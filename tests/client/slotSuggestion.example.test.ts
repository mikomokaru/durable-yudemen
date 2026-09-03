// tests/client/slotSuggestion.example.test.ts — 提案の導出の境界。
//
// **Validates: Requirements 1.4, 1.5**
//
// 性質テストは「全域でこうなる」を言うが、線がどこに引かれているかは言わない。ここは線そのものを名指しで
// 固定する——何を提案とし、何を提案としないか。絞り込みの条件は `orderQueueEntries` の内側にあり、
// `slotDisplay` はそれを再実装しない（この 2 つが同じ条件であることが要件 1.4 の実体である）。

import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, type ClientView } from "../../src/client/connection";
import { orderQueueEntries } from "../../src/client/components/queueDisplay";
import { assignedSlotDisplays } from "../../src/client/components/slotDisplay";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import type { PendingOrder } from "../../src/domain/order";
import type { CookRecommendation } from "../../src/domain/messages";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000;
const UNITS = [0] as const;
const NOODLE = DEFAULT_NOODLE_PRESETS[0].noodleType;

function order(overrides: Partial<PendingOrder> = {}): PendingOrder {
  return {
    externalOrderId: "o-1",
    itemIndex: 0,
    noodleType: NOODLE,
    firmness: "normal",
    tableId: null,
    arrivalTime: NOW - 60_000,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    ...overrides,
  };
}

function recommendation(overrides: Partial<CookRecommendation> = {}): CookRecommendation {
  return {
    externalOrderId: "o-1",
    itemIndex: 0,
    slotIds: nonEmpty(["0"]),
    startAt: NOW,
    ...overrides,
  };
}

function view(
  pendingOrders: readonly PendingOrder[],
  recommendations: readonly CookRecommendation[],
): ClientView {
  return { ...EMPTY_VIEW, sync: "synced", connectivity: "up", pendingOrders, recommendations };
}

/**
 * 1 度の導出から idle の next を引く。
 *
 * `entries` を渡して受けるのは、`next` に入る提案が `entries` の要素と**同じオブジェクト**であることに
 * 意味があるためである——`SlotBoard` は品目の鍵をこの参照の一致で引く（`itemOf`）。二度導出すれば
 * 深く等価だが別物になり、その経路が壊れる。
 */
function nextOf(
  current: ClientView,
  slot: number,
  entries = orderQueueEntries(current, UNITS, NOW),
) {
  const display = assignedSlotDisplays(current, UNITS, NOW, entries).find(
    (candidate) => candidate.slot === slot,
  );
  return display !== undefined && display.kind === "idle" ? display.next : undefined;
}

describe("Feature: slot-suggested-start — 提案にならない推奨（要件 1.4）", () => {
  it("対象品目が待ち行列に無い推奨は提案にならない", () => {
    // 既存 `boilSecondsOf` の条件をそのまま保つ。理由の内訳は現場へ持ち出さない（一様に「提案なし」）。
    expect(nextOf(view([], [recommendation()]), 0)).toBeNull();
  });

  it("麺種が現在のプリセットに無い品目の推奨は提案にならない", () => {
    const retired = order({ noodleType: "Retired" });
    expect(nextOf(view([retired], [recommendation()]), 0)).toBeNull();
  });

  it("鍵が一致しない推奨は提案にならない（組で 1 品目を指す）", () => {
    expect(nextOf(view([order()], [recommendation({ itemIndex: 1 })]), 0)).toBeNull();
    expect(nextOf(view([order()], [recommendation({ externalOrderId: "o-2" })]), 0)).toBeNull();
  });
});

describe("Feature: slot-suggested-start — 提案の選び方", () => {
  it("同値の startAt では到着順の先着を採る（並びが揺れない）", () => {
    const first = order({ externalOrderId: "o-early", arrivalTime: NOW - 120_000 });
    const second = order({ externalOrderId: "o-late", arrivalTime: NOW - 60_000 });
    const current = view(
      [second, first], // 入力の並びは到着順でない
      [
        recommendation({ externalOrderId: "o-early", startAt: NOW }),
        recommendation({ externalOrderId: "o-late", startAt: NOW }),
      ],
    );
    // orderQueueEntries が到着順へ並べ替えるため、先着（o-early）が残る。2 件は深く等価（同じ startAt・
    // 同じ slotIds）ゆえ、どちらが選ばれたかは参照でしか区別できない——1 度の導出から引いて同一性で問う。
    const entries = orderQueueEntries(current, UNITS, NOW);
    const next = nextOf(current, 0, entries);
    expect(next).toBe(
      entries.find((entry) => entry.order.externalOrderId === "o-early")?.suggestion,
    );
  });

  it("過去の startAt も提案として出る（時刻の到来を待たせない・AC 8.3）", () => {
    const past = recommendation({ startAt: NOW - 300_000 });
    expect(nextOf(view([order()], [past]), 0)?.startAt).toBe(NOW - 300_000);
  });

  it("複数釜にまたがる推奨は各釜に現れ、slotIds は推奨の全体を保つ（要件 1.5）", () => {
    const wide = recommendation({ slotIds: nonEmpty(["0", "2"]) });
    const current = view([order()], [wide]);
    for (const slot of [0, 2]) {
      const next = nextOf(current, slot);
      expect(next).not.toBeNull();
      // どの釜から押しても推奨の slotIds 全体で開始する（釜ごとに切り出さない）。
      expect(next!.slotIds).toEqual(["0", "2"]);
    }
    expect(nextOf(current, 1)).toBeNull();
  });
});

describe("Feature: slot-suggested-start — 提案は idle 以外に現れない（要件 1.3）", () => {
  it("同期前（unreceived）の釜は next を持たない相になる", () => {
    const connecting: ClientView = { ...view([order()], [recommendation()]), sync: "connecting" };
    const entries = orderQueueEntries(connecting, UNITS, NOW);
    for (const display of assignedSlotDisplays(connecting, UNITS, NOW, entries)) {
      // idle 以外の相は next という項目を型として持たない（提案を出す口が無い）。
      expect(display.kind).not.toBe("idle");
    }
  });
});

describe("Feature: slot-suggested-start — next は entries の提案と同一の参照である", () => {
  it("SlotBoard が品目の鍵を引ける（itemOf が参照の一致に依る）", () => {
    // 提案は品目の鍵を持たない（持たせれば同じ鍵が提案と行の二箇所に現れる）。ゆえに `SlotBoard` は
    // 「同じ提案オブジェクトである」ことで行を引く。1 度の導出を両者へ渡す構造がこれを支えている。
    const current = view([order()], [recommendation()]);
    const entries = orderQueueEntries(current, UNITS, NOW);
    expect(nextOf(current, 0, entries)).toBe(entries[0]?.suggestion);
  });
});
