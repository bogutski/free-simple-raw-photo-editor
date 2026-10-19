import path from "node:path";
import * as ort from "onnxruntime-node";
import { HIST_BINS, HIST_BOUND } from "@/lib/awb-histogram";

/*
 * Нейросетевой автобаланс белого C5 (Cross-Camera Convolutional Color Constancy,
 * Afifi et al., ICCV 2021, Apache-2.0). Модель смотрит на гистограммы цветности кадра
 * в «сырых» цветах камеры и оценивает цвет освещения. Обучена на нескольких камерах
 * и рассчитана на работу с незнакомыми (в том числе Sony).
 *
 * Модель выдаёт фильтр F, смещение B и множитель G; последний шаг (круговая свёртка
 * гистограммы с F, softmax, ожидаемая точка) считается здесь: FFT в ONNX не работает
 * на CoreML, а сама модель настолько мала, что CPU быстрее.
 */

const MODEL_PATH = path.join(process.cwd(), "models", "c5_m_7_h_64_w_g.onnx");
/** Модель принимает 7 кадров одной камеры; дополнительные почти не влияют, повторяем сам кадр. */
const SLOTS = 7;
const N = HIST_BINS;

const g = globalThis as typeof globalThis & { __photoeditAwb?: Promise<ort.InferenceSession> };

function getSession(): Promise<ort.InferenceSession> {
  // Сессия одна на процесс и переживает горячую перезагрузку модуля.
  g.__photoeditAwb ??= ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["cpu"] });
  return g.__photoeditAwb;
}

/** Вход модели: для каждого слота — 2 гистограммы и 2 плоскости координат (u, v). */
function buildInput(histograms: Float32Array): Float32Array {
  const plane = N * N;
  const x = new Float32Array(SLOTS * 4 * plane);
  for (let k = 0; k < SLOTS; k++) {
    const base = k * 4 * plane;
    x.set(histograms, base);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        x[base + 2 * plane + r * N + c] = c / (N - 1);
        x[base + 3 * plane + r * N + c] = (N - 1 - r) / (N - 1);
      }
    }
  }
  return x;
}

/** Круговая свёртка гистограмм с F, ×G + B, softmax → цвет освещения в «сырых» цветах камеры. */
function postprocess(histograms: Float32Array, F: Float32Array, B: Float32Array, G: Float32Array) {
  const z = new Float64Array(N * N);
  for (let ch = 0; ch < 2; ch++) {
    const h = histograms.subarray(ch * N * N, (ch + 1) * N * N);
    const f = F.subarray(ch * N * N, (ch + 1) * N * N);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const a = h[i * N + j];
        if (a === 0) continue;
        for (let y = 0; y < N; y++) {
          const fr = ((y - i + N) % N) * N;
          for (let x = 0; x < N; x++) z[y * N + x] += a * f[fr + ((x - j + N) & (N - 1))];
        }
      }
    }
  }
  let max = -Infinity;
  for (let k = 0; k < N * N; k++) {
    z[k] = Math.min(100, Math.max(-100, G[k] * z[k] + B[k]));
    max = Math.max(max, z[k]);
  }
  let sum = 0;
  for (let k = 0; k < N * N; k++) sum += z[k] = Math.exp(z[k] - max);

  let u = 0;
  let v = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const p = z[r * N + c] / sum;
      u += p * (c - (N - 1) / 2);
      v += p * ((N - 1) / 2 - r);
    }
  }
  const scale = (2 * HIST_BOUND) / N;
  return [Math.exp(-u * scale), 1, Math.exp(-v * scale)];
}

/** histograms — 2×64×64 (кадр и его контуры) из awb-histogram. Возвращает освещение [r, 1, b] в цветах камеры. */
export async function estimateIlluminant(histograms: Float32Array): Promise<number[]> {
  const session = await getSession();
  const out = await session.run({
    histograms: new ort.Tensor("float32", buildInput(histograms), [1, SLOTS, 4, N, N]),
  });
  return postprocess(
    histograms,
    out.F.data as Float32Array,
    out.B.data as Float32Array,
    out.G.data as Float32Array,
  );
}
