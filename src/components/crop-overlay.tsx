"use client";

import { useRef, useState, type PointerEvent } from "react";
import {
  fitInside,
  moveRect,
  rectInside,
  resizeRect,
  rotateCrop,
  type Crop,
  type CropRect,
  type Handle,
} from "@/lib/crop";

const HANDLES: { id: Handle; className: string; cursor: string }[] = [
  { id: "nw", className: "left-0 top-0", cursor: "nwse-resize" },
  { id: "n", className: "left-1/2 top-0", cursor: "ns-resize" },
  { id: "ne", className: "left-full top-0", cursor: "nesw-resize" },
  { id: "e", className: "left-full top-1/2", cursor: "ew-resize" },
  { id: "se", className: "left-full top-full", cursor: "nwse-resize" },
  { id: "s", className: "left-1/2 top-full", cursor: "ns-resize" },
  { id: "sw", className: "left-0 top-full", cursor: "nesw-resize" },
  { id: "w", className: "left-0 top-1/2", cursor: "ew-resize" },
];

/** Зоны поворота снаружи углов рамки, как в Lightroom. */
const ROTATE_ZONES = [
  "left-0 top-0 -translate-x-full -translate-y-full",
  "left-full top-0 -translate-y-full",
  "left-full top-full",
  "left-0 top-full -translate-x-full",
];

// Курсор-дуга с двумя стрелками: в CSS нет стандартного курсора поворота.
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<g stroke="black" stroke-width="4"><path d="M5 9a8 8 0 0 1 14 0"/><path d="M19 4v5h-5"/><path d="M5 4v5h5"/></g>' +
    '<g stroke="white" stroke-width="2"><path d="M5 9a8 8 0 0 1 14 0"/><path d="M19 4v5h-5"/><path d="M5 4v5h5"/></g></svg>',
)}") 12 12, crosshair`;

type Props = {
  crop: Crop;
  /** Пропорция рамки в долях изображения или null, если свободная. */
  ratio: number | null;
  /** Ширина / высота изображения в пикселях: по ней рамка накладывается на вписанный кадр. */
  imageAspect: number;
  onChange: (crop: Crop) => void;
};

type Drag = { mode: Handle | "move" | "rotate"; x: number; y: number; crop: Crop; box: DOMRect; startAngle: number };

/**
 * Рамка кадрирования поверх изображения: тянуть за рамку — двигать, за ручки — менять размер,
 * снаружи углов — поворачивать фото под рамкой. Рамка никогда не выходит за повёрнутое фото.
 */
export function CropOverlay({ crop, ratio, imageAspect, onChange }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [rotating, setRotating] = useState(false);

  /** Угол направления от центра рамки на точку экрана, в градусах. */
  const angleFromCenter = (box: DOMRect, rect: CropRect, x: number, y: number) =>
    (Math.atan2(
      y - (box.top + (rect.y + rect.h / 2) * box.height),
      x - (box.left + (rect.x + rect.w / 2) * box.width),
    ) * 180) / Math.PI;

  const start = (mode: Drag["mode"], e: PointerEvent) => {
    // Не отдаём событие масштабу: иначе вместе с рамкой поедет и кадр.
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const box = boxRef.current!.getBoundingClientRect();
    drag.current = { mode, x: e.clientX, y: e.clientY, crop, box, startAngle: angleFromCenter(box, crop, e.clientX, e.clientY) };
    if (mode === "rotate") setRotating(true);
  };

  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "rotate") {
      let delta = angleFromCenter(d.box, d.crop, e.clientX, e.clientY) - d.startAngle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      onChange(rotateCrop(d.crop, d.crop, Math.round((d.crop.angle + delta) * 10) / 10, imageAspect));
      return;
    }
    // Размер box уже учитывает масштаб, так что сдвиг переводится в доли кадра напрямую.
    const dx = (e.clientX - d.x) / d.box.width;
    const dy = (e.clientY - d.y) / d.box.height;
    if (d.mode === "move") {
      const rect = moveRect(d.crop, dx, dy);
      // За край повёрнутого фото рамку не пускаем.
      if (rectInside(rect, d.crop.angle, imageAspect)) onChange({ ...crop, ...rect });
    } else {
      const rect = resizeRect(d.crop, d.mode, dx, dy, ratio);
      onChange({ ...crop, ...fitInside(rect, d.crop.angle, imageAspect) });
    }
  };

  const end = () => {
    drag.current = null;
    setRotating(false);
  };

  const pointer = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };
  const rectStyle = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.w * 100}%`,
    height: `${crop.h * 100}%`,
  };
  // При повороте — частая сетка, чтобы выравнивать горизонт; иначе — трети.
  const lines = rotating ? [1, 2, 3, 4, 5, 6, 7].map((i) => i / 8) : [1 / 3, 2 / 3];

  return (
    // Та же геометрия, что у изображения с object-contain и p-4.
    <div className="absolute inset-0 flex items-center justify-center p-4" style={{ containerType: "size" }}>
      <div
        ref={boxRef}
        className="relative"
        style={{ width: `min(100cqw, ${imageAspect} * 100cqh)`, aspectRatio: imageAspect }}
      >
        <div
          className="absolute cursor-move border border-white/80"
          // Затемнение всего, что за рамкой.
          style={{ ...rectStyle, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.6)" }}
          onPointerDown={(e) => start("move", e)}
          {...pointer}
        >
          <div className="pointer-events-none absolute inset-0">
            {lines.map((f) => (
              <div key={`v${f}`} className="absolute inset-y-0 border-l border-white/30" style={{ left: `${f * 100}%` }} />
            ))}
            {lines.map((f) => (
              <div key={`h${f}`} className="absolute inset-x-0 border-t border-white/30" style={{ top: `${f * 100}%` }} />
            ))}
          </div>
        </div>
        <div className="pointer-events-none absolute" style={rectStyle}>
          {ROTATE_ZONES.map((className) => (
            <div
              key={className}
              className={`pointer-events-auto absolute h-7 w-7 ${className}`}
              style={{ cursor: ROTATE_CURSOR }}
              onPointerDown={(e) => start("rotate", e)}
              {...pointer}
            />
          ))}
          {HANDLES.map((h) => (
            <div
              key={h.id}
              className={`pointer-events-auto absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 border border-neutral-900 bg-white ${h.className}`}
              style={{ cursor: h.cursor }}
              onPointerDown={(e) => start(h.id, e)}
              {...pointer}
            />
          ))}
        </div>
        {rotating && (
          <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded bg-black/70 px-2 py-0.5 text-xs text-white tabular-nums">
            {crop.angle.toFixed(1)}°
          </div>
        )}
      </div>
    </div>
  );
}
