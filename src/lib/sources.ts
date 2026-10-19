import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Edits } from "@/lib/adjustments";
import { readEdits } from "@/lib/edits";
import { renderedThumbVersion } from "@/lib/thumbs";

/** Папка с исходниками: сюда вручную кладутся RAW-файлы. */
export const SOURCES_DIR = path.join(process.cwd(), "sources");

export const RAW_EXTENSIONS = new Set([
  ".raf", ".dng", ".nef", ".nrw", ".arw", ".sr2", ".srf",
  ".cr2", ".orf", ".pef", ".rw2", ".cr3",
]);

export type SourceFile = {
  name: string;
  size: number;
  /** Время изменения, мс. Входит в URL превью, чтобы сбрасывать кэш браузера. */
  mtime: number;
  /** Сохранённые настройки обработки; null, если файл ещё не обрабатывался. */
  edits: Edits | null;
  /** Версия обработанной миниатюры (входит в её URL); null, если в ленте превью камеры. */
  thumb: number | null;
};

export async function listSources(): Promise<SourceFile[]> {
  const entries = await readdir(SOURCES_DIR, { withFileTypes: true }).catch(() => []);
  const files = entries.filter(
    (e) => e.isFile() && RAW_EXTENSIONS.has(path.extname(e.name).toLowerCase()),
  );

  const result = await Promise.all(
    files.map(async (e) => {
      const filePath = path.join(SOURCES_DIR, e.name);
      const s = await stat(filePath);
      return {
        name: e.name,
        size: s.size,
        mtime: Math.round(s.mtimeMs),
        edits: await readEdits(filePath),
        thumb: await renderedThumbVersion(filePath),
      };
    }),
  );
  return result.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Путь к файлу из папки исходников; null, если имя пытается выйти за её пределы. */
export function resolveSource(name: string): string | null {
  if (name !== path.basename(name)) return null;
  if (!RAW_EXTENSIONS.has(path.extname(name).toLowerCase())) return null;
  return path.join(SOURCES_DIR, name);
}
