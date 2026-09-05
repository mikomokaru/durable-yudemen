// engine/lift の回帰テスト——上げ表の導出（initialLifts）・窓の数え方（loadWith）・置き場所（firstFit）・
// 手伝いの費用（liftOverflow）を、design Component 10 と Requirement 9 の具体値で固定する。
//
// lift.property が「firstFit は候補以上で条件を満たす最小」「ちょうど L 離れた上がりは同じ窓に入らない」を
// 全域で言うのに対し、ここは **どの時刻に置くか・いくら減点するか** を数字で固定する。とくに AC 9.15 の
// 近似（{60:1, 104:1, 105:2} → 0）は「手伝いが要る窓には必ず費用が付く」と読み違えやすい判断なので、
// 期待値として明記する。

import { describe, expect, it } from "vitest";
import {
  advanceLifts,
  firstFit,
  initialLifts,
  liftCap,
  liftOverflow,
  loadWith,
  type Lift,
  type LiftTable,
} from "../../src/engine/lift";
import { createTimer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { HELPER_ARMS } from "../../src/domain/store";
import { nonEmpty } from "../nonEmpty";

/** 秒で書いた時刻をミリ秒の EpochMillis へ。例はすべて秒単位で読めるようにする。 */
function sec(seconds: number): EpochMillis {
  return (seconds * 1_000) as EpochMillis;
}

/** {秒: 本数} の並びから表を組む（at 昇順に並べるのは advanceLifts の責務）。 */
function table(...entries: readonly (readonly [seconds: number, span: number])[]): LiftTable {
  return advanceLifts(
    [],
    entries.map(([seconds, span]): Lift => ({ at: sec(seconds), span })),
  );
}

/** design Component 10 の例と同じ arms 2・L 45 秒。 */
const PARAMS = { arms: 2, liftIntervalSeconds: 45 };

describe("initialLifts — 走行中から上げ表を導く", () => {
  it("全 Timer（boiled も）を実効 endTime・占める釜の数で載せ、at 昇順に並べる", () => {
    const running = [
      createTimer({
        id: "late" as TimerId,
        slotIds: nonEmpty(["2" as SlotId, "3" as SlotId]),
        noodleType: "Thin" as NoodleType,
        firmness: "normal",
        startTime: sec(40),
        endTime: sec(100),
        seq: 0,
        adjustment: 5_000, // 実効 endTime は 105 秒
      }),
      createTimer({
        id: "boiled" as TimerId,
        slotIds: nonEmpty(["0" as SlotId]),
        noodleType: "Thin" as NoodleType,
        firmness: "normal",
        startTime: sec(-70),
        endTime: sec(-10),
        seq: 1,
        boiledAt: sec(-10),
      }),
      createTimer({
        id: "soon" as TimerId,
        slotIds: nonEmpty(["1" as SlotId]),
        noodleType: "Thin" as NoodleType,
        firmness: "normal",
        startTime: sec(0),
        endTime: sec(60),
        seq: 2,
      }),
    ];

    expect(initialLifts(running)).toEqual([
      { at: sec(-10), span: 1 }, // boiled は過去の窓の負荷として残る（AC 9.3）
      { at: sec(60), span: 1 },
      { at: sec(105), span: 2 }, // 大盛（2 釜）は 2 本分（AC 9.11）
    ]);
  });
});

describe("loadWith — t を含む半開窓の負荷の最大", () => {
  it("ちょうど L 離れた上がりは同じ窓に入らず、1 ミリ秒手前なら入る（AC 9.3）", () => {
    const lifts = table([0, 2]);
    // [0, 45) は 45 秒を含まない。45 秒を含む窓は [45, 90) だけで、既存の上がりは無い。
    expect(loadWith(lifts, sec(45), 1, PARAMS)).toBe(1);
    // 44.999 秒は [0, 45) に含まれる。
    expect(loadWith(lifts, (sec(45) - 1) as EpochMillis, 1, PARAMS)).toBe(3);
  });

  it("t を含む窓だけを見る——含まない窓の過負荷は数えない（AC 9.4）", () => {
    // 0 秒に 6 本（走行中だけで上限 4 を超えている窓）。
    const lifts = table([0, 6]);
    expect(loadWith(lifts, sec(45), 1, PARAMS)).toBe(1);
    expect(loadWith(lifts, sec(-45), 1, PARAMS)).toBe(1);
    // 含む窓なら数える。
    expect(loadWith(lifts, sec(10), 1, PARAMS)).toBe(7);
  });

  it("起点は既存の上がり時刻と t 自身——その中の最大を採る", () => {
    // 54・54・66 秒に 1 本ずつ。60 秒に 2 本を足すと [54, 99) に 5 本、[60, 105) に 3 本。
    const lifts = table([54, 1], [54, 1], [66, 1]);
    expect(loadWith(lifts, sec(60), 2, PARAMS)).toBe(5);
  });
});

describe("firstFit — 候補以降で上限を満たす最初の時刻", () => {
  it("span が arms + HELPER_ARMS を超えれば null（AC 9.12）", () => {
    expect(liftCap(PARAMS)).toBe(2 + HELPER_ARMS);
    expect(firstFit([], sec(0), liftCap(PARAMS) + 1, PARAMS)).toBeNull();
    expect(firstFit([], sec(0), liftCap(PARAMS), PARAMS)).toBe(sec(0));
  });

  it("走行中 4 本が 60 秒に上がる表では、残りは 105 秒へ（design Component 10）", () => {
    const lifts = table([60, 4]);
    expect(firstFit(lifts, sec(60), 1, PARAMS)).toBe(sec(105));
    // 窓の外の候補は動かない。
    expect(firstFit(lifts, sec(105), 1, PARAMS)).toBe(sec(105));
    expect(firstFit(lifts, sec(200), 4, PARAMS)).toBe(sec(200));
  });

  it("走行中 3 本が 54・54・66 秒の表で、候補 60 秒の pack（span 2）は 99 秒、1 品なら 60 秒（レビュー 1）", () => {
    const lifts = table([54, 1], [54, 1], [66, 1]);
    // [54, 99) に 3 本 ＋ 2 本 = 5 > 4 → 起点 54 の窓を抜けた 99 秒。99 秒を含む窓は [66, 111)（1 + 2）と
    // [99, 144)（0 + 2）だけで、どちらも上限内。
    expect(firstFit(lifts, sec(60), 2, PARAMS)).toBe(sec(99));
    expect(firstFit(lifts, sec(60), 1, PARAMS)).toBe(sec(60));
  });

  it("走行中だけで上限を超えている窓は、それを含まない候補を動かさない（AC 9.4）", () => {
    const lifts = table([0, 6]);
    expect(firstFit(lifts, sec(45), 1, PARAMS)).toBe(sec(45));
    // 含む候補は窓を抜けるまで後ろへ動く（半開ゆえちょうど 45 秒で抜ける）。
    expect(firstFit(lifts, (sec(45) - 1) as EpochMillis, 1, PARAMS)).toBe(sec(45));
  });

  it("重なる複数の窓を順に抜ける（最早の起点から L ずつ進めて止まる）", () => {
    // 0 秒に 3 本、40 秒に 4 本。候補 40 秒（span 1）は [0, 45) で 8 → 45 秒へ、そこで [40, 85) が 5 → 85 秒へ。
    const lifts = table([0, 3], [40, 4]);
    expect(firstFit(lifts, sec(40), 1, PARAMS)).toBe(sec(85));
  });
});

describe("liftOverflow — 手伝いの費用（一意な貪欲・秒相当）", () => {
  it("{60:2, 63:2, 105:2} は [60,105) で超過 2 → 2 × 45 = 90（design Component 10）", () => {
    expect(liftOverflow(table([60, 2], [63, 2], [105, 2]), PARAMS)).toBe(90);
  });

  it("{60:1, 104:1, 105:2} は割当が [60,105) / [105,150) で超過 0——窓 [104,149) の 3 本は数えない近似（AC 9.15）", () => {
    expect(liftOverflow(table([60, 1], [104, 1], [105, 2]), PARAMS)).toBe(0);
  });

  it("空の表と arms 以下の表は 0、重みは liftIntervalSeconds 秒/本", () => {
    expect(liftOverflow([], PARAMS)).toBe(0);
    expect(liftOverflow(table([10, 1], [20, 1]), PARAMS)).toBe(0);
    expect(liftOverflow(table([10, 1], [20, 1], [30, 1]), PARAMS)).toBe(45);
    expect(
      liftOverflow(table([10, 1], [20, 1], [30, 1]), { arms: 2, liftIntervalSeconds: 30 }),
    ).toBe(30);
  });

  it("重なる窓を二度数えない——起点を割当済みの内側へ置かない", () => {
    // 0 秒に 3 本・30 秒に 3 本・60 秒に 3 本（arms 2）。[0,45) に 6 → 4、次の未割当は 60 秒で [60,105) に 3 → 1。
    // 30 秒を起点に数え直せば [30,75) に 6 でもう 4 になるが、30 秒は [0,45) に割当済みなので起点にならない。
    expect(liftOverflow(table([0, 3], [30, 3], [60, 3]), PARAMS)).toBe((4 + 1) * 45);
  });
});
