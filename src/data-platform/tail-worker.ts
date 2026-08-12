// Data Platform 側の Tail Worker。完了済み Producer execution の tail events を、
// 別 Worker execution として受け、純粋 envelope filter と codec で妥当な
// canonical 一行だけを Queue へ送る。Producer / StoreTimerDO への逆方向経路を持たない
// （env に Producer binding が無いことで構造的に到達不能・要件 4.13, 4.14）。

import { operationLinesFromTailEvents } from "../operation-history/tail";
import type { OperationLineFailure } from "../operation-history/codec";

/**
 * Queue へ渡す一件分。canonical 一行を raw arrival として保ち（重複・欠落判定の根拠を
 * 消さない・要件 5.5, 5.7）、観測側 metadata の初回観測時刻を添える。
 */
export interface OperationRecordMessage {
  readonly canonicalLine: string;
  readonly firstObservedAt: number;
  readonly producerScript: string;
}

/** codec 解析へ到達したが妥当でなかった候補の観測側記録（Queue へ送らない・要件 4.4）。 */
export interface TailObservationFailure {
  readonly lineNumber: number;
  readonly failure: OperationLineFailure;
}

/** Tail Worker が Data Platform 側で使う binding。Producer への逆 binding を持たない。 */
export interface TailWorkerEnv {
  readonly OPERATION_RECORDS: Queue<OperationRecordMessage>;
}

/**
 * 完了済み Producer tail events を、Queue 送信用 message と観測側失敗へ純粋に分ける。
 * 全条件を満たす canonical 一行だけが入力順で message になり、不正行は 1 始まり位置と
 * 失敗種別として観測側に残る。platform 作用を持たない。
 *
 * filter は tail event 単位で呼ぶ。不正候補の位置は tail event 内の 1 始まり行番号であり、
 * message へ添える producer script は当該 event の scriptName だから、event の境界を跨がない。
 */
export function operationRecordMessagesFromTailEvents(
  events: readonly TraceItem[],
  firstObservedAt: number,
): {
  readonly messages: readonly OperationRecordMessage[];
  readonly failures: readonly TailObservationFailure[];
} {
  const messages: OperationRecordMessage[] = [];
  const failures: TailObservationFailure[] = [];

  for (const event of events) {
    const observed = operationLinesFromTailEvents([event]);
    const producerScript = event.scriptName ?? "";
    for (const canonicalLine of observed.candidates) {
      messages.push({ canonicalLine, firstObservedAt, producerScript });
    }
    failures.push(...observed.failures);
  }

  return { messages, failures };
}

/**
 * Producer 完了後に別 Worker execution として起動する tail entrypoint。
 * 妥当な Operation Record（canonical 一行）と観測側 metadata だけを Queue へ送り、
 * 不正行は Data Platform 内に観測失敗として保持する。送信・再試行は Data Platform に閉じる。
 */
const tailWorker: ExportedHandler<TailWorkerEnv> = {
  async tail(events, env): Promise<void> {
    const firstObservedAt = Date.now();
    const { messages, failures } = operationRecordMessagesFromTailEvents(events, firstObservedAt);

    if (messages.length > 0) {
      await env.OPERATION_RECORDS.sendBatch(messages.map((body) => ({ body })));
    }

    // 不正行は Producer へ返さず、Data Platform 側の観測記録として残す（要件 4.4, 4.14）。
    for (const { lineNumber, failure } of failures) {
      console.warn(JSON.stringify({ observation: "codec-failure", lineNumber, failure }));
    }
  },
};

export default tailWorker;
