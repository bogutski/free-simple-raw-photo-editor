import { connection } from "next/server";
import { extractPreview } from "@/lib/raw-preview";
import { resolveSource } from "@/lib/sources";

export async function GET(_req: Request, ctx: RouteContext<"/api/sources/[name]/preview">) {
  await connection();
  const { name } = await ctx.params;
  const filePath = resolveSource(name);
  if (!filePath) return new Response("Not found", { status: 404 });

  const jpeg = await extractPreview(filePath).catch(() => null);
  if (!jpeg) return new Response("No embedded preview", { status: 404 });

  return new Response(new Uint8Array(jpeg), {
    headers: {
      "Content-Type": "image/jpeg",
      // URL содержит mtime файла, поэтому превью можно кэшировать надолго.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
