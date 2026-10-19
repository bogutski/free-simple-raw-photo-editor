import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { connection } from "next/server";
import { resolveSource } from "@/lib/sources";

/** Отдаёт исходный RAW-файл браузеру для декодирования через LibRaw. */
export async function GET(_req: Request, ctx: RouteContext<"/api/sources/[name]/raw">) {
  await connection();
  const { name } = await ctx.params;
  const filePath = resolveSource(name);
  const info = filePath ? await stat(filePath).catch(() => null) : null;
  if (!filePath || !info) return new Response("Not found", { status: 404 });

  return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(info.size),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
