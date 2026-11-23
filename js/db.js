// Almacenamiento local permanente (IndexedDB). Los datos nunca salen del dispositivo.
const NAME = "seguimiento-medico";
const VERSION = 1;

const dbp = new Promise((resolve, reject) => {
  const r = indexedDB.open(NAME, VERSION);
  r.onupgradeneeded = () => {
    const d = r.result;
    for (const s of ["patients", "reports", "weights"]) {
      if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: "id", autoIncrement: true });
    }
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

async function tx(store, mode, fn) {
  const d = await dbp;
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out && "result" in out ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const all = (store) => tx(store, "readonly", (s) => s.getAll());
export const put = (store, value) => tx(store, "readwrite", (s) => s.put(value));
export const del = (store, id) => tx(store, "readwrite", (s) => s.delete(id));

/** Escribe pacientes, informes y pesos en una sola transacción (todo o nada). */
export async function batchWrite({ patients = [], reports = [], weights = [] }) {
  const d = await dbp;
  return new Promise((resolve, reject) => {
    const t = d.transaction(["patients", "reports", "weights"], "readwrite");
    for (const [name, rows] of [["patients", patients], ["reports", reports], ["weights", weights]]) {
      const store = t.objectStore(name);
      for (const r of rows) store.put(r);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function deletePatient(id) {
  for (const store of ["reports", "weights"]) {
    for (const row of await all(store)) if (row.patientId === id) await del(store, row.id);
  }
  await del("patients", id);
}

/** Pide al navegador que no borre los datos por falta de espacio. */
export async function requestPersistence() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; }
  catch { return false; }
}

export async function exportAll() {
  return { app: "seguimiento-medico", version: 1, exportedAt: new Date().toISOString(),
    patients: await all("patients"), reports: await all("reports"), weights: await all("weights") };
}

/** Une una copia de respaldo con los datos actuales, sin duplicar. Los datos cifrados se conservan cifrados. */
export async function importBackup(data) {
  if (!data || data.app !== "seguimiento-medico") throw new Error("El archivo no es una copia de respaldo válida.");
  const patients = await all("patients");
  const reports = await all("reports");
  const weights = await all("weights");
  const idMap = new Map();
  let addedReports = 0, addedWeights = 0, renamed = 0;
  for (const p of data.patients || []) {
    const existing = patients.find((x) => x.nameKey === p.nameKey);
    const sameProtection = existing && (existing.protection?.salt || null) === (p.protection?.salt || null);
    if (existing && sameProtection) { idMap.set(p.id, existing.id); continue; }
    const { id, ...rest } = p;
    if (existing) { rest.name = `${p.name} (respaldo)`; rest.nameKey = `${p.nameKey} (RESPALDO)`; renamed++; }
    const newId = await put("patients", rest);
    patients.push({ ...rest, id: newId });
    idMap.set(id, newId);
  }
  const reportKey = (r) => r.fileHash ?? r.enc?.iv;
  for (const r of data.reports || []) {
    if (reports.some((x) => reportKey(x) === reportKey(r))) continue;
    const { id, ...rest } = r;
    await put("reports", { ...rest, patientId: idMap.get(r.patientId) });
    addedReports++;
  }
  for (const w of data.weights || []) {
    const pid = idMap.get(w.patientId);
    const dup = w.enc ? weights.some((x) => x.enc?.iv === w.enc.iv)
      : weights.some((x) => x.patientId === pid && x.date === w.date && x.kg === w.kg);
    if (dup) continue;
    const { id, ...rest } = w;
    await put("weights", { ...rest, patientId: pid });
    addedWeights++;
  }
  return { addedReports, addedWeights, renamed };
}
