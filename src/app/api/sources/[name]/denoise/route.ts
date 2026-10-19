import { stat } from "node:fs/promises";
import { connection } from "next/server";
import { denoise, readDenoised } from "@/lib/denoise";
import { resolveSource } from "@/lib/sources";

/**
 * Ключ кэша: файл, его версия и размер декодированного кадра (браузер присылает
 * кадр после LibRaw, и результат должен совпадать с ним пиксель в пиксель).
 */
async function cacheKey(req: Request, ctx: RouteContext<"/api/sources/[name]/denoise">) {
  const { name } = await ctx.params;
  const filePath = resolveSource(name);
  const info = filePath ? await stat(filePath).catch(() => null) : null;
  const url = new URL(req.url);
  const width = Number(url.searchParams.get("w"));
  const height = Number(url.searchParams.get("h"));
  if (!info || !(width > 0) || !(height > 0)) return null;
  // v2: вход — действительно линейный кадр (до этого libraw-wasm отдавал его с гаммой BT.709).
  return { key: `${name}.${Math.round(info.mtimeMs)}.${width}x${height}.v2`, width, height };
}

/** Готовый очищенный кадр (линейный RGB, 16 бит) или 204, если его ещё нет. */
export async function GET(req: Request, ctx: RouteContext<"/api/sources/[name]/denoise">) {
  await connection();
  const k = await cacheKey(req, ctx);
  if (!k) return new Response("Not found", { status: 404 });
  const data = await readDenoised(k.key);
  // «Ещё не обработан» — не ошибка, поэтому 204, а не 404.
  if (!data) return new Response(null, { status: 204 });
  return new Response(new Uint8Array(data), {
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
  });
}

/**
 * Запуск шумоподавления. Тело — декодированный кадр (линейный RGB, 16 бит).
 * Ответ — поток строк JSON с прогрессом: {"phase":"model"}, {"phase":"tiles","done":3,"total":35},
 * в конце {"phase":"done"} или {"phase":"error","message":"..."}.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/sources/[name]/denoise">) {
  await connection();
  const k = await cacheKey(req, ctx);
  if (!k) return new Response("Not found", { status: 404 });

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength !== k.width * k.height * 6) return new Response("Bad image size", { status: 400 });
  // Копия с выравниванием под Uint16Array.
  const data = new Uint16Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (msg: object) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(msg) + "\n"));
        } catch {
          // Клиент ушёл (переключил кадр) — обработка всё равно доведётся до кэша.
        }
      };
      denoise(k.key, { width: k.width, height: k.height, data }, send)
        .then(() => send({ phase: "done" }))
        .catch((e: unknown) => send({ phase: "error", message: e instanceof Error ? e.message : String(e) }))
        .finally(() => {
          try {
            controller.close();
          } catch {}
        });
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
