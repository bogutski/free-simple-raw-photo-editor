import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { extractPreview } from "@/lib/raw-preview";

/** Кэш миниатюр для ленты. Можно удалять целиком, миниатюры пересоберутся. */
const THUMBS_DIR = path.join(process.cwd(), ".cache", "thumbs");
const THUMB_HEIGHT = 240;
/** Миниатюры обработанных кадров: их рисует браузер после каждой правки. */
const RENDERED_DIR = path.join(process.cwd(), ".cache", "rendered");
const renderedPath = (filePath: string) => path.join(RENDERED_DIR, `${path.basename(filePath)}.jpg`);

/** Время записи обработанной миниатюры, мс; null, если её ещё нет. */
export async function renderedThumbVersion(filePath: string): Promise<number | null> {
  const s = await stat(renderedPath(filePath)).catch(() => null);
  return s ? Math.round(s.mtimeMs) : null;
}

export async function saveRenderedThumb(filePath: string, jpeg: Buffer): Promise<void> {
  await mkdir(RENDERED_DIR, { recursive: true });
  // Через временный файл, чтобы лента никогда не получила недописанную картинку.
  const tmp = `${renderedPath(filePath)}.tmp`;
  await writeFile(tmp, jpeg);
  await rename(tmp, renderedPath(filePath));
}

/** Миниатюра для ленты: обработанная, если есть, иначе из встроенного превью камеры. */
export async function getThumb(filePath: string): Promise<Buffer | null> {
  const rendered = await readFile(renderedPath(filePath)).catch(() => null);
  if (rendered) return rendered;

  const { mtimeMs } = await stat(filePath);
  const cached = path.join(THUMBS_DIR, `${path.basename(filePath)}.${Math.round(mtimeMs)}.jpg`);

  const hit = await readFile(cached).catch(() => null);
  if (hit) return hit;

  const preview = await extractPreview(filePath);
  if (!preview) return null;

  // rotate() без аргументов поворачивает кадр по EXIF-ориентации.
  const thumb = await sharp(preview).rotate().resize({ height: THUMB_HEIGHT }).jpeg({ quality: 80 }).toBuffer();
  await mkdir(THUMBS_DIR, { recursive: true });
  await writeFile(cached, thumb);
  return thumb;
}
