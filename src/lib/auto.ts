import { MIXER_CHANNELS, MIXER_COLORS, mixerKey, type Adjustments, type MixerKey } from "@/lib/adjustments";
import type { LinearImage } from "@/lib/raw-decoder";
import { whiteBalance } from "@/lib/white-balance";

/** Ползунки, которые выставляет Auto; остальные остаются как были. */
export type AutoResult = Pick<
  Adjustments,
  "temp" | "tint" | "exposure" | "contrast" | "lights" | "darks" | "vibrance" | MixerKey
>;

const LUMA = [0.2126, 0.7152, 0.0722];
/** Сколько точек кадра анализируем: хватает для статистики, считается за десятки мс. */
const SAMPLES = 250_000;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Тёплый оттенок: от красного до жёлтого (примерно 0°…60°). */
function isWarm(r: number, g: number, b: number): boolean {
  return r >= g && g >= b;
}

/** Перцентиль (0…1) с весами: values и weights одинаковой длины. */
function weightedPercentile(values: Float32Array, weights: Float32Array | null, p: number): number {
  const order = Array.from(values.keys()).sort((a, b) => values[a] - values[b]);
  const total = weights ? weights.reduce((s, w) => s + w, 0) : values.length;
  let acc = 0;
  for (const i of order) {
    acc += weights ? weights[i] : 1;
    if (acc >= p * total) return values[i];
  }
  return values[order[order.length - 1]];
}

/**
 * Автонастройка по статистике кадра, как кнопка Auto в Lightroom (без нейросети):
 * баланс белого по почти нейтральным светлым участкам, экспозиция по средним тонам
 * с весом центра кадра, края гистограммы — белыми/чёрными, перегруженные зоны —
 * светами/тенями, ширина гистограммы — контрастом, блёклость — сочностью.
 */
export function computeAuto(
  { width, height, data }: LinearImage,
  /** Баланс белого от нейросети; без него — оценка по статистике кадра. */
  neuralWb?: { temp: number; tint: number },
): AutoResult {
  // --- Выборка точек на равномерной сетке.
  const step = Math.max(1, Math.round(Math.sqrt((width * height) / SAMPLES)));
  const rgb: number[] = [];
  const center: number[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 3;
      rgb.push(data[i] / 65535, data[i + 1] / 65535, data[i + 2] / 65535);
      // Вес центра: объект съёмки обычно ближе к середине кадра.
      const dx = x / width - 0.5;
      const dy = y / height - 0.5;
      center.push(Math.exp(-(dx * dx + dy * dy) / (2 * 0.25 * 0.25)));
    }
  }
  const n = center.length;

  // --- Баланс белого: средний цвет светлых почти серых незасвеченных точек.
  // Тёплые оттенки (кожа, бежевые стены, дерево) не берём: они не серые, и их «нейтрализация»
  // охлаждала бы весь кадр — именно так Auto раньше синил лица.
  const lumaOf = (i: number) => LUMA[0] * rgb[i * 3] + LUMA[1] * rgb[i * 3 + 1] + LUMA[2] * rgb[i * 3 + 2];
  const lumas = Float32Array.from({ length: n }, (_, i) => lumaOf(i));
  const bright = weightedPercentile(lumas, null, 0.3);
  let sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < n; i++) {
    const [r, g, b] = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
    const max = Math.max(r, g, b);
    if (max >= 0.95 || lumas[i] < bright || max <= 0) continue;
    const saturation = (max - Math.min(r, g, b)) / max;
    if (saturation > 0.12) continue;
    if (saturation > 0.04 && isWarm(r, g, b)) continue;
    sum = [sum[0] + r / lumas[i], sum[1] + g / lumas[i], sum[2] + b / lumas[i]];
    count++;
  }
  let temp = 0;
  let tint = 0;
  let estimateTemp = 0;
  let estimateTint = 0;
  if (neuralWb) {
    ({ temp, tint } = neuralWb);
  } else if (count > n * 0.01) {
    // Мало нейтральных точек — доверяем балансу камеры.
    const illum = sum.map((v) => v / count);
    let best = Infinity;
    for (let t = -60; t <= 60; t += 2) {
      for (let ti = -60; ti <= 60; ti += 2) {
        const m = whiteBalance(t / 100, ti / 100);
        const r = m[0] * illum[0] + m[1] * illum[1] + m[2] * illum[2];
        const g = m[3] * illum[0] + m[4] * illum[1] + m[5] * illum[2];
        const b = m[6] * illum[0] + m[7] * illum[1] + m[8] * illum[2];
        const err = (r / g - 1) ** 2 + (b / g - 1) ** 2;
        if (err < best) [best, estimateTemp, estimateTint] = [err, t, ti];
      }
    }
    // Камера обычно ошибается несильно: сдвигаем на половину оценки и не дальше ±20.
    temp = clamp(Math.round(estimateTemp / 2), -20, 20);
    tint = clamp(Math.round(estimateTint / 2), -20, 20);
  }

  // --- Яркость после баланса белого.
  const wb = whiteBalance(temp / 100, tint / 100);
  const y = new Float32Array(n);
  const maxChannel = new Float32Array(n);
  const sat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [r0, g0, b0] = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
    const r = wb[0] * r0 + wb[1] * g0 + wb[2] * b0;
    const g = wb[3] * r0 + wb[4] * g0 + wb[5] * b0;
    const b = wb[6] * r0 + wb[7] * g0 + wb[8] * b0;
    y[i] = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    maxChannel[i] = Math.max(r, g, b);
    const dr = toSrgb(clamp(r, 0, 1));
    const dg = toSrgb(clamp(g, 0, 1));
    const db = toSrgb(clamp(b, 0, 1));
    const mx = Math.max(dr, dg, db);
    sat[i] = mx > 0.02 ? (mx - Math.min(dr, dg, db)) / mx : 0;
  }

  // --- Экспозиция: средние тона с весом центра — к целевой яркости.
  const logY = y.map((v) => Math.log2(v + 1e-5));
  const midLog = weightedPercentile(logY, Float32Array.from(center), 0.5);
  const exposure = clamp(Math.log2(0.25) - midLog, -3, 3);
  const gain = 2 ** exposure;

  // --- Доли пересвеченных и провальных точек после экспозиции.
  let highs = 0;
  let lows = 0;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    const v = y[i] * gain;
    if (v > 0.75) highs++;
    if (v < 0.02) lows++;
    if (maxChannel[i] * gain > 1) clipped++;
  }
  const highlights = -clamp((highs / n - 0.02) * 400, 0, 70);
  const shadows = clamp((lows / n - 0.02) * 300, 0, 60);

  // --- Белые и чёрные: растягиваем края гистограммы в отображаемых значениях.
  const display = y.map((v) => toSrgb(clamp(v * gain, 0, 1)));
  const hi = weightedPercentile(display, null, 0.995);
  const lo = weightedPercentile(display, null, 0.005);
  // В шейдере: display += whites · 0.35 · d³ и display += blacks · 0.2 · (1 − d)³.
  let whites = hi < 0.97 ? ((0.98 - hi) / (0.35 * hi ** 3)) * 70 : 0;
  if (clipped / n > 0.005) whites = -Math.min(40, (clipped / n) * 1000);
  const blacks = lo > 0.03 ? (-(lo - 0.02) / (0.2 * (1 - lo) ** 3)) * 70 : 0;

  // --- Контраст по ширине гистограммы в ступенях.
  const range =
    weightedPercentile(logY, null, 0.95) - weightedPercentile(logY, null, 0.05);
  const contrast = clamp((7 - range) * 8, -20, 30);

  // --- Сочность: немного, если кадр блёклый.
  const meanSat = sat.reduce((s, v) => s + v, 0) / n;
  const vibrance = clamp((0.25 - meanSat) * 120, 0, 30);

  return {
    ...autoMixer(rgb, center, wb, gain),
    temp,
    tint,
    exposure: Math.round(exposure * 20) / 20,
    contrast: Math.round(contrast),
    // Lights: если светлые пересвечены — темнее (вернуть детали), иначе — дотянуть до белого.
    lights: Math.round(highlights < 0 || whites < 0 ? Math.min(highlights, whites, 0) : clamp(whites, 0, 35)),
    // Darks: провалы — вытянуть тени, иначе — углубить чёрные; берём то, что нужнее.
    darks: Math.round(shadows >= -clamp(blacks, -35, 0) ? shadows : clamp(blacks, -35, 0)),
    vibrance: Math.round(vibrance),
  };
}

/** Центры полос Color Mixer (градусы HSV) с повтором красного на 360°, как в шейдере. */
const MIX_HUES = [...MIXER_COLORS.map((c) => c.hue), 360];
/** Какой тон кожи считаем правильным и какой насыщенности (HSV на экране). */
const SKIN_HUE = 22;
const SKIN_SAT = 0.38;

/** Оттенок (0…360) и насыщенность HSV цвета в отображаемых значениях. */
function hsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  if (d < 1e-4) return { h: 0, s: 0, v: mx };
  let h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return { h, s: d / mx, v: mx };
}

/** Доли двух соседних полос, в которые попадает оттенок (так же плавно, как в шейдере). */
function bandWeights(h: number): [number, number, number] {
  let i = 0;
  for (let k = 1; k < 8; k++) if (h >= MIX_HUES[k]) i = k;
  const x = (h - MIX_HUES[i]) / (MIX_HUES[i + 1] - MIX_HUES[i]);
  const t = x * x * (3 - 2 * x);
  return [i, (i + 1) % 8, t];
}

/**
 * Color Mixer для Auto. Кожа: оттенок и насыщенность оранжевого (и отчасти красного) подтягиваются
 * к естественному тону — так убирается красноватая или «загарная» кожа. Остальные цвета, которые
 * занимают заметную часть кадра и выглядят блёкло, немного насыщаются. Всё мягко, с ограничениями:
 * Auto должен поправлять, а не перекрашивать.
 */
function autoMixer(rgb: number[], center: number[], wb: ArrayLike<number>, gain: number): Pick<Adjustments, MixerKey> {
  const result = Object.fromEntries(
    MIXER_CHANNELS.flatMap((ch) => MIXER_COLORS.map((c) => [mixerKey(ch.id, c.id), 0])),
  ) as Pick<Adjustments, MixerKey>;

  const n = center.length;
  const share = new Float64Array(8);
  const satSum = new Float64Array(8);
  let total = 0;
  let skinW = 0;
  let skinHue = 0;
  let skinSat = 0;
  for (let i = 0; i < n; i++) {
    const [r0, g0, b0] = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
    const r = toSrgb(clamp((wb[0] * r0 + wb[1] * g0 + wb[2] * b0) * gain, 0, 1));
    const g = toSrgb(clamp((wb[3] * r0 + wb[4] * g0 + wb[5] * b0) * gain, 0, 1));
    const b = toSrgb(clamp((wb[6] * r0 + wb[7] * g0 + wb[8] * b0) * gain, 0, 1));
    const { h, s, v } = hsv(r, g, b);
    total++;
    // Почти серые, тёмные и пересвеченные точки цвета не показывают.
    if (s < 0.1 || v < 0.15 || v > 0.98) continue;
    const [a, c, t] = bandWeights(h);
    share[a] += 1 - t;
    share[c] += t;
    satSum[a] += (1 - t) * s;
    satSum[c] += t * s;
    // Кожа: тёплые оттенки средней насыщенности, с весом центра кадра.
    if (h < 50 && s > 0.12 && s < 0.75 && v > 0.25) {
      const w = center[i];
      skinW += w;
      skinHue += w * h;
      skinSat += w * s;
    }
  }

  const round = (v: number) => Math.round(v);
  if (skinW > 0 && skinW / n > 0.02) {
    const hue = skinHue / skinW;
    const sat = skinSat / skinW;
    // Ползунок Hue ±100 сдвигает оттенок примерно на ±30°; исправляем половину отклонения.
    const hueShift = clamp(((SKIN_HUE - hue) / 30) * 100 * 0.5, -20, 20);
    result.hueOrange = round(hueShift);
    result.hueRed = round(hueShift / 2);
    // Saturation −100 убирает цвет, +100 удваивает: множитель 1 + x/100.
    const satShift = clamp((SKIN_SAT / sat - 1) * 100 * 0.6, -25, 10);
    result.satOrange = round(satShift);
    result.satRed = round(satShift / 2);
  }

  // Блёклые цвета, которых в кадре заметно много (небо, зелень, одежда), — чуть насыщеннее.
  for (const [i, c] of MIXER_COLORS.entries()) {
    if (c.id === "Red" || c.id === "Orange" || share[i] / total < 0.03) continue;
    const mean = satSum[i] / share[i];
    if (mean < 0.3) result[mixerKey("sat", c.id)] = round(clamp((0.3 - mean) * 100, 0, 15));
  }
  return result;
}
