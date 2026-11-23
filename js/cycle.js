// Calendario menstrual: cálculo de la fase del ciclo a partir de las fechas de inicio de la regla.
// Es una estimación basada en un ciclo típico (fase lútea de unos 14 días); no sirve como método anticonceptivo.
const DAY = 86400000;
const t = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (isoDate, n) => iso(t(isoDate) + n * DAY);
export const diffDays = (a, b) => Math.round((t(a) - t(b)) / DAY);
const mod = (n, m) => ((n % m) + m) % m;

export const PHASES = {
  menstrual: { name: "Menstrual", color: "#d64550", text: "Es la fase del sangrado. Las hormonas (estrógeno y progesterona) están en su nivel más bajo; es normal sentir cansancio o cólicos." },
  folicular: { name: "Folicular", color: "#e8a33d", text: "Después del sangrado el estrógeno sube y madura un óvulo. Muchas personas notan más energía y mejor ánimo." },
  ovulatoria: { name: "Ovulatoria", color: "#3a9d6b", text: "Alrededor de la ovulación se libera el óvulo y es el momento de mayor fertilidad. Puede haber más flujo cervical y una ligera molestia en un costado." },
  lutea: { name: "Lútea", color: "#7a5cc4", text: "La progesterona sube. Hacia el final pueden aparecer síntomas premenstruales: hinchazón, sensibilidad en los senos, cambios de ánimo y antojos." },
};

/** Largo del ciclo: promedio de los últimos intervalos registrados (entre 15 y 60 días) o el valor indicado. */
export function cycleLength(c) {
  const starts = [...(c.starts || [])].sort();
  const gaps = [];
  for (let i = 1; i < starts.length; i++) { const g = diffDays(starts[i], starts[i - 1]); if (g >= 15 && g <= 60) gaps.push(g); }
  const last = gaps.slice(-6);
  return last.length >= 2 ? Math.round(last.reduce((a, b) => a + b, 0) / last.length) : c.cycleLength || 28;
}

function layout(len, period) {
  const ov = Math.max(period + 2, len - 14);   // día del ciclo en que se espera la ovulación
  return { ov, fertileFrom: ov - 5, fertileTo: ov + 1 };
}

/** Fase y día del ciclo para una fecha. Devuelve null si no hay fechas registradas o el modo no calcula fases. */
export function phaseOn(c, date) {
  if (!c || c.mode !== "natural" || !c.starts?.length) return null;
  const starts = [...c.starts].sort();
  const len = cycleLength(c), period = c.periodLength || 5;
  let idx = -1;
  starts.forEach((s, i) => { if (diffDays(date, s) >= 0) idx = i; });
  let start, cLen, projected = false;
  if (idx === -1) {                       // antes del primer registro: se proyecta hacia atrás
    const n = Math.ceil(-diffDays(date, starts[0]) / len);
    start = addDays(starts[0], -n * len); cLen = len; projected = true;
  } else if (idx < starts.length - 1) {   // entre dos registros reales
    start = starts[idx]; cLen = diffDays(starts[idx + 1], starts[idx]);
  } else {                                // después del último registro: se proyecta hacia adelante
    const k = Math.floor(diffDays(date, starts[idx]) / len);
    start = addDays(starts[idx], k * len); cLen = len; projected = k > 0;
  }
  const day = diffDays(date, start) + 1;
  const { ov, fertileFrom, fertileTo } = layout(cLen, period);
  let phase = day <= period ? "menstrual" : day < ov - 1 ? "folicular" : day <= ov + 1 ? "ovulatoria" : "lutea";
  const nextStart = addDays(start, cLen);
  return {
    day, length: cLen, phase, projected, start, nextStart,
    daysToNext: diffDays(nextStart, date),
    ovulation: addDays(start, ov - 1),
    fertile: { from: addDays(start, fertileFrom - 1), to: addDays(start, fertileTo - 1) },
    inFertileWindow: day >= fertileFrom && day <= fertileTo,
    irregular: c.regular === "no",
  };
}

/** Matriz del mes para el calendario: semanas que empiezan en lunes. */
export function monthGrid(year, month /* 0-11 */, c) {
  const first = iso(Date.UTC(year, month, 1));
  const lead = mod(new Date(Date.UTC(year, month, 1)).getUTCDay() - 1, 7);
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) {
    const date = addDays(first, d - 1);
    cells.push({ date, d, info: phaseOn(c, date) });
  }
  while (cells.length % 7) cells.push(null);
  return cells;
}
