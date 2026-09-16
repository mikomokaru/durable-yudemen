import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSolution } from "./validate-solution.mjs";

const model = {
  variables: [
    [0, 10],
    [1, 1],
    [0, 11],
  ],
  intervals: [[0, 1, 2, null]],
  objective: [[2, 1]],
  constraints: [
    { kind: "linear", terms: [[0, 1]], lo: 3, hi: 10, when: [] },
    {
      kind: "max",
      target: 2,
      expressions: [
        [
          [0, 1],
          [1, 1],
        ],
        [[1, 1]],
      ],
    },
    { kind: "min", target: 0, values: [0, 2] },
    { kind: "element", index: 1, values: [0, 4], target: 2 },
    { kind: "noOverlap", intervals: [0] },
  ],
};
const solved = { status: "OPTIMAL", solution: [3, 1, 4], objective: 4 };
test("validates every primitive and independently recomputes objective", () => {
  assert.equal(validateSolution(model, solved), 4);
  assert.equal(validateSolution(model, { ...solved, status: "FEASIBLE", objective: 5 }), 4);
});
test("rejects invalid domains, intervals, constraints and reported optima", () => {
  for (const solution of [
    [3.1, 1, 4],
    [3, 1, 5],
    [2, 1, 3],
    [11, 1, 12],
    [3, 1],
  ])
    assert.throws(() => validateSolution(model, { ...solved, solution }));
  assert.throws(() => validateSolution(model, { ...solved, objective: 5 }));
  assert.throws(() => validateSolution(model, { ...solved, status: "UNKNOWN" }));
});
