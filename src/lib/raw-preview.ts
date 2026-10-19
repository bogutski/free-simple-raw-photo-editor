import { open, type FileHandle } from "node:fs/promises";

/**
 * Достаёт из RAW встроенный JPEG, который камера кладёт в файл для просмотра.
 * Так же делают Lightroom и LibRaw (unpack_thumb) для быстрого показа: сенсорные
 * данные не декодируются. Полноценная обработка RAW через LibRaw появится на шаге редактирования.
 *
 * Поддержка: RAF (Fujifilm) и TIFF-подобные форматы (DNG, NEF, ARW, CR2, ORF, PEF, RW2).
 * CR3 (контейнер ISOBMFF) не поддерживается.
 */
export async function extractPreview(filePath: string): Promise<Buffer | null> {
  const fh = await open(filePath, "r");
  try {
    const head = await readAt(fh, 0, 16);
    const found =
      head.toString("latin1") === "FUJIFILMCCD-RAW "
        ? await findRafPreview(fh)
        : await findTiffPreview(fh);
    if (!found) return null;

    const jpeg = await readAt(fh, found.offset, found.length);
    return withOrientation(jpeg, found.orientation);
  } finally {
    await fh.close();
  }
}

type Found = { offset: number; length: number; orientation: number };

async function readAt(fh: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

// --- RAF ---------------------------------------------------------------------

async function findRafPreview(fh: FileHandle): Promise<Found | null> {
  // Заголовок RAF: по смещению 84 лежат offset и length встроенного JPEG (big-endian).
  const h = await readAt(fh, 84, 8);
  const offset = h.readUInt32BE(0);
  const length = h.readUInt32BE(4);
  if (!(await isBrowserJpeg(fh, offset, length))) return null;
  // Во встроенном JPEG у Fujifilm свой EXIF с ориентацией, браузер применит его сам.
  return { offset, length, orientation: 1 };
}

// --- TIFF-подобные форматы ---------------------------------------------------

const TAG = {
  orientation: 0x0112,
  compression: 0x0103,
  stripOffsets: 0x0111,
  stripByteCounts: 0x0117,
  jpegOffset: 0x0201,
  jpegLength: 0x0202,
  subIfds: 0x014a,
  exifIfd: 0x8769,
  rw2JpgFromRaw: 0x002e,
};

async function findTiffPreview(fh: FileHandle): Promise<Found | null> {
  const header = await readAt(fh, 0, 8);
  if (header.length < 8) return null;
  const order = header.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = (b: Buffer, o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b: Buffer, o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));

  const candidates: { offset: number; length: number }[] = [];
  let orientation = 1;
  const visited = new Set<number>();

  // Обходим цепочку IFD, SubIFD и EXIF IFD, собирая все места, где может лежать JPEG.
  const walk = async (ifdOffset: number, isIfd0: boolean): Promise<void> => {
    if (!ifdOffset || visited.has(ifdOffset) || visited.size > 64) return;
    visited.add(ifdOffset);

    const countBuf = await readAt(fh, ifdOffset, 2);
    if (countBuf.length < 2) return;
    const count = u16(countBuf, 0);
    const ifd = await readAt(fh, ifdOffset + 2, count * 12 + 4);
    if (ifd.length < count * 12 + 4) return;

    const tags = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const e = i * 12;
      const tag = u16(ifd, e);
      const type = u16(ifd, e + 2);
      const n = u32(ifd, e + 4);
      const size = type === 3 ? 2 : type === 4 || type === 13 ? 4 : 0;

      // Длина встроенного RW2 JPEG хранится в поле count, данные лежат по смещению.
      if (tag === TAG.rw2JpgFromRaw) {
        candidates.push({ offset: u32(ifd, e + 8), length: n });
        continue;
      }
      if (!size || n === 0 || n > 1024) continue;

      const bytes = size * n;
      const data = bytes <= 4 ? ifd.subarray(e + 8, e + 12) : await readAt(fh, u32(ifd, e + 8), bytes);
      const values: number[] = [];
      for (let k = 0; k < n && (k + 1) * size <= data.length; k++) {
        values.push(size === 2 ? u16(data, k * size) : u32(data, k * size));
      }
      tags.set(tag, values);
    }

    if (isIfd0) orientation = tags.get(TAG.orientation)?.[0] ?? 1;

    const jOff = tags.get(TAG.jpegOffset)?.[0];
    const jLen = tags.get(TAG.jpegLength)?.[0];
    if (jOff && jLen) candidates.push({ offset: jOff, length: jLen });

    // Превью, записанное как единственная JPEG-полоса (CR2, DNG).
    const compression = tags.get(TAG.compression)?.[0];
    const strips = tags.get(TAG.stripOffsets);
    const stripLens = tags.get(TAG.stripByteCounts);
    if ((compression === 6 || compression === 7) && strips?.length === 1 && stripLens?.length === 1) {
      candidates.push({ offset: strips[0], length: stripLens[0] });
    }

    for (const sub of tags.get(TAG.subIfds) ?? []) await walk(sub, false);
    const exif = tags.get(TAG.exifIfd)?.[0];
    if (exif) await walk(exif, false);
    await walk(u32(ifd, count * 12), false);
  };

  await walk(u32(header, 4), true);

  // Берём самый крупный JPEG, который умеет показать браузер.
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    if (await isBrowserJpeg(fh, c.offset, c.length)) return { ...c, orientation };
  }
  return null;
}

// --- JPEG --------------------------------------------------------------------

/** JPEG с baseline/progressive-кодированием. Lossless JPEG (SOF3) браузеры не декодируют. */
async function isBrowserJpeg(fh: FileHandle, offset: number, length: number): Promise<boolean> {
  if (!offset || length < 1024) return false;
  const b = await readAt(fh, offset, Math.min(length, 256 * 1024));
  if (b[0] !== 0xff || b[1] !== 0xd8) return false;

  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return false;
    const marker = b[p + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) return true;
    if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return false;
    }
    p += 2 + b.readUInt16BE(p + 2);
  }
  return false;
}

/**
 * Встроенный JPEG часто без EXIF, а ориентация записана только в самом RAW.
 * Добавляем минимальный EXIF-блок с ориентацией, и браузер повернёт кадр сам.
 */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  if (orientation <= 1 || orientation > 8) return jpeg;
  const hasExif = jpeg[2] === 0xff && jpeg[3] === 0xe1 && jpeg.toString("latin1", 6, 10) === "Exif";
  if (hasExif) return jpeg;

  const app1 = Buffer.alloc(36);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(34, 2); // длина сегмента без маркера
  app1.write("Exif\0\0", 4, "latin1");
  app1.write("MM", 10, "latin1");
  app1.writeUInt16BE(42, 12);
  app1.writeUInt32BE(8, 14); // смещение IFD0 от начала TIFF-заголовка
  app1.writeUInt16BE(1, 18); // одна запись
  app1.writeUInt16BE(TAG.orientation, 20);
  app1.writeUInt16BE(3, 22); // SHORT
  app1.writeUInt32BE(1, 24);
  app1.writeUInt16BE(orientation, 28);
  app1.writeUInt32BE(0, 32); // следующего IFD нет

  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}
