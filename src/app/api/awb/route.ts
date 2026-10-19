import { connection } from "next/server";
import { HIST_BINS } from "@/lib/awb-histogram";
import { estimateIlluminant } from "@/lib/awb-model";

/** Тело — гистограммы кадра (float32, 2×64×64), ответ — цвет освещения в «сырых» цветах камеры. */
export async function POST(req: Request) {
  await connection();
  const body = await req.arrayBuffer();
  if (body.byteLength !== 2 * HIST_BINS * HIST_BINS * 4) return new Response("Bad histogram size", { status: 400 });
  const illuminant = await estimateIlluminant(new Float32Array(body));
  return Response.json({ illuminant });
}
