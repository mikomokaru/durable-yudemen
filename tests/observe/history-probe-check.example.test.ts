// プローブの到達確認。読めた・確認できなかった・読み取りが失敗した、を畳まないことを固定する。

import { describe, expect, it } from "vitest";
import { checkProbeVisibility } from "../../src/observe/history-probe-check";
import type { PageRunner } from "../../src/observe/history-fetch";
import { INGEST_COLUMN, type HistoryScope } from "../../src/observe/history-query";
import type { QueryOutcome } from "../../src/observe/history-response";

const scope: HistoryScope = {
  dataset: "operation",
  table: "history.operation_arrivals_v1",
  ingestFrom: "2026-09-12T00:00:00Z",
  ingestTo: "2026-09-13T00:00:00Z",
};

const metrics = { bytesScanned: 10, filesScanned: 1, r2Requests: 1 };
const EMITTED_AT = 1_700_000_000_000;

const found = (count: number): QueryOutcome => ({
  ok: true,
  rows: Array.from({ length: count }, () => ({
    probeId: "probe-1",
    eventTime: EMITTED_AT,
    [INGEST_COLUMN]: "2026-09-12T06:00:01Z",
  })),
  columns: ["probeId", "eventTime", INGEST_COLUMN],
  metrics,
});

const empty: QueryOutcome = { ok: true, rows: [], columns: [], metrics };
const failed: QueryOutcome = {
  ok: false,
  failure: "rejected",
  errors: [{ code: 10000, message: "Authentication error" }],
};

/** 呼ばれるたびに時計を 30 秒進める実行体。待機は即座に返す。 */
function harness(outcomes: readonly QueryOutcome[]) {
  let current = EMITTED_AT;
  let index = 0;
  const queries: string[] = [];
  const run: PageRunner = (query) => {
    queries.push(query);
    current += 30_000;
    const outcome = outcomes[index] ?? empty;
    index += 1;
    return Promise.resolve(outcome);
  };
  return {
    run,
    queries,
    clock: { now: () => current, sleep: () => Promise.resolve() },
  };
}

const limits = { attempts: 4, deadlineMs: 15 * 60 * 1000 };

describe("プローブの到達確認", () => {
  it("読めたら経過時間と取込時刻を返す", async () => {
    const { run, clock, queries } = harness([empty, found(1)]);

    const check = await checkProbeVisibility(run, scope, "probe-1", EMITTED_AT, limits, clock);

    expect(check.status).toBe("visible");
    if (check.status !== "visible") return;
    expect(check.attempts).toBe(2);
    expect(check.elapsedMs).toBe(60_000);
    expect(check.ingestedAt).toBe("2026-09-12T06:00:01Z");
    expect(check.duplicated).toBe(false);
    expect(queries[0]).toContain("probeId = 'probe-1'");
  });

  it("同じ ID が複数行あれば経路の複製として印を付ける", async () => {
    const { run, clock } = harness([found(2)]);

    const check = await checkProbeVisibility(run, scope, "probe-1", EMITTED_AT, limits, clock);

    expect(check.status === "visible" && check.duplicated).toBe(true);
  });

  it("回数を使い切ったら未確認で終える（永続再送しない）", async () => {
    const { run, clock, queries } = harness([empty, empty, empty, empty, found(1)]);

    const check = await checkProbeVisibility(run, scope, "probe-1", EMITTED_AT, limits, clock);

    expect(check).toMatchObject({
      status: "unconfirmed",
      attempts: 4,
      reason: "attempts-exhausted",
    });
    // 5 回目は撃たない。
    expect(queries).toHaveLength(4);
  });

  it("期限を過ぎたら回数が残っていても未確認で終える", async () => {
    const { run, clock } = harness([empty, empty]);

    const check = await checkProbeVisibility(
      run,
      scope,
      "probe-1",
      EMITTED_AT,
      {
        attempts: 4,
        deadlineMs: 45_000,
      },
      clock,
    );

    expect(check).toMatchObject({ status: "unconfirmed", reason: "deadline-exceeded" });
  });

  it("読み取りの失敗を未確認と混同しない", async () => {
    const { run, clock } = harness([failed]);

    const check = await checkProbeVisibility(run, scope, "probe-1", EMITTED_AT, limits, clock);

    expect(check.status).toBe("reader-failed");
    if (check.status !== "reader-failed") return;
    expect(check.errors[0]?.code).toBe(10000);
    // 失敗の時点で止める。同じ失敗を回数分繰り返さない。
    expect(check.attempts).toBe(1);
  });
});
