// Convierte un PDF en filas de texto (una fila de tabla por cadena) usando pdf.js.
export function rowsFromItems(items, tol = 3) {
  const pieces = items.filter((it) => it.str && it.str.trim() !== "")
    .map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width || 0, s: it.str.trim() }));
  pieces.sort((a, b) => (a.y !== b.y ? b.y - a.y : a.x - b.x));
  const groups = [];
  for (const p of pieces) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].y - p.y) <= tol) g.push(p); else groups.push([p]);
  }
  return groups.map((g) => {
    g.sort((a, b) => a.x - b.x);
    let line = g[0].s;
    for (let i = 1; i < g.length; i++) {
      const gap = g[i].x - (g[i - 1].x + g[i - 1].w);
      line += (gap < 0.8 ? "" : gap < 6 ? " " : "   ") + g[i].s;
    }
    return line;
  });
}

export async function pdfToPages(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(rowsFromItems(content.items));
  }
  return pages;
}
