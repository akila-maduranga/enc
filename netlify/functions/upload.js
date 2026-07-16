const { sql } = require("./_lib/db");

// Simple shared-secret gate so randoms on the internet can't fill your DB.
// Swap for real auth (magic link, Telegram login widget, etc.) before
// treating this as more than a personal/small-team tool.
function isAuthorized(req) {
  const token = req.headers.get("x-upload-token");
  return !!process.env.UPLOAD_TOKEN && token === process.env.UPLOAD_TOKEN;
}

exports.handler = async (event) => {
  // Netlify Functions v2 (fetch-style) -- adjust if you're on the older
  // event/context signature.
  const req = new Request(`https://x${event.rawUrl ? new URL(event.rawUrl).pathname : "/"}`, {
    method: event.httpMethod,
    headers: event.headers,
    body: event.body,
  });

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  if (!isAuthorized(req)) {
    return { statusCode: 401, body: "Unauthorized" };
  }

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
};
