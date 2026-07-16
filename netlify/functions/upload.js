const { sql } = require("./_lib/db");

// Netlify Functions body-size limit is ~6 MB.  Base64-encoded ciphertext of a
// 4+ MB photo will blow past that.  We cap the client-side payload here so the
// function fails with a clear 413 instead of a cryptic 502.
const MAX_PAYLOAD_BYTES = 5.5 * 1024 * 1024; // 5.5 MB — leave headroom

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // --- Authorisation --------------------------------------------------------
  const token = event.headers["x-upload-token"];
  if (!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  // --- Payload size guard ---------------------------------------------------
  if (event.body && event.body.length > MAX_PAYLOAD_BYTES) {
    return {
      statusCode: 413,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error:
          `Payload too large (${(event.body.length / 1024 / 1024).toFixed(1)} MB). ` +
          `Maximum is ${(MAX_PAYLOAD_BYTES / 1024 / 1024).toFixed(1)} MB. ` +
          `Try a smaller image or reduce its resolution before uploading.`,
      }),
    };
  }

  // --- Parse JSON -----------------------------------------------------------
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const required = [
    "fullCiphertext", "fullIv", "fullKeyWrapped",
    "thumbCiphertext", "thumbIv", "thumbKeyWrapped",
  ];
  for (const field of required) {
    if (!payload[field]) return { statusCode: 400, body: `Missing field: ${field}` };
  }

  // --- Database insert (wrapped in try-catch) ------------------------------
  try {
    const db = sql();
    const [row] = await db`
      insert into images (
        full_ciphertext, full_iv, full_key_wrapped,
        thumb_ciphertext, thumb_iv, thumb_key_wrapped,
        caption, max_deliveries
      ) values (
        ${Buffer.from(payload.fullCiphertext, "base64")},
        ${Buffer.from(payload.fullIv, "base64")},
        ${Buffer.from(payload.fullKeyWrapped, "base64")},
        ${Buffer.from(payload.thumbCiphertext, "base64")},
        ${Buffer.from(payload.thumbIv, "base64")},
        ${Buffer.from(payload.thumbKeyWrapped, "base64")},
        ${payload.caption || null},
        ${payload.maxDeliveries ?? null}
      )
      returning id
    `;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: row.id }),
    };
  } catch (err) {
    console.error("upload handler error:", err);

    // Surface a helpful error to the client instead of letting Netlify
    // turn the unhandled rejection into a generic 502.
    const msg = err.message || "Unknown database error";

    if (msg.includes("DATABASE_URL is not set")) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Server database is not configured (DATABASE_URL)." }),
      };
    }

    // Neon-specific: connection / pool exhausted
    if (msg.includes("Connection") || msg.includes("timeout") || msg.includes("pool")) {
      return {
        statusCode: 503,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Database connection failed. Please retry in a moment." }),
      };
    }

    // TODO: once the root cause is identified, tighten this back to a
    // generic message.  Left verbose for now so the real error is visible
    // in the browser UI during debugging.
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `DB error: ${msg}` }),
    };
  }
};