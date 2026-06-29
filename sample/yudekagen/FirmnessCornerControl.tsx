import { useEffect, useState, type CSSProperties } from "react";
import { FIRMNESS_LEVELS, type Firmness } from "./firmness";

export interface FirmnessCornerControlProps {
  /** 現在の硬さ */
  value: Firmness;
  /** 硬さを選んだとき（親で endsAt を引き直す → 残り時間が再計算される） */
  onChange: (next: Firmness) => void;
  /**
   * メニュー開閉の通知。開いている間、親カードは STOP ボタンを隠す想定
   * （= 角ボタンの展開と STOP の衝突を避ける）。
   */
  onOpenChange?: (open: boolean) => void;
  /** その麺種のアクセント色（選択中ボタン・枠に使う） */
  accent?: string;
}

// レイアウト定数（プロトタイプと同値）
const W = 90;     // 選択肢ボタン幅
const H = 78;     // 選択肢ボタン高さ
const GAP = 10;
const LEFT0 = 14; // 先頭ボタンの左位置（角ボタンに重なる）
const BOTTOM = 16;

/**
 * boiling 相カードの「左下・角融合」茹で加減コントロール。
 *
 * 使い方：boiling 中のカード（position: relative）の中に置くだけ。
 *   <div style={{ position: "relative", ... }}>
 *     ...タイマー表示...
 *     {menuOpen ? null : <StopButton />}        // open 中は STOP を隠す
 *     <FirmnessCornerControl
 *       value={firmness}
 *       onChange={applyFirmness}
 *       onOpenChange={setMenuOpen}
 *       accent={noodleColor}
 *     />
 *   </div>
 *
 * 挙動：
 *  - 角ボタン（現在の硬さを表示）をタップ → 硬さ4段が右へスライド展開
 *  - 角ボタンはフェードし、先頭(バリカタ)がその位置に来る（ボタンが行に変身）
 *  - 選択肢をタップ → onChange + 自動で閉じる（確定ボタン不要）
 *  - 背景（薄いカバー）タップ / Esc で閉じる
 *  - デフォルト「ふつう」のままなら角ボタンを触る必要なし（操作コスト0）
 */
export function FirmnessCornerControl({
  value,
  onChange,
  onOpenChange,
  accent = "#e8c07a",
}: FirmnessCornerControlProps) {
  const [open, setOpen] = useState(false);

  const setOpenAnd = (next: boolean) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isDefault = value === "ふつう";

  // 角ボタン（開いている間はフェードして先頭ボタンに席を譲る）
  const cornerStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    bottom: 0,
    zIndex: 6,
    width: 126,
    height: 92,
    padding: "0 0 14px 18px",
    display: "flex",
    alignItems: "flex-end",
    border: 0,
    borderRadius: "0 20px 0 16px", // 外側(左下)はカード角、内側(右上)だけ丸める＝角融合
    background: isDefault ? "#4a4030" : "#6b5a30",
    boxShadow: isDefault ? "none" : "0 0 0 1px #caa24e inset",
    color: isDefault ? "#cbbd9c" : "#f3e2b6",
    fontSize: 25,
    fontWeight: 800,
    lineHeight: 1.05,
    cursor: "pointer",
    opacity: open ? 0 : 1,
    pointerEvents: open ? "none" : "auto",
    transition: "background .15s, box-shadow .15s, opacity .15s",
  };

  return (
    <>
      {/* 薄いカバー：他要素を隠さず軽く沈める。タップで閉じる */}
      <div
        onClick={() => setOpenAnd(false)}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 4,
          background: "rgba(10,8,5,.42)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity .18s",
        }}
      />

      {/* 角ボタン */}
      <button type="button" onClick={() => setOpenAnd(!open)} style={cornerStyle}>
        {value}
      </button>

      {/* 右へスライド展開する硬さ選択（硬い→柔らかいの順） */}
      <div style={{ position: "absolute", left: 0, bottom: 0, width: 0, height: 0, zIndex: 5 }}>
        {FIRMNESS_LEVELS.map((level, i) => {
          const x = LEFT0 + i * (W + GAP);
          const active = level.id === value;
          const style: CSSProperties = {
            position: "absolute",
            left: x,
            bottom: BOTTOM,
            width: W,
            height: H,
            borderRadius: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: active ? 0 : "1px solid #4a4233",
            background: active ? accent : "#23201a",
            color: active ? "#241c08" : "#ece4d2",
            fontSize: 19,
            fontWeight: 800,
            lineHeight: 1,
            cursor: "pointer",
            boxShadow: active
              ? "0 8px 22px rgba(232,192,122,.45)"
              : "0 8px 20px rgba(0,0,0,.45)",
            // 閉じている間は角ボタン位置(x=LEFT0)に畳んでおく → 開くと各自の位置へ右スライド
            transform: open ? "translateX(0) scale(1)" : `translateX(${LEFT0 - x}px) scale(.92)`,
            opacity: open ? 1 : 0,
            pointerEvents: open ? "auto" : "none",
            transition:
              "transform .3s cubic-bezier(.2,.85,.3,1.1), opacity .18s, background .15s, border-color .15s",
            transitionDelay: open ? `${i * 45}ms` : "0ms",
          };
          return (
            <button
              key={level.id}
              type="button"
              style={style}
              onClick={() => {
                onChange(level.id); // 親で endsAt を引き直す（残り時間が即再計算）
                setOpenAnd(false);  // 選択＝確定して閉じる
              }}
            >
              {level.id}
            </button>
          );
        })}
      </div>
    </>
  );
}
