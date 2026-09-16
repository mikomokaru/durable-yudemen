// 注文到着の原事実（order-arrival-log）。
//
// **記録するのは「POS が何を、いつ、どの店舗へ届けたか」だけである。** 品目の解釈は一切しない。
// 何杯の麺か、どの麺種か、といった読み方は `order_items` の構造を知ることであり、それは素通し原則
// （pos-order-ingress 要件 14）が守っている領域である。ここで構造を読めば、ベンダーが項目を 1 つ
// 増やしただけで記録が壊れる側になる。
//
// **ベンダーの綴りを型に持ち込まない。** 一意キーの 4 要素（`store_id` / `terminal_id` / `bill_no` /
// `datetime`）は `toUniqueKey` が 1 本の文字列へ畳んだ形でだけ持つ。禁止された 12 個のキーは、この
// file のどこにも型メンバとして現れない（`tests/pos-order-ingress.static.test.ts` の (b)）。
//
// 生ペイロードは**文字列のまま**持つ。検査もしない。実測では 1 件およそ 711 バイト、品目の多い注文で
// 約 1,048 バイトであり（pos-order-ingress タスク）、物理行の上限 16 KB に対しておよそ 15 倍の余裕が
// ある。超えた場合は物理検証が理由付きで弾き、Tail が `history-intake-discards` に数える——静かには
// 消えない。

/** 形式の名乗り。操作履歴・遅延ログのどちらとも衝突しない語を選ぶ。 */
export const ORDER_ARRIVAL_RECORD_TYPE = "order-arrival";

/** payload の形式版。属性を足すときに上げる。物理世代（列の集合）とは別である。 */
export const ORDER_ARRIVAL_PAYLOAD_VERSION = 1;

/**
 * 注文到着 1 件。
 *
 * `externalOrderId` は `toUniqueKey(payload)` の結果そのものである。ドメインが注文を指すときに使う
 * 値と**同一**なので（`src/shell/store-timer-do.ts` が同じ関数で採番している）、遅延ログの開始記録に
 * 載せた同名の値と直接突き合う。相関のために新しい対応表を作らない。
 */
export interface OrderArrivalRecord {
  readonly recordType: typeof ORDER_ARRIVAL_RECORD_TYPE;
  readonly payloadVersion: number;
  /** 到着 1 件の安定 ID。同じ注文の後着も別の到着として残す。 */
  readonly eventId: string;
  /** 我々の店舗 slug。POS の Store_Code ではない。 */
  readonly storeId: string;
  /** 注文の同定子。`toUniqueKey` の結果で、ドメインの `externalOrderId` と同値である。 */
  readonly externalOrderId: string;
  /** 上流が観測から付与した到着時刻。**我々の受信時刻ではない。** */
  readonly arrivalTimestampMs: number;
  /** 上流が観測から付与した連番。同じ注文の後着を区別する。 */
  readonly sequenceNumber: string;
  /** 上流が観測から付与した経路（`/lio/order` 等）。Order_Path と Status_Path を分ける。 */
  readonly path: string;
  /** ベンダー由来の申告値そのまま。**解釈しない。** */
  readonly rawPayload: string;
  /** 生ペイロードの UTF-8 byte 数。`rawPayload` を読まずに大きさを数えられるようにする。 */
  readonly payloadBytes: number;
}

/**
 * 到着 1 件の安定イベント ID。
 *
 * `toUniqueKey` の結果と上流の連番を `#` で繋ぐ。**`#` を区切りに選べる**のは、一意キーが上流と同じ
 * パーセントエンコードを通っており、素通しされる文字が英数字と `- . / _ ~`、区切りが `:` だけだから
 * である（`src/ingress/unique-key.ts`）。ゆえに一意キーの側に `#` は決して現れず、最初の `#` で
 * 一意に分かれる。
 *
 * **連番を混ぜるのは、同じ注文の後着を別の到着として数えるためである。** 上流は同じ一意キーの新しい
 * Record で未着手品目を置き換える（`docs/pos-records-ingress-api.md`）。連番を混ぜずに一意キーだけを
 * ID にすると、後着が先着と同じ ID になり、読み出しで 1 件へ畳まれて**置き換えが起きた事実が消える**。
 */
export function orderArrivalEventId(externalOrderId: string, sequenceNumber: string): string {
  return `${externalOrderId}#${sequenceNumber}`;
}
