import assert from "./assert";
import defaultPreferences from "./defaults.json";

export interface SchedulePreferences {
  readonly liftOverflowCost: number;
  /**
   * **2026-09-13 以降、本組み込みのモデルは読まない**（R4.4 の改訂）。`arms + 2` の超過は
   * ペナルティではなくハード制約になったので、罰する対象が存在しない。
   *
   * 係数一覧（`defaults.json`）と PoC の評価器（`evaluate` / `total`）には残す——PoC の記録との
   * 対応が切れるためである。旧い形（`ModelShape.hardLiftCap: false`）を選んだときだけ効く。
   */
  readonly severeLiftOverflowCost: number;
  readonly clusterCost: number;
  readonly gapShortfallWeight: number;
  readonly simultaneousDistanceWeight: number;
  readonly multiSlotDistanceWeight: number;
  readonly peripheralWeight: number;
  readonly centralWeight: number;
  readonly purchaseInversionCost: number;
  readonly orderFragmentCost: number;
  readonly orderDistanceWeight: number;
  readonly slotChangeCost: number;
}

export interface ScheduleEvaluation {
  readonly waitSeconds: number;
  readonly liftOverflow: number;
  readonly severeLiftOverflow: number;
  readonly clusters: number;
  readonly gapShortfallSeconds: number;
  readonly simultaneousDistance: number;
  readonly multiSlotDistance: number;
  readonly peripheral: number;
  readonly central: number;
  readonly purchaseInversions: number;
  readonly orderFragments: number;
  readonly orderDistance: number;
  readonly slotChanges: number;
}

export type Item = {
  readonly id: string;
  readonly order: string;
  readonly purchasedAt: number;
  readonly boilSeconds: number;
  readonly slotSpan: number;
};
export type Placement = Item & { start: number; end: number; slots: number[] };
export type History = {
  readonly id: string;
  readonly items: readonly Item[];
  readonly coordinates: readonly { readonly x: number; readonly y: number }[];
  readonly arms: number;
  readonly liftWindow: number;
  readonly tolerancePercent: number;
  /** Purchase-time cohort, [start, end). Context is still replayed to completion. */
  readonly evaluationWindow?: { readonly start: number; readonly end: number };
};
type Terms = [number, number][];
type Constraint =
  | { kind: "linear"; terms: Terms; lo: number; hi: number; when: number[] }
  | { kind: "max"; target: number; expressions: Terms[] }
  | { kind: "min"; target: number; values: number[] }
  | { kind: "element"; target: number; index: number; values: number[] }
  /**
   * 変数を引く element。`target = exprs[index]` で、`exprs` は線形式（変数の項 ＋ 定数）である。
   *
   * 定数表を引く `element` と分けるのは、符号化が違うためだけである（値を LinearExpression の
   * offset で書くか、変数の項で書くか）。クラスタごとの集約（広がり・時刻）を杯ごとに 1 変数で
   * 引くために要る——全組を作らずに「自分のクラスタの値」へ届く唯一の道具である。
   */
  | {
      kind: "elementVars";
      target: number;
      index: number;
      exprs: { terms: Terms; offset: number }[];
    }
  | { kind: "noOverlap"; intervals: number[] }
  /**
   * 累積資源（CP-SAT の `cumulative`）。**どの時刻でも、その時刻を覆う区間の需要の和が容量以下**。
   *
   * 上げ窓の負荷はこれで表す。区間を `[上がり時刻, 上がり時刻 + L)` に取ると、時刻 t を覆う区間の
   * 集合は「`(t − L, t]` に上がる杯」そのものになるので、窓の負荷の定義と厳密に一致する。
   * 杯の組ごとに窓の内外を判定する形（2 乗）が、区間 n 本と制約 1 本に置き換わる。
   *
   * `demands` と `capacity` は線形式（変数の項 ＋ 定数 offset）である。
   */
  | {
      kind: "cumulative";
      intervals: number[];
      demands: { terms: Terms; offset: number }[];
      capacity: { terms: Terms; offset: number };
    };
export type Model = {
  variables: [number, number][];
  constraints: Constraint[];
  intervals: [number, number, number, number | null][];
  objective: Terms;
  hints: [number, number][];
  budget: number;
};
type Solved = {
  status: string;
  objective: number | null;
  solution: number[];
  deterministicTime: number;
  modelVariables: number;
  modelConstraints: number;
};
type Solve = (model: Model) => Promise<Solved>;
const DEFAULTS: SchedulePreferences = defaultPreferences;
const INF = 1_000_000_000;

/**
 * モデルの形の切り替え。**掃引で新旧を並べて測るためだけに在る。**
 *
 * 既定値が新しい形である（`hardLiftCap: true`）。旧い形は比較のときだけ明示的に選ぶ。
 */
export interface ModelShape {
  /**
   * 上げ窓の負荷を `arms + HELPER_ARMS` 以下に**ハードで**縛るか（既定 true）。
   *
   * false は cumulativeLift: false と併せてのみ受け付ける。旧来の形（超過に値段を付けるだけ）に
   * 戻るため、engine のハード制約と食い違い、
   * 出た計画は `withinLiftCap` で棄却されうる。
   */
  readonly hardLiftCap?: boolean;
  /**
   * 探索予算（決定的時間）を**そのまま差し替える**。掃引で予算の効きを見るためだけに在る。
   *
   * 既定は `min(0.2, 0.04 + 変数数/50000)`。**上限（0.2）を上げても効かない**——変数が
   * 1 万を切る規模では第 2 項が常に小さく、min の左が縛っていないためである（2026-09-13 の失敗）。
   * ハード制約を足すと、この予算では最初の実行可能解に届かない局面が出る（status=UNKNOWN）。
   */
  readonly budget?: number;
  /**
   * 釜の在否を釜ごとの bool 1 個で持つか（既定 true）。false は旧い形（`eq` 経由・1 釜 4 変数）。
   *
   * 変数の 1 次の項がおよそ 1/4 になる。比較のときだけ false にする。
   */
  readonly leanSlots?: boolean;
  /**
   * 上げ窓を `cumulative` で表すか（既定 true）。false は旧い形（杯の組ごとに窓の内外を判定）。
   * false は旧い組ごとの生成ループを使うため、leanPairs: false と併せてのみ受け付ける。
   *
   * **E1 の定義が変わる**（2026-09-13 の改訂）。旧＝「クラスタごとの超過の和」、
   * 新＝「その瞬間に手伝いの手が何杯分要るか」。窓が重なるとき、旧は同じ超過を複数のクラスタで
   * 数えうるが、新は手を 1 回だけ数える。厨房の負荷に近いのは後者である。
   */
  readonly cumulativeLift?: boolean;
  /**
   * E7 を隣接組の逆転で数えるか（既定 true・2026-09-13 の改訂）。
   *
   * 旧＝全組の逆転数。全組では 1 つの遅れが後続すべてと組を作って増幅されるが、厨房で見えるのは
   * 「先に買った人の後に出た」という個々の事実である。E4 とは独立に効かせられる。
   */
  readonly leanInversions?: boolean;
  /**
   * E4 をクラスタの広がりで測り、距離の生成を同一注文の組（E8）に限るか。
   *
   * **既定は true（2026-09-13）。** 所属 bool と enforcement literal 付きの線形だけで組む
   * （`elementVars` で引く形は実モデルの中でソルバーを落とした。最小再現では落ちなかったので
   * 原因は element 単独ではない——定石の形へ置き換えて解消した）。E2・E3 も同じ骨格に乗るので、
   * 全組の `equal` も `next` も消える。
   */
  readonly leanPairs?: boolean;
  /** 前回と同じ釜を hint に使うか（既定 true）。false は旧い形——負の対照。 */
  readonly rememberSlots?: boolean;
  /**
   * **間もなく始まる杯（Head 近傍）について、釜を変える費用を何倍にするか**（既定 120・2026-09-15）。
   *
   * 現場が「パタパタ動く」と感じるのは**手を伸ばしている先**である。1 時間後に茹でる杯の釜が
   * 変わっても画面には見えない。ゆえに一律の重みを上げるのではなく、**見えている範囲だけを重くする**。
   *
   * **ハードにしない。** 前回の釜が塞がった局面で強制すれば解が消える——釜を変えたほうが明らかに
   * 良い場面は実在する。高い値段を払ってでも変えるべきなら、ソルバーがそう決めてよい。
   *
   * **値は 2 度の掃引で決めた。** 1 度目（走行中が変わらない局面・12 局面）では 40 で Head 近傍が
   * 0% になり、一律（倍率 1）の負の対照が 13% だった。
   *
   * **ところが 40 では足りなかった。** 現場から「スロットが埋まり気味の局面で次候補が安定しない」
   * という観察があり（2026-09-15）、**求解の 2〜6 秒の間に釜が埋まる**局面を再現すると——本番の
   * 1108 では走行中が 3 秒で 4 本 → 8 本と動いていた——40 でも Head 近傍が 11% 動いた。
   * 掃引をやり直す（24 局面・Head 対応 100 杯・2 度目の求解で走行中を 2 本増やす）。
   *
   * | 倍率 | Head 近傍 | 全対応の釜変更 | Σ杯数×待ち | 広がり | 逆転 |
   * |---:|---|---|---:|---:|---:|
   * | 40 | **11%** | — | 134,912 | 2,771 | **53** |
   * | 80 | 0% | 19/254 | 287,899 | 8,287 | 121 |
   * | **120** | **0%** | **13/254** | **286,753** | **6,974** | 138 |
   * | 160 | 0% | 24/254 | 288,609 | 7,541 | 157 |
   * | 400 | 0% | — | 135,617 | 2,908 | **78（40 比 +47%）** |
   *
   * **上げすぎると逆転が増える**——釜を守るために注文順を崩す。400 では逆転が 5 割増えた。
   * 120 は「どの指標でも悪くない」点で、待ち・広がり・全対応の釜変更がいずれも最小である。
   * **80〜160 の差は単調でなく、誤差の範囲かもしれない**——120 を採る理由はその 3 項にある。
   */
  readonly headSlotChangeFactor?: number;
  /**
   * Head 近傍と見なす秒数（既定 120）。前回の提案の開始時刻が「今」からこの範囲にある杯が対象。
   * `liftWindow`（45 秒）の数倍——現場が次に手を付ける範囲を粗く覆う。
   */
  readonly headHorizonSeconds?: number;
  /** 購入順の逆転の重み（既定は `defaults.json` の 20）。掃引で釜の安定と釣り合わせるために上書きする。 */
  readonly purchaseInversionCost?: number;
  /**
   * **貪欲 hint が注文順を守るか**（既定 true・2026-09-15）。
   *
   * 貪欲は対象を到着順に見るが、**釜が空く順に置く**ので後の注文が先に上がる——大盛（2 釜）が
   * 空きを待つ間に、後から来た普通（1 釜）がすり抜ける。実測では**貪欲 hint の時点で逆転 94**
   * （TS は 45）、そこから解いた CP-SAT は 138 だった。
   *
   * 修正前の hint による係数掃引では逆転が単調に減らなかった。その原因を探索範囲だけに
   * 帰すことはできず、実行不能な hint の修正後に再検証する必要がある。
   *
   * true にすると、hint の上がり時刻に「**先に注文された杯より先に上げない**」という下限を課す。
   * この下限自体はモデルの制約には加えず、ソルバーは時刻を動かせる。ただしクラスタ数の
   * 既定値は hint の相異なる上がり時刻数から決まるため、モデルの大きさ・解集合も変わりうる。
   * 代償は待ちで、先の杯を待つぶん後の杯が遅れる（「多少遅くなっても順番どおり」・ユーザー判断）。
   */
  readonly orderedHint?: boolean;
  /**
   * **伝票ごとの待ちを目的にする**（既定 false・試作中・2026-09-13）。
   *
   * on にすると 2 つ変わる。
   *   ・待ちの課金が**杯ごとの上がり時刻**から**伝票の最遅**へ移る（1 杯の伝票では同じ）
   *   ・伝票の内側の広がり（最遅 − 最早）に値段が付く（`billSpreadWeight`）
   * 同一伝票の距離の項（E8）は、広がりが同じ役目を果たすので生成しない。
   */
  readonly billWait?: boolean;
  /** 伝票の内側の広がりの重み（`billWait` のとき）。既定 10＝待ち 1 秒と同じ。 */
  readonly billSpreadWeight?: number;
  /**
   * **同じ伝票の杯を同じクラスタ（＝同じ上げ時刻）へ縛る**（既定 false・2026-09-13）。
   * 置けない局面のために伝票ごとの逃げ道 bool を 1 個持ち、`billSplitCost` を払う。
   */
  readonly billCluster?: boolean;
  /** 伝票を割ったときの費用（`billCluster` のとき）。既定 6000＝待ち 600 秒ぶん。 */
  readonly billSplitCost?: number;
  /**
   * **貪欲 hint を伝票単位で組む**（既定 false・2026-09-13）。同じ伝票の杯を同じ上がり時刻へ置く
   * 出発点を作る。費用でも構造でも動かなかったのは出発点が割れていたためである。
   */
  readonly billHint?: boolean;
  /**
   * **外から渡す出発点**（2026-09-13）。杯の鍵 → モデル秒での開始・終了・釜。
   *
   * 与えられた杯は貪欲法の代わりにこの配置を hint にする。**別の計画器（TS）の解をそのまま
   * 出発点にする**ために置いた——TS は同一伝票を pack で置くので同時性を構造として持っており、
   * 「CP-SAT はそこから目的関数で改善できる所だけ動かす」形になる。
   *
   * `fixHints` と併せれば、渡した解をこの目的関数で**採点する**ことになる。
   */
  readonly seed?: ReadonlyMap<
    string,
    { readonly start: number; readonly end: number; readonly slots: readonly number[] }
  >;
  /**
   * クラスタ数の上限（既定は杯数＝制限なし）。`leanPairs` のときだけ効く。
   *
   * **これはモデルの制限である。** 上限を杯数より小さくすると「相異なる上がり時刻は高々 K 個」を
   * 強いることになり、解集合が狭まる。`elementVars` 1 本がクラスタ数ぶんの式を持つので、
   * proto のバイト数は杯数 × クラスタ数で伸びる——杯数 48 以上で WASM のヒープに入らなくなった
   * （`_malloc` 失敗・2026-09-13 実測）。
   */
  readonly clusterCap?: number;
  /**
   * hint の値を等式で固定するか（既定 false・**検査専用**）。
   *
   * **hint はモデルに変数を足すたびに欠ける。** 2026-09-13 に 2 度続けて同じ失敗をした——
   * 累積資源を入れたときは上げ窓を見ない hint を、クラスタ骨格を入れたときはクラスタ時刻を
   * 渡さない hint を残し、どちらも `status=UNKNOWN` の山になった。人が覚えるより試験が捕まえる
   * ほうが確実なので、**hint を固定して解いて FEASIBLE が返ること**を掃引で確かめる。
   * 返らなければ hint がモデルの制約を満たしていない。
   */
  readonly fixHints?: boolean;
  /**
   * **全変数を hint する（`completeHint`）。** `fixHints` で固定して解くと、ソルバーは
   * モデルの**全変数**について値を返す——補助変数まで含めて矛盾の無い一つの実行可能解である。
   * それをそのまま出発点として元のモデルへ戻すのがこの摘みである。
   *
   * 普段の hint は `start`・`end`・スロット・クラスタ時刻と所属しか置かない。残りの補助変数は
   * ソルバーが埋める。**その埋め方が失敗すると、実行可能な hint を渡しても解が見つからない**
   * ——「固定すれば OPTIMAL なのに自由に解くと UNKNOWN」という 2026-09-15 の観測がこの形である。
   * 完全 hint はその切り分けのために在る。
   *
   * 長さは `model.variables.length` と一致していなければならない。
   */
  readonly completeHint?: readonly number[];
  /**
   * **hint の一部だけを固定する。** 種別（`time`・`slot`・`cluster`・`bill`・`helper`）を挙げると、
   * その種別の hint だけに等式を張る。`fixHints` が `INFEASIBLE` を返す局面で、
   * **hint のどの部分がモデルと矛盾しているか**を二分するために在る（2026-09-15）。
   */
  readonly fixHintSections?: readonly string[];
  /**
   * **特定の杯の釜だけをハードで固定する（`holdSlots`・2026-09-15）。**
   *
   * 「Head 近傍の釜が動いた」1 件を判定するために在る。**動いた杯の釜だけを固定し、
   * 時刻も他の杯も自由にする**——前回計画を丸ごと固定すると、要らない制約まで持ち込んで
   * 「維持できなかった」と誤って結論する。また「前回の釜が空いていた」だけでは、
   * 計画全体として維持できた証明にならないので、解かせて確かめる必要がある。
   *
   * 鍵は品目の id、値は釜番号の列（`slotSpan` と同じ長さ）。
   */
  readonly holdSlots?: ReadonlyMap<string, readonly number[]>;
}
const ZERO = (): ScheduleEvaluation => ({
  waitSeconds: 0,
  liftOverflow: 0,
  severeLiftOverflow: 0,
  clusters: 0,
  gapShortfallSeconds: 0,
  simultaneousDistance: 0,
  multiSlotDistance: 0,
  peripheral: 0,
  central: 0,
  purchaseInversions: 0,
  orderFragments: 0,
  orderDistance: 0,
  slotChanges: 0,
});

function preferences(value: SchedulePreferences): SchedulePreferences {
  assert.deepEqual(Object.keys(value).sort(), Object.keys(DEFAULTS).sort(), "Preference fields");
  for (const number of Object.values(value))
    assert(Number.isSafeInteger(number) && number >= 0 && number <= 10000);
  assert(value.severeLiftOverflowCost >= value.liftOverflowCost, "Overflow tiers must be ordered");
  return value;
}
export function total(f: ScheduleEvaluation, p: SchedulePreferences): number {
  return (
    f.waitSeconds +
    f.liftOverflow * p.liftOverflowCost +
    f.severeLiftOverflow * p.severeLiftOverflowCost +
    f.clusters * p.clusterCost +
    f.gapShortfallSeconds * p.gapShortfallWeight +
    f.simultaneousDistance * p.simultaneousDistanceWeight +
    f.multiSlotDistance * p.multiSlotDistanceWeight +
    f.peripheral * p.peripheralWeight +
    f.central * p.centralWeight +
    f.purchaseInversions * p.purchaseInversionCost +
    f.orderFragments * p.orderFragmentCost +
    f.orderDistance * p.orderDistanceWeight +
    f.slotChanges * p.slotChangeCost
  );
}
function distance(h: History, a: number, b: number): number {
  const dx = Math.abs(h.coordinates[a]!.x - h.coordinates[b]!.x);
  const dy = Math.abs(h.coordinates[a]!.y - h.coordinates[b]!.y);
  return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
}
/**
 * E4 の**旧**定義：同一クラスタの異なる杯について、割当スロットの全組合せの距離の和（D/10）。
 *
 * **`evaluate` と検証 harness が同じ関数を読む。** 定義変更の順位相関を出すとき、旧新どちらかを
 * 書き写せば「差が定義の差か写しの差か」が分からなくなる（2026-09-13）。
 */
export function simultaneousPairDistance(h: History, placements: readonly Placement[]): number {
  let sum = 0;
  for (const time of [...new Set(placements.map((p) => p.end))]) {
    const cluster = placements.filter((p) => p.end === time);
    for (let i = 0; i < cluster.length; i++)
      for (let j = i + 1; j < cluster.length; j++)
        for (const a of cluster[i]!.slots)
          for (const b of cluster[j]!.slots) sum += distance(h, a, b) / 10;
  }
  return sum;
}

/**
 * E4 の**新**定義（2026-09-13）：クラスタごとの x・y の広がり（最大 − 最小）を、距離と同じ形
 * （`10·max + 4·min`）で合計する（D/10）。**組の和ではなく散り方の幅を測る。**
 */
export function simultaneousSpread(h: History, placements: readonly Placement[]): number {
  let sum = 0;
  for (const time of [...new Set(placements.map((p) => p.end))]) {
    const slots = placements.filter((p) => p.end === time).flatMap((p) => p.slots);
    if (slots.length < 2) continue;
    const xs = slots.map((a) => h.coordinates[a]!.x);
    const ys = slots.map((a) => h.coordinates[a]!.y);
    const wx = Math.max(...xs) - Math.min(...xs);
    const wy = Math.max(...ys) - Math.min(...ys);
    sum += (10 * Math.max(wx, wy) + 4 * Math.min(wx, wy)) / 10;
  }
  return sum;
}

/**
 * 分解用（2026-09-13）：クラスタごとに**組の距離の平均**を 1 回だけ足す。
 *
 * 旧（全組の和）との差は**数え方だけ**である（距離を当てる対象は組のまま）。旧との順位相関が
 * 高ければ、新旧のずれは「数え方」では説明できない。
 */
export function simultaneousPairMean(h: History, placements: readonly Placement[]): number {
  let sum = 0;
  for (const time of [...new Set(placements.map((p) => p.end))]) {
    const slots = placements.filter((p) => p.end === time).flatMap((p) => p.slots);
    let pairs = 0;
    let total = 0;
    for (let i = 0; i < slots.length; i++)
      for (let j = i + 1; j < slots.length; j++) {
        total += distance(h, slots[i]!, slots[j]!) / 10;
        pairs += 1;
      }
    if (pairs > 0) sum += total / pairs;
  }
  return sum;
}

/**
 * 分解用（2026-09-13）：クラスタごとに**最も遠い組の距離**を 1 回だけ足す。
 *
 * 新（軸ごとの広がり）との差は**距離を当てる対象だけ**である（どちらもクラスタごとに 1 回）。
 * 両者の順位相関が高ければ、新旧のずれは「当てる対象」では説明できない。
 */
export function simultaneousPairMax(h: History, placements: readonly Placement[]): number {
  let sum = 0;
  for (const time of [...new Set(placements.map((p) => p.end))]) {
    const slots = placements.filter((p) => p.end === time).flatMap((p) => p.slots);
    let widest = 0;
    for (let i = 0; i < slots.length; i++)
      for (let j = i + 1; j < slots.length; j++)
        widest = Math.max(widest, distance(h, slots[i]!, slots[j]!) / 10);
    sum += widest;
  }
  return sum;
}

/** E7 の**旧**定義：購入が早い杯の終了が遅い杯より後になる**全組**の数。 */
export function allInversions(placements: readonly Placement[]): number {
  let count = 0;
  for (const a of placements)
    for (const b of placements) if (a.purchasedAt < b.purchasedAt && a.end > b.end) count += 1;
  return count;
}

/** E7 の**新**定義（2026-09-13）：購入順で**隣接する組**の逆転の数。 */
export function adjacentInversions(placements: readonly Placement[]): number {
  const order = [...placements].sort(
    (a, z) => a.purchasedAt - z.purchasedAt || (a.id < z.id ? -1 : a.id > z.id ? 1 : 0),
  );
  let count = 0;
  for (let k = 0; k + 1 < order.length; k++) {
    const older = order[k]!;
    const newer = order[k + 1]!;
    if (older.purchasedAt !== newer.purchasedAt && older.end > newer.end) count += 1;
  }
  return count;
}

function centrality(h: History): number[] {
  return h.coordinates.map((_, a) =>
    h.coordinates.reduce((sum, _, b) => sum + distance(h, a, b), 0),
  );
}
function gapTarget(count: number): number {
  return [0, 45, 75, 100, 120][count] ?? 120 + 20 * (count - 4);
}
function sameSlots(a: readonly number[], b: readonly number[]): boolean {
  return (
    a.length === b.length &&
    [...a].sort((x, y) => x - y).every((s, i) => s === [...b].sort((x, y) => x - y)[i])
  );
}
function fragments(
  h: History,
  placements: readonly Placement[],
): { count: number; distance: number } {
  const orders = new Map<string, Placement[]>();
  for (const p of placements) orders.set(p.order, [...(orders.get(p.order) ?? []), p]);
  let count = 0;
  let sum = 0;
  for (const group of orders.values()) {
    const visited = new Set([0]);
    while (visited.size < group.length) {
      let best = Infinity;
      let next = -1;
      for (const i of visited)
        for (let j = 0; j < group.length; j++) {
          if (visited.has(j)) continue;
          const d = Math.min(
            ...group[i]!.slots.flatMap((s) => group[j]!.slots.map((t) => distance(h, s, t))),
          );
          if (d < best) {
            best = d;
            next = j;
          }
        }
      assert(next >= 0);
      visited.add(next);
      if (best > 10) count++;
      sum += Math.max(0, best - 10) / 10;
    }
  }
  return { count, distance: sum };
}
export function evaluate(
  h: History,
  placements: readonly Placement[],
  previous: ReadonlyMap<string, readonly number[]>,
  past: readonly Placement[] = [],
  include: (p: Item) => boolean = () => true,
): ScheduleEvaluation {
  const c = centrality(h);
  const result = { ...ZERO() };
  for (const p of placements) {
    if (!include(p)) continue;
    result.waitSeconds += p.end - p.purchasedAt;
    if (previous.has(p.id) && !sameSlots(previous.get(p.id)!, p.slots)) result.slotChanges++;
    if (p.slots.length === 1) result.peripheral += (Math.max(...c) - c[p.slots[0]!]!) / 10;
    else {
      result.central += p.slots.reduce((sum, s) => sum + c[s]! - Math.min(...c), 0) / 10;
      for (let i = 0; i < p.slots.length; i++)
        for (let j = i + 1; j < p.slots.length; j++)
          result.multiSlotDistance += Math.max(0, distance(h, p.slots[i]!, p.slots[j]!) - 10) / 10;
    }
  }
  const times = [...new Set(placements.map((p) => p.end))].sort((a, b) => a - b);
  if (past.length && times.length && placements.some((p) => p.end === times[0] && include(p))) {
    const last = Math.max(...past.map((p) => p.end));
    const count = past.filter((p) => p.end === last).length;
    result.gapShortfallSeconds += Math.max(0, gapTarget(count) - (times[0]! - last));
  }
  for (let k = 0; k < times.length; k++) {
    const t = times[k]!;
    const cluster = placements.filter((p) => p.end === t);
    const clusterIncluded = cluster.some(include);
    if (clusterIncluded) result.clusters++;
    const lifting = [...past, ...placements].filter((p) => p.end <= t && p.end > t - h.liftWindow);
    const load = lifting.reduce((sum, p) => sum + p.slots.length, 0);
    if (lifting.some(include)) {
      result.liftOverflow += Math.min(2, Math.max(0, load - h.arms));
      result.severeLiftOverflow += Math.max(0, load - h.arms - 2);
    }
    if (
      k + 1 < times.length &&
      (clusterIncluded || placements.some((p) => p.end === times[k + 1] && include(p)))
    )
      result.gapShortfallSeconds += Math.max(0, gapTarget(cluster.length) - (times[k + 1]! - t));
    for (let i = 0; i < cluster.length; i++)
      for (let j = i + 1; j < cluster.length; j++) {
        if (!include(cluster[i]!) && !include(cluster[j]!)) continue;
        // 旧定義の式は `simultaneousPairDistance` と同一である（`include` の絞りだけが違う）。
        for (const a of cluster[i]!.slots)
          for (const b of cluster[j]!.slots) result.simultaneousDistance += distance(h, a, b) / 10;
      }
  }
  for (const a of placements)
    for (const b of placements)
      if ((include(a) || include(b)) && a.purchasedAt < b.purchasedAt && a.end > b.end)
        result.purchaseInversions++;
  const spatial = fragments(h, placements.filter(include));
  result.orderFragments = spatial.count;
  result.orderDistance = spatial.distance;
  return result;
}

class Formulation {
  /**
   * 変数を「どの構造が作ったか」で数える。**どこが太っているかを当て推量で決めないため。**
   * モデルの中身には影響しない（`section` を切り替えるだけ）。
   */
  section = "other";
  readonly bySection: Record<string, number> = {};
  /**
   * **hint の種別**（`model.hints` と同じ長さ・同じ順）。`fixHintSections` で一部だけ固定して
   * 解き、**hint のどの部分がモデルと矛盾しているか**を二分するために在る（2026-09-15）。
   * `hints.push` を直に呼ばず `hint()` を通すのは、この対応がずれないようにするためである。
   */
  readonly hintKinds: string[] = [];
  /** 種別つきで hint を積む。 */
  hint(kind: string, ...pairs: [number, number][]): void {
    for (const pair of pairs) {
      this.model.hints.push(pair);
      this.hintKinds.push(kind);
    }
  }
  readonly model: Model = {
    variables: [],
    constraints: [],
    intervals: [],
    objective: [],
    hints: [],
    budget: 0.1,
  };
  readonly zero: number;
  constructor() {
    this.zero = this.variable(0, 0);
  }
  variable(lo: number, hi: number): number {
    assert(Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && lo <= hi);
    this.bySection[this.section] = (this.bySection[this.section] ?? 0) + 1;
    this.model.variables.push([lo, hi]);
    return this.model.variables.length - 1;
  }
  linear(terms: Terms, lo: number, hi = lo, when: number[] = []): void {
    this.model.constraints.push({ kind: "linear", terms, lo, hi, when });
  }
  /**
   * `a == b` の指示子。**補助変数は 2 個である**（旧い形は `gt` を 2 回呼んで 3 個だった）。
   *
   * `v` が真なら等号を強制する。偽なら向き `d` で分けて厳密な不等号を強制する——`a == b` の下では
   * どちらの枝も成り立たないので `v` は真に固定され、`a != b` の下では等号の枝が破れるので `v` は
   * 偽に固定される。ゆえに `v` は指示子として一意に定まり、**解集合は旧い形と同じ**である。
   * 強制リテラルを 2 つ並べられることが前提で、符号化（`protobuf.ts`）は `when` を repeated で書く。
   */
  eq(a: number, b: number): number {
    const v = this.variable(0, 1);
    const d = this.variable(0, 1);
    const difference: Terms = [
      [a, 1],
      [b, -1],
    ];
    this.linear(difference, 0, 0, [v]);
    this.linear(difference, 1, INF, [-v - 1, d]);
    this.linear(difference, -INF, -1, [-v - 1, -d - 1]);
    return v;
  }
  gt(a: number, b: number, offset = 0): number {
    const v = this.variable(0, 1);
    this.linear(
      [
        [a, 1],
        [b, -1],
      ],
      offset + 1,
      INF,
      [v],
    );
    this.linear(
      [
        [a, 1],
        [b, -1],
      ],
      -INF,
      offset,
      [-v - 1],
    );
    return v;
  }
  and(literals: number[]): number {
    const v = this.variable(0, 1);
    const terms: Terms = literals.map((i) => (i >= 0 ? [i, 1] : [-i - 1, -1]));
    const negatives = literals.filter((i) => i < 0).length;
    for (const literal of literals)
      this.linear(
        [
          [v, 1],
          [literal >= 0 ? literal : -literal - 1, literal >= 0 ? -1 : 1],
        ],
        -INF,
        literal >= 0 ? 0 : 1,
      );
    this.linear([...terms, [v, -1]], -INF, literals.length - 1 - negatives);
    return v;
  }
  max(expressions: Terms[], lo: number, hi: number): number {
    const target = this.variable(lo, hi);
    this.model.constraints.push({ kind: "max", target, expressions });
    return target;
  }
  positive(terms: Terms, hi: number): number {
    return this.max([terms, [[this.zero, 1]]], 0, hi);
  }
  constant(n: number): number {
    return this.variable(n, n);
  }
  min(values: number[], lo: number, hi: number): number {
    const target = this.variable(lo, hi);
    this.model.constraints.push({ kind: "min", target, values });
    return target;
  }
  element(index: number, values: number[]): number {
    const target = this.variable(Math.min(...values), Math.max(...values));
    this.model.constraints.push({ kind: "element", index, values, target });
    return target;
  }
  elementVars(
    index: number,
    exprs: { terms: Terms; offset: number }[],
    lo: number,
    hi: number,
  ): number {
    const target = this.variable(lo, hi);
    this.model.constraints.push({ kind: "elementVars", index, exprs, target });
    return target;
  }
  conditional(value: number, active: number, otherwise = 0): number {
    const [lo, hi] = this.model.variables[value]!;
    const target = this.variable(Math.min(lo, otherwise), Math.max(hi, otherwise));
    this.linear(
      [
        [target, 1],
        [value, -1],
      ],
      0,
      0,
      [active],
    );
    this.linear([[target, 1]], otherwise, otherwise, [-active - 1]);
    return target;
  }
  cumulative(
    intervals: number[],
    demands: { terms: Terms; offset: number }[],
    capacity: { terms: Terms; offset: number },
  ): void {
    this.model.constraints.push({ kind: "cumulative", intervals, demands, capacity });
  }
  cost(value: number, coefficient: number): void {
    assert(Number.isSafeInteger(coefficient));
    if (coefficient !== 0) this.model.objective.push([value, coefficient]);
  }
}

export function formulate(
  h: History,
  now: number,
  jobs: readonly Item[],
  running: readonly Placement[],
  previous: ReadonlyMap<string, readonly number[]>,
  past: readonly Placement[],
  p: SchedulePreferences,
  unavailableSlots: readonly number[] = [],
  shape: ModelShape = {},
  /**
   * 前回の提案の開始時刻（モデル秒）。**Head 近傍の判定にだけ使う**——釜を守る重みを変える
   * ためであって、配置を縛るためではない。省略すれば従来どおり一律の重みになる。
   */
  previousStartOf?: ReadonlyMap<string, number>,
) {
  const b = new Formulation();
  // engine（src/engine/lift.ts）では arms はソフト（超えた分は手伝いの費用）だが、
  // **arms + HELPER_ARMS はハード**である——`withinLiftCap` がゲート (f) と合成でこれを見る。
  // 既定でハードにする。値段にしておくと、目的関数が得と判断した瞬間に上限を超える配置が出て、
  // ゲートがそれを丸ごと棄却する（2026-09-13 の掃引で採用 0 の本体だった）。
  const hardLiftCap = shape.hardLiftCap ?? true;
  const leanSlots = shape.leanSlots ?? true;
  const cumulativeLift = shape.cumulativeLift ?? true;
  const leanInversions = shape.leanInversions ?? true;
  const leanPairs = shape.leanPairs ?? true;
  assert(hardLiftCap || !cumulativeLift, "hardLiftCap: false requires cumulativeLift: false");
  assert(cumulativeLift || !leanPairs, "cumulativeLift: false requires leanPairs: false");
  // **前回と同じ釜を hint に使うか**（既定 true）。false は旧い形（毎回ゼロから釜を選び直す）で、
  // 釜の揺れの負の対照を取るためだけに在る。
  const rememberSlots = shape.rememberSlots ?? true;
  const headSlotChangeFactor = shape.headSlotChangeFactor ?? 120;
  // 逆転の重みは既定を上書きできる（掃引専用。本番は defaults.json の値で動く）。
  const inversionCost = shape.purchaseInversionCost ?? p.purchaseInversionCost;
  const orderedHint = shape.orderedHint ?? true;
  const headHorizonSeconds = shape.headHorizonSeconds ?? 120;
  const billWait = shape.billWait ?? false;
  const billSpreadWeight = shape.billSpreadWeight ?? 10;
  const billCluster = shape.billCluster ?? false;
  const billSplitCost = shape.billSplitCost ?? 6000;
  const billHint = shape.billHint ?? false;
  const occupied = new Map(running.map((r) => [r.id, r]));
  const horizon =
    Math.max(now, ...running.map((r) => r.end)) +
    jobs.reduce((sum, j) => sum + j.boilSeconds + 180, 0) +
    600;
  const slotIntervals: number[][] = h.coordinates.map(() => []);
  const c = centrality(h);
  const xs = h.coordinates.map((v) => v.x);
  const ys = h.coordinates.map((v) => v.y);
  const maxDistance = Math.max(...c);
  const slots: { slot: number; x: number; y: number }[][] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const hints: Placement[] = [];
  /** hint が置いた上がり時刻の最大（`orderedHint` の下限）。到着順に見るので単調に進む。 */
  let latestHintedEnd = 0;
  const release = h.coordinates.map((_, s) =>
    Math.max(now, ...running.filter((r) => r.slots.includes(s)).map((r) => r.end)),
  );
  /** 手伝いで増やせる腕の数（engine の `HELPER_ARMS`）。hint がハード上限を知るために要る。 */
  const HELPER_ARMS_HINT = 2;
  /** 新しい上げ区間の全体で容量を守るか。走行中の上がりは候補時刻より後にもある。 */
  const fits = (
    lifts: readonly { at: number; span: number }[],
    at: number,
    span: number,
    capacity: number = h.arms,
  ) => {
    // 新しい上げは [at, at + L) を占有する。負荷が増える点をすべて見る。
    // at だけを見ると、その直後に上がる走行中の麺との衝突を見落とす。
    const edges = [
      at,
      ...lifts.filter((lift) => lift.at > at && lift.at < at + h.liftWindow).map((lift) => lift.at),
    ];
    return edges.every((edge) => {
      const load = lifts.reduce(
        (sum, lift) => sum + (lift.at > edge - h.liftWindow && lift.at <= edge ? lift.span : 0),
        span,
      );
      return load <= capacity;
    });
  };
  /** 入らない窓の分だけ後ろへ送る（engine の `firstFit` と同じ考え方）。 */
  const firstFitAt = (
    lifts: readonly { at: number; span: number }[],
    from: number,
    span: number,
    capacity: number = h.arms,
  ) => {
    let at = from;
    for (let guard = 0; guard <= lifts.length && !fits(lifts, at, span, capacity); guard += 1) {
      const blocking = lifts
        .filter((lift) => lift.at > at - h.liftWindow && lift.at < at + h.liftWindow)
        .map((lift) => lift.at + h.liftWindow);
      if (blocking.length === 0) break;
      at = Math.min(...blocking);
    }
    assert(
      fits(lifts, at, span, capacity),
      `Greedy hint cannot fit lift demand: span=${span}, capacity=${capacity}, from=${from}, at=${at}`,
    );
    return at;
  };
  /**
   * **伝票を揃える貪欲解（`billHint`・2026-09-13）。**
   *
   * 既存の貪欲は杯を到着順に見て「空くのが早い釜」へ置く。**伝票を見ていない**ので、同じお客の
   * 2 杯が別々の時刻に上がる出発点ができ、**探索はそこから出られなかった**——費用（広がりの重み
   * 10〜1000）でも構造（同一伝票 ⇒ 同一クラスタ）でも、広がりは 25% しか縮まなかった。
   *
   * ここは伝票を単位に置く。伝票の各杯を単独で置いたときの上がり時刻の**最大**を共通の時刻に
   * 取り（早い杯は待たせる）、上げ窓に入るところまで後ろへ送り、各杯を `共通時刻 − 茹で時間` から
   * 始める。**釜は各杯が自分の開始時刻までに空いている釜から取る**ので、解放表と噛み合う。
   *
   * 揃えられない伝票（釜が足りない）はその杯だけ単独で置く——hint は手がかりであって制約ではない。
   */
  const billAlignedHint = () => {
    const free = h.coordinates.map((_, slot) =>
      Math.max(now, ...running.filter((r) => r.slots.includes(slot)).map((r) => r.end)),
    );
    const lifts: { at: number; span: number }[] = past.map((old) => ({
      at: old.end,
      span: old.slots.length,
    }));
    const plan = new Map<string, { start: number; end: number; slots: number[] }>();
    const bills = new Map<string, Item[]>();
    for (const item of jobs) {
      if (occupied.has(item.id)) continue;
      const group = bills.get(item.order);
      if (group === undefined) bills.set(item.order, [item]);
      else group.push(item);
    }
    /** `by` までに空く釜を span 本、番号の昇順で取る。足りなければ null。 */
    const take = (by: number, span: number) => {
      const ready = free.flatMap((at, slot) => (at <= by ? [slot] : []));
      return ready.length < span ? null : ready.slice(0, span);
    };
    for (const group of bills.values()) {
      // 各杯を単独で置いたときの最早の上がり時刻。その最大が伝票の共通時刻の下限である。
      let target = -Infinity;
      for (const item of group) {
        const soonest = [...free].sort((a, z) => a - z)[item.slotSpan - 1];
        if (soonest === undefined) continue;
        target = Math.max(target, Math.max(now, soonest) + item.boilSeconds);
      }
      if (!Number.isFinite(target)) continue;
      const span = group.reduce((sum, item) => sum + item.slotSpan, 0);
      // **ハード上限まで許す（`arms + HELPER_ARMS`）。** 腕だけに収める（`arms`）と、3 杯の伝票は
      // 同時に上げられず揃えられない。超えた分は手伝いで賄い、その旨を `helped` の hint で渡す。
      const at = firstFitAt(lifts, target, span, h.arms + HELPER_ARMS_HINT);
      for (const item of group) {
        const start = at - item.boilSeconds;
        const slots = take(start, item.slotSpan);
        if (slots === null) continue;
        for (const slot of slots) free[slot] = at;
        plan.set(item.id, { start, end: at, slots });
      }
      lifts.push({ at, span });
    }
    // **自分の出した解を自分で検査する。** hint が実行不能だと、ソルバーは最初の実行可能解を
    // 自力で探す羽目になり `status=UNKNOWN` が増える（この案件で 3 度踏んでいる）。
    // 破っていたら黙って渡さず、何を破ったかを添えて落とす。
    const used = new Map<number, { start: number; end: number }[]>();
    const broken: string[] = [];
    for (const [id, placed] of plan) {
      if (placed.start < now) broken.push(`${id}: 開始が下限より前 ${placed.start} < ${now}`);
      for (const slot of placed.slots) {
        if (!Number.isInteger(slot) || slot < 0 || slot >= h.coordinates.length)
          broken.push(`${id}: 釜の番号が範囲外 ${slot}`);
        const taken = used.get(slot) ?? [];
        for (const other of taken)
          if (placed.start < other.end && other.start < placed.end)
            broken.push(`${id}: 釜 ${slot} が重なる`);
        taken.push({ start: placed.start, end: placed.end });
        used.set(slot, taken);
      }
      if (new Set(placed.slots).size !== placed.slots.length) broken.push(`${id}: 釜が重複`);
    }
    for (const [id, placed] of plan) {
      let load = 0;
      for (const [otherId, other] of plan)
        if (other.end > placed.end - h.liftWindow && other.end <= placed.end)
          load += plan.get(otherId)!.slots.length;
      if (load > h.arms + HELPER_ARMS_HINT)
        broken.push(`${id}: 上げ窓の負荷 ${load} > 上限 ${h.arms + HELPER_ARMS_HINT}`);
    }
    if (broken.length > 0)
      throw new Error(`伝票 hint が実行不能：${broken.slice(0, 4).join(" / ")}`);
    return plan;
  };
  const aligned = billHint ? billAlignedHint() : undefined;
  /** `holdSlots` が実際に当たった品目。**当たらなければ失敗させる**——鍵の形を間違えると黙って効かない。 */
  const heldMatched = new Set<string>();
  b.section = "item/time+slot";
  /** hint が積んだ上がり（時刻と本数）。hint を実行可能に保つためだけに使う。 */
  const hintedLifts: { at: number; span: number }[] = past.map((old) => ({
    at: old.end,
    span: old.slots.length,
  }));
  for (let i = 0; i < jobs.length; i++) {
    const item = jobs[i]!;
    const r = occupied.get(item.id);
    const tolerance = Math.floor((item.boilSeconds * h.tolerancePercent) / 100);
    const start = b.variable(r?.start ?? now, r?.start ?? horizon - item.boilSeconds - tolerance);
    // 下限は `start + size` の下限から導く。**`end = start + size` の線形制約が既にこれを含意するので、
    // 解集合は変わらない**——伝播に効くだけの締め方である（2026-09-13）。旧い形は `now + 1` で、
    // 茹で時間 7 分の麺でも「1 秒後に上がる」可能性を境界に残していた。
    // **走行中の上がり時刻に「今より後」を課さない（2026-09-13 修正）。**
    //
    // 走行中の end は事実であって、境界で締めるものではない。`now` は**受領の見込み時刻**
    // （今 + `CPSAT_DELIVERY_LEAD_MS`）なので、**lead の窓の内側で上がるタイマーがあると
    // 下限が上限を追い越し**、変数の定義域が逆転して `CP-SAT invariant failed` で求解ごと落ちる。
    // 実測：残り 3 秒の走行中を 2 本入れるだけで 6 局面すべてが落ちた。本番でも 1108 で 3 件出た。
    //
    // 未着手の側は従来どおり `now + 1` で締める——あちらは「これから置く」ので見込み時刻より
    // 後に上がるのが正しい。
    const end = b.variable(
      r
        ? r.start + item.boilSeconds - tolerance
        : Math.max(now + 1, now + item.boilSeconds - tolerance),
      r ? r.start + item.boilSeconds + tolerance : horizon,
    );
    starts.push(start);
    ends.push(end);
    const size = b.variable(item.boilSeconds - tolerance, item.boilSeconds + tolerance);
    b.linear(
      [
        [end, 1],
        [start, -1],
        [size, -1],
      ],
      0,
    );
    // **前回と同じ釜を hint に使う（2026-09-13）。**
    //
    // `slotChangeCost` はモデルに在るが、解は `FEASIBLE`（予算内で打ち切り）なので**ソルバーは
    // hint の近くを返す**。その hint が毎回「空くのが早い釜」からゼロで選び直していたため、
    // 前回と同じ釜へ戻る理由が無く、**本番で対応した杯のほぼ全数が別の釜へ移っていた**
    // （実測 16/16・23/23・22/22＝100%・2026-09-13 の `yamaokaya-1108`）。
    //
    // 釜の hint 自体は配置を縛らない。ただし釜選びが上がり時刻を変えると、hint 由来の
    // クラスタ数も変わりうるため、モデルの大きさ・解集合が不変とは言えない。前回の釜が使えないとき
    // （本数が合わない・範囲外・使用不可）は従来どおり空き順で選ぶ。使えるのに悪ければ、
    // ソルバーが目的関数に従って動かす。
    const planted = shape.seed?.get(item.id) ?? aligned?.get(item.id);
    const remembered = previous.get(item.id);
    const reusable =
      rememberSlots &&
      !r &&
      remembered !== undefined &&
      remembered.length === item.slotSpan &&
      new Set(remembered).size === item.slotSpan &&
      remembered.every(
        (slot) =>
          Number.isInteger(slot) &&
          slot >= 0 &&
          slot < h.coordinates.length &&
          !unavailableSlots.includes(slot),
      );
    // **使えない釜を選ばない（2026-09-15 修正）。**
    //
    // 貪欲は「空くのが早い釜」から取るが、`unavailableSlots` を見ていなかった。**茹で上がって
    // Complete を待っている釜（boiled）はそこに入る**——`release`（解放表）はその釜を「いま空いて
    // いる」と見なすので、貪欲は真っ先にそこを選ぶ。選べば hint はモデルの制約（`presence = 0`）を
    // 破り、**ソルバーは最初の実行可能解を自力で探す羽目になって `status=UNKNOWN` で落ちる。**
    //
    // 本番の失敗局面 47 件を集めたところ、走行中 136 本のうち **103 本（76%）が「既に上がっている」**
    // で、30 局面は全部が過去だった。ローカルで再現すると 6 局面中 4 つで hint が実行不能になる。
    // **「前回と同じ釜」の枝（`reusable`）だけは検査していた**——既定の枝に同じ検査が無かった。
    const usable = release
      .map((at, slot) => ({ at, slot }))
      .filter(({ slot }) => !unavailableSlots.includes(slot));
    const chosen = r
      ? [...r.slots].sort((a, z) => a - z)
      : planted
        ? [...planted.slots].sort((a, z) => a - z)
        : reusable
          ? [...remembered!].sort((a, z) => a - z)
          : usable
              .sort((a, z) => a.at - z.at || a.slot - z.slot)
              .slice(0, item.slotSpan)
              .map((v) => v.slot)
              .sort((a, z) => a - z);
    // **hint は上げ窓の上限を守る。** 破った点を渡すと、ソルバーは最初の実行可能解を自力で
    // 探す羽目になる——ハード化したあと `status=UNKNOWN`（予算内に実行可能解なし）が増えた
    // 主因がこれである（2026-09-13）。engine の `firstFit` と同じ考え方で、入らない窓の分だけ
    // 後ろへ送る。上げ窓の制約自体は緩めない。ただしクラスタ数の既定値は hint の上がり時刻から
    // 決まるため、hint の変更でモデルの大きさ・解集合まで不変になるわけではない。
    // 外から渡した配置は時刻もそのまま使う（貪欲の `firstFit` を通さない）。
    const hintedStart =
      r?.start ?? planted?.start ?? Math.max(now, ...chosen.map((s) => release[s]!));
    const naturalEnd = hintedStart + item.boilSeconds;
    // **先に注文された杯より先に上げない（`orderedHint`）。** `jobs` は到着順に並んでいるので、
    // 直前までに hint が置いた上がり時刻の最大を下限にすればよい。同じ時刻の注文は追い越しに
    // ならないので等号を許す。走行中（`r`）と外から渡した配置（`planted`）には課さない
    // ——あちらは事実であって、貪欲が決める時刻ではない。
    const orderedFloor = orderedHint && !r && planted === undefined ? latestHintedEnd : 0;
    const hintedEnd =
      r?.end ??
      planted?.end ??
      firstFitAt(hintedLifts, Math.max(naturalEnd, orderedFloor), item.slotSpan);
    // **床を上げるのは貪欲が決めた杯だけ（2026-09-15 修正）。**
    //
    // 走行中（`r`）の上がり時刻で床を上げると、**別の空き釜なら早く出せる新規の杯まで
    // その時刻以降へ送られる**——走行中が 420 秒に上がるなら、180 秒に出せる杯も 420 秒へ。
    // 走行中は追い越しの対象ではない（もう始まっている）ので、順序の床に入れる理由が無い。
    // 外から渡した配置（`planted`）も同じく事実であって、貪欲の決定ではない。
    if (!r && planted === undefined) latestHintedEnd = Math.max(latestHintedEnd, hintedEnd);
    hintedLifts.push({ at: hintedEnd, span: item.slotSpan });
    // `end = start + size` を保つため、後ろへ送った分は start も動かす。
    const shiftedStart = r?.start ?? hintedEnd - item.boilSeconds;
    hints.push({ ...item, slots: chosen, start: shiftedStart, end: hintedEnd });
    if (!r) for (const s of chosen) release[s] = hintedEnd;
    b.hint(r ? "timeRunning" : `timePending:${i}`, [start, shiftedStart], [end, hintedEnd]);
    const position = [];
    for (let a = 0; a < item.slotSpan; a++) {
      const slot = b.variable(r ? chosen[a]! : 0, r ? chosen[a]! : h.coordinates.length - 1);
      // **釜の在否は釜ごとの bool 1 個で持つ。** 旧い形は釜ごとに `eq(slot, s)` を作っており、
      // `eq` は内部で `gt` を 2 回呼ぶので 1 釜あたり補助変数 4 個・線形制約 4 本になっていた
      // （釜 12 で 1 占有あたり 48 変数）。ここは「ちょうど 1 つ」と「slot との連動」の線形 2 本で
      // 閉じる。**同値である**——`sum p_s = 1` かつ `sum s·p_s = slot` なら、p は slot の指示子に
      // 一意に定まる（2026-09-13 のダイエット）。
      const presence: number[] = [];
      for (let s = 0; s < h.coordinates.length; s++) {
        const present = leanSlots ? b.variable(0, 1) : b.eq(slot, b.constant(s));
        presence.push(present);
        slotIntervals[s]!.push(b.model.intervals.length);
        b.model.intervals.push([start, size, end, present]);
      }
      if (leanSlots) {
        b.linear(
          presence.map((v): [number, number] => [v, 1]),
          1,
        );
        b.linear([...presence.map((v, s): [number, number] => [v, s]), [slot, -1]], 0);
        b.hint("slot", ...presence.map((v, s): [number, number] => [v, s === chosen[a] ? 1 : 0]));
      }
      if (!r)
        for (const unavailable of unavailableSlots)
          b.linear(
            [[leanSlots ? presence[unavailable]! : b.eq(slot, b.constant(unavailable)), 1]],
            0,
          );
      b.hint("slot", [slot, chosen[a]!]);
      // **この杯の釜を固定する（`holdSlots`）。** 時刻は縛らない。
      const held = shape.holdSlots?.get(item.id);
      if (held !== undefined) {
        assert.equal(held.length, item.slotSpan, "holdSlots must match the item's slot span");
        b.linear([[slot, 1]], held[a]!);
        heldMatched.add(item.id);
      }
      if (a > 0)
        b.linear(
          [
            [slot, 1],
            [position[a - 1]!.slot, -1],
          ],
          1,
          INF,
        );
      position.push({ slot, presence, x: b.element(slot, xs), y: b.element(slot, ys) });
      b.cost(
        b.element(
          slot,
          item.slotSpan === 1 ? c.map((v) => Math.max(...c) - v) : c.map((v) => v - Math.min(...c)),
        ),
        item.slotSpan === 1 ? p.peripheralWeight : p.centralWeight,
      );
    }
    slots.push(position);
    // **待ちの課金。** 既定は杯ごとの上がり時刻。`billWait` では伝票の最遅へ移すので、
    // ここでは課金せず下の伝票ごとの集約で一度だけ課金する（1 杯の伝票では同じ値になる）。
    if (!billWait || r) b.cost(end, 10);
    if (previous.has(item.id) && !r) {
      const old = [...previous.get(item.id)!].sort((a, z) => a - z);
      // 変更の有無も presence で引く（`eq` を作り直さない）。
      const unchanged = b.and(
        position.map((s, a) =>
          leanSlots ? s.presence[old[a]!]! : b.eq(s.slot, b.constant(old[a]!)),
        ),
      );
      const changed = b.variable(0, 1);
      b.linear(
        [
          [unchanged, 1],
          [changed, 1],
        ],
        1,
      );
      // **間もなく始まる杯の釜は重く守る（2026-09-15）。**
      //
      // 現場が「パタパタ動く」と感じるのは**手を伸ばしている先**であって、1 時間後に茹でる杯では
      // ない。一律の重みを上げると遠くの杯まで硬直し、目的関数の他の項（待ち・同時提供）を
      // 押し退けてしまう。**見えている範囲だけを重くする。**
      //
      // 判定は**前回の提案の開始時刻**で行う——「いま」からの距離である。今回の計画の開始時刻で
      // 判定すると、遠くへ動かした杯が「もう Head ではない」と自称して安く逃げられる。
      const previousStart = previousStartOf?.get(item.id);
      const nearHead = previousStart !== undefined && previousStart - now <= headHorizonSeconds;
      b.cost(changed, 10 * p.slotChangeCost * (nearHead ? headSlotChangeFactor : 1));
    }
  }
  if (billWait) {
    b.section = "bill/wait+spread";
    // **伝票ごとに 1 度だけ課金する（2026-09-13・ユーザー提案）。**
    //
    // 「伝票の待ち＝最後の 1 杯が出るまで」と定めると、そろえる圧力が定義から出る——別の項で
    // 買い足す必要がない。到着時刻は定数なので目的には効かず、最遅そのものを課金すれば足りる。
    //
    // **1 杯の伝票は退化した場合であって例外ではない。** 最大も最小もその杯自身なので新しい
    // 変数を作らず、費用は従来（杯ごとの上がり時刻 × 10）と**完全に同じ**になる。実データでは
    // 伝票の 77% が 1 杯なので、増える変数は伝票の 2 割ぶんの高々 2 個ずつである。
    //
    // 杯数を重みに掛ける（α=1）。**伝票間の優先度は現行と同じ**——現行も杯ごとの総和ゆえ
    // 3 杯の伝票は 3 倍の重みを持つ。1 組 1 回と数える（α=0）ほうが優先度を変える側である。
    const byBill = new Map<string, number[]>();
    for (let i = 0; i < jobs.length; i++) {
      if (occupied.has(jobs[i]!.id)) continue;
      const key = jobs[i]!.order;
      const group = byBill.get(key);
      if (group === undefined) byBill.set(key, [i]);
      else group.push(i);
    }
    for (const group of byBill.values()) {
      if (group.length === 1) {
        b.cost(ends[group[0]!]!, 10);
        continue;
      }
      const last = b.max(
        group.map((i): Terms => [[ends[i]!, 1]]),
        now + 1,
        horizon,
      );
      b.cost(last, 10 * group.length);
      const first = b.min(
        group.map((i) => ends[i]!),
        now + 1,
        horizon,
      );
      // 広がり＝最遅 − 最早。非負なので下限 0 の変数 1 個で表せる。
      const spread = b.variable(0, horizon);
      b.linear(
        [
          [last, 1],
          [first, -1],
          [spread, -1],
        ],
        0,
      );
      b.cost(spread, billSpreadWeight);
    }
  }
  b.section = "noOverlap";
  for (const intervals of slotIntervals) b.model.constraints.push({ kind: "noOverlap", intervals });
  if (past.length) {
    const last = Math.max(...past.map((v) => v.end));
    const count = past.filter((v) => v.end === last).length;
    const next = b.min(ends, now + 1, horizon);
    b.cost(
      b.positive(
        [
          [b.constant(last + gapTarget(count)), 1],
          [next, -1],
        ],
        gapTarget(count),
      ),
      p.gapShortfallWeight * 10,
    );
  }
  const distances = new Map<string, number[]>();
  const geometric = (a: { x: number; y: number }, z: { x: number; y: number }) => {
    const dx = b.max(
      [
        [
          [a.x, 1],
          [z.x, -1],
        ],
        [
          [z.x, 1],
          [a.x, -1],
        ],
      ],
      0,
      maxDistance,
    );
    const dy = b.max(
      [
        [
          [a.y, 1],
          [z.y, -1],
        ],
        [
          [z.y, 1],
          [a.y, -1],
        ],
      ],
      0,
      maxDistance,
    );
    const maximum = b.max([[[dx, 1]], [[dy, 1]]], 0, maxDistance);
    const d = b.variable(0, maxDistance);
    b.linear(
      [
        [d, 1],
        [maximum, -6],
        [dx, -4],
        [dy, -4],
      ],
      0,
    );
    return d;
  };
  /** クラスタ数の上限（`leanPairs` のときだけ意味を持つ）。0 は「クラスタ骨格を使っていない」。 */
  let clusterCap = 0;
  b.section = "pair/equal+inversion+distance";
  const equal: number[][] = jobs.map(() => []);
  for (let i = 0; i < jobs.length; i++) {
    for (let a = 0; a < slots[i]!.length; a++)
      for (let z = a + 1; z < slots[i]!.length; z++) {
        const d = geometric(slots[i]![a]!, slots[i]![z]!);
        b.cost(
          b.positive(
            [
              [d, 1],
              [b.constant(10), -1],
            ],
            maxDistance,
          ),
          p.multiSlotDistanceWeight,
        );
      }
    for (let j = i; j < jobs.length; j++) {
      // `leanPairs` ではクラスタ所属 bool が同一時刻を表すので、全組の `eq` は作らない
      // ——E2（クラスタ数）と E3（間隔）も同じ骨格に乗るため、これが最後の全組の項だった。
      const same = leanPairs ? 0 : i === j ? b.constant(1) : b.eq(ends[i]!, ends[j]!);
      if (!leanPairs) {
        equal[i]![j] = same;
        equal[j]![i] = same;
      }
      if (i === j) continue;
      // E7。旧＝全組の逆転。新（`leanPairs`）＝購入順で隣接する組だけ（下で組む）。
      if (!leanInversions && jobs[i]!.purchasedAt !== jobs[j]!.purchasedAt) {
        const older = jobs[i]!.purchasedAt < jobs[j]!.purchasedAt ? i : j;
        const newer = older === i ? j : i;
        b.cost(b.gt(ends[older]!, ends[newer]!), 10 * inversionCost);
      }
      // **距離の生成は E4 が要求していた。** `leanPairs` では E4 が広がりで測るので、
      // 距離が要るのは E8（同一注文の組）だけになる。生成をそこへ限る（E8 の意味は不変）。
      //
      // `billWait` では E8 も作らない——伝票の内側の広がり（時刻）が同じ役目を果たすうえ、
      // **E8 は組ごとの距離ゆえ伝票の大きさの 2 乗**で増える。伝票ごとの集約は最大 2 変数である。
      if (billWait) continue;
      if (leanPairs && jobs[i]!.order !== jobs[j]!.order) continue;
      const ds = slots[i]!.flatMap((a) => slots[j]!.map((z) => geometric(a, z)));
      distances.set(`${i}:${j}`, ds);
      // E4（旧）。組ごとの距離を同一クラスタ条件つきで加算する。
      if (!leanPairs)
        for (const d of ds) b.cost(b.conditional(d, same), p.simultaneousDistanceWeight);
    }
  }
  if (leanInversions) {
    // **E7（新）：購入順で隣接する組の逆転だけを数える。** 全組では 1 つの遅れが後続すべてと
    // 組を作って増幅されるが、厨房で見えるのは「先に買った人の後に出た」という個々の事実である。
    const byPurchase = jobs
      .map((job, index) => ({ index, at: job.purchasedAt }))
      .sort((a, z) => a.at - z.at || a.index - z.index);
    for (let k = 0; k + 1 < byPurchase.length; k++) {
      const older = byPurchase[k]!;
      const newer = byPurchase[k + 1]!;
      if (older.at === newer.at) continue;
      b.cost(b.gt(ends[older.index]!, ends[newer.index]!), 10 * inversionCost);
    }
  }
  if (leanPairs) {
    // **クラスタを所属 bool で持つ（2026-09-13）。** 変数を引く element は実モデルの中で
    // ソルバーを落としたが、最小再現（`probe-elementvars-domain.mjs`）では幅 27,000・杯 32 でも
    // 落ちなかった——原因は element 単独ではない。**定石の形（enforcement literal 付きの線形だけ）
    // へ置き換える。** element も全組の `equal` も `next` も消え、E2・E3 も同じ骨格に乗る。
    //
    //   所属      x[i][k]（杯 i がクラスタ k）。杯ごとに「ちょうど 1 つ」を線形 1 本
    //   時刻の一致 x[i][k] ⇒ end_i = T_k
    //   対称性    T_k は狭義単調増加（同じクラスタ番号 ⟺ 同じ上がり時刻）
    //   E4 広がり x[i][k] ⇒ minX_k ≤ 座標 ≤ maxX_k。費用は maxX_k − minX_k と y 側
    //   E2 個数   used_k ≥ x[i][k] を数える
    //   E3 間隔   T_{k+1} − T_k の不足を、used_{k+1} の条件つきで費用にする
    // **クラスタ数は hint が要した数＋余裕に寄せる。** 所属 bool は杯数 × クラスタ数だけ制約を作る
    // ので、ここが proto のバイト数を決める（上限 64 で 1 MiB を超えた）。hint（実行可能な貪欲解）が
    // 使ったクラスタ数は実行可能性に足りる上限であり、余裕はそれより細かく割る自由のためである。
    // **これはモデルの制限である**——「相異なる上がり時刻は高々 K 個」を強いるので、それより多くの
    // クラスタに割る解は除かれる。E2 がクラスタ数を罰するので最適解は少ない側に寄るが、除外は除外である。
    const CLUSTER_MARGIN = 4;
    const hintedEnds = [...new Set(hints.map((hint) => hint.end))].sort((a, z) => a - z);
    const clusterCount = Math.max(
      1,
      Math.min(jobs.length, shape.clusterCap ?? hintedEnds.length + CLUSTER_MARGIN),
    );
    clusterCap = clusterCount;
    // T_k の定義域は締める（伝播に効き、費用が無い）。最短の茹で時間より早くは上がらない。
    const soonest = Math.min(
      ...jobs.map((job) => {
        const r = occupied.get(job.id);
        return r
          ? r.end
          : now + job.boilSeconds - Math.floor((job.boilSeconds * h.tolerancePercent) / 100);
      }),
    );
    // **クラスタ時刻の下限は「最も早く上がる杯」である（2026-09-13 修正）。**
    //
    // `now + 1` で床を張ると、**lead の窓の内側で上がる走行中**（`r.end < now + 1`）がどのクラスタ
    // 時刻にも一致できず、`x ⇒ end = T_k` を満たせなくなって求解が `INFEASIBLE` になる。
    // `now` は受領の見込み時刻なので、走行中はそれより前に上がりうる——上がる時刻は事実である。
    const timeLo = soonest;
    const timeHi = horizon + clusterCount;
    // **hint はクラスタまで通す。** 所属だけ渡して時刻を渡さないと、hint は `x ⇒ end = T_k` を
    // 満たさず手がかりにならない——累積資源のときと同じ失敗である（2026-09-13）。
    // hint が置いた上がり時刻の相異なる値がそのままクラスタ時刻になる。
    const hintedTime = (k: number) =>
      Math.min(timeHi, k < hintedEnds.length ? hintedEnds[k]! : (hintedEnds.at(-1) ?? timeLo) + k);
    const clusterTime: number[] = [];
    for (let k = 0; k < clusterCount; k++) {
      const t = b.variable(timeLo, timeHi);
      if (k > 0)
        b.linear(
          [
            [t, 1],
            [clusterTime[k - 1]!, -1],
          ],
          1,
          INF,
        );
      b.hint("cluster", [t, Math.max(timeLo, hintedTime(k))]);
      clusterTime.push(t);
    }
    const axis = (values: readonly number[]) => {
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      const high = Array.from({ length: clusterCount }, () => b.variable(lo, hi));
      const low = Array.from({ length: clusterCount }, () => b.variable(lo, hi));
      for (let k = 0; k < clusterCount; k++)
        b.linear(
          [
            [high[k]!, 1],
            [low[k]!, -1],
          ],
          0,
          INF,
        );
      return { high, low, lo, hi };
    };
    const spans = [axis(xs), axis(ys)];
    const used = Array.from({ length: clusterCount }, () => b.variable(0, 1));
    const sizes = Array.from({ length: clusterCount }, (): Terms => []);
    /** 所属 bool を杯ごとに控える（`x[i][k]`）。伝票のまとまりを等式で書くのに要る。 */
    const membership: number[][] = [];
    for (let i = 0; i < jobs.length; i++) {
      const row: Terms = [];
      for (let k = 0; k < clusterCount; k++) {
        const member = b.variable(0, 1);
        row.push([member, 1]);
        sizes[k]!.push([member, 1]);
        b.linear(
          [
            [ends[i]!, 1],
            [clusterTime[k]!, -1],
          ],
          0,
          0,
          [member],
        );

        for (const position of slots[i]!)
          for (const [index, span] of spans.entries()) {
            const coordinate = index === 0 ? position.x : position.y;
            b.linear(
              [
                [span.high[k]!, 1],
                [coordinate, -1],
              ],
              0,
              INF,
              [member],
            );
            b.linear(
              [
                [span.low[k]!, 1],
                [coordinate, -1],
              ],
              -INF,
              0,
              [member],
            );
          }
        b.hint("cluster", [member, hintedEnds[k] === hints[i]!.end ? 1 : 0]);
      }
      b.linear(row, 1);
      membership.push(row.map(([variable]) => variable));
    }
    if (billCluster) {
      // **同じ伝票の杯は同じクラスタに置く（2026-09-13・費用ではなく構造で決める）。**
      //
      // クラスタは「同じ時刻に上がる杯の組」なので、同一伝票を同一クラスタへ縛れば**同時提供が
      // 構造として成立する**——広がりに値段を付けて誘導する必要が消える。
      //
      // **費用で誘導しても効かないことを先に測ってある**：広がりの重みを 10 → 1000 と振っても
      // 単調に減らず（5,042 → 3,892 → 3,304 → 3,664 → 3,959 秒）、探索予算を 6 倍にしても
      // 目的値が 3 桁目まで動かなかった。この予算では、費用は出発点の近傍を順位付けするだけである。
      //
      // **逃げ道を 1 つ置く。** 釜が足りない・上げ窓に入らないなどで同じクラスタに置けない局面は
      // 実在するので、伝票ごとに「割ってよい」bool を 1 個だけ持ち、大きい費用を付ける。
      // 連続の重みではなく二値なので、探索は「割るか割らないか」だけを決めればよい。
      const byBill = new Map<string, number[]>();
      for (let i = 0; i < jobs.length; i++) {
        if (occupied.has(jobs[i]!.id)) continue;
        const key = jobs[i]!.order;
        const group = byBill.get(key);
        if (group === undefined) byBill.set(key, [i]);
        else group.push(i);
      }
      for (const group of byBill.values()) {
        if (group.length < 2) continue;
        const split = b.variable(0, 1);
        const keep = b.variable(0, 1);
        b.linear(
          [
            [split, 1],
            [keep, 1],
          ],
          1,
        );
        const head = group[0]!;
        for (const other of group.slice(1))
          for (let k = 0; k < clusterCount; k++)
            b.linear(
              [
                [membership[other]![k]!, 1],
                [membership[head]![k]!, -1],
              ],
              0,
              0,
              [keep],
            );
        b.cost(split, billSplitCost);
        // hint も同じ答えを持たせる（出発点が伝票を割っていれば split = 1）。
        const same = group.every((i) => hints[i]!.end === hints[head]!.end);
        b.hint("bill", [split, same ? 0 : 1], [keep, same ? 1 : 0]);
      }
    }
    for (let k = 0; k < clusterCount; k++) {
      // `used_k` は杯ごとに 1 本ではなく、クラスタごとに 1 本で縛る（制約の本数が杯数 × クラスタ数
      // から クラスタ数 へ落ちる。proto のバイト数がここで効く）。
      b.linear([...sizes[k]!, [used[k]!, -jobs.length]], -INF, 0);
      // E2。クラスタ 1 つにつき 1 回。
      b.cost(used[k]!, 10 * p.clusterCost);
      // E4。距離の形は旧い定義に揃える（10·max + 4·min）。
      const widths = spans.map((span) => {
        const width = b.variable(0, span.hi - span.lo);
        b.linear(
          [
            [width, 1],
            [span.high[k]!, -1],
            [span.low[k]!, 1],
          ],
          0,
        );
        return width;
      });
      b.cost(
        b.max(
          widths.map((w): Terms => [[w, 1]]),
          0,
          maxDistance,
        ),
        p.simultaneousDistanceWeight * 10,
      );
      b.cost(b.min(widths, 0, maxDistance), p.simultaneousDistanceWeight * 4);
      // E3。隣のクラスタとの間隔が、このクラスタの杯数に応じた目標に足りない分。
      if (k + 1 >= clusterCount) continue;
      const size = b.variable(0, jobs.length);
      b.linear([...sizes[k]!, [size, -1]], 0);
      const target = b.element(
        size,
        Array.from({ length: jobs.length + 1 }, (_, count) => gapTarget(count)),
      );
      const shortfall = b.positive(
        [
          [target, 1],
          [clusterTime[k]!, 1],
          [clusterTime[k + 1]!, -1],
        ],
        gapTarget(jobs.length),
      );
      b.cost(b.conditional(shortfall, used[k + 1]!), p.gapShortfallWeight * 10);
    }
  }
  b.section = "liftWindow+cluster";
  // **上げ窓は累積資源で表す（2026-09-13・E1 の再定義）。**
  //
  // 区間を `[上がり時刻, 上がり時刻 + L)` に取ると、時刻 t を覆う区間の集合は「`(t − L, t]` に
  // 上がる杯」そのものになる。ゆえに 1 本の `cumulative` が**すべての長さ L の窓**を同時に縛る
  // ——杯の組ごとに窓の内外を判定する形（2 乗）が、区間 n 本と制約 2 本に置き換わる。
  //
  // ハードとソフトを**同じ骨格**に乗せる。値段と禁止が別の構造を見ていたことが、engine の
  // `withinLiftCap` と食い違った原因だった。
  //   容量 `arms`      に「手伝いを頼まなかった分」の需要 → 超えられない＝arms を超える分は必ず手伝う
  //   容量 `HELPER_ARMS` に「手伝った分」の需要         → 手は 2 本まで（ハード上限 arms + 2）
  // E1 の費用は「手伝った杯数（占有換算）」である。**旧い形の「クラスタごとの超過の和」とは
  // 数え方が違う**——窓が重なるとき、旧は同じ超過を複数のクラスタで数えうるが、新は手を 1 回だけ
  // 数える。手伝いは瞬間に要る手の数で決まるので、新しい定義のほうが厨房の負荷に近い。
  if (cumulativeLift) {
    const windowSize = b.constant(h.liftWindow);
    // **固定分（走行中・過去の上がり）と自由な杯を分ける（2026-09-13）。**
    //
    // 固定分をそのまま需要として載せると、**人が既に上限を超える杯を同じ窓へ走らせている局面で
    // モデルが実行不能になる**。engine はそうしない——`withinLiftCap` は「t を含む窓で
    // 既存 + span ≤ cap」を課すだけで、**既に超えている窓へ足すことだけを拒む**（AC 9.4：
    // 「走行中だけ・過去の boiled だけで既に上限を超えている窓は開始後の事実であって、
    // それを含まない配置を落とす理由にならない」）。実測でもここが食い違っていた——固定分が
    // 上限（arms + 2 = 4）を 1 本超えた瞬間、全局面が `status=UNKNOWN` になった。
    //
    // **固定分の負荷を容量で頭打ちにする。** 時刻の関数として階段状に求解前に計算できる
    // （固定の上がり時刻は定数だから）。帯ごとに `min(固定分, 容量)` を需要として載せれば
    //   固定分 < 容量 … そのまま。自由な杯の余地は `容量 − 固定分` で engine と同じ
    //   固定分 ≥ 容量 … 頭打ち。自由な杯の余地は 0 で「何も足せない」と同じ
    // となり、**緩くなる帯は無い。**
    const fixedLifts: { at: number; span: number }[] = [
      ...jobs.flatMap((item, index) => {
        const r = occupied.get(item.id);
        return r === undefined ? [] : [{ at: r.end, span: item.slotSpan, index }];
      }),
      ...past.map((old) => ({ at: old.end, span: old.slots.length, index: -1 })),
    ];
    const fixedIndexes = new Set(
      jobs.flatMap((item, index) => (occupied.has(item.id) ? [index] : [])),
    );
    // **hint の側で「誰が手伝ってもらうか」まで決める（2026-09-13）。**
    //
    // 以前は `helped` を一律 0 で渡していた。腕 `arms` だけで上がる hint（既存の貪欲は `fits` を
    // `arms` で見る）ならそれで正しいが、**同じ伝票の杯を揃えると 1 つの窓に arms を超える杯が
    // 集まる**——腕 2 本で 3 杯は同時に上げられず、手伝い（+2）が要る。0 のまま渡すと hint は
    // 実行不能になり、ソルバーは最初の実行可能解を自力で探す羽目になる（`status=UNKNOWN`）。
    //
    // 決め方は engine の 2 段（`arms` はソフト・`arms + HELPER_ARMS` はハード）と同じ形である。
    // 上がり時刻の早い順に見て、腕だけで収まるならそのまま、収まらなければ手伝いへ回す。
    const helpedHint = new Set<number>();
    {
      const order = jobs
        .map((_, index) => index)
        .filter((index) => !fixedIndexes.has(index))
        .sort((a, z) => hints[a]!.end - hints[z]!.end || a - z);
      const placedLifts: { at: number; span: number; helped: boolean }[] = [];
      for (const index of order) {
        const at = hints[index]!.end;
        const span = jobs[index]!.slotSpan;
        // ソフト側にも走行中・過去の固定負荷が載る。候補時刻の後に始まる負荷も含める。
        const unhelped = [...fixedLifts, ...placedLifts.filter((lift) => !lift.helped)];
        const needsHelp = !fits(unhelped, at, span, h.arms);
        if (needsHelp) helpedHint.add(index);
        placedLifts.push({ at, span, helped: needsHelp });
      }
    }
    /**
     * 固定分の負荷 `F(t)`（時刻 t を右端とする窓の負荷）を、容量 `capacity` で頭打ちにした
     * 階段関数を、累積資源へ載せられる区間の列にする。帯は互いに素なので、各時点の需要の和が
     * そのまま `min(F(t), capacity)` になる。
     */
    const cappedFixedBands = (capacity: number) => {
      // 変化点は「上がり時刻」（増える）と「上がり時刻 + L」（減る）だけである。
      const points = [
        ...new Set(fixedLifts.flatMap((lift) => [lift.at, lift.at + h.liftWindow])),
      ].sort((a, z) => a - z);
      const bands: { from: number; to: number; demand: number }[] = [];
      for (let k = 0; k + 1 < points.length; k += 1) {
        const from = points[k]!;
        const to = points[k + 1]!;
        const load = fixedLifts
          .filter((lift) => lift.at <= from && from < lift.at + h.liftWindow)
          .reduce((sum, lift) => sum + lift.span, 0);
        const demand = Math.min(load, capacity);
        if (demand > 0) bands.push({ from, to, demand });
      }
      return bands;
    };
    /** 自由な杯の上げ区間 `[end, end + L)`。固定分はここに含めない。 */
    const freeIntervals: number[] = [];
    const freeSpan: { terms: Terms; offset: number }[] = [];
    const freeUnhelped: { terms: Terms; offset: number }[] = [];
    for (let i = 0; i < jobs.length; i++) {
      const [lo, hi] = b.model.variables[ends[i]!]!;
      const liftEnd = b.variable(lo + h.liftWindow, hi + h.liftWindow);
      b.linear(
        [
          [liftEnd, 1],
          [ends[i]!, -1],
        ],
        h.liftWindow,
      );
      const interval = b.model.intervals.length;
      b.model.intervals.push([ends[i]!, windowSize, liftEnd, null]);
      const span = jobs[i]!.slotSpan;
      if (fixedIndexes.has(i)) continue; // 固定分は帯として別に載せる
      freeIntervals.push(interval);
      freeSpan.push({ terms: [], offset: span });
      const helped = b.variable(0, 1);
      b.hint("helper", [helped, helpedHint.has(i) ? 1 : 0]);
      freeUnhelped.push({ terms: [[helped, -span]], offset: span });
      // 手伝いの費用は手の数（占有換算）に比例する。大盛 1 杯を手伝うには手が 2 本要る。
      b.cost(helped, p.liftOverflowCost * 10 * span);
    }
    /** 帯を区間として載せる。開始・終了とも定数なので動かない。 */
    const withBands = (
      capacity: number,
      intervals: number[],
      demands: { terms: Terms; offset: number }[],
    ) => {
      const merged = [...intervals];
      const mergedDemands = [...demands];
      for (const band of cappedFixedBands(capacity)) {
        merged.push(b.model.intervals.length);
        b.model.intervals.push([
          b.constant(band.from),
          b.constant(band.to - band.from),
          b.constant(band.to),
          null,
        ]);
        mergedDemands.push({ terms: [], offset: band.demand });
      }
      b.cumulative(merged, mergedDemands, { terms: [], offset: capacity });
    };
    // **ハード。** 容量 `arms + HELPER_ARMS`。自由な杯は手伝いの有無に関わらず占有を使う。
    // これが engine の `withinLiftCap` と同値の条件である。
    withBands(h.arms + 2, freeIntervals, freeSpan);
    // **ソフト（E1）。** 容量 `arms`。手伝わなかった分だけが乗る。固定分は `arms` で頭打ち——
    // 既に済んだ手伝いを再び費用に数えない。
    withBands(h.arms, freeIntervals, freeUnhelped);
  }
  for (let i = 0; leanPairs ? false : i < jobs.length; i++) {
    const leader = b.and(equal[i]!.slice(0, i).map((same) => -same - 1));
    b.cost(leader, 10 * p.clusterCost);
    const loadTerms: Terms = [];
    for (let j = 0; cumulativeLift ? false : j < jobs.length; j++) {
      const inWindow = b.and([
        -b.gt(ends[j]!, ends[i]!) - 1,
        -b.gt(ends[i]!, ends[j]!, h.liftWindow - 1) - 1,
      ]);
      loadTerms.push([inWindow, jobs[j]!.slotSpan]);
    }
    for (const old of cumulativeLift ? [] : past) {
      const oldTime = b.constant(old.end);
      const inWindow = b.and([
        -b.gt(oldTime, ends[i]!) - 1,
        -b.gt(ends[i]!, oldTime, h.liftWindow - 1) - 1,
      ]);
      loadTerms.push([inWindow, old.slots.length]);
    }
    if (cumulativeLift) {
      // 上で累積資源に載せたので、ここは何もしない。
    } else if (hardLiftCap) {
      // ハード。窓 (ends[i] − L, ends[i]] の負荷が arms + HELPER_ARMS を超える解を作らせない。
      // **engine の条件（t を含むすべての窓）より弱くない**——長さ L のどの窓 W も、W に入る
      // 計画上がりのうち最遅を t* とすれば W の点はすべて (t*−L, t*] に入るので、右端を各上がりに
      // 固定した検査が W を覆う。
      b.linear(loadTerms, -INF, h.arms + 2);
      // arms はソフトのまま（超えた分は手伝いを頼む費用）。ハードにしたので超過は高々 2 である。
      const excess = b.positive([...loadTerms, [b.constant(h.arms), -1]], 2);
      b.cost(b.conditional(excess, leader), p.liftOverflowCost * 10);
    } else {
      const excess = b.positive([...loadTerms, [b.constant(h.arms), -1]], 1000);
      const severe = b.positive([...loadTerms, [b.constant(h.arms + 2), -1]], 1000);
      const first = b.variable(0, 2);
      b.linear(
        [
          [first, 1],
          [severe, 1],
          [excess, -1],
        ],
        0,
      );
      b.cost(b.conditional(first, leader), p.liftOverflowCost * 10);
      b.cost(b.conditional(severe, leader), p.severeLiftOverflowCost * 10);
    }
    const next = b.min(
      ends
        .filter((_, j) => j !== i)
        .map((end) => b.conditional(end, b.gt(end, ends[i]!), horizon + 1000))
        .concat(b.constant(horizon + 1000)),
      now,
      horizon + 1000,
    );
    const size = b.variable(1, jobs.length);
    b.linear([...equal[i]!.map((v): [number, number] => [v, 1]), [size, -1]], 0);
    const target = b.element(
      size,
      Array.from({ length: jobs.length + 1 }, (_, count) => gapTarget(count)),
    );
    const shortfall = b.positive(
      [
        [target, 1],
        [ends[i]!, 1],
        [next, -1],
      ],
      gapTarget(jobs.length),
    );
    b.cost(b.conditional(shortfall, leader), p.gapShortfallWeight * 10);
  }
  const treeObjectiveStart = b.model.objective.length;
  const groups = new Map<string, number[]>();
  for (let i = 0; i < jobs.length; i++)
    groups.set(jobs[i]!.order, [...(groups.get(jobs[i]!.order) ?? []), i]);
  for (const group of groups.values()) {
    // **`billWait` では E8（同一伝票のまとまり）を作らない。** ここは伝票の中の全組に弧変数を
    // 張る木であり、**伝票の大きさの 2 乗**で増える。伝票の内側の広がり（最遅 − 最早・変数 2 個）が
    // 同じ「同じお客の杯をまとめる」役目を果たすので、置き換える（2026-09-13 の試作）。
    // 距離（`distances`）もこのときは生成していないので、引く側もここで閉じる。
    if (billWait || group.length < 2) continue;
    const depth = group.map((_, k) => b.variable(k === 0 ? 0 : 1, k === 0 ? 0 : group.length - 1));
    for (let child = 1; child < group.length; child++) {
      const parents: Terms = [];
      for (let parent = 0; parent < group.length; parent++) {
        if (parent === child) continue;
        const arc = b.variable(0, 1);
        parents.push([arc, 1]);
        b.linear(
          [
            [depth[child]!, 1],
            [depth[parent]!, -1],
          ],
          1,
          INF,
          [arc],
        );
        const a = Math.min(group[child]!, group[parent]!);
        const z = Math.max(group[child]!, group[parent]!);
        const d = b.min(distances.get(`${a}:${z}`)!, 0, maxDistance);
        b.cost(b.and([arc, b.gt(d, b.constant(10))]), p.orderFragmentCost * 10);
        b.cost(
          b.conditional(
            b.positive(
              [
                [d, 1],
                [b.constant(10), -1],
              ],
              maxDistance,
            ),
            arc,
          ),
          p.orderDistanceWeight,
        );
      }
      b.linear(parents, 1);
    }
  }
  b.section = "other";
  // **予算は「難しさ」で決める。変数の数で決めない**（2026-09-13 改訂）。
  //
  // 旧い式は `min(0.2, 0.04 + 変数数/50000)` で、**良い定式化ほど時間をもらえなかった**
  // ——上げ窓を累積資源へ移して変数を 1/3 にしたところ、予算も減って最初の実行可能解に
  // 届かなくなった（実測）。難しさの代理は計画対象の杯数である。杯数はモデルの書き方に依らず、
  // engine 側が求解の前に知っている値でもある（要求の同一性に入れられる）。
  //
  // 上限は 1.0——CP-SAT の決定的時間は (0, 1] しか受け付けない（実測で 3 は拒否された）。
  // **係数は実測で校正する（2026-09-13）。** 4 点とも実測であり、外挿は杯数 32 以上だけである。
  //
  //   杯数 6・走行中 0  → 0.046  旧規則の値。6 では予算が質に還らないことを掃引で確認
  //   杯数 24・走行中 0 → 0.172  最小十分（0.17 で 30/30・それ以上は改善しない）
  //   杯数 24・走行中 2 → 0.336  実測の要件 0.3（10/10。0.2 では 6/10）
  //   杯数 24・走行中 4 → 0.500  実測の要件 0.5（10/10。0.4 では 7/10）
  //   杯数 24・走行中 6 → 0.500  実測の要件 0.5（10/10。走行中 4 本で頭打ち）
  //
  // **走行中の寄与は頭打ちを持つ。** 4 本で飽和するので、直線を引くと 6 本以上で過大に払う。
  // 走行中が効くのは「釜を別々の時刻まで塞いで断片化する」ためで、本数に比例して難しくなる
  // わけではない。**杯数だけを難しさの代理にしていた前の式はこれを捉えていなかった**
  // ——1108（人が操作している店舗）の求解失敗 61% の後半がこれである。
  // **hint を固定する（`fixHints`）。** 宣言だけ在って `formulate` が読んでいなかった
  // ——2026-09-13 に判明。それまでの「hint の実行可能性検査」は**何も固定せずに解いていた**ので、
  // 検査として働いていない。ここで hint の各変数を等式で縛る：返れば hint はモデルの制約を
  // 満たしており、返らなければ満たしていない。
  //
  // **外から解を渡して目的値を読む用途にも使う**（`seed` ＋ `fixHints`）——別の計画器の解を
  // この目的関数で採点すれば、「モデルの最適解が本当にそこにあるのか」を切り分けられる。
  // **固定が当たったことを検算する。** 鍵の形が違うと一致せず、固定は黙って効かない
  // ——`#` で組んで一度これを踏んだ（2026-09-15）。効かない固定は結果を返すので、
  // 突き合わせない限り「維持できた」と誤読する。
  if (shape.holdSlots !== undefined)
    for (const id of shape.holdSlots.keys())
      assert(heldMatched.has(id), `holdSlots key did not match any item: ${JSON.stringify(id)}`);
  if (shape.fixHints)
    for (const [variable, value] of b.model.hints) b.linear([[variable, 1]], value);
  // **種別を挙げた分だけ固定する（`fixHintSections`）。** `fixHints` の二分に使う。
  if (shape.fixHintSections !== undefined) {
    const wanted = new Set(shape.fixHintSections);
    assert.equal(b.hintKinds.length, b.model.hints.length, "hint kinds must track hints");
    b.model.hints.forEach(([variable, value], index) => {
      if (wanted.has(b.hintKinds[index]!)) b.linear([[variable, 1]], value);
    });
  }
  // **完全 hint で置き換える（`completeHint`）。** 固定解の全変数をそのまま出発点にする。
  // 添字は `formulate` の組み立て順であり、`fixHints` は制約を足すだけで変数を増やさないので、
  // 同じ shape で組み直せば 1 度目の解ベクトルとそのまま対応する。
  if (shape.completeHint !== undefined) {
    assert.equal(
      shape.completeHint.length,
      b.model.variables.length,
      "completeHint length must match the variable count",
    );
    b.model.hints = shape.completeHint.map((value, index) => [index, value] as [number, number]);
  }
  b.model.budget =
    shape.budget ?? Math.min(1, 0.004 + jobs.length * 0.007 + Math.min(running.length, 4) * 0.082);
  const decode = (solution: number[]): Placement[] => {
    assert.equal(solution.length, b.model.variables.length, "Incomplete solution vector");
    assert(
      solution.every(
        (v, i) =>
          Number.isSafeInteger(v) && v >= b.model.variables[i]![0] && v <= b.model.variables[i]![1],
      ),
    );
    return jobs.map((item, i) => ({
      ...item,
      start: solution[starts[i]!]!,
      end: solution[ends[i]!]!,
      slots: slots[i]!.map((s) => solution[s.slot]!),
    }));
  };
  /**
   * **hint が変数の定義域から外れている箇所**（2026-09-15）。
   *
   * ここに 1 つでも在れば、`fixHints` は必ず `INFEASIBLE` になる——他の制約を見るまでもない。
   * 定義域は `formulate` が自分で決めた上下限なので、外れているなら**貪欲 hint と
   * モデルの前提が食い違っている**ということである。種別つきで返す。
   */
  const hintOutOfDomain = b.model.hints.flatMap(([variable, value], index) => {
    const [lo, hi] = b.model.variables[variable]!;
    return value >= lo && value <= hi
      ? []
      : [{ kind: b.hintKinds[index] ?? "?", variable, value, lo, hi }];
  });
  /**
   * **hint が要求している圧力**（2026-09-15）。`fixHints` が `INFEASIBLE` を返したとき、
   * どの容量を超えているかを名指すために測る。時刻だけで決まる二つを見る——
   * **釜の同時占有**（釜の本数を超えれば、どう割り当てても入らない）と
   * **上げ窓の負荷**（窓の中で上げる杯数が腕を超えれば、ハードな上限に当たる）。
   */
  const hintPressure = (() => {
    const edges = [...new Set(hints.map((p) => p.start))].sort((a, z) => a - z);
    let concurrent = 0;
    let concurrentAt = 0;
    for (const t of edges) {
      const load = hints
        .filter((p) => p.start <= t && t < p.end)
        .reduce((sum, p) => sum + p.slots.length, 0);
      if (load > concurrent) {
        concurrent = load;
        concurrentAt = t;
      }
    }
    const lifts = [
      ...past.map((old) => ({ at: old.end, span: old.slots.length })),
      ...hints.map((p) => ({ at: p.end, span: p.slots.length })),
    ];
    let lift = 0;
    let liftAt = 0;
    for (const one of lifts) {
      const load = lifts
        .filter((other) => other.at > one.at - h.liftWindow && other.at <= one.at)
        .reduce((sum, other) => sum + other.span, 0);
      if (load > lift) {
        lift = load;
        liftAt = one.at;
      }
    }
    return {
      concurrent,
      concurrentAt,
      kettles: h.coordinates.length,
      unavailable: unavailableSlots.length,
      lift,
      liftAt,
      arms: h.arms,
    };
  })();
  return {
    model: b.model,
    hintOutOfDomain,
    hintPressure,
    /** 変数の内訳（どの構造が作ったか）。ダイエットの当て所を実測で決めるためだけに在る。 */
    bySection: b.bySection,
    /** クラスタ数の上限（モデルの制限）。上限に張り付いた回を後から数えるために返す。 */
    clusterCap,
    decode,
    hints,
    treeObjective: (solution: number[]) =>
      b.model.objective
        .slice(treeObjectiveStart)
        .reduce((sum, [v, w]) => sum + solution[v]! * w, 0),
    offset: jobs.reduce((sum, j) => sum + j.purchasedAt * 10, 0),
  };
}

function validate(
  h: History,
  now: number,
  jobs: readonly Item[],
  placements: readonly Placement[],
  running: readonly Placement[],
): void {
  assert.equal(placements.length, jobs.length);
  assert.equal(new Set(placements.map((p) => p.id)).size, jobs.length);
  const started = new Map(running.map((r) => [r.id, r]));
  for (const item of jobs) {
    const p = placements.find((v) => v.id === item.id);
    assert(p);
    assert(Number.isSafeInteger(p.start) && Number.isSafeInteger(p.end));
    assert.equal(p.slots.length, item.slotSpan);
    assert.equal(new Set(p.slots).size, p.slots.length);
    for (const s of p.slots) assert(Number.isInteger(s) && s >= 0 && s < h.coordinates.length);
    const tolerance = Math.floor((item.boilSeconds * h.tolerancePercent) / 100);
    assert(Math.abs(p.end - p.start - item.boilSeconds) <= tolerance);
    assert(p.end >= now);
    const old = started.get(item.id);
    if (old) {
      assert.equal(p.start, old.start);
      assert(sameSlots(p.slots, old.slots));
    } else assert(p.start >= now);
  }
  for (let i = 0; i < placements.length; i++)
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i]!;
      const b = placements[j]!;
      assert(
        a.end <= b.start || b.end <= a.start || !a.slots.some((s) => b.slots.includes(s)),
        "Overlapping slot occupancy",
      );
    }
}

/** Closed-loop, isolated hypothesis replay; never invokes the production engine. */
export async function replayOrderHistory(
  history: History,
  planPreferences: SchedulePreferences,
  solve: Solve,
  options: { readonly pendingLimit?: number; readonly maxSolves?: number } = {},
) {
  const p = preferences(planPreferences);
  const h = history;
  const window = h.evaluationWindow;
  if (window)
    assert(
      Number.isSafeInteger(window.start) &&
        Number.isSafeInteger(window.end) &&
        window.start >= 0 &&
        window.end > window.start,
    );
  const include = (j: Item) =>
    !window || (j.purchasedAt >= window.start && j.purchasedAt < window.end);
  assert(h.items.some(include), "Empty evaluation cohort");
  assert(h.items.length > 0 && h.items.length <= 200);
  assert.equal(new Set(h.items.map((j) => j.id)).size, h.items.length);
  assert(h.coordinates.length >= 2 && h.coordinates.length <= 24);
  assert(h.coordinates.every((c) => Number.isSafeInteger(c.x) && Number.isSafeInteger(c.y)));
  assert(
    h.items.every(
      (j) =>
        Number.isSafeInteger(j.purchasedAt) &&
        j.purchasedAt >= 0 &&
        Number.isSafeInteger(j.boilSeconds) &&
        j.boilSeconds > 0 &&
        Number.isInteger(j.slotSpan) &&
        j.slotSpan >= 1 &&
        j.slotSpan <= 2,
    ),
  );
  assert(
    Number.isSafeInteger(h.tolerancePercent) &&
      h.tolerancePercent >= 0 &&
      h.tolerancePercent < 100 &&
      Number.isSafeInteger(h.arms) &&
      h.arms >= 1 &&
      Number.isSafeInteger(h.liftWindow) &&
      h.liftWindow > 0,
  );
  const items = [...h.items].sort(
    (a, b) => a.purchasedAt - b.purchasedAt || a.id.localeCompare(b.id),
  );
  const pendingLimit = options.pendingLimit ?? 6;
  assert(Number.isInteger(pendingLimit) && pendingLimit >= 1 && pendingLimit <= 20);
  const completed: Placement[] = [];
  let running: Placement[] = [];
  let now = items[0]!.purchasedAt;
  let previous = new Map<string, readonly number[]>();
  let plans: Placement[] = [];
  let solveCount = 0;
  let fallbackCount = 0;
  let slotChanges = 0;
  let fragmentMinutes = 0;
  let distanceMinutes = 0;
  let maxVariables = 0;
  let maxConstraints = 0;
  let maxDeterministicTime = 0;
  let optimalObjectiveChecks = 0;
  let feasibleObjectiveChecks = 0;
  let maxAuxiliaryTreeGap = 0;
  let reportedObjectiveMismatches = 0;
  let maxReportedObjectiveGap = 0;
  let steps = 0;
  const statuses: Record<string, number> = {};
  let nextStart = now;
  let dirty = true;
  const trace: { at: number; started: string[]; lifted: string[] }[] = [];
  while (completed.length < items.length) {
    assert(++steps <= 100000, "Replay event-step limit exceeded");
    assert(
      now <= items.at(-1)!.purchasedAt + 14400,
      "Replay horizon exceeded; no dropping unfinished items",
    );
    // Fire the already scheduled lift before arrivals can trigger a replan.
    const lifted = running.filter((r) => r.end <= now);
    if (lifted.length) {
      assert(
        lifted.every((r) => r.end === now),
        "Missed lift event",
      );
      completed.push(...lifted);
      running = running.filter((r) => r.end > now);
      dirty = true;
    }
    const doneIds = new Set(completed.map((j) => j.id));
    const startedIds = new Set(running.map((j) => j.id));
    const pending = items.filter(
      (j) => j.purchasedAt <= now && !doneIds.has(j.id) && !startedIds.has(j.id),
    );
    if (dirty && (pending.length || running.length)) {
      assert(solveCount < (options.maxSolves ?? 1000), "Solve limit exceeded");
      const jobs = [...running, ...pending.slice(0, pendingLimit)];
      const lastLift = Math.max(-Infinity, ...completed.map((j) => j.end));
      const recent = completed.filter((j) => j.end > now - h.liftWindow || j.end === lastLift);
      const built = formulate(h, now, jobs, running, previous, recent, p);
      const response = await solve(built.model);
      solveCount++;
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      maxVariables = Math.max(maxVariables, response.modelVariables);
      maxConstraints = Math.max(maxConstraints, response.modelConstraints);
      maxDeterministicTime = Math.max(maxDeterministicTime, response.deterministicTime);
      assert(
        response.status !== "MODEL_INVALID" && response.status !== "INFEASIBLE",
        `Unexpected ${response.status}`,
      );
      const found = response.status === "OPTIMAL" || response.status === "FEASIBLE";
      const candidate = found ? built.decode(response.solution) : built.hints;
      if (!found) fallbackCount++;
      validate(h, now, jobs, candidate, running);
      const changeBaseline = new Map([...previous].filter(([id]) => !startedIds.has(id)));
      const score = evaluate(h, candidate, changeBaseline, recent);
      if (found) {
        const independent = total(score, p) * 10 + built.offset;
        const actual = built.model.objective.reduce(
          (sum, [v, w]) => sum + response.solution[v]! * w,
          0,
        );
        const tree = built.treeObjective(response.solution);
        const canonicalTree =
          (score.orderFragments * p.orderFragmentCost +
            score.orderDistance * p.orderDistanceWeight) *
          10;
        assert(tree + 0.001 >= canonicalTree, "Invalid tree cost");
        assert(
          Math.abs(independent - (actual - tree + canonicalTree)) < 0.001,
          "Independent feature objective mismatch",
        );
        // Observed 9.15 FEASIBLE responses sometimes report an objective above
        // that of their returned solution. Preserve and report this discrepancy;
        // never use the reported value to score a replay or hide a model mismatch.
        assert(
          response.objective !== null && actual <= response.objective + 0.001,
          `Solution objective ${actual} > reported CP ${response.objective}`,
        );
        maxAuxiliaryTreeGap = Math.max(maxAuxiliaryTreeGap, (tree - canonicalTree) / 10);
        maxReportedObjectiveGap = Math.max(
          maxReportedObjectiveGap,
          (response.objective - actual) / 10,
        );
        if (Math.abs(response.objective - actual) > 0.001) reportedObjectiveMismatches++;
        if (response.status === "OPTIMAL") {
          assert(Math.abs(independent - response.objective) < 0.001, "Optimal objective mismatch");
          optimalObjectiveChecks++;
        } else feasibleObjectiveChecks++;
      }
      for (const c of candidate)
        if (
          include(c) &&
          !startedIds.has(c.id) &&
          previous.has(c.id) &&
          !sameSlots(previous.get(c.id)!, c.slots)
        )
          slotChanges++;
      previous = new Map(
        candidate.filter((c) => !startedIds.has(c.id)).map((c) => [c.id, c.slots]),
      );
      running = candidate.filter((c) => startedIds.has(c.id));
      plans = candidate.filter((c) => !startedIds.has(c.id));
    }
    dirty = false;
    const occupied = new Set(running.flatMap((r) => r.slots));
    const ready = plans
      .filter(
        (v) =>
          v.start <= now &&
          !completed.some((c) => c.id === v.id) &&
          !v.slots.some((s) => occupied.has(s)),
      )
      .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    const started: string[] = [];
    if (now >= nextStart && ready.length) {
      const chosen = ready[0]!;
      // A late start reanchors the recipe; it cannot inherit an impossibly short boil.
      const start: Placement = { ...chosen, start: now, end: chosen.end + now - chosen.start };
      running.push(start);
      plans = plans.filter((v) => v.id !== chosen.id);
      previous.delete(chosen.id);
      nextStart = now + 3;
      started.push(chosen.id);
      dirty = true;
    }
    if (started.length || lifted.length)
      trace.push({ at: now, started, lifted: lifted.map((r) => r.id) });
    if (completed.length === items.length) break;
    if (dirty) continue;
    const futureArrivals = items.filter((i) => i.purchasedAt > now).map((i) => i.purchasedAt);
    const possibleStarts = plans.map((v) => Math.max(now + 1, nextStart, v.start));
    const next = Math.min(...futureArrivals, ...running.map((r) => r.end), ...possibleStarts);
    assert(Number.isFinite(next) && next > now, "Replay cannot advance");
    const spatial = fragments(h, running.filter(include));
    fragmentMinutes += (spatial.count * (next - now)) / 60;
    distanceMinutes += (spatial.distance * (next - now)) / 60;
    dirty = futureArrivals.includes(next);
    now = next;
  }
  validate(h, 0, items, completed, []);
  assert(completed.every((j) => j.start >= j.purchasedAt));
  const features = { ...evaluate(h, completed, new Map(), [], include), slotChanges };
  const cohort = completed.filter(include);
  const waits = cohort.map((j) => j.end - j.purchasedAt).sort((a, b) => a - b);
  // Presentation scatter is evaluated over actual concurrent occupants, not
  // all historical assignments on slots reused at different times.
  const fixed =
    total({ ...features, orderFragments: 0, orderDistance: 0 }, DEFAULTS) +
    fragmentMinutes * 10 +
    distanceMinutes;
  return {
    historyId: h.id,
    completedItems: completed.length,
    expectedItems: items.length,
    evaluationWindow: window ?? null,
    evaluatedItems: cohort.length,
    waitSummary: {
      total: features.waitSeconds,
      mean: features.waitSeconds / cohort.length,
      p95: waits[Math.ceil(waits.length * 0.95) - 1]!,
      max: waits.at(-1)!,
      over720Seconds: waits.filter((w) => w > 720).length,
    },
    features,
    fragmentMinutes,
    distanceMinutes,
    fixedScore: fixed,
    solveCount,
    fallbackCount,
    statuses,
    maxVariables,
    maxConstraints,
    maxDeterministicTime,
    optimalObjectiveChecks,
    feasibleObjectiveChecks,
    maxAuxiliaryTreeGap,
    reportedObjectiveMismatches,
    maxReportedObjectiveGap,
    finishedAt: now,
    placements: completed,
    trace,
  };
}
