// Run once locally: `node scripts/generate-session.js`
//
// Get TELEGRAM_API_ID / TELEGRAM_API_HASH from https://my.telegram.org/apps
// (these are your *application's* MTProto credentials -- separate from the
// bot token, which you get from @BotFather).
//
// This logs the bot in over MTProto once and prints a StringSession you can
// reuse from serverless functions without re-authenticating every call.
// Treat the printed string exactly like a password: whoever has it can act
// as your bot over MTProto. Set it as TELEGRAM_SESSION_STRING in Netlify env
// vars, never commit it.
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

(async () => {
  const apiId = Number(await input.text("TELEGRAM_API_ID: "));
  const apiHash = await input.text("TELEGRAM_API_HASH: ");
  const botToken = await input.text("Bot token (from @BotFather): ");

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
  await client.start({ botAuthToken: botToken });

  console.log("\n=== TELEGRAM_SESSION_STRING (set as a secret env var) ===\n");
  console.log(client.session.save());

  await client.disconnect();
})();
