import { connection } from "next/server";
import { resolveSource } from "@/lib/sources";
import { getThumb, saveRenderedThumb } from "@/lib/thumbs";

export async function GET(_req: Request, ctx: RouteContext<"/api/sources/[name]/thumb">) {
  await connection();
  const { name } = await ctx.params;
  const filePath = resolveSource(name);
  if (!filePath) return new Response("Not found", { status: 404 });

  const jpeg = await getThumb(filePath).catch(() => null);
  if (!jpeg) return new Response("No embedded preview", { status: 404 });

  return new Response(new Uint8Array(jpeg), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

/** Обработанная миниатюра от браузера: JPEG с учётом цвета и кадрирования. */
export async function PUT(req: Request, ctx: RouteContext<"/api/sources/[name]/thumb">) {
  await connection();
  const { name } = await ctx.params;
  const filePath = resolveSource(name);
  if (!filePath) return new Response("Not found", { status: 404 });

  const jpeg = Buffer.from(await req.arrayBuffer());
  // Простая проверка, что пришёл JPEG, а не что-то другое.
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return new Response("Expected JPEG", { status: 400 });
  await saveRenderedThumb(filePath, jpeg);
  return new Response(null, { status: 204 });
}
