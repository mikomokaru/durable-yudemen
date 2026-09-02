// client/persistence.ts — 受信ビューの永続コーデック（純粋層）。
//
// 設計哲学「計算と作用の分離」に従い、本ファイルのこの部分は純粋な変換だけを担う。
// serializeView / parsePersistedView は localStorage・Date.now・WS・DOM のいずれにも触れない。
// 実際の localStorage 読み書き（ViewStore / localStorageViewStore）は端の責務であり、
// 本ファイル後半にまとめる。コーデック（純粋）と IO（端）を同一ファイル内で明確に分ける。
//
// 永続するのは「これ以上分解できない事実」だけ —— timers（起源タグ込み）・クロックオフセット・
// processedIds。Connectivity / sync / error / unreachableReason は導出・一過性のフィールドであり永続しない。
//
// 待ち行列（pendingOrders）と推奨（recommendations）も永続しない。走行中 Timer を永続するのは endTime が
// それ自体で完結する事実で、秒読みが瞬断で死んではならないからである。待ち行列はそうではない——サーバだけが
// 確定させる事実で、接続が無い間に外で変わりうる（到着・キャンセル・他端末の開始）。起動時に古い写しを
// 出せば「まだ茹でていない注文」という嘘を語る。接続が無い間は「知らない」を空で示し、hydration で受け直す。
// 再水和後の connectivity は常に "down" 起点（接続未確立 = degraded 起点・要件3）、sync は
// "connecting"、error は null、unreachableReason は "offline" 起点（到達不能理由は一過性・分類前は既定・要件15.7）。
// これらは EMPTY_VIEW のベース値であり、解析結果へ重ねる。

import type { ClientTimer, ClientView, TimerOrigin } from "./connection";
import { EMPTY_VIEW } from "./connection";
import type { NonEmptyArray } from "../domain/timer";
import { isNonEmpty } from "../domain/timer";
import { DEFAULT_FIRMNESS, isFirmness } from "../domain/firmness";

/**
 * 永続ブロブの形（単一 JSON・version 付き・要件11.1）。
 *
 * ClientView から「永続すべき事実」だけを抜き出した射影。processedIds は Set ではなく配列で持つ
 * （JSON は Set を表現できないため）。connectivity / sync / error / unreachableReason は導出・一過性ゆえ含めない。
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

  // connectivity / sync / error / unreachableReason は永続しない。EMPTY_VIEW のベース値
  // （down / connecting / null / "offline"）へ重ねる（unreachableReason は一過性・分類前は既定・要件15.7）。
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
  // startTime は v4 で追加。欠如（旧保存ブロブ）は endTime で埋める（進捗リングは縮退・UI 側でガード）。
  const startTime = typeof value.startTime === "number" ? value.startTime : value.endTime;
  // firmness は v5 で追加。欠如/不正な旧ブロブは normal で埋める。
  const firmness = isFirmness(value.firmness) ? value.firmness : DEFAULT_FIRMNESS;
  return {
    id: value.id,
    slotIds,
    noodleType: value.noodleType,
    firmness,
    startTime,
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
 * 永続ビューの保存キーの接頭辞（単一・version 込み）。
 *
 * ビュー全体を単一の JSON ブロブとして 1 キーに丸ごと書く（要件11.1）。キー名に version 接尾辞
 * （.v1）を持たせ、将来ブロブ形式が非互換に変わったときは別キーへ移せるようにしてある
 * （旧キーは parse 失敗 → EMPTY_VIEW へ優雅にフォールバックする）。
 *
 * この接頭辞は単独ではキーにならない。実キーは必ず storeId でスコープした scopedStorageKey で作る
 * （要件1.5：スコープは条件付きではなく必須）。接頭辞のみの旧キー（未スコープ）は決して読まない。
 */
const STORAGE_KEY_PREFIX = "yudemen.offline.view.v1" as const;

/**
 * storeId でスコープした永続ビューの保存キー（`yudemen.offline.view.v1:${storeId}`・要件1.5）。
 *
 * 店舗ごとに別キーへ書き分けることで、店舗を跨いだビューの漏洩（前店舗の表示が次店舗に出ること）を
 * キー空間の分離だけで構造的に防ぐ。現在の storeId のキーを読む限り、別店舗・未スコープのブロブは
 * そもそも参照されず、当該永続ビューは空として扱われる（要件1.6 のフェイルセーフ初期化の土台）。
 */
export function scopedStorageKey(storeId: string): string {
  return `${STORAGE_KEY_PREFIX}:${storeId}`;
}

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
 * localStorage を裏側に持つ既定の ViewStore（端）。storeId でスコープする（要件1.5・必須引数）。
 *
 * save は serializeView の結果を storeId スコープのキー scopedStorageKey(storeId) へ同期書き込みし、
 * load は同一 storeId のキーをページ内同期で読み出して parsePersistedView でビューへ復元する
 * （要件11.2 / 11.4）。storeId は省略不能——スコープは「あれば付ける」条件付きではなく常に必須であり、
 * スコープなしでは店舗を跨いだビューの漏洩を防げないため、型で欠落を排除する（不正な状態を表現可能にしない）。
 *
 * なぜ別店舗・未スコープの永続ビューが再水和されないか（要件1.5 / 1.6・フェイルセーフ初期化）:
 * 読み書きするキーは現在の storeId でスコープされたキーだけである。前店舗（storeId が異なる）は別キーに
 * 書かれており、未スコープの旧キー（接頭辞のみ）はそもそもキーとして構成しない。ゆえに現在の storeId で
 * load すると、当該 storeId に属さないブロブは参照されず getItem は null を返し、parsePersistedView が
 * EMPTY_VIEW を返す——前店舗のビューを再水和せず空から始める。漏洩をランタイム条件ではなくキー空間の
 * 分離で構造的に封じる。
 *
 * なぜ save の失敗を握り潰さず、かつ呼び出し側のループも止めないか（優雅な劣化・「失敗を握り潰さず
 * 回復経路を持つ」）: localStorage への書き込みは容量逼迫やプライベートモードでの拒否で
 * 失敗しうる（QuotaExceededError 等）。ここで例外を再 throw すればビュー更新ループ（秒読みティック・ローカル発火）まで巻き
 * 添えに止まり、表示が死に茹で上がりを取りこぼす——これは最も避けたい「厨房スタッフへの害」である。
 * かといって黙って捨てれば、状態について嘘をつく（保存できていないのに成功を装う）。よって失敗は
 * console.error で観測可能に残しつつ、表示・発火は継続させる。永続は「次のビュー変化で再試行」され、
 * 一過性の失敗（容量逼迫の解消等）からは自然に回復する。これが本ファイルで採る回復経路である。
 */
export function localStorageViewStore(storeId: string): ViewStore {
  const key = scopedStorageKey(storeId);
  return {
    save(view: ClientView): void {
      try {
        localStorage.setItem(key, serializeView(view));
      } catch (cause) {
        // 失敗を握り潰さず観測可能にする。だが再 throw はしない（上記コメントの「なぜ」を参照）。
        console.error("[yudemen] view persistence failed; will retry on next view change", cause);
      }
    },
    load(): ClientView {
      // getItem も SecurityError 等で失敗しうる。読み出し不能なら EMPTY_VIEW 起点へ優雅に劣化する。
      let raw: string | null;
      try {
        raw = localStorage.getItem(key);
      } catch (cause) {
        console.error("[yudemen] view rehydration read failed; starting from empty view", cause);
        return EMPTY_VIEW;
      }
      // parse 自体は純粋コーデックに委ね、不正・不在は EMPTY_VIEW（connectivity は "down" 起点）へ畳む。
      // 別店舗・未スコープのブロブは key が一致せず raw=null となり、ここで EMPTY_VIEW に畳まれる（要件1.6）。
      return parsePersistedView(raw);
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 前回使用店の記憶（client 専用の関心事・端）— ACCESS OFF 期の唯一の復帰経路の土台。
//
// start_url `/`（Entry）で開いた PWA は、ACCESS OFF 期（Phase 1〜2）にはサーバ側の行き先解決を
// 持たない（要件7.8）。そこで「前回どの店舗にいたか」だけをローカルに憶えておき、次回 Entry 起動時に
// クライアント側で店舗パス（/s/{storeId}/）へ直行する（App の Entry）。これはビュー永続（scopedStorageKey）
// とは別の関心事ゆえ、専用キーに分ける——店舗スコープのビューと混ぜない（キー空間で関心事を分離する）。
// 記憶が無い／壊れているときは一様に「記憶なし」（null）へ畳み、呼び出し側は合鍵 URL の案内へ落とす。
// ───────────────────────────────────────────────────────────────────────────

/** 前回使用店の保存キー（ビュー永続とは別系統・単一の storeId 値のみを持つ）。 */
const LAST_STORE_KEY = "yudemen.last-store.v1" as const;

/**
 * storeId の許容形（[a-z0-9-]・長さ 1..64・要件1.2 / storeIdFromPath と同一形）。
 * 壊れた記憶（別用途の値の混入・切り詰め・改竄）を「記憶なし」へ弾く番人。
 */
const STORE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/**
 * 前回使用店として storeId を記憶する（端）。
 *
 * なぜ失敗を握り潰さず、かつ再 throw もしないか（view save と同じ規律）: localStorage 書き込みは
 * 容量逼迫やプライベートモードで失敗しうる。ここで例外を投げれば呼び出し元（店舗タイマーのマウント）
 * まで巻き添えに死ぬ——記憶は「次回の直行の利便」であってタイマー機能の前提ではないため、失敗は
 * console.error で観測可能に残しつつ握り潰さず、稼働は継続させる。次回のマウントで自然に再試行される。
 */
export function rememberLastStore(storeId: string): void {
  try {
    localStorage.setItem(LAST_STORE_KEY, storeId);
  } catch (cause) {
    console.error(
      "[yudemen] last-store memory write failed; will retry on next store mount",
      cause,
    );
  }
}

/**
 * 前回使用店の storeId を読み出す（端）。無い／不正／読み出し不能はすべて「記憶なし」= null に畳む。
 *
 * 保存値が storeId の許容形（STORE_ID_PATTERN）を満たさなければ壊れた記憶として null を返す
 * （不正な状態を「ある」ものとして扱わない）。getItem 自体の SecurityError も null へ優雅に劣化する。
 */
export function readLastStore(): string | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LAST_STORE_KEY);
  } catch (cause) {
    console.error("[yudemen] last-store memory read failed; treating as no memory", cause);
    return null;
  }
  if (raw === null || !STORE_ID_PATTERN.test(raw)) {
    return null;
  }
  return raw;
}
