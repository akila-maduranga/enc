// ---------------------------------------------------------------------------
// Paste the PUBLIC key printed by `node scripts/generate-keys.js` here.
// This is the *public* half -- safe to ship to the browser. The private half
// stays server-side only (RSA_PRIVATE_KEY env var).
// ---------------------------------------------------------------------------
const SERVER_PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo0bsg29ywJvn7l3hMtxw
oWbxUEJ0Nf0PVHGoxnU+KHXXl5fmz/MtG+4wkKmlez33YcO4cNV5y+Dvu//Y2DG8
ZA5iZXTDG26fZeIZnWL122YCXKbo+ytMTQSeZ/r/mmK2FFy7UA09wY4bXf9iKFNk
S1pnEzNJ2qN+vML3NQsou+RohVXvhyaCFGYhVerwif0PV70zAYUZ/zEgQDxZbG8+
0UASVEBFaN1oj+RUoHBskos9sV5V9BC1ZRpu62xodtd1Lt3RwmGrAIWfEbxKXM8W
dNKVaISoFkE8/rX7MDmD3AAfBJ0CPVG9Lc/skAGSXdTrIGhITNXFltmAbg7cfbmT
kwIDAQAB
-----END PUBLIC KEY-----';

const THUMB_MAX_DIMENSION = 480;

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

async function importServerPublicKey() {
  return crypto.subtle.importKey(
    "spki",
    pemToArrayBuffer(SERVER_PUBLIC_KEY_PEM),
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["wrapKey"]
  );
}

function bufToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Generates a fresh AES-256-GCM key, encrypts `plaintextBuffer` with a
 * random 12-byte IV, and wraps the key with the server's RSA-OAEP public
 * key. Nothing here is ever sent anywhere except the three base64 outputs.
 */
async function sealBuffer(plaintextBuffer, serverPublicKey) {
  const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, plaintextBuffer);
  const wrappedKey = await crypto.subtle.wrapKey("raw", dataKey, serverPublicKey, { name: "RSA-OAEP" });

  return {
    ciphertext: bufToBase64(ciphertext), // GCM auth tag is appended automatically by SubtleCrypto
    iv: bufToBase64(iv),
    wrappedKey: bufToBase64(wrappedKey),
  };
}

function makeThumbnailBlob(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, THUMB_MAX_DIMENSION / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.filter = "blur(6px)"; // light obscuring -- this is a teaser, not the delivered image
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("thumbnail encode failed"))), "image/jpeg", 0.72);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// --- UI wiring -------------------------------------------------------------

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const sealBtn = document.getElementById("sealBtn");
const ledger = document.getElementById("ledger");
const captionInput = document.getElementById("caption");
const maxDeliveriesInput = document.getElementById("maxDeliveries");
const uploadTokenInput = document.getElementById("uploadToken");

let selectedFile = null;

function logLine(text, state = "pending") {
  const li = document.createElement("li");
  li.dataset.state = state;
  li.innerHTML = `<span>${text}</span>`;
  ledger.prepend(li);
  return li;
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("is-dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("is-dragover");
  if (e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files[0]) selectFile(fileInput.files[0]); });

function selectFile(file) {
  selectedFile = file;
  dropzone.querySelector(".dropzone__label").textContent = file.name;
  sealBtn.disabled = false;
}

sealBtn.addEventListener("click", async () => {
  if (!selectedFile) return;
  if (!uploadTokenInput.value) {
    logLine("Missing upload token", "error");
    return;
  }
  if (SERVER_PUBLIC_KEY_PEM.includes("REPLACE_ME")) {
    logLine("Set SERVER_PUBLIC_KEY_PEM in app.js first (run scripts/generate-keys.js)", "error");
    return;
  }

  sealBtn.disabled = true;
  const line = logLine(`Sealing ${selectedFile.name}…`);

  try {
    const serverPublicKey = await importServerPublicKey();

    const fullBuffer = await selectedFile.arrayBuffer();
    const thumbBlob = await makeThumbnailBlob(selectedFile);
    const thumbBuffer = await thumbBlob.arrayBuffer();

    const [full, thumb] = await Promise.all([
      sealBuffer(fullBuffer, serverPublicKey),
      sealBuffer(thumbBuffer, serverPublicKey),
    ]);

    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-upload-token": uploadTokenInput.value,
      },
      body: JSON.stringify({
        fullCiphertext: full.ciphertext,
        fullIv: full.iv,
        fullKeyWrapped: full.wrappedKey,
        thumbCiphertext: thumb.ciphertext,
        thumbIv: thumb.iv,
        thumbKeyWrapped: thumb.wrappedKey,
        caption: captionInput.value || undefined,
        maxDeliveries: maxDeliveriesInput.value ? Number(maxDeliveriesInput.value) : undefined,
      }),
    });

    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const { id } = await res.json();

    line.dataset.state = "ok";
    line.innerHTML = `<span>Sealed ✓ ${selectedFile.name}</span><span>${id}</span>`;
  } catch (err) {
    line.dataset.state = "error";
    line.innerHTML = `<span>Failed: ${err.message}</span>`;
  } finally {
    selectedFile = null;
    fileInput.value = "";
    dropzone.querySelector(".dropzone__label").textContent = "Drop an image, or click to choose one";
    sealBtn.disabled = true;
  }
});
