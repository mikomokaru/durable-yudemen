// tests/registry/code-index.example.test.ts — Store_Code 逆引き（src/registry/code-index.ts）の example test。
//
// property test（code-index.property.test.ts）が全域の不変を突くのに対し、ここでは設計判断が現れる
// 具体例を固定する——非活性店舗も索引に載る（要件2.7）、Store_Code を持たない店舗は載らない（要件3.8）、
// 衝突は列として返る（要件3.6）。

import { describe, expect, it } from "vitest";
import { buildCodeIndex, detectDuplicateStoreCodes, storeForCode } from "../../src/registry/code-index";
import type { Store } from "../../src/registry/ideal";

/** 検証に影響する事実（storeId・storeCode・active・createdAt）だけを与えて Store を組む。 */
function store(fields: {
  storeId: string;
  storeCode?: string;
  active?: boolean;
  createdAt?: number;
}): Store {
  return {
    storeId: fields.storeId,
    chainId: "chain-a",
    name: fields.storeId,
    policyIds: [],
    override: {},
    storeRoster: [],
    active: fields.active ?? true,
    ...(fields.storeCode === undefined ? {} : { storeCode: fields.storeCode }),
    createdAt: fields.createdAt ?? 0,
    updatedAt: fields.createdAt ?? 0,
  };
}

describe("registry/code-index — 索引の構築と読み出し", () => {
  it("非活性店舗の Store_Code も逆引きできる（閉店の判定は索引の責務でない・要件2.7）", () => {
    const index = buildCodeIndex([
      store({ storeId: "abc123", storeCode: "1001" }),
      store({ storeId: "def456", storeCode: "1002", active: false }),
    ]);

    expect(storeForCode(index, "1001")).toBe("abc123");
    expect(storeForCode(index, "1002")).toBe("def456");
  });

  it("Store_Code を持たない店舗は索引に載らない（要件3.8）", () => {
    const index = buildCodeIndex([store({ storeId: "abc123" }), store({ storeId: "def456", storeCode: "1001" })]);

    expect(index.size).toBe(1);
    expect(storeForCode(index, "1001")).toBe("def456");
  });

  it("未知の Store_Code は undefined を返す（フォールバックしない・要件2.6）", () => {
    const index = buildCodeIndex([store({ storeId: "abc123", storeCode: "1001" })]);

    expect(storeForCode(index, "9999")).toBeUndefined();
  });
});

describe("registry/code-index — 衝突検出", () => {
  it("一意なら空を返す（要件3.1）", () => {
    expect(
      detectDuplicateStoreCodes([
        store({ storeId: "abc123", storeCode: "1001" }),
        store({ storeId: "def456", storeCode: "1002", active: false }),
        store({ storeId: "ghi789" }),
      ]),
    ).toEqual([]);
  });

  it("非活性店舗との衝突も検出する（活性状態を問わず全店で一意・要件3.1）", () => {
    expect(
      detectDuplicateStoreCodes([
        store({ storeId: "def456", storeCode: "1001" }),
        store({ storeId: "abc123", storeCode: "1001", active: false }),
      ]),
    ).toEqual([{ storeCode: "1001", storeIds: ["abc123", "def456"] }]);
  });

  it("複数の衝突を storeCode 昇順で列挙する（要件3.5 / 3.6）", () => {
    expect(
      detectDuplicateStoreCodes([
        store({ storeId: "s2", storeCode: "1002" }),
        store({ storeId: "s1", storeCode: "1001" }),
        store({ storeId: "s3", storeCode: "1002" }),
        store({ storeId: "s4", storeCode: "1001" }),
      ]),
    ).toEqual([
      { storeCode: "1001", storeIds: ["s1", "s4"] },
      { storeCode: "1002", storeIds: ["s2", "s3"] },
    ]);
  });
});
