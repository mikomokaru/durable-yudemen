import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  operationRecordPayload,
  printCanonicalOperationLine,
} from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";
import { operationLinesFromTailEvents } from "../../src/operation-history/tail";

const NUM_RUNS = 200;
// 現存する Producer script は root wrangler.jsonc の "name" ただ一つ。
const PRODUCER_SCRIPTS = ["yude-men-timer"] as const;
// filter が落とすべき script 名。環境別 script は未導入ゆえ実在せず、ここに属する。
const OTHER_SCRIPTS = ["other-worker", "yude-men-timer-prod"] as const;

type CandidateBlueprint = {
  readonly token: number;
  readonly scriptName: (typeof PRODUCER_SCRIPTS)[number] | (typeof OTHER_SCRIPTS)[number] | null;
  readonly level: "log" | "warn" | "error";
  readonly argumentCount: 0 | 1 | 2;
  // "payload" は Producer がいま出す形（記録のオブジェクトそのもの）。"object" は名乗らないオブジェクト。
  readonly argumentType: "string" | "number" | "object" | "payload";
  readonly lineValidity: "canonical" | "invalid-json" | "non-canonical" | "multiple-lines";
};

const genCandidateBlueprint: fc.Arbitrary<CandidateBlueprint> = fc.record({
  token: fc.integer({ min: 0, max: 1_000_000 }),
  // 想定 Producer が一つに減った分だけ重みで補い、Queue 候補が現れる密度を保つ。
  scriptName: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...PRODUCER_SCRIPTS) },
    { weight: 2, arbitrary: fc.constantFrom(...OTHER_SCRIPTS, null) },
  ),
  level: fc.constantFrom("log", "warn", "error"),
  argumentCount: fc.constantFrom(0, 1, 2),
  argumentType: fc.constantFrom("string", "number", "object", "payload"),
  lineValidity: fc.constantFrom("canonical", "invalid-json", "non-canonical", "multiple-lines"),
});

function recordOf(token: number): OperationRecord {
  return {
    storeId: `store-${token}`,
    timerId: `timer-${token}`,
    operationKind: "completed",
    eventTime: (token + 1) as OperationRecord["eventTime"],
    slotIds: [`slot-${token}`],
    noodleType: `noodle-${token}`,
    firmness: "normal",
  };
}

function canonicalLine(token: number): string {
  return printCanonicalOperationLine(recordOf(token));
}

function stringArgument(blueprint: CandidateBlueprint): string {
  const line = canonicalLine(blueprint.token);
  switch (blueprint.lineValidity) {
    case "canonical":
      return line;
    case "invalid-json":
      return line.slice(0, -1);
    case "non-canonical":
      return ` ${line}`;
    case "multiple-lines":
      return `${line}\n${line}`;
  }
}

function consoleArgument(blueprint: CandidateBlueprint): unknown {
  switch (blueprint.argumentType) {
    case "string":
      return stringArgument(blueprint);
    case "number":
      return blueprint.token;
    case "object":
      // 名乗らないオブジェクト（他機能の構造化ログ）。
      return { line: stringArgument(blueprint) };
    case "payload":
      return operationRecordPayload(recordOf(blueprint.token));
  }
}

function message(blueprint: CandidateBlueprint): readonly unknown[] {
  const argument = consoleArgument(blueprint);
  switch (blueprint.argumentCount) {
    case 0:
      return [];
    case 1:
      return [argument];
    case 2:
      return [argument, "extra"];
  }
}

/** 封筒までは同じ条件。中身の条件だけが姿ごとに違う。 */
function passesEnvelope(blueprint: CandidateBlueprint): boolean {
  return (
    blueprint.scriptName !== null &&
    PRODUCER_SCRIPTS.includes(blueprint.scriptName as (typeof PRODUCER_SCRIPTS)[number]) &&
    blueprint.level === "log" &&
    blueprint.argumentCount === 1
  );
}

function isQueueCandidate(blueprint: CandidateBlueprint): boolean {
  if (!passesEnvelope(blueprint)) return false;
  // オブジェクトで届く経路は `lineValidity`（文字列の壊し方）に左右されない。
  if (blueprint.argumentType === "payload") return true;
  return blueprint.argumentType === "string" && blueprint.lineValidity === "canonical";
}

describe("Property 11: Tail envelope filtering", () => {
  // **Validates: Requirements 4.3, 4.4**
  it("全 envelope 条件を満たす一行だけを入力順で Queue 候補にする", () => {
    fc.assert(
      fc.property(
        fc.array(genCandidateBlueprint, { minLength: 1, maxLength: 40 }),
        (blueprints) => {
          const events = blueprints.map((blueprint) => ({
            scriptName: blueprint.scriptName,
            logs: [{ level: blueprint.level, message: message(blueprint) }],
          }));
          const expected = blueprints.filter(isQueueCandidate).map((blueprint) => ({
            line: canonicalLine(blueprint.token),
            record: recordOf(blueprint.token),
          }));

          expect(operationLinesFromTailEvents(events).candidates).toEqual(expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
