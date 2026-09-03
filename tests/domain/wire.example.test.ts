// tests/domain/wire.example.test.ts — verified-wire-contract の境界を例示で固定する。
//
// **Validates: Requirements 2.3, 2.4, 5.2, 5.3**
//
// 性質テストは「全域でこうなる」を言うが、境界がどこに引かれているかは言わない。ここは線そのものを
// 名指しで固定する——何を通し、何を落とすか。特に「値域を見ない」は、見てしまうと engine の拒否が
// error として要求元へ返る経路が無音の破棄に変わるため、例示で楔を打つ。

import { describe, expect, it } from "vitest";
import { toClientMessage, toServerMessage } from "../../src/domain/wire";
import { RETIRED_MESSAGE_TYPES } from "./wireGenerators";

const START = { type: "start", slotIds: ["0"], noodleType: "Thin", boilSeconds: 60 } as const;

describe("Feature: verified-wire-contract — 撤去済み種別の回帰の楔", () => {
  it("撤去済み種別 5 種はいずれも Decode_Failure になる", () => {
    for (const type of RETIRED_MESSAGE_TYPES) {
      expect(toServerMessage(JSON.stringify({ type, serverTime: 0, timerId: "T" }))).toBeNull();
    }
  });

  it("未知の種別・JSON 不正・非オブジェクトはいずれも Decode_Failure になる", () => {
    expect(toServerMessage(JSON.stringify({ type: "whatever", serverTime: 0 }))).toBeNull();
    expect(toServerMessage("{not json")).toBeNull();
    expect(toServerMessage("42")).toBeNull();
    expect(toClientMessage("null")).toBeNull();
  });
});

describe("Feature: verified-wire-contract — ClientMessage は形だけを見る（要件 2.3）", () => {
  it("値域外の boilSeconds は通る（engine が InvalidBoilSeconds で拒否し error を返す）", () => {
    for (const boilSeconds of [0, -1, 1801, 0.5]) {
      expect(toClientMessage(JSON.stringify({ ...START, boilSeconds }))?.type).toBe("start");
    }
  });

  it("NaN / Infinity は JSON を跨げず null として届くため落ちる（旧実装と同じ）", () => {
    // JSON.stringify は NaN / Infinity を null へ写す。ゆえに受け手が見るのは常に null であり、
    // typeof で落ちる。engine 側の Number.isFinite 検査はワイヤ以外の経路のための防御である。
    expect(JSON.stringify({ boilSeconds: Number.NaN })).toBe('{"boilSeconds":null}');
    expect(toClientMessage(JSON.stringify({ ...START, boilSeconds: Number.NaN }))).toBeNull();
  });

  it("空文字の noodleType は通る（engine が InvalidSlotOrNoodle で拒否する）", () => {
    expect(toClientMessage(JSON.stringify({ ...START, noodleType: "" }))?.type).toBe("start");
  });

  it("実在しない timerId は通る（engine が TimerNotFound で拒否する）", () => {
    expect(toClientMessage(JSON.stringify({ type: "cancel", timerId: "no-such" }))).toEqual({
      type: "cancel",
      timerId: "no-such",
    });
  });

  it("空の slotIds は落ちる（基数は形の問題であり、engine の拒否に委ねない）", () => {
    expect(toClientMessage(JSON.stringify({ ...START, slotIds: [] }))).toBeNull();
  });

  it("未知の firmness は落ちる（有限リテラル集合の所属は形の問題）", () => {
    expect(
      toClientMessage(JSON.stringify({ type: "adjust", timerId: "T", firmness: "chewy" })),
    ).toBeNull();
  });
});

describe("Feature: slot-suggested-start — 品目を指す開始（startOrderItem）", () => {
  const ORDER_ITEM = {
    type: "startOrderItem",
    slotIds: ["0"],
    externalOrderId: "o-1",
    itemIndex: 2,
  } as const;

  it("3 項目が揃えば通る（麺種・茹で加減・茹で秒は運ばない）", () => {
    expect(toClientMessage(JSON.stringify(ORDER_ITEM))).toEqual(ORDER_ITEM);
  });

  it("余剰の麺種・茹で秒は落とす（運ばないものを受け取らない）", () => {
    const withExtra = { ...ORDER_ITEM, noodleType: "Thin", boilSeconds: 60 };
    expect(toClientMessage(JSON.stringify(withExtra))).toEqual(ORDER_ITEM);
  });

  it("品目の鍵が欠ける・不正なら Decode_Failure（この種別は品目を指すことが存在理由である）", () => {
    // start と違い「組を成さずアドホックとして通す」余地が無い——指せない要求は要求として成立しない。
    for (const broken of [
      { externalOrderId: undefined },
      { itemIndex: undefined },
      { externalOrderId: "" },
      { itemIndex: -1 },
      { itemIndex: 1.5 },
    ]) {
      expect(toClientMessage(JSON.stringify({ ...ORDER_ITEM, ...broken }))).toBeNull();
    }
  });

  it("start は品目を指さない（余剰の品目参照は落ちる）", () => {
    const withItem = { ...START, externalOrderId: "o-1", itemIndex: 2 };
    expect(toClientMessage(JSON.stringify(withItem))).toEqual(START);
  });
});

describe("Feature: verified-wire-contract — ServerMessage は正規化条件を含む（要件 2.4）", () => {
  const snapshot = {
    type: "snapshot",
    serverTime: 1,
    timers: [],
    pendingOrders: [],
    recommendations: [],
  } as const;

  it("必須の全量列を欠く snapshot は落ちる", () => {
    expect(
      toServerMessage(JSON.stringify({ type: "snapshot", serverTime: 1, timers: [] })),
    ).toBeNull();
  });

  it("空の slotIds を持つ推奨は snapshot 全体を落とす（粒度はメッセージ単位・要件 2.7）", () => {
    const withEmpty = {
      ...snapshot,
      timers: [
        {
          id: "T",
          slotIds: ["0"],
          noodleType: "Thin",
          firmness: "normal",
          startTime: 0,
          endTime: 1,
        },
      ],
      recommendations: [{ externalOrderId: "o-1", itemIndex: 0, slotIds: [], startAt: 1 }],
    };
    expect(toServerMessage(JSON.stringify(withEmpty))).toBeNull();
  });

  it("余剰フィールドは落として正規化する（要素検証の共有の帰結）", () => {
    const withExtra = {
      type: "config",
      serverTime: 1,
      unitCount: 1,
      arms: 3,
      toleranceRatio: 10,
      noodlePresets: [
        {
          noodleType: "Thin",
          boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 },
          nonsense: "x",
        },
      ],
      orderSyncWeight: 1,
      tableSyncWeight: 1,
      affinityWeight: 1,
      orderSyncToleranceSeconds: 10,
      tableSyncToleranceSeconds: 10,
      affinityToleranceDistance: 10,
      unitOrigins: [{ x: 0, y: 0 }],
      slotOffsets: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 0, y: 2 },
        { x: 1, y: 2 },
      ],
      firmnessCodes: [],
      menuItems: [],
    };
    const message = toServerMessage(JSON.stringify(withExtra));
    expect(message?.type).toBe("config");
    expect(message?.type === "config" ? message.noodlePresets[0] : null).toEqual({
      noodleType: "Thin",
      boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 },
    });
  });

  it("0 以下の茹で秒を持つプリセットは落ちる（正規化条件が値域を含む・要件 2.4）", () => {
    const zeroSeconds = {
      type: "config",
      serverTime: 1,
      unitCount: 1,
      arms: 3,
      toleranceRatio: 10,
      noodlePresets: [
        { noodleType: "Thin", boilSeconds: { extraHard: 0, hard: 52, normal: 60, soft: 75 } },
      ],
      orderSyncWeight: 1,
      tableSyncWeight: 1,
      affinityWeight: 1,
      orderSyncToleranceSeconds: 10,
      tableSyncToleranceSeconds: 10,
      affinityToleranceDistance: 10,
      unitOrigins: [{ x: 0, y: 0 }],
      slotOffsets: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 0, y: 2 },
        { x: 1, y: 2 },
      ],
      firmnessCodes: [],
      menuItems: [],
    };
    expect(toServerMessage(JSON.stringify(zeroSeconds))).toBeNull();
  });

  it("6 要素でない slotOffsets は落ちる（タプルの基数）", () => {
    const fiveOffsets = {
      type: "config",
      serverTime: 1,
      unitCount: 1,
      arms: 3,
      toleranceRatio: 10,
      noodlePresets: [
        { noodleType: "Thin", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
      ],
      orderSyncWeight: 1,
      tableSyncWeight: 1,
      affinityWeight: 1,
      orderSyncToleranceSeconds: 10,
      tableSyncToleranceSeconds: 10,
      affinityToleranceDistance: 10,
      unitOrigins: [{ x: 0, y: 0 }],
      slotOffsets: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 0, y: 2 },
      ],
      firmnessCodes: [],
      menuItems: [],
    };
    expect(toServerMessage(JSON.stringify(fiveOffsets))).toBeNull();
  });
});
