import type { Model } from "../../experiments/cpsat-workers/tuning/schedule";

// OR-Tools v9.15 cp_model.proto. Encode the small, closed model vocabulary built
// by the shared TS formulation; no native/Python solver or protobuf dependency.
class Proto {
  readonly bytes: number[] = [];

  private varint(value: number): void {
    if (!Number.isSafeInteger(value)) throw new Error("Non-integer protobuf value");
    let n = BigInt.asUintN(64, BigInt(value));
    while (n > 127n) {
      this.bytes.push(Number(n & 127n) | 128);
      n >>= 7n;
    }
    this.bytes.push(Number(n));
  }

  int(field: number, value: number): this {
    this.varint(field * 8);
    this.varint(value);
    return this;
  }

  message(field: number, value: Proto): this {
    this.varint(field * 8 + 2);
    this.varint(value.bytes.length);
    for (const byte of value.bytes) this.bytes.push(byte);
    return this;
  }

  double(field: number, value: number): this {
    this.varint(field * 8 + 1);
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.bytes.push(...bytes);
    return this;
  }
}

function expression(terms: readonly (readonly [number, number])[], scale = 1, offset = 0): Proto {
  const result = new Proto();
  for (const [variable, weight] of terms) result.int(1, variable).int(2, weight * scale);
  // LinearExpressionProto.offset（field 3）。0 は既定値なので書かない（無駄な byte を載せない）。
  if (offset !== 0) result.int(3, offset * scale);
  return result;
}

export function encodeModel(model: Model): Uint8Array {
  const result = new Proto();
  for (const [lo, hi] of model.variables) result.message(2, new Proto().int(2, lo).int(2, hi));
  // noOverlap stores indices into this initial interval-constraint prefix.
  for (const [start, size, end, presence] of model.intervals) {
    const constraint = new Proto();
    if (presence !== null) constraint.int(2, presence);
    constraint.message(
      19,
      new Proto()
        .message(4, expression([[start, 1]]))
        .message(5, expression([[end, 1]]))
        .message(6, expression([[size, 1]])),
    );
    result.message(3, constraint);
  }
  for (const row of model.constraints) {
    const constraint = new Proto();
    if (row.kind === "linear") {
      for (const literal of row.when) constraint.int(2, literal);
      const linear = new Proto().int(3, row.lo).int(3, row.hi);
      for (const [variable, weight] of row.terms) linear.int(1, variable).int(2, weight);
      constraint.message(12, linear);
    } else if (row.kind === "max" || row.kind === "min") {
      const scale = row.kind === "min" ? -1 : 1;
      const terms = row.kind === "min" ? row.values.map((v) => [[v, 1] as const]) : row.expressions;
      const maximum = new Proto().message(1, expression([[row.target, 1]], scale));
      for (const term of terms) maximum.message(2, expression(term, scale));
      constraint.message(27, maximum);
    } else if (row.kind === "elementVars") {
      // 変数を引く element。`exprs`（field 6）に線形式をそのまま書く。定数表を引く `element` と
      // 同じ ElementConstraintProto（field 14）で、値の書き方だけが違う。
      const element = new Proto()
        .message(4, expression([[row.index, 1]]))
        .message(5, expression([[row.target, 1]]));
      for (const expr of row.exprs) element.message(6, expression(expr.terms, 1, expr.offset));
      constraint.message(14, element);
    } else if (row.kind === "element") {
      const element = new Proto()
        .message(4, expression([[row.index, 1]]))
        .message(5, expression([[row.target, 1]]));
      for (const value of row.values) element.message(6, new Proto().int(3, value));
      constraint.message(14, element);
    } else if (row.kind === "noOverlap") {
      const overlap = new Proto();
      for (const index of row.intervals) overlap.int(1, index);
      constraint.message(20, overlap);
    } else {
      // CumulativeConstraintProto: capacity=1, intervals=2, demands=3。
      // ConstraintProto の cumulative は field 22（no_overlap=20・no_overlap_2d=21 の次）。
      // **黙って無視されないことを試験で確かめている**（tests/cpsat-cumulative.example.test.ts）
      // ——番号を取り違えると制約が消えたまま解が返り、それは静かな誤りになる。
      const cumulative = new Proto();
      cumulative.message(1, expression(row.capacity.terms, 1, row.capacity.offset));
      for (const index of row.intervals) cumulative.int(2, index);
      for (const demand of row.demands)
        cumulative.message(3, expression(demand.terms, 1, demand.offset));
      constraint.message(22, cumulative);
    }
    result.message(3, constraint);
  }
  const objective = new Proto().double(3, 1);
  for (const [variable, weight] of model.objective) objective.int(1, variable).int(4, weight);
  result.message(4, objective);
  const hint = new Proto();
  for (const [variable, value] of model.hints) hint.int(1, variable).int(2, value);
  result.message(6, hint);
  const bytes = Uint8Array.from(result.bytes);
  if (bytes.length > 1048576) throw new Error("CP-SAT model exceeds 1 MiB");
  return bytes;
}
