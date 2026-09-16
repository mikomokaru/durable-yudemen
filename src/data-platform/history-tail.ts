// 共通の履歴基盤の入口。Producer の実行完了後に別 Worker 実行として起動し、観測できた canonical 行を
// 物理行へ写して Pipelines の Stream へ直接送る（operation-history-log 要件 4.1 / 4.4 / 4.5）。
//
// Queue も Consumer も配送台帳も持たない。送れなかった行はそこで失われる——それが best-effort の
// 意味であり、失った件数を後から作らないことがこの入口の契約である（要件 4.3）。
//
// Producer / StoreTimerDO への逆方向経路を持たない。env に Stream binding しか無いことで、
// 構造的に到達不能である（要件 4.1）。

import type { Pipeline } from "cloudflare:pipelines";
import {
  liftDelayArrival,
  operationArrival,
  orderArrivalArrival,
  validateArrival,
  type ArrivalRejection,
  type Dataset,
  type HistoryArrival,
  type TailObservation,
  type Truncation,
} from "./arrival";
import type { OperationLineFailure } from "../operation-history/codec";
import { PRODUCER_SCRIPTS, operationLinesFromTailEvents } from "../operation-history/tail";
import { liftDelayLinesFromTailEvents } from "../lift-delay/tail";
import type { LiftDelayLineFailure } from "../lift-delay/codec";
import {
  orderArrivalLinesFromTailEvents,
  type OrderArrivalLineFailure,
} from "../order-arrival/tail";

/**
 * 合成プローブの Producer script。経路が生きているかを確かめるためだけに動く専用 Worker であり、
 * **合成かどうかは script 名だけで決める**——payload の申告で合成を名乗れると、業務行を合成として
 * 分析から外す道が開く（要件 7.3）。プローブ行の probeId には、プローブが採番した Timer ID を使う。
 */
export const PROBE_SCRIPT = "yude-men-history-probe";

/** この入口が受け入れる script。業務の Producer と合成プローブだけ。 */
export const ACCEPTED_SCRIPTS: ReadonlySet<string> = new Set([...PRODUCER_SCRIPTS, PROBE_SCRIPT]);

/**
 * 1 回の send に載せる上限と、1 invocation が行う send の回数。
 *
 * Pipelines の 1 取込要求は 5 MB が上限で、byte 上限はそこへ十分な余裕を持たせた値。件数と回数は
 * tail invocation の実行予算を有界にするために置く。上限を超えた分は送らずに数える（要件 4.5）。
 * 実測に基づく確定はタスク 1.3。
 */
export const SEND_RECORD_LIMIT = 100;
export const SEND_BYTE_LIMIT = 1_000_000;
export const SEND_BATCH_LIMIT = 4;

/** 送らなかった一件と、その理由。件数だけでなく理由を残す（要件 4.4 / 4.5）。 */
export type IntakeDiscard =
  | {
      readonly kind: "codec";
      readonly lineNumber: number;
      readonly failure: OperationLineFailure;
      /** 検査が落ちた場（オブジェクト経路のみ）。 */
      readonly issues?: readonly string[];
    }
  | {
      readonly kind: "lift-delay-codec";
      readonly lineNumber: number;
      readonly failure: LiftDelayLineFailure;
      readonly issues?: readonly string[];
    }
  | {
      readonly kind: "order-arrival-codec";
      readonly lineNumber: number;
      readonly failure: OrderArrivalLineFailure;
      readonly issues?: readonly string[];
    }
  | { readonly kind: "schema"; readonly arrivalId: string; readonly rejection: ArrivalRejection }
  | { readonly kind: "send-budget"; readonly arrivalId: string };

export interface TailIntake {
  readonly batches: readonly (readonly HistoryArrival[])[];
  readonly discards: readonly IntakeDiscard[];
}

/** tail event のうち、この入口が読む部分。TraceItem はこの形を満たす。 */
export interface ObservedTailEvent {
  readonly scriptName: string | null;
  readonly logs: readonly { readonly level: string; readonly message: readonly unknown[] }[];
  readonly truncated?: boolean;
}

/**
 * 切詰めは三値で持つ。`truncated` を読めない runtime では **false と言い切らない**——
 * 「確認して無かった」と「確認する手段が無かった」を同じ値にすると、欠落の調査で嘘になる（要件 4.7）。
 */
function truncationOf(event: ObservedTailEvent): Truncation {
  if (typeof event.truncated !== "boolean") return "unknown";
  return event.truncated ? "detected" : "not-detected";
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * 観測した tail events を、送る batch と送らない一件へ純粋に分ける。
 *
 * event ごとに filter を呼ぶのは、行番号と script 名が event 内で閉じた事実だからである。
 * arrival ID の採番だけを呼び出し側から受け取り、この関数自体は時刻も乱数も持たない。
 */
export function historyIntake(
  events: readonly ObservedTailEvent[],
  observedAt: number,
  mintArrivalId: () => string,
): TailIntake {
  const accepted: HistoryArrival[] = [];
  const discards: IntakeDiscard[] = [];

  for (const event of events) {
    const observed = operationLinesFromTailEvents([event], ACCEPTED_SCRIPTS);
    for (const { lineNumber, failure, issues } of observed.failures) {
      discards.push({ kind: "codec", lineNumber, failure, ...(issues ? { issues } : {}) });
    }

    const isProbe = event.scriptName === PROBE_SCRIPT;
    const observation = {
      observedAt,
      producerScript: event.scriptName ?? "",
      truncation: truncationOf(event),
    } satisfies Omit<TailObservation, "arrivalId" | "probeId">;

    // 遅延ログの行。同じ封筒・同じ Tail を通り、dataset だけが違う（lift-delay-log 要件 5.3）。
    const delays = liftDelayLinesFromTailEvents([event], ACCEPTED_SCRIPTS);
    for (const { lineNumber, failure, issues } of delays.failures) {
      discards.push({
        kind: "lift-delay-codec",
        lineNumber,
        failure,
        ...(issues ? { issues } : {}),
      });
    }
    for (const candidate of delays.candidates) {
      const arrivalId = mintArrivalId();
      const facts =
        candidate.kind === "terminal"
          ? {
              eventId: candidate.record.eventId,
              storeId: candidate.record.storeId,
              eventTime: candidate.record.terminalAt,
              payloadVersion: candidate.record.payloadVersion,
            }
          : {
              eventId: candidate.record.eventId,
              storeId: candidate.record.storeId,
              eventTime: candidate.record.startedAt,
              payloadVersion: candidate.record.payloadVersion,
            };
      const checked = validateArrival(
        liftDelayArrival(facts, candidate.line, {
          ...observation,
          arrivalId,
          probeId: isProbe ? candidate.record.timerId : null,
        }),
      );
      if (!checked.ok) {
        discards.push({ kind: "schema", arrivalId, rejection: checked.rejection });
        continue;
      }
      accepted.push(checked.arrival);
    }

    // 注文到着の行。同じ封筒・同じ Tail を通り、dataset だけが違う（order-arrival-log）。
    const orders = orderArrivalLinesFromTailEvents([event], ACCEPTED_SCRIPTS);
    for (const { lineNumber, failure, issues } of orders.failures) {
      discards.push({
        kind: "order-arrival-codec",
        lineNumber,
        failure,
        ...(issues ? { issues } : {}),
      });
    }
    for (const candidate of orders.candidates) {
      const arrivalId = mintArrivalId();
      const checked = validateArrival(
        orderArrivalArrival(
          {
            eventId: candidate.record.eventId,
            storeId: candidate.record.storeId,
            eventTime: candidate.record.arrivalTimestampMs,
            payloadVersion: candidate.record.payloadVersion,
          },
          candidate.line,
          { ...observation, arrivalId, probeId: null },
        ),
      );
      if (!checked.ok) {
        discards.push({ kind: "schema", arrivalId, rejection: checked.rejection });
        continue;
      }
      accepted.push(checked.arrival);
    }

    for (const candidate of observed.candidates) {
      const arrivalId = mintArrivalId();
      const checked = validateArrival(
        operationArrival(candidate.record, candidate.line, {
          ...observation,
          arrivalId,
          probeId: isProbe ? candidate.record.timerId : null,
        }),
      );
      if (!checked.ok) {
        discards.push({ kind: "schema", arrivalId, rejection: checked.rejection });
        continue;
      }
      accepted.push(checked.arrival);
    }
  }

  return packBatches(accepted, discards);
}

/**
 * 送信単位へ分ける。**同じ batch に別の dataset を混ぜない**——送り先の Stream が違うからである。
 * 予算（件数・byte・回数）は dataset をまたいで共有する。tail invocation 全体の上限だからである。
 */
function packBatches(accepted: readonly HistoryArrival[], discards: IntakeDiscard[]): TailIntake {
  const batches: HistoryArrival[][] = [];
  let current: HistoryArrival[] = [];
  let currentBytes = 0;
  let currentDataset: Dataset | null = null;

  for (const arrival of accepted) {
    const bytes = utf8Bytes(JSON.stringify(arrival));
    const full =
      current.length >= SEND_RECORD_LIMIT ||
      currentBytes + bytes > SEND_BYTE_LIMIT ||
      (currentDataset !== null && currentDataset !== arrival.dataset);
    if (full && current.length > 0) {
      batches.push(current);
      current = [];
      currentBytes = 0;
      currentDataset = null;
    }
    if (batches.length >= SEND_BATCH_LIMIT) {
      discards.push({ kind: "send-budget", arrivalId: arrival.arrivalId });
      continue;
    }
    current.push(arrival);
    currentBytes += bytes;
    currentDataset = arrival.dataset;
  }
  if (current.length > 0) batches.push(current);

  return { batches, discards };
}

/**
 * この入口の binding。Producer・Queue・R2・DO への経路を持たない。
 *
 * **dataset ごとに Stream を分ける。** 共有した Stream へ pipeline SQL で振り分ける形だと、SQL を
 * 後から変更できない以上、dataset を足すたびに operation 側の pipeline を作り直すことになる
 * （operation-history-log 要件 4.9）。
 */
export interface HistoryTailEnv {
  readonly HISTORY_ARRIVALS: Pipeline<HistoryArrival>;
  readonly LIFT_DELAY_ARRIVALS: Pipeline<HistoryArrival>;
  readonly ORDER_ARRIVAL_ARRIVALS: Pipeline<HistoryArrival>;
}

/**
 * 送信の診断。Tail 自身のログは同じ Tail の収集対象ではない（Producer script の allowlist に
 * 入っていない）ため、再帰的に取り込まれない。
 */
function diagnose(observation: string, detail: Record<string, unknown>): void {
  console.warn(JSON.stringify({ observation, ...detail }));
}

/** batch の行き先。dataset は batch 内で揃っている（packBatches が分けている）。 */
function streamFor(env: HistoryTailEnv, dataset: Dataset): Pipeline<HistoryArrival> {
  switch (dataset) {
    case "lift-delay":
      return env.LIFT_DELAY_ARRIVALS;
    case "order-arrival":
      return env.ORDER_ARRIVAL_ARRIVALS;
    case "operation":
      return env.HISTORY_ARRIVALS;
  }
}

async function sendBatch(env: HistoryTailEnv, batch: readonly HistoryArrival[]): Promise<void> {
  const dataset = batch[0]?.dataset ?? "operation";
  try {
    await streamFor(env, dataset).send([...batch]);
  } catch (error) {
    // send の失敗は Data Platform 内に閉じる。Producer へ返さず、再試行もしない（要件 4.5）。
    diagnose("history-send-failure", { dataset, records: batch.length, error: `${error}` });
  }
}

const historyTail: ExportedHandler<HistoryTailEnv> = {
  async tail(events, env, ctx): Promise<void> {
    const intake = historyIntake(events, Date.now(), () => crypto.randomUUID());

    for (const batch of intake.batches) {
      // send の完了を invocation の外へ逃がさず追跡する。成功は ingested の確認に限り、
      // Iceberg 可視を意味しない（要件 4.6）。
      ctx.waitUntil(sendBatch(env, batch));
    }

    if (intake.discards.length > 0) {
      diagnose("history-intake-discards", {
        count: intake.discards.length,
        discards: intake.discards,
      });
    }
  },
};

export default historyTail;
