// observe/scenario.ts — 宣言的シナリオの型・検証・整列・待機判定（純粋）。
// cloudflare:workers にも fs にも WebSocket にも触れない。実時間を一切持たず、
// Date.now() も setTimeout/setInterval も使わない（純度の契約は src/observe/README.md）。
//
// 本ファイルは「シナリオが何であるか」だけを語る純粋層である。相対時刻に沿った実駆動
// （250ms 窓・await-done の実待機・接続・終了コード）は端（tools/observe/runner.ts）の責務で、
// ここには持ち込まない。端は orderedSteps で整列した列と shouldStopAwaiting の判定を使うだけ。

import type { ServerMessage } from "../domain/messages";

// ── 許容範囲（要件3.1 / 3.3 / 3.4 / 7.2 / 7.3 の事実。一箇所でのみ定義する） ──────

/** ステップ数の下限・上限（要件3.1）。 */
const MIN_STEP_COUNT = 1;
const MAX_STEP_COUNT = 100;

/** 相対時刻 at の下限・上限（ミリ秒・要件3.1）。 */
const MIN_RELATIVE_TIME_MS = 0;
const MAX_RELATIVE_TIME_MS = 3_600_000;

/** wait の durationMs の下限・上限（ミリ秒・要件3.3）。 */
const MIN_WAIT_DURATION_MS = 0;
const MAX_WAIT_DURATION_MS = 600_000;

/** await-done の timeoutMs の下限・上限（ミリ秒・要件3.4）。 */
const MIN_AWAIT_TIMEOUT_MS = 1_000;
const MAX_AWAIT_TIMEOUT_MS = 600_000;

/** idle interval の下限・上限（整数秒・要件7.2 / 7.3）。 */
const MIN_IDLE_INTERVAL_SECONDS = 1;
const MAX_IDLE_INTERVAL_SECONDS = 3600;

// ── シナリオモデル（純粋・不正な状態を構築不能にする discriminated union） ────────

/**
 * シナリオの 1 ステップ。op を判別子とし、相対時刻 at（起動からの経過ミリ秒）に op 固有の
 * フィールドだけを併せ持つ。op に属さないフィールドを構築できない形にすることで、
 * 「start なのに timerId を持つ」等の不正な状態を表現可能にしない（設計哲学）。
 */
export type ScenarioStep =
  | {
      readonly at: number;
      readonly op: "start";
      readonly slotId: string;
      readonly noodleType: string;
      readonly boilSeconds: number;
    }
  | { readonly at: number; readonly op: "cancel"; readonly timerId: string }
  | { readonly at: number; readonly op: "wait"; readonly durationMs: number }
  | { readonly at: number; readonly op: "await-done"; readonly timerId: string; readonly timeoutMs: number };

/** 宣言的シナリオ。1..100 ステップと idle interval（整数秒）からなる（要件3.1 / 7.2）。 */
export interface Scenario {
  readonly steps: readonly ScenarioStep[];
  readonly idleIntervalSeconds: number;
}

/**
 * シナリオ検証の結果。成功なら scenario、失敗なら理由を保持する（判別可能）。
 * 失敗時に scenario を持たないことが型で保証され、範囲外入力を有効シナリオと取り違えない。
 */
export type ScenarioValidation =
  | { readonly ok: true; readonly scenario: Scenario }
  | { readonly ok: false; readonly reason: ScenarioRejectReason };

/** シナリオ拒否の理由。範囲ごとに一つ（要件3.1 / 3.3 / 3.4 / 7.3）。 */
export type ScenarioRejectReason =
  | "StepCountOutOfRange" // ステップ数が 1..100 外（要件3.1）
  | "RelativeTimeOutOfRange" // at が 0..3,600,000ms 外（要件3.1）
  | "WaitDurationOutOfRange" // wait の durationMs が 0..600,000ms 外（要件3.3）
  | "AwaitTimeoutOutOfRange" // await-done の timeoutMs が 1,000..600,000ms 外（要件3.4）
  | "IdleIntervalOutOfRange"; // idleIntervalSeconds が 1..3600 の整数秒でない（要件7.3）

// ── 検証 ─────────────────────────────────────────────────────────────────────

/** min..max（両端含む）の整数か。範囲はすべて整数で表現される事実。 */
function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * 生のシナリオ入力を検証する（要件3.1 / 3.3 / 3.4 / 7.3）。
 *
 * ステップ数・相対時刻 at・wait の durationMs・await-done の timeoutMs・idleIntervalSeconds が
 * **すべて**許容範囲内のときのみ ok:true を返す。いずれかが範囲外なら、対応する理由で ok:false を
 * 返す。純粋関数であり、毎回新しい結果値を構築して返すだけで、いかなる既存設定も変更しない。
 *
 * 範囲チェックの優先順位は ScenarioRejectReason の宣言順に従う（StepCount → 各ステップの
 * RelativeTime → Wait/Await → IdleInterval）。これにより複数の違反があっても結果は決定的になる。
 * 範囲を語る以前に構造が壊れている入力（オブジェクトでない・op が 4 種以外・必須フィールド欠如/型
 * 不整合）は、その範囲を満たしようがないため、当該範囲の理由で拒否する（関数を全域に保つ）。
 */
export function validateScenario(raw: unknown): ScenarioValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "StepCountOutOfRange" };
  }

  const record = raw as Record<string, unknown>;
  const { steps } = record;

  // ステップ数（1..100）。配列でない・範囲外は StepCountOutOfRange。
  if (!Array.isArray(steps) || steps.length < MIN_STEP_COUNT || steps.length > MAX_STEP_COUNT) {
    return { ok: false, reason: "StepCountOutOfRange" };
  }

  // 各ステップを記述順に検証する。範囲チェックの前に at と op 固有フィールドの構造を確かめる。
  const validatedSteps: ScenarioStep[] = [];
  for (const candidate of steps) {
    const result = validateStep(candidate);
    if (!result.ok) {
      return result;
    }
    validatedSteps.push(result.step);
  }

  // idle interval（1..3600 の整数秒）。
  if (!isIntegerInRange(record.idleIntervalSeconds, MIN_IDLE_INTERVAL_SECONDS, MAX_IDLE_INTERVAL_SECONDS)) {
    return { ok: false, reason: "IdleIntervalOutOfRange" };
  }

  return {
    ok: true,
    scenario: { steps: validatedSteps, idleIntervalSeconds: record.idleIntervalSeconds },
  };
}

/** 1 ステップの検証結果。成功なら型付き ScenarioStep、失敗なら拒否理由を持つ。 */
type StepValidation =
  | { readonly ok: true; readonly step: ScenarioStep }
  | { readonly ok: false; readonly reason: ScenarioRejectReason };

/**
 * 1 ステップを検証する。at（0..3,600,000ms 整数）を先に確かめ、op 固有の範囲・構造を続けて確かめる。
 * op が 4 種以外、または op 固有の必須フィールドが欠如/型不整合なら、その op の範囲理由で拒否する。
 */
function validateStep(candidate: unknown): StepValidation {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    // op を判別できない以上、相対時刻も語れない。RelativeTimeOutOfRange として拒否する。
    return { ok: false, reason: "RelativeTimeOutOfRange" };
  }

  const step = candidate as Record<string, unknown>;

  // 相対時刻 at（0..3,600,000ms 整数）。op に依らず全ステップ共通。
  if (!isIntegerInRange(step.at, MIN_RELATIVE_TIME_MS, MAX_RELATIVE_TIME_MS)) {
    return { ok: false, reason: "RelativeTimeOutOfRange" };
  }
  const at = step.at;

  switch (step.op) {
    case "start": {
      // start は範囲を持つ数値フィールドを持たない。構造（slotId / noodleType / boilSeconds）の
      // 整合だけを確かめる。不整合なら相対時刻の文脈で拒否する（専用理由を持たないため）。
      if (
        typeof step.slotId !== "string" ||
        typeof step.noodleType !== "string" ||
        typeof step.boilSeconds !== "number" ||
        !Number.isFinite(step.boilSeconds)
      ) {
        return { ok: false, reason: "RelativeTimeOutOfRange" };
      }
      return {
        ok: true,
        step: { at, op: "start", slotId: step.slotId, noodleType: step.noodleType, boilSeconds: step.boilSeconds },
      };
    }
    case "cancel": {
      if (typeof step.timerId !== "string") {
        return { ok: false, reason: "RelativeTimeOutOfRange" };
      }
      return { ok: true, step: { at, op: "cancel", timerId: step.timerId } };
    }
    case "wait": {
      // wait の durationMs（0..600,000ms 整数）。
      if (!isIntegerInRange(step.durationMs, MIN_WAIT_DURATION_MS, MAX_WAIT_DURATION_MS)) {
        return { ok: false, reason: "WaitDurationOutOfRange" };
      }
      return { ok: true, step: { at, op: "wait", durationMs: step.durationMs } };
    }
    case "await-done": {
      if (typeof step.timerId !== "string") {
        return { ok: false, reason: "RelativeTimeOutOfRange" };
      }
      // await-done の timeoutMs（1,000..600,000ms 整数）。
      if (!isIntegerInRange(step.timeoutMs, MIN_AWAIT_TIMEOUT_MS, MAX_AWAIT_TIMEOUT_MS)) {
        return { ok: false, reason: "AwaitTimeoutOutOfRange" };
      }
      return { ok: true, step: { at, op: "await-done", timerId: step.timerId, timeoutMs: step.timeoutMs } };
    }
    default:
      // 4 種以外の op は相対時刻を語る以前に不正。RelativeTimeOutOfRange として拒否する。
      return { ok: false, reason: "RelativeTimeOutOfRange" };
  }
}

// ── 整列 ─────────────────────────────────────────────────────────────────────

/**
 * ステップを相対時刻 at の昇順へ安定整列する（要件3.1）。
 * at が等しい複数ステップは記述順を保持する。
 *
 * 記述順インデックスを副え木にして (at, index) の辞書順で比較することで、実行環境の sort の
 * 安定性に依らず常に安定整列となることを構造で保証する。
 */
export function orderedSteps(scenario: Scenario): readonly ScenarioStep[] {
  return scenario.steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => (a.step.at !== b.step.at ? a.step.at - b.step.at : a.index - b.index))
    .map((decorated) => decorated.step);
}

// ── 待機判定 ─────────────────────────────────────────────────────────────────

/**
 * await-done の待機を終了すべきか（純粋判定・要件3.4 / 3.5）。
 * 受信が指定 timerId の boiled（茹で上がり通知）のときに限り true。一致しない boiled も、boiled 以外の
 * 種別も false（待機継続）。DSL の op 名は await-done のまま（外部シナリオ互換）だが、待機対象の
 * ワイヤ種別は茹で上がり通知 boiled である。実時間・タイムアウトは端の責務で、ここでは一致だけを語る。
 */
export function shouldStopAwaiting(received: ServerMessage, targetTimerId: string): boolean {
  return received.type === "boiled" && received.timerId === targetTimerId;
}
