// Run once locally: `node scripts/generate-keys.js`
// Prints a public key (paste into the frontend config) and a private key
// (set as the RSA_PRIVATE_KEY env var in Netlify -- never commit it, never
// put it in client-side code).
const crypto = require("crypto");

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 4096,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

console.log("=== PUBLIC KEY (safe to embed in public/app.js) ===\n");
console.log(publicKey);
console.log("=== PRIVATE KEY (set as Netlify env var RSA_PRIVATE_KEY, keep secret) ===\n");
console.log(privateKey);
