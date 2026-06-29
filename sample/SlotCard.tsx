import { type MouseEvent } from "react";
import type { SlotState } from "./types";
import { cn } from "./cn";

export interface SlotCardProps {
  index: number;
  slot: SlotState;
  /** Start タッチ。center = ラジアルメニューを開く中心座標（ビューポート） */
  onStart: (index: number, center: { x: number; y: number }) => void;
  onStop: (index: number) => void;
  onClear: (index: number) => void;
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

const btnBase =
  "h-[clamp(44px,6vh,56px)] px-[clamp(18px,2vw,26px)] rounded-[13px] " +
  "font-extrabold tracking-[.02em] text-[clamp(15px,2vh,17px)] whitespace-nowrap " +
  "cursor-pointer transition active:scale-95";

export function SlotCard({ index, slot, onStart, onStop, onClear }: SlotCardProps) {
  const handleStart = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onStart(index, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  };

  const borderColor =
    slot.status === "running"
      ? "border-l-running"
      : slot.status === "boiled"
        ? "border-l-boiled"
        : "border-l-idle";

  const timeColor = slot.status === "boiled" ? "text-boiled" : "text-running";

  return (
    <article
      aria-label={`Slot ${index}`}
      className={cn(
        "relative min-h-0 flex flex-col justify-center",
        "gap-[clamp(4px,1vh,10px)] rounded-[14px] border border-line",
        "border-l-[5px] bg-panel p-[clamp(10px,1.6vh,18px)_clamp(14px,1.8vw,20px)]",
        "shadow-[0_1px_0_rgba(255,255,255,.03)_inset,0_8px_24px_rgba(0,0,0,.35)]",
        "transition-[border-color,box-shadow] duration-200",
        borderColor,
        slot.status === "boiled" && "animate-boiled border-boiled/45",
      )}
    >
      {/* 上段：スロット名 ＋ 残り時間 */}
      <div className="flex items-center justify-between gap-4">
        <header
          className={cn(
            "text-[clamp(11px,1.5vh,13px)] font-bold uppercase tracking-[.08em]",
            slot.status === "idle" ? "text-idle" : "text-muted",
          )}
        >
          Slot {index}
        </header>
        {slot.status !== "idle" && (
          <p
            className={cn(
              "m-0 font-mono font-medium leading-[.95] tabular-nums tracking-[.02em]",
              "text-[clamp(30px,7vh,64px)]",
              timeColor,
            )}
          >
            {fmt(slot.remaining)}
          </p>
        )}
      </div>

      {/* 下段：状態 ＋ 操作ボタン */}
      <div className="flex items-center justify-between gap-4">
        <p
          className={cn(
            "m-0 inline-flex min-w-0 items-center gap-2 text-[clamp(13px,1.8vh,16px)] font-bold",
            slot.status === "boiled" ? "text-boiled tracking-[.04em]" : "text-muted",
          )}
        >
          {slot.status === "boiled" && (
            <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-boiled/20">
              ✓
            </span>
          )}
          <span className="truncate">
            {slot.status === "idle" && "Ready"}
            {slot.status === "running" && `Boiling — ${slot.noodle?.name ?? ""}`}
            {slot.status === "boiled" && "Boiled!"}
          </span>
        </p>

        <div className="flex justify-end">
          {slot.status === "idle" && (
            <button
              type="button"
              onClick={handleStart}
              className={cn(btnBase, "bg-running text-[#1a1408] hover:brightness-110")}
            >
              ＋ Start
            </button>
          )}
          {slot.status === "running" && (
            <button
              type="button"
              onClick={() => onStop(index)}
              className={cn(btnBase, "border border-line bg-panel2 text-ink hover:border-muted")}
            >
              Stop
            </button>
          )}
          {slot.status === "boiled" && (
            <button
              type="button"
              onClick={() => onClear(index)}
              className={cn(btnBase, "bg-boiled text-[#0d1a10] hover:brightness-105")}
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
