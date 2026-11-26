// Escritor de PDF mínimo, sin dependencias: texto con Helvetica (fuente estándar, no hace falta incrustarla), líneas, rectángulos,
// polilíneas y círculos. Las medidas están en puntos (1 pt = 1/72 de pulgada) y el origen está arriba a la izquierda.
const W = [[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,500,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500],[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,556,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556]];   // anchos de Helvetica y Helvetica-Bold para los códigos 32 a 255 (WinAnsi), por mil de tamaño de letra

const SPECIAL = { "€": 0x80, "‚": 0x82, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };
const REPLACE = { "≤": "<=", "≥": ">=", "→": "->", "←": "<-", "⁶": "^6", "⁹": "^9", "³": "³", "μ": "µ", "▲": "+", "▼": "-", "✓": "", "≈": "~", "−": "-", " ": " ", " ": " " };
/** Convierte texto a bytes WinAnsi; lo que no existe en la fuente se sustituye por un equivalente legible. */
export function toWinAnsi(text) {
  const out = [];
  for (const ch of String(text ?? "")) {
    const r = REPLACE[ch] ?? ch;
    for (const c of r) {
      const code = c.codePointAt(0);
      if (SPECIAL[c]) out.push(SPECIAL[c]);
      else if (code >= 32 && code < 127) out.push(code);
      else if (code >= 160 && code < 256) out.push(code);
      else if (code === 9 || code === 10) out.push(32);
      else if (code >= 0x300 && code < 0x370) continue;   // marcas de acento sueltas
      else out.push(63);
    }
  }
  return out;
}
const clean = (s) => String.fromCharCode(...toWinAnsi(s));   // solo para emitir: el resultado ya está en WinAnsi
const uni = (s) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ");

/** Ancho del texto en puntos. */
export function textWidth(text, size, bold = false) {
  const t = W[bold ? 1 : 0];
  let w = 0;
  for (const c of toWinAnsi(text)) w += t[c - 32] ?? 556;
  return (w * size) / 1000;
}
/** Recorta el texto con puntos suspensivos para que quepa en el ancho dado. */
export function fit(text, size, bold, maxW) {
  text = uni(text);
  if (textWidth(text, size, bold) <= maxW) return text;
  while (text.length > 1 && textWidth(text + "…", size, bold) > maxW) text = text.slice(0, -1);
  return text.trimEnd() + "…";
}
/** Divide el texto en renglones que quepan en el ancho dado. */
export function wrap(text, size, bold, maxW) {
  const lines = [];
  for (const para of String(text ?? "").split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? cur + " " + word : word;
      if (cur && textWidth(next, size, bold) > maxW) { lines.push(cur); cur = word; } else cur = next;
    }
    lines.push(cur);
  }
  return lines;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
export function rgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => num(parseInt(h.slice(i, i + 2), 16) / 255)).join(" ");
}
const esc = (s) => s.replace(/[\\()]/g, (m) => "\\" + m);

export class Page {
  constructor(width, height) { this.w = width; this.h = height; this.ops = []; this.alpha = new Set(); }
  y(v) { return this.h - v; }
  /** Escribe una línea de texto. align: left | right | center. */
  text(str, x, y, { size = 10, bold = false, color = "#16181d", align = "left", maxW = null } = {}) {
    let s = uni(str);
    if (maxW) s = fit(s, size, bold, maxW);
    if (!s) return;
    const w = textWidth(s, size, bold);
    const px = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${num(size)} Tf ${rgb(color)} rg ${num(px)} ${num(this.y(y))} Td (${esc(clean(s))}) Tj ET`);
  }
  /** Párrafo con saltos de línea automáticos. Devuelve la altura usada. */
  paragraph(str, x, y, width, { size = 10, bold = false, color = "#16181d", lead = null } = {}) {
    const step = lead || size * 1.35;
    const lines = wrap(str, size, bold, width);
    lines.forEach((l, i) => this.text(l, x, y + size + i * step, { size, bold, color }));
    return lines.length * step;
  }
  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.6 } = {}) {
    const ops = [];
    if (fill) ops.push(`${rgb(fill)} rg`);
    if (stroke) ops.push(`${rgb(stroke)} RG ${num(lineWidth)} w`);
    ops.push(`${num(x)} ${num(this.y(y + h))} ${num(w)} ${num(h)} re ${fill && stroke ? "B" : fill ? "f" : "S"}`);
    this.ops.push("q " + ops.join(" ") + " Q");
  }
  line(x1, y1, x2, y2, { color = "#e5e7eb", lineWidth = 0.6, dash = null } = {}) {
    this.ops.push(`q ${rgb(color)} RG ${num(lineWidth)} w ${dash ? `[${dash.join(" ")}] 0 d` : ""} ${num(x1)} ${num(this.y(y1))} m ${num(x2)} ${num(this.y(y2))} l S Q`);
  }
  polyline(points, { color = "#16181d", lineWidth = 1.2 } = {}) {
    if (points.length < 2) return;
    const d = points.map(([x, y], i) => `${num(x)} ${num(this.y(y))} ${i ? "l" : "m"}`).join(" ");
    this.ops.push(`q ${rgb(color)} RG ${num(lineWidth)} w 1 j 1 J ${d} S Q`);
  }
  circle(cx, cy, r, { fill = "#16181d", stroke = null } = {}) {
    const k = 0.5523 * r, X = cx, Y = this.y(cy);
    const d = `${num(X + r)} ${num(Y)} m ${num(X + r)} ${num(Y + k)} ${num(X + k)} ${num(Y + r)} ${num(X)} ${num(Y + r)} c ${num(X - k)} ${num(Y + r)} ${num(X - r)} ${num(Y + k)} ${num(X - r)} ${num(Y)} c ${num(X - r)} ${num(Y - k)} ${num(X - k)} ${num(Y - r)} ${num(X)} ${num(Y - r)} c ${num(X + k)} ${num(Y - r)} ${num(X + r)} ${num(Y - k)} ${num(X + r)} ${num(Y)} c`;
    this.ops.push(`q ${fill ? rgb(fill) + " rg " : ""}${stroke ? rgb(stroke) + " RG 0.8 w " : ""}${d} ${fill && stroke ? "B" : fill ? "f" : "S"} Q`);
  }
  triangle(cx, cy, r, up, color) {
    const pts = up ? [[cx, cy - r], [cx - r, cy + r * 0.8], [cx + r, cy + r * 0.8]] : [[cx, cy + r], [cx - r, cy - r * 0.8], [cx + r, cy - r * 0.8]];
    this.ops.push(`q ${rgb(color)} rg ${pts.map(([x, y], i) => `${num(x)} ${num(this.y(y))} ${i ? "l" : "m"}`).join(" ")} h f Q`);
  }
}

const latin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
async function deflate(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}

export class PdfDoc {
  constructor({ title = "", author = "", subject = "", width = 792, height = 612 } = {}) { this.meta = { title, author, subject }; this.size = [width, height]; this.pages = []; }
  addPage() { const p = new Page(...this.size); this.pages.push(p); return p; }
  /** Genera los bytes del archivo PDF. */
  async build() {
    const objs = [];          // cada objeto es una lista de trozos (texto o bytes)
    const add = (...parts) => objs.push(parts) && objs.length;
    const catalog = add(), pagesRoot = add(), f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
      f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids = [];
    for (const p of this.pages) {
      const raw = latin(p.ops.join("\n"));
      const z = await deflate(raw);
      const content = z ? add(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, z, "\nendstream") : add(`<< /Length ${raw.length} >>\nstream\n`, raw, "\nendstream");
      kids.push(add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objs[catalog - 1] = [`<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`];
    objs[pagesRoot - 1] = [`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`];
    const info = add(`<< /Title (${esc(clean(this.meta.title))}) /Author (${esc(clean(this.meta.author))}) /Subject (${esc(clean(this.meta.subject))}) /Producer (Anatomia segun Emmanuel Anguiano) >>`);
    const chunks = [latin("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
    let pos = chunks[0].length;
    const offsets = [];
    objs.forEach((parts, i) => {
      offsets.push(pos);
      const pieces = [`${i + 1} 0 obj\n`, ...parts, "\nendobj\n"].map((x) => (typeof x === "string" ? latin(x) : x));
      for (const c of pieces) { chunks.push(c); pos += c.length; }
    });
    const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
    chunks.push(latin(xref + `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}
