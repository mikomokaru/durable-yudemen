// observe/correlate.ts — Correlator（2 ログの突き合わせと検証条件判定・純粋）。
// cloudflare:workers にも fs にも WebSocket にも触れない。時刻はすべて引数で受け取り、
// Date.now() も console.log も使わない（純度の契約は src/observe/README.md）。
//
// 本ファイルは観測ハーネスの「計算の核」である。Operation_Log（Probe_Client の送受信）と
// Instrumentation_Log（shell 計装の継ぎ目）を共通の epoch ms 軸で突き合わせ、再 construct の
// 分類・検証条件 a/b・実行全体の判定を、すべて副作用のない決定的純粋関数として導出する。
// 同じ二つのログを入力すれば常に同じ判定を返す——これにより「観測の正しさ」自体が property で
// 検証可能になる（design.md 骨格 1）。
//
// 時刻は log entry に倣い素の number（epoch ms）で扱う。core/types.ts の EpochMillis ブランドは
// 持ち込まない——観測の純粋層は core から独立であり（src/observe は製品の core ではない）、
// log codec（log.ts）の at も素の number だからである。

import type { InstrumentationLogEntry, OperationLogEntry } from "./log";

// ── 共通時刻軸マージ（要件6.1 / 6.6・Property 8） ──────────────────────────────

/** マージ系列の各行がどちらのログ由来か。 */
export type MergedSource = "operation" | "instrumentation";

/**
 * 共通 epoch ms 軸へ統合した 1 行。どちらのログ由来か（source）と元の entry を保持する。
 * at は entry の at をそのまま運ぶ（突き合わせの共通軸）。
 */
export interface MergedRow {
  readonly at: number;
  readonly source: MergedSource;
  readonly entry: OperationLogEntry | InstrumentationLogEntry;
}

/**
 * Operation_Log と Instrumentation_Log を epoch ms 昇順で安定マージする（要件6.1 / 6.6・Property 8）。
 *
 * 保存性・安定整列・決定性を同時に満たす。
 *  - 保存性: 出力長は ops.length + seams.length に等しく、いずれの入力行も欠落・重複させない。
 *    片方／両方が 0 行でも成り立つ。
 *  - 安定整列: at の昇順。同一 at の行は両入力それぞれの元の出現順（各入力配列のインデックス順）を保持する。
 *  - 決定性: 同一入力に常に同一系列を返す。
 *
 * 実装は orderedSteps（scenario.ts）と同じく、(at, sourceRank, index) の三つ組を副え木にした
 * 全順序ソートである。比較が index まで含めて全順序になるため、実行環境の sort の安定性に依らず
 * 常に同一の安定整列が得られる（構造で安定性を保証する）。
 *
 * 同一 at が両ソースに跨るときのタイブレークは「operation を instrumentation より先」に固定する
 * （sourceRank: operation=0 / instrumentation=1）。これは決定性のための明示的・文書化された選択で
 * あり、両入力それぞれの内部順序（index 昇順）は独立に保持される。二つのログは別々の時計・別々の
 * 出所を持ち両者間に本来の前後関係が無いため、源の優先順位を一つ固定する以外に決定的な交互配置の
 * 根拠は無い——ゆえに恣意を一点（operation 優先）に閉じ込めて文書化する。
 */
export function mergeByTime(
  ops: readonly OperationLogEntry[],
  seams: readonly InstrumentationLogEntry[],
): readonly MergedRow[] {
  const decorated: ReadonlyArray<{
    readonly at: number;
    readonly sourceRank: number;
    readonly index: number;
    readonly row: MergedRow;
  }> = [
    ...ops.map((entry, index) => ({
      at: entry.at,
      sourceRank: 0,
      index,
      row: { at: entry.at, source: "operation" as const, entry },
    })),
    ...seams.map((entry, index) => ({
      at: entry.at,
      sourceRank: 1,
      index,
      row: { at: entry.at, source: "instrumentation" as const, entry },
    })),
  ];

  return decorated
    .slice()
    .sort((a, b) =>
      a.at !== b.at
        ? a.at - b.at
        : a.sourceRank !== b.sourceRank
          ? a.sourceRank - b.sourceRank
          : a.index - b.index,
    )
    .map((d) => d.row);
}

// ── instanceId による再 construct の分類（要件5・Property 6 / 7） ───────────────

/**
 * 再 construct の分類カテゴリ。互いに独立した 4 区分（要件5.2 / 5.3 / 5.5 / 5.6）。
 *  - hibernation-wake: 出現区間に Probe_Client の再接続イベント 0 件。
 *  - cold-start-or-redeploy: 出現区間に再接続イベント 1 件以上。
 *  - initial-construct: 先行 instanceId が無い観測上の初回。独立カテゴリで、上 2 つに分類しない。
 *  - unclassifiable: 対応する Operation_Log が欠落し分類に必要な情報が得られない。
 */
export type ConstructClass =
  | "hibernation-wake"
  | "cold-start-or-redeploy"
  | "initial-construct"
  | "unclassifiable";

/**
 * 各 instanceId の出現区間。construct 継ぎ目から導出する観測単位。
 *  - bornAt: 当該 instanceId の construct の採番時刻（要件5.1）。
 *  - endAt: 次の instanceId の bornAt、無ければ観測終了時刻（要件5.2）。
 */
export interface InstanceInterval {
  readonly instanceId: string;
  readonly bornAt: number;
  readonly endAt: number;
  readonly classification: ConstructClass;
}

/**
 * 各 instanceId の出現区間を採番時刻昇順で安定整列し、要件5.2 / 5.3 / 5.5 / 5.6 に従い分類する
 * （Property 6 / 7）。
 *
 * 区間の構成:
 *  - construct 継ぎ目のみを採り、bornAt = その at とする。
 *  - bornAt 昇順へ安定整列する。bornAt が同一なら採番順（seams 内の出現順）を保持する
 *    （(bornAt, index) の全順序ソート。実行環境の sort 安定性に依らない）。
 *  - endAt は整列後の次区間の bornAt、最終区間は observationEndAt とする。
 *
 * 分類（区間 [bornAt, endAt) に属する Operation_Log から導出。最終区間のみ右端を含む [bornAt, endAt]）:
 *  (a) 整列後の先頭区間（先行 instanceId 無し）は initial-construct。独立カテゴリで、再接続有無を見ない（要件5.6）。
 *  (b) 区間に属する Operation_Log が 1 件も無い区間は unclassifiable と標識し、他区間の分類は継続する（要件5.5）。
 *  (c) それ以外は、区間内の「再接続イベント」が 0 件なら hibernation-wake、1 件以上なら cold-start-or-redeploy。
 *
 * 「再接続イベント」の導出（要件5.2 / 5.3）: 既存ワイヤ形式（messages.ts）に明示的な reconnect
 * メッセージは無い。サーバは新しい WS 接続の確立時に hydration 全量 `snapshot` を送る（要件4.1）。
 * ゆえに区間内の「受信した snapshot」（direction:recv・messageType:"snapshot"）を Probe_Client の
 * 再接続の徴と解する——cold start / 再デプロイは再接続を伴い新たな snapshot を生むが、hibernation
 * wake は WS 接続を維持したまま復帰するため新たな snapshot を生まない（接続継続）。
 *
 * 「対応する Operation_Log 欠落」の導出（要件5.5）: 区間 [bornAt, endAt) に属する Operation_Log が
 * 1 件も無いことを「欠落」と解する。区間に何の操作記録も重ならなければ、その区間に再接続が
 * あったか否かを観測できず分類に必要な情報が得られない。一方 hibernation wake は wake 後に
 * `done` 等の受信記録が区間内に残るため、0 件（欠落）とは構造的に区別される。
 */
export function classifyInstances(
  seams: readonly InstrumentationLogEntry[],
  ops: readonly OperationLogEntry[],
  observationEndAt: number,
): readonly InstanceInterval[] {
  // construct 継ぎ目のみを採り、(bornAt, 採番順 index) の全順序で安定整列する。
  const constructs = seams
    .map((entry, index) => ({ entry, index }))
    .filter((d) => d.entry.seam === "construct")
    .sort((a, b) => (a.entry.at !== b.entry.at ? a.entry.at - b.entry.at : a.index - b.index));

  return constructs.map((decorated, position) => {
    const bornAt = decorated.entry.at;
    const next = constructs[position + 1];
    const isLast = next === undefined;
    const endAt = isLast ? observationEndAt : next.entry.at;
    const classification = classifyInterval(position === 0, bornAt, endAt, isLast, ops);
    return { instanceId: decorated.entry.instanceId, bornAt, endAt, classification };
  });
}

/**
 * 単一区間を分類する（classifyInstances の内部・要件5.2 / 5.3 / 5.5 / 5.6）。
 * 先頭区間は initial-construct、区間内 Operation_Log 欠落は unclassifiable、それ以外は
 * 区間内の再接続イベント数で hibernation-wake / cold-start-or-redeploy を分ける。
 */
function classifyInterval(
  isFirst: boolean,
  bornAt: number,
  endAt: number,
  isLast: boolean,
  ops: readonly OperationLogEntry[],
): ConstructClass {
  if (isFirst) {
    return "initial-construct";
  }

  // 区間 [bornAt, endAt) に属する Operation_Log。最終区間のみ観測終了時刻 endAt を含む。
  const opsInInterval = ops.filter((o) => o.at >= bornAt && (isLast ? o.at <= endAt : o.at < endAt));
  if (opsInInterval.length === 0) {
    return "unclassifiable";
  }

  // 再接続イベント = 区間内に受信した snapshot（新しい WS 接続の hydration 全量）。
  const reconnects = opsInInterval.filter(
    (o) => o.direction === "recv" && o.messageType === "snapshot",
  ).length;
  return reconnects === 0 ? "hibernation-wake" : "cold-start-or-redeploy";
}

// ── 検証条件 a / b（要件6.2〜6.5・Property 9 / 10） ───────────────────────────

/** Probe_Client が start/cancel を一切発行しない連続区間。両端を含む閉区間として扱う。 */
export interface IdleInterval {
  readonly fromAt: number;
  readonly toAt: number;
}

/**
 * 検証条件 a の判定。pass / fail を識別可能に表す。fail は二つの原因を区別する。
 *  - NoAlarm: 対応する alarm が存在しない（要件6.3）。
 *  - AlarmAfterDone: alarm の epoch ms が done より後（順序逆転・要件6.3）。
 */
export type ConditionA =
  | { readonly verdict: "pass"; readonly timerId: string }
  | { readonly verdict: "fail"; readonly timerId: string; readonly cause: "NoAlarm" | "AlarmAfterDone" };

/**
 * idle 区間内で、当該タイマーの `done` に対し `alarm` が「done 以下の epoch ms」で先行するかを判定する
 * （要件6.2 / 6.3・Property 9）。
 *
 * idle 区間内（閉区間 [fromAt, toAt]）の `done`（Operation_Log・direction:recv・messageType:"done"）を
 * 対象タイマーごとに走査し、同区間内の `alarm`（Instrumentation_Log）との順序で合否を決める。
 *  - 区間内に alarm が 1 件も無ければ fail(NoAlarm)。
 *  - alarm が在り、いずれかの alarm.at が done.at 以下なら pass（発火 → broadcast → 受信の因果が観測された）。
 *  - alarm が在るがすべて done.at より後なら fail(AlarmAfterDone)。
 *
 * alarm 継ぎ目は timerId を持たない（alarm は due タイマーを一括発火する事実の記録）。ゆえに「対応する
 * alarm」は同 idle 区間内の任意の alarm を指す。対象タイマーは done の payload.timerId で特定する。
 * 出力順は merged の走査順（= 時刻順）に一致し決定的。
 */
export function verifyAlarmFiredInIdle(
  merged: readonly MergedRow[],
  idle: IdleInterval,
): readonly ConditionA[] {
  const withinIdle = (at: number): boolean => at >= idle.fromAt && at <= idle.toAt;

  // idle 区間内の alarm の epoch ms 一覧。
  const alarmTimes: readonly number[] = merged
    .map(instrumentationOf)
    .filter((entry): entry is InstrumentationLogEntry => entry !== null && entry.seam === "alarm")
    .map((entry) => entry.at)
    .filter(withinIdle);

  const results: ConditionA[] = [];
  for (const row of merged) {
    const entry = operationOf(row);
    if (entry === null) {
      continue;
    }
    const timerId = doneTimerId(entry);
    if (timerId === null || !withinIdle(entry.at)) {
      continue;
    }

    if (alarmTimes.length === 0) {
      results.push({ verdict: "fail", timerId, cause: "NoAlarm" });
    } else if (alarmTimes.some((alarmAt) => alarmAt <= entry.at)) {
      results.push({ verdict: "pass", timerId });
    } else {
      results.push({ verdict: "fail", timerId, cause: "AlarmAfterDone" });
    }
  }
  return results;
}

/**
 * 検証条件 b の判定。pass は復元件数、fail は期待件数（直前 active 数）と観測件数（復元件数）を運ぶ。
 */
export type ConditionB =
  | { readonly verdict: "pass"; readonly restoredCount: number }
  | { readonly verdict: "fail"; readonly expectedActive: number; readonly restoredCount: number };

/**
 * idle 後の最初のイベントで、新しい instanceId の `construct` に続く `rehydrate` の復元件数が、当該
 * イベント直前に active（start 済みかつ done/cancel 未到達）だったタイマー数と一致するかを判定する
 * （要件6.4 / 6.5・Property 10）。
 *
 * 対象は再 construct の区間（classification が initial-construct 以外＝新しい instanceId）で、その
 * construct に続く同一 instanceId の rehydrate を持つもの。各々に一つの ConditionB を出す。
 *  - 復元件数（rehydrate.restoredCount）が直前 active 数と等しければ pass。
 *  - 一致しなければ fail（expectedActive = 直前 active 数、restoredCount = 観測復元件数）。
 *
 * 「直前 active 数」の導出（Operation_Log から）: サーバが採番・確定した `started`（recv・
 * payload.timer.id）で当該 id を active 集合へ加え、`done` / `cancelled`（recv・payload.timerId）で
 * 取り除く。construct の bornAt より厳密に前（at < bornAt）の受信記録のみを時刻順に畳み込んだ集合の
 * 大きさが直前 active 数である。active の起点に client 送信の `start` ではなくサーバ確定の `started` を
 * 採るのは、active は「サーバが id を採番し永続に確定したタイマー」であり、その id が無ければ
 * done/cancel と突き合わせられないからである（SSOT 規律と整合）。
 */
export function verifyRehydrateCount(
  merged: readonly MergedRow[],
  instances: readonly InstanceInterval[],
): readonly ConditionB[] {
  const ops: readonly OperationLogEntry[] = merged
    .map(operationOf)
    .filter((entry): entry is OperationLogEntry => entry !== null);

  const results: ConditionB[] = [];
  for (const interval of instances) {
    if (interval.classification === "initial-construct") {
      continue;
    }
    const rehydrate = rehydrateFor(merged, interval);
    if (rehydrate === null) {
      continue;
    }
    const expectedActive = activeCountBefore(ops, interval.bornAt);
    const restoredCount = rehydrate.restoredCount;
    results.push(
      restoredCount === expectedActive
        ? { verdict: "pass", restoredCount }
        : { verdict: "fail", expectedActive, restoredCount },
    );
  }
  return results;
}

// ── 実行全体の判定（要件7.4〜7.6・Property 11） ───────────────────────────────

/**
 * 実行全体の判定。三区分は相互に独立で、ちょうど一つを返す（要件7.6）。
 *  - confirmed: hibernation wake signal を観測し、検証条件 a/b に fail が無い。
 *  - inconclusive: 観測ウィンドウ満了点までに wake signal が観測されない（fail と独立・要件7.4 / 7.6）。
 *  - fail: wake signal は観測したが、検証条件 a/b のいずれかが fail。
 */
export type HarnessVerdict =
  | { readonly kind: "confirmed"; readonly conditionA: readonly ConditionA[]; readonly conditionB: readonly ConditionB[] }
  | { readonly kind: "inconclusive" }
  | { readonly kind: "fail"; readonly conditionA: readonly ConditionA[]; readonly conditionB: readonly ConditionB[] };

/** 観測ウィンドウ満了点 = idle 経過時点 + 最大 60 秒（要件7.4）。 */
export const OBSERVATION_TAIL_MS = 60_000;

/**
 * 観測ウィンドウ満了時点での hibernation wake signal の有無を先に見て confirmed / inconclusive を
 * 分け、signal がある場合のみ検証条件 a/b の fail 有無で confirmed / fail を決める（要件7.4 / 7.5 / 7.6・
 * Property 11）。inconclusive は決して fail に含めず、三区分は相互に独立する。
 *
 * hibernation wake signal の導出（要件7.4 / 7.5）: 「新しい instanceId（再 construct）と rehydrate の組」。
 * すなわち classification が initial-construct 以外の区間で、bornAt が観測ウィンドウ満了点以下、かつ
 * 同一 instanceId の rehydrate が満了点以下で観測されること。先に signal を見て切り分けることで、
 * hibernation が起きなかった実行（signal 無し）を fail と取り違えない（本ハーネスの正直さの核心）。
 *
 * 検証条件 a に要する idle 区間は、Operation_Log から導出する（deriveIdleInterval）。最後の client
 * コマンド（start/cancel の送信）の時刻を idle の開始、観測ウィンドウ満了点を終端とする——コマンドを
 * 最後に送ってから観測終了までが「無操作の連続区間」だからである。コマンドが一つも無ければ観測の
 * 全域を idle とみなす。
 */
export function determineVerdict(
  merged: readonly MergedRow[],
  instances: readonly InstanceInterval[],
  observationWindowEndAt: number,
): HarnessVerdict {
  if (!hasWakeSignal(merged, instances, observationWindowEndAt)) {
    return { kind: "inconclusive" };
  }

  const idle = deriveIdleInterval(merged, observationWindowEndAt);
  const conditionA = verifyAlarmFiredInIdle(merged, idle);
  const conditionB = verifyRehydrateCount(merged, instances);

  const anyFail =
    conditionA.some((c) => c.verdict === "fail") || conditionB.some((c) => c.verdict === "fail");
  return anyFail
    ? { kind: "fail", conditionA, conditionB }
    : { kind: "confirmed", conditionA, conditionB };
}

/**
 * 観測ウィンドウ満了点までに hibernation wake signal（新しい instanceId + rehydrate の組）が
 * 観測されたか（determineVerdict の内部・要件7.4 / 7.5）。
 */
function hasWakeSignal(
  merged: readonly MergedRow[],
  instances: readonly InstanceInterval[],
  windowEnd: number,
): boolean {
  for (const interval of instances) {
    if (interval.classification === "initial-construct" || interval.bornAt > windowEnd) {
      continue;
    }
    const rehydrate = rehydrateFor(merged, interval);
    if (rehydrate !== null && rehydrate.at <= windowEnd) {
      return true;
    }
  }
  return false;
}

/**
 * 検証条件 a 用の idle 区間を Operation_Log から導出する（determineVerdict の内部）。
 * 最後の client コマンド（start/cancel の送信）の時刻を開始、観測ウィンドウ満了点を終端とする。
 * コマンドが無ければ開始を 0（観測の全域を idle）とみなす。
 */
function deriveIdleInterval(merged: readonly MergedRow[], windowEnd: number): IdleInterval {
  let lastCommandAt = 0;
  for (const row of merged) {
    const entry = operationOf(row);
    if (
      entry !== null &&
      entry.direction === "send" &&
      (entry.messageType === "start" || entry.messageType === "cancel") &&
      entry.at > lastCommandAt
    ) {
      lastCommandAt = entry.at;
    }
  }
  return { fromAt: lastCommandAt, toAt: windowEnd };
}

// ── 内部ヘルパー（source 判別・payload からの安全な抽出・active 数導出） ───────────

/** rehydrate 継ぎ目の entry 型（restoredCount を持つ枝へ絞る）。 */
type RehydrateEntry = Extract<InstrumentationLogEntry, { seam: "rehydrate" }>;

/** operation 由来の行なら OperationLogEntry、そうでなければ null。 */
function operationOf(row: MergedRow): OperationLogEntry | null {
  return row.source === "operation" ? (row.entry as OperationLogEntry) : null;
}

/** instrumentation 由来の行なら InstrumentationLogEntry、そうでなければ null。 */
function instrumentationOf(row: MergedRow): InstrumentationLogEntry | null {
  return row.source === "instrumentation" ? (row.entry as InstrumentationLogEntry) : null;
}

/**
 * 区間に対応する rehydrate 継ぎ目（同一 instanceId・区間内）の最初の 1 件を返す。
 * 最終区間以外は [bornAt, endAt)、最終区間は右端 endAt を含む（construct→rehydrate は同一 at でもよい）。
 */
function rehydrateFor(merged: readonly MergedRow[], interval: InstanceInterval): RehydrateEntry | null {
  for (const row of merged) {
    const entry = instrumentationOf(row);
    if (
      entry !== null &&
      entry.seam === "rehydrate" &&
      entry.instanceId === interval.instanceId &&
      entry.at >= interval.bornAt &&
      entry.at <= interval.endAt
    ) {
      return entry;
    }
  }
  return null;
}

/**
 * 境界時刻より厳密に前（at < boundary）の Operation_Log を時刻順に畳み込み、active なタイマー数を返す。
 * `started`（recv・payload.timer.id）で加え、`done` / `cancelled`（recv・payload.timerId）で取り除く。
 * 入力 ops は merged 由来で既に時刻順（= 記録順）であることを前提とする。
 */
function activeCountBefore(ops: readonly OperationLogEntry[], boundary: number): number {
  const active = new Set<string>();
  for (const entry of ops) {
    if (entry.at >= boundary) {
      continue;
    }
    const startedId = startedTimerId(entry);
    if (startedId !== null) {
      active.add(startedId);
      continue;
    }
    const endedId = endedTimerId(entry);
    if (endedId !== null) {
      active.delete(endedId);
    }
  }
  return active.size;
}

/** 受信した `done` の payload.timerId（要件6.2 の対象タイマー特定）。該当しなければ null。 */
function doneTimerId(entry: OperationLogEntry): string | null {
  if (!isRecv(entry, "done")) {
    return null;
  }
  return stringField(entry.payload, "timerId");
}

/** 受信した `started` の payload.timer.id（active 集合への追加・要件6.4）。該当しなければ null。 */
function startedTimerId(entry: OperationLogEntry): string | null {
  if (!isRecv(entry, "started")) {
    return null;
  }
  const payload = entry.payload;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const timer = (payload as Record<string, unknown>).timer;
  return stringField(timer, "id");
}

/** 受信した `done` / `cancelled` の payload.timerId（active 集合からの除去・要件6.4）。該当しなければ null。 */
function endedTimerId(entry: OperationLogEntry): string | null {
  if (entry.direction !== "recv" || (entry.messageType !== "done" && entry.messageType !== "cancelled")) {
    return null;
  }
  return stringField(entry.payload, "timerId");
}

/** entry が指定種別の受信記録か。 */
function isRecv(entry: OperationLogEntry, messageType: string): boolean {
  return entry.direction === "recv" && entry.messageType === messageType;
}

/** value がオブジェクトで key に文字列を持てばその値、そうでなければ null。 */
function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
}
