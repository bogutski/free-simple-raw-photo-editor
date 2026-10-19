"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Шаги масштаба относительно режима «по размеру окна». */
const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
/** Поле вокруг кадра в режиме «по размеру окна», как p-4 у изображения. */
const PADDING = 16;

type Point = { x: number; y: number };

/**
 * Масштаб и перемещение кадра: ⌘+ / ⌘− и колесо мыши меняют масштаб, ⌘0 — по размеру окна,
 * в приближении кадр перетаскивается мышью. Дети растягиваются на всю область
 * и вписывают изображение сами (object-contain).
 */
export function ZoomPan({ aspect, children }: { aspect: number | null; children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const drag = useRef<{ pointer: Point; pan: Point } | null>(null);

  useEffect(() => {
    const el = containerRef.current!;
    const observer = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Насколько кадр может сдвинуться, не открывая пустоту по краям.
  const limit = (z: number): Point => {
    if (!aspect) return { x: 0, y: 0 };
    const availW = view.w - PADDING * 2;
    const availH = view.h - PADDING * 2;
    const fitW = Math.min(availW, availH * aspect);
    const fitH = fitW / aspect;
    // В приближении кадр может занимать и поля, вплоть до краёв окна.
    return {
      x: Math.max(0, (fitW * z - view.w) / 2),
      y: Math.max(0, (fitH * z - view.h) / 2),
    };
  };
  const clampPan = (p: Point, z: number): Point => {
    const l = limit(z);
    return { x: Math.min(l.x, Math.max(-l.x, p.x)), y: Math.min(l.y, Math.max(-l.y, p.y)) };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      let next: number;
      if (e.key === "=" || e.key === "+") next = ZOOM_STEPS.find((s) => s > zoom) ?? zoom;
      else if (e.key === "-") next = ZOOM_STEPS.findLast((s) => s < zoom) ?? zoom;
      else if (e.key === "0") next = 1;
      else return;
      // Перехватываем, чтобы браузер не масштабировал всю страницу.
      e.preventDefault();
      // Масштабируем относительно центра окна: сдвиг растёт вместе с масштабом.
      setPan((p) => ({ x: (p.x * next) / zoom, y: (p.y * next) / zoom }));
      setZoom(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  const shown = clampPan(pan, zoom);
  const zoomed = zoom > 1;

  // Колесо мыши (и щипок на трекпаде) плавно меняет масштаб относительно точки под курсором.
  useEffect(() => {
    const el = containerRef.current!;
    const onWheel = (e: WheelEvent) => {
      // Без passive: false браузер не даст отменить прокрутку и масштаб страницы.
      e.preventDefault();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      // Щипок приходит маленькими шагами с ctrlKey, ему нужна большая чувствительность.
      const next = Math.min(MAX_ZOOM, Math.max(1, zoom * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.002))));
      if (next === zoom) return;

      // Точка под курсором остаётся на месте.
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const k = next / zoom;
      setPan(clampPan({ x: cx - (cx - shown.x) * k, y: cy - (cy - shown.y) * k }, next));
      setZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 overflow-hidden ${zoomed ? "cursor-grab active:cursor-grabbing" : ""}`}
      onPointerDown={(e) => {
        if (!zoomed) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { pointer: { x: e.clientX, y: e.clientY }, pan: shown };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setPan(clampPan({ x: d.pan.x + e.clientX - d.pointer.x, y: d.pan.y + e.clientY - d.pointer.y }, zoom));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <div
        className="absolute inset-0"
        style={{ transform: `translate(${shown.x}px, ${shown.y}px) scale(${zoom})` }}
      >
        {children}
      </div>
      {zoomed && (
        <div className="pointer-events-none absolute top-2 left-3 text-xs text-neutral-500 tabular-nums">
          {Math.round(zoom * 100)}%
        </div>
      )}
    </div>
  );
}
