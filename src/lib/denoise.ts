import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import * as ort from "onnxruntime-node";

/*
 * Нейросетевое шумоподавление SCUNet (обучена на реальном шуме камер, Apache-2.0).
 * Модель переэкспортирована под CoreML с фиксированным входом 512×512, поэтому кадр
 * обрабатывается тайлами с перекрытием, а швы сглаживаются линейными весами.
 * Вход и выход модели — sRGB (с гаммой) 0…1, планарный RGB.
 */

const MODEL_PATH = path.join(process.cwd(), "models", "scunet_real_psnr_coreml_512.onnx");
const CACHE_DIR = path.join(process.cwd(), ".cache", "denoise");
const TILE = 512;
const OVERLAP = 32;
/** MLProgram: формат CoreML, с которым модель работает на GPU Apple. */
const COREML_FLAGS = 0x010;

export type DenoiseProgress = { phase: "model" } | { phase: "tiles"; done: number; total: number };

type State = { session: Promise<ort.InferenceSession> | null; queue: Promise<unknown>; exitHook: boolean };
// Состояние живёт в globalThis, чтобы горячая перезагрузка модуля не создавала новую сессию:
// каждая — это компиляция CoreML на ~10 с и временные файлы в системной папке.
const g = globalThis as typeof globalThis & { __photoeditDenoise?: State };
const state = (g.__photoeditDenoise ??= { session: null, queue: Promise.resolve(), exitHook: false });

function getSession(): Promise<ort.InferenceSession> {
  if (!state.session) {
    state.session = ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: [{ name: "coreml", coreMlFlags: COREML_FLAGS }],
      graphOptimizationLevel: "all",
    });
    // Без release() CoreML оставляет во временной папке ~100 МБ на каждую сессию.
    if (!state.exitHook) {
      state.exitHook = true;
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, async () => {
          await (await state.session)?.release().catch(() => {});
          process.exit(0);
        });
      }
    }
  }
  return state.session;
}

const cachePath = (key: string) => path.join(CACHE_DIR, `${key}.u16`);

/** Готовый результат из кэша: линейный RGB, 16 бит, того же размера, что вход. */
export async function readDenoised(key: string): Promise<Buffer | null> {
  return readFile(cachePath(key)).catch(() => null);
}

/**
 * Ставит кадр в очередь на шумоподавление и сохраняет результат в кэш.
 * Кадры обрабатываются по одному: GPU всё равно один, а память не растёт.
 */
export function denoise(
  key: string,
  image: { width: number; height: number; data: Uint16Array },
  onProgress: (p: DenoiseProgress) => void,
): Promise<void> {
  const job = state.queue.then(async () => {
    if (await readDenoised(key)) return;
    onProgress({ phase: "model" });
    const session = await getSession();
    const out = await runTiles(session, image, (done, total) => onProgress({ phase: "tiles", done, total }));
    await mkdir(CACHE_DIR, { recursive: true });
    // Через временный файл, чтобы недописанный результат никогда не попал в кэш.
    const tmp = `${cachePath(key)}.tmp`;
    await writeFile(tmp, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
    await rename(tmp, cachePath(key));
  });
  state.queue = job.catch(() => {});
  return job;
}

const toSrgb = (x: number) => {
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};
const toLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));

/** Начала тайлов вдоль стороны: шаг TILE − OVERLAP, последний прижат к краю. */
function tileStarts(len: number): number[] {
  if (len <= TILE) return [0];
  const starts: number[] = [];
  for (let p = 0; ; p += TILE - OVERLAP) {
    if (p + TILE >= len) {
      starts.push(len - TILE);
      return starts;
    }
    starts.push(p);
  }
}

/** Вес пикселя в зоне перекрытия: линейно растёт от края тайла, если там есть сосед. */
function ramp(i: number, n: number, hasPrev: boolean, hasNext: boolean): number {
  let r = 1;
  if (hasPrev && i < OVERLAP) r = Math.min(r, (i + 0.5) / OVERLAP);
  if (hasNext && i >= n - OVERLAP) r = Math.min(r, (n - i - 0.5) / OVERLAP);
  return r;
}

async function runTiles(
  session: ort.InferenceSession,
  { width: W, height: H, data }: { width: number; height: number; data: Uint16Array },
  onTile: (done: number, total: number) => void,
): Promise<Uint16Array> {
  if (W < TILE || H < TILE) throw new Error(`Image is smaller than ${TILE}×${TILE}`);
  const P = W * H;

  // Линейный 16-битный RGB → sRGB 0…1, планарный (CHW), как ждёт модель. Таблица на 65536 значений.
  const lut = new Float32Array(65536);
  for (let v = 0; v < 65536; v++) lut[v] = toSrgb(v / 65535);
  const srgb = new Float32Array(3 * P);
  for (let i = 0; i < P; i++) for (let c = 0; c < 3; c++) srgb[c * P + i] = lut[data[i * 3 + c]];

  const ys = tileStarts(H);
  const xs = tileStarts(W);
  const total = ys.length * xs.length;
  const acc = new Float32Array(3 * P);
  const wsum = new Float32Array(P);
  const tile = new Float32Array(3 * TILE * TILE);
  const [inName] = session.inputNames;
  const [outName] = session.outputNames;

  let done = 0;
  onTile(done, total);
  for (const y0 of ys) {
    for (const x0 of xs) {
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < TILE; y++) {
          const from = c * P + (y0 + y) * W + x0;
          tile.set(srgb.subarray(from, from + TILE), (c * TILE + y) * TILE);
        }
      }
      const result = await session.run({ [inName]: new ort.Tensor("float32", tile, [1, 3, TILE, TILE]) });
      const o = result[outName].data as Float32Array;

      for (let y = 0; y < TILE; y++) {
        const wy = ramp(y, TILE, y0 > 0, y0 + TILE < H);
        for (let x = 0; x < TILE; x++) {
          const w = wy * ramp(x, TILE, x0 > 0, x0 + TILE < W);
          const idx = (y0 + y) * W + x0 + x;
          wsum[idx] += w;
          for (let c = 0; c < 3; c++) acc[c * P + idx] += w * o[(c * TILE + y) * TILE + x];
        }
      }
      onTile(++done, total);
    }
  }

  // Обратно в линейный 16-битный RGB с чередованием каналов.
  const out = new Uint16Array(3 * P);
  for (let i = 0; i < P; i++) {
    for (let c = 0; c < 3; c++) {
      const v = acc[c * P + i] / wsum[i];
      out[i * 3 + c] = Math.round(toLinear(v < 0 ? 0 : v > 1 ? 1 : v) * 65535);
    }
  }
  return out;
}
