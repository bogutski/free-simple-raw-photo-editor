"use client";

import { useRef } from "react";
import {
  ASPECTS,
  MAX_ANGLE,
  aspectLabel,
  defaultCrop,
  fitInside,
  fitRatio,
  normalizedRatio,
  rotateCrop,
  type AspectId,
  type Crop,
  type CropRect,
  type Orientation,
} from "@/lib/crop";

type Props = {
  crop: Crop | null;
  /** Ширина / высота изображения в пикселях; null, пока кадр не загружен. */
  imageAspect: number | null;
  onChange: (crop: Crop | null) => void;
};

export function CropPanel({ crop, imageAspect, onChange }: Props) {
  const current = crop ?? defaultCrop(imageAspect);
  // Рамка в момент, когда начали двигать ползунок угла: от неё и считаем уменьшение.
  const rotateBase = useRef<CropRect | null>(null);

  const apply = (aspect: AspectId, orientation: Orientation) => {
    if (!imageAspect) return;
    const next = { ...current, aspect, orientation };
    const rect = fitRatio(current, normalizedRatio(next, imageAspect));
    onChange({ ...next, ...fitInside(rect, current.angle, imageAspect) });
  };

  const rotate = (angle: number) => {
    if (!imageAspect) return;
    onChange(rotateCrop(current, rotateBase.current ?? current, angle, imageAspect));
  };

  const selectedRatio = ASPECTS.find((a) => a.id === current.aspect)!.ratio;
  const canFlip = typeof selectedRatio === "number" && selectedRatio !== 1;

  const button = (active: boolean) =>
    `rounded px-2 py-1 text-[11px] ${active ? "bg-neutral-200 text-neutral-900" : "bg-neutral-800 hover:bg-neutral-700"}`;

  return (
    <div className="space-y-3 px-2.5 py-3 text-[11px]">
      <div>
        <div className="mb-1.5 text-neutral-500">Aspect ratio</div>
        <div className="grid grid-cols-3 gap-1">
          {ASPECTS.map((a) => (
            <button
              key={a.id}
              className={button(current.aspect === a.id)}
              onClick={() => apply(a.id, current.orientation)}
            >
              {aspectLabel(a.id, current.orientation)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1">
        {(["landscape", "portrait"] as const).map((o) => (
          <button
            key={o}
            disabled={!canFlip}
            className={`${button(canFlip && current.orientation === o)} disabled:opacity-40`}
            onClick={() => apply(current.aspect, o)}
          >
            {o === "landscape" ? "Landscape" : "Portrait"}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-1.5">
        <span className="w-10 shrink-0">Angle</span>
        <input
          type="range"
          min={-MAX_ANGLE}
          max={MAX_ANGLE}
          step={0.1}
          value={current.angle}
          disabled={!imageAspect}
          onPointerDown={() => (rotateBase.current = current)}
          onPointerUp={() => (rotateBase.current = null)}
          onChange={(e) => rotate(Number(e.target.value))}
          // Двойной клик возвращает горизонт.
          onDoubleClick={() => rotate(0)}
          className="slider min-w-0 flex-1"
        />
        <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-neutral-500">
          {current.angle.toFixed(1)}°
        </span>
      </label>
      <div className="text-[10px] text-neutral-500">Drag just outside a corner of the frame to rotate.</div>

      <button className={`${button(false)} w-full`} disabled={!crop} onClick={() => onChange(null)}>
        Reset crop
      </button>
    </div>
  );
}
