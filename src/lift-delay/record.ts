// 麺揚げ遅延ログの原事実（lift-delay-log 要件 1・5）。
//
// 記録するのは**時刻そのもの**であって、遅延という導出値ではない。`terminalAt - dueAt` は読み出しや
// 統計の時点で計算する。ここで差を保存すれば、丸め方や外れ値の扱いを変えた再分析ができなくなる。
//
// 操作履歴の `OperationRecord` とは別の形式である。両者は同じ console と同じ Tail を通るので、
// 行が自分の形式を名乗る（`recordType`）。名乗りが無ければ、受け取った側は別の形式として解釈し得る。

import type { Firmness } from "../domain/firmness";
import type { NonEmptyArray } from "../domain/timer";

/**
 * 形式の名乗り。操作履歴の既知属性と衝突しない語を選ぶ。
 *
 * 2 種類ある。開始の瞬間に出す `lift-delay-start` と、終端で出す `lift-delay`。**開始文脈を
 * 業務の保存へ預けず、その場で 1 行にする**ので、読み側が `(storeId, timerId)` で対応させる
 * （2026-09-16 の変更・要件 2.1）。預ける形は、満杯時に厨房操作を失敗させ得る唯一の経路だった。
 */
export const LIFT_DELAY_RECORD_TYPE = "lift-delay";
export const LIFT_DELAY_START_RECORD_TYPE = "lift-delay-start";

/**
 * **書くときの形式版。** 属性を足すときに上げる。物理世代（列の集合）とは別である。
 *
 * 版 2 で開始 record に `orderItem` を足した（注文到着との突合・order-arrival-log）。終端 record の
 * 形は版 1 から変わっていない。
 */
export const LIFT_DELAY_PAYLOAD_VERSION = 2;

/**
 * **読めるときの形式版。** 書く版と読める版は別である——混ぜると、版を上げた瞬間に既に保存した行が
 * 全て「読めない行」に変わる。実際に 2026-09-16 に一度そうなりかけた。
 *
 * 版 1 と版 2 の差は `orderItem` の有無だけで、版 1 の行は `orderItem` を持たない記録として完全に
 * 読める。**読んだ版はそのまま保つ**——版 2 へ書き換えれば、記録がいつの形式で作られたかが消える。
 */
export const LIFT_DELAY_SUPPORTED_PAYLOAD_VERSIONS: readonly number[] = [1, 2];

/** 読める形式版か。 */
export function isSupportedLiftDelayPayloadVersion(value: unknown): value is number {
  return typeof value === "number" && LIFT_DELAY_SUPPORTED_PAYLOAD_VERSIONS.includes(value);
}

/**
 * 品目への参照。注文到着の記録と突き合わせる鍵である（order-arrival-log）。
 *
 * `externalOrderId` は `toUniqueKey(payload)` の結果で、注文到着記録の同名の場と**同値**である。
 * 別の対応表を作らずに突き合うのは、採番の関数を 1 つしか持たないからである。
 */
export type LiftDelayOrderItemRef = {
  readonly externalOrderId: string;
  readonly itemIndex: number;
};

/** 終端の種別。取消に完了遅延を割り当てない（要件 1.5）。 */
export type TerminalOutcome = "completed" | "cancelled";

/** 開始直前の提案にあった配置。見つからないことを「単独群だった」と読まない（要件 2.3）。 */
export type ShownPlacement =
  | {
      readonly kind: "found";
      readonly startAt: number;
      readonly serveAt: number;
      readonly mates: number;
    }
  | { readonly kind: "absent" };

/**
 * 開始時点の文脈。開始 record の素材であり、読み側では突き合わせの結果として現れる。
 *
 * 取れなかった理由を値として持つ。不明を 0 杯・0 秒・単独群で埋めれば、条件別の分析がその
 * 埋めた値に引きずられる（要件 2.6）。
 */
export type LiftDelayStartContext =
  | {
      readonly kind: "recorded";
      readonly startedAt: number;
      /** 注文品目からの開始か、アドホックな開始か。 */
      readonly source: "order-item" | "ad-hoc";
      /** 開始直前の未着手品目数と、対象自身を除いた数（要件 2.2）。 */
      readonly pendingBeforeStart: number;
      readonly pendingOtherItems: number;
      readonly activeTimerCount: number;
      readonly occupiedSlotCount: number;
      readonly shownPlacement: ShownPlacement;
      /** 適用ウェイト。調整機構は未実装ゆえ、根拠のある値だけを持つ（要件 2.5）。 */
      readonly appliedWait: { readonly kind: "not-introduced" };
    }
  | {
      readonly kind: "unknown";
      /**
       * `before-introduction` は記録機構の導入前に始まった Timer、`missing` は文脈が見つからない、
       * `capacity` は保存の余地が無く付けなかった、`undecodable` は読めなかった。
       */
      readonly reason: "before-introduction" | "missing" | "capacity" | "undecodable";
    };

/** 開始の瞬間に出す 1 行。終端を待たずに出すので、業務の保存を一切変えない。 */
export interface LiftDelayStartRecord {
  readonly recordType: typeof LIFT_DELAY_START_RECORD_TYPE;
  readonly payloadVersion: number;
  /** 開始の安定 ID。終端と同じ規律で、時刻も連番も混ぜない。 */
  readonly eventId: string;
  readonly storeId: string;
  readonly timerId: string;
  readonly startedAt: number;
  readonly source: "order-item" | "ad-hoc";
  readonly pendingBeforeStart: number;
  readonly pendingOtherItems: number;
  readonly activeTimerCount: number;
  readonly occupiedSlotCount: number;
  readonly shownPlacement: ShownPlacement;
  readonly appliedWait: { readonly kind: "not-introduced" };
  /**
   * 開始した品目への参照。注文到着の記録と突き合わせる鍵である（payload 版 2 で追加）。
   *
   * **null の意味は `source` と `payloadVersion` で分かれる。** `source` が `ad-hoc` なら注文由来で
   * ないという事実であり、`order-item` なのに null なら**記録していなかった**（版 1 の行）という意味
   * である。この 2 つを同じ「群なし」として数えれば、機構の導入前を単独の手動ゆでに化けさせる。
   */
  readonly orderItem: LiftDelayOrderItemRef | null;
}

/** 完了または取消の 1 Timer 分の原事実。 */
export interface LiftDelayRecord {
  readonly recordType: typeof LIFT_DELAY_RECORD_TYPE;
  readonly payloadVersion: number;
  /** 同じ終端の複製でも不変の ID。再送で増やさないための鍵である（要件 5.2）。 */
  readonly eventId: string;
  readonly storeId: string;
  readonly timerId: string;
  readonly outcome: TerminalOutcome;
  /** Timer の開始時刻。 */
  readonly startedAt: number;
  /** 操作を適用する直前の実効麺揚げ予定時刻（`adjustedEndTime`）。 */
  readonly dueAt: number;
  /** 操作を受理したサーバ時刻。当該 decide へ渡した now と同値である。 */
  readonly terminalAt: number;
  readonly noodleType: string;
  readonly firmness: Firmness;
  readonly slotIds: NonEmptyArray<string>;
}

// **一括完了の相関は持たない（2026-09-16 の決定）。**
//
// 1 回の押下で複数の麺を上げたことを端末に申告させる案を検討し、採らなかった。注文由来の開始なら
// 群の情報は開始の行（`shownPlacement.mates`）に既にあり、申告が要らない。手動ゆでには群という
// 事実がそもそも無く、申告を受け取っても解釈できない。**最も欲しい場面で最も当てにならない。**
//
// 代わりに、分析は Timer 単位の件数として出し、独立した観測ではないことを明示する
// （lift-delay-log 要件 3・6.2）。

/**
 * 終端の安定イベント ID。
 *
 * `(storeId, timerId, outcome)` から決める。Timer ID は開始時に生成され再利用しないので、この 3 つで
 * 1 つの終端が定まる。**壁時計も連番も混ぜない**——混ぜれば、同じ終端の再送が別 ID になり、読み側で
 * 1 件へ収束できなくなる（要件 5.2）。
 *
 * 区切りに `:` を使えるのは、storeId が `[a-z0-9-]`、timerId が UUID、outcome が固定語で、いずれも
 * `:` を含まないからである。
 */
export function liftDelayEventId(
  storeId: string,
  timerId: string,
  outcome: TerminalOutcome,
): string {
  return `${storeId}:${timerId}:${outcome}`;
}

/**
 * 開始の安定イベント ID。終端の 3 つ組と同じ形で、終端種別の位置に `start` を置く。
 * 保存先の物理行は dataset ごとに ID を要求するので、開始の行も名乗る。
 */
export function liftDelayStartEventId(storeId: string, timerId: string): string {
  return `${storeId}:${timerId}:start`;
}

/** 完了操作遅延。負は早め、0 はちょうど、正は遅れ。取消では意味を持たない。 */
export function completionDelayMs(record: LiftDelayRecord): number | null {
  return record.outcome === "completed" ? record.terminalAt - record.dueAt : null;
}
