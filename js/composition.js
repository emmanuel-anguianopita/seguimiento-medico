// Cálculo del IMC y lectura de la composición corporal. Funciones puras, sin interfaz.
// Referencias:
//  - IMC: clasificación de la OMS para adultos.
//  - % de grasa: rangos de Gallagher y colaboradores (Am J Clin Nutr 2000;72:694-701), por sexo y edad (20 a 79 años).
//  - % de agua: rangos habituales de básculas de bioimpedancia (Tanita, Withings): mujeres 45-60 %, hombres 50-65 %.
//  - Masa ósea: valores de referencia por sexo y peso de Tanita. Es una referencia aproximada, no un estudio de densidad ósea.

export function ageYears(birthIso, onIso) {
  if (!birthIso) return null;
  const b = new Date(birthIso + "T12:00:00"), d = new Date((onIso || new Date().toISOString().slice(0, 10)) + "T12:00:00");
  let a = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) a--;
  return a;
}

export const bmi = (kg, cm) => (kg && cm ? kg / Math.pow(cm / 100, 2) : null);

// status: normal | bajo | fuera (atención moderada) | alto (atención mayor)
export function bmiCategory(v, age) {
  if (age !== null && age < 18) return { label: "En menores de 18 años el IMC se interpreta con percentiles por edad (no incluidos)", status: "fuera", adult: false };
  if (v < 18.5) return { label: "Bajo peso", status: "bajo", adult: true };
  if (v < 25) return { label: "Peso normal", status: "normal", adult: true };
  if (v < 30) return { label: "Sobrepeso", status: "fuera", adult: true };
  if (v < 35) return { label: "Obesidad grado I", status: "alto", adult: true };
  if (v < 40) return { label: "Obesidad grado II", status: "alto", adult: true };
  return { label: "Obesidad grado III", status: "alto", adult: true };
}

// [inicio del rango saludable, inicio de exceso de grasa, inicio de obesidad]
const FAT = {
  F: [[20, 39, [21, 33, 39]], [40, 59, [23, 34, 40]], [60, 79, [24, 36, 42]]],
  M: [[20, 39, [8, 20, 25]], [40, 59, [11, 22, 28]], [60, 79, [13, 25, 30]]],
};
const r1 = (n) => Number(n.toFixed(1));

export function fatCategory(pct, sex, age) {
  if (!sex || age === null) return null;
  if (age < 20) return { label: "Sin rango de referencia para menores de 20 años", status: "fuera", range: null };
  const band = FAT[sex].find(([lo, hi]) => age >= lo && age <= hi) || FAT[sex][2];
  const [t0, t1, t2] = band[2];
  const range = `${t0}–${r1(t1 - 0.1)} %`;
  const approx = age > 79 ? " (referencia de 60 a 79 años, aproximada)" : "";
  if (pct < t0) return { label: "Por debajo del rango saludable" + approx, status: "bajo", range };
  if (pct < t1) return { label: "Dentro del rango saludable" + approx, status: "normal", range };
  if (pct < t2) return { label: "Exceso de grasa (rango de sobrepeso)" + approx, status: "fuera", range };
  return { label: "Exceso de grasa (rango de obesidad)" + approx, status: "alto", range };
}

export function waterCategory(pct, sex) {
  if (!sex) return null;
  const [lo, hi] = sex === "F" ? [45, 60] : [50, 65];
  const range = `${lo}–${hi} %`;
  if (pct < lo) return { label: "Por debajo del rango habitual", status: "bajo", range };
  if (pct > hi) return { label: "Por encima del rango habitual", status: "fuera", range };
  return { label: "Dentro del rango habitual", status: "normal", range };
}

export function boneReference(kg, sex) {
  if (!sex) return null;
  if (sex === "M") return kg < 65 ? 2.65 : kg <= 95 ? 3.29 : 3.69;
  return kg < 50 ? 1.95 : kg <= 75 ? 2.4 : 2.95;
}

export function boneCategory(boneKg, kg, sex) {
  const ref = boneReference(kg, sex);
  if (!ref) return null;
  const ratio = boneKg / ref;
  const text = `referencia aproximada ${ref} kg`;
  if (ratio < 0.85) return { label: "Por debajo de la referencia", status: "bajo", range: text };
  if (ratio <= 1.15) return { label: "Cercana a la referencia", status: "normal", range: text };
  return { label: "Por encima de la referencia", status: "normal", range: text };
}

/**
 * entry: { date, kg, fatPct?, waterPct?, boneKg? }   profile: { heightCm?, sex?, birthDate? }
 */
export function compose(entry, profile = {}) {
  const age = ageYears(profile.birthDate, entry.date);
  const sex = profile.sex || null;
  const missing = [];
  if (!profile.heightCm) missing.push("la altura");
  if (!sex) missing.push("el sexo");
  if (!profile.birthDate) missing.push("la fecha de nacimiento");

  const out = { age, sex, items: [], missing, kg: entry.kg };
  const value = bmi(entry.kg, profile.heightCm);
  if (value !== null) out.bmi = { value: r1(value), ...bmiCategory(value, age) };
  if (entry.fatPct != null) {
    out.fatMassKg = r1((entry.kg * entry.fatPct) / 100);
    out.leanMassKg = r1(entry.kg - out.fatMassKg);
    out.fat = { value: entry.fatPct, ...(fatCategory(entry.fatPct, sex, age) || {}) };
  }
  if (entry.waterPct != null) {
    out.waterKg = r1((entry.kg * entry.waterPct) / 100);
    out.water = { value: entry.waterPct, ...(waterCategory(entry.waterPct, sex) || {}) };
  }
  if (entry.boneKg != null) out.bone = { value: entry.boneKg, ...(boneCategory(entry.boneKg, entry.kg, sex) || {}) };

  // Resumen en lenguaje sencillo
  const checked = [["IMC", out.bmi], ["% de grasa", out.fat], ["% de agua", out.water], ["masa ósea", out.bone]].filter(([, x]) => x && x.status);
  const attention = checked.filter(([, x]) => x.status !== "normal");
  const parts = [];
  if (out.bmi) parts.push(`IMC ${out.bmi.value}: ${out.bmi.label.toLowerCase()}.`);
  if (out.fat?.status) parts.push(`Grasa corporal ${out.fat.value} %: ${out.fat.label.toLowerCase()}${out.fat.range ? ` (${out.fat.range} para ${sex === "F" ? "mujeres" : "hombres"} de su edad)` : ""}.`);
  if (out.fat) parts.push(`Equivale a ${out.fatMassKg} kg de grasa y ${out.leanMassKg} kg de masa magra (músculo, agua, huesos y órganos).`);
  if (out.water?.status) parts.push(`Agua corporal ${out.water.value} %: ${out.water.label.toLowerCase()} (${out.water.range}).`);
  if (out.bone?.status) parts.push(`Masa ósea ${out.bone.value} kg: ${out.bone.label.toLowerCase()}.`);
  let level = "sin datos";
  if (checked.length) level = attention.length === 0 ? "normal" : attention.some(([, x]) => x.status === "alto") ? "alto" : "fuera";
  out.level = level;
  out.headline = !checked.length ? "Faltan datos para evaluar la composición."
    : attention.length === 0 ? "Composición corporal dentro de los rangos de referencia."
    : `Puntos de atención: ${attention.map(([n]) => n).join(", ")}.`;
  out.paragraphs = parts;
  return out;
}
