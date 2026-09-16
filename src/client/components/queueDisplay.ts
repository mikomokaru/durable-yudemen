// client/components/queueDisplay.ts — 待ち行列 1 行の表示状態を導出する純粋関数。
// WS も DOM も触れない。受信ビュー（待ち行列と推奨の全量）・担当ユニット集合・現在時刻 now から、
// 表示集合を毎描画導出する（保持は全量・表示は導出／slotDisplay.ts と同じ規律）。
//
// 待ち時間（waitingMs）は状態ではない。arrivalTime（事実）と補正後現在時刻からの導出値であり、
// 描画のたびに算出する（残り秒と同じ扱い）。推奨も同様に、担当範囲での絞り込みと開始に要る茹で秒の
// 引き当てをここで導き、ビューには写しだけを置く。
//
// 待ち行列そのものも、読むのは wire の品目全件（`orderItems`＝期限内 ∨ 生きた Timer の参照先）ではなく未調理の品目
// （`pendingOrders(items, timers, now)`＝期限内 ∧ unstarted）である（pending-order-expiry AC 3.1・order-lifecycle
// AC 4.5）。snapshot は調理中・調理済みの品目も運ぶ（釜のカードが参照で卓・品名を引くため）が、レールとラジアルには
// 出さない。snapshot の後に時刻が進んで寿命を跨ぐ品目も client が消す——次の snapshot を待たない。述語は domain の
// pendingOrders ただ一つで、client 側に別の式を書かない（AC 3.2）。絞った値は ClientView に持たない（時刻が進めば
// 古くなる導出値を保持しない・design 原則 1）。
//
// 時刻の契約（design Component 5）。引数名 `now` はローカル時計、`corrected` は補正済み（サーバ基準）の時計で、
// 混ぜない。部品の境界（SlotBoard と orderQueueEntries）だけが `now` を受けて correctedNow を **1 回** 計算し、
// その下（suggestedItemOf と liftGroups.ts の全部）は `corrected` を受けて内部で補正しない——二重補正の経路を
// 構造から無くす。

import type { LiftItem } from "../../domain/lift-group";
import type { CookRecommendation } from "../../domain/messages";
import {
  compareArrival,
  itemKeyOf,
  pendingOrders,
  type OrderItem,
  type WireOrderItem,
} from "../../domain/order";
import type { NoodlePreset } from "../../domain/store";
import type { NonEmptyArray } from "../../domain/timer";
import { mode, type ClientView } from "../connection";
import { correctedNow } from "../clock";
import { assignedBySlots } from "../assignment";

/**
 * 推奨（提案）— そこから開始するのに要る事実がすべて揃った形。
 *
 * 担当範囲で絞る前の形である。レール（orderQueueEntries）は担当範囲内の推奨からこれを組み、群の導出
 * （liftGroups）は受信した推奨の全量から組む（lift-group-display AC 1.1）——絞るのは呼び出し側で、提案の形は
 * 一つである。
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
 * 開始できる推奨——domain の LiftItem（推奨・品目・茹で秒）に、釜カードとレールが読む提案（QueueSuggestion）を
 * 重ねた形。
 *
 * `suggestion` の釜と時刻は `recommendation` と同じ値で、そこに `serveAt`（導出値）を添えたものである。二つの
 * 顔を持つのは、群の連鎖と Head の導出（domain/lift-group.ts）が推奨の形を読み、描画が提案の形を読むためで、
 * どちらも suggestedItemOf ただ一箇所で組む——同じ値を二つの式から作らない。
 */
export interface SuggestedItem extends LiftItem {
  readonly suggestion: QueueSuggestion;
}

/**
 * 推奨から、そこから開始できる提案とその品目を一度に組む。組めなければ null。
 *
 * レール（担当範囲の提案・orderQueueEntries）と群の導出（liftGroups）はどちらも「推奨 → 品目 → 茹で秒 → serveAt」
 * の順に辿る。この連鎖をここに一つだけ置き、鍵の突き合わせも茹で秒の引き当ても serveAt の等号も二度書かない。
 * 対象品目が待ち行列に無い推奨（追い越されて消えた・まだ届いていない・寿命を過ぎた）と、麺種が現在のプリセットに
 * 無い推奨（設定差し替えの過渡）は、開始できないので提案として成立しない（lift-group-display AC 1.3）。理由は
 * 分けない——人はいつでも既存の開始経路で始められ、理由の内訳を現場へ持ち出さない。
 *
 * 待ち行列は `corrected`（補正済み現在時刻）の未調理の品目（`pendingOrders`）で引く（pending-order-expiry AC 3.3・
 * order-lifecycle AC 4.5）——寿命を過ぎた品目や調理中・調理済みの品目を指す推奨は「待ち行列に無い推奨」と同じ経路で
 * 捨てる。`corrected` は境界（orderQueueEntries / SlotBoard）が 1 回計算した値を受けるだけで、ここでは補正しない。
 */
export function suggestedItemOf(
  view: ClientView,
  recommendation: CookRecommendation,
  corrected: number,
): SuggestedItem | null {
  const order = pendingItemOf(
    pendingOrders(view.orderItems, view.timers, corrected),
    recommendation,
  );
  if (order === undefined) return null;
  const boilSeconds = boilSecondsOf(view.noodlePresets, order);
  if (boilSeconds === null) return null;
  return {
    recommendation,
    order,
    boilSeconds,
    suggestion: {
      slotIds: recommendation.slotIds, // 非空はワイヤ境界（domain/wire.ts）が確立済み
      startAt: recommendation.startAt,
      boilSeconds,
      serveAt: recommendation.startAt + boilSeconds * 1000,
    },
  };
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
  /** 未調理の品目の事実そのもの（サーバ由来の写し・`interruptedAt` は一度戻された品目の色分けに読める）。 */
  readonly order: OrderItem;
  /** 到着から現在までの経過（ミリ秒・導出値）。負にはしない。 */
  readonly waitingMs: number;
  /** 担当範囲内の提案。無ければ null。 */
  readonly suggestion: QueueSuggestion | null;
}

/**
 * 待ち行列の全件について表示状態を到着順で導出する。
 *
 * 並びは到着順の全順序 compareArrival（domain/order.ts・同じ事実からは同じ見え方）。
 *
 * 件数は絞らない。計画対象の上限を超える分も待ち行列には現れ、提案が付かないだけである（AC 2.4 / 8.1）。
 * 絞るのは未調理（期限内 ∧ unstarted）だけ——並べるのは `corrected` の `pendingOrders(view.orderItems, view.timers,
 * corrected)` で、寿命を跨いだ品目は次の snapshot を待たずに消え（pending-order-expiry AC 3.1・性質 5.8）、生きた
 * Timer が指す調理中の品目と `completedAt` を持つ調理済みの品目は snapshot に載っていても現れない（order-lifecycle
 * AC 4.5・性質 7.6）。厨房 Cancel で戻った品目は unstarted ゆえ再び現れる。ラジアルの帯もこの結果を読むので、入口は
 * ここ一つである。提案は担当スロット範囲で絞る（assignedBySlots の any-overlap＝Timer の担当絞り込みと同一判定）。
 *
 * ここは時刻の境界である。ローカル時計 `now` を受け、補正済み `corrected` を 1 回だけ計算して下へ渡す。
 */
export function orderQueueEntries(
  view: ClientView,
  units: readonly number[],
  now: number,
): readonly QueueEntry[] {
  const corrected = correctedNow(view.offset, now);
  // degraded と、通信復旧後に snapshot / Reconcile で再整合するまでは列挙しない（order-lifecycle 判断 18）。pong だけで
  // connectivity は up になるが、それは最新 snapshot の適用済みを意味しない。未調理は「自分を指す生きた Timer が無い品目」
  // の導出で、通信断中にローカルで Timer だけを消す完了（boiled の LocalComplete・早め上げは走行中への complete → LocalComplete）は品目に
  // completedAt を書けないため、調理済みの品目が未調理として戻って見える（重複調理につながる表示）。サーバ未確定の
  // completedAt を client で書く代わりに、再接続の snapshot で復帰する。
  if (mode(view) !== "live" || view.awaitingResync) return [];
  // 担当範囲内の推奨を品目の鍵で引けるよう束ねる。表示は品目単位の事象である。
  const suggested = new Map<string, QueueSuggestion>();
  for (const recommendation of assignedBySlots(view.recommendations, units)) {
    const item = suggestedItemOf(view, recommendation, corrected);
    if (item === null) continue; // 開始できない推奨は提案として成立しない
    suggested.set(itemKeyOf(item.order), item.suggestion);
  }

  return [...pendingOrders(view.orderItems, view.timers, corrected)]
    .sort(compareArrival)
    .map((order) => ({
      order,
      waitingMs: Math.max(0, corrected - order.arrivalTime),
      suggestion: suggested.get(itemKeyOf(order)) ?? null,
    }));
}

/**
 * 品目の表示名。POS 申告の商品名を優先し、無ければ麺種名で代替する（pos-order-ingress 要件 5.3）。
 *
 * 表示のたびに NFKC 正規化する——半角カナ（`"ﾈｷﾞ丼"`）を全角へ寄せるのは表示の関心事であり、永続値は
 * 申告のままである（要件 4.5 / 5.5）。
 *
 * **語は 2 つの軸で短くなる**（item-display-abbreviation）。商品名はサーバが被せた札を使い、麺量は固定表で
 * 1 文字に畳む（`普通` は区切りごと消える）。**札は「あるかもしれないもの」である**——無ければ本 spec 以前と
 * 同じ全名を返す。札は上書きであって前提ではない。
 *
 * **異なる品目が同じ札を持っていても扱いを変えない。** 一意性は保証されない（判断 7）。
 *
 * レール・釜カードの提案・ラジアルの待ち行列は同じ品目を同じ語で呼ぶ必要があり、代替と正規化の規則を
 * 描画側へ散らせば三つの真実になる。語を組むのはここだけで、描画側は受け取った文字列を置くだけである。
 */
/**
 * 麺量名 → 表示（item-display-abbreviation 判断 8）。実データの麺量は 4 種しかなく
 * （`普通` 61.7% / `中盛` 22.6% / `大盛` 14.0% / `半玉` 1.7%）、店舗によって変わらない。
 *
 * **`中盛` / `大盛` / `半玉` はそのまま出す**（2026-09-15 改訂）。当初は 1 文字へ畳んでいたが、`醤油中盛` /
 * `味噌大盛` のように語のまま読める方が現場の語彙に近い。**`普通` だけは区切りごと消す。**
 *
 * **`普通` を表から外さない。** 外すと「表に無い麺量」と同じ扱い（空白区切り）に落ちる。空文字を
 * 置くことで「表に在る」と「表示する」を分ける——在るが何も表示しない、が `普通` の正しい扱いである。
 * 値が鍵と同じ 3 語についても、表に在ることは意味を持つ——**区切りを置かない**のは表に在る語だけである。
 *
 * 設定にしないのは、4 語しかなく既定がどれかも店舗に依らないためである。設定項目にすれば投入漏れの面が
 * 増えるだけで、得るものが無い。
 */
const SIZE_LABEL: ReadonlyMap<string, string> = new Map([
  ["普通", ""],
  ["中盛", "中盛"],
  ["大盛", "大盛"],
  ["半玉", "半玉"],
]);

export function displayName(order: WireOrderItem): string {
  const declared = (order.itemName ?? order.noodleType).normalize("NFKC");
  // **札はサーバが被せたものをそのまま使う。** client は辞書を持たない（判断 20）——引数は品目 1 つだけで、
  // 札が無ければ全名へ戻る。`shortName` は `itemName` に対してだけ付くので、`noodleType` 代替のときは現れない。
  const head = order.shortName ?? declared;
  const size = order.sizeName?.normalize("NFKC");
  if (size === undefined) return head;
  const label = SIZE_LABEL.get(size);
  // 表に在れば区切り無しで連結する（`普通` は空文字ゆえ何も付かない）。無ければ従来どおり空白区切りで
  // 全名を添える——知らない麺量を機械的に 1 字へ削ると、`特盛`→`特` のように札と紛らわしくなる。
  return label === undefined ? `${head} ${size}` : `${head}${label}`;
}

/** 推奨が指す品目を待ち行列から引く（品目の鍵で 1 品目を指す・domain の itemKeyOf）。無ければ undefined。 */
function pendingItemOf(
  pending: readonly OrderItem[],
  recommendation: CookRecommendation,
): OrderItem | undefined {
  const key = itemKeyOf(recommendation);
  return pending.find((candidate) => itemKeyOf(candidate) === key);
}

/**
 * 品目の茹で秒を麺種プリセットから引く（noodleType × firmness）。
 *
 * 茹で秒は Pending_Order も推奨も持たない導出値ゆえ、開始の直前にここで引く。麺種が現在のプリセットに無い
 * （設定差し替えの過渡）ときは null——開始できない提案は出さない。計画側（schedule.ts の toBoiling）と同じ
 * 引き方で、startAt + 茹で秒 は両端で整数ミリ秒として一致する（lift-group-display 観測事実 9）。serveAt の
 * 等号はここでは組まない——組むのは suggestedItemOf だけである。
 */
function boilSecondsOf(presets: readonly NoodlePreset[], order: OrderItem): number | null {
  const preset = presets.find((candidate) => candidate.noodleType === order.noodleType);
  if (preset === undefined) return null;
  return preset.boilSeconds[order.firmness];
}
