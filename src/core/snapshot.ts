// core/snapshot.ts — 永続層の形（単一キー・version 付きスナップショット）と、状態との純粋変換。
// cloudflare:workers にも storage にも触れない純粋モジュール。

import { CURRENT_SCHEMA_VERSION } from "./types";
import type { TimerState } from "./state";
import type { Timer } from "./timer";

/**
 * ActiveTimersSnapshot — 永続層に単一キー（"activeTimers"）で丸ごと put / get する形。
 *
 * スキーマバージョンを含む（要件11）。version は常に現行スキーマバージョンに一致する。
 */
export interface ActiveTimersSnapshot {
  /** スキーマバージョン。現行は 1。 */
  readonly version: typeof CURRENT_SCHEMA_VERSION;
  /** アクティブな全 Timer。 */
  readonly timers: readonly Timer[];
  /** 次に割り当てる登録順（seq）。 */
  readonly nextSeq: number;
}

/**
 * 状態 → スナップショット（純粋）。
 *
 * version は常に現行スキーマバージョンを名乗る（要件11.1）。永続化の起点は常にこの形で、
 * 「いま書くものは必ず現行版」という事実をここ一箇所で表明する。
 * timers / nextSeq はそのまま写す（状態は残り秒を持たない事実だけなので、落とす情報はない）。
 */
export function toSnapshot(state: TimerState): ActiveTimersSnapshot {
  return {
    version: CURRENT_SCHEMA_VERSION,
    timers: state.timers,
    nextSeq: state.nextSeq,
  };
}

/**
 * スナップショット → 状態（純粋）。version 検証は migrate が担うため、ここでは形の写しに徹する。
 *
 * 状態は version を持たない（version は永続層の関心事であって、業務状態の事実ではない）。
 * その一枚を剥がすだけなので、往復（fromSnapshot(toSnapshot(state))）で情報は落ちない。
 */
export function fromSnapshot(snapshot: ActiveTimersSnapshot): TimerState {
  return {
    timers: snapshot.timers,
    nextSeq: snapshot.nextSeq,
  };
}
