// client/format.ts — 残りミリ秒を MM:SS 文字列へ整形する純粋関数。
// 副作用なし・決定的（同じ入力に同じ出力）。残り秒は状態ではなく導出値であり、
// その導出値を「人が読む形」へ写すだけの最終段。表示の都合をここに閉じ込める。

/**
 * 非負の残りミリ秒を MM:SS 形式へ整形する。
 *
 * 最小単位は 1 秒（切り捨て＝Math.floor）。クロック側で max(0, ...) 済みの前提だが、
 * 負の入力を渡されても 00:00 相当へ正規化し、負の時間を決して表示しない（要件5.6）。
 * 分・秒はそれぞれ 2 桁ゼロ詰め。最大茹で時間 1800 秒は "30:00"。分は 2 桁を下限とし、
 * 99 分を超える場合は自然に桁が伸びる。
 *
 * 要件5.4（MM:SS・最小単位 1 秒）/ 要件5.6（負を出さない）
 */
export function formatRemaining(remainingMs: number): string {
  // 負・NaN は 0 へ正規化（負の残り時間を表示しない）。
  const safeMs = remainingMs > 0 ? remainingMs : 0;
  // 最小単位 1 秒。端数は切り捨てる。
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

/** 2 桁ゼロ詰め（2 桁を下限とし、超過分は伸ばす）。 */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
