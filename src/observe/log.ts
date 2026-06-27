// observe/log.ts — 観測ログ entry の型・直列化・解析（純粋）。
// cloudflare:workers にも fs にも WebSocket にも触れない。時刻は引数で受け取り、
// console.log も Date.now() も使わない（純度の契約は src/observe/README.md）。
//
// 本ファイルは二つの構造化ログの codec を担う。
//  1. Operation_Log（Probe_Client が出力する JSON Lines・送受信記録）— 本節。
//  2. Instrumentation_Log（Shell_Instrumentation が console.log で出力）— 後段。
// いずれも「1 行 1 JSON オブジェクト」で、Correlator が共通の epoch ms 軸で突き合わせる。

// ── 共有の検証ヘルパー（Operation / Instrumentation 双方が用いる） ───────────────

/** 0 以上の整数か。エポックミリ秒・seq・件数はいずれも負や小数を取らない事実。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// ── Operation_Log entry（Probe_Client が出力・JSON Lines） ────────────────────

/** 送受信の方向。送信 / 受信（要件2.1 / 2.2）。 */
export type LogDirection = "send" | "recv";

/**
 * Operation_Log の 1 記録。送受信のたびに 1 行記録される。
 *
 * 時刻は二重表現を持つ（要件2.1 / 2.2）。`at`（epoch ms）が突き合わせの共通軸、
 * `atIso` は人間可読の同一時刻表現。両者は同じ時刻を指す。
 */
export interface OperationLogEntry {
  /** 起動時 0 から 1 ずつ単調増加・欠番/重複なし（要件2.3）。 */
  readonly seq: number;
  /** 送受信時刻のエポックミリ秒（0 以上の整数・要件2.1 / 2.2）。 */
  readonly at: number;
  /** 同時刻の UTC ISO 8601・末尾 Z・ミリ秒精度（要件2.1 / 2.2）。 */
  readonly atIso: string;
  /** 送信 / 受信。 */
  readonly direction: LogDirection;
  /** start/cancel/snapshot/started/cancelled/done/error 等のメッセージ種別。 */
  readonly messageType: string;
  /** メッセージ本文（JSON 値）。 */
  readonly payload: unknown;
}

/**
 * entry を 1 行の JSON 文字列へ直列化する（要件2.4）。
 *
 * 属性を宣言順で明示的に組み立て、決定的な出力にする。JSON.stringify は文字列値中の改行を
 * `\n` へエスケープするため、出力は決して生の改行を含まない 1 行になる（JSON Lines の健全性）。
 * payload は JSON 値であることを前提とする（JSON 値でない undefined はキーごと脱落し round-trip しない）。
 */
export function serializeOperationEntry(entry: OperationLogEntry): string {
  return JSON.stringify({
    seq: entry.seq,
    at: entry.at,
    atIso: entry.atIso,
    direction: entry.direction,
    messageType: entry.messageType,
    payload: entry.payload,
  });
}

/**
 * 1 行の解析結果。成功なら entry、失敗なら元の行を保持する（判別可能・要件2.6）。
 * 失敗時に entry を持たないことが型で保証され、不正行を有効 entry と取り違えない。
 */
export type ParsedOperationLine =
  | { readonly ok: true; readonly entry: OperationLogEntry }
  | { readonly ok: false; readonly raw: string };

/**
 * 1 行を解析する（要件2.6）。
 *
 * JSON として不正、またはオブジェクトでない、または必須属性（seq / at / atIso / direction /
 * messageType / payload）のいずれかを欠く・型不整合（seq・at が非整数/負、direction が
 * send/recv 以外、messageType が非文字列）なら ok:false で raw を保持する。
 * payload は値の如何を問わず JSON 値でよいが、「キーの存在」は必須とする
 * （undefined と欠如を区別するため "payload" in record で判定する）。
 */
export function parseOperationLine(line: string): ParsedOperationLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, raw: line };
  }

  // entry はオブジェクトでしか表現されない。プリミティブ・配列・null は不正。
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, raw: line };
  }

  const record = parsed as Record<string, unknown>;

  // payload はキーの存在自体を必須とする（値が null でも有効、欠如は不正）。
  if (!("payload" in record)) {
    return { ok: false, raw: line };
  }

  const { seq, at, atIso, direction, messageType } = record;
  if (
    !isNonNegativeInteger(seq) ||
    !isNonNegativeInteger(at) ||
    typeof atIso !== "string" ||
    !isLogDirection(direction) ||
    typeof messageType !== "string"
  ) {
    return { ok: false, raw: line };
  }

  return {
    ok: true,
    entry: { seq, at, atIso, direction, messageType, payload: record.payload },
  };
}

/** Operation_Log 全体の解析結果。有効 entry と解析失敗行を分離して保持する。 */
export interface OperationLogParse {
  /** 入力の行順を保持した有効 entry の列（要件2.5）。 */
  readonly entries: readonly OperationLogEntry[];
  /** 解析失敗行（JSON 不正・必須属性欠如・型不整合。判別可能・要件2.6）。 */
  readonly failures: readonly string[];
}

/**
 * JSON Lines 全体を解析する（要件2.5 / 2.6）。
 *
 * 各行を `\n` で分割し、有効行は入力の行順を保ったまま entries へ、不正行は failures へ分離する。
 * 既に解析済みの有効 entry は不正行の存在によって失われない。
 *
 * 空行は無視する（failures に入れない）。serializeOperationEntry は改行を含まない 1 行のみを
 * 出力するため、entry を表す行は決して空にならない。一方 JSONL ファイルは末尾改行を持ちうるので、
 * 連結（`\n`）→分割で生じる空行を無視することが round-trip と整合する唯一の選択である。
 */
export function parseOperationLog(text: string): OperationLogParse {
  const entries: OperationLogEntry[] = [];
  const failures: string[] = [];

  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const result = parseOperationLine(line);
    if (result.ok) {
      entries.push(result.entry);
    } else {
      failures.push(result.raw);
    }
  }

  return { entries, failures };
}

/** seq を持たない記録候補（送受信の事実のみ。seq は付番ヘルパーが与える）。 */
export type UnsequencedOperationEntry = Omit<OperationLogEntry, "seq">;

/**
 * 記録候補列に seq を付番する純粋関数（要件2.3）。
 *
 * 起動時 0 から記録順に +1 で付与し、得られる seq 列は 0..n-1 となる——欠番も重複もない。
 * 記録順（送受信が起きた順）をそのまま seq の順序とする。同じ入力に常に同じ出力を返す。
 */
export function assignSeq(
  records: readonly UnsequencedOperationEntry[],
): readonly OperationLogEntry[] {
  return records.map((record, index) => ({ seq: index, ...record }));
}

// ── Instrumentation_Log entry（Shell_Instrumentation が console.log で出力） ───

/**
 * 計装が覗く継ぎ目の種別。4 継ぎ目に限定する（要件4.9）。
 * 列挙をこの 4 種へ閉じることで、観測点が増殖しないことを型で表明する。
 */
export type SeamKind = "construct" | "rehydrate" | "alarm" | "broadcast";

/**
 * Instrumentation_Log の 1 記録（要件4.1〜4.4）。
 *
 * seam を判別子とする discriminated union。継ぎ目ごとに必要なフィールドだけを持ち、
 * 不正な状態（restoredCount を持つ construct、messageType を持つ alarm 等）を構築不能にする
 * （設計哲学「不正な状態を表現可能にしない」）。
 *  - restoredCount は rehydrate のみ（復元 Timer 件数・要件4.2）。
 *  - messageType は broadcast のみ（送信 ServerMessage の種別・要件4.4）。
 *  - construct / alarm はいずれも持たない。
 *
 * 共通フィールドの時刻は Operation_Log と同じ二重表現（at = epoch ms の共通軸、
 * atIso = 同時刻の UTC ISO 8601・末尾 Z・ミリ秒）。
 */
export type InstrumentationLogEntry =
  | {
      readonly seam: "construct";
      readonly at: number;
      readonly atIso: string;
      readonly instanceId: string;
    }
  | {
      readonly seam: "alarm";
      readonly at: number;
      readonly atIso: string;
      readonly instanceId: string;
    }
  | {
      readonly seam: "rehydrate";
      readonly at: number;
      readonly atIso: string;
      readonly instanceId: string;
      /** 復元した Timer 件数（0 以上整数・要件4.2）。 */
      readonly restoredCount: number;
    }
  | {
      readonly seam: "broadcast";
      readonly at: number;
      readonly atIso: string;
      readonly instanceId: string;
      /** 送信した ServerMessage の種別（要件4.4）。 */
      readonly messageType: string;
    };

/**
 * 継ぎ目の値から計装 entry を組み立てる純粋関数（shell はこれを console.log で吐くだけ・要件4.1〜4.4）。
 *
 * atIso は at から `new Date(at).toISOString()` で決定的に導出する。これは引数 at からの
 * 純粋変換であって暗黙の時計（Date.now()）ではない——同じ at に常に同じ atIso を返すため、
 * Property 13 の round-trip と整合する。形式は Operation_Log（parseOperationLine が受ける
 * UTC・末尾 Z・ミリ秒）と揃う。
 *
 * seam に応じて必要なフィールドだけを取り込み、余分な入力は無視する（rehydrate→restoredCount、
 * broadcast→messageType。construct / alarm はどちらも持たない）。これにより出力 entry は
 * 常に seam 種別に整合し、不正な状態を構築しない。
 */
export function buildSeamEntry(input: {
  seam: SeamKind;
  at: number;
  instanceId: string;
  restoredCount?: number;
  messageType?: string;
}): InstrumentationLogEntry {
  const atIso = new Date(input.at).toISOString();
  const { seam, at, instanceId } = input;

  switch (seam) {
    case "rehydrate":
      // restoredCount は rehydrate の継ぎ目で常に workingCopy.timers.length として与えられる。
      // 万一欠けても型の健全性を保つため 0 を既定とする（呼び出し側は shell の単一地点）。
      return { seam, at, atIso, instanceId, restoredCount: input.restoredCount ?? 0 };
    case "broadcast":
      // messageType は broadcast の継ぎ目で常に effect.message.type として与えられる。
      return { seam, at, atIso, instanceId, messageType: input.messageType ?? "" };
    case "construct":
    case "alarm":
      return { seam, at, atIso, instanceId };
  }
}

/**
 * 計装 entry を 1 行の JSON 文字列へ直列化する（改行を含まない）。
 *
 * shell の実出力は `console.log(JSON.stringify(entry))` だが、Property 13（組み立て→直列化→解析）の
 * round-trip 対称性を Operation_Log（serializeOperationEntry）と揃えるため、ここに直列化を一本化する。
 * seam 種別ごとに該当フィールドのみを宣言順で組み立て、余分なキーを出さない（厳格な round-trip）。
 */
export function serializeInstrumentationEntry(entry: InstrumentationLogEntry): string {
  switch (entry.seam) {
    case "rehydrate":
      return JSON.stringify({
        seam: entry.seam,
        at: entry.at,
        atIso: entry.atIso,
        instanceId: entry.instanceId,
        restoredCount: entry.restoredCount,
      });
    case "broadcast":
      return JSON.stringify({
        seam: entry.seam,
        at: entry.at,
        atIso: entry.atIso,
        instanceId: entry.instanceId,
        messageType: entry.messageType,
      });
    case "construct":
    case "alarm":
      return JSON.stringify({
        seam: entry.seam,
        at: entry.at,
        atIso: entry.atIso,
        instanceId: entry.instanceId,
      });
  }
}

/**
 * 1 行の解析結果。成功なら entry、失敗なら元の行を保持する（判別可能）。
 * Operation_Log の ParsedOperationLine と同じ判別構造で、不正行を有効 entry と取り違えない。
 */
export type ParsedInstrumentationLine =
  | { readonly ok: true; readonly entry: InstrumentationLogEntry }
  | { readonly ok: false; readonly raw: string };

/**
 * wrangler tail で収集した 1 行から計装 entry を解析する（round-trip 対象・要件4.1〜4.4）。
 *
 * 次のいずれかなら ok:false で raw を保持する。
 *  - JSON として不正、またはオブジェクトでない（プリミティブ・配列・null）。
 *  - seam が 4 継ぎ目以外。
 *  - 共通必須属性（at が非整数/負、atIso が非文字列、instanceId が非文字列）の欠如/型不整合。
 *  - seam 別フィールドの欠如/不整合（rehydrate に restoredCount 非整数、broadcast に messageType 非文字列）。
 *  - seam に属さない余分フィールド（construct/alarm に restoredCount や messageType、
 *    rehydrate に messageType、broadcast に restoredCount）。
 *
 * 余分フィールドを厳格に弾くのは、buildSeamEntry が seam 種別に整合した entry しか出さない以上、
 * 余分フィールドを持つ行は計装の真の出力ではないからである（4 継ぎ目限定・不正状態を構築不能に
 * する方針）。これにより buildSeamEntry→serialize→parse の round-trip が全属性一致で閉じる。
 */
export function parseInstrumentationLine(line: string): ParsedInstrumentationLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, raw: line };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, raw: line };
  }

  const record = parsed as Record<string, unknown>;
  const { seam, at, atIso, instanceId } = record;

  // 共通必須属性の検証（全 seam 共通）。
  if (
    !isSeamKind(seam) ||
    !isNonNegativeInteger(at) ||
    typeof atIso !== "string" ||
    typeof instanceId !== "string"
  ) {
    return { ok: false, raw: line };
  }

  const hasRestoredCount = "restoredCount" in record;
  const hasMessageType = "messageType" in record;

  // seam 別フィールドの存在/型を厳格に検証する。該当 seam 以外の余分フィールドは弾く。
  switch (seam) {
    case "rehydrate": {
      if (hasMessageType || !isNonNegativeInteger(record.restoredCount)) {
        return { ok: false, raw: line };
      }
      return { ok: true, entry: { seam, at, atIso, instanceId, restoredCount: record.restoredCount } };
    }
    case "broadcast": {
      if (hasRestoredCount || typeof record.messageType !== "string") {
        return { ok: false, raw: line };
      }
      return { ok: true, entry: { seam, at, atIso, instanceId, messageType: record.messageType } };
    }
    case "construct":
    case "alarm": {
      if (hasRestoredCount || hasMessageType) {
        return { ok: false, raw: line };
      }
      return { ok: true, entry: { seam, at, atIso, instanceId } };
    }
  }
}

// ── 内部判定 ─────────────────────────────────────────────────────────────────

/** send / recv のいずれかか。 */
function isLogDirection(value: unknown): value is LogDirection {
  return value === "send" || value === "recv";
}

/** 4 継ぎ目のいずれかか（要件4.9）。 */
function isSeamKind(value: unknown): value is SeamKind {
  return (
    value === "construct" ||
    value === "rehydrate" ||
    value === "alarm" ||
    value === "broadcast"
  );
}
