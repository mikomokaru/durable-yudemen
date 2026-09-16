import assert from "node:assert/strict";

/** Validate the returned vector, not the solver's claim about its objective. */
export function validateSolution(model, result) {
  assert(["OPTIMAL", "FEASIBLE"].includes(result.status));
  const v = result.solution;
  assert.equal(v.length, model.variables.length);
  model.variables.forEach(([lo, hi], i) =>
    assert(Number.isSafeInteger(v[i]) && v[i] >= lo && v[i] <= hi, `Variable domain: ${i}`),
  );
  const expression = (terms) => terms.reduce((sum, [i, weight]) => sum + v[i] * weight, 0);
  const literal = (i) => (i >= 0 ? v[i] === 1 : v[-i - 1] === 0);
  const active = ([, , , presence]) => presence === null || literal(presence);
  for (const interval of model.intervals)
    if (active(interval)) {
      assert(v[interval[1]] >= 0);
      assert.equal(v[interval[0]] + v[interval[1]], v[interval[2]]);
    }
  for (const c of model.constraints) {
    if (c.kind === "linear") {
      if (c.when.every(literal)) {
        const value = expression(c.terms);
        assert(value >= c.lo && value <= c.hi, "Linear constraint");
      }
    } else if (c.kind === "max")
      assert.equal(v[c.target], Math.max(...c.expressions.map(expression)));
    else if (c.kind === "min") assert.equal(v[c.target], Math.min(...c.values.map((i) => v[i])));
    else if (c.kind === "element") {
      assert(v[c.index] >= 0 && v[c.index] < c.values.length);
      assert.equal(v[c.target], c.values[v[c.index]]);
    } else if (c.kind === "noOverlap") {
      const intervals = c.intervals.map((i) => model.intervals[i]).filter(active);
      for (let i = 0; i < intervals.length; i++)
        for (let j = i + 1; j < intervals.length; j++) {
          const a = intervals[i],
            b = intervals[j];
          assert(v[a[2]] <= v[b[0]] || v[b[2]] <= v[a[0]], "Overlapping Wasm intervals");
        }
    } else assert.fail(`Unsupported validation: ${c.kind}`);
  }
  const actual = expression(model.objective);
  assert(Number.isFinite(result.objective) && actual <= result.objective + 0.001);
  if (result.status === "OPTIMAL") assert(Math.abs(actual - result.objective) < 0.001);
  return actual;
}
