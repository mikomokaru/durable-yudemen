// client/components/flowLanes.ts — オーダーの流れ（KANBAN）のレーンを導出する純粋関数。
// WS も DOM も触れない。受信ビュー（品目全件・Timer 全件・推奨）と現在時刻 now から、4 つのレーンを毎描画導出する
// （保持は全量・表示は導出／queueDisplay.ts・slotDisplay.ts と同じ規律）。
//
// **プロトタイプ（2026-09-16）。** 釜中心のタイマー画面とは別に、品目がどの段階に在るかを店舗全体で俯瞰する画面の
// ための導出である。段階と既存モデルの対応は次のとおりで、**新しい状態を保存しない**——すべて `itemStatusOf` と
// Timer の endTime、`completedAt` からの導出である。
//
//   Waiting（未処理）  = 未調理（`pendingOrders`＝期限内 ∧ unstarted）
//   Boiling（茹で中）  = 生きた Timer（走行中・茹で上がりとも）。品目ではなく Timer を単位に並べる——注文を持たない
//                        アドホックの Timer も釜を占めており、タイムラインから消せば釜の実態と食い違う
//   Plating（盛りつけ中）= 厨房が Complete を打った（`completedAt` あり＝麺を上げた事実）で、まだこの端末で
//                        「盛りつけ済み」と確認されていない品目
//   Done（完了）        = 盛りつけ済みと確認された品目
//
// **Plating → Done の遷移だけはサーバに事実が無い。** 現行の正本は `completedAt`（麺を上げた）で終わっており、
// 「盛りつけて客席へ出した」に当たる事実もメッセージも無い。プロトタイプでは端末ローカルの確認集合
// （`acked`・platingAcks.ts）で代替し、他端末・再接続を跨いで残ることを保証しない。本実装で必要になれば新しい
// 事実（品目の属性）と ClientMessage を spec で立てる——ここに client だけの真実を作り込まない。

import type { ClientTimer, ClientView } from "../connection";
import { mode } from "../connection";
import { correctedNow } from "../clock";
import { suggestedItemOf, type SuggestedItem } from "./queueDisplay";
import {
  compareArrival,
  compareText,
  itemKeyOf,
  itemStatusOf,
  liveOrders,
  orderItemOf,
  pendingOrders,
  type ItemKey,
  type OrderItem,
} from "../../domain/order";

/**
 * 客の待ち時間の警告段階（2026-09-17）。オーダーから 10 分で `warn`（黄）、15 分で `alert`（赤・⚠）。
 * 表示だけの導出で、並びにも計画にも効かない。しきいは定数——店舗差が実在するまで設定にしない。
 */
export const WAIT_WARN_MS = 10 * 60_000;
export const WAIT_ALERT_MS = 15 * 60_000;
export type WaitTone = "calm" | "warn" | "alert";
export function waitTone(waitingMs: number): WaitTone {
  if (waitingMs >= WAIT_ALERT_MS) return "alert";
  if (waitingMs >= WAIT_WARN_MS) return "warn";
  return "calm";
}

/**
 * 食券番号（4 桁）を externalOrderId から導く（2026-09-17・ユーザー確定「4 桁の番号」）。
 *
 * POS 取り込みの externalOrderId は Unique_Key（`store_id:terminal_id:bill_no:datetime`・要素は %XX で符号化）で、
 * 食券番号は 3 番目の `bill_no`（伝票番号）である。区切りが無い id（手投入・試験）は id 全体を材料にする。
 * 材料の**末尾の数字列の下 4 桁**を 0 詰めで返す——伝票番号が 4 桁を超えて回る店でも現場が呼ぶのは下 4 桁である。
 * 数字が無ければ材料の末尾 4 文字（読めないより何か出す）。表示だけの導出で、同定には使わない（一意ではない）。
 */
export function ticketNumberOf(externalOrderId: string): string {
  const segments = externalOrderId.split(":");
  const raw = segments.length >= 3 ? decodePercent(segments[2] ?? "") : externalOrderId;
  const digits = /(\d+)(?!.*\d)/.exec(raw)?.[1];
  if (digits === undefined) return raw.slice(-4);
  return digits.slice(-4).padStart(4, "0");
}

/** %XX を戻す。壊れた符号化はそのまま返す（表示のための最善努力）。 */
function decodePercent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Waiting の 1 行。並びは推奨の startAt（無ければ末尾）→ 到着順。 */
export interface WaitingEntry {
  readonly order: OrderItem;
  /** 到着から現在までの経過（ミリ秒・導出値・負にはしない）。 */
  readonly waitingMs: number;
  /** 店舗全体の推奨のうち、この品目を指すものの開始時刻。無ければ null（提案が無いことだけを意味する）。 */
  readonly startAt: number | null;
}

/**
 * Boiling の 1 行。Timer が単位で、`order` は参照解決の結果（null は注文なし＝アドホック・参照先の無い Timer。
 * 参照先の無い Timer を扱う経路は一つ・order-lifecycle 判断 13）。
 */
export interface BoilingEntry {
  readonly timer: ClientTimer;
  readonly order: OrderItem | null;
  /** 上がりまでの残り（ミリ秒・負にはしない）。0 なら茹で上がっている。 */
  readonly remainingMs: number;
  /** 茹で上がってからの経過（ミリ秒・負にはしない）。0 なら走行中。 */
  readonly overdueMs: number;
}

/** Plating の 1 行。`completedAt` は非 null が型で確立済み。 */
export interface PlatingEntry {
  readonly order: OrderItem;
  readonly completedAt: number;
  /** オーダー（到着）から現在までの経過（ミリ秒・負にはしない）。客の待ちで読む——Waiting と同じ起点。 */
  readonly waitingMs: number;
}

/** Done の 1 行。 */
export interface DoneEntry {
  readonly order: OrderItem;
  readonly completedAt: number;
}

/**
 * BOWL_PREP_LEAD_MS — 丼の準備猶予（90 秒・ミリ秒）。上がりまでの残りがこれ以下になった品目が「丼にタレを入れて
 * 受け取り準備をする」対象になる（棚とタイムラインの準備帯が同じ集合を読む）。
 *
 * 釜側の PREP_LEAD_MS（麺を手に持つ猶予 60 秒・domain/messages.ts）と同じ構図の、盛りつけ側の猶予である。設定にしない
 * ——店舗差が実在するまでは定数で足り、ここ（準備の集合を導く関数の隣）に置くのは、この猶予が上がり時刻に対してだけ
 * 意味を持つ時間だからである。ユーザー確定 2026-09-16。
 */
export const BOWL_PREP_LEAD_MS = 90_000;

/** 棚の 1 杯。準備中・上がり待ちは Timer（boiling）、上げた後は品目（plating）が正体で、段階を判別で持つ。 */
export type Bowl =
  | { readonly kind: "boiling"; readonly entry: BoilingEntry }
  | { readonly kind: "plating"; readonly entry: PlatingEntry };

/**
 * 計画の 1 群（同じ投入作業として続ける品目のまとまり・CookRecommendation.group）。並びは開始の早い順。
 * 品目は推奨 → 未調理の品目 → 茹で秒 → 上がり時刻の連鎖（suggestedItemOf）が成立したものだけ——開始できない推奨は
 * 計画として出さない（lift-group-display AC 1.3 と同じ扱い）。
 */
export interface PlanGroup {
  readonly group: string;
  /** 群の最早の開始（推奨の startAt の最小）。 */
  readonly startAt: number;
  /** 群の上がり（serveAt の最小・同卓なら揃っている）。 */
  readonly serveAt: number;
  readonly items: readonly SuggestedItem[];
}

/**
 * 最新の計画を群で束ねる（Orders 画面の計画パネル・2026-09-17）。degraded・再整合待ちでは空。
 * 推奨は店舗全体（担当範囲で絞らない）。群の中は startAt 昇順 → 到着順、群どうしは startAt 昇順 → group。
 */
export function planGroups(view: ClientView, now: number): readonly PlanGroup[] {
  if (mode(view) !== "live" || view.awaitingResync) return [];
  const corrected = correctedNow(view.offset, now);
  const byGroup = new Map<string, SuggestedItem[]>();
  for (const recommendation of view.recommendations) {
    const item = suggestedItemOf(view, recommendation, corrected);
    if (item === null) continue;
    const members = byGroup.get(recommendation.group) ?? [];
    members.push(item);
    byGroup.set(recommendation.group, members);
  }
  return [...byGroup.entries()]
    .map(([group, items]): PlanGroup => {
      const sorted = [...items].sort(
        (a, b) =>
          a.recommendation.startAt - b.recommendation.startAt || compareArrival(a.order, b.order),
      );
      return {
        group,
        startAt: Math.min(...sorted.map((item) => item.recommendation.startAt)),
        serveAt: Math.min(...sorted.map((item) => item.suggestion.serveAt)),
        items: sorted,
      };
    })
    .sort((a, b) => a.startAt - b.startAt || compareText(a.group, b.group));
}

/**
 * 調理クラスタ——一度の麺揚げ作業として上がる品目のまとまり（CONTEXT.md）。上がり時刻（serveAt）が等しい群の集合で、
 * 中は群（提供の単位・同卓）で区切って持つ。Plan パネルはこれを箱にする（ユーザー確定 2026-09-17「一度で上げるものを見たい」）。
 */
export interface PlanCluster {
  readonly serveAt: number;
  /** クラスタの最早の開始。 */
  readonly startAt: number;
  readonly groups: readonly PlanGroup[];
}

/** 群を上がり時刻で束ねる。クラスタは serveAt 昇順、中の群は planGroups の並び（開始の早い順）を保つ。 */
export function planClusters(view: ClientView, now: number): readonly PlanCluster[] {
  const byServe = new Map<number, PlanGroup[]>();
  for (const group of planGroups(view, now)) {
    const members = byServe.get(group.serveAt) ?? [];
    members.push(group);
    byServe.set(group.serveAt, members);
  }
  return [...byServe.entries()]
    .map(([serveAt, groups]): PlanCluster => ({
      serveAt,
      startAt: Math.min(...groups.map((group) => group.startAt)),
      groups,
    }))
    .sort((a, b) => a.serveAt - b.serveAt);
}

/**
 * 計画の目盛りを「いま」に合わせる（表示だけの導出・2026-09-17）。
 *
 * 計画はサーバの状態変化でだけ組み直され、時計の進みでは動かない。釜が空で誰も開始しないと、先頭の開始が過去に
 * なったまま止まる。そのとき**計画の並び（何と何を一緒に・どの間隔で）は生きていて、時刻の目盛りだけが古い**ので、
 * 先頭の遅れぶん（`lagMs` = now − 先頭の startAt）を**全クラスタ**の開始・上がりに足して「いま始めたら」の見込みとして
 * 出す。先頭だけを動かせば後続との間隔が縮んで嘘になる。計画の中身（群・釜・順）は一切変えない。
 * 遅れが無ければ入力をそのまま返す（lagMs = 0）。
 */
export interface RebasedPlan {
  readonly lagMs: number;
  readonly clusters: readonly PlanCluster[];
}
export function rebasePlan(clusters: readonly PlanCluster[], corrected: number): RebasedPlan {
  const head = clusters[0];
  if (head === undefined) return { lagMs: 0, clusters };
  const lagMs = Math.max(0, corrected - head.startAt);
  if (lagMs === 0) return { lagMs, clusters };
  return {
    lagMs,
    clusters: clusters.map((cluster) => ({
      ...cluster,
      startAt: cluster.startAt + lagMs,
      serveAt: cluster.serveAt + lagMs,
      groups: cluster.groups.map((group) => ({
        ...group,
        startAt: group.startAt + lagMs,
        serveAt: group.serveAt + lagMs,
      })),
    })),
  };
}

/** 4 レーン。すべて導出値で、ビューには保持しない。 */
export interface FlowLanes {
  /**
   * 品目のレーン（waiting / plating / done）を列挙してよいか。degraded と再整合待ちでは false——左レールと同じ理由で、
   * 「自分を指す生きた Timer が無い品目」の導出が通信断中のローカル完了で狂う（order-lifecycle 判断 18）。boiling は
   * Timer 由来で、degraded でもローカルの秒読みが続くので常に列挙する。
   */
  readonly synced: boolean;
  readonly waiting: readonly WaitingEntry[];
  readonly boiling: readonly BoilingEntry[];
  /**
   * 準備すべき丼（boiling のうち残りが `BOWL_PREP_LEAD_MS` 以下・茹で上がって Complete 待ちも含む）。上がる順。
   * boiling の部分列であって別の集合ではない——棚（横）とタイムラインの準備帯（縦）はこれを二つの向きで見せる。
   * 準備が「済んだ」事実は持たない。棚を出る出来事は Complete（Timer の消滅）だけである。
   */
  readonly prep: readonly BoilingEntry[];
  /**
   * 棚に並ぶ丼（時系列の昇順・棚は右端から置く）。Done に入るまで生かす——準備中（prep）と、上がって盛りつけ中（plating）
   * の両方で、段階を `kind` で持つ。並びは段階が先（盛りつけ中 → 上がり待ち・準備中）、段階の中は plating が到着順、
   * boiling が上がる順。prep / plating の部分列の和であって別の集合ではない。
   */
  readonly bowls: readonly Bowl[];
  readonly plating: readonly PlatingEntry[];
  readonly done: readonly DoneEntry[];
}

/**
 * ビューから 4 レーンを導出する。ここは時刻の境界——ローカル時計 `now` を受け、補正済み現在時刻を 1 回だけ計算する。
 *
 * - waiting: `pendingOrders` を、推奨の startAt 昇順（推奨の無い品目は末尾）→ `compareArrival` で並べる。
 *   「早く処理しなければいけないものが上」の解釈で、計画が提案する開始の順をそのまま読む（client で並びを再計算しない）。
 * - boiling: Timer 全件を endTime 昇順（同値は id）で並べる。上がる順そのもので、タイムラインは残り時間で位置を決める。
 * - plating: `done` かつ未確認を、到着順（`compareArrival`＝オーダーから長く待っている順）。
 * - done: `done` かつ確認済みを、`completedAt` 降順（新しいものが上・折りたたみの中）。
 */
export function flowLanes(view: ClientView, acked: ReadonlySet<ItemKey>, now: number): FlowLanes {
  const corrected = correctedNow(view.offset, now);
  const synced = mode(view) === "live" && !view.awaitingResync;

  const boiling = [...view.timers]
    .sort((a, b) => a.endTime - b.endTime || compareText(a.id, b.id))
    .map((timer) => ({
      timer,
      order: orderItemOf(timer, view.orderItems),
      remainingMs: Math.max(0, timer.endTime - corrected),
      overdueMs: Math.max(0, corrected - timer.endTime),
    }));

  const prep = boiling.filter((entry) => entry.remainingMs <= BOWL_PREP_LEAD_MS);
  const prepBowls: Bowl[] = prep.map((entry) => ({ kind: "boiling", entry }));

  if (!synced) {
    return { synced, waiting: [], boiling, prep, bowls: prepBowls, plating: [], done: [] };
  }

  // 推奨は店舗全体（担当範囲で絞らない）。同じ品目を複数の推奨が指すことは無いが、在っても最早を採る。
  const startAtOf = new Map<ItemKey, number>();
  for (const recommendation of view.recommendations) {
    const key = itemKeyOf(recommendation);
    const known = startAtOf.get(key);
    if (known === undefined || recommendation.startAt < known)
      startAtOf.set(key, recommendation.startAt);
  }
  const waiting = pendingOrders(view.orderItems, view.timers, corrected)
    .map((order) => ({
      order,
      waitingMs: Math.max(0, corrected - order.arrivalTime),
      startAt: startAtOf.get(itemKeyOf(order)) ?? null,
    }))
    .sort(
      (a, b) =>
        (a.startAt ?? Number.POSITIVE_INFINITY) - (b.startAt ?? Number.POSITIVE_INFINITY) ||
        compareArrival(a.order, b.order),
    );

  const plating: PlatingEntry[] = [];
  const done: DoneEntry[] = [];
  for (const order of liveOrders(view.orderItems, corrected)) {
    if (order.completedAt === null || itemStatusOf(order, view.timers) !== "done") continue;
    const entry = { order, completedAt: order.completedAt };
    if (acked.has(itemKeyOf(order))) done.push(entry);
    else plating.push({ ...entry, waitingMs: Math.max(0, corrected - order.arrivalTime) });
  }
  plating.sort((a, b) => compareArrival(a.order, b.order));
  done.sort((a, b) => b.completedAt - a.completedAt || compareArrival(a.order, b.order));

  const bowls: Bowl[] = [
    ...plating.map((entry): Bowl => ({ kind: "plating", entry })),
    ...prepBowls,
  ];

  return { synced, waiting, boiling, prep, bowls, plating, done };
}

/** タイムライン上の 1 枚の位置。`top` は上端からの px、`column` は重なりを避けるための横の列（0 起点）。 */
export interface TimelinePlacement<T> {
  readonly entry: T;
  readonly top: number;
  readonly column: number;
}

/** 配置の結果。`columns` は使った列の数（横幅の割り付けに読む）。 */
export interface TimelineLayout<T> {
  readonly placements: readonly TimelinePlacement<T>[];
  readonly columns: number;
}

/**
 * 残り時間を縦位置へ写す（上が「いま」・下が未来）。時刻が進むほど上へ動く。
 *
 * **縦位置は時刻そのもの**（`remainingMs × pxPerSecond`）で、決して歪めない。同じ頃に上がる札どうしが縦に重なるときは、
 * 横の列へ避ける——上から順に、直前の札の下端（`cardPx + gapPx`）が自分の上端より上に在る最初の列へ置き、無ければ
 * 新しい列を開く（カレンダーの日表示と同じ規則）。茹で上がり（remainingMs = 0）は上端に横一列で並ぶ。
 */
export function timelinePlacements<T extends { readonly remainingMs: number }>(
  entries: readonly T[],
  pxPerSecond: number,
  cardPx: number,
  gapPx: number,
): TimelineLayout<T> {
  const bottoms: number[] = [];
  const placements: TimelinePlacement<T>[] = [];
  for (const entry of entries) {
    const top = (entry.remainingMs / 1000) * pxPerSecond;
    let column = bottoms.findIndex((bottom) => bottom <= top);
    if (column === -1) column = bottoms.length;
    bottoms[column] = top + cardPx + gapPx;
    placements.push({ entry, top, column });
  }
  return { placements, columns: bottoms.length };
}
