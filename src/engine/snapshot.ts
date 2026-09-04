// core/snapshot.ts — 永続層の形（単一キー・version 付きスナップショット）と、状態との純粋変換。
// cloudflare:workers にも storage にも触れない純粋モジュール。

import { CURRENT_SCHEMA_VERSION } from "../engine/types";
import type { TimerState } from "./state";
import type { Timer } from "./timer";
import type { AcceptedSlice } from "./schedule";
import type { InputDigest } from "./digest";
import type { PendingOrder } from "../domain/order";

/**
 * StoreSnapshot — 永続層に単一キーで丸ごと put / get する「店舗の全状態」の形。
 *
 * スキーマバージョンを含む（要件11）。version は常に現行スキーマバージョンに一致する。
 * v7 で覆う範囲が Timer だけでなくなった（Pending_Order・採用済み計画・指紋）ため、
 * 名は StoreConfig / StoreTimerDO と同じ Store 接頭辞で「店舗の全状態」を表明する。
 * ストレージキー "activeTimers"（shell/store-timer-do.ts）は最初に置かれた場所の名として据え置く——
 * 世代管理は version が担い、キー名は永続層の内部詳細で外に漏れていない（design.md）。
 */
export interface StoreSnapshot {
  /** スキーマバージョン。現行は v10（CURRENT_SCHEMA_VERSION）。 */
  readonly version: typeof CURRENT_SCHEMA_VERSION;
  /** アクティブな全 Timer。engine 専用の adjustment / orderItem を含む（欠如は migrate が埋める）。 */
  readonly timers: readonly Timer[];
  /** 次に割り当てる登録順（seq）。 */
  readonly nextSeq: number;
  /** 未着手オーダーの品目集合（正本・v7）。 */
  readonly pendingOrders: readonly PendingOrder[];
  /** 採用済み外部計画の一片（再計算では復元できない事実・v7）。 */
  readonly acceptedSlices: readonly AcceptedSlice[];
  /** 直前に外部計画を要求した時点の入力の指紋（v7）。null は未要求。 */
  readonly requestedDigest: InputDigest | null;
  /**
   * 端末ごとの「最後に受理した sequence_number」（v8）。
   *
   * 別キーに置かないのは、Pending_Order 集合と別の `put` になれば「判定材料だけ進んで注文が無い」欠落が
   * 生じ、その注文は再送でも重複として弾かれて永久に失われるためである（state.ts と同じ根拠）。
   */
  readonly lastSequenceByTerminal: Readonly<Record<string, string>>;
}

/**
 * 状態 → スナップショット（純粋）。
 *
 * version は常に現行スキーマバージョンを名乗る（要件11.1）。永続化の起点は常にこの形で、
 * 「いま書くものは必ず現行版」という事実をここ一箇所で表明する。
 * 状態のフィールドはすべてそのまま写す（状態は残り秒も Committed_Plan も持たない事実だけなので、
 * 落とす情報はない）。timers 内の adjustment / orderItem（engine 専用）も Timer 型に含まれるため丸ごと乗る。
 */
export function toSnapshot(state: TimerState): StoreSnapshot {
  return {
    version: CURRENT_SCHEMA_VERSION,
    timers: state.timers,
    nextSeq: state.nextSeq,
    pendingOrders: state.pendingOrders,
    acceptedSlices: state.acceptedSlices,
    requestedDigest: state.requestedDigest,
    lastSequenceByTerminal: state.lastSequenceByTerminal,
  };
}

/**
 * スナップショット → 状態（純粋）。version 検証は migrate が担うため、ここでは形の写しに徹する。
 *
 * 状態は version を持たない（version は永続層の関心事であって、業務状態の事実ではない）。
 * その一枚を剥がすだけなので、往復（fromSnapshot(toSnapshot(state))）で情報は落ちない。
 */
export function fromSnapshot(snapshot: StoreSnapshot): TimerState {
  return {
    timers: snapshot.timers,
    nextSeq: snapshot.nextSeq,
    pendingOrders: snapshot.pendingOrders,
    acceptedSlices: snapshot.acceptedSlices,
    requestedDigest: snapshot.requestedDigest,
    lastSequenceByTerminal: snapshot.lastSequenceByTerminal,
  };
}
