// client/components/RadialMenu.tsx — タッチ地点を中心に麺種プリセットを円弧状に展開するセレクタ。
// 「Start タッチ → 種類を円形展開 → 選んで自動スタート」フローの選択段を担う。選択＝開始であり、
// このコンポーネント自身は状態を持たない（開閉アニメの shown だけがローカルな表示都合）。表示は
// 受信した noodlePresets（サーバ権威の StoreConfig 由来）をそのまま咲かせ、選んだ preset を onSelect で
// 親へ返すだけ。花びらの背景は noodleType からの導出色（noodleColor）で麺ごとに個性を出し、文字は統一の暗色。
// createPortal で body 直下に描き、スロットの overflow / スタッキングに縛られない。
//
// 花びらの座標は実行時に変わるためインライン style（transform / transitionDelay）で渡す。Tailwind でも
// 「実行時に変わる値」はインラインが正解で、無理にクラス化しない（design-system の方針）。

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../cn";
import type { NoodlePreset } from "../../domain/store";
import type { NoodleColor } from "./noodleColor";

interface RadialMenuProps {
  /** タッチした地点（ビューポート座標の中心）。null で閉じる。 */
  readonly anchor: { readonly x: number; readonly y: number } | null;
  /** 円弧状に展開する麺種プリセット（3〜6 個を想定）。 */
  readonly presets: readonly NoodlePreset[];
  /** noodleType → 背景色の resolver（花びらの背景塗りに用いる。SlotCard と同じ割り当てを共有する）。 */
  readonly colorOf: NoodleColor;
  /** 中心ハブの上に出すラベル（例: "Slot 0"）。 */
  readonly label?: string | undefined;
  /** 展開半径(px)。既定 132。 */
  readonly radius?: number;
  /** プリセットを選んだとき（＝そのまま自動スタート）。 */
  readonly onSelect: (preset: NoodlePreset) => void;
  /** キャンセル（背景タップ / ×ハブ / Esc）。 */
  readonly onClose: () => void;
}

/**
 * タッチした地点を中心に麺種を円弧状に展開するラジアルメニュー。
 * 項目数(3〜6)に応じて弧の広がりが変わり、画面端では内側に開く。
 */
export function RadialMenu({ anchor, presets, colorOf, label, radius = 132, onSelect, onClose }: RadialMenuProps) {
  const [shown, setShown] = useState(false);

  // マウント後に開く（中心 → 放射のアニメ）。
  useEffect(() => {
    if (!anchor) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [anchor]);

  // Esc で閉じる。
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
    const n = presets.length;
    const margin = radius + 60;
    // 咲く余白を確保するため、中心を画面内にクランプ。
    const cx = Math.max(margin, Math.min(vw - margin, anchor.x));
    const cy = Math.max(margin, Math.min(vh - margin, anchor.y));
    // 右半分なら左へ、左半分なら右へ開く（画面端で切れない）。
    const base = anchor.x > vw / 2 ? Math.PI : 0;
    const spread = Math.min(Math.PI * 1.5, (n - 1) * 0.62 + 0.4);
    const petals = presets.map((preset, k) => {
      const ang = base + (n > 1 ? (k - (n - 1) / 2) * (spread / (n - 1)) : 0);
      return {
        preset,
        x: Math.cos(ang) * radius,
        y: Math.sin(ang) * radius,
        delay: k * 35,
      };
    });
    return { cx, cy, petals };
  }, [anchor, presets, radius]);

  if (!anchor || !layout) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Select noodle">
      {/* 背景 */}
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-[rgba(8,6,4,.55)] backdrop-blur-[0.1875rem] transition-opacity duration-150",
          shown ? "opacity-100" : "opacity-0",
        )}
      />

      {/* ラベル */}
      {label && (
        <div
          style={{ left: layout.cx, top: layout.cy - radius - 30 }}
          className={cn(
            "absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[0.75rem] font-bold",
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
          "absolute -ml-[1.8125rem] -mt-[1.8125rem] grid h-[3.625rem] w-[3.625rem] place-items-center rounded-full",
          "border border-line bg-panel text-2xl font-bold text-muted cursor-pointer",
          "shadow-[0_0.375rem_1.25rem_rgba(0,0,0,.45)] transition duration-200 ease-[cubic-bezier(.2,.9,.3,1.3)]",
          shown ? "scale-100 opacity-100" : "scale-[.4] opacity-0",
        )}
      >
        ×
      </button>

      {/* 放射状に咲く選択肢 */}
      {layout.petals.map(({ preset, x, y, delay }) => (
        <button
          key={preset.noodleType}
          type="button"
          onClick={() => onSelect(preset)}
          style={{
            left: layout.cx,
            top: layout.cy,
            backgroundColor: colorOf(preset.noodleType),
            transitionDelay: `${delay}ms`,
            transform: shown ? `translate(${x}px, ${y}px) scale(1)` : "translate(0, 0) scale(0.3)",
          }}
          className={cn(
            "absolute left-0 top-0 -ml-[2.875rem] -mt-[2.875rem] flex h-[5.75rem] w-[5.75rem] flex-col items-center justify-center gap-0.5",
            "rounded-full border border-line text-[#15120c] cursor-pointer",
            "shadow-[0_0.5rem_1.375rem_rgba(0,0,0,.4)] hover:border-ink active:brightness-105",
            "transition-[transform,opacity,border-color] duration-[260ms] ease-[cubic-bezier(.2,.9,.3,1.25)]",
            shown ? "opacity-100" : "opacity-0",
          )}
        >
          {/* 花びらの背景が麺のキャラクター色、文字は統一の暗色（前景は統一・背景で識別）。 */}
          <span className="text-[1rem] font-extrabold leading-none">{preset.noodleType}</span>
          <span className="font-mono text-[0.8125rem] font-medium opacity-70">{preset.boilSeconds.normal}s</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
