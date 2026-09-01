// client/components/FirmnessCornerControl.tsx — カード左下の「角融合」茹で加減コントロール
// （sample/yudekagen 由来）。角ボタン（現在の硬さを表示）→ タップで4段が右へスライド展開 → 選んで即確定。
// デフォルト「ふつう」のままなら無操作でよい。展開中は親が STOP を隠す（onOpenChange）。
// boiling 相は操作可能、boiled 相は disabled で現在の硬さを表示したまま操作不能（変更に意味がないため）。
//
// onChange は実機能：親（SlotCard）経由で TimerConnection.adjust を呼び、その麺の硬さ別茹で時間で endTime を
// 引き直す（boiling 相のみ・boiled 除外）。レイアウトは実行時座標（スライド変位）を持つためインライン style。
// 色はテーマ変数とアクセント（麺色）に寄せ、寸法はカード幅基準（cqw・角ボタンも選択肢も追従）。

import { useEffect, useState, type CSSProperties } from "react";
import { FIRMNESS_ORDER, type Firmness } from "../../domain/firmness";
import { FIRMNESS_LABEL } from "./firmness";
import { cn } from "../cn";

export interface FirmnessCornerControlProps {
  readonly value: Firmness;
  /** 硬さを選んだとき。親（SlotCard）が TimerConnection.adjust を発行し endTime を引き直す。 */
  readonly onChange: (next: Firmness) => void;
  /** メニュー開閉の通知。開いている間は親が STOP を隠す（衝突回避）。 */
  readonly onOpenChange?: (open: boolean) => void;
  /** その麺種のアクセント色（選択中ボタン・非デフォルト枠に使う）。 */
  readonly accent: string;
  /** 操作不能（boiled 相）。現在の硬さは表示するが、展開・変更はできない（変更に意味がないため）。 */
  readonly disabled?: boolean;
}

// レイアウト定数。横方向はカード幅基準（cqw・カードは @container 済み）にして、展開時の合計幅が
// カード幅を超えないようにする（4×W + 3×GAP + LEFT0 ≒ 91.5cqw < 100cqw）。縦は rem。
const W = 23; // 選択肢ボタン幅（cqw）
const GAP = 1.5; // cqw
const LEFT0 = 2; // 先頭ボタンの左位置（cqw）。合計 = LEFT0 + 4W + 3GAP ≒ 98.5cqw（ほぼ全幅・左右に僅かな余白）
const BOTTOM = 1; // rem
/** iPad（大カード）の横スライド行での選択肢サイズ。カード幅に追従（cqw）しつつタッチ下限を確保する。 */
const OPTION_SIZE = "h-[clamp(2.75rem,16cqw,4.875rem)] text-[clamp(0.8rem,4.6cqw,1.1875rem)]";

// 狭カード（iPhone・カードコンテナ幅 ≤240px）は iPad の横スライド行を隠し、代わりにスロット全面の 2×2
// グリッドを出す。判定はカードのコンテナクエリ（@max-[240px]:）で行い、機種・向きに依存しない（「狭ければ
// 広げる」という本質に紐づける）。iPhone のカードは 2 カラム配置で ≈184px、iPad は ≳270px ゆえ 240px で
// 分かれる（実機で確認済み・調整可）。Tailwind は静的スキャンゆえ variant はリテラルで書く（動的連結は拾えない）。
/**
 * 角ボタンの寸法もカード幅基準（cqw）にする。固定 rem だと横画面（2ユニット=カードが小さい）で
 * カードに対する占有率が上がり過大に見えるため、クロック（cqi）・選択肢（cqw）と同じく幅追従にして
 * 占有率を向き非依存に保つ。clamp でタッチ下限と肥大の上限を抑える。
 */
const CORNER_W = "clamp(5.5rem,31cqw,8.5rem)";
const CORNER_H = "clamp(3.75rem,22cqw,6rem)";
const CORNER_FONT = "clamp(1rem,6cqw,1.625rem)";

/** 「ふつう」が既定。これ以外を選ぶと角ボタンを強調して「デフォルトでない」を示す。 */
export function FirmnessCornerControl({
  value,
  onChange,
  onOpenChange,
  accent,
  disabled = false,
}: FirmnessCornerControlProps) {
  const [open, setOpen] = useState(false);

  const setOpenAnd = (next: boolean) => {
    if (disabled) return; // 操作不能（boiled）では展開させない
    setOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenAnd(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // setOpenAnd は安定（state setter + 任意コールバック）。open のみ依存で十分。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isDefault = value === "normal";

  // 角ボタン（外側=左下はカード角と一致、内側=右上だけ丸める＝角融合）。開いている間はフェードして先頭へ席を譲る。
  const cornerStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    bottom: 0,
    zIndex: 6,
    width: CORNER_W,
    height: CORNER_H,
    padding: "0 0 3.4cqw 4.4cqw",
    display: "flex",
    alignItems: "flex-end",
    border: 0,
    borderRadius: "0 1.25rem 0 1rem",
    background: accent,
    boxShadow: isDefault ? "none" : "0 0 0 0.125rem rgba(0,0,0,.38) inset",
    color: "#15120c",
    fontSize: CORNER_FONT,
    fontWeight: 800,
    lineHeight: 1.05,
    cursor: disabled ? "default" : "pointer",
    opacity: open ? 0 : disabled ? 0.7 : 1,
    pointerEvents: open ? "none" : "auto",
    transition: "background .15s, box-shadow .15s, opacity .15s, color .15s",
  };

  return (
    <>
      {/* 薄いカバー：他要素を軽く沈める。タップで閉じる。狭カード（iPhone）ではタイマーを透かすため暗幕を薄くする。 */}
      <div
        onClick={() => setOpenAnd(false)}
        className="bg-[#0a0805]/40"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 4,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity .18s",
        }}
      />

      {/* 角ボタン（現在の硬さを表示） */}
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={() => setOpenAnd(!open)}
        style={cornerStyle}
      >
        {FIRMNESS_LABEL[value]}
      </button>

      {/* iPad（広カード）: 右へスライド展開する硬さ選択（硬い→柔らかい）。閉じている間は角ボタン位置に畳む。
          狭カード（iPhone）ではこの行を隠し、下の 2×2 グリッドに委ねる。 */}
      <div
        role="radiogroup"
        aria-label="Firmness"
        className="@max-[240px]:hidden"
        style={{ position: "absolute", left: 0, bottom: 0, zIndex: 5 }}
      >
        {FIRMNESS_ORDER.map((id, i) => {
          const x = LEFT0 + i * (W + GAP);
          const active = id === value;
          const style: CSSProperties = {
            position: "absolute",
            left: `${x}cqw`,
            bottom: `${BOTTOM}rem`,
            width: `${W}cqw`,
            borderRadius: "1rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: active ? 0 : "0.0625rem solid var(--color-line)",
            background: active ? accent : "var(--color-panel2)",
            color: active ? "#15120c" : "var(--color-ink)",
            fontWeight: 800,
            lineHeight: 1,
            cursor: "pointer",
            boxShadow: active
              ? `0 0.5rem 1.375rem color-mix(in oklab, ${accent} 45%, transparent)`
              : "0 0.5rem 1.25rem rgba(0,0,0,.45)",
            // 閉じている間は角ボタン位置(x=LEFT0)に畳む → 開くと各自の位置へ右スライド。
            transform: open ? "translateX(0) scale(1)" : `translateX(${LEFT0 - x}cqw) scale(.92)`,
            opacity: open ? 1 : 0,
            pointerEvents: open ? "auto" : "none",
            transition:
              "transform .3s cubic-bezier(.2,.85,.3,1.1), opacity .18s, background .15s, border-color .15s",
            transitionDelay: open ? `${i * 45}ms` : "0ms",
          };
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              className={OPTION_SIZE}
              style={style}
              onClick={() => {
                onChange(id); // その麺の硬さ別茹で時間で endTime を引き直す（親が adjust を発行）
                setOpenAnd(false); // 選択＝確定して閉じる
              }}
            >
              {FIRMNESS_LABEL[id]}
            </button>
          );
        })}
      </div>

      {/* iPhone（狭カード）専用: スロット全面を 2×2 で覆う大ボタン。狭カードでだけ grid で現れる（既定は hidden）。
          押しやすさを最大化するため各セルいっぱいに広げる。開閉は opacity/scale でアニメート（座標計算は不要）。 */}
      <div
        role="radiogroup"
        aria-label="Firmness"
        className={cn(
          // 上端はバッジ（SlotCard・z-7）の下から始めて被らない。左右下は 0.5rem。バッジ選択中も上部にバッジが見える。
          "absolute top-[3.5rem] right-[0.5rem] bottom-[0.5rem] left-[0.5rem] z-[5] hidden grid-cols-2 grid-rows-2 gap-[0.5rem] @max-[240px]:grid",
          "transition-[opacity,transform] duration-150",
          open ? "opacity-100" : "pointer-events-none scale-95 opacity-0",
        )}
      >
        {FIRMNESS_ORDER.map((id) => {
          const active = id === value;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              className={cn(
                "grid place-items-center rounded-[0.875rem] text-[1.0625rem] leading-none font-extrabold whitespace-nowrap",
                active ? "border-0" : "border border-line",
              )}
              style={{
                // 不透明。背後は透かさず、残り時間はバッジ右端へ寄せたクロックで見せる（SlotCard 側）。
                background: active ? accent : "var(--color-panel2)",
                color: active ? "#15120c" : "var(--color-ink)",
                boxShadow: active
                  ? `0 0.5rem 1.375rem color-mix(in oklab, ${accent} 40%, transparent)`
                  : "0 0.5rem 1.25rem rgba(0,0,0,.45)",
              }}
              onClick={() => {
                onChange(id); // その麺の硬さ別茹で時間で endTime を引き直す（親が adjust を発行）
                setOpenAnd(false); // 選択＝確定して閉じる
              }}
            >
              {FIRMNESS_LABEL[id]}
            </button>
          );
        })}
      </div>
    </>
  );
}
