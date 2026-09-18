// tests/cpsat-input-digest.example.test.ts — 入力の同一性を輸送に載せる形を固定する。
//
// **Validates: cpsat-planner-integration R5.3, R6.4**
//
// 送り手は入力の写しではなくハッシュを載せる。受け手は自分で組み直して照合するので、
// どちらでも同じ判定ができる——ならば短いほうを送る。写しを載せると同じデータが
// メッセージに 2 回入り、実測で 2.12 倍になって 1 通の上限を脅かす。
//
// **段階配備の途中では両方が届く。** 受け手が写しも受けることを、切り替えが終わるまで
// ここで守る（終わったら写しの受理を外し、この試験もハッシュだけに絞る）。
import { describe, expect, it } from "vitest";
import {
  checkCpsatPayload,
  cpsatInputDigest,
  cpsatInputKey,
  matchesCpsatInput,
  type CpsatPlanRequest,
} from "../src/cpsat/request";
import { DEFAULT_NOODLE_PRESETS } from "../src/domain/store";
import { schedulingDefaults } from "./storeConfigDefaults";

const base = {
  planner: "cpsat",
  storeId: "yamaokaya-1108",
  requestId: "00000000-0000-4000-8000-000000000000",
  pending: [
    {
      externalOrderId: "POS-0001",
      itemIndex: 0,
      noodleType: DEFAULT_NOODLE_PRESETS[0].noodleType,
      firmness: "normal",
      tableId: "T-1",
      arrivalTime: 1_700_000_000_000,
      portions: 1,
      itemName: "特味噌ネギラーメン",
      sizeName: "中盛",
      completedAt: null,
      interruptedAt: null,
      tableAssignedAt: null,
    },
  ],
  running: [],
  params: schedulingDefaults(3),
  noodlePresets: DEFAULT_NOODLE_PRESETS,
  digest: 0,
  shownPlan: [],
} as unknown as Omit<CpsatPlanRequest, "inputKey">;

describe("輸送に載せる入力の同一性", () => {
  it("ハッシュは 16 進 64 文字で、写しより桁違いに短い", async () => {
    const hashed = await cpsatInputDigest(base as never);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed.length).toBeLessThan(cpsatInputKey(base as never).length / 10);
  });

  it("受け手はハッシュだけを受け、写しは受けない", async () => {
    // 段階配備（2026-09-13）の 3 段目で、写しの受理を外した。2 つ受ける形を残すと、
    // 送り手が古い形へ戻っても気づけない。
    const hashed: CpsatPlanRequest = { ...base, inputKey: await cpsatInputDigest(base as never) };
    const copied: CpsatPlanRequest = { ...base, inputKey: cpsatInputKey(base as never) };
    expect(await matchesCpsatInput(hashed)).toBe(true);
    expect(await matchesCpsatInput(copied)).toBe(false);
  });

  it("入力が変われば一致しない", async () => {
    const hashed: CpsatPlanRequest = { ...base, inputKey: await cpsatInputDigest(base as never) };
    const moved: CpsatPlanRequest = {
      ...hashed,
      pending: [{ ...base.pending[0]!, arrivalTime: 1_700_000_001_000 }],
    };
    expect(await matchesCpsatInput(moved)).toBe(false);
  });

  it("ハッシュにすると、入力が大きいほど節約が効く", async () => {
    // 1 品目では写しも小さく、半減しない。主張すべきは**入力に比例して膨らむ項が
    // 消えること**である。品目を増やして比が変わることで示す。
    const measure = async (count: number) => {
      const pending = Array.from({ length: count }, (_, index) => ({
        ...base.pending[0]!,
        externalOrderId: `POS-${String(index).padStart(4, "0")}`,
      }));
      const scene = { ...base, pending } as unknown as Omit<CpsatPlanRequest, "inputKey">;
      const copied: CpsatPlanRequest = { ...scene, inputKey: cpsatInputKey(scene as never) };
      const hashed: CpsatPlanRequest = {
        ...scene,
        inputKey: await cpsatInputDigest(scene as never),
      };
      return {
        copied: checkCpsatPayload(copied).bytes,
        hashed: checkCpsatPayload(hashed).bytes,
      };
    };
    const one = await measure(1);
    const many = await measure(64);
    // ハッシュ側は入力 1 本ぶんしか持たない。写し側は 2 本持つので、品目が増えるほど差が開く。
    expect(many.hashed).toBeLessThan(many.copied / 1.9);
    expect(many.copied - many.hashed).toBeGreaterThan(one.copied - one.hashed);
    // 64 KB の課金境界を跨ぐかは局面全体（`running`・`shownPlan` を含む）で決まる。
    // その主張は実局面を組む `cpsat-plan-request-size.example.test.ts` が担う。
    // ここで固定するのは**入力に比例する項が 1 本消える**という性質だけである。
  });
});
