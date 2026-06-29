// tests/observe/correlate-clock-skew.example.test.ts — Correlator の cross-source 時刻整合の回帰例。
//
// ライブ観測（本番 Cloudflare）で表面化した問題を固定する。Operation_Log の at は Probe_Client
// （Node）の時計、Instrumentation_Log の at は Cloudflare の時計であり、両者にはクロックスキューが
// ある（実機で約 180ms の前後逆転を観測）。素の at で突き合わせると、idle 中に alarm 発火 → done
// 配送という同一事象の前後が逆転し、本来 confirmed の観測が誤って fail に倒れていた。
//
// 修正方針（option A）: ServerMessage が運ぶ payload.serverTime（サーバが確定した単一の時計）を
// cross-source 比較の時間の真実とする。本例はその整合が効くこと（confirmed に戻ること）を固定する。

import { describe, expect, it } from "vitest";

import {
  classifyInstances,
  determineVerdict,
  mergeByTime,
  verifyAlarmFiredInIdle,
  verifyRehydrateCount,
} from "../../src/observe/correlate";
import type { InstrumentationLogEntry, OperationLogEntry } from "../../src/observe/log";

// client 時計（at）はサーバ時計（serverTime）より一定量だけ「進んで／遅れて」記録されうる。
// ここでは done の client at(1000) がサーバの alarm at(1010) より前に出る逆転を再現する。
const CLIENT_DONE_AT = 1000;
const SERVER_TIME = 1010; // started/done の serverTime と alarm/construct/rehydrate(B) のサーバ時刻

const iso = (at: number): string => new Date(at).toISOString();

// idle 中に T が発火して done が届く。idle 後の最初のイベントで新 instanceId B が wake し、
// rehydrate が active 1 件を復元する——hibernation 観測の正準ケース。
const ops: readonly OperationLogEntry[] = [
  { seq: 0, at: 40, atIso: iso(40), direction: "recv", messageType: "snapshot",
    payload: { type: "snapshot", serverTime: 50, timers: [] } },
  { seq: 1, at: 60, atIso: iso(60), direction: "send", messageType: "start",
    payload: { type: "start", slotId: "kama-1", noodleType: "Medium", boilSeconds: 90 } },
  { seq: 2, at: 100, atIso: iso(100), direction: "recv", messageType: "started",
    payload: { type: "started", serverTime: 110,
      timer: { id: "T", slotId: "kama-1", noodleType: "Medium", endTime: SERVER_TIME } } },
  // 逆転の核心: client は 1000 で boiled を受信したが、サーバ確定時刻（serverTime）は 1010。
  { seq: 3, at: CLIENT_DONE_AT, atIso: iso(CLIENT_DONE_AT), direction: "recv", messageType: "boiled",
    payload: { type: "boiled", serverTime: SERVER_TIME, timerId: "T" } },
];

const seams: readonly InstrumentationLogEntry[] = [
  { seam: "construct", at: 50, atIso: iso(50), instanceId: "A" },
  { seam: "rehydrate", at: 50, atIso: iso(50), instanceId: "A", restoredCount: 0 },
  { seam: "broadcast", at: 110, atIso: iso(110), instanceId: "A", messageType: "started" },
  // idle 後の wake（新 instanceId B）。すべてサーバ時計 1010。
  { seam: "construct", at: SERVER_TIME, atIso: iso(SERVER_TIME), instanceId: "B" },
  { seam: "rehydrate", at: SERVER_TIME, atIso: iso(SERVER_TIME), instanceId: "B", restoredCount: 1 },
  { seam: "alarm", at: SERVER_TIME, atIso: iso(SERVER_TIME), instanceId: "B" },
  { seam: "broadcast", at: SERVER_TIME, atIso: iso(SERVER_TIME), instanceId: "B", messageType: "boiled" },
];

const OBSERVATION_END = 2000;

describe("Correlator: cross-source 時刻はサーバ時計（serverTime）に整合する", () => {
  it("client/server スキューで done が alarm より前に記録されても検証条件 a は pass する", () => {
    const merged = mergeByTime(ops, seams);
    const idle = { fromAt: 60, toAt: OBSERVATION_END };
    const conditionA = verifyAlarmFiredInIdle(merged, idle);
    expect(conditionA).toEqual([{ verdict: "pass", timerId: "T" }]);
  });

  it("wake 区間は done（serverTime 整合）を含み hibernation-wake に分類される", () => {
    const instances = classifyInstances(seams, ops, OBSERVATION_END);
    const wake = instances.find((i) => i.instanceId === "B");
    expect(wake?.classification).toBe("hibernation-wake");
  });

  it("直前 active 数（serverTime 整合）が rehydrate 復元件数 1 と一致し検証条件 b は pass する", () => {
    const merged = mergeByTime(ops, seams);
    const instances = classifyInstances(seams, ops, OBSERVATION_END);
    const conditionB = verifyRehydrateCount(merged, instances);
    expect(conditionB).toContainEqual({ verdict: "pass", restoredCount: 1 });
    expect(conditionB.every((c) => c.verdict === "pass")).toBe(true);
  });

  it("実行全体の判定は confirmed になる（スキューで fail に倒れない）", () => {
    const merged = mergeByTime(ops, seams);
    const instances = classifyInstances(seams, ops, OBSERVATION_END);
    const verdict = determineVerdict(merged, instances, OBSERVATION_END);
    expect(verdict.kind).toBe("confirmed");
  });
});
