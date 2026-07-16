const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { CustomFile } = require("telegram/client/uploads");

/**
 * ttl_seconds / view-once is an MTProto feature, not exposed over plain Bot
 * API HTTP -- so this path connects as a full MTProto client (authenticated
 * once via scripts/generate-session.js, replayed here from a saved string
 * session) instead of just calling api.telegram.org.
 *
 * Netlify functions are stateless: we connect fresh, send, and disconnect on
 * every invocation rather than holding a persistent socket open. That's the
 * necessary tradeoff for running this on serverless -- see README for the
 * rate-limit / cold-start caveats.
 */
async function sendSelfDestructingPhoto({ chatId, plaintextBuffer, filename = "photo.jpg", ttlSeconds = 30, caption = "" }) {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const sessionString = process.env.TELEGRAM_SESSION_STRING;

  if (!apiId || !apiHash || !sessionString) {
    throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION_STRING must be set");
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 2,
  });

  try {
    await client.connect();

    // CustomFile's 4th arg (in-memory buffer instead of a disk path) is a
    // stable but lightly-documented part of the GramJS API -- confirm the
    // signature matches your installed "telegram" version before relying on
    // it in production (`node_modules/telegram/client/uploads.d.ts`).
    const file = new CustomFile(filename, plaintextBuffer.length, "", plaintextBuffer);
    const uploaded = await client.uploadFile({ file, workers: 1 });

    const entity = await client.getEntity(chatId);

    await client.invoke(
      new Api.messages.SendMedia({
        peer: entity,
        media: new Api.InputMediaUploadedPhoto({
          file: uploaded,
          ttlSeconds,
        }),
        message: caption,
        randomId: BigInt("0x" + require("crypto").randomBytes(8).toString("hex")),
      })
    );
  } finally {
    // Always disconnect -- don't leave a socket dangling past this invocation.
    await client.disconnect().catch(() => {});
  }
}

module.exports = { sendSelfDestructingPhoto };
