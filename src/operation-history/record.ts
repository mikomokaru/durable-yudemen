// Operation History の Producer / Data Platform 間だけで共有する既知属性契約。
// Timer 本体の共有契約へ観測関心を混ぜず、JSON 上の値だけを表す。

import type { Firmness } from "../domain/firmness";
import type { NonEmptyArray } from "../domain/timer";

declare const positiveEpochMillis: unique symbol;

/** 検証済みの正の整数 epoch millisecond。確立は導出・parser の入力境界が担う。 */
type PositiveEpochMillis = number & { readonly [positiveEpochMillis]: true };

interface CommonOperationRecord {
  readonly storeId: string;
  readonly timerId: string;
  readonly operationKind: "boil-started" | "boiled" | "adjusted" | "completed" | "cancelled";
  readonly eventTime: PositiveEpochMillis;
  readonly slotIds: NonEmptyArray<string>;
  readonly noodleType: string;
  readonly firmness: Firmness;
}

interface BoilStartedRecord extends CommonOperationRecord {
  readonly operationKind: "boil-started";
  readonly startTime: PositiveEpochMillis;
  readonly endTime: PositiveEpochMillis;
}

interface BoiledRecord extends CommonOperationRecord {
  readonly operationKind: "boiled";
  readonly endTime: PositiveEpochMillis;
  readonly boiledAt: PositiveEpochMillis;
}

interface AdjustedRecord extends CommonOperationRecord {
  readonly operationKind: "adjusted";
  readonly endTime: PositiveEpochMillis;
}

interface CompletedRecord extends CommonOperationRecord {
  readonly operationKind: "completed";
}

interface CancelledRecord extends CommonOperationRecord {
  readonly operationKind: "cancelled";
}

/** 確定 Timer 差分一件を表す、kind ごとに閉じた best-effort telemetry。 */
export type OperationRecord =
  | BoilStartedRecord
  | BoiledRecord
  | AdjustedRecord
  | CompletedRecord
  | CancelledRecord;
