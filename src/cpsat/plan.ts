import {
  adjacentInversions,
  evaluate,
  total,
  allInversions,
  formulate,
  simultaneousPairDistance,
  simultaneousPairMax,
  simultaneousPairMean,
  simultaneousSpread,
  type History,
  type Item,
  type ModelShape,
  type Placement as ModelPlacement,
  type ScheduleEvaluation,
} from "../../experiments/cpsat-workers/tuning/schedule";
import defaults from "../../experiments/cpsat-workers/tuning/defaults.json";
import { runtime, solve } from "../../experiments/cpsat-workers/src/runtime";
import { position } from "../domain/store";
import { itemKeyOf } from "../domain/order";
import { adjustedEndTime, tableKeyOf } from "../engine/project";
import { initialLifts, liftsOf, withinLiftCap } from "../engine/lift";
import { boilMillisOf } from "../engine/boil";
import { toCookSchedule, type CookSchedule } from "../engine/schedule";
import { encodeModel } from "./protobuf";
import { validateSolution } from "./validate";
import {
  cpsatTargets,
  CPSAT_DELIVERY_LEAD_MS,
  CPSAT_TARGET_LIMIT,
  type CpsatPlanRequest,
} from "./request";

/** モデル規模の上限。この 2 値は**実行時を有界に保つための防壁**で、本番はこの値で動く。 */
export const CPSAT_MODEL_VARIABLE_LIMIT = 8192;
export const CPSAT_MODEL_CONSTRAINT_LIMIT = 40000;

/**
 * `planCpsat` の上限。**すべて省略可能で、省略時は本番の値である。**
 *
 * 測るためだけに在る。上限を変えた掃引を harness 側で組むと、対象の絞りやモデル生成の写しを
 * もう一つ作ることになり、差が上限の差か写しの差か分からなくなる（2026-09-13 の掃引）。
 */
export interface CpsatPlanOptions {
  /** 計画対象の件数上限（既定 6）。 */
  readonly targetLimit?: number;
  /** モデル変数の上限（既定 8192）。防壁を外して素の劣化を見るときだけ上げる。 */
  readonly maxVariables?: number;
  /** 制約＋区間の上限（既定 40000）。同上。 */
  readonly maxConstraints?: number;
  /** モデルの形。既定は新しい形（上げ窓の上限をハードにする）。旧形は比較のときだけ選ぶ。 */
  readonly shape?: ModelShape;
  /**
   * **外から渡す出発点**（絶対時刻のまま渡す・2026-09-13）。杯の鍵 → 開始・提供・釜。
   *
   * モデル秒への変換はここで行う——原点（`origin`）を知っているのはこの関数だけである。
   * 別の計画器（TS）の解を出発点にする実験のために置いた。測定専用で、本番は渡さない。
   */
  readonly seedPlan?: ReadonlyMap<
    string,
    { readonly startAt: number; readonly serveAt: number; readonly slotIds: readonly string[] }
  >;
}

export async function planCpsat(
  request: CpsatPlanRequest,
  now: number,
  options: CpsatPlanOptions = {},
): Promise<{
  readonly schedule: CookSchedule;
  readonly status: string;
  readonly variables: number;
  readonly memoryBytes: number;
  /**
   * ソルバーが報告した目的値（このモデル自身の目的関数の値）。
   *
   * **engine の `scoreSchedule` とは別の費用関数の値であり、比較できない。** 採否を決める
   * のは engine 側の再計算であって、この値ではない（R4.8）。返すのは観測のためだけである
   * ——報告値と再計算値を並べて残せるようにする（計画の質の評価・2026-09-13）。
   */
  readonly objective: number | null;
  /** 実際に使った探索予算（決定的時間）。予算切れ（status=UNKNOWN）の切り分けに要る。 */
  readonly budget: number;
  /**
   * **固定して解いたときの全変数の解ベクトル**（`shape.fixHints` のときだけ返す）。
   *
   * 掃引が「固定解を完全 hint として元のモデルへ戻す」実験をするために在る（2026-09-15）。
   * 本番は `fixHints` を使わないので、この経路では常に `undefined` であり、応答は太らない。
   */
  readonly solutionVector?: readonly number[];
  /**
   * **hint が変数の定義域から外れている箇所**（`shape.fixHints` のときだけ返す）。
   * 1 つでも在れば `fixHints` は必ず `INFEASIBLE` になる。切り分けの最初に見る値である。
   */
  /** hint の配置そのもの（`shape.fixHints` のときだけ返す）。どの杯が壊すかを見るため。 */
  readonly hintPlacements?: readonly {
    readonly id: string;
    readonly start: number;
    readonly end: number;
    readonly slots: readonly number[];
    readonly boil: number;
    readonly span: number;
    readonly running: boolean;
  }[];
  /** hint が要求している圧力（`shape.fixHints` のときだけ返す）。切り分けの材料である。 */
  readonly hintPressure?: {
    readonly concurrent: number;
    readonly concurrentAt: number;
    readonly kettles: number;
    readonly unavailable: number;
    readonly lift: number;
    readonly liftAt: number;
    readonly arms: number;
  };
  readonly hintOutOfDomain?: readonly {
    readonly kind: string;
    readonly variable: number;
    readonly value: number;
    readonly lo: number;
    readonly hi: number;
  }[];
  /** 実際に使った計画対象の件数上限。**式から計算した想定ではなく、走った値である。** */
  readonly targetLimit: number;
  /**
   * 受領までの見込み遅れ（ミリ秒）。モデルが置ける最も早い開始時刻を決めた値である。
   * 実効値を返すのは、この 1 値が棄却率を決めるからである（`CPSAT_DELIVERY_LEAD_MS`）。
   */
  readonly deliveryLeadMs: number;
  /** 変数の内訳（どの構造が作ったか）。ダイエットの当て所を実測で決めるため。 */
  readonly bySection: Record<string, number>;
  /**
   * 旧定義・新定義の E4／E7 を、**この計画の上で**計算した値。定義変更の順位相関に使う。
   * 計算は `tuning/schedule.ts` の共有関数ただ一つを通る（写しを作らない）。
   */
  readonly metrics: {
    readonly e4Pairs: number;
    readonly e4Spread: number;
    /** 分解用：数え方だけを変えた値（組の距離の平均をクラスタごとに 1 回）。 */
    readonly e4PairMean: number;
    /** 分解用：当てる対象だけを変えた値（最も遠い組の距離をクラスタごとに 1 回）。 */
    readonly e4PairMax: number;
    readonly e7All: number;
    readonly e7Adjacent: number;
  };
  /** クラスタ数の上限と、解が実際に使った数。上限に張り付いた回を後から数えるため。 */
  readonly clusters: { readonly cap: number; readonly used: number };
  /**
   * **目的値の分解。** 解と hint を同じ `evaluate` に通した項別の値と、重み付き総和。
   * 「逆転が増えた代わりに何が改善したか」は総和からは読めない（2026-09-15 の相談）。
   */
  readonly terms: {
    readonly solved: ScheduleEvaluation;
    readonly hint: ScheduleEvaluation;
    readonly solvedTotal: number;
    readonly hintTotal: number;
  };
}> {
  const { params } = request;
  const slotCount = params.unitOrigins.length * 6;
  if (slotCount < 6 || slotCount > 24 || request.running.length > 24 || request.pending.length > 64)
    throw new Error("Unsupported CP-SAT cohort size");
  const targetLimit = options.targetLimit ?? CPSAT_TARGET_LIMIT;
  const maxVariables = options.maxVariables ?? CPSAT_MODEL_VARIABLE_LIMIT;
  const maxConstraints = options.maxConstraints ?? CPSAT_MODEL_CONSTRAINT_LIMIT;
  const targets = cpsatTargets(
    request.pending,
    request.noodlePresets,
    slotCount,
    now,
    params,
    targetLimit,
  );
  const origin =
    Math.floor(
      Math.min(
        now,
        ...targets.map((item) => item.arrivalTime),
        ...request.running.map((timer) => timer.startTime),
      ) / 1000,
    ) - 1;
  const second = Math.ceil(now / 1000) - origin;
  // **モデルが置ける最も早い開始時刻は「今」ではなく「受領の見込み時刻」である**
  // （`CPSAT_DELIVERY_LEAD_MS`・2026-09-14）。`formulate` の第 2 引数はモデル内の「今」で、
  // 釜の解放床・開始時刻の下限・最早の上がりのすべてがこの 1 値から出る。ここを送れば、
  // 遅れの扱いはモデルの中で閉じる——復路で時刻を付け替える処理を足さずに済む。
  //
  // 走行中の占有区間の丸め（下の `second + 1`）には**送らない値**を使う。あちらは「実在する
  // 釜を早く空けない」ための丸めで、見込みの遅れとは関係がない。
  const earliest = Math.ceil((now + CPSAT_DELIVERY_LEAD_MS) / 1000) - origin;
  const unavailable = request.running
    .filter((timer) => timer.boiledAt !== null || adjustedEndTime(timer) <= now)
    .flatMap((timer) => timer.slotIds.map(Number));
  if (
    !targets.length ||
    slotCount - new Set(unavailable).size < Math.max(...targets.map((item) => item.slotSpan))
  )
    throw new Error("No usable slots for the CP-SAT cohort");
  const running: ModelPlacement[] = request.running
    .filter((timer) => timer.boiledAt === null && adjustedEndTime(timer) > now)
    .map((timer) => {
      const start = Math.floor(timer.startTime / 1000) - origin;
      // Round the occupied interval outwards; never release a real pot early.
      const end = Math.max(second + 1, Math.ceil(adjustedEndTime(timer) / 1000) - origin);
      return {
        id: `running:${timer.id}`,
        // **群の鍵は `tableKeyOf` ただ一つ**（卓が分かればその卓、分からなければ伝票ごと）。
        // モデルの `order` はこの単位で「同じお客のひとまとまり」を表す（2026-09-13）。
        order: timer.orderItem ? tableKeyOf(timer.orderItem) : `running:${timer.id}`,
        purchasedAt: start,
        boilSeconds: end - start,
        slotSpan: timer.slotIds.length,
        start,
        end,
        slots: timer.slotIds.map(Number),
      };
    });
  const pending: Item[] = targets.map((item) => ({
    id: itemKeyOf(item),
    order: tableKeyOf(item),
    purchasedAt: Math.floor(item.arrivalTime / 1000) - origin,
    boilSeconds: boilMillisOf(item, request.noodlePresets)! / 1000,
    slotSpan: item.slotSpan,
  }));
  const history: History = {
    id: "live",
    items: [...running, ...pending],
    coordinates: Array.from({ length: slotCount }, (_, slot) =>
      position(slot, params.unitOrigins, params.slotOffsets),
    ),
    arms: params.arms,
    liftWindow: params.liftIntervalSeconds,
    // The live Timer contract starts at the recipe duration. Boil_Sync remains
    // authoritative for already-started timers; this planner cannot change them.
    tolerancePercent: 0,
  };
  const previous = new Map(
    request.shownPlan.map((item) => [itemKeyOf(item), item.slotIds.map(Number)]),
  );
  // **前回の提案の開始時刻**（モデル秒）。Head 近傍——現場が手を伸ばしている先——の釜を
  // 重く守るためだけに渡す（`headSlotChangeFactor`・2026-09-15）。配置は縛らない。
  const previousStartOf = new Map(
    request.shownPlan.map((item) => [
      itemKeyOf(item),
      Math.round(Number(item.startAt) / 1000) - origin,
    ]),
  );
  // 外から渡した出発点をモデル秒へ写す。原点を知っているのはここだけである。
  //
  // **丸めは上へ。** 開始の下限は `earliest = ceil((now + lead)/1000) - origin` なので、下へ丸めると
  // 1 秒ぶん下限を割って**実行不能になる**。終了は `start + 茹で時間` から導く——提供時刻を別に
  // 丸めると `end − start = size` の等式が 1 秒ずれて、これも実行不能になる（2026-09-13 に踏んだ）。
  const boilOf = new Map(
    targets.map((item) => [itemKeyOf(item), boilMillisOf(item, request.noodlePresets)! / 1000]),
  );
  const seed =
    options.seedPlan === undefined
      ? undefined
      : new Map(
          [...options.seedPlan].flatMap(([id, placement]) => {
            const boil = boilOf.get(id);
            if (boil === undefined) return [];
            const start = Math.ceil(placement.startAt / 1000) - origin;
            return [
              [id, { start, end: start + boil, slots: placement.slotIds.map(Number) }],
            ] as const;
          }),
        );
  const built = formulate(
    history,
    earliest,
    history.items,
    running,
    previous,
    [],
    defaults,
    unavailable,
    seed === undefined ? options.shape : { ...options.shape, seed },
    previousStartOf,
  );
  if (
    built.model.variables.length > maxVariables ||
    built.model.constraints.length + built.model.intervals.length > maxConstraints
  )
    throw new Error("CP-SAT model exceeds the bounded runtime");
  // **固定して解く前に、hint が定義域に入っているかを言う（`fixHints`・2026-09-15）。**
  // 外れていれば `fixHints` は必ず `INFEASIBLE` になり、例外は「解なし」としか言わない。
  // 掃引はこの文字列を `hintFeasible` に取るので、ここで理由を載せておく。
  // 本番は `fixHints` を使わないので、この経路は通らない。
  if (options.shape?.fixHints === true && built.hintOutOfDomain.length > 0) {
    const shown = built.hintOutOfDomain
      .slice(0, 6)
      .map((o) => `${o.kind}#${o.variable}=${o.value}∉[${o.lo},${o.hi}]`)
      .join(" ");
    throw new Error(`Hint outside variable domains (${built.hintOutOfDomain.length}): ${shown}`);
  }
  const loaded = await runtime("frozen");
  const result = solve(loaded.value, "model", built.model.budget, encodeModel(built.model));
  // **固定して解いて落ちたときは、hint の圧力を添えて投げ直す（`fixHints`・2026-09-15）。**
  // 例外は「解なし」としか言わないので、どの容量に当たっているかを読むには値が要る。
  // **ここで不可の判定はしない**——上げ窓は手伝いの余地があり、単純な上限ではない。
  // 測った値を並べるだけである。本番は `fixHints` を使わないので、この経路は通らない。
  if (options.shape?.fixHints === true)
    try {
      validateSolution(built.model, result);
    } catch (error) {
      const q = built.hintPressure;
      const shown = built.hints
        .map((h, index) => {
          const isRunning = running.some((r) => r.id === h.id);
          return `${isRunning ? "R" : `#${index}`}:${h.start}-${h.end}@${h.slots.join("/")}`;
        })
        .join(" ");
      throw new Error(
        `${String(error)} :: hint 圧力 同時占有 ${q.concurrent}/${q.kettles - q.unavailable}@${q.concurrentAt} 上げ窓 ${q.lift}/腕 ${q.arms}@${q.liftAt} 杯 ${built.hints.length} :: 配置 ${shown}`,
      );
    }
  else validateSolution(built.model, result);
  const decoded = built.decode([...result.solution]);
  const slices = new Map<string, unknown[]>();
  for (const item of targets) {
    const placement = decoded.find((p) => p.id === itemKeyOf(item));
    if (!placement) throw new Error("Missing CP-SAT placement");
    const key = tableKeyOf(item);
    const rows = slices.get(key) ?? [];
    rows.push({
      externalOrderId: item.externalOrderId,
      itemIndex: item.itemIndex,
      slotIds: placement.slots.map(String),
      startAt: (origin + placement.start) * 1000,
      serveAt: (origin + placement.end) * 1000,
      anchor: null,
    });
    slices.set(key, rows);
  }
  // **一片は「最も早く始まる順」に並べる（2026-09-15）。**
  //
  // `admit` は**計画順の接頭辞**として採り、一片ごとに解放表を進める。ゆえに並びが到着順のままだと、
  // 後ろの一片が前の時刻に釜を使う計画——たとえば片 0 が「釜 9 を 399→789 秒」、片 5 が
  // 「釜 9 を 9→399 秒」——で、**片 5 が `feasibleRelease` に落ちる**。釜 9 は 9〜399 秒と
  // 399〜789 秒で連続して使えるのだから、**計画は正しく、並べ方だけが噛み合っていない。**
  //
  // 実測（空き釜 4 本・コーパス 12 局面）では、届いた一片の **24% がこれで落ちていた**
  // ——現場からは「出ていた提案が取り下げられた」に見える。空き釜が減るほど釜の再利用が増え、
  // 順序の食い違いも増える。
  //
  // **時刻で並べれば、解放表は単調に進む。** 同時刻は釜の番号で断つ（並びを入力順に依存させない）。
  // 並べ替えの鍵だけを読む（`toCookSchedule` が形を検証するまで値は素通しである）。
  const keyOf = (placements: readonly unknown[]) => {
    const rows = placements as readonly { startAt: number; slotIds: readonly string[] }[];
    return {
      at: Math.min(...rows.map((row) => row.startAt)),
      slot: Math.min(...rows.flatMap((row) => row.slotIds.map(Number))),
    };
  };
  const ordered = [...slices]
    .map(([tableKey, placements]) => ({ tableKey, placements, key: keyOf(placements) }))
    .sort((one, other) => one.key.at - other.key.at || one.key.slot - other.key.slot)
    .map(({ tableKey, placements }) => ({ tableKey, placements }));
  const schedule = toCookSchedule({
    slices: ordered,
  });
  if (!schedule) throw new Error("Invalid decoded CP-SAT schedule");

  // **上げ窓の上限を、モデルとは独立にもう一度見る**（R4.4・2026-09-13）。
  //
  // モデルは `arms + HELPER_ARMS` をハード制約として持つが、それはモデルの内側の主張である。
  // ここは復号した計画に **engine 自身の述語**（`withinLiftCap`——`admit` のゲート (f) と確定計画の
  // 合成が読むのと同じ関数）を当てる。規則の写しをここに書かないので、engine が式を変えれば
  // この検査も自動で追随する。
  //
  // **走行中の上がりは engine 側の集合で数える。** `initialLifts(request.running)` は boiled も含めて
  // 全走行中を載せる（`lift.ts` の「boiled に分岐を書かない」）。モデルが載せる走行中は
  // `boiledAt === null && 実効 endTime > now` に絞った部分集合なので、**ここで初めて食い違いが出る**。
  // 出たら送らない——送っても `admit` が同じ述語で落とすだけで、その棄却は「計画が悪い」と
  // 見分けがつかない。
  if (
    !withinLiftCap(
      initialLifts(request.running),
      liftsOf(schedule.slices.flatMap((slice) => slice.placements)),
      params,
    )
  )
    throw new Error("CP-SAT plan exceeds the lift capacity (arms + HELPER_ARMS)");
  // 決めた配置を Placement の形へ戻し、旧新の評価量を**同じ共有関数**で計算する（定義変更の順位相関）。
  const placed: ModelPlacement[] = targets.flatMap((item) => {
    const placement = decoded.find((p) => p.id === itemKeyOf(item));
    return placement === undefined
      ? []
      : [
          {
            id: placement.id,
            // 群の鍵は `tableKeyOf` ただ一つ（モデルへ渡す側と同じ）。ここは E8 などの指標を
            // 計算し直すための写しなので、鍵が食い違うと指標だけ別の群で数えることになる。
            order: tableKeyOf(item),
            purchasedAt: Math.floor(item.arrivalTime / 1000) - origin,
            boilSeconds: placement.end - placement.start,
            slotSpan: item.slotSpan,
            start: placement.start,
            end: placement.end,
            slots: placement.slots,
          },
        ];
  });
  return {
    schedule,
    status: result.status,
    variables: result.modelVariables,
    memoryBytes: result.wasmMemoryBytes,
    budget: built.model.budget,
    // 固定して解いたときだけ全変数の解を返す（掃引の完全 hint 実験・上の宣言を見よ）。
    ...(options.shape?.fixHints === true ? { solutionVector: [...result.solution] } : {}),
    ...(options.shape?.fixHints === true ? { hintOutOfDomain: built.hintOutOfDomain } : {}),
    ...(options.shape?.fixHints === true ? { hintPressure: built.hintPressure } : {}),
    ...(options.shape?.fixHints === true
      ? {
          hintPlacements: built.hints.map((h) => ({
            id: h.id,
            start: h.start,
            end: h.end,
            slots: [...h.slots],
            boil: h.boilSeconds,
            span: h.slotSpan,
            running: running.some((r) => r.id === h.id),
          })),
        }
      : {}),
    targetLimit,
    deliveryLeadMs: CPSAT_DELIVERY_LEAD_MS,
    bySection: built.bySection,
    metrics: {
      e4Pairs: simultaneousPairDistance(history, placed),
      e4Spread: simultaneousSpread(history, placed),
      e4PairMean: simultaneousPairMean(history, placed),
      e4PairMax: simultaneousPairMax(history, placed),
      e7All: allInversions(placed),
      e7Adjacent: adjacentInversions(placed),
    },
    clusters: { cap: built.clusterCap, used: new Set(placed.map((p) => p.end)).size },
    // **目的値の分解（2026-09-15）。** 「何と引き換えに逆転したか」は総和からは読めない。
    // 解と hint を**同じ `evaluate`** に通し、項別の値と重み付き総和を並べる——写しを作らない。
    // hint は `formulate` が返す実際の出発点であって、再現した推定ではない。
    terms: {
      solved: evaluate(history, placed, previous, []),
      hint: evaluate(history, built.hints, previous, []),
      solvedTotal: total(evaluate(history, placed, previous, []), defaults),
      hintTotal: total(evaluate(history, built.hints, previous, []), defaults),
    },
    objective: typeof result.objective === "number" ? result.objective : null,
  };
}
