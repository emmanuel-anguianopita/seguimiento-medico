// Publicación de resultados para el paciente.
// El profesional genera un archivo cifrado por paciente (data/<id>.json). Para abrirlo hace falta el nombre completo
// (que da el nombre del archivo) y la contraseña (que descifra el contenido). En el archivo no hay nada legible.
import { makeProtection, tryUnlock, encryptJSON, decryptJSON, encryptBytes } from "./crypto.js";

export const nameToken = (name) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9ñÑ ]+/g, " ")
  .toUpperCase().split(/\s+/).filter(Boolean).sort().join(" ");   // sin acentos, sin importar el orden de nombre y apellidos

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Identificador del archivo de un paciente, derivado de su nombre con un hash lento. */
export async function lookupId(name) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(nameToken(name)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode("seguimiento-medico/archivo/v1"), iterations: 100000, hash: "SHA-256" }, base, 256);
  return toHex(bits).slice(0, 32);
}

export const MIN_PASSWORD = 10;

/** patient: {name, profile}; reports/weights ya descifrados; pdfs: [{hash, bytes}].
 *  Devuelve {id, json, files}: json es el archivo principal y files son los PDF cifrados (uno por informe). */
export async function buildBundle(patient, reports, weights, password, pdfs = []) {
  const pdfIds = new Set(pdfs.map((p) => p.hash.slice(0, 16)));
  const payload = {
    v: 1, name: patient.name, profile: patient.profile || {}, publishedAt: new Date().toISOString(),
    reports: reports.map((r) => ({ id: r.id, date: r.date, lab: r.lab, folio: r.folio, results: r.results,   // sin el texto del PDF
      pdf: r.fileHash && pdfIds.has(r.fileHash.slice(0, 16)) ? r.fileHash.slice(0, 16) : null })),
    weights: weights.map((w) => ({ id: w.id, date: w.date, kg: w.kg, note: w.note, fatPct: w.fatPct, waterPct: w.waterPct, boneKg: w.boneKg })),
  };
  const { key, meta } = await makeProtection(password);
  const file = { app: "seguimiento-medico-publico", v: 1, protection: meta, enc: await encryptJSON(key, payload) };
  const id = await lookupId(patient.name);
  const files = [];
  for (const p of pdfs) {
    const { iv, ct } = await encryptBytes(key, p.bytes);
    const data = new Uint8Array(12 + ct.byteLength); data.set(iv, 0); data.set(new Uint8Array(ct), 12);
    files.push({ name: `${id}/${p.hash.slice(0, 16)}.bin`, data });
  }
  return { id, json: JSON.stringify(file), payload, files };
}

/** Devuelve {payload, key} si la contraseña es correcta; si no, null. */
export async function openBundleWithKey(file, password) {
  if (!file || file.app !== "seguimiento-medico-publico" || !file.protection || !file.enc) return null;
  const key = await tryUnlock(password, file.protection);
  if (!key) return null;
  try { return { payload: await decryptJSON(key, file.enc), key }; } catch { return null; }
}
export const openBundle = async (file, password) => (await openBundleWithKey(file, password))?.payload ?? null;

/** Descifra un PDF publicado (formato: 12 bytes de vector inicial + contenido cifrado). */
export async function openPdfFile(key, bytes) {
  const { decryptBytes } = await import("./crypto.js");
  return decryptBytes(key, { iv: bytes.slice(0, 12), ct: bytes.slice(12) });
}
