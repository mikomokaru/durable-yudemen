// tests/ingress/arrival-window.example.test.ts — Order_Arrival_Time の値域窓の example test。
//
// 窓の判定は境界がすべてである（内と外を分ける線が 2 本しかない）。ゆえに面で押さえるより、
// 境界ちょうどを点で固定する方が判定の意図を正確に写す。
//
// あわせて「型としては通り、値域では落ちる」という 2 層の関門の関係を固定する（AC 8.12 の具体例）。
// batch.ts の 4 構造検証は非負整数であることまでしか見ず、値域は本モジュールが見る。

import { describe, expect, it } from "vitest";
import { toArrivalRecord } from "../../src/ingress/batch";
import { ARRIVAL_WINDOW_MS, isWithinArrivalWindow } from "../../src/ingress/arrival-window";

/** 受理時刻。実運用の桁（2025 年台のエポックミリ秒）を用いる。 */
const NOW = 1_755_460_339_000;

describe("ingress/arrival-window — ARRIVAL_WINDOW_MS", () => {
  it("窓の幅は 2 時間である（Unrouted_Record の保持期間と同一の値・AC 8.13）", () => {
    expect(ARRIVAL_WINDOW_MS).toBe(7_200_000);
  });
});

describe("ingress/arrival-window — isWithinArrivalWindow", () => {
  it("受理時刻ちょうどは窓の内である（上限は受理時刻・AC 8.14）", () => {
    expect(isWithinArrivalWindow(NOW, NOW)).toBe(true);
  });

  it("2 時間前ちょうどは窓の内である（下限を含む閉区間）", () => {
    expect(isWithinArrivalWindow(NOW - ARRIVAL_WINDOW_MS, NOW)).toBe(true);
  });

  it("2 時間前の 1 ミリ秒前は窓の外である", () => {
    expect(isWithinArrivalWindow(NOW - ARRIVAL_WINDOW_MS - 1, NOW)).toBe(false);
  });

  it("受理時刻の 1 ミリ秒後は窓の外である（未来の到着時刻は時計のずれを超えた異常・AC 8.14）", () => {
    expect(isWithinArrivalWindow(NOW + 1, NOW)).toBe(false);
  });

  it("arrival_timestamp_ms = 0 は型としては通り、値域では窓の外になる（AC 8.12）", () => {
    // 構造検証は非負整数を要求するだけゆえ 0 は通る（Upstream_Contract 上も 0 は非負である）。
    const record = toArrivalRecord({
      path: "/lio/order",
      payload: {},
      arrival_timestamp_ms: 0,
      sequence_number: "1",
    });
    expect(record?.arrivalTimestampMs).toBe(0);
    // それが Order_Arrival_Time になれば Wait_Time が約 56 年となり、当該品目が待ち行列の先頭に居座る。
    expect(isWithinArrivalWindow(0, NOW)).toBe(false);
  });

  it("下限は固定値ではなく受理時刻からの相対である（AC 8.13）", () => {
    // 同じ到着時刻が、受理時刻が 1 ミリ秒進むだけで窓の内から外へ転じる。固定の下限ならこうならない。
    const arrival = NOW - ARRIVAL_WINDOW_MS;
    expect(isWithinArrivalWindow(arrival, NOW)).toBe(true);
    expect(isWithinArrivalWindow(arrival, NOW + 1)).toBe(false);
  });
});
