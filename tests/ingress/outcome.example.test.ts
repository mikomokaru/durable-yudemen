// tests/ingress/outcome.example.test.ts — 1 Record の分類の example test。
//
// property test（outcome.property.test.ts）が全域性を面で押さえるのに対し、ここでは既知 `path` の 2 値と
// 「Status_Path が未知 `path` と別種別に落ちる」境界を点で固定する。

import { describe, expect, it } from "vitest";
import { KNOWN_RECORD_PATHS } from "../../src/ingress/outcome";

describe("ingress/outcome — KNOWN_RECORD_PATHS", () => {
  it("既知 path は Order_Path と Status_Path の 2 値だけである（AC 7.7）", () => {
    expect([...KNOWN_RECORD_PATHS.keys()]).toEqual(["/lio/order", "/lio/status"]);
  });

  it("Order_Path は order へ落ちる（Pending_Order への写像の対象・AC 7.2）", () => {
    expect(KNOWN_RECORD_PATHS.get("/lio/order")).toBe("order");
  });

  it("Status_Path は status へ落ち、未知 path とは別種別になる（AC 7.8・7.9）", () => {
    // 破棄という挙動は同一だが事由が異なる——既知の path であり Permanent_Failure ではない。
    expect(KNOWN_RECORD_PATHS.get("/lio/status")).toBe("status");
    expect(KNOWN_RECORD_PATHS.get("/lio/status")).not.toBe(KNOWN_RECORD_PATHS.get("/lio/whatever"));
  });

  it("既知 2 値の外はすべて未知になる（大小・末尾スラッシュ・前後の空白を含む）", () => {
    expect(KNOWN_RECORD_PATHS.get("/lio/whatever")).toBeUndefined();
    expect(KNOWN_RECORD_PATHS.get("/LIO/ORDER")).toBeUndefined();
    expect(KNOWN_RECORD_PATHS.get("/lio/order/")).toBeUndefined();
    expect(KNOWN_RECORD_PATHS.get(" /lio/order")).toBeUndefined();
    expect(KNOWN_RECORD_PATHS.get("lio/order")).toBeUndefined();
    expect(KNOWN_RECORD_PATHS.get("")).toBeUndefined();
  });
});
