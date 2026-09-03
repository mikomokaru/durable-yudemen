// domain/wire.ts — ワイヤ境界の唯一の関門。
//
// messages.ts が契約を宣言し、ここがその契約を未検証の文字列から確立する。役割が違うため同居させない
// （messages.ts は型だけのファイルであり、実行時の検証を持たない）。
//
// 型アサーション（as）を書かない。as は「検証していないものを検証済みと言う」構文であり、境界に置けば
// 型が状態について嘘をつく。撤去済み種別（started / cancelled / completed / boiled / adjusted）の case を
// 書けないのもこの帰結である——撤去済みの形をしたリテラルは ServerMessage と突き合わされて型検査に落ちる。
//
// 見る範囲は方向で異なる。
//  - ClientMessage（外部からの要求）: 構造の一致までを見る。値域・識別子の実在・他の事実との整合は engine の
//    拒否（InvalidBoilSeconds / InvalidSlotOrNoodle / TimerNotFound / CapacityExceeded）に委ね、shell が error
//    として要求元へ返す。ここで弾けば、その応答経路が無音の破棄に変わる。
//  - ServerMessage（自分が送ったもの）: store.ts の要素検証をそのまま共有するため、それらが課す正規化条件
//    （余剰フィールドの除去・正の秒数・正の商品コード・slotSpan の域内）も含む。形が違えば自分の不具合であり、
//    理由を返す相手がいない。
//
// 失敗の粒度はメッセージ単位。要素が 1 つ壊れていれば snapshot 全体を捨てる（要素だけ落とせば「畳まない」
// 規律に反し、snapshot の全量性という権威表現の性質も濁る）。

import type { ClientMessage, CookRecommendation, ServerMessage } from "./messages";
import { isNonEmpty, type NonEmptyArray, type TimerFact } from "./timer";
import { isFirmness } from "./firmness";
import { isNonEmptyString, isNonNegativeInteger, isRecord, toDeclaredName } from "./predicate";
import type { PendingOrder } from "./order";
import {
  SLOTS_PER_UNIT,
  toFirmnessCode,
  toGridPoint,
  toMenuItem,
  toNoodlePreset,
  type FirmnessCode,
  type MenuItem,
  type NoodlePreset,
  type SlotOffsets,
  type StoreConfig,
} from "./store";

/**
 * 要素の写し取りを配列へ適用する。一つでも null なら配列全体が null。
 *
 * 配列の助けはこれ 1 つに限る。要素検証（toNoodlePreset 等）は入力を判定するのではなく余剰フィールドを
 * 落とした新しいオブジェクトを返すため、型ガード（value is readonly T[]）の形には収まらない。
 */
function toArrayOf<T>(value: unknown, toElement: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const element = toElement(item);
    if (element === null) return null;
    items.push(element);
  }
  return items;
}

/** 生値を非空の slot 集合へ。1 Timer は最低 1 スロットを駆動する（型で非空を強制する項目の入口）。 */
function toSlotIds(value: unknown): NonEmptyArray<string> | null {
  const slotIds = toArrayOf(value, (item) => (typeof item === "string" ? item : null));
  if (slotIds === null || !isNonEmpty(slotIds)) return null;
  return slotIds;
}

// ── client → server ──────────────────────────────────────────────────────────

/**
 * 受信した文字列を ClientMessage として確立する。失敗は null（例外を送出しない）。
 *
 * 構造の一致までを見る。値域外の boilSeconds・実在しない timerId・未知の noodleType はここを通り、
 * engine が拒否として扱う（要件 2.3）。
 */
export function toClientMessage(text: string): ClientMessage | null {
  const parsed = toJson(text);
  if (!isRecord(parsed)) return null;
  switch (parsed.type) {
    case "start":
      return toStartMessage(parsed);
    case "startOrderItem":
      return toStartOrderItemMessage(parsed);
    case "cancel":
      return toTimerIdMessage(parsed, "cancel");
    case "complete":
      return toTimerIdMessage(parsed, "complete");
    case "adjust":
      return toAdjustMessage(parsed);
    default:
      return null;
  }
}

/**
 * start を確立する。注文品目参照は両方が揃い型が妥当なときだけ組を成し、それ以外は組を成さず通す。
 *
 * 片方だけを拒否しないのは承認済みの挙動である（POS を経ないアドホック麺茹では正当な経路であり、
 * POS 連携の不具合で片方が欠けても麺は茹でられなければならない）。
 * exactOptionalPropertyTypes ゆえ、組が無いときはキー自体を置かない（undefined を値として書けない）。
 */
function toStartMessage(record: Record<string, unknown>): ClientMessage | null {
  const slotIds = toSlotIds(record.slotIds);
  if (slotIds === null) return null;
  const { noodleType, boilSeconds } = record;
  if (typeof noodleType !== "string") return null;
  if (typeof boilSeconds !== "number") return null;
  return { type: "start", slotIds, noodleType, boilSeconds };
}

/**
 * startOrderItem を確立する。運ぶのは 3 項目だけで、麺種・茹で加減・茹で秒は見ない（送られてこない）。
 *
 * 品目の鍵は両方が必須である。片方だけの入力は Decode_Failure——start の頃と違い「組を成さずアドホックとして
 * 通す」余地が無い。この種別は品目を指すことが存在理由であり、指せない要求は要求として成立しない。
 */
function toStartOrderItemMessage(record: Record<string, unknown>): ClientMessage | null {
  const slotIds = toSlotIds(record.slotIds);
  if (slotIds === null) return null;
  const { externalOrderId, itemIndex } = record;
  if (!isNonEmptyString(externalOrderId)) return null;
  if (!isNonNegativeInteger(itemIndex)) return null;
  return { type: "startOrderItem", slotIds, externalOrderId, itemIndex };
}

/** cancel / complete を確立する。どちらも timerId 一つだけを運ぶ同形の要求である。 */
function toTimerIdMessage(
  record: Record<string, unknown>,
  type: "cancel" | "complete",
): ClientMessage | null {
  const { timerId } = record;
  return typeof timerId === "string" ? { type, timerId } : null;
}

/** adjust を確立する。firmness は有限リテラル集合ゆえ述語で所属を見る。 */
function toAdjustMessage(record: Record<string, unknown>): ClientMessage | null {
  const { timerId, firmness } = record;
  if (typeof timerId !== "string") return null;
  if (!isFirmness(firmness)) return null;
  return { type: "adjust", timerId, firmness };
}

// ── server → client ──────────────────────────────────────────────────────────

/**
 * 受信した文字列を ServerMessage として確立する。失敗は null（例外を送出しない）。
 *
 * pong は素の文字列フレームであり、呼び出し側が先に判別してここへは渡さない。
 */
export function toServerMessage(text: string): ServerMessage | null {
  const parsed = toJson(text);
  if (!isRecord(parsed)) return null;
  const { serverTime } = parsed;
  if (typeof serverTime !== "number") return null;
  switch (parsed.type) {
    case "snapshot":
      return toSnapshotMessage(parsed, serverTime);
    case "config":
      return toConfigMessage(parsed, serverTime);
    case "error":
      return toErrorMessage(parsed, serverTime);
    default:
      return null;
  }
}

/** snapshot を確立する。3 つの全量列のいずれかが壊れていればメッセージ全体を捨てる。 */
function toSnapshotMessage(
  record: Record<string, unknown>,
  serverTime: number,
): ServerMessage | null {
  const timers = toArrayOf(record.timers, toTimerFact);
  if (timers === null) return null;
  const pendingOrders = toArrayOf(record.pendingOrders, toPendingOrderFromWire);
  if (pendingOrders === null) return null;
  const recommendations = toArrayOf(record.recommendations, toRecommendation);
  if (recommendations === null) return null;
  return { type: "snapshot", serverTime, timers, pendingOrders, recommendations };
}

/** ワイヤの Timer 表現（既定の型パラメータ＝生プリミティブ）を確立する。 */
function toTimerFact(value: unknown): TimerFact | null {
  if (!isRecord(value)) return null;
  const { id, noodleType, firmness, startTime, endTime } = value;
  if (typeof id !== "string") return null;
  const slotIds = toSlotIds(value.slotIds);
  if (slotIds === null) return null;
  if (typeof noodleType !== "string") return null;
  if (!isFirmness(firmness)) return null;
  if (typeof startTime !== "number" || typeof endTime !== "number") return null;
  return { id, slotIds, noodleType, firmness, startTime, endTime };
}

/**
 * ワイヤの PendingOrder を確立する。
 *
 * order.ts の toPendingOrder を流用しない。あちらは arrivalTime を引数で受け（POS の主張を許さない）
 * noodleType を presets と照合する受け口用の検証で、義務が違う。ここは arrivalTime を値から読み、
 * presets 照合をしない——サーバが送った待ち行列の写しであり、整合は送り手が既に確立している。
 * 同じ形に見えて義務が違う二つの検証は、一つに畳まない。
 */
function toPendingOrderFromWire(value: unknown): PendingOrder | null {
  if (!isRecord(value)) return null;
  const { externalOrderId, itemIndex, noodleType, firmness, arrivalTime, slotSpan } = value;
  if (!isNonEmptyString(externalOrderId)) return null;
  if (!isNonNegativeInteger(itemIndex)) return null;
  if (!isNonEmptyString(noodleType)) return null;
  if (!isFirmness(firmness)) return null;
  // 申告された名前 3 つは同じ関門を通る。受けてから書くのは、キー名が項目ごとに違うためである。
  const tableId = toDeclaredName(value.tableId);
  if (tableId === null) return null;
  const itemName = toDeclaredName(value.itemName);
  if (itemName === null) return null;
  const sizeName = toDeclaredName(value.sizeName);
  if (sizeName === null) return null;
  if (!isNonNegativeInteger(arrivalTime)) return null;
  if (!isNonNegativeInteger(slotSpan)) return null;
  return {
    externalOrderId,
    itemIndex,
    noodleType,
    firmness,
    tableId: tableId.name,
    arrivalTime,
    slotSpan,
    itemName: itemName.name,
    sizeName: sizeName.name,
  };
}

/** 開始推奨 1 件を確立する。slotIds の非空はここで型へ載せる（受け手の読み飛ばしを不要にする）。 */
function toRecommendation(value: unknown): CookRecommendation | null {
  if (!isRecord(value)) return null;
  const { externalOrderId, itemIndex, startAt } = value;
  if (!isNonEmptyString(externalOrderId)) return null;
  if (!isNonNegativeInteger(itemIndex)) return null;
  const slotIds = toSlotIds(value.slotIds);
  if (slotIds === null) return null;
  if (typeof startAt !== "number") return null;
  return { externalOrderId, itemIndex, slotIds, startAt };
}

/**
 * config を確立する。StoreConfig の全 14 項目をここで検証する。
 *
 * 項目の一覧はこの関数にしか無い（型側は `& StoreConfig` ゆえ第二の一覧を持たない）。StoreConfig に
 * 項目が増えれば、この関数が組む値が型に足りずコンパイルエラーになる——忘却の検出器はこの一箇所である。
 */
function toConfigMessage(
  record: Record<string, unknown>,
  serverTime: number,
): ServerMessage | null {
  const config = toStoreConfig(record);
  return config === null ? null : { type: "config", serverTime, ...config };
}

/** 生値を StoreConfig へ。数値項目は域を見ない（サーバ権威の確定値であり、形だけを確かめる）。 */
function toStoreConfig(record: Record<string, unknown>): StoreConfig | null {
  const {
    unitCount,
    arms,
    toleranceRatio,
    orderSyncWeight,
    tableSyncWeight,
    affinityWeight,
    orderSyncToleranceSeconds,
    tableSyncToleranceSeconds,
    affinityToleranceDistance,
  } = record;
  if (
    typeof unitCount !== "number" ||
    typeof arms !== "number" ||
    typeof toleranceRatio !== "number" ||
    typeof orderSyncWeight !== "number" ||
    typeof tableSyncWeight !== "number" ||
    typeof affinityWeight !== "number" ||
    typeof orderSyncToleranceSeconds !== "number" ||
    typeof tableSyncToleranceSeconds !== "number" ||
    typeof affinityToleranceDistance !== "number"
  ) {
    return null;
  }
  const presets = toArrayOf<NoodlePreset>(record.noodlePresets, toNoodlePreset);
  if (presets === null || !isNonEmpty(presets)) return null;
  const unitOrigins = toArrayOf(record.unitOrigins, toGridPoint);
  if (unitOrigins === null) return null;
  const slotOffsets = toSlotOffsetsFromWire(record.slotOffsets);
  if (slotOffsets === null) return null;
  const firmnessCodes = toArrayOf<FirmnessCode>(record.firmnessCodes, toFirmnessCode);
  if (firmnessCodes === null) return null;
  const menuItems = toArrayOf<MenuItem>(record.menuItems, toMenuItem);
  if (menuItems === null) return null;
  return {
    unitCount,
    arms,
    toleranceRatio,
    noodlePresets: presets,
    orderSyncWeight,
    tableSyncWeight,
    affinityWeight,
    orderSyncToleranceSeconds,
    tableSyncToleranceSeconds,
    affinityToleranceDistance,
    unitOrigins,
    slotOffsets,
    firmnessCodes,
    menuItems,
  };
}

/**
 * SLOTS_PER_UNIT 個のオフセット組を確立する。名に FromWire を付けるのは、store.ts が同名の畳む関数
 * （複数形は既定へ畳む）を公開しており、domain 内で同じ名が逆の意味を持たないためである。
 *
 * noUncheckedIndexedAccess ゆえ items[0] は GridPoint | undefined であり、長さを見るだけではタプル型に
 * ならない。分割代入で 6 つを個別に確立し、配列リテラルで返す（as SlotOffsets を書かないための形）。
 */
function toSlotOffsetsFromWire(value: unknown): SlotOffsets | null {
  const items = toArrayOf(value, toGridPoint);
  if (items === null || items.length !== SLOTS_PER_UNIT) return null;
  const [first, second, third, fourth, fifth, sixth, ...rest] = items;
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    fifth === undefined ||
    sixth === undefined ||
    rest.length !== 0
  ) {
    return null;
  }
  return [first, second, third, fourth, fifth, sixth];
}

/** error を確立する。code は判定に用いる安定 id、message は人が読む診断である。 */
function toErrorMessage(record: Record<string, unknown>, serverTime: number): ServerMessage | null {
  const { code, message } = record;
  if (typeof code !== "string" || typeof message !== "string") return null;
  return { type: "error", serverTime, code, message };
}

// ── Decode_Failure の記録 ────────────────────────────────────────────────────

/**
 * Decode_Failure を観測可能に残すための 1 行 JSON を組む。出力（console.error）は両端の受け口が行う——
 * domain は何も出力しない。両端が同じ形を出すための唯一の場所である。
 *
 * 破棄を無音にしない。client は pong（auto-response は必ず返る）で up を確定し続けるため、ここで黙れば
 * 盤面が古い値のまま凍っても接続は健全に見える。ローカル秒読みが endTime から進むので画面は動いて見え、
 * 気づく経路が他に無い。
 *
 * Instrumentation_Log は使わない。あれは hibernation の継ぎ目を覗く道具であって異常を報せる道具ではなく、
 * 出力が debug flag（OBSERVE_DEBUG の既定は "0"）に閉じているため本番で無音になる。
 *
 * contract は復号器と 1 対 1 で、受け手も向きもここから導ける。direction を使わないのは Operation_Log が
 * send / recv の意味で持つためで、at も同 log の epoch ms と衝突する。Wire_Text の中身は載せない——
 * snapshot の pendingOrders は externalOrderId / tableId を含み、これは POS 由来の業務データである。
 */
export function toDecodeFailureLine(contract: "ClientMessage" | "ServerMessage"): string {
  return JSON.stringify({ kind: "decode-failure", contract });
}

// ── 共通 ─────────────────────────────────────────────────────────────────────

/** 文字列を JSON として解釈する。失敗は null（呼び出し側が Decode_Failure へ落とす）。 */
function toJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
