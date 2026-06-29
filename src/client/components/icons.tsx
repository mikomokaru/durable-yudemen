// client/components/icons.tsx — 操作ボタンのピクトグラム（オーディオ機器のメタファー）。
//
// 言語に依存しないピクトグラムで操作を表す（英語ラベルの置き換え）。アクセシブルネームは各ボタン側の
// aria-label が担い、ここの SVG は装飾として aria-hidden にする（読み上げを二重化しない）。
// 色は fill: currentColor でボタンのテキスト色を継ぐ（状態色との一貫性をボタン側 className で決める）。
//
//   Play（右向き三角） = Start    Stop（四角） = Cancel    上矢印（麺を上げる） = Complete

interface IconProps {
  readonly className?: string;
}

/** Play — 右向き三角。タイマー開始（オーディオの再生メタファー）。 */
export function PlayIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

/** Stop — 角丸の四角。走行中の中断（オーディオの停止メタファー）。 */
export function StopIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

/** Lift — 上矢印。茹で上がりの引き上げ＝明示完了（麺を上げる動作）。 */
export function LiftIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12 3l7 7h-4v8h-6v-8H5z" />
    </svg>
  );
}
