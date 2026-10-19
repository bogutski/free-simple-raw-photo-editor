import { readFile, writeFile } from "node:fs/promises";
import { parseEdits, type Edits } from "@/lib/adjustments";

/**
 * Настройки обработки хранятся рядом с исходником в `<файл>.json`,
 * как .xmp у Lightroom. Сам RAW никогда не изменяется.
 */
const sidecarPath = (sourcePath: string) => `${sourcePath}.json`;

export async function readEdits(sourcePath: string): Promise<Edits | null> {
  const text = await readFile(sidecarPath(sourcePath), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return parseEdits(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function writeEdits(sourcePath: string, edits: Edits): Promise<void> {
  await writeFile(sidecarPath(sourcePath), JSON.stringify(edits, null, 2) + "\n");
}
