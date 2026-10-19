import type { LinearImage } from "@/lib/raw-decoder";

export type DenoiseStatus =
  | { state: "model" }
  | { state: "running"; done: number; total: number }
  | { state: "done" }
  | { state: "error"; message: string };

/**
 * Возвращает очищенный нейросетью кадр. Если его нет в кэше сервера — отправляет
 * декодированный кадр на обработку и сообщает прогресс через onStatus.
 */
export async function fetchDenoised(
  baseUrl: string,
  image: LinearImage,
  signal: AbortSignal,
  onStatus: (s: DenoiseStatus) => void,
): Promise<LinearImage> {
  const url = `${baseUrl}?w=${image.width}&h=${image.height}`;
  const load = async () => {
    const res = await fetch(url, { signal });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`Denoise request failed: ${res.status}`);
    return { width: image.width, height: image.height, data: new Uint16Array(await res.arrayBuffer()) };
  };

  const cached = await load();
  if (cached) return cached;

  const res = await fetch(url, {
    method: "POST",
    body: new Blob([image.data as Uint16Array<ArrayBuffer>]),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Denoise request failed: ${res.status}`);

  // Читаем поток строк JSON с прогрессом.
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const msg = JSON.parse(line);
      if (msg.phase === "model") onStatus({ state: "model" });
      else if (msg.phase === "tiles") onStatus({ state: "running", done: msg.done, total: msg.total });
      else if (msg.phase === "error") throw new Error(msg.message);
    }
  }

  const result = await load();
  if (!result) throw new Error("Denoised image is missing after processing");
  return result;
}
