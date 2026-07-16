// MINIMAL DIAGNOSTIC VERSION — strips out GramJS/MTProto to test if
// the webhook routing, Bot API, and DB work at all.
//
// Deploy this temporarily.  If the bot replies, we know the issue is
// GramJS and we'll fix that separately.

const { sendMessage } = require("./_lib/botApi");

exports.handler = async (event) => {
  console.log("=== WEBHOOK HIT ===");
  console.log("headers:", JSON.stringify(event.headers).substring(0, 500));
  console.log("body:", (event.body || "").substring(0, 500));

  let update;
  try {
    update = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const chatId = update?.message?.chat?.id;
  const text   = update?.message?.text || "";

  console.log("chatId:", chatId, "text:", text);

  if (!chatId) {
    return { statusCode: 200, body: "ok" };
  }

  // Reply to ANY message so we can confirm the webhook works.
  try {
    await sendMessage(chatId, `Webhook is alive. You sent: "${text}"`);

    if (text.startsWith("/start") && text.includes("reveal_")) {
      const imageId = text.split("reveal_")[1];
      await sendMessage(chatId, `Reveal request received for image: ${imageId}`);
      await sendMessage(chatId, "MTProto delivery is disabled in this diagnostic build. Check Netlify function logs for import errors related to the 'telegram' package (GramJS).");
    }
  } catch (err) {
    console.error("sendMessage failed:", err.message);
  }

  return { statusCode: 200, body: "ok" };
};