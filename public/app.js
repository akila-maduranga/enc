// ---------------------------------------------------------------------------
// Paste the PUBLIC key printed by `node scripts/generate-keys.js` here.
// This is the *public* half -- safe to ship to the browser. The private half
// stays server-side only (RSA_PRIVATE_KEY env var).
// ---------------------------------------------------------------------------
const SERVER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo0bsg29ywJvn7l3hMtxw
oWbxUEJ0Nf0PVHGoxnU+KHXXl5fmz/MtG+4wkKmlez33YcO4cNV5y+Dvu//Y2DG8
ZA5iZXTDG26fZeIZnWL122YCXKbo+ytMTQSeZ/r/mmK2FFy7UA09wY4bXf9iKFNk
S1pnEzNJ2qN+vML3NQsou+RohVXvhyaCFGYhVerwif0PV70zAYUZ/zEgQDxZbG8+
0UASVEBFaN1oj+RUoHBskos9sV5V9BC1ZRpu62xodtd1Lt3RwmGrAIWfEbxKXM8W
dNKVaISoFkE8/rX7MDmD3AAfBJ0CPVG9Lc/skAGSXdTrIGhITNXFltmAbg7cfbmT
kwIDAQAB
-----END PUBLIC KEY-----`;

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

async function sealBuffer(plaintextBuffer, serverPublicKey) {
  const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, plaintextBuffer);
  const wrappedKey = await crypto.subtle.wrapKey("raw", dataKey, serverPublicKey, { name: "RSA-OAEP" });
  return {
    ciphertext: bufToBase64(ciphertext),
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
      ctx.filter = "blur(6px)";
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

function selectFile(file) {
  if (!file) return;
  
  if (!file.type.startsWith('image/')) {
    logLine(`❌ "${file.name}" is not an image`, "error");
    return;
  }
  
  selectedFile = file;
  
  const label = dropzone.querySelector(".dropzone__label");
  const hint = dropzone.querySelector(".dropzone__hint");
  
  if (label) {
    label.textContent = `📷 ${file.name}`;
    label.style.fontWeight = "500";
    label.style.color = "var(--ink)";
  }
  
  if (hint) {
    hint.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB — click or drop another to change`;
  }
  
  sealBtn.disabled = false;
  logLine(`📎 Selected: ${file.name}`, "ok");
}

function resetDropzone() {
  selectedFile = null;
  fileInput.value = "";
  
  const label = dropzone.querySelector(".dropzone__label");
  const hint = dropzone.querySelector(".dropzone__hint");
  
  if (label) {
    label.textContent = "Drop an image, or click to choose one";
    label.style.fontWeight = "";
    label.style.color = "";
  }
  
  if (hint) {
    hint.textContent = "Encryption happens here, on this device, before anything is sent.";
  }
  
  sealBtn.disabled = true;
}

// --- Event Listeners ---

dropzone.addEventListener("click", (e) => {
  if (e.target.closest('button')) return;
  fileInput.click();
});

dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropzone.classList.add("is-dragover");
});

dropzone.addEventListener("dragleave", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropzone.classList.remove("is-dragover");
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropzone.classList.remove("is-dragover");
  
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    selectFile(files[0]);
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length > 0) {
    selectFile(fileInput.files[0]);
  } else {
    resetDropzone();
  }
});

// --- Seal Button ---

sealBtn.addEventListener("click", async () => {
  if (!selectedFile) {
    logLine("❌ No file selected", "error");
    return;
  }
  
  if (!uploadTokenInput.value) {
    logLine("❌ Missing upload token", "error");
    return;
  }
  
  // Check if public key is properly set
  if (SERVER_PUBLIC_KEY_PEM.includes("REPLACE_ME") || SERVER_PUBLIC_KEY_PEM.length < 100) {
    logLine("❌ Server public key is not configured correctly", "error");
    return;
  }

  sealBtn.disabled = true;
  const line = logLine(`🔐 Sealing ${selectedFile.name}…`);

  try {
    const serverPublicKey = await importServerPublicKey();
    const fullBuffer = await selectedFile.arrayBuffer();
    const thumbBlob = await makeThumbnailBlob(selectedFile);
    const thumbBuffer = await thumbBlob.arrayBuffer();

    const [full, thumb] = await Promise.all([
      sealBuffer(fullBuffer, serverPublicKey),
      sealBuffer(thumbBuffer, serverPublicKey),
    ]);

    const payload = {
      fullCiphertext: full.ciphertext,
      fullIv: full.iv,
      fullKeyWrapped: full.wrappedKey,
      thumbCiphertext: thumb.ciphertext,
      thumbIv: thumb.iv,
      thumbKeyWrapped: thumb.wrappedKey,
      caption: captionInput.value || undefined,
      maxDeliveries: maxDeliveriesInput.value ? Number(maxDeliveriesInput.value) : undefined,
    };

    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-upload-token": uploadTokenInput.value,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let errorMsg = `Upload failed: ${res.status}`;
      try {
        const errorData = await res.json();
        if (errorData.error) errorMsg = errorData.error;
      } catch (e) { /* ignore */ }
      throw new Error(errorMsg);
    }
    
    const { id } = await res.json();

    line.dataset.state = "ok";
    line.innerHTML = `<span>✅ Sealed ✓ ${selectedFile.name}</span><span style="font-family:monospace;font-size:11px;color:var(--indigo)">${id}</span>`;
    
    captionInput.value = "";
    maxDeliveriesInput.value = "";
    resetDropzone();
    
  } catch (err) {
    line.dataset.state = "error";
    line.innerHTML = `<span>❌ Failed: ${err.message}</span>`;
    sealBtn.disabled = false;
  } finally {
    if (!selectedFile) {
      sealBtn.disabled = true;
    }
  }
});

// --- Initialize ---
resetDropzone();
logLine("🟢 Ready — drop an image or click the box above", "ok");
