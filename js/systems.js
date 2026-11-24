// Clasificación de indicadores por sistema u órgano. Es una orientación general: algunos indicadores
// participan en varios sistemas y aquí se ubican en el más habitual.
export const SYSTEMS = [
  ["Sangre: serie roja", "🩸"], ["Sangre: serie blanca", "🛡️"], ["Plaquetas", "🧫"],
  ["Hígado y vías biliares", "🫘"], ["Páncreas", "🥐"], ["Riñón y vías urinarias", "💧"],
  ["Glucosa y metabolismo", "🍬"], ["Lípidos y corazón", "❤️"], ["Electrolitos y minerales", "🧂"],
  ["Proteínas", "🥚"], ["Tiroides", "🦋"], ["Vitaminas y huesos", "🦴"],
  ["Inflamación y reumatología", "🔥"], ["Autoinmunidad", "🧬"], ["Otros", "📋"],
];
export const SYSTEM_NAMES = SYSTEMS.map(([n]) => n);
export const systemIcon = (name) => (SYSTEMS.find(([n]) => n === name) || [])[1] || "📋";

const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// Reglas en orden: gana la primera que coincide.
const RULES = [
  [/proteina c reactiva|sedimentacion|factor reumatoide|ccp|hla-b27|complemento/, "Inflamacion"],
  [/inmunoglobulina|^ig[gam] /, "Autoinmunidad"],
  [/anticoagulante lupico|cardiolipina|beta-2-glicoproteina|anti-|antinucleares|anca|anticuerpos anti-citoplasma/, "Autoinmunidad"],
  [/glicosilada|hba1c|insulina|homa/, "Glucosa y metabolismo"],
  [/plaquet/, "Plaquetas"],
  [/eritrocitos|hemoglobina|hematocrito|volumen corpuscular|ancho de distribucion eritrocitaria/, "Sangre: serie roja"],
  [/leucocitos|linfocitos|monocitos|eosinofilos|basofilos|neutrofilos|bandas|blastos|mielocitos|metamielocitos/, "Sangre: serie blanca"],
  [/^alt |^ast |bilirrubina|fosfatasa alcalina|ggt|ldh/, "Hígado y vías biliares"],
  [/ast\/alt/, "Hígado y vías biliares"],
  [/amilasa|lipasa/, "Páncreas"],
  [/creatinina|urea|nitrogeno ureico|bun|acido urico|filtracion glomerular/, "Riñón y vías urinarias"],
  [/^glucosa/, "Glucosa y metabolismo"],
  [/colesterol|trigliceridos|aterogenico|ldl|hdl|lipido|fosfolipido|lipoprote/, "Lípidos y corazón"],
  [/sodio|potasio|cloruro|calcio|fosforo|magnesio|hierro|ferritina|transferrina/, "Electrolitos y minerales"],
  [/albumina|globulina|proteinas totales|relacion a\/g/, "Proteínas"],
  [/tiroides|tsh|tiroxina|triyodotironina|t4 libre|t3 libre/, "Tiroides"],
  [/vitamina|folico/, "Vitaminas y huesos"],
];
const FIX = { Inflamacion: "Inflamación y reumatología" };

export function systemOf(name, category) {
  if (category === "Orina") return "Riñón y vías urinarias";
  const n = strip(name);
  for (const [rx, sys] of RULES) if (rx.test(n)) return FIX[sys] || sys;
  return "Otros";
}
