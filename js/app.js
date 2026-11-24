import { parseDocument, SUPPORTED_LABS, restandardize } from "./parser.js";
import { compose, bmi as calcBmi } from "./composition.js";
import { SYSTEM_NAMES, systemOf, systemIcon } from "./systems.js";
import { PHASES, phaseOn, monthGrid, addDays, cycleLength } from "./cycle.js";
import { progress, compare } from "./progress.js";
import { lookupId, buildBundle, openBundleWithKey, openPdfFile, MIN_PASSWORD } from "./publish.js";
import { pdfToPages } from "./pdftext.js";
import * as db from "./db.js";
import { lineChart, sparkline, fmt } from "./charts.js";
import { makeProtection, tryUnlock, encryptJSON, decryptJSON, encryptBytes, decryptBytes } from "./crypto.js";
import { makeZip } from "./zip.js";

const CATEGORIES = ["Hematología", "Química clínica", "Inmunología", "Orina", "Otros"];
const STATUS = {
  normal: { label: "Normal", icon: "✓" },
  bajo: { label: "Bajo", icon: "▼" },
  alto: { label: "Alto", icon: "▲" },
  fuera: { label: "Fuera de rango", icon: "!" },
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const toTime = (iso) => new Date(iso + "T12:00:00").getTime();
const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const makeKey = (name) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/,/g, " ").split(/\s+/).filter(Boolean).join(" ").toUpperCase();
const toTitle = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

const state = {
  patients: [], reports: [], weights: [], files: [], portalKey: null, portalId: null,
  patientId: Number(localStorage.getItem("patientId")) || null,
  tab: "analisis", view: null, onlyOut: false, search: "", busy: false,
  keys: new Map(), unlockError: "", histSearch: "", histOnlyOut: false, calMonth: null,
  readOnly: false, portalList: null, mode: "admin", justAdded: null, portalError: "", groupBy: localStorage.getItem("groupBy") === "system" ? "system" : "study",
};
const REPORT_FIELDS = ["date", "lab", "folio", "fileHash", "rawText", "results", "importedAt"];
const FILE_FIELDS = ["hash", "name", "size"];
const WEIGHT_FIELDS = ["date", "kg", "note", "fatPct", "waterPct", "boneKg"];
const pick = (o, fields) => Object.fromEntries(fields.map((f) => [f, o[f]]));
const isLocked = (p) => !!p && !!p.protection && !state.keys.has(p.id);

// ---------- Datos ----------
async function load() {
  state.patients = (await db.all("patients")).sort((a, b) => a.name.localeCompare(b.name, "es"));
  for (const p of state.patients) {
    if (p.profileEnc && state.keys.has(p.id)) { try { p.profile = await decryptJSON(state.keys.get(p.id), p.profileEnc); } catch { /* perfil dañado */ } }
  }
  const decode = async (rows) => {
    const out = [];
    for (const r of rows) {
      if (!r.enc) { out.push(r); continue; }
      const key = state.keys.get(r.patientId);
      if (!key) continue; // paciente bloqueado: sus datos siguen cifrados
      try { out.push({ ...(await decryptJSON(key, r.enc)), id: r.id, patientId: r.patientId }); } catch { /* registro dañado */ }
    }
    return out;
  };
  state.reports = await decode(await db.all("reports"));
  state.weights = await decode(await db.all("weights"));
  state.files = await decode(await db.all("files"));
  if (!state.patients.some((p) => p.id === state.patientId)) state.patientId = state.patients[0]?.id ?? null;
  if (state.patientId) localStorage.setItem("patientId", state.patientId);
}

/** Convierte un registro a su forma guardada: en claro, o cifrado si el paciente tiene contraseña. */
async function encodeRecord(pat, rec, fields, key = state.keys.get(pat.id)) {
  const out = { patientId: pat.id };
  if (rec.id != null) out.id = rec.id;
  if (pat.protection) out.enc = await encryptJSON(key, pick(rec, fields));
  else Object.assign(out, pick(rec, fields));
  return out;
}
/** Guarda al paciente. Si tiene contraseña, su perfil (altura, sexo, nacimiento, saludo) se guarda cifrado. */
async function savePatient(pat) {
  const rec = { ...pat };
  if (pat.protection) {
    delete rec.profile;
    rec.profileEnc = await encryptJSON(state.keys.get(pat.id), pat.profile || {});
    pat.profileEnc = rec.profileEnc;
  } else delete rec.profileEnc;
  if (rec.id == null) delete rec.id;
  pat.id = await db.put("patients", rec);
}
/** Quita un indicador de los informes de un paciente (todos, o solo uno). Con «todos» se recuerda para que no vuelva a entrar al importar. */
async function removeIndicator(pat, key, reportId = null) {
  for (const r of state.reports.filter((x) => x.patientId === pat.id && (reportId == null || x.id === reportId))) {
    const results = r.results.filter((x) => restandardize(x).key !== key);
    if (results.length !== r.results.length) await saveReport(pat, { ...r, results });
  }
  if (reportId == null) {
    pat.profile = { ...(pat.profile || {}), ignored: [...new Set([...(pat.profile?.ignored || []), key])] };
    await savePatient(pat);
  }
  await load();
}
const birthOf = (p) => p?.profile?.birthDate ?? p?.birthDate ?? null;
async function fillProfile(pat, parsed) {
  const prof = { ...(pat.profile || {}) };
  let changed = false;
  if (!birthOf(pat) && parsed.birth) { prof.birthDate = parsed.birth; changed = true; }
  if (!prof.sex && parsed.sex) { prof.sex = parsed.sex; changed = true; }
  if (changed) { pat.profile = prof; await savePatient(pat); }
}
/** Guarda el PDF original del estudio (cifrado si el paciente tiene contraseña). */
async function saveFile(pat, rec, bytes) {
  const id = await db.put("files", await encodeRecord(pat, rec, FILE_FIELDS));
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const blob = pat.protection ? { id, patientId: pat.id, ...(await encryptBytes(state.keys.get(pat.id), new Uint8Array(copy))) } : { id, patientId: pat.id, data: copy };
  await db.put("blobs", blob);
  state.files.push({ ...rec, id });
}
async function getPdfBytes(f) {
  const blob = await db.get("blobs", f.id);
  if (!blob) throw new Error("PDF no guardado");
  return blob.data ? new Uint8Array(blob.data) : decryptBytes(state.keys.get(f.patientId), blob);
}
const fileOf = (r, patientId = state.patientId) => state.files.find((x) => x.hash === r.fileHash && x.patientId === patientId);
async function saveReport(pat, report) { report.id = await db.put("reports", await encodeRecord(pat, report, REPORT_FIELDS)); }
async function saveWeight(pat, w) { w.id = await db.put("weights", await encodeRecord(pat, w, WEIGHT_FIELDS)); }

const patient = () => state.patients.find((p) => p.id === state.patientId) || null;
// Los resultados se vuelven a estandarizar al leerlos, así los estudios importados con versiones anteriores quedan con los nombres actuales.
const STD = new WeakMap();
const standard = (r) => { let v = STD.get(r); if (!v) { const seen = new Set(); v = { ...r, results: r.results.map(restandardize).filter((x) => !seen.has(x.key) && seen.add(x.key)) }; STD.set(r, v); } return v; };
const myReports = () => state.reports.filter((r) => r.patientId === state.patientId).map(standard).sort((a, b) => a.date.localeCompare(b.date));
const myWeights = () => state.weights.filter((w) => w.patientId === state.patientId).sort((a, b) => a.date.localeCompare(b.date));

function buildSeries() {
  const map = new Map();
  for (const r of myReports()) for (const x of r.results) {
    const pt = { rid: r.id, date: r.date, t: toTime(r.date), value: x.value, text: x.text, unit: x.unit, status: x.status,
      refLow: x.refLow, refHigh: x.refHigh, refKind: x.refKind, refText: x.refText };
    const s = map.get(x.key);
    if (s) { s.points.push(pt); s.name = x.name; s.category = x.category; }
    else map.set(x.key, { key: x.key, name: x.name, category: x.category, points: [pt] });
  }
  return [...map.values()];
}
const display = (p) => (p.value !== null && p.value !== undefined ? fmt(p.value) : p.text ?? "–");
function reference(p) {
  switch (p.refKind) {
    case "range": return `${fmt(p.refLow)} – ${fmt(p.refHigh)}`;
    case "lt": return `< ${fmt(p.refHigh)}`;
    case "le": return `≤ ${fmt(p.refHigh)}`;
    case "gt": return `> ${fmt(p.refLow)}`;
    case "ge": return `≥ ${fmt(p.refLow)}`;
    default: return p.refText || "–";
  }
}
const badge = (st) => `<span class="badge st-${st}">${STATUS[st].icon} ${STATUS[st].label}</span>`;

// ---------- Importación ----------
let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ??= import("../vendor/pdf.min.mjs").then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;
    return m;
  });
  return pdfjsPromise;
}
async function sha256(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function importFiles(files) {
  state.busy = true; render();
  const outcomes = [];
  try {
    const pdfjs = await loadPdfjs();
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const hash = await sha256(buf);
        const copy = buf.slice(0);   // pdf.js puede consumir el búfer original
        const dupReport = state.reports.find((r) => r.fileHash === hash);
        if (dupReport) {
          const owner = state.patients.find((p) => p.id === dupReport.patientId);
          if (owner && !state.files.some((x) => x.hash === hash && x.patientId === owner.id)) {
            await saveFile(owner, { patientId: owner.id, hash, name: f.name, size: copy.byteLength }, new Uint8Array(copy));
            outcomes.push({ name: f.name, ok: true, attached: true, date: dupReport.date, msg: "Este estudio ya estaba importado; ahora se guardó también su PDF." });
          } else outcomes.push({ name: f.name, ok: false, msg: "Este PDF ya estaba importado." });
          continue;
        }
        const pages = await pdfToPages(pdfjs, new Uint8Array(buf));
        const parsed = parseDocument(pages);
        const rawText = pages.map((p, i) => `— Página ${i + 1} —\n${p.join("\n")}`).join("\n");
        if (!parsed.results.length) {
          outcomes.push({ name: f.name, ok: false, raw: rawText, msg: "No se reconocieron resultados. Puede ser un PDF escaneado (imagen) o un formato de laboratorio todavía no soportado." });
          continue;
        }
        let pat;
        if (parsed.patient) {
          const key = makeKey(parsed.patient);
          const sorted = (k) => k.split(" ").sort().join(" ");   // algunos laboratorios ponen primero el nombre y otros los apellidos
          pat = state.patients.find((p) => p.nameKey === key) || state.patients.find((p) => !p.nameKey.includes("(RESPALDO)") && sorted(p.nameKey) === sorted(key));
          if (!pat) { pat = { name: toTitle(parsed.patient), nameKey: key, profile: { birthDate: parsed.birth, sex: parsed.sex } }; await savePatient(pat); state.patients.push(pat); }
        } else {
          pat = patient();
          if (!pat) { pat = { name: "Paciente", nameKey: "PACIENTE", profile: {} }; await savePatient(pat); state.patients.push(pat); }
        }
        if (isLocked(pat)) {
          if (!(await requestUnlock(pat))) { outcomes.push({ name: f.name, ok: false, msg: `«${pat.name}» está protegido con contraseña y no se desbloqueó. El PDF no se importó.` }); continue; }
          if (state.reports.some((r) => r.fileHash === hash)) { outcomes.push({ name: f.name, ok: false, msg: "Este PDF ya estaba importado." }); continue; }
        }
        await fillProfile(pat, parsed);
        const omitidos = new Set(pat.profile?.ignored || []);   // indicadores que el profesional eliminó por error de lectura
        if (omitidos.size) parsed.results = parsed.results.filter((x) => !omitidos.has(x.key));
        // Mismo estudio entregado en otro PDF (mismo paciente, laboratorio, fecha y folio): se combina en un solo informe, sin duplicar columnas.
        const same = parsed.folio && parsed.date ? state.reports.find((r) => r.patientId === pat.id && r.folio === parsed.folio && r.date === parsed.date && r.lab === parsed.lab) : null;
        if (same) {
          const have = new Set(same.results.map((x) => restandardize(x).key));
          const extra = parsed.results.filter((x) => !have.has(x.key));
          const bigger = parsed.results.length > same.results.length;
          const merged = { ...same, results: [...same.results, ...extra], ...(bigger ? { fileHash: hash, rawText } : {}) };
          await saveReport(pat, merged);
          await saveFile(pat, { patientId: pat.id, hash, name: f.name, size: copy.byteLength }, new Uint8Array(copy));
          state.patientId = pat.id; localStorage.setItem("patientId", pat.id);
          outcomes.push({ name: f.name, ok: true, date: merged.date, msg: `${parsed.lab} · ${fmtDate(merged.date)}: este estudio (folio ${parsed.folio}) ya estaba importado; se combinó y ahora tiene ${merged.results.length} resultados (${extra.length} nuevo${extra.length === 1 ? "" : "s"}).` });
          continue;
        }
        const report = { patientId: pat.id, date: parsed.date || todayIso(), lab: parsed.lab, folio: parsed.folio || "",
          fileHash: hash, rawText, results: parsed.results, importedAt: new Date().toISOString() };
        await saveReport(pat, report);
        state.reports.push(report);
        await saveFile(pat, { patientId: pat.id, hash, name: f.name, size: copy.byteLength }, new Uint8Array(copy));
        state.patientId = pat.id; localStorage.setItem("patientId", pat.id);
        const out = parsed.results.filter((r) => r.status !== "normal").length;
        outcomes.push({ name: f.name, ok: true, date: report.date, msg: `${parsed.lab} · ${fmtDate(report.date)}: ${parsed.results.length} resultados, ${out} fuera de rango.` + (parsed.date ? "" : " No se encontró la fecha; se usó la de hoy (corrígela en Informes).") });
      } catch (e) {
        console.error(e);
        outcomes.push({ name: f.name, ok: false, msg: "No se pudo leer el archivo." });
      }
    }
  } catch (e) {
    console.error(e);
    outcomes.push({ name: "PDF", ok: false, msg: "No se pudo cargar el lector de PDF." });
  }
  state.busy = false; await load();
  const added = outcomes.filter((o) => o.ok && !o.attached);
  if (added.length) { state.tab = "avances"; state.view = null; state.justAdded = added.map((o) => o.date).sort().pop(); }
  render();
  const unknown = outcomes.filter((o) => o.raw);
  const actions = [{ label: "Listo" }];
  if (unknown.length) actions.unshift({ label: "Copiar texto del PDF", onClick: () => copyUnknown(unknown) });
  showDialog("Resultado de la importación", outcomes.map((o) => `<div class="out ${o.ok ? "ok" : "bad"}"><strong>${o.ok ? "✓" : "!"} ${esc(o.name)}</strong><span>${esc(o.msg)}</span></div>`).join("") +
    (unknown.length ? `<p class="small muted">Si es un formato nuevo, copia el texto y pégalo en la conversación para añadirlo a la lista de formatos compatibles.</p>` : ""), actions);
}

async function copyUnknown(list) {
  const text = list.map((o) => `### ${o.name}\n${o.raw}`).join("\n\n");
  const note = "Contiene los datos del PDF, incluido el nombre del paciente. Revísalo antes de compartirlo.";
  try { await navigator.clipboard.writeText(text); showDialog("Texto copiado", note); }
  catch { showDialog("Copia el texto manualmente", `${esc(note)}<pre>${esc(text)}</pre>`); }
}

// ---------- Vistas ----------
function header(title, back) {
  if (back) return `<header class="top back"><button class="icon" data-action="back" aria-label="Volver">‹</button><h1>${esc(title)}</h1><span class="spacer"></span></header>`;
  if (state.readOnly) return `<header class="top"><h1 class="grow">${esc(patient()?.name || title)}</h1><button class="icon" data-action="menu" aria-label="Menú">⋯</button></header>`;
  const opts = state.patients.map((p) => `<option value="${p.id}" ${p.id === state.patientId ? "selected" : ""}>${p.protection ? "🔒 " : ""}${esc(p.name)}</option>`).join("");
  return `<header class="top"><select id="patientSelect" aria-label="Paciente">${opts || `<option>${esc(title)}</option>`}</select><button class="icon" data-action="menu" aria-label="Menú">⋯</button></header>`;
}

function viewLocked(p) {
  return `${header(p.name)}<main><div class="empty"><div class="logo">🔒</div><p><strong>${esc(p.name)}</strong></p>
    <p class="muted">Este paciente está protegido con contraseña.</p>
    <form id="unlockForm" class="form lockform"><input type="password" name="pw" placeholder="Contraseña" autocomplete="current-password" required>
    <button class="primary" type="submit">Desbloquear</button><div class="err">${esc(state.unlockError)}</div></form></div></main>`;
}

function viewPortal() {
  const list = state.portalList;
  const opts = (list || []).map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join("");
  const msg = list === null ? "Cargando…" : "";
  return `<main class="gate"><div class="gate-box"><div class="gate-mark" aria-hidden="true"></div>
    <h1 class="gate-title">Anatomía según<br>Emmanuel Anguiano</h1><div class="gate-rule"></div>
    <form id="portalForm" class="gate-form" autocomplete="off">
      <select name="pid" aria-label="Paciente" required><option value="" disabled selected>${list && !list.length ? "Sin pacientes disponibles" : "Selecciona tu nombre"}</option>${opts}</select>
      <input type="password" name="pw" placeholder="Contraseña" autocomplete="current-password" aria-label="Contraseña" required>
      <button class="primary" type="submit" ${state.busy ? "disabled" : ""}>${state.busy ? "Verificando…" : "Entrar"}</button>
      <div class="err" id="portalErr">${esc(state.portalError || msg)}</div></form><div class="gate-ver">Versión 16</div></div></main>`;
}

async function loadPortalList() {
  try {
    const res = await fetch("./data/pacientes.json", { cache: "no-store" });
    if (!res.ok) throw new Error("sin lista");
    const j = await res.json();
    state.portalList = (Array.isArray(j.pacientes) ? j.pacientes : []).filter((x) => x && x.id && x.label)
      .sort((a, b) => a.label.localeCompare(b.label, "es"));
  } catch { state.portalList = []; }
  if (state.mode === "portal" && !state.readOnly) render();
}

async function portalLogin(id, pw) {
  state.busy = true; state.portalError = ""; render();
  const fail = "La contraseña no es correcta. Inténtalo de nuevo.";
  try {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("paciente");
    const res = await fetch(`./data/${id}.json`, { cache: "no-store" });
    if (!res.ok) throw new Error("no encontrado");
    const opened = await openBundleWithKey(await res.json(), pw);
    if (!opened) throw new Error("contraseña");
    const data = opened.payload;
    state.portalKey = opened.key; state.portalId = id;
    state.patients = [{ id: 1, name: data.name, nameKey: makeKey(data.name), profile: data.profile || {} }];
    state.patientId = 1;
    state.reports = data.reports.map((r) => ({ ...r, patientId: 1 }));
    state.weights = data.weights.map((w) => ({ ...w, patientId: 1 }));
    state.readOnly = true; state.tab = "analisis"; state.view = null; state.justAdded = null;
  } catch (e) {
    state.portalError = e instanceof TypeError ? "No hay conexión. Inténtalo de nuevo." : fail;
  }
  state.busy = false; render(); touch();
}

async function leavePortal() {
  state.readOnly = false; state.patients = []; state.reports = []; state.weights = []; state.files = []; state.patientId = null; state.view = null; state.tab = "analisis";
  state.portalKey = null; state.portalId = null;
  document.getElementById("dlg")?.remove();
  if (state.mode === "admin") await load(); else loadPortalList();
  render();
}

async function setMode(mode) {
  state.mode = mode;
  if (mode === "admin") { try { localStorage.setItem("mode", "admin"); } catch {} }
  if (state.readOnly) { state.readOnly = false; state.patients = []; state.reports = []; state.weights = []; state.portalKey = null; state.portalId = null; }
  if (mode === "admin") await load();
  state.view = null; state.tab = "analisis"; state.portalError = "";
  render();
  if (mode === "portal") loadPortalList();
}
async function decideMode() {
  const h = location.hash;
  if (h === "#portal") return "portal";
  if (h === "#admin") return "admin";
  if (localStorage.getItem("mode") === "admin") return "admin";
  return (await db.all("patients")).length ? "admin" : "portal";
}

// ---- publicar para el paciente ----
async function openPdf(hash, download) {
  let bytes;
  try {
    if (state.readOnly) {
      const res = await fetch(`./data/${state.portalId}/${hash.slice(0, 16)}.bin`, { cache: "no-store" });
      if (!res.ok) throw new Error("no encontrado");
      bytes = await openPdfFile(state.portalKey, new Uint8Array(await res.arrayBuffer()));
    } else {
      const f = state.files.find((x) => x.hash.startsWith(hash.slice(0, 16)) && x.patientId === state.patientId);
      bytes = await getPdfBytes(f);
    }
  } catch (e) {
    console.error(e);
    return showDialog("No se pudo abrir el PDF", state.readOnly ? "Revisa tu conexión e inténtalo de nuevo. Si el problema sigue, avisa a tu médico." : "El PDF de este estudio no está guardado. Impórtalo de nuevo para guardarlo.");
  }
  const r = myReports().find((x) => (x.fileHash || x.pdf || "").startsWith(hash.slice(0, 16)));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const save = () => { const a = document.createElement("a"); a.href = url; a.download = `estudio-${r?.date || "resultados"}.pdf`; document.body.appendChild(a); a.click(); a.remove(); };
  if (download || !window.open(url, "_blank")) save();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function deliverFile(file) {
  return async () => {
    try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: file.name }); return; } }
    catch (e) { if (e.name === "AbortError") return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
}
function publishPatient(pat) {
  let file = null, info = null;
  const d = showForm({
    title: "Publicar para el paciente",
    intro: `Se crea un paquete cifrado con los resultados y los PDF de <strong>${esc(pat.name)}</strong>. El paciente elige su nombre en la lista de acceso y escribe esta contraseña. Ojo: el nombre de la lista es visible para quien abra la dirección de la aplicación; puedes usar un nombre corto o un apodo. Compártesela por un medio distinto al paquete y usa al menos ${MIN_PASSWORD} caracteres.`,
    fields: [{ name: "label", label: "Nombre que aparecerá en la lista de acceso", type: "text", value: pat.published?.label || pat.name },
      { name: "pw", label: `Contraseña del paciente (mínimo ${MIN_PASSWORD} caracteres)`, autocomplete: "new-password" }, { name: "pw2", label: "Repite la contraseña", autocomplete: "new-password" }],
    okLabel: "Crear archivo",
    onSubmit: async ({ label, pw, pw2 }) => {
      label = String(label || "").trim().slice(0, 80);
      if (!label) return "Escribe el nombre que aparecerá en la lista.";
      if (pw.length < MIN_PASSWORD) return `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`;
      if (pw !== pw2) return "Las contraseñas no coinciden.";
      const reports = state.reports.filter((r) => r.patientId === pat.id).map(standard), weights = state.weights.filter((w) => w.patientId === pat.id);
      const pdfs = [];
      for (const f of state.files.filter((x) => x.patientId === pat.id && reports.some((r) => r.fileHash === x.hash))) pdfs.push({ hash: f.hash, bytes: await getPdfBytes(f) });
      const out = await buildBundle(pat, reports, weights, pw, pdfs);
      pat.published = { label, id: out.id }; await savePatient(pat);
      // La lista se arma con los pacientes publicados desde este dispositivo y los que ya están en la lista publicada del sitio,
      // para que publicar a uno nuevo nunca saque de la lista a los anteriores.
      const porId = new Map();
      try {
        const res = await fetch("./data/pacientes.json", { cache: "no-store" });
        if (res.ok) for (const x of (await res.json()).pacientes || []) if (x?.id && x?.label) porId.set(x.id, { id: x.id, label: x.label });
      } catch { /* sin conexión o sin lista publicada todavía */ }
      for (const x of await db.all("patients")) if (x.published?.id && x.published?.label) porId.set(x.published.id, { id: x.published.id, label: x.published.label });
      const lista = [...porId.values()];
      const zip = makeZip([{ name: `pacientes.json`, data: new TextEncoder().encode(JSON.stringify({ v: 1, pacientes: lista })) },
        { name: `${out.id}.json`, data: new TextEncoder().encode(out.json) }, ...out.files]);
      file = new File([zip], `resultados-${out.id.slice(0, 8)}.zip`, { type: "application/zip" });
      info = { pdfs: pdfs.length, missing: reports.filter((r) => !out.payload.reports.find((x) => x.id === r.id)?.pdf).length };
    },
  });
  d.addEventListener("closed", (e) => {
    if (e.detail !== true || !file) return;
    showDialog("Paquete listo", `<p><strong>${esc(file.name)}</strong> · ${info.pdfs} PDF cifrado${info.pdfs === 1 ? "" : "s"}</p>
      ${info.missing ? `<p class="small muted">${info.missing} estudio${info.missing === 1 ? "" : "s"} no tiene${info.missing === 1 ? "" : "n"} PDF guardado: vuelve a importar ese PDF y publica de nuevo para incluirlo.</p>` : ""}
      <ol class="small"><li>Guarda el .zip y ábrelo. Contiene <strong>pacientes.json</strong> (la lista de acceso), un archivo .json y una carpeta con el mismo código. Copia todo dentro de la carpeta <strong>data</strong> del repositorio (créala la primera vez) y reemplaza si ya existen.</li>
      <li>En GitHub Desktop escribe un resumen, pulsa <strong>Commit to main</strong> y luego <strong>Push origin</strong>.</li>
      <li>En un par de minutos el paciente podrá elegir su nombre en la lista y consultar sus resultados con su contraseña.</li></ol>
      <p class="small muted">Repite este proceso cada vez que importes estudios nuevos, usando la misma contraseña.</p>`,
      [{ label: "Cerrar" }, { label: "Guardar archivo", onClick: deliverFile(file) }]);
  });
}

const CHANGE = { mejoro: ["good", "Mejoró"], empeoro: ["bad", "Empeoró"], estable: ["flat", "Estable"], igual: ["flat", "Sin cambio"], nuevo: ["new", "Nuevo"] };
const signed = (v) => `${v > 0 ? "+" : ""}${fmt(Number(v.toFixed(2)))}`;
function trendChip(it) {
  if (!it) return "";
  const [cls, label] = CHANGE[it.change];
  if (it.change === "nuevo") return `<span class="chip new">Nuevo</span>`;
  const arrow = it.delta > 0 ? "▲" : it.delta < 0 ? "▼" : "●";
  return `<span class="chip ${cls}" title="${label}">${it.delta === null ? "●" : arrow} ${it.delta === null ? label : signed(it.delta)}</span>`;
}
const pctChip = (d) => d === null ? "" : `<span class="chip ${d > 0 ? "good" : d < 0 ? "bad" : "flat"}">${d > 0 ? "▲" : d < 0 ? "▼" : "●"} ${signed(d)} puntos</span>`;

function changeRow(it) {
  const prev = it.prev ? `${esc(display(it.prev))} → ` : "";
  return `<li><button class="row" data-action="analyte" data-key="${esc(it.key)}"><span class="grow"><span class="name">${esc(it.name)}${it.category === "Orina" ? " (orina)" : ""}</span>
    <span class="sub">${prev}${esc(display(it.last))} ${esc(it.last.unit)} · ${esc(fmtDate(it.last.date))}</span></span>
    <span class="val">${badge(it.last.status)}${trendChip(it)}</span></button></li>`;
}

function viewAvances() {
  const reports = myReports();
  if (!reports.length) return `${header("Avances")}<main><h2 class="hello">${esc(greeting())}</h2><div class="empty"><p>Todavía no hay estudios.</p><p class="muted">Cuando haya resultados verás aquí cómo avanzan.</p>${state.readOnly ? "" : `<button class="primary" data-action="import">Importar PDF</button>`}</div></main>`;
  const P = progress(buildSeries(), reports);
  const t = P.timeline[P.timeline.length - 1];
  let html = `${header("Avances")}<main>`;
  if (state.justAdded) html += `<div class="card banner">✓ Se agregó el estudio del <strong>${esc(fmtDate(state.justAdded))}</strong>. Estos son los cambios.</div>`;
  html += `<div class="card hero"><div class="muted small">Indicadores dentro de rango · estudio del ${esc(fmtDate(P.latestDate))}</div>
    <div class="bigrow"><span class="big">${fmt(P.nowPct)} %</span>${pctChip(P.deltaPct)}</div>
    <div class="bar"><i style="width:${P.nowPct}%"></i></div>
    <div class="small muted">${t.ok} de ${t.total} indicadores en rango${P.previousDate ? ` · comparado con el estudio del ${esc(fmtDate(P.previousDate))}` : " · es el primer estudio, aún no hay con qué comparar"}</div>
    ${P.timeline.length > 1 ? lineChart({ points: P.timeline.map((x) => ({ t: toTime(x.date), v: x.pct, status: "normal" })), label: "Porcentaje de indicadores en rango por estudio" }) : ""}</div>`;
  const flat = P.counts.estable + P.counts.igual;
  html += `<div class="tiles"><div class="tile good"><strong>${P.counts.mejoro}</strong><span>Mejoraron</span></div><div class="tile bad"><strong>${P.counts.empeoro}</strong><span>Empeoraron</span></div>
    <div class="tile flat"><strong>${flat}</strong><span>Sin cambio</span></div><div class="tile new"><strong>${P.counts.nuevo}</strong><span>Nuevos</span></div></div>`;
  html += `<h2>Por sistema u órgano</h2><div class="card">` + P.bySystem.map((x) => {
    const pct = Math.round((x.ok / x.total) * 100);
    return `<div class="sysrow"><div class="sysname"><span>${esc(systemIcon(x.name))} ${esc(x.name)}</span><span class="muted small">${x.ok}/${x.total}${x.mejoro ? ` · <b class="g">▲${x.mejoro}</b>` : ""}${x.empeoro ? ` · <b class="r">▼${x.empeoro}</b>` : ""}</span></div><div class="bar thin"><i style="width:${pct}%"></i></div></div>`;
  }).join("") + `</div>`;
  const section = (title, list) => list.length ? `<h2>${title} (${list.length})</h2><ul class="list">${list.map(changeRow).join("")}</ul>` : "";
  const by = (c) => P.items.filter((i) => i.change === c).sort((a, b) => a.name.localeCompare(b.name, "es"));
  html += section("Empeoraron", by("empeoro")) + section("Mejoraron", by("mejoro"));
  html += section("Siguen fuera de rango sin cambio", by("igual").filter((i) => i.last.status !== "normal")) + section("Nuevos en este estudio", by("nuevo"));
  return html + `<p class="muted small">Se compara el último valor de cada indicador con el anterior. «Mejoró» incluye valores que volvieron al rango o se acercaron a él.</p></main>`;
}

const GENDERS = [["", "Selecciona"], ["F", "Mujer"], ["M", "Hombre"], ["X", "No binario"], ["N", "Prefiero no decir"]];
const RACES = [["", "Prefiero no decir"], ["mestiza", "Mestiza"], ["indigena", "Indígena"], ["blanca", "Blanca"], ["afro", "Afrodescendiente"], ["asiatica", "Asiática"], ["otra", "Otra"]];
const opts = (list, val) => list.map(([v, l]) => `<option value="${v}" ${v === (val ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("");
const ageText = (birth) => { const a = ageYears(birth); return a === null || a < 0 || a > 120 ? "" : `Edad: ${a} años`; };

/** Cuestionario inicial. Con isNew crea al paciente; si no, edita el perfil del paciente actual. */
function viewProfile(isNew) {
  const pat = isNew ? null : patient();
  const pr = pat?.profile || {};
  const cy = pr.cycle || {};
  const lastW = pat ? myWeights().slice(-1)[0] : null;
  const gender = pr.gender || (pr.sex === "F" ? "F" : pr.sex === "M" ? "M" : "");
  const cycleOn = !!cy.mode && cy.mode !== "off";
  const lastStart = [...(cy.starts || [])].sort().slice(-1)[0] || "";
  const body = `<form id="profileForm" class="card form" data-new="${isNew ? 1 : 0}">
    <p class="small muted">${isNew ? "Responde unas preguntas para personalizar la aplicación. Todo se queda en este dispositivo y puedes cambiarlo después en ⋯ → Perfil del paciente." : "Estos datos se usan para el IMC, la composición corporal y el calendario menstrual."}</p>
    ${isNew ? `<label>Nombre completo<input name="fullName" required autocomplete="name" placeholder="Nombre y apellidos"></label>`
            : `<label>Nombre para el saludo<input name="greetName" value="${esc(pr.greetName || pat?.name || "")}"></label>`}
    <label>Fecha de nacimiento<input type="date" id="qBirth" name="birthDate" value="${esc(pr.birthDate || "")}" max="${todayIso()}" required></label>
    <div class="small" id="qAge">${esc(ageText(pr.birthDate))}</div>
    <label>Género<select name="gender" id="qGender" required>${opts(GENDERS, gender)}</select></label>
    <label id="sexRow" ${gender === "X" || gender === "N" ? "" : "hidden"}>Para las referencias clínicas (grasa corporal) usar el rango<select name="sex">${opts([["", "Sin indicar"], ["F", "Femenino"], ["M", "Masculino"]], gender === "X" || gender === "N" ? pr.sex : "")}</select></label>
    <div class="grid2"><label>Peso (kg)<input name="kg" inputmode="decimal" placeholder="70.5" value="${lastW ? esc(lastW.kg) : ""}" ${isNew ? "required" : ""}></label>
    <label>Altura (cm)<input name="heightCm" inputmode="decimal" placeholder="165" value="${esc(pr.heightCm ?? "")}"></label></div>
    <label>Raza u origen (opcional)<select name="race">${opts(RACES, pr.race)}</select></label>
    <p class="small muted">La raza solo se guarda como dato de contexto; no cambia ningún cálculo.</p>
    <label class="check" id="cycleRow" ${gender === "M" ? "hidden" : ""}><input type="checkbox" name="cycleOn" id="qCycleOn" ${cycleOn ? "checked" : ""}> Quiero llevar un calendario menstrual</label>
    <fieldset id="cycleBlock" ${cycleOn && gender !== "M" ? "" : "hidden"}><legend>Calendario menstrual</legend>
      <label>Situación actual<select name="cycleMode" id="qCycleMode">${opts([["natural", "Ciclo menstrual natural"], ["hormonal", "Uso anticonceptivo hormonal"], ["none", "Embarazo, posparto o menopausia"]], cy.mode === "hormonal" || cy.mode === "none" ? cy.mode : "natural")}</select></label>
      <div id="naturalFields" ${cy.mode === "hormonal" || cy.mode === "none" ? "hidden" : ""}>
        <label>Primer día de tu última regla<input type="date" name="lastStart" value="${esc(lastStart)}" max="${todayIso()}"></label>
        <div class="grid2"><label>Ciclo (días)<input name="cycleLength" inputmode="numeric" value="${esc(cy.cycleLength ?? 28)}"></label>
        <label>Regla (días)<input name="periodLength" inputmode="numeric" value="${esc(cy.periodLength ?? 5)}"></label></div>
        <label>¿Tus ciclos son regulares?<select name="regular">${opts([["si", "Sí"], ["no", "No"], ["", "No lo sé"]], cy.regular ?? "si")}</select></label>
        <p class="small muted">El ciclo se cuenta desde el primer día de la regla hasta el día anterior a la siguiente (lo habitual son 21 a 35 días).</p>
      </div>
      <p class="small muted" id="hormNote" ${cy.mode === "hormonal" ? "" : "hidden"}>Con anticonceptivos hormonales no hay un ciclo natural con ovulación, por lo que no se calculan fases.</p>
    </fieldset>
    <div class="err" id="qErr"></div>
    <button class="primary" type="submit">${isNew ? "Continuar" : "Guardar"}</button>
    ${isNew ? `<button class="link" type="button" data-action="import">Prefiero importar un PDF primero</button>` : ""}
  </form>`;
  if (isNew) return `<header class="top"><h1>Bienvenido</h1></header><main><h2 class="hello">Cuéntanos sobre ti</h2>${body}</main>`;
  return `${header("Perfil del paciente", true)}<main>${body}</main>`;
}

function ageYears(birth) {
  if (!birth) return null;
  const b = new Date(birth + "T12:00:00"), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}

async function submitProfile(form) {
  const isNew = form.dataset.new === "1";
  const f = new FormData(form);
  const err = (m) => { document.getElementById("qErr").textContent = m; };
  const num = (n) => { const r = String(f.get(n) || "").trim().replace(",", "."); return r === "" ? null : parseFloat(r); };
  const birthDate = String(f.get("birthDate") || "");
  const age = ageYears(birthDate);
  if (!birthDate || age === null || age < 0 || age > 120) return err("Escribe una fecha de nacimiento válida.");
  const gender = String(f.get("gender") || "");
  if (!gender) return err("Selecciona tu género.");
  const kg = num("kg"), heightCm = num("heightCm");
  if (kg !== null && !(kg >= 20 && kg <= 400)) return err("Escribe un peso entre 20 y 400 kg.");
  if (isNew && kg === null) return err("Escribe tu peso.");
  if (heightCm !== null && !(heightCm >= 90 && heightCm <= 230)) return err("Escribe una altura entre 90 y 230 cm.");
  const sex = gender === "F" ? "F" : gender === "M" ? "M" : String(f.get("sex") || "") || null;
  const pat = isNew ? { name: "", nameKey: "", profile: {} } : patient();
  if (isNew) {
    const name = String(f.get("fullName") || "").trim().replace(/\s+/g, " ");
    if (name.length < 3) return err("Escribe tu nombre completo.");
    pat.name = name; pat.nameKey = makeKey(name);
  }
  const prev = pat.profile || {};
  let cycle = { ...(prev.cycle || {}), mode: "off" };
  if (f.get("cycleOn") && gender !== "M") {
    const mode = String(f.get("cycleMode"));
    if (mode === "natural") {
      const lastStart = String(f.get("lastStart") || "");
      const cl = num("cycleLength"), pl = num("periodLength");
      if (!lastStart || lastStart > todayIso()) return err("Indica el primer día de tu última regla.");
      if (!(cl >= 21 && cl <= 45)) return err("La duración del ciclo debe estar entre 21 y 45 días.");
      if (!(pl >= 2 && pl <= 10)) return err("La duración de la regla debe estar entre 2 y 10 días.");
      const starts = [...new Set([...(prev.cycle?.starts || []), lastStart])].sort();
      cycle = { mode, starts, cycleLength: Math.round(cl), periodLength: Math.round(pl), regular: String(f.get("regular") || "") };
    } else cycle = { ...(prev.cycle || {}), mode };
  }
  pat.profile = { ...prev, greetName: isNew ? "" : String(f.get("greetName") || "").trim(), birthDate, gender, sex, heightCm,
    race: String(f.get("race") || "") || null, cycle, answered: true };
  await savePatient(pat);
  if (isNew) { state.patients.push(pat); state.patientId = pat.id; localStorage.setItem("patientId", pat.id); }
  if (kg !== null) {
    const last = (await (async () => state.weights.filter((w) => w.patientId === pat.id).sort((a, b) => a.date.localeCompare(b.date)).slice(-1)[0])());
    if (!last || last.kg !== kg) await saveWeight(pat, { date: todayIso(), kg });
  }
  state.view = null; state.tab = "analisis";
  await load(); render();
}

const profileNudge = () => {
  const p = patient();
  return p && !state.readOnly && !p.profile?.answered ? `<div class="card"><div class="small">Responde el cuestionario inicial para calcular el IMC, la composición corporal y, si lo deseas, el calendario menstrual.</div><button class="link" data-action="profile">Abrir cuestionario</button></div>` : "";
};

const dateLong = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });

function viewCiclo() {
  const pat = patient();
  const cy = pat?.profile?.cycle;
  let html = `${header("Ciclo")}<main>`;
  if (!cy || !["natural", "hormonal"].includes(cy.mode)) return html + `<div class="empty"><p>El calendario menstrual no está activado.</p>${state.readOnly ? "" : `<button class="primary" data-action="profile">Activar en el perfil</button>`}</div></main>`;
  if (cy.mode === "hormonal") return html + `<div class="card"><strong>Anticonceptivo hormonal</strong><p class="small">Con anticonceptivos hormonales no hay un ciclo natural con ovulación, por eso no se calculan fases.</p>${state.readOnly ? "" : `<button class="link" data-action="profile">Editar perfil</button>`}</div></main>`;
  const today = todayIso();
  const now = phaseOn(cy, today);
  if (!now) return html + `<div class="empty"><p>Falta la fecha de la última regla.</p>${state.readOnly ? "" : `<button class="primary" data-action="periodStart">Registrar inicio de regla</button>`}</div></main>`;
  const ph = PHASES[now.phase];
  html += `<div class="card cyc"><div class="muted small">Hoy · ${esc(dateLong(today))}</div>
    <div class="phase" style="--c:${ph.color}">Fase ${esc(ph.name.toLowerCase())}</div>
    <div class="big">Día ${now.day}<span class="of"> de ${now.length}</span></div>
    <p class="small">${esc(ph.text)}</p>
    <ul class="facts"><li>Próxima regla estimada: <strong>${esc(dateLong(now.nextStart))}</strong> (${now.daysToNext === 1 ? "mañana" : `en ${now.daysToNext} días`})</li>
    <li>Ovulación estimada: <strong>${esc(dateLong(now.ovulation))}</strong></li>
    <li>Ventana fértil estimada: <strong>${esc(fmtDate(now.fertile.from))} al ${esc(fmtDate(now.fertile.to))}</strong>${now.inFertileWindow ? " · estás dentro de ella" : ""}</li></ul>
    ${now.projected ? `<p class="small muted">Estimación proyectada: no hay un registro de regla reciente. Registra el inicio de tu última regla para afinar el cálculo.</p>` : ""}
    ${now.irregular ? `<p class="small muted">Como tus ciclos no son regulares, las fechas pueden variar varios días.</p>` : ""}
    ${state.readOnly ? "" : `<button class="primary wide" data-action="periodStart">Registrar inicio de regla</button>`}</div>`;
  const cm = state.calMonth || { y: new Date().getFullYear(), m: new Date().getMonth() };
  const title = new Date(cm.y, cm.m, 1).toLocaleDateString("es-MX", { month: "long" }) + " de " + cm.y;
  const starts = new Set(cy.starts || []);
  html += `<div class="card"><div class="calhead"><button class="icon" data-action="calPrev" aria-label="Mes anterior">‹</button><strong>${esc(title)}</strong><button class="icon" data-action="calNext" aria-label="Mes siguiente">›</button></div>
    <div class="cal">${["L", "M", "M", "J", "V", "S", "D"].map((d) => `<span class="dow">${d}</span>`).join("")}` +
    monthGrid(cm.y, cm.m, cy).map((c) => {
      if (!c) return `<span></span>`;
      const i = c.info, col = i ? PHASES[i.phase].color : "transparent";
      return `<span class="day${c.date === today ? " today" : ""}${i?.inFertileWindow ? " fertile" : ""}${starts.has(c.date) ? " start" : ""}" style="--c:${col}" title="${i ? esc(PHASES[i.phase].name) : ""}">${c.d}</span>`;
    }).join("") + `</div>
    <div class="legend">${Object.values(PHASES).map((p) => `<span><i style="background:${p.color}"></i>${esc(p.name)}</span>`).join("")}<span><i class="ring"></i>Ventana fértil</span><span><i class="dot"></i>Inicio de regla</span></div></div>`;
  const hist = [...(cy.starts || [])].sort().reverse().slice(0, 8);
  html += `<h2>Inicios de regla registrados</h2><ul class="list">${hist.map((d) => `<li class="row static"><span class="grow"><span class="name">${esc(fmtDate(d))}</span></span>${state.readOnly ? "" : `<button class="icon danger" data-action="delStart" data-date="${d}" aria-label="Borrar">✕</button>`}</li>`).join("")}</ul>
    <p class="small muted">Ciclo promedio usado: ${cycleLength(cy)} días. Las fases son estimaciones basadas en un ciclo típico; no sustituyen la valoración médica ni sirven como método anticonceptivo.</p></main>`;
  return html;
}

function registerPeriod() {
  const pat = patient();
  showForm({ title: "Inicio de regla", intro: "Indica el primer día de sangrado.",
    fields: [{ name: "d", label: "Fecha", type: "date", value: todayIso(), max: todayIso() }], okLabel: "Guardar",
    onSubmit: async ({ d }) => {
      if (!d || d > todayIso()) return "Escribe una fecha válida.";
      const cy = pat.profile.cycle;
      pat.profile = { ...pat.profile, cycle: { ...cy, starts: [...new Set([...(cy.starts || []), d])].sort() } };
      await savePatient(pat); await load(); render();
    } });
}
async function removePeriod(date) {
  const pat = patient(), cy = pat.profile.cycle;
  pat.profile = { ...pat.profile, cycle: { ...cy, starts: (cy.starts || []).filter((x) => x !== date) } };
  await savePatient(pat); await load(); render();
}

const greeting = () => {
  const p = patient();
  const n = (p?.profile?.greetName || p?.name || "").trim();
  return n ? `¡Bienvenido ${n}!` : "¡Bienvenido!";
};

/** Agrupa filas por tipo de estudio o por sistema u órgano, según la preferencia elegida. */
function groupRows(rows) {
  const byName = (a, b) => a.name.localeCompare(b.name, "es");
  if (state.groupBy === "system") {
    return SYSTEM_NAMES.map((g) => [`${systemIcon(g)} ${g}`, rows.filter((s) => systemOf(s.name, s.category) === g).sort(byName)]).filter(([, r]) => r.length);
  }
  return CATEGORIES.map((c) => [c, rows.filter((s) => s.category === c).sort(byName)]).filter(([, r]) => r.length);
}
const groupToggle = () => `<div class="seg" role="group" aria-label="Agrupar por"><span class="muted small">Agrupar por</span>
  <button data-action="groupBy" data-mode="study" class="${state.groupBy === "study" ? "on" : ""}">Estudio</button>
  <button data-action="groupBy" data-mode="system" class="${state.groupBy === "system" ? "on" : ""}">Sistema u órgano</button></div>`;

function viewAnalisis() {
  const reports = myReports();
  if (!reports.length) return `${header("Análisis")}<main><h2 class="hello">${esc(greeting())}</h2>${profileNudge()}<div class="empty"><p>Todavía no hay análisis.</p><p class="muted">${state.readOnly ? "Tu médico aún no ha publicado resultados." : "Importa un PDF de laboratorio y los resultados se leen automáticamente."}</p>${state.readOnly ? "" : `<button class="primary" data-action="import">Importar PDF</button>`}</div></main>`;
  const all = buildSeries();
  const prog = progress(all, reports);
  const byKey = new Map(prog.items.map((i) => [i.key, i]));
  const flagged = all.filter((s) => s.points[s.points.length - 1].status !== "normal").length;
  const q = state.search.trim().toLowerCase();
  const list = all.filter((s) => (!q || s.name.toLowerCase().includes(q)) && (!state.onlyOut || s.points[s.points.length - 1].status !== "normal"));
  let html = `${header(patient().name)}<main>
    <h2 class="hello">${esc(greeting())}</h2>${profileNudge()}
    <div class="card summary">${reports.length} informe${reports.length === 1 ? "" : "s"} · <strong>${flagged}</strong> de ${all.length} parámetros fuera de rango en su último valor</div>
    <div class="tools"><input id="search" type="search" placeholder="Buscar parámetro" value="${esc(state.search)}"><label class="check"><input type="checkbox" id="onlyOut" ${state.onlyOut ? "checked" : ""}> Solo fuera de rango</label></div>${groupToggle()}`;
  for (const [cat, rows] of groupRows(list)) {
    html += `<h2>${cat}</h2><ul class="list">` + rows.map((s) => {
      const last = s.points[s.points.length - 1];
      const nums = s.points.filter((p) => p.value !== null).map((p) => ({ t: p.t, v: p.value }));
      return `<li><button class="row" data-action="analyte" data-key="${esc(s.key)}">
        <span class="grow"><span class="name">${esc(s.name)}</span><span class="sub">${fmtDate(last.date)} · ${s.points.length} estudio${s.points.length === 1 ? "" : "s"}</span></span>
        ${sparkline(nums, last.status)}
        <span class="val"><strong>${esc(display(last))} ${esc(last.unit)}</strong>${badge(last.status)}${trendChip(byKey.get(s.key))}</span></button></li>`;
    }).join("") + "</ul>";
  }
  if (!list.length) html += `<p class="muted center">Sin resultados para ese filtro.</p>`;
  return html + "</main>";
}

function viewAnalyte(key) {
  const s = buildSeries().find((x) => x.key === key);
  if (!s) return viewAnalisis();
  const nums = s.points.filter((p) => p.value !== null);
  const refPt = nums[nums.length - 1] || s.points[s.points.length - 1];
  const unit = s.points[s.points.length - 1].unit;
  let html = `${header(s.name, true)}<main>`;
  if (nums.length) {
    html += `<div class="card"><div class="muted small">Tendencia${unit ? ` (${esc(unit)})` : ""}</div>${lineChart({ points: nums.map((p) => ({ t: p.t, v: p.value, status: p.status })), refLow: refPt.refLow, refHigh: refPt.refHigh, label: "Tendencia de " + s.name })}
      <div class="muted small">Las líneas punteadas son los límites de referencia del estudio más reciente: ${esc(reference(refPt))}.</div></div>`;
  }
  html += `<h2>Historial</h2><ul class="list">` + [...s.points].reverse().map((p) => `<li class="row static"><span class="grow"><span class="name">${fmtDate(p.date)}</span><span class="sub">Referencia: ${esc(reference(p))}</span></span><span class="val"><strong>${esc(display(p))} ${esc(p.unit)}</strong>${badge(p.status)}</span></li>`).join("") + "</ul>";
  if (!state.readOnly) html += `<button class="danger-btn wide" data-action="delAnalyte" data-key="${esc(s.key)}">Eliminar este indicador (lectura errónea)</button>`;
  html += "</main>";
  return html;
}

function viewHistorico() {
  const reports = myReports();
  if (!reports.length) return `${header("Histórico")}<main><h2 class="hello">${esc(greeting())}</h2><div class="empty"><p>Todavía no hay análisis.</p><p class="muted">Cuando haya informes aparecerá aquí cada indicador a lo largo del tiempo.</p>${state.readOnly ? "" : `<button class="primary" data-action="import">Importar PDF</button>`}</div></main>`;
  const all = buildSeries();
  const q = state.histSearch.trim().toLowerCase();
  const cols = [...reports].sort((a, b) => a.date.localeCompare(b.date));
  const list = all.filter((s) => (!q || s.name.toLowerCase().includes(q)) && (!state.histOnlyOut || s.points.some((p) => p.status !== "normal")));
  let html = `${header("Histórico")}<main>
    <div class="tools"><input id="histSearch" type="search" placeholder="Buscar indicador" value="${esc(state.histSearch)}"><label class="check"><input type="checkbox" id="histOnlyOut" ${state.histOnlyOut ? "checked" : ""}> Con algún valor fuera de rango</label></div>${groupToggle()}
    <p class="muted small">${all.length} indicadores en ${cols.length} informe${cols.length === 1 ? "" : "s"}. Toca un indicador para ver su gráfica.</p>`;
  for (const [cat, rows] of groupRows(list)) {
    html += `<h2>${cat}</h2><div class="histwrap"><table class="hist"><thead><tr><th class="sticky">Indicador</th>${cols.map((r, i) => `<th class="${i === cols.length - 1 ? "latest" : ""}">${fmtDate(r.date)}${i === cols.length - 1 ? "<small>último</small>" : ""}</th>`).join("")}</tr></thead><tbody>` +
      rows.map((s) => {
        const byRid = new Map(s.points.map((pt, i) => [pt.rid, { ...pt, change: i ? compare({ ...s, points: s.points.slice(0, i + 1) }) : null }]));
        const unit = s.points[s.points.length - 1].unit;
        return `<tr><th class="sticky"><button data-action="analyte" data-key="${esc(s.key)}">${esc(s.name)}<small>${esc(unit)}</small></button></th>` +
          cols.map((r) => { const pt = byRid.get(r.id); const ch = pt?.change; const ar = ch && ch.delta ? `<sup class="ar ${CHANGE[ch.change][0]}">${ch.delta > 0 ? "▲" : "▼"}</sup>` : ""; return pt ? `<td class="st-${pt.status}${r.date === cols[cols.length - 1].date ? " latest" : ""}" title="Referencia: ${esc(reference(pt))}">${esc(display(pt))}${ar}</td>` : `<td class="none">–</td>`; }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";
  }
  if (!list.length) html += `<p class="muted center">Sin resultados para ese filtro.</p>`;
  html += `<button class="link wide" data-action="exportCsv">Exportar histórico (CSV)</button>`;
  return html + "</main>";
}

async function exportCsv() {
  const p = patient();
  const all = buildSeries();
  const cols = [...myReports()].sort((a, b) => a.date.localeCompare(b.date));
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Categoría", "Sistema u órgano", "Indicador", "Unidad", ...cols.map((r) => r.date)].map(q).join(",")];
  for (const cat of CATEGORIES) for (const s of all.filter((x) => x.category === cat)) {
    const by = new Map(s.points.map((pt) => [pt.rid, pt]));
    lines.push([cat, systemOf(s.name, s.category), s.name, s.points[s.points.length - 1].unit, ...cols.map((r) => { const pt = by.get(r.id); return pt ? display(pt) : ""; })].map(q).join(","));
  }
  const name = `historico-${todayIso()}.csv`;
  const file = new File(["\ufeff" + lines.join("\r\n")], name, { type: "text/csv" });
  const go = async () => {
    try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; } }
    catch (e) { if (e.name === "AbortError") return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
  if (p?.protection) showDialog("Archivo sin cifrar", "El CSV no está protegido con contraseña. Guárdalo en un lugar seguro.", [{ label: "Cancelar" }, { label: "Exportar", onClick: go }]);
  else go();
}

const LEVEL_TEXT = { normal: "Dentro de rangos", fuera: "Atención moderada", alto: "Atención", "sin datos": "Sin datos" };
const dash = (v, unit = "") => (v == null ? "–" : `${fmt(v)}${unit}`);

function compositionCard(w, prof) {
  const c = compose(w, prof);
  const line = (name, item, unit) => item ? `<li class="row static"><span class="grow"><span class="name">${name}</span>${item.range ? `<span class="sub">Referencia: ${esc(item.range)}</span>` : ""}</span><span class="val"><strong>${esc(fmt(item.value))}${unit}</strong>${item.status ? `<span class="badge st-${item.status}">${esc(item.label)}</span>` : ""}</span></li>` : "";
  let html = `<div class="card comp"><div class="muted small">Composición corporal · ${fmtDate(w.date)}</div>
    <div class="compHead st-${c.level === "sin datos" ? "normal" : c.level}">${esc(c.headline)}</div>
    <ul class="list">${line("IMC", c.bmi, "")}${line("Grasa corporal", c.fat, " %")}${line("Agua corporal", c.water, " %")}${line("Masa ósea", c.bone, " kg")}</ul>`;
  if (c.bmi) html += `<p class="cheer">Lo estás logrando: tu constancia se nota y tienes un cuerpo extraordinario. Sigue así.</p>`;
  if (c.fat) html += `<p class="small">Masa grasa: <strong>${fmt(c.fatMassKg)} kg</strong> · Masa magra: <strong>${fmt(c.leanMassKg)} kg</strong>${c.waterKg ? ` · Agua: <strong>${fmt(c.waterKg)} kg</strong>` : ""}</p>`;
  if (c.paragraphs.length) html += `<p class="small">${c.paragraphs.map(esc).join(" ")}</p>`;
  if (c.missing.length) html += `<p class="small muted">Para una evaluación completa falta ${esc(c.missing.join(", "))} en el perfil.</p>${state.readOnly ? "" : `<button class="link" data-action="profile">Completar perfil</button>`}`;
  html += `<p class="muted small">Referencias: IMC de la OMS para adultos; grasa de Gallagher y colaboradores (2000); agua y masa ósea de guías de básculas de bioimpedancia. Las mediciones por bioimpedancia son estimaciones y varían con la hidratación. Esta lectura es informativa y no sustituye la valoración de un profesional de la salud.</p></div>`;
  return html;
}

function viewPeso() {
  const ws = myWeights();
  const pat = patient();
  const kg = (v) => `${fmt(Number(v.toFixed(1)))} kg`;
  const delta = (v) => `${v > 0 ? "+" : ""}${fmt(Number(v.toFixed(1)))} kg`;
  if (!pat) return `${header("Peso")}<main><div class="empty"><p>Primero crea un paciente o importa un PDF.</p><button class="primary" data-action="newPatient">Nuevo paciente</button></div></main>`;
  const prof = pat.profile || {};
  let html = `${header("Peso")}<main>`;
  if (!state.readOnly && (!prof.heightCm || !prof.sex || !prof.birthDate)) html += `<div class="card"><div class="small">Completa la altura, el sexo y la fecha de nacimiento para calcular el IMC y evaluar la composición corporal.</div><button class="link" data-action="profile">Completar perfil</button></div>`;
  if (!state.readOnly) html += `<form id="weightForm" class="card form"><div class="grid2"><label>Fecha<input type="date" name="date" value="${todayIso()}" max="${todayIso()}" required></label>
    <label>Peso (kg)<input name="kg" inputmode="decimal" placeholder="70.5" required></label></div>
    <div class="grid3"><label>% grasa<input name="fatPct" inputmode="decimal" placeholder="opcional"></label>
    <label>% agua<input name="waterPct" inputmode="decimal" placeholder="opcional"></label>
    <label>Huesos (kg)<input name="boneKg" inputmode="decimal" placeholder="opcional"></label></div>
    <label>Nota (opcional)<input name="note" maxlength="80"></label><button class="primary" type="submit">Guardar</button></form>`;
  if (ws.length) {
    const last = ws[ws.length - 1];
    const lastBmi = calcBmi(last.kg, prof.heightCm);
    html += `<div class="card"><div class="big">${kg(last.kg)}</div><div class="muted small">Último registro: ${fmtDate(last.date)}</div>${lastBmi ? `<div class="small">IMC: <strong>${fmt(Number(lastBmi.toFixed(1)))}</strong></div>` : ""}`;
    if (ws.length > 1) html += `<div class="small">Frente al registro anterior: <strong>${delta(last.kg - ws[ws.length - 2].kg)}</strong></div><div class="small">Desde el primer registro (${fmtDate(ws[0].date)}): <strong>${delta(last.kg - ws[0].kg)}</strong></div>`;
    html += "</div>";
    const comp = [...ws].reverse().find((w) => w.fatPct != null || w.waterPct != null || w.boneKg != null);
    html += compositionCard(comp || last, prof);
    const chart = (title, pts, label) => pts.length > 1 ? `<div class="card"><div class="muted small">${title}</div>${lineChart({ points: pts, label })}</div>` : "";
    html += chart("Evolución del peso (kg)", ws.map((w) => ({ t: toTime(w.date), v: w.kg, status: "normal" })), "Evolución del peso");
    if (prof.heightCm) html += chart("Evolución del IMC", ws.map((w) => ({ t: toTime(w.date), v: Number(calcBmi(w.kg, prof.heightCm).toFixed(1)), status: "normal" })), "Evolución del IMC");
    html += chart("Evolución de la grasa corporal (%)", ws.filter((w) => w.fatPct != null).map((w) => ({ t: toTime(w.date), v: w.fatPct, status: "normal" })), "Evolución de la grasa");
    html += chart("Evolución del agua corporal (%)", ws.filter((w) => w.waterPct != null).map((w) => ({ t: toTime(w.date), v: w.waterPct, status: "normal" })), "Evolución del agua");
    html += chart("Evolución de la masa ósea (kg)", ws.filter((w) => w.boneKg != null).map((w) => ({ t: toTime(w.date), v: w.boneKg, status: "normal" })), "Evolución de la masa ósea");
    html += `<h2>Registros</h2><ul class="list">` + [...ws].reverse().map((w) => {
      const extra = [w.fatPct != null ? `grasa ${fmt(w.fatPct)} %` : "", w.waterPct != null ? `agua ${fmt(w.waterPct)} %` : "", w.boneKg != null ? `huesos ${fmt(w.boneKg)} kg` : "", w.note || ""].filter(Boolean).join(" · ");
      return `<li class="row static"><span class="grow"><span class="name">${fmtDate(w.date)}</span>${extra ? `<span class="sub">${esc(extra)}</span>` : ""}</span><strong>${kg(w.kg)}</strong>${state.readOnly ? "" : `<button class="icon danger" data-action="delWeight" data-id="${w.id}" aria-label="Borrar">✕</button>`}</li>`;
    }).join("") + "</ul>";
  } else html += `<p class="muted center">Sin registros de peso todavía.</p>`;
  return html + "</main>";
}

function viewInformes() {
  const reports = [...myReports()].reverse();
  let html = `${header("Informes")}<main>${state.readOnly ? "" : `<button class="primary wide" data-action="import">Importar PDF</button>`}`;
  if (!reports.length) return html + `<p class="muted center">Sin informes.</p></main>`;
  html += `<ul class="list">` + reports.map((r) => {
    const out = r.results.filter((x) => x.status !== "normal").length;
    const hash = state.readOnly ? r.pdf : fileOf(r) ? r.fileHash : null;
    const info = `<span class="grow"><span class="name">${fmtDate(r.date)}</span><span class="sub">${esc(r.lab)}${hash ? " · 📎 PDF" : ""}</span></span><span class="sub right">${r.results.length} resultados<br>${out} fuera de rango</span>`;
    if (state.readOnly) return `<li class="row static">${info}${hash ? `<span class="pdfbtns"><button class="mini" data-action="openPdf" data-hash="${hash}">Abrir PDF</button><button class="mini" data-action="openPdf" data-mode="download" data-hash="${hash}">Descargar</button></span>` : ""}</li>`;
    return `<li><button class="row" data-action="report" data-id="${r.id}">${info}<span class="chev">›</span></button></li>`;
  }).join("") + "</ul></main>";
  return html;
}

function viewReport(id) {
  const r = state.reports.filter((x) => x.id === id).map(standard)[0];
  if (!r) return viewInformes();
  let html = `${header("Informe", true)}<main><div class="card form"><label>Fecha de toma<input type="date" id="reportDate" value="${r.date}" max="${todayIso()}"></label>
    <div class="muted small">${esc(r.lab)}${r.folio ? " · folio " + esc(r.folio) : ""}</div></div>`;
  for (const cat of CATEGORIES) {
    const rows = r.results.filter((x) => x.category === cat);
    if (!rows.length) continue;
    html += `<h2>${cat}</h2><ul class="list">` + rows.map((x) => `<li class="row static"><span class="grow"><span class="name">${esc(x.name)}</span><span class="sub">Referencia: ${esc(reference(x))}</span></span><span class="val"><strong>${esc(display(x))} ${esc(x.unit)}</strong>${badge(x.status)}</span>${state.readOnly ? "" : `<button class="icon danger" data-action="delResult" data-id="${r.id}" data-key="${esc(x.key)}" aria-label="Eliminar este resultado del informe">✕</button>`}</li>`).join("") + "</ul>";
  }
  const f = fileOf(r);
  html += f ? `<div class="card"><div class="small">📎 <strong>${esc(f.name)}</strong> · ${fmt(Number((f.size / 1024).toFixed(0)))} KB</div>
      <div class="pdfbtns"><button class="mini" data-action="openPdf" data-hash="${r.fileHash}">Abrir PDF</button><button class="mini" data-action="openPdf" data-mode="download" data-hash="${r.fileHash}">Descargar</button></div></div>`
    : `<div class="card"><div class="small muted">No hay PDF guardado de este informe. Impórtalo de nuevo y se guardará.</div></div>`;
  html += `<details class="card"><summary>Texto extraído del PDF</summary><pre>${esc(r.rawText)}</pre></details>
    <button class="danger-btn wide" data-action="delReport" data-id="${r.id}">Borrar este informe</button></main>`;
  return html;
}

function nav() {
  const tabs = [["analisis", "Análisis", "🩸"], ["avances", "Avances", "📈"], ["historico", "Histórico", "🗂️"], ["peso", "Peso", "⚖️"]];
  if (["natural", "hormonal"].includes(patient()?.profile?.cycle?.mode)) tabs.push(["ciclo", "Ciclo", "🌙"]);
  if (!state.readOnly || myReports().some((r) => r.pdf)) tabs.push(["informes", "Informes", "📄"]);
  return `<nav class="tabs">${tabs.map(([k, l, i]) => `<button data-action="tab" data-tab="${k}" class="${state.tab === k && !state.view ? "active" : ""}"><span>${i}</span>${l}</button>`).join("")}</nav>`;
}

function render() {
  const app = document.getElementById("app");
  const keepScroll = window.scrollY;
  let html;
  const cur = patient();
  const locked = isLocked(cur);
  if (state.mode === "portal" && !state.readOnly) { app.innerHTML = viewPortal(); return; }
  if (locked) html = viewLocked(cur);
  else if (state.view?.type === "analyte") html = viewAnalyte(state.view.key);
  else if (state.view?.type === "report") html = viewReport(state.view.id);
  else if (state.view?.type === "profile") html = viewProfile(false);
  else if (!state.patients.length && !state.readOnly) html = viewProfile(true);
  else html = state.tab === "avances" ? viewAvances() : state.tab === "peso" ? viewPeso() : state.tab === "ciclo" ? viewCiclo() : state.tab === "historico" ? viewHistorico() : state.tab === "informes" ? viewInformes() : viewAnalisis();
  app.innerHTML = html + (locked || !state.patients.length ? "" : nav()) + (state.busy ? `<div class="busy"><div class="spinner"></div>Leyendo PDF…</div>` : "");
  if (state.view) window.scrollTo(0, 0); else window.scrollTo(0, keepScroll);
}

// ---------- Diálogos ----------
function showDialog(title, body, actions = [{ label: "Listo" }]) {
  document.getElementById("dlg")?.remove();
  const d = document.createElement("dialog");
  d.id = "dlg";
  d.innerHTML = `<h3>${esc(title)}</h3><div class="dlgbody">${body}</div><div class="dlgactions">${actions.map((a, i) => `<button data-i="${i}" class="${a.kind || ""}">${esc(a.label)}</button>`).join("")}</div>`;
  d.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    const a = actions[Number(b.dataset.i)];
    d.close(); d.remove();
    a.onClick?.();
  });
  document.body.appendChild(d);
  d.showModal();
}

function askText(title, placeholder, onOk) {
  showDialog(title, `<input id="dlgInput" placeholder="${esc(placeholder)}" autocomplete="off">`, [
    { label: "Cancelar" },
    { label: "Crear", kind: "primary", onClick: () => onOk(input.value) },
  ]);
  const input = document.getElementById("dlgInput");
  input.focus();
}

function showMenu() {
  const p = patient();
  if (state.readOnly) {
    showDialog("Menú", `<div class="menu"><button data-menu="logout">Cerrar sesión</button><p class="muted small">Por seguridad la sesión se cierra sola tras unos minutos sin actividad.</p></div>`);
    document.querySelector("#dlg .menu").addEventListener("click", (e) => {
      if (!e.target.closest("[data-menu=logout]")) return;
      document.getElementById("dlg")?.remove(); leavePortal();
    });
    return;
  }
  const protect = !p ? "" : !p.protection
    ? `<button data-menu="protect">Proteger «${esc(p.name)}» con contraseña</button>`
    : `<button data-menu="lock">Bloquear ahora</button><button data-menu="changePw">Cambiar contraseña</button><button data-menu="removePw">Quitar contraseña</button>`;
  showDialog("Menú", `<div class="menu">
      <button data-menu="newPatient">Nuevo paciente</button>
      ${p ? `<button data-menu="profile">Perfil del paciente (nombre, altura, sexo, nacimiento)</button>` : ""}
      ${p && !isLocked(p) ? `<button data-menu="publish">Publicar resultados para el paciente</button>` : ""}
      <button data-menu="asPatient">Ver como paciente (prueba)</button>
      ${protect}
      ${p ? `<button data-menu="delPatient" class="danger-text">Borrar paciente «${esc(p.name)}» y sus datos</button>` : ""}
      ${p && !isLocked(p) && p.profile?.ignored?.length ? `<button data-menu="restoreIgnored">Permitir de nuevo indicadores eliminados (${p.profile.ignored.length})</button>` : ""}
      <button data-menu="export">Exportar copia de respaldo</button>
      <button data-menu="backup">Importar copia de respaldo</button>
      <p class="muted small">Los datos se guardan solo en este dispositivo. Los pacientes con contraseña se guardan cifrados, también en la copia de respaldo. Haz copias con regularidad, sobre todo antes de cambiar de teléfono.</p>
    <p class="muted small center">Versión 16</p>
    </div>`);
  document.querySelector("#dlg .menu").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-menu]");
    if (!b) return;
    document.getElementById("dlg")?.close(); document.getElementById("dlg")?.remove();
    menuAction(b.dataset.menu);
  });
}

// ---------- Contraseñas ----------
/** Formulario modal que se queda abierto mientras onSubmit devuelva un mensaje de error. */
function showForm({ title, intro = "", fields, okLabel, onSubmit }) {
  document.getElementById("dlg")?.remove();
  const d = document.createElement("dialog");
  d.id = "dlg";
  d.innerHTML = `<h3>${esc(title)}</h3><form class="form" autocomplete="off">${intro ? `<p class="small muted">${intro}</p>` : ""}
    ${fields.map((f) => f.type === "select"
      ? `<label>${esc(f.label)}<select name="${f.name}">${f.options.map(([v, l]) => `<option value="${v}" ${v === (f.value ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`
      : `<label>${esc(f.label)}<input name="${f.name}" type="${f.type || "password"}" value="${esc(f.value ?? "")}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ""} ${f.max ? `max="${f.max}"` : ""} autocomplete="${f.autocomplete || "off"}" ${f.optional ? "" : "required"}></label>`).join("")}
    <div class="err" id="formErr"></div>
    <div class="dlgactions"><button type="button" data-cancel>Cancelar</button><button type="submit" class="primary">${esc(okLabel)}</button></div></form>`;
  document.body.appendChild(d);
  const form = d.querySelector("form");
  let done = false;
  const close = (value) => { if (done) return; done = true; d.close(); d.remove(); d.dispatchEvent(new CustomEvent("closed", { detail: value })); };
  d.querySelector("[data-cancel]").addEventListener("click", () => close(false));
  d.addEventListener("cancel", () => close(false));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Procesando…";
    const values = Object.fromEntries(new FormData(form));
    let err;
    try { err = await onSubmit(values); } catch (x) { console.error(x); err = "Ocurrió un error. Inténtalo de nuevo."; }
    if (err) { document.getElementById("formErr").textContent = err; btn.disabled = false; btn.textContent = okLabel; }
    else close(true);
  });
  d.showModal();
  form.querySelector("input")?.focus();
  return d;
}

function requestUnlock(pat) {
  return new Promise((resolve) => {
    const d = showForm({
      title: "Paciente protegido", intro: `Escribe la contraseña de <strong>${esc(pat.name)}</strong>.`,
      fields: [{ name: "pw", label: "Contraseña", autocomplete: "current-password" }], okLabel: "Desbloquear",
      onSubmit: async ({ pw }) => {
        const key = await tryUnlock(pw, pat.protection);
        if (!key) return "Contraseña incorrecta.";
        state.keys.set(pat.id, key);
        await load();
      },
    });
    d.addEventListener("closed", (e) => resolve(e.detail === true));
  });
}

const passwordProblem = (a, b) => (a.length < 8 ? "La contraseña debe tener al menos 8 caracteres." : a !== b ? "Las contraseñas no coinciden." : "");
const NO_RECOVERY = "<strong>No hay forma de recuperarla.</strong> Si la olvidas, los datos de este paciente no se podrán leer. Guarda una copia de respaldo y anota la contraseña en un lugar seguro.";

/** Vuelve a guardar todos los datos del paciente con una clave nueva (o sin cifrar) en una sola transacción. */
async function reencrypt(pat, newKey, newMeta) {
  const updated = { ...pat };
  const profile = { ...(pat.profile || {}) };
  if (pat.birthDate && !profile.birthDate) profile.birthDate = pat.birthDate;   // la fecha de nacimiento antigua pasa al perfil
  delete updated.birthDate;
  if (newMeta) { updated.protection = newMeta; updated.profileEnc = await encryptJSON(newKey, profile); delete updated.profile; }
  else { delete updated.protection; delete updated.profileEnc; updated.profile = profile; }
  const reports = [], weights = [];
  for (const r of state.reports.filter((x) => x.patientId === pat.id)) reports.push(await encodeRecord(updated, r, REPORT_FIELDS, newKey));
  for (const w of state.weights.filter((x) => x.patientId === pat.id)) weights.push(await encodeRecord(updated, w, WEIGHT_FIELDS, newKey));
  const files = [], blobs = [];
  for (const f of state.files.filter((x) => x.patientId === pat.id)) {
    const bytes = await getPdfBytes(f);   // aún con la clave anterior
    files.push(await encodeRecord(updated, f, FILE_FIELDS, newKey));
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    blobs.push(newKey ? { id: f.id, patientId: pat.id, ...(await encryptBytes(newKey, new Uint8Array(copy))) } : { id: f.id, patientId: pat.id, data: copy });
  }
  await db.batchWrite({ patients: [updated], reports, weights, files, blobs });
  if (newKey) state.keys.set(pat.id, newKey); else state.keys.delete(pat.id);
  await load(); render();
}

function protectPatient(pat, mode) {
  const changing = mode === "change";
  showForm({
    title: changing ? "Cambiar contraseña" : "Proteger con contraseña",
    intro: NO_RECOVERY,
    fields: [
      ...(changing ? [{ name: "old", label: "Contraseña actual", autocomplete: "current-password" }] : []),
      { name: "pw", label: "Contraseña nueva (mínimo 8 caracteres)", autocomplete: "new-password" },
      { name: "pw2", label: "Repite la contraseña nueva", autocomplete: "new-password" },
    ],
    okLabel: changing ? "Cambiar" : "Proteger",
    onSubmit: async ({ old, pw, pw2 }) => {
      if (changing && !(await tryUnlock(old, pat.protection))) return "La contraseña actual es incorrecta.";
      const problem = passwordProblem(pw, pw2);
      if (problem) return problem;
      const { key, meta } = await makeProtection(pw);
      await reencrypt(pat, key, meta);
    },
  });
}

function removeProtection(pat) {
  showForm({
    title: "Quitar contraseña", intro: `Los datos de <strong>${esc(pat.name)}</strong> se guardarán sin cifrar.`,
    fields: [{ name: "old", label: "Contraseña actual", autocomplete: "current-password" }], okLabel: "Quitar",
    onSubmit: async ({ old }) => {
      if (!(await tryUnlock(old, pat.protection))) return "La contraseña es incorrecta.";
      await reencrypt(pat, null, null);
    },
  });
}

function lockAll() {
  if (state.readOnly) { leavePortal(); return; }
  if (!state.keys.size) return;
  state.keys.clear(); state.view = null;
  document.getElementById("dlg")?.remove();
  load().then(render);
}

async function menuAction(kind) {
  const p = patient();
  if (kind === "newPatient") return newPatient();
  if (kind === "publish") return publishPatient(p);
  if (kind === "asPatient") return setMode("portal");
  if (kind === "profile") { state.view = { type: "profile" }; return render(); }
  if (kind === "protect") return protectPatient(p, "set");
  if (kind === "changePw") return protectPatient(p, "change");
  if (kind === "removePw") return removeProtection(p);
  if (kind === "lock") return lockAll();
  if (kind === "restoreIgnored") {
    return showDialog("¿Permitir de nuevo?", "Los indicadores eliminados volverán a leerse en los PDF que importes a partir de ahora. Los que ya se quitaron de los estudios reaparecen al borrar el informe e importar su PDF otra vez.", [
      { label: "Cancelar" }, { label: "Permitir", onClick: async () => { p.profile = { ...(p.profile || {}), ignored: [] }; await savePatient(p); render(); } }]);
  }
  if (kind === "delPatient") {
    return showDialog("¿Borrar paciente?", `Se borrarán todos los informes y pesos de <strong>${esc(p.name)}</strong>. Esta acción no se puede deshacer.`, [
      { label: "Cancelar" }, { label: "Borrar", kind: "danger", onClick: async () => { await db.deletePatient(p.id); state.keys.delete(p.id); await load(); render(); } }]);
  }
  if (kind === "export") return exportBackup();
  if (kind === "backup") return document.getElementById("backupInput").click();
}

function newPatient() {
  askText("Nuevo paciente", "Nombre completo", async (v) => {
    const name = (v || "").trim();
    if (!name) return;
    const p = { name, nameKey: makeKey(name), profile: {} };
    await savePatient(p);
    state.patientId = p.id; localStorage.setItem("patientId", p.id);
    await load(); render();
  });
}

async function exportBackup() {
  const data = await db.exportAll();
  const name = `respaldo-seguimiento-medico-${todayIso()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: "application/json" });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- Eventos ----------
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  if (a === "tab") { state.tab = el.dataset.tab; state.view = null; if (state.tab !== "avances") state.justAdded = null; render(); }
  else if (a === "back") { state.view = null; render(); }
  else if (a === "analyte") { state.view = { type: "analyte", key: el.dataset.key }; render(); }
  else if (a === "report") { state.view = { type: "report", id: Number(el.dataset.id) }; render(); }
  else if (a === "import") document.getElementById("pdfInput").click();
  else if (a === "profile") { state.view = { type: "profile" }; render(); }
  else if (a === "calPrev" || a === "calNext") { const m = state.calMonth || { y: new Date().getFullYear(), m: new Date().getMonth() }; const d = new Date(m.y, m.m + (a === "calNext" ? 1 : -1), 1); state.calMonth = { y: d.getFullYear(), m: d.getMonth() }; render(); }
  else if (a === "periodStart") registerPeriod();
  else if (a === "openPdf") openPdf(el.dataset.hash, el.dataset.mode === "download");
  else if (a === "goAdmin") { location.hash = "#admin"; await setMode("admin"); }
  else if (a === "delStart") removePeriod(el.dataset.date);
  else if (a === "groupBy") { state.groupBy = el.dataset.mode; localStorage.setItem("groupBy", state.groupBy); render(); }
  else if (a === "exportCsv") exportCsv();
  else if (a === "menu") showMenu();
  else if (a === "newPatient") newPatient();
  else if (a === "delWeight") { await db.del("weights", Number(el.dataset.id)); await load(); render(); }
  else if (a === "delAnalyte") {
    const key = el.dataset.key, pat = patient(), s = buildSeries().find((x) => x.key === key);
    if (!pat || !s) return;
    showDialog("¿Eliminar indicador?", `Se quitará <strong>${esc(s.name)}</strong> de los ${s.points.length} estudio${s.points.length === 1 ? "" : "s"} de ${esc(pat.name)} y no volverá a aparecer al importar nuevos PDF. Los PDF originales no se modifican. Puedes revertirlo desde el menú ⋯.`, [
      { label: "Cancelar" }, { label: "Eliminar", kind: "danger", onClick: async () => { await removeIndicator(pat, key); state.view = null; render(); } }]);
  }
  else if (a === "delResult") {
    const key = el.dataset.key, id = Number(el.dataset.id), pat = patient();
    const rep = state.reports.map(standard).find((x) => x.id === id), x = rep?.results.find((r) => r.key === key);
    if (!pat || !x) return;
    showDialog("¿Quitar resultado?", `Se quitará <strong>${esc(x.name)}</strong> solo de este informe. Si vuelves a importar el PDF, reaparecerá; para quitarlo de todos los estudios, usa «Eliminar este indicador» en su ficha.`, [
      { label: "Cancelar" }, { label: "Quitar", kind: "danger", onClick: async () => { await removeIndicator(pat, key, id); render(); } }]);
  }
  else if (a === "delReport") {
    const id = Number(el.dataset.id);
    showDialog("¿Borrar informe?", "Se borrarán sus resultados. Esta acción no se puede deshacer.", [
      { label: "Cancelar" }, { label: "Borrar", kind: "danger", onClick: async () => {
        const rep = state.reports.find((x) => x.id === id), f = rep && fileOf(rep, rep.patientId);
        await db.del("reports", id);
        if (f) { await db.del("files", f.id); await db.del("blobs", f.id); }
        state.view = null; await load(); render(); } }]);
  }
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "qGender" || t.id === "qCycleOn" || t.id === "qCycleMode") {
    const g = document.getElementById("qGender").value, on = document.getElementById("qCycleOn").checked, mode = document.getElementById("qCycleMode").value;
    document.getElementById("sexRow").hidden = !(g === "X" || g === "N");
    document.getElementById("cycleRow").hidden = g === "M";
    document.getElementById("cycleBlock").hidden = !(on && g !== "M");
    document.getElementById("naturalFields").hidden = mode !== "natural";
    document.getElementById("hormNote").hidden = mode !== "hormonal";
  } else if (t.id === "patientSelect") { state.patientId = Number(t.value); localStorage.setItem("patientId", t.value); state.view = null; render(); }
  else if (t.id === "onlyOut") { state.onlyOut = t.checked; render(); }
  else if (t.id === "histOnlyOut") { state.histOnlyOut = t.checked; render(); }
  else if (t.id === "pdfInput") { const files = [...t.files]; t.value = ""; if (files.length) importFiles(files); }
  else if (t.id === "backupInput") {
    const f = t.files[0]; t.value = "";
    if (!f) return;
    try {
      const r = await db.importBackup(JSON.parse(await f.text()));
      await load(); render();
      showDialog("Copia importada", `Se agregaron ${r.addedReports} informes, ${r.addedWeights} registros de peso y ${r.addedFiles} PDF.` + (r.renamed ? ` ${r.renamed} paciente${r.renamed === 1 ? "" : "s"} tenía${r.renamed === 1 ? "" : "n"} el mismo nombre con otra contraseña y se agregó${r.renamed === 1 ? "" : "ron"} como «(respaldo)».` : ""));
    } catch (err) { showDialog("No se pudo importar", esc(err.message || "Archivo inválido.")); }
  }
  else if (t.id === "reportDate" && state.view?.type === "report" && t.value) {
    const r = state.reports.filter((x) => x.id === state.view.id).map(standard)[0];
    r.date = t.value; await saveReport(patient(), r); render();
  }
});

document.addEventListener("input", (e) => {
  const id = e.target.id;
  if (id === "qBirth") { document.getElementById("qAge").textContent = ageText(e.target.value); return; }
  if (id === "search" || id === "histSearch") {
    state[id === "search" ? "search" : "histSearch"] = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const s = document.getElementById(id); s.focus(); s.setSelectionRange(pos, pos);
  }
});

document.addEventListener("submit", async (e) => {
  if (e.target.id === "unlockForm") {
    e.preventDefault();
    const pat = patient();
    const pw = new FormData(e.target).get("pw");
    state.busy = true; render();
    const key = await tryUnlock(String(pw), pat.protection);
    state.busy = false;
    if (key) { state.keys.set(pat.id, key); state.unlockError = ""; await load(); touch(); }
    else state.unlockError = "Contraseña incorrecta.";
    render();
    return;
  }
  if (e.target.id === "portalForm") { e.preventDefault(); const f = new FormData(e.target); await portalLogin(String(f.get("pid")), String(f.get("pw"))); return; }
  if (e.target.id === "profileForm") { e.preventDefault(); await submitProfile(e.target); return; }
  if (e.target.id !== "weightForm") return;
  e.preventDefault();
  const f = new FormData(e.target);
  const num = (name) => { const raw = String(f.get(name) || "").trim().replace(",", "."); return raw === "" ? null : parseFloat(raw); };
  const kg = num("kg"), fatPct = num("fatPct"), waterPct = num("waterPct"), boneKg = num("boneKg");
  if (!(kg >= 20 && kg <= 400)) { showDialog("Peso no válido", "Escribe un peso entre 20 y 400 kg."); return; }
  if (fatPct !== null && !(fatPct >= 3 && fatPct <= 70)) { showDialog("% de grasa no válido", "Escribe un valor entre 3 y 70."); return; }
  if (waterPct !== null && !(waterPct >= 20 && waterPct <= 80)) { showDialog("% de agua no válido", "Escribe un valor entre 20 y 80."); return; }
  if (boneKg !== null && !(boneKg >= 0.5 && boneKg <= 8)) { showDialog("Masa ósea no válida", "Escribe un valor entre 0.5 y 8 kg."); return; }
  const rec = { date: f.get("date"), kg, note: String(f.get("note") || "") };
  if (fatPct !== null) rec.fatPct = fatPct;
  if (waterPct !== null) rec.waterPct = waterPct;
  if (boneKg !== null) rec.boneKg = boneKg;
  await saveWeight(patient(), rec);
  await load(); render();
});

// ---------- Bloqueo automático ----------
const IDLE_MS = 5 * 60 * 1000;        // sin tocar la pantalla
const AWAY_MS = 60 * 1000;            // aplicación en segundo plano
let lastActive = Date.now(), hiddenAt = 0;
function touch() { lastActive = Date.now(); }
["click", "keydown", "touchstart", "scroll"].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > AWAY_MS) lockAll();
  hiddenAt = 0; touch();
});
setInterval(() => { if ((state.keys.size || state.readOnly) && Date.now() - lastActive > IDLE_MS) lockAll(); }, 15000);
window.addEventListener("hashchange", async () => { if (state.readOnly) return; const m = await decideMode(); if (m !== state.mode) await setMode(m); });

// ---------- Inicio ----------
(async () => {
  state.mode = await decideMode();
  if (state.mode === "admin") { try { localStorage.setItem("mode", "admin"); } catch {} await load(); }
  render();
  if (state.mode === "portal") loadPortalList();
  if (state.mode === "admin") db.requestPersistence();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
