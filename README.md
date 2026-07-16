# Vault — encrypted image intake with self-destructing Telegram delivery

Browser-encrypted image storage in Postgres, delivered as a true
self-destructing (view-once) photo to a Telegram user, driven by inline
buttons in a bot and a channel.

## How it fits together

```
 browser                 Netlify functions              Neon Postgres      Telegram
 ───────                 ──────────────────              ────────────      ────────
 1. pick image
 2. AES-256-GCM encrypt
    image + thumbnail,     ─upload.js────────────────►    images table
    RSA-OAEP wrap keys                                    (ciphertext only)

                                                                              channel post:
                            post-to-channel.js  ──────────────────────────►  thumbnail +
                                (decrypts thumb only,                        "Get image" button
                                 sends via Bot API)                          (deep-links to bot)

                                                                              user taps button
                                                                              → opens DM, /start
                                                                                reveal_<id>
                            telegram-webhook.js ◄──────────────────────────  webhook POST
                              - unwrap key (RSA)
                              - AES-GCM decrypt (memory only)
                              - GramJS/MTProto sendMedia
                                with ttlSeconds        ───────────────────►  self-destructing
                              - zero the buffer                              photo in DM
```

The server never sees a decrypted image until the moment someone requests
delivery, and even then it only exists as a `Buffer` in function memory for
the span of that single invocation — never written to disk, never logged.

## Why this needs two different Telegram APIs

`ttl_seconds` / view-once is an **MTProto** feature (the protocol Telegram's
own apps speak), not something the plain Bot API HTTP surface exposes. So:

- **Bot API** (`_lib/botApi.js`, plain HTTPS) — webhook updates, `/start`,
  `/catalog`, inline keyboards, thumbnail delivery, channel posts. Stateless,
  fits serverless perfectly.
- **MTProto** (`_lib/mtproto.js`, via [GramJS](https://gram.js.org)) — only
  for the actual self-destructing photo send. Requires a pre-authenticated
  session (`scripts/generate-session.js`, run once locally), replayed fresh
  on every function invocation since Netlify functions can't hold a
  persistent socket open between calls.

Telegram also restricts `ttl_seconds`/`view_once` to **private chats** — a
bot cannot send a self-destructing photo into a channel or group. That's why
the channel flow posts a persistent blurred thumbnail with a button that
deep-links (`t.me/<bot>?start=reveal_<id>`) into a private DM, where the real
delivery happens.

## Setup

1. **Database**: create a Neon project, then `psql "$DATABASE_URL" -f sql/schema.sql`.
2. **Envelope keys**: `npm run generate:keys` → paste the public key into
   `public/app.js` (`SERVER_PUBLIC_KEY_PEM`), put the private key in the
   `RSA_PRIVATE_KEY` env var.
3. **Bot**: create one with [@BotFather](https://t.me/BotFather), get the
   token. Get `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` from
   [my.telegram.org/apps](https://my.telegram.org/apps).
4. **MTProto session**: `npm run generate:session` → set the printed string
   as `TELEGRAM_SESSION_STRING`.
5. Fill in the rest of `.env.example` and set every value as a Netlify
   environment variable (never commit `.env`).
6. Deploy, then register the webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d url="https://<your-site>.netlify.app/api/telegram-webhook" \
     -d secret_token="<same value as TELEGRAM_WEBHOOK_SECRET>"
   ```
7. Open the site, paste your upload token, drop an image.

## Netlify timeout gotcha

A delivery request does: Postgres fetch → RSA unwrap → AES-GCM decrypt →
MTProto connect → upload → send. That routinely takes longer than the 10s
default. `netlify.toml` requests the 26s paid-plan ceiling, but as of this
writing Netlify support has to manually flip that on per-site even for
Pro/Enterprise accounts — check your dashboard or open a support ticket
before assuming it's active. If it isn't, keep images small (a few hundred
KB) or move the MTProto send into a background function and have the webhook
return immediately.

## Threat model — what this does and doesn't protect against

**Protects against:**
- A read of the Postgres database on its own yields only ciphertext and a
  key wrapped to a private key it doesn't have.
- The upload path: the server never receives plaintext, ever.
- Disk traces: nothing is written to `/tmp` or any filesystem at any point;
  decrypted bytes exist only as in-memory buffers for the duration of one
  function call.

**Does not protect against:**
- **The recipient's device.** Once a self-destructing photo is opened, the
  recipient's Telegram client renders it. Screenshots, screen recording, or
  a modified client can still capture it — Telegram's self-destruct is a UX
  contract enforced by the client, not cryptographic erasure of something
  already displayed.
- **The delivery-time decrypt.** The RSA private key has to live somewhere
  the function can reach it (a Netlify env var here). Anyone with that key
  and the ciphertext can decrypt. For stronger guarantees, move key custody
  to a real KMS/HSM (AWS KMS, GCP KMS) instead of a plain env var.
- **Node's memory model.** `buffer.fill(0)` in `_lib/crypto.js` and the
  webhook is best-effort: it removes the only reference your code holds and
  overwrites the bytes, but V8/Node doesn't guarantee no other internal copy
  briefly existed (e.g. during GC, or an OS-level page it touched). This is a
  real reduction in exposure, not an absolute guarantee — the same caveat
  applies to essentially any managed-runtime "secure delete."
- **Metadata.** Function logs, Netlify's own request logs, and Telegram's
  servers all see *that* a delivery happened and *to whom*, even though they
  don't see the image content. If that's a problem, review Netlify's and
  Telegram's own logging/retention policies for your use case.
- **The `UPLOAD_TOKEN` gate** is a single shared secret, fine for a
  personal/small-team tool, not real multi-user auth. Replace it before
  giving upload access to people you don't fully trust.

## Known rough edges to test before relying on this

- `CustomFile`'s in-memory-buffer constructor (`_lib/mtproto.js`) is a
  lightly-documented part of GramJS — confirm the signature against your
  installed version.
- Reconnecting a fresh MTProto session on every invocation is not how
  GramJS is typically used (it's built for persistent clients). It works,
  but watch for Telegram rate-limiting frequent connect/disconnect cycles
  from the same session if delivery volume grows.
- No retry/idempotency handling if Telegram's webhook retries a delivery
  that partially succeeded (e.g. MTProto send succeeded but the Postgres
  `delivery_count` update failed) — currently that could double-send. Add a
  dedupe check (e.g. on `update_id`) before production use.
