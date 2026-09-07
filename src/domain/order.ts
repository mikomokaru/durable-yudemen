// domain/order.ts — 注文品目（Order_Item）という事実の契約と、その状態の導出。同じ domain 内の語彙（firmness・timer・store）だけを取り込む。
//
// Order_Item は「POS 由来の 1 品目」であり、**生涯を通じて一つの事実として残る**（order-lifecycle 判断 1）。正本は DO の
// 永続層に置く（AC 2.1）。POS の状態を正本として参照しない——外部の可用性に待ち行列の真実を委ねると、瞬断のたびに
// 現場の見え方が揺れる。届いた事実をこちらで確定させ、確定した事実だけを配る。
//
// **状態（unstarted / cooking / done）は保存せず導出する。** 自分を指す生きた Timer（走行中・茹で上がりとも）が在れば
// cooking、無く `completedAt` が在れば done、どちらも無ければ unstarted（`itemStatusOf`）。「未調理」は保存された集合では
// なく関数（`pendingOrders`）である（判断 10）。
//
// なぜ TimerFact と別に立つか（timer-model.md の判定）:
//   1. 「両者で共有される事実か」→ client が待ち行列と推奨を表示するため、共有される事実である。
//      ゆえに片側専用（engine / client）ではなく domain に置く。
//   2. 「TimerFact を god type にしないか」→ Timer は「一回の調理の記録」、Order_Item は「注文の品目」。
//      占有する slot も endTime も持たない、基数も生存期間も違う概念である（Timer has 0..1 Order item）。
//      共有だからといって一つの型へ混ぜれば、共有の芯が片側都合で膨らみ、複雑性は抑制ではなく増幅に転じる。
//   3. 「概念が別なら名前を分ける」→ よって独立した契約として立てる。両者を結ぶのは Timer 側の参照
//      `orderItem`（{ externalOrderId; itemIndex }）ただ一つで、品目 → Timer の参照は状態に持たない（判断 2）。

import { isFirmness, type Firmness } from "./firmness";
import { isNonEmptyString, isNonNegativeInteger, isRecord, toDeclaredName } from "./predicate";
import { isNonEmpty, type NonEmptyArray } from "./timer";
import { SLOT_SPAN_MAX, SLOT_SPAN_MIN, type NoodlePreset } from "./store";

/**
 * OrderItem — 注文品目（旧 PendingOrder）。生涯を通じて一つの事実として残り、状態は `itemStatusOf` で導く。
 *
 * 茹で秒（boilSeconds）は持たない。StoreConfig.noodlePresets から noodleType × firmness で引ける導出値であり、
 * 持てば同じ真実が二箇所に生まれて必ずズレる（麺の設定変更が既存の待ち行列に反映されない、という形で現れる）。
 * Wait_Time も同様に持たない。arrivalTime（事実）と提供時刻からの導出値である。
 */
export interface OrderItem {
  /** POS 側の識別子。同一オーダーの再送（modification）を upsert する鍵。 */
  readonly externalOrderId: string;
  /** 同一オーダー内の品目連番。externalOrderId との組で 1 品目を一意に指す。 */
  readonly itemIndex: number;
  /** 麺の種類。茹で秒はここから StoreConfig 経由で引く。 */
  readonly noodleType: string;
  /** 茹で加減（安定 id・Firmness）。麺ごとの硬さ別茹で秒表のキー。 */
  readonly firmness: Firmness;
  /** Table_Group（同卓提供を揃える単位）の識別子。null は「その品目だけの単独グループ」。 */
  readonly tableId: string | null;
  /** Order_Arrival_Time（絶対時刻の事実）。Wait_Time の起点であり、待ち行列の並び順の基準。 */
  readonly arrivalTime: number;
  /**
   * 1 品目がスロット軸上で占める幅（SLOT_SPAN_MIN〜SLOT_SPAN_MAX）。麺量の指定から翻訳して定める。
   *
   * timer-model.md の判定を通した結果ここに置く——client が待ち行列を表示し engine が計画を組むのに要る
   * ため共有される事実であり、片側専用の関心事ではない。Timer.slotIds（割り当てられた実体）とは
   * 「要求」と「割当」の関係で別概念ゆえ、被せず別の名で立てる。
   */
  readonly slotSpan: number;
  /**
   * POS が申告した親品目の商品名。伝票に印字される文字列そのもの。
   *
   * 設定（StoreConfig.menuItems）に名前表を設けず申告値を持つのは、伝票の文字列と釜の画面の文字列を同じ
   * 出所にするためである。表を別に持てば投入漏れと改名のズレが起きる。**正規化しない**——半角カナ等の
   * 整形は表示時の導出であり、保存は事実のままとする。
   *
   * 欠落・空文字・型違いは null（Pass_Through）。null は「POS が名前を送っていない」という正常な入力で、
   * 表示は noodleType で代替する。
   */
  readonly itemName: string | null;
  /** POS が申告した麺量 child の商品名。slotSpan を決めた child と同じ同定結果から取る。欠落は null。 */
  readonly sizeName: string | null;
  /**
   * 完了の事実（厨房が完了を確定した時刻）。null は未完了。engine の `complete` だけが書く（判断 3）。
   *
   * 茹で上がり（Timer が boiled になる）とは別の事実である——時間が来ただけでは done にならない。
   */
  readonly completedAt: number | null;
  /**
   * 中断の事実（厨房 Cancel で調理が止められ未調理に戻った最後の時刻）。null は一度も中断されていない。
   * engine の `cancel` だけが書き、次の Cancel で上書きする。**状態には効かない**（判断 3′）——unstarted の条件は
   * 「生きた Timer なし ∧ completedAt なし」のままで、表示の色分けにだけ使う。
   */
  readonly interruptedAt: number | null;
}

/** Item_Status — 品目の状態。保存しない導出値（`itemStatusOf` が唯一の出所）。 */
export type ItemStatus = "unstarted" | "cooking" | "done";

/** 品目への参照（externalOrderId と itemIndex の組）。`Timer.orderItem` / `TimerFact.orderItem` の形。 */
type ItemRef = { readonly externalOrderId: string; readonly itemIndex: number };

/** 参照を持つもの（engine の Timer・wire の TimerFact）。null はアドホック（注文を持たない）Timer。 */
type RefHolder = { readonly orderItem: ItemRef | null };

/**
 * ItemKey — 品目の鍵（externalOrderId と itemIndex の組を一つの文字列に畳んだもの）。推奨・Order_Item・
 * 走行中 Timer の品目参照を突き合わせる唯一の同定手段。文字列なのは Map / Set の鍵に置くためで、鍵から
 * 組へ戻す読み手は無い（戻したければ元の品目を持て）。
 */
export type ItemKey = string;

/**
 * 品目の鍵を組む。区切りは NUL——externalOrderId は POS の任意文字列で、`#` や `-` は識別子の中に現れうる。
 *
 * 推奨（CookRecommendation）も Order_Item も同じ二つの項目を持つので、どちらからでも同じ鍵に達する
 * （構造で受け、型を問わない）。engine の pending / objective も同じ形の鍵を持つが、ここは client と engine が
 * 共有する Head の導出（lift-group.ts）が要る正本である。
 */
export function itemKeyOf(item: {
  readonly externalOrderId: string;
  readonly itemIndex: number;
}): ItemKey {
  return `${item.externalOrderId}\u0000${item.itemIndex}`;
}

/**
 * 到着順の全順序（arrivalTime 昇順, externalOrderId 昇順, itemIndex 昇順）。
 *
 * 待ち行列の並び（client のレール）と、群の中で startAt が同値の品目の並び（lift-group-display AC 1.4・
 * lift-group.ts）は同じ順序を要る。第 2・第 3 の鍵はサーバ側の計画対象の整列と同じで、同時到着でも端末間・
 * 再描画間で並びが揺れない。
 */
export function compareArrival(a: OrderItem, b: OrderItem): number {
  return (
    a.arrivalTime - b.arrivalTime ||
    compareText(a.externalOrderId, b.externalOrderId) ||
    a.itemIndex - b.itemIndex
  );
}

/** 文字列の全順序（並びを決定的にするための第 2 の鍵）。 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ORDER_LIFETIME_MS — Order_Lifetime（注文の寿命・ミリ秒）。`arrivalTime + ORDER_LIFETIME_MS ≤ now` で期限切れ
 * （半開区間：ちょうど寿命の時点で切れる・pending-order-expiry AC 1.4）。
 *
 * 2 時間の定数であり、店舗設定・ワイヤ・環境変数のいずれからも読まない（AC 1.3）。店舗差が実在したときに設定へ
 * 上げる（`liftIntervalSeconds` と同じ立場）。起点は `arrivalTime`——上流の観測時刻で、「オーダー時刻」に最も近い事実
 * （pos-order-ingress AC 8.1〜8.4）。同じ注文の後着が最早の `arrivalTime` を引き継ぐ規則はそのままなので、期限を
 * 過ぎた注文を変更する Record が届いても生き返らない。
 */
export const ORDER_LIFETIME_MS = 2 * 60 * 60 * 1000;

/**
 * isLive — 期限の述語。`arrivalTime + ORDER_LIFETIME_MS > now` なら期限内（半開区間・ちょうど寿命の時点で切れる・
 * pending-order-expiry AC 1.4）。`arrivalTime` が `now` より未来（上流の時計が進んでいる）なら期限内として扱う——
 * 未来の到着を弾くのは期限の関心ではない。
 *
 * 述語は domain にこの一つ。`liveOrders` / `pendingOrders` / `orderItemsToBroadcast` が内側で同じ式を呼び、engine と
 * client が同じ線を引く（`lift-group.ts` の Head と同じ規律・AC 3.2）。調理の状態と期限は別の軸である
 * （order-lifecycle 判断 5）——「未調理だが期限切れ」「調理済みで期限切れ」は普通に在る。
 */
export function isLive(item: { readonly arrivalTime: number }, now: number): boolean {
  return item.arrivalTime + ORDER_LIFETIME_MS > now;
}

/**
 * liveOrders — Live_Orders（期限内の品目）。期限内（`isLive`）の品目だけを、入力の並びのまま返す（並び替えない・
 * 重複を作らない・入力を変えない・AC 1.1）。`now` と `items` だけに依存する（Timer・設定・前回の計画を読まない・AC 1.2）。
 *
 * **正本（`TimerState.orderItems`）は変えず、絞った値を正とする（pending-order-expiry 判断 1）。** 期限は状態を書き換える
 * 出来事ではなく `now` から導く述語である。読む側の入口はこれを直接呼ばず、`pendingOrders`（計画・左レール）と
 * `orderItemsToBroadcast`（snapshot）の内側で呼ばれる（order-lifecycle 判断 10）。
 *
 * **全件が期限内なら入力と同じ配列を返す**（新しい配列を作らない）。通常はこれが既定の経路であり、`ClientView` の
 * 参照同値で再描画を抑える既存の経路（React の props 比較）を壊さない。
 */
export function liveOrders(items: readonly OrderItem[], now: number): readonly OrderItem[] {
  const live = items.filter((item) => isLive(item, now));
  return live.length === items.length ? items : live;
}

/**
 * refersTo — 参照が品目を指すか。`externalOrderId` と `itemIndex` の一致（`itemKeyOf` と同じ鍵）。
 *
 * Timer → 品目の対応はこの述語ただ一つから出る。engine の `Timer.orderItem`（tableId を余分に持つ）も wire の
 * `TimerFact.orderItem` も構造で受ける。
 */
export function refersTo(ref: ItemRef, item: ItemRef): boolean {
  return ref.externalOrderId === item.externalOrderId && ref.itemIndex === item.itemIndex;
}

/**
 * itemStatusOf — 品目の状態の正本（order-lifecycle 判断 1・AC 1.2）。
 *
 * 導出の順は (1) 自分を参照する生きた Timer が在る → `cooking`、(2) 無く `completedAt` が在る → `done`、(3) どちらも
 * 無い → `unstarted`。**生きた Timer は走行中だけでなく、茹で上がって Complete を待つ boiled も含む**——`timers` は状態の
 * Timer 全件で、running / boiled を区別しない。時間が来ただけでは done にならない（茹で上がりと、厨房が完了を確定する
 * ことは別）。`interruptedAt` は読まない（判断 3′）。第 4 の状態は作らない。
 */
export function itemStatusOf(item: OrderItem, timers: readonly RefHolder[]): ItemStatus {
  if (timers.some((timer) => timer.orderItem !== null && refersTo(timer.orderItem, item))) {
    return "cooking";
  }
  return item.completedAt !== null ? "done" : "unstarted";
}

/**
 * pendingOrders — 未調理の品目（期限内 ∧ `unstarted`）。計画と左レール・ラジアル・開始の照合・指紋・外部要求・変更費用の
 * 対応が読む入口（order-lifecycle Requirement 3.1 / 4.1）。「未調理」は保存された集合ではなくこの関数である（判断 10）。
 *
 * 並びは入力のまま。**全件が通れば入力と同じ参照を返す**（`liveOrders` と同じ理由・再描画の抑制）。`liveOrders` を内側に
 * 畳むので、期限の述語はここでも一つのまま。二度当てても冪等（`planTargets` が再び `liveOrders` を通してよい）。
 */
export function pendingOrders(
  items: readonly OrderItem[],
  timers: readonly RefHolder[],
  now: number,
): readonly OrderItem[] {
  const live = liveOrders(items, now);
  const unstarted = live.filter((item) => itemStatusOf(item, timers) === "unstarted");
  return unstarted.length === live.length ? live : unstarted;
}

/**
 * orderItemsToBroadcast — snapshot に載せる品目集合（期限内 **または** 生きた Timer の参照先・Requirement 3.2）。
 *
 * 調理中の品目は期限を超えても Complete まで配信され、釜のカードが参照で卓・品名を引ける（注文から 1 時間 59 分で
 * 10 分茹での品目を開始し、2 時間 1 分に snapshot を送っても品目は載る）。`done` と `unstarted` は期限で消える
 * （Requirement 3.4・保持は正本）。期限の述語は `isLive` を共有し、状態の述語は `itemStatusOf` を共有する——
 * 期限判定を共有することと、全用途で同じ集合を読むことは別である（判断 5）。並びは入力のまま。全件が通れば同じ参照。
 */
export function orderItemsToBroadcast(
  items: readonly OrderItem[],
  timers: readonly RefHolder[],
  now: number,
): readonly OrderItem[] {
  const kept = items.filter(
    (item) => isLive(item, now) || itemStatusOf(item, timers) === "cooking",
  );
  return kept.length === items.length ? items : kept;
}

/**
 * orderItemOf — Timer → 品目の参照解決（釜側の入口・Requirement 4.6）。
 *
 * `orderItem` が null（アドホック開始）なら null。参照先が集合に無い（v12 由来の走行中 Timer・判断 14）場合も null で、
 * 呼び手は「注文なし」と同じ経路を通る——参照先の無い Timer を扱う経路は一つである（判断 13）。engine の `Timer` と
 * wire の `TimerFact` の両方から呼べるよう、引数は参照を持つものを構造で受ける。
 */
export function orderItemOf(holder: RefHolder, items: readonly OrderItem[]): OrderItem | null {
  const ref = holder.orderItem;
  if (ref === null) return null;
  return items.find((item) => refersTo(ref, item)) ?? null;
}

/**
 * Order_Ingress が受けた到着の生値（品目の配列）を OrderItem 列へ写す純粋関数。
 *
 * **1 品目でも不正なら全体を null へ落とす**（AC 1.4「当該到着を拒否し、Order_Item 集合と Timer 集合の
 * いずれも変更しない」）。この点だけが toNoodlePresets と形が違う——設定は不正要素を畳んで残りで営業を続ける
 * のが善だが、到着は「注文の一部だけを受理した」状態を作れば現場が欠品に気づけない。要件が全体拒否を定めて
 * いるのは、部分受理という嘘を許さないためである。空配列も受理する内容が無いため null。
 *
 * 受理拒否（400）への写しは呼び出し側（shell の受け口）が行う。ここは「妥当な OrderItem 列か否か」だけを
 * 答え、HTTP の語彙を domain へ持ち込まない。
 *
 * noodleType は presets との突き合わせで「未知の品目種別」（AC 1.4）を弾く。設定全体（StoreConfig）ではなく
 * 麺種プリセットだけを受け取る——判定に要るのはこの一つで、重み・許容幅・レイアウトは無関係である。
 * arrivalTime は生値に含めず引数で受ける。Order_Arrival_Time は「Order_Ingress 経由で受理された絶対時刻」
 * という受け手側の事実であって、POS の主張ではない（主張を許せば待ち時間の起点を外部が操作できてしまう）。
 *
 * 同一 (externalOrderId, itemIndex) の重複はここでは見ない。集合としての一意性は upsertOrder の関心事である。
 */
export function toOrderItems(
  raw: unknown,
  presets: readonly NoodlePreset[],
  arrivalTime: number,
): NonEmptyArray<OrderItem> | null {
  if (!Array.isArray(raw)) return null;
  const orders: OrderItem[] = [];
  for (const item of raw) {
    const order = toArrivedItem(item, presets, arrivalTime);
    if (order === null) return null;
    orders.push(order);
  }
  return isNonEmpty(orders) ? orders : null;
}

/**
 * 生値を 1 件の OrderItem へ正規化する。必須属性の欠落・未知の品目種別・型違反はいずれも null。
 *
 * 厨房の事実（`completedAt` / `interruptedAt`）は到着が持たない——POS は厨房の完了も中断も知らない。新しい品目は
 * null で生まれ、同じ鍵の品目が既に在れば `upsertOrder`（engine/pending.ts）が既存の事実を保つ。
 */
function toArrivedItem(
  value: unknown,
  presets: readonly NoodlePreset[],
  arrivalTime: number,
): OrderItem | null {
  if (!isRecord(value)) return null;
  const candidate = value;
  if (!isNonEmptyString(candidate.externalOrderId)) return null;
  // 品目連番は 0 以上の整数（NaN / Infinity は整数性の判定で落ちる・domain/predicate）。
  if (!isNonNegativeInteger(candidate.itemIndex)) return null;
  // 未知の品目種別を弾く（AC 1.4）。空文字はどのプリセットにも一致しないため、この一手で型違反も覆う。
  if (
    typeof candidate.noodleType !== "string" ||
    !presets.some((preset) => preset.noodleType === candidate.noodleType)
  ) {
    return null;
  }
  if (!isFirmness(candidate.firmness)) return null;
  // tableId は「無い」ことに意味がある（卓に紐づかない持ち帰りは単独グループ）。欠落・null は null へ正規化し、
  // 文字列以外と空文字は型違反として拒否する——空の卓 id を通すと、卓なしの品目が一つの卓へ黙って束ねられる。
  // 判定は toDeclaredName ただ一つに閉じる（同じ形の関門を項目ごとに書かない）。
  const tableId = toDeclaredName(candidate.tableId);
  if (tableId === null) return null;
  const slotSpan = toSlotSpan(candidate.slotSpan);
  if (slotSpan === null) return null;
  // 余剰フィールドを落として正規化する（外部の混ぜ物を待ち行列の正本へ持ち込まない）。
  return {
    externalOrderId: candidate.externalOrderId,
    itemIndex: candidate.itemIndex,
    noodleType: candidate.noodleType,
    firmness: candidate.firmness,
    tableId: tableId.name,
    // 商品名は素通しする（AC 4.3）。欠落・空文字・型違いは null へ畳み、Record も品目も拒否しない
    // ——名前は麺を茹でる判断に要らず、読めないことを拒否事由にすれば伝票が現場へ届かなくなる。
    itemName: toDeclaredName(candidate.itemName)?.name ?? null,
    sizeName: toDeclaredName(candidate.sizeName)?.name ?? null,
    arrivalTime,
    slotSpan,
    completedAt: null,
    interruptedAt: null,
  };
}

/**
 * 生値を占有幅へ写す。値域外・非整数・null は null（呼び出し側が到着全体を拒否する）。
 *
 * 欠如だけは 1 スロット占有へ畳む。麺量の語彙を持たない到着（既存 Order_Ingress の直接投入）は現に
 * 1 品目 1 スロットで計画されており、畳んだ値がその実際の挙動に一致する——これは「指定が無い」という
 * 入力の形に対する既定であり、不正値を黙って通すことではない。下限と同じ値になるのは偶然ではなく、
 * 占有しない麺が在りえないことの帰結である。
 *
 * 値域外はクランプせず拒否する（store.ts の toNoodleSize と同じ判断）。勝手に寄せれば、どこにも
 * 要求されていない占有幅を新たに作ってしまう。
 */
function toSlotSpan(value: unknown): number | null {
  if (value === undefined) return SLOT_SPAN_MIN;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < SLOT_SPAN_MIN || value > SLOT_SPAN_MAX) return null;
  return value;
}
