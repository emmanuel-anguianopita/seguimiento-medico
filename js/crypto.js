// Cifrado por paciente: contraseña -> clave (PBKDF2-SHA256) -> AES-GCM de 256 bits.
// La clave solo vive en memoria mientras el paciente está desbloqueado; nunca se guarda.
const enc = new TextEncoder();
const dec = new TextDecoder();
export const ITERATIONS = 600000;
const MARK = "seguimiento-medico";

const b64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, saltB64, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: unb64(saltB64), iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function decryptJSON(key, rec) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(rec.iv) }, key, unb64(rec.ct));
  return JSON.parse(dec.decode(pt));
}

/** Crea la protección de un paciente: devuelve la clave y los metadatos que se guardan con el paciente. */
export async function makeProtection(password) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(password, salt, ITERATIONS);
  const check = await encryptJSON(key, { ok: MARK });
  return { key, meta: { salt, iterations: ITERATIONS, check } };
}

/** Devuelve la clave si la contraseña es correcta; si no, null. */
export async function tryUnlock(password, meta) {
  try {
    const key = await deriveKey(password, meta.salt, meta.iterations);
    const o = await decryptJSON(key, meta.check);
    return o.ok === MARK ? key : null;
  } catch {
    return null;
  }
}
