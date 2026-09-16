// 注文到着の Producer（order-arrival-log）。
//
// 操作履歴・遅延ログと同じ規律で動く。**受理した Record を、同期 console 出力として 1 回試みる。**
// 失敗は外へ出さない。待たない。再試行しない。POS への応答にも保存にも触れない。
//
// **店舗 DO を経由しない。** ここは注文取り込みの Worker（root）の中であり、記録は POS が届けた事実
// そのものである。DO を通せば、観測のために厨房の経路へ仕事を足すことになる。
//
// **配備の順序: Tail を先に出す。** 古い Tail はこの dataset を知らず、行を黙って落とす。

import type { ArrivalRecord } from "../ingress/batch";
import { orderArrivalPayload } from "./codec";
import { orderArrivalRecordOf } from "./derive";

/** 1 店舗分の受理した Record と、その宛先。 */
export interface OrderArrivalObservation {
  /** 解決済みの店舗 slug。未解決の Record はここへ来ない。 */
  readonly storeId: string;
  /** 受理した Record と、その注文の同定子（`toUniqueKey` の結果）。 */
  readonly records: readonly {
    readonly record: ArrivalRecord;
    readonly externalOrderId: string;
  }[];
}

/**
 * 受理した Record を best-effort に console へ出す。
 *
 * 1 件の失敗を他の件にも POS の応答にも伝播させない。操作履歴の `tryWriteOperationLines` と同じ形である。
 */
export function tryWriteOrderArrivalLines(
  enabled: boolean,
  observation: OrderArrivalObservation,
): void {
  if (!enabled) return;

  try {
    for (const { record, externalOrderId } of observation.records) {
      try {
        console.log(
          orderArrivalPayload(orderArrivalRecordOf(observation.storeId, externalOrderId, record)),
        );
      } catch {
        // 1 件の観測失敗を後続の件にも取り込みの応答にも伝播させない。
      }
    }
  } catch {
    return;
  }
}
