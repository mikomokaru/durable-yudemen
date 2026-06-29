import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Noodle } from "./types";
import { cn } from "./cn";

export interface RadialMenuProps {
  /** タッチした地点（ビューポート座標の中心）。null で閉じる */
  anchor: { x: number; y: number } | null;
  /** 表示する麺の種類（3〜6個） */
  noodles: Noodle[];
  /** 中心ハブの上に出すラベル（例: "Slot 0"） */
  label?: string;
  /** 展開半径(px)。既定 132 */
  radius?: number;
  /** 種類を選んだとき（＝そのまま自動スタート用） */
  onSelect: (noodle: Noodle) => void;
  /** キャンセル（背景タップ / ×ハブ / Esc） */
  onClose: () => void;
}

/**
 * タッチした地点を中心に、麺の種類を円弧状に展開するラジアルメニュー。
 * 項目数(3〜6)に応じて弧の広がりが変わり、画面端では内側に開きます。
 * 花びらの座標は動的なのでインライン style（CSS 変数的な使い方）で渡します。
 */
export function RadialMenu({
  anchor,
  noodles,
  label,
  radius = 132,
  onSelect,
  onClose,
}: RadialMenuProps) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!anchor) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anchor, onClose]);

  const layout = useMemo(() => {
    if (!anchor) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const n = noodles.length;
    const margin = radius + 60;
    const cx = Math.max(margin, Math.min(vw - margin, anchor.x));
    const cy = Math.max(margin, Math.min(vh - margin, anchor.y));
    const base = anchor.x > vw / 2 ? Math.PI : 0;
    const spread = Math.min(Math.PI * 1.5, (n - 1) * 0.62 + 0.4);
    const petals = noodles.map((nd, k) => {
      const ang = base + (n > 1 ? (k - (n - 1) / 2) * (spread / (n - 1)) : 0);
      return {
        nd,
        x: Math.cos(ang) * radius,
        y: Math.sin(ang) * radius,
        delay: k * 35,
      };
    });
    return { cx, cy, petals };
  }, [anchor, noodles, radius]);

  if (!anchor || !layout) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Select noodle">
      {/* 背景 */}
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-[rgba(8,6,4,.55)] backdrop-blur-[3px] transition-opacity duration-150",
          shown ? "opacity-100" : "opacity-0",
        )}
      />

      {/* ラベル */}
      {label && (
        <div
          style={{ left: layout.cx, top: layout.cy - radius - 30 }}
          className={cn(
            "absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[12px] font-bold",
            "uppercase tracking-[.06em] text-muted transition-opacity duration-200 delay-[50ms]",
            shown ? "opacity-100" : "opacity-0",
          )}
        >
          {label}
        </div>
      )}

      {/* 中心ハブ（キャンセル） */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Cancel"
        style={{ left: layout.cx, top: layout.cy }}
        className={cn(
          "absolute -ml-[29px] -mt-[29px] grid h-[58px] w-[58px] place-items-center rounded-full",
          "border border-line bg-panel text-2xl font-bold text-muted cursor-pointer",
          "shadow-[0_6px_20px_rgba(0,0,0,.45)] transition duration-200 ease-[cubic-bezier(.2,.9,.3,1.3)]",
          shown ? "scale-100 opacity-100" : "scale-[.4] opacity-0",
        )}
      >
        ×
      </button>

      {/* 放射状に咲く選択肢 */}
      {layout.petals.map(({ nd, x, y, delay }) => (
        <button
          key={nd.id}
          type="button"
          onClick={() => onSelect(nd)}
          style={{
            left: layout.cx,
            top: layout.cy,
            transitionDelay: `${delay}ms`,
            transform: shown ? `translate(${x}px, ${y}px) scale(1)` : "translate(0, 0) scale(0.3)",
          }}
          className={cn(
            "absolute left-0 top-0 -ml-[46px] -mt-[46px] flex h-[92px] w-[92px] flex-col items-center justify-center gap-0.5",
            "rounded-full border border-line bg-panel2 text-ink cursor-pointer",
            "shadow-[0_8px_22px_rgba(0,0,0,.4)] hover:border-running hover:bg-running/15 active:brightness-110",
            "transition-[transform,opacity,border-color,background-color] duration-[260ms] ease-[cubic-bezier(.2,.9,.3,1.25)]",
            shown ? "opacity-100" : "opacity-0",
          )}
        >
          <span className="text-[16px] font-extrabold leading-none">{nd.name}</span>
          <span className="font-mono text-[13px] font-medium text-running">{nd.sec}s</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
