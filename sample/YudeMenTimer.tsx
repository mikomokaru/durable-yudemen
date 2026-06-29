import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Noodle, SlotState } from "./types";
import { SlotCard } from "./SlotCard";
import { RadialMenu } from "./RadialMenu";
import { cn } from "./cn";

export interface YudeMenTimerProps {
  /** スロット数（既定 6） */
  slotCount?: number;
  /** 麺の種類（3〜6個） */
  noodles: Noodle[];
  title?: string;
  /** 同期ステータス表示（例: "Synced"）。null で非表示 */
  status?: string | null;
  /**
   * 設定ポップオーバーの中身（Units / Start unit など）。
   * 渡すと上部バーに「Settings」ボタンが出ます。省略時はボタン非表示。
   */
  settings?: ReactNode;
}

type Cell = { endsAt: number | null; noodle: Noodle | null };

export function YudeMenTimer({
  slotCount = 6,
  noodles,
  title = "Yude-men Timer",
  status = "Synced",
  settings,
}: YudeMenTimerProps) {
  const [cells, setCells] = useState<Cell[]>(() =>
    Array.from({ length: slotCount }, () => ({ endsAt: null, noodle: null })),
  );

  useEffect(() => {
    setCells((cs) => {
      if (cs.length === slotCount) return cs;
      const next = cs.slice(0, slotCount);
      while (next.length < slotCount) next.push({ endsAt: null, noodle: null });
      return next;
    });
  }, [slotCount]);

  const [now, setNow] = useState(() => Date.now());
  const [picker, setPicker] = useState<{ index: number; x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const hasRunning = cells.some((c) => c.endsAt != null && c.endsAt > now);
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [hasRunning]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        popRef.current && !popRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setSettingsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSettingsOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen]);

  const slots: SlotState[] = useMemo(
    () =>
      cells.map((c) => {
        if (c.endsAt == null) return { status: "idle", remaining: 0, noodle: null };
        const remaining = Math.max(0, Math.ceil((c.endsAt - now) / 1000));
        return {
          status: remaining > 0 ? "running" : "boiled",
          remaining,
          noodle: c.noodle,
        };
      }),
    [cells, now],
  );

  const startSlot = (index: number, noodle: Noodle) =>
    setCells((cs) =>
      cs.map((c, i) => (i === index ? { endsAt: Date.now() + noodle.sec * 1000, noodle } : c)),
    );
  const resetSlot = (index: number) =>
    setCells((cs) => cs.map((c, i) => (i === index ? { endsAt: null, noodle: null } : c)));

  return (
    <div className="flex h-[100dvh] flex-col">
      {/* 固定タイトルバー */}
      <header
        className={cn(
          "relative z-30 flex flex-none items-center gap-4",
          "h-[calc(clamp(52px,7.5vh,66px)+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]",
          "px-[clamp(12px,2.4vw,26px)] border-b border-line",
          "bg-[color-mix(in_oklab,var(--color-panel)_92%,black)]",
        )}
      >
        <h1 className="m-0 text-[clamp(15px,2.2vw,20px)] font-extrabold uppercase tracking-[.06em] text-ink">
          {title}
        </h1>
        <div className="flex-1" />

        {status && (
          <span className="inline-flex items-center gap-2 text-[13px] font-bold text-muted before:h-[9px] before:w-[9px] before:rounded-full before:bg-boiled before:shadow-[0_0_8px_var(--color-boiled)] before:content-['']">
            {status}
          </span>
        )}

        {settings && (
          <>
            <button
              ref={btnRef}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((o) => !o)}
              className="inline-flex h-10 items-center gap-2 rounded-[11px] border border-line bg-panel2 px-4 text-sm font-bold text-ink cursor-pointer hover:border-muted before:text-[17px] before:content-['⚙']"
            >
              Settings
            </button>
            {settingsOpen && (
              <div
                ref={popRef}
                role="dialog"
                aria-label="Settings"
                className="absolute right-[clamp(12px,2.4vw,26px)] top-[calc(100%+8px)] z-40 w-[min(360px,calc(100vw-24px))] rounded-[14px] border border-line bg-panel p-[14px] shadow-[0_18px_50px_rgba(0,0,0,.55)]"
              >
                {settings}
              </div>
            )}
          </>
        )}
      </header>

      {/* スロット領域：画面いっぱい・スクロールなし */}
      <main className="min-h-0 flex-1 p-[clamp(8px,1.4vw,16px)]" aria-label="Slots">
        <div className="grid h-full auto-rows-fr grid-cols-2 gap-[clamp(8px,1.2vw,14px)] [@media(orientation:portrait)]:grid-cols-1">
          {slots.map((slot, i) => (
            <SlotCard
              key={i}
              index={i}
              slot={slot}
              onStart={(idx, center) => setPicker({ index: idx, ...center })}
              onStop={resetSlot}
              onClear={resetSlot}
            />
          ))}
        </div>
      </main>

      <RadialMenu
        anchor={picker ? { x: picker.x, y: picker.y } : null}
        noodles={noodles}
        label={picker ? `Slot ${picker.index}` : undefined}
        onSelect={(nd) => {
          if (picker) startSlot(picker.index, nd);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
    </div>
  );
}
