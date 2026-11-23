// Gráficas SVG sin dependencias.
const nf = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 3, useGrouping: false });
export const fmt = (n) => (n === null || n === undefined ? "–" : nf.format(n));
const dateShort = (t) => new Date(t).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "2-digit" });
const COLORS = { normal: "var(--ok)", bajo: "var(--low)", alto: "var(--high)", fuera: "var(--out)" };

export function lineChart({ points, refLow = null, refHigh = null, label = "Gráfica", smooth = false }) {
  const W = 340, H = 210, L = 44, R = 14, T = 14, B = 30;
  if (!points.length) return "";
  const ts = points.map((p) => p.t);
  let t0 = Math.min(...ts), t1 = Math.max(...ts);
  if (t0 === t1) { t0 -= 86400000 * 15; t1 += 86400000 * 15; }
  const vals = points.map((p) => p.v).concat([refLow, refHigh].filter((x) => x !== null));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}" class="chart">`;
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end" class="axis">${fmt(Number(v.toPrecision(3)))}</text>`;
  }
  if (refHigh !== null) s += `<line x1="${L}" x2="${W - R}" y1="${y(refHigh)}" y2="${y(refHigh)}" class="ref ref-high"/><text x="${W - R}" y="${y(refHigh) - 3}" text-anchor="end" class="reflabel">máximo ${fmt(refHigh)}</text>`;
  if (refLow !== null) s += `<line x1="${L}" x2="${W - R}" y1="${y(refLow)}" y2="${y(refLow)}" class="ref ref-low"/><text x="${W - R}" y="${y(refLow) + 11}" text-anchor="end" class="reflabel">mínimo ${fmt(refLow)}</text>`;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  if (sorted.length > 1) s += `<polyline points="${sorted.map((p) => `${x(p.t)},${y(p.v)}`).join(" ")}" class="line"/>`;
  for (const p of sorted) s += `<circle cx="${x(p.t)}" cy="${y(p.v)}" r="4.5" fill="${COLORS[p.status] || COLORS.normal}" class="dot"><title>${dateShort(p.t)}: ${fmt(p.v)}</title></circle>`;
  const first = sorted[0], last = sorted[sorted.length - 1];
  s += `<text x="${x(first.t)}" y="${H - 8}" text-anchor="${sorted.length > 1 ? "start" : "middle"}" class="axis">${dateShort(first.t)}</text>`;
  if (sorted.length > 1) s += `<text x="${x(last.t)}" y="${H - 8}" text-anchor="end" class="axis">${dateShort(last.t)}</text>`;
  return s + "</svg>";
}

export function sparkline(points, status) {
  if (points.length < 2) return "";
  const W = 56, H = 26;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const t0 = sorted[0].t, t1 = sorted[sorted.length - 1].t || 1;
  let lo = Math.min(...sorted.map((p) => p.v)), hi = Math.max(...sorted.map((p) => p.v));
  if (lo === hi) { lo -= 1; hi += 1; }
  const pts = sorted.map((p) => `${2 + ((p.t - t0) / (t1 - t0 || 1)) * (W - 4)},${2 + (1 - (p.v - lo) / (hi - lo)) * (H - 4)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" class="spark" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${COLORS[status] || COLORS.normal}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
