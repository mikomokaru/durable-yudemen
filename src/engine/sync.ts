// engine/sync.ts — 近接同時茹で上がり調整（Boil_Sync）の純粋変換 synchronize。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 割合窓の重なりで Running_Timer をクラスタ化し、arms 本ずつの Sync_Set に分け、maximin で
// 各セットの共通茹で上がり時刻（Sync_Target）を窓の許す範囲で離して配置し、各 Timer へ符号付き
// Adjustment を全体置換で割り当てる。オリジナル endTime（不変アンカー）自体は書き換えない。
//
// すべての窓量・比較・maximin を「100 倍スケール整数」で扱う。toleranceRatio は整数パーセントゆえ
// h_i × 100 = duration_i × toleranceRatio が整数になり、クラスタ判定・Window_Intersection・maximin を
// 浮動小数の順序依存・丸め誤差なしに行える（決定性の担保）。入力を正準順序（オリジナル endTime 昇順・
// 同着 seq 昇順）へ整列してから解くため、入力の列挙順に依らず一意の結果を返す。

import type { Timer } from "./timer";

/**
 * SyncParams — 同期計算のパラメータ（値）。arms・toleranceRatio は shell が StoreConfig から
 * 解決して渡す。engine は設定型を知らず、ただの数値として受け取る（非純粋を端へ寄せる規律）。
 */
export interface SyncParams {
  readonly arms: number; // 1..10 の整数（同時に上げられる本数の上限＝1 Sync_Set の最大本数）
  readonly toleranceRatio: number; // 1..50 の整数パーセント（許容調整割合）
}

/**
 * Running_Timer 集合に Adjustment を全体置換で割り当てる純粋変換（要件1〜3・7）。
 *
 * boiled（boiledAt !== null）は「発火済みの過去の事実」ゆえ調整対象にせず、入力どおり凍結して返す
 * （呼び出し側は running のみ渡す前提だが、混在しても boiled を動かさない安全網を engine 側にも置く）。
 * 空 running はそのまま返す。同一入力に対し入力の列挙順に依らず一意の結果を返す（決定的タイブレーク）。
 */
export function synchronize(running: readonly Timer[], params: SyncParams): readonly Timer[] {
  // arms<1 の下限ガード（二重の安全網）。正本の検証は domain の toArms にあり、ここは engine 側の保険。
  const armsLimit = params.arms < 1 ? 1 : params.arms;

  // 調整対象は running のみ。boiled は凍結（発火時の Adjustment を保持する）。
  const targets = running.filter((t) => t.boiledAt === null);
  if (targets.length === 0) return running;

  // seq をキーに Adjustment を集める（seq は running 内で一意の全順序の根拠）。未設定は 0。
  const adjustmentBySeq = new Map<number, number>();

  // 各 Running_Timer をスケール整数の窓へ写す。
  const windows = targets.map((timer) => toWindow(timer, params.toleranceRatio));

  // 近接クラスタ（窓の重なりの連結成分）ごとに Sync_Set へ分割し、Sync_Target を決めて Adjustment を割り当てる。
  for (const cluster of formClusters(windows)) {
    assignCluster(cluster, armsLimit, adjustmentBySeq);
  }

  // running は算出結果で全体置換、boiled はそのまま。入力順を保って返す。
  return running.map((timer) =>
    timer.boiledAt === null ? { ...timer, adjustment: adjustmentBySeq.get(timer.seq) ?? 0 } : timer,
  );
}

/**
 * Windowed — Running_Timer をスケール整数（× 100）の許容調整窓へ写した内部表現。
 *
 * half = duration × toleranceRatio = h_i × 100（クランプなし）。center = endTime × 100。
 * left / right は閉区間 [endTime − h_i, endTime + h_i] のスケール整数端。
 */
interface Windowed {
  readonly timer: Timer;
  readonly seq: number;
  readonly center: number; // endTime × 100
  readonly left: number; // (endTime − h_i) × 100
  readonly right: number; // (endTime + h_i) × 100
}

/** Running_Timer をスケール整数の窓へ写す。半幅にクランプは設けない（要件1.2 / 4.3）。 */
function toWindow(timer: Timer, toleranceRatio: number): Windowed {
  const duration = timer.endTime - timer.startTime; // Boil_Duration（ms・不変量）
  const half = duration * toleranceRatio; // h_i × 100（スケール整数）
  const center = timer.endTime * 100;
  return { timer, seq: timer.seq, center, left: center - half, right: center + half };
}

/**
 * Proximity_Cluster の形成（要件1.3〜1.6）。窓の重なり `|Δend| ≤ h_A + h_B` は閉区間の重なりと同値ゆえ、
 * 左端昇順に整列し「直前までの最大右端 ≥ 次の左端」が続く限り連結する区間掃引で連結成分を正しく求める。
 * 境界一致（差がちょうど h_A + h_B ＝ 一点で接する）は等号を含めて重なりに包含する（要件1.5）。
 */
function formClusters(windows: readonly Windowed[]): Windowed[][] {
  // 左端昇順。同着は center・seq で決定的に。
  const sorted = [...windows].sort((a, b) => a.left - b.left || a.center - b.center || a.seq - b.seq);
  const clusters: Windowed[][] = [];
  let current: Windowed[] = [];
  let maxRight = Number.NEGATIVE_INFINITY;
  for (const w of sorted) {
    // 次の左端が直前までの最大右端以下なら重なり（一点接触＝等号も包含）。さもなくば新クラスタ。
    if (current.length === 0 || w.left <= maxRight) {
      current.push(w);
      maxRight = Math.max(maxRight, w.right);
    } else {
      clusters.push(current);
      current = [w];
      maxRight = w.right;
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/** Sync_Set — 一つの Proximity_Cluster を endTime 昇順に arms 本ずつ区切った同時に上げる単位。 */
type SyncSet = readonly Windowed[];

/**
 * 一クラスタを Sync_Set へ分割し、同期可能なセット群へ maximin で Sync_Target を配置して Adjustment を割り当てる。
 * 同期見送りセット（Window_Intersection が空）・単独クラスタ・単独メンバーは Adjustment 0 に落ちる（要件1.7 / 3.6 / 7.4）。
 */
function assignCluster(cluster: readonly Windowed[], armsLimit: number, out: Map<number, number>): void {
  // クラスタ内をオリジナル endTime 昇順（同着 seq 昇順）に整列し、先頭から arms 本ずつチャンク化（要件2.2〜2.5）。
  const ordered = [...cluster].sort((a, b) => a.center - b.center || a.seq - b.seq);
  const sets: SyncSet[] = [];
  for (let i = 0; i < ordered.length; i += armsLimit) {
    sets.push(ordered.slice(i, i + armsLimit));
  }

  // Window_Intersection [Lmax, Rmin] と同期可能判定（Lmax ≤ Rmin）。同期見送りセットは全メンバー 0（要件3.1 / 3.2 / 3.6）。
  const syncable: { readonly set: SyncSet; readonly lmax: number; readonly rmin: number }[] = [];
  for (const set of sets) {
    const lmax = Math.max(...set.map((w) => w.left));
    const rmin = Math.min(...set.map((w) => w.right));
    if (lmax <= rmin) {
      syncable.push({ set, lmax, rmin });
    } else {
      // 同期見送り（品質の絶対優先）。当該セットは規定時刻のまま。
      for (const w of set) out.set(w.seq, 0);
    }
  }

  // 同一クラスタ内の同期可能セット群を endTime 昇順（＝チャンク順）に maximin 配置し、Sync_Target を決める。
  const targetsScaled = placeSyncTargets(syncable.map((s) => ({ lmax: s.lmax, rmin: s.rmin })));

  // Sync_Target を整数ミリ秒へ決定的丸め（I 内クランプ）し、adjustment = Sync_Target − endTime を割り当てる。
  syncable.forEach(({ set, lmax, rmin }, k) => {
    const targetMs = toTargetMs(targetsScaled[k], lmax, rmin);
    for (const w of set) out.set(w.seq, targetMs - w.timer.endTime);
  });
}

/**
 * maximin 配置（要件3.3〜3.5）。同期可能セット群 I_k = [lmax, rmin]（endTime 昇順）に対し、
 * t_k ∈ I_k かつ t_1 ≤ … ≤ t_m の下で連続 Sync_Target 間隔の最小値を最大化する g\* を求め、
 * g\* 固定下で Window_Intersection 中点への二乗偏差和を最小化（箱制約付き単調回帰）して一意化する。
 * 単独セット（m=1）は g\* を持たず中点＝自窓の中点に落ちる（単独メンバーなら中点＝オリジナル endTime → 0）。
 * 返すのはスケール整数（× 100）の Sync_Target 列。
 */
function placeSyncTargets(sets: readonly { readonly lmax: number; readonly rmin: number }[]): number[] {
  const m = sets.length;
  if (m === 0) return [];

  // 浮動小数の精度を保つため、最小左端を基準に相対座標へ移す（大きな絶対エポック値の丸め誤差を避ける）。
  const base = Math.min(...sets.map((s) => s.lmax));
  const rel = sets.map((s) => ({ left: s.lmax - base, right: s.rmin - base }));

  // 間隔下限 g の最大実行可能値 g\*（m=1 は間隔が存在せず 0）。整数スケール上で二分探索する。
  const gap = m >= 2 ? maxFeasibleGap(rel) : 0;

  // 変数変換 u_k = t_k − k·g\* で間隔制約 t_{k+1} − t_k ≥ g\* を単調制約 u_{k+1} ≥ u_k に化かす。
  const shifted = rel.map((r, k) => ({
    lo: r.left - k * gap,
    hi: r.right - k * gap,
    goal: (r.left + r.right) / 2 - k * gap, // Window_Intersection の中点（自然目標）
  }));
  const u = boundedIsotonic(shifted);

  // 相対座標を絶対スケールへ戻し、各 Window_Intersection [lmax, rmin] 内へクランプする。
  return sets.map((s, k) => clamp((u[k] ?? 0) + k * gap + base, s.lmax, s.rmin));
}

/**
 * 間隔下限 g に対する貪欲左詰めの実行可能性。t_1 = left_1、t_k = max(left_k, t_{k−1} + g)、
 * いずれかで t_k > right_k なら実行不能。セットは endTime 昇順ゆえ g=0 は常に実行可能（連結成分の性質）。
 */
function feasibleGap(rel: readonly { readonly left: number; readonly right: number }[], gap: number): boolean {
  let prev = Number.NEGATIVE_INFINITY;
  let first = true;
  for (const r of rel) {
    const t = first ? r.left : Math.max(r.left, prev + gap);
    if (t > r.right) return false;
    prev = t;
    first = false;
  }
  return true;
}

/** g\* を整数スケール上の二分探索で得る。単調（大きいほど不能へ向かう）ゆえ最大の実行可能 g を返す。 */
function maxFeasibleGap(rel: readonly { readonly left: number; readonly right: number }[]): number {
  let lo = 0;
  // g がこの上限を超えると必ず t_2 > right_2 で実行不能になる（探索の右端）。
  let hi = Math.max(...rel.map((r) => r.right)) - Math.min(...rel.map((r) => r.left)) + 1;
  while (lo < hi) {
    const gmid = Math.floor((lo + hi + 1) / 2);
    if (feasibleGap(rel, gmid)) lo = gmid;
    else hi = gmid - 1;
  }
  return lo;
}

/**
 * 箱制約付き単調回帰（pool-adjacent-violators）。u_1 ≤ … ≤ u_m かつ lo_k ≤ u_k ≤ hi_k の下で
 * Σ(u_k − goal_k)² を最小化する一意解を返す。各ブロックの最適値は「プール平均を箱 [max lo, min hi] へ
 * クランプした値」であり、隣接ブロックが単調性を破る（左 > 右）限り併合して再計算する。
 * 実行可能性（g\* が実行可能）が併合ブロックの箱を非空に保つ。
 */
function boundedIsotonic(
  items: readonly { readonly lo: number; readonly hi: number; readonly goal: number }[],
): number[] {
  interface Block {
    sum: number;
    count: number;
    lo: number;
    hi: number;
    value: number;
  }
  const blocks: Block[] = [];
  for (const item of items) {
    const block: Block = { sum: item.goal, count: 1, lo: item.lo, hi: item.hi, value: 0 };
    block.value = clamp(block.sum / block.count, block.lo, block.hi);
    blocks.push(block);
    // 左ブロックの値が右を上回る限り併合（単調性の回復）。
    while (blocks.length >= 2) {
      const right = blocks.pop();
      const left = blocks.pop();
      if (right === undefined || left === undefined) break;
      if (left.value <= right.value) {
        // 単調性を満たすので戻して打ち切る。
        blocks.push(left, right);
        break;
      }
      const merged: Block = {
        sum: left.sum + right.sum,
        count: left.count + right.count,
        lo: Math.max(left.lo, right.lo),
        hi: Math.min(left.hi, right.hi),
        value: 0,
      };
      merged.value = clamp(merged.sum / merged.count, merged.lo, merged.hi);
      blocks.push(merged);
    }
  }
  // ブロック値を各メンバーへ展開する。
  const u: number[] = [];
  for (const block of blocks) {
    for (let i = 0; i < block.count; i++) u.push(block.value);
  }
  return u;
}

/**
 * スケール整数の Sync_Target を整数ミリ秒へ決定的丸めし、Window_Intersection 内へクランプする。
 * 窓は最短でも ±(1s × 1%) = ±10ms ゆえ、0.5ms 丸めは窓を割らない（丸めても I 内に整数 ms が必ず存在する）。
 */
function toTargetMs(targetScaled: number | undefined, lmax: number, rmin: number): number {
  // targetScaled は placeSyncTargets が同数返すため常に定義済み。念のため中点へ退避する。
  const scaled = targetScaled ?? (lmax + rmin) / 2;
  const loMs = Math.ceil(lmax / 100);
  const hiMs = Math.floor(rmin / 100);
  let targetMs = Math.round(scaled / 100);
  if (loMs <= hiMs) targetMs = clamp(targetMs, loMs, hiMs);
  return targetMs;
}

/** 値を閉区間 [lo, hi] へ収める。 */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}
