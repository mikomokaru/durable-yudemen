// core/event.ts — core への入力イベント。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// コマンド（外部由来）と内部イベント（Alarm 発火・rehydrate 整合）を一つの代数的データ型に
// 集約する。`now` は shell が Date.now() で採取して渡す（core は時計を持たない＝純粋）。
// `newTimerId` も shell が採取して渡し、crypto.randomUUID() という副作用を core から閉め出す。

import type { EpochMillis, TimerId } from "../engine/types";
import type { Ordered } from "./timer";
import type { CookSchedule } from "./schedule";
import type { Firmness } from "../domain/firmness";
import type { PendingOrder } from "../domain/order";
import type { NonEmptyArray } from "../domain/timer";

/** core への入力イベント。すべて `now` を入力として受け取る。 */
export type Event =
  | {
      readonly type: "Start";
      readonly slotIds: readonly string[];
      readonly noodleType: string;
      readonly boilSeconds: number;
      readonly newTimerId: TimerId;
      // 由来する注文品目。省略時はアドホック麺茹で（POS を経ない開始）＝createTimer の orderItem? と同形。
      // 形の正本は engine/timer.ts の Ordered ひとつ（同じ概念を三度書かない）。
      readonly orderItem?: Ordered["orderItem"];
      readonly now: EpochMillis;
    }
  | { readonly type: "Cancel"; readonly timerId: string; readonly now: EpochMillis }
  // ユーザーの明示完了（boiled の消し込み）。対象 Timer を除去する（cancel と同形・別概念）。
  | { readonly type: "Complete"; readonly timerId: string; readonly now: EpochMillis }
  // 走行中の茹で加減変更。boilSeconds は shell が StoreConfig（麺ごとの硬さ別秒）から解決して渡す。
  | {
      readonly type: "Adjust";
      readonly timerId: string;
      readonly firmness: Firmness;
      readonly boilSeconds: number;
      readonly now: EpochMillis;
    }
  | { readonly type: "AlarmFired"; readonly now: EpochMillis }
  // rehydrate 直後の整合（即時発火含む）
  | { readonly type: "Reconcile"; readonly now: EpochMillis }
  // POS からのオーダー到着（要件1.7）。新規・再送・変更を区別せず upsert ひとつで受ける——区別を外部の
  // 申告に委ねれば到着の冪等性が外部の正しさに依存する。arrival は upsertOrder が受ける形そのまま
  // （NonEmptyArray<PendingOrder>）で、境界で形を変えない。各品目の arrivalTime は「Order_Ingress が
  // 受理した絶対時刻」という受け手側の事実で、now と同じく shell が採取して渡す（Wait_Time の起点）。
  // now は当該遷移の時計（settle の再同期と snapshot の serverTime が用いる）であり、役割が別ゆえ両方運ぶ。
  | {
      readonly type: "OrderArrived";
      readonly arrival: NonEmptyArray<PendingOrder>;
      readonly now: EpochMillis;
    }
  // POS からのオーダー取り消し。当該 externalOrderId の未着手品目だけを除き、開始済み Timer には触れない。
  | { readonly type: "OrderCancelled"; readonly externalOrderId: string; readonly now: EpochMillis }
  // 外部（Solver_Worker）から届いた計画（要件6.1）。plan.score は**外部が主張した値**にすぎず、採否の根拠に
  // しない——engine 側の採点（scoreSchedule）が唯一の権威である（design「意図的な重複」の不変点）。
  // 解析不能・スキーマ不正・Input_Fingerprint の欠落（AC 10.3）はここに到達する前に落とす——境界で検証して
  // engine には検証済みの型だけを渡す既存の規律（domain の toPendingOrders・shell の parseClientMessage）に
  // 従い、受け口（deliverPlan・タスク 19.2）の担当とする。届かなければ状態は変わらず、全体棄却が成立する。
  | { readonly type: "PlanArrived"; readonly plan: CookSchedule; readonly now: EpochMillis };
