#!/usr/bin/env node
// 本番の計画行を店舗別に集計する（読み取りのみ・配備も設定変更もしない）。
//
//   set -a; . experiments/cpsat-workers/fixtures/local/observability.env; set +a
//   node experiments/cpsat-workers/quality/collect-plan-decisions.mjs OUT.json [minutes]
//
// 2 つの Worker から読む。**採否と画面の由来はアプリ側（DO）にしか無い**——`cpsat.plan-decided`
// は `StoreTimerDO.deliverPlan` が出す（2026-09-13 配備・版 a4412cad）。計画 Worker 側の
// `cpsat-plan-computed` は局面の規模（`pending`・`slices`）を持つ。両者を `requestId` で突き合わせると、
// 棄却の段が分かる——`pending > 6` かつ `slices == 1` の棄却は一片の完全被覆（段 1）であって
// 計画の良し悪しではなく、`pending <= 6` の棄却は非改善（段 2）である。
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ACCOUNT = "305d89a643ac689b4204454c5493cbde";
const WORKER = "yude-men-cpsat-planner-dev";
/** 採否と**画面の由来**はアプリ側（DO）が出す（`cpsat.plan-decided`・2026-09-13 配備）。 */
const APP = "yude-men-timer";
const output = process.argv[2];
const minutes = Number(process.argv[3] ?? 180);
if (!output || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
  throw new Error("Usage: collect-plan-decisions.mjs OUT.json [minutes 1..1440]");
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set; load observability.env first.");

const to = Math.floor(Date.now() / 60_000) * 60_000;
const from = to - minutes * 60_000;
// 1 回の応答は 1000 行で頭打ちになり cursor も返らない。ゆえに**時間で刻む**。
// 刻みが飽和（1000 行）した区間は「読み切れていない」として記録し、率を主張しない。
const SLICE_MS = 3 * 60_000;
const rows = [];
/** 求解 1 回ぶんの CPU・wall。構造化ログには無いので invocation event から取る。 */
const invocations = [];
const slices = [];
for (let start = from; start < to; start += SLICE_MS) {
  const end = Math.min(start + SLICE_MS, to);
  // Worker ごとに別の問い合わせにする。`in` 演算子で 2 サービスをまとめる形は 0 行を返した
  // （2026-09-13 実測）——静かに 0 を返す形を残さない。
  for (const [service, type] of [
    [WORKER, "cf-worker"],
    [APP, "cf-worker"],
    // invocation event。**CPU と wall はここにしか無い**（構造化ログには載らない）。
    [WORKER, "cf-worker-event"],
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          queryId: "cpsat-plan-decisions",
          view: "events",
          limit: 1000,
          timeframe: { from: start, to: end },
          parameters: {
            filters: [
              { key: "$metadata.service", operation: "eq", type: "string", value: service },
              { key: "$metadata.type", operation: "eq", type: "string", value: type },
            ],
          },
        }),
      },
    );
    // oxlint-disable-next-line no-await-in-loop
    const body = await response.json().catch(() => null);
    const events = body?.result?.events?.events ?? [];
    slices.push({
      service,
      type,
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      status: response.status,
      count: events.length,
      saturated: events.length >= 1000,
    });
    if (!response.ok) continue;
    for (const event of events) {
      if (type === "cf-worker-event") {
        const workers = event?.$workers;
        if (typeof workers?.cpuTimeMs === "number")
          invocations.push({
            cpuMs: workers.cpuTimeMs,
            wallMs: typeof workers.wallTimeMs === "number" ? workers.wallTimeMs : null,
            outcome: workers.outcome ?? null,
            at: event?.timestamp ?? null,
          });
        continue;
      }
      // 構造化ログは `source` に**解析済みの object** として載る（`$workers.event.logs` ではない）。
      const value =
        typeof event?.source === "string" ? tryParse(event.source) : (event?.source ?? null);
      if (value && typeof value === "object" && typeof value.kind === "string")
        rows.push({ ...value, at: event?.timestamp ?? null });
    }
  }
}

function tryParse(text) {
  const offset = text.indexOf('{"');
  if (offset < 0) return null;
  try {
    return JSON.parse(text.slice(offset));
  } catch {
    return null;
  }
}

const computed = rows.filter((row) => row.kind === "cpsat-plan-computed");
const decided = rows.filter((row) => row.kind === "cpsat.plan-decided");
// 段の判別は突き合わせで行う（`admit` の内側の理由は engine の契約を動かさないと運べない）。
const scale = new Map(computed.map((row) => [row.requestId, row]));
const joined = decided.map((row) => {
  const solve = scale.get(row.requestId) ?? null;
  const pending = solve?.pending ?? null;
  const slices = solve?.slices ?? null;
  const stage =
    row.outcome === "adopted"
      ? null
      : pending === null
        ? "unknown"
        : pending > 6 && slices === 1
          ? "coverage"
          : pending <= 6
            ? "not-improving"
            : "ambiguous";
  return { ...row, pending, slices, stage };
});
const tally = (values) =>
  values.reduce(
    (counts, value) => ({ ...counts, [String(value)]: (counts[String(value)] ?? 0) + 1 }),
    {},
  );

const byStore = new Map();
for (const row of computed) {
  const entry = byStore.get(row.storeId) ?? {
    storeId: row.storeId,
    solves: 0,
    pending: [],
    placements: [],
    running: [],
    status: {},
  };
  entry.solves += 1;
  entry.pending.push(row.pending);
  entry.placements.push(row.placements);
  entry.running.push(row.running);
  entry.status[row.status] = (entry.status[row.status] ?? 0) + 1;
  byStore.set(row.storeId, entry);
}
const distribution = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1),
    mean: Math.round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
    // **本番の上限を超える回の比率。** 分布の分位だけでは「上限に当たる回がどれだけ在るか」が
    // 読み取れない（測定窓では cpu_ms を上げているので、その回も成功として記録されている）。
    over: Object.fromEntries(
      [5000, 10000, 15000, 20000, 30000].map((limit) => [
        limit,
        sorted.filter((v) => v > limit).length,
      ]),
    ),
  };
};
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? null
    : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const stores = [...byStore.values()]
  .map((entry) => ({
    storeId: entry.storeId,
    solves: entry.solves,
    status: entry.status,
    pendingMin: Math.min(...entry.pending),
    pendingP50: quantile(entry.pending, 0.5),
    pendingMax: Math.max(...entry.pending),
    solvesWithPendingOverSix: entry.pending.filter((value) => value > 6).length,
    runningMax: Math.max(...entry.running),
    placements: [...new Set(entry.placements)].sort((a, b) => a - b),
  }))
  .sort((a, b) => b.solves - a.solves);

const allPending = computed.map((row) => row.pending);
const report = {
  collectedAt: new Date().toISOString(),
  window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), minutes },
  worker: WORKER,
  slices,
  saturatedSlices: slices.filter((slice) => slice.saturated).length,
  kinds: Object.fromEntries(
    [...new Set(rows.map((row) => row.kind))].map((kind) => [
      kind,
      rows.filter((row) => row.kind === kind).length,
    ]),
  ),
  solves: computed.length,
  stores: stores.length,
  pendingOverall: {
    min: allPending.length ? Math.min(...allPending) : null,
    p50: quantile(allPending, 0.5),
    max: allPending.length ? Math.max(...allPending) : null,
    overSix: allPending.filter((value) => value > 6).length,
  },
  // **CPU の分布が測定窓の主目的である。** 上限に当たった回を失敗として消さないよう、
  // 窓の間だけ consumer の cpu_ms を上げてある（verification/cpsat-cpu-window-20260913.md）。
  resource: {
    invocations: invocations.length,
    cpuMs: distribution(invocations.map((row) => row.cpuMs)),
    wallMs: distribution(invocations.flatMap((row) => (row.wallMs === null ? [] : [row.wallMs]))),
    outcomes: tally(invocations.map((row) => row.outcome)),
  },
  failures: {
    planFailed: rows.filter((row) => row.kind === "cpsat-plan-failed").length,
    reasons: tally(
      rows
        .filter((row) => row.kind === "cpsat-plan-failed")
        .map((row) => String(row.reason ?? row.error ?? "").slice(0, 60)),
    ),
    queueRejected: rows.filter((row) => row.kind === "cpsat-queue-rejected").length,
  },
  // 求解が長くなると同じ isolate への衝突が増え、busy の再配送が戻りうる。
  retries: {
    received: rows.filter((row) => row.kind === "cpsat-queue-received").length,
    attemptsOverOne: rows.filter(
      (row) => row.kind === "cpsat-queue-received" && Number(row.attempts) > 1,
    ).length,
    attempts: tally(
      rows.filter((row) => row.kind === "cpsat-queue-received").map((row) => row.attempts),
    ),
  },
  adoption: {
    decided: decided.length,
    matchedToSolve: joined.filter((row) => row.pending !== null).length,
    outcome: tally(joined.map((row) => row.outcome)),
    // **画面の由来。** 非 0 なら、その時点で画面に出ている配置は外部計画（CP-SAT）由来である。
    standingAcceptedSlices: tally(joined.map((row) => row.standingAcceptedSlices)),
    rejectionStage: tally(
      joined.filter((row) => row.outcome === "rejected").map((row) => row.stage),
    ),
    adoptedStores: [
      ...new Set(joined.filter((row) => row.outcome === "adopted").map((row) => row.storeId)),
    ],
    standingStores: [
      ...new Set(
        joined.filter((row) => (row.standingAcceptedSlices ?? 0) > 0).map((row) => row.storeId),
      ),
    ],
  },
  perStore: stores,
};
await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(
  JSON.stringify(
    {
      report: resolve(output),
      solves: report.solves,
      stores: report.stores,
      pendingOverall: report.pendingOverall,
      resource: report.resource,
      failures: report.failures,
      retries: report.retries,
      adoption: report.adoption,
      kinds: report.kinds,
      saturatedSlices: report.saturatedSlices,
    },
    null,
    2,
  ),
);
