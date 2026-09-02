// tests/client/degraded-slot-superimposition.exploration.property.test.ts
//
// 何を守っているか — 不変条件「1 スロット ≤ 1 タイマー」である。degraded（縮退）中のローカル発火から
// 再接続 Reconcile までの**記録された遷移列**を production の実イベントだけで再演し、その全段で
// バグ条件 C(X)（同一スロットが origin="server" と origin="local" に同時占有される ClientView）が
// **到達不能**であることを主張する（Property 5）。
//
// このファイルの出自は bug condition exploration（bugfix 方法論）であり、修正前は同じ主張が赤かった。
// 赤で入れて修正で緑へ転じた事実そのものが、この主張が破れを実際に捉えることの証拠である
// （変異検出の代わり）。ゆえに回帰の防具を別ファイルへ新設せず、同じファイルの役割を転じさせている。
//
// **記録された反例**（修正前に得られた到達の実体。消さないのは、この不変条件が守っている具体的な症状
// ——1 釜に 2 本が同居し、slotDisplay が片方を隠す——を後から読める形に留めるためである）:
//   経路 A の最小反例: slotId=0 | server: id="srv-a" endTime=1000000 | local: id="loc-a" endTime=1001000
//     （最初の破れは Reconcile ではなく **LocalStart** であった＝生成の側から来ていた）
//   固定再演の反例: slotId="0" | server: id="srv-boiled" | local: id="loc-provisional"
//     （経路 A では LocalStart が、経路 B では Reconcile の復活が同じ重ね合わせを作っていた）
//
// 何が守っているか（2 層・design.md）— **経路ごとに効く層が違うため、経路を分けて再演する**:
//   修正(1) decideLocalStart の占有ゲート        → 生成の側を閉じる（経路 A）
//   修正(2) reconcileServerConfirmed の統一規則  → 流入の側を閉じる（経路 B）
// 片方の層を外したときにどちらの経路が破れるかを、別々の失敗として読めるようにしてある。
//
// なぜ ClientView を手で組み立てないのか — 組み立てれば「そういう値は構築できない」しか言えず、
// 実際の遷移が到達させないことを語れない。ここでは production の openTimerConnection が実際に踏む順序を、
// src/client/connection.ts の decideView と実 ClientEvent だけで再演する:
//   Connectivity(up) → Server(snapshot) → Connectivity(down) → LocalDone → LocalStart
//   → Connectivity(up) → Reconcile
// ローカル発火の対象選定も端（fireDue）と同一の純粋導出 dueLocalTimers に委ね、二度書かない。
//
// 参照: .kiro/specs/degraded-slot-superimposition/bugfix.md
//   Expected Behavior 2.1（発火後も 1 スロット ≤ 1 タイマーを保つ）
//   Expected Behavior 2.2（boiled なスロットへの start が C(X) を生成しない）
//   Expected Behavior 2.3（ローカルで消化済みの server-confirmed が表示上「復活」して見えない扱い）
//   Expected Behavior 2.4（隠れていた別起源タイマーが不意に再出現しない）
// 記録専用の Current Behavior 1.1〜1.4（修正前の症状）は同 bugfix.md が正本であり、ここでは写さない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideView,
  dueLocalTimers,
  EMPTY_VIEW,
  type ClientTimer,
  type ClientView,
} from "../../src/client/connection";
import { assignedSlotDisplays } from "../../src/client/components/slotDisplay";
import type { TimerFact } from "../../src/domain/timer";
import { nonEmpty } from "../nonEmpty";

// ── バグ条件 C(X)（bugfix.md の擬似コードをそのまま写す） ──────────────────────────────────────

/**
 * bugfix.md の isBugCondition(X) を局所述語として写したもの（非公開・この不変条件の主張専用）。
 *
 * 判定は slotIds の any-overlap で行う（集合の等値ではない）。1 Timer は複数スロットを駆動しうるため、
 * 重ね合わせの定義は「同じ slotId を共に含むか」であって「同じスロット集合か」ではない
 * （src/client/assignment.ts の射影規律と同じ any-overlap）。
 */
function isBugCondition(view: ClientView): boolean {
  return view.timers.some(
    (confirmed) =>
      confirmed.origin === "server" &&
      view.timers.some(
        (provisional) =>
          provisional.origin === "local" &&
          provisional.slotIds.some((slotId) => confirmed.slotIds.includes(slotId)),
      ),
  );
}

/** 重ね合わせの実体（反例として報告する事実）。 */
interface Superimposition {
  readonly slotId: string;
  readonly serverTimerId: string;
  readonly serverEndTime: number;
  readonly localTimerId: string;
  readonly localEndTime: number;
}

/** C(X) を満たす (slotId, server 側, local 側) の組を全て列挙する。反例を人が読める形で残すため。 */
function superimpositions(view: ClientView): readonly Superimposition[] {
  const found: Superimposition[] = [];
  for (const confirmed of view.timers) {
    if (confirmed.origin !== "server") continue;
    for (const provisional of view.timers) {
      if (provisional.origin !== "local") continue;
      for (const slotId of confirmed.slotIds) {
        if (!provisional.slotIds.includes(slotId)) continue;
        found.push({
          slotId,
          serverTimerId: confirmed.id,
          serverEndTime: confirmed.endTime,
          localTimerId: provisional.id,
          localEndTime: provisional.endTime,
        });
      }
    }
  }
  return found;
}

/** 反例を 1 行で綴じる。assert 失敗時のメッセージに載せ、slotId / id / origin / endTime を失わない。 */
function counterexample(view: ClientView): string {
  const found = superimpositions(view);
  if (found.length === 0) return "no superimposition";
  return found
    .map(
      (s) =>
        `slotId=${s.slotId} | server: id=${s.serverTimerId} origin="server" endTime=${s.serverEndTime}` +
        ` | local: id=${s.localTimerId} origin="local" endTime=${s.localEndTime}`,
    )
    .join(" ;; ");
}

// ── 記録された遷移列の再演（production の遷移だけを用いる） ──────────────────────────────────

/** 再演のパラメータ。時刻・生成 id はすべて引数として運ぶ（純粋層に暗黙時計を漏らさない）。 */
interface DegradedRun {
  /** 争いの舞台になるスロット（unit 0 の範囲 = "0".."5" に収め、担当射影を素直に保つ）。 */
  readonly slotId: string;
  readonly serverTimerId: string;
  readonly localTimerId: string;
  readonly serverEndTime: number;
  readonly serverTime: number;
  readonly receivedAt: number;
  readonly noodleType: string;
  readonly boilSeconds: number;
  /** endTime 到達からローカル発火までの遅れ（≥ 0）。端のティック粒度に相当する。 */
  readonly fireDelayMs: number;
  /**
   * 発火から現場が次の手を動かすまでの遅れ（≥ 0）。
   *
   * 経路 A ではその手が「同一スロットへの start」、経路 B では「消し込み（LocalComplete）」である。
   * どちらも「茹で上がりを見てから動くまでの間」という同じ事実ゆえ、二つのパラメータへ分けない。
   */
  readonly startDelayMs: number;
  /**
   * 消し込みから空きスロットへの start までの遅れ（≥ 0）。経路 B だけが読む。
   *
   * 経路 B は消し込みで釜を空けたあとに start するため、発火からの遅れ 1 つでは段を綴じられない
   * （消し込みと start が同時刻に潰れると「空きスロットへ入れた」という現場の手順が読めなくなる）。
   */
  readonly completeToStartDelayMs: number;
}

/**
 * 補正後時刻 → 生のローカル時計の読み（`clock.ts` の `correctedNow(offset, now) = now + offset` の逆写像）。
 *
 * なぜこの変換が要るのか — 再演が渡す時刻には**二種類**あり、引数ごとにどちらを期待するかが決まっている。
 * 取り違えると `offset ≠ 0` のとき盤面がずれる（本ファイルは実際に一度これを踏んだ）。
 *
 *   - **補正後時刻（サーバ基準）を取る引数**: `dueLocalTimers(view, correctedNowMs)` /
 *     `LocalStart.correctedNow`。端は `now() + view.offset` を渡す。
 *   - **生のローカル時計の読みを取る引数**: `Server.receivedAt` / `Reconcile.receivedAt` /
 *     `LocalComplete.now`。端は `now()` をそのまま渡し、補正は受け手の内部（`reconcileServerConfirmed` の
 *     `correctedNow(view.offset, at)` 等）が行う。ここへ補正後時刻を渡すと **offset が二重に足される**。
 *
 * 再演の各段（`fireAt` / `completeAt` / `startAt`）は `serverEndTime`（サーバ基準の endTime）からの導出ゆえ
 * すべて補正後時刻である。よって生のローカル読みを求める引数へ渡すときだけ、この逆写像を通す。
 */
function localReadingOf(correctedMs: number, offset: number): number {
  return correctedMs - offset;
}

/** 再演の各段（不変条件を遷移ごとに主張できるよう、全段を返す）。 */
interface DegradedRunStages {
  readonly serverFact: TimerFact;
  readonly afterSnapshot: ClientView;
  readonly afterDegraded: ClientView;
  readonly due: readonly ClientTimer[];
  readonly afterLocalDone: ClientView;
  readonly afterLocalStart: ClientView;
  readonly afterReconcile: ClientView;
  readonly fireAt: number;
  readonly startAt: number;
}

/**
 * 経路 A（bugfix.md に記録された遷移列）を decideView の実イベントだけで再演する。
 *
 * 段の時刻（fireAt / startAt）はすべて補正後時刻（サーバ基準）である。生のローカル読みを求める引数へは
 * `localReadingOf` で戻して渡す（どの引数がどちらを期待するかは同関数の docstring が正本）。offset の算出は
 * decideServerMessage が担うため、ここでは snapshot の serverTime / receivedAt を与えるだけで再確立される。
 */
function replayBoiledThenLocalStart(run: DegradedRun): DegradedRunStages {
  const serverFact: TimerFact = {
    id: run.serverTimerId,
    slotIds: nonEmpty([run.slotId]),
    noodleType: run.noodleType,
    firmness: "normal",
    startTime: run.serverEndTime - 60_000,
    endTime: run.serverEndTime,
  };

  // (1) live で接続が確立し、全量 snapshot が server-confirmed を運ぶ（= down 前から在るタイマー）。
  const connected = decideView(EMPTY_VIEW, { kind: "Connectivity", status: "up" });
  const afterSnapshot = decideView(connected, {
    kind: "Server",
    message: {
      type: "snapshot",
      serverTime: run.serverTime,
      timers: [serverFact],
      pendingOrders: [],
      recommendations: [],
    },
    receivedAt: run.receivedAt,
  });

  // snapshot で再確立された offset。式を写さずビューから読む（offset の正本は decideServerMessage 側）。
  const offset = afterSnapshot.offset;

  // (2) 接続喪失 → degraded。Mode は connectivity からの導出値ゆえ状態として触らない。
  const afterDegraded = decideView(afterSnapshot, { kind: "Connectivity", status: "down" });

  // (3) endTime 到達 → ローカル発火。対象選定は端（fireDue）と同じ dueLocalTimers に委ね、LocalDone を
  //     畳む。発火は processedIds への記録だけで、timers からは除去しない（この性質は修正後も不変）。
  const fireAt = run.serverEndTime + run.fireDelayMs;
  const due = dueLocalTimers(afterDegraded, fireAt);
  let afterLocalDone = afterDegraded;
  for (const timer of due) {
    afterLocalDone = decideView(afterLocalDone, { kind: "LocalDone", timerId: timer.id });
  }

  // (4) 茹で上がった同一スロットへユーザーが start。ここが記録された遷移列で最初に破れていた点であり、
  //     いまは占有ゲート（修正(1)）が注入を拒む——boiled であっても麺は釜に在るため、釜は空いていない。
  const startAt = fireAt + run.startDelayMs;
  const afterLocalStart = decideView(afterLocalDone, {
    kind: "LocalStart",
    slotIds: nonEmpty([run.slotId]),
    noodleType: run.noodleType,
    boilSeconds: run.boilSeconds,
    newTimerId: run.localTimerId,
    correctedNow: startAt,
  });

  // (5) サーバ再起動後の再接続（down→up）→ 最初の全量 snapshot が Reconcile として畳まれる。
  //     write-back はスコープ外ゆえサーバは古い server タイマーを保持し続けており、同じ serverFact が
  //     戻ってくる。経路 A ではゲートが provisional を作らせていないため、戻った先で争う相手が居ない。
  const reconnected = decideView(afterLocalStart, { kind: "Connectivity", status: "up" });
  const afterReconcile = decideView(reconnected, {
    kind: "Reconcile",
    timers: [serverFact],
    pendingOrders: [],
    recommendations: [],
    // receivedAt は生のローカル読み。受け手が correctedNow(view.offset, at) で補正するため、
    // 補正後時刻 startAt をそのまま渡すと offset が二重に足される。
    receivedAt: localReadingOf(startAt, offset),
  });

  return {
    serverFact,
    afterSnapshot,
    afterDegraded,
    due,
    afterLocalDone,
    afterLocalStart,
    afterReconcile,
    fireAt,
    startAt,
  };
}

// ── 経路 B の再演（現場が正しく消し込んだあと、復活が重ね合わせを作る） ──────────────────────

/**
 * 経路 B の各段。経路 A（`replayBoiledThenLocalStart`）と段が違うため別の型に分ける——同じ名前の段に
 * 別の意味を持たせると、どの遷移が不変条件を守っているのかを読めなくなる。
 */
interface ResurrectionRunStages {
  readonly serverFact: TimerFact;
  readonly afterSnapshot: ClientView;
  readonly afterDegraded: ClientView;
  readonly due: readonly ClientTimer[];
  readonly afterLocalDone: ClientView;
  readonly afterLocalComplete: ClientView;
  readonly afterLocalStart: ClientView;
  readonly afterReconcile: ClientView;
  readonly fireAt: number;
  readonly completeAt: number;
  readonly startAt: number;
}

/**
 * 経路 B を decideView の実イベントだけで再演する（経路 A と同じく ClientView を手で組まない）。
 *
 *   Connectivity(up) → Server(snapshot) → Connectivity(down) → LocalDone
 *   → LocalComplete（現場が正しく消し込む）→ LocalStart（その時点で空きスロット）
 *   → Connectivity(up) → Reconcile（write-back 不在ゆえサーバは同じ serverFact を保持している）
 *
 * なぜこの経路を別に再演するのか — 経路 A の破れは `LocalStart` にあり、占有ゲート（修正(1)）で閉じる。
 * 経路 B では現場が手順を守っている（消し込んでから空き釜へ入れている）ため start の側に落ち度が無く、
 * 重ね合わせは **Reconcile による復活**という流入の側から来ていた。ゆえにゲートだけでは閉じず、
 * ここを守るのは統一規則（修正(2)）である。**この経路が、2 層である理由を検査に固定している。**
 */
function replayCompleteThenReconcile(run: DegradedRun): ResurrectionRunStages {
  const serverFact: TimerFact = {
    id: run.serverTimerId,
    slotIds: nonEmpty([run.slotId]),
    noodleType: run.noodleType,
    firmness: "normal",
    startTime: run.serverEndTime - 60_000,
    endTime: run.serverEndTime,
  };

  // (1) live で接続が確立し、全量 snapshot が server-confirmed を運ぶ（= down 前から在るタイマー）。
  const connected = decideView(EMPTY_VIEW, { kind: "Connectivity", status: "up" });
  const afterSnapshot = decideView(connected, {
    kind: "Server",
    message: {
      type: "snapshot",
      serverTime: run.serverTime,
      timers: [serverFact],
      pendingOrders: [],
      recommendations: [],
    },
    receivedAt: run.receivedAt,
  });

  // snapshot で再確立された offset（経路 A と同じく式は写さずビューから読む）。
  const offset = afterSnapshot.offset;

  // (2) 接続喪失 → degraded。
  const afterDegraded = decideView(afterSnapshot, { kind: "Connectivity", status: "down" });

  // (3) endTime 到達 → ローカル発火。発火だけでは timers から除去されない（経路 A と同じ出発点）。
  const fireAt = run.serverEndTime + run.fireDelayMs;
  const due = dueLocalTimers(afterDegraded, fireAt);
  let afterLocalDone = afterDegraded;
  for (const timer of due) {
    afterLocalDone = decideView(afterLocalDone, { kind: "LocalDone", timerId: timer.id });
  }

  // (4) 現場が茹で上がりを消し込む（LocalComplete）。経路 A との分岐点はここだけである。
  //     除去と processedIds への記録が同時に起き、釜は空きになる。
  const completeAt = fireAt + run.startDelayMs;
  let afterLocalComplete = afterLocalDone;
  for (const timer of due) {
    afterLocalComplete = decideView(afterLocalComplete, {
      kind: "LocalComplete",
      // now は生のローカル読み（端は now() をそのまま渡す）。残滓 lastResults の記録時刻に用いられる。
      timerId: timer.id,
      now: localReadingOf(completeAt, offset),
    });
  }

  // (5) 空いた釜へ start（Unchanged Behavior 3.1 の正常経路）。占有が無いため占有ゲートを通り、
  //     provisional はちょうど 1 本注入される。ここが「現場は何も間違えていない」ことの表明である。
  const startAt = completeAt + run.completeToStartDelayMs;
  const afterLocalStart = decideView(afterLocalComplete, {
    kind: "LocalStart",
    slotIds: nonEmpty([run.slotId]),
    noodleType: run.noodleType,
    boilSeconds: run.boilSeconds,
    newTimerId: run.localTimerId,
    correctedNow: startAt,
  });

  // (6) 再接続（down→up）→ 最初の全量 snapshot が Reconcile として畳まれる。write-back はスコープ外ゆえ
  //     サーバは消し込みを知らず、同じ serverFact を運んでくる。ここで統一規則が占有を決着させる。
  const reconnected = decideView(afterLocalStart, { kind: "Connectivity", status: "up" });
  const afterReconcile = decideView(reconnected, {
    kind: "Reconcile",
    timers: [serverFact],
    pendingOrders: [],
    recommendations: [],
    // receivedAt は生のローカル読み（経路 A と同じ。補正は受け手の correctedNow が行う）。
    receivedAt: localReadingOf(startAt, offset),
  });

  return {
    serverFact,
    afterSnapshot,
    afterDegraded,
    due,
    afterLocalDone,
    afterLocalComplete,
    afterLocalStart,
    afterReconcile,
    fireAt,
    completeAt,
    startAt,
  };
}

// ── 固定の再演（記録された遷移列そのまま。id は記録された反例の名をそのまま用いる） ────────────

/** unit 0 の先頭スロット。担当ユニット [0] の射影に確実に入る（slot 0..5 が unit 0）。 */
const FIXED_RUN: DegradedRun = {
  slotId: "0",
  serverTimerId: "srv-boiled",
  localTimerId: "loc-provisional",
  serverEndTime: 1_700_000_000_000,
  // serverTime === receivedAt ゆえ offset は 0。補正後時刻とローカル時刻が一致し、主張が読みやすい。
  serverTime: 1_699_999_940_000,
  receivedAt: 1_699_999_940_000,
  noodleType: "Thin",
  boilSeconds: 90,
  fireDelayMs: 1_000,
  startDelayMs: 5_000,
  completeToStartDelayMs: 3_000,
};

// ── 生成器（小さく決定的に保つ） ────────────────────────────────────────────────────────────

const NOODLE_POOL = ["Thin", "Medium", "Thick"] as const;

/**
 * degraded 再演のパラメータ生成器。スロットは unit 0 の範囲に収め、id 空間は起源ごとに分ける。
 *
 * プールと範囲は記録された最小反例（`slotId=0` / `srv-a` endTime=1000000 / `loc-a` endTime=1001000）を
 * 必ず含む形に保つ。反例そのものが探索空間の内側に居続けることが、この防具が症状を捉え続ける根拠である。
 */
const genDegradedRun: fc.Arbitrary<DegradedRun> = fc.record({
  slotId: fc.integer({ min: 0, max: 5 }).map(String),
  serverTimerId: fc.constantFrom("srv-a", "srv-b", "srv-c"),
  localTimerId: fc.constantFrom("loc-a", "loc-b", "loc-c"),
  serverEndTime: fc.integer({ min: 1_000_000, max: 1_100_000 }),
  serverTime: fc.integer({ min: 900_000, max: 1_000_000 }),
  receivedAt: fc.integer({ min: 900_000, max: 1_000_000 }),
  noodleType: fc.constantFrom(...NOODLE_POOL),
  boilSeconds: fc.integer({ min: 1, max: 1800 }),
  fireDelayMs: fc.integer({ min: 0, max: 5_000 }),
  startDelayMs: fc.integer({ min: 0, max: 60_000 }),
  completeToStartDelayMs: fc.integer({ min: 0, max: 60_000 }),
});

const NUM_RUNS = 100;

describe("client degraded 経路 A — 発火済みスロットへの start が重ね合わせを作らない", () => {
  // Feature: degraded-slot-superimposition, Property 5: 記録された degraded 遷移列で C(X) は到達不能
  // **Validates: Requirements 2.2, 2.4**
  //
  // 記録された遷移列をそのまま再演し、ローカル発火の直後に同一スロットへ start しても C(X) が
  // 成立しないことを主張する。守っているのは占有ゲート（修正(1)）である——注入が拒まれるため、
  // 重ね合わせの片方が生まれない。修正前はこの it の末尾が反例つきで赤かった。
  it("発火済みスロットへの start は拒まれ、在席は server-confirmed 1 本のまま", () => {
    const stages = replayBoiledThenLocalStart(FIXED_RUN);

    // 前提の確認 — 再演が「合法な遷移」であることを段ごとに固める（ここが崩れると不変条件を語れない）。
    // snapshot で server-confirmed が 1 本だけ在席し、その時点では重ね合わせでない。
    expect(stages.afterSnapshot.timers.map((timer) => timer.origin)).toEqual(["server"]);
    expect(isBugCondition(stages.afterSnapshot)).toBe(false);
    // degraded へ落ちても在席は変わらない。
    expect(stages.afterDegraded.connectivity).toBe("down");
    // endTime 到達でローカル発火の対象になる（端 fireDue と同じ導出）。
    expect(stages.due.map((timer) => timer.id)).toEqual([FIXED_RUN.serverTimerId]);
    // 発火は processedIds に記録するだけで timers から除去しない（修正後も不変の性質）。
    expect(stages.afterLocalDone.processedIds.has(FIXED_RUN.serverTimerId)).toBe(true);
    expect(stages.afterLocalDone.timers.map((timer) => timer.id)).toEqual([
      FIXED_RUN.serverTimerId,
    ]);
    // この時点ではまだ local 起源が居ないため C(X) は偽。
    expect(isBugCondition(stages.afterLocalDone)).toBe(false);

    // 占有ゲート（要件2.2）— 在席しているスロットへの LocalStart は provisional を注入しない。
    // boiled であっても麺は釜に在るため、釜は空いていない。
    expect(stages.afterLocalStart.timers.map((timer) => timer.origin)).toEqual(["server"]);
    // ビュー不変は参照同一で返る。これが端（openTimerConnection.update）の早期 return を通し、
    // 永続化と通知を走らせない性質そのものである（スプレッドで作り直していれば崩れる）。
    expect(stages.afterLocalStart).toBe(stages.afterLocalDone);

    // 不変条件の主張（1 スロット ≤ 1 タイマー）。記録された遷移列で最初に破れていた地点である。
    expect(
      isBugCondition(stages.afterLocalStart),
      `LocalDone + LocalStart で重ね合わせが成立した: ${counterexample(stages.afterLocalStart)}`,
    ).toBe(false);
  });

  // Feature: degraded-slot-superimposition, Property 5: 記録された degraded 遷移列で C(X) は到達不能
  // **Validates: Requirements 2.2, 2.4**
  //
  // 再接続後の主張を独立の it に分けるのは、直前の主張が失敗しても「Reconcile を跨いでも破れない」という
  // 別の事実を独立に読めるようにするためである（同一 it に畳むと先の失敗で後続が走らない）。
  it("再接続 Reconcile で server-confirmed が戻っても、争う相手が居ないため重ね合わせにならない", () => {
    const stages = replayBoiledThenLocalStart(FIXED_RUN);

    // 前提の確認 — server 集合の全置換で、ローカルで消化したはずの id が戻っている（write-back 不在）。
    expect(
      stages.afterReconcile.timers
        .filter((timer) => timer.origin === "server")
        .map((timer) => timer.id),
    ).toEqual([FIXED_RUN.serverTimerId]);
    // 経路 A では provisional が存在しない——ゲートが注入を拒んだため、戻った server と争う相手が居ない。
    // 「復活した server を統一規則が落とす」観測は経路 B が担う（provisional 在席の Reconcile を合法に
    // 組めるのは経路 B だけである）。
    expect(
      stages.afterReconcile.timers
        .filter((timer) => timer.origin === "local")
        .map((timer) => timer.id),
    ).toEqual([]);

    // 不変条件の主張（要件2.4）— Reconcile を跨いでも 1 スロット ≤ 1 タイマーが保たれる。
    expect(
      isBugCondition(stages.afterReconcile),
      `Reconcile 後に重ね合わせが成立した: ${counterexample(stages.afterReconcile)}`,
    ).toBe(false);
  });

  // Feature: degraded-slot-superimposition, Property 5: 記録された degraded 遷移列で C(X) は到達不能
  // **Validates: Requirements 2.2, 2.4**
  //
  // 不変条件が手で選んだ一例に依らないことを示す。スロット・時刻・茹で秒・麺種・id を振っても、
  // 同じ経路で 1 スロット ≤ 1 タイマーは保たれる（記録された最小反例も探索空間の内側に居る）。
  it("Property: degraded 経路の任意パラメータで 1 スロット ≤ 1 タイマーが保たれる", () => {
    fc.assert(
      fc.property(genDegradedRun, (run) => {
        const stages = replayBoiledThenLocalStart(run);
        // 経路の前提: endTime 到達分がローカル発火の対象になっている（発火が起きた経路であること）。
        expect(stages.due.map((timer) => timer.id)).toEqual([run.serverTimerId]);
        // 不変条件の主張。破れれば fast-check が最小反例へ縮約し、反例を報告する。
        expect(
          isBugCondition(stages.afterLocalStart),
          `LocalStart 後に重ね合わせ: ${counterexample(stages.afterLocalStart)}`,
        ).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: degraded-slot-superimposition, Property 5: 記録された degraded 遷移列で C(X) は到達不能
  // **Validates: Requirements 2.2, 2.4**
  //
  // 不変条件が表示に何をもたらすかの観測。1 スロット = 1 表示という導出規律（走行中優先・同区分内で最早
  // endTime）は変えていない。変わったのは在席が 1 本になったことで、**隠れる相手が存在しなくなった**点である
  // ——修正前はここで 2 本の同居と「隠れた側」を記録していた。全域の言明は Property 4 が担い、これはその具体例。
  it("観測記録: 在席は 1 本ゆえ表示と一致し、隠れる側が存在しない", () => {
    const stages = replayBoiledThenLocalStart(FIXED_RUN);
    const view = stages.afterLocalStart;
    // slot "0" は unit 0 の担当範囲。offset は 0（serverTime === receivedAt）ゆえ now をそのまま渡せる。
    expect(view.offset).toBe(0);

    const displays = assignedSlotDisplays(view, [0], stages.startAt);
    const forSlotZero = displays.filter((display) => display.slot === 0);

    // 在席 1 本・表示 1 件。数が一致していること自体が「隠れが無い」ことの表明である。
    expect(view.timers).toHaveLength(1);
    expect(forSlotZero).toHaveLength(1);

    // 表示は boiled（茹で上がり・消し込み待ち）で、指す先は在席している server-confirmed である。
    // 修正前はここが running（provisional）を指し、boiled な server-confirmed が隠れていた。
    const shown = forSlotZero[0]!;
    expect(shown.kind).toBe("boiled");
    if (shown.kind === "boiled") {
      expect(shown.timer.id).toBe(FIXED_RUN.serverTimerId);
      // 超過時間は endTime（事実）からの導出。発火の遅れ + 現場が動くまでの遅れに一致する。
      expect(shown.overdueMs).toBe(FIXED_RUN.fireDelayMs + FIXED_RUN.startDelayMs);
    }

    // 当該スロットに在席する Timer は、すべて表示に現れている（隠れが 1 本も無い）。
    const occupants = view.timers.filter((timer) => timer.slotIds.includes(FIXED_RUN.slotId));
    const displayedIds = forSlotZero.flatMap((display) =>
      display.kind === "running" || display.kind === "boiled" ? [display.timer.id] : [],
    );
    expect(displayedIds).toEqual(occupants.map((timer) => timer.id));
  });

  // Feature: degraded-slot-superimposition, Property 5: 記録された degraded 遷移列で C(X) は到達不能
  // **Validates: Requirements 2.2, 2.4**
  //
  // 付随観測。Reconcile の processedIds 刈り取りは保持 id 集合への限定でしかないため、戻ってきた
  // server タイマーの id は残り、ローカル再発火は抑止され続ける（鳴り終わった通知は二度鳴らない）。
  // 「**落としても** id が残る」（Property 7 の具体例）を語るには経路 B が要る——経路 A では在席が
  // 1 本しか無く、統一規則が何も落とさない。
  it("観測記録: Reconcile 後も processedIds が id を保持し、ローカル再発火は抑止されたまま", () => {
    const stages = replayBoiledThenLocalStart(FIXED_RUN);
    const view = stages.afterReconcile;

    // 戻り: 同一 id の server-confirmed が全置換で在席を取り戻している。
    expect(
      view.timers.filter((timer) => timer.origin === "server").map((timer) => timer.id),
    ).toEqual([FIXED_RUN.serverTimerId]);
    // 経路 A に provisional は居ない（ゲートが注入を拒んだため）。
    expect(
      view.timers.filter((timer) => timer.origin === "local").map((timer) => timer.id),
    ).toEqual([]);
    // 刈り取り後も処理済み記録は残る（保持 id 集合に属するため）。
    expect(view.processedIds.has(FIXED_RUN.serverTimerId)).toBe(true);
    // ゆえに戻ってきた server タイマーはローカル再発火しない。
    expect(dueLocalTimers(view, stages.startAt).map((timer) => timer.id)).toEqual([]);
  });
});

describe("client degraded 経路 B — 消し込み後に Reconcile が戻す server-confirmed の決着", () => {
  // Feature: degraded-slot-superimposition, Property 5: 記録された degraded 遷移列で C(X) は到達不能
  // **Validates: Requirements 2.2, 2.4**
  //
  // 段を別々の it に分けるのは、先の主張が失敗すると後続の主張が走らず、各遷移が何を守っているかを
  // 独立に読めなくなるためである（このファイルの分割方針そのまま）。
  // まず「消し込みは正しく効く」ことを固める——ここが崩れると、後段の決着を統一規則の働きだと言えない。
  it("消し込みは正しく効く: LocalComplete で server-confirmed は除去され処理済みに記録される", () => {
    const stages = replayCompleteThenReconcile(FIXED_RUN);

    // 前提 — snapshot で server-confirmed が 1 本在席し、endTime 到達でローカル発火の対象になる。
    expect(stages.afterSnapshot.timers.map((timer) => timer.origin)).toEqual(["server"]);
    expect(stages.afterDegraded.connectivity).toBe("down");
    expect(stages.due.map((timer) => timer.id)).toEqual([FIXED_RUN.serverTimerId]);
    // 発火だけでは timers から消えない（経路 A と同じ出発点）。
    expect(stages.afterLocalDone.timers.map((timer) => timer.id)).toEqual([
      FIXED_RUN.serverTimerId,
    ]);

    // 消し込みは在席を解く。釜は空きになり、処理済み記録は残る（ローカル再発火の抑止）。
    expect(stages.afterLocalComplete.timers).toEqual([]);
    expect(stages.afterLocalComplete.processedIds.has(FIXED_RUN.serverTimerId)).toBe(true);
    expect(isBugCondition(stages.afterLocalComplete)).toBe(false);
  });

  // Feature: degraded-slot-superimposition, Property 5: 記録された degraded 遷移列で C(X) は到達不能
  // **Validates: Requirements 2.2, 2.4**
  //
  // 空き釜への start は正常経路（Unchanged Behavior 3.1）であり、占有ゲートはこれを塞がない。
  // ゲートを広く取りすぎていれば、ここが赤くなって知らせる（この段は「現場は手順を守っている」の表明でもある）。
  it("空きスロットへの start は通る: provisional がちょうど 1 本注入され重ね合わせは無い", () => {
    const stages = replayCompleteThenReconcile(FIXED_RUN);
    const locals = stages.afterLocalStart.timers.filter((timer) => timer.origin === "local");

    expect(locals.map((timer) => timer.id)).toEqual([FIXED_RUN.localTimerId]);
    expect(locals[0]?.slotIds).toContain(FIXED_RUN.slotId);
    // 当該スロットに在席するのはこの 1 本だけ（server 側は消し込み済み）。
    expect(
      stages.afterLocalStart.timers.filter((timer) => timer.slotIds.includes(FIXED_RUN.slotId)),
    ).toHaveLength(1);
    expect(isBugCondition(stages.afterLocalStart)).toBe(false);
  });

  // Feature: degraded-slot-superimposition, Property 5: 記録された degraded 遷移列で C(X) は到達不能
  // **Validates: Requirements 2.2, 2.4**
  //
  // 経路 B の核心であり、**2 層である理由がここに固定されている**——start の側に落ち度が無いため
  // 占有ゲートは何もせず、決着をつけるのは統一規則（修正(2)）だけである。規則を外せばこの it が
  // 反例つきで赤くなる。同時にこれは Property 7 の具体例でもある（落とした Timer の id は残る）。
  it("Reconcile が戻す server-confirmed は解決で落ち、在席は provisional 1 本だけ", () => {
    const stages = replayCompleteThenReconcile(FIXED_RUN);

    // 統一規則の決着（要件2.3）— server 側は boiled（消し込み済みの endTime は過去）、local 側は running。
    // 走行中の主張が勝ち、戻ってきた server-confirmed は落ちる。落として失われるのは鳴り終わった通知の
    // 残骸だけで、走っている麺の秒読みは残る。
    expect(
      stages.afterReconcile.timers
        .filter((timer) => timer.origin === "server")
        .map((timer) => timer.id),
    ).toEqual([]);
    // provisional は保持される（決定 B）。現場が空き釜へ入れた麺の秒読みは消えない。
    expect(
      stages.afterReconcile.timers
        .filter((timer) => timer.origin === "local")
        .map((timer) => timer.id),
    ).toEqual([FIXED_RUN.localTimerId]);
    // 当該スロットの在席はちょうど 1 本。
    expect(
      stages.afterReconcile.timers.filter((timer) => timer.slotIds.includes(FIXED_RUN.slotId)),
    ).toHaveLength(1);

    // 落としても処理済み記録は残る（刈り取りの入力は解決**前**の集合ゆえ・Property 7 の具体例）。
    // これが無いと、server 側が次の snapshot で在席を取り戻したとき通知がもう一度鳴る。
    expect(stages.afterReconcile.processedIds.has(FIXED_RUN.serverTimerId)).toBe(true);

    // 不変条件の主張（1 スロット ≤ 1 タイマー）。記録された遷移列では、ここが復活によって破れていた。
    expect(
      isBugCondition(stages.afterReconcile),
      `消し込み後の Reconcile で重ね合わせが成立した: ${counterexample(stages.afterReconcile)}`,
    ).toBe(false);
  });

  // Feature: degraded-slot-superimposition, Property 5: 記録された degraded 遷移列で C(X) は到達不能
  // **Validates: Requirements 2.2, 2.4**
  //
  // 付随観測。前段が「id が残る」ことを主張するのに対し、ここはその帰結——残っているからローカル再発火が
  // 起きない——を主張する。落とした server タイマーが将来在席を取り戻しても、鳴り終わった通知は二度鳴らない。
  it("観測記録: 解決後も processedIds が id を保持し、ローカル再発火は抑止されたまま", () => {
    const stages = replayCompleteThenReconcile(FIXED_RUN);
    const view = stages.afterReconcile;

    expect(view.processedIds.has(FIXED_RUN.serverTimerId)).toBe(true);
    expect(dueLocalTimers(view, stages.startAt).map((timer) => timer.id)).not.toContain(
      FIXED_RUN.serverTimerId,
    );
  });

  // Feature: degraded-slot-superimposition, Property 5: 記録された degraded 遷移列で C(X) は到達不能
  // **Validates: Requirements 2.2, 2.4**
  //
  // 経路 B の不変条件が手で選んだ一例に依らないことを示す（消し込みから start までの遅れも振る）。
  it("Property: 経路 B の任意パラメータで 1 スロット ≤ 1 タイマーが保たれる", () => {
    fc.assert(
      fc.property(genDegradedRun, (run) => {
        const stages = replayCompleteThenReconcile(run);
        // 経路の前提: 発火 → 消し込み → 空き釜への start が成立している（合法な手順であること）。
        expect(stages.due.map((timer) => timer.id)).toEqual([run.serverTimerId]);
        expect(stages.afterLocalComplete.timers).toEqual([]);
        expect(
          stages.afterLocalStart.timers
            .filter((timer) => timer.origin === "local")
            .map((timer) => timer.id),
        ).toEqual([run.localTimerId]);
        // 不変条件の主張。破れれば fast-check が最小反例へ縮約し、反例を報告する。
        expect(
          isBugCondition(stages.afterReconcile),
          `Reconcile 後に重ね合わせ: ${counterexample(stages.afterReconcile)}`,
        ).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
