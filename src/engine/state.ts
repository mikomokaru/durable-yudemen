// core/state.ts — core が扱う状態。残り秒を持たない「事実」だけの集合。
// cloudflare:workers にも storage にも触れない純粋モジュール。

import type { Timer } from "./timer";

/**
 * TimerState — core の状態。
 *
 * 「これ以上分解できない事実」だけに絞る。残り秒は存在しない（導出値であって状態ではない）。
 * 状態はアクティブな Timer の集合と、次に割り当てる登録順だけ。
 */
export interface TimerState {
  /** アクティブな全 Timer。 */
  readonly timers: readonly Timer[];
  /** 次に割り当てる登録順（seq）。 */
  readonly nextSeq: number;
}

/** 空の初期状態。Timer なし・seq は 0 から。 */
export const EMPTY_STATE: TimerState = { timers: [], nextSeq: 0 };
