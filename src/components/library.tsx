"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { AdjustmentsPanel } from "@/components/adjustments-panel";
import { CropPanel } from "@/components/crop-panel";
import { PhotoView, type ViewMode } from "@/components/photo-view";
import { DEFAULT_EDITS, SLIDERS, type Adjustments, type Edits } from "@/lib/adjustments";
import { computeAuto } from "@/lib/auto";
import { neuralWhiteBalance } from "@/lib/auto-wb";
import type { DenoiseStatus } from "@/lib/denoise-client";
import type { LinearImage } from "@/lib/raw-decoder";
import type { SourceFile } from "@/lib/sources";

function previewUrl(file: SourceFile, kind: "preview" | "thumb" | "raw") {
  // У обработанной миниатюры своя версия: она меняется после каждой правки.
  const v = kind === "thumb" && file.thumb ? `${file.mtime}-${file.thumb}` : file.mtime;
  return `/api/sources/${encodeURIComponent(file.name)}/${kind}?v=${v}`;
}

/** Баланс белого — нейросетью (если доступна), остальное — по статистике кадра. */
async function autoAdjustments(image: LinearImage) {
  const wb = await neuralWhiteBalance(image);
  return computeAuto(image, wb ?? undefined);
}

export function Library() {
  const [files, setFiles] = useState<SourceFile[]>([]);
  // Текущий снимок (показан в окне) и выделенные в ленте; текущий всегда входит в выделение.
  const [selected, setSelected] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // Правки по каждому файлу. Источник истины — sidecar-файлы на диске, здесь их копия.
  const [edits, setEdits] = useState<Record<string, Edits>>({});
  // Вкладка правой панели; от неё зависит и вид кадра (кадрированный или с рамкой).
  const [tab, setTab] = useState<ViewMode>("color");
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  // Скопированные настройки цвета (без кропа) и короткое уведомление о копировании/вставке.
  const [clipboard, setClipboard] = useState<Adjustments | null>(null);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  // Последний декодированный кадр: по нему считается Auto.
  const [decoded, setDecoded] = useState<{ rawSrc: string; image: LinearImage } | null>(null);
  const onDecoded = useCallback((rawSrc: string, image: LinearImage) => setDecoded({ rawSrc, image }), []);
  // Статус нейросетевого шумоподавления по каждому снимку.
  const [denoiseStatus, setDenoiseStatus] = useState<Record<string, DenoiseStatus>>({});
  const onDenoiseStatus = useCallback(
    (rawSrc: string, status: DenoiseStatus) => setDenoiseStatus((prev) => ({ ...prev, [rawSrc]: status })),
    [],
  );
  // Свежие миниатюры обработанных кадров из этой вкладки (blob-URL), поверх тех, что на сервере.
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  const onThumbnail = useCallback((rawSrc: string, jpeg: Blob) => {
    const file = filesRef.current.find((f) => previewUrl(f, "raw") === rawSrc);
    if (!file) return;
    const url = URL.createObjectURL(jpeg);
    setThumbs((prev) => {
      if (prev[file.name]) URL.revokeObjectURL(prev[file.name]);
      return { ...prev, [file.name]: url };
    });
    fetch(`/api/sources/${encodeURIComponent(file.name)}/thumb`, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: jpeg,
    });
  }, []);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Снимки, которые правились в этой вкладке.
  const edited = useRef(new Set<string>());

  const updateEdits = useCallback((name: string, value: Edits) => {
    edited.current.add(name);
    setEdits((prev) => ({ ...prev, [name]: value }));
    // Сохраняем с задержкой, чтобы не писать файл на каждый шаг ползунка.
    clearTimeout(saveTimers.current.get(name));
    saveTimers.current.set(
      name,
      setTimeout(() => {
        saveTimers.current.delete(name);
        fetch(`/api/sources/${encodeURIComponent(name)}/edits`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        });
      }, 300),
    );
  }, []);
  const stripRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/sources", { cache: "no-store" });
      const list: SourceFile[] = await res.json();
      setFiles(list);
      // Сохранённые настройки подхватываем только для файлов, которые ещё не правились в этой вкладке.
      setEdits((prev) => {
        const next = { ...prev };
        for (const f of list) if (!(f.name in next) && f.edits) next[f.name] = f.edits;
        return next;
      });
      setSelected((cur) => (cur && list.some((f) => f.name === cur) ? cur : (list[0]?.name ?? null)));
    } finally {
      setLoading(false);
    }
  }, []);

  // Список перечитывается при загрузке и при возврате в окно: файлы добавляются через Finder.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- первичная загрузка списка
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const index = files.findIndex((f) => f.name === selected);
  const current = index >= 0 ? files[index] : null;
  const currentEdits = current ? (edits[current.name] ?? DEFAULT_EDITS) : DEFAULT_EDITS;

  // Снимок, который ещё ни разу не правился, при первом открытии получает Auto.
  const autoStarted = useRef(new Set<string>());
  useEffect(() => {
    if (!current || current.edits || decoded?.rawSrc !== previewUrl(current, "raw")) return;
    const name = current.name;
    if (edited.current.has(name) || autoStarted.current.has(name)) return;
    autoStarted.current.add(name);
    autoAdjustments(decoded.image).then((auto) => {
      // Пока считали, пользователь мог уже сам что-то поменять — тогда не перетираем.
      if (!edited.current.has(name)) updateEdits(name, { ...DEFAULT_EDITS, ...auto });
    });
  }, [current, decoded, updateEdits]);

  // Переход по кадрам стрелками, как в ленте Lightroom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // Стрелки на ползунке двигают ползунок, а не переключают кадр.
      if (e.target instanceof HTMLInputElement) return;
      const next = files[index + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) {
        e.preventDefault();
        setSelected(next.name);
        setSelection([next.name]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files, index]);

  const selectedNames = useMemo(
    () => (selected && selection.includes(selected) ? selection : selected ? [selected] : []),
    [selected, selection],
  );

  // Клик по миниатюре: обычный — один кадр, ⌘ — добавить/убрать, Shift — диапазон от текущего.
  const onThumbClick = (name: string, e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      if (!selectedNames.includes(name)) {
        setSelection([...selectedNames, name]);
        setSelected(name);
      } else if (selectedNames.length > 1) {
        const rest = selectedNames.filter((n) => n !== name);
        setSelection(rest);
        if (name === selected) setSelected(rest[rest.length - 1]);
      }
    } else if (e.shiftKey && index >= 0) {
      const to = files.findIndex((f) => f.name === name);
      const [a, b] = index < to ? [index, to] : [to, index];
      setSelection(files.slice(a, b + 1).map((f) => f.name));
      setSelected(name);
    } else {
      setSelection([name]);
      setSelected(name);
    }
  };

  // ⌘C копирует настройки цвета текущего снимка, ⌘V вставляет их во все выделенные.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !current) return;
      // По физической клавише, чтобы работало и в русской раскладке.
      if (e.code !== "KeyC" && e.code !== "KeyV") return;
      if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;

      e.preventDefault();
      if (e.code === "KeyC") {
        setClipboard(Object.fromEntries(SLIDERS.map((s) => [s.key, currentEdits[s.key]])) as Adjustments);
        setToast({ text: "Color settings copied", id: Date.now() });
      } else if (clipboard) {
        for (const name of selectedNames) updateEdits(name, { ...(edits[name] ?? DEFAULT_EDITS), ...clipboard });
        const n = selectedNames.length;
        setToast({ text: n > 1 ? `Color settings pasted to ${n} photos` : "Color settings pasted", id: Date.now() });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, currentEdits, clipboard, updateEdits, edits, selectedNames]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1500);
    return () => clearTimeout(timer);
  }, [toast]);

  // Колёсико над лентой листает её влево-вправо. Горизонтальный свайп трекпада работает и так.
  // Слушатель не пассивный: иначе нельзя отменить вертикальную прокрутку по умолчанию.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    stripRef.current
      ?.querySelector(`[data-name="${CSS.escape(selected ?? "")}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  return (
    <div className="grid h-screen grid-cols-[1fr_18rem] grid-rows-[1fr_8.5rem] bg-neutral-900 text-neutral-300">
      <main className="relative min-h-0 bg-neutral-950">
        {current ? (
          <PhotoView
            previewSrc={previewUrl(current, "preview")}
            rawSrc={previewUrl(current, "raw")}
            denoiseUrl={`/api/sources/${encodeURIComponent(current.name)}/denoise`}
            edits={currentEdits}
            mode={tab}
            onCropChange={(crop) => updateEdits(current.name, { ...currentEdits, crop })}
            onImageAspect={setImageAspect}
            onDecoded={onDecoded}
            onDenoiseStatus={onDenoiseStatus}
            onThumbnail={onThumbnail}
          />
        ) : (
          !loading && (
            <div className="flex h-full items-center justify-center text-center text-sm text-neutral-500">
              Put RAW files into the <code className="mx-1 text-neutral-300">sources/</code> folder
            </div>
          )
        )}
        {toast && (
          <div className="pointer-events-none absolute right-3 bottom-2 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200">
            {toast.text}
          </div>
        )}
      </main>

      <aside className="row-span-2 flex min-h-0 flex-col border-l border-neutral-800">
        <div className="flex shrink-0 border-b border-neutral-800 text-[11px]">
          {(
            [
              ["color", "Color"],
              ["crop", "Crop"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 py-2 ${tab === id ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {current &&
            (tab === "color" ? (
              <AdjustmentsPanel
                value={currentEdits}
                onChange={(v) => updateEdits(current.name, { ...currentEdits, ...v })}
                denoiseStatus={denoiseStatus[previewUrl(current, "raw")] ?? null}
                onAuto={
                  decoded?.rawSrc === previewUrl(current, "raw")
                    ? async () => updateEdits(current.name, { ...currentEdits, ...(await autoAdjustments(decoded.image)) })
                    : null
                }
              />
            ) : (
              <CropPanel
                crop={currentEdits.crop}
                imageAspect={imageAspect}
                onChange={(crop) => updateEdits(current.name, { ...currentEdits, crop })}
              />
            ))}
        </div>
      </aside>

      <div
        ref={stripRef}
        className="flex gap-2 overflow-x-auto border-t border-neutral-800 px-3 py-3"
      >
        {files.map((f) => (
          <button
            key={f.name}
            data-name={f.name}
            onClick={(e) => onThumbClick(f.name, e)}
            title={f.name}
            className={`h-full shrink-0 overflow-hidden rounded border-2 ${
              f.name === selected
                ? "border-neutral-200"
                : selectedNames.includes(f.name)
                  ? "border-neutral-500"
                  : "border-transparent"
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumbs[f.name] ?? previewUrl(f, "thumb")} alt={f.name} className="block h-full w-auto" />
          </button>
        ))}
      </div>
    </div>
  );
}
