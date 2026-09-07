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
import { adjustedEndTime, tableKeyOf, type TableMembers } from "./project";
import { scoreSchedule, type ScheduleParams } from "./objective";
import {
  advanceLifts,
  firstFit,
  liftCap,
  liftOverflow,
  liftsOf,
  loadWith,
  withinLiftCap,
  type LiftTable,
} from "./lift";
import { isNonEmpty, type NonEmptyArray } from "../domain/timer";
import {
  compareArrival,
  itemKeyOf,
  liveOrders,
  type ItemKey,
  type PendingOrder,
} from "../domain/order";
import { slotDistance, slotOf, type NoodlePreset } from "../domain/store";
import { boilMillisOf, joinWindowMillis } from "./boil";
import {
  partialChangeCost,
  shownHeadsOf,
  type ChangeContext,
  type ShownItem,
  type ShownPlan,
} from "./stability";

// 茹で時間と合流の窓の導出は boil.ts に在る（変更費用が同じ導出を読むため）。読む側の入口はここのまま。
export { boilMillisOf, joinWindowMillis } from "./boil";
// Table_Group の識別子は project.ts に在る（成員表の鍵と同じ規則・変更費用と復元が同じ鍵を読むため）。入口は同じくここ。
export { tableKeyOf } from "./project";

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
  /**
   * 合流先の走行中の実効 endTime（錨）。合流でなければ null。
   *
   * **配置の時点で決めて以後変えない**（lift-group-planning AC 9.9・判断 20）。上げ窓が `serveAt` を錨より後ろへ
   * 動かしても（21.5）、群の所属は合流の判定で決まった事実であって時刻からは逆算できなくなる。ゆえに
   * `serveAt` と錨の近さ（±h_i）から推定する形（旧 `joinedAnchor` を読む `recommend`）をやめ、配置が持つ。
   * 外部計画も主張する（`toPlacement`）。ゲートと合成は `keepsAnchor` がこの主張を pack の単位で検証する（AC 9.10）。
   */
  readonly anchor: EpochMillis | null;
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

/**
 * 生値を 1 配置へ写す。対象品目・釜・開始と提供の時刻・錨の主張のいずれかが不正なら null。
 *
 * **`anchor` は明示の主張を要る（null か整数）。** 欠如を「合流していない」と読み替えれば、契約を知らない
 * 外部解が黙って合流無しの計画として通る。合流の所属は配置の事実であり（AC 9.9）、主張しない計画は形を
 * 満たしていない。主張の真偽（現在の走行中の仲間の実効 endTime に等しいか）はここでは見ない——`admit` の
 * ハード制約 (e)（`keepsAnchor`）が pack の単位で検証する（AC 9.10）。
 */
function toPlacement(value: unknown): Placement | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  // 品目を指す組の妥当性は domain/order.ts の PendingOrder と同じ（非空 id と 0 以上の整数連番）。
  if (typeof candidate.externalOrderId !== "string" || candidate.externalOrderId.length === 0)
    return null;
  if (!isInteger(candidate.itemIndex) || candidate.itemIndex < 0) return null;
  if (!isInteger(candidate.startAt) || !isInteger(candidate.serveAt)) return null;
  if (candidate.anchor !== null && !isInteger(candidate.anchor)) return null;
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
    anchor: candidate.anchor === null ? null : (candidate.anchor as EpochMillis),
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
 * 採点を呼ぶのは候補の選択（保持候補 R と生成候補 F の比較）だけで、配置そのものは採点を呼ばない——採点は比較の
 * 時点の関心事で、配置の関心事ではない（lift-group-planning 判断 7）。
 *
 * **卓の成員表を引数に取る。** 同じ卓の走行中 Timer の提供時刻（project.ts の tableMembers）で、その最大が
 * 群の錨になる。解放表（「その釜がいつ空くか」）と同じ資格の第二の表（「その卓がいつ上がるか」）であり、
 * 配置は Timer ではなく表だけを読む。
 *
 * **解放表を引数に取る。** 「途中まで確定した配置の続きを埋める」用途（committedSchedule の尾部再実行）に
 * そのまま使えることが、合成後の計画が構成から feasible であることの根拠になる。全体の自前解は
 * initialRelease(running, now, slotCount) を渡した場合である。「過去に開始しない」という事実の置き場所は
 * 解放表ただ一つ（initialRelease が下限を now に置く）で、`now` を引数に取るのはそのためではない。
 *
 * **`now` を引数に取る（pending-order-expiry Component 2）。** 計画対象は生きている待ち行列（Live_Orders・
 * `liveOrders(pending, now)`）から組む——期限切れの品目が到着順の先頭を占めて枠（PLAN_TARGET_LIMIT）を食わない
 * ためで、絞るのは `planTargets` ただ一つ。`changeContext.now` と同じ値だが、`changeContext` が null の経路でも
 * 要るので引数にする。解放表の下限とは別の関心事（あちらは「いつから置けるか」、こちらは「何を置くか」）。
 *
 * **上げ表を引数に取る（第三の表・lift-group-planning 判断 20・ADR-0009）。** 店舗全体で「いつ上がるか」——走行中の
 * 実効 endTime と計画済みの serveAt——を並べた表（lift.ts）で、解放表・成員表と同じく毎回導く導出値である。
 * 全体の自前解は initialLifts(running) を渡し、合成の尾部は採用済み一片の上がりで進めた表を渡す（AC 9.14）。
 * 群を跨いで進める——先に置いた卓の上がりが後の卓の置き場所を動かす（窓は店舗全体で数える・AC 9.3）。
 *
 * **麺プリセットを引数に取る（design の署名からの追加）。** serveAt = startAt + 茹で時間 だが、茹で時間は
 * PendingOrder にも ScheduleParams にも無い。採点は serveAt が済んだ後の話ゆえ茹で時間を要さず、
 * 要るのは計画の算出側だけである。ゆえに ScheduleParams へ混ぜず独立した引数で受ける。
 * **関数（(noodleType, firmness) => number）ではなく値（NoodlePreset の列）を採る。** 理由は 2 つ。
 * (1) この関数は決定的であることを要件が求める（AC 4.3）。引き当てを閉じた関数で受けると、任意の計算が
 * 署名から見えない形で入り込み、決定性が署名から読めなくなる。値は不活性で、整列も比較もできる。
 * (2) toPendingOrders（domain/order.ts）が同じ判断のために同じ型を受けている前例がある。
 * StoreConfig 全体は渡さない——重み・許容幅・レイアウト以外の設定まで engine が引き連れることになる。
 *
 * **変更費用の文脈（`changeContext`）を引数に取る（plan-stability Requirement 3・design Component 5）。** 前回配信対象
 * として確定した提案（Shown_Plan）が在れば、釜の選択はその釜を第一候補にし（AC 3.1）、batch の並びの同値は前回の
 * `startAt` 順で断ち、列の pack / split の局所比較に変更費用の差分を足して「前回の配置の再現・まとまり・先頭を保つ分割」を
 * 候補に置く（AC 3.2）。ハード制約（釜の排他・slotSpan・上げ窓・合流の契約）は候補の生成の前に効き、前回より優先する
 * （AC 3.3）。null は比較の相手なし——前回を残す経路は一つも通らず、従来と同じ計画が出る。
 *
 * **保持候補 R と生成候補 F を組み、同じ旧 Shown_Plan に対する総費用で選ぶ（plan-stability Requirement 6・design
 * Component 7・2026-09-07）。** F は文脈つきの生成器（`buildSchedule`）の出力に「今」の配分の loop（`placeNow`）を通した
 * 完成候補。R は旧 Shown_Plan を**再計算せず復元**した計画（`retain`：Live_Orders に在る品目を初出順の一片に組み、過去開始の
 * 「今」を now に置き直し、一片ごとに合成と同じ述語で検証して、不正な一片はその位置でその卓を再生成する）に同じ loop を
 * 通した完成候補。両方を `scoreSchedule`（業務費用 ＋ 変更費用）で同じ旧 Shown_Plan に対して採点し、R ≤ F なら R（同点は
 * 前回）。Shown_Plan が無ければ F だけ。生成器で前回を再現する候補（`Continuity.faithful`）は撤去した——固定・下限・
 * 取り置きの規則を足しても将来の釜・分割・群まで一致する保証にならず、実占有で性質 5.6 が落ちた（判断 9〜12）。
 *
 * **占有（`occupied`）を引数に取る（startable-placement design Component 3′）。** 解放表は「将来いつ空く見込みか」の予測で、
 * 茹で上がった釜（boiled・Complete 待ち）を `now` に空くと扱う。一方「今、開始操作できるか」は対象釜に Timer が無い事実
 * （client の全釜 idle と同じ domain の述語 `occupiedSlotsOf`）で決まる。両者が食い違うと、「今」と提案した先頭が押せない
 * 釜に置かれ、本当に始められる後続まで連鎖で隠れる（観測事実 8）。`occupied` を読むのは「今」の品目への配分（`pinNow`）
 * だけで、将来配置（`startAt > now`）の釜の選択は占有を直接の条件にしない（性質 4.6・判断 10）。
 */
export function baselineSchedule(
  pending: readonly PendingOrder[],
  release: SlotRelease,
  members: TableMembers,
  lifts: LiftTable,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
  now: EpochMillis,
  occupied: ReadonlySet<number>,
  changeContext: ChangeContext | null,
): CookSchedule {
  const { fresh, retained } = scheduleCandidates(
    pending,
    release,
    members,
    lifts,
    presets,
    params,
    now,
    occupied,
    changeContext,
  );
  if (retained === null || changeContext === null) return fresh;
  // 両候補を同じ旧 Shown_Plan（遷移前の状態が持つもの・AC 6.5）に対する総費用で比べる。同点は前回（R）。
  const scoreContext = { members, lifts, change: changeContext };
  const totalOf = (schedule: CookSchedule) =>
    scoreSchedule(schedule.slices, pending, scoreContext, params).total;
  return totalOf(retained) <= totalOf(fresh) ? retained : fresh;
}

/**
 * scheduleCandidates — `baselineSchedule` が比べる 2 候補（生成候補 F と保持候補 R）。R は Shown_Plan が無ければ null。
 *
 * 公開するのは、性質の検査が**選ばれなかった側**も見るためである——完成した R と F の両方が物理的なハード制約を守ること
 * （plan-stability 性質 5.10・startable-placement 性質 4.8）、選ばれた計画の総費用が F 単独より高くならないこと（性質 5.11）は、
 * 選択の結果だけからは読めない。引数は `baselineSchedule` と同じ。
 */
export function scheduleCandidates(
  pending: readonly PendingOrder[],
  release: SlotRelease,
  members: TableMembers,
  lifts: LiftTable,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
  now: EpochMillis,
  occupied: ReadonlySet<number>,
  changeContext: ChangeContext | null,
): { readonly fresh: CookSchedule; readonly retained: CookSchedule | null } {
  const { fresh, retained } = scheduleStages(
    pending,
    release,
    members,
    lifts,
    presets,
    params,
    now,
    occupied,
    changeContext,
  );
  return { fresh: fresh.completed, retained: retained?.completed ?? null };
}

/**
 * 一候補の経過——1 段目（生成 or 復元）・候補 K（`placeNow` が固定を外す場面で組んだ「1 段目の時刻を保ち釜だけ交換した
 * 計画」・その場面が無ければ null）・完成形。性質 4.7′（判断 14）の検査が「K を実際に組んで合法性と総費用を比べる」ために
 * 読む——完成形だけからは、1 段目の「今」が「今」を失った理由（K が違法か、K より総費用が真に低いか）が読めない。
 */
export interface CandidateStages {
  readonly stage1: CookSchedule;
  /** loop を終えた計画（固定を外した再生成を含む）。固定を外す場面が無ければ完成形そのもの。 */
  readonly regenerated: CookSchedule;
  /** 候補 K。固定を外す場面が無ければ null。違法な K もそのまま返す（検査が違法性を見る）。 */
  readonly swap: CookSchedule | null;
  /** 完成形——`regenerated` か、合法で総費用が真に低くない再生成に対して選ばれた `swap`。 */
  readonly completed: CookSchedule;
}

/** `scheduleCandidates` の 2 候補を経過つきで返す。引数は同じ。 */
export function scheduleStages(
  pending: readonly PendingOrder[],
  release: SlotRelease,
  members: TableMembers,
  lifts: LiftTable,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
  now: EpochMillis,
  occupied: ReadonlySet<number>,
  changeContext: ChangeContext | null,
): { readonly fresh: CandidateStages; readonly retained: CandidateStages | null } {
  const planning: Planning = {
    pending,
    targets: placeableTargets(pending, now, presets, params),
    release,
    lifts,
    members,
    occupied,
    presets,
    params,
    now,
    seed: seedOf(changeContext, params),
  };
  const fresh = placeNow(planning, buildSchedule(planning, pending, release, lifts));
  if (planning.seed === null) return { fresh, retained: null };
  return { fresh, retained: placeNow(planning, retain(planning)) };
}

/**
 * Planning — 一度の計画が読む入力の束。`baselineSchedule` の引数と、そこから一度だけ導く置ける品目（`placeableTargets`・
 * plan-stability Requirement 7）・前回を残す文脈の種（`seedOf`）。生成（`buildSchedule`）・復元（`retain`）・配分（`pinNow`）・
 * 検証と再生成（`revalidate`）が同じ束を読む（位置引数の増殖を止める）。
 */
interface Planning {
  readonly pending: readonly PendingOrder[];
  /** 置ける品目（`isStale` と再生成が読む集合・定義は `placeableTargets` ただ一つ）。 */
  readonly targets: readonly PendingOrder[];
  /** 採用済み接頭辞で進めた解放表（合成の尾部）か、走行中から引いた表（全体の自前解）。 */
  readonly release: SlotRelease;
  readonly lifts: LiftTable;
  readonly members: TableMembers;
  /** Timer（running / boiled とも）の載る釜。配分と保持の条件だけが読む。 */
  readonly occupied: ReadonlySet<number>;
  readonly presets: readonly NoodlePreset[];
  readonly params: ScheduleParams;
  readonly now: EpochMillis;
  /** 前回を残す文脈の種。null は比較の相手なし（保持候補 R も組まない）。 */
  readonly seed: Seed | null;
}

/** 前回を残す文脈の種（列ごとの `slices` を除いた Continuity）。null は比較の相手なし。 */
type Seed = Omit<Continuity, "slices">;

/**
 * 変更費用の文脈から前回を残す文脈の種を組む。前回の提案が無ければ（比較の相手なし）、前回を残す経路は一つも
 * 通らない——同じ入力からは前回の無い計画と同じ計画が出る。空の Shown_Plan も同じ扱い（changeCost が 0 を返す
 * 計画に、候補だけ増やす理由は無い）。
 */
function seedOf(changeContext: ChangeContext | null, params: ScheduleParams): Seed | null {
  if (changeContext === null || changeContext.shown.length === 0) return null;
  const shownByKey = new Map(changeContext.shown.map((item) => [itemKeyOf(item), item]));
  // 旧 Shown_Plan の Head は比較の時点で決まり、計画の間は変わらない（一度だけ導く）。
  const heads = shownHeadsOf(changeContext, params);
  return { changeContext, shownByKey, heads };
}

/** 「今」の品目（`startAt ≤ now` の配置と、その品目）。配分の入力。 */
interface NowItem {
  readonly placement: Placement;
  readonly order: PendingOrder;
}

/**
 * placeNow — 「今」の品目に釜を配って計画を完成させる loop（startable-placement design Component 3′・AC 1.8 改訂・判断 14）。
 *
 * **保持するのは「今に選んだ品目とその時刻」であり、釜は変更不能にしない。** 1 段目の「今」（`startAt ≤ now`）を nowSet とし、
 * 反復ごとに nowSet **全体**を最終的な表示順（`startAt` → `compareArrival`）で配り直し（`pinNow`）、将来配置は前の反復のまま
 * 残して計画順に検証し、不正な一片はその位置で再生成する（`revalidate`・配分した「今」はその配置のまま残す）。再生成で
 * 「今」になった品目（fresh）が在れば nowSet に足して繰り返す。loop で発見した順ではなく最終的な表示順で配り直すのは、後着の
 * 品目が先に空き釜を固定すると、後から「今」になった先着の品目（表示の先頭）が boiled の釜に落ちて押せず、後続も隠れるため
 * である（反例：同卓の先着 Short 60 秒・後着 Long 600 秒、釜 0 が boiled・釜 1 だけ空き——Long を釜 1 に固定すると、再生成で
 * 「今」になった Short が釜 0 に落ち `headsOf` が空。Short を釜 1・Long を釜 0 に配り直せば Short の提案が出る）。
 *
 * **「今」の入れ替えは費用改善の判断（判断 14）。** 固定した「今」を残した再生成が計画順で成り立たない一片で `revalidate` は
 * 固定を外して卓を丸ごと再生成する（その「今」は失われ得る）が、それを物理的な例外とは扱わない。その場面では候補 K——
 * 1 段目の配置の時刻をすべて保ち、配分した釜だけを交換した計画（`swapNow`）——を組んで検証し、K が合法なら K と再生成を
 * 終えた計画（「今」の入れ替えを含む）を同じ旧 Shown_Plan に対する総費用（`scoreSchedule`）で比べ、真に低い方を採る（同点は
 * K）。K が違法なときだけ再生成に落ちる。1 段目の「今」が「今」を失うのは、K が違法か、K より総費用が真に低い計画が在るとき
 * だけ（性質 4.7′）。1 段目への無条件のフォールバックは置かない（性質 4.8——場面 E では 1 段目の「今」の大盛が釜 1 に残る Timer
 * で押せない）。
 *
 * **停止性**：継続する反復ごとに nowSet が必ず増える（fresh が空なら止まる）ので、反復回数は品目数で抑えられる。釜の固定に
 * 依らない（固定を外されて「今」でなくなった品目の鍵も nowSet に残す）。K は品目を足さず、比較は loop の外で一度だけ行う。
 *
 * 1 段目に「今」の品目が無ければ計画は 1 段目のまま（占有に依らない・性質 4.6）。生成候補 F と保持候補 R の両方が通る。
 */
function placeNow(planning: Planning, stage1: CookSchedule): CandidateStages {
  const { now } = planning;
  const orderByKey = new Map(planning.pending.map((order) => [itemKeyOf(order), order]));
  const nowKeysOf = (schedule: CookSchedule): readonly ItemKey[] =>
    schedule.slices.flatMap((slice) =>
      slice.placements.flatMap((placement) =>
        placement.startAt <= now ? [itemKeyOf(placement)] : [],
      ),
    );
  const nowKeys = new Set(nowKeysOf(stage1));
  if (nowKeys.size === 0) return { stage1, regenerated: stage1, swap: null, completed: stage1 };

  let plan = stage1;
  // 1 段目の「今」への配分（最初の反復のもの）。候補 K はこれで釜を交換する。
  let first: ReadonlyMap<ItemKey, Placement> | null = null;
  let dropped = false;
  for (;;) {
    const byKey = new Map(
      plan.slices.flatMap((slice) =>
        slice.placements.map((placement) => [itemKeyOf(placement), placement] as const),
      ),
    );
    // nowSet の品目は配分した配置のまま残る（`revalidate` の再生成は固定分を落とさない）ので必ず引ける。
    const nowItems: NowItem[] = [...nowKeys]
      .map((key) => ({ placement: byKey.get(key)!, order: orderByKey.get(key)! }))
      // 固定を外されて「今」でなくなった品目（`revalidate`）は配らない（鍵は nowSet に残り、停止性はそのまま）。
      .filter((item) => item.placement.startAt <= now)
      .sort(byDisplayOrder);
    const allocation = pinNow(nowItems, planning);
    first ??= allocation;
    const allocated = plan.slices.map((slice) => ({
      tableKey: slice.tableKey,
      placements: slice.placements.map(
        (placement) => allocation.get(itemKeyOf(placement)) ?? placement,
      ),
    }));
    const revalidated = revalidate(planning, allocated, allocation, false);
    plan = { slices: revalidated.slices };
    dropped ||= revalidated.dropped;
    const fresh = nowKeysOf(plan).filter((key) => !nowKeys.has(key));
    if (fresh.length === 0) break;
    for (const key of fresh) nowKeys.add(key);
  }
  if (!dropped) return { stage1, regenerated: plan, swap: null, completed: plan };

  const swap = swapNow(stage1, first!);
  if (!isLegal(planning, swap.slices)) return { stage1, regenerated: plan, swap, completed: plan };
  const { pending, members, lifts, params, seed } = planning;
  const scoreContext = { members, lifts, change: seed?.changeContext ?? null };
  const totalOf = (schedule: CookSchedule) =>
    scoreSchedule(schedule.slices, pending, scoreContext, params).total;
  const completed = totalOf(plan) < totalOf(swap) ? plan : swap;
  return { stage1, regenerated: plan, swap, completed };
}

/**
 * 候補 K——1 段目の配置の時刻をすべて保ち、配分した釜だけを交換した計画（判断 14）。
 *
 * 配分が「今」の品目を新しい釜（`taken`＝配分後にだけ在る釜）へ動かすと、その釜を使っていた 1 段目の将来配置は行き場を
 * 失う。それらを、動いた「今」の品目が空けた釜（`freed`＝配分前にだけ在る釜）へ index 順に写す——釜の**交換**であり、時刻は
 * 一つも動かさない（配分は「今」の全品目について排他的で本数を保つので `|taken| = |freed|`）。交換で同じ釜の時間帯が重なる
 * （空けた釜を 1 段目の後続配置が上がった後に使っていた）など成り立たない K は違法として落ちる（`isLegal`）——K は合法か
 * 違法かのどちらかで、再生成はしない。
 */
function swapNow(stage1: CookSchedule, allocation: ReadonlyMap<ItemKey, Placement>): CookSchedule {
  const before = new Set<number>();
  const after = new Set<number>();
  for (const slice of stage1.slices) {
    for (const placement of slice.placements) {
      const moved = allocation.get(itemKeyOf(placement));
      if (moved === undefined) continue;
      for (const slotId of placement.slotIds) before.add(slotOf(slotId));
      for (const slotId of moved.slotIds) after.add(slotOf(slotId));
    }
  }
  const ascending = (slots: Iterable<number>) => [...slots].sort((slot, other) => slot - other);
  const freed = ascending(before).filter((slot) => !after.has(slot));
  const taken = ascending(after).filter((slot) => !before.has(slot));
  const exchanged = new Map(taken.map((slot, index) => [slot, freed[index]!]));
  return {
    slices: stage1.slices.map((slice) => ({
      tableKey: slice.tableKey,
      placements: slice.placements.map((placement) => {
        const moved = allocation.get(itemKeyOf(placement));
        if (moved !== undefined) return moved;
        if (!placement.slotIds.some((slotId) => exchanged.has(slotOf(slotId)))) return placement;
        const slots = placement.slotIds.map(
          (slotId) => exchanged.get(slotOf(slotId)) ?? slotOf(slotId),
        );
        return { ...placement, slotIds: slotIdsOf(slots) };
      }),
    })),
  };
}

/**
 * 完成した計画が計画順に物理的なハード制約（置ける品目に限る `isStale`・`feasibleRelease`・`keepsAnchor`・`withinLiftCap`）を
 * 守るか。`revalidate` と同じ述語を、再生成も取り置きも無しに当てる（候補 K の検証・性質 4.8 の検査と同じ形）。
 */
function isLegal(planning: Planning, slices: readonly PlanSlice[]): boolean {
  const { targets, members, presets, params } = planning;
  let free = planning.release;
  let ends = planning.lifts;
  for (const slice of slices) {
    const siblings = members.get(slice.tableKey) ?? null;
    if (
      isStale(slice, targets) ||
      feasibleRelease(slice.placements, free, targets, presets) === null ||
      !keepsAnchor(slice.placements, free, ends, siblings, targets, presets, params) ||
      !withinLiftCap(ends, liftsOf(slice.placements), params)
    )
      return false;
    free = advanceRelease(free, slice.placements);
    ends = advanceLifts(ends, liftsOf(slice.placements));
  }
  return true;
}

/** 表示の順——`startAt` 昇順・同値は到着順（`compareArrival`・表示の `liftGroupsOf` と同じ比較）。 */
function byDisplayOrder(a: NowItem, b: NowItem): number {
  return a.placement.startAt - b.placement.startAt || compareArrival(a.order, b.order);
}

/**
 * pinNow — 「今」の品目に、今割り当てられる釜を表示の順に配る（startable-placement AC 1.1〜1.7・2.1）。
 *
 * **入力は表示の順に並んだ「今」の品目**（`startAt` 昇順・同値は到着順）であって計画の一片の順ではない（観測事実 9：卓 X に
 * −3 秒の 60 秒麺と −1 秒の 600 秒麺、卓 Y に −2 秒の 600 秒麺なら、計画順は X → Y だが「今」の表示順は Y → X）。先頭
 * arms 本は表示の順で数えるので、配る順もそれに結ぶ（AC 1.5）。
 *
 * **配分の母集団 `pool`** は `release[s] ≤ now` の釜（入力の解放表＝採用済み接頭辞の予約を反映済み。予約された釜は Timer が
 * 無くても今割り当てられる釜ではない・判断 9 (a)）。そのうち `occupied` に無い釜が今割り当てられる釜 `assignable`、在る釜が
 * 待つ釜（boiled）。「今」の配置は互いに素で全部 `pool` に載っている（検証済みの計画の「今」は解放時刻 `now` の釜に在り、
 * 同じ釜に「今」を二つ置けない）ので `|pool| ≥ Σ slotSpan`——**配分は「今」の全品目（待つ品目も含む）について `pool` の上の
 * 排他的な割当**として行い、取った釜は `claimed` に入れて以後どの品目も採らない。
 *
 * **規則（品目を表示順に見て slotSpan 本を `pool ∖ claimed` から）。**
 *   (i) 未claim の `assignable` が slotSpan 本以上あれば `assignable` だけから——(a) 前回の釜（Shown_Plan の `slotIds`）が
 *       全部在ればそれ（AC 1.7・先の品目を押しのけない範囲で保つ）、(b) いまの釜（1 段目・前の反復・復元した配置）が全部
 *       在ればそれ、(c) `chooseSlots`（釜距離 → index の既存規則。`assignable ∖ claimed` だけを `now` にした表で引く）。
 *   (ii) 足りなければ待つ品目として、未claim の待つ釜だけから——(a) いまの釜、(b) 前回の釜、(c) index 昇順。
 *        `assignable` の残りは後の品目に残す（半端に取って空き釜を潰さない・AC 1.4 の待ちは空き釜不足のときだけ）。
 *   (iii) それも足りなければ `pool ∖ claimed` から index 昇順で混ぜて取る（本数の勘定から必ず足りる。全釜 idle でない
 *         ので待つ品目になる）。いまの釜が先の品目に取られた品目の退避先。
 * 前回の釜が Timer の在る釜なら (i) では採れない——押せない釜を前回の釜として守らない（AC 2.1・釜の変更費用 L は払う）。
 * 保持候補 R の復元した「今」も同じ規則を通る（いまの釜＝前回の釜なので、先の品目が要さない限りそのまま残る）。
 *
 * 返すのは品目ごとの配置（釜だけを配り直したもの・`startAt` / `serveAt` / `anchor` は入力のまま）。
 */
function pinNow(nowItems: readonly NowItem[], planning: Planning): ReadonlyMap<ItemKey, Placement> {
  const { release, occupied, now, params, seed } = planning;
  const pool = release.flatMap((at, slot) => (at <= now ? [slot] : []));
  const assignable = pool.filter((slot) => !occupied.has(slot));
  const waiting = pool.filter((slot) => occupied.has(slot));
  const claimed = new Set<number>();
  const unclaimed = (slots: readonly number[]) => slots.filter((slot) => !claimed.has(slot));

  const placements = new Map<ItemKey, Placement>();
  for (const { placement, order } of nowItems) {
    const key = itemKeyOf(order);
    const span = placement.slotIds.length;
    const current = placement.slotIds.map(slotOf);
    const shown = seed?.shownByKey.get(key);
    const remembered = shown === undefined ? null : [...new Set(shown.slotIds.map(slotOf))];
    const startable = unclaimed(assignable);
    const boiled = unclaimed(waiting);
    let chosen: readonly number[];
    if (startable.length >= span) {
      chosen =
        within(remembered, span, startable) ??
        within(current, span, startable) ??
        chooseSlots(span, onlyNow(release, startable, now), params);
    } else if (boiled.length >= span) {
      chosen =
        within(current, span, boiled) ?? within(remembered, span, boiled) ?? boiled.slice(0, span);
    } else {
      chosen = unclaimed(pool).slice(0, span);
    }
    const slots = [...chosen].sort((slot, other) => slot - other);
    for (const slot of slots) claimed.add(slot);
    placements.set(key, { ...placement, slotIds: slotIdsOf(slots) });
  }
  return placements;
}

/** 候補の釜の組が count 本の相異なる釜で、すべて allowed に在ればその組（配分の (a)(b)）。そうでなければ null。 */
function within(
  candidate: readonly number[] | null,
  count: number,
  allowed: readonly number[],
): readonly number[] | null {
  if (candidate === null || candidate.length !== count) return null;
  if (new Set(candidate).size !== count) return null;
  return candidate.every((slot) => allowed.includes(slot)) ? candidate : null;
}

/** `slots` だけを `now` に、他をすべて後回し（無限大）にした解放表——`chooseSlots` の候補をその釜に限る。 */
function onlyNow(release: SlotRelease, slots: readonly number[], now: EpochMillis): SlotRelease {
  return release.map((_unused, slot) =>
    slots.includes(slot) ? now : (Number.POSITIVE_INFINITY as EpochMillis),
  );
}

/**
 * revalidate — 一片の列を計画順に検証し、不正な一片は**その位置で**その卓を再生成する（plan-stability Requirement 6 判断 10・
 * startable-placement Component 3′）。復元（`retain`）と「今」の配分の loop（`placeNow`）が同じ関数を呼ぶ——対象が Shown_Plan か
 * 1 段目かの違いだけ。
 *
 * 一片ごとに、採用済み接頭辞（入力の表）と手前の一片で進めた表に、**まだ来ていない一片の配分した「今」の釜**（`fixed` の
 * うち手前に無いもの・`ahead`）を取り置いた表で検証する（上がりは載せない——本文の注記）。配分は互いに素で `pool` に載る
 * （構造）ので、再生成が配分した釜を取ることは無い。述語は合成（`livePrefix`）・
 * ゲート（`prune`）と同じ公開関数——置ける品目に限る `isStale`（Requirement 7）・解放表の feasibility（`feasibleRelease`）・
 * `keepsAnchor`・`withinLiftCap`。`retaining` のときは検証の前に復元した配置の錨を現在の走行中に対して付け直す（`reanchor`）。
 *
 * **保持の条件 `cannotStart`（判断 10・13）は復元には当てない（実装で判明・2026-09-07）。** 過去開始は retime（判断 9）で
 * 消え、残るのは「`startAt ≤ now` で釜に Timer」＝空き不足で boiled の釜の Complete を待つ配置（AC 1.4・合法）だけである。
 * それを落とせば、待つ配置を含む卓が同じ入力でも毎回再生成され、前回を再現できず性質 5.6 が実占有で落ちる（実測：6 釜・
 * arms 1・L 5・総費用 3993 → 4014）。待つ配置の釜は `placeNow` の配分が表示順に配り直す（空き釜が出ていれば Startable_Slot へ
 * 動き、無ければ待つ）ので、復元で落とす理由が無い。`cannotStart` は採用済み接頭辞（`livePrefix`・再配分されない）の条件に
 * 留まる。
 *
 * 不正な一片は、その卓の置ける品目を生成器（`placeGroup`・文脈つき）で置き直す。一片の配分した「今」の配置（`fixed` に
 * 在るもの）は**その配置のまま**残し、残りの品目だけを、手前の一片・`ahead` の取り置き・その固定分で進めた表の上に置く（「今」の
 * 集合は縮まず、「今」の品目の時刻は動かない・AC 1.8 改訂）。固定分を残した再生成が計画順で成り立たないとき——固定分の
 * 上がりが手前の一片の上がりと同じ窓で上限 (f) を超える・合流した固定分の候補時刻が手前の表で変わって (d) が破れる——は、
 * 固定を外して卓を丸ごと再生成し、`dropped` で呼び手に知らせる。その「今」を失うかどうかは呼び手（`placeNow`）が候補 K との
 * 総費用の比較で決める（判断 14——物理的な例外として扱わない）。再生成した一片の並びは生成器の並び（固定分・合流分・batch の順）。
 * 「最初の不正で止める」形（接頭辞・合成）は採らない——now が進むたびに前回の「今」が落ちてほぼ全再生成になり役に立たない
 * （判断 10・実測）。
 */
function revalidate(
  planning: Planning,
  slices: readonly PlanSlice[],
  fixed: ReadonlyMap<ItemKey, Placement>,
  retaining: boolean,
): {
  readonly slices: readonly PlanSlice[];
  readonly release: SlotRelease;
  readonly lifts: LiftTable;
  /** 固定した「今」を残した再生成が成り立たず、固定を外して卓を再生成した一片が在ったか（`placeNow` が候補 K を組む合図）。 */
  readonly dropped: boolean;
} {
  const { targets, members, presets, params, seed } = planning;
  const out: PlanSlice[] = [];
  let free = planning.release;
  let ends = planning.lifts;
  let dropped = false;
  const allocated = [...fixed.values()];
  const seen = new Set<ItemKey>();
  for (const slice of slices) {
    for (const placement of slice.placements) seen.add(itemKeyOf(placement));
    const ahead = allocated.filter((placement) => !seen.has(itemKeyOf(placement)));
    // 後の一片の配分した「今」の釜は取り置く（解放を無限大に）——上がった後に使う配置も許さない。計画順の解放表は
    // 「その釜は次にいつ空くか」しか語れず、手前の一片がその釜を（今の配置が上がった後に）使えば、後の一片の「今」は
    // 計画順の検証（ゲート・合成と同じ）で解放時刻より前の開始になる。**上がりは載せない**——載せて手前の一片の pack が
    // その窓で延期されると、計画順の検証には延期の理由（後の一片の上がり）が見えず `keepsAnchor` (d) を破る（実測：18 釜・
    // arms 1・L 8 で、後の卓なし品目の 60 秒の上がりを見た卓 t-2 の合流分が 52.55 秒から 61 秒へ動いた）。窓の上限 (f) は
    // 後の一片の側で検証し、成り立たなければその「今」を固定から外す（下）。
    const freeAhead = reserve(
      free,
      ahead.flatMap((placement) => placement.slotIds.map(slotOf)),
    );
    const siblings = members.get(slice.tableKey) ?? null;
    // 復元した一片は、Shown_Plan の品目から始まった走行中（新しい仲間）に対して錨を付け直してから検証する（`reanchor`）。
    const started = retaining && seed !== null ? startedSiblingsOf(slice.tableKey, seed) : [];
    const restored =
      started.length > 0
        ? reanchor(slice.placements, freeAhead, started, targets, presets, params)
        : slice.placements;
    // 物理的なハード制約（計画順・手前の一片で進めた表・後の「今」の釜は取り置き）。`isStale` は一片の品目集合の検査。
    const legal = (placements: readonly Placement[]) =>
      feasibleRelease(placements, freeAhead, targets, presets) !== null &&
      keepsAnchor(placements, freeAhead, ends, siblings, targets, presets, params) &&
      withinLiftCap(ends, liftsOf(placements), params);
    let placements = restored;
    if (isStale(slice, targets) || !legal(restored)) {
      const own = slice.placements.filter((placement) => fixed.has(itemKeyOf(placement)));
      const group: TableGroup = {
        tableKey: slice.tableKey,
        items: targets.filter((order) => tableKeyOf(order) === slice.tableKey),
      };
      const continuity: Continuity | null = seed === null ? null : { ...seed, slices: out };
      const regenerate = (kept: readonly Placement[]) =>
        placeGroup(
          group,
          advanceRelease(freeAhead, kept),
          advanceLifts(ends, liftsOf(kept)),
          siblings,
          presets,
          params,
          continuity,
          kept,
        );
      placements = regenerate(own);
      // 固定した「今」を残した再生成が計画順で成り立たない——固定分の上がりが手前の一片の上がりと同じ窓で上限を超える、
      // 合流した固定分の候補時刻が手前の表で変わった——なら、固定を外して卓を丸ごと再生成する（「今」の入れ替えを含む）。
      // これは物理的な例外ではなく再生成の一候補で、呼び手（`placeNow`）が候補 K と総費用で比べて選ぶ（判断 14）。
      if (own.length > 0 && !legal(placements)) {
        placements = regenerate([]);
        dropped = true;
      }
      // 置ける品目が一つも無くなった卓は一片を成さない。
      if (placements.length === 0) continue;
    }
    out.push({ tableKey: slice.tableKey, placements });
    free = advanceRelease(free, placements);
    ends = advanceLifts(ends, liftsOf(placements));
  }
  return { slices: out, release: free, lifts: ends, dropped };
}

/**
 * 卓の走行中の仲間のうち、旧 Shown_Plan の品目から始まったもの（新しい仲間）の実効 endTime（昇順）。
 *
 * 前回の計画が組まれた時点には無く、その後の遷移（開始）で現れた錨である。Shown_Plan は前回の Timer 集合を持たないが、
 * 走行中の `orderItem` の鍵が Shown_Plan に在れば、その Timer は前回は未着手の配置だった——それが始まったことは事実から
 * 読める。前回から在った仲間はここに入らない（前回の配置の `anchor` はそれらに対して既に決めた事実で、null も判断である）。
 */
function startedSiblingsOf(tableKey: string, seed: Seed): readonly EpochMillis[] {
  return seed.changeContext.running
    .filter(
      (timer) =>
        timer.orderItem !== null &&
        timer.orderItem.tableId === tableKey &&
        seed.shownByKey.has(itemKeyOf(timer.orderItem)),
    )
    .map((timer) => adjustedEndTime(timer))
    .sort((a, b) => a - b);
}

/**
 * 復元した一片の配置に、新しい仲間（`startedSiblingsOf`）の錨を付け直す（`retain` の検証の前・plan-stability 判断 9′：復元した
 * 配置の `anchor` は、旧 Shown_Plan の品目のうち**今回 Timer になったもの**の実効 endTime にだけ付け直す。全走行中に付け直すと、
 * 生成器が意図して付けなかった錨が付く）。
 *
 * `Placement.anchor` は「合流先の走行中の実効 endTime」という現在の Timer 集合に対する事実であり（AC 9.9）、前回の配置を
 * そのまま持つと二つの形で古びる。(1) 群の 1 本目（前回は未着手の配置）が始まった——残りは前回 `anchor: null`（または前回の
 * 仲間への錨）のままだが、いまは始まった 1 本目の上がりに合流した配置そのものである（時刻も釜も同じ）。null のまま残せば
 * `keepsAnchor` は通る（押し出しではない）が、群は Group_Started にならず連鎖が止まり、後の卓の提案が隠れる（lift-group-display
 * 判断 19）。(2) 錨の Timer が Complete で消えた——`keepsAnchor` (a) が落として再生成に回る（ここでは触らない）。
 *
 * (1) を生成器と同じ規則で埋める：`anchor` を持たない配置を開始時刻の順に見て、その品目の釜がこの一片の手前の配置で進めた
 * 表で空く最早の時刻 ＋ 茹で時間（earliest）から、**新しい仲間だけ**を相手に `joinTarget` を引き、合流先が在って配置の提供
 * 時刻がその候補以上（窓で後ろへ動いた合流分を含む）ならその錨を付ける。前回から在った仲間を相手にしないのは、前回の
 * 配置の null がそれらに対する判断（合流できなかった・batch に回した）であり、実際の釜から引いた earliest で引き直せば生成器
 * が合流させなかった配置にまで錨が付くためである（実測：同じ入力の再計画で、走行中 0 / 176 秒の卓の Thin を 284 秒に置いた
 * 前回の配置に錨 176 が付き、`keepsAnchor` は通るが前回と一致しない計画になって性質 5.6 が 1 万場面に 1 回落ちた）。
 * 同じ入力（新しい仲間なし）の再計画では何も付け直さず、前回そのものが復元される。錨を持つ配置はそのまま。
 */
function reanchor(
  placements: readonly Placement[],
  release: SlotRelease,
  siblings: readonly EpochMillis[],
  targets: readonly PendingOrder[],
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): readonly Placement[] {
  const order = [...placements].sort(
    (a, b) => a.startAt - b.startAt || slotOf(a.slotIds[0]) - slotOf(b.slotIds[0]),
  );
  const anchored = new Map<Placement, EpochMillis>();
  let free = release;
  for (const placement of order) {
    if (placement.anchor === null) {
      const { boilMillis } = resolveBoil(placement, targets, presets);
      if (boilMillis !== null) {
        const frees = placement.slotIds.map((slotId) => free[slotOf(slotId)]);
        if (frees.every((at) => at !== undefined)) {
          const earliest = Math.max(...(frees as number[])) + boilMillis;
          const target = joinTarget(earliest, siblings, boilMillis, params);
          if (target !== null && placement.serveAt >= target.serveAt) {
            anchored.set(placement, target.anchor);
          }
        }
      }
    }
    free = advanceRelease(free, [placement]);
  }
  if (anchored.size === 0) return placements;
  return placements.map((placement) => {
    const anchor = anchored.get(placement);
    return anchor === undefined ? placement : { ...placement, anchor };
  });
}

/**
 * retain — 旧 Shown_Plan を復元して保持候補 R の 1 段目にする（plan-stability Requirement 6 判断 9・10・AC 6.2・design
 * Component 7）。
 *
 * 復元（`restoreSlices`）：`shownPlan` の品目のうち置ける品目（Live_Orders の計画対象・Requirement 7）に在るものを初出順の一片
 * （現在の品目の `tableKeyOf`・卓なしは単独キー）に組み、`slotIds` / `startAt` / `serveAt` / `anchor` をそのまま持つ。群は
 * `recommend` が付け直す（`mates` は読まない）。過去開始の「今」（`startAt < now`）は **now に置き直してから**（retime：
 * `startAt = now`・`serveAt = now + 茹で時間`）検証する（完全復元 44 → 855 場面・実測）。
 *
 * 検証と再生成は `revalidate`（錨の付け直しを足す・保持の条件 `cannotStart` は当てない——同所の注記）。前回に無い品目（新着）は
 * その卓の一片が `isStale` で落ちる
 * ので再生成に含まれ、卓ごと新しい（前回に一片が無い）品目は末尾に生成器で置く。復元した「今」の配置は `placeNow` の配分に
 * そのまま渡る（いまの釜＝前回の釜として (i)(b) で残る）。
 */
function retain(planning: Planning): CookSchedule {
  const { targets, now, presets } = planning;
  // `seed` は呼び手が非 null を確かめている（Shown_Plan が無ければ R は組まない）。
  const shown = planning.seed!.changeContext.shown;
  const restored = restoreSlices(shown, targets, now, presets);
  const { slices, release, lifts } = revalidate(planning, restored, new Map(), true);
  // 前回に一片が無かった卓の品目を末尾に置く。計画対象（正本）から組んで群の順（卓の最早到着）を従来どおりにし、64 件の
  // 制限を跨がない（`planTargets` の出力の部分集合）。
  const restoredTables = new Set(restored.map((slice) => slice.tableKey));
  const rest = planTargets(planning.pending, now).filter(
    (order) => !restoredTables.has(tableKeyOf(order)),
  );
  const tail = buildSchedule(planning, rest, release, lifts, slices);
  return { slices: [...slices, ...tail.slices] };
}

/**
 * Shown_Plan を一片の列に組む（`retain` の復元）。一片の順は Shown_Plan での初出順（`shownPlanOf` は計画順に平坦化するので
 * 計画順が残る）。置ける品目に無い品目（開始済み・キャンセル・期限切れ・置けない）は落とす——落ちた卓は `isStale` で
 * 再生成に回る。過去開始（`startAt < now`）は now に置き直す（retime）——提供時刻は現在の茹で時間で、錨は保つ。
 */
function restoreSlices(
  shown: ShownPlan,
  targets: readonly PendingOrder[],
  now: EpochMillis,
  presets: readonly NoodlePreset[],
): readonly PlanSlice[] {
  const byKey = new Map(targets.map((order) => [itemKeyOf(order), order]));
  const slices = new Map<string, Placement[]>();
  const seen = new Set<ItemKey>();
  for (const item of shown) {
    const key = itemKeyOf(item);
    const order = byKey.get(key);
    if (order === undefined || seen.has(key)) continue;
    seen.add(key);
    const lapsed = item.startAt < now;
    // 置ける品目は茹で時間が必ず引ける。
    const boilMillis = boilMillisOf(order, presets)!;
    const placement: Placement = {
      externalOrderId: item.externalOrderId,
      itemIndex: item.itemIndex,
      slotIds: item.slotIds,
      startAt: lapsed ? now : item.startAt,
      serveAt: lapsed ? ((now + boilMillis) as EpochMillis) : item.serveAt,
      anchor: item.anchor,
    };
    const tableKey = tableKeyOf(order);
    const slice = slices.get(tableKey);
    if (slice === undefined) slices.set(tableKey, [placement]);
    else slice.push(placement);
  }
  return [...slices].map(([tableKey, placements]) => ({ tableKey, placements }));
}

/**
 * 卓ごとの群を正準順序で置いて計画を組む（生成器。生成候補 F の 1 段目と、復元で前回に一片が無かった卓の尾部）。
 * `pending` は置く対象（`Planning.pending` の部分集合でもよい）、`release` / `lifts` は置き始める表、`before` は手前に
 * 置いた一片（列の局所比較が読む「列の外」）。`seed` は前回を残す文脈、null は前回なし。
 *
 * 群は正本の計画対象から組む（群の順＝卓の最早到着は置けない品目も数える・従来どおり）。置くのは群の中の置ける品目
 * だけ（`placeGroup` が `isPlaceable` で絞る＝`placeableTargets` と同じ一箇所の定義）——合成・ゲート・復元が `isStale`
 * で比べる集合と、自前解の一片の品目集合はこれで一致する（plan-stability Requirement 7.4）。
 */
function buildSchedule(
  planning: Planning,
  pending: readonly PendingOrder[],
  release: SlotRelease,
  lifts: LiftTable,
  before: readonly PlanSlice[] = [],
): CookSchedule {
  const { members, presets, params, now, seed } = planning;
  const slices: PlanSlice[] = [];
  let free = release;
  let ends = lifts;
  for (const group of tableGroups(planTargets(pending, now))) {
    // 走行中の錨＝同じ卓の走行中の仲間の提供時刻の最大（表の値は昇順ゆえ末尾）。卓なしの単独キーは
    // NUL 始まりで非空の tableId と一致しないため、表に当たらない（条件を書かない・ADR-0003）。
    const siblings = members.get(group.tableKey) ?? null;
    // 手前の一片は、列の候補配置を仮に置いた計画の「列の外」を成す（この群を置く間は増えない）。
    const continuity: Continuity | null =
      seed === null ? null : { ...seed, slices: [...before, ...slices] };
    const placements = placeGroup(group, free, ends, siblings, presets, params, continuity, []);
    // 1 品目も置けなかったグループは PlanSlice を成さない（空の一片は採用/棄却の対象にならない）。
    if (placements.length === 0) continue;
    slices.push({ tableKey: group.tableKey, placements });
    free = advanceRelease(free, placements);
    ends = advanceLifts(ends, liftsOf(placements));
  }
  return { slices };
}

/**
 * 計画対象＝生きている待ち行列（Live_Orders・`liveOrders(pending, now)`）を正準順序（arrivalTime 昇順,
 * externalOrderId 昇順, itemIndex 昇順）に並べた先頭 PLAN_TARGET_LIMIT 件。
 *
 * **絞ってから切る（pending-order-expiry AC 2.1）。** 切ってから絞れば、到着順の先頭を占める期限切れの品目が枠を
 * 食い、新しい注文が計画に入らない（性質 5.4）。期限は状態を書き換えず `now` から導く述語（domain/order.ts）で、
 * 「何が計画対象か」の出所であるこの関数が、呼び手ごとの `now` で一度だけ呼ぶ。`isStale` / 合成の `livePrefix` は
 * この出力を受けるので、期限切れの品目を指す一片は「計画対象と一致しない」で落ちる（AC 2.3）。
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
export function planTargets(
  pending: readonly PendingOrder[],
  now: EpochMillis,
): readonly PendingOrder[] {
  return [...liveOrders(pending, now)].sort(byCanonicalOrder).slice(0, PLAN_TARGET_LIMIT);
}

/**
 * 置ける品目——計画対象（`planTargets`）のうち、茹で時間が引け（プリセットに在る麺種）、品目単体で上げ窓の上限
 * （slotSpan ≤ arms + HELPER_ARMS・`liftCap`）に収まるもの（plan-stability Requirement 7・2026-09-07）。
 *
 * **計画対象を決めた後に絞る（AC 7.1）。** 期限と 64 件の制限は正本（`planTargets`）の関心事で、そこで切った後に
 * 置けるかで絞る。除外した分の繰り上げはしない——65 件目は入らない（絞ってから切れば、プリセットの差し替えが
 * 計画対象の範囲を動かし、指紋と要求が指す範囲（`planTargets`）と食い違う）。
 *
 * **現在の空き不足や上げ窓の混雑は除外理由にしない（AC 7.2）。** それらは「置けない品目」ではなく「待つ品目」で、
 * 待つ配置（boiled の釜の Complete を待つ・startable-placement AC 1.4）は合法である。
 *
 * **定義はここ一箇所（AC 7.4）。** 自前解（`placeGroup` が群の中で置く品目・同じ `isPlaceable`）・合成（`livePrefix`・
 * 尾部の残り）・ゲート（`prune`）・復元（retain）が同じ集合を `isStale` に渡す。正本の計画対象のまま比べると、自前解は
 * 置けない品目を置かないので未知麺種を含む卓の一片（自前解・外部解とも）が常に「欠落」で落ちる（3000 場面中 1319 一片・
 * 実測）。自前解の**群の順**（卓の最早到着）は正本の計画対象で決めたまま——置けない品目が卓の先着でも群の順は変えない
 * （集合の定義ではなく並びの規則で、Requirement 7 の外。`schedule.example` の性質 5.6 の回帰がその並びに立つ）。
 * 指紋（`digestInput`）と要求（`RequestPlan.pending`）は正本の計画対象のまま——「何が計画対象か」と「そのうち何が
 * 置けるか」は別の問いで、要求は置けない品目もプリセットと共に外部へ運ぶ（外部は同じ規則で絞る）。
 */
export function placeableTargets(
  pending: readonly PendingOrder[],
  now: EpochMillis,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): readonly PendingOrder[] {
  const cap = liftCap(params);
  return planTargets(pending, now).filter((order) => isPlaceable(order, presets, cap));
}

/** 置ける品目か——茹で時間が引け（プリセットに在る麺種）、品目単体で上げ窓の上限 `cap`（`liftCap`）に収まる。 */
function isPlaceable(order: PendingOrder, presets: readonly NoodlePreset[], cap: number): boolean {
  return boilMillisOf(order, presets) !== null && order.slotSpan <= cap;
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
 * `commit.ts`（確定計画の合成）と `admit.ts`（Acceptance_Gate の段 1）と復元（retain）が同じ述語を用いる。判定を
 * 二箇所に書けば、採用の基準と維持の基準が黙ってずれる。置き場所をここにするのは、PlanSlice・計画対象の
 * いずれもこのモジュールが定めているためである（Table_Group の識別子 `tableKeyOf` は project.ts・入口はここ）。
 *
 * **`startAt < now`（過去開始）はここに含めない。** それは「人が推奨時刻に開始しなかった」という時間の事実で、
 * 計画対象との食い違いではない。保持の条件（`cannotStart`）として分ける。Acceptance_Gate の側では
 * ハード制約 (c) が独立に落とす——解放表の下限が now ゆえ、過去に始まる配置は feasibility を満たさない。
 *
 * **targets は置ける品目（`placeableTargets` の出力）を渡す（plan-stability Requirement 7・2026-09-07）。** 正本の
 * 計画対象（`planTargets`）を渡すと、自前解が置かない品目（茹で時間の引けない麺種・単体で上限を超える span）を含む卓の
 * 一片は常に「欠落」で落ちる。置ける品目の欠落と、対象外（置けない・計画対象外）の品目の混入は引き続き落とす
 * （AC 7.3）——本数の一致と「計画対象 ⊆ 一片」の走査がそのまま両方を言う。全 Pending_Order を渡して内部で切り直すと、
 * 一片ごとに同じ整列を繰り返すうえ、呼び出し側が既に持っている範囲と別の範囲を指す余地が生まれる。
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
 * cannotStart — 開始できない配置を含む一片か（startable-placement 判断 8・Requirement 3.4 / 3.5）。二つの事実の
 * どちらかで立つ。
 *   - **過去開始**（`startAt < now`）——人が推奨時刻に開始しなかった事実。その前提の上に積んだ後方も意味を失う。
 *   - **押せない釜**（`startAt ≤ now` かつ釜のどれかに Timer が残っている）——開始時刻が来ているのに、その釜は
 *     Complete 待ち（boiled）か走行中で、現場は押せない事実。解放表は boiled の釜を `now` に空く予測で扱うので
 *     feasibility は通るが、そのまま維持すれば「今」の先頭が押せない品目のまま固定され、尾部が空き釜に置いた
 *     品目も連鎖で隠れる（観測事実 10）。過去に受領した将来計画が時刻の到来で「今」になり、その釜がまだ boiled
 *     なら同じ規則で落ちる（3.5）。開始時刻がまだ先の配置は見ない——boiled の釜はそれまでに Complete される
 *     予測に立つ（判断 2）。
 *
 * **これは採用済み一片を保持する条件であって、生成した計画全体の成立の条件ではない（plan-stability Requirement 6
 * 判断 13）。** 合成（`livePrefix`）は採用済み接頭辞（再配分されない）に当て、落ちた分を自前解が置き直す。生成した計画には
 * 一律に当てない——空き釜不足で boiled の釜の Complete を待つ配置（startable-placement AC 1.4）は合法で、自前解はそれを
 * 意図して置く。復元（`retain`）にも当てない——過去開始は retime で消え、待つ配置の釜は「今」の配分（`placeNow`）が配り直す
 * （`revalidate` の注記）。ゲート（admit）の feasibility もこの述語を読まない（判断 5）。述語の実装は一つ、適用先は別。
 *
 * 一片の中の 1 本でも該当すれば全体を陳腐化と見る。同一 Table_Group の配置は提供時刻を揃えるために
 * 互いの開始時刻を前提にしているので、1 本だけを落として残りを維持すれば、その一片が主張していた
 * 同時提供はもう成り立たない。`occupied` は Timer（running / boiled とも）の載る釜（domain の `occupiedSlotsOf`）。
 */
export function cannotStart(
  slice: PlanSlice,
  now: EpochMillis,
  occupied: ReadonlySet<number>,
): boolean {
  return slice.placements.some(
    (placement) =>
      placement.startAt < now ||
      (placement.startAt <= now &&
        placement.slotIds.some((slotId) => occupied.has(slotOf(slotId)))),
  );
}

/**
 * feasibleRelease — 一片の配置が解放表の上に置けるか。置けるなら当該一片の占有で進めた解放表を、置けないなら null。
 *
 * 検査するのは Requirement 3 のハード制約 (a)(b)(c) と、**配置が物理的に成立していること**である。ゲート（admit の
 * 段 1 (c)）と復元（retain・plan-stability 判断 10 の「解放表の feasibility」）が同じ関数を呼ぶ。合成（`livePrefix`）は
 * 採用済み接頭辞にこれを当てない——接頭辞は採用時にこの検査を通っており、その後の変化は `isStale` / `cannotStart` /
 * `keepsAnchor` / `withinLiftCap` が見る（採用済み一片の契約は従来のまま）。
 *
 * - (a) 同一 slot の時間帯を重複させない — 解放表が請け負う。配置を開始時刻の昇順に見て、その釜の解放時刻
 *   より前に始まる配置を落とす。一片の内側でも同じ釜を順に使う配置はあり得る（釜の数を超える大人数の卓は
 *   分割して置かれる）ため、一片の中でも表を進めながら見る。
 * - (b) 各時点の同時走行本数 ≤ slot 数 — (a) から従う。各配置は自分の釜の時間帯を排他に占めるので、
 *   ある瞬間に走れる本数は表の長さ＝釜の数を超えられない。独立の検査を置かない（同じ事実を二度書かない）。
 * - (c) 開始済み Timer の割当と実効 endTime を変えない — `initialRelease` が請け負う。表の初期値が開始済み
 *   Timer の実効 endTime であり、下限が now ゆえ過去に始まる配置もここで落ちる。
 *
 * **(d) slotSpan を検査する。** 配置の釜は当該品目の slotSpan 個で、かつ相異なること。本数だけを見ると
 * `["3","3"]` が本数 2 を満たしながら 1 釜しか占めず、advanceRelease が重複を吸収するので解放表にも現れない。
 * 本数で容量を数える設計（lift-group-planning AC 4.5）が開けた穴を、同じ場所で閉じる。述語は occupiesSlotSpan
 * ただ一つ（相異なるかは釜番号で比べる。`["0","00"]` は 1 釜）。isStale も同じ述語を読むので (a)(b) で既に落ちて
 * いるが、feasibility の側にも書くのは「解放表に置ける配置か」がここの主張だから。
 *
 * **serveAt = startAt ＋ 当該品目の茹で時間 を検査する。** 外部計画は startAt と serveAt の両方を主張してくるが、
 * 両者を結ぶのは品目の茹で時間ただ一つである。検査しないと「10 秒で茹で上がる」と主張する計画が作れ、Wait_Time も
 * 解放表もその嘘に従う——目的関数値はいくらでも小さくでき、改善判定と段 2 が無条件に通る。外部を信用しない設計の
 * 要は、外部が申告した値のうち検証できるものをすべて検証することにある。`targets` に無い品目（置けない品目を含む）を
 * 指す配置もここで落ちる。
 *
 * 走行中の錨 (e)（`keepsAnchor`）と上げ窓の上限 (f)（`withinLiftCap`）は別の公開述語で、呼び手が同じ位置（一片を置く前の
 * 表）で当てる。
 */
export function feasibleRelease(
  placements: readonly Placement[],
  release: SlotRelease,
  targets: readonly PendingOrder[],
  presets: readonly NoodlePreset[],
): SlotRelease | null {
  // 開始時刻の昇順で見る。同時刻は代表 slot の番号で断つ（判定を配置の並び順に依存させない）。
  const ordered = [...placements].sort(
    (placement, other) =>
      placement.startAt - other.startAt || slotOf(placement.slotIds[0]) - slotOf(other.slotIds[0]),
  );

  let free = release;
  for (const placement of ordered) {
    const order = targets.find((candidate) => refersTo(placement, candidate));
    if (order === undefined) return null;
    const boilMillis = boilMillisOf(order, presets);
    if (boilMillis === null) return null;
    if (placement.serveAt - placement.startAt !== boilMillis) return null;
    if (!occupiesSlotSpan(placement, order)) return null;
    for (const slotId of placement.slotIds) {
      const at = free[slotOf(slotId)];
      // 表の外を指す slot は存在しない釜であり、置き場所ではない。
      if (at === undefined) return null;
      if (placement.startAt < at) return null;
    }
    free = advanceRelease(free, [placement]);
  }
  return free;
}

/**
 * 一片が走行中の錨を守っているか（ハード制約 (e)・判断 16 / 17・AC 9.10・ADR-0007 / ADR-0009）。
 *
 * 一片の配置を**単位**にまとめ、単位を一つずつ解放表と上げ表へ載せながら検査する（design Component 10）。単位は
 * `anchor` を持つ配置なら「同じ `anchor`・同じ `serveAt`」の pack、持たない配置なら 1 品。自前解は列（同じ候補時刻の
 * 合流分）を pack 全体の span で `firstFit` して置く（placeWithLifts）ので、検証も同じ単位でなければ正当な待ち合わせ
 * （走行中 3 本が 54・54・66 秒に上がる表で、2 品の pack が 99 秒に置かれる）を拒否してしまう。
 *
 * pack（錨 A・提供時刻 T・Σ span = S）には 4 条件を要る（`fitsPack`）。
 *   (a) **錨の主張は現在の仲間に在る**：A は現在の走行中の仲間の実効 endTime のいずれかに等しい。`Placement.anchor` は
 *       `recommend` が無条件に client へ運び、client は `anchor > now` で「開始済み」を読む（判断 19）ので、検証しなければ
 *       外部計画が任意の錨を書いても通り、Boil_Sync で錨が動いた採用済み一片も古い錨を運び続ける（判断 17 が潰した
 *       回帰）。仲間が無い卓（`siblings` が null）では在りうる錨が無く、`anchor` を持つ配置は一つも許さない。
 *   (b) **手前に散らさない**：T ≥ A − h_i。
 *   (c) **集合として合流できた**：各配置の釜が、手前の単位で進めた解放表で A + h_i − 茹で時間 までに空いていた
 *       （空きが 1 釜だけなら、その釜を順に使う 2 品のうち後の品は仲間に合流できない）。
 *   (d) **延期の理由は窓だけ**：T が、各配置の釜の解放から取った判断 18 の候補時刻（`joinTarget`）の最大を候補とし、
 *       手前の単位で進めた上げ表の下で pack 全体の S で `firstFit` した時刻に一致する。**錨の主張だけでは合流分と
 *       認めない**——主張を無条件に信じれば、押し出した配置に仲間の endTime を書くだけで (e) を素通りする
 *       （全員を後ろへ遅らせた計画の 3 配置すべてに錨を付けた形が採用されていた。21.5 のレビュー P1）。後続品のために
 *       合流分を遅らせた計画（Thin と 600 秒の品目を両方 600 秒に置き Thin に anchor 60 を付ける）は、Thin の pack の
 *       firstFit が 60 秒ゆえここで落ちる。
 * `anchor` を持たない配置には押し出し（`isPushedOut`）を判定する——手前の単位で進めた表の下でいずれかの仲間に合流
 * できた品目が、候補時刻からの `firstFit` より後ろに置かれていれば押し出し。合流できない品目は保護の対象外である。
 *
 * 加えて、どの配置も走行中の最早より h_i を超えて手前には置かない（走行中より先に上げる配置は合流でも後続でもない）。
 *
 * **単位の順は「pack を (serveAt, startAt, 代表釜) の順にすべて載せてから、1 品の配置を同じ順に載せる」。** design の
 * 擬似コードは pack と 1 品を serveAt 順に混ぜて載せるが、自前解は合流の判定（joinable）を batch より先に、群を置く前の
 * 解放表の上で行う——上げ窓が pack を batch の 1 品より後ろの窓へ動かすと（釜 0・2 が空き・走行中 3 本が 60 秒に上がる
 * 表で Thin 2 品の pack は 105 秒、釜 1 が 40 秒に空く 3 品目は合流できず 100 秒）、serveAt 順では batch の 1 品が pack
 * より先に載り、pack の釜を「空いていた」と読んで正当な batch を押し出しと判定する。合流分を先に載せる順は、判断 16
 * の「合流できる品目で最初の batch を組み、残りは進めた表で置く」そのものである（レビュー追記・2026-09-06）。
 *
 * Acceptance_Gate（admit.ts）・確定計画の合成（commit.ts）・自前解の性質検査（Property 17）が同じ述語を読む。合成が
 * 読むのは、採用済み一片が採用時の錨の上に組まれているためである——錨は Boil_Sync で動く（無関係な Timer が仲間の
 * 窓の内側で始まると仲間の adjustment が変わる）。錨が動けば合流分の `anchor` はもう仲間に無く（(a) が破れる）、一片は
 * 切られて自前解が現在の錨で置き直す（±h_i の内側の動きでも同じ——錨は等号で運ぶ約束であり、近似では運ばない）。
 * `anchor` を持たない配置は、−Δ でまだ合流できるなら押し出し、もう届かないなら正当な後続の batch になる。どれも導出
 * だけで判定でき、採用時の錨を持たなくてよい。
 *
 * **合流する部分集合と pack の切り方を外部解に強制しない（ADR-0007）。** 残り容量が 1 品分で自前解が A を選んでも、
 * 外部解が B を合流させ A を後ろに置く一片は、A が B の後では合流できない（押し出しではない）ので守っている。
 *
 * `release` / `lifts` は当該一片を置く前の表（計画順に進めた表）。
 */
export function keepsAnchor(
  placements: readonly Placement[],
  release: SlotRelease,
  lifts: LiftTable,
  siblings: readonly EpochMillis[] | null,
  targets: readonly PendingOrder[],
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): boolean {
  // (a) 錨の主張は現在の仲間の実効 endTime のいずれかに等しい（仲間が無ければ主張そのものが立たない）。
  const claimsAbsent = placements.some(
    (placement) => placement.anchor !== null && !(siblings ?? []).includes(placement.anchor),
  );
  if (claimsAbsent) return false;
  if (siblings === null) return true;
  const resolved = placements.map((placement) => resolveBoil(placement, targets, presets));
  // 走行中の最早より h_i を超えて手前に散らさない。
  const earliestSibling = siblings[0]!;
  const scattered = resolved.some(({ placement, boilMillis }) => {
    const window = boilMillis === null ? 0 : joinWindowMillis(boilMillis, params);
    return placement.serveAt < earliestSibling - window;
  });
  if (scattered) return false;

  // pack を順に載せる（(b)〜(d)）。
  let free = release;
  let ends = lifts;
  for (const pack of packsOf(resolved)) {
    if (!fitsPack(pack, free, ends, siblings, params)) return false;
    const placed = pack.map(({ placement }) => placement);
    free = advanceRelease(free, placed);
    ends = advanceLifts(ends, liftsOf(placed));
  }
  // 1 品の配置は pack で進めた表の上で押し出しを見る。
  const singles = resolved
    .filter(({ placement }) => placement.anchor === null)
    .sort((one, other) => byUnitOrder(one.placement, other.placement));
  return !isPushedOut(singles, free, ends, siblings, params);
}

/** 配置と、その品目の茹で時間（品目が計画対象に無い・麺種がプリセットに無いなら null）。 */
interface Resolved {
  readonly placement: Placement;
  readonly boilMillis: number | null;
}

/** 配置の品目を計画対象から引いて茹で時間を解決する。 */
function resolveBoil(
  placement: Placement,
  targets: readonly PendingOrder[],
  presets: readonly NoodlePreset[],
): Resolved {
  const order = targets.find((candidate) => refersTo(placement, candidate));
  return { placement, boilMillis: order === undefined ? null : boilMillisOf(order, presets) };
}

/** 単位の順——serveAt 昇順・同値は startAt 昇順・代表釜の番号（判定を配置の並び順に依存させない・AC 9.10）。 */
function byUnitOrder(placement: Placement, other: Placement): number {
  return (
    placement.serveAt - other.serveAt ||
    placement.startAt - other.startAt ||
    slotOf(placement.slotIds[0]) - slotOf(other.slotIds[0])
  );
}

/** `anchor` を持つ配置を「同じ anchor・同じ serveAt」の pack にまとめ、単位の順に並べる（AC 9.10）。 */
function packsOf(resolved: readonly Resolved[]): readonly (readonly Resolved[])[] {
  const packs = new Map<string, Resolved[]>();
  for (const entry of resolved) {
    if (entry.placement.anchor === null) continue;
    const key = `${entry.placement.anchor} ${entry.placement.serveAt}`;
    const pack = packs.get(key);
    if (pack === undefined) packs.set(key, [entry]);
    else pack.push(entry);
  }
  return [...packs.values()]
    .map((pack) => pack.sort((one, other) => byUnitOrder(one.placement, other.placement)))
    .sort((pack, other) => byUnitOrder(pack[0]!.placement, other[0]!.placement));
}

/**
 * pack が (b) 手前に散らさず、(c) 集合として合流でき、(d) 延期の理由が窓だけか（AC 9.10・keepsAnchor の注記）。
 *
 * 茹で時間が引けない配置を含む pack は成立しない——(c)(d) が判定できず、その品目は自前解も置かない。
 * `release` / `lifts` は手前の単位で進めた表。
 */
function fitsPack(
  pack: readonly Resolved[],
  release: SlotRelease,
  lifts: LiftTable,
  siblings: readonly EpochMillis[],
  params: ScheduleParams,
): boolean {
  // pack は同じ anchor・同じ serveAt の配置の非空の集まり（packsOf が作る）。
  const anchor = pack[0]!.placement.anchor!;
  const serveAt = pack[0]!.placement.serveAt;
  let candidate = Number.NEGATIVE_INFINITY;
  let span = 0;
  for (const { placement, boilMillis } of pack) {
    if (boilMillis === null) return false;
    const window = joinWindowMillis(boilMillis, params);
    if (serveAt < anchor - window) return false; // (b)
    const frees = placement.slotIds.map((slotId) => release[slotOf(slotId)]);
    // 表の外を指す釜は存在しない釜であり、そこからは合流できない。
    if (frees.some((at) => at === undefined)) return false;
    const earliestOwn = Math.max(...(frees as number[])) + boilMillis;
    if (earliestOwn > anchor + window) return false; // (c)
    // (c) が成り立てば錨に h_i で届くので候補は必ず在る（起こらないものに防御を置かない）。
    const target = joinTarget(earliestOwn, siblings, boilMillis, params)!;
    if (target.serveAt > candidate) candidate = target.serveAt;
    span += placement.slotIds.length;
  }
  return firstFit(lifts, candidate as EpochMillis, span, params) === serveAt; // (d)
}

/**
 * 走行中の錨に合流できたのに、候補時刻からの `firstFit` より後ろへ押し出された配置が在るか（ハード制約 (e)・判断 16・
 * ADR-0007）。`anchor` を持たない配置を単位の順に、手前の単位で進めた表の上で見る（AC 9.10）。
 *
 * 「始めたまとまりを崩さない」は目的関数では守れない——卓同期項は最遅からの遅れの和なので、合流できない 1 本が
 * 在るとき「合流できる品目まで全員を最後へ遅らせる」配置の方が点が良く（合流分の遅れが消える）、ソフトに
 * 置けば外部解がその形で自前解を上書きする。ゆえに feasibility の側に置く。主張は「揃えたい」という好みでは
 * なく「始めたまとまりを崩す計画は成立していない」という構造のもの。
 *
 * 判定：品目の `slotSpan` 個の釜が最も早く空く時刻 + 茹で時間（earliest）が「最遅の仲間 + h_i」以下——窓を当てる
 * 前にいずれかの仲間に合流できた——なら保護の対象で、判断 18 の候補時刻（`joinTarget`）から span で `firstFit` した
 * 時刻より後ろに置かれていれば押し出し。合流できない品目は保護の対象外で、仲間 60 秒・残りが茹で 300 秒と 600 秒
 * を後の batch で 600 秒に揃える配置は押し出しではない。窓による必要な延期も押し出しではない（走行中 4 本が 60 秒に
 * 上がる表で残りを 105 秒に置く一片は守っている）。錨が過去（走行中が boiled だけ）なら earliest は必ず錨 + h_i を
 * 超え（解放表の下限が now）、何も押し出しにならない。茹で時間が引けない配置は判定しない（合流の可否が定まらない）。
 *
 * `release` / `lifts` は pack を載せた後の表。Acceptance_Gate と自前解の性質検査が keepsAnchor 経由で共用する。
 */
function isPushedOut(
  singles: readonly Resolved[],
  release: SlotRelease,
  lifts: LiftTable,
  siblings: readonly EpochMillis[],
  params: ScheduleParams,
): boolean {
  const latest = siblings[siblings.length - 1]!;
  let free = release;
  let ends = lifts;
  for (const { placement, boilMillis } of singles) {
    if (boilMillis !== null) {
      const span = placement.slotIds.length;
      const window = joinWindowMillis(boilMillis, params);
      // span 個の釜が最も早く空く時刻は解放時刻の span 番目に小さい値（釜が足りなければ合流できない）。
      const nth = [...free].sort((at, other) => at - other)[span - 1];
      const earliest = nth === undefined ? Number.POSITIVE_INFINITY : nth + boilMillis;
      if (earliest <= latest + window) {
        // 合流できた品目は候補時刻を必ず持つ（joinTarget は最遅の仲間 + h_i 以内なら非 null）。
        const target = joinTarget(earliest, siblings, boilMillis, params)!;
        const expected = firstFit(ends, target.serveAt, span, params);
        // 1 品で上げ窓の上限を超える品目（expected が null）は置き場所が無く、押し出しの対象にならない（AC 9.12）。
        if (expected !== null && placement.serveAt > expected) return true;
      }
    }
    free = advanceRelease(free, [placement]);
    ends = advanceLifts(ends, liftsOf([placement]));
  }
  return false;
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
 * Continuity — 自前解が前回の提案を残すための文脈（plan-stability Requirement 3・design Component 5）。
 *
 * `changeContext` は変更費用の比較の文脈（旧 Shown_Plan・遷移後の Timer・比較の時点の now・pending・presets）、
 * `shownByKey` はその Shown_Plan を品目の鍵で引く表（釜の第一候補・並びの同値・前回のまとまり）、`heads` はその
 * Head、`slices` はこの計画で手前に置いた一片（列の候補配置を仮に置いた計画の「列の外」）。null は比較の相手なし。
 * 生成器で前回を再現する旗（かつての `faithful`）は無い——前回そのものは復元（`retain`）が候補にする（Requirement 6 判断 12）。
 */
interface Continuity {
  readonly changeContext: ChangeContext;
  readonly shownByKey: ReadonlyMap<ItemKey, ShownItem>;
  /** 旧 Shown_Plan の Head（比較の時点の now・遷移後の Timer 集合で導く）。「前回の先頭を今の窓に残す」候補が読む。 */
  readonly heads: ReadonlySet<ItemKey>;
  readonly slices: readonly PlanSlice[];
}

/**
 * 列の局所比較に要る Continuity——いま置いている群の鍵と、その群で先に置いた配置。列の候補配置を足せば、
 * 変更費用を数える途中の計画（手前の一片 ＋ この群の一片）が組める。
 */
interface ColumnContinuity extends Continuity {
  readonly tableKey: string;
  readonly placed: readonly Placement[];
}

/** 列の配置を置いた後の Continuity（残りの列・分割の残りが読む）。 */
function after(
  continuity: ColumnContinuity | null,
  placed: readonly Placement[],
): ColumnContinuity | null {
  return continuity === null ? null : { ...continuity, placed: [...continuity.placed, ...placed] };
}

/**
 * 1 つの Table_Group を配置する。
 *
 * **茹で時間が引けない品目は配置しない（絞るのは `placeableTargets`）。** 未知の noodleType は Order_Ingress では弾かれる
 * （toPendingOrders が presets と突き合わせる）が、永続した待ち行列が設定の差し替えを跨いだ後には
 * 起こり得る——プリセットから消えた麺種の品目が残る経路が実在する。そのとき既定の茹で時間を当てれば
 * 「その秒数で茹でれば良い」という嘘の計画ができる。ゆえに置かない。品目は待ち行列に残って表示され、
 * 推奨だけが付かない（計画対象を超えた品目と同じ扱い）。
 *
 * **1 品で上げ窓の上限（arms + HELPER_ARMS）を超える品目も配置しない（AC 9.12・同じく `placeableTargets`）。** いつまで
 * 待っても入る窓が無く（`firstFit` は null）、茹で時間が引けない品目と同じ扱いに落とす。ラジアルからは始められる。
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
 * 空くか。合流した品目は走行中と同じ serveAt を候補に持ち、残りは従来どおり詰める。走行中が無い卓は一行も変えない
 * （待つことも含めてまとめる・AC 1.8）。
 *
 * **上げ表を群の内側でも進める（判断 20）。** 合流分・batch の順に置き、置いた上がりで表を進めてから次を置く。
 * 卓の成員の提供時刻（走行中の仲間＋この群で先に置いた配置）も同じ順で積み、局所費用の卓の遅れに読ませる。
 *
 * **固定した配置（`fixed`・再生成で残す「今」の配置・startable-placement Component 3′）。** 群の品目のうち `fixed` に在る
 * ものは**その配置のまま**出力に加え（`assignSlots` を通さない・表は呼び手がその占有で進めてある）、その `serveAt` を局所
 * 費用の卓の成員 `members` にだけ足す。**卓の成員表（走行中の錨）には足さない**——固定配置は未開始の計画であって走行中の
 * 事実ではなく、足せば実在しない Timer に合流でき、`keepsAnchor` (a) が現実の Timer に対して失敗する（レビュー実走：走行中
 * なしで同卓の「600 秒麺を今・60 秒麺を 540 秒後」に固定配置を成員として足すと、後者に `anchor: 600` が付く）。残りの
 * 品目は従来どおり置く（下限・取り置き・列の幅の補正は無い——前回そのものは復元が候補にするので、生成器が前回を再現する
 * 必要は無い）。返す並びは固定分・合流分・batch の順。
 */
function placeGroup(
  group: TableGroup,
  release: SlotRelease,
  lifts: LiftTable,
  siblings: readonly EpochMillis[] | null,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
  continuity: Continuity | null,
  fixed: readonly Placement[],
): readonly Placement[] {
  // 残りの batch の錨は走行中の最遅（表の値は昇順ゆえ末尾）。合流の判定は個々の走行中の提供時刻で行う。
  const runningAnchor = siblings === null ? null : siblings[siblings.length - 1]!;
  // 置ける品目だけを置く（絞る規則は `isPlaceable` ただ一つ＝`placeableTargets` と同じ定義）。置ける品目は茹で時間が
  // 必ず引けるので、`toBoiling` の null の除外は型の関門にすぎない。
  const cap = liftCap(params);
  const boilings = group.items
    .filter((order) => isPlaceable(order, presets, cap))
    .map((order) => toBoiling(order, presets))
    .filter((boiling): boiling is Boiling => boiling !== null);
  // 同時に置ける幅＝置ける釜の数。解放表の長さが「置ける場所」の全体を語る（表の外に釜は無い）。再生成で後の一片の「今」に
  // 取り置かれた釜（解放が無限大・`revalidate`）は数えない——数えれば batch が置ける釜より広くなり、無限大の釜を取って配置の
  // 時刻が無限大になる（上げ表の走査が止まらない）。
  const capacity = release.filter((at) => Number.isFinite(at)).length;
  const fixedByKey = new Map(fixed.map((placement) => [itemKeyOf(placement), placement]));
  const own = boilings.flatMap((boiling) => fixedByKey.get(itemKeyOf(boiling.order)) ?? []);
  if (capacity === 0) return own;

  const placements: Placement[] = [...own];
  let free = release;
  let ends = lifts;
  // 卓の成員の提供時刻。走行中の仲間と固定分から始め、置いた配置を足す（局所費用の卓の遅れ・AC 9.8）。
  let members: readonly EpochMillis[] = [
    ...(siblings ?? []),
    ...own.map((placement) => placement.serveAt),
  ];
  const collect = (added: readonly Placement[]) => {
    placements.push(...added);
    free = advanceRelease(free, added);
    ends = advanceLifts(ends, liftsOf(added));
    members = [...members, ...added.map((placement) => placement.serveAt)];
  };
  // 列の局所比較が読む文脈。この群で先に置いた配置（固定分を含む）は列を置くたびに増える。
  const column = (): ColumnContinuity | null =>
    continuity === null
      ? null
      : { ...continuity, tableKey: group.tableKey, placed: [...placements] };

  // 残りの品目。取り置きで置ける釜が品目の span に足りない品目は置けない（構造上は起こらない——後の一片の「今」は手前の
  // 一片が使わない釜にしか無い。起きれば一片が欠けて性質 5.10 の `isStale` が検出する）。
  let remaining = boilings.filter(
    (boiling) => !fixedByKey.has(itemKeyOf(boiling.order)) && boiling.order.slotSpan <= capacity,
  );
  if (siblings !== null) {
    // 合流分は品目ごとに「間に合う最早の走行中」を候補にし、候補ごとの列を上げ窓に当てて置く。
    // **合流の判定は置いた後の解放表で繰り返す。** 合流分の釜は判定の間は取り置き（joinable）、置いてはじめて
    // 実際の提供時刻で空く。先に合流した短い品目の釜がその上がりで空けば、次の品目がその釜から後の仲間に届く
    // ことがある（仲間 41.85 秒と 145 秒・Thin が 45 秒に上がった釜 4 から Thick が 45 秒に投入して 145 秒に
    // 届く）。一度の判定で残りを batch へ回すと、ゲート（isPushedOut・置いた後の表で合流できたかを見る）が
    // その配置を押し出しと判定する（Property 17 の実測）。どの品目も合流できなくなるまで回す。
    for (;;) {
      const joined = joinable(remaining, free, siblings, params, continuity);
      if (joined.length === 0) break;
      collect(placeJoined(joined, ends, members, params, column()));
      remaining = remaining.filter((boiling) => !joined.some((entry) => entry.boiling === boiling));
    }
  }

  let batch: Boiling[] = [];
  let span = 0;
  const flush = () => {
    if (batch.length === 0) return;
    collect(placeBatch(batch, free, ends, members, runningAnchor, params, column()));
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
 * 合流を確定した品目——釜の対応づけと合流先（候補時刻と錨）。joinable が決め、placeJoined がそのまま置く。
 *
 * 判定と配置が同じ対応づけを読むために持つ。判定が集合ごとに釜を選び直す形（かつての fits）では、単独なら錨に届く
 * 品目が集合に入ると別の釜を取って届かず batch へ回り、ゲート（isPushedOut・品目ごとに釜の空きを見る）が自前解を
 * 押し出しと判定する corner が在った（design Component 3「間に合う集合が在れば必ず間に合わせる」が成り立たない。
 * 21.5 のレビュー P2）。
 */
interface Joined {
  readonly boiling: Boiling;
  /** 割り当てた釜（番号）。合流分の中で相異なる。 */
  readonly slots: readonly number[];
  /** 判断 18 の候補時刻と錨（AC 9.9）。 */
  readonly target: { readonly serveAt: EpochMillis; readonly anchor: EpochMillis };
}

/**
 * 走行中の錨に合流できる品目。正準順序の貪欲で、**先に合流を確定した品目が釜を取った上で**次を単独で判定する
 * （design Component 3）。合流の本数を最大化しない——最適な部分集合の選択は外部ソルバの役目で、自前解に要るのは
 * 決定性だけ（正準順序と assignSlots の全順序から従う）。
 *
 * 合流できるとは、品目の slotSpan 個の相異なる釜が最も早く空く時刻 + 茹で時間（earliest）でいずれかの走行中に
 * h_i 以内で届くこと（`joinTarget` が非 null・判断 18）。「錨 + h_i − 茹で時間 までに釜が空く」と同値で、錨 + h_i
 * までの残りより茹で時間が長い品目は、解放表の下限が now ゆえ必ず外れる。
 *
 * **確定した品目の釜は群の内側で再利用しない（`reserve`・解放時刻を無限大に置く）。** 合流分の実際の提供時刻は
 * 上げ窓を当てるまで決まらない（候補より後ろの窓へ動きうる）ので、候補時刻で空くと見なして次の品目に同じ釜を
 * 与えると、先の品目が上がる前に始める配置になる。残りの batch は合流分を実際に置いた後の解放表で釜を取る。
 */
function joinable(
  boilings: readonly Boiling[],
  release: SlotRelease,
  siblings: readonly EpochMillis[],
  params: ScheduleParams,
  continuity: Continuity | null,
): readonly Joined[] {
  const joined: Joined[] = [];
  let free = release;
  for (const boiling of boilings) {
    // 前回の釜の第一候補（AC 3.1）。候補の時刻は、既存の規則で置いたときの合流先の提供時刻——前回の釜がそこまでに
    // 空けば採り、合流先はその釜の earliest から引き直す（候補より手前に届くことはあっても、後ろへは動かない）。
    const { slotsOfItem, earliest } = assignSlots(
      [boiling],
      free,
      params,
      continuity,
      (base) => joinTarget(base[0]!, siblings, boiling.boilMillis, params)?.serveAt ?? null,
    );
    const target = joinTarget(earliest[0]!, siblings, boiling.boilMillis, params);
    if (target === null) continue;
    joined.push({ boiling, slots: slotsOfItem[0]!, target });
    free = reserve(free, slotsOfItem[0]!);
  }
  return joined;
}

/** 釜を群の内側で取り置く——解放時刻を無限大にして以後の対応づけから外す。入力の表は破壊しない。 */
function reserve(release: SlotRelease, slots: readonly number[]): SlotRelease {
  return release.map((at, slot) =>
    slots.includes(slot) ? (Number.POSITIVE_INFINITY as EpochMillis) : at,
  );
}

/**
 * 合流した品目の置き先——提供時刻の候補と、合流先の走行中（錨）の組。
 *   - いずれかの走行中の提供時刻が earliest から h_i 以内（前後どちらでも）に在れば **earliest** に置く——待たずに
 *     いま始める。数秒の差は Boil_Sync の範囲であり、揃えるために待てば投入のたびに startAt が未来へずれる
 *     （実測：3 本目で Boil_Sync が新しい仲間を別のセットへ 6 秒遅らせ、残りがそれを追いかけた）。錨はその
 *     h_i 以内の走行中のうち最も近いもの（同距離なら早いほう・表は昇順）。
 *   - そうでなければ、earliest より後の最早の走行中に揃える（短い茹での品目が仲間を待って一緒に上がる）。
 *     錨はその走行中そのもの。
 *   - どちらも無ければ null（最遅の仲間にも h_i 以内で届かない＝合流できない）。
 *
 * 錨を提供時刻と一緒に返すのは、`Placement.anchor` を配置の時点で決めるため（AC 9.9）。置いた後に
 * `serveAt` から錨を逆算する形（joinedAnchor）は、上げ窓が `serveAt` を動かすと成り立たない。
 * ここで返す提供時刻は**候補**であり、上げ窓（placeWithLifts）がそれ以降の空いた窓へ動かしうる（判断 20）。
 */
function joinTarget(
  earliest: number,
  siblings: readonly EpochMillis[],
  boilMillis: number,
  params: ScheduleParams,
): { readonly serveAt: EpochMillis; readonly anchor: EpochMillis } | null {
  const window = joinWindowMillis(boilMillis, params);
  let nearest: EpochMillis | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const end of siblings) {
    const gap = Math.abs(end - earliest);
    if (gap <= window && gap < distance) {
      nearest = end;
      distance = gap;
    }
  }
  if (nearest !== null) return { serveAt: earliest as EpochMillis, anchor: nearest };
  const next = siblings.find((end) => end > earliest);
  return next === undefined ? null : { serveAt: next, anchor: next };
}

/**
 * 合流した品目群を置く。各品目の候補は joinTarget——錨に届く品目は錨に、窓の内側で届かない品目は最早に
 * （判断 18）。錨に届く品目を届かない品目の earliest まで遅らせない（placeBatch の「全員を max(earliest) に
 * 揃える」を合流分には使わない——揃える相手は走行中の錨である）。合流先の錨は配置に載せる（AC 9.9）。
 *
 * **候補時刻ごとに列を組み、上げ窓に当てる（AC 9.8）。** 同じ候補の品目が「同じ時刻に上げたい列」であり、
 * placeWithLifts が pack / split を決める。列は候補の昇順に置き、置いた上がりで表を進めてから次の列を置く。
 * 候補時刻が同じなら錨も同じである——earliest に置く場合の錨は h_i 以内で最も近い走行中で、h_i の広い品目でも
 * 狭い品目が持つ最も近いものは変わらず、走行中に揃える場合は錨がその走行中そのもの。ゆえに列は AC 9.10 の
 * pack（同じ anchor・同じ serveAt）の単位と一致し、ゲートと合成が自前解を同じ単位で検証できる。
 *
 * 釜の対応づけは joinable が決めたものをそのまま使う（判定と配置が同じ釜を読む・釜は列を跨いで相異なる）。列が
 * 窓で後ろへ動いても、その列の釜は候補の時点で空いているので feasibility は保たれる。列の順は配置の対応づけと
 * 同じ（茹で時間の長い順・同値は正準順序）。返す並びは joined の順。
 */
function placeJoined(
  joined: readonly Joined[],
  lifts: LiftTable,
  members: readonly EpochMillis[],
  params: ScheduleParams,
  continuity: ColumnContinuity | null,
): readonly Placement[] {
  const byBoil = batchOrder(
    joined.map((entry) => entry.boiling),
    continuity,
  );
  const candidates = [...new Set(joined.map((entry) => entry.target.serveAt))].sort(
    (a, b) => a - b,
  );

  const placed: Placement[] = new Array(joined.length);
  let ends = lifts;
  let ended = members;
  let placedSoFar = continuity;
  for (const candidate of candidates) {
    const indices = byBoil.filter((index) => joined[index]!.target.serveAt === candidate);
    const column = indices.map((index) => ({
      boiling: joined[index]!.boiling,
      slots: joined[index]!.slots,
      anchor: joined[index]!.target.anchor,
    }));
    const result = placeWithLifts(column, candidate, ends, ended, params, placedSoFar);
    indices.forEach((index, position) => {
      placed[index] = result[position]!;
    });
    ends = advanceLifts(ends, liftsOf(result));
    ended = [...ended, ...result.map((placement) => placement.serveAt)];
    placedSoFar = after(placedSoFar, result);
  }
  return placed;
}

/** 茹で時間を解決する。プリセットに無い麺種は解決できない（null）。 */
function toBoiling(order: PendingOrder, presets: readonly NoodlePreset[]): Boiling | null {
  const boilMillis = boilMillisOf(order, presets);
  return boilMillis === null ? null : { order, boilMillis };
}

/**
 * 同時に置ける品目群（Σ slotSpan ≤ 釜の数）を配置し、提供時刻の候補を群の錨に一致させる。
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
 * **錨は候補であり、上げ窓が最終の置き場所を決める（判断 20）。** batch 全員が錨に揃う列を placeWithLifts へ渡し、
 * 窓に載る本数に応じて pack / split する。錨より手前には動かない（firstFit は候補以上）ので、上の逆算の根拠は
 * そのまま生きる。
 *
 * **釜の割当は決定的である。** 長い茹でに早く空く釜を与える（1 品目 1 釜では錨を最小にする対応づけだった）。
 * slotSpan が混在すると最小性は言えないが、要るのは決定性だけで、それは byRelease / byBoil の全順序
 * （同点を index で断つ）から従う。厳密解の供給は外部ソルバの役目である。返す並びは batch の順。
 */
function placeBatch(
  batch: readonly Boiling[],
  release: SlotRelease,
  lifts: LiftTable,
  members: readonly EpochMillis[],
  runningAnchor: EpochMillis | null,
  params: ScheduleParams,
  continuity: ColumnContinuity | null,
): readonly Placement[] {
  // 前回の釜の第一候補（AC 3.1）。候補の時刻は、既存の規則で置いたときの錨から**列のどの塊も上げ窓で置けない最早の時刻**
  // （最小の span で firstFit）まで進めた値——錨の窓が埋まっていれば列はどのみちそこまで待つので、そこまでに空く前回の
  // 釜を採っても列は遅れない。錨そのものを候補にすると、窓が押す列で前回の釜が「間に合わない」と見なされ、同じ時刻に
  // 置かれるのに釜だけが変わる。firstFit は時刻にも span にも単調なので、この時刻より手前に置かれる塊は無い（feasible）。
  const { slotsOfItem, earliest, byBoil } = assignSlots(
    batch,
    release,
    params,
    continuity,
    (base) => {
      const anchor = Math.max(...base, runningAnchor ?? Number.NEGATIVE_INFINITY) as EpochMillis;
      const least = Math.min(...batch.map((boiling) => boiling.order.slotSpan));
      return firstFit(lifts, anchor, least, params) ?? anchor;
    },
  );
  const anchor = Math.max(...earliest, runningAnchor ?? Number.NEGATIVE_INFINITY) as EpochMillis;
  const column = byBoil.map((index) => ({
    boiling: batch[index]!,
    slots: slotsOfItem[index]!,
    // batch は合流ではない。Group_Anchor（走行中の最遅）に揃う場合もそれは下限であって合流先ではなく、
    // 群の所属（`Placement.anchor`）は placeJoined だけが与える（判断 18・AC 9.9）。
    anchor: null,
  }));
  const result = placeWithLifts(column, anchor, lifts, members, params, continuity);
  const placed: Placement[] = new Array(batch.length);
  byBoil.forEach((index, position) => {
    placed[index] = result[position]!;
  });
  return placed;
}

/**
 * 釜と錨が決まり、上げ窓を当てる直前の品目——placeWithLifts の列の要素。
 *
 * 列の順は釜の対応づけの順（茹で時間の長い順・同値は正準順序）。pack / split の接頭辞はこの順で切る（AC 9.8）。
 */
interface Assigned {
  readonly boiling: Boiling;
  /** 割り当てた釜（番号）。候補時刻の時点で空いている。 */
  readonly slots: readonly number[];
  /** 合流先の錨（AC 9.9）。batch は null。 */
  readonly anchor: EpochMillis | null;
}

/** ミリ秒と秒の換算。局所費用は目的関数と同じく秒相当で読むが、ミリ秒のまま比べる（丸めで同点を作らない）。 */
const MILLIS_PER_SECOND = 1000;

/**
 * 同じ時刻に上げたい列を上げ窓に当てて置く（AC 9.8・design Component 10）。
 *
 * 候補 t0（合流の規則か batch の錨）以降で、列を含むすべての窓の負荷が arms + HELPER_ARMS 以下になる最初の
 * 時刻へ置く（`firstFit`・AC 9.4）。Σ span = S について：
 *   - S > arms + HELPER_ARMS：どの時刻にも入らない列なので、**候補の窓の残り容量**（上限 − 既存の負荷。残りが
 *     先頭の品目に足りなければ上限）に収まる最長の非空の接頭辞と残りに割って再帰する（先頭の品目は必ず上限に
 *     収まる——1 品で超える品目は placeGroup が列に入れない・AC 9.12）。
 *   - S ≤ arms：手伝いが要らないので pack（全員を firstFit の時刻へ）。前回の提案が在れば、前回のまとまり・先頭を
 *     残す分割も候補になる（窓が埋まって pack が次の窓へ動くとき、先頭の 1 本だけなら今の窓に残れることがある）。
 *   - その間：pack（全員を同じ窓へ・手伝いを頼む）と split（arms に収まる最長の非空の接頭辞を先に、残りを
 *     進めた表の上で再帰）の**両方を同じ既存の表に対して実際に作り**、局所の費用で安い方を置く。同点は pack。
 *     **品目は不可分**——接頭辞が空（先頭の品目の span が arms を超える・例：arms 1 の大盛）なら split は候補に
 *     ならず pack を置く。
 *
 * 局所の費用 cost(c) = Σ 待ち（serve − 到着・候補を後ろへ動かした分を含む）
 *                   + w_table × Σ 卓の遅れ（走行中の仲間と先に置いた配置を含む成員の、最遅からの差）
 *                   + ΔLift_Overflow（liftOverflow は秒相当を返すので L を重ねて掛けない）
 *                   + Change_Cost（前回の提案が在るとき・秒相当をミリ秒へ）
 * 目的関数と同じ物差しで測るが、目的関数そのものではない（丸めを持ち込まずミリ秒で比べる・卓の内側と
 * 店舗全体の差分に閉じる）。4 人家族（arms 2・L 45・表が空）は pack 330 対 split 330（split の残りも同じ窓に
 * 入る）で同点ゆえ pack、走行中 2 本の窓に 2 品を足す場面は pack が次の窓へ動いても卓の遅れが小さく pack が
 * 勝つ——どちらも「同時に上げる方を置く」（判断 20）。
 *
 * **前回の提案が在れば候補を足し、全候補の最小を採る（plan-stability AC 3.2・design Component 5）。** 「前回のまとまりを
 * 保つ分割」（前回同じ群だった品目を同じ塊に置く・`keepPrevious`）と「前回の先頭を今の窓に残す分割」（旧 Head の品目を
 * 先頭の塊にする・`keepHeads`）で、局所費用には Change_Cost の差分——**先頭の変更 (a) を含む 4 種**——を足す。同点は
 * 前回のまとまりを保つ側、次に前回の先頭を残す側、次に pack。(a) を含めるのは、(b)(c)(d) だけでは最も
 * 守りたい投入対象が動くためである：arms 1・L 45・茹で 600 秒・走行中 2 本が 600 秒に上がる表で、旧提案が A を今・
 * B を 45 秒後なら、両方を 45 秒後へ pack すると業務費用は 45 秒改善するが、A の先頭消失は 90 秒で総費用は 45 秒
 * 悪化する——pack は採らない。Head は列の候補配置を仮に置いた計画（手前の一片 ＋ この群で先に置いた配置 ＋ 列）に
 * 対して導く（`partialChangeCost`・列の外の品目は現在の確定分）。
 *
 * **前回の配置を再現する分割（`restorePrevious`）も候補に置く。** 同じ群（`mates`）でも提供時刻は違い得る——走行中の錨に
 * 合流した群は一つの群のまま、窓が押した品目だけ次の窓に上がる。そのとき前回のまとまりを保つ分割は塊が一つ（pack と
 * 同じ）で前回の配置を出せず、同値の並びを前回の startAt で断った列では split の接頭辞と余りが前回と入れ替わって、
 * 総費用で劣る配置しか候補に残らない（実測：arms 3・走行中 3 本の窓に前回 1 本だけ合流していた卓で、その 1 本が次の
 * 窓へ動き、業務費用 5 秒と変更費用 1 秒の両方が悪化）。前回の serveAt が同じ品目を塊にし、前回の serveAt の昇順に置く。
 * 容量超過の分岐（接頭辞で切る）でも、この 2 候補を足して同じ局所費用で選ぶ。
 *
 * 結果は列と同じ並びで返す（pack も split も前回を保つ分割も、列の順を保つ）。
 */
function placeWithLifts(
  column: readonly Assigned[],
  t0: EpochMillis,
  lifts: LiftTable,
  members: readonly EpochMillis[],
  params: ScheduleParams,
  continuity: ColumnContinuity | null,
): readonly Placement[] {
  if (column.length === 0) return [];
  const cap = liftCap(params);
  const total = spanOf(column);
  if (total > cap) {
    // 先頭の塊は**候補の窓の残り容量**（上限 − t0 を含む窓の既存の負荷）で切る。上限そのもので切ると、走行中が
    // 既に窓の一部を占めているとき先頭の塊が次の窓へ押され、余りの品目だけが今の窓に入る（実測：走行中 1 本の
    // 錨に 5 本が合流する列で、先頭 4 本が 45 秒後・余りの 1 本だけが now）。残りが先頭の品目に足りなければ
    // 今の窓には誰も入らないので、上限で切る。
    const room = cap - loadWith(lifts, t0, 0, params);
    const first = column[0]!.boiling.order.slotSpan;
    const head = longestPrefixWithin(column, room >= first ? room : cap);
    const placedHead = placeWithLifts(head, t0, lifts, members, params, continuity);
    const placedRest = placeWithLifts(
      column.slice(head.length),
      t0,
      advanceLifts(lifts, liftsOf(placedHead)),
      [...members, ...placedHead.map((placement) => placement.serveAt)],
      params,
      after(continuity, placedHead),
    );
    const cut = [...placedHead, ...placedRest];
    // 接頭辞の切り方は列の並びに従うので、同値の並びを前回の startAt で断った列では前回同じ群だった品目が接頭辞の
    // 内と外に割れる（実測：3 品の卓・上限 4・Σ span 5 で、前回 pack した 2 品のうち後ろの 1 品が接頭辞から外れ、
    // 業務費用が同点のまま前回と違う分割になる）。前回のまとまりを保つ分割をここでも候補にし、局所費用で選ぶ。
    if (continuity === null) return cut;
    return cheapest(
      [
        restorePrevious(column, t0, lifts, members, params, continuity),
        keepPrevious(column, t0, lifts, members, params, continuity),
        cut,
      ],
      column,
      lifts,
      members,
      params,
      continuity,
    );
  }
  // S ≤ arms + HELPER_ARMS なので firstFit は必ず時刻を返す（null は span が上限を超えるときだけ）。
  const pack = placeAt(column, firstFit(lifts, t0, total, params)!);
  // 候補は優先順（同点はこの順で先の側）：前回の配置を再現する分割・前回のまとまりを保つ分割・前回の先頭を今の窓に
  // 残す分割・pack・split。前回の提案が無ければ前者 3 つは無い。
  const keeping =
    continuity === null
      ? []
      : [
          restorePrevious(column, t0, lifts, members, params, continuity),
          keepPrevious(column, t0, lifts, members, params, continuity),
          keepHeads(column, t0, lifts, members, params, continuity),
        ];
  // S ≤ arms：手伝いが要らないので pack——ただし窓が埋まっていて pack が次の窓へ動くとき、前回の先頭やまとまりを
  // 今の窓に残す分割は候補になる（列の全員が窓に入らなくても、先頭の 1 本は入ることがある）。
  if (total <= params.arms)
    return cheapest([...keeping, pack], column, lifts, members, params, continuity);
  const prefix = longestPrefixWithin(column, params.arms);
  if (prefix.length === 0)
    return cheapest([...keeping, pack], column, lifts, members, params, continuity);
  const placedPrefix = placeAt(prefix, firstFit(lifts, t0, spanOf(prefix), params)!);
  const placedRest = placeWithLifts(
    column.slice(prefix.length),
    t0,
    advanceLifts(lifts, liftsOf(placedPrefix)),
    [...members, ...placedPrefix.map((placement) => placement.serveAt)],
    params,
    after(continuity, placedPrefix),
  );
  const split = [...placedPrefix, ...placedRest];
  return cheapest([...keeping, pack, split], column, lifts, members, params, continuity);
}

/** 候補（優先順・null は候補にならなかったもの）のうち局所費用が最小のもの。同点は先の候補。 */
function cheapest(
  candidates: readonly (readonly Placement[] | null)[],
  column: readonly Assigned[],
  lifts: LiftTable,
  members: readonly EpochMillis[],
  params: ScheduleParams,
  continuity: ColumnContinuity | null,
): readonly Placement[] {
  let best: readonly Placement[] | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const cost = localCost(candidate, column, lifts, members, params, continuity);
    if (cost < bestCost) {
      best = candidate;
      bestCost = cost;
    }
  }
  // pack は常に候補に在る（null でない）ので、最小は必ず見つかる。
  return best!;
}

/**
 * 前回の先頭を今の窓に残す分割（plan-stability design Component 5 の局所比較・判断 2 (a)）。
 *
 * 列のうち旧 Shown_Plan の Head に在る品目を先頭の塊として候補の時刻の窓に置き（`firstFit`）、残りを進めた表の上で
 * 再帰する。split の接頭辞は arms で切るので、走行中が窓の一部を占めていると接頭辞ごと次の窓へ押され、先頭 1 本だけ
 * なら残れた窓を誰も使わない（実測：arms 2・走行中 3 本が同じ窓に上がる表で、前回「今」だった 1 本が 45 秒後へ動く）。
 * この候補は先頭の本数で切るので、その 1 本を残せる。採るかどうかは局所費用（先頭の消失 2L を含む）が決める。
 *
 * 候補にならない場面は null——列に先頭が無い、または列の全員が先頭（pack と同じ）。結果は列の並びで返す。
 */
function keepHeads(
  column: readonly Assigned[],
  t0: EpochMillis,
  lifts: LiftTable,
  members: readonly EpochMillis[],
  params: ScheduleParams,
  continuity: ColumnContinuity,
): readonly Placement[] | null {
  const isHead = (index: number) => continuity.heads.has(itemKeyOf(column[index]!.boiling.order));
  const indices = column.map((_unused, index) => index);
  const leading = indices.filter(isHead);
  if (leading.length === 0 || leading.length === column.length) return null;
  return placeChunks(
    column,
    [leading, indices.filter((index) => !isHead(index))],
    t0,
    lifts,
    members,
    params,
    continuity,
  );
}

/**
 * 列を塊の列に沿って置く——塊の span が上限以下なら塊ごと `firstFit`（同じ時刻に上げる）、超えれば `placeWithLifts` の
 * 再帰（既存の容量の規則で更に割る）。塊は順に、置いた上がりで進めた表の上に置く。結果は列の並びで返す。
 */
function placeChunks(
  column: readonly Assigned[],
  chunks: readonly (readonly number[])[],
  t0: EpochMillis,
  lifts: LiftTable,
  members: readonly EpochMillis[],
  params: ScheduleParams,
  continuity: ColumnContinuity,
): readonly Placement[] {
  const cap = liftCap(params);
  const placed: Placement[] = new Array(column.length);
  let ends = lifts;
  let ended = members;
  let placedSoFar: ColumnContinuity | null = continuity;
  for (const chunk of chunks) {
    const part = chunk.map((index) => column[index]!);
    const span = spanOf(part);
    const result =
      span <= cap
        ? placeAt(part, firstFit(ends, t0, span, params)!)
        : placeWithLifts(part, t0, ends, ended, params, placedSoFar);
    chunk.forEach((index, position) => {
      placed[index] = result[position]!;
    });
    ends = advanceLifts(ends, liftsOf(result));
    ended = [...ended, ...result.map((placement) => placement.serveAt)];
    placedSoFar = after(placedSoFar, result);
  }
  return placed;
}

/**
 * 前回のまとまりを保つ分割（plan-stability AC 3.2・design Component 5 の第 3 候補）。
 *
 * 列を、Shown_Plan で同じ群だった品目（`mates`・列の内側で連結成分に閉じる）が同じ塊に入るように割り、塊を列の順に
 * 置く——塊の span が上限以下なら塊ごと `firstFit`（同じ時刻に上げる）、超えれば既存の容量の規則で更に割る
 * （`placeWithLifts` の再帰）。前回に無い品目は自分だけの塊（新規に増えた品目は守る相手を持たない）。
 *
 * 候補にならない場面は null——塊が一つ（pack と同じ）か、列のどの品目も前回に無い（保つまとまりが無い）。
 * 塊の並びは列の順（茹で時間の長い順・同値は前回の startAt 順）を保ち、結果も列の並びで返す。
 */
function keepPrevious(
  column: readonly Assigned[],
  t0: EpochMillis,
  lifts: LiftTable,
  members: readonly EpochMillis[],
  params: ScheduleParams,
  continuity: ColumnContinuity,
): readonly Placement[] | null {
  const keys = column.map((assigned) => itemKeyOf(assigned.boiling.order));
  if (!keys.some((key) => continuity.shownByKey.has(key))) return null;
  const chunks = chunksByMates(keys, continuity.shownByKey);
  if (chunks.length <= 1) return null;
  return placeChunks(column, chunks, t0, lifts, members, params, continuity);
}

/**
 * 列の品目（鍵の列）を、Shown_Plan の `mates` で繋がる連結成分に割る。成分は列の内側で閉じ（列の外の相手は辿らない）、
 * 成分の並びと成分の中の並びは列の順。`mates` は対称に持つ（shownPlanOf）が、永続から来た値が片側だけでも成分は繋がる。
 */
function chunksByMates(
  keys: readonly ItemKey[],
  shownByKey: ReadonlyMap<ItemKey, ShownItem>,
): readonly (readonly number[])[] {
  const positionOf = new Map(keys.map((key, index) => [key, index]));
  const chunkOf: number[] = keys.map((_unused, index) => index);
  const rootOf = (index: number): number => {
    let root = index;
    while (chunkOf[root] !== root) root = chunkOf[root]!;
    return root;
  };
  keys.forEach((key, index) => {
    for (const mate of shownByKey.get(key)?.mates ?? []) {
      const other = positionOf.get(mate);
      if (other === undefined) continue;
      const a = rootOf(index);
      const b = rootOf(other);
      // 根は列で先に現れる側に寄せる（成分の代表が列の順を保つ）。
      if (a !== b) chunkOf[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const chunks = new Map<number, number[]>();
  keys.forEach((_unused, index) => {
    const root = rootOf(index);
    const chunk = chunks.get(root);
    if (chunk === undefined) chunks.set(root, [index]);
    else chunk.push(index);
  });
  return [...chunks.entries()].sort(([a], [b]) => a - b).map(([, chunk]) => chunk);
}

/**
 * 前回の配置を再現する分割（plan-stability design Component 5 の実装時の追記）。
 *
 * 列を、Shown_Plan の `serveAt` が同じ品目の塊に割り、塊を前回の `serveAt` の昇順に置く——塊の span が上限以下なら
 * 塊ごと `firstFit`、超えれば既存の容量の規則で更に割る（`keepPrevious` と同じ `placeChunks`）。前回に無い品目は末尾に
 * 自分だけの塊（再現する相手を持たない）。候補にならない場面は null——塊が一つ（pack と同じ）か、列のどの品目も前回に無い。
 */
function restorePrevious(
  column: readonly Assigned[],
  t0: EpochMillis,
  lifts: LiftTable,
  members: readonly EpochMillis[],
  params: ScheduleParams,
  continuity: ColumnContinuity,
): readonly Placement[] | null {
  const keys = column.map((assigned) => itemKeyOf(assigned.boiling.order));
  if (!keys.some((key) => continuity.shownByKey.has(key))) return null;
  const chunks = chunksByServeAt(keys, continuity.shownByKey);
  if (chunks.length <= 1) return null;
  return placeChunks(column, chunks, t0, lifts, members, params, continuity);
}

/** 列の品目（鍵の列）を Shown_Plan の `serveAt` ごとの塊に割る。塊は前回の `serveAt` の昇順、前回に無い品目は末尾に単独。 */
function chunksByServeAt(
  keys: readonly ItemKey[],
  shownByKey: ReadonlyMap<ItemKey, ShownItem>,
): readonly (readonly number[])[] {
  const byServeAt = new Map<number, number[]>();
  const fresh: (readonly number[])[] = [];
  keys.forEach((key, index) => {
    const shown = shownByKey.get(key);
    if (shown === undefined) {
      fresh.push([index]);
      return;
    }
    const chunk = byServeAt.get(shown.serveAt);
    if (chunk === undefined) byServeAt.set(shown.serveAt, [index]);
    else chunk.push(index);
  });
  return [
    ...[...byServeAt.entries()].sort(([a], [b]) => a - b).map(([, chunk]) => chunk),
    ...fresh,
  ];
}

/** 列の Σ span。 */
function spanOf(column: readonly Assigned[]): number {
  return column.reduce((sum, assigned) => sum + assigned.boiling.order.slotSpan, 0);
}

/** Σ span が limit に収まる最長の接頭辞（先頭の品目が limit を超えれば空）。 */
function longestPrefixWithin(column: readonly Assigned[], limit: number): readonly Assigned[] {
  let span = 0;
  let length = 0;
  for (const assigned of column) {
    if (span + assigned.boiling.order.slotSpan > limit) break;
    span += assigned.boiling.order.slotSpan;
    length++;
  }
  return column.slice(0, length);
}

/** 列の全員を同じ提供時刻に置く。開始時刻は茹で時間の逆算（serveAt ≥ 候補 ≥ earliest ゆえ釜の解放を下回らない）。 */
function placeAt(column: readonly Assigned[], serveAt: EpochMillis): readonly Placement[] {
  return column.map(({ boiling, slots, anchor }) => ({
    externalOrderId: boiling.order.externalOrderId,
    itemIndex: boiling.order.itemIndex,
    slotIds: slotIdsOf(slots),
    startAt: (serveAt - boiling.boilMillis) as EpochMillis,
    serveAt,
    anchor,
  }));
}

/**
 * 釜番号の列を配置の slotIds へ写す。slotId はスロット番号の文字列表現（domain の slotOf = Number(slotId) の逆・
 * 要件12.5）。非空は構成から従う（slotSpan ≥ 1・domain の SLOT_SPAN_MIN）ので先頭と残りに分けて型へ載せる。
 */
function slotIdsOf(slots: readonly number[]): NonEmptyArray<SlotId> {
  const [head, ...tail] = slots;
  return [String(head!) as SlotId, ...tail.map((slot) => String(slot) as SlotId)];
}

/**
 * 列の配置の局所費用（ミリ秒相当）。placeWithLifts の pack / split / 前回を保つ分割の比較にだけ用いる。
 *
 * 卓の遅れは成員（走行中の仲間・先に置いた配置・この列）の最遅からの差の和で、目的関数の Table_Lag と同じ形。
 * 手伝いの費用は「この列を足す前後の Lift_Overflow の差」——既存の表が既に超えている窓の費用は候補に依らないので
 * 差分だけが比較に効く。変更費用（plan-stability）は、手前の一片とこの群で先に置いた配置に列の候補配置を足した途中の
 * 計画に対して数える（`partialChangeCost`・列に依らない組の費用は候補の間で定数）。秒相当をミリ秒へ揃えて足す。
 */
function localCost(
  placed: readonly Placement[],
  column: readonly Assigned[],
  lifts: LiftTable,
  members: readonly EpochMillis[],
  params: ScheduleParams,
  continuity: ColumnContinuity | null,
): number {
  let wait = 0;
  for (const [index, placement] of placed.entries()) {
    wait += placement.serveAt - column[index]!.boiling.order.arrivalTime;
  }
  const serves = [...members, ...placed.map((placement) => placement.serveAt)];
  const latest = Math.max(...serves);
  let lag = 0;
  for (const serveAt of serves) lag += latest - serveAt;
  const overflow =
    liftOverflow(advanceLifts(lifts, liftsOf(placed)), params) - liftOverflow(lifts, params);
  const change =
    continuity === null
      ? 0
      : partialChangeCost(
          {
            slices: [
              ...continuity.slices,
              { tableKey: continuity.tableKey, placements: [...continuity.placed, ...placed] },
            ],
          },
          continuity.changeContext,
          params,
        );
  return wait + params.tableSyncWeight * lag + (overflow + change) * MILLIS_PER_SECOND;
}

/**
 * 品目群への釜の対応づけと、各品目の earliest（全釜の解放時刻の最大 + 茹で時間）、対応づけの順（byBoil）。
 *
 * placeBatch（batch の配置）と joinable（合流の判定・その対応づけを placeJoined がそのまま置く）が**同じ対応づけ**を
 * 読む唯一の場所。二箇所に書けば「合流できる」と判定した品目が、置くときには別の釜を取って錨に届かない、という
 * 食い違いが生まれる。
 *
 * 長い茹でから順に、早く空く釜を slotSpan 個ずつ連続した塊で配る（1 品目 1 釜では錨を最小にする対応づけ
 * だった。slotSpan が混在すると最小性は言えないが、要るのは決定性だけで、byRelease / byBoil の全順序——
 * 同点を index で断つ——から従う）。byBoil は上げ窓を当てる列の順でもある（AC 9.8・接頭辞をこの順で切る）。
 *
 * **前回の釜の第一候補（plan-stability AC 3.1）。** 前回の提案（`continuity`）が在れば、まず既存の規則で対応づけて
 * 列の候補時刻（`candidateAt`——batch なら錨、合流なら合流先の提供時刻）を得て、品目ごとに前回の釜がその時刻までに
 * 空くか（`chooseSlots` の `preferred`）を byBoil の順に見る。空く品目は前回の釜を取り置き、残りの品目は残った釜に
 * 既存の対応づけで落とす（品目ごとに選び直すと対応づけの規則が二つになる）。前回の釜を採ったことで列の候補が
 * 遅れる（残りの品目の earliest が候補を超える）なら、既存の規則の対応づけへ戻る——前回の釜は候補の時刻の内側で
 * だけ守り、業務費用を黙って悪化させない。前回の釜が候補に間に合わなければ既存の規則（釜の変更費用 L を払う・AC 3.3）。
 */
function assignSlots(
  batch: readonly Boiling[],
  release: SlotRelease,
  params: ScheduleParams,
  continuity: Continuity | null,
  candidateAt: (earliest: readonly number[]) => number | null,
): {
  readonly slotsOfItem: readonly (readonly number[])[];
  readonly earliest: readonly number[];
  readonly byBoil: readonly number[];
} {
  const byBoil = batchOrder(batch, continuity);
  const base = distribute(batch, byBoil, release, params);
  if (continuity === null) return base;
  const deadline = candidateAt(base.earliest);
  if (deadline === null) return base;

  const slotsOfItem: (readonly number[] | undefined)[] = new Array(batch.length);
  let free = release;
  for (const index of byBoil) {
    const boiling = batch[index]!;
    const shown = continuity.shownByKey.get(itemKeyOf(boiling.order));
    if (shown === undefined) continue;
    const preferred = [...new Set(shown.slotIds.map(slotOf))];
    const chosen = chooseSlots(
      boiling.order.slotSpan,
      free,
      params,
      preferred,
      deadline - boiling.boilMillis,
    );
    // 前回の釜が採れた品目だけを取り置く（採れなければ残りの品目と一緒に既存の対応づけへ）。
    if (!sameSlots(chosen, preferred)) continue;
    slotsOfItem[index] = chosen;
    free = reserve(free, chosen);
  }
  const deferred = byBoil.filter((index) => slotsOfItem[index] === undefined);
  if (deferred.length === batch.length) return base;
  const rest = distribute(
    deferred.map((index) => batch[index]!),
    deferred.map((_unused, position) => position),
    free,
    params,
  );
  deferred.forEach((index, position) => {
    slotsOfItem[index] = rest.slotsOfItem[position]!;
  });
  const assigned = slotsOfItem as readonly (readonly number[])[];
  const earliest = batch.map(
    (boiling, index) =>
      Math.max(...assigned[index]!.map((slot) => release[slot]!)) + boiling.boilMillis,
  );
  if (Math.max(...earliest) > deadline) return base;
  return { slotsOfItem: assigned, earliest, byBoil };
}

/** 既存の規則の対応づけ——釜の組を一度に選び、早く空く順に長い茹でから slotSpan 個ずつ配る。 */
function distribute(
  batch: readonly Boiling[],
  byBoil: readonly number[],
  release: SlotRelease,
  params: ScheduleParams,
): {
  readonly slotsOfItem: readonly (readonly number[])[];
  readonly earliest: readonly number[];
  readonly byBoil: readonly number[];
} {
  const totalSpan = batch.reduce((sum, boiling) => sum + boiling.order.slotSpan, 0);
  const slots = chooseSlots(totalSpan, release, params);
  const byRelease = [...slots].sort(
    (slot, other) => release[slot]! - release[other]! || slot - other,
  );
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
  return { slotsOfItem, earliest, byBoil };
}

/**
 * batch の並び——茹で時間の長い順・同値は**前回の `startAt` 順**（plan-stability AC 3.2）・それも同値なら正準順序
 * （batch の index）。前回に無い品目は前回に在る品目の後ろ（守る順を持たない）。
 *
 * 前回の順を先に使うのは、pack / split の接頭辞をこの順で切る（AC 9.8）ため——同値を正準順序で断つと、前回
 * 「先に上げる」と示した品目が後ろの塊へ回り、順の逆転（Change_Cost (c-2)）を自前解自身が作る。
 */
function batchOrder(batch: readonly Boiling[], continuity: Continuity | null): readonly number[] {
  const shownStartAt = (index: number): number | null =>
    continuity?.shownByKey.get(itemKeyOf(batch[index]!.order))?.startAt ?? null;
  return batch
    .map((_unused, index) => index)
    .sort(
      (index, other) =>
        batch[other]!.boilMillis - batch[index]!.boilMillis ||
        compareShownStartAt(shownStartAt(index), shownStartAt(other)) ||
        index - other,
    );
}

/** 前回の startAt の比較。無い側を後ろへ、両方無ければ同値。 */
function compareShownStartAt(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a - b;
}

/** 釜の組の一致（同じ本数で同じ番号の集合）。 */
function sameSlots(slots: readonly number[], other: readonly number[]): boolean {
  return slots.length === other.length && other.every((slot) => slots.includes(slot));
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
 * **前回の釜の第一候補（plan-stability AC 3.1）。** `preferred` が count 本の相異なる実在の釜で、そのすべてが `freeBy`
 * までに空く（解放時刻 ≤ freeBy＝候補の提供時刻 − 茹で時間）ならそれを採る。そうでなければ上の規則へ落ちる
 * （前回の釜が埋まっていれば動く・AC 3.3）。候補の時刻までに空くなら、いま埋まっていても採る——待たされる列の
 * 候補は前回の釜が空く前には来ないので、前回の釜を採ることで列が遅れることはない。
 *
 * count ≤ release.length を前提とする（呼び出し側が釜の数で分割している）。
 */
function chooseSlots(
  count: number,
  release: SlotRelease,
  params: ScheduleParams,
  preferred?: readonly number[],
  freeBy?: number,
): readonly number[] {
  if (
    preferred !== undefined &&
    freeBy !== undefined &&
    preferred.length === count &&
    new Set(preferred).size === count &&
    preferred.every((slot) => {
      const at = release[slot];
      return at !== undefined && at <= freeBy;
    })
  ) {
    // 並びは既存の規則と同じ「早く空く順・同値は index 順」（配置の slotIds の並びが規則で揺れない）。
    return [...preferred].sort((slot, other) => release[slot]! - release[other]! || slot - other);
  }
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

/** slot 間距離。尺度の正本は domain/store.ts の slotDistance ただ一つ（距離を二度定義しない）。 */
function distanceBetween(slot: number, other: number, params: ScheduleParams): number {
  return slotDistance(slot, other, params.unitOrigins, params.slotOffsets);
}
