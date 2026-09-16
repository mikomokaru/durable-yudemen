// tests/cpsat-plan-request-size.example.test.ts — 往路のボディが Queue の 1 通に載るか。
//
// **Validates: cpsat-planner-integration 第9節の実行契機の選び直し（判断材料）**
//
// Cloudflare Queues の 1 メッセージは 128 KB が上限である
// （https://developers.cloudflare.com/queues/platform/limits/）。実行契機を Queue へ
// 移す案は、`PlanRequest` がその 1 通に収まることを前提にしている。前提は測ってから
// 使う。手で組んだ近似ではなく engine に `RequestPlan` を出させ、shell の `requestPlan`
// と同じ形へ組んで UTF-8 バイト数を採る。
//
// 上界は engine 側が決めている——計画対象は PLAN_TARGET_LIMIT = 64 件、釜は
// unitCount × SLOTS_PER_UNIT。品目の文字列長には domain の上限が無いので、
// 実データに寄せた長さ（POS の商品名は日本語＝1 文字 3 バイト）で測り、
// 文字列長を変えたときの増え方も併せて残す。
import { describe, expect, it } from "vitest";
import { decide } from "../src/engine/decide";
import { EMPTY_STATE, type TimerState } from "../src/engine/state";
import { fromSnapshot } from "../src/engine/snapshot";
import { PLAN_TARGET_LIMIT } from "../src/engine/schedule";
import {
  DEFAULT_NOODLE_PRESETS,
  DEFAULT_UNIT_COUNT,
  SLOTS_PER_UNIT,
  UNIT_COUNT_MAX,
} from "../src/domain/store";
import type { Effect } from "../src/engine/effect";
import type { Event } from "../src/engine/event";
import type { EpochMillis, TimerId } from "../src/engine/types";
import type { OrderItem } from "../src/domain/order";
import { checkCpsatPayload, cpsatInputKey } from "../src/cpsat/request";
import { settleParams } from "./settleParams";
import { nonEmpty } from "./nonEmpty";

const SYNC = { arms: 2, toleranceRatio: 0.1 };
const T0 = 1_700_000_000_000 as EpochMillis;
const QUEUE_MESSAGE_LIMIT = 128 * 1024;

/** POS が実際に送る形に寄せた 1 品目。名前は日本語＝1 文字 3 バイト。 */
function item(index: number, itemName: string, tableId: string): OrderItem {
  return {
    externalOrderId: `POS-20260912-${String(index).padStart(6, "0")}`,
    itemIndex: index % 8,
    noodleType: DEFAULT_NOODLE_PRESETS[0].noodleType,
    firmness: "normal",
    tableId,
    arrivalTime: T0 + index * 1000,
    slotSpan: 1,
    itemName,
    sizeName: "中盛",
    completedAt: null,
    interruptedAt: null,
  };
}

/**
 * 計画対象の枠を埋め、さらに釜も全部塞いでから、最後に出た RequestPlan を採る。
 *
 * 釜を塞ぐのは `running` を空にしないためである。空のまま測ると、往路のボディの
 * 一部を数えないまま「収まる」と言うことになる。
 */
function requestPlanEffect(
  itemName: string,
  tableId: string,
  unitCount: number = DEFAULT_UNIT_COUNT,
): Effect | undefined {
  const params = settleParams(SYNC, unitCount);
  // 枠より多く入れる。planTargets が先頭 PLAN_TARGET_LIMIT 件へ切るので、
  // 溢れさせておかないと上界を測ったことにならない。
  const slotCount = unitCount * SLOTS_PER_UNIT;
  const count = PLAN_TARGET_LIMIT + slotCount + 8;
  let state: TimerState = EMPTY_STATE;
  // 最後に出た RequestPlan を採る。指紋は計画対象（先頭 PLAN_TARGET_LIMIT 件）
  // だけを畳むので、枠が埋まったあとの到着では指紋が変わらず要求が出ない。
  // 最終遷移の effects を見ると、いちばん大きい要求を取り逃がす。
  let latest: Effect | undefined;
  for (let index = 0; index < count; index += 1) {
    const event: Event = {
      type: "OrderArrived",
      arrival: nonEmpty([item(index, itemName, tableId)]),
      now: (T0 + index * 1000) as EpochMillis,
    };
    const outcome = decide(state, event, params);
    if (!outcome.ok) throw new Error("arrival must not be rejected");
    latest = outcome.effects.find((effect) => effect.type === "RequestPlan") ?? latest;
    // DO と同じ確定の仕方。put 成功したスナップショットだけが次の Working_Copy になる。
    const persisted = outcome.effects.find((effect) => effect.type === "Persist");
    if (persisted?.type === "Persist") state = fromSnapshot(persisted.snapshot);
  }

  // 釜を 1 つずつ塞ぐ。品目を指す開始なので、麺種・茹で秒は engine が品目から導く。
  for (let slot = 0; slot < slotCount; slot += 1) {
    const now = (T0 + (count + slot) * 1000) as EpochMillis;
    const event: Event = {
      type: "StartOrderItem",
      slotIds: [`slot-${slot}`],
      externalOrderId: `POS-20260912-${String(slot).padStart(6, "0")}`,
      itemIndex: slot % 8,
      // 既存テストと同じ流儀。ブランドは検証の産物で、ここは生成側である。
      newTimerId: `timer-${slot}` as TimerId,
      now,
    };
    const outcome = decide(state, event, params);
    if (!outcome.ok) continue;
    latest = outcome.effects.find((effect) => effect.type === "RequestPlan") ?? latest;
    const persisted = outcome.effects.find((effect) => effect.type === "Persist");
    if (persisted?.type === "Persist") state = fromSnapshot(persisted.snapshot);
  }
  return latest;
}

/** shell の requestPlan と同じ形へ組む（storeId を添えるのは送出側の責務）。 */
function bodyBytes(effect: Extract<Effect, { readonly type: "RequestPlan" }>): number {
  const body = {
    storeId: "cpsat-transport-20260909-04",
    pending: effect.pending,
    running: effect.running,
    params: effect.params,
    noodlePresets: effect.noodlePresets,
    digest: effect.digest,
    shownPlan: effect.shownPlan,
  };
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

describe("PlanRequest が Queue の 1 通に載るか", () => {
  it("実データに寄せた長さで 128 KB を大きく下回る", () => {
    const effect = requestPlanEffect("特味噌ネギラーメン", "T-12");
    expect(effect?.type).toBe("RequestPlan");
    if (effect?.type !== "RequestPlan") return;
    expect(effect.pending.length).toBe(PLAN_TARGET_LIMIT);
    // 釜が空のまま測っていないこと。空だと往路の一部を数え落とす。
    expect(effect.running.length).toBeGreaterThan(0);

    const bytes = bodyBytes(effect);
    // 数値そのものを主張に出す。上限に対してどれだけ空いているかが判断材料である。
    expect(bytes).toBeLessThan(QUEUE_MESSAGE_LIMIT);
    // 余裕の主張。上限の半分に届かないことを固定し、engine の上界
    // （PLAN_TARGET_LIMIT・釜数）が動いたら気づけるようにする。
    expect(bytes).toBeLessThan(QUEUE_MESSAGE_LIMIT / 2);
    console.log(
      JSON.stringify({
        case: "realistic",
        bytes,
        limit: QUEUE_MESSAGE_LIMIT,
        headroomRatio: Number((bytes / QUEUE_MESSAGE_LIMIT).toFixed(4)),
        pending: effect.pending.length,
        running: effect.running.length,
        // 空なら、この欄は測れていない。上限は PLAN_TARGET_LIMIT 件である。
        shownPlan: effect.shownPlan.length,
        noodlePresets: effect.noodlePresets.length,
      }),
    );
  });

  it("釜も名前も上限にして、なお 128 KB に届かない", () => {
    // domain は品名・卓名の長さを縛らないので、上界は「長くしたらどうなるか」で
    // 押さえるほかない。POS の伝票に載る現実的な上限をかなり超えた長さを入れる。
    const longName = "特製濃厚魚介豚骨つけ麺大盛".repeat(8); // 104 文字 = 312 バイト
    const longTable = "カウンター奥左".repeat(4);
    // 釜も上限（UNIT_COUNT_MAX = 4・24 スロット）にする。これで pending・running・
    // shownPlan の 3 つとも engine の上界に張り付き、残る変数は文字列長だけになる。
    const effect = requestPlanEffect(longName, longTable, UNIT_COUNT_MAX);
    if (effect?.type !== "RequestPlan") throw new Error("expected RequestPlan");

    const bytes = bodyBytes(effect);
    expect(bytes).toBeLessThan(QUEUE_MESSAGE_LIMIT);
    console.log(
      JSON.stringify({
        case: "long-names",
        bytes,
        limit: QUEUE_MESSAGE_LIMIT,
        headroomRatio: Number((bytes / QUEUE_MESSAGE_LIMIT).toFixed(4)),
        itemNameBytes: new TextEncoder().encode(longName).length,
        pending: effect.pending.length,
        running: effect.running.length,
        shownPlan: effect.shownPlan.length,
      }),
    );
  });

  it("Queue に載る実際のメッセージは PlanRequest の約2倍になる", () => {
    const effect = requestPlanEffect("特味噌ネギラーメン", "T-12");
    if (effect?.type !== "RequestPlan") throw new Error("expected RequestPlan");
    const body = {
      storeId: "yamaokaya-1108",
      pending: effect.pending,
      running: effect.running,
      params: effect.params,
      noodlePresets: effect.noodlePresets,
      digest: effect.digest,
      shownPlan: effect.shownPlan,
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).length;
    // `cpsatInputKey` は pending・running・params・presets・shownPlan の JSON である。
    // メッセージはその文字列を**フィールドとして別に載せる**ので、同じデータが 2 回入る。
    const message = {
      ...body,
      planner: "cpsat" as const,
      inputKey: cpsatInputKey(body),
      requestId: "00000000-0000-4000-8000-000000000000",
    };
    const check = checkCpsatPayload(message);
    console.log(
      JSON.stringify({
        planRequestBytes: bodyBytes,
        messageBytes: check.bytes,
        ratio: Number((check.bytes / bodyBytes).toFixed(2)),
        // Queues は 64 KB ごとに 1 操作。境界を跨ぐと課金が倍になる。
        billedOperationsPerAccess: Math.ceil(check.bytes / (64 * 1024)),
        withinLimit: check.ok,
      }),
    );
    expect(check.ok).toBe(true);
  });
});
