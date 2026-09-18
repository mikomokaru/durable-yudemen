import type { PlanRequest } from "../solver/request";
import type { OrderItem } from "../domain/order";
import { slotSpanOf, type NoodlePreset } from "../domain/store";
import { placeableTargets } from "../engine/schedule";
import type { ScheduleParams } from "../engine/objective";

export interface CpsatPlanRequest extends PlanRequest {
  readonly planner: "cpsat";
  readonly inputKey: string;
  readonly requestId: string;
}

/**
 * CP-SAT が 1 回で扱える計画対象の**天井**。ここで切る（2026-09-13・ユーザー判断）。
 *
 * 値の根拠は本番トラフィックでの実測（2026-09-13）。上限 24・予算 0.172 で CPU p50 1,731 ms・
 * max 4,571 ms・10,000 ms 超過 0 件（`verification/cpsat-cpu-window-20260913.md`）。
 * **32 は測っていない**——上限を動かすときはその件数で測り直す。
 */
export const CPSAT_TARGET_LIMIT = 24;

/**
 * **受領までの見込み遅れ。モデルが置ける最も早い開始時刻をこれだけ先へ送る（2026-09-14）。**
 *
 * 計画は組んだ時刻の「今」から置き始めるが、DO がそれを受け取るのは Queue → 求解 → 復路の
 * 後である。受領時刻では先頭の配置が**過去開始**になっており、`feasibleRelease` が
 * 「`startAt < 解放時刻`」で落とす——解放表は受領時刻で床を張るからである。一片が卓 1 つに
 * まとまる局面（実データの `table_no` は全行 1）では、それが計画全体の棄却になる。
 *
 * **これが採用 0 の本体だった**（2026-09-14 実測・本番 322 件すべて `rejected`）。掃引は計画と
 * 採否を同じ `now` で見ていたため一度も踏めていない（`--deliver-delay` を足して再現した）。
 *
 * 値の根拠は本番実測（2026-09-14・60 分・n=320、`cpsat-queue-received` → `cpsat.plan-decided`）。
 *
 * | p50 | p90 | p99 | max |
 * |---:|---:|---:|---:|
 * | 2,648 ms | 4,498 ms | 5,905 ms | 6,619 ms |
 *
 * 8,000 ms は max に約 1.2 倍の余裕を置いた値である。**大きくすれば棄却は減るが、先頭の推奨が
 * その分だけ先へ動く**——新しい計画が届くたびに頭が先送りされるので、到着間隔より長い遅れを
 * 置くと先頭の推奨が永久に「今」にならない。超過した回は棄却されるので、**残余の棄却率を
 * 測って値を見直す**（式・遅れ・棄却率を 1 組で記録する）。
 */
export const CPSAT_DELIVERY_LEAD_MS = 8_000;

/**
 * CP-SAT が置く計画対象。**`placeableTargets` の絞りを共有し、天井で切る。**
 *
 * 絞りを共有するのは、`isStale` が見る集合と別物だったのを直したためである（2026-09-13）。
 * 以前の独自条件（`slotSpan <= min(2, slotCount)`）は実データの span が 1〜2 でたまたま一致して
 * いただけで、構造としては別の集合だった。
 *
 * **切ることの帰結を明記する。** 一片はその Table_Group の計画対象を全件置かなければ `isStale` で
 * 落ちる。卓が 1 つで計画対象が天井を超える局面では、**切った計画は採用され得ない**——本番実測で
 * 165 店舗・334 件の受領すべてが `coverage` で棄却された。切って送るのはユーザー判断であり
 * （2026-09-13）、見える提案にするには受理側の被覆規則も併せて変える必要がある。
 */
export function cpsatTargets(
  pending: readonly OrderItem[],
  presets: readonly NoodlePreset[],
  slotCount: number,
  now: number,
  params: ScheduleParams,
  limit: number = CPSAT_TARGET_LIMIT,
): readonly OrderItem[] {
  // 釜に入らない品目はモデルが置けない。`placeableTargets` は上げ窓の上限（arms + HELPER_ARMS）で
  // 絞るが、釜の本数は見ない——CP-SAT 固有の条件としてここで足す。
  return placeableTargets(pending, now as never, presets, params)
    .filter((item) => slotSpanOf(item.portions) <= slotCount)
    .slice(0, limit);
}

/**
 * 入力の完全な写し。旧来の 32bit 抑制ハッシュとは別物で、欠落なく同一性を判定する。
 * 私設の経路だけを通り、記録にも永続にも出さない。Shown_Plan の変化も古い並行解を無効にする。
 *
 * **これを輸送に載せない。** 載せると同じデータがメッセージに 2 回入り、実測で
 * `PlanRequest` 44,068 B に対しメッセージが 93,591 B（2.12 倍）になる。Queues は 64 KB ごと
 * 課金なので操作が倍になり、さらに品名が長い局面（実測 77,696 B）は 2 倍して 165 KB となり
 * **1 通の上限 128 KB を超えて送出が止まる**——その店舗の計画が出なくなる。
 * 輸送には `cpsatInputDigest` を載せる（2026-09-13）。
 */
export function cpsatInputKey(request: PlanRequest): string {
  return JSON.stringify([
    request.pending,
    request.running,
    request.params,
    request.noodlePresets,
    request.shownPlan,
  ]);
}

/**
 * 輸送に載せる入力の指紋。`cpsatInputKey` の SHA-256（16 進 64 文字）である。
 *
 * **受け手は送られた値の中身を使っていない。** 自分で `cpsatInputKey` を組み直して
 * 一致を見るだけなので、写しでもハッシュでも同じ判定ができる。ならば短いほうを送る。
 *
 * 衝突は考慮している——SHA-256 の 256bit に対し、1 店舗が 1 日に出す要求は高々 1,000 件
 * 程度である。旧来の 32bit ハッシュとは桁が違う。
 */
export async function cpsatInputDigest(request: PlanRequest): Promise<string> {
  const bytes = new TextEncoder().encode(cpsatInputKey(request));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 輸送に載った `inputKey` が、受け取った入力のものかを確かめる。
 *
 * 2026-09-13 の段階配備で、送り手は写しではなくハッシュを載せるようになった。
 * 移行中は写しも受けていたが、切り替え完了を確認して**受理を 1 つに戻した**——
 * 2 つ受ける形を残すと、送り手が古い形へ戻っても気づけない。
 */
export async function matchesCpsatInput(request: CpsatPlanRequest): Promise<boolean> {
  return request.inputKey === (await cpsatInputDigest(request));
}

/**
 * Queue の 1 メッセージの上限（[Queues limits](https://developers.cloudflare.com/queues/platform/limits/)）から
 * 内部 metadata の分を引いた、送出できる上限。
 *
 * 実測では計画対象 64 件・釜 24 の最悪形で 77,696 バイトだった（`tests/cpsat-plan-request-size`）。
 * 収まるのは往路に載るのが待ち行列全体ではなく計画対象の先頭 `PLAN_TARGET_LIMIT` 件だけだから
 * であり、**その上界が動けば前提も動く**。品名・卓名の長さに domain の上限が無いので、
 * 送出前の検査を関門として置く。
 */
export const CPSAT_QUEUE_PAYLOAD_LIMIT_BYTES = 128 * 1024 - 1024;

/** 送出前の検査の結末。超過は理由を持つ失敗で、成功と区別できる（R6.4）。 */
export type CpsatPayloadCheck =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly bytes: number };

/**
 * 1 通に収まるかを確かめる。**超過を黙って落とさない**ための関門である。
 *
 * バイト数は UTF-8 で数える——`String.length` は符号単位の数であり、日本語の商品名を
 * 含む要求では実際のバイト数と食い違う。
 */
export function checkCpsatPayload(request: CpsatPlanRequest): CpsatPayloadCheck {
  const bytes = new TextEncoder().encode(JSON.stringify(request)).length;
  return { ok: bytes <= CPSAT_QUEUE_PAYLOAD_LIMIT_BYTES, bytes };
}
