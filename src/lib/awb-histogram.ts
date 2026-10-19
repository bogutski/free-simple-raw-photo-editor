import type { LinearImage } from "@/lib/raw-decoder";
import { whiteBalance } from "@/lib/white-balance";

/*
 * Подготовка входа для нейросетевого автобаланса C5 (см. awb-model.ts) и перевод
 * его ответа в наши ползунки. Работает в браузере: кадр уже здесь, а на сервер
 * уходят только гистограммы (32 КБ).
 */

export const HIST_BINS = 64;
/** Границы log-цветности u = log(g/r), v = log(g/b). */
export const HIST_BOUND = 2.85;
const BIN = (2 * HIST_BOUND) / (HIST_BINS - 1);
const EPS = 1e-9;
/** Размер уменьшенного кадра, по которому строятся гистограммы (как при обучении C5). */
const SMALL_W = 384;
const SMALL_H = 256;

/** Цветовые данные LibRaw: множители баланса камеры и матрица «камера → sRGB». */
export type CameraColor = { camMul: number[]; rgbCam: number[][] };

const inv3 = (m: number[]) => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(
    (v) => v / det,
  );
};

/** Баланс камеры, нормированный на зелёный. */
const camMulNorm = ({ camMul }: CameraColor) => [camMul[0] / camMul[1], 1, camMul[2] / camMul[1]];

/**
 * Линейный sRGB с балансом камеры → «сырые» цвета камеры без баланса, уменьшенные
 * до 384×256 усреднением (вертикальный кадр поворачивается набок). Пересвеченные
 * пиксели дают ноль — C5 их не учитывает.
 */
function toRawSmall({ width: w, height: h, data }: LinearImage, color: CameraColor): Float64Array {
  const cm = camMulNorm(color);
  const m = inv3(color.rgbCam.flat());
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] /= cm[r];

  const portrait = h > w;
  const W = portrait ? h : w;
  const H = portrait ? w : h;
  const out = new Float64Array(SMALL_W * SMALL_H * 3);
  const count = new Float64Array(SMALL_W * SMALL_H);
  const clip = 0.999 * 65535;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const [R, G, B] = [data[i], data[i + 1], data[i + 2]];
      const X = portrait ? y : x;
      const Y = portrait ? x : y;
      const o = Math.min(SMALL_H - 1, Math.floor((Y * SMALL_H) / H)) * SMALL_W + Math.min(SMALL_W - 1, Math.floor((X * SMALL_W) / W));
      count[o]++;
      if (R >= clip || G >= clip || B >= clip) continue;
      for (let c = 0; c < 3; c++) out[o * 3 + c] += Math.max(0, m[c * 3] * R + m[c * 3 + 1] * G + m[c * 3 + 2] * B);
    }
  }
  for (let o = 0; o < SMALL_W * SMALL_H; o++) for (let c = 0; c < 3; c++) out[o * 3 + c] /= count[o] * 65535;
  return out;
}

/** Гистограмма log-цветности: строки — v (сверху вниз по убыванию), столбцы — u; вес — яркость, нормировка корнем. */
function histogram(img: Float64Array, dst: Float32Array, offset: number) {
  const n = HIST_BINS;
  const acc = new Float64Array(n * n);
  const center = (i: number) => -HIST_BOUND + i * BIN;
  for (let p = 0; p < SMALL_W * SMALL_H; p++) {
    const [r, g, b] = [img[p * 3], img[p * 3 + 1], img[p * 3 + 2]];
    if (r + g + b <= EPS) continue;
    const lg = Math.log(g + EPS);
    const u = lg - Math.log(r + EPS);
    const v = lg - Math.log(b + EPS);
    const weight = Math.hypot(r, g, b);
    const iu0 = Math.max(0, Math.ceil((u + HIST_BOUND) / BIN - 1 - 1e-9));
    const iv0 = Math.max(0, Math.ceil((v + HIST_BOUND) / BIN - 1 - 1e-9));
    for (let iv = iv0; iv < Math.min(n, iv0 + 3); iv++) {
      const dv = Math.abs(v - center(iv));
      if (dv > BIN || dv === 0) continue;
      for (let iu = iu0; iu < Math.min(n, iu0 + 3); iu++) {
        const du = Math.abs(u - center(iu));
        if (du > BIN || du === 0) continue;
        acc[(n - 1 - iv) * n + iu] += weight;
      }
    }
  }
  let sum = EPS;
  for (const v of acc) sum += v;
  for (let i = 0; i < n * n; i++) dst[offset + i] = Math.sqrt(acc[i] / sum);
}

/** Контуры: средний модуль разницы с 8 соседями (с зеркальным краем). */
function edges(img: Float64Array): Float64Array {
  const e = new Float64Array(img.length);
  const reflect = (i: number, n: number) => (i < 0 ? -i - 1 : i >= n ? 2 * n - i - 1 : i);
  for (let y = 0; y < SMALL_H; y++) {
    for (let x = 0; x < SMALL_W; x++) {
      const p = (y * SMALL_W + x) * 3;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const q = (reflect(y + dy, SMALL_H) * SMALL_W + reflect(x + dx, SMALL_W)) * 3;
          for (let c = 0; c < 3; c++) e[p + c] += Math.abs(img[p + c] - img[q + c]) / 8;
        }
      }
    }
  }
  return e;
}

/** Вход C5: гистограммы кадра и его контуров, 2×64×64. */
export function awbHistograms(image: LinearImage, color: CameraColor): Float32Array<ArrayBuffer> {
  const small = toRawSmall(image, color);
  const out = new Float32Array(2 * HIST_BINS * HIST_BINS);
  histogram(small, out, 0);
  histogram(edges(small), out, HIST_BINS * HIST_BINS);
  return out;
}

/** Освещение из «сырых» цветов камеры → в линейный sRGB с балансом камеры (g = 1). */
export function illuminantToSrgb(raw: number[], color: CameraColor): number[] {
  const cm = camMulNorm(color);
  const il = color.rgbCam.map((row) => row[0] * cm[0] * raw[0] + row[1] * cm[1] * raw[1] + row[2] * cm[2] * raw[2]);
  return il.map((v) => v / il[1]);
}

/** Угол между цветами в градусах. */
function angle(a: number[], b: number[]) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (Math.acos(Math.min(1, Math.max(-1, dot / Math.hypot(...a) / Math.hypot(...b)))) * 180) / Math.PI;
}

/** Temp/Tint (−1…+1), при которых наша матрица баланса делает это освещение нейтральным. */
export function illuminantToTempTint(illum: number[]): { temp: number; tint: number } {
  const error = (t: number, n: number) => {
    const m = whiteBalance(t, n);
    const v = [0, 1, 2].map((r) => m[r * 3] * illum[0] + m[r * 3 + 1] * illum[1] + m[r * 3 + 2] * illum[2]);
    return angle(v, [1, 1, 1]);
  };
  let best = { e: Infinity, t: 0, n: 0 };
  for (let t = -1; t <= 1.0001; t += 0.05) {
    for (let n = -1; n <= 1.0001; n += 0.05) {
      const e = error(t, n);
      if (e < best.e) best = { e, t, n };
    }
  }
  for (const step of [0.01, 0.002]) {
    const { t: t0, n: n0 } = best;
    for (let i = -5; i <= 5; i++) {
      for (let j = -5; j <= 5; j++) {
        const e = error(t0 + i * step, n0 + j * step);
        if (e < best.e) best = { e, t: t0 + i * step, n: n0 + j * step };
      }
    }
  }
  return { temp: best.t, tint: best.n };
}
