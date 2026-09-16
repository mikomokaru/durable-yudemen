// engine/lift.ts — 上げ窓（Lift_Window）。走行中と計画済みが「いつ上がるか」を並べ、腕で上げられる本数に
// 合わせて新しい配置の置き場所を決める純粋関数群。cloudflare:workers にも storage にも触れない。
//
// 釜の解放表（initialRelease・「その釜がいつ空くか」）・卓の成員表（tableMembers・「その卓がいつ上がるか」）と
// 同じ資格の**第三の表**で、「店舗全体でいつ上がるか」を持つ。状態ではない——running からの導出値であり、
// 計画のたびに作って捨てる（lift-group-planning 判断 20・ADR-0009）。
//
// 腕を釜と同じ資源として占有表に載せる形は採らない（ADR-0009 の却下案）。扱うのは「走行中の上がり時刻を避けて
// 置く」ことで、表は上がり時刻の並びそのものである。arms はソフト（超えた分は手伝いを頼む費用・liftOverflow）、
// arms + HELPER_ARMS はハード（成立しない・firstFit / ゲートの (f)）。この 2 段は ADR-0002「計画では arms は
// ソフト」を保ったまま、ソフトの上限（手伝いの分）と上げの間隔だけを足す。
//
// ここに置くのは表の導出と窓の数え方だけで、pack / split の局所費用比較（placeWithLifts）は schedule.ts、
// 採点への組み込みは objective.ts、ゲートと合成での検査は admit.ts / commit.ts の関心事である。

import type { Timer } from "./timer";
import type { EpochMillis } from "./types";
import { adjustedEndTime } from "./project";
import { HELPER_ARMS } from "../domain/store";

/**
 * Lift — 上がり 1 件。at は実効 endTime（走行中）または serveAt（計画済み）、span は上がる本数（slotSpan・大盛は 2）。
 *
 * 走行中か計画済みかを区別しない。窓の負荷は「その時刻に何本上がるか」だけで決まり、上がりの出所は上限にも
 * 費用にも効かない（AC 9.3）。
 */
export interface Lift {
  readonly at: EpochMillis;
  readonly span: number;
}

/**
 * LiftTable — 上がり時刻の表。**at 昇順**が不変条件で、initialLifts / advanceLifts だけが作る。
 *
 * 昇順を要るのは liftOverflow の貪欲（前から詰める・AC 9.6）が走査順に依存するためで、表を作る側で並べておけば
 * 読む側が毎回並べ直さずに済む。
 */
export type LiftTable = readonly Lift[];

/**
 * 上げ窓に要るパラメータ。ScheduleParams の部分集合（構造的に代入できる）。
 *
 * ScheduleParams そのものを受けないのは、objective.ts が liftOverflow を読む側になるため——型を objective から
 * 引けば循環になる。窓の意味を定めるのは arms（腕）と liftIntervalSeconds（窓の長さ L）の 2 値だけである。
 */
export interface LiftParams {
  /** 腕の本数。窓に載る本数がこれを超えた分は手伝いの費用（ソフト）。 */
  readonly arms: number;
  /** 上げの間隔（秒・整数）。窓の長さ L であり、手伝いの費用の 1 本あたりの秒相当でもある。 */
  readonly liftIntervalSeconds: number;
}

/** 時刻の単位（ミリ秒）と設定の単位（秒）の換算。目的関数と同じく秒で閉じるため、費用は秒で返す。 */
const MILLIS_PER_SECOND = 1000;

/** 窓の長さ L（ミリ秒）。 */
function windowMillis(params: LiftParams): number {
  return params.liftIntervalSeconds * MILLIS_PER_SECOND;
}

/**
 * ハード上限（arms + HELPER_ARMS）。手伝えるのは物理的に 1 人なので、腕は最大でこれだけ増える（AC 9.2・9.4）。
 *
 * 公開するのは、ゲートと合成が「当該配置を含む窓の負荷がこれを超えるか」を同じ値で判定するため（AC 9.5・9.14）。
 */
export function liftCap(params: LiftParams): number {
  return params.arms + HELPER_ARMS;
}

/** at 昇順・同値は span 昇順。表の並びを running の並び（状態の履歴）に依存させない。 */
function byLift(a: Lift, b: Lift): number {
  return a.at - b.at || a.span - b.span;
}

/**
 * 走行中 Timer から上げ表を作る（AC 9.3）。
 *
 * **boiled に分岐を書かない。** boiled の実効 endTime は過去だが、それは「その時刻に上がった」事実であり、
 * 過去の窓の負荷として表に残す。過去の窓は新しい配置を含まないので上限の検査には掛からず（AC 9.4）、
 * 除外の条件を書く必要がない（解放表が boiled を式ひとつで扱うのと同じ姿勢）。
 *
 * span は占める釜の数（slotIds.length）。開始時に slotIds の数と slotSpan の一致は検査しない（既存 AC 8.3）ので、
 * 走行中については実際に占めている釜の数を上がる本数と読む。
 */
export function initialLifts(running: readonly Timer[]): LiftTable {
  return running
    .map((timer) => ({ at: adjustedEndTime(timer), span: timer.slotIds.length }))
    .sort(byLift);
}

/**
 * 計画済みの配置を上がりへ写す——at は `serveAt`、span は占める釜の数（AC 9.3・9.11）。
 *
 * 配置から表の要素を作る写像はここ一つである。配置（schedule.ts）・合成（commit.ts）・ゲート（admit.ts）が
 * それぞれ書けば、「大盛は 2 本分」（AC 9.11）の数え方が三箇所に散る。走行中を写す `initialLifts` と対になる。
 * `Placement` 型そのものは引かない（schedule.ts がこのモジュールを読む側であり、表は上がりの形だけを知る）。
 */
export function liftsOf(
  placements: readonly { readonly serveAt: EpochMillis; readonly slotIds: readonly unknown[] }[],
): readonly Lift[] {
  return placements.map((placement) => ({
    at: placement.serveAt,
    span: placement.slotIds.length,
  }));
}

/**
 * 確定した上がりで表を進める（合成の尾部再実行と、貪欲法が次の群へ渡す表の更新に用いる）。
 *
 * 入力の表は破壊せず新しい表を返す（純粋変換であることを呼び出し側が確かめずに済む）。
 * 結果は at 昇順（LiftTable の不変条件をここで保つ）。
 */
export function advanceLifts(lifts: LiftTable, added: readonly Lift[]): LiftTable {
  if (added.length === 0) return lifts;
  return [...lifts, ...added].sort(byLift);
}

/**
 * t を含む窓の起点の候補。窓は半開区間 [x, x + L) ゆえ、t を含む起点は x ∈ (t − L, t]。
 *
 * 負荷が極大になる起点は既存の上がり時刻 {e.at : t − L < e.at ≤ t} と t 自身だけである——起点を上がり時刻の
 * 間へ置いても、その窓に入る上がりは右隣の上がり時刻を起点にした窓の部分集合になる（AC 9.3・design Component 10）。
 * 昇順で返す（firstFit が「最早の起点」を先頭で取れるように）。
 */
function originsContaining(lifts: LiftTable, t: EpochMillis, params: LiftParams): EpochMillis[] {
  const lower = t - windowMillis(params);
  const origins: EpochMillis[] = [];
  for (const lift of lifts) {
    if (lift.at > t) break; // 昇順ゆえ以降はすべて t より後
    if (lift.at > lower && (origins.length === 0 || origins[origins.length - 1] !== lift.at)) {
      origins.push(lift.at);
    }
  }
  // t 自身が既存の上がり時刻と一致すればもう入っている。
  if (origins.length === 0 || origins[origins.length - 1] !== t) origins.push(t);
  return origins;
}

/**
 * t を含む窓を起点順に走査する。窓へ入る分を足し、外れる分を引くので、一度の検査は O(n)。
 * CP-SAT の上げ窓検証で確認した将来側の負荷も含め、最大負荷と最初の過負荷を同じ走査で求める。
 * 上限を指定した場合は最初の過負荷で止める（firstFit が飛ばす最早の起点）。
 */
function scanWindows(
  lifts: LiftTable,
  t: EpochMillis,
  params: LiftParams,
  limit = Number.POSITIVE_INFINITY,
): { readonly load: number; readonly overloadedAt: EpochMillis | null } {
  const origins = originsContaining(lifts, t, params);
  const length = windowMillis(params);
  let left = 0;
  while (left < lifts.length && lifts[left]!.at < origins[0]!) left += 1;
  let right = left;
  let load = 0;
  let max = 0;
  for (const origin of origins) {
    const upper = origin + length;
    while (right < lifts.length && lifts[right]!.at < upper) {
      load += lifts[right]!.span;
      right += 1;
    }
    while (left < right && lifts[left]!.at < origin) {
      load -= lifts[left]!.span;
      left += 1;
    }
    if (load > limit) return { load, overloadedAt: origin };
    if (load > max) max = load;
  }
  return { load: max, overloadedAt: null };
}

/**
 * t に span 本を足したとき、t を含む半開窓 [x, x + L) の負荷の最大（Lift_Load・AC 9.3）。
 *
 * 見るのは**t を含む窓だけ**である（AC 9.4・9.5・9.14）。走行中だけ・過去の boiled だけで既に上限を超えている
 * 窓は開始後の事実であって、それを含まない配置を落とす理由にならない。ちょうど L 離れた上がりは同じ窓に
 * 入らない（半開区間・45 秒間隔を許す）。
 */
export function loadWith(
  lifts: LiftTable,
  t: EpochMillis,
  span: number,
  params: LiftParams,
): number {
  return scanWindows(lifts, t, params).load + span;
}

/**
 * t 以降で「span 本を足しても、それを含むすべての窓の負荷が arms + HELPER_ARMS 以下」となる最小の時刻（AC 9.4）。
 *
 * span 単独で上限を超えるなら null——いつまで待っても入らない（AC 9.12。茹で時間が引けない品目と同じく
 * 配置しない。ゲートもその配置を feasible と認めない）。
 *
 * **停止性と最小性（design Component 10）。** t から始め、t を含む過負荷の窓のうち最早の起点 e について
 * t ← e + L を繰り返す。[t, e + L) のどの時刻も窓 [e, e + L) に含まれ、その窓の負荷は既存の上がり ＋ span のまま
 * 変わらないので、飛ばした時刻はすべて不可である（最小性）。起点 e が t 自身のときも、[t, t + L) に既存の上がりが
 * 在るからこそ過負荷になっている（span ≤ 上限）ので、各反復で既存の上がりを一つ以上「t より L 以上手前」へ
 * 追い越す。表が有限なら止まる（停止性）。
 */
export function firstFit(
  lifts: LiftTable,
  t: EpochMillis,
  span: number,
  params: LiftParams,
): EpochMillis | null {
  const cap = liftCap(params);
  if (span > cap) return null;
  const length = windowMillis(params);
  let candidate = t;
  for (;;) {
    const { overloadedAt } = scanWindows(lifts, candidate, params, cap - span);
    if (overloadedAt === null) return candidate;
    candidate = (overloadedAt + length) as EpochMillis;
  }
}

/**
 * 上がりの列を一つずつ表へ載せたとき、どの上がりについても「それを含む窓」の負荷が arms + HELPER_ARMS 以下か
 * （ハード制約 (f)・AC 9.5・9.14）。
 *
 * Acceptance_Gate（admit.ts）が外部計画の一片に、確定計画の合成（commit.ts）が採用済み一片に、同じ述語で同じ位置
 * （一片を置く前の表）から検査する。**見るのは載せる上がりを含む窓だけ**——走行中だけ・過去の boiled だけで既に
 * 上限を超えている窓は開始後の事実であり、それを含まない一片を落とす理由にならない（AC 9.4）。
 *
 * 載せる順は結果に効かない。ある窓に載る上がりのうち最後に載せるものの検査が、その窓に先に載った上がりを
 * すべて含んだ負荷を見る（loadWith はその時刻を含む窓の負荷の最大を返す）ので、「列を全部載せたとき、列の
 * いずれかを含むすべての窓が上限以下」と同値である。一片の内側で同じ窓に上がる 2 品（pack）も、2 品目の検査で
 * 合計の負荷を見る。
 */
export function withinLiftCap(
  lifts: LiftTable,
  added: readonly Lift[],
  params: LiftParams,
): boolean {
  const cap = liftCap(params);
  let table = lifts;
  for (const lift of added) {
    if (loadWith(table, lift.at, lift.span, params) > cap) return false;
    table = advanceLifts(table, [lift]);
  }
  return true;
}

/**
 * Lift_Overflow——店舗全体で arms を超えて同じ窓に上がる本数の、手伝いを頼む費用（秒相当の整数・AC 9.6）。
 *
 * 上がる時刻を昇順に走査し、未割当の最早の時刻 e を起点に窓 [e, e + L) の負荷を取り、max(0, 負荷 − arms) を
 * 足して窓の内側を割当済みにする。重なる窓を二度数えない。Boil_Sync のセット分割と同じ「前から詰める」形で、
 * 外部ソルバも同じ式で再現できる。重みは L 秒/本——手伝いが無ければその 1 本は次の窓まで待つ、という時間の
 * 等価であり、新しい重みを足さない（判断 20）。
 *
 * **起点を上がり時刻に限る近似である（AC 9.15）。** arms 2・L 45 で {60:1, 104:1, 105:2} は割当が [60,105) と
 * [105,150) になり超過 0 だが、窓 [104,149) には 3 本ある。「手伝いが要る窓には必ず費用が付く」定義ではない。
 * ハード上限（loadWith・firstFit）は t を含むすべての窓を見るので近似ではない。近似を許すのは、一意で外部
 * 再現できる式を優先するためである。
 *
 * 表は at 昇順（LiftTable の不変条件）を前提とする。
 */
export function liftOverflow(lifts: LiftTable, params: LiftParams): number {
  const length = windowMillis(params);
  let total = 0;
  let i = 0;
  while (i < lifts.length) {
    const origin = lifts[i]?.at;
    if (origin === undefined) break;
    const upper = origin + length;
    let load = 0;
    let j = i;
    for (; j < lifts.length; j++) {
      const lift = lifts[j];
      if (lift === undefined || lift.at >= upper) break;
      load += lift.span;
    }
    total += Math.max(0, load - params.arms);
    i = j;
  }
  return total * params.liftIntervalSeconds;
}
