import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCpsatObservation, serializeCpsatObservation } from "../../src/cpsat/observation";
import { summarizeCpsatObservations } from "../../src/observe/cpsat";
import fixture from "./fixtures/cpsat-counts.json";

describe("P14 CP-SAT observation", () => {
  it("is invariant under reordering and repeated delivery", () => {
    const expected = summarizeCpsatObservations(fixture.rows, fixture.coverage);
    expect(expected.usableForRates).toBe(true);
    fc.assert(
      fc.property(
        fc.array(fc.record({ copies: fc.integer({ min: 1, max: 4 }), order: fc.integer() }), {
          minLength: fixture.rows.length,
          maxLength: fixture.rows.length,
        }),
        (choices) => {
          const copies = fixture.rows
            .flatMap((row, index) => {
              const choice = choices[index]!;
              return Array.from({ length: choice.copies }, () => ({ row, order: choice.order }));
            })
            .sort((a, b) => a.order - b.order)
            .map(({ row }) => row);
          const actual = summarizeCpsatObservations(copies, fixture.coverage);
          expect(actual.usableForRates).toBe(true);
          expect(actual.totals).toEqual(expected.totals);
          expect(actual.minutes).toEqual(expected.minutes);
          expect(actual.duplicateRows).toBe(copies.length - fixture.rows.length);
        },
      ),
      { seed: 20260909, numRuns: 150 },
    );
  });

  it("round trips finite timestamps and rejects extra input without exposing it", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), fc.string(), (at, secret) => {
        const input = { ...fixture.rows[1], at };
        const parsed = parseCpsatObservation(input);
        expect(parsed).not.toBeNull();
        if (parsed === null) throw new Error("fixture");
        expect(parseCpsatObservation(serializeCpsatObservation(parsed))).toEqual(input);
        expect(parseCpsatObservation({ ...input, forbidden: secret })).toBeNull();
      }),
      { seed: 20260910, numRuns: 150 },
    );
  });

  it("does not accept a missing causal predecessor even when its children are duplicated", () => {
    // これらは全て子を持つ行。末端行の脱落は取得 manifest の責務であり、相関だけで断定しない。
    const parentIds = ["g-1", "g-2", "p-2", "d-2"];
    fc.assert(
      fc.property(fc.constantFrom(...parentIds), fc.integer({ min: 1, max: 5 }), (id, repeat) => {
        const remaining = fixture.rows.filter((row) => row.eventId !== id);
        const summary = summarizeCpsatObservations(
          Array.from({ length: repeat }, () => remaining).flat(),
          fixture.coverage,
        );
        expect(summary.usableForRates).toBe(false);
        expect(summary.issues).toContain("broken-causal-link");
        expect(summary.totals[0]?.counts).toBeNull();
      }),
      { seed: 20260911, numRuns: 100 },
    );
  });
});
