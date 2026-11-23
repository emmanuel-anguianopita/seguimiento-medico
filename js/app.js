import { parseDocument } from "./parser.js";
import { pdfToPages } from "./pdftext.js";
import * as db from "./db.js";
import { lineChart, sparkline, fmt } from "./charts.js";
import { makeProtection, tryUnlock, encryptJSON, decryptJSON } from "./crypto.js";

const CATEGORIES = ["Hematología", "Química clínica", "Orina", "Otros"];
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
  patients: [], reports: [], weights: [],
  patientId: Number(localStorage.getItem("patientId")) || null,
  tab: "analisis", view: null, onlyOut: false, search: "", busy: false,
  keys: new Map(), unlockError: "",
};
const REPORT_FIELDS = ["date", "lab", "folio", "fileHash", "rawText", "results", "importedAt"];
const WEIGHT_FIELDS = ["date", "kg", "note"];
const pick = (o, fields) => Object.fromEntries(fields.map((f) => [f, o[f]]));
const isLocked = (p) => !!p && !!p.protection && !state.keys.has(p.id);

// ---------- Datos ----------
async function load() {
  state.patients = (await db.all("patients")).sort((a, b) => a.name.localeCompare(b.name, "es"));
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
async function saveReport(pat, report) { report.id = await db.put("reports", await encodeRecord(pat, report, REPORT_FIELDS)); }
async function saveWeight(pat, w) { w.id = await db.put("weights", await encodeRecord(pat, w, WEIGHT_FIELDS)); }

const patient = () => state.patients.find((p) => p.id === state.patientId) || null;
const myReports = () => state.reports.filter((r) => r.patientId === state.patientId).sort((a, b) => a.date.localeCompare(b.date));
const myWeights = () => state.weights.filter((w) => w.patientId === state.patientId).sort((a, b) => a.date.localeCompare(b.date));

function buildSeries() {
  const map = new Map();
  for (const r of myReports()) for (const x of r.results) {
    const pt = { date: r.date, t: toTime(r.date), value: x.value, text: x.text, unit: x.unit, status: x.status,
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
        if (state.reports.some((r) => r.fileHash === hash)) { outcomes.push({ name: f.name, ok: false, msg: "Este PDF ya estaba importado." }); continue; }
        const pages = await pdfToPages(pdfjs, new Uint8Array(buf));
        const parsed = parseDocument(pages);
        if (!parsed.results.length) {
          outcomes.push({ name: f.name, ok: false, msg: "No se reconocieron resultados. Puede ser un PDF escaneado (imagen) o un formato de laboratorio todavía no soportado." });
          continue;
        }
        let pat;
        if (parsed.patient) {
          const key = makeKey(parsed.patient);
          pat = state.patients.find((p) => p.nameKey === key);
          if (!pat) { pat = { name: toTitle(parsed.patient), nameKey: key, birthDate: parsed.birth }; pat.id = await db.put("patients", pat); state.patients.push(pat); }
          else if (!pat.birthDate && parsed.birth && !pat.protection) { pat.birthDate = parsed.birth; await db.put("patients", pat); }
        } else {
          pat = patient();
          if (!pat) { pat = { name: "Paciente", nameKey: "PACIENTE", birthDate: null }; pat.id = await db.put("patients", pat); state.patients.push(pat); }
        }
        if (isLocked(pat)) {
          if (!(await requestUnlock(pat))) { outcomes.push({ name: f.name, ok: false, msg: `«${pat.name}» está protegido con contraseña y no se desbloqueó. El PDF no se importó.` }); continue; }
          if (state.reports.some((r) => r.fileHash === hash)) { outcomes.push({ name: f.name, ok: false, msg: "Este PDF ya estaba importado." }); continue; }
        }
        const rawText = pages.map((p, i) => `— Página ${i + 1} —\n${p.join("\n")}`).join("\n");
        const report = { patientId: pat.id, date: parsed.date || todayIso(), lab: parsed.lab, folio: parsed.folio || "",
          fileHash: hash, rawText, results: parsed.results, importedAt: new Date().toISOString() };
        await saveReport(pat, report);
        state.reports.push(report);
        state.patientId = pat.id; localStorage.setItem("patientId", pat.id);
        const out = parsed.results.filter((r) => r.status !== "normal").length;
        outcomes.push({ name: f.name, ok: true, msg: `${parsed.lab} · ${fmtDate(report.date)}: ${parsed.results.length} resultados, ${out} fuera de rango.` + (parsed.date ? "" : " No se encontró la fecha; se usó la de hoy (corrígela en Informes).") });
      } catch (e) {
        console.error(e);
        outcomes.push({ name: f.name, ok: false, msg: "No se pudo leer el archivo." });
      }
    }
  } catch (e) {
    console.error(e);
    outcomes.push({ name: "PDF", ok: false, msg: "No se pudo cargar el lector de PDF." });
  }
  state.busy = false; await load(); render();
  showDialog("Resultado de la importación", outcomes.map((o) => `<div class="out ${o.ok ? "ok" : "bad"}"><strong>${o.ok ? "✓" : "!"} ${esc(o.name)}</strong><span>${esc(o.msg)}</span></div>`).join(""));
}

// ---------- Vistas ----------
function header(title, back) {
  if (back) return `<header class="top back"><button class="icon" data-action="back" aria-label="Volver">‹</button><h1>${esc(title)}</h1><span class="spacer"></span></header>`;
  const opts = state.patients.map((p) => `<option value="${p.id}" ${p.id === state.patientId ? "selected" : ""}>${p.protection ? "🔒 " : ""}${esc(p.name)}</option>`).join("");
  return `<header class="top"><select id="patientSelect" aria-label="Paciente">${opts || `<option>${esc(title)}</option>`}</select><button class="icon" data-action="menu" aria-label="Menú">⋯</button></header>`;
}

function viewLocked(p) {
  return `${header(p.name)}<main><div class="empty"><div class="logo">🔒</div><p><strong>${esc(p.name)}</strong></p>
    <p class="muted">Este paciente está protegido con contraseña.</p>
    <form id="unlockForm" class="form lockform"><input type="password" name="pw" placeholder="Contraseña" autocomplete="current-password" required>
    <button class="primary" type="submit">Desbloquear</button><div class="err">${esc(state.unlockError)}</div></form></div></main>`;
}

function viewAnalisis() {
  const reports = myReports();
  if (!reports.length) return `${header("Análisis")}<main><div class="empty"><p>Todavía no hay análisis.</p><p class="muted">Importa un PDF de laboratorio y los resultados se leen automáticamente.</p><button class="primary" data-action="import">Importar PDF</button></div></main>`;
  const all = buildSeries();
  const flagged = all.filter((s) => s.points[s.points.length - 1].status !== "normal").length;
  const q = state.search.trim().toLowerCase();
  const list = all.filter((s) => (!q || s.name.toLowerCase().includes(q)) && (!state.onlyOut || s.points[s.points.length - 1].status !== "normal"));
  let html = `${header(patient().name)}<main>
    <div class="card summary">${reports.length} informe${reports.length === 1 ? "" : "s"} · <strong>${flagged}</strong> de ${all.length} parámetros fuera de rango en su último valor</div>
    <div class="tools"><input id="search" type="search" placeholder="Buscar parámetro" value="${esc(state.search)}"><label class="check"><input type="checkbox" id="onlyOut" ${state.onlyOut ? "checked" : ""}> Solo fuera de rango</label></div>`;
  for (const cat of CATEGORIES) {
    const rows = list.filter((s) => s.category === cat).sort((a, b) => a.name.localeCompare(b.name, "es"));
    if (!rows.length) continue;
    html += `<h2>${cat}</h2><ul class="list">` + rows.map((s) => {
      const last = s.points[s.points.length - 1];
      const nums = s.points.filter((p) => p.value !== null).map((p) => ({ t: p.t, v: p.value }));
      return `<li><button class="row" data-action="analyte" data-key="${esc(s.key)}">
        <span class="grow"><span class="name">${esc(s.name)}</span><span class="sub">${fmtDate(last.date)} · ${s.points.length} estudio${s.points.length === 1 ? "" : "s"}</span></span>
        ${sparkline(nums, last.status)}
        <span class="val"><strong>${esc(display(last))} ${esc(last.unit)}</strong>${badge(last.status)}</span></button></li>`;
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
  html += `<h2>Historial</h2><ul class="list">` + [...s.points].reverse().map((p) => `<li class="row static"><span class="grow"><span class="name">${fmtDate(p.date)}</span><span class="sub">Referencia: ${esc(reference(p))}</span></span><span class="val"><strong>${esc(display(p))} ${esc(p.unit)}</strong>${badge(p.status)}</span></li>`).join("") + "</ul></main>";
  return html;
}

function viewPeso() {
  const ws = myWeights();
  const kg = (v) => `${fmt(Number(v.toFixed(1)))} kg`;
  const delta = (v) => `${v > 0 ? "+" : ""}${fmt(Number(v.toFixed(1)))} kg`;
  let html = `${header("Peso")}<main>`;
  if (!patient()) return `${header("Peso")}<main><div class="empty"><p>Primero crea un paciente o importa un PDF.</p><button class="primary" data-action="newPatient">Nuevo paciente</button></div></main>`;
  html += `<form id="weightForm" class="card form"><div class="grid2"><label>Fecha<input type="date" name="date" value="${todayIso()}" max="${todayIso()}" required></label>
    <label>Peso (kg)<input name="kg" inputmode="decimal" placeholder="70.5" required></label></div>
    <label>Nota (opcional)<input name="note" maxlength="80"></label><button class="primary" type="submit">Guardar peso</button></form>`;
  if (ws.length) {
    const last = ws[ws.length - 1];
    html += `<div class="card"><div class="big">${kg(last.kg)}</div><div class="muted small">Último registro: ${fmtDate(last.date)}</div>`;
    if (ws.length > 1) {
      html += `<div class="small">Frente al registro anterior: <strong>${delta(last.kg - ws[ws.length - 2].kg)}</strong></div><div class="small">Desde el primer registro (${fmtDate(ws[0].date)}): <strong>${delta(last.kg - ws[0].kg)}</strong></div>`;
    }
    html += "</div>";
    if (ws.length > 1) html += `<div class="card"><div class="muted small">Evolución (kg)</div>${lineChart({ points: ws.map((w) => ({ t: toTime(w.date), v: w.kg, status: "normal" })), label: "Evolución del peso" })}</div>`;
    html += `<h2>Registros</h2><ul class="list">` + [...ws].reverse().map((w) => `<li class="row static"><span class="grow"><span class="name">${fmtDate(w.date)}</span>${w.note ? `<span class="sub">${esc(w.note)}</span>` : ""}</span><strong>${kg(w.kg)}</strong><button class="icon danger" data-action="delWeight" data-id="${w.id}" aria-label="Borrar">✕</button></li>`).join("") + "</ul>";
  } else html += `<p class="muted center">Sin registros de peso todavía.</p>`;
  return html + "</main>";
}

function viewInformes() {
  const reports = [...myReports()].reverse();
  let html = `${header("Informes")}<main><button class="primary wide" data-action="import">Importar PDF</button>`;
  if (!reports.length) return html + `<p class="muted center">Sin informes.</p></main>`;
  html += `<ul class="list">` + reports.map((r) => {
    const out = r.results.filter((x) => x.status !== "normal").length;
    return `<li><button class="row" data-action="report" data-id="${r.id}"><span class="grow"><span class="name">${fmtDate(r.date)}</span><span class="sub">${esc(r.lab)}</span></span><span class="sub right">${r.results.length} resultados<br>${out} fuera de rango</span><span class="chev">›</span></button></li>`;
  }).join("") + "</ul></main>";
  return html;
}

function viewReport(id) {
  const r = state.reports.find((x) => x.id === id);
  if (!r) return viewInformes();
  let html = `${header("Informe", true)}<main><div class="card form"><label>Fecha de toma<input type="date" id="reportDate" value="${r.date}" max="${todayIso()}"></label>
    <div class="muted small">${esc(r.lab)}${r.folio ? " · folio " + esc(r.folio) : ""}</div></div>`;
  for (const cat of CATEGORIES) {
    const rows = r.results.filter((x) => x.category === cat);
    if (!rows.length) continue;
    html += `<h2>${cat}</h2><ul class="list">` + rows.map((x) => `<li class="row static"><span class="grow"><span class="name">${esc(x.name)}</span><span class="sub">Referencia: ${esc(reference(x))}</span></span><span class="val"><strong>${esc(display(x))} ${esc(x.unit)}</strong>${badge(x.status)}</span></li>`).join("") + "</ul>";
  }
  html += `<details class="card"><summary>Texto extraído del PDF</summary><pre>${esc(r.rawText)}</pre></details>
    <button class="danger-btn wide" data-action="delReport" data-id="${r.id}">Borrar este informe</button></main>`;
  return html;
}

function nav() {
  const tabs = [["analisis", "Análisis", "🩸"], ["peso", "Peso", "⚖️"], ["informes", "Informes", "📄"]];
  return `<nav class="tabs">${tabs.map(([k, l, i]) => `<button data-action="tab" data-tab="${k}" class="${state.tab === k && !state.view ? "active" : ""}"><span>${i}</span>${l}</button>`).join("")}</nav>`;
}

function render() {
  const app = document.getElementById("app");
  const keepScroll = window.scrollY;
  let html;
  const cur = patient();
  const locked = isLocked(cur);
  if (locked) html = viewLocked(cur);
  else if (state.view?.type === "analyte") html = viewAnalyte(state.view.key);
  else if (state.view?.type === "report") html = viewReport(state.view.id);
  else if (!state.patients.length && state.tab !== "informes") html = `${header("Seguimiento médico")}<main><div class="empty"><div class="logo">🩸</div><p><strong>Seguimiento médico</strong></p><p class="muted">Importa un PDF de análisis de sangre y la aplicación lee los resultados automáticamente. El peso se captura a mano. Todo se queda en este dispositivo.</p><button class="primary" data-action="import">Importar PDF</button><button class="link" data-action="newPatient">Crear paciente sin PDF</button></div></main>`;
  else html = state.tab === "peso" ? viewPeso() : state.tab === "informes" ? viewInformes() : viewAnalisis();
  app.innerHTML = html + (locked ? "" : nav()) + (state.busy ? `<div class="busy"><div class="spinner"></div>Leyendo PDF…</div>` : "");
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
  const protect = !p ? "" : !p.protection
    ? `<button data-menu="protect">Proteger «${esc(p.name)}» con contraseña</button>`
    : `<button data-menu="lock">Bloquear ahora</button><button data-menu="changePw">Cambiar contraseña</button><button data-menu="removePw">Quitar contraseña</button>`;
  showDialog("Menú", `<div class="menu">
      <button data-menu="newPatient">Nuevo paciente</button>
      ${protect}
      ${p ? `<button data-menu="delPatient" class="danger-text">Borrar paciente «${esc(p.name)}» y sus datos</button>` : ""}
      <button data-menu="export">Exportar copia de respaldo</button>
      <button data-menu="backup">Importar copia de respaldo</button>
      <p class="muted small">Los datos se guardan solo en este dispositivo. Los pacientes con contraseña se guardan cifrados, también en la copia de respaldo. Haz copias con regularidad, sobre todo antes de cambiar de teléfono.</p>
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
    ${fields.map((f) => `<label>${esc(f.label)}<input name="${f.name}" type="password" autocomplete="${f.autocomplete || "off"}" required></label>`).join("")}
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
  if (newMeta) updated.protection = newMeta; else delete updated.protection;
  const reports = [], weights = [];
  for (const r of state.reports.filter((x) => x.patientId === pat.id)) reports.push(await encodeRecord(updated, r, REPORT_FIELDS, newKey));
  for (const w of state.weights.filter((x) => x.patientId === pat.id)) weights.push(await encodeRecord(updated, w, WEIGHT_FIELDS, newKey));
  await db.batchWrite({ patients: [updated], reports, weights });
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
  if (!state.keys.size) return;
  state.keys.clear(); state.view = null;
  document.getElementById("dlg")?.remove();
  load().then(render);
}

async function menuAction(kind) {
  const p = patient();
  if (kind === "newPatient") return newPatient();
  if (kind === "protect") return protectPatient(p, "set");
  if (kind === "changePw") return protectPatient(p, "change");
  if (kind === "removePw") return removeProtection(p);
  if (kind === "lock") return lockAll();
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
    const p = { name, nameKey: makeKey(name), birthDate: null };
    p.id = await db.put("patients", p);
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
  if (a === "tab") { state.tab = el.dataset.tab; state.view = null; render(); }
  else if (a === "back") { state.view = null; render(); }
  else if (a === "analyte") { state.view = { type: "analyte", key: el.dataset.key }; render(); }
  else if (a === "report") { state.view = { type: "report", id: Number(el.dataset.id) }; render(); }
  else if (a === "import") document.getElementById("pdfInput").click();
  else if (a === "menu") showMenu();
  else if (a === "newPatient") newPatient();
  else if (a === "delWeight") { await db.del("weights", Number(el.dataset.id)); await load(); render(); }
  else if (a === "delReport") {
    const id = Number(el.dataset.id);
    showDialog("¿Borrar informe?", "Se borrarán sus resultados. Esta acción no se puede deshacer.", [
      { label: "Cancelar" }, { label: "Borrar", kind: "danger", onClick: async () => { await db.del("reports", id); state.view = null; await load(); render(); } }]);
  }
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "patientSelect") { state.patientId = Number(t.value); localStorage.setItem("patientId", t.value); state.view = null; render(); }
  else if (t.id === "onlyOut") { state.onlyOut = t.checked; render(); }
  else if (t.id === "pdfInput") { const files = [...t.files]; t.value = ""; if (files.length) importFiles(files); }
  else if (t.id === "backupInput") {
    const f = t.files[0]; t.value = "";
    if (!f) return;
    try {
      const r = await db.importBackup(JSON.parse(await f.text()));
      await load(); render();
      showDialog("Copia importada", `Se agregaron ${r.addedReports} informes y ${r.addedWeights} registros de peso.` + (r.renamed ? ` ${r.renamed} paciente${r.renamed === 1 ? "" : "s"} tenía${r.renamed === 1 ? "" : "n"} el mismo nombre con otra contraseña y se agregó${r.renamed === 1 ? "" : "ron"} como «(respaldo)».` : ""));
    } catch (err) { showDialog("No se pudo importar", esc(err.message || "Archivo inválido.")); }
  }
  else if (t.id === "reportDate" && state.view?.type === "report" && t.value) {
    const r = state.reports.find((x) => x.id === state.view.id);
    r.date = t.value; await saveReport(patient(), r); render();
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    state.search = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const s = document.getElementById("search"); s.focus(); s.setSelectionRange(pos, pos);
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
  if (e.target.id !== "weightForm") return;
  e.preventDefault();
  const f = new FormData(e.target);
  const kg = parseFloat(String(f.get("kg")).replace(",", "."));
  if (!(kg >= 20 && kg <= 400)) { showDialog("Peso no válido", "Escribe un peso entre 20 y 400 kg."); return; }
  await saveWeight(patient(), { date: f.get("date"), kg, note: String(f.get("note") || "") });
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
setInterval(() => { if (state.keys.size && Date.now() - lastActive > IDLE_MS) lockAll(); }, 15000);

// ---------- Inicio ----------
(async () => {
  await load();
  render();
  db.requestPersistence();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
