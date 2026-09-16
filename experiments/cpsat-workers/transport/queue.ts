// 輸送を Queue へ移すための、送出側・受領側で共有する純粋な部分。
//
// **ここに実行時の I/O は無い。** Queue binding にも WASM にも触れず、形と検査だけを置く。
// 送出側（producer）と consumer が同じ判断を二箇所に書かないための共有点である。
//
// design 第9節 9.1「配送」と requirements R6.4 が、この関門を求めている——1 通の上限を
// 超える要求は送出前に落とし、黙って消えないよう観測可能な失敗にする。
import type { CpsatObservation } from "../../../src/cpsat/observation";

/**
 * Queue の 1 メッセージの上限（[Queues limits](https://developers.cloudflare.com/queues/platform/limits/)）。
 *
 * 内部 metadata が約 100 バイト載るため、その分を引いた値を関門に用いる。上限ちょうどで
 * 通して配送時に落ちるより、手前で落として理由を残すほうがよい。
 */
export const QUEUE_MESSAGE_LIMIT_BYTES = 128 * 1024;
const QUEUE_METADATA_ALLOWANCE_BYTES = 1024;

/** 送出できる上限。実測（44,081 B / 77,696 B）はいずれもこの下にある。 */
export const QUEUE_PAYLOAD_LIMIT_BYTES = QUEUE_MESSAGE_LIMIT_BYTES - QUEUE_METADATA_ALLOWANCE_BYTES;

/**
 * Queue に載せる 1 件。観測行（`CpsatObservation`）をそのまま運ぶ。
 *
 * 別の形へ詰め替えないのは、送出側が既に組んでいる値だからである。詰め替えれば同じ
 * フィールドの列挙がもう一箇所に増え、版の食い違いの箱になる。
 */
export interface CpsatQueueMessage {
  readonly row: CpsatObservation;
}

/** 送出前の検査の結末。超過は理由を持つ失敗で、成功と区別できる。 */
export type QueuePayloadCheck =
  | { readonly ok: true; readonly body: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: "too-large"; readonly bytes: number };

/**
 * 送出前にサイズを検査する。**超過を黙って落とさない**（R6.4）。
 *
 * バイト数は UTF-8 で数える——`String.length` は符号単位の数であり、日本語の商品名を
 * 含む要求では実際のバイト数と食い違う。
 */
export function checkQueuePayload(message: CpsatQueueMessage): QueuePayloadCheck {
  const body = JSON.stringify(message);
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > QUEUE_PAYLOAD_LIMIT_BYTES) return { ok: false, reason: "too-large", bytes };
  return { ok: true, body, bytes };
}
