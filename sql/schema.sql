-- Run once against your Neon database (e.g. via `psql "$DATABASE_URL" -f sql/schema.sql`)

create extension if not exists pgcrypto;

create table if not exists images (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  -- Full-resolution image, encrypted client-side with AES-256-GCM before upload.
  -- The server never sees this in plaintext at upload time.
  full_ciphertext bytea not null,
  full_iv         bytea not null,          -- 12-byte GCM IV
  full_key_wrapped bytea not null,         -- per-image AES key, RSA-OAEP wrapped for the server's public key

  -- Low-res preview, same scheme, separate key. Shown in the channel/catalog.
  -- Treat this as "semi-sensitive" -- it persists (isn't view-once) and the
  -- server decrypts it on every catalog render, so don't put anything in the
  -- thumbnail you wouldn't want to persist server-side.
  thumb_ciphertext bytea not null,
  thumb_iv         bytea not null,
  thumb_key_wrapped bytea not null,

  caption         text,
  uploader_note   text,                    -- optional, never shown to recipients

  -- delivery bookkeeping -- no plaintext, no decrypted bytes, ever stored here
  delivered_to    bigint[] not null default '{}',  -- Telegram user IDs it's been sent to
  delivery_count  int not null default 0,
  max_deliveries  int,                     -- null = unlimited; set to e.g. 1 for true one-shot
  revoked         boolean not null default false
);

create index if not exists idx_images_created_at on images (created_at desc);

-- One row per Telegram user who has started the bot, so /start deep-link
-- payloads can be matched back to a chat_id for delivery.
create table if not exists bot_users (
  telegram_user_id bigint primary key,
  chat_id           bigint not null,
  first_seen        timestamptz not null default now(),
  last_seen         timestamptz not null default now()
);
