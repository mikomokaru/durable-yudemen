// domain/lift-order.ts — 上がり順（Lift_Order）の導出。走行中の Timer に「茹で上がる順の番号」を振る純粋関数。
//
// 番号は保持しない導出値である（lift-order-numbering 判断 6）。描画のたびに Timer 集合と now から導き、状態にも
// ワイヤにも永続にも持たない——残り時間と同じ規律（要件 12.2 の思想）。ここに置くのは、番号の単位とその並びという
// 規則が一つであるべきで、client の描画側に式を書けば釜のカードと将来の読み手（音・レール）が別の番号に達しうる
// からである。群・先頭（lift-group.ts）と同じく **店舗全体** で判定し、担当範囲で絞るのは表示だけ（判断 1・
// lift-group-display AC 1.6 / 2.12）。
//
// 番号は 2 段である（2026-09-08 の改訂）。**クラスタ**（同じ実効 endTime＝一括で上がる集合）に上がる順の番号を
// 振り、**クラスタ内の注文**に枝番を振る。同時に上がる別々の注文は、以前は 2 と 3 という無関係な数に分かれて
// 「同時に上がる」ことが番号から読めなかった。クラスタ番号を共有して枝で分ければ、上がるタイミング（クラスタ）と
// 盛り分けの単位（注文）を一つの表記が両方語る。表記は `4a` / `4b`（`liftOrderLabel`）。
//
// 入力は engine の `Timer` も wire の `TimerFact` / client の `ClientTimer` も満たす構造型で受ける。読むのは
// id・startTime・endTime（実効 endTime＝Boil_Sync の調整込み）と `orderItem.externalOrderId` だけである。

import { compareText } from "./order";

/**
 * 上がり順の導出が読む Timer の形。`slotIds` は読まない——複数釜を駆動する Timer は 1 本として数え、番号は Timer の id に
 * 付く（駆動する各釜のカードが同じ id で引くので自然に同じ番号になる・判断 5）。
 */
export interface LiftTimer {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
  /** 由来する注文。null はアドホック開始（1 本で 1 つの枝）。`itemIndex` は読まない（枝は注文であって品目ではない）。 */
  readonly orderItem: { readonly externalOrderId: string } | null;
}

/**
 * 上がり順。`cluster` は店舗全体で密な 1 始まりの順位（同じ実効 endTime なら同じ番号）、`branch` はクラスタ内で
 * 密な 1 始まりの枝番（同じ注文なら同じ枝）。単独のクラスタでも枝は 1 で、表記から省かない（表記の形を揃える）。
 */
export interface LiftOrder {
  readonly cluster: number;
  readonly branch: number;
}

/** クラスタ内の枝（同じ実効 endTime かつ同じ注文の走行中 Timer の組）。上げて盛る回そのものである。 */
interface Branch {
  /** 枝内の最早 startTime（先に始めた注文が先・判断 2）。 */
  startTime: number;
  /** 注文の識別子。アドホックは NUL ＋ Timer の id（注文の識別子は非空の文字列なので衝突しない）。 */
  readonly orderKey: string;
  readonly ids: string[];
}

/** クラスタ（同じ実効 endTime で一括に上がる走行中 Timer の集合）。 */
interface Cluster {
  readonly endTime: number;
  /** 注文の識別子 → 枝。挿入順には依らない（並べ替えて枝番を振る）。 */
  readonly branches: Map<string, Branch>;
}

/**
 * liftOrderOf — 走行中（`endTime > now`）の Timer に上がり順を振る。鍵は Timer の id。
 *
 * 1. 対象は走行中だけ。茹で上がり（`endTime ≤ now`）は番号を持たない（Map に無い・判断 3）。
 * 2. クラスタは「同じ実効 endTime」。並びは endTime 昇順で、番号は index + 1（密——1・2・3 であって 1・3・4 では
 *    ない）。同じ Sync_Set の Timer は注文が違っても同じクラスタ番号を持つ（一括で上がるため）。
 * 3. 枝はクラスタ内の注文。並びは枝内の最早 startTime 昇順 → 注文の識別子の符号単位順（決定的）で、枝番は
 *    index + 1。注文を持たない Timer（アドホック）は 1 本で 1 つの枝。
 * 4. 番号は「上げて盛る回」であって本数ではない。同じ注文を複数の釜で駆動する 1 本の Timer は 1 つの枝である。
 *
 * 入力の並びに依らず同じ Map に達する（同じ入力からは同じ結果）。`now` は補正済み（サーバ基準）の現在時刻で、
 * 走行中の判定 `endTime > now` は client の `remainingMs(...) > 0` と同じ線である。
 */
export function liftOrderOf(
  timers: readonly LiftTimer[],
  now: number,
): ReadonlyMap<string, LiftOrder> {
  const clusters = new Map<number, Cluster>();
  for (const timer of timers) {
    if (timer.endTime <= now) continue; // 茹で上がりは対象外（判断 3）
    const orderKey =
      timer.orderItem === null ? `\u0000${timer.id}` : timer.orderItem.externalOrderId;
    let cluster = clusters.get(timer.endTime);
    if (cluster === undefined) {
      cluster = { endTime: timer.endTime, branches: new Map() };
      clusters.set(timer.endTime, cluster);
    }
    const branch = cluster.branches.get(orderKey);
    if (branch === undefined) {
      cluster.branches.set(orderKey, { startTime: timer.startTime, orderKey, ids: [timer.id] });
    } else {
      branch.startTime = Math.min(branch.startTime, timer.startTime);
      branch.ids.push(timer.id);
    }
  }

  const order = new Map<string, LiftOrder>();
  const ordered = [...clusters.values()].sort((a, b) => a.endTime - b.endTime);
  ordered.forEach((cluster, clusterIndex) => {
    const branches = [...cluster.branches.values()].sort(
      (a, b) => a.startTime - b.startTime || compareText(a.orderKey, b.orderKey),
    );
    branches.forEach((branch, branchIndex) => {
      for (const id of branch.ids) {
        order.set(id, { cluster: clusterIndex + 1, branch: branchIndex + 1 });
      }
    });
  });
  return order;
}

/**
 * liftOrderLabel — 上がり順の表記（`4a` / `4b` / `12c`）。クラスタは十進、枝は小文字のアルファベット。
 *
 * 枝が 26 を超えたら `aa`・`ab`（表計算の列と同じ規則）。1 つのクラスタに 27 以上の注文が同時に上がることは
 * 実務では起きないが、表記は入力の全域で定める（部分関数にしない）。
 */
export function liftOrderLabel(order: LiftOrder): string {
  return `${order.cluster}${branchLetters(order.branch)}`;
}

/** 1 → a、26 → z、27 → aa（1 始まりの十進をアルファベット 26 進へ）。 */
function branchLetters(branch: number): string {
  let rest = branch;
  let letters = "";
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    letters = String.fromCharCode(97 + digit) + letters;
    rest = (rest - 1 - digit) / 26;
  }
  return letters;
}
