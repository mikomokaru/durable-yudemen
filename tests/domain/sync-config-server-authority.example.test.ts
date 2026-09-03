// Feature: synchronized-boil-adjustment, Example: sync parameters use one-way delivery and server authority
// **Validates: Requirements 5.1, 6.5**
//
// 後続の online-cook-scheduling で StoreConfig は全項目配信へ改められた。
// ここでは現行契約を固定する。arms / toleranceRatio は config で一方向配信されるが、
// client のビューにも client → server の変更要求にも現れず、StoreConfig が同期計算の権威を持つ。

import { describe, expect, it } from "vitest";
import { decideView, EMPTY_VIEW } from "../../src/client/connection";
import type { ClientMessage, ServerMessage } from "../../src/domain/messages";
import type { StoreConfig } from "../../src/domain/store";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type AllKeys<T> = T extends unknown ? keyof T : never;
type ConfigMessage = Extract<ServerMessage, { readonly type: "config" }>;

// config は StoreConfig そのものを運ぶ（verified-wire-contract 判断 5）。項目名を列挙すると
// StoreConfig の項目集合を写した第二の一覧がここに生まれ、設定が増えるたびに更新を求めてくる。
// 構造で言えば、その一覧は要らない——`& StoreConfig` であることそのものを検査する。
type ConfigShapeAssertions = [
  Assert<Equal<keyof ConfigMessage, "type" | "serverTime" | keyof StoreConfig>>,
  Assert<Equal<Extract<AllKeys<ClientMessage>, "arms" | "toleranceRatio">, never>>,
];

const configShapeAssertions: ConfigShapeAssertions = [true, true];
const SERVER_TIME = 1_700_000_000_000;

const configMessage = {
  type: "config",
  serverTime: SERVER_TIME,
  unitCount: 2,
  noodlePresets: [
    { noodleType: "Thin", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
  ],
  arms: 3,
  toleranceRatio: 12,
  orderSyncWeight: 3,
  tableSyncWeight: 2,
  affinityWeight: 1,
  orderSyncToleranceSeconds: 30,
  tableSyncToleranceSeconds: 60,
  affinityToleranceDistance: 14,
  unitOrigins: [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
  ],
  slotOffsets: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 0, y: 2 },
    { x: 1, y: 2 },
  ],
  firmnessCodes: [{ code: 10010, firmness: "hard" }],
  menuItems: [{ productCode: 11421, noodleType: "Thin", sizes: [{ code: 19401, slotSpan: 1 }] }],
} satisfies ConfigMessage;

const CONFIG_KEYS = [
  "affinityToleranceDistance",
  "affinityWeight",
  "arms",
  "firmnessCodes",
  "menuItems",
  "noodlePresets",
  "orderSyncToleranceSeconds",
  "orderSyncWeight",
  "serverTime",
  "slotOffsets",
  "tableSyncToleranceSeconds",
  "tableSyncWeight",
  "toleranceRatio",
  "type",
  "unitCount",
  "unitOrigins",
] as const;

describe("同期調整パラメータの一方向配信と server authority の境界", () => {
  it("config で一方向配信しても JSON 往復後の client view と変更要求には保持しない", () => {
    expect(configShapeAssertions).toEqual([true, true]);
    expect(Object.keys(configMessage).sort()).toEqual(CONFIG_KEYS);
    expect(configMessage.arms).toBe(3);
    expect(configMessage.toleranceRatio).toBe(12);

    const serialized = JSON.stringify(configMessage);
    const delivered = JSON.parse(serialized) as ConfigMessage;

    expect(Object.keys(delivered).sort()).toEqual(CONFIG_KEYS);
    expect(delivered).toHaveProperty("arms", 3);
    expect(delivered).toHaveProperty("toleranceRatio", 12);

    const view = decideView(EMPTY_VIEW, {
      kind: "Server",
      message: delivered,
      receivedAt: SERVER_TIME,
    });

    expect(view.unitCount).toBe(2);
    expect(view.noodlePresets).toEqual(configMessage.noodlePresets);
    expect(view).not.toHaveProperty("arms");
    expect(view).not.toHaveProperty("toleranceRatio");
  });
});
