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
  if (!process.env.TELEGRAM_CHANNEL_ID || !process.env.TELEGRAM_BOT_USERNAME) {
    return { statusCode: 500, body: "TELEGRAM_CHANNEL_ID / TELEGRAM_BOT_USERNAME not configured" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }
  if (!body.imageId) return { statusCode: 400, body: "Missing imageId" };

  const db = sql();
  const [row] = await db`
    select id, caption, thumb_ciphertext, thumb_iv, thumb_key_wrapped
    from images
    where id = ${body.imageId} and revoked = false
  `;
  if (!row) return { statusCode: 404, body: "Image not found" };

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
  } finally {
    if (thumbBuf) thumbBuf.fill(0);
    thumbBuf = null;
  }

  return { statusCode: 200, body: "posted" };
};
