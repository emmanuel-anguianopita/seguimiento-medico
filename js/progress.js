// Avances entre estudios: qué mejoró, qué empeoró, qué es nuevo y cómo evoluciona el porcentaje de indicadores en rango.
import { systemOf, SYSTEM_NAMES } from "./systems.js";

/** Qué tan lejos del rango está un valor (0 = dentro del rango), en proporción al ancho del rango. */
export function distance(p) {
  if (p.status === "normal") return 0;
  if (p.value === null || p.value === undefined) return 1;
  const lo = p.refLow, hi = p.refHigh;
  const scale = (lo !== null && hi !== null && hi > lo ? hi - lo : Math.abs(hi ?? lo ?? 1)) || 1;
  if (p.status === "bajo" && lo !== null) return Math.max(0, (lo - p.value) / scale);
  if (p.status === "alto" && hi !== null) return Math.max(0, (p.value - hi) / scale);
  return 1;
}

/** Compara el último valor con el anterior. change: nuevo | mejoro | empeoro | estable | igual */
export function compare(series) {
  const pts = series.points;
  const last = pts[pts.length - 1];
  const prev = pts.length > 1 ? pts[pts.length - 2] : null;
  const item = { key: series.key, name: series.name, category: series.category, system: systemOf(series.name, series.category), last, prev, change: "nuevo", delta: null };
  if (!prev) return item;
  if (typeof last.value === "number" && typeof prev.value === "number") item.delta = last.value - prev.value;
  if (last.status === "normal") item.change = prev.status === "normal" ? "estable" : "mejoro";
  else if (prev.status === "normal") item.change = "empeoro";
  else {
    const dl = distance(last), dp = distance(prev);
    item.change = dl < dp - 0.02 ? "mejoro" : dl > dp + 0.02 ? "empeoro" : "igual";
  }
  return item;
}

/** reports: [{date, results:[{key,status}]}]; series: salida de buildSeries(). */
export function progress(series, reports) {
  const dates = [...new Set(reports.map((r) => r.date))].sort();
  const latestDate = dates[dates.length - 1] || null;
  const previousDate = dates.length > 1 ? dates[dates.length - 2] : null;
  const items = series.map(compare);
  // los indicadores "nuevos" son los que aparecen por primera vez en el último estudio
  for (const it of items) if (it.change === "nuevo" && it.last.date !== latestDate) it.change = "estable";
  const counts = { mejoro: 0, empeoro: 0, estable: 0, igual: 0, nuevo: 0 };
  for (const it of items) counts[it.change]++;
  const timeline = dates.map((d) => {
    const seen = new Map();
    for (const r of reports.filter((x) => x.date === d)) for (const x of r.results) seen.set(x.key, x.status);
    const total = seen.size, ok = [...seen.values()].filter((s) => s === "normal").length;
    return { date: d, total, ok, pct: total ? Math.round((ok / total) * 1000) / 10 : 0 };
  });
  const lastT = timeline[timeline.length - 1], prevT = timeline.length > 1 ? timeline[timeline.length - 2] : null;
  const bySystem = SYSTEM_NAMES.map((name) => {
    const list = items.filter((i) => i.system === name);
    const ok = list.filter((i) => i.last.status === "normal").length;
    return { name, total: list.length, ok, mejoro: list.filter((i) => i.change === "mejoro").length, empeoro: list.filter((i) => i.change === "empeoro").length };
  }).filter((s) => s.total);
  return { items, counts, timeline, latestDate, previousDate, nowPct: lastT?.pct ?? null,
    deltaPct: prevT && lastT ? Math.round((lastT.pct - prevT.pct) * 10) / 10 : null, bySystem, attention: items.filter((i) => i.last.status !== "normal") };
}
