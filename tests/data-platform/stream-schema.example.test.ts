// 配備する schema ファイルと、送信前の validator が同じ定義から出ていることの機械的な固定。
// ここが緩むと、送る側と stream の列がずれても型検査は通り、ずれた行は取込後に落ちる。

import { describe, expect, it } from "vitest";
import deployedSchema from "../../config/history-pipelines/arrivals-v1.schema.json";
import {
  ARRIVAL_FIELDS,
  arrivalStreamSchema,
  operationArrival,
} from "../../src/data-platform/arrival";
import { canonicalPayload, completedRecord, observation } from "./support/arrival-fixture";

describe("物理 schema の唯一の出所", () => {
  it("配備する schema ファイルが列定義と一致する", () => {
    expect(deployedSchema).toEqual(arrivalStreamSchema());
  });

  it("列定義が行の属性を過不足なく覆う", () => {
    const row = operationArrival(completedRecord, canonicalPayload, observation);

    expect(Object.keys(row).sort()).toEqual([...ARRIVAL_FIELDS.map((field) => field.name)].sort());
  });

  it("列の順序を世代内で固定する", () => {
    // 順序は schema ファイルと table の列順に現れる。世代を上げずに並べ替えない。
    expect(ARRIVAL_FIELDS.map((field) => field.name)).toEqual([
      "dataset",
      "physicalVersion",
      "payloadVersion",
      "arrivalId",
      "eventId",
      "storeId",
      "source",
      "guarantee",
      "eventTime",
      "observedAt",
      "canonicalPayload",
      "sourceMetadata",
      "isSynthetic",
      "probeId",
    ]);
  });
});
