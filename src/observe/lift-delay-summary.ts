// 遅延ログの要約（lift-delay-log 要件 6）。
//
// 数え方の線を 3 つ引く。**取消を完了の標本に混ぜない。開始の行が見つからない終端を 0 杯で埋めない。
// 同じ ID の異内容を上書きしない。** どれも「分からない」を数字に化けさせないための線である。
//
// 分位点は 0 件なら null にする。件数が少ないほど分位点は意味を失うので、0 を返して「遅れ 0 秒」と
// 読まれる余地を残さない（要件 6.4）。

import { parseLiftDelayLine, parseLiftDelayStartLine } from "../lift-delay/codec";
import {
  completionDelayMs,
  LIFT_DELAY_RECORD_TYPE,
  LIFT_DELAY_START_RECORD_TYPE,
  type LiftDelayRecord,
  type LiftDelayStartRecord,
} from "../lift-delay/record";

/** 分布の区切り（秒）。表示のための区切りであり、生ログの切詰めには使わない。 */
const BUCKET_BOUNDS_SEC = [0, 5, 15, 30, 60, 120] as const;

export interface LiftDelayCounts {
  readonly storedRows: number;
  readonly startRows: number;
  readonly terminalRows: number;
  readonly completed: number;
  readonly cancelled: number;
  /** 同じ eventId で内容が違う行。分析から外し、raw は消さない。 */
  readonly conflicts: number;
  /** 開始の行が見つからなかった終端。0 杯・単独群で埋めない。 */
  readonly contextUnknown: number;
  readonly faults: number;
}

export interface DelayDistribution {
  readonly negative: number;
  readonly zero: number;
  readonly upTo5s: number;
  readonly upTo15s: number;
  readonly upTo30s: number;
  readonly upTo60s: number;
  readonly upTo120s: number;
  readonly over120s: number;
}

export interface LiftDelaySummary {
  readonly counts: LiftDelayCounts;
  /**
   * 突合率。**保存済みの終端に対して開始が見つかった割合**であって、全操作に対する欠落率ではない。
   * 開始も終端も落ちた麺は、ここには現れない（要件 9）。
   */
  readonly contextMatch: {
    readonly matched: number;
    readonly terminals: number;
    readonly rate: number | null;
  };
  readonly delay: {
    readonly samples: number;
    readonly early: number;
    readonly zero: number;
    readonly late: number;
    readonly medianMs: number | null;
    readonly p90Ms: number | null;
    readonly maxMs: number | null;
    readonly distribution: DelayDistribution;
  };
  /** 日別の完了件数。既定は Asia/Tokyo（要件 6.5）。 */
  readonly byDay: Readonly<Record<string, number>>;
  readonly timezone: string;
  /** 条件別に絞るための素材。不明は混ぜない。 */
  readonly byBackorder: {
    readonly withContext: number;
    readonly medianPendingOtherItems: number | null;
  };
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  // 偶数なら中央 2 値の平均（要件 6.2 の初期方式）。
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function nearestRankP90(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(0.9 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

function distributionOf(delays: readonly number[]): DelayDistribution {
  const counts = { negative: 0, zero: 0, buckets: [0, 0, 0, 0, 0], over: 0 };
  for (const delay of delays) {
    if (delay < 0) {
      counts.negative += 1;
      continue;
    }
    if (delay === 0) {
      counts.zero += 1;
      continue;
    }
    const seconds = delay / 1000;
    const index = BUCKET_BOUNDS_SEC.slice(1).findIndex((bound) => seconds <= bound);
    if (index < 0) counts.over += 1;
    else counts.buckets[index] = (counts.buckets[index] ?? 0) + 1;
  }
  return {
    negative: counts.negative,
    zero: counts.zero,
    upTo5s: counts.buckets[0] ?? 0,
    upTo15s: counts.buckets[1] ?? 0,
    upTo30s: counts.buckets[2] ?? 0,
    upTo60s: counts.buckets[3] ?? 0,
    upTo120s: counts.buckets[4] ?? 0,
    over120s: counts.over,
  };
}

/** epoch ms を指定 timezone の日付にする。日別の境界を timezone とともに出力へ残す。 */
function dayOf(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

type DecodedRows = {
  readonly terminals: Map<string, LiftDelayRecord>;
  readonly starts: Map<string, LiftDelayStartRecord>;
  readonly conflicts: number;
  readonly faults: number;
  readonly startRows: number;
  readonly terminalRows: number;
};

function decode(rows: readonly Readonly<Record<string, unknown>>[]): DecodedRows {
  const terminals = new Map<string, LiftDelayRecord>();
  const starts = new Map<string, LiftDelayStartRecord>();
  const lines = new Map<string, string>();
  let conflicts = 0;
  let faults = 0;
  let startRows = 0;
  let terminalRows = 0;

  for (const row of rows) {
    const payload = row.canonicalPayload;
    if (typeof payload !== "string") {
      faults += 1;
      continue;
    }
    if (payload.includes(`"recordType":"${LIFT_DELAY_START_RECORD_TYPE}"`)) {
      const parsed = parseLiftDelayStartLine(payload);
      if (!parsed.ok) {
        faults += 1;
        continue;
      }
      startRows += 1;
      const seen = lines.get(parsed.record.eventId);
      // 同じ ID で内容が違えば競合。**上書きしない。**
      if (seen !== undefined && seen !== payload) conflicts += 1;
      else {
        lines.set(parsed.record.eventId, payload);
        starts.set(`${parsed.record.storeId}:${parsed.record.timerId}`, parsed.record);
      }
      continue;
    }
    if (!payload.includes(`"recordType":"${LIFT_DELAY_RECORD_TYPE}"`)) {
      faults += 1;
      continue;
    }
    const parsed = parseLiftDelayLine(payload);
    if (!parsed.ok) {
      faults += 1;
      continue;
    }
    terminalRows += 1;
    const seen = lines.get(parsed.record.eventId);
    if (seen !== undefined && seen !== payload) conflicts += 1;
    else {
      lines.set(parsed.record.eventId, payload);
      terminals.set(parsed.record.eventId, parsed.record);
    }
  }

  return { terminals, starts, conflicts, faults, startRows, terminalRows };
}

/** 取得した行から遅延の要約を作る。行の集合だけに依存し、時計も I/O も持たない。 */
export function summarizeLiftDelayRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  timeZone = "Asia/Tokyo",
): LiftDelaySummary {
  const decoded = decode(rows);
  const records = [...decoded.terminals.values()];
  const completed = records.filter((record) => record.outcome === "completed");
  const cancelled = records.length - completed.length;

  const delays = completed
    .map((record) => completionDelayMs(record))
    .filter((delay): delay is number => delay !== null);
  const sorted = [...delays].sort((left, right) => left - right);

  const byDay: Record<string, number> = {};
  for (const record of completed) {
    const day = dayOf(record.terminalAt, timeZone);
    byDay[day] = (byDay[day] ?? 0) + 1;
  }

  const matched = records.filter((record) =>
    decoded.starts.has(`${record.storeId}:${record.timerId}`),
  );
  const pendingOther = matched
    .map((record) => decoded.starts.get(`${record.storeId}:${record.timerId}`))
    .flatMap((start) => (start === undefined ? [] : [start.pendingOtherItems]))
    .sort((left, right) => left - right);

  return {
    counts: {
      storedRows: rows.length,
      startRows: decoded.startRows,
      terminalRows: decoded.terminalRows,
      completed: completed.length,
      cancelled,
      conflicts: decoded.conflicts,
      contextUnknown: records.length - matched.length,
      faults: decoded.faults,
    },
    contextMatch: {
      matched: matched.length,
      terminals: records.length,
      rate: records.length === 0 ? null : matched.length / records.length,
    },
    delay: {
      samples: delays.length,
      early: delays.filter((delay) => delay < 0).length,
      zero: delays.filter((delay) => delay === 0).length,
      late: delays.filter((delay) => delay > 0).length,
      medianMs: median(sorted),
      p90Ms: nearestRankP90(sorted),
      maxMs: sorted.length === 0 ? null : (sorted[sorted.length - 1] as number),
      distribution: distributionOf(delays),
    },
    byDay,
    timezone: timeZone,
    byBackorder: {
      withContext: matched.length,
      medianPendingOtherItems: median(pendingOther),
    },
  };
}
