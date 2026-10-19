import { parseCrop, type Crop } from "@/lib/crop";

type Slider = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  digits: number;
  /** Значение по умолчанию; к нему же сбрасывает двойной клик. */
  default: number;
  group: string;
};

const tone = <K extends string>(key: K, label: string, group: string) =>
  ({ key, label, min: -100, max: 100, step: 1, digits: 0, default: 0, group }) as const;

/** Полосы спектра Color Mixer, как в Lightroom. hue — центр полосы в градусах HSV. */
export const MIXER_COLORS = [
  { id: "Red", label: "Red", hue: 0 },
  { id: "Orange", label: "Orange", hue: 30 },
  { id: "Yellow", label: "Yellow", hue: 60 },
  { id: "Green", label: "Green", hue: 120 },
  { id: "Aqua", label: "Aqua", hue: 180 },
  { id: "Blue", label: "Blue", hue: 240 },
  { id: "Purple", label: "Purple", hue: 270 },
  { id: "Magenta", label: "Magenta", hue: 300 },
] as const;

export const MIXER_CHANNELS = [
  { id: "hue", label: "Hue" },
  { id: "sat", label: "Saturation" },
  { id: "lum", label: "Luminance" },
] as const;

type MixerColor = (typeof MIXER_COLORS)[number]["id"];
type MixerChannel = (typeof MIXER_CHANNELS)[number]["id"];
export type MixerKey = `${MixerChannel}${MixerColor}`;

export const mixerKey = (channel: MixerChannel, color: MixerColor): MixerKey => `${channel}${color}`;

const MIXER_SLIDERS = MIXER_CHANNELS.flatMap((ch) =>
  MIXER_COLORS.map((c) => tone(mixerKey(ch.id, c.id), c.label, "mixer")),
);

export const SLIDERS = [
  // Баланс белого: относительный сдвиг от баланса камеры.
  tone("temp", "Temp", "wb"),
  tone("tint", "Tint", "wb"),
  // Тон.
  { key: "exposure", label: "Exposure", min: -5, max: 5, step: 0.05, digits: 2, default: 0, group: "tone" },
  tone("contrast", "Contrast", "tone"),
  // Светлое и тёмное: по одному ползунку, «+» — светлее, «−» — темнее.
  tone("lights", "Lights", "range"),
  tone("darks", "Darks", "range"),
  // Присутствие.
  tone("texture", "Texture", "presence"),
  tone("clarity", "Clarity", "presence"),
  tone("vibrance", "Vibrance", "presence"),
  tone("saturation", "Saturation", "presence"),
  // Цвет по отдельным участкам спектра: оттенок, насыщенность и яркость.
  ...MIXER_SLIDERS,
  // Детализация. Резкость: только контуры, гладкие участки не трогает.
  { key: "sharpen", label: "Sharpening", min: 0, max: 100, step: 1, digits: 0, default: 0, group: "detail" },
  // Шумоподавление нейросетью: смешивание исходного и очищенного кадра, 0 — без подавления.
  { key: "denoise", label: "Noise (AI)", min: 0, max: 100, step: 1, digits: 0, default: 0, group: "detail" },
] as const satisfies readonly Slider[];

/** Группы ползунков в порядке панели Basic/Detail в Lightroom. */
export const GROUPS = [
  { id: "wb", label: "White Balance" },
  { id: "tone", label: "Tone" },
  { id: "range", label: "Lights & Darks" },
  { id: "presence", label: "Presence" },
  { id: "mixer", label: "Color Mixer" },
  { id: "detail", label: "Detail" },
] as const;

export type AdjustmentKey = (typeof SLIDERS)[number]["key"];
export type Adjustments = Record<AdjustmentKey, number>;

export const DEFAULT_ADJUSTMENTS = Object.fromEntries(SLIDERS.map((s) => [s.key, s.default])) as Adjustments;

/** Приводит произвольный JSON к корректным настройкам: неизвестные поля отбрасываются, значения обрезаются по диапазону. */
export function parseAdjustments(input: unknown): Adjustments {
  const o = { ...((input ?? {}) as Record<string, unknown>) };
  // Старые файлы: Highlights/Whites и Shadows/Blacks были отдельными ползунками.
  // Берём из пары тот, что сдвинут сильнее, — он и задавал характер правки.
  const old = (key: string) => (typeof o[key] === "number" ? (o[key] as number) : 0);
  const stronger = (a: number, b: number) => (Math.abs(a) >= Math.abs(b) ? a : b);
  if (o.lights === undefined) o.lights = stronger(old("whites"), old("highlights"));
  if (o.darks === undefined) o.darks = stronger(old("blacks"), old("shadows"));
  const result = { ...DEFAULT_ADJUSTMENTS };
  for (const s of SLIDERS) {
    const v = o[s.key];
    if (typeof v === "number" && Number.isFinite(v)) result[s.key] = Math.min(s.max, Math.max(s.min, v));
  }
  return result;
}

/** Всё, что хранится в файле настроек рядом с исходником. */
export type Edits = Adjustments & { crop: Crop | null };

export const DEFAULT_EDITS: Edits = { ...DEFAULT_ADJUSTMENTS, crop: null };

export function parseEdits(input: unknown): Edits {
  return { ...parseAdjustments(input), crop: parseCrop((input as { crop?: unknown } | null)?.crop) };
}

/**
 * Внутренние операции шейдера (−1…+1) для ползунков Lights и Darks. «Светлее» в светлых —
 * в основном подтянуть их к белому (Whites), «темнее» — вернуть детали в светлых участках
 * по локальной маске (Highlights). Для тёмных наоборот: «светлее» — вытянуть тени (Shadows),
 * «темнее» — углубить чёрные (Blacks). Вторая операция подмешивается слабее, чтобы переход был цельным.
 */
export function toneRange({ lights, darks }: Pick<Adjustments, "lights" | "darks">) {
  const l = lights / 100;
  const d = darks / 100;
  return {
    highlights: l > 0 ? 0.3 * l : l,
    whites: l > 0 ? l : 0.3 * l,
    shadows: d > 0 ? d : 0.3 * d,
    blacks: d > 0 ? 0.3 * d : d,
  };
}
