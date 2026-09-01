// tests/client/generators.smoke.test.ts — offline-degradation 生成器土台のスモーク。
//
// 生成器の土台が「単体で実行可能」かつ「要件13.3 の入力空間（server/local 混在・endTime==correctedNow 境界・
// 範囲外 boilSeconds・処理済み id 重複・cancel 済み server の snapshot 復活・不正/不在ブロブ）を構造的に
// サンプリングできる」ことを確認する（Correctness Property 本体ではない）。
//
// 生成器が実装の公開型（src/client/connection.ts の ClientView / ClientEvent）へ追随していることも、ここで
// 実行時に見張る——フィールド集合を EMPTY_VIEW と突き合わせ、イベントは 9 系統すべての出現を要求する。
// 型注釈だけでは「実は誰も踏んでいない次元」を見逃す（空虚な生成器を作らないための番人）。
//
// 純粋層方針（要件13.4 / design.md「暗黙時計に漏れたら境界を疑う」）に従い、Date.now のスタブも
// vi.useFakeTimers() も用いない。時刻はすべて生成器が引数値として吐く。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, type ClientEvent, type ClientView } from "../../src/client/connection";
import {
  genBoilSeconds,
  genClientTimer,
  genClientView,
  genCorrectedNow,
  genEvent,
  genEventStream,
  genPersistedBlob,
  genServerMessage,
  genValidPersistedBlob,
} from "./generators";

/** 非空ビューのサンプルを 1 つ得る（境界生成器の検証足場）。 */
function sampleNonEmptyView(): ClientView {
  const views = fc.sample(genClientView, 200);
  const found = views.find((v) => v.timers.length > 0);
  if (found === undefined) throw new Error("非空ビューを生成できなかった");
  return found;
}

/** ClientEvent の全系統（判別共用体のタグを網羅列挙する。生成器が 1 つでも欠けば落ちる）。 */
const ALL_EVENT_KINDS: readonly ClientEvent["kind"][] = [
  "Server",
  "LocalStart",
  "LocalCancel",
  "LocalComplete",
  "Connectivity",
  "Classify",
  "LocalDone",
  "Tick",
  "Reconcile",
];

describe("client/generators 生成器土台のスモーク", () => {
  it("genClientView は公開型 ClientView の全フィールドを埋める（EMPTY_VIEW とフィールド集合が一致）", () => {
    const expected = Object.keys(EMPTY_VIEW).sort();
    for (const view of fc.sample(genClientView, 50)) {
      expect(Object.keys(view).sort()).toEqual(expected);
    }
  });

  it("genClientTimer は server / local 双方の起源を構造的にサンプリングする", () => {
    const samples = fc.sample(genClientTimer, 200);
    expect(samples.length).toBe(200);
    expect(samples.some((t) => t.origin === "server")).toBe(true);
    expect(samples.some((t) => t.origin === "local")).toBe(true);
  });

  it("genClientView は空ビューと非空ビューの双方を踏み、ビュー内の id は一意", () => {
    const samples = fc.sample(genClientView, 300);
    expect(samples.some((v) => v.timers.length === 0)).toBe(true);
    expect(samples.some((v) => v.timers.length > 0)).toBe(true);
    for (const view of samples) {
      const ids = view.timers.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("genClientView の processedIds は timers の id と重複する場合を含む（処理済み id の重複）", () => {
    const samples = fc.sample(genClientView, 300);
    const hasOverlap = samples.some(
      (v) => v.timers.length > 0 && v.timers.some((t) => v.processedIds.has(t.id)),
    );
    expect(hasOverlap).toBe(true);
  });

  it("genClientView は connectivity 二値・unreachableReason 三値の双方を踏む", () => {
    const samples = fc.sample(genClientView, 300);
    const connectivities = new Set(samples.map((v) => v.connectivity));
    expect(connectivities).toEqual(new Set(["up", "down"]));
    const reasons = new Set(samples.map((v) => v.unreachableReason));
    expect(reasons).toEqual(new Set(["offline", "noAccess", "signInRequired"]));
  });

  it("genClientView の lastResults は空と既存残滓ありの双方を踏み、占有スロット上の残滓も生じる", () => {
    const samples = fc.sample(genClientView, 300);
    expect(samples.some((v) => v.lastResults.size === 0)).toBe(true);
    expect(samples.some((v) => v.lastResults.size > 0)).toBe(true);
    // 占有スロット（timers の駆動スロット）に既存残滓が載る盤面（畳み込みのクリア対象）。
    const onOccupied = samples.some((v) =>
      v.timers.some((t) => t.slotIds.some((slotId) => v.lastResults.has(slotId))),
    );
    expect(onOccupied).toBe(true);
  });

  it("genClientView の待ち行列・推奨は空と非空の双方を踏む（サーバ権威の写し）", () => {
    const samples = fc.sample(genClientView, 300);
    expect(samples.some((v) => v.pendingOrders.length === 0)).toBe(true);
    expect(samples.some((v) => v.pendingOrders.length > 0)).toBe(true);
    expect(samples.some((v) => v.recommendations.length === 0)).toBe(true);
    expect(samples.some((v) => v.recommendations.length > 0)).toBe(true);
  });

  it("genBoilSeconds は範囲内（1..1800 整数）と範囲外（0・負・1801 以上・非整数）の双方を踏む", () => {
    const samples = fc.sample(genBoilSeconds, 400);
    const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= 1800;
    expect(samples.some(inRange)).toBe(true);
    expect(samples.some((n) => n === 0)).toBe(true);
    expect(samples.some((n) => n < 0)).toBe(true);
    expect(samples.some((n) => n >= 1801)).toBe(true);
    expect(samples.some((n) => !Number.isInteger(n))).toBe(true);
  });

  it("genCorrectedNow は endTime と一致する境界をサンプリングする", () => {
    const view = sampleNonEmptyView();
    const endTimes = new Set(view.timers.map((t) => t.endTime));
    const samples = fc.sample(genCorrectedNow(view), 300);
    expect(samples.some((now) => endTimes.has(now))).toBe(true);
  });

  it("genServerMessage は snapshot / config / error の 3 種別すべてを分布する", () => {
    const samples = fc.sample(genServerMessage, 400);
    const types = new Set(samples.map((m) => m.type));
    for (const t of ["snapshot", "config", "error"]) {
      expect(types.has(t as (typeof samples)[number]["type"])).toBe(true);
    }
  });

  it("genEvent は ClientEvent の 9 系統すべてを分布する", () => {
    const view = sampleNonEmptyView();
    const kinds = new Set(fc.sample(genEvent(view), 600).map((e) => e.kind));
    expect(kinds).toEqual(new Set(ALL_EVENT_KINDS));
  });

  it("genEvent の除去系イベントは除去時刻 now を運び、Classify は到達不能理由 3 値を踏む", () => {
    const view = sampleNonEmptyView();
    const samples = fc.sample(genEvent(view), 600);
    // LocalCancel / LocalComplete は残滓の提示時間窓の起点 now を持つ（型ではなく実値で確かめる）。
    const removals = samples.filter(
      (e): e is Extract<ClientEvent, { kind: "LocalCancel" | "LocalComplete" }> =>
        e.kind === "LocalCancel" || e.kind === "LocalComplete",
    );
    expect(new Set(removals.map((e) => e.kind))).toEqual(new Set(["LocalCancel", "LocalComplete"]));
    expect(removals.every((e) => Number.isFinite(e.now))).toBe(true);
    const reasons = new Set(samples.filter((e) => e.kind === "Classify").map((e) => e.reason));
    expect(reasons).toEqual(new Set(["offline", "noAccess", "signInRequired"]));
  });

  it("genEvent の Reconcile は待ち行列・推奨も運ぶ（snapshot と同じ全置換の入力）", () => {
    const view = sampleNonEmptyView();
    const reconciles = fc.sample(genEvent(view), 600).filter((e) => e.kind === "Reconcile");
    expect(reconciles.length).toBeGreaterThan(0);
    expect(
      reconciles.every((e) => Array.isArray(e.pendingOrders) && Array.isArray(e.recommendations)),
    ).toBe(true);
    expect(reconciles.some((e) => e.pendingOrders.length > 0)).toBe(true);
  });

  it("genEvent の Reconcile は cancel 済み server の snapshot 復活を踏みうる（processedIds 登録 id の再出現）", () => {
    // processedIds に id を持つビューに対し、Reconcile/Server の timers が同じ id を再出現させる組を探す。
    const found = fc
      .sample(
        genClientView.chain((view) => genEvent(view).map((event) => ({ view, event }))),
        600,
      )
      .some(({ view, event }) => {
        if (view.processedIds.size === 0) return false;
        const timers =
          event.kind === "Reconcile"
            ? event.timers
            : event.kind === "Server" && event.message.type === "snapshot"
              ? event.message.timers
              : [];
        return timers.some((t) => view.processedIds.has(t.id));
      });
    expect(found).toBe(true);
  });

  it("genEventStream は実行可能で、9 系統が混在する列を生成する", () => {
    const view = sampleNonEmptyView();
    const samples = fc.sample(genEventStream(view), 50);
    expect(samples.length).toBe(50);
    expect(samples.every((stream) => Array.isArray(stream))).toBe(true);
    const kinds = new Set(samples.flat().map((e) => e.kind));
    expect(kinds).toEqual(new Set(ALL_EVENT_KINDS));
  });

  it("genValidPersistedBlob は version 1 の妥当な JSON に round-trip パースできる", () => {
    const samples = fc.sample(genValidPersistedBlob, 100);
    for (const raw of samples) {
      const parsed = JSON.parse(raw) as { version: number };
      expect(parsed.version).toBe(1);
    }
  });

  it("genPersistedBlob は 妥当 / 不正 / 不在(null) の三領域を踏む", () => {
    const samples = fc.sample(genPersistedBlob, 300);
    expect(samples.some((b) => b === null)).toBe(true); // 不在
    const isValid = (b: string | null): boolean => {
      if (b === null) return false;
      try {
        const v = JSON.parse(b) as { version?: unknown };
        return typeof v === "object" && v !== null && v.version === 1;
      } catch {
        return false;
      }
    };
    expect(samples.some((b) => isValid(b))).toBe(true); // 妥当
    expect(samples.some((b) => b !== null && !isValid(b))).toBe(true); // 不正
  });
});
