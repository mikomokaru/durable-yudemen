// tests/client/localAuthority.property.test.ts — 一時的なローカル権限（temporary local authority）の property テスト。
//
// 何を守っているか — 接続が落ちているあいだ client が自前で下す 3 種の決定である。start（Provisional_Timer の
// 注入）・cancel（起源別の除去と一様残滓）・茹で上がりの発火判定（dueLocalTimers と LocalDone の冪等化）。
// 検証対象は `decideView` の LocalStart / LocalCancel / LocalDone / Reconcile 分岐と `dueLocalTimers` だけで、
// いずれも WS・DOM・時計・localStorage に触れない純粋関数である。時刻・生成 id はすべて生成器が引数値として
// 吐き、`Date.now` のスタブも `vi.useFakeTimers()` も用いない（要件13.4・tests/client/README.md）。
//
// 既存カバーとの棲み分け（同じ主張を二度書かない）:
//   - Property 3 の範囲内注入の厳密な主張（local がちょうど 1 件増える・id === newTimerId・endTime ===
//     correctedNow + boilSeconds * 1000・slotIds 一致・残滓解除・既存 Timer が失われない）は
//     `degraded-slot-superimposition.gate.property.test.ts` の Property 2 が担う。ここは残余だけを書く——
//     **範囲外 boilSeconds × 空きスロット**（占有ゲートが範囲検査より先に return するため gate 側が踏めない
//     経路）、要件9.1 の表示走行中化、`processedIds` の不変。
//   - Property 5 の「`shouldHandleDone` / `markProcessed` が高々 1 回・登録後 false・id 間の不干渉」は
//     `notification.property.test.ts` の Property 16 が担う。ここは残余だけを書く——`dueLocalTimers` の
//     全域特徴づけ（両包含・`endTime === correctedNow` 境界）と、`decideView` を入口にした混在列の畳み込み。
//
// 生成器は `tests/client/generators.ts` の公開分（genClientView / genClientTimer / genCorrectedNow /
// genBoilSeconds）を土台に用い、足りない分（範囲外だけを吐く茹で秒・空きスロット化・残滓の種）だけを
// ここでローカルに組む。
//
// 参照: .kiro/specs/offline-degradation/design.md Property 3 / 4 / 5（改訂後の本文）

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideView,
  dueLocalTimers,
  type ClientEvent,
  type ClientTimer,
  type ClientView,
} from "../../src/client/connection";
import { assignedSlotDisplays } from "../../src/client/components/slotDisplay";
import { BOIL_SECONDS_MAX, BOIL_SECONDS_MIN } from "../../src/engine/types";
import type { TimerFact, NonEmptyArray } from "../../src/domain/timer";
import { nonEmpty } from "../nonEmpty";
import { genBoilSeconds, genClientTimer, genClientView, genCorrectedNow } from "./generators";

const NUM_RUNS = 200;

/** LocalStart イベントの形（`decideView` の判別共用体から取り出す。第二の定義を作らない）。 */
type LocalStart = Extract<ClientEvent, { kind: "LocalStart" }>;

/** 残滓 1 件の形（公開型 `ClientView["lastResults"]` の値型から引く。第二の定義を作らない）。 */
type Residual = NonNullable<ReturnType<ClientView["lastResults"]["get"]>>;

// ── ローカルプール（要求スロットは unit 0 に収まる範囲へ限る） ──────────────────────────────────

/**
 * 要求スロットのプール。unit 0（SLOTS_PER_UNIT = 6）に収まる範囲に限るのは、表示導出を
 * `assignedSlotDisplays(view, [0], now, [])` で引くためである——担当外スロットは射影で構造的に現れない。
 */
const REQUEST_SLOT_POOL = ["0", "1", "2", "3"] as const;
/** 麺種プール。 */
const NOODLE_POOL = ["thin", "thick", "curly", "ramen"] as const;
/** 注入される provisional の id プール。generators.ts の id 空間（t-*）と分け、注入分を id で同定できるようにする。 */
const NEW_ID_POOL = ["new-a", "new-b"] as const;
/**
 * 既存残滓に載せる麺種プール。NOODLE_POOL と**意図的に重ならない**——残滓が上書きされたのか既存が
 * 残ったのかを値で見分けるため（generators.ts の RESIDUAL_NOODLE_POOL と同じ流儀）。
 */
const RESIDUAL_NOODLE_POOL = ["last-thin", "last-thick"] as const;

/** 残滓の種。記録時刻 at は負域から引く——イベントが運ぶ除去時刻（非負）と重ならず、上書きを at でも見分けられる。 */
const genResidual: fc.Arbitrary<Residual> = fc.record({
  noodleType: fc.constantFrom(...RESIDUAL_NOODLE_POOL),
  at: fc.integer({ min: -1_000_000, max: -1 }),
});

/** 除去時刻 / 受信時刻のエポックミリ秒（非負。既存残滓の at が負域ゆえ必ず区別できる）。 */
const genAt: fc.Arbitrary<number> = fc.integer({ min: 0, max: 10_000_000 });

/** 実装（decideLocalStart）が通す範囲。境界値は engine の正本を引き、テスト側で二度書かない。 */
function isBoilInRange(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= BOIL_SECONDS_MIN && seconds <= BOIL_SECONDS_MAX;
}

/**
 * 範囲内 / 範囲外だけを吐く茹で秒。病的値の定義（0・負・1801 以上・非整数）を二度書かないため、
 * 共有 genBoilSeconds（両方を吐く）を述語で二分する。
 */
const genInRangeBoilSeconds: fc.Arbitrary<number> = genBoilSeconds.filter(isBoilInRange);
const genOutOfRangeBoilSeconds: fc.Arbitrary<number> = genBoilSeconds.filter(
  (seconds) => !isBoilInRange(seconds),
);

/** ClientTimer から起源タグを削いだワイヤ表現。snapshot / Reconcile が運ぶのは事実だけである。 */
function toWireTimer(timer: ClientTimer): TimerFact {
  return {
    id: timer.id,
    slotIds: timer.slotIds,
    noodleType: timer.noodleType,
    firmness: timer.firmness,
    startTime: timer.startTime,
    endTime: timer.endTime,
  };
}

// ── Property 3 の残余 — 空きスロット × 範囲外 ────────────────────────────────────────────────────

/** 主張の単位 — 空きスロットへの LocalStart を、範囲内・範囲外の二つの秒数で同じ盤面へ畳む組。 */
interface FreeSlotStartCase {
  readonly view: ClientView;
  readonly slotIds: NonEmptyArray<string>;
  readonly noodleType: string;
  readonly newTimerId: string;
  readonly correctedNow: number;
  readonly inRangeSeconds: number;
  readonly outOfRangeSeconds: number;
}

/**
 * 要求スロットを空きにし、そこへ既存残滓を必ず載せたビューを作る。
 *
 * 空きにするのは、実装が占有ゲートを範囲検査より**先**に return するためである。占有したままでは範囲外の
 * 分岐へ一度も到達せず、主張が「ゲートが効いた」ことの再検査に化ける（それは gate 側の Property 1 の担当）。
 * 残滓を載せるのは、不変の主張が「元から無かった」で緑にならないようにするため。
 */
function freeSlots(view: ClientView, slotIds: readonly string[], residual: Residual): ClientView {
  const lastResults = new Map(view.lastResults);
  for (const slotId of slotIds) lastResults.set(slotId, residual);
  return {
    ...view,
    timers: view.timers.filter(
      (timer) => !timer.slotIds.some((slotId) => slotIds.includes(slotId)),
    ),
    lastResults,
  };
}

const genFreeSlotStartCase: fc.Arbitrary<FreeSlotStartCase> = fc
  .record({
    base: genClientView,
    slots: fc.subarray([...REQUEST_SLOT_POOL], { minLength: 1 }),
    residual: genResidual,
    noodleType: fc.constantFrom(...NOODLE_POOL),
    newTimerId: fc.constantFrom(...NEW_ID_POOL),
    inRangeSeconds: genInRangeBoilSeconds,
    outOfRangeSeconds: genOutOfRangeBoilSeconds,
  })
  .chain((draft) => {
    const view = freeSlots(draft.base, draft.slots, draft.residual);
    // correctedNow は元ビューの endTime 群に対する境界（±1・全過去・全未来）を踏む。空きスロット化で
    // 落ちた Timer の endTime も候補に残るが、それも正当な補正後現在時刻である。
    return genCorrectedNow(draft.base).map((correctedNow): FreeSlotStartCase => ({
      view,
      slotIds: nonEmpty(draft.slots),
      noodleType: draft.noodleType,
      newTimerId: draft.newTimerId,
      correctedNow,
      inRangeSeconds: draft.inRangeSeconds,
      outOfRangeSeconds: draft.outOfRangeSeconds,
    }));
  });

/** 同じ盤面・同じ要求スロットに対し、茹で秒だけを差し替えた LocalStart を組む。 */
function startEvent(start: FreeSlotStartCase, boilSeconds: number): LocalStart {
  return {
    kind: "LocalStart",
    slotIds: start.slotIds,
    noodleType: start.noodleType,
    boilSeconds,
    newTimerId: start.newTimerId,
    correctedNow: start.correctedNow,
  };
}

// ── Property 4 — 起源別のローカル cancel ─────────────────────────────────────────────────────────

/** cancel 対象の id。generators.ts の id 空間（TIMER_ID_POOL / UNRELATED_ID_POOL / ABSENT_ID_POOL）と分ける。 */
const CANCEL_TARGET_ID = "t-cancel";
/** ビューに存在しない id。上と同様、生成器の id 空間と衝突しない。 */
const CANCEL_ABSENT_ID = "t-nobody";

interface CancelCase {
  /** 対象を必ず含むビュー。存在側と非存在側を同じ試行で踏むため、対象は構築で保証する（filter で捨てない）。 */
  readonly view: ClientView;
  readonly target: ClientTimer;
  readonly now: number;
}

const genCancelCase: fc.Arbitrary<CancelCase> = fc
  .record({
    base: genClientView,
    target: genClientTimer.map((timer) => ({ ...timer, id: CANCEL_TARGET_ID })),
    now: genAt,
  })
  .map(({ base, target, now }): CancelCase => ({
    view: { ...base, timers: [...base.timers, target] },
    target,
    now,
  }));

// ── Property 5 の残余 — 発火対象の全域特徴づけと混在列の畳み込み ──────────────────────────────────

/** 発火対象にする server 起源 Timer の id。生成器の processedIds（TIMER_ID_POOL / UNRELATED 由来）に現れない。 */
const DUE_TARGET_ID = "t-due";

interface DueCase {
  /** 未登録・server 起源の対象を必ず含むビュー（両包含の主張が空にならないことを構造で保証する）。 */
  readonly view: ClientView;
  readonly correctedNow: number;
  readonly target: ClientTimer;
  /** 同一 timerId の LocalDone を畳む回数。 */
  readonly doneRepeats: number;
  readonly receivedAt: number;
}

const genDueCase: fc.Arbitrary<DueCase> = fc
  .record({
    base: genClientView,
    target: genClientTimer.map((timer) => ({
      ...timer,
      id: DUE_TARGET_ID,
      origin: "server" as const,
    })),
    doneRepeats: fc.integer({ min: 1, max: 4 }),
    receivedAt: genAt,
  })
  .chain((draft) => {
    const view: ClientView = { ...draft.base, timers: [...draft.base.timers, draft.target] };
    return genCorrectedNow(view).map((correctedNow): DueCase => ({
      view,
      correctedNow,
      target: draft.target,
      doneRepeats: draft.doneRepeats,
      receivedAt: draft.receivedAt,
    }));
  });

/**
 * `dueLocalTimers` の全域特徴づけを**両包含**で検べる。
 *
 * 「含まれるべきでないものが 1 つも含まれない」だけでは、常に空配列を返す実装でも緑になる。ゆえに
 * 「含まれるべきものが全部含まれる」を対に置く。
 */
function expectDueExactly(view: ClientView, correctedNowMs: number): void {
  const expected = view.timers.filter(
    (timer) => timer.endTime <= correctedNowMs && !view.processedIds.has(timer.id),
  );
  const actual = dueLocalTimers(view, correctedNowMs);
  for (const timer of expected) expect(actual).toContain(timer);
  for (const timer of actual) expect(expected).toContain(timer);
  expect(actual).toHaveLength(expected.length);
}

describe("client/connection 一時的なローカル権限（offline-degradation）", () => {
  // Feature: offline-degradation, Property 3: degraded のローカル start は範囲内でちょうど 1 件の
  // Provisional_Timer を注入し、範囲外では不変
  // **Validates: Requirements 6.1, 6.2, 6.5, 9.1**
  //
  // 残余の 3 点だけを書く（範囲内注入の厳密な主張は gate 側 Property 2 の担当）:
  //   - 範囲外 boilSeconds（0・負・1801 以上・非整数）× **空きスロット** → ビュー不変
  //   - 要件9.1 の表示走行中化（当該スロットの表示導出が running かつ unconfirmed）
  //   - 範囲内でも processedIds は不変
  //
  // 範囲内・範囲外を**同じ試行の同じ盤面**へ畳むのは、範囲外の不変だけを検べると「LocalStart が常に何も
  // しない」実装でも緑になるためである。増える／増えないの対比を構造で置く（分布に頼らない）。
  it("Property 3: 空きスロットでも範囲外の茹で秒は注入せず、範囲内はちょうど 1 件を注入して当該スロットを走行中にする", () => {
    fc.assert(
      fc.property(genFreeSlotStartCase, (start) => {
        const { view, slotIds } = start;
        // 生成器の前提 — 要求スロットは空きで、そこに既存残滓が載っている。
        expect(
          view.timers.some((timer) => timer.slotIds.some((slotId) => slotIds.includes(slotId))),
        ).toBe(false);
        for (const slotId of slotIds) expect(view.lastResults.has(slotId)).toBe(true);

        // 範囲外 — 参照同一で返る（端の update が永続化も再描画も起こさない性質そのもの）。
        const rejected = decideView(view, startEvent(start, start.outOfRangeSeconds));
        expect(rejected).toBe(view);
        // 参照同一に含まれるが、プロパティ本文の主張（Timer も processedIds も残滓も不変）を明示に読む。
        expect(rejected.timers).toBe(view.timers);
        expect(rejected.processedIds).toBe(view.processedIds);
        expect(rejected.lastResults).toBe(view.lastResults);

        // 範囲内 — ちょうど 1 件増える（上の不変と対になる主張）。
        const accepted = decideView(view, startEvent(start, start.inRangeSeconds));
        expect(accepted.timers).toHaveLength(view.timers.length + 1);
        // 注入は発火抑止の記録に触れない（ローカル start は「まだ鳴っていない」事実を何も変えない）。
        expect(accepted.processedIds).toBe(view.processedIds);

        // 要件9.1 — 表示導出の側から見る。当該スロットは走行中（running）かつ未確定（unconfirmed）であり、
        // SlotCard が Start の口を描くのは idle 分岐だけゆえ、走行中化は口の消失そのものである。
        // ローカル時刻は補正後現在時刻から offset を差し引いて逆算する（時計に触れず引数で運ぶ）。
        const localNow = start.correctedNow - view.offset;
        const displays = assignedSlotDisplays(accepted, [0], localNow, []);
        for (const slotId of slotIds) {
          const display = displays.find((candidate) => candidate.slot === Number(slotId));
          expect(display).toBeDefined();
          expect(display!.kind).toBe("running");
          // unconfirmed は running のみが持つ導出値（origin === "local" から導く・要件6.4）。
          expect(display!.kind === "running" && display!.unconfirmed).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: offline-degradation, Property 4: degraded のローカル cancel は起源別に正しく作用する
  // **Validates: Requirements 7.1, 7.2**
  //
  // 実装（decideLocalCancel）の作用を、起源の二面と非存在の面で主張する。対象が在れば origin を問わず
  // timers から除去し、除去直前の麺種を各駆動スロットへ `{ noodleType, at: now }` として記録する（中断でも
  // 完了でも一様な残滓・要件5.2）。server 起源のときだけ processedIds へ登録し、local 起源では変えない。
  // 対象が非存在なら参照同一で返る。
  it("Property 4: ローカル cancel は起源を問わず除去して残滓を記録し、processedIds は server 起源のときだけ増える", () => {
    // 起源の二面を実際に踏んだことの実測。片側しか吐かない生成器では、もう一方の分岐の主張が一度も
    // 実行されないまま緑になる（起源別という property の核が空虚になる）。
    const observedOrigins = new Set<ClientTimer["origin"]>();

    fc.assert(
      fc.property(genCancelCase, ({ view, target, now }) => {
        observedOrigins.add(target.origin);

        // 非存在 id — 参照同一（残滓の Map も作り直さない）。
        expect(decideView(view, { kind: "LocalCancel", timerId: CANCEL_ABSENT_ID, now })).toBe(
          view,
        );

        const result = decideView(view, { kind: "LocalCancel", timerId: target.id, now });

        // 対象は消え、対象以外は参照同一のまま残る（除去が周りを作り直さない）。
        expect(result.timers).toHaveLength(view.timers.length - 1);
        expect(result.timers.some((timer) => timer.id === target.id)).toBe(false);
        for (const timer of view.timers) {
          if (timer.id !== target.id) expect(result.timers).toContain(timer);
        }

        // 残滓 — 除去直前の麺種を各駆動スロットへ、除去時刻 now を起点として記録する。既存残滓は別プール
        // （last-*）かつ at が負域ゆえ、上書きされたのか元のまま残ったのかを値で見分けられる。
        for (const slotId of target.slotIds) {
          expect(result.lastResults.get(slotId)).toEqual({
            noodleType: target.noodleType,
            at: now,
          });
        }
        // 対象スロット以外の残滓は元のまま。キー集合は「元 ∪ 対象の駆動スロット」に一致する。
        for (const [slotId, residual] of view.lastResults) {
          if (target.slotIds.includes(slotId)) continue;
          expect(result.lastResults.get(slotId)).toBe(residual);
        }
        expect([...result.lastResults.keys()].sort()).toEqual(
          [...new Set([...view.lastResults.keys(), ...target.slotIds])].sort(),
        );

        if (target.origin === "server") {
          // server-confirmed の cancel は後続のローカル発火を抑止する（要件7.2）。
          expect(result.processedIds.has(target.id)).toBe(true);
          expect([...result.processedIds].sort()).toEqual(
            [...new Set([...view.processedIds, target.id])].sort(),
          );
        } else {
          // provisional の cancel は抑止記録を変えない（参照同一・要件7.1）。生成器の processedIds は
          // TIMER_ID_POOL / UNRELATED_ID_POOL 由来ゆえ、対象 id を初めから含まない。
          expect(result.processedIds).toBe(view.processedIds);
          expect(result.processedIds.has(target.id)).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );

    expect([...observedOrigins].sort()).toEqual(["local", "server"]);
  });

  // Feature: offline-degradation, Property 5: ローカル茹で上がりは各 timerId につき高々 1 回だけ処理される
  // （後続 snapshot でも再発火しない）
  // **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
  //
  // 残余の 2 点だけを書く（shouldHandleDone / markProcessed の「高々 1 回」は notification 側 Property 16 の担当）:
  //   - dueLocalTimers の全域特徴づけ（両包含・endTime === correctedNow 境界が due 側・server / local 双方）
  //   - decideView を入口にした混在列の畳み込み。現行 ServerMessage に done 種別は無いため、サーバ側の完了は
  //     全量 snapshot から当該 Timer が消えることとして現れる（design の改訂後 P5）。ゆえに 2 経路は
  //     「LocalDone の重複」と「snapshot からの消失」で組む。
  it("Property 5: dueLocalTimers は『期限到来かつ未登録』と厳密に一致し、LocalDone の重複と snapshot 消失は再発火を生まない", () => {
    // 生成器が local 起源の発火対象を実際に吐いたことの実測。踏めていなければ「起源を問わない」は空虚である。
    let sawLocalOriginDue = false;

    fc.assert(
      fc.property(genDueCase, ({ view, correctedNow, target, doneRepeats, receivedAt }) => {
        // (1) 全域特徴づけ — 任意の補正後現在時刻で両包含。
        expectDueExactly(view, correctedNow);
        if (dueLocalTimers(view, correctedNow).some((timer) => timer.origin === "local")) {
          sawLocalOriginDue = true;
        }

        // 境界（endTime === correctedNow）は due 側に属する。対象は未登録ゆえ必ず返り、標本が空にならない。
        expect(dueLocalTimers(view, target.endTime)).toContain(target);
        expectDueExactly(view, target.endTime);
        // 境界の直前は返らない（endTime ≤ correctedNow の ≤ が < に狭まっていないことの裏面）。
        expect(dueLocalTimers(view, target.endTime - 1)).not.toContain(target);

        // (2a) LocalDone の重複 — 何度畳んでも登録は 1 回。参照同一で返る回は無変更を意味する。
        let folded = view;
        let registrations = 0;
        for (let round = 0; round < doneRepeats; round++) {
          const next = decideView(folded, { kind: "LocalDone", timerId: target.id });
          if (next !== folded) registrations++;
          folded = next;
        }
        expect(registrations).toBe(1);
        expect(folded.processedIds.has(target.id)).toBe(true);
        // 以後の発火対象に現れない（アラートを二度鳴らさない）。特徴づけは畳み込み後も保たれる。
        expect(dueLocalTimers(folded, target.endTime)).not.toContain(target);
        expectDueExactly(folded, correctedNow);

        // (2b) snapshot からの消失 — サーバ側の完了は全量 snapshot に当該 Timer が現れないこととして届く。
        const reconciled = decideView(view, {
          kind: "Reconcile",
          timers: view.timers
            .filter((timer) => timer.origin === "server" && timer.id !== target.id)
            .map(toWireTimer),
          pendingOrders: view.pendingOrders,
          recommendations: view.recommendations,
          receivedAt,
        });
        expect(reconciled.timers.some((timer) => timer.id === target.id)).toBe(false);
        expect(
          dueLocalTimers(reconciled, target.endTime).some((timer) => timer.id === target.id),
        ).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );

    expect(sawLocalOriginDue).toBe(true);
  });
});
