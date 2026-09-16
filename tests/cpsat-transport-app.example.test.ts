import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseConfigFileTextToJson } from "typescript";
import { expect, expectTypeOf, it } from "vitest";
import { isRecord } from "../src/domain/predicate";
import { parseCpsatObservation } from "../src/cpsat/observation";
import provenance from "./observe/fixtures/cpsat-transport-provenance.json";

it("CP-SAT を閉じた配備設定が、想定した接続だけを持つ", async () => {
  // **2026-09-16 に K-2 版へ戻した（配備差分 §3.5 の手順 1）。** CP-SAT への経路を全部閉じる判断による。
  // ガードは削除せず反転する——「無いこと」を確かめる検査を消すと、戻し忘れも増やし過ぎも
  // 同じように見えなくなる。再開するときは、この it が落ちることで目に入る。
  const path = "wrangler.jsonc";
  const parsed = parseConfigFileTextToJson(path, await readFile(path, "utf8"));
  expect(parsed.error).toBeUndefined();
  const config: unknown = parsed.config;
  if (!isRecord(config) || !isRecord(config.vars) || !Array.isArray(config.services))
    throw new Error("Root config is malformed");

  // 入口は本来の worker。試験 app（検証用 RPC を 2 つ足す側）は経路から外した。
  expect(config.main).toBe("src/worker.ts");
  // 試験の輸送 shim は経路から外した（2026-09-12）。`ts` へ戻したときの経路として
  // 本来の TS solver を指す。**求解 Worker への直接 binding は無い**——持てば呼べてしまい、
  // 同期の求解に呼出元が握られる連鎖が復活する。
  // 札の Worker（item-display-abbreviation）が 2 本目として加わった（2026-09-15）。**この検査が守る禁は
  // 変わらない**——「求解 Worker への直接 binding は無い」ことであって、service binding の本数ではない。
  // 追加した接続はここへ明示的に書き、増えたことが目に入る形にする。
  //
  // 札の Worker を分けたのは、root に `ai` / `kv_namespaces` を置くと `StoreTimerDO` の env にも現れる
  // ためである（`class StoreTimerDO extends DurableObject<Env>`）。閉じているのは「DO が AI・KV の
  // **直接** binding を持たない」ことで、この service binding 自体は DO からも見える（SOLVER と同じ）。
  expect(config.services).toEqual([
    { binding: "SOLVER", service: "yude-men-solver" },
    { binding: "SHORT_NAMES_WORKER", service: "yude-men-short-names" },
  ]);
  // **Queue の投入口は設定に残るが、到達できない。** `PLANNER_BACKEND: "ts"` の枝は
  // `SOLVER` へ送って Queue に一切触れないので、経路としては閉じている。
  // binding 自体を消すには `StoreTimerDO` の CP-SAT 分岐も一緒に落とす必要があり
  // （`env.CPSAT_PLAN_QUEUE.send` が型で要求する）、それは別の変更として残す。
  expect(config.queues).toEqual({
    producers: [{ binding: "CPSAT_PLAN_QUEUE", queue: "cpsat-plan-requests" }],
  });
  // 公開範囲は配備前の実測（true）を維持する。省略で既定へ流れないよう明示する。
  expect(config.workers_dev).toBe(true);
  // **計画器の選択は明示する**（design 第1.1節）。2026-09-16、CP-SAT を閉じて `ts` へ戻した。
  // 二重の安全弁を両方閉じたことを固定する——`ts` なら shell は `SOLVER` へ送って Queue に
  // 触れず、有効化世代が空なら `cpsat` に戻しても送出は止まる（R1.6）。
  // **再び有効化する変更は、この検査が落ちることで目に入る。**
  expect(config.vars).toMatchObject({ PLANNER_BACKEND: "ts", CPSAT_ACTIVATION_ID: "" });
  // DO と assets は据え置き。ここが変わると既存データと画面に影響する。
  expect(config.durable_objects).toEqual({
    bindings: [
      { name: "STORE_TIMER_DO", class_name: "StoreTimerDO" },
      { name: "STORE_REGISTRY_DO", class_name: "StoreRegistryDO" },
    ],
  });
  expect(isRecord(config.assets) && config.assets.binding).toBe("ASSETS");

  // Access の3値は配備済みの値がリポジトリに無い。設定に書いて上書きするのでは
  // なく、配備時に --var で明示する（--keep-vars だけに頼らない）。
  expect(config.vars).toMatchObject({ ACCESS_REQUIRED: "0" });

  const localPath = "experiments/cpsat-workers/transport/wrangler.types.jsonc";
  const localParsed = parseConfigFileTextToJson(localPath, await readFile(localPath, "utf8"));
  expect(localParsed.error).toBeUndefined();
  const localConfig: unknown = localParsed.config;
  if (!isRecord(localConfig)) throw new Error("Local type config is malformed");
  expect(localConfig).not.toHaveProperty("name");
  expect(localConfig).not.toHaveProperty("main");
  // 型生成用の設定にも求解 Worker への binding は無い。残すと生成される d.ts に型だけが
  // 残り、設定から消しても型検査が呼び出しを通してしまう（2026-09-12）。
  expect(localConfig).not.toHaveProperty("services");
  expect(localConfig.queues).toEqual({
    producers: [{ binding: "CPSAT_PLAN_QUEUE", queue: "cpsat-plan-requests" }],
  });
});

it("private app → 固定WASM → 実StoreDOと拒否経路をローカルCLIで検証する", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-app-test-"));
  const output = resolve(scratch, "report.json");
  await promisify(execFile)(
    process.execPath,
    ["experiments/cpsat-workers/transport/check-app-local.mjs", output],
    { timeout: 28_000, maxBuffer: 1_048_576 },
  );
  const report: unknown = JSON.parse(await readFile(output, "utf8"));
  // The report is written before teardown, so the run's end lives beside it.
  const teardown: unknown = JSON.parse(await readFile(`${output}.teardown.json`, "utf8"));
  if (!isRecord(teardown) || !Array.isArray(teardown.closes) || !isRecord(teardown.ledger))
    throw new Error("Teardown record is malformed");
  // Every socket reported its close event; none was released on a timeout, and
  // the slots came back only because of that confirmation.
  expect(teardown.closes.every((row: unknown) => isRecord(row) && row.confirmed === true)).toBe(
    true,
  );
  expect(teardown.ledger).toMatchObject({ openConnections: 0, unconfirmedConnections: 0 });
  expect(teardown.error).toBeNull();
  if (!isRecord(report) || !Array.isArray(report.observations) || !isRecord(report.countSummary))
    throw new Error("Local report is malformed");
  expect(report.cloudEvidence).toBe(false);
  expect(report.appEffectPathTested).toBe(true);
  expect(report.engineGeneration).toEqual({
    measured: false,
    count: null,
    reason: "H1 is not wired in the real shell",
  });
  expect(report.shimReceipts).toHaveLength(2);
  expect(report.effectTrials).toHaveLength(2);
  expect(report.transportCoverage).toEqual({
    boundary: "shim receipt after input/store/window validation",
    doToShimMeasured: false,
    preReceiptRefusalsMeasured: false,
    operationToDispatch: "inference only; not H1",
    durableLedgerImplemented: true,
  });
  // Every send the run observed was reserved before it happened, and the trial
  // stopped for nothing. Reserved must cover observed, never the other way.
  expect(report.ledger).toMatchObject({
    limits: { dispatch: 128, operation: 512, connection: 32, concurrent: 4, openConnections: 4 },
    // Three attempts: two observing sockets still open when the report is
    // taken, and the subscription-boundary socket already closed. Teardown
    // releases the simultaneity slot, never the cumulative attempt.
    totals: {
      // 注入した送出失敗が 3 系列から 1 系列へ減った分だけ 11 から 9 になる
      // （2026-09-12・求解 Worker への直接 binding を外したため）。
      dispatch: 9,
      operation: 3,
      connection: 4,
      inFlight: 0,
      openConnections: 2,
      unattributedDispatches: 0,
      stopped: null,
    },
    restartCrossingExercisedHere: false,
  });
  // Connections are charged even though this warm run saw none cause a send.
  expect(report.ledger).toHaveProperty("connectionsWereWarmHere");
  const ledgerTotals = (report.ledger as { totals: Record<string, number> }).totals;
  expect(typeof ledgerTotals.dispatch).toBe("number");
  // Reserved must cover observed. Connections are charged an allowance they may
  // not use, so equality is not the invariant; coverage is.
  expect(ledgerTotals.observedDispatches).toBeLessThanOrEqual(ledgerTotals.dispatch!);
  // Every send was attributed to a reservation, so the per-operation hypothesis
  // was actually tested — not merely covered by the loose total bound.
  expect(ledgerTotals.unattributedDispatches).toBe(0);
  // Browser unreachability is argued, not measured. The claim must say so.
  expect(report.browserReachability).toMatchObject({ measured: false });
  if (!Array.isArray(report.loopbackCases)) throw new Error("Missing real HTTP cases");
  expect(report.loopbackCases).toHaveLength(17);
  expect(
    report.loopbackCases.filter((row: unknown) => isRecord(row) && row.forwarded === 0),
  ).toHaveLength(15);
  expect(
    report.loopbackCases.filter(
      (row: unknown) => isRecord(row) && row.status === 202 && row.forwarded === 1,
    ),
  ).toHaveLength(2);
  expect(report.checks).toEqual({
    negativeInputsNeverDispatch: true,
    publicAuthAndTsPathUnchanged: true,
    sharedProvenanceAdmission: true,
    realWasmCallsRealDoCallback: true,
    callbackDoesNotChangeBusinessFactsOrBroadcast: true,
    tsHydrationOnlyAdvancesImmediateProposal: true,
    realEffectReachesOnlyFixedTransport: true,
    sendFailureIsBoundedAndNeverRetriesOrFallsBack: true,
    distinctCountersAndCausalLinks: true,
    seriesAreDisjointAggregateScopes: true,
    realLoopbackRefusalsNeverForward: true,
    realLoopbackReachesPrivateBinding: true,
    privateEntranceDrivesRealOperations: true,
    watchIsSubscriptionOnly: true,
    storeInitiatedCloseReachesCaller: true,
  });
  expect(report.provenanceCases).toEqual(
    provenance.map((fixture) =>
      Object.assign({}, fixture, { solverStatus: fixture.transportAccepted ? 429 : 400 }),
    ),
  );
  expect(report.countSummary.usableForRates).toBe(true);
  const rows = report.observations.map((raw: unknown) =>
    parseCpsatObservation(JSON.stringify(raw)),
  );
  // 注入した送出失敗が 3 系列から 1 系列へ減り、各 2 行ぶん（要求と結末）で 4 行減る。
  expect(rows).toHaveLength(74);
  expect(rows.every((row) => row !== null)).toBe(true);
  expect(rows.filter((row) => row?.fact.type === "cpsat.request-generated")).toHaveLength(0);
  // 直接 probe 4 店舗 ＋ shim 系列 ＋ 注入した送出失敗 1 件。
  expect(rows.filter((row) => row?.fact.type === "cpsat.request-dispatched")).toHaveLength(5);
  expect(rows.filter((row) => row?.fact.type === "cpsat.solve-started")).toHaveLength(4);
});
