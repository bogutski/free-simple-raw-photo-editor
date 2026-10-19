import { awbHistograms, illuminantToSrgb, illuminantToTempTint } from "@/lib/awb-histogram";
import type { LinearImage } from "@/lib/raw-decoder";

/**
 * Нейросеть ошибается примерно на каждом четвёртом портрете (до ~8°), поэтому применяем
 * её поправку не целиком и ограничиваем — Auto должен улучшать, а не перекрашивать.
 */
const STRENGTH = 0.6;
const LIMIT = 30;

const clamp = (v: number) => Math.min(LIMIT, Math.max(-LIMIT, Math.round(v)));

/** Temp/Tint для Auto по нейросети C5; null, если цветовых данных камеры нет или сервер недоступен. */
export async function neuralWhiteBalance(image: LinearImage): Promise<{ temp: number; tint: number } | null> {
  if (!image.color) return null;
  try {
    const histograms = awbHistograms(image, image.color);
    const res = await fetch("/api/awb", { method: "POST", body: new Blob([histograms]) });
    if (!res.ok) return null;
    const { illuminant } = (await res.json()) as { illuminant: number[] };
    const { temp, tint } = illuminantToTempTint(illuminantToSrgb(illuminant, image.color));
    return { temp: clamp(temp * 100 * STRENGTH), tint: clamp(tint * 100 * STRENGTH) };
  } catch {
    return null;
  }
}
