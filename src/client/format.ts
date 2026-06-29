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

/**
 * 残り時間の表示分解。分の有無でレイアウト（分・秒のサイズ差）を切り替えるための構造化出力。
 *  - withMinutes: 1 分以上。分を大きく・秒を小さく出す。
 *  - secondsOnly: 1 分未満。秒だけを大きく出す。
 */
export type RemainingParts =
  | { readonly kind: "withMinutes"; readonly minutes: string; readonly seconds: string }
  | { readonly kind: "secondsOnly"; readonly seconds: string };

/**
 * 非負の残りミリ秒を、サイズ差をつけて表示するための分・秒へ分解する純粋関数。
 *
 * 丸めは formatRemaining と同一（最小単位 1 秒・切り捨て・負/NaN は 0）で、二つの真実を作らない。
 *  - 1 分以上: minutes（ゼロ詰めなし）＋ seconds（2 桁ゼロ詰め "MM:SS" の SS 相当）。
 *  - 1 分未満: seconds のみ（ゼロ詰めなし）。
 */
export function remainingParts(remainingMs: number): RemainingParts {
  const safeMs = remainingMs > 0 ? remainingMs : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 1) {
    return { kind: "withMinutes", minutes: String(minutes), seconds: pad2(seconds) };
  }
  return { kind: "secondsOnly", seconds: String(seconds) };
}
