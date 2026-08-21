import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { isValidStoreId } from "./registry/slug";
import type { Identity, StoreId } from "./registry/ideal";
import { type ArrivalRecord, toArrivalBatch } from "./ingress/batch";
import { readDeclaredText } from "./ingress/declared-text";
import { type PoisonReason, toRecordOutcome } from "./ingress/outcome";
import { groupByStoreCode } from "./ingress/store-code";
import { isAdminAuthorized, isOrderIngressAuthorized } from "./worker-auth";
import { type EntryDestination, resolveEntryDestination } from "./worker-entry";
import { type HeldCounts, REGISTRY_NAME, StoreRegistryDO } from "./shell/store-registry-do";
import {
  IDENTITY_HEADER,
  type ReceiveCounts,
  type ReceiveOutcome,
  StoreTimerDO,
} from "./shell/store-timer-do";

// Durable Object クラスは Worker から re-export してランタイムに公開する（登録の唯一の出所）
export { StoreRegistryDO, StoreTimerDO };

// 店舗宛先パス（Store_Path）— 宛先はパスのみで運ぶ（identity から導出しない・要件1.1）。
//   /s/{storeId}/ws  … WebSocket 接続
//   /s/{storeId}/    … 画面・SPA（配下の client ルートを含む）
// storeId 断片は生のまま切り出し、ルーティング前段で isValidStoreId により検証する。
// Order_Ingress（POST /s/{storeId}/orders・online-cook-scheduling 要件1）。POS がオーダーの到着・キャンセルを
// 届ける認可付き経路。画面パターンより前に照合する（STORE_SCREEN_PATTERN はこのパスにも当たるため）。
const STORE_WS_PATTERN = /^\/s\/([^/]+)\/ws$/;
const STORE_ORDERS_PATTERN = /^\/s\/([^/]+)\/orders$/;
const STORE_SCREEN_PATTERN = /^\/s\/([^/]+)(?:\/.*)?$/;

// POS_Ingress（POST /pos/records・pos-order-ingress AC 1.1）。宛先を Store_Code でも StoreId でも URL に
// 載せない単一のパスである（上流は設定値の 1 URL へ投げ、1 バッチに複数店舗が混在する）。受け口を
// `orders` と名付けないのは、この経路が Order_Path と Status_Path の双方を含む Record 群を受けるためで、
// `orders` と名付ければ Status_Path を受けることが名前と矛盾する。
const POS_RECORDS_PATH = "/pos/records";

/**
 * SIGNIN_ENTRY_PATH — 認証を経て店舗画面へ導く通し口の接頭（`/entry/signin/{storeId}`・要件4.5 / 4.6）。
 *
 * Sign_In_Affordance の遷移先である。`/entry/` 配下に置くのは、Service_Worker のフォールバック除外が
 * この配下をまとめて対象にしており（要件5.2）、除外設定を個別に足さずに済むためである。Access は
 * ホスト全体を保護しているため、このパスも自動的に保護下に入る（Access 側の構成変更を要さない）。
 *
 * **通し口であって関門ではない。** 接続可否の判定は店舗 DO の投影 Roster が担う既存の一本道であり、
 * ここに Roster 判定を足せば判定が二箇所に分かれる。ここが担うのは storeId の形式検証（既存の
 * `/s/{storeId}/` 分岐と同じ関門）と、店舗画面への 302 だけである。
 */
const SIGNIN_ENTRY_PATH = "/entry/signin/";

/**
 * 1 リクエストに含められる Record 件数の上限（AC 1.13）。**この値の単一の出所である。**
 *
 * 超過は一時的失敗として応答し、上流の bisect による分割で通過させる（何も確定させない）。100 店規模なら
 * 1 バッチに全店が混在しても数百 Record であり、宛先 DO への RPC は店舗ごとに 1 回ゆえ Worker の
 * subrequest 上限に収まる。実測で調整する前提の値である。
 */
const POS_RECORDS_LIMIT = 1000;

/**
 * resolvedStoreIds — Store_Code → StoreId の isolate-local メモ（Code_Memo・AC 4.1〜4.6）。
 *
 * 写像が不変（Provisioning が Store_Code の変更・再利用を拒む）ゆえ TTL も無効化も世代管理も持たない。
 * **持つ必要が無いことが、この形の正しさである。**
 *
 * **未知（不在）は載せない**（AC 4.4）。不在は不変ではない——後の店舗登録で既知に転じるうえ、保留が
 * 非空の間はレジストリが意図的に未知を返す（design §8-a・タスク 19）。載せれば、その isolate は保留が
 * 空になった後も未知を返し続け、届くはずの注文が保留へ積まれ続ける。
 *
 * 用途は宛先解決の高速化のみで、認可の判定には用いない（AC 4.6）。格納先は isolate 内のメモリだけで、
 * Cache API・KV・DO のいずれも用いない（AC 4.5）。
 *
 * NOTE: モジュールスコープゆえテスト間で持ち越される（テストは isolate を共有する）。memo の状態に
 * 依存する検証（Property 7）は forgetResolvedStoreIds で明示的に空へ戻す。
 */
const resolvedStoreIds = new Map<string, StoreId>();

/**
 * forgetResolvedStoreIds — Code_Memo を空へ戻す。**Property 7（memo は結果を変えない）の検証が要する。**
 *
 * 本番の経路はこれを呼ばない——無効化を持たないことが Code_Memo の設計そのものである（AC 4.3）。
 */
export function forgetResolvedStoreIds(): void {
  resolvedStoreIds.clear();
}

/**
 * RecordTally — 1 リクエストの観測カウンタ。**フィールド名がそのままログの JSON キーであり、
 * design「観測値の出力先」の 12 カウンタの単一の出所である**（宣言順もあの表の順に揃える）。
 *
 * 12 のうち 11 をここに持つ。`replayWindowExpired`（再生時に値域窓の外へ出た Record の破棄）だけは
 * リクエストの文脈に乗らない——再生は Alarm 由来でも起き、そのときリクエストは存在しない。ゆえに
 * あのカウンタは StoreRegistryDO が再生の地点で出す（`replayUnrouted`）。ここに 0 として並べれば、
 * 「このリクエストでは起きなかった」と「そもそもこの経路では数えていない」が同じ 0 に見える。
 *
 * 由来は 3 つに分かれる。Worker が自身で数えるもの（分類・宛先解決の結末）、宛先 DO の内側でしか判らず
 * `ReceiveOutcome.counts` で運ばれるもの（`doDedupeSkipped` / `unknownNoodleType`）、レジストリの保持の
 * 書き込みが返すもの（`heldExpired` / `heldOverflow`）。**いずれも出力は Worker が 1 行に畳む**——DO が
 * 個別に出せば 1 バッチで最大 1000 行が店舗ごとに分散して読めなくなる（AC 12.15）。
 */
interface RecordTally {
  /** 毒レコード件数（AC 9.4）。上流と同名のカウンタで突き合わせる。 */
  poisonRecord: number;
  /** 既知 `path` のいずれでもない Record（AC 7.3）。 */
  unknownPath: number;
  /** Status_Path の破棄件数（AC 7.6）。未知 `path` と別に数える（AC 7.9）。 */
  statusDiscarded: number;
  /** 宛先未解決ゆえ保留へ回った Record 数。 */
  unknownStorePending: number;
  /** 単調性で弾いた重複（宛先 DO が数え、`ReceiveOutcome.counts` で運ぶ）。上流の `dedupeSkipped` とは別名。 */
  doDedupeSkipped: number;
  /** 上流の契約違反（型違反・値域窓の外）。起こらないはずの事象として可視化する（AC 8.9）。 */
  upstreamContractViolation: number;
  /**
   * 認可失敗の件数（AC 12.8）。数えるのは**リクエスト**であって Record ではない——鍵が合わなければボディを
   * 読まないため、捨てた Record の件数は原理的に判らない。上流の `workerRejected` にアラームが無いゆえ、
   * 鍵の不一致に気づく手段はこちら側のこの値だけである。
   */
  unauthorized: number;
  /** 非活性店舗宛ての Record 数（恒久的失敗ゆえ飛ばして数える）。 */
  deactivatedStore: number;
  /** 対応表に無い麺種で写せなかった品目数（宛先 DO が数え、`ReceiveOutcome.counts` で運ぶ・AC 6.28）。 */
  unknownNoodleType: number;
  /** 保持期間（2 時間）を過ぎて破棄された件数。登録の遅れを示す。 */
  heldExpired: number;
  /** 件数上限の超過で破棄された件数。不正送信または大量の登録漏れを示す。 */
  heldOverflow: number;
}

/** 数える前の 0。1 リクエストにつき 1 つだけ作る（401 の経路も含む）。 */
function emptyTally(): RecordTally {
  return {
    poisonRecord: 0,
    unknownPath: 0,
    statusDiscarded: 0,
    unknownStorePending: 0,
    doDedupeSkipped: 0,
    upstreamContractViolation: 0,
    unauthorized: 0,
    deactivatedStore: 0,
    unknownNoodleType: 0,
    heldExpired: 0,
    heldOverflow: 0,
  };
}

/**
 * tallyHeldDiscards — 保留・隔離が返した破棄件数を数に足す。
 *
 * 2 つの受け口（`holdUnrouted` / `quarantineContractViolations`）は同一の規律で破棄するため、数え方も 1 つに
 * 保つ（破棄の 3 つを 1 つに畳まないのとは層が違う——ここは同じ 2 種を 2 箇所から集める）。
 */
function tallyHeldDiscards(tally: RecordTally, counts: HeldCounts): void {
  tally.heldExpired += counts.heldExpired;
  tally.heldOverflow += counts.heldOverflow;
}

/** tallyReceiveCounts — 宛先 DO の内側でしか判らない 2 件を数に足す（AC 12.15）。 */
function tallyReceiveCounts(tally: RecordTally, counts: ReceiveCounts): void {
  tally.doDedupeSkipped += counts.doDedupeSkipped;
  tally.unknownNoodleType += counts.unknownNoodleType;
}

/**
 * DiscardReason — 診断ログの理由（AC 9.3・9.12）。**閉じた集合の名で「なぜ捨てたか」を残す。**
 *
 * ペイロード本体をログへ出さないため、捨てた事実の内容はこの名と `sequence_number` の 2 項目に尽きる。
 * 毒の 4 事由（`PoisonReason`）に 2 つを足す——隔離の置き場が無い契約違反と、認可失敗である。いずれも
 * 「捨てたことが件数以外に何も残らない」経路であり、そこにだけ診断を出す。破棄という挙動が同じでも
 * Status_Path と未知 `path` には出さない（前者は配線待ちの既知経路、後者は件数だけで足りる想定外の到着で、
 * どちらも毎秒届きうる——1 件ずつ行を出せば診断が定常のノイズに沈む）。
 */
type DiscardReason = PoisonReason | "store-code-unreadable" | "unauthorized";

/**
 * IngressDiagnostic — 診断ログ 1 行の内容。**`sequence_number` と理由の 2 項目のみ**（AC 9.3）。
 *
 * seq を持たないのは、seq を読めない Record（構造が破れた毒）と認可失敗（ボディを読まない）である。
 * `exactOptionalPropertyTypes` ゆえ、無い場合はフィールドを省く。
 */
interface IngressDiagnostic {
  readonly reason: DiscardReason;
  readonly sequenceNumber?: string;
}

/** 分類の結果。届ける Record 列・隔離へ回す生値・届かなかったものの件数と診断に分かれる。 */
interface ClassifiedRecords {
  readonly deliverable: readonly ArrivalRecord[];
  /**
   * 隔離へ回す検証前の生値（Store_Code ごと・到着順）。
   *
   * `Map` で持つのは、同一 Store_Code の隔離が 1 回の書き込みに畳まれることである（同じキーへの並行な
   * 読み書きを作らない）。Store_Code を読めなかった契約違反は組に属せず、`upstreamContractViolation` に
   * 数えて破棄する（`contractViolationStoreCode` の注記）。
   */
  readonly violations: ReadonlyMap<string, readonly unknown[]>;
  readonly tally: RecordTally;
  /**
   * 捨てた Record ごとの診断（到着順）。**溜めてから出す**——分類の内側で `console.log` を呼べば、観測点が
   * 解釈の途中に作用を持ち込むことになる（観測は観測点であって作用点ではない）。出力の地点は 1 つに保つ。
   */
  readonly diagnostics: readonly IngressDiagnostic[];
}

/**
 * contractViolationStoreCode — 隔離のキーに要る Store_Code を検証前の生値から読む。
 *
 * 契約違反の Record は `ArrivalRecord` を構築できないため（`arrival_timestamp_ms` が型を満たさない Record が
 * 実在する）、検証済みの Record を畳む `groupByStoreCode` を通せない。ゆえに宛先の値だけをここで読む
 * ——読み出しの規則は `readDeclaredText`（申告値の唯一の関門）に委ね、可否の規則を二箇所に置かない。
 *
 * **Store_Code を読めない契約違反は隔離せず、数えて破棄する。** キーが `contract-violation:{storeCode}` である
 * 以上、宛先の値を読めない Record には置き場が無い。宛先不明用の別キーへ落とせば、失効と件数上限の単位が
 * Store_Code でなくなり（上限 2000 の根拠は 1 店舗 2 時間分の到着量である）、全店の異常が 1 箇所へ集まって
 * 上限が意味を失う。隔離は再生されない証跡ゆえ、破棄で待ち行列から失われるものは無く、上流のバグは
 * `upstreamContractViolation` の件数と診断ログの `sequence_number`（`store-code-unreadable`）で気づける。
 */
function contractViolationStoreCode(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = (raw as Record<string, unknown>).payload;
  if (typeof payload !== "object" || payload === null) return null;
  return readDeclaredText((payload as Record<string, unknown>).store_id);
}

/**
 * classifyRecords — Arrival_Batch の各要素を分類し、宛先へ届ける Record 列と件数に分ける。
 *
 * 分類そのものは純粋関数 `toRecordOutcome` に閉じており（AC 1.8）、ここが持つのは結末ごとの分岐だけで
 * ある。Record 間に原子性は無いため、1 件の異常でバッチを落とさず飛ばして数えて進む（AC 9.2・9.5）。
 */
function classifyRecords(records: readonly unknown[], now: number): ClassifiedRecords {
  const deliverable: ArrivalRecord[] = [];
  const violations = new Map<string, unknown[]>();
  const diagnostics: IngressDiagnostic[] = [];
  const tally = emptyTally();
  for (const raw of records) {
    const outcome = toRecordOutcome(raw, now);
    switch (outcome.kind) {
      case "order":
        deliverable.push(outcome.record);
        break;
      case "status":
        // 意図的な破棄先（blackhole）。届いていること自体は件数で観測できる形に保つ（AC 7.5・7.6）。
        tally.statusDiscarded += 1;
        break;
      case "unknown-path":
        tally.unknownPath += 1;
        break;
      case "poison":
        // 診断は seq と理由の 2 項目のみ（AC 9.3）。ペイロード本体はログへ出さない——毒の事由は構造の欠落
        // であり、中身を出しても直す手がかりにならない一方、個票の内容がログに残り続ける。
        tally.poisonRecord += 1;
        diagnostics.push(diagnose(outcome.reason, outcome.sequenceNumber));
        break;
      case "contract-violation": {
        // 起こらないはずの事象として件数を残す（AC 8.9）。件数が 0 でないことが上流の修正を促す契機になる。
        tally.upstreamContractViolation += 1;
        // 隔離（`contract-violation:{storeCode}` へ 2 時間・**再生しない**・AC 8.8・8.11）。生値のまま運ぶ
        // ——起点を推測で埋めない（受理時刻も `payload.datetime` も代替の起点に用いない・AC 8.10）。
        const storeCode = contractViolationStoreCode(outcome.raw);
        if (storeCode === null) {
          // 置き場が無いゆえ破棄する（`contractViolationStoreCode` の注記）。証跡が隔離に残らないこの 1 経路
          // だけは診断で seq を残す——さもなければ上流のバグが件数以外に何も手がかりを残さない。
          diagnostics.push(diagnose("store-code-unreadable", outcome.sequenceNumber));
          break;
        }
        const arrived = violations.get(storeCode);
        if (arrived === undefined) {
          violations.set(storeCode, [outcome.raw]);
        } else {
          arrived.push(outcome.raw);
        }
        break;
      }
    }
  }
  return { deliverable, violations, tally, diagnostics };
}

// seq を読めない Record が実在するため、`exactOptionalPropertyTypes` の下ではフィールドを省く形が要る
// （`sequenceNumber: undefined` は「値が無い」ではなく「undefined という値がある」ことになる）。
function diagnose(reason: DiscardReason, sequenceNumber: string | undefined): IngressDiagnostic {
  return sequenceNumber === undefined ? { reason } : { reason, sequenceNumber };
}

/**
 * logPosIngress — 1 リクエスト分の観測を出す。**構造化 `console.log` ただ一つで、新しい binding を持たない**
 * （AC 12.13・12.14。`wrangler.jsonc` の `observability.enabled` により Workers Logs へ入る）。
 *
 * **既存の Instrumentation_Log（`src/observe/log.ts` の `buildSeamEntry`）とは別の経路である。** あちらは
 * `OBSERVE_DEBUG` ゲートの既定 OFF で 4 継ぎ目に閉じた計装であり、常時数えるカウンタには向かない。
 * Operation_History にも載せない——あちらの出力対象は Timer 状態の確定差分であって取り込みの件数ではない。
 * ゆえに `posIngress` を行の判別子に持つ独立の形とし、既存 2 系統の codec を共有しない。
 *
 * **カウンタは 1 リクエストにつき 1 行、診断は捨てた Record ごとに 1 行。** 同じ行に畳まないのは 2 つの理由に
 * よる——毒が複数あれば診断は複数件になり、1 行へ詰めれば行の長さが件数に比例して伸びて上限で切られる
 * （観測が黙って落ちる）。かつ AC 9.3 は Record ごとに 1 行を求めている。カウンタ行を最後に出すのは、
 * それがそのリクエストの締めであり、診断の後に読める形にするためである。
 *
 * カウンタは 0 でも省かない。欠けたキーは「起きなかった」と「数えていない」の区別を失う——形が毎行同じ
 * であることが、上流の数と突き合わせられる形そのものである。
 */
function logPosIngress(tally: RecordTally, diagnostics: readonly IngressDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    console.log(JSON.stringify({ posIngress: "diagnostic", ...diagnostic }));
  }
  console.log(JSON.stringify({ posIngress: "counts", ...tally }));
}

/**
 * StoreDelivery — 1 店舗への委譲の結末。
 *
 * `unresolved` は Code_Index に宛先が無いことで、DO へは一切到達していない（`ReceiveOutcome` の 4 種は
 * いずれも DO に届いた上での結末である）。両者を同じ和型で扱うのは、呼び出し元がバッチ全体の応答を
 * 決めるときに見る対象が「この店舗分が確定したか」という一つの問いだからである。
 */
type StoreDelivery = ReceiveOutcome | { readonly kind: "unresolved" };

/**
 * resolveStoreId — Store_Code から宛先 StoreId を引く（Code_Memo → `resolveStoreCode`）。
 *
 * memo に在れば StoreRegistryDO へ照会しない（AC 4.2）。既知の結果だけを memo へ載せ、未知は載せない
 * （AC 4.1・4.4）。Store_Code を DO 名に用いず、返った StoreId のみを `idFromName` へ渡す（AC 2.8）。
 */
async function resolveStoreId(env: Env, storeCode: string): Promise<StoreId | undefined> {
  const memoized = resolvedStoreIds.get(storeCode);
  if (memoized !== undefined) {
    return memoized;
  }
  // シングルトンゆえ locationHint 非対応の getByName で一意に addressing する（/admin/*・/entry/* と同型）。
  const stub = env.STORE_REGISTRY_DO.getByName(REGISTRY_NAME);
  const storeId = await stub.resolveStoreCode(storeCode);
  if (storeId !== undefined) {
    resolvedStoreIds.set(storeCode, storeId);
  }
  return storeId;
}

/**
 * deliverRecords — 1 店舗分の Record 群を宛先 StoreTimerDO へまとめて委譲する（AC 5.2）。
 *
 * **委譲は RPC（`receiveRecords`）で行い、Request を転送しない。** 結末が 4 種に分かれ（確定・投影未達・
 * 非活性・put 失敗）、呼び出し元がそれで挙動を分ける必要があるため、HTTP ステータスでは分類を運べない。
 * 副産物として、クライアント由来の内部 identity ヘッダ（IDENTITY_HEADER）が宛先 DO へ運ばれる経路が
 * そもそも生じない（AC 1.9・後述の注記）。
 *
 * スタブは既存経路と同じ `idFromName` → `get({ locationHint: "apac-ne" })` の二段で引く（AC 1.10）。
 */
async function deliverRecords(
  env: Env,
  storeCode: string,
  records: readonly ArrivalRecord[],
): Promise<StoreDelivery> {
  const storeId = await resolveStoreId(env, storeCode);
  if (storeId === undefined) {
    return { kind: "unresolved" };
  }
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  const stub = env.STORE_TIMER_DO.get(id, { locationHint: "apac-ne" });
  // 到着順は groupByStoreCode が保った並びのまま渡す（同一 Store_Code 内は直列・AC 5.3）。
  return stub.receiveRecords(records);
}

// 認可の純粋ロジック（isAdminAuthorized / timingSafeEqual）は src/worker-auth.ts へ隔離した。
// Worker エントリは cloudflare:workers を DO の re-export 経由で引き込むため、既定 pool での純粋な
// property 検証（Property 21）が DO ランタイムに阻まれないよう、判定ロジックを端に寄せる（構造の主権）。

// Access JWT 検証（jose・Cloudflare 前提 4 / 要件8.5・8.6）。ACCESS_REQUIRED が ON のときのみ経路に入る。
// JWKS のエンドポイント（Access が公開する署名鍵）。TEAM_DOMAIN 配下の固定パス。
const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";

// createRemoteJWKSet は内部に署名鍵のキャッシュを持つ。跨リクエストで再利用するためモジュールスコープに保持する
// （毎リクエストで新規生成すると鍵取得が走りキャッシュが効かない）。env は module load 時には手に入らないため、
// TEAM_DOMAIN をキーに遅延生成・メモ化する（team が変われば張り直す）。
let cachedJwks: { readonly teamDomain: string; readonly jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

function accessJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  if (cachedJwks?.teamDomain !== teamDomain) {
    cachedJwks = { teamDomain, jwks: createRemoteJWKSet(new URL(`${teamDomain}${ACCESS_CERTS_PATH}`)) };
  }
  return cachedJwks.jwks;
}

// 正準 identity クレームの選定は設計時確定事項（要件9.5・[Q7] の申し送り）。IdP 固有差を Access が JWT に
// 正規化して載せるため、人間可読で Roster の運用単位に一致する email を正準クレームとし、email を持たない
// サービス／端末アカウントは sub にフォールバックする。いずれも空・非文字列なら identity 不成立（null）。
function canonicalIdentity(payload: JWTPayload): Identity | null {
  const email = payload.email;
  if (typeof email === "string" && email.length > 0) {
    return email;
  }
  if (typeof payload.sub === "string" && payload.sub.length > 0) {
    return payload.sub;
  }
  return null;
}

/**
 * verifyAccessIdentity — `Cf-Access-Jwt-Assertion` を JWKS 署名検証し、正準 identity を返す（要件8.5 / 8.6）。
 *
 * ACCESS_REQUIRED が ON の経路でのみ呼ばれる。ヘッダ欠如・署名/issuer/audience/期限のいずれかの検証失敗・
 * 正準クレーム欠落はすべて null を返し、呼び出し元が 403 に落とす。未検証ヘッダを信用しないことが、
 * Worker 直叩きによる Access バイパスへの防御そのものである（真実は署名検証を通した identity のみ）。
 */
export async function verifyAccessIdentity(request: Request, env: Env): Promise<Identity | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return null;
  }
  const teamDomain = env.TEAM_DOMAIN;
  try {
    const { payload } = await jwtVerify(token, accessJwks(teamDomain), {
      issuer: teamDomain,
      audience: env.POLICY_AUD,
    });
    return canonicalIdentity(payload);
  } catch {
    // 署名・issuer・audience・期限のいずれかが不正 → 未検証として扱う（呼び出し元が 403）
    return null;
  }
}

// Entry の行き先解決（EntryDestination / resolveEntryDestination）は cloudflare:workers・jose に依存しない
// 純粋ロジックゆえ src/worker-entry.ts へ隔離した（既定 pool での Property 18 検証を DO ランタイムに阻ませない）。
// 既存の公開シンボルとの互換のため、ここから re-export する（worker.ts が唯一の公開面である契約を保つ）。
export { type EntryDestination, resolveEntryDestination };

/**
 * Worker 本体 — 極薄のエントリポイント。
 *
 * 宛先は URL パスで運ぶ（要件1.1）。店舗宛先 `/s/{storeId}/ws`（WebSocket）と `/s/{storeId}/`（画面・SPA）を
 * 対象店舗の DO へ委譲し、運用の Provisioning_API（`/admin/*`）は認可の上でシングルトンのレジストリへ素通しする。
 * それ以外は Entry（`/`）を含め Static Assets（React SPA）に委ねる（wrangler.jsonc の assets 設定）。
 * 設定投入は Provisioning_API → StoreRegistryDO → StoreTimerDO.applyProjection の一本に集約する（要件2.8）。
 * 配置を APAC（日本向けは apac-ne）へ寄せるため、名前引きは idFromName → get で行う。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 店舗宛先（新経路・要件1.1）: /s/{storeId}/ws（WS）。storeId 検証をルーティングの前段に置き、
    // 不正・導出不能は 400 で DO へ到達させない（DEFAULT_STORE_ID へ落とさない・要件1.2）。
    const wsMatch = STORE_WS_PATTERN.exec(url.pathname);
    if (wsMatch) {
      const storeId = wsMatch[1] ?? "";
      if (!isValidStoreId(storeId)) {
        return new Response("Invalid storeId", { status: 400 });
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      // 内部 identity ヘッダの偽装防御（要件8.6）: 店舗 DO へ検証済み identity を運ぶ内部ヘッダ
      // （IDENTITY_HEADER）は、クライアントが Worker へ直接送って Roster 認可を迂回しうる攻撃面である。
      // ゆえに転送前に「無条件で」除去する（ON / OFF のいずれでも・クライアント由来の同名ヘッダを決して透過しない）。
      // 除去後に Worker だけが、ON かつ署名検証成功時に限り、検証済み identity で付け直す（真実は署名を通した値のみ）。
      const forwarded = new Headers(request.headers);
      forwarded.delete(IDENTITY_HEADER);
      // Access バイパス防御（要件8.5 / 8.6）: ACCESS_REQUIRED が ON のときのみ Cf-Access-Jwt-Assertion を
      // JWKS 署名検証し、未検証（ヘッダ欠如・署名/issuer/audience 不正）は 403 で DO へ到達させない。
      // OFF（既定 "0"）は合鍵 URL のみで接続でき、この経路では identity を付与しない（DO 側 Roster ゲートは走らない）。
      if ((env.ACCESS_REQUIRED as string) === "1") {
        const identity = await verifyAccessIdentity(request, env);
        if (identity === null) {
          return new Response("Forbidden", { status: 403 });
        }
        // 検証済み identity のみを内部ヘッダへ載せ直す（この経路が唯一の付与元）。
        forwarded.set(IDENTITY_HEADER, identity);
      }
      // ヘッダは Request のままでは書き換えられないため、除去／付与済みヘッダで新しい Request を構成する。
      // `new Request(request, { headers })` は method / body を引き継ぎ、Upgrade ヘッダも保つため WS 昇格として有効なまま。
      const forwardedRequest = new Request(request, { headers: forwarded });
      // 名前から DO の ID を引き、locationHint で APAC 北東（日本向け）へ配置を寄せる（要件1.4）。
      // getByName は locationHint を受け取れないため idFromName → get の二段で引く。
      const id = env.STORE_TIMER_DO.idFromName(storeId);
      const stub = env.STORE_TIMER_DO.get(id, { locationHint: "apac-ne" });
      return stub.fetch(forwardedRequest);
    }

    // Order_Ingress（POST /s/{storeId}/orders・online-cook-scheduling AC 1.1）。POS からのオーダー到着・
    // キャンセルを受ける。Worker は認可（ORDER_INGRESS_TOKEN の定数時間照合）だけを担い、ボディの解釈・
    // 検証・400 応答は店舗 DO の receiveOrder に閉じる（Worker 極薄・/admin/* と同じ置き方）。
    // 鍵は ADMIN_TOKEN とは別の secret である——POS へ運用系の書き込み口（Provisioning_API）を開かない。
    // 不一致・欠如は 401 で DO へ到達させず、状態を一切変更しない。
    const ordersMatch = STORE_ORDERS_PATTERN.exec(url.pathname);
    if (ordersMatch) {
      if (!isOrderIngressAuthorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.method !== "POST") {
        return new Response("Expected POST", { status: 405 });
      }
      const storeId = ordersMatch[1] ?? "";
      if (!isValidStoreId(storeId)) {
        return new Response("Invalid storeId", { status: 400 });
      }
      // 内部 identity ヘッダは、この経路でも無条件で除去する（per-store-provisioning 要件8.6）。
      // POS は identity を運ばないため付け直しもしない。「クライアント由来の同名ヘッダを決して透過しない」は
      // 経路ごとの例外を作らないことで守られる不変であり、店舗 DO へ委譲するすべての経路がこれに従う。
      const forwarded = new Headers(request.headers);
      forwarded.delete(IDENTITY_HEADER);
      // WS 経路と同じく idFromName → get（locationHint）で APAC 北東へ配置を寄せる。
      const id = env.STORE_TIMER_DO.idFromName(storeId);
      const stub = env.STORE_TIMER_DO.get(id, { locationHint: "apac-ne" });
      return stub.fetch(new Request(request, { headers: forwarded }));
    }

    // POS_Ingress（POST /pos/records・pos-order-ingress 要件1）。宛先をボディから解決する取り込み経路。
    // Worker が担うのは 4 つだけである（AC 1.7）——認可・宛先解決・宛先 DO への委譲・宛先未解決の保留。
    // ボディの解釈は `src/ingress/` の純粋関数へ委ね、Worker 自身に持たせない（AC 1.8）。
    if (url.pathname === POS_RECORDS_PATH) {
      // 認可鍵は ORDER_INGRESS_TOKEN のみ（ADMIN_TOKEN は用いない・AC 1.6）。未設定（空）は不許可で
      // （AC 1.4）、失敗は 401 で StoreRegistryDO・StoreTimerDO のいずれへも到達させない（AC 1.5）。
      if (!isOrderIngressAuthorized(request, env)) {
        // 捨てていることが誰にも見えない状態は許容しない（AC 9.12）。**観測は Worker 内で完結する**
        // ——カウンタも診断も DO を起こさずに出す（起こせば認可失敗が状態の入口を叩く経路になる）。
        const tally = emptyTally();
        tally.unauthorized = 1;
        logPosIngress(tally, [{ reason: "unauthorized" }]);
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.method !== "POST") {
        return new Response("Expected POST", { status: 405 });
      }
      // 内部 identity ヘッダについて（AC 1.9）: 本経路は Request を転送せず RPC（receiveRecords）で委譲する
      // ため、クライアント由来の同名ヘッダが宛先 DO へ運ばれる経路がそもそも存在しない。既存の 2 経路が
      // 転送前に delete するのと同じ不変を、こちらは委譲の形そのもので満たす（経路ごとの例外ではない）。
      const body = await request.json().catch(() => null);
      // null を返すのはボディが records 配列を成さないときだけである（AC 1.11）。個々の Record の異常で
      // バッチを落とさない——Record 間に原子性は無い。
      const batch = toArrivalBatch(body);
      if (batch === null) {
        return new Response("Invalid body", { status: 400 });
      }
      // 上限超過は一時的失敗として何も確定させない（AC 1.13）。上流の bisect が分割して再送する。
      if (batch.records.length > POS_RECORDS_LIMIT) {
        return new Response("Too many records", { status: 503 });
      }
      // 時計を読むのはここだけで、窓の検査には引数として渡す（純粋関数に時計を持ち込まない規律）。
      const classified = classifyRecords(batch.records, Date.now());
      const groups = groupByStoreCode(classified.deliverable);
      // unreadableStoreCode は空である（Unique_Key を導けた Record は store_id を読み出せる——両者は
      // 同一の関門を通る）。それでも数に足すのは、この含意が将来崩れたときに黙って消えないためである。
      classified.tally.poisonRecord += groups.unreadableStoreCode.length;
      // 異なる Store_Code へは並列に委譲してよい（Store_Code 間の順序は上流も保証しない・AC 5.4）。
      // 同一 Store_Code は Map の 1 要素ゆえ 1 回の委譲に畳まれ、宛先の照会も 1 回で済む（AC 4.7・5.2）。
      const delivered = await Promise.all(
        [...groups.byStoreCode].map(async ([storeCode, records]) => ({
          storeCode,
          records,
          delivery: await deliverRecords(env, storeCode, records),
        })),
      );
      // 宛先店舗数に比例する処理の継続機構は持たない（残作業＋Alarm 継続を本経路に持ち込まない・AC 5.9）。
      // 未完了は一時的失敗として上流の再送に委ねる。
      let transient = false;
      const unrouted: { readonly storeCode: string; readonly records: readonly ArrivalRecord[] }[] = [];
      for (const { storeCode, records, delivery } of delivered) {
        switch (delivery.kind) {
          case "settled":
            // DO の内側でしか判らない 2 件を拾い、リクエストの 1 行へ合算する（AC 12.15）。
            tallyReceiveCounts(classified.tally, delivery.counts);
            break;
          case "deactivated":
            // 恒久的失敗（再活性化は運用の判断であり 2 時間の窓に収まらない）ゆえ飛ばして数える。
            classified.tally.deactivatedStore += records.length;
            break;
          case "unresolved":
            // 宛先未解決は捨てず保留する（AC 11.1・11.2）。4xx を返せば上流はアラームの無いカウンタを
            // 加算して Record を捨て、5xx を返せば同一バッチの他店舗も止まる。ゆえに第三の道を採る。
            unrouted.push({ storeCode, records });
            break;
          case "unprovisioned":
          case "persist-failed":
            // いずれも一時的失敗ゆえ Arrival_Batch 全体を 5xx にする（AC 5.8・Duplicate_Bias）。既に確定した
            // 他店舗の分は残り、再送時の重複は下流の冪等が吸収する。`unprovisioned` を飛ばして数えれば、
            // 店舗開設の瞬間に届いた注文が消える。
            transient = true;
            break;
        }
      }
      // 保留と隔離。**いずれも `put` 成功で確定してから受理を応答する**（Property 10・AC 11.3・11.4・8.11）。
      // 保持できていないものを受理と主張しないため、応答を組む前にここを待ち切る。書き込み先は Store_Code
      // ごとに 1 つのキーゆえ、並列でも同じキーの取り合いにならない。
      if (unrouted.length > 0 || classified.violations.size > 0) {
        const registry = env.STORE_REGISTRY_DO.getByName(REGISTRY_NAME);
        const [held, quarantined] = await Promise.all([
          Promise.all(
            unrouted.map(async ({ storeCode, records }) => ({
              count: records.length,
              outcome: await registry.holdUnrouted(storeCode, records),
            })),
          ),
          Promise.all(
            [...classified.violations].map(([storeCode, raws]) =>
              registry.quarantineContractViolations(storeCode, raws),
            ),
          ),
        ]);
        for (const { count, outcome } of held) {
          if (outcome.kind === "persist-failed") {
            transient = true;
            continue;
          }
          if (outcome.kind === "replay-deferred") {
            // 保留は確定している（ゆえに件数は数える）が、既知コードの再生が完了しなかった。一時的失敗として
            // 応答し上流の再送に委ねる（design §8-b）——レジストリの残作業と Alarm も回収を続けるため、
            // どちらか一方が働けば届く。再送が生む保留の重複は宛先 DO の単調性が吸収する。
            transient = true;
          }
          classified.tally.unknownStorePending += count;
          tallyHeldDiscards(classified.tally, outcome.counts);
        }
        for (const outcome of quarantined) {
          if (outcome.kind === "persist-failed") {
            transient = true;
            continue;
          }
          tallyHeldDiscards(classified.tally, outcome.counts);
        }
      }
      // 出力はここ 1 箇所で、応答の分岐より前に置く。分岐の内側へ入れれば行が 2 通りになり、「1 リクエスト
      // につき 1 行」が応答の種類に依存する（一時的失敗のリクエストだけ観測が欠ける形を作らない）。
      logPosIngress(classified.tally, classified.diagnostics);
      if (transient) {
        return new Response("Retry", { status: 503 });
      }
      return Response.json({ accepted: true });
    }

    // 店舗宛先（新経路・要件1.1 / 1.3）: /s/{storeId}/（画面・SPA）。storeId を検証し、不正は 400。
    // 正当な storeId は静的アセット（React SPA）へフォールバックし、SPA が URL から storeId を読む。
    const screenMatch = STORE_SCREEN_PATTERN.exec(url.pathname);
    if (screenMatch) {
      const storeId = screenMatch[1] ?? "";
      if (!isValidStoreId(storeId)) {
        return new Response("Invalid storeId", { status: 400 });
      }
      return env.ASSETS.fetch(request);
    }

    // Provisioning_API（新経路・要件2.8 / 2.9 / 8.1〜8.4）: チェーン・Policy・店舗イデアの外部投入と読み出し。
    //   PUT /admin/chains/{id}・PUT /admin/policies/{id}・POST /admin/stores・PUT /admin/stores/{id}・GET /admin/*
    // Worker は認可（ADMIN_TOKEN の定数時間比較）のみを担い、許可した Request をシングルトンのレジストリへ
    // 素通し委譲する（Worker 極薄）。ルート解釈・JSON パース・拒否型 400 応答はレジストリ fetch に閉じる。
    // 未設定（空）・不一致は 401 でレジストリへ到達させない（書き込み口を広く晒さない・要件8.2 / 8.3）。
    // 設定投入経路は Provisioning_API → StoreRegistryDO → StoreTimerDO の一本（要件2.8）。旧 /admin/config の
    // 直接委譲は撤去済みで、未定義のルートはレジストリ fetch が 404 を返す（レジストリが唯一の解釈者）。
    if (url.pathname.startsWith("/admin/")) {
      if (!isAdminAuthorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      // シングルトンゆえ locationHint 非対応の getByName で一意に addressing する（magic string は使わない）。
      const stub = env.STORE_REGISTRY_DO.getByName(REGISTRY_NAME);
      return stub.fetch(request);
    }

    // 店舗切替リストの受け渡し（GET /entry/stores・要件7.4）。複数店舗担当（SV・本部）向けの切替 UI が
    // SPA から取得する。302（Entry のリダイレクト）はボディを運べないため、切替の選択肢はこの JSON 経路で渡す。
    // Access ON のときだけ JWT 検証 → 逆引きで identity の接続可能店舗を (storeId, name)[] で返す（低頻度・
    // ホットパス分離・要件7.7）。OFF（既定 "0"）は Entry の行き先解決を提供しない（要件7.8）ため、切替リストも
    // 供さず 404 を返す（Entry `/` の OFF 挙動と揃える）。表示は name を使う——storeId はスラッグゆえ（要件7.4）。
    if (url.pathname === "/entry/stores") {
      if ((env.ACCESS_REQUIRED as string) !== "1") {
        return new Response("Not found", { status: 404 });
      }
      const identity = await verifyAccessIdentity(request, env);
      if (identity === null) {
        // 未検証（ヘッダ欠如・署名/issuer/audience 不正）は 403（要件8.6・Access バイパス防御）。
        return new Response("Forbidden", { status: 403 });
      }
      // レジストリの逆引き（保持済みインデックスの単一読み出し・低頻度・要件7.4 / 7.7）。
      const stub = env.STORE_REGISTRY_DO.getByName(REGISTRY_NAME);
      const choices = await stub.storeChoicesForIdentity(identity);
      return Response.json(choices);
    }

    // 認証を経て店舗画面へ戻る通し口（GET /entry/signin/{storeId}・signin-required-misreported-as-offline
    // 要件4.5 / 4.6）。Access セッションが切れた端末が Sign_In_Affordance から向かう先である。未認証なら
    // Access がここへの遷移に 302 を返してログインへ運び、認証後は redirect_url でこのパスへ戻る。
    // ゆえに戻り先が生 JSON にならず（`/entry/stores` を遷移先にできない理由）、かつ storeId をパスで運ぶ
    // ため identity からの逆引きに委ねずに現場の居る店舗へ戻れる。
    // ACCESS_REQUIRED を見ない——OFF でも 302 するだけで無害であり、フラグで分岐させる理由がない。
    if (url.pathname.startsWith(SIGNIN_ENTRY_PATH)) {
      const storeId = url.pathname.slice(SIGNIN_ENTRY_PATH.length);
      if (!isValidStoreId(storeId)) {
        return new Response("Invalid storeId", { status: 400 });
      }
      return Response.redirect(new URL(`/s/${storeId}/`, url), 302);
    }

    // Entry（共通 URL `/`・要件7.1〜7.5）。PWA の start_url はこの 1 個に固定する（配布単位は店舗数に依存しない）。
    // ACCESS_REQUIRED が ON のときのみ、認証済み identity の行き先を逆引きで解決してリダイレクトする（要件7.2）。
    // OFF（既定 "0"）は Entry の行き先解決を提供せず、SPA へフォールバックする（前回使用店のクライアント側直行に
    // 委ねる・要件7.8。タスク 6.6）。逆引き RPC は Entry（起動時・低頻度）に限り、WS 経路（高頻度）では呼ばない
    // （ホットパス分離・要件7.7）。
    if (url.pathname === "/" && (env.ACCESS_REQUIRED as string) === "1") {
      const identity = await verifyAccessIdentity(request, env);
      if (identity === null) {
        // 未検証（ヘッダ欠如・署名/issuer/audience 不正）は 403（要件8.6・Access バイパス防御）。
        return new Response("Forbidden", { status: 403 });
      }
      // レジストリの逆引き（保持済みインデックスの単一読み出し・低頻度・要件7.2 / 7.7）。
      const stub = env.STORE_REGISTRY_DO.getByName(REGISTRY_NAME);
      const stores = await stub.storesForIdentity(identity);
      const destination = resolveEntryDestination(stores);
      if (destination.kind === "none") {
        // 0 店舗 → 接続先なし。いかなる店舗へもフォールバックしない（要件7.5）。
        return new Response("No store", { status: 404 });
      }
      // 1 店舗・複数店舗（既定店＝登録順の先頭）いずれも当該 Store_Path へリダイレクトする（要件7.3 / 7.4）。
      return Response.redirect(new URL(`/s/${destination.storeId}/`, url), 302);
    }

    // 静的アセット（React SPA）へフォールバック
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
