// tests/client/assignment-ui.example.test.ts — 担当 UI と担当不変の example テスト（要件12.3 / 12.4）。
//
// React テスティングライブラリ（@testing-library/react・jsdom/happy-dom）は本プロジェクトに
// 導入されていない。重い DOM 依存を持ち込まず（YAGNI）、UI の操作スコープを実際に決定している
// 純粋導出ロジックを検証する。SlotBoard は assignedSlotDisplays が返した SlotDisplay からのみ
// SlotCard を生成し、SlotCard は kind から操作 UI（Start/Cancel）の有無を決める。したがって
// 「担当スロットにのみ操作 UI が出る」ことは assignedSlotDisplays の射影スコープに帰着し、
// 「担当不変」は担当集合が view（接続台数の反映）に依存しないことに帰着する。

import { describe, expect, it } from "vitest";
import type { ClientTimer, ClientView } from "../../src/client/connection";
import { slotsOfUnits } from "../../src/client/assignment";
import { assignedSlotDisplays, type SlotDisplay } from "../../src/client/components/slotDisplay";
import { unitsFrom } from "../../src/client/components/UnitSelector";

// SlotCard の描画規則の写し: kind ごとに提示される操作手段を導出する。
// running は Cancel、idle / boiled は Start を提示し、unreceived は操作手段を一切持たない。
// （SlotCard.tsx の分岐とそのまま対応する。）
type Operation = "start" | "cancel";
function operationsOf(display: SlotDisplay): readonly Operation[] {
  switch (display.kind) {
    case "running":
      return ["cancel"];
    case "idle":
    case "boiled":
      return ["start"];
    case "unreceived":
      return [];
  }
}

// 指定スロットにアクティブ Timer を 1 件持つ ClientTimer を組み立てる（server-confirmed）。
function timerOnSlot(slot: number, id: string): ClientTimer {
  return { id, slotIds: [String(slot)], noodleType: "ramen", endTime: 60_000, origin: "server" };
}

// synced 済みのビューを、与えた Timer 集合から組み立てる。
function syncedView(timers: readonly ClientTimer[]): ClientView {
  return {
    timers,
    offset: 0,
    processedIds: new Set<string>(),
    connectivity: "up",
    sync: "synced",
    error: null,
    unitCount: 4,
  };
}

describe("client 担当 UI と担当不変（要件12.3 / 12.4）", () => {
  // 要件12.3: 開始・キャンセル操作は担当スロットに対してのみ提示し、担当外スロットに操作手段を出さない。
  it("操作 UI は担当スロットにのみ描画され、担当外スロットには操作手段が一切出ない", () => {
    const units = [1]; // 担当 = unit 1 = slot 6..11
    const assigned = slotsOfUnits(units);
    // 担当内 slot 6・7 と、担当外 slot 0・12 に Timer がある全量ビュー（担当外も受信はする）。
    const view = syncedView([
      timerOnSlot(6, "in-a"),
      timerOnSlot(7, "in-b"),
      timerOnSlot(0, "out-a"),
      timerOnSlot(12, "out-b"),
    ]);

    const displays = assignedSlotDisplays(view, units, 0);

    // 描画されるスロットは担当集合とちょうど一致する（担当外スロットは構造的に現れない）。
    const renderedSlots = new Set(displays.map((d) => d.slot));
    expect(renderedSlots).toEqual(assigned);

    // 操作手段（Start / Cancel）を持つスロットは、すべて担当集合に含まれる。
    for (const display of displays) {
      if (operationsOf(display).length > 0) {
        expect(assigned.has(display.slot)).toBe(true);
      }
    }

    // 担当外スロット（0・12）に対応する表示・操作はひとつも存在しない。
    expect(displays.some((d) => d.slot === 0 || d.slot === 12)).toBe(false);

    // 担当内の Timer 在席スロットは Cancel を、空き担当スロットは Start を提示する（操作手段が実在する）。
    const slot6 = displays.find((d) => d.slot === 6);
    const slot8 = displays.find((d) => d.slot === 8); // 担当内だが Timer なし
    expect(slot6 && operationsOf(slot6)).toEqual(["cancel"]);
    expect(slot8 && operationsOf(slot8)).toEqual(["start"]);
  });

  // 要件12.4: 担当範囲はユーザーの明示的な再指定でのみ変わり、WS 接続台数の増減では変わらない。
  // 接続台数の変化は「店舗内で見える Timer 集合の変化」としてビューに現れる。担当集合がビューに
  // 依存しないこと（＝接続台数を入力に取らないこと）をもって不変性を示す。
  it("WS 接続台数の増減（＝ビュー上の Timer 集合の変化）で担当ユニット集合は不変", () => {
    const units = [0, 1]; // 担当 = unit 0,1 = slot 0..11
    const expectedAssigned = slotsOfUnits(units);

    // 接続台数の異なる状況を、ビュー上の Timer 集合の違いとして表現する。
    //  - 接続 0 台相当: Timer なし
    //  - 接続少数: 担当内に数件
    //  - 接続多数: 担当内外にまたがる多数の Timer（他端末が店舗中の釜を動かしている状況）
    const views: readonly ClientView[] = [
      syncedView([]),
      syncedView([timerOnSlot(0, "a"), timerOnSlot(5, "b")]),
      syncedView(
        Array.from({ length: 18 }, (_, slot) => timerOnSlot(slot, `t-${slot}`)),
      ),
    ];

    for (const view of views) {
      const displays = assignedSlotDisplays(view, units, 0);
      const renderedSlots = new Set(displays.map((d) => d.slot));
      // 担当集合（＝操作・表示スコープ）はビューの Timer 集合に一切左右されない。
      expect(renderedSlots).toEqual(expectedAssigned);
      // 操作手段が現れるのも常に担当集合の内側のみ。
      for (const display of displays) {
        if (operationsOf(display).length > 0) {
          expect(expectedAssigned.has(display.slot)).toBe(true);
        }
      }
    }
  });

  // 担当範囲が変わる唯一の経路はユーザーの明示的再指定（UnitSelector → unitsFrom）であることを示す。
  // unitsFrom は (base, count) というユーザー入力のみの純関数であり、接続台数を入力に取らない。
  it("担当ユニット集合はユーザー明示指定（unitsFrom）のみで決まり、接続台数を入力に取らない", () => {
    // ユーザーが unit 2 を 1 ユニット担当に再指定 → slot 12..17（店舗総数 3）。
    expect(slotsOfUnits(unitsFrom(2, 1, 3))).toEqual(new Set([12, 13, 14, 15, 16, 17]));
    // ユーザーが unit 0 から 2 ユニットへ再指定 → slot 0..11。
    expect(slotsOfUnits(unitsFrom(0, 2, 3))).toEqual(
      new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    );
    // 同一のユーザー入力は、接続状況に関わらず同一の担当集合を返す（決定的・副作用なし）。
    expect(unitsFrom(1, 1, 3)).toEqual(unitsFrom(1, 1, 3));
  });
});
