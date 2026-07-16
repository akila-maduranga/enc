const crypto = require("crypto");

/**
 * Unwraps a per-image AES-256 data key that the browser wrapped with the
 * server's RSA-OAEP public key. The private key only ever lives in an env
 * var / memory -- never written to disk.
 */
function unwrapKey(wrappedKeyBuffer) {
  const privateKeyPem = process.env.RSA_PRIVATE_KEY;
  if (!privateKeyPem) throw new Error("RSA_PRIVATE_KEY is not set");

  return crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    wrappedKeyBuffer
  );
}

/**
 * Decrypts AES-256-GCM ciphertext. Expects the browser to have appended the
 * 16-byte GCM auth tag to the end of the ciphertext (the default behavior of
 * SubtleCrypto's AES-GCM encrypt) -- we split it back off here.
 *
 * Returns a plain Buffer. Callers are responsible for not persisting it and
 * for dropping the reference (buf.fill(0); buf = null) as soon as it has been
 * handed off to Telegram.
 */
function decryptAesGcm(ciphertextWithTag, ivBuffer, keyBuffer) {
  const TAG_LENGTH = 16;
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - TAG_LENGTH);
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer, ivBuffer);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Convenience wrapper: unwrap the per-image key, then decrypt the payload.
 * Zeroes the unwrapped key from memory once decryption is done (best-effort --
 * V8 doesn't guarantee immediate physical erasure, but this at minimum removes
 * the only reference and overwrites the bytes).
 */
function unwrapAndDecrypt({ ciphertext, iv, wrappedKey }) {
  const dek = unwrapKey(wrappedKey);
  try {
    return decryptAesGcm(ciphertext, iv, dek);
  } finally {
    dek.fill(0);
  }
}

module.exports = { unwrapKey, decryptAesGcm, unwrapAndDecrypt };
