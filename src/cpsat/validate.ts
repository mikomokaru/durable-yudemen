import type { Model } from "../../experiments/cpsat-workers/tuning/schedule";
import type { SolverResult } from "../../experiments/cpsat-workers/src/runtime";

export function validateSolution(model: Model, result: SolverResult): void {
  const require = (value: boolean, why = "") => {
    if (!value) throw new Error(`Invalid CP-SAT solution${why === "" ? "" : `: ${why}`}`);
  };
  // **解が無いことと、解が壊れていることは別である。** 同じ文言で投げると、予算切れ・
  // 実行不能・モデルの誤りが 1 つの失敗に潰れ、どれを直せばよいか分からない（2026-09-13）。
  require(result.status === "OPTIMAL" ||
    result.status === "FEASIBLE", `no solution (status=${result.status})`);
  const v = result.solution;
  require(v.length === model.variables.length);
  model.variables.forEach(([lo, hi], i) =>
    require(Number.isSafeInteger(v[i]) && v[i]! >= lo && v[i]! <= hi),
  );
  const expression = (terms: readonly (readonly [number, number])[]) =>
    terms.reduce((sum, [i, weight]) => sum + v[i]! * weight, 0);
  const literal = (i: number) => (i >= 0 ? v[i] === 1 : v[-i - 1] === 0);
  const active = ([, , , presence]: Model["intervals"][number]) =>
    presence === null || literal(presence);
  for (const interval of model.intervals)
    if (active(interval))
      require(v[interval[1]]! >= 0 && v[interval[0]]! + v[interval[1]]! === v[interval[2]]);
  for (const c of model.constraints) {
    if (c.kind === "linear") {
      if (c.when.every(literal)) {
        const value = expression(c.terms);
        require(value >= c.lo && value <= c.hi);
      }
    } else if (c.kind === "max")
      require(v[c.target] === Math.max(...c.expressions.map(expression)));
    else if (c.kind === "min") require(v[c.target] === Math.min(...c.values.map((i) => v[i]!)));
    else if (c.kind === "elementVars") {
      const index = v[c.index]!;
      require(index >= 0 && index < c.exprs.length, "elementVars index out of range");
      const chosen = c.exprs[index]!;
      require(v[c.target] ===
        expression(chosen.terms) + chosen.offset, "elementVars target mismatch");
    } else if (c.kind === "element")
      require(
        v[c.index]! >= 0 && v[c.index]! < c.values.length && v[c.target] === c.values[v[c.index]!],
      );
    else if (c.kind === "noOverlap") {
      const intervals = c.intervals.map((i) => model.intervals[i]!).filter(active);
      for (let i = 0; i < intervals.length; i++)
        for (let j = i + 1; j < intervals.length; j++) {
          const a = intervals[i]!,
            b = intervals[j]!;
          require(v[a[2]]! <= v[b[0]]! || v[b[2]]! <= v[a[0]]!);
        }
    } else {
      // 累積資源。**開始時刻だけを見れば足りる**——覆う区間の集合が変わるのは、どれかの区間が
      // 始まる時刻だけだからである（区間が終わる時刻では集合は減るので、負荷は増えない）。
      //
      // **検査は符号化とは独立である。** 制約が黙って落ちた符号化（field 番号の取り違えなど）を、
      // 返ってきた解の側から捕まえるために置く。
      const capacity = expression(c.capacity.terms) + c.capacity.offset;
      const present = c.intervals
        .map((index, position) => ({ interval: model.intervals[index]!, position }))
        .filter(({ interval }) => active(interval));
      for (const { interval } of present) {
        const at = v[interval[0]]!;
        let load = 0;
        for (const { interval: other, position } of present) {
          const demand = c.demands[position]!;
          if (v[other[0]]! <= at && at < v[other[2]]!)
            load += expression(demand.terms) + demand.offset;
        }
        require(load <= capacity, `cumulative load ${load} > capacity ${capacity}`);
      }
    }
  }
  const actual = expression(model.objective);
  require(
    result.objective !== null &&
      Number.isFinite(result.objective) &&
      actual <= result.objective + 0.001,
  );
  if (result.status === "OPTIMAL") require(Math.abs(actual - result.objective!) < 0.001);
}
