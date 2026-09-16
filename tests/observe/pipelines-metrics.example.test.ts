// Pipelines の指標の解釈。取れなかったことを 0 件と言わない、差を「落ちた数」と呼ばない。

import { describe, expect, it } from "vitest";
import {
  PIPELINE_HEALTH_QUERY,
  droppedByValidation,
  pendingOrDropped,
  readPipelineHealth,
} from "../../src/observe/pipelines-metrics";

const response = {
  data: {
    viewer: {
      accounts: [
        {
          operator: [{ sum: { recordsIn: 120, decodeErrors: 2, bytesIn: 40_000 } }],
          sink: [{ sum: { recordsWritten: 100, filesWritten: 5, bytesWritten: 30_000 } }],
          userErrors: [
            { count: 3, dimensions: { errorFamily: "validation", errorType: "type_mismatch" } },
            { count: 1, dimensions: { errorFamily: "validation", errorType: "missing_field" } },
          ],
        },
      ],
    },
  },
  errors: null,
};

describe("指標の解釈", () => {
  it("取込・書込・検証エラーを読む", () => {
    const outcome = readPipelineHealth(response);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.health.recordsIn).toBe(120);
    expect(outcome.health.recordsWritten).toBe(100);
    expect(outcome.health.decodeErrors).toBe(2);
    expect(outcome.health.userErrors).toEqual([
      { errorFamily: "validation", errorType: "type_mismatch", count: 3 },
      { errorFamily: "validation", errorType: "missing_field", count: 1 },
    ]);
  });

  it("時間帯ごとに分かれた集計を足し合わせる", () => {
    const hourly = {
      ...response,
      data: {
        viewer: {
          accounts: [
            {
              operator: [
                { sum: { recordsIn: 10, decodeErrors: 0, bytesIn: 1 } },
                { sum: { recordsIn: 5, decodeErrors: 1, bytesIn: 1 } },
              ],
              sink: [{ sum: { recordsWritten: 15, filesWritten: 1, bytesWritten: 1 } }],
              userErrors: [],
            },
          ],
        },
      },
    };

    const outcome = readPipelineHealth(hourly);

    expect(outcome.ok && outcome.health.recordsIn).toBe(15);
    expect(outcome.ok && outcome.health.decodeErrors).toBe(1);
  });

  it("認可されない応答を 0 件にしない", () => {
    const outcome = readPipelineHealth({
      data: null,
      errors: [{ message: "authentication error" }],
    });

    expect(outcome).toEqual({
      ok: false,
      failure: "rejected",
      errors: ["authentication error"],
    });
  });

  it("形の違う応答を取得できなかったものとして扱う", () => {
    expect(readPipelineHealth({ data: { viewer: { accounts: [] } } }).ok).toBe(false);
    expect(readPipelineHealth("<html>502</html>").ok).toBe(false);
  });

  it("集計が空でも成功なら 0 として読む", () => {
    const outcome = readPipelineHealth({
      data: { viewer: { accounts: [{ operator: [], sink: [], userErrors: [] }] } },
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.health.recordsIn).toBe(0);
  });
});

describe("差の読み方", () => {
  const health = {
    recordsIn: 120,
    decodeErrors: 2,
    recordsWritten: 100,
    filesWritten: 5,
    userErrors: [{ errorFamily: "validation", errorType: "type_mismatch", count: 3 }],
  };

  it("取込と書込の差は「落ちた数」ではない", () => {
    // roll 待ちの分も差に出る。名前でそれを表明する。
    expect(pendingOrDropped(health)).toBe(20);
  });

  it("落ちたと言い切れるのは検証で弾かれた分だけである", () => {
    expect(droppedByValidation(health)).toBe(5);
  });
});

describe("query の形", () => {
  it("3 種の集計を 1 回で取り、pipeline と期間で絞る", () => {
    expect(PIPELINE_HEALTH_QUERY).toContain("pipelinesOperatorAdaptiveGroups");
    expect(PIPELINE_HEALTH_QUERY).toContain("pipelinesSinkAdaptiveGroups");
    expect(PIPELINE_HEALTH_QUERY).toContain("pipelinesUserErrorsAdaptiveGroups");
    expect(PIPELINE_HEALTH_QUERY).toContain("datetime_geq: $from");
    expect(PIPELINE_HEALTH_QUERY).toContain("pipelineId: $pipelineId");
  });
});
