// engine/schedule.ts — 調理順の計画（Cook_Plan）を表す engine 専用の内部形。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// ここには「計画とは何か」と「slot がいつ空くか」を置く。計画そのものを組む baselineSchedule は
// 同じファイルに後から加わるが、型と解放表は先に独立して立つ（型は状態 TimerState が、解放表は
// 貪欲法の初期状態として要求される）。
// ワイヤへ出す形（CookRecommendation）とは分ける——client が要るのは「次に何を始めるか」だけで、
// 計画の全体像は engine 内部の計算過程である。

import type { EpochMillis, SlotId } from "./types";
import type { Timer } from "./timer";
import { adjustedEndTime, type TableMembers } from "./project";
import { slotDistance, type ScheduleParams } from "./objective";
import { isNonEmpty, type NonEmptyArray } from "../domain/timer";
import type { PendingOrder } from "../domain/order";
import { slotOf, type NoodlePreset } from "../domain/store";

/**
 * Placement — 1 品目の配置。engine 内部形。
 *
 * 品目は (externalOrderId, itemIndex) で指す（PendingOrder を丸ごと抱えない。麺種・卓・到着時刻は
 * Pending_Order 集合が正本であり、計画が写しを持てば二つの真実になる）。
 * serveAt は startAt ＋ 茹で時間の導出の中間値だが、目的関数の同時提供項がこの値の差だけを見るため
 * 計画の一片として持つ（呼び出し側が茹で時間表を引き直さずに採点できる）。
 */
export interface Placement {
  /** POS 側の識別子。対象品目を Pending_Order 集合と突き合わせる鍵。 */
  readonly externalOrderId: string;
  /** 同一オーダー内の品目連番。externalOrderId との組で 1 品目を一意に指す。 */
  readonly itemIndex: number;
  /** 割り当てた slot（複数釜に跨る茹でを許すため非空配列・既存 Timer.slotIds と同一基数）。 */
  readonly slotIds: NonEmptyArray<SlotId>;
  /** 推奨開始時刻。人が従う義務はない（推奨は提案であって指示ではない）。 */
  readonly startAt: EpochMillis;
  /** 提供時刻＝startAt ＋ 茹で時間。Wait_Time の終点であり同時提供の差を測る点。 */
  readonly serveAt: EpochMillis;
}

/**
 * PlanSlice — Plan_Unit ＝ 計画を独立に採用/棄却できる一片。現行の分解軸は Table_Group。
 *
 * 名に分解軸（卓・時間・干渉閉包）を焼き付けない。軸が変わっても「計画の独立した一片」という
 * 概念境界は変わらないため（design.md 命名節）。
 * 一片は自分の点数を持たない。採点は比較の時点（Acceptance_Gate）の導出であって計画の一部ではなく、
 * 永続すれば重みや走行中の変化とずれる（lift-group-planning 判断 7・ADR-0001）。
 */
export interface PlanSlice {
  /** 現行の分解軸＝Table_Group 識別子（tableId が null の品目は単独キーへ写す）。 */
  readonly tableKey: string;
  /** この一片に属する品目の配置。 */
  readonly placements: readonly Placement[];
}

/**
 * CookSchedule — 計画全体。slices は計画順（接頭辞採用の順序）で並ぶ。
 *
 * 導出値であり状態ではない（正本は採用済み PlanSlice 列と現在の Pending_Order / Timer 集合）。
 */
export interface CookSchedule {
  /** 計画順に並ぶ一片の列。 */
  readonly slices: readonly PlanSlice[];
}

/**
 * AcceptedSlice — Acceptance_Gate が採用した PlanSlice（永続する再現不能な事実・AC 7.1）。
 *
 * 形は PlanSlice と同一だが概念境界が違う——PlanSlice は「計算の産物」、AcceptedSlice は
 * 「外部計画のうちこの店が採用したという、再計算では復元できない事実」である。だから状態に載り、永続する。
 * 名を分けるのは、状態のフィールド（acceptedSlices）が何を保持しているかを型が語るため。
 */
export interface AcceptedSlice extends PlanSlice {}

/**
 * toCookSchedule — 外部（Solver_Worker）から届いた生値を検証済みの CookSchedule へ写す唯一の関門（AC 10.3）。
 *
 * **1 箇所でも不正なら全体を null へ落とす。** 部分採用は「届いた計画の一部だけを信じる」ことであり、
 * 部分和も接頭辞の順序も外部が組んだ全体の中でしか意味を持たない。AC 10.3 が全体棄却を定めているのは
 * そのためで、形は domain の `toPendingOrders` と同じ規律である——設定は不正要素を畳んで営業を続けるが、
 * 外部からの到着は全体で受けるか全体で捨てるかのどちらかしかない。
 *
 * **ここが SlotId / EpochMillis のブランドと slotIds の非空を確立する唯一の経路である。** engine の受け口
 * （`receivePlan`）は検証済みの `CookSchedule` ただ一つを受け、生値を知らない（plan.ts 冒頭の規律）。境界で
 * 検証して engine には検証済みの型だけを渡す既存の形（`toPendingOrders`・`parseClientMessage`）にそのまま乗る。
 *
 * **置き場所は `CookSchedule` の定義と同じここである。** 検証は「この型を名乗れる値とは何か」の宣言であり、
 * 型と離せば両者は黙ってずれる（`isNonEmpty` が `NonEmptyArray` と同居しているのと同じ判断）。
 *
 * 外部が score を添えてきても読まない（計画は点数を持たない・AC 5.6）。読まない値を検証すれば、検証だけが
 * 理由で計画が棄却されうる。
 *
 * **見るのは形だけである。** 釜の時間帯の重複・`serveAt` と茹で時間の整合・同一 Table_Group の二重計画は
 * いずれも検査しない——型の内側で成立していない計画であり、`admit` のハード制約が落とす（plan.ts 冒頭）。
 * ここで重ねて見れば、同じ判定が二箇所に生まれる。
 */
export function toCookSchedule(raw: unknown): CookSchedule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.slices)) return null;
  const slices: PlanSlice[] = [];
  for (const value of candidate.slices) {
    const slice = toPlanSlice(value);
    if (slice === null) return null;
    slices.push(slice);
  }
  return { slices };
}

/** 生値を 1 つの PlanSlice へ写す。分解軸の鍵・配置列のいずれかが不正なら null。 */
function toPlanSlice(value: unknown): PlanSlice | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  // 空の tableKey はどの Table_Group も指さない（識別子は tableId か単独キーのいずれかで必ず非空）。
  if (typeof candidate.tableKey !== "string" || candidate.tableKey.length === 0) return null;
  if (!Array.isArray(candidate.placements)) return null;
  const placements: Placement[] = [];
  for (const item of candidate.placements) {
    const placement = toPlacement(item);
    if (placement === null) return null;
    placements.push(placement);
  }
  return { tableKey: candidate.tableKey, placements };
}

/** 生値を 1 配置へ写す。対象品目・釜・開始と提供の時刻のいずれかが不正なら null。 */
function toPlacement(value: unknown): Placement | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  // 品目を指す組の妥当性は domain/order.ts の PendingOrder と同じ（非空 id と 0 以上の整数連番）。
  if (typeof candidate.externalOrderId !== "string" || candidate.externalOrderId.length === 0)
    return null;
  if (!isInteger(candidate.itemIndex) || candidate.itemIndex < 0) return null;
  if (!isInteger(candidate.startAt) || !isInteger(candidate.serveAt)) return null;
  if (!Array.isArray(candidate.slotIds)) return null;
  // slotId は非空文字列。番号への写像（slotOf）は非数値を NaN へ落とし、表のどの index にも一致しない
  // ——存在しない釜を指す計画は admit のハード制約で落ちるため、ここで番号の範囲は見ない。
  if (!candidate.slotIds.every((slotId) => typeof slotId === "string" && slotId.length > 0))
    return null;
  const slotIds: readonly string[] = candidate.slotIds;
  // 非空は型の要求そのもの（Placement.slotIds は NonEmptyArray）。確立の関門は isNonEmpty ただ一つ。
  if (!isNonEmpty(slotIds)) return null;
  return {
    externalOrderId: candidate.externalOrderId,
    itemIndex: candidate.itemIndex,
    slotIds: slotIds as NonEmptyArray<SlotId>,
    startAt: candidate.startAt as EpochMillis,
    serveAt: candidate.serveAt as EpochMillis,
  };
}

/** 有限な整数か。NaN / Infinity / 非数値はすべて偽（比較をすり抜ける値を先に断つ）。 */
function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * SlotRelease — 各 slot の最早解放時刻。index は slot 番号（domain の slotOf と同一規約）。
 *
 * 長さは slotCount（unitCount × SLOTS_PER_UNIT）。表の外にある slot 番号は存在しない釜であり、
 * 計画は決してそこへ置かない（表の長さが「置ける場所」の全体を語る）。
 */
export type SlotRelease = readonly EpochMillis[];

/**
 * 開始済み Timer の占有から解放表を作る（ハード制約「同一 slot の時間帯を重複させない」を所与として
 * 織り込む唯一の経路）。
 *
 * 各 slot の最早解放時刻は、その slot を占める Timer の実効 endTime（adjustedEndTime）と now の大きいほう。
 * 空き slot は now。
 *
 * **boiled に分岐を書かない。** boiled（boiledAt 非 null）の実効 endTime は定義上過去なので、同じ式が
 * 当該 slot を「今すぐ空いている」と扱う。湯切りで麺が釜から上がるため釜は空いており、Complete は
 * UI 上の確認であって釜の占有ではない——この事実が式ひとつで表せることが、扱いの正しさの証である。
 *
 * **下限は now に置く。** 過去の解放時刻は「今すぐ空いている」と同義だが、表を now から先の値に揃えると
 * 「過去に開始しない」という事実の置き場所が 1 箇所に定まる。解放表を受け取る baselineSchedule は now を
 * 引数に取らない（受け取る必要がない）ため、now を知るこの関数だけがその下限を立てられる。
 */
export function initialRelease(
  running: readonly Timer[],
  now: EpochMillis,
  slotCount: number,
): SlotRelease {
  // slot 側から引く（Timer 側から書き込まない）。表の外を指す slot——設定の unitCount より大きい番号や
  // 非数値の slotId——はどの index にも一致しないため、範囲検査を書かずに構造で落ちる。
  return Array.from({ length: Math.max(0, slotCount) }, (_unused, slot) => {
    let free = now;
    for (const timer of running) {
      if (!occupies(timer.slotIds, slot)) continue;
      // 最も遅い一本で決まる。engine は開始時に slot の占有を検査しない（start.ts の拒否事由に無い）ため、
      // 同一 slot を複数 Timer が占める状態は表現可能である。その釜が空くのは最後の一本が上がった時。
      const end = adjustedEndTime(timer);
      if (end > free) free = end;
    }
    return free;
  });
}

/**
 * 確定した配置列で解放表を進める（合成の尾部再実行と、貪欲法が次の Table_Group へ渡す表の更新に用いる）。
 *
 * 各 Placement が占めるのは startAt から serveAt まで——麺を上げた時点でその釜は次の茹でに使える。
 * 入力の表は破壊せず新しい表を返す（純粋変換であることを呼び出し側が確かめずに済む）。
 * 解放時刻は後退させない（最大を採る）。表は「この先いつ空くか」の単調に進む記録である。
 */
export function advanceRelease(
  release: SlotRelease,
  placements: readonly Placement[],
): SlotRelease {
  return release.map((current, slot) => {
    let free = current;
    for (const placement of placements) {
      if (!occupies(placement.slotIds, slot)) continue;
      if (placement.serveAt > free) free = placement.serveAt;
    }
    return free;
  });
}

/** slotIds が当該 slot 番号を含むか。slotId → 番号の写像は domain の slotOf ただ一つ。 */
function occupies(slotIds: NonEmptyArray<SlotId>, slot: number): boolean {
  return slotIds.some((slotId) => slotOf(slotId) === slot);
}

/**
 * PLAN_TARGET_LIMIT — 1 回の計算が扱う計画対象の上限（AC 11.2）。
 *
 * 待ち行列はこれを超えて保持・表示されるが、計画には現れず Cook_Recommendation の対象にもならない。
 * 上限は計算量の天井を確定値にするために置く（n ≤ 64・m ≤ 24 で貪欲法が定数上限に収まる）。
 */
export const PLAN_TARGET_LIMIT = 64;

/**
 * 茹で時間を解決した計画対象。配置の計算に要る一切がここに揃う。
 *
 * boilMillis は startAt と serveAt を結ぶ唯一の値である。PendingOrder はこれを持たない
 * （noodleType × firmness からの導出値ゆえ・domain/order.ts）ので、配置の直前に一度だけ解決する。
 */
interface Boiling {
  readonly order: PendingOrder;
  /** 茹で時間（ミリ秒）。serveAt = startAt + boilMillis。 */
  readonly boilMillis: number;
}

/** Table_Group ＝ 提供時刻を揃える単位。tableId を持たない品目はその品目だけの単独グループになる。 */
interface TableGroup {
  readonly tableKey: string;
  readonly items: readonly PendingOrder[];
}

/**
 * baselineSchedule — 計画対象へ順序・slot・開始時刻を割り当てる決定的な貪欲法（要件4.1〜4.5）。
 *
 * 常に feasible（Requirement 3 のハード制約充足）。pending が空なら空の計画を返す。
 * 採点を呼ばない——採点は比較の時点（Acceptance_Gate）の関心事で、配置の関心事ではない。この関数は
 * 「配置を決める」だけである（lift-group-planning 判断 7）。
 *
 * **卓の成員表を引数に取る。** 同じ卓の走行中 Timer の提供時刻（project.ts の tableMembers）で、その最大が
 * 群の錨になる。解放表（「その釜がいつ空くか」）と同じ資格の第二の表（「その卓がいつ上がるか」）であり、
 * 配置は Timer ではなく表だけを読む。
 *
 * **解放表を引数に取る。** 「途中まで確定した配置の続きを埋める」用途（committedSchedule の尾部再実行）に
 * そのまま使えることが、合成後の計画が構成から feasible であることの根拠になる。全体の自前解は
 * initialRelease(running, now, slotCount) を渡した場合である。now を引数に取らないのは、
 * 「過去に開始しない」という事実の置き場所が解放表ただ一つであるため（initialRelease が下限を now に置く）。
 *
 * **麺プリセットを引数に取る（design の署名からの追加）。** serveAt = startAt + 茹で時間 だが、茹で時間は
 * PendingOrder にも ScheduleParams にも無い。採点は serveAt が済んだ後の話ゆえ茹で時間を要さず、
 * 要るのは計画の算出側だけである。ゆえに ScheduleParams へ混ぜず独立した引数で受ける。
 * **関数（(noodleType, firmness) => number）ではなく値（NoodlePreset の列）を採る。** 理由は 2 つ。
 * (1) この関数は決定的であることを要件が求める（AC 4.3）。引き当てを閉じた関数で受けると、任意の計算が
 * 署名から見えない形で入り込み、決定性が署名から読めなくなる。値は不活性で、整列も比較もできる。
 * (2) toPendingOrders（domain/order.ts）が同じ判断のために同じ型を受けている前例がある。
 * StoreConfig 全体は渡さない——重み・許容幅・レイアウト以外の設定まで engine が引き連れることになる。
 */
export function baselineSchedule(
  pending: readonly PendingOrder[],
  release: SlotRelease,
  members: TableMembers,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): CookSchedule {
  const slices: PlanSlice[] = [];
  let free = release;
  for (const group of tableGroups(planTargets(pending))) {
    // 走行中の錨＝同じ卓の走行中の仲間の提供時刻の最大（表の値は昇順ゆえ末尾）。卓なしの単独キーは
    // NUL 始まりで非空の tableId と一致しないため、表に当たらない（条件を書かない・ADR-0003）。
    const siblings = members.get(group.tableKey) ?? null;
    const placements = placeGroup(group.items, free, siblings, presets, params);
    // 1 品目も置けなかったグループは PlanSlice を成さない（空の一片は採用/棄却の対象にならない）。
    if (placements.length === 0) continue;
    slices.push({ tableKey: group.tableKey, placements });
    free = advanceRelease(free, placements);
  }
  return { slices };
}

/**
 * 計画対象＝正準順序（arrivalTime 昇順, externalOrderId 昇順, itemIndex 昇順）の先頭 PLAN_TARGET_LIMIT 件。
 *
 * 正準順序へ整列してから走らせることが、列挙順に依存しない（AC 4.3）ことの根拠である。
 * 文字列の比較は符号単位順（`<`）で行う。localeCompare は環境の locale に依存し、同じ入力から
 * 違う計画が出る余地を作る——決定性を要求する計算に、環境という隠れた入力を混ぜない。
 *
 * **切り捨ては茹で時間の解決より先に行う。** 計画対象を「到着順の先頭 64 件」と設定から独立に定めることで、
 * 麺プリセットの差し替えが計画対象の範囲を動かさない（指紋計算が同じ範囲を指せる）。
 *
 * **公開する。** 「何が計画対象か」は baselineSchedule の内部事情ではなく、陳腐化判定（isStale）と
 * 確定計画の合成（commit.ts）が同じ範囲を指すために要る共有の語彙である。範囲の定義が二箇所にあれば、
 * 上限 64 件の境界で計画と判定が食い違う。
 */
export function planTargets(pending: readonly PendingOrder[]): readonly PendingOrder[] {
  return [...pending].sort(byCanonicalOrder).slice(0, PLAN_TARGET_LIMIT);
}

/**
 * isStale — 採用済みの一片が現在の計画対象と食い違っているか（design の陳腐化A・陳腐化B）。
 *
 * 2 つの判定は一つの集合比較に畳める。
 *   (a) 陳腐化A — 一片の対象品目が現在も計画対象の Pending_Order に在る
 *   (b) 陳腐化B — 一片の Table_Group に計画が知らない新着が加わっていない
 * ⟺ **一片の品目集合が、計画対象のうち同じ Table_Group の品目集合と一致する。** 片方向で足りないのは
 * (a) が「一片 ⊆ 計画対象」、(b) が「計画対象 ⊆ 一片」を言っているためで、両方向＝一致である。
 *
 * `commit.ts`（確定計画の合成）と `admit.ts`（Acceptance_Gate の段 1）が同じ述語を用いる。判定を二箇所に
 * 書けば、採用の基準と維持の基準が黙ってずれる。置き場所をここにするのは、PlanSlice・計画対象・Table_Group
 * 識別子のいずれもこのモジュールが定めているためである（tableKeyOf を公開せずに済む）。
 *
 * **`startAt < now`（過去開始）はここに含めない。** それは「人が推奨時刻に開始しなかった」という時間の事実で、
 * 計画対象との食い違いではない。合成側（commit.ts）の関心事として分ける。Acceptance_Gate の側では
 * ハード制約 (c) が独立に落とす——解放表の下限が now ゆえ、過去に始まる配置は feasibility を満たさない。
 *
 * targets は計画対象（planTargets の出力）を渡す。全 Pending_Order を渡して内部で切り直すと、一片ごとに
 * 同じ整列を繰り返すうえ、呼び出し側が既に持っている範囲と別の範囲を指す余地が生まれる。
 */
export function isStale(slice: PlanSlice, targets: readonly PendingOrder[]): boolean {
  // 品目を持たない一片は採用/棄却の単位になり得ない（baselineSchedule も空の一片を作らない）。
  if (slice.placements.length === 0) return true;

  const group = targets.filter((order) => tableKeyOf(order) === slice.tableKey);
  // 本数が違えば集合は一致しない。以降の走査で「計画対象 ⊆ 一片」だけを見れば足りる形にする
  // （本数が等しく計画対象を覆うなら、一片の側に余りも重複も残らない）。
  if (group.length !== slice.placements.length) return true;
  // 品目が在るだけでなく、配置がその品目の**現在の** slotSpan を満たしていること。採用済み一片は
  // 採用時の slotSpan の上に組まれており、品目が同じでも要る釜数が変われば（v9 の採用済み計画は
  // slotSpan を読まずに 1 釜で組まれている・サイズ変更の再送）配置はもうその品目の計画ではない。
  return group.some((order) => {
    const placement = slice.placements.find((candidate) => refersTo(candidate, order));
    return placement === undefined || !occupiesSlotSpan(placement, order);
  });
}

/**
 * 一片が走行中の錨を守っているか（ハード制約 (e)・判断 16 / 17・ADR-0007）。守るとは 2 つ——
 *   1. **合流分は錨に一致する**：錨以下に提供する配置は、ちょうど錨に提供する（錨より手前に散らさない）。
 *   2. **押し出さない**：合流できた品目を錨より後ろへ置かない（isPushedOut）。
 *
 * Acceptance_Gate（admit.ts）と確定計画の合成（commit.ts）が同じ述語を読む。合成が読むのは、採用済み一片が
 * 採用時の錨の上に組まれているためである——錨は Boil_Sync で動く（無関係な Timer が仲間の窓の内側で始まると
 * 仲間の adjustment が変わる）。錨が +Δ 動けば合流分は錨より手前になり（1 が破れる）、−Δ 動けば合流分は
 * 錨より後ろになって、まだ合流できるなら押し出し（2 が破れる）、もう届かないなら正当な後続の batch になる。
 * どちらも導出だけで判定でき、採用時の錨を持たなくてよい。
 *
 * **合流する部分集合を外部解に強制しない。** 残り容量が 1 品分で自前解が A を選んでも、外部解が B を合流させ
 * A を後ろに置く一片は、A が B の後では合流できない（isPushedOut が偽）ので守っている。強制するのは「合流した
 * ものは錨に一致」と「合流できるものを押し出さない」だけで、どれを合流させるかは外部の自由（ADR-0007）。
 */
export function keepsAnchor(
  placements: readonly Placement[],
  release: SlotRelease,
  siblings: readonly EpochMillis[],
  targets: readonly PendingOrder[],
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): boolean {
  // 1. 走行中の最早より h_i を超えて手前に散らさない（走行中より先に上げる配置は合流でも後続でもない）。
  const earliestSibling = siblings[0]!;
  const scattered = placements.some((placement) => {
    const order = targets.find((candidate) => refersTo(placement, candidate));
    const boilMillis = order === undefined ? null : boilMillisOf(order, presets);
    const window = boilMillis === null ? 0 : joinWindowMillis(boilMillis, params);
    return placement.serveAt < earliestSibling - window;
  });
  if (scattered) return false;
  return !isPushedOut(placements, release, siblings, targets, presets, params);
}

/**
 * 配置が合流している走行中の提供時刻（錨）——走行中の仲間のうち `|serveAt − A| ≤ h_i` を満たす最も近いもの
 * （判断 18）。無ければ null（合流していない）。合成（isPushedOut）と推奨の射影（recommend の `anchor`）が
 * 同じ判定を読む。
 */
export function joinedAnchor(
  placement: Placement,
  siblings: readonly EpochMillis[],
  boilMillis: number,
  params: ScheduleParams,
): EpochMillis | null {
  const window = joinWindowMillis(boilMillis, params);
  // 走行中のうち serveAt から h_i 以内（前後どちらでも）に在る最も近いもの。
  let anchor: EpochMillis | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const end of siblings) {
    const gap = Math.abs(end - placement.serveAt);
    if (gap <= window && gap < distance) {
      anchor = end;
      distance = gap;
    }
  }
  return anchor;
}

/**
 * 走行中の錨に合流できたのに、錨より後ろへ押し出された配置が在るか（ハード制約 (e)・判断 16・ADR-0007）。
 *
 * 「始めたまとまりを崩さない」は目的関数では守れない——卓同期項は最遅からの遅れの和なので、合流できない 1 本が
 * 在るとき「合流できる品目まで全員を最後へ遅らせる」配置の方が点が良く（合流分の遅れが消える）、ソフトに
 * 置けば外部解がその形で自前解を上書きする。ゆえに feasibility の側に置く。主張は「揃えたい」という好みでは
 * なく「始めたまとまりを崩す計画は成立していない」という構造のもの。
 *
 * 判定：合流分（錨 ≤ serveAt ≤ 錨 + h_i）だけで解放表を進めた上で、合流していない各配置について、その品目の
 * `slotSpan` 個の釜が「錨 + h_i − 茹で時間」までに空いていたなら押し出しである（窓は判断 18）。自前解はこの述語を構成から満たす
 * （joinable の貪欲が拒んだ品目は、合流分を置いた後の表でも間に合わない——対応づけは間に合う集合が在れば
 * 必ず間に合わせる形で、集合が増えるほど間に合いにくくなるだけ）。錨が過去（走行中が boiled だけ）なら
 * 「錨 − 茹で時間」までに空く釜は無く、何も押し出しにならない。
 *
 * `release` は当該一片を置く前の解放表（計画順に進めた表）。Acceptance_Gate と自前解の性質検査が共用する。
 */
export function isPushedOut(
  placements: readonly Placement[],
  release: SlotRelease,
  siblings: readonly EpochMillis[],
  targets: readonly PendingOrder[],
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): boolean {
  const latest = siblings[siblings.length - 1]!;
  const withBoil = placements.map((placement) => {
    const order = targets.find((candidate) => refersTo(placement, candidate));
    const boilMillis = order === undefined ? null : boilMillisOf(order, presets);
    return { placement, order, boilMillis };
  });
  // 合流分（いずれかの走行中に h_i 以内で続く配置）だけで解放表を進める。茹で時間が引けない配置は合流と見なさない。
  const joined = withBoil.filter(
    ({ placement, boilMillis }) =>
      boilMillis !== null && joinedAnchor(placement, siblings, boilMillis, params) !== null,
  );
  const joinedTable = advanceRelease(
    release,
    joined.map(({ placement }) => placement),
  );
  return withBoil.some(({ placement, order, boilMillis }) => {
    if (order === undefined || boilMillis === null) return false;
    if (joinedAnchor(placement, siblings, boilMillis, params) !== null) return false;
    if (placement.serveAt < siblings[0]!) return false; // 手前の配置は keepsAnchor の 1 が見る
    // 最遅の走行中にも間に合わない位置に置かれたが、間に合う釜が空いていたなら押し出し。
    const deadline = latest + joinWindowMillis(boilMillis, params) - boilMillis;
    const available = joinedTable.filter((at) => at <= deadline).length;
    return available >= order.slotSpan;
  });
}

/**
 * 配置が当該品目の slotSpan を満たしているか——`slotIds` の本数が `slotSpan` に等しく、かつ釜が相異なる
 * （lift-group-planning AC 4.2）。
 *
 * 相異なるかは **釜番号（slotOf）** で比べる。文字列で比べると `["0","00"]` が別の釜に見えるが、解放表を
 * 引く側は両方を釜 0 に写すので、1 釜しか空いていない釜に 2 釜の品目が置ける穴になる。
 * Acceptance_Gate（admit.ts）と確定計画の合成（commit.ts・isStale 経由）が同じ述語を読む。
 */
export function occupiesSlotSpan(placement: Placement, order: PendingOrder): boolean {
  if (placement.slotIds.length !== order.slotSpan) return false;
  return new Set(placement.slotIds.map(slotOf)).size === placement.slotIds.length;
}

/**
 * 配置が当該 Pending_Order を指しているか。品目の同一性は (externalOrderId, itemIndex) の組で決まる。
 *
 * 公開するのは、確定計画の合成（commit.ts）が「接頭辞が既に置いた品目を計画対象から除く」ために同じ
 * 同一性を要するためである。組の突き合わせを二箇所に書けば、品目を指す規則が二つになる。
 */
export function refersTo(placement: Placement, order: PendingOrder): boolean {
  return (
    placement.externalOrderId === order.externalOrderId && placement.itemIndex === order.itemIndex
  );
}

/** 正準順序の比較。arrivalTime → externalOrderId → itemIndex。 */
function byCanonicalOrder(order: PendingOrder, other: PendingOrder): number {
  if (order.arrivalTime !== other.arrivalTime) return order.arrivalTime - other.arrivalTime;
  if (order.externalOrderId !== other.externalOrderId)
    return order.externalOrderId < other.externalOrderId ? -1 : 1;
  return order.itemIndex - other.itemIndex;
}

/**
 * 計画対象を Table_Group へまとめ、（最早 arrivalTime, 識別子）順に並べる。
 *
 * **境界で Table_Group が割れる場合、計画対象に入った品目だけでグループを成す**（AC 11.2）。
 * 残りは次の再計算で先頭が減ったときに同じ Table_Group へ合流する。ソフト制約の評価も対象品目の間だけで
 * 閉じる——これは scoreSchedule が PlanSlice の内側だけを見ることから自動的に従う。
 */
function tableGroups(targets: readonly PendingOrder[]): readonly TableGroup[] {
  const grouped = new Map<string, PendingOrder[]>();
  for (const order of targets) {
    const key = tableKeyOf(order);
    const items = grouped.get(key);
    if (items === undefined) grouped.set(key, [order]);
    else items.push(order);
  }
  // targets は正準順序ゆえ items[0] が当該グループの最早到着である。
  return [...grouped]
    .map(([tableKey, items]) => ({ tableKey, items }))
    .sort(
      (group, other) =>
        group.items[0]!.arrivalTime - other.items[0]!.arrivalTime ||
        (group.tableKey < other.tableKey ? -1 : 1),
    );
}

/**
 * Table_Group の識別子。tableId を持たない品目は「その品目だけの単独グループ」へ写す。
 *
 * 単独キーの区切りに NUL を使う。tableId は任意の非空文字列を採れるため、単独キーが本物の卓 id と
 * 衝突すれば、卓に紐づかない品目が黙って一つの卓へ束ねられる（objective.ts の品目鍵と同じ規律）。
 */
function tableKeyOf(order: PendingOrder): string {
  return order.tableId ?? `\u0000${order.externalOrderId}\u0000${order.itemIndex}`;
}

/**
 * 1 つの Table_Group を配置する。
 *
 * **茹で時間が引けない品目は配置しない。** 未知の noodleType は Order_Ingress では弾かれる
 * （toPendingOrders が presets と突き合わせる）が、永続した待ち行列が設定の差し替えを跨いだ後には
 * 起こり得る——プリセットから消えた麺種の品目が残る経路が実在する。そのとき既定の茹で時間を当てれば
 * 「その秒数で茹でれば良い」という嘘の計画ができる。ゆえに置かない。品目は待ち行列に残って表示され、
 * 推奨だけが付かない（計画対象を超えた品目と同じ扱い）。
 *
 * **釜容量を超える品目は同時に置けない。** 容量は本数ではなく slotSpan の合計で数える（大盛は 2 釜）。
 * 大人数の卓が容量を超えることは表現可能ゆえ、正準順序のまま容量に収まる分ずつ batch に分けて順に置く
 * （batch の跨ぎで生じる提供時刻の開きは卓の遅れとして計上されるだけで、feasibility は保つ）。
 * 1 品目が単独で容量を超えることは無い——slotSpan ≤ SLOT_SPAN_MAX = SLOTS_PER_UNIT ≤ 容量
 * （UNIT_COUNT_MIN = 1）——ので「置けない品目」の分岐を書かない（起こり得ないものに防御を置かない）。
 *
 * **走行中の仲間が在る卓は、その錨に合流できる品目で最初の batch を組む（判断 16・ADR-0007）。** 容量は釜の
 * 総数で数えるため走行中が占める釜も入り、群の 1 本目を始めた直後に残りが一つの batch に収まって、走行中の
 * 釜が空くまで全員が錨ごと後ろへずれる（始めたまとまりを後続品のために崩す）。合流できるとは「slotSpan 個の
 * 相異なる釜すべてが 錨 − 茹で時間 までに空く」こと——いま空いているかではなく、逆算した投入時刻までに
 * 空くか。合流した品目は走行中と同じ serveAt を持ち、残りは従来どおり詰める。走行中が無い卓は一行も変えない
 * （待つことも含めてまとめる・AC 1.8）。
 */
function placeGroup(
  items: readonly PendingOrder[],
  release: SlotRelease,
  siblings: readonly EpochMillis[] | null,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): readonly Placement[] {
  // 残りの batch の錨は走行中の最遅（表の値は昇順ゆえ末尾）。合流の判定は個々の走行中の提供時刻で行う。
  const runningAnchor = siblings === null ? null : siblings[siblings.length - 1]!;
  const boilings = items
    .map((order) => toBoiling(order, presets))
    .filter((boiling): boiling is Boiling => boiling !== null);
  // 同時に置ける幅＝釜の数。解放表の長さが「置ける場所」の全体を語る（表の外に釜は無い）。
  const capacity = release.length;
  if (capacity === 0) return [];

  const placements: Placement[] = [];
  let free = release;
  let remaining = boilings;
  if (siblings !== null) {
    const joined = joinable(boilings, free, siblings, params);
    if (joined.length > 0) {
      // 合流分は品目ごとに「間に合う最早の走行中」へ置く（届くなら一致・届かなければ最早）。
      const placed = placeJoined(joined, free, siblings, params);
      placements.push(...placed);
      free = advanceRelease(free, placed);
      remaining = boilings.filter((boiling) => !joined.includes(boiling));
    }
  }

  let batch: Boiling[] = [];
  let span = 0;
  const flush = () => {
    if (batch.length === 0) return;
    const placed = placeBatch(batch, free, runningAnchor, params);
    placements.push(...placed);
    free = advanceRelease(free, placed);
    batch = [];
    span = 0;
  };
  for (const boiling of remaining) {
    if (span + boiling.order.slotSpan > capacity) flush();
    batch.push(boiling);
    span += boiling.order.slotSpan;
  }
  flush();
  return placements;
}

/**
 * 走行中の錨に合流できる品目。正準順序の貪欲で、先に合流を確定した品目が釜を取った上で次を判定する。
 * 合流の本数を最大化しない——最適な部分集合の選択は外部ソルバの役目で、自前解に要るのは決定性だけ
 * （正準順序と assignSlots の全順序から従う）。
 */
function joinable(
  boilings: readonly Boiling[],
  release: SlotRelease,
  siblings: readonly EpochMillis[],
  params: ScheduleParams,
): readonly Boiling[] {
  const joined: Boiling[] = [];
  for (const boiling of boilings) {
    if (fits([...joined, boiling], release, siblings, params)) joined.push(boiling);
  }
  return joined;
}

/**
 * 合流先——走行中の仲間のうち、品目が間に合う最早の提供時刻（`A ≥ earliest − h_i` を満たす最小の A）。
 * 無ければ null（最遅の仲間にも h_i 以内で届かない＝合流できない）。
 *
 * 最遅（Group_Anchor の max）ではなく最早に揃えるのは、Boil_Sync が arms で走行中を複数の Sync_Set に
 * 分けた後、新しい品目まで最後のセットに揃えれば投入のたびに startAt が未来へずれ続けるからである
 * （実測：arms 1 で 2 本目の後に 3 秒、arms 2 で 3 本目の後に 12 秒）。「同じ投入作業として続ける」なら、
 * いま間に合う最早のセットに乗るのが自然で、届かない分は最早に置いて Boil_Sync に委ねる（判断 18）。
 */
function catchable(
  earliest: number,
  siblings: readonly EpochMillis[],
  boilMillis: number,
  params: ScheduleParams,
): EpochMillis | null {
  const window = joinWindowMillis(boilMillis, params);
  return siblings.find((end) => end >= earliest - window) ?? null;
}

/**
 * 合流した品目の提供時刻。
 *   - いずれかの走行中の提供時刻が earliest から h_i 以内（前後どちらでも）に在れば **earliest**——待たずに
 *     いま始める。数秒の差は Boil_Sync の範囲であり、揃えるために待てば投入のたびに startAt が未来へずれる
 *     （実測：3 本目で Boil_Sync が新しい仲間を別のセットへ 6 秒遅らせ、残りがそれを追いかけた）。
 *   - そうでなければ、earliest より後の最早の走行中に揃える（短い茹での品目が仲間を待って一緒に上がる）。
 *   - どちらも無ければ null（最遅の仲間にも h_i 以内で届かない＝合流できない）。
 */
function joinedServeAt(
  earliest: number,
  siblings: readonly EpochMillis[],
  boilMillis: number,
  params: ScheduleParams,
): EpochMillis | null {
  const window = joinWindowMillis(boilMillis, params);
  if (siblings.some((end) => Math.abs(end - earliest) <= window)) return earliest as EpochMillis;
  return siblings.find((end) => end > earliest) ?? null;
}

/**
 * 合流した品目群を置く。各品目の serveAt は max(錨, earliest)——錨に届く品目は錨に一致し、窓の内側で届かない
 * 品目は最早に置く（判断 18）。錨に届く品目を届かない品目の earliest まで遅らせない（placeBatch の
 * 「全員を max(earliest) に揃える」を合流分には使わない——揃える相手は走行中の錨である）。
 */
function placeJoined(
  batch: readonly Boiling[],
  release: SlotRelease,
  siblings: readonly EpochMillis[],
  params: ScheduleParams,
): readonly Placement[] {
  const { slotsOfItem, earliest } = assignSlots(batch, release, params);
  return batch.map((boiling, index) => {
    // fits が全員の合流先の存在を確かめているので、ここで null は起こらない（起こらないものに防御を置かない）。
    const serveAt = joinedServeAt(earliest[index]!, siblings, boiling.boilMillis, params)!;
    const [head, ...tail] = slotsOfItem[index]!;
    const slotIds: NonEmptyArray<SlotId> = [
      String(head!) as SlotId,
      ...tail.map((slot) => String(slot) as SlotId),
    ];
    return {
      externalOrderId: boiling.order.externalOrderId,
      itemIndex: boiling.order.itemIndex,
      slotIds,
      startAt: (serveAt - boiling.boilMillis) as EpochMillis,
      serveAt,
    };
  });
}

/**
 * 品目群が全員、錨に間に合うか——placeBatch と同じ対応づけで各品目の earliest（全釜の解放時刻の最大 +
 * 茹で時間）を出し、すべてが 錨 + h_i 以下であること（合流の窓・判断 18）。「全釜が 錨 + h_i − 茹で時間 までに
 * 空く」と同値。錨 + h_i までの残りより茹で時間が長い品目は、解放表の下限が now ゆえ必ず外れる。
 */
function fits(
  candidate: readonly Boiling[],
  release: SlotRelease,
  siblings: readonly EpochMillis[],
  params: ScheduleParams,
): boolean {
  const totalSpan = candidate.reduce((sum, boiling) => sum + boiling.order.slotSpan, 0);
  if (totalSpan > release.length) return false;
  const { earliest } = assignSlots(candidate, release, params);
  return candidate.every(
    (boiling, index) => catchable(earliest[index]!, siblings, boiling.boilMillis, params) !== null,
  );
}

/** 茹で時間を解決する。プリセットに無い麺種は解決できない（null）。 */
function toBoiling(order: PendingOrder, presets: readonly NoodlePreset[]): Boiling | null {
  const boilMillis = boilMillisOf(order, presets);
  return boilMillis === null ? null : { order, boilMillis };
}

/**
 * 品目の茹で時間（ミリ秒）。麺種がプリセットに無ければ null。
 *
 * 茹で時間は PendingOrder が持たない導出値（noodleType × firmness）。配置・ゲート・推奨の射影が同じ引き方を
 * 読む唯一の場所（二度書けば二つの真実になる）。
 */
export function boilMillisOf(order: PendingOrder, presets: readonly NoodlePreset[]): number | null {
  const preset = presets.find((candidate) => candidate.noodleType === order.noodleType);
  if (preset === undefined) return null;
  return preset.boilSeconds[order.firmness] * 1000;
}

/**
 * 合流の窓 h_i（ミリ秒）——茹で時間 × toleranceRatio / 100（lift-group-planning 判断 18・ADR-0008）。
 *
 * 走行中の錨に `earliest ≤ 錨 + h_i` で届く品目を「同じ投入作業として続ける」と見なす。Boil_Sync の許容調整
 * 割合と同じ既存の品質許容幅であって新しい設定ではないが、**Boil_Sync が同時に揃える保証ではない**——あちらは
 * 個々の基底 endTime から窓を作り、共通部分と arms のセット分割を見る。計画の群と Sync_Set は別の概念である。
 */
export function joinWindowMillis(boilMillis: number, params: ScheduleParams): number {
  return Math.floor((boilMillis * params.toleranceRatio) / 100);
}

/**
 * 同時に置ける品目群（Σ slotSpan ≤ 釜の数）を配置し、提供時刻を群の錨に一致させる。
 *
 * **提供時刻の錨（Group_Anchor）は max(全員の earliest, 走行中の錨)。** earliest は「その品目の全釜の解放時刻の
 * 最大 + 茹で時間」で、各品目を最も早く始めたときの提供時刻。解放時刻そのものを錨に採ると茹で時間の分だけ
 * 手前に開始を逆算して釜が空く前に始める配置が生まれるため、錨は「解放 + 茹で」の側に置く。こうすると
 * 各品目の提供時刻は自分の全釜の解放時刻 + 茹で時間 以上に必ずなり、**逆算した開始時刻が解放時刻を下回る
 * 余地が構成から消える**（下限のクランプを書く必要がない・起こり得ないものに防御を置かない）。
 *
 * **錨へ厳密に一致させる。** 許容幅の内側に散らす形（かつての tableFloor / orderFloor）は採らない。目的関数の
 * 卓同期項が「最遅からの遅れの和 × w_table」であり、w_table ≥ 2 の下では全員を錨に置く配置がその式の
 * 唯一の最適点である——揃えることは制約でも保証でもなく採点の帰結で、この関数はその最適点を直接置く
 * （lift-group-planning 判断 5・ADR-0001）。走行中の錨に届かない品目があれば群ごと錨より後ろへずれ、
 * 走行中との差は卓の遅れとして計上されるだけで feasibility の否定事由にはしない。錨は batch ごとに取り直す
 * （batch 2 の earliest は進めた解放表から出る）。
 *
 * **釜の割当は決定的である。** 長い茹でに早く空く釜を与える（1 品目 1 釜では錨を最小にする対応づけだった）。
 * slotSpan が混在すると最小性は言えないが、要るのは決定性だけで、それは byRelease / byBoil の全順序
 * （同点を index で断つ）から従う。厳密解の供給は外部ソルバの役目である。
 */
function placeBatch(
  batch: readonly Boiling[],
  release: SlotRelease,
  runningAnchor: EpochMillis | null,
  params: ScheduleParams,
): readonly Placement[] {
  const { slotsOfItem, earliest } = assignSlots(batch, release, params);
  const anchor = Math.max(...earliest, runningAnchor ?? Number.NEGATIVE_INFINITY);

  return batch.map((boiling, index) => {
    // slotId はスロット番号の文字列表現（domain の slotOf = Number(slotId) の逆・要件12.5）。
    // 非空は構成から従う（slotSpan ≥ 1・domain の SLOT_SPAN_MIN）ので先頭と残りに分けて型へ載せる。
    const [head, ...tail] = slotsOfItem[index]!;
    const slotIds: NonEmptyArray<SlotId> = [
      String(head!) as SlotId,
      ...tail.map((slot) => String(slot) as SlotId),
    ];
    return {
      externalOrderId: boiling.order.externalOrderId,
      itemIndex: boiling.order.itemIndex,
      slotIds,
      startAt: (anchor - boiling.boilMillis) as EpochMillis,
      serveAt: anchor as EpochMillis,
    };
  });
}

/**
 * 品目群への釜の対応づけと、各品目の earliest（全釜の解放時刻の最大 + 茹で時間）。
 *
 * placeBatch（配置）と fits（合流の判定）が**同じ対応づけ**を読む唯一の場所。二箇所に書けば「合流できる」と
 * 判定した品目が、置くときには別の釜を取って錨に届かない、という食い違いが生まれる。
 *
 * 長い茹でから順に、早く空く釜を slotSpan 個ずつ連続した塊で配る（1 品目 1 釜では錨を最小にする対応づけ
 * だった。slotSpan が混在すると最小性は言えないが、要るのは決定性だけで、byRelease / byBoil の全順序——
 * 同点を index で断つ——から従う）。
 */
function assignSlots(
  batch: readonly Boiling[],
  release: SlotRelease,
  params: ScheduleParams,
): { readonly slotsOfItem: readonly (readonly number[])[]; readonly earliest: readonly number[] } {
  const totalSpan = batch.reduce((sum, boiling) => sum + boiling.order.slotSpan, 0);
  const slots = chooseSlots(totalSpan, release, params);
  const byRelease = [...slots].sort(
    (slot, other) => release[slot]! - release[other]! || slot - other,
  );
  const byBoil = batch
    .map((_unused, index) => index)
    .sort((index, other) => batch[other]!.boilMillis - batch[index]!.boilMillis || index - other);
  const slotsOfItem: (readonly number[])[] = new Array(batch.length);
  let cursor = 0;
  for (const index of byBoil) {
    const span = batch[index]!.order.slotSpan;
    slotsOfItem[index] = byRelease.slice(cursor, cursor + span);
    cursor += span;
  }
  const earliest = batch.map(
    (boiling, index) =>
      Math.max(...slotsOfItem[index]!.map((slot) => release[slot]!)) + boiling.boilMillis,
  );
  return { slotsOfItem, earliest };
}

/**
 * count 本の釜を選ぶ。**「count 本すべてが空く最早時刻」が最小になる組**が第一の基準（design のアルゴリズム 2）。
 *
 * その最早時刻は解放時刻の count 番目に小さい値で、候補はそれ以下に空く釜の全体である。候補が count 本より
 * 多い（＝同点が余る）ときだけ Slot_Affinity が選ぶ余地を持ち、**グループ内の全ペア距離和が最小**の組を採る。
 * 全部分集合の走査は組み合わせ爆発ゆえ、各候補を起点に近い順で count 本取る形に絞る（貪欲法の内側であり、
 * ここに厳密最適は要らない——厳密解の供給は外部ソルバーの役目である）。
 *
 * 同点は slot index 昇順で断つ。初期値を候補の先頭 count 本（index 昇順で最小の組）に置き、距離和が
 * **真に小さい**組でしか置き換えないため、同点は常に index の小さい組が残る。
 *
 * count ≤ release.length を前提とする（呼び出し側が釜の数で分割している）。
 */
function chooseSlots(
  count: number,
  release: SlotRelease,
  params: ScheduleParams,
): readonly number[] {
  const byRelease = release
    .map((_unused, slot) => slot)
    .sort((slot, other) => release[slot]! - release[other]! || slot - other);
  const earliestAllFree = release[byRelease[count - 1]!]!;
  const candidates = byRelease
    .filter((slot) => release[slot]! <= earliestAllFree)
    .sort((slot, other) => slot - other);

  let best = candidates.slice(0, count);
  if (candidates.length === count) return best;

  let bestDistance = pairwiseDistance(best, params);
  for (const anchor of candidates) {
    const near = [...candidates]
      .sort(
        (slot, other) =>
          distanceBetween(anchor, slot, params) - distanceBetween(anchor, other, params) ||
          slot - other,
      )
      .slice(0, count)
      .sort((slot, other) => slot - other);
    const distance = pairwiseDistance(near, params);
    if (distance < bestDistance) {
      best = near;
      bestDistance = distance;
    }
  }
  return best;
}

/** 組の全ペア距離和。Slot_Affinity の評価軸（objective.ts の affinity 項と同じ全ペア和）。 */
function pairwiseDistance(slots: readonly number[], params: ScheduleParams): number {
  let total = 0;
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      total += distanceBetween(slots[i]!, slots[j]!, params);
    }
  }
  return total;
}

/** slot 間距離。尺度の正本は objective.ts の slotDistance ただ一つ（距離を二度定義しない）。 */
function distanceBetween(slot: number, other: number, params: ScheduleParams): number {
  return slotDistance(slot, other, params.unitOrigins, params.slotOffsets);
}
