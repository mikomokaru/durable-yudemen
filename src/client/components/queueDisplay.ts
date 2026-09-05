// client/components/queueDisplay.ts — 待ち行列 1 行の表示状態を導出する純粋関数。
// WS も DOM も触れない。受信ビュー（待ち行列と推奨の全量）・担当ユニット集合・現在時刻 now から、
// 表示集合を毎描画導出する（保持は全量・表示は導出／slotDisplay.ts と同じ規律）。
//
// 待ち時間（waitingMs）は状態ではない。arrivalTime（事実）と補正後現在時刻からの導出値であり、
// 描画のたびに算出する（残り秒と同じ扱い）。推奨も同様に、担当範囲での絞り込みと開始に要る茹で秒の
// 引き当てをここで導き、ビューには写しだけを置く。

import type { CookRecommendation } from "../../domain/messages";
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
  /**
   * 上がる時刻（`startAt + boilSeconds × 1000`・導出値）。
   *
   * 計画は同じ卓の品目の serveAt を揃えて出す（lift-group-planning）が、ワイヤは startAt しか運ばない
   * （観測事実 10）。この等号を計算するのは suggestedItemOf ただ一箇所で、レール（担当範囲の提案）も群の導出
   * （liftGroups）もその値を受け取るだけである——群の鍵（同じ卓で serveAt が等しい・lift-group-display
   * AC 1.1 / 1.2）を組む左辺を、二つの式から作らない。
   * 注文への参照は足さない——注文を指すのは GroupItem.order / QueueEntry.order で、提案は釜と時刻だけを語る。
   */
  readonly serveAt: number;
}

/**
 * 推奨から、そこから開始できる提案とその品目を一度に組む。組めなければ null。
 *
 * レール（担当範囲の提案・orderQueueEntries）と群の導出（liftGroups）はどちらも「推奨 → 品目 → 茹で秒 → serveAt」
 * の順に辿る。この連鎖をここに一つだけ置き、鍵の突き合わせも茹で秒の引き当ても serveAt の等号も二度書かない。
 * 対象品目が待ち行列に無い推奨（追い越されて消えた・まだ届いていない）と、麺種が現在のプリセットに無い推奨
 * （設定差し替えの過渡）は、開始できないので提案として成立しない（lift-group-display AC 1.3）。理由は分けない
 * ——人はいつでも既存の開始経路で始められ、理由の内訳を現場へ持ち出さない。
 */
export function suggestedItemOf(
  view: ClientView,
  recommendation: CookRecommendation,
): { readonly order: PendingOrder; readonly suggestion: QueueSuggestion } | null {
  const order = pendingItemOf(view.pendingOrders, recommendation);
  if (order === undefined) return null;
  const boilSeconds = boilSecondsOf(view.noodlePresets, order);
  if (boilSeconds === null) return null;
  return {
    order,
    suggestion: {
      slotIds: recommendation.slotIds, // 非空はワイヤ境界（domain/wire.ts）が確立済み
      startAt: recommendation.startAt,
      boilSeconds,
      serveAt: recommendation.startAt + boilSeconds * 1000,
    },
  };
}

/**
 * SuggestionTiming — 提案の時期の 3 相。
 *
 * `now` は `ms` を持たない。常に 0 である項目は情報を持たない（`predicate.ts` の `toDeclaredName` が
 * 常に true の `ok` を持たないのと同じ判断）。
 *
 * **`countdown` の `ms` は錨までの残りではない。** 錨までの残り（Start_Lead）に計画内オフセットを
 * 足した値＝**この提案自身の開始までの残り**である。ゆえに `lead` と名付けない——語彙が食い違う。
 */
export type SuggestionTiming =
  | { readonly kind: "countdown"; readonly ms: number }
  | { readonly kind: "now" }
  | { readonly kind: "offset"; readonly ms: number };

/**
 * suggestionTiming — 提案の時期を決める（lapsed-suggestion-timing 要件 1）。
 *
 * 時期は 2 つの導出値から成る。計画内オフセット（`startAt − 錨`＝1 本目からの間隔）はサーバの事実からの
 * 導出で、錨までの秒読み（`max(0, 錨 − 現在)`）は問うた時点で決まる。**受け取った `startAt` は書き換えない。**
 *
 * 錨（`planAnchor`）は受信した推奨の全量から取った最小 `startAt` である。担当範囲で絞った後に取ると
 * 端末ごとに錨が変わり、同じ計画が 2 台で違う間隔に見える（要件 2.2）。ゆえにこの関数は担当範囲を
 * 知らず、錨を引数で受ける。
 *
 * **秒読みが尽きたら別の相へ移る。** 1 本目を始めない限り錨は現在へ張り付き、オフセットは不変である。
 * 同じ秒読みとして描き続ければ減らない秒読みになる——減らない秒読みは嘘である（要件 3.1）。
 *
 * **文字列を作らない。** `mm:ss` の整形と語（`in` / `+`）は表示側（`SlotBoard`）が持つ。表示語彙を
 * 二箇所に置かない（`slot-suggested-start` の判断）。
 */
export function suggestionTiming(
  startAt: number,
  planAnchor: number,
  corrected: number,
): SuggestionTiming {
  const offset = startAt - planAnchor;
  const lead = Math.max(0, planAnchor - corrected);
  if (lead > 0) return { kind: "countdown", ms: lead + offset };
  return offset === 0 ? { kind: "now" } : { kind: "offset", ms: offset };
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
 * 並びは到着順の全順序 compareArrival（同じ事実からは同じ見え方）。
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
    const item = suggestedItemOf(view, recommendation);
    if (item === null) continue; // 開始できない推奨は提案として成立しない
    suggested.set(itemKey(item.order.externalOrderId, item.order.itemIndex), item.suggestion);
  }

  return [...view.pendingOrders].sort(compareArrival).map((order) => ({
    order,
    waitingMs: Math.max(0, corrected - order.arrivalTime),
    suggestion: suggested.get(itemKey(order.externalOrderId, order.itemIndex)) ?? null,
  }));
}

/**
 * 到着順の全順序（arrivalTime 昇順, externalOrderId 昇順, itemIndex 昇順）。
 *
 * 待ち行列の並びと、群の中で startAt が同値の品目の並び（lift-group-display AC 1.4）は同じ順序を要る。
 * 第 2・第 3 の鍵はサーバ側の計画対象の整列と同じで、同時到着でも端末間・再描画間で並びが揺れない。
 */
export function compareArrival(a: PendingOrder, b: PendingOrder): number {
  return (
    a.arrivalTime - b.arrivalTime ||
    compareText(a.externalOrderId, b.externalOrderId) ||
    a.itemIndex - b.itemIndex
  );
}

/** 品目の鍵（externalOrderId と itemIndex の組）。推奨と Pending_Order を突き合わせる唯一の同定手段。 */
function itemKey(externalOrderId: string, itemIndex: number): string {
  return `${externalOrderId}\u0000${itemIndex}`;
}

/** 推奨が指す品目を待ち行列から引く（品目の鍵で 1 品目を指す）。無ければ undefined。 */
function pendingItemOf(
  pending: readonly PendingOrder[],
  recommendation: CookRecommendation,
): PendingOrder | undefined {
  const key = itemKey(recommendation.externalOrderId, recommendation.itemIndex);
  return pending.find(
    (candidate) => itemKey(candidate.externalOrderId, candidate.itemIndex) === key,
  );
}

/**
 * 品目の茹で秒を麺種プリセットから引く（noodleType × firmness）。
 *
 * 茹で秒は Pending_Order も推奨も持たない導出値ゆえ、開始の直前にここで引く。麺種が現在のプリセットに無い
 * （設定差し替えの過渡）ときは null——開始できない提案は出さない。計画側（schedule.ts の toBoiling）と同じ
 * 引き方で、startAt + 茹で秒 は両端で整数ミリ秒として一致する（lift-group-display 観測事実 9）。serveAt の
 * 等号はここでは組まない——組むのは suggestedItemOf だけである。
 */
function boilSecondsOf(presets: readonly NoodlePreset[], order: PendingOrder): number | null {
  const preset = presets.find((candidate) => candidate.noodleType === order.noodleType);
  if (preset === undefined) return null;
  return preset.boilSeconds[order.firmness];
}

/** 文字列の全順序（並びを決定的にするための第 2 の鍵）。 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
