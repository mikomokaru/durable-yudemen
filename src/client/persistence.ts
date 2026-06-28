// client/persistence.ts — 受信ビューの永続コーデック（純粋層）。
//
// 設計哲学「計算と作用の分離」に従い、本ファイルのこの部分は純粋な変換だけを担う。
// serializeView / parsePersistedView は localStorage・Date.now・WS・DOM のいずれにも触れない。
// 実際の localStorage 読み書き（ViewStore / localStorageViewStore）は端の責務であり、
// 本ファイル後半にまとめる。コーデック（純粋）と IO（端）を同一ファイル内で明確に分ける。
//
// 永続するのは「これ以上分解できない事実」だけ —— timers（起源タグ込み）・クロックオフセット・
// processedIds。Connectivity / sync / error は導出・一過性のフィールドであり永続しない。
// 再水和後の connectivity は常に "down" 起点（接続未確立 = degraded 起点・要件3）、sync は
// "connecting"、error は null。これらは EMPTY_VIEW のベース値であり、解析結果へ重ねる。

import type { ClientTimer, ClientView, TimerOrigin } from "./connection";
import { EMPTY_VIEW } from "./connection";
import type { NonEmptyArray } from "../domain/timer";
import { isNonEmpty } from "../domain/timer";

/**
 * 永続ブロブの形（単一 JSON・version 付き・要件11.1）。
 *
 * ClientView から「永続すべき事実」だけを抜き出した射影。processedIds は Set ではなく配列で持つ
 * （JSON は Set を表現できないため）。connectivity / sync / error は導出・一過性ゆえ含めない。
 * version は将来のブロブ形式変更に備えた識別子で、現行は 1 のみを受理する。
 */
export interface PersistedView {
  readonly version: 1;
  readonly timers: readonly ClientTimer[]; // server-confirmed ＋ provisional（起源タグ込み）
  readonly offset: number;
  readonly processedIds: readonly string[];
}

/**
 * ビュー → 単一 JSON 文字列（純粋）。
 *
 * 永続すべき事実（timers・offset・processedIds）だけを PersistedView へ射影して直列化する。
 * processedIds（Set）は配列へ変換する。connectivity / sync / error など導出・一過性のフィールドは
 * 含めない（再水和時に EMPTY_VIEW のベース値から復元する）。出力は必ず version: 1 を持つ。
 */
export function serializeView(view: ClientView): string {
  const blob: PersistedView = {
    version: 1,
    timers: view.timers,
    offset: view.offset,
    processedIds: [...view.processedIds],
  };
  return JSON.stringify(blob);
}

/**
 * 単一 JSON 文字列 → ビュー（純粋）。
 *
 * 不正・不在（null・JSON parse 失敗・形不一致・version 不一致）は一切例外を投げず EMPTY_VIEW を返す。
 * timers 配列は各要素を構造検証し、一つでも不正なら全体を EMPTY_VIEW へフォールバックする。
 * processedIds 配列は要素が string のもののみ受理する。
 *
 * 再水和後の connectivity は "down" 起点・sync は "connecting"・error は null（= EMPTY_VIEW のベース）。
 * processedIds 配列は Set へ復元する。
 */
export function parsePersistedView(raw: string | null): ClientView {
  if (raw === null) {
    return EMPTY_VIEW;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_VIEW;
  }

  if (!isRecord(parsed)) {
    return EMPTY_VIEW;
  }
  if (parsed.version !== 1) {
    return EMPTY_VIEW;
  }
  if (!Array.isArray(parsed.timers) || !Array.isArray(parsed.processedIds)) {
    return EMPTY_VIEW;
  }
  if (typeof parsed.offset !== "number") {
    return EMPTY_VIEW;
  }

  // timers は厳格検証。一要素でも形が崩れていれば全体をフォールバックする（部分的に壊れた状態を表現しない）。
  const timers: ClientTimer[] = [];
  for (const candidate of parsed.timers) {
    const timer = toClientTimer(candidate);
    if (timer === null) {
      return EMPTY_VIEW;
    }
    timers.push(timer);
  }

  // processedIds は string 要素のみ受理する（非 string は受理しない）。
  const processedIds = new Set<string>();
  for (const id of parsed.processedIds) {
    if (typeof id === "string") {
      processedIds.add(id);
    }
  }

  // connectivity / sync / error は永続しない。EMPTY_VIEW のベース値（down / connecting / null）へ重ねる。
  return {
    ...EMPTY_VIEW,
    timers,
    offset: parsed.offset,
    processedIds,
  };
}

/** 任意値が（null でない）プレーンなレコードかを判定する。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 起源タグの値（"server" | "local"）かを判定する。 */
function isTimerOrigin(value: unknown): value is TimerOrigin {
  return value === "server" || value === "local";
}

/**
 * 任意値を ClientTimer へ構造検証する。形が一つでも崩れていれば null を返す。
 *
 * id / noodleType は string、endTime は number、origin は "server" | "local"。slotIds は
 * 現行 v2 形（非空文字列の非空配列）を優先し、旧 v1 形（単一 `slotId` 文字列）は `[slotId]` に包んで
 * 受理する（保存キー据え置きで走行中タイマーを失わない優雅な移行）。余剰フィールドは無視する。
 */
function toClientTimer(value: unknown): ClientTimer | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.noodleType !== "string" ||
    typeof value.endTime !== "number" ||
    !isTimerOrigin(value.origin)
  ) {
    return null;
  }
  const slotIds = toSlotIds(value.slotIds, value.slotId);
  if (slotIds === null) {
    return null;
  }
  return {
    id: value.id,
    slotIds,
    noodleType: value.noodleType,
    endTime: value.endTime,
    origin: value.origin,
  };
}

/** 永続スロット表現を現行形（非空文字列の非空配列）へ写す。v2 配列を優先し、無ければ v1 単一を包む。 */
function toSlotIds(slotIds: unknown, legacySlotId: unknown): NonEmptyArray<string> | null {
  if (Array.isArray(slotIds)) {
    if (slotIds.some((s) => typeof s !== "string" || s.length === 0)) return null;
    const strings = slotIds as readonly string[];
    return isNonEmpty(strings) ? strings : null;
  }
  if (typeof legacySlotId === "string" && legacySlotId.length > 0) {
    return [legacySlotId];
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// 端（IO）— ここから下だけが localStorage に触れてよい唯一の箇所。
// 上の純粋コーデック（serializeView / parsePersistedView）を端から呼び出すことで、
// 「計算と作用の分離」を一本のファイル内でも構造として保つ。
// ───────────────────────────────────────────────────────────────────────────

/**
 * 永続ビューの保存キー（単一・version 込み）。
 *
 * ビュー全体を単一の JSON ブロブとして 1 キーに丸ごと書く（要件11.1）。キー名に version 接尾辞
 * （.v1）を持たせ、将来ブロブ形式が非互換に変わったときは別キーへ移せるようにしてある
 * （旧キーは parse 失敗 → EMPTY_VIEW へ優雅にフォールバックする）。
 */
export const STORAGE_KEY = "yudemen.offline.view.v1" as const;

/**
 * ビュー永続の抽象境界（端）。
 *
 * save はビューを単一ブロブとして書き込み、load はそれを同期的に読み戻してビューへ再水和する。
 * トランスポート（localStorage か否か）を呼び出し側から隠し、boot 再水和とビュー変化時の保存を
 * この一点に集約する。IndexedDB / Background Sync には依存しない（iOS 制約・要件11.4）。
 */
export interface ViewStore {
  /** 現在ビューを単一ブロブとして永続する（要件11.1）。 */
  readonly save: (view: ClientView) => void;
  /** 永続済みブロブを同期読み出ししてビューへ再水和する。無ければ EMPTY_VIEW（要件11.2）。 */
  readonly load: () => ClientView;
}

/**
 * localStorage を裏側に持つ既定の ViewStore（端）。
 *
 * save は serializeView の結果を単一キー STORAGE_KEY へ同期書き込み、load は同キーをページ内同期で
 * 読み出して parsePersistedView でビューへ復元する（要件11.2 / 11.4）。
 *
 * なぜ save の失敗を握り潰さず、かつ呼び出し側のループも止めないか（優雅な劣化・「失敗を握り潰さず
 * 回復経路を持つ」）: localStorage への書き込みは容量逼迫やプライベートモードでの拒否で
 * 失敗しうる（QuotaExceededError 等）。ここで例外を再 throw すればビュー更新ループ（秒読みティック・ローカル発火）まで巻き
 * 添えに止まり、表示が死に茹で上がりを取りこぼす——これは最も避けたい「厨房スタッフへの害」である。
 * かといって黙って捨てれば、状態について嘘をつく（保存できていないのに成功を装う）。よって失敗は
 * console.error で観測可能に残しつつ、表示・発火は継続させる。永続は「次のビュー変化で再試行」され、
 * 一過性の失敗（容量逼迫の解消等）からは自然に回復する。これが本ファイルで採る回復経路である。
 */
export function localStorageViewStore(): ViewStore {
  return {
    save(view: ClientView): void {
      try {
        localStorage.setItem(STORAGE_KEY, serializeView(view));
      } catch (cause) {
        // 失敗を握り潰さず観測可能にする。だが再 throw はしない（上記コメントの「なぜ」を参照）。
        console.error("[yudemen] view persistence failed; will retry on next view change", cause);
      }
    },
    load(): ClientView {
      // getItem も SecurityError 等で失敗しうる。読み出し不能なら EMPTY_VIEW 起点へ優雅に劣化する。
      let raw: string | null;
      try {
        raw = localStorage.getItem(STORAGE_KEY);
      } catch (cause) {
        console.error("[yudemen] view rehydration read failed; starting from empty view", cause);
        return EMPTY_VIEW;
      }
      // parse 自体は純粋コーデックに委ね、不正・不在は EMPTY_VIEW（connectivity は "down" 起点）へ畳む。
      return parsePersistedView(raw);
    },
  };
}
