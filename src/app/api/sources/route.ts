import { connection } from "next/server";
import { listSources } from "@/lib/sources";

export async function GET() {
  await connection();
  return Response.json(await listSources());
}
