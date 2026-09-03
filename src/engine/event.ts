// core/event.ts — core への入力イベント。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// コマンド（外部由来）と内部イベント（Alarm 発火・rehydrate 整合）を一つの代数的データ型に
// 集約する。`now` は shell が Date.now() で採取して渡す（core は時計を持たない＝純粋）。
// `newTimerId` も shell が採取して渡し、crypto.randomUUID() という副作用を core から閉め出す。

import type { EpochMillis, TimerId } from "../engine/types";
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
      readonly now: EpochMillis;
    }
  // 注文品目を指す開始（slot-suggested-start）。運ぶのは鍵と釜だけで、麺種・茹で加減・茹で秒は運ばない
  // ——engine が pendingOrders の当該品目と params.noodlePresets から導く。Start と一つに畳まないのは、
  // 「主張を検証して使う」と「事実から導く」で義務が違うためである（畳めば引数で切り替える分岐が生まれる）。
  | {
      readonly type: "StartOrderItem";
      readonly slotIds: readonly string[];
      readonly externalOrderId: string;
      readonly itemIndex: number;
      readonly newTimerId: TimerId;
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
  // 取り込み経路が受けた 1 店舗分の受領（pos-order-ingress AC 6.9）。**OrderArrived / OrderCancelled では
  // 表現できない**——(a) 到着は非空の品目列を要求するため「茹で対象 0 件」を運べない、(b) いずれも端末 ID と
  // sequence_number を運ばないため重複判定の材料を進められない、(c) Record ごとに分ければ 1 受領につき
  // Persist が 1 つという規律（AC 5.5）が破れる。ゆえに受領を 1 イベントに畳む。
  //
  // received は翻訳済みの受領単位を到着順に並べたもの。翻訳（麺の仕様の解釈）は StoreConfig を要するため
  // shell に残り、engine は翻訳後の事実だけを見る（engine は StoreConfig を知らない既存の規律）。
  | {
      readonly type: "RecordsReceived";
      readonly received: readonly ReceivedOrder[];
      readonly now: EpochMillis;
    }
  // 外部（Solver_Worker）から届いた計画（要件6.1）。plan.score は**外部が主張した値**にすぎず、採否の根拠に
  // しない——engine 側の採点（scoreSchedule）が唯一の権威である（design「意図的な重複」の不変点）。
  // 解析不能・スキーマ不正・Input_Fingerprint の欠落（AC 10.3）はここに到達する前に落とす——境界で検証して
  // engine には検証済みの型だけを渡す既存の規律（domain の toPendingOrders・shell の parseClientMessage）に
  // 従い、受け口（deliverPlan・タスク 19.2）の担当とする。届かなければ状態は変わらず、全体棄却が成立する。
  | { readonly type: "PlanArrived"; readonly plan: CookSchedule; readonly now: EpochMillis };

/**
 * ReceivedOrder — 1 Record の翻訳結果。engine が受領について見る唯一の形。
 *
 * engine は POS の語彙（`plu_no`・麺量の商品コード・`item_type`）を一切知らない。ここに現れる
 * `sequenceNumber` は上流が付与する不透明な順序の印であり、engine が持つのは比較可能な文字列という
 * 一事だけである（`noodleType` のように意味を解釈しない）。翻訳は shell 側に残り、engine は翻訳済みの
 * 事実だけを見る。
 */
export interface ReceivedOrder {
  /** Unique_Key から導出済みの識別子。同一オーダーの後着はこの値で束ねる。 */
  readonly externalOrderId: string;
  /** 単調性の判定材料（lastSequenceByTerminal）のキー。 */
  readonly terminalId: string;
  /** 単調性の比較対象。新旧の判定は isNewerSequence ただ一つに閉じる。 */
  readonly sequenceNumber: string;
  /**
   * 翻訳できた茹で対象の品目。**NonEmptyArray にしない。**
   *
   * 空は「キャンセル、または麺を含まない注文」という正常な入力であり、型で禁じてはならない。0 件は
   * 当該 externalOrderId の除去（既存あり）または集合の無変更（既存なし）を意味し、どちらの場合も
   * 判定材料は進む（AC 6.11 / 6.12）。OrderArrived が非空を要求するのは 1 つの到着だけを扱うためで、
   * 受領単位では空が意味を持つ。
   */
  readonly items: readonly PendingOrder[];
}
