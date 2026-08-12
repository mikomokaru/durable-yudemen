// Data Platform 側の Queue Consumer。Tail Worker が送った canonical 一行を raw arrival として
// R2 へ保存し、put 成功後だけ Queue へ ack する（要件 4.5）。ack は Consumer → Queue に閉じ、
// Producer / StoreTimerDO へは返さない（要件 4.15）。env に Producer binding が無いことで
// 逆方向経路は構造的に到達不能である（要件 4.13, 4.14）。

import type { OperationRecordMessage } from "./tail-worker";

/**
 * raw object に添える観測側 metadata。初回観測時刻、到着時刻、producer script、Queue delivery の
 * trace 値、canonical hash を保つ。Operation Record 本体の属性でも Timer 永続 identity でもない
 * （要件 5.3, 5.4）。R2 customMetadata は文字列値のみを取るため全て文字列で持つ。
 */
export type RawArrivalObservation = {
  readonly firstObservedAt: string;
  readonly arrivedAt: string;
  readonly producerScript: string;
  readonly queueMessageId: string;
  readonly deliveryAttempt: string;
  readonly canonicalHash: string;
};

/** R2 へ書く一件。body は canonical 一行そのままで、観測側 metadata と分離して持つ。 */
export type RawArrivalObject = {
  readonly key: string;
  readonly canonicalLine: string;
  readonly observation: RawArrivalObservation;
};

/** Queue delivery から読める、canonical 一行に属さない観測側の値。 */
export type RawArrivalDelivery = {
  readonly queueMessageId: string;
  readonly deliveryAttempt: number;
  readonly arrivedAt: number;
  readonly canonicalHash: string;
};

/** Consumer が Data Platform 側で使う binding。Producer への逆 binding を持たない。 */
export interface RawArrivalConsumerEnv {
  readonly OPERATION_RAW_ARRIVALS: R2Bucket;
}

function utcDatePrefix(epochMs: number): string {
  const at = new Date(epochMs);
  const month = `${at.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${at.getUTCDate()}`.padStart(2, "0");
  return `${at.getUTCFullYear()}/${month}/${day}`;
}

/**
 * Queue message と delivery の観測値から、R2 へ書く一件を純粋に決める。
 * key は delivery の identity（message id と配送試行回数）だけから決まるため、重複配送は
 * 既存 object を消さず上書きもせず別 object として残り、同一試行の再実行は同じ内容の冪等な
 * 書込みになる（要件 5.5, 5.7）。key に list や delete を必要とする要素を含めない。
 */
export function rawArrivalObject(
  message: OperationRecordMessage,
  delivery: RawArrivalDelivery,
): RawArrivalObject {
  return {
    key: `raw/${utcDatePrefix(message.firstObservedAt)}/${message.firstObservedAt}-${delivery.queueMessageId}-${delivery.deliveryAttempt}.json`,
    canonicalLine: message.canonicalLine,
    observation: {
      firstObservedAt: `${message.firstObservedAt}`,
      arrivedAt: `${delivery.arrivedAt}`,
      producerScript: message.producerScript,
      queueMessageId: delivery.queueMessageId,
      deliveryAttempt: `${delivery.deliveryAttempt}`,
      canonicalHash: delivery.canonicalHash,
    },
  };
}

/** canonical 一行の SHA-256 hex。曖昧性解消の補助情報であり identity ではない（要件 5.4）。 */
export async function canonicalLineHash(canonicalLine: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalLine));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Queue delivery を受ける Consumer entrypoint。一件ごとに R2 put を試し、成功した message だけを
 * ack する。put 失敗の message は ack せず Queue の再配送方針へ委ねる（要件 4.5, 4.11）。
 * 失敗記録は Data Platform 内に残し、Producer へは返さない（要件 4.13, 4.14）。
 */
const rawArrivalConsumer: ExportedHandler<RawArrivalConsumerEnv, OperationRecordMessage> = {
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const object = rawArrivalObject(message.body, {
          queueMessageId: message.id,
          deliveryAttempt: message.attempts,
          arrivedAt: Date.now(),
          canonicalHash: await canonicalLineHash(message.body.canonicalLine),
        });
        await env.OPERATION_RAW_ARRIVALS.put(object.key, object.canonicalLine, {
          customMetadata: object.observation,
        });
      } catch (error) {
        // put 成功前の ack は 0 件。再配送は Queue 側の方針に委ね、診断は Data Platform に閉じる。
        console.warn(JSON.stringify({ observation: "raw-arrival-put-failure", messageId: message.id, error: `${error}` }));
        message.retry();
        continue;
      }
      message.ack();
    }
  },
};

export default rawArrivalConsumer;
