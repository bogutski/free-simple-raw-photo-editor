// Линейный sRGB → XYZ → конусное пространство Bradford, и обратно.
const SRGB_TO_XYZ = [0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505];
const XYZ_TO_SRGB = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057];
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const BRADFORD_INV = [0.9870, -0.1471, 0.1600, 0.4323, 0.5184, 0.0493, -0.0085, 0.0400, 0.9685];

const mul = (a: number[], b: number[]) =>
  Array.from({ length: 9 }, (_, i) => {
    const r = Math.floor(i / 3);
    const c = i % 3;
    return a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  });

const TO_LMS = mul(BRADFORD, SRGB_TO_XYZ);
const FROM_LMS = mul(XYZ_TO_SRGB, BRADFORD_INV);

/**
 * Сдвиг баланса белого относительно камерного: масштабирование конусных откликов
 * (адаптация фон Криса). temp: тёплое ↔ холодное, tint: пурпурный ↔ зелёный, оба −1…+1.
 * Яркость белого сохраняется. Матрица 3×3 по строкам, применяется к линейному sRGB.
 */
export function whiteBalance(temp: number, tint: number): Float32Array {
  const gains = [2 ** (0.3 * temp), 2 ** (-0.2 * tint), 2 ** (-0.9 * temp)];
  const diag = [gains[0], 0, 0, 0, gains[1], 0, 0, 0, gains[2]];
  const m = mul(FROM_LMS, mul(diag, TO_LMS));

  const white = [0, 1, 2].map((r) => m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2]);
  const norm = 0.2126 * white[0] + 0.7152 * white[1] + 0.0722 * white[2];
  return new Float32Array(m.map((v) => v / norm));
}
