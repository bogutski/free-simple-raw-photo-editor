import { connection } from "next/server";
import { parseEdits } from "@/lib/adjustments";
import { writeEdits } from "@/lib/edits";
import { resolveSource } from "@/lib/sources";

export async function PUT(req: Request, ctx: RouteContext<"/api/sources/[name]/edits">) {
  await connection();
  const { name } = await ctx.params;
  const filePath = resolveSource(name);
  if (!filePath) return new Response("Not found", { status: 404 });

  const edits = parseEdits(await req.json().catch(() => null));
  await writeEdits(filePath, edits);
  return Response.json(edits);
}
