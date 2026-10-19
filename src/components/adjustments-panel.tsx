"use client";

import { useState, type CSSProperties } from "react";
import {
  GROUPS,
  MIXER_CHANNELS,
  MIXER_COLORS,
  SLIDERS,
  mixerKey,
  type Adjustments,
} from "@/lib/adjustments";
import type { DenoiseStatus } from "@/lib/denoise-client";

type SliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits: number;
  defaultValue: number;
  disabled?: boolean;
  /** CSS-фон дорожки, например градиент цвета. */
  track?: string;
  onChange: (v: number) => void;
};

function Slider({
  label,
  value,
  min,
  max,
  step,
  digits,
  defaultValue,
  disabled,
  track,
  onChange,
}: SliderProps) {
  return (
    <label
      className={`flex items-center gap-1.5 text-[11px] ${disabled ? "opacity-40" : ""}`}
    >
      <span className="w-16 shrink-0 whitespace-nowrap">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        // Двойной клик сбрасывает ползунок к значению по умолчанию, как в Lightroom.
        onDoubleClick={() => onChange(defaultValue)}
        className={`slider min-w-0 flex-1 ${track ? "slider-track" : ""}`}
        style={track ? ({ "--track": track } as CSSProperties) : undefined}
      />
      <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-neutral-500">
        {(min < 0 && value > 0 ? "+" : "") + value.toFixed(digits)}
      </span>
    </label>
  );
}

type MixerChannel = (typeof MIXER_CHANNELS)[number]["id"];

/** Дорожка ползунка Color Mixer показывает, куда он сдвигает цвет. */
function mixerTrack(channel: MixerChannel, hue: number) {
  const color = (h: number, s = 70, l = 50) => `hsl(${h} ${s}% ${l}%)`;
  if (channel === "hue")
    return `linear-gradient(to right, ${color(hue - 30)}, ${color(hue)}, ${color(hue + 30)})`;
  if (channel === "sat")
    return `linear-gradient(to right, ${color(hue, 0)}, ${color(hue)})`;
  return `linear-gradient(to right, ${color(hue, 70, 15)}, ${color(hue, 70, 80)})`;
}

/** Color Mixer, как в Lightroom: переключатель Hue / Saturation / Luminance и по ползунку на полосу спектра. */
function ColorMixer({
  value,
  onChange,
}: {
  value: Adjustments;
  onChange: (v: Adjustments) => void;
}) {
  const [channel, setChannel] = useState<MixerChannel>("hue");
  return (
    <>
      <div className="mb-1.5 grid grid-cols-3 gap-1">
        {MIXER_CHANNELS.map((ch) => (
          <button
            key={ch.id}
            onClick={() => setChannel(ch.id)}
            className={`rounded px-1 py-0.5 text-[10px] ${
              channel === ch.id
                ? "bg-neutral-200 text-neutral-900"
                : "bg-neutral-800 hover:bg-neutral-700"
            }`}
          >
            {ch.label}
          </button>
        ))}
      </div>
      <div className="space-y-1">
        {MIXER_COLORS.map((c) => {
          const key = mixerKey(channel, c.id);
          return (
            <Slider
              key={key}
              label={c.label}
              value={value[key]}
              min={-100}
              max={100}
              step={1}
              digits={0}
              defaultValue={0}
              track={mixerTrack(channel, c.hue)}
              onChange={(v) => onChange({ ...value, [key]: v })}
            />
          );
        })}
      </div>
    </>
  );
}

/** Под ползунком шумоподавления: что сейчас делает нейросеть. */
function DenoiseState({
  status,
  value,
}: {
  status: DenoiseStatus | null;
  value: number;
}) {
  const spinner = (
    <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-neutral-500 border-t-neutral-200" />
  );
  let content;
  if (status?.state === "model") {
    content = <>{spinner} Loading AI model…</>;
  } else if (status?.state === "running") {
    const pct = Math.round((status.done / status.total) * 100);
    content = (
      <div className="flex-1">
        <div className="flex items-center gap-1.5">
          {spinner} Denoising… {pct}%
        </div>
        <div className="mt-1 h-0.5 rounded bg-neutral-700">
          <div
            className="h-full rounded bg-neutral-300 transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  } else if (status?.state === "done" && value > 0) {
    content = <>✓ AI denoise applied</>;
  } else if (status?.state === "error") {
    content = (
      <span className="text-red-400">AI denoise failed: {status.message}</span>
    );
  } else if (value === 0) {
    content = <>Move the slider to run AI denoise (~7 s per photo)</>;
  } else {
    content = <>{spinner} Waiting for RAW…</>;
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-[10px] text-neutral-500">
      {content}
    </div>
  );
}

export function AdjustmentsPanel({
  value,
  onChange,
  onAuto,
  denoiseStatus,
}: {
  value: Adjustments;
  onChange: (v: Adjustments) => void;
  denoiseStatus: DenoiseStatus | null;
  /** Автонастройка; null, пока кадр не декодирован. */
  onAuto: (() => void) | null;
}) {
  return (
    <div className="space-y-3 px-2.5 py-3">
      {GROUPS.map((g) => (
        <section key={g.id}>
          <div className="mb-1 flex h-5 items-center justify-between text-[10px] tracking-wide text-neutral-500 uppercase">
            {g.label}
            {/* Как в Lightroom: Auto стоит в заголовке группы тона. */}
            {g.id === "tone" && (
              <button
                onClick={() => onAuto?.()}
                disabled={!onAuto}
                className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] tracking-normal text-neutral-300 normal-case hover:bg-neutral-700 disabled:opacity-40"
              >
                Auto
              </button>
            )}
          </div>
          {g.id === "mixer" ? (
            <ColorMixer value={value} onChange={onChange} />
          ) : (
            <div className="space-y-1">
              {SLIDERS.filter((s) => s.group === g.id).map((s) => (
                <div key={s.key}>
                  <Slider
                    label={s.label}
                    value={value[s.key]}
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    digits={s.digits}
                    defaultValue={s.default}
                    onChange={(v) => onChange({ ...value, [s.key]: v })}
                  />
                  {s.key === "denoise" && (
                    <DenoiseState
                      status={denoiseStatus}
                      value={value.denoise}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
