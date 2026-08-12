import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { printCanonicalOperationLine } from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";
import { operationLinesFromTailEvents } from "../../src/operation-history/tail";

const NUM_RUNS = 200;
const PRODUCER_SCRIPTS = [
  "yude-men-timer-dev",
  "yude-men-timer-stage",
  "yude-men-timer-prod",
] as const;

type CandidateBlueprint = {
  readonly token: number;
  readonly scriptName: (typeof PRODUCER_SCRIPTS)[number] | "other-worker" | null;
  readonly level: "log" | "warn" | "error";
  readonly argumentCount: 0 | 1 | 2;
  readonly argumentType: "string" | "number" | "object";
  readonly lineValidity: "canonical" | "invalid-json" | "non-canonical" | "multiple-lines";
};

const genCandidateBlueprint: fc.Arbitrary<CandidateBlueprint> = fc.record({
  token: fc.integer({ min: 0, max: 1_000_000 }),
  scriptName: fc.constantFrom(...PRODUCER_SCRIPTS, "other-worker", null),
  level: fc.constantFrom("log", "warn", "error"),
  argumentCount: fc.constantFrom(0, 1, 2),
  argumentType: fc.constantFrom("string", "number", "object"),
  lineValidity: fc.constantFrom("canonical", "invalid-json", "non-canonical", "multiple-lines"),
});

function canonicalLine(token: number): string {
  return printCanonicalOperationLine({
    storeId: `store-${token}`,
    timerId: `timer-${token}`,
    operationKind: "completed",
    eventTime: (token + 1) as OperationRecord["eventTime"],
    slotIds: [`slot-${token}`],
    noodleType: `noodle-${token}`,
    firmness: "normal",
  });
}

function stringArgument(blueprint: CandidateBlueprint): string {
  const line = canonicalLine(blueprint.token);
  switch (blueprint.lineValidity) {
    case "canonical": return line;
    case "invalid-json": return line.slice(0, -1);
    case "non-canonical": return ` ${line}`;
    case "multiple-lines": return `${line}\n${line}`;
  }
}

function consoleArgument(blueprint: CandidateBlueprint): unknown {
  switch (blueprint.argumentType) {
    case "string": return stringArgument(blueprint);
    case "number": return blueprint.token;
    case "object": return { line: stringArgument(blueprint) };
  }
}

function message(blueprint: CandidateBlueprint): readonly unknown[] {
  const argument = consoleArgument(blueprint);
  switch (blueprint.argumentCount) {
    case 0: return [];
    case 1: return [argument];
    case 2: return [argument, "extra"];
  }
}

function isQueueCandidate(blueprint: CandidateBlueprint): boolean {
  return blueprint.scriptName !== null
    && PRODUCER_SCRIPTS.includes(blueprint.scriptName as (typeof PRODUCER_SCRIPTS)[number])
    && blueprint.level === "log"
    && blueprint.argumentCount === 1
    && blueprint.argumentType === "string"
    && blueprint.lineValidity === "canonical";
}

describe("Property 11: Tail envelope filtering", () => {
  // **Validates: Requirements 4.3, 4.4**
  it("全 envelope 条件を満たす一行だけを入力順で Queue 候補にする", () => {
    fc.assert(
      fc.property(fc.array(genCandidateBlueprint, { minLength: 1, maxLength: 40 }), (blueprints) => {
        const events = blueprints.map((blueprint) => ({
          scriptName: blueprint.scriptName,
          logs: [{ level: blueprint.level, message: message(blueprint) }],
        }));
        const expected = blueprints
          .filter(isQueueCandidate)
          .map((blueprint) => canonicalLine(blueprint.token));

        expect(operationLinesFromTailEvents(events).candidates).toEqual(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
