"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CropOverlay } from "@/components/crop-overlay";
import { ZoomPan } from "@/components/zoom-pan";
import type { Edits } from "@/lib/adjustments";
import { defaultCrop, normalizedRatio, type Crop } from "@/lib/crop";
import { fetchDenoised, type DenoiseStatus } from "@/lib/denoise-client";
import { decodeRaw, type LinearImage } from "@/lib/raw-decoder";
import { Renderer } from "@/lib/renderer";

export type ViewMode = "color" | "crop";

type Props = {
  /** Встроенное превью камеры: показывается сразу, пока декодируется RAW. */
  previewSrc: string;
  rawSrc: string;
  /** Адрес API нейросетевого шумоподавления для этого снимка. */
  denoiseUrl: string;
  edits: Edits;
  /** «color» — готовый кадр с кадрированием, «crop» — весь кадр с рамкой. */
  mode: ViewMode;
  onCropChange: (crop: Crop) => void;
  /** Сообщает соотношение сторон изображения (ширина / высота). */
  onImageAspect: (aspect: number) => void;
  /** Отдаёт декодированный кадр наверх, например для автонастройки. */
  onDecoded: (rawSrc: string, image: LinearImage) => void;
  onDenoiseStatus: (rawSrc: string, status: DenoiseStatus) => void;
  /** Миниатюра обработанного кадра (JPEG) для ленты, после каждой правки. */
  onThumbnail: (rawSrc: string, jpeg: Blob) => void;
};

/** Высота миниатюры для ленты, как у миниатюр из превью камеры. */
const THUMB_HEIGHT = 240;
/** Миниатюру обновляем, когда правки ненадолго затихли, а не на каждый шаг ползунка. */
const THUMB_DELAY = 400;

export function PhotoView({
  previewSrc,
  rawSrc,
  denoiseUrl,
  edits,
  mode,
  onCropChange,
  onImageAspect,
  onDecoded,
  onDenoiseStatus,
  onThumbnail,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  // URL исходника, который сейчас загружен в рендерер.
  const [decoded, setDecoded] = useState<string | null>(null);
  const [error, setError] = useState<{ src: string; message: string } | null>(null);
  const [imageAspect, setImageAspect] = useState<number | null>(null);

  useEffect(() => {
    if (imageAspect) onImageAspect(imageAspect);
  }, [imageAspect, onImageAspect]);

  // Декодированный кадр (вход для нейросети) и исходник, для которого загружен очищенный кадр.
  const imageRef = useRef<LinearImage | null>(null);
  const [denoisedFor, setDenoisedFor] = useState<string | null>(null);

  // Последние обработчики в ref, чтобы их смена не перезапускала декодирование и шумоподавление.
  const onDecodedRef = useRef(onDecoded);
  const onDenoiseStatusRef = useRef(onDenoiseStatus);
  const onThumbnailRef = useRef(onThumbnail);
  useEffect(() => {
    onDecodedRef.current = onDecoded;
    onDenoiseStatusRef.current = onDenoiseStatus;
    onThumbnailRef.current = onThumbnail;
  }, [onDecoded, onDenoiseStatus, onThumbnail]);

  useEffect(() => {
    const controller = new AbortController();
    // Небольшая пауза, чтобы не начинать декодирование каждого кадра при быстром листании.
    const timer = setTimeout(() => {
      decodeRaw(rawSrc, controller.signal)
        .then((image) => {
          rendererRef.current ??= new Renderer(canvasRef.current!);
          rendererRef.current.setImage(image);
          imageRef.current = image;
          // setImage сбрасывает очищенный кадр в рендерере.
          setDenoisedFor(null);
          setDecoded(rawSrc);
          setImageAspect(image.width / image.height);
          onDecodedRef.current(rawSrc, image);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setError({ src: rawSrc, message: String(e) });
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [rawSrc]);

  const ready = decoded === rawSrc;
  const crop = edits.crop;
  // В режиме кадрирования показываем весь кадр, рамка рисуется поверх.
  const shownCrop = mode === "color" && crop ? crop : null;

  // Нейросеть запускается только когда ползунок шумоподавления больше нуля.
  const wantsDenoise = ready && edits.denoise > 0 && denoisedFor !== rawSrc;
  useEffect(() => {
    if (!wantsDenoise || !imageRef.current) return;
    const controller = new AbortController();
    const report = (s: DenoiseStatus) => onDenoiseStatusRef.current(rawSrc, s);
    fetchDenoised(denoiseUrl, imageRef.current, controller.signal, report)
      .then((image) => {
        rendererRef.current?.setDenoised(image);
        setDenoisedFor(rawSrc);
        report({ state: "done" });
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) report({ state: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [wantsDenoise, rawSrc, denoiseUrl]);

  useEffect(() => {
    if (ready) rendererRef.current?.render(edits, shownCrop, crop?.angle ?? 0);
  }, [ready, edits, shownCrop, crop?.angle, denoisedFor]);

  // Миниатюра для ленты — всегда кадрированная, даже когда на экране режим кадрирования.
  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!ready || !renderer || !canvas) return;
    const timer = setTimeout(() => {
      const angle = crop?.angle ?? 0;
      renderer.render(edits, crop, angle);
      // Буфер WebGL читается только до конца текущей задачи, поэтому копируем сразу после рисования.
      const thumb = document.createElement("canvas");
      thumb.height = THUMB_HEIGHT;
      thumb.width = Math.max(1, Math.round((canvas.width / canvas.height) * THUMB_HEIGHT));
      const ctx = thumb.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
      // Возвращаем на экран то, что там было.
      if (crop !== shownCrop) renderer.render(edits, shownCrop, angle);
      thumb.toBlob((jpeg) => jpeg && onThumbnailRef.current(rawSrc, jpeg), "image/jpeg", 0.85);
    }, THUMB_DELAY);
    return () => clearTimeout(timer);
  }, [ready, rawSrc, edits, crop, shownCrop, denoisedFor]);

  const failed = error?.src === rawSrc ? error.message : null;
  const shownAspect = imageAspect && (shownCrop ? (imageAspect * shownCrop.w) / shownCrop.h : imageAspect);

  return (
    <>
      <ZoomPan aspect={shownAspect}>
        {!ready && (
          // eslint-disable-next-line @next/next/no-img-element -- превью отдаёт свой API, оптимизатор не нужен
          <img
            src={previewSrc}
            alt=""
            draggable={false}
            onLoad={(e) => setImageAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
            className="absolute inset-0 h-full w-full object-contain p-4"
            style={
              shownCrop
                ? {
                    // Кадрирование превью до готовности RAW (там, где браузер это умеет).
                    objectViewBox: `inset(${shownCrop.y * 100}% ${(1 - shownCrop.x - shownCrop.w) * 100}% ${
                      (1 - shownCrop.y - shownCrop.h) * 100
                    }% ${shownCrop.x * 100}%)`,
                  } as CSSProperties
                : undefined
            }
          />
        )}
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 h-full w-full object-contain p-4 ${ready ? "" : "invisible"}`}
        />
        {mode === "crop" && imageAspect && (
          <CropOverlay
            crop={crop ?? defaultCrop(imageAspect)}
            ratio={crop ? normalizedRatio(crop, imageAspect) : null}
            imageAspect={imageAspect}
            onChange={onCropChange}
          />
        )}
      </ZoomPan>
      {!ready && (
        <div className="absolute bottom-2 left-3 text-xs text-neutral-500">
          {failed ? `Failed to decode RAW: ${failed}` : "Decoding RAW…"}
        </div>
      )}
    </>
  );
}
