import { DurableObject } from "cloudflare:workers";
import { decide } from "../engine/decide";
import type { Effect } from "../engine/effect";
import type { Event, ReceivedOrder } from "../engine/event";
import { migrate } from "../engine/migrate";
import type { ShellFailure } from "../engine/rejection";
import { fromSnapshot } from "../engine/snapshot";
import { EMPTY_STATE, isNewerSequence, type TimerState } from "../engine/state";
import { toCookSchedule } from "../engine/schedule";
import { toWireSnapshot, type SettleParams } from "../engine/settle";
import type { ScheduleParams } from "../engine/objective";
import type { EpochMillis, TimerId } from "../engine/types";
import { buildSeamEntry, type InstrumentationLogEntry } from "../observe/log";
import { PING_REQUEST, PONG_RESPONSE } from "../transport/heartbeat";
import { REJECTION_CLOSE_CODE } from "../transport/rejection";
import type { ServerMessage } from "../domain/messages";
import { toClientMessage, toDecodeFailureLine } from "../domain/wire";
import { toDeclaredName } from "../domain/predicate";
import { toPendingOrders, type PendingOrder } from "../domain/order";
import type { NonEmptyArray } from "../domain/timer";
import type { StoreConfig, NoodlePreset, FirmnessCode, MenuItem } from "../domain/store";
import {
  DEFAULT_UNIT_COUNT,
  DEFAULT_NOODLE_PRESETS,
  DEFAULT_FIRMNESS_CODES,
  DEFAULT_MENU_ITEMS,
  DEFAULT_ARMS,
  DEFAULT_TOLERANCE_RATIO,
  DEFAULT_ORDER_SYNC_WEIGHT,
  DEFAULT_TABLE_SYNC_WEIGHT,
  DEFAULT_AFFINITY_WEIGHT,
  DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS,
  DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS,
  DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  DEFAULT_SLOT_OFFSETS,
  defaultUnitOrigins,
} from "../domain/store";
import type { ArrivalRecord } from "../ingress/batch";
import { readDeclaredText } from "../ingress/declared-text";
import { toNoodleSpec, type NoodleLookup } from "../ingress/noodle-spec";
import { toUniqueKey } from "../ingress/unique-key";
import type { StoreProjection } from "../registry/projection";
import type { Roster } from "../registry/ideal";
import { normalize } from "../registry/authz";
import { tryWriteOperationLines } from "../operation-history/producer";
import type { OperationObservation } from "../operation-history/derive";
import type { PlanRequest } from "../solver/request";

/**
 * 内部 identity ヘッダ名 — Worker が JWKS 検証済みの identity を店舗 DO へ運ぶ唯一の内部ヘッダ（要件6.3 / 8.6）。
 *
 * このヘッダはサーバ内部（Worker → 店舗 DO）専用であり、クライアント由来の同名ヘッダを決して透過しない。
 * Worker（task 13.3）は転送時に無条件でこのヘッダを除去した上で、ACCESS_REQUIRED ON かつ JWT 検証成功時に
 * のみ検証済み identity を付与し直す（偽装防御）。店舗 DO 側（本 task 13.4）は ACCESS_REQUIRED ON のとき
 * このヘッダから検証済み identity を読み、永続投影の Roster にローカル照合する（レジストリ照会なし）。
 * X- 接頭辞と Yudemen 名前空間で、標準ヘッダ・他アプリのヘッダとの衝突を避ける（この定数が単一の正本で、
 * Worker 側の付与／除去はこの名前に一致させる）。
 */
export const IDENTITY_HEADER = "X-Yudemen-Identity";

/** タイマー SSOT の単一キー。状態は丸ごとこのキーへ put / get する（要件8.3・SQL 不使用）。 */
const SNAPSHOT_KEY = "activeTimers";

/**
 * 投影（StoreProjection）の単一永続キー。config + roster + active + version を丸ごとこのキーへ put / get する。
 * Timer SSOT（activeTimers）とは別概念ゆえ独立したキーに持つ（要件5.2 / 6.5）。
 * レジストリからの押し込み（applyProjection）だけがこのキーを書き、店舗 DO はここを投影の正本とする。
 * env シード（旧 storeConfig）は廃止した——設定はプロビジョニング（投影押し込み）でのみ確立する（要件2.7 / 9.3）。
 */
const PROJECTION_KEY = "projection";

/**
 * プロビジョニング状態。投影が永続されていれば provisioned（その投影を同梱）、未永続なら未プロビジョニング。
 * env シードを廃した今、投影の永続だけが「この店舗が存在する」ことの唯一の証左（要件2.6 / 2.7）。
 * fetch 経路（接続可否判定 — task 4.3 の未プロビジョニング拒否・task 4.4 の非活性化）がこの状態を読む。
 * detection のみを表し、作用（put など）は一切持たない。
 */
type ProvisionState =
  | { readonly provisioned: false }
  | { readonly provisioned: true; readonly projection: StoreProjection };

/** Cloudflare Alarm の自動リトライ上限（公式: 初回2秒・指数バックオフ・最大6回）。 */
const ALARM_MAX_RETRIES = 6;

/**
 * retryCount がこの値以上なら throw せず新規 Alarm を張り直す（リトライ枯渇の一歩手前）。
 * throw による at-least-once リトライを使い切る前に新しい Alarm を予約し、取りこぼしを防ぐ（公式推奨）。
 */
const ALARM_REARM_THRESHOLD = ALARM_MAX_RETRIES - 1;

/** 張り直す Alarm の遅延。put が回復するまでの猶予を置く（公式推奨パターンの例値）。 */
const ALARM_REARM_DELAY_MS = 30_000;

/**
 * 非活性化（deactivated）で接続中の WS を閉じるときの close code（要件6.6）。
 *
 * 「店舗の状態による接続拒否」を表すアプリ固有シグナルは client と共有する単一の確定値ゆえ、値は
 * transport/rejection.ts（REJECTION_CLOSE_CODE）に集約する（二重定義の根絶）。クライアントはこの符号を
 * 接続拒否と解し、Entry へ戻って行き先を解決し直す（要件7.6・design.md Component 8 / 10）。
 */
const DEACTIVATED_CLOSE_CODE = REJECTION_CLOSE_CODE;

/** 非活性化で WS を閉じるときに添える close reason（人が読む診断用。判定には使わない）。 */
const DEACTIVATED_CLOSE_REASON = "store deactivated";

/** runEffects の結果。Persist が確定したか（put 成功か）だけを呼び出し元へ返す。 */
interface RunResult {
  /** Persist が成功して状態が確定したら true。put 失敗で後続を中断したら false。 */
  readonly persisted: boolean;
}

/**
 * 初期化（rehydrate）失敗。移行不能（UnsupportedSchemaVersion / MigrationFailed）を包んで throw し、
 * blockConcurrencyWhile による DO 再初期化に委ねる（要件7.5）。Working_Copy は確定しないまま破棄される。
 */
class InitError extends Error {
  constructor(readonly failure: ShellFailure) {
    super(`rehydrate failed: ${failure.code}`);
    this.name = "InitError";
  }
}

/**
 * Order_Ingress のボディが表す意図（要件1）。到着とキャンセルを 1 経路で受け、形で判別する。
 *
 * 到着は `{ items: [...] }`、キャンセルは `{ cancelledOrderId: "..." }`。1 ボディ 1 意図とし、両方載る形も
 * どちらも載らない形も拒否する——「何を要求しているのか」が定まらない到着を推測で受ければ、待ち行列の
 * 正本が POS の書き方に依存する。
 */
type OrderIntent =
  | { readonly kind: "arrival"; readonly arrival: NonEmptyArray<PendingOrder> }
  | { readonly kind: "cancellation"; readonly externalOrderId: string };

/**
 * Order_Ingress の生ボディを OrderIntent へ解釈する。不正・判別不能はすべて null（呼び出し側が 400 に写す）。
 *
 * 品目の検証は domain の `toPendingOrders` に委ね、ここでは書かない（同じ検証を二度書かない）。必須属性の
 * 欠落・未知の品目種別・型違反はあちらが 1 品目でも見つけた時点で全体を null へ落とす——部分受理は
 * 現場が欠品に気づけない嘘になる（AC 1.4）。arrivalTime は shell が採る受け手側の事実で、POS の主張ではない。
 */
function toOrderIntent(
  body: unknown,
  presets: readonly NoodlePreset[],
  arrivalTime: EpochMillis,
): OrderIntent | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Record<string, unknown>;
  const cancelledOrderId = candidate.cancelledOrderId;
  // 意図の判別はキーの有無で行い、値の妥当性はその後に見る（不正な値を「別の意図」へ読み替えない）。
  if ((candidate.items === undefined) === (cancelledOrderId === undefined)) return null;
  if (cancelledOrderId !== undefined) {
    return typeof cancelledOrderId === "string" && cancelledOrderId.length > 0
      ? { kind: "cancellation", externalOrderId: cancelledOrderId }
      : null;
  }
  const arrival = toPendingOrders(candidate.items, presets, arrivalTime);
  return arrival === null ? null : { kind: "arrival", arrival };
}

/**
 * ReceiveCounts — 1 回の受領のうち、**この DO の内側でしか判らない**件数（AC 12.15）。
 *
 * 他の 10 カウンタ（毒・未知 `path`・破棄・認可失敗ほか）はいずれも Worker が自身で数えられる値ゆえ
 * ここに含めない。含めれば同じ件数を Worker と DO の二箇所で数える形になり、どちらが正かが曖昧になる。
 * `deactivatedStore` も含めない——`ReceiveOutcome` の種別そのものが数える材料である。
 */
export interface ReceiveCounts {
  /** 単調性で読み飛ばした Record 数（重複吸収）。判定材料は engine 状態に属し、外からは見えない。 */
  readonly doDedupeSkipped: number;
  /** 麺として解釈できたが `noodlePresets` に麺種が無く、待ち行列へ写せなかった品目数（AC 6.28）。 */
  readonly unknownNoodleType: number;
}

/**
 * ReceiveOutcome — 受領の結末。
 *
 * **RPC ゆえ HTTP ステータスでは分類を運べない。** 呼び出し元（Worker の fan-out と保留の再生）は種別で
 * 挙動を分ける必要がある——一時的失敗なら Arrival_Batch 全体を落として上流の再送に委ね、恒久的失敗なら
 * 飛ばして数える。判別可能な和型だけがその分岐を型で表せる。
 *
 * **`unprovisioned` と `deactivated` を分ける。** 既存のゲート（`fetch` / `receiveOrder`）はどちらも 403 で
 * 返すため区別できないが、性質が正反対である。`createStore` が `commitIdeal` を終えた時点で Code_Index には
 * 店舗が載るが、投影の押し込みは `converge` の Alarm 継続で非同期に進むため、Code_Index に載った直後の
 * 到着は投影未達で拒まれうる——これは時間が解消する一時的な状態である。`deactivated` と同じく
 * 「飛ばして数える」にすれば、店舗開設の瞬間に届いた注文が消える（Property 15）。
 */
export type ReceiveOutcome =
  /** 確定した。件数は Worker が 1 バッチ 1 行のログにまとめるために返す。 */
  | { readonly kind: "settled"; readonly counts: ReceiveCounts }
  /** 投影未受領。一時的な状態ゆえ再試行に値する（Property 15）。集合は一切変えていない。 */
  | { readonly kind: "unprovisioned" }
  /** 非活性。時間が経っても解消しない（再活性化は運用の判断）ゆえ飛ばして数える。 */
  | { readonly kind: "deactivated" }
  /** `Persist` が失敗した。何も確定していない（受理も broadcast も出していない）。 */
  | { readonly kind: "persist-failed" };

/** 翻訳の結果。`received` は engine へ渡す形そのままで、件数は DO 内でしか判らない観測値である。 */
interface RecordTranslation {
  readonly received: readonly ReceivedOrder[];
  readonly unknownNoodleType: number;
}

/**
 * 受領した Record 群を `ReceivedOrder` 列へ翻訳する純粋関数（AC 6.5 / 6.26〜6.28 / 6.34）。
 *
 * **`toPendingOrders` の全体拒否をここへ持ち込まない**（AC 6.27）。あちらは「1 つのオーダーの品目群」の
 * 原子性を守るために 1 品目でも不正なら全体を落とすが、本経路では翻訳できない品目が正常に起こる
 * ——非麺の品目（丼・餃子・飲料）がそれで、実データ 3 件すべてに含まれる。全体拒否を適用すれば、
 * 丼が付いたラーメンの注文がまるごと弾かれる。ゆえに品目単位で扱い、翻訳できた品目のみを写す。
 *
 * **対応表に無い麺種はここで弾いて数える**（AC 6.28）。`boilSeconds` を引けない品目を待ち行列へ入れれば、
 * 計画にも表示にも現れない項目が正本に溜まる。整合を入口（`validate.ts`）で見ないのは、3 層の合成後で
 * しか判定できず、Policy がメニューを配り店舗が `noodlePresets` を上書きする段階的投入が正当だからである。
 *
 * **`itemIndex` は `order_items` の元の位置とする**（AC 6.34）。茹で対象でない品目の位置は欠番として残る
 * ——詰め直せば、対応表の改定で判定が変わった際に既存の待ち行列の番号がずれる。
 */
function toReceivedOrders(
  records: readonly ArrivalRecord[],
  lookup: NoodleLookup,
  presets: readonly NoodlePreset[],
): RecordTranslation {
  const received: ReceivedOrder[] = [];
  let unknownNoodleType = 0;
  for (const record of records) {
    const externalOrderId = toUniqueKey(record.payload);
    const terminalId = readDeclaredText(record.payload.terminal_id);
    // 到達しない分岐である——Worker は同一の `toUniqueKey` で毒を分類済みで、その 4 要素に `terminal_id` が
    // 含まれる。ここで数えないのは毒の件数が Worker の関心事だからで、飛ばすのは識別子を持たない受領を
    // engine へ渡せないためである（`externalOrderId` は置換・除去の鍵そのものである）。
    if (externalOrderId === null || terminalId === null) continue;
    const tableId = toTableId(record.payload.table_no);
    const items: PendingOrder[] = [];
    const rawItems = record.payload.order_items;
    if (Array.isArray(rawItems)) {
      for (let itemIndex = 0; itemIndex < rawItems.length; itemIndex += 1) {
        const rawItem: unknown = rawItems[itemIndex];
        if (typeof rawItem !== "object" || rawItem === null) continue;
        const spec = toNoodleSpec(rawItem as Record<string, unknown>, lookup);
        // 麺量を持たない品目は茹でない（AC 6.21・6.22）。非麺は正常な入力ゆえ数えない。
        if (spec === null) continue;
        if (!presets.some((preset) => preset.noodleType === spec.noodleType)) {
          unknownNoodleType += 1;
          continue;
        }
        items.push({
          externalOrderId,
          itemIndex,
          noodleType: spec.noodleType,
          firmness: spec.firmness,
          tableId,
          // Order_Arrival_Time の起点は上流の観測時刻。受理時刻は再送ごとに動き、`payload.datetime` は
          // 券売機の時計に依存する申告値である（AC 8.1〜8.4）。
          arrivalTime: record.arrivalTimestampMs,
          slotSpan: spec.slotSpan,
          // 商品名は POS 申告値をそのまま持つ（正規化は表示時の導出）。親は素通しで読み、麺量は
          // slotSpan を決めた同定結果から取る（noodle-spec が同じ 1 度の同定から返す）。
          itemName: toDeclaredName((rawItem as Record<string, unknown>).item_name)?.name ?? null,
          sizeName: spec.sizeName,
        });
      }
    }
    // 品目 0 件も受領として渡す。空は「キャンセル、または麺を含まない注文」という正常な入力であり、
    // 除去（既存あり）または無変更（既存なし）へ engine が写す（AC 6.11 / 6.12）。
    received.push({ externalOrderId, terminalId, sequenceNumber: record.sequenceNumber, items });
  }
  return { received, unknownNoodleType };
}

/**
 * `payload.table_no` を Table_Group の識別子へ写す（AC 6.26）。欠落・`0` は卓に紐づかない品目ゆえ null。
 *
 * 読み出しは `readDeclaredText` に委ねる——実データでは卓番が数値で届き、Unique_Key の要素と同じ
 * 「申告値を文字列として読む」規則に従うのが素直である。`0` の除外を文字列化の後に置くのは、数値の `0` と
 * 文字列の `"0"` が同じ意味（卓なし）を表すためで、型によって扱いが分かれる形を作らない。
 */
function toTableId(raw: unknown): string | null {
  const text = readDeclaredText(raw);
  return text === null || text === "0" ? null : text;
}

/**
 * 単調性で読み飛ばされる Record 数を数える（`ReceiveCounts.doDedupeSkipped`）。
 *
 * **判定するのは engine であって、ここは数えるだけである。** 重複の判定は `arriveRecords` の内側にあり
 * （判定材料が engine 状態に属する・AC 6.10）、engine の遷移は件数を返さない——`Outcome` は全遷移が
 * 共有する形ゆえ、受領だけのために件数を載せれば他の 7 遷移の契約まで動く。件数は観測値であって
 * 状態でも作用でもないため、同じ入力を同じ述語で走り直して得る。
 *
 * **新旧の基準は `isNewerSequence` ただ一つを通す。** 桁数を揃えた文字列比較の規則が二箇所に分かれれば、
 * 繰り上がりの瞬間に片方だけが誤る。述語が同一で、走る列も開始状態も順序も同一であるため、engine の
 * 読み飛ばしとこの計数が食い違うことはない。
 *
 * 突き合わせるのは**畳んだ途中の値**である（`arriveRecords` と同じ理由）。遷移前の値と比べれば、同一受領に
 * 含まれる同一端末の後着がすべて「新しい」と見えてしまう。
 */
function countDedupeSkipped(
  received: readonly ReceivedOrder[],
  lastSequenceByTerminal: Readonly<Record<string, string>>,
): number {
  const advanced: Record<string, string> = { ...lastSequenceByTerminal };
  let skipped = 0;
  for (const order of received) {
    if (!isNewerSequence(order.sequenceNumber, advanced[order.terminalId])) {
      skipped += 1;
      continue;
    }
    advanced[order.terminalId] = order.sequenceNumber;
  }
  return skipped;
}

/**
 * 往路（Solver_Worker への計画要求）の宛先 URL。
 *
 * 宛先を決めるのは Service binding（`env.SOLVER`）であり、この URL のホスト名はどこも指さない。指さないことを
 * 名前で示すため予約 TLD（`.invalid`）を使う——実在しうるホスト名を書くと、binding を通らない経路が
 * どこかに在るように読める。`fetch` が絶対 URL を要求するために置くだけの値である。
 */
const SOLVER_REQUEST_URL = "https://solver.invalid/plan";

/** 不正な到着ボディへの応答（AC 1.4）。集合は変わっていないという事実をそのまま 400 で伝える。 */
function rejectedOrder(): Response {
  return Response.json({ accepted: false, error: "malformed-order" }, { status: 400 });
}

/**
 * StoreTimerDO — 店舗の全タイマー状態の正本（SSOT）を保持する Durable Object。
 *
 * core（decide）が返す Effect 列を shell が先頭から順に実行する。SSOT 規律はこの実行規則に宿る。
 * 確定の起点は storage.put の成功のみ。Persist が成功して初めて Working_Copy を確定反映し、
 * その上に SetAlarm / ClearAlarm / Broadcast が立つ。
 *
 * 自立性の不変（要件6.1 / 6.2）：この DO はレジストリ（STORE_REGISTRY_DO）へ一切越境読みをしない。
 * 設定・名簿はレジストリからの applyProjection 押し込みでのみ届き（pull せず push で受ける）、自身の
 * projection キーへ永続した「最後に受領した投影」だけが正本となる。ゆえに rehydrate（hibernate 復帰）の
 * ホットパス（ensureLoaded → ensureProvisioned → reconcile）も接続時の条件判定（fetch の未プロビジョニング・
 * 非活性化ゲート）も store DO 内で閉じ、いずれも自身の storage.get だけを読む。レジストリが不達・停止して
 * いてもタイマー機能と接続可否判定は最後の投影で継続する。env から読むのは OBSERVE_DEBUG（計装フラグ）のみで、
 * この DO は STORE_REGISTRY_DO バインディングも他 DO スタブ（idFromName / getByName）も一切保持しない。
 */
export class StoreTimerDO extends DurableObject<Env> {
  /**
   * Working_Copy — メモリ上に保持する TimerState そのもの。
   *
   * メモリへの代入は永続化ではない。永続層が SSOT であり、この複製は storage.put 成功時にのみ
   * 確定反映される（runEffects 参照）。hibernate 復帰後は揮発するため task 11 でロードを保証する。
   */
  private workingCopy: TimerState = EMPTY_STATE;

  /**
   * ロード済みフラグ。ensureLoaded を一度きりにして冪等に保つ。
   *
   * constructor の blockConcurrencyWhile で必ず初期化されるが、各エントリポイントの前段でも
   * ensureLoaded を呼ぶため、このフラグで二重ロードを防ぐ（hibernate 復帰ごとに false へ戻る）。
   */
  private loaded = false;

  /**
   * 店舗のユニット総数（StoreConfig.unitCount）。サーバ権威・クライアント不変の店舗設定。
   *
   * ensureProvisioned が永続投影（projection.config）から在メモリへ反映する。接続時に config ServerMessage
   * として各クライアントへ一方向配信する。既定は投影未受領（未プロビジョニング）時の安全網。
   */
  private unitCount: number = DEFAULT_UNIT_COUNT;

  /**
   * 店舗が提供する麺種プリセット（StoreConfig.noodlePresets）。サーバ権威・クライアント不変の店舗設定。
   *
   * unitCount と同じ系統で投影 config から反映し、config として配信する。店舗ごとに異なりうる
   * （レジストリのイデアから合成された投影が正本）。既定は安全網。
   */
  private noodlePresets: NonEmptyArray<NoodlePreset> = DEFAULT_NOODLE_PRESETS;

  /**
   * 硬さの商品コード → Firmness の対応表（StoreConfig.firmnessCodes）。サーバ権威・クライアント不変の店舗設定。
   *
   * noodlePresets と同じ系統で投影 config から反映し、config として配信する（項目ごとに配信対象を選び直さない）。
   * 既定は投影未受領時の安全網で、空の表は「まだ投入していない」という正直な状態である。
   */
  private firmnessCodes: readonly FirmnessCode[] = DEFAULT_FIRMNESS_CODES;

  /**
   * メニュー（親品目の商品コード）→ 麺種と麺量群の対応表（StoreConfig.menuItems）。サーバ権威設定。
   *
   * firmnessCodes と 1 つの束に畳まないのは、更新の主体と頻度が異なる 2 枚を StoreConfig が分けて持つ理由が
   * そのまま在メモリの写しにも当てはまるためである（scheduleParams が束なのは engine の採点関数が要する
   * 入力の全体だからで、こちらにそのような読み手はまだ無い）。
   */
  private menuItems: readonly MenuItem[] = DEFAULT_MENU_ITEMS;

  /**
   * 腕の本数（StoreConfig.arms）。同時に上げられる本数の上限＝1 Sync_Set の最大本数。サーバ権威設定。
   *
   * unitCount と同じ系統で投影 config から反映し、decide 呼び出し時に synchronize へ値として注入する。
   * client へは配信しない（要件6.5）。既定は安全網。
   */
  private arms: number = DEFAULT_ARMS;

  /**
   * 許容調整割合（StoreConfig.toleranceRatio・整数パーセント）。各 Timer が茹で時間に対し前後に調整してよい割合。
   *
   * arms と同じ系統で投影 config から反映し、decide 呼び出し時に synchronize へ値として注入する。
   * client へは配信しない（要件6.5）。既定は安全網。
   */
  private toleranceRatio: number = DEFAULT_TOLERANCE_RATIO;

  /**
   * 計画の採点パラメータ（StoreConfig の重み 3・許容幅 3・レイアウト 2）。サーバ権威設定。
   *
   * unitCount と同じ系統で投影 config から反映し、decide 呼び出し時に settleParams へ載せ、config として
   * 配信する（全項目配信へ方針転換した・design の中心的判断 10）。8 値を個別フィールドに散らさず 1 つの
   * 束で持つのは、これが engine の採点関数がちょうど要する入力の全体（ScheduleParams）であり、
   * 意味を定めているのが目的関数の側だからである（`arms` のように shell が単独で読む値ではない）。
   * 既定は投影未受領（未プロビジョニング）時の安全網。
   */
  private scheduleParams: ScheduleParams = {
    orderSyncWeight: DEFAULT_ORDER_SYNC_WEIGHT,
    tableSyncWeight: DEFAULT_TABLE_SYNC_WEIGHT,
    affinityWeight: DEFAULT_AFFINITY_WEIGHT,
    orderSyncToleranceSeconds: DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS,
    tableSyncToleranceSeconds: DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS,
    affinityToleranceDistance: DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
    unitOrigins: defaultUnitOrigins(DEFAULT_UNIT_COUNT),
    slotOffsets: DEFAULT_SLOT_OFFSETS,
  };

  /**
   * プロビジョニング状態のキャッシュ。ensureProvisioned が一度読んだ判定を保持し、fetch 経路が参照する。
   * 既定は未プロビジョニング（安全側）。applyProjection の押し込み確定時にも provisioned へ更新される。
   */
  private provisionState: ProvisionState = { provisioned: false };

  /** プロビジョニング判定済みフラグ。ensureProvisioned を冪等にする（hibernate 復帰ごとに false へ戻る）。 */
  private provisionChecked = false;

  /**
   * instanceId — この in-memory 生存期間を一意に識別する観測キー（要件4.8 / 5.1）。
   *
   * 採番は crypto.randomUUID() という shell の作用であり、フィールド初期化子により construct 時に
   * 一度だけ行う。readonly ゆえ存続期間中は不変で、再 construct（cold start / 再デプロイ / hibernation
   * wake）ごとに必ず別値になる。これは永続状態ではなくメモリ上の事実であり、Working_Copy や
   * 永続スナップショットには一切混ざらない（計装は観測点であって作用点ではない）。
   */
  private readonly instanceId: string = crypto.randomUUID();

  /** instanceId の採番時刻（construct 時刻）。区間分類の昇順整列に用いる観測値（要件5.1）。 */
  private readonly instanceBornAt: EpochMillis = Date.now() as EpochMillis;

  /**
   * debug flag ゲート。計装出力の有効/無効をこの一点で判定する（要件4.10）。
   *
   * OBSERVE_DEBUG は env 経由の公開設定キー。既定値は "0"（無効）で、観測時のみデプロイ時の
   * オーバーライドで "1" に上書きする。wrangler types は既定値から literal 型 "0" を生成するため、
   * "1" との直接比較は型の重なりが無く TS2367 になる。実行時は "1" を取りうる事実を表すため
   * string へ広げて比較する。
   */
  private get instrumentationEnabled(): boolean {
    return (this.env.OBSERVE_DEBUG as string) === "1";
  }

  /** Operation History の同期 Producer を有効にする独立ゲート。debug 計装とは共有しない。 */
  private get operationHistoryEnabled(): boolean {
    return (this.env.OPERATION_HISTORY_ENABLED as string) === "1";
  }

  /** Persist を含む既存作用列が通常完了した確定差分だけを、入口の終端で同期出力試行する。 */
  private tryWriteCommittedOperation(
    eventKind: OperationObservation["eventKind"],
    eventTime: EpochMillis,
    before: TimerState,
    effects: readonly Effect[],
    result: RunResult,
  ): void {
    if (!result.persisted || !effects.some((effect) => effect.type === "Persist")) return;
    const storeId = this.ctx.id.name;
    if (storeId === undefined || storeId.length === 0) return;
    tryWriteOperationLines(this.operationHistoryEnabled, {
      storeId,
      eventTime,
      eventKind,
      before,
      after: this.workingCopy,
    });
  }

  /**
   * Access_Required_Flag ゲート。接続時 Roster 認可の要否をこの一点で判定する（要件6.3 / 6.4 / 8.7）。
   *
   * ACCESS_REQUIRED は env 経由の公開設定キー。ON（"1"）のとき、fetch は Worker が付与した検証済み identity を
   * 投影 Roster にローカル照合する（レジストリ照会なし）。OFF（既定 "0"）のときは Roster 照合を行わず、
   * プロビジョニング済みであることのみを接続の条件とする（合鍵 URL・要件6.4）。フラグの切替は env のみで、
   * コード変更を要しない（要件8.7）。wrangler types は既定値から literal 型 "0" を生成するため、"1" との
   * 直接比較は型の重なりが無く TS2367 になる。実行時は "1" を取りうる事実を表すため string へ広げて比較する。
   */
  private get accessRequired(): boolean {
    return (this.env.ACCESS_REQUIRED as string) === "1";
  }

  /**
   * 接続時 Roster 認可の所属判定（投影のみで完結・レジストリ照会なし・要件6.3）。
   *
   * 照合の両辺——接続要求の identity と Roster の各要素——を normalize で正準形へ写してから比較する
   * （同じ人を同じ単位で照合する・要件9.5）。判定に用いるのは永続投影が同梱する roster だけで、レジストリへ
   * 越境しない（自立性・要件6.2）。identity 欠如（null）は非所属として扱い、呼び出し側が接続を拒否する。
   */
  private isRostered(roster: Roster, identity: string | null): boolean {
    if (identity === null) return false;
    const target = normalize(identity);
    return roster.some((entry) => normalize(entry) === target);
  }

  /**
   * 計装 entry を Instrumentation_Log として吐く唯一の作用点（要件4.1〜4.4 / 4.10）。
   *
   * debug 無効時は即 return し、いずれの継ぎ目からも出力しない。ゲートをこの一点に集約することで
   * 「4継ぎ目限定」（要件4.9）が構造で守られる。entry の組み立ては純粋関数（src/observe/log.ts の
   * buildSeamEntry）に委ね、shell は console.log(JSON.stringify(...)) で吐くだけ。同期的な
   * console.log のみで待機も状態も持たず、Working_Copy・永続スナップショット・Effect 実行順序
   * （Persist 先頭）を一切変えない（要件4.6）。wrangler tail がこの出力を拾う。
   */
  private emitSeam(entry: InstrumentationLogEntry): void {
    if (!this.instrumentationEnabled) return;
    console.log(JSON.stringify(entry));
  }

  /**
   * hibernate 復帰後の初期化を blockConcurrencyWhile で囲い、完了まで後続イベント配送を止める（要件7.3）。
   *
   * 中途半端な Working_Copy を外部へ応答しないための規律。ロード後に reconcile を 1 回適用し、
   * 期限到来分の即時発火・残存からの Alarm 再導出を回収する（要件7.6 / 7.2 / 7.7）。
   * blockConcurrencyWhile 内で投げられた例外（読み出し失敗 / 移行不能）は DO を再初期化させる（要件7.5）。
   *
   * この復帰ホットパスはレジストリへ越境しない（要件6.1）——ensureLoaded / ensureProvisioned は自身の
   * storage.get のみを読み、reconcile は在メモリ状態と ensureProvisioned が確立した投影 config（arms /
   * toleranceRatio）だけで決まる。レジストリ RPC は経路上に存在せず、その可用性に依存せず復帰できる。
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 継ぎ目1: construct（要件4.1）。なぜ先頭か——この呼び出し自体が「新しい in-memory が生まれた」
    // 事実そのものであり、blockConcurrencyWhile（rehydrate）より前に採番済みの instanceId を確定の
    // 起点として記録しなければ、cold start / wake の境界を後続の継ぎ目と突き合わせられないため。
    // at は採番時刻（instanceBornAt）を用い、instanceId と同一時点を指させる。
    this.emitSeam(
      buildSeamEntry({ seam: "construct", at: this.instanceBornAt, instanceId: this.instanceId }),
    );
    void ctx.blockConcurrencyWhile(async () => {
      await this.ensureLoaded();
      await this.ensureProvisioned();
      // ロード後の整合（要件7.6 / 7.2 / 7.7）。now は shell が採取して core へ渡す（core は時計を持たない）。
      const now = Date.now() as EpochMillis;
      const before = this.workingCopy;
      // 同期・採点のパラメータは settleParams が一箇所で組む（投影 config から確立した確定値を注入する）。
      const outcome = decide(before, { type: "Reconcile", now }, this.settleParams());
      // reconcile は常に成功する（fireDueTimers と同形）。Persist 先頭の Effect 列を runEffects が実行し、
      // 即時発火による状態変化は put 成功時にのみ確定する（SSOT 規律）。
      if (outcome.ok) {
        const result = await this.runEffects(outcome.effects);
        this.tryWriteCommittedOperation("Reconcile", now, before, outcome.effects, result);
      }
    });
  }

  /**
   * Working_Copy のロードを保証する（要件7.1 / 8.6）。全エントリポイント共通の前段。
   *
   * 未ロード時のみ storage.get → migrate → fromSnapshot で TimerState を再構築する。
   * - 読み出し失敗（storage.get の reject）は握り潰さず呼び出し元へ伝播し、再初期化に委ねる（要件7.5）。
   * - migrate は snapshot 不在を空スナップショットへ写すため、不在は空状態になる（Alarm 設定なし・要件7.4）。
   * - 移行不能（UnsupportedSchemaVersion / MigrationFailed）は Working_Copy を確定せず throw（要件7.5）。
   * loaded フラグにより二度目以降は何もしない（冪等）。
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    // 読み出し失敗はここで確定せず伝播させる（要件7.5）。
    const raw = await this.ctx.storage.get(SNAPSHOT_KEY);
    // version 検査・移行（要件11）。不在は空スナップショットへ写される（要件7.4）。
    const migrated = migrate(raw);
    if (!migrated.ok) {
      // 移行を確定しない。Working_Copy も loaded も触らず throw し、再初期化に委ねる（要件7.5）。
      throw new InitError(migrated.failure);
    }
    // ここで初めて Working_Copy を再構築する。確定後にロード済みとし、以後は冪等。
    this.workingCopy = fromSnapshot(migrated.snapshot);
    // 継ぎ目2: rehydrate（要件4.2）。なぜ fromSnapshot 直後か——hibernate 復帰で揮発した Working_Copy が
    // 永続スナップショットから何件復元されたかは、再構築が済んだこの時点でしか正確に採れないため。
    // restoredCount は復元後の copy を読むだけで、ロード制御（loaded フラグ）や状態を一切変えない。
    this.emitSeam(
      buildSeamEntry({
        seam: "rehydrate",
        at: Date.now(),
        instanceId: this.instanceId,
        restoredCount: this.workingCopy.timers.length,
      }),
    );
    this.loaded = true;
  }

  /**
   * プロビジョニング状態を確定し、投影が在れば config を在メモリへ反映する（現行 ensureConfigLoaded の後継）。
   *
   * env シード分岐は撤去した。自身の storeId は DO の addressed name（ctx.id.name）で表され（Cloudflare 前提2）、
   * この DO が「存在する店舗」かどうかは永続投影（projection キー）の有無だけが語る。投影が未永続なら
   * 未プロビジョニング——env から設定を自動確立することはしない（要件2.7 / 9.3）。永続されていれば投影 config を
   * 在メモリへ反映し（接続時 config 配信・adjust 解決・decide 注入がこの値に従う）、provisioned として返す。
   *
   * これは detection のみで作用（put）を持たない。未プロビジョニングの拒否（要件2.6・書き込みゼロ）と
   * 非活性化の閉鎖（要件6.6）は fetch 側が本状態を読んで行う（task 4.3 / 4.4）。provisionChecked で冪等に保つ。
   */
  private async ensureProvisioned(): Promise<ProvisionState> {
    if (this.provisionChecked) return this.provisionState;
    // 越境読みなし——参照するのは自身の永続投影だけ（レジストリへ問い合わせない・要件6.1 / 6.2）。
    const projection = (await this.ctx.storage.get(PROJECTION_KEY)) as StoreProjection | undefined;
    if (projection === undefined) {
      // 投影未永続＝未プロビジョニング。config は既定の安全網のまま（接続は task 4.3 が拒否する）。
      this.provisionState = { provisioned: false };
    } else {
      // 投影を受領済み＝プロビジョニング済み。config を在メモリへ反映して以後の応答の正本とする。
      this.adoptProjectionConfig(projection.config);
      this.provisionState = { provisioned: true, projection };
    }
    this.provisionChecked = true;
    return this.provisionState;
  }

  /**
   * 投影の StoreConfig を在メモリへ反映する唯一の反映点。
   *
   * 接続時の config 配信・adjust 解決・decide への注入はこの在メモリ値に従う。applyProjection（押し込み確定時）と
   * ensureProvisioned（rehydrate ロード時）の双方がここを経由し、設定の写しが二箇所で分岐しないようにする
   * （SSOT は永続投影、その在メモリ側の反映を一本化する）。純粋な代入のみで永続・配信の作用は持たない。
   */
  private adoptProjectionConfig(config: StoreConfig): void {
    this.unitCount = config.unitCount;
    this.arms = config.arms;
    this.toleranceRatio = config.toleranceRatio;
    this.noodlePresets = config.noodlePresets;
    this.firmnessCodes = config.firmnessCodes;
    this.menuItems = config.menuItems;
    // 採点パラメータは投影 config が正本。投影（StoreConfig）は既定を合成済みで届くため（registry の compose）、
    // ここで再度 DEFAULT_* へ畳まない——畳めば「どちらが既定を決めるのか」が二箇所になる。
    this.scheduleParams = {
      orderSyncWeight: config.orderSyncWeight,
      tableSyncWeight: config.tableSyncWeight,
      affinityWeight: config.affinityWeight,
      orderSyncToleranceSeconds: config.orderSyncToleranceSeconds,
      tableSyncToleranceSeconds: config.tableSyncToleranceSeconds,
      affinityToleranceDistance: config.affinityToleranceDistance,
      unitOrigins: config.unitOrigins,
      slotOffsets: config.slotOffsets,
    };
  }

  /**
   * 配信する config メッセージを組む唯一の場所（接続時の単送と押し込み時の再配信が同じ形を共有する）。
   *
   * StoreConfig の全項目を載せる（要件3.4・design の中心的判断 10）。値はいずれも投影 config から確立した
   * 確定値で、項目ごとに配信対象を選び直さない——選び直せば「client がどれを知っているか」が項目数だけ
   * 分岐し、設定が増えるたびにその表が伸びる。
   */
  private configMessage(): ServerMessage {
    return {
      type: "config",
      serverTime: Date.now(),
      unitCount: this.unitCount,
      noodlePresets: this.noodlePresets,
      arms: this.arms,
      toleranceRatio: this.toleranceRatio,
      ...this.scheduleParams,
      firmnessCodes: this.firmnessCodes,
      menuItems: this.menuItems,
    };
  }

  /**
   * decide へ注入する値の束を組む唯一の場所（engine は StoreConfig 型を知らない・非純粋を端へ寄せる規律）。
   *
   * arms / toleranceRatio / noodlePresets / 採点パラメータのいずれも ensureProvisioned（または
   * applyProjection）が投影 config から確立した確定値。
   */
  private settleParams(): SettleParams {
    return {
      arms: this.arms,
      toleranceRatio: this.toleranceRatio,
      noodlePresets: this.noodlePresets,
      ...this.scheduleParams,
    };
  }

  /**
   * applyProjection — レジストリからの投影押し込みを受ける型付き RPC（設定投入の唯一の経路）。
   *
   * 受領した投影を projection キーへ丸ごと永続し（config + roster + active + version が正本）、その上で
   * config の変化を接続中の全クライアントへ config メッセージで再配信する（要件5.2）。受領した version を
   * エコーで返す（要件5.9）。
   *
   * 単調ガード（要件5.4）：受領 version が永続済み version より小さい投影は適用せず、永続済み version を
   * そのまま返す。レジストリのリクエスト処理と Alarm 継続の fan-out は await 中に並走しうるため、到着順が
   * 逆転しても last-write-wins が店舗 DO 側で完結する。照合基準は在メモリのキャッシュではなく永続層
   * （SSOT）とし、確定済みの版に照らす。
   *
   * roster は投影の一部として永続するが ServerMessage には決して載せない（要件5.3）。config だけを配信可能と
   * する分離は StoreProjection の型構造と config ServerMessage の形が担い、ここでの送信フィルタには依らない
   * （ServerMessage に roster を表現するフィールドが無く、構築不能）。
   *
   * 到達＝計算済みの健全な投影（要件4.6 の帰結・レジストリ入口で検証済み）ゆえ、ここで再検証はしない。
   */
  async applyProjection(projection: StoreProjection): Promise<{ readonly version: number }> {
    // 単調ガードの基準は永続済み投影の version。SSOT は永続層ゆえ storage から読む。
    const persisted = (await this.ctx.storage.get(PROJECTION_KEY)) as StoreProjection | undefined;
    if (persisted !== undefined && projection.version < persisted.version) {
      // 到着順逆転。より新しい投影が既に確定済みゆえ適用せず、永続済み version をエコーする。
      return { version: persisted.version };
    }

    // 確定の起点は put 成功。先に投影全体を永続し、その上に在メモリ反映と config 再配信を立てる（SSOT 規律）。
    await this.ctx.storage.put(PROJECTION_KEY, projection);
    // config の値を在メモリへ反映する（この instance の以後の接続・adjust 解決が最新投影に従う）。
    this.adoptProjectionConfig(projection.config);
    // 投影を確定したこの店舗はプロビジョニング済み。ensureProvisioned のキャッシュも provisioned へ更新し、
    // 同一 instance 内で materialize（押し込み）直後に来る接続が正しく受理されるようにする。
    this.provisionState = { provisioned: true, projection };
    this.provisionChecked = true;
    // 接続中の全 WS への作用は投影の活性状態で分岐する（要件5.2 / 6.6）。
    if (projection.active) {
      // 活性: サーバ権威設定を config で再配信する（クライアントは制御できず受信して従うのみ）。
      // roster は載せない — config ServerMessage に表現する場所が無い（要件5.3）。
      const payload = JSON.stringify(this.configMessage());
      for (const ws of this.ctx.getWebSockets()) {
        ws.send(payload);
      }
    } else {
      // 非活性化（deactivated・要件6.6）: 新規接続は fetch が拒否する。接続中の WS はここで閉じる。
      // close はメモリ上の接続を切るだけで、永続した投影・タイマー SSOT は残す（物理削除しない・要件9.6）。
      for (const ws of this.ctx.getWebSockets()) {
        ws.close(DEACTIVATED_CLOSE_CODE, DEACTIVATED_CLOSE_REASON);
      }
    }
    // 受領した version をエコーする（収束台帳の突き合わせに用いる・要件5.9）。
    return { version: projection.version };
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    // プロビジョニング状態を確定する（投影の有無を判定し、在れば config を在メモリへ反映する）。
    // 非活性化閉鎖（要件6.6）はこの状態を読む後続タスク（4.4）が担う。
    const provision = await this.ensureProvisioned();

    // Order_Ingress（POST /s/{storeId}/orders・要件1）。認可（ORDER_INGRESS_TOKEN の定数時間照合）は
    // worker.ts が済ませており、不一致・欠如は 401 で DO へ到達しない（AC 1.1）。どのパスがこの DO へ届くかは
    // worker.ts の関心事ゆえ、ここではパスを再解釈せず method で分岐する（WS 昇格が Upgrade ヘッダで判るのと
    // 同じ置き方）。WS 昇格の判定より前に置くのは、この経路が Upgrade を持たない通常の HTTP だからである。
    if (request.method === "POST") {
      return this.receiveOrder(request, provision);
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    // 未プロビジョニング拒否（要件2.6・書き込みゼロ）。投影が未永続の DO への WS 接続は、storage.put を
    // 一切行わずに拒否する。ここまでの経路は書き込みを持たない——ensureLoaded / ensureProvisioned は
    // storage.get のみ、constructor の reconcile は空状態ゆえ settle が no-op で Effect 空を返し put が立たない
    // （空の DO では timers が無く Persist が生成されない）。判定を WebSocketPair 生成・acceptWebSocket より
    // 前に置くことで書き込み経路へ一切進ませず、書き込みゼロの DO は消滅して痕跡を残さない（合鍵 URL の帰結）。
    if (!provision.provisioned) {
      return new Response("Not provisioned", { status: 403 });
    }

    // 非活性化（deactivated）拒否（要件6.6）。保持する投影が active=false を示すとき、新規接続を受け付けない。
    // タイマー状態・投影はそのまま保持し（物理削除しない・コスト根拠は要件9.6）、拒否のみを返す。接続中の
    // 既存 WS の閉鎖は applyProjection（active=false 受領時）が担い、ここは「新規接続の拒否」に限る。
    if (!provision.projection.active) {
      return new Response("Store deactivated", { status: 403 });
    }

    // 接続時 Roster 認可（要件6.3 / 6.4）。ACCESS_REQUIRED ON 時のみ、Worker が JWKS 検証の上で内部ヘッダ
    // （IDENTITY_HEADER）に付与した identity を、永続投影の実効 Roster にローカル照合する。判定は投影だけで
    // 完結し、レジストリへ照会しない（自立性・要件6.2）。identity 欠如または Roster に不在なら 403 で拒否する。
    // OFF（暫定期）のときはこのゲートを通さず、プロビジョニング済み（＋活性）のみを条件とする（合鍵 URL・要件6.4）。
    // 判定は WebSocketPair 生成・acceptWebSocket より前に置き、拒否時は収容へ一切進ませない。
    if (
      this.accessRequired &&
      !this.isRostered(provision.projection.roster, request.headers.get(IDENTITY_HEADER))
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation 互換の収容（server.accept() は使わない）
    this.ctx.acceptWebSocket(server);

    // auto-response（要件1.1 / 12.3）: 所定の ping 要求に所定の pong を登録する。ランタイムが直接
    // 応答するため webSocketMessage ハンドラを起動せず、hibernate からの wake を伴わない。心拍は
    // 接続を生かすだけで Working_Copy も Effect 実行順序も一切変えない（client と同一の確定値を共有）。
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PING_REQUEST, PONG_RESPONSE),
    );

    // 店舗設定の一方向配信（サーバ権威・クライアント不変）。snapshot より先に送り、クライアントが
    // ユニット総数（担当範囲のクランプ元）を先に確定できるようにする。クライアントは変更できない。
    server.send(JSON.stringify(this.configMessage()));

    // Hydration（要件4.1 / 9.2 / 5.4・AC 2.4）。接続確立の一環として、収容直後にこの WS だけへ現在の確定状態の
    // 全量を snapshot として送る（差分ではなく全量）。組み立ては engine の唯一の射影 toWireSnapshot に委ねる
    // ——broadcast 経路（settle）と同一の関数を通ることが、再取得完了時点で他端末と同一の内容を持つことの根拠
    // である。shell は状態と時計を渡すだけで、確定計画・推奨の導出を持たない。
    // serverTime は送信時点のサーバ現在時刻（残り秒は送らず endTime から各クライアントが導出する）。
    server.send(
      JSON.stringify(
        toWireSnapshot(this.workingCopy, this.settleParams(), Date.now() as EpochMillis),
      ),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * receiveOrder — Order_Ingress の受け口（要件1・design の命名節）。到着とキャンセルを decide へ写す。
   *
   * **受理を応答するのは永続が確定した後だけである**（AC 1.2 / 1.5）。runEffects が返す `persisted` を見て
   * 応答を決め、put 失敗なら受理も broadcast も出さない——put 前に 200 を返せば、POS 側は届いたと信じ、
   * こちらは何も確定していないという最悪の食い違いが生まれる。broadcast は Effect 列の中で put 成功の上に
   * のみ立つ（runEffects の規律）ため、この一点を守れば両者の順序は自動的に揃う。
   *
   * 冪等（AC 1.3）は engine 側で閉じる。同一内容の再送は upsertOrder が同じ集合を返し、settle が Effect を
   * 出さないため、put も broadcast も起きずに 200 を返す（初回受理と同一の確定状態へ収束する）。存在しない
   * オーダーのキャンセルも同じ形で no-op になり、開始済み Timer には触れない（AC 1.6）。
   *
   * Operation History へは何も出さない。到着・キャンセルは Timer 状態の差分を持たず、あちらの Producer の
   * 出力対象（Timer_Persist が確定させた Timer 状態の差分だけ）に当たらないためである（tasks.md 21.3）。
   */
  private async receiveOrder(request: Request, provision: ProvisionState): Promise<Response> {
    // 接続と同じゲート（要件2.6 / 6.6）。未プロビジョニングの DO には麺種プリセットが確立しておらず、
    // 既定のプリセットに照らして到着を検証すれば、店舗が提供しない品目を待ち行列へ通しうる。
    // 判定を put の前に置くことで、書き込みゼロの DO は痕跡を残さないまま拒否される。
    if (!provision.provisioned) {
      return new Response("Not provisioned", { status: 403 });
    }
    if (!provision.projection.active) {
      return new Response("Store deactivated", { status: 403 });
    }

    // arrivalTime は「Order_Ingress が受理した絶対時刻」という受け手側の事実（Wait_Time の起点）。
    // 当該遷移の時計（settle の再同期と snapshot の serverTime）と同じ値を用いる。
    const now = Date.now() as EpochMillis;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return rejectedOrder();
    }
    const intent = toOrderIntent(body, this.noodlePresets, now);
    // 不正ボディは 400 で、Pending_Order 集合と Timer 集合をいずれも変更しない（AC 1.4）——decide を
    // 呼ばずに戻るため、集合が変わる経路に一切入らない。
    if (intent === null) {
      return rejectedOrder();
    }

    const event: Event =
      intent.kind === "arrival"
        ? { type: "OrderArrived", arrival: intent.arrival, now }
        : { type: "OrderCancelled", externalOrderId: intent.externalOrderId, now };
    const outcome = decide(this.workingCopy, event, this.settleParams());
    if (!outcome.ok) {
      // 到着・キャンセルの遷移は拒否経路を持たない（engine/order.ts）。型の網羅のためだけの分岐であり、
      // 到達したら engine 側の不変が破れた合図ゆえ、受理を主張せずサーバ側の失敗として返す。
      return new Response(outcome.rejection.message, { status: 500 });
    }
    const result = await this.runEffects(outcome.effects);
    if (!result.persisted) {
      // put 失敗＝何も確定していない。受理も broadcast も出さず、POS の再送に委ねる（再送は冪等）。
      return Response.json({ accepted: false, error: "persist-failed" }, { status: 503 });
    }
    return Response.json({ accepted: true });
  }

  /**
   * receiveRecords — 取り込み経路（POS_Ingress）の受け口。1 店舗分の Record 群を単一の遷移へ畳む。
   *
   * `receiveOrder`（宛先を URL で直指定する既存 Order_Ingress）と別に立てるのは、届く形も冪等の鍵も違う
   * ためである。あちらは 1 意図 1 ボディで受け手側の受理時刻を起点に採り、こちらは複数オーダーを到着順に
   * 運び端末ごとの `sequence_number` で重複を弾く。RPC ゆえ HTTP ステータスを持たず、結末は
   * `ReceiveOutcome` が運ぶ。
   *
   * **`decide` は 1 回だけ呼ぶ**（Property 20）。Record ごとに呼べば `Persist` が件数だけ生じ、1 受領につき
   * 単一の `put`（AC 5.5）と単一遷移がいずれも破れる。engine 側の `arriveRecords` が集合と判定材料を先に
   * 畳み切り、確定をただ一度に閉じることでこれが成立する。
   *
   * **受理も broadcast も `Persist` の成功の上にのみ立つ**（Property 8 / AC 5.6 / 5.7）。`runEffects` が返す
   * `persisted` を見て `settled` か `persist-failed` を決める——確定の前に受理を返せば、上流は届いたと信じ、
   * こちらは何も確定していないという最悪の食い違いが生まれる。broadcast は Effect 列の中で put 成功の後に
   * しか実行されないため、この一点を守れば両者の順序は自動的に揃う。
   *
   * **前提（本メソッドが検査しないこと）。** ここへ届くのは Worker が `KNOWN_RECORD_PATHS` で Order_Path と
   * 分類し、Unique_Key を導け、Order_Arrival_Time が値域窓（受理時刻の 2 時間前から受理時刻まで）の内側に
   * ある Record だけである。窓の検査を Worker に置くのは、`now` を純粋関数の引数として渡す既存の規律に
   * 従うためで（時計を純粋関数の内側に持ち込まない）、ここで二度目の検査を置けば判定基準が二箇所に分かれる。
   *
   * Operation History へは何も出さない。受領は Timer 状態の差分を持たず、あちらの出力対象（Timer_Persist が
   * 確定させた Timer 状態の差分）に当たらない——`receiveOrder` と同じ判断である。
   */
  async receiveRecords(records: readonly ArrivalRecord[]): Promise<ReceiveOutcome> {
    await this.ensureLoaded();
    const provision = await this.ensureProvisioned();
    // 既存ゲートと同じ順・同じ位置（put の前）に置く。書き込みゼロの DO は痕跡を残さないまま拒む。
    // 応答が 403 の 1 種でなく 2 種に分かれるのは、呼び出し元が再試行と読み飛ばしを分ける必要があるためで
    // ある（`ReceiveOutcome` の注記）。
    if (!provision.provisioned) return { kind: "unprovisioned" };
    if (!provision.projection.active) return { kind: "deactivated" };

    // 翻訳は純粋関数へ委ね、shell は作用だけを担う。対応表 2 枚は投影 config から確立した在メモリの確定値で、
    // engine へは渡さない（engine は StoreConfig を知らない・AC 6.13）。
    const { received, unknownNoodleType } = toReceivedOrders(
      records,
      { firmnessCodes: this.firmnessCodes, menuItems: this.menuItems },
      this.noodlePresets,
    );
    // 計数は遷移の前に採る。遷移後の状態からは「どの Record が読み飛ばされたか」を復元できない
    // （判定材料は端末ごとに 1 つしか残らない）。
    const doDedupeSkipped = countDedupeSkipped(received, this.workingCopy.lastSequenceByTerminal);

    // now は当該遷移の時計（settle の再同期と snapshot の serverTime が用いる）。各品目の arrivalTime は
    // 上流の観測時刻ゆえ別の値であり、役割が別だから両方を運ぶ。
    const now = Date.now() as EpochMillis;
    const outcome = decide(
      this.workingCopy,
      { type: "RecordsReceived", received, now },
      this.settleParams(),
    );
    if (!outcome.ok) {
      // 受領の遷移は拒否経路を持たない（engine/receive.ts）。型の網羅のためだけの分岐であり、到達したら
      // engine 側の不変が破れた合図である。受理を主張せず「何も確定していない」として返す——呼び出し元は
      // 一時的失敗として扱い、上流の再送に委ねる。
      return { kind: "persist-failed" };
    }
    const result = await this.runEffects(outcome.effects);
    // put 失敗＝何も確定していない。受理も broadcast も出ず、集合は直前の確定状態のまま据え置かれる。
    if (!result.persisted) return { kind: "persist-failed" };
    return { kind: "settled", counts: { doDedupeSkipped, unknownNoodleType } };
  }

  /**
   * deliverPlan — Solver_Worker からの計画受領（復路・AC 6.1 / 10.3 / 12.3）。受領を PlanArrived として decide へ流す。
   *
   * **DO の公開 RPC ゆえ Service binding 経由でしか到達しない。** ネットワークからは URL を持たず、Worker の
   * ルーティング（worker.ts）にもこの経路は無い。ゆえに受け口自身がトークンを持たない——境界の認可は
   * 「誰がこの DO の stub を引けるか」で既に閉じている（`applyProjection` がレジストリからの押し込みだけを
   * 受けるのと同じ構図）。
   *
   * **生値の検証はここで行う**（AC 10.3）。解析不能・スキーマ不正は `toCookSchedule` が全体を null へ落とし、
   * このメソッドは何もせずに戻る——engine の受け口が事象を起こさないという形で全体棄却が成立する。
   *
   * **受領を新たな要求の契機にしない**（AC 5.7）。`receivePlan` が `settle` へ `mayRequestPlan = false` を渡すため、
   * 採用しても要求の連鎖は生まれない。全棄却なら `Persist` も `Broadcast` も出ない（AC 6.6）。
   *
   * 戻り値を持たない。採否を呼び出し元へ返せば、Solver_Worker が結果を見て何かを決める余地が生まれる
   * ——採否は DO 側のゲートだけが決める（AC 6.7）。in-flight の追跡状態も応答監視の Alarm も持たない（AC 10.4）。
   */
  async deliverPlan(plan: unknown): Promise<void> {
    await this.ensureLoaded();
    const validated = toCookSchedule(plan);
    if (validated === null) return;
    const now = Date.now() as EpochMillis;
    const outcome = decide(
      this.workingCopy,
      { type: "PlanArrived", plan: validated, now },
      this.settleParams(),
    );
    // 受領の遷移は拒否経路を持たない（engine/plan.ts）。型の網羅のためだけの分岐である。
    if (!outcome.ok) return;
    // 採用があれば Persist 先頭の Effect 列が実行され、broadcast は put 成功の上に立つ（SSOT 規律）。
    // Operation History へは何も出さない——採用/棄却は Timer 状態の差分ではない（tasks.md 21.3）。
    await this.runEffects(outcome.effects);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ensureLoaded();

    // 受理するのは文字列 JSON のみ。ArrayBuffer など非文字列は破棄して Working_Copy を一切変えない（要件9.7）。
    if (typeof message !== "string") return;
    const command = toClientMessage(message);
    // 不正形式（JSON parse 失敗 / 未知 type / 必須フィールド欠如・型不一致）は破棄する（要件9.7）。
    if (command === null) {
      console.error(toDecodeFailureLine("ClientMessage"));
      return;
    }

    // ClientMessage を core への Event へ写す。crypto.randomUUID() と Date.now() は shell の作用であり、
    // core は時計も乱数も持たない（core/event.ts 参照）。
    const now = Date.now() as EpochMillis;
    // adjust は engine が持たない「麺ごとの硬さ別茹で秒」を shell が StoreConfig から解決して載せる。
    // 対象不在・該当麺なしは Event を作らず error を返す（解決できない要求は core へ進めない）。
    if (command.type === "adjust") {
      const target = this.workingCopy.timers.find((t) => t.id === command.timerId);
      const preset = target && this.noodlePresets.find((p) => p.noodleType === target.noodleType);
      if (target === undefined || preset === undefined) {
        const error: ServerMessage = {
          type: "error",
          serverTime: Date.now(),
          code: target === undefined ? "TimerNotFound" : "UnknownNoodle",
          message:
            target === undefined
              ? `指定された timerId の Timer は存在しない: ${command.timerId}`
              : `店舗設定に該当する麺種がない: ${target.noodleType}`,
        };
        ws.send(JSON.stringify(error));
        return;
      }
      // 同期・採点のパラメータは settleParams が一箇所で組む（投影 config から確立した確定値を注入する）。
      const before = this.workingCopy;
      const outcome = decide(
        before,
        {
          type: "Adjust",
          timerId: command.timerId,
          firmness: command.firmness,
          boilSeconds: preset.boilSeconds[command.firmness],
          now,
        },
        this.settleParams(),
      );
      if (outcome.ok) {
        const result = await this.runEffects(outcome.effects);
        this.tryWriteCommittedOperation("Adjust", now, before, outcome.effects, result);
        return;
      }
      const error: ServerMessage = {
        type: "error",
        serverTime: Date.now(),
        code: outcome.rejection.code,
        message: outcome.rejection.message,
      };
      ws.send(JSON.stringify(error));
      return;
    }

    const event =
      command.type === "start"
        ? {
            type: "Start" as const,
            slotIds: command.slotIds,
            noodleType: command.noodleType,
            boilSeconds: command.boilSeconds,
            newTimerId: crypto.randomUUID() as TimerId,
            now,
          }
        : command.type === "startOrderItem"
          ? {
              // 品目を指す開始。麺種・茹で加減・茹で秒は運ばれず、engine が pendingOrders と
              // noodlePresets から導く（slot-suggested-start 判断 6）。
              type: "StartOrderItem" as const,
              slotIds: command.slotIds,
              externalOrderId: command.externalOrderId,
              itemIndex: command.itemIndex,
              newTimerId: crypto.randomUUID() as TimerId,
              now,
            }
          : command.type === "cancel"
            ? { type: "Cancel" as const, timerId: command.timerId, now }
            : { type: "Complete" as const, timerId: command.timerId, now };

    // 同期・採点のパラメータは settleParams が一箇所で組む（投影 config から確立した確定値を注入する）。
    const before = this.workingCopy;
    const outcome = decide(before, event, this.settleParams());
    if (outcome.ok) {
      // Persist 先頭の Effect 列を runEffects が実行する（SSOT 規律）。確定変化は全 WS へ snapshot を
      // broadcast し、要求元も他 client と同一の snapshot を受ける（Reply を使わない・bug#1 の構造的消滅）。
      const result = await this.runEffects(outcome.effects);
      this.tryWriteCommittedOperation(event.type, now, before, outcome.effects, result);
      return;
    }
    // 拒否は Effect 列を生まない（outcome.ok === false）。要求元の WS だけへ error を返す（要件1.5 / 3.8 / 6.6）。
    const error: ServerMessage = {
      type: "error",
      serverTime: Date.now(),
      code: outcome.rejection.code,
      message: outcome.rejection.message,
    };
    ws.send(JSON.stringify(error));
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    // 接続管理は ctx.getWebSockets() を正とし、自前の接続リストという隠れ状態を持たない（要件9.4）。
    // よって切断時に除去すべき独自状態は存在しない。web_socket_auto_reply_to_close は
    // compatibility_date(2026-06-26) で既定化済みのため ws.close() も不要。ハンドラ本体は空でよい。
    void ws;
    void code;
    void reason;
    void wasClean;
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.ensureLoaded();
    // 継ぎ目3: alarm（要件4.3）。なぜ ensureLoaded 後の先頭か——Alarm 起動も hibernate からの wake を
    // 伴いうるため、Working_Copy のロードが済んだ起動直後に「この instance で Alarm が走った」事実を
    // 記録する。decide / runEffects より前なので発火・永続・broadcast の順序には一切干渉しない。
    this.emitSeam(buildSeamEntry({ seam: "alarm", at: Date.now(), instanceId: this.instanceId }));
    // now は shell が採取して core へ渡す（core は時計を持たない＝純粋）。
    const now = Date.now() as EpochMillis;
    const before = this.workingCopy;
    // AlarmFired は fireDueTimers と同形で常に成功する（拒否経路を持たない）。
    // 同期・採点のパラメータは settleParams が一箇所で組む（投影 config から確立した確定値を注入する）。
    const outcome = decide(before, { type: "AlarmFired", now }, this.settleParams());
    if (!outcome.ok) return;
    // Persist 先頭の Effect 列を runEffects が実行する。SetAlarm/ClearAlarm は applySideEffect が
    // storage.setAlarm/deleteAlarm へ写し、done の Broadcast は put 成功の上にのみ立つ（SSOT 規律）。
    const result = await this.runEffects(outcome.effects);
    if (result.persisted) {
      this.tryWriteCommittedOperation("AlarmFired", now, before, outcome.effects, result);
      return;
    }
    // ここに来たら Persist 失敗 = 何も確定していない（Working_Copy も put 前のまま据え置き）。
    // 原則は throw して Cloudflare Alarm の at-least-once 自動リトライに委ねる。ただし retryCount が
    // 上限近傍のときは throw せず新規 Alarm を張り直し、リトライ枯渇による取りこぼしを防ぐ（公式推奨）。
    if (alarmInfo !== undefined && alarmInfo.retryCount >= ALARM_REARM_THRESHOLD) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_REARM_DELAY_MS);
      return;
    }
    throw new Error(
      `alarm persist failed (store=${this.ctx.id.name ?? "unknown"}, retryCount=${alarmInfo?.retryCount ?? 0})`,
    );
  }

  /**
   * core が返した Effect 列を先頭から順に実行する（要件8.1・8.4・8.5・3.7）。
   *
   * Persist は確定の起点。await で書き込み完了を保証してから後続へ進む。put 成功時にのみ
   * Working_Copy を確定反映する。put が失敗したら後続 Effect（SetAlarm/ClearAlarm/Broadcast）
   * を実行せず、Working_Copy も put 前のまま据え置く（成功するまで代入しないので「戻す」操作は不要）。
   *
   * 拒否・失敗の要求元通知は Effect 列に乗らず、shell が error を直接 ws.send する（Reply を使わない）。
   * ゆえに runEffects は宛先 WS を引き回さない（Broadcast は全 WS 一様・snapshot 単一表現）。
   */
  private async runEffects(effects: readonly Effect[]): Promise<RunResult> {
    for (const effect of effects) {
      if (effect.type === "Persist") {
        try {
          // 逐次 await は意図的。確定の起点である put の完了を保証してから後続へ進むため、
          // 並列化（Promise.all）は SSOT 規律に反する。
          // oxlint-disable-next-line no-await-in-loop
          await this.ctx.storage.put(SNAPSHOT_KEY, effect.snapshot);
        } catch {
          // put 失敗 = 何も確定していない。後続 Effect を実行せず Working_Copy も据え置く。
          return { persisted: false };
        }
        // 確定の起点。put 成功したスナップショットだけが新しい Working_Copy になる。
        this.workingCopy = fromSnapshot(effect.snapshot);
      } else {
        // Persist 成功の後でのみ到達する。put 成功の上に broadcast / alarm が立つ。
        // 逐次 await は列の順序を守るためで、待ちを持つのは RequestPlan の受理応答（202）ひとつだけである
        // （他の作用は同期に済む）。202 を待つのは「送ったことを確かめてから event 処理を終える」ためで、
        // 計算完了は待たない（AC 5.2 / 12.2）。
        // oxlint-disable-next-line no-await-in-loop
        await this.applySideEffect(effect);
      }
    }
    return { persisted: true };
  }

  /**
   * Persist 以外の Effect を対応するプラットフォーム作用へ写す。
   *
   * これらは永続済み状態から再構成可能な派生作用であり、Persist のように完了を await しない
   * （欠落は Alarm なら次回起動の reconcile、Broadcast なら再接続時の全量 hydration が回収する）。
   *
   * **RequestPlan だけが待ちを持つ。** 外部への送出は完了を確かめないと、event 処理の終了で invocation ごと
   * 打ち切られて要求が届かないことがある。ゆえに受理応答（202）までを await する——計算完了は待たない
   * （AC 5.2 / 12.2）。この一点のために署名が Promise を返す。
   */
  private async applySideEffect(
    effect: Exclude<Effect, { readonly type: "Persist" }>,
  ): Promise<void> {
    switch (effect.type) {
      case "SetAlarm":
        void this.ctx.storage.setAlarm(effect.at);
        break;
      case "ClearAlarm":
        void this.ctx.storage.deleteAlarm();
        break;
      case "Broadcast": {
        // 接続中の全 WS へ全量送信。送信失敗は握り潰さず、回復は再接続 hydration に委ねる（要件2.6）。
        const payload = JSON.stringify(effect.message);
        // 継ぎ目4: broadcast（要件4.4）。なぜ送信ループ前に 1 回か——「この broadcast 作用が起きた」事実は
        // 宛先 WS の数とは独立した 1 回の出来事であり、ループ内に置くと接続数ぶん増殖して観測点が
        // 4 継ぎ目限定（要件4.9）から外れるため。messageType は送る ServerMessage の種別を読むだけで、
        // payload の中身・送信内容・送信タイミングは一切変えない（要件4.6）。
        this.emitSeam(
          buildSeamEntry({
            seam: "broadcast",
            at: Date.now(),
            instanceId: this.instanceId,
            messageType: effect.message.type,
          }),
        );
        for (const ws of this.ctx.getWebSockets()) {
          ws.send(payload);
        }
        break;
      }
      case "RequestPlan":
        // 唯一の待ち。受理応答（202）までを await して「送ったことを確かめてから」event 処理を終える。
        // 計算完了は待たない（AC 5.2 / 12.2）。送出失敗は requestPlan が内で握る（AC 10.2）。
        await this.requestPlan(effect);
        break;
      default: {
        // 網羅を型で強制する。Effect へ新しい種別が入ると effect が never へ落ちず、この代入が型エラーに
        // なる——「宣言なく黙って落とす」穴が二度と開かない（design の「網羅性は switch が型で保証する」）。
        const unhandled: never = effect;
        return unhandled;
      }
    }
  }

  /**
   * 外部（Solver_Worker）へ計画を要求する（AC 5.2 / 10.2 / 12.2）。往路の唯一の送出点。
   *
   * **受理応答（202）だけを await する。** 計算完了を待てば、改善の投機のために DO が起きたまま外部の計算を
   * 抱えることになる（「待つなら寝かせる、抱えると漏れる」）。完了は Solver_Worker 側が `ctx.waitUntil` で
   * 抱え、復路の `deliverPlan` が DO を wake させる——その wake が正当な起動である。
   *
   * **送出失敗を Timer 本体へ伝播させない**（AC 10.2）。送出は確定の一部ではなく投機ゆえ、Effect 列の末尾に
   * 置かれている。ここで throw を通せば、既に確定した Persist / Broadcast の後で呼び出し元（event 入口）へ
   * 失敗が伝わり、計時と無関係な失敗が現場の応答を壊す。応答の status も見ない——不到達・エラー応答・
   * タイムアウトはすべて「何も起きない」に収束し（AC 10.1）、取り逃した機会は次の状態変化の要求が回収する。
   * **DO 内で再試行を抱えず、in-flight の追跡状態も応答監視の Alarm も持たない**（AC 10.4）。
   *
   * storeId は shell が付ける（engine は storeId を知らない・構造の主権）。名前を持たない DO——`idFromName`
   * 以外で引かれた stub——は復路の宛先を持てないため、要求そのものを出さない。
   */
  private async requestPlan(
    effect: Extract<Effect, { readonly type: "RequestPlan" }>,
  ): Promise<void> {
    const storeId = this.ctx.id.name;
    if (storeId === undefined || storeId.length === 0) return;
    // 麺プリセットは在メモリの確定値（投影 config）から載せる。Effect が宣言して運ぶのは採点パラメータの
    // 8 値までで、茹で時間は engine 側でも算出の引数として別に渡される値である（solver/request.ts の注記）。
    const body: PlanRequest = {
      storeId,
      pending: effect.pending,
      running: effect.running,
      params: effect.params,
      noodlePresets: this.noodlePresets,
      digest: effect.digest,
    };
    try {
      await this.env.SOLVER.fetch(SOLVER_REQUEST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // 送出失敗は握って落とす（上記のとおり伝播させない・再試行も抱えない）。
    }
  }
}
