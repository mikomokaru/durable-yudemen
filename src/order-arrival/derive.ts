// 受理した Record 1 件から到着記録を作る（order-arrival-log）。
//
// 純粋である。時計も乱数も I/O も持たない。`arrivalTimestampMs` は上流が付与した値をそのまま使う
// ——**我々の受信時刻を混ぜない。** 混ぜれば「POS が届けた時刻」と「我々が受けた時刻」の差が
// 記録から消え、注文到着を起点にした分析がこちら側の遅れを含んでしまう。

import type { ArrivalRecord } from "../ingress/batch";
import {
  ORDER_ARRIVAL_PAYLOAD_VERSION,
  ORDER_ARRIVAL_RECORD_TYPE,
  orderArrivalEventId,
  type OrderArrivalRecord,
} from "./record";

const utf8 = new TextEncoder();

/**
 * 到着記録を作る。`externalOrderId` は呼び出し側が `toUniqueKey` で採った値を渡す
 * ——**同じ関数の結果をドメインと共有する**ことが相関の根拠であり、ここで採り直せば別経路になる。
 */
export function orderArrivalRecordOf(
  storeId: string,
  externalOrderId: string,
  record: ArrivalRecord,
): OrderArrivalRecord {
  // 生ペイロードは解釈せず、そのまま 1 本の文字列にする。鍵の並びは上流が届けた順のままである。
  const rawPayload = JSON.stringify(record.payload);
  return {
    recordType: ORDER_ARRIVAL_RECORD_TYPE,
    payloadVersion: ORDER_ARRIVAL_PAYLOAD_VERSION,
    eventId: orderArrivalEventId(externalOrderId, record.sequenceNumber),
    storeId,
    externalOrderId,
    arrivalTimestampMs: record.arrivalTimestampMs,
    sequenceNumber: record.sequenceNumber,
    path: record.path,
    rawPayload,
    payloadBytes: utf8.encode(rawPayload).length,
  };
}
