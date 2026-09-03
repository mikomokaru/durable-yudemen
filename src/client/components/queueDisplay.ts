// client/components/queueDisplay.ts — 待ち行列 1 行の表示状態を導出する純粋関数。
// WS も DOM も触れない。受信ビュー（待ち行列と推奨の全量）・担当ユニット集合・現在時刻 now から、
// 表示集合を毎描画導出する（保持は全量・表示は導出／slotDisplay.ts と同じ規律）。
//
// 待ち時間（waitingMs）は状態ではない。arrivalTime（事実）と補正後現在時刻からの導出値であり、
// 描画のたびに算出する（残り秒と同じ扱い）。推奨も同様に、担当範囲での絞り込みと開始に要る茹で秒の
// 引き当てをここで導き、ビューには写しだけを置く。

import type { PendingOrder } from "../../domain/order";
import type { NoodlePreset } from "../../domain/store";
import type { NonEmptyArray } from "../../domain/timer";
import type { ClientView } from "../connection";
import { correctedNow } from "../clock";
import { assignedBySlots } from "../assignment";

/**
 * 担当範囲内の推奨（提案）— そこから開始するのに要る事実がすべて揃った形。
 *
 * 指示ではなく提案である。startAt が到来しても何も起こらない（自動開始しない・AC 8.2）。過ぎた startAt は
 * サーバの次回再評価で置き換わるまで過去時刻のまま提示される——client は時刻到来を契機に何もしない。
 */
export interface QueueSuggestion {
  /** 推奨する slot（釜）。ワイヤの生配列を境界で非空へ確立してから運ぶ。 */
  readonly slotIds: NonEmptyArray<string>;
  /** 推奨する開始の絶対時刻（サーバ基準のエポックミリ秒）。 */
  readonly startAt: number;
  /** 開始に用いる茹で秒。noodleType × firmness で麺種プリセットから引いた導出値。 */
  readonly boilSeconds: number;
}

/**
 * 待ち行列 1 行の表示状態。
 *
 * suggestion が null な行は「この端末の担当範囲に提案が無い」ことだけを意味する。理由は問わない
 * ——計画対象の上限を超えている・他ユニットへ提案されている・麺種が現在のプリセットに無いのいずれでも
 * 一様に「提案なし」へ畳む。人はいつでも既存の開始経路（スロットのラジアル）で好きに始められるため、
 * 理由の内訳を現場へ持ち出す必要がない（機械は指示しない）。
 */
export interface QueueEntry {
  /** 未着手オーダーの事実そのもの（サーバ由来の写し）。 */
  readonly order: PendingOrder;
  /** 到着から現在までの経過（ミリ秒・導出値）。負にはしない。 */
  readonly waitingMs: number;
  /** 担当範囲内の提案。無ければ null。 */
  readonly suggestion: QueueSuggestion | null;
}

/**
 * 待ち行列の全件について表示状態を到着順で導出する。
 *
 * 並びは（arrivalTime 昇順, externalOrderId 昇順, itemIndex 昇順）。第 2・第 3 の鍵はサーバ側の計画対象の
 * 整列と同じで、同時到着でも端末間・再描画間で並びが揺れない（同じ事実からは同じ見え方）。
 *
 * 件数は絞らない。計画対象の上限を超える分も待ち行列には現れ、提案が付かないだけである（AC 2.4 / 8.1）。
 * 提案は担当スロット範囲で絞る（assignedBySlots の any-overlap＝Timer の担当絞り込みと同一判定）。
 */
export function orderQueueEntries(
  view: ClientView,
  units: readonly number[],
  now: number,
): readonly QueueEntry[] {
  const corrected = correctedNow(view.offset, now);
  // 担当範囲内の推奨を品目の鍵で引けるよう束ねる。表示は品目単位の事象である。
  const suggested = new Map<string, QueueSuggestion>();
  for (const recommendation of assignedBySlots(view.recommendations, units)) {
    const slotIds = recommendation.slotIds; // 非空はワイヤ境界（domain/wire.ts）が確立済み
    const boilSeconds = boilSecondsOf(view.noodlePresets, recommendation, view.pendingOrders);
    if (boilSeconds === null) continue; // 茹で秒を引けない提案は開始できない＝提案として成立しない
    suggested.set(itemKey(recommendation.externalOrderId, recommendation.itemIndex), {
      slotIds,
      startAt: recommendation.startAt,
      boilSeconds,
    });
  }

  return [...view.pendingOrders]
    .sort(
      (a, b) =>
        a.arrivalTime - b.arrivalTime ||
        compareText(a.externalOrderId, b.externalOrderId) ||
        a.itemIndex - b.itemIndex,
    )
    .map((order) => ({
      order,
      waitingMs: Math.max(0, corrected - order.arrivalTime),
      suggestion: suggested.get(itemKey(order.externalOrderId, order.itemIndex)) ?? null,
    }));
}

/** 品目の鍵（externalOrderId と itemIndex の組）。推奨と Pending_Order を突き合わせる唯一の同定手段。 */
function itemKey(externalOrderId: string, itemIndex: number): string {
  return `${externalOrderId}\u0000${itemIndex}`;
}

/**
 * 推奨の対象品目の茹で秒を麺種プリセットから引く（noodleType × firmness）。
 *
 * 茹で秒は Pending_Order も推奨も持たない導出値ゆえ、開始の直前にここで引く。対象品目が待ち行列に無い、
 * または麺種が現在のプリセットに無い（設定差し替えの過渡）ときは null——開始できない提案は出さない。
 */
function boilSecondsOf(
  presets: readonly NoodlePreset[],
  recommendation: { readonly externalOrderId: string; readonly itemIndex: number },
  pending: readonly PendingOrder[],
): number | null {
  const order = pending.find(
    (candidate) =>
      candidate.externalOrderId === recommendation.externalOrderId &&
      candidate.itemIndex === recommendation.itemIndex,
  );
  if (order === undefined) return null;
  const preset = presets.find((candidate) => candidate.noodleType === order.noodleType);
  if (preset === undefined) return null;
  return preset.boilSeconds[order.firmness];
}

/** 文字列の全順序（並びを決定的にするための第 2 の鍵）。 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
