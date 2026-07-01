// client/components/Logo.tsx — アプリのワードマーク「BOILIT」。
//
// 文字はアプリ既定フォント（Manrope 800・uppercase）の実テキストで描き、O だけを SVG の鍋に差し替える。
// こうすることで B/I/L/I/T は既存ヘッダーのワードマークと同じフォント・字送りに必然的に一致し、
// 特別扱いするのは「鍋の O」ただ一点に絞られる。配色は @theme の SSOT トークン（text-ink / --color-brand）
// から取り、この単位では色を宣言しない。鍋の中の三点は茹で加減インジケータ（麺）のモチーフ。

import { cn } from "../cn";

/** ワードマークの O ＝俯瞰した鍋（琥珀のリング）と、麺を表す三点。文字と同じ em を基準に cap 高へ揃える。 */
function PotO() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      fill="none"
      className="mx-[0.03em] h-[0.82em] w-[0.82em] translate-y-[-0.02em]"
    >
      {/* 鍋のリング。文字の重量（800）に釣り合う太リング。 */}
      <circle cx="50" cy="50" r="37" stroke="var(--color-brand)" strokeWidth="16" />
      {/* 麺の三点（茹で加減の三点モチーフ）。中心やや下に寄せて鍋に浮かべる。 */}
      <circle cx="40" cy="57" r="7.5" fill="var(--color-brand)" />
      <circle cx="57" cy="53" r="6" fill="var(--color-brand)" />
      <circle cx="56" cy="66" r="5" fill="var(--color-brand)" />
    </svg>
  );
}

/** ワードマーク BOILIT。role="img" + aria-label で全体を一つのロゴとして読み上げる。 */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="BoilIt"
      className={cn(
        "inline-flex select-none items-center font-extrabold uppercase leading-none tracking-[.04em] text-ink",
        className,
      )}
    >
      <span aria-hidden="true">B</span>
      <PotO />
      <span aria-hidden="true">ILIT</span>
    </span>
  );
}
