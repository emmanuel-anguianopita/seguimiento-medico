import { parseDocument, SUPPORTED_LABS } from "./parser.js";
import { compose, bmi as calcBmi } from "./composition.js";
import { SYSTEM_NAMES, systemOf, systemIcon } from "./systems.js";
import { PHASES, phaseOn, monthGrid, addDays, cycleLength } from "./cycle.js";
import { pdfToPages } from "./pdftext.js";
import * as db from "./db.js";
import { lineChart, sparkline, fmt } from "./charts.js";
import { makeProtection, tryUnlock, encryptJSON, decryptJSON } from "./crypto.js";

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
  patients: [], reports: [], weights: [],
  patientId: Number(localStorage.getItem("patientId")) || null,
  tab: "analisis", view: null, onlyOut: false, search: "", busy: false,
  keys: new Map(), unlockError: "", histSearch: "", histOnlyOut: false, calMonth: null, groupBy: localStorage.getItem("groupBy") === "system" ? "system" : "study",
};
const REPORT_FIELDS = ["date", "lab", "folio", "fileHash", "rawText", "results", "importedAt"];
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
const birthOf = (p) => p?.profile?.birthDate ?? p?.birthDate ?? null;
async function fillProfile(pat, parsed) {
  const prof = { ...(pat.profile || {}) };
  let changed = false;
  if (!birthOf(pat) && parsed.birth) { prof.birthDate = parsed.birth; changed = true; }
  if (!prof.sex && parsed.sex) { prof.sex = parsed.sex; changed = true; }
  if (changed) { pat.profile = prof; await savePatient(pat); }
}
async function saveReport(pat, report) { report.id = await db.put("reports", await encodeRecord(pat, report, REPORT_FIELDS)); }
async function saveWeight(pat, w) { w.id = await db.put("weights", await encodeRecord(pat, w, WEIGHT_FIELDS)); }

const patient = () => state.patients.find((p) => p.id === state.patientId) || null;
const myReports = () => state.reports.filter((r) => r.patientId === state.patientId).sort((a, b) => a.date.localeCompare(b.date));
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
        if (state.reports.some((r) => r.fileHash === hash)) { outcomes.push({ name: f.name, ok: false, msg: "Este PDF ya estaba importado." }); continue; }
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
  const opts = state.patients.map((p) => `<option value="${p.id}" ${p.id === state.patientId ? "selected" : ""}>${p.protection ? "🔒 " : ""}${esc(p.name)}</option>`).join("");
  return `<header class="top"><select id="patientSelect" aria-label="Paciente">${opts || `<option>${esc(title)}</option>`}</select><button class="icon" data-action="menu" aria-label="Menú">⋯</button></header>`;
}

function viewLocked(p) {
  return `${header(p.name)}<main><div class="empty"><div class="logo">🔒</div><p><strong>${esc(p.name)}</strong></p>
    <p class="muted">Este paciente está protegido con contraseña.</p>
    <form id="unlockForm" class="form lockform"><input type="password" name="pw" placeholder="Contraseña" autocomplete="current-password" required>
    <button class="primary" type="submit">Desbloquear</button><div class="err">${esc(state.unlockError)}</div></form></div></main>`;
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
  return p && !p.profile?.answered ? `<div class="card"><div class="small">Responde el cuestionario inicial para calcular el IMC, la composición corporal y, si lo deseas, el calendario menstrual.</div><button class="link" data-action="profile">Abrir cuestionario</button></div>` : "";
};

const dateLong = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });

function viewCiclo() {
  const pat = patient();
  const cy = pat?.profile?.cycle;
  let html = `${header("Ciclo")}<main>`;
  if (!cy || !["natural", "hormonal"].includes(cy.mode)) return html + `<div class="empty"><p>El calendario menstrual no está activado.</p><button class="primary" data-action="profile">Activar en el perfil</button></div></main>`;
  if (cy.mode === "hormonal") return html + `<div class="card"><strong>Anticonceptivo hormonal</strong><p class="small">Con anticonceptivos hormonales no hay un ciclo natural con ovulación, por eso no se calculan fases. Puedes cambiar esta opción en el perfil.</p><button class="link" data-action="profile">Editar perfil</button></div></main>`;
  const today = todayIso();
  const now = phaseOn(cy, today);
  if (!now) return html + `<div class="empty"><p>Falta la fecha de tu última regla.</p><button class="primary" data-action="periodStart">Registrar inicio de regla</button></div></main>`;
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
    <button class="primary wide" data-action="periodStart">Registrar inicio de regla</button></div>`;
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
  html += `<h2>Inicios de regla registrados</h2><ul class="list">${hist.map((d) => `<li class="row static"><span class="grow"><span class="name">${esc(fmtDate(d))}</span></span><button class="icon danger" data-action="delStart" data-date="${d}" aria-label="Borrar">✕</button></li>`).join("")}</ul>
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
  if (!reports.length) return `${header("Análisis")}<main><h2 class="hello">${esc(greeting())}</h2>${profileNudge()}<div class="empty"><p>Todavía no hay análisis.</p><p class="muted">Importa un PDF de laboratorio y los resultados se leen automáticamente.</p><button class="primary" data-action="import">Importar PDF</button></div></main>`;
  const all = buildSeries();
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

function viewHistorico() {
  const reports = myReports();
  if (!reports.length) return `${header("Histórico")}<main><h2 class="hello">${esc(greeting())}</h2><div class="empty"><p>Todavía no hay análisis.</p><p class="muted">Cuando importes informes aparecerá aquí cada indicador a lo largo del tiempo.</p><button class="primary" data-action="import">Importar PDF</button></div></main>`;
  const all = buildSeries();
  const q = state.histSearch.trim().toLowerCase();
  const cols = [...reports].sort((a, b) => a.date.localeCompare(b.date));
  const list = all.filter((s) => (!q || s.name.toLowerCase().includes(q)) && (!state.histOnlyOut || s.points.some((p) => p.status !== "normal")));
  let html = `${header("Histórico")}<main>
    <div class="tools"><input id="histSearch" type="search" placeholder="Buscar indicador" value="${esc(state.histSearch)}"><label class="check"><input type="checkbox" id="histOnlyOut" ${state.histOnlyOut ? "checked" : ""}> Con algún valor fuera de rango</label></div>${groupToggle()}
    <p class="muted small">${all.length} indicadores en ${cols.length} informe${cols.length === 1 ? "" : "s"}. Toca un indicador para ver su gráfica.</p>`;
  for (const [cat, rows] of groupRows(list)) {
    html += `<h2>${cat}</h2><div class="histwrap"><table class="hist"><thead><tr><th class="sticky">Indicador</th>${cols.map((r) => `<th>${fmtDate(r.date)}</th>`).join("")}</tr></thead><tbody>` +
      rows.map((s) => {
        const byRid = new Map(s.points.map((pt) => [pt.rid, pt]));
        const unit = s.points[s.points.length - 1].unit;
        return `<tr><th class="sticky"><button data-action="analyte" data-key="${esc(s.key)}">${esc(s.name)}<small>${esc(unit)}</small></button></th>` +
          cols.map((r) => { const pt = byRid.get(r.id); return pt ? `<td class="st-${pt.status}" title="Referencia: ${esc(reference(pt))}">${esc(display(pt))}</td>` : `<td class="none">–</td>`; }).join("") + "</tr>";
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
  if (c.fat) html += `<p class="small">Masa grasa: <strong>${fmt(c.fatMassKg)} kg</strong> · Masa magra: <strong>${fmt(c.leanMassKg)} kg</strong>${c.waterKg ? ` · Agua: <strong>${fmt(c.waterKg)} kg</strong>` : ""}</p>`;
  if (c.paragraphs.length) html += `<p class="small">${c.paragraphs.map(esc).join(" ")}</p>`;
  if (c.missing.length) html += `<p class="small muted">Para una evaluación completa agrega ${esc(c.missing.join(", "))} en el perfil.</p><button class="link" data-action="profile">Completar perfil</button>`;
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
  if (!prof.heightCm || !prof.sex || !prof.birthDate) html += `<div class="card"><div class="small">Completa la altura, el sexo y la fecha de nacimiento para calcular el IMC y evaluar la composición corporal.</div><button class="link" data-action="profile">Completar perfil</button></div>`;
  html += `<form id="weightForm" class="card form"><div class="grid2"><label>Fecha<input type="date" name="date" value="${todayIso()}" max="${todayIso()}" required></label>
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
      return `<li class="row static"><span class="grow"><span class="name">${fmtDate(w.date)}</span>${extra ? `<span class="sub">${esc(extra)}</span>` : ""}</span><strong>${kg(w.kg)}</strong><button class="icon danger" data-action="delWeight" data-id="${w.id}" aria-label="Borrar">✕</button></li>`;
    }).join("") + "</ul>";
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
  const tabs = [["analisis", "Análisis", "🩸"], ["historico", "Histórico", "🗂️"], ["peso", "Peso", "⚖️"]];
  if (["natural", "hormonal"].includes(patient()?.profile?.cycle?.mode)) tabs.push(["ciclo", "Ciclo", "🌙"]);
  tabs.push(["informes", "Informes", "📄"]);
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
  else if (state.view?.type === "profile") html = viewProfile(false);
  else if (!state.patients.length) html = viewProfile(true);
  else html = state.tab === "peso" ? viewPeso() : state.tab === "ciclo" ? viewCiclo() : state.tab === "historico" ? viewHistorico() : state.tab === "informes" ? viewInformes() : viewAnalisis();
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
  const protect = !p ? "" : !p.protection
    ? `<button data-menu="protect">Proteger «${esc(p.name)}» con contraseña</button>`
    : `<button data-menu="lock">Bloquear ahora</button><button data-menu="changePw">Cambiar contraseña</button><button data-menu="removePw">Quitar contraseña</button>`;
  showDialog("Menú", `<div class="menu">
      <button data-menu="newPatient">Nuevo paciente</button>
      ${p ? `<button data-menu="profile">Perfil del paciente (nombre, altura, sexo, nacimiento)</button>` : ""}
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
  if (kind === "profile") { state.view = { type: "profile" }; return render(); }
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
  if (a === "tab") { state.tab = el.dataset.tab; state.view = null; render(); }
  else if (a === "back") { state.view = null; render(); }
  else if (a === "analyte") { state.view = { type: "analyte", key: el.dataset.key }; render(); }
  else if (a === "report") { state.view = { type: "report", id: Number(el.dataset.id) }; render(); }
  else if (a === "import") document.getElementById("pdfInput").click();
  else if (a === "profile") { state.view = { type: "profile" }; render(); }
  else if (a === "calPrev" || a === "calNext") { const m = state.calMonth || { y: new Date().getFullYear(), m: new Date().getMonth() }; const d = new Date(m.y, m.m + (a === "calNext" ? 1 : -1), 1); state.calMonth = { y: d.getFullYear(), m: d.getMonth() }; render(); }
  else if (a === "periodStart") registerPeriod();
  else if (a === "delStart") removePeriod(el.dataset.date);
  else if (a === "groupBy") { state.groupBy = el.dataset.mode; localStorage.setItem("groupBy", state.groupBy); render(); }
  else if (a === "exportCsv") exportCsv();
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
      showDialog("Copia importada", `Se agregaron ${r.addedReports} informes y ${r.addedWeights} registros de peso.` + (r.renamed ? ` ${r.renamed} paciente${r.renamed === 1 ? "" : "s"} tenía${r.renamed === 1 ? "" : "n"} el mismo nombre con otra contraseña y se agregó${r.renamed === 1 ? "" : "ron"} como «(respaldo)».` : ""));
    } catch (err) { showDialog("No se pudo importar", esc(err.message || "Archivo inválido.")); }
  }
  else if (t.id === "reportDate" && state.view?.type === "report" && t.value) {
    const r = state.reports.find((x) => x.id === state.view.id);
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
setInterval(() => { if (state.keys.size && Date.now() - lastActive > IDLE_MS) lockAll(); }, 15000);

// ---------- Inicio ----------
(async () => {
  await load();
  render();
  db.requestPersistence();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
