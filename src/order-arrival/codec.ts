// 注文到着記録の出口（order-arrival-log）。
//
// 検査は Tail 側の Zod が行う（`src/data-platform/record-schema.ts`）。ここが持つのは
// **console へ渡す payload を組むこと**と、保存する canonical 一行の並びを固定することだけである。

import { ORDER_ARRIVAL_RECORD_TYPE, type OrderArrivalRecord } from "./record";

/**
 * console へ渡す payload。**その場で作り直した素のオブジェクトである。**
 *
 * 操作履歴・遅延ログの `*Payload()` と同じ規律で、参照ではなく写しを渡す。ログした後に呼び出し側が
 * 書き換える窓を閉じるためで、属性の集合と並びもここで決まる。
 */
export function orderArrivalPayload(record: OrderArrivalRecord): Record<string, unknown> {
  return {
    recordType: record.recordType,
    payloadVersion: record.payloadVersion,
    eventId: record.eventId,
    storeId: record.storeId,
    externalOrderId: record.externalOrderId,
    arrivalTimestampMs: record.arrivalTimestampMs,
    sequenceNumber: record.sequenceNumber,
    path: record.path,
    rawPayload: record.rawPayload,
    payloadBytes: record.payloadBytes,
  };
}

/** 固定順序の canonical 一行。 */
export function printCanonicalOrderArrivalLine(record: OrderArrivalRecord): string {
  return JSON.stringify(orderArrivalPayload(record));
}

/** 名乗りの判定に使う印。Tail はオブジェクトの場として、読み出しは文字列として見る。 */
export const ORDER_ARRIVAL_CLAIM = `"recordType":"${ORDER_ARRIVAL_RECORD_TYPE}"`;
