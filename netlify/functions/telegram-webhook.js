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
  // If TELEGRAM_WEBHOOK_SECRET is not set, we skip this check (both sides undefined).
  const secret = event.headers["x-telegram-bot-api-secret-token"];
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
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
    // Last-resort catch — individual handlers should already send user-facing
    // error messages.  This just prevents a 500 that would make Telegram retry.
    console.error("webhook top-level error:", err);
  }

  // Always 200 -- Telegram retries aggressively on non-200, which would
  // otherwise cause duplicate self-destruct sends.
  return { statusCode: 200, body: "ok" };
};

// --- Helpers ----------------------------------------------------------------

async function upsertBotUser(userId, chatId) {
  try {
    const db = sql();
    await db`
      insert into bot_users (telegram_user_id, chat_id)
      values (${userId}, ${chatId})
      on conflict (telegram_user_id)
      do update set chat_id = excluded.chat_id, last_seen = now()
    `;
  } catch (err) {
    console.error("upsertBotUser failed (non-fatal):", err.message);
  }
}

/** Send an error message to the user so they see something instead of silence. */
async function sendError(chatId, text) {
  try {
    await sendMessage(chatId, `⚠️ ${text}`);
  } catch (e) {
    console.error("failed to send error message to user:", e.message);
  }
}

// --- Message handler --------------------------------------------------------

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || "";

  if (message.chat.type !== "private") return; // self-destruct only works 1:1

  // Non-blocking — don't let a missing table kill the whole flow.
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

// --- Callback query handler -------------------------------------------------

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

// --- Catalog ----------------------------------------------------------------

async function sendCatalog(chatId) {
  try {
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
  } catch (err) {
    console.error("sendCatalog error:", err);
    await sendError(chatId, "Could not load catalog. The server may be misconfigured.");
  }
}

// --- Image delivery (view-once via MTProto) ---------------------------------

async function deliverImage({ imageId, chatId, userId }) {
  // --- 1. Fetch from DB -----------------------------------------------------
  let row;
  try {
    const db = sql();
    const rows = await db`
      select id, full_ciphertext, full_iv, full_key_wrapped, caption,
             delivery_count, max_deliveries, revoked
      from images
      where id = ${imageId}
    `;
    row = rows[0] || rows;
  } catch (err) {
    console.error("deliverImage DB error:", err);
    await sendError(chatId, "Database error while fetching image.");
    return;
  }

  if (!row || !row.id || row.revoked) {
    await sendMessage(chatId, "This image is no longer available.");
    return;
  }
  if (row.max_deliveries != null && row.delivery_count >= row.max_deliveries) {
    await sendMessage(chatId, "This image has already been delivered the maximum number of times.");
    return;
  }

  // --- 2. Decrypt -----------------------------------------------------------
  let plaintext;
  try {
    plaintext = unwrapAndDecrypt({
      ciphertext: row.full_ciphertext,
      iv: row.full_iv,
      wrappedKey: row.full_key_wrapped,
    });
  } catch (err) {
    console.error("deliverImage decrypt error:", err);
    await sendError(chatId, "Decryption failed. The RSA_PRIVATE_KEY may be wrong or mismatched with the public key used during upload.");
    return;
  }

  // --- 3. Send via MTProto (self-destructing) --------------------------------
  try {
    await sendSelfDestructingPhoto({
      chatId,
      plaintextBuffer: plaintext,
      ttlSeconds: 30,
      caption: row.caption || "",
    });
  } catch (err) {
    console.error("deliverImage MTProto send error:", err);
    // Surface the actual error so we can debug — tighten later.
    await sendError(chatId, `Delivery failed: ${err.message}`);
    return;
  }

  // --- 4. Update delivery bookkeeping ---------------------------------------
  try {
    const db = sql();
    await db`
      update images
      set delivery_count = delivery_count + 1,
          delivered_to = array_append(delivered_to, ${userId}::bigint)
      where id = ${imageId}
    `;
  } catch (err) {
    console.error("deliverImage DB update error:", err);
    // Image was sent successfully — don't bother the user with this.
  } finally {
    if (plaintext) plaintext.fill(0);
    plaintext = null;
  }
}

async function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

module.exports = { isAdmin };