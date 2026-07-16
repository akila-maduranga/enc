const { sql } = require("./_lib/db");
const { unwrapAndDecrypt } = require("./_lib/crypto");
const { sendSelfDestructingPhoto } = require("./_lib/mtproto");
const { sendMessage, answerCallbackQuery, sendPhotoBuffer, inlineKeyboard } = require("./_lib/botApi");

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

exports.handler = async (event) => {
  // Verify this really came from Telegram, not a random POST to the endpoint.
  // Set this same value with setWebhook's secret_token param.
  const secret = event.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  let update;
  try {
    update = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    // Log server-side only. Never echo internal error detail back to Telegram/the user.
    console.error("webhook error:", err);
  }

  // Always 200 -- Telegram retries aggressively on non-200, which would
  // otherwise cause duplicate self-destruct sends.
  return { statusCode: 200, body: "ok" };
};

async function upsertBotUser(userId, chatId) {
  const db = sql();
  await db`
    insert into bot_users (telegram_user_id, chat_id)
    values (${userId}, ${chatId})
    on conflict (telegram_user_id)
    do update set chat_id = excluded.chat_id, last_seen = now()
  `;
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || "";

  if (message.chat.type !== "private") return; // self-destruct only works 1:1

  await upsertBotUser(userId, chatId);

  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const payload = parts[1]; // e.g. "reveal_<uuid>" from a channel deep link
    if (payload && payload.startsWith("reveal_")) {
      const imageId = payload.slice("reveal_".length);
      await deliverImage({ imageId, chatId, userId });
      return;
    }
    await sendMessage(chatId, "Welcome. Send /catalog to browse available images.");
    return;
  }

  if (text.startsWith("/catalog")) {
    await sendCatalog(chatId);
    return;
  }
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  await upsertBotUser(userId, chatId);

  if (cb.data && cb.data.startsWith("reveal:")) {
    const imageId = cb.data.slice("reveal:".length);
    await answerCallbackQuery(cb.id, "Sending...");
    await deliverImage({ imageId, chatId, userId });
    return;
  }

  await answerCallbackQuery(cb.id, "Unknown action");
}

async function sendCatalog(chatId) {
  const db = sql();
  const rows = await db`
    select id, caption, thumb_ciphertext, thumb_iv, thumb_key_wrapped
    from images
    where revoked = false
    order by created_at desc
    limit 10
  `;

  if (rows.length === 0) {
    await sendMessage(chatId, "No images available.");
    return;
  }

  for (const row of rows) {
    let thumbBuf;
    try {
      thumbBuf = unwrapAndDecrypt({
        ciphertext: row.thumb_ciphertext,
        iv: row.thumb_iv,
        wrappedKey: row.thumb_key_wrapped,
      });
      await sendPhotoBuffer(chatId, thumbBuf, {
        caption: row.caption || undefined,
        replyMarkup: inlineKeyboard([[{ text: "Reveal (view once)", callback_data: `reveal:${row.id}` }]]),
      });
    } finally {
      if (thumbBuf) thumbBuf.fill(0);
      thumbBuf = null;
    }
  }
}

async function deliverImage({ imageId, chatId, userId }) {
  const db = sql();
  const [row] = await db`
    select id, full_ciphertext, full_iv, full_key_wrapped, caption,
           delivery_count, max_deliveries, revoked
    from images
    where id = ${imageId}
  `;

  if (!row || row.revoked) {
    await sendMessage(chatId, "This image is no longer available.");
    return;
  }
  if (row.max_deliveries != null && row.delivery_count >= row.max_deliveries) {
    await sendMessage(chatId, "This image has already been delivered the maximum number of times.");
    return;
  }

  let plaintext;
  try {
    plaintext = unwrapAndDecrypt({
      ciphertext: row.full_ciphertext,
      iv: row.full_iv,
      wrappedKey: row.full_key_wrapped,
    });

    await sendSelfDestructingPhoto({
      chatId,
      plaintextBuffer: plaintext,
      ttlSeconds: 30,
      caption: row.caption || "",
    });

    await db`
      update images
      set delivery_count = delivery_count + 1,
          delivered_to = array_append(delivered_to, ${userId}::bigint)
      where id = ${imageId}
    `;
  } catch (err) {
    console.error("delivery failed:", err);
    await sendMessage(chatId, "Sorry, something went wrong delivering that image.");
  } finally {
    // Best-effort in-process wipe. Node/V8 doesn't guarantee this scrubs
    // every copy the engine may have made, but it removes the only reference
    // your code holds and overwrites the bytes rather than just dropping them.
    if (plaintext) plaintext.fill(0);
    plaintext = null;
  }
}

async function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

module.exports = { isAdmin };
