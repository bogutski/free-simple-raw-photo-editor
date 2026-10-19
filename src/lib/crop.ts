/**
 * Кадрирование. Прямоугольник хранится в долях ширины и высоты изображения (0…1),
 * поэтому не зависит от разрешения декодирования.
 */
export type CropRect = { x: number; y: number; w: number; h: number };

export type AspectId = "free" | "original" | "1:1" | "5:4" | "7:5" | "3:2" | "16:9";
export type Orientation = "landscape" | "portrait";

/** angle — поворот фото под рамкой в градусах (по часовой стрелке), −45…+45. */
export type Crop = CropRect & { aspect: AspectId; orientation: Orientation; angle: number };

export const MAX_ANGLE = 45;

/** Пропорции в «горизонтальном» виде: ширина / высота. Для вертикали переворачиваются. */
export const ASPECTS: { id: AspectId; label: string; ratio: number | "image" | null }[] = [
  { id: "free", label: "Free", ratio: null },
  { id: "original", label: "Original", ratio: "image" },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "5:4", label: "5:4", ratio: 5 / 4 },
  { id: "7:5", label: "7:5", ratio: 7 / 5 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
];

export const FULL_FRAME: CropRect = { x: 0, y: 0, w: 1, h: 1 };
const MIN_SIZE = 0.05;

/** Подпись пропорции с учётом ориентации: «5:4» или «4:5». */
export function aspectLabel(id: AspectId, orientation: Orientation): string {
  const a = ASPECTS.find((x) => x.id === id)!;
  if (typeof a.ratio !== "number" || a.ratio === 1 || orientation === "landscape") return a.label;
  return a.label.split(":").reverse().join(":");
}

/**
 * Пропорция рамки в долях изображения (w/h в координатах 0…1) или null, если свободная.
 * imageAspect — ширина / высота изображения в пикселях.
 */
export function normalizedRatio(crop: Pick<Crop, "aspect" | "orientation">, imageAspect: number): number | null {
  const a = ASPECTS.find((x) => x.id === crop.aspect)!;
  if (a.ratio === null) return null;
  if (a.ratio === "image") return 1;
  const pixel = crop.orientation === "portrait" ? 1 / a.ratio : a.ratio;
  return pixel / imageAspect;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Самая большая рамка нужной пропорции с центром в центре текущей, не выходящая за кадр. */
export function fitRatio(rect: CropRect, ratio: number | null): CropRect {
  if (ratio === null) return rect;
  let w = Math.min(1, ratio);
  let h = w / ratio;
  if (h > 1) {
    h = 1;
    w = ratio;
  }
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

export function moveRect(rect: CropRect, dx: number, dy: number): CropRect {
  return { ...rect, x: clamp(rect.x + dx, 0, 1 - rect.w), y: clamp(rect.y + dy, 0, 1 - rect.h) };
}

/** Ручка рамки: стороны света, как у курсоров resize. */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Изменение рамки перетаскиванием ручки; при заданной пропорции она сохраняется. */
export function resizeRect(rect: CropRect, handle: Handle, dx: number, dy: number, ratio: number | null): CropRect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;

  if (handle.includes("w")) left = clamp(left + dx, 0, right - MIN_SIZE);
  if (handle.includes("e")) right = clamp(right + dx, left + MIN_SIZE, 1);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - MIN_SIZE);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN_SIZE, 1);
  if (ratio === null) return { x: left, y: top, w: right - left, h: bottom - top };

  // С пропорцией: определяем размер по ведущей стороне, затем вписываем в доступное место.
  const horizontal = handle.includes("e") || handle.includes("w");
  const vertical = handle.includes("n") || handle.includes("s");
  let w = right - left;
  let h = bottom - top;
  if (horizontal && (!vertical || Math.abs(dx) >= Math.abs(dy) * ratio)) h = w / ratio;
  else w = h * ratio;

  // Точка, которая остаётся на месте: противоположный угол или центр противоположной стороны.
  const anchorX = handle.includes("w") ? rect.x + rect.w : handle.includes("e") ? rect.x : rect.x + rect.w / 2;
  const anchorY = handle.includes("n") ? rect.y + rect.h : handle.includes("s") ? rect.y : rect.y + rect.h / 2;
  const fx = handle.includes("w") ? 1 : handle.includes("e") ? 0 : 0.5;
  const fy = handle.includes("n") ? 1 : handle.includes("s") ? 0 : 0.5;

  // Максимальная ширина, при которой рамка помещается в кадр от точки привязки.
  const maxW = Math.min(
    fx === 1 ? anchorX : fx === 0 ? 1 - anchorX : 2 * Math.min(anchorX, 1 - anchorX),
    (fy === 1 ? anchorY : fy === 0 ? 1 - anchorY : 2 * Math.min(anchorY, 1 - anchorY)) * ratio,
  );
  w = clamp(w, Math.min(MIN_SIZE, maxW), maxW);
  h = w / ratio;
  return { x: anchorX - w * fx, y: anchorY - h * fy, w, h };
}

export function parseCrop(input: unknown): Crop | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const x = clamp(num(o.x), 0, 1);
  const y = clamp(num(o.y), 0, 1);
  const w = clamp(num(o.w), MIN_SIZE, 1 - x);
  const h = clamp(num(o.h), MIN_SIZE, 1 - y);
  if ([x, y, w, h].some(Number.isNaN)) return null;
  const aspect = ASPECTS.some((a) => a.id === o.aspect) ? (o.aspect as AspectId) : "free";
  const orientation = o.orientation === "portrait" ? "portrait" : "landscape";
  const angle = clamp(Number.isFinite(o.angle) ? (o.angle as number) : 0, -MAX_ANGLE, MAX_ANGLE);
  return { x, y, w, h, aspect, orientation, angle };
}

// --- Поворот -------------------------------------------------------------------

/**
 * Лежит ли рамка целиком внутри повёрнутого фото. Считаем в пикселях
 * (ширина изображения = imageAspect, высота = 1): каждый угол рамки переводим
 * в координаты исходного фото обратным поворотом вокруг центра.
 */
export function rectInside(rect: CropRect, angle: number, imageAspect: number): boolean {
  const a = (angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = imageAspect / 2;
  const cy = 0.5;
  const eps = 1e-6;
  for (const [x, y] of [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h],
  ]) {
    const dx = x * imageAspect - cx;
    const dy = y - cy;
    const sx = cx + cos * dx + sin * dy;
    const sy = cy - sin * dx + cos * dy;
    if (sx < -eps || sx > imageAspect + eps || sy < -eps || sy > 1 + eps) return false;
  }
  return true;
}

/**
 * Самая большая рамка с тем же центром и пропорциями, что помещается в повёрнутое фото.
 * Если не помещается даже маленькая — переносим центр в центр кадра.
 */
export function fitInside(rect: CropRect, angle: number, imageAspect: number): CropRect {
  if (rectInside(rect, angle, imageAspect)) return rect;
  const scaled = (r: CropRect, s: number): CropRect => ({
    x: r.x + (r.w * (1 - s)) / 2,
    y: r.y + (r.h * (1 - s)) / 2,
    w: r.w * s,
    h: r.h * s,
  });
  let base = rect;
  if (!rectInside(scaled(base, 0.01), angle, imageAspect)) base = { ...rect, x: 0.5 - rect.w / 2, y: 0.5 - rect.h / 2 };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (rectInside(scaled(base, mid), angle, imageAspect)) lo = mid;
    else hi = mid;
  }
  return scaled(base, lo);
}

/** Кроп без кадрирования: весь кадр, ориентация рамки как у снимка. */
export function defaultCrop(imageAspect: number | null): Crop {
  return {
    ...FULL_FRAME,
    aspect: "free",
    orientation: imageAspect !== null && imageAspect < 1 ? "portrait" : "landscape",
    angle: 0,
  };
}

/** Поворот: base — рамка до начала поворота; она уменьшается ровно настолько, чтобы влезть. */
export function rotateCrop(crop: Crop, base: CropRect, angle: number, imageAspect: number): Crop {
  const a = clamp(angle, -MAX_ANGLE, MAX_ANGLE);
  return { ...crop, ...fitInside(base, a, imageAspect), angle: a };
}
