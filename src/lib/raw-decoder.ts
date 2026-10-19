import LibRaw from "libraw-wasm";
import type { CameraColor } from "@/lib/awb-histogram";

export type LinearImage = {
  width: number;
  height: number;
  /** RGB, 16 бит на канал, линейный свет в основных цветах sRGB. */
  data: Uint16Array;
  /** Цветовые данные камеры из LibRaw (нужны нейросетевому автобалансу). */
  color?: CameraColor;
};

/**
 * Настройки LibRaw: только «научная» часть конвейера — баланс белого камеры,
 * демозаик, цветовая матрица в sRGB. Без автояркости: тон и экспозицию дальше
 * задаёт наш шейдер по настройкам пользователя.
 */
const SETTINGS = {
  // Вдвое меньше по каждой стороне: 24 Мп → 6 Мп, в 4 раза быстрее, для экрана хватает.
  halfSize: true,
  outputBps: 16,
  outputColor: 1,
  noAutoBright: true,
  useCameraWb: true,
};

/**
 * libraw-wasm игнорирует настройку gamm и всегда кодирует выход кривой BT.709
 * (степень 0.45, наклон 4.5 у нуля). Наш конвейер работает в линейном свете,
 * поэтому снимаем эту кривую. Проверено сравнением с rawpy (gamma = 1): совпадение 0.1%.
 */
const BT709_TO_LINEAR = (() => {
  const lut = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) {
    const y = i / 65535;
    const x = y < 0.081 ? y / 4.5 : Math.pow((y + 0.099) / 1.099, 1 / 0.45);
    lut[i] = Math.round(Math.min(1, x) * 65535);
  }
  return lut;
})();

function linearize(data: Uint16Array) {
  for (let i = 0; i < data.length; i++) data[i] = BT709_TO_LINEAR[data[i]];
}

let decoder: LibRaw | null = null;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Декодирует RAW по URL. Задачи идут строго по очереди; отменённые (signal)
 * пропускаются, поэтому быстрое листание кадров не копит лишние декодирования.
 */
export function decodeRaw(url: string, signal: AbortSignal): Promise<LinearImage> {
  const job = queue.then(async () => {
    signal.throwIfAborted();
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Failed to load RAW: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());

    signal.throwIfAborted();
    decoder ??= new LibRaw();
    await decoder.open(bytes, SETTINGS);
    const img = await decoder.imageData();
    if (!img || !(img.data instanceof Uint16Array) || img.colors !== 3) {
      throw new Error("LibRaw returned an unexpected image format");
    }
    // Полные метаданные: баланс камеры и матрица «камера → sRGB» (берём 3×3 из 3×4).
    const meta = await decoder.metadata(true);
    const cd = meta?.color_data;
    const color = cd && cd.cam_mul?.[1] ? { camMul: cd.cam_mul, rgbCam: cd.rgb_cam.map((row) => row.slice(0, 3)) } : undefined;
    linearize(img.data);
    return { width: img.width, height: img.height, data: img.data, color };
  });
  queue = job.catch(() => {});
  return job;
}

