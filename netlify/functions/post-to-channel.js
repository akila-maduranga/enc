const { sql } = require("./_lib/db");
const { unwrapAndDecrypt } = require("./_lib/crypto");
const { sendPhotoBuffer, inlineKeyboard } = require("./_lib/botApi");

// Self-destructing photos only work in private chats (Telegram restriction),
// so the channel post itself is just a persistent thumbnail + a URL button
// that deep-links into a private chat with the bot. The bot then delivers
// the real view-once photo there.
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const token = event.headers["x-upload-token"];
  if (!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  // --- Config check ----------------------------------------------------------
  const missing = [];
  if (!process.env.TELEGRAM_CHANNEL_ID) missing.push("TELEGRAM_CHANNEL_ID");
  if (!process.env.TELEGRAM_BOT_USERNAME) missing.push("TELEGRAM_BOT_USERNAME");
  if (!process.env.TELEGRAM_BOT_TOKEN)  missing.push("TELEGRAM_BOT_TOKEN");
  if (!process.env.RSA_PRIVATE_KEY)     missing.push("RSA_PRIVATE_KEY");

  if (missing.length) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `Server misconfigured: ${missing.join(", ")} not set` }),
    };
  }

  // --- Parse body ------------------------------------------------------------
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }
  if (!body.imageId) return { statusCode: 400, body: "Missing imageId" };

  // --- Fetch image from DB ---------------------------------------------------
  let row;
  try {
    const db = sql();
    const rows = await db`
      select id, caption, thumb_ciphertext, thumb_iv, thumb_key_wrapped
      from images
      where id = ${body.imageId} and revoked = false
    `;
    row = rows[0] || rows;          // neon() may return array or single row
    if (!row || !row.id) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Image not found or revoked" }),
      };
    }
  } catch (err) {
    console.error("post-to-channel DB error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `DB error: ${err.message}` }),
    };
  }

  // --- Decrypt thumbnail & send to Telegram ----------------------------------
  let thumbBuf;
  try {
    thumbBuf = unwrapAndDecrypt({
      ciphertext: row.thumb_ciphertext,
      iv: row.thumb_iv,
      wrappedKey: row.thumb_key_wrapped,
    });

    const deepLink = `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=reveal_${row.id}`;
    await sendPhotoBuffer(process.env.TELEGRAM_CHANNEL_ID, thumbBuf, {
      caption: row.caption || undefined,
      replyMarkup: inlineKeyboard([[{ text: "Get full image (view once, DM)", url: deepLink }]]),
    });
  } catch (err) {
    console.error("post-to-channel send error:", err);
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `Telegram send failed: ${err.message}` }),
    };
  } finally {
    if (thumbBuf) thumbBuf.fill(0);
    thumbBuf = null;
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, imageId: body.imageId }),
  };
};