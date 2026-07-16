const BASE = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function callApi(method, body) {
  const res = await fetch(`${BASE()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description || res.status}`);
  }
  return data.result;
}

function sendMessage(chatId, text, extra = {}) {
  return callApi("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  return callApi("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert });
}

/**
 * Sends a photo from an in-memory buffer (multipart/form-data) -- used for
 * catalog thumbnails, which are NOT self-destructing and go through the
 * regular Bot API. This is a normal, persistent Telegram message; don't put
 * anything sensitive in a thumbnail beyond a low-res preview.
 */
async function sendPhotoBuffer(chatId, buffer, { caption, replyMarkup, filename = "thumb.jpg" } = {}) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  form.append("photo", new Blob([buffer]), filename);

  const res = await fetch(`${BASE()}/sendPhoto`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API sendPhoto failed: ${data.description || res.status}`);
  }
  return data.result;
}

function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

module.exports = { callApi, sendMessage, answerCallbackQuery, sendPhotoBuffer, inlineKeyboard };
