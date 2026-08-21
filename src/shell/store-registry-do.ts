import { DurableObject } from "cloudflare:workers";
import type { Chain, ChainId, Identity, Policy, PolicyFields, PolicyId, Roster, Store, StoreId, StoreOverride } from "../registry/ideal";
import { isValidStoreId, mintStoreId } from "../registry/slug";
import { affectedStores, nextResidual, recomposeProjection, type IdealChange } from "../registry/converge";
import { buildReverseIndex, storesForIdentity, type ReverseIndex } from "../registry/reverse-index";
import {
  buildCodeIndex,
  detectDuplicateStoreCodes,
  storeForCode,
  type CodeIndex,
  type DuplicateStoreCode,
} from "../registry/code-index";
import { validateProvisioningInput, type Rejection } from "../registry/validate";
import { detectAmbiguousAssignment, type AmbiguousPolicyConflict } from "../registry/policy-conflict";
import { isHeldReplayable, retainHeld, type HeldRecord } from "../registry/held-record";
import type { ArrivalRecord } from "../ingress/batch";
import { isNewerSequence } from "../engine/state";
import type { ReceiveOutcome } from "./store-timer-do";
import { isNonEmpty, type NonEmptyArray } from "../domain/timer";

// store-registry-do.ts — StoreRegistryDO（シングルトン・作用の端）。
//
// チェーン・Policy・店舗・名簿という「望ましい設定の正本（イデア）」を永続し、その変更を影響店舗の
// StoreTimerDO へ収束させる作用を担う。純粋計算（合成・逆引き・収束の残作業計算）は src/registry/ へ
// 委譲し、本クラスは put・RPC 押し込み・Alarm 継続という作用だけを端で実行する（計算と作用の分離）。
//
// ストレージは SQLite バックエンド（new_sqlite_classes）＋非同期 KV API のみで扱う（ctx.storage.sql は
// 使わない・要件9 / tooling）。イデア（正本）・導出値・収束台帳を別キー群に持ち、その名前空間は下記の
// キーヘルパに集約する（キー書式の唯一の出所）。
//
// スコープ：本ファイルは骨格（タスク 3.1）。チェーン／店舗 CRUD（3.2）・fan-out RPC と Alarm 継続（3.3）・
// GET 読み出し（3.4）は後続タスクが commitIdeal（put-first）を起点に配線する。

// ── 永続キーの名前空間（キー書式の SSOT・要件9 / Data Models「レジストリの永続モデル」）──
//
// 店舗 DO の SNAPSHOT_KEY 等と同様、キー書式は一箇所に集約して唯一の出所とする。Worker のシングルトン
// addressing（getByName(REGISTRY_NAME)・タスク 5.2）と、put-first / revision の統合・property テスト
// （storage をキーで検査する）が magic string を複製せず本モジュールを参照できるよう export する。

/** シングルトンの固定名（idFromName / getByName の引数）。自身の名は ctx.id.name から読む（Cloudflare 前提2）。 */
export const REGISTRY_NAME = "registry";

/** 逆引きインデックス（identity → 接続可能店舗）。名簿書き込み時に再導出する導出値（要件3.6）。 */
export const REVERSE_INDEX_KEY = "index:reverse";

/** 外部店舗コード → storeId の突き合わせ補助（導出値）。 */
export const CODE_INDEX_KEY = "index:code";

/** レジストリ全体の狭義単調 revision。イデアの全書き込みで +1 し、投影 version・収束台帳の基準にする（要件5.6）。 */
export const REVISION_KEY = "meta:revision";

/** 収束の残作業（未完了店舗の storeId 列）。Alarm 継続の対象（要件5.8）。 */
export const RESIDUAL_KEY = "converge:residual";

/**
 * 再生の残作業（再生を持ち越した Store_Code の列）。Alarm 継続の対象（pos-order-ingress 要件11.9）。
 *
 * **収束の RESIDUAL_KEY に相乗りしない。** あちらが持つのは storeId（採番スラッグ）で、こちらは Store_Code
 * （外部マスタのコード）である——1 本の配列に混ぜれば、どちらの語彙の値かを型が語らなくなり、読み出した側が
 * 推測で振り分けることになる。進め方も違う（収束は nextResidual で 1 店ずつ畳み、再生は当該コードの保留が
 * 空になるまで繰り返す）。ゆえにキーを分け、**1 本しかない Alarm での多重化はハンドラ側で行う**（`alarm()` が
 * 両方の残作業を見る・design §9-a）。
 */
export const REPLAY_RESIDUAL_KEY = "replay:residual";

/** チェーン（イデアの正本）のキー。 */
export function chainKey(chainId: ChainId): string {
  return `chain:${chainId}`;
}

/** 店舗（イデアの正本）のキー。storeId はグローバル一意ゆえチェーン名前空間に埋め込まない（要件3.8）。 */
export function storeKey(storeId: StoreId): string {
  return `store:${storeId}`;
}

/** Policy（イデアの正本）のキー。loadIdeal の policy: prefix 走査と同一名前空間（キー書式の SSOT）。 */
export function policyKey(policyId: PolicyId): string {
  return `policy:${policyId}`;
}

/** 収束台帳：当該店舗が受領した投影の revision（要件5.9）。 */
export function convergedVersionKey(storeId: StoreId): string {
  return `converge:version:${storeId}`;
}

/**
 * 宛先未解決の Record の保留（pos-order-ingress 要件11.1・2 時間・**再生される**）。
 *
 * キーが Store_Code ごとに分かれるのは、再生の契機が当該 Store_Code の店舗登録の確定であり、失効と件数
 * 上限の単位も 1 Store_Code だからである（AC 11.23）。1 本に畳めば、1 店舗の登録漏れが全店の上限を食う。
 */
export function unroutedKey(storeCode: string): string {
  return `unrouted:${storeCode}`;
}

/**
 * 上流の契約違反の隔離（pos-order-ingress 要件8.8〜8.11・2 時間・**再生されない**）。
 *
 * `unroutedKey` と別のキーに置く（design §9-b）。混ぜてはならない——あちらの再生の契機は「店舗登録の確定」
 * であり、Store_Code が既知の Record にはその契機が永遠に来ない。かつ窓の外にある時刻の注文を待ち行列へ
 * 入れれば並び順を壊す（Order_Arrival_Time が並びの基準ゆえ）。保持の意味は上流のバグを調べる証跡である。
 */
export function contractViolationKey(storeCode: string): string {
  return `contract-violation:${storeCode}`;
}

// ── storeId 採番のパラメータ（要件2.2）──

/**
 * 採番に用いる乱数バイト数。128 ビットは base32 で ~26 文字となり推測困難かつ長さ上限（64）に収まる。
 * 乱数採取（crypto.getRandomValues）は shell が担い、mintStoreId はバイト列→slug の純粋符号化に留まる（前提）。
 */
const MINT_RANDOM_BYTES = 16;

/**
 * 未使用な storeId を引き当てるまでの採番試行の上限。衝突は 128 ビット空間ゆえ実質起こらないが、
 * 万一連続衝突したら前提違反として throw する（黙って別 ID へ流さない — 呼び出し元の意図を偽らない）。
 */
const MAX_MINT_ATTEMPTS = 8;

// ── 収束の実行時間境界と Alarm 継続のパラメータ（要件5.5 / 5.8・Cloudflare 前提3）──

/**
 * 1 回の converge / alarm 実行で押し込む店舗数の上限。DO の実行時間制限に対する素朴な境界を、
 * wall-clock ではなく件数で刻む（直列 RPC 1 件あたりのコストが概ね一定で、決定的かつテスト可能ゆえ）。
 * 上限に達したら残りを RESIDUAL_KEY に残して Alarm 継続へ委ねる。100 店規模を数回の Alarm で捌く粒度（要件5.5）。
 */
const CONVERGE_MAX_PUSHES_PER_RUN = 25;

/** 残作業がある間の Alarm 継続の遅延。put / RPC の一時失敗が回復する猶予を置く（作業があるときだけ張る）。 */
const CONVERGE_ALARM_DELAY_MS = 2_000;

/**
 * 再生の残作業がある間の Alarm 継続の遅延（pos-order-ingress 要件11.9）。
 *
 * **収束と同じ値だが同じ定数にしない。** Alarm は 1 本しかないため両者の要求は最小値へ畳まれる（design §9-a）
 * ——畳む側が 2 つの要求を見分けられることが前提であり、1 つの定数を共有すれば「どちらの都合で 2 秒なのか」が
 * 消える。再生が待つ理由は投影の到達（unprovisioned の解消）で、収束が待つ理由は押し込みの再試行である。
 */
const REPLAY_ALARM_DELAY_MS = 2_000;

/** Cloudflare Alarm の自動リトライ上限（公式: 初回2秒・指数バックオフ・最大6回）。StoreTimerDO と同一規律。 */
const ALARM_MAX_RETRIES = 6;

/**
 * retryCount がこの値以上なら throw せず新規 Alarm を張り直す（リトライ枯渇の一歩手前）。
 * 収束本体が durable な進捗を残せず失敗した場合に、自動リトライを使い切る前に継続を予約する（公式推奨）。
 */
const ALARM_REARM_THRESHOLD = ALARM_MAX_RETRIES - 1;

// ── プロビジョニングの結果（HTTP 面はこれを fetch が状態コードへ写す。作用と表現の分離）──

/**
 * ProvisionFailure — 登録／更新の拒否理由。値検証違反（validateProvisioningInput の拒否）と、
 * storeId 固有の拒否（文字集合・長さ違反／使用済み）、対象不在を区別して表明する。
 * HTTP ステータスへの対応付けは fetch が一箇所で行う（validation・storeId 系は 400、not-found は 404）。
 */
type ProvisionFailure =
  | { readonly kind: "validation"; readonly rejections: NonEmptyArray<Rejection> }
  | { readonly kind: "ambiguous-assignment"; readonly conflicts: NonEmptyArray<AmbiguousPolicyConflict> } // 同一 priority・同一フィールドの曖昧割当（要件3.4）
  | { readonly kind: "store-id-invalid"; readonly storeId: string } // 文字集合・長さ違反（要件2.4）
  | { readonly kind: "store-id-in-use"; readonly storeId: string } // 使用済み（要件2.4）
  // Store_Code が他店舗で使用済み（pos-order-ingress 要件3.1 / 3.2）。storeId は既に当該コードを
  // 主張している店舗（衝突の相手）を指す——相手が判れば、付け替え要求の誤りがそのまま読める。
  | { readonly kind: "store-code-in-use"; readonly storeCode: string; readonly storeId: StoreId }
  // 既存の Store_Code と異なる値への付け替え要求（pos-order-ingress 要件3.3 / 3.7）。
  | { readonly kind: "store-code-immutable"; readonly storeId: StoreId; readonly storeCode: string }
  | { readonly kind: "not-found"; readonly storeId: string }; // 更新対象の店舗が存在しない

/** チェーン更新・店舗更新の結果。受理か、拒否（理由付き）か。 */
type ProvisionResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly failure: ProvisionFailure };

/** 店舗登録の結果。受理時は採番済み／明示受理した storeId を返す（要件2.2）。 */
type CreateStoreResult =
  | { readonly accepted: true; readonly storeId: StoreId }
  | { readonly accepted: false; readonly failure: ProvisionFailure };

/** 一括 upsert の要素ごとの失敗（配列内の位置・対象 storeId・拒否理由）。all-or-nothing 応答で列挙する。 */
interface BulkStoreFailure {
  readonly index: number;
  readonly storeId?: string;
  readonly failure: ProvisionFailure;
}

/**
 * 一括 upsert（PUT /admin/stores・配列）の結果。all-or-nothing——1 つでも不正なら failures を全列挙して
 * イデアを一切変更しない（要件2.16 系）。受理時は確定した件数を返す。
 */
type BulkStoresResult =
  | { readonly accepted: true; readonly count: number }
  | { readonly accepted: false; readonly failures: NonEmptyArray<BulkStoreFailure> };

// ── Store_Code の不変性と一意性（pos-order-ingress 要件3・純粋な判定ゆえ端の外に置く）──

/**
 * StoreCodeVerdict — 更新要求が主張する Store_Code の確定結果。受理なら書き込み後の値（不在なら省略）、
 * 拒否なら理由を持つ。値と拒否を同じ返り値で表明し、「拒否されたが値も返る」状態を構築不能にする。
 */
type StoreCodeVerdict =
  | { readonly ok: true; readonly storeCode?: string }
  | { readonly ok: false; readonly failure: ProvisionFailure };

/**
 * storeCodeAfterUpdate — 要求が主張する Store_Code を不変性の規律に照らして確定する（要件3.3 / 3.4 / 3.8）。
 *
 * 判定は 4 つ。省略は主張なしゆえ既存を保つ。既存が未設定なら受理する——storeCode 省略の店舗を許す規律
 * （要件3.8）がある以上、後から POS 連携を始める店舗が実在し、それを新規作成に強いれば StoreId が変わって
 * 既存の画面 URL と WS 接続が切れる。「不変」が守るのは*一度定めた対応が変わらない*ことであり、未設定から
 * 設定への遷移は対応を変えていない。既存と同値なら受理（同一ボディの再送を拒否しない・冪等・要件3.4）。
 * 既存と異なれば store-code-immutable で拒否する（要件3.3）——既存値を優先して変更要求を黙って無視すれば、
 * 呼び出し元の意図を偽る。付け替えは新規店舗の作成として扱う（要件3.7）。
 *
 * createStore / updateStore / resolveBulkElement の 3 経路が同じ 1 つの関数を通る。規則が分かれれば、
 * 単発と一括で同じ要求の可否が分かれる。
 */
function storeCodeAfterUpdate(existing: Store | undefined, claimed: unknown): StoreCodeVerdict {
  if (claimed === undefined) {
    const held = existing?.storeCode;
    return held === undefined ? { ok: true } : { ok: true, storeCode: held };
  }
  if (typeof claimed !== "string" || claimed.length === 0) {
    // 型不一致・空文字を既定（未設定）へ黙って畳まない。畳めば「登録したのに宛先が引けない」店舗が生まれる。
    return {
      ok: false,
      failure: {
        kind: "validation",
        rejections: [{ path: "storeCode", reason: "type-mismatch", detail: "非空の文字列である必要がある" }],
      },
    };
  }
  if (existing === undefined || existing.storeCode === undefined) return { ok: true, storeCode: claimed };
  if (existing.storeCode === claimed) return { ok: true, storeCode: claimed };
  return {
    ok: false,
    failure: { kind: "store-code-immutable", storeId: existing.storeId, storeCode: claimed },
  };
}

/**
 * storeCodeInUseFailure — 検出された衝突の列から、当該店舗の拒否理由を組む（要件3.1 / 3.2）。
 *
 * detectDuplicateStoreCodes（純粋・活性状態で絞らない）が返した衝突のうち、当該 storeId が関与するものを
 * 拒否理由へ写す。関与しなければ undefined——書き込み前から在った他店同士の衝突で、無関係な要求を拒まない。
 * 報告する storeId は衝突の相手（既に当該コードを主張している店舗）とする。
 */
function storeCodeInUseFailure(
  duplicates: readonly DuplicateStoreCode[],
  storeId: StoreId,
): ProvisionFailure | undefined {
  for (const duplicate of duplicates) {
    if (!duplicate.storeIds.includes(storeId)) continue;
    const incumbent = duplicate.storeIds.find((id) => id !== storeId);
    return {
      kind: "store-code-in-use",
      storeCode: duplicate.storeCode,
      // 衝突は 2 件以上の別店舗ゆえ相手は必ず在る。型の全域性のため自身へ畳む（相手なしは表現しない）。
      storeId: incumbent ?? storeId,
    };
  }
  return undefined;
}

/**
 * lastSentSequence — 押し込んだ Record 群の「送り終えた最後の `sequence_number`」（design §8-b の穴 2）。
 *
 * 同一店舗内で `sequence_number` は昇順に届く（AC 10.8）ため末尾の値で足るはずだが、**最大値を畳んで求める**。
 * 保留は再送・失効の刈り取り・件数上限の切り落としを経た列であり、「末尾が最大」は保留の側の事実ではない。
 * 末尾を採って実際の最大より小さければ、送り終えた Record が保留に残って再送され、それは重複で済む。
 * 逆に大きければ未送信が消える——ゆえに畳む方向は最大しかない。
 *
 * 比較は `isNewerSequence`（`engine/state.ts`）を通す。桁数を揃えた文字列比較の規則が二箇所に分かれれば、
 * 桁が繰り上がる瞬間に片方だけが誤る。
 */
function lastSentSequence(sent: NonEmptyArray<ArrivalRecord>): string {
  let last = sent[0].sequenceNumber;
  for (const record of sent) {
    if (isNewerSequence(record.sequenceNumber, last)) last = record.sequenceNumber;
  }
  return last;
}

// ── 保留と隔離の結末（pos-order-ingress 要件11・8.8〜8.11）──

/**
 * HeldCounts — 保持の書き込みで破棄された件数。**出力は書かず、Worker が拾える形で返すところまでを持つ**
 * （DO が個別にログを出せば 1 バッチで最大 1000 行が店舗ごとに分散して読めなくなる）。Worker は
 * `logPosIngress` でこれを 1 リクエスト 1 行のカウンタへ合算する。
 */
export interface HeldCounts {
  /** 保持期間（2 時間）を過ぎて破棄した件数（`heldExpired`）。登録の遅れを示す。 */
  readonly heldExpired: number;
  /** 件数上限の超過で破棄した件数（`heldOverflow`）。不正送信または大量の登録漏れを示す。 */
  readonly heldOverflow: number;
}

/**
 * HoldOutcome — 保留・隔離の結末。**`put` の成功だけが「保持した」の根拠である**（Property 10・AC 11.3 / 11.4）。
 *
 * `persist-failed` は `ReceiveOutcome` と同名で、意味も同一である（何も確定していない・一時的失敗）。
 * 呼び出し元は保持できていないものを受理と主張せず、上流の再送に委ねる。
 */
export type HoldOutcome =
  | { readonly kind: "held"; readonly counts: HeldCounts }
  /**
   * 保持は確定したが、同一リクエスト内の再生が完了しなかった（design §8-b の穴 1）。
   *
   * **`persist-failed` と分ける。** あちらは「何も確定していない」であり、こちらは「保持は確定した・再生を
   * 持ち越した」である。同じ名で運べば、保持できている Record について「保持できていない」と嘘をつく。
   * 呼び出し元の挙動は同じ（一時的失敗として応答し上流の再送に委ねる）だが、**同じ挙動を選ぶことと同じ事実で
   * あることは別である**——件数（counts）が意味を持つのはこちらだけである。
   */
  | { readonly kind: "replay-deferred"; readonly counts: HeldCounts }
  | { readonly kind: "persist-failed" };

/**
 * ReplayProgress — 1 Store_Code の再生がどこまで進んだか（design §8-b・§9）。
 *
 * 4 つの終わり方を分けるのは、**残作業と Alarm を張るべきなのが `deferred` の 1 つだけ**だからである。
 * `halted`（宛先が未知・宛先が非活性）で張れば、2 時間の失効を待つ間ずっと DO を起こし続けることになり、
 * 「待つなら寝かせる」の規律に反する（未知コードの契機は店舗登録の確定であり、時間ではない）。
 *
 * `windowExpired` は再生時に値域窓の外へ出ていて再保留しなかった件数（`replayWindowExpired`・AC 12.12）。
 * 出力は `replayUnrouted` が行う——他の 11 カウンタは Worker が 1 リクエスト 1 行にまとめるが、この 1 つだけは
 * リクエストの文脈に乗らない（再生は Alarm 由来でも起きる・`replayUnrouted` の注記）。
 */
interface ReplayProgress {
  /**
   * `drained` 保留が空になった／`deferred` 一時的失敗ゆえ持ち越す／`halted` 再試行しても届かない／
   * `joined` 別の再生が走っており、そちらが拾う。
   */
  readonly kind: "drained" | "deferred" | "halted" | "joined";
  readonly windowExpired: number;
}

// ── 最小の読み出しビュー（要件2.10・ADMIN_TOKEN と同一認可）──
//
// 外部マスタとの突き合わせ・採番スラッグ（storeId）の再確認用の最小 GET。一覧は突き合わせに要る
// メタデータへ絞り（Roster 等の内部詳細は載せない）、個別取得はイデア全体（Store）を返す。

/** ChainSummary — チェーン一覧の最小ビュー。突き合わせに要る chainId / name のみ（chainRoster は載せない）。 */
interface ChainSummary {
  readonly chainId: ChainId;
  readonly name: string;
}

/** StoreSummary — 店舗一覧の最小ビュー。採番スラッグ（storeId）・所属・名称・活性状態の一覧確認用。 */
interface StoreSummary {
  readonly storeId: StoreId;
  readonly chainId: ChainId;
  readonly name: string;
  readonly active: boolean;
}

/**
 * StoreChoice — Entry の店舗切替 UI へ渡す店舗の選択肢（要件7.4）。
 *
 * storeId はランダムスラッグゆえ人間には無意味であり、切替 UI の表示には人間可読の name を用いる。
 * ワイヤに載せるのは storeId（宛先）と name（表示）だけで、Roster などイデアの内部詳細は載せない
 * （逆引きで解決した接続可能店舗の最小の宛先情報に留める）。
 */
export interface StoreChoice {
  readonly storeId: StoreId;
  readonly name: string;
}

/** 生値をプレーンオブジェクト（配列・null を除く）へ絞り込む。該当しなければ null。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * StoreRegistryDO — 全チェーン・Policy・店舗・名簿のイデア（正本）を保持するシングルトンの Durable Object。
 *
 * put-first 規律：いかなる登録／更新も、まずイデアの書き込み群・増分した meta:revision・残作業を
 * storage.put で確定してから fan-out（applyProjection 押し込み）を始める。確定の起点は put 成功のみで、
 * その前に外部（店舗 DO）へ真実を主張しない（SSOT 規律・要件5.1）。
 *
 * 収束の fan-out（3.3）と CRUD（3.2）・GET（3.4）は後続タスクが本骨格の commitIdeal を起点に配線する。
 */
export class StoreRegistryDO extends DurableObject<Env> {
  /**
   * いま再生が走っている Store_Code（in-memory・design §8-b）。同時に走る再生を 1 本に限る印である。
   *
   * **永続しない。** hibernate を跨げないことを承知の上で in-memory に置く——これは二重送信を減らすための
   * 工夫であって正しさの要件ではなく、失われても欠落しない（正しさは identity ベースの削除が支える）。
   * 永続すれば逆に、DO が落ちた瞬間の印が残って再生が永久に始まらない状態を作れてしまう。
   */
  private readonly replaying = new Set<string>();

  /**
   * 自身の addressing 名。getByName("registry") で addressing され、ctx.id.name から引数受け渡し・永続なしで
   * 読む（Cloudflare 前提2）。name 未提供の環境では固定名へ畳む（シングルトンゆえ一意）。
   */
  private get registryName(): string {
    return this.ctx.id.name ?? REGISTRY_NAME;
  }

  /**
   * 現在の revision を読む（不在は 0）。イデア未書き込みの初期状態を 0 とし、最初の書き込みで 1 になる。
   * revision はシングルトン DO 内で直列化されるため、読み → +1 → put の間に競合は入らない（自明に単調）。
   */
  private async currentRevision(): Promise<number> {
    const raw = await this.ctx.storage.get(REVISION_KEY);
    return typeof raw === "number" ? raw : 0;
  }

  /**
   * commitIdeal — put-first の確定。イデアの書き込み群・増分した meta:revision・残作業を、fan-out の前に
   * 一度の put で確定する（要件5.1 / 5.6 / 5.8）。
   *
   * meta:revision はイデアの全書き込みで +1（狭義単調増加）。返す revision を投影 version（recomposeProjection）
   * と収束台帳（convergedVersionKey）の基準にする。CRUD（3.2）は idealWrites にイデアのキー群
   * （chainKey / storeKey ほか・逆引き index:reverse の再導出を含む）を組み立てて渡し、収束（3.3）は
   * 返された revision で再合成した投影を影響店舗へ押し込む。
   *
   * 確定の起点は put 成功のみゆえ、本メソッドの解決前に fan-out を始めてはならない（呼び出し規律）。
   */
  private async commitIdeal(
    idealWrites: Readonly<Record<string, unknown>>,
    residual: readonly StoreId[],
  ): Promise<number> {
    const revision = (await this.currentRevision()) + 1;
    // put-first：イデア＋revision＋残作業を fan-out より前に確定する（SSOT 規律）。
    // オブジェクト形の put で一括確定し、部分確定の隙を作らない。
    await this.ctx.storage.put({
      ...idealWrites,
      [REVISION_KEY]: revision,
      [RESIDUAL_KEY]: residual,
    });
    return revision;
  }

  /**
   * 全店舗のイデアを読み出す（非同期 KV API の list・要件9 / tooling）。
   *
   * チェーン変更の影響店舗逆引き（affectedStores）に用いる。store:{storeId} は各店舗の正本キーゆえ、
   * この prefix 走査が現時点の全店舗を過不足なく返す。GET 読み出し（タスク 3.4）とは別用途の内部ヘルパ。
   */
  private async loadStores(): Promise<Store[]> {
    const entries = await this.ctx.storage.list<Store>({ prefix: "store:" });
    return [...entries.values()];
  }

  /**
   * 全チェーンのイデアを読み出す（chain: prefix 走査・非同期 KV API）。
   *
   * 逆引きインデックスの再導出（reverseIndexWrite）に用いる。chainRoster は各チェーンが保持するため、
   * 実効 Roster の導出（effectiveRoster）にはチェーン一式が要る。
   */
  private async loadChains(): Promise<Chain[]> {
    const entries = await this.ctx.storage.list<Chain>({ prefix: "chain:" });
    return [...entries.values()];
  }

  /**
   * reverseIndexWrite — 逆引きインデックス（identity → 接続可能店舗）を再導出して index:reverse に載せる
   * 書き込みを組む（要件3.6）。
   *
   * 正本はイデア（chain:* / store:*）一本であり、逆引きは名簿・店舗の書き込みのたびにここで再導出される
   * 導出値ゆえ、正本と乖離させない——導出値を状態に昇格させず、イデアと同じ put で一緒に確定する。
   * ReadonlyMap は配列化（[identity, storeId[]] の列）して永続する（Data Models「ReverseIndex（配列化）」）。
   * 引数は書き込み後（post-write）のチェーン・店舗一式であることを前提とする（呼び出し側が overlay する）。
   */
  private reverseIndexWrite(
    chains: readonly Chain[],
    stores: readonly Store[],
  ): Record<string, unknown> {
    const index = buildReverseIndex(chains, stores);
    return { [REVERSE_INDEX_KEY]: [...index.entries()] };
  }

  /**
   * codeIndexWrite — Store_Code 逆引きインデックス（storeCode → storeId）を再導出して index:code に載せる
   * 書き込みを組む（pos-order-ingress 要件2.1 / 2.3）。
   *
   * reverseIndexWrite と同型に置く。正本はイデア（store:*）一本であり、この索引は店舗の書き込みのたびに
   * ここで再導出される導出値ゆえ、イデアと同一の put で一緒に確定する（導出値を正本から常に再導出できる
   * 状態に保つ）。ReadonlyMap は配列化（[storeCode, storeId] の列）して永続する。
   * 引数は書き込み後（post-write）の店舗一式であることを前提とする（呼び出し側が overlay する）。
   *
   * チェーン・Policy の書き込みでは呼ばない——buildCodeIndex が見るのは store:* の storeCode だけであり、
   * チェーン名簿や Policy の変更は索引を動かさない（reverseIndexWrite が chains を要するのとは依存が違う）。
   */
  private codeIndexWrite(stores: readonly Store[]): Record<string, unknown> {
    const index = buildCodeIndex(stores);
    return { [CODE_INDEX_KEY]: [...index.entries()] };
  }

  /**
   * 永続の index:code を CodeIndex（ReadonlyMap）へ復元する。未書き込み・型不一致は空索引として扱う
   * （storesForIdentity の逆引き読み戻しと同型）。
   */
  private async loadCodeIndex(): Promise<CodeIndex> {
    const raw = await this.ctx.storage.get(CODE_INDEX_KEY);
    const entries = Array.isArray(raw) ? (raw as readonly (readonly [string, StoreId])[]) : [];
    return new Map(entries);
  }

  /**
   * resolveStoreCode — 外部マスタの店舗コードから宛先 storeId を引く（pos-order-ingress 要件2.5 / 2.6）。
   *
   * Worker が宛先を引く唯一の経路。保持済みインデックス（index:code）の単一読み出しで完結し、全店舗を
   * 走査しない。未知の Store_Code は undefined を返し、いかなる店舗へもフォールバックしない（要件2.6）。
   * 非活性店舗も索引に載る（要件2.7）——閉店の判定は StoreTimerDO の既存ゲートに任せ、索引を活性で絞らない。
   *
   * **保留が非空であるあいだは、宛先が既知でも未知として応答する**（design §8-a・AC 11.20 / 11.21）。これは
   * 欠落を防ぐための不変であり、性能の工夫ではない——再生は Alarm 継続で非同期に進むため、その間に新着
   * （大きい `sequence_number`）を直接届ければ宛先 DO の判定材料が進み、後から再生される保留分（小さい
   * `sequence_number`）が全件「重複」として弾かれて消える。未知は Code_Memo に載らないため（AC 4.4）、
   * 新着も保留へ積まれて到着順が保たれ、保留が空になった瞬間から直接配送が始まる。**新しい状態を持たずに、
   * 既存の 2 つの規律の組み合わせで順序が守られる。**
   */
  async resolveStoreCode(storeCode: string): Promise<StoreId | undefined> {
    if (await this.hasUnrouted(storeCode)) return undefined;
    return storeForCode(await this.loadCodeIndex(), storeCode);
  }

  /**
   * 当該 Store_Code の保留が非空か（§8-a の判定）。
   *
   * 保持が空になったらキーを消す規律（`hold` 参照）があるため、判定は 1 つの形で済む——不在ならば保持なし。
   *
   * **失効した Record だけが残っている状態も「非空」として扱う。** 生きているかを見るには値を丸ごと読んで
   * 各件を判定することになり、それは失効を落とす put を伴わない限り観測を状態へ反映できない（常設 Alarm を
   * 持たない帰結・AC 11.16）。非空として扱えば、次の 1 バッチが `holdUnrouted` を通って同期再生が刈り、
   * その次から直接配送へ戻る。**遅れは 1 バッチで自ら解ける一方、生きていると誤って直接配送すれば欠落が残る。**
   */
  private async hasUnrouted(storeCode: string): Promise<boolean> {
    const raw = await this.ctx.storage.get(unroutedKey(storeCode));
    return Array.isArray(raw) && raw.length > 0;
  }

  /**
   * 保持中の Record 列を読む（不在・型不一致は空）。キーの不在が「保持なし」である——保持が空になった時点で
   * キーを消すため（hold 参照）、空配列と不在の 2 つの形を判定側が見分ける必要が無い。
   */
  private async loadHeld(key: string): Promise<readonly HeldRecord[]> {
    const raw = await this.ctx.storage.get(key);
    return Array.isArray(raw) ? (raw as readonly HeldRecord[]) : [];
  }

  /**
   * hold — 保持の書き込み。保留（`unrouted:`）と隔離（`contract-violation:`）が共有する唯一の作用（AC 8.11）。
   *
   * **`put` の成功で確定してから受理を応答する**（Property 10・AC 11.3 / 11.4）。失敗は `persist-failed` で
   * 返し、保持できていないものを受理と主張しない。put より前に応答を組み立てる経路をここに持たない。
   *
   * **常設 Alarm を張らない**（AC 11.16）。失効の判定はこの読み書きの瞬間と再生の瞬間だけで行う——保留が
   * 無い間も DO を起こし続けるのは hibernation の規律（待つなら寝かせる）に反する。ゆえに本メソッドは
   * `setAlarm` を呼ばない（再生の Alarm は `deferReplay` が `armAlarm` を通して収束と多重化して張る）。
   *
   * 失効・件数上限の判定は純粋関数（`retainHeld`）に閉じ、ここは読み・書き・件数の受け渡しだけを行う。
   */
  private async hold(key: string, arriving: readonly HeldRecord[], now: number): Promise<HoldOutcome> {
    const retention = retainHeld(await this.loadHeld(key), arriving, now);
    if (arriving.length === 0 && retention.expired === 0 && retention.overflow === 0) {
      // 何も変わらないなら書かない（書いた事実が無いのに書いたことになる状態を作らない）。
      return { kind: "held", counts: { heldExpired: 0, heldOverflow: 0 } };
    }
    try {
      if (retention.retained.length === 0) {
        // 全件が失効したらキーを消す（不在＝保持なし。空配列を残せば「非空か」の判定が 2 つの形を見る）。
        await this.ctx.storage.delete(key);
      } else {
        await this.ctx.storage.put(key, retention.retained);
      }
    } catch {
      return { kind: "persist-failed" };
    }
    return {
      kind: "held",
      counts: { heldExpired: retention.expired, heldOverflow: retention.overflow },
    };
  }

  /**
   * holdUnrouted — 宛先が解決できなかった Record を 2 時間だけ保留する（AC 11.1〜11.4）。
   *
   * 捨てないのは、4xx を返せば上流はアラームの無いカウンタ（`workerRejected`）を加算して Record を捨て、
   * 5xx を返せばバッチ全体の再送で同一バッチの他店舗も止まるためである。ゆえに第三の道を採る。
   *
   * 保持するのは検証済みの Record そのままである。麺の仕様の解釈に要る `noodlePresets` は宛先が定まらない
   * 段階では得られないため、解釈は再生時に行う（再生専用の解釈経路を持たない）。
   *
   * **当該 Store_Code が既に Code_Index に既知なら、応答を返す前に再生を完了させる**（design §8-b の穴 1）。
   * これがなければ保留が永久に詰まる——`resolveStoreCode` の未知応答（§8-a）を受けた Worker が保留を積む間に
   * 走っていた再生が保留を空にして停止すると、既知コードのキーに積まれた Record を再生する契機が誰にも
   * 残らず、以降のバッチも「保留非空 → 未知 → 積む」を繰り返すだけになる。上流は同一 `store_id` を直列に
   * 送るため、応答前に終えれば次バッチとの順序も守られる。
   */
  async holdUnrouted(storeCode: string, records: readonly ArrivalRecord[]): Promise<HoldOutcome> {
    // 時計を読むのは端であるここだけで、判定（retainHeld）には引数として渡す。
    const now = Date.now();
    const outcome = await this.hold(
      unroutedKey(storeCode),
      records.map((record): HeldRecord => ({ kind: "unrouted", heldAt: now, record })),
      now,
    );
    if (outcome.kind === "persist-failed") return outcome;
    // 未知コードの契機は店舗登録の確定である（design §9 の契機 1）。ここで索引を引くのは、既知かどうかで
    // 契機の在り処が変わるという一点だけのためである。
    if (storeForCode(await this.loadCodeIndex(), storeCode) === undefined) return outcome;
    const progress = await this.replayUnrouted(storeCode);
    if (progress.kind !== "deferred") return outcome;
    // 一時的失敗ゆえ残作業へ残し（Alarm が回収する）、応答も一時的失敗とする（design §8-b）。上流の再送は
    // 保留の重複を生むが、それは宛先 DO の単調性が吸収する——欠落と重複の分岐では重複を選ぶ。
    await this.deferReplay(storeCode);
    return { kind: "replay-deferred", counts: outcome.counts };
  }

  /**
   * replayUnrouted — 1 Store_Code の再生を起こす。**同時に走る再生を 1 本に限る**（design §8-b）。
   *
   * 再生中に来た保留要求は追記だけを行い、走っている再生が「保留が空になるまで繰り返す」過程でそれを拾う。
   * **これは二重送信を減らすための工夫であって、正しさの要件ではない**——`replaying` は in-memory ゆえ
   * hibernate を跨げないが、失われても欠落しない。正しさを支えるのは identity ベースの削除（`retainUnsent`）
   * ただ一つである。
   *
   * **`replayWindowExpired` の唯一の出力点でもある**（AC 12.12・12.13）。他の 11 カウンタは Worker が
   * 1 リクエストにつき 1 行へまとめるが、このカウンタだけはそこへ乗らない——再生の契機は 3 つあり
   * （既知コードへの `holdUnrouted`・店舗登録の確定・Alarm）、後ろの 2 つに POS のリクエストは無い。
   * 一方をリクエストの行へ、他方をここへ出せば同じカウンタの出力点が 2 つに分かれる。ゆえに 3 つの契機が
   * 必ず通るこの 1 箇所に置く。**出力を Worker へ集める理由（1 バッチで最大 1000 行の分散）はここには
   * 当たらない**——行は Record ごとではなく 1 回の再生ごとで、しかも破棄が生じた再生に限る。
   *
   * 形は Worker の観測（`logPosIngress`）と同じ `posIngress` の判別子を持つ独立の行で、既存の
   * Instrumentation_Log（`src/observe/log.ts` の `buildSeamEntry`・`OBSERVE_DEBUG` ゲート）とは別経路である。
   */
  private async replayUnrouted(storeCode: string): Promise<ReplayProgress> {
    if (this.replaying.has(storeCode)) return { kind: "joined", windowExpired: 0 };
    this.replaying.add(storeCode);
    try {
      const progress = await this.drainUnrouted(storeCode);
      if (progress.windowExpired > 0) {
        // 行の種別がカウンタ名そのものである（リクエストの行は名 → 数の 11 対を並べるが、こちらは 1 つの
        // カウンタだけを運ぶ）。破棄が生じた再生だけを出す——0 件の再生まで出せば、頻度の高い再生が定常の
        // ノイズになる。**Store_Code は載せない**（カウンタの行はいずれも識別子を運ばず件数だけを運ぶ）。
        console.log(JSON.stringify({ posIngress: "replayWindowExpired", discarded: progress.windowExpired }));
      }
      return progress;
    } finally {
      this.replaying.delete(storeCode);
    }
  }

  /**
   * drainUnrouted — 保留が空になるまで再生を繰り返す（AC 11.7〜11.10・11.22）。
   *
   * **削除は件数ではなく identity（送り終えた最後の `sequenceNumber`）で行う。** `holdUnrouted` の同期再生と
   * Alarm 由来の再生は同時に走りうる（DO は単一スレッドでも await 境界で交互に進む）ため、件数で削れば一方が
   * 他方の未送信分を消す——「2 件送った」を現在の一覧の先頭 2 件と解釈した瞬間、その一覧が既に別の再生に
   * よって入れ替わっていれば、まだ送っていない Record を削ることになる。
   *
   * 押し込みの後に必ず読み直すのは、RPC を await している間に届いた追記を消さないためである（穴 2）。
   */
  private async drainUnrouted(storeCode: string): Promise<ReplayProgress> {
    const key = unroutedKey(storeCode);
    const storeId = storeForCode(await this.loadCodeIndex(), storeCode);
    // 宛先が無い保留の契機は店舗登録の確定である。時間で再試行しても宛先は現れない（Alarm を張らない）。
    if (storeId === undefined) return { kind: "halted", windowExpired: 0 };

    let windowExpired = 0;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const held = await this.loadHeld(key);
      if (held.length === 0) return { kind: "drained", windowExpired };
      const now = Date.now();
      // 失効・窓外は送らない（AC 11.22）。刈るのは書き戻しの一箇所だけで、ここでは選ぶだけである。
      const sendable = held.filter((entry) => isHeldReplayable(entry, now)).map((entry) => entry.record);
      if (!isNonEmpty(sendable)) {
        // 送れるものが 1 件も無い＝残っているのは失効・窓外だけ。RPC を通さずに刈って終える。
        // **読み直さない**——`loadHeld` の解決からここまでに await が無いため、この値は現在の値そのままで
        // あり、間に追記は割り込めない（読み直せば逆に、読み直しの await 中の追記を消す隙を作る）。
        // oxlint-disable-next-line no-await-in-loop
        windowExpired += await this.retainUnsent(key, held, undefined, now);
        return { kind: "drained", windowExpired };
      }

      let outcome: ReceiveOutcome;
      try {
        // oxlint-disable-next-line no-await-in-loop
        outcome = await this.pushToStore(storeId, sendable);
      } catch {
        // DO 到達失敗・タイムアウトは一時的失敗。何も削らずに持ち越す（送れていないものを送ったとしない）。
        return { kind: "deferred", windowExpired };
      }
      if (outcome.kind === "unprovisioned" || outcome.kind === "persist-failed") {
        // 投影未受領は一時的な状態ゆえ再試行に値する（Property 15）。put 失敗も同じく何も確定していない。
        return { kind: "deferred", windowExpired };
      }
      if (outcome.kind === "deactivated") {
        // 恒久的失敗（再活性化は運用の判断であり 2 時間の窓に収まらない）。削らず・張らず、失効に委ねる
        // ——時間で再試行すれば 2 時間ぶん DO を起こし続け、それでも届かない。
        return { kind: "halted", windowExpired };
      }

      const lastSent = lastSentSequence(sendable);
      // oxlint-disable-next-line no-await-in-loop
      const current = await this.loadHeld(key);
      // oxlint-disable-next-line no-await-in-loop
      windowExpired += await this.retainUnsent(key, current, lastSent, Date.now());
    }
  }

  /**
   * pushToStore — 再生の押し込み。**通常の取り込みと同一の RPC（`receiveRecords`）を通す**（AC 11.10）。
   *
   * 再生専用の解釈経路を持たない——写像（麺の仕様の翻訳）・冪等（`sequence_number` の単調性）・順序の規律は
   * すべて宛先 DO の内側の 1 つの遷移が担う。ここに解釈を持てば、同じ Record が経路によって別の Pending_Order
   * になりうる。スタブは既存経路と同じ `idFromName` → `get({ locationHint })` の二段で引く。
   */
  private async pushToStore(
    storeId: StoreId,
    records: NonEmptyArray<ArrivalRecord>,
  ): Promise<ReceiveOutcome> {
    const stub = this.env.STORE_TIMER_DO.get(this.env.STORE_TIMER_DO.idFromName(storeId), {
      locationHint: "apac-ne",
    });
    return stub.receiveRecords(records);
  }

  /**
   * retainUnsent — 送り終えた範囲と再生できないものを取り除いて書き戻す（AC 11.7・11.22）。
   *
   * **`current` は呼び出し側が読んだ「現在の値」であり、読みからこの呼び出しまでに await を挟んではならない。**
   * 本メソッドは絞り込み（同期）と put だけを行うため、その規律を守る限り読み→書きの間に他の継続が割り込めず、
   * 追記を消さない（DO は単一スレッドで、割り込みは await 境界にしか生じない）。
   *
   * 判定の順序に意味がある。**窓の再評価を送信済み判定より先に置く**——後にすれば、失効した古い Record が
   * 「送り終えた範囲」として黙って消え、破棄が観測から落ちる（件数が動かないまま Record が失われる）。
   *
   * @returns 窓の外へ出ていて再保留しなかった件数（`replayWindowExpired`）。
   */
  private async retainUnsent(
    key: string,
    current: readonly HeldRecord[],
    lastSent: string | undefined,
    now: number,
  ): Promise<number> {
    const retained: HeldRecord[] = [];
    let windowExpired = 0;
    for (const entry of current) {
      if (!isHeldReplayable(entry, now)) {
        // 再保留しない（保留 → 再生 → 窓外 → 再保留の循環を作らない・AC 11.22）。
        windowExpired += 1;
        continue;
      }
      // **比較は isNewerSequence を通す**（桁数を揃えた文字列比較の規則の単一の出所）。素の `>` で書けば、
      // 桁が繰り上がる瞬間に片方だけが誤り、送信済みの Record が残るか未送信の Record が消える。
      if (lastSent !== undefined && !isNewerSequence(entry.record.sequenceNumber, lastSent)) continue;
      retained.push(entry);
    }
    if (retained.length === 0) {
      // 不在＝保持なし（空配列を残せば §8-a の「非空か」の判定が 2 つの形を見ることになる）。
      await this.ctx.storage.delete(key);
    } else {
      await this.ctx.storage.put(key, retained);
    }
    return windowExpired;
  }

  /** 再生の残作業（Store_Code の列）を読む（不在・型不一致は空）。 */
  private async loadReplayResidual(): Promise<readonly string[]> {
    const raw = await this.ctx.storage.get(REPLAY_RESIDUAL_KEY);
    return Array.isArray(raw) ? (raw as readonly string[]) : [];
  }

  /**
   * deferReplay — 再生を持ち越す。残作業へ Store_Code を足し、継続の Alarm を張る（AC 11.9）。
   *
   * 残作業を先に確定してから Alarm を張る（put 成功が唯一の起点ゆえ、張った Alarm が読む先が既に在る）。
   */
  private async deferReplay(storeCode: string): Promise<void> {
    const residual = await this.loadReplayResidual();
    if (!residual.includes(storeCode)) {
      await this.ctx.storage.put(REPLAY_RESIDUAL_KEY, [...residual, storeCode]);
    }
    await this.armAlarm(Date.now() + REPLAY_ALARM_DELAY_MS);
  }

  /**
   * armAlarm — 継続の Alarm を「より早い方」で張る（design §9-a）。
   *
   * DO の Alarm は 1 本ゆえ、後から張る側が先の要求を上書きすれば、上書きされた側の残作業が次の契機まで止まる。
   * **収束（`converge` / `alarm`）と再生（`deferReplay` / `alarm`）の Alarm 要求はすべて本メソッドを通る**
   * ——素の `setAlarm` を残せば、その 1 箇所が他方の要求を後ろへずらす。既に等しいか早い Alarm が在れば
   * 何もしない（同じ 2 秒後の要求が 2 つ在っても張り直さない。1 回の発火が両方の残作業を捌く）。
   */
  private async armAlarm(at: number): Promise<void> {
    const pending = await this.ctx.storage.getAlarm();
    if (pending === null || at < pending) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  /**
   * runReplay — 再生の残作業を捌く（Alarm 継続の入口。`runConvergence` と同型）。
   *
   * 各 Store_Code の再生は直列に行う（一度に抱え込まない）。持ち越しが残るものだけを残作業へ書き戻し、
   * `halted`（宛先が未知・非活性）は落とす——時間で再試行しても届かないものを残せば、失効までの 2 時間、
   * DO を起こし続ける。
   *
   * 呼び出し元は `alarm()` の `replayInAlarm` ただ一つで、そこが本メソッドの throw を吸収する（再生の失敗で
   * 収束の `retryCount` を消費しない・design §9-a）。ゆえに本メソッド自身は storage の失敗を握り潰さない。
   *
   * @returns 実行後に残った残作業（空なら再生完了）。
   */
  private async runReplay(): Promise<readonly string[]> {
    const residual = await this.loadReplayResidual();
    if (residual.length === 0) return residual;
    const remaining: string[] = [];
    for (const storeCode of residual) {
      // oxlint-disable-next-line no-await-in-loop
      const progress = await this.replayUnrouted(storeCode);
      if (progress.kind === "deferred") remaining.push(storeCode);
    }
    await this.ctx.storage.put(REPLAY_RESIDUAL_KEY, remaining);
    return remaining;
  }

  /**
   * replayForStoreCodes — 店舗登録の確定を契機に、当該 Store_Code の保留を再生する（design §9 の契機 1）。
   *
   * **`converge()` の後に置く。** 再生は宛先 DO の `receiveRecords` を通り、投影未受領なら `unprovisioned` で
   * 持ち越しになる。`converge` は当該店舗へ投影を押し込む作用そのものゆえ、前に置けば店舗開設直後の再生が
   * 必ず一度空振りし、保留の解消が Alarm の次回まで遅れる（登録の瞬間に届いていた注文が最も新しい注文である）。
   *
   * 再生の失敗で登録の応答を落とさない。イデアは既に put で確定済みであり、残作業と Alarm が回収する。
   */
  private async replayForStoreCodes(storeCodes: readonly (string | undefined)[]): Promise<void> {
    for (const storeCode of storeCodes) {
      if (storeCode === undefined) continue;
      try {
        // oxlint-disable-next-line no-await-in-loop
        const progress = await this.replayUnrouted(storeCode);
        // oxlint-disable-next-line no-await-in-loop
        if (progress.kind === "deferred") await this.deferReplay(storeCode);
      } catch {
        // 読み書きの失敗も持ち越しとして扱う（登録は確定済み・再生は at-least-once の best-effort）。
        // oxlint-disable-next-line no-await-in-loop
        await this.deferReplay(storeCode).catch(() => undefined);
      }
    }
  }

  /**
   * quarantineContractViolations — 上流の契約違反を 2 時間だけ隔離する（AC 8.8〜8.11）。
   *
   * **`holdUnrouted` と別の受け口にする。** 規律（`put` 成功で確定・2 時間・件数上限・観測）は共有するが、
   * 事後条件が違う——こちらは決して再生されず（design §9-b）、タスク 19 が同期再生を足すのは `holdUnrouted`
   * だけである。1 つの受け口で種別を受ければ、同じ呼び出しの意味が引数で分岐する。かつ引数の型も違う
   * ——隔離の対象は検証前の生値である（型違反の Record は `ArrivalRecord` を構築できない）。
   *
   * 保持する意味は上流のバグを調べる証跡であり、待ち行列へ入れることではない。ゆえに 2 時間で失効し、
   * 破棄されるだけである。受理時刻・`payload.datetime` のいずれも代替の起点に用いない（AC 8.10）。
   */
  async quarantineContractViolations(storeCode: string, raws: readonly unknown[]): Promise<HoldOutcome> {
    const now = Date.now();
    return this.hold(
      contractViolationKey(storeCode),
      raws.map((raw): HeldRecord => ({ kind: "contract-violation", heldAt: now, raw })),
      now,
    );
  }

  /**
   * 割り当て予定の policyIds を policy:{policyId} キーから解決する（曖昧割当検出の入力・要件3.4）。
   *
   * 存在する Policy だけを返す（バッチ get は不在キーを Map から省く）。存在しない Policy 参照は主張する
   * フィールドを持たず曖昧さを生み得ないため、ここで無視してよい（本タスクは曖昧割当検出に集中する）。
   * policyIds の重複はキー重複としてバッチ get が一意化するため、単一 Policy が自身と曖昧化することはない。
   */
  private async loadAssignedPolicies(policyIds: readonly PolicyId[]): Promise<Policy[]> {
    if (policyIds.length === 0) return [];
    const map = await this.ctx.storage.get<Policy>(policyIds.map(policyKey));
    return [...map.values()];
  }

  /**
   * 未使用な storeId をランダム採番する（要件2.2）。
   *
   * 乱数採取は shell の作用ゆえここで crypto.getRandomValues を回し、純粋関数 mintStoreId へ渡す。
   * 既存 store キーとの衝突を都度確認し、衝突すれば採り直す。mintStoreId の出力は必ず isValidStoreId を
   * 満たす（slug.ts の事後条件）ため、ここでの再検証は要らない。
   */
  private async mintUnusedStoreId(): Promise<StoreId> {
    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
      const bytes = new Uint8Array(MINT_RANDOM_BYTES);
      crypto.getRandomValues(bytes);
      const candidate = mintStoreId(bytes);
      // oxlint-disable-next-line no-await-in-loop
      const existing = await this.ctx.storage.get(storeKey(candidate));
      if (existing === undefined) return candidate;
    }
    // 128 ビット空間で連続衝突は実質起こらない。起きたら前提違反として明示的に失敗させる。
    throw new Error("storeId 採番が衝突上限まで達した（乱数源を確認）");
  }

  /**
   * createOrUpdateChain — チェーンの登録／更新（PUT /admin/chains/{chainId}・ボディ全置換）。
   *
   * name の型と chainRoster の値を検証し（chainRoster は validateProvisioningInput の roster 検証・要件4.6）、
   * 違反は 400・イデア不変で拒否する。受理時はイデアを put-first で確定してから影響店舗（このチェーンに属する
   * 全店・affectedStores）の収束を開始する（要件3.7）。chainRoster 省略時は空名簿（PUT の全置換意味論）。
   */
  async createOrUpdateChain(chainId: ChainId, raw: unknown): Promise<ProvisionResult> {
    const body = asRecord(raw);
    if (body === null) {
      return rejectValidation({ path: "", reason: "type-mismatch", detail: "オブジェクトである必要がある" });
    }

    const rejections: Rejection[] = [];
    if (typeof body.name !== "string" || body.name.length === 0) {
      rejections.push({
        path: "name",
        reason: body.name === undefined ? "missing-required" : "type-mismatch",
        detail: "非空の文字列である必要がある",
      });
    }
    // chainRoster は省略可（全置換で空名簿）。存在するときのみ値検証する。
    if (body.chainRoster !== undefined) {
      const verdict = validateProvisioningInput({ target: "roster", raw: body.chainRoster });
      if (!verdict.accepted) rejections.push(...verdict.rejections);
    }
    if (isNonEmpty(rejections)) {
      return { accepted: false, failure: { kind: "validation", rejections } };
    }

    const chain: Chain = {
      chainId,
      name: body.name as string,
      chainRoster: (body.chainRoster as Roster | undefined) ?? [],
    };

    // put-first：イデア＋revision＋残作業を確定してから fan-out を始める（SSOT 規律・要件5.1 / 5.6）。
    // chainRoster の変更は実効 Roster を動かすため、逆引きインデックスも同じ put で再導出する（要件3.6）。
    const stores = await this.loadStores();
    const chains = [...(await this.loadChains()).filter((c) => c.chainId !== chainId), chain];
    const change: IdealChange = { kind: "chain", chainId };
    const residual = affectedStores(change, stores);
    await this.commitIdeal(
      { [chainKey(chainId)]: chain, ...this.reverseIndexWrite(chains, stores) },
      residual,
    );
    await this.converge();
    return { accepted: true };
  }

  /**
   * createOrUpdatePolicy — Policy の登録／更新（PUT /admin/policies/{policyId}・ボディ全置換）。
   *
   * name / chainId（非空文字列）・priority（有限数値）を検証し、fields（PolicyFields）の mode/値は
   * validateProvisioningInput（policyFields 検証・要件4.6）で拒否型検証する。未知フィールド・型不一致・
   * 値域外は 400・イデア不変で拒否する。受理時はイデアを put-first で確定してから、この Policy を割り当てて
   * いる影響店舗（affectedStores の Policy 変種）の収束を開始する（要件3.7）。
   *
   * NOTE: 新規 Policy は、いずれかの店舗が policyIds に含めるまで影響店舗が空である（affectedStores が
   * 空集合を返す）。ゆえに新規登録の時点では収束は誰も動かさず、割当（updateStore の policyIds）で初めて
   * 当該店舗の投影が再合成される。曖昧割当（同一 priority・同一フィールド）の入口 400 拒否はタスク 9.2 で扱う。
   */
  async createOrUpdatePolicy(policyId: PolicyId, raw: unknown): Promise<ProvisionResult> {
    const body = asRecord(raw);
    if (body === null) {
      return rejectValidation({ path: "", reason: "type-mismatch", detail: "オブジェクトである必要がある" });
    }

    const rejections: Rejection[] = [];
    if (typeof body.name !== "string" || body.name.length === 0) {
      rejections.push({
        path: "name",
        reason: body.name === undefined ? "missing-required" : "type-mismatch",
        detail: "非空の文字列である必要がある",
      });
    }
    if (typeof body.chainId !== "string" || body.chainId.length === 0) {
      rejections.push({
        path: "chainId",
        reason: body.chainId === undefined ? "missing-required" : "type-mismatch",
        detail: "非空の文字列である必要がある",
      });
    }
    if (typeof body.priority !== "number" || !Number.isFinite(body.priority)) {
      rejections.push({
        path: "priority",
        reason: body.priority === undefined ? "missing-required" : "type-mismatch",
        detail: "有限の数値である必要がある",
      });
    }
    // fields は省略可（何も主張しない Policy を許す）。存在するときのみ mode/値を拒否型検証する。
    if (body.fields !== undefined) {
      const verdict = validateProvisioningInput({ target: "policyFields", raw: body.fields });
      if (!verdict.accepted) rejections.push(...verdict.rejections);
    }
    if (isNonEmpty(rejections)) {
      return { accepted: false, failure: { kind: "validation", rejections } };
    }

    const policy: Policy = {
      policyId,
      chainId: body.chainId as string,
      name: body.name as string,
      priority: body.priority as number,
      fields: (body.fields as PolicyFields | undefined) ?? {},
    };

    // put-first：イデアを確定してから影響店舗（この Policy を割り当てる全店）の収束を始める（要件3.7 / 5.1）。
    const change: IdealChange = { kind: "policy", policyId };
    const residual = affectedStores(change, await this.loadStores());
    await this.commitIdeal({ [policyKey(policyId)]: policy }, residual);
    await this.converge();
    return { accepted: true };
  }

  /**
   * createStore — 店舗の登録（POST /admin/stores）。
   *
   * storeId 未指定はランダムスラッグを採番して応答で返す（要件2.2）。明示指定は isValidStoreId（文字集合・
   * 長さ）＋未使用チェックを通過したときのみ受理し、違反・使用済みは 400・イデア不変・別 ID の代替受理を
   * 行わない（要件2.3 / 2.4）。Override の値は validateProvisioningInput（storeOverride 検証）で拒否型検証し、
   * 違反は 400・イデア不変（要件4.6。storeId の検証とは別レイヤ）。受理時はイデアを put-first で確定してから
   * 当該店舗の収束（materialize）を開始する（要件2.5 / 5.1）。
   *
   * Policy 割当（policyIds）は Phase 2（タスク 9.1）、店舗 Roster は Phase 3（タスク 12.3）で扱うため、
   * ここでは空で確定する（イデアの型は最終形ゆえ後続 Phase は追加のみ）。
   */
  async createStore(raw: unknown): Promise<CreateStoreResult> {
    const body = asRecord(raw);
    if (body === null) {
      return { accepted: false, failure: { kind: "validation", rejections: [
        { path: "", reason: "type-mismatch", detail: "オブジェクトである必要がある" },
      ] } };
    }

    // ── 値検証（storeId の文字集合・衝突検証とは別レイヤ・要件4.6）──
    const rejections: Rejection[] = [];
    if (typeof body.name !== "string" || body.name.length === 0) {
      rejections.push({
        path: "name",
        reason: body.name === undefined ? "missing-required" : "type-mismatch",
        detail: "非空の文字列である必要がある",
      });
    }
    if (typeof body.chainId !== "string" || body.chainId.length === 0) {
      rejections.push({
        path: "chainId",
        reason: body.chainId === undefined ? "missing-required" : "type-mismatch",
        detail: "非空の文字列である必要がある",
      });
    }
    if (body.override !== undefined) {
      const verdict = validateProvisioningInput({ target: "storeOverride", raw: body.override });
      if (!verdict.accepted) rejections.push(...verdict.rejections);
    }
    // storeRoster は作成時に同梱してよい（省略時は空名簿）。存在するときのみ Roster の値を拒否型検証する
    // （updateStore と同一の検証・要件4.6）。店舗の定義と名簿を 1 リクエストで自己完結させる。
    if (body.storeRoster !== undefined) {
      const verdict = validateProvisioningInput({ target: "roster", raw: body.storeRoster });
      if (!verdict.accepted) rejections.push(...verdict.rejections);
    }
    if (isNonEmpty(rejections)) {
      return { accepted: false, failure: { kind: "validation", rejections } };
    }

    // Store_Code の解釈は 3 経路で同じ 1 つの関数を通す（新規ゆえ既存は無く、型・空文字の拒否だけが働く）。
    const codeVerdict = storeCodeAfterUpdate(undefined, body.storeCode);
    if (!codeVerdict.ok) return { accepted: false, failure: codeVerdict.failure };

    // ── storeId の採番 or 明示検証（要件2.2 / 2.3 / 2.4）──
    let storeId: StoreId;
    if (body.storeId === undefined) {
      storeId = await this.mintUnusedStoreId();
    } else {
      if (typeof body.storeId !== "string" || !isValidStoreId(body.storeId)) {
        // 文字集合・長さ違反。別 ID の自動採番による代替受理は行わない（要件2.4）。
        return { accepted: false, failure: { kind: "store-id-invalid", storeId: String(body.storeId) } };
      }
      if ((await this.ctx.storage.get(storeKey(body.storeId))) !== undefined) {
        // 使用済み。外部マスタとの対応が黙って壊れるのを防ぐため、別 ID で受理しない（要件2.4）。
        return { accepted: false, failure: { kind: "store-id-in-use", storeId: body.storeId } };
      }
      storeId = body.storeId;
    }

    const now = Date.now();
    const store: Store = {
      storeId,
      chainId: body.chainId as string,
      name: body.name as string,
      policyIds: [], // Phase 2（タスク 9.1）で割当を受ける
      override: (body.override as StoreOverride | undefined) ?? {},
      // storeRoster は作成ボディに同梱可（省略時は空名簿）。以後の改定は updateStore（PUT /admin/stores/{id}）が受ける（要件3.5）
      storeRoster: (body.storeRoster as Roster | undefined) ?? [],
      active: true,
      ...(codeVerdict.storeCode !== undefined ? { storeCode: codeVerdict.storeCode } : {}),
      createdAt: now,
      updatedAt: now,
    };

    // put-first：イデアを確定してから当該店舗の収束を始める（要件2.5 / 5.1）。
    // 新規店舗の追加は逆引きインデックスに現れるため、post-write の店舗一式で再導出する（要件3.6）。
    const chains = await this.loadChains();
    const stores = [...(await this.loadStores()), store];

    // Store_Code の一意性は post-write の店舗集合へ検出を掛けて確かめる（pos-order-ingress 要件3.1 / 3.2）。
    // commitIdeal の**直前**に判定し、拒否時はイデアを一切変更しない（detectAmbiguousAssignment と同じ規律）。
    const inUse = storeCodeInUseFailure(detectDuplicateStoreCodes(stores), storeId);
    if (inUse !== undefined) return { accepted: false, failure: inUse };

    await this.commitIdeal(
      {
        [storeKey(storeId)]: store,
        ...this.reverseIndexWrite(chains, stores),
        // storeCode を持つ新規店舗は Store_Code 逆引きに現れる（pos-order-ingress 要件2.3）。
        ...this.codeIndexWrite(stores),
      },
      [storeId],
    );
    await this.converge();
    // 店舗登録の確定は再生の契機である（design §9 の契機 1）。converge の後に置く理由は replayForStoreCodes に。
    await this.replayForStoreCodes([codeVerdict.storeCode]);
    return { accepted: true, storeId };
  }

  /**
   * updateStore — 店舗の作成または更新（PUT /admin/stores/{storeId}・冪等 upsert）。
   *
   * 対象店舗が**存在しなければ作成**（createStore へ path の storeId を注入して委譲・create-or-replace）、
   * **存在すれば更新**する。同 URI への PUT は冪等——同じボディの再送は同じイデアへ収束する（一括投入の再実行安全性）。
   * 更新では Override・active・name・Policy 割当（policyIds）・storeRoster を受ける。active=false（閉店）を受けられる。
   * 物理削除はしない——非活性化はイデアの更新であり、収束で店舗 DO へ投影される（要件3.9 / 6.6）。Override の値は
   * validateProvisioningInput で拒否型検証し、違反は 400・イデア不変（要件4.6）。policyIds は文字列配列であることを
   * 検証する（存在しない Policy 参照の整合検証・曖昧割当の 400 拒否はタスク 9.2 で扱う）。受理時はイデアを put-first で確定してから当該店舗の
   * 収束を開始する——店舗変更ゆえ影響は当該店のみ（[storeId]）で、recomposeProjection が更新後の policyIds に
   * 割り当てられた Policy 群を composeEffectiveConfig へ渡して投影を再合成する（Policy 割当変更の収束・要件3.7）。
   *
   * 店舗 Roster（storeRoster）はこの更新ボディに含めて運ぶ（design.md Component 7 のルート表）。値は
   * validateProvisioningInput（roster 検証・要件4.6）で拒否型検証し、違反は 400・イデア不変。省略時は既存値を
   * 保持する（部分更新）。storeRoster の変更は実効 Roster を動かすため、逆引きインデックスを再導出し、
   * recomposeProjection が effectiveRoster で導出した投影 roster を当該店の StoreTimerDO へ収束させる（要件3.5 / 3.6）。
   */
  async updateStore(storeId: StoreId, raw: unknown): Promise<ProvisionResult> {
    const existing = (await this.ctx.storage.get(storeKey(storeId))) as Store | undefined;
    if (existing === undefined) {
      // 冪等 upsert：対象が不在なら「作成」する。同 URI への PUT を create-or-replace とし、同じボディの再送が
      // 同じイデアへ収束する（冪等性）。作成の検証・既定・storeCode・storeRoster・収束は createStore に一元化し
      // （二重定義を避ける・設計哲学「重複の根絶」）、path の storeId を注入して委譲する。CreateStoreResult は
      // storeId を返すが PUT の結果表現は ProvisionResult ゆえ受理/失敗のみへ写す（失敗理由は共通の ProvisionFailure）。
      const createBody = asRecord(raw);
      if (createBody === null) {
        return rejectValidation({ path: "", reason: "type-mismatch", detail: "オブジェクトである必要がある" });
      }
      const created = await this.createStore({ ...createBody, storeId });
      return created.accepted ? { accepted: true } : { accepted: false, failure: created.failure };
    }

    const body = asRecord(raw);
    if (body === null) {
      return rejectValidation({ path: "", reason: "type-mismatch", detail: "オブジェクトである必要がある" });
    }

    const rejections: Rejection[] = [];
    if (body.override !== undefined) {
      const verdict = validateProvisioningInput({ target: "storeOverride", raw: body.override });
      if (!verdict.accepted) rejections.push(...verdict.rejections);
    }
    if (body.name !== undefined && (typeof body.name !== "string" || body.name.length === 0)) {
      rejections.push({ path: "name", reason: "type-mismatch", detail: "非空の文字列である必要がある" });
    }
    if (body.active !== undefined && typeof body.active !== "boolean") {
      rejections.push({ path: "active", reason: "type-mismatch", detail: "真偽値である必要がある" });
    }
    // policyIds は Policy 割当（PolicyId の配列）。存在するときのみ文字列配列であることを検証する。
    if (
      body.policyIds !== undefined &&
      (!Array.isArray(body.policyIds) || body.policyIds.some((id) => typeof id !== "string"))
    ) {
      rejections.push({ path: "policyIds", reason: "type-mismatch", detail: "文字列の配列である必要がある" });
    }
    // storeRoster は省略可（部分更新）。存在するときのみ Roster の値を拒否型検証する（要件4.6）。
    if (body.storeRoster !== undefined) {
      const verdict = validateProvisioningInput({ target: "roster", raw: body.storeRoster });
      if (!verdict.accepted) rejections.push(...verdict.rejections);
    }
    if (isNonEmpty(rejections)) {
      return { accepted: false, failure: { kind: "validation", rejections } };
    }

    // Store_Code の解釈（要件3.3 / 3.4 / 3.8）。既存が未設定なら受理・同値なら受理・異なれば拒否。
    // 更新経路が storeCode を読まない形は、後から POS 連携を始める店舗に新規作成を強いる（StoreId が変わり
    // 既存の画面 URL と WS 接続が切れる）。
    const codeVerdict = storeCodeAfterUpdate(existing, body.storeCode);
    if (!codeVerdict.ok) return { accepted: false, failure: codeVerdict.failure };

    const updated: Store = {
      ...existing,
      name: typeof body.name === "string" ? body.name : existing.name,
      override: body.override !== undefined ? (body.override as StoreOverride) : existing.override,
      policyIds: Array.isArray(body.policyIds) ? (body.policyIds as readonly PolicyId[]) : existing.policyIds,
      storeRoster: body.storeRoster !== undefined ? (body.storeRoster as Roster) : existing.storeRoster,
      active: typeof body.active === "boolean" ? body.active : existing.active,
      ...(codeVerdict.storeCode !== undefined ? { storeCode: codeVerdict.storeCode } : {}),
      updatedAt: Date.now(),
    };

    // 曖昧な Policy 割当の入口検証（要件3.4）。更新後の would-be policyIds を Policy オブジェクトへ解決し、
    // 同一 priority で同一フィールドを主張する複数 Policy があれば 400・イデア不変で拒否する（曖昧な統制を
    // 表現可能にしない）。put-first の commitIdeal より前に判定し、拒否時はイデアを一切書き換えない。
    const assigned = await this.loadAssignedPolicies(updated.policyIds);
    const conflicts = detectAmbiguousAssignment(assigned);
    if (isNonEmpty(conflicts)) {
      return { accepted: false, failure: { kind: "ambiguous-assignment", conflicts } };
    }

    // put-first：イデアを確定してから当該店舗の収束を始める（要件3.7 / 5.1）。
    // storeRoster・active・chainId の変更は逆引きインデックスを動かすため、post-write の店舗一式で再導出する（要件3.6）。
    const chains = await this.loadChains();
    const stores = [...(await this.loadStores()).filter((s) => s.storeId !== storeId), updated];

    // 更新も一意性の検出を通す（要件3.2）。既存が未設定なら付与を受理する経路が在るため、更新でも他店舗の
    // 使用中コードを主張しうる。createStore と同じ 1 つの純粋関数を commitIdeal の直前に掛ける。
    const inUse = storeCodeInUseFailure(detectDuplicateStoreCodes(stores), storeId);
    if (inUse !== undefined) return { accepted: false, failure: inUse };

    await this.commitIdeal(
      {
        [storeKey(storeId)]: updated,
        ...this.reverseIndexWrite(chains, stores),
        // 更新でも Store_Code 逆引きを post-write の店舗一式から再導出する（pos-order-ingress 要件2.3）。
        // 3 経路のいずれかで漏らせば「登録したのに宛先が引けない」店舗が生まれる。
        ...this.codeIndexWrite(stores),
      },
      [storeId],
    );
    await this.converge();
    // 未設定 → 設定の受理も再生の契機になる（保留していた Record の宛先がここで定まる・design §4 末尾）。
    await this.replayForStoreCodes([codeVerdict.storeCode]);
    return { accepted: true };
  }

  /**
   * upsertStores — 店舗の一括冪等 upsert（PUT /admin/stores・配列ボディ）。
   *
   * 各要素を storeId をキーに upsert する（不在なら作成・存在すれば更新）。**all-or-nothing**——全要素を
   * 検証してから確定し、1 つでも不正なら failures を全列挙して 400・イデア不変で拒否する（部分適用しない）。
   * 「宣言された集合の upsert」であって全置換ではない——列挙外の店舗は削除しない（そもそも削除は持たない）。
   * 各要素は storeId を必須とする（冪等の鍵。ランダム採番は単発 POST の関心事であり一括では受けない）。
   * 受理時はイデアを一度の put-first で確定し（commitIdeal）、影響全店を residual に載せて converge を 1 回起こす
   * （25 件/波の Alarm ドレインは既存機構がそのまま捌く・要件5.8）。検証・合成の純粋ロジックは既存
   * （validateProvisioningInput / detectAmbiguousAssignment / reverseIndexWrite）を再利用し、新規に足さない。
   */
  async upsertStores(raw: unknown): Promise<BulkStoresResult> {
    if (!Array.isArray(raw)) {
      return {
        accepted: false,
        failures: [
          {
            index: -1,
            failure: {
              kind: "validation",
              rejections: [{ path: "", reason: "type-mismatch", detail: "配列である必要がある" }],
            },
          },
        ],
      };
    }
    if (raw.length === 0) return { accepted: true, count: 0 };

    // 既存店舗・チェーンを一度だけ読む（存在判定・逆引き再導出・バッチ内 storeId 重複検出に用いる）。
    const existingStores = await this.loadStores();
    const existingByKey = new Map<StoreId, Store>(existingStores.map((s) => [s.storeId, s]));
    const chains = await this.loadChains();

    const built: Store[] = [];
    const failures: BulkStoreFailure[] = [];
    const seenIds = new Set<string>();
    // 要素の位置を storeId から引けるようにする（Store_Code の衝突は post-write の集合で検出するため、
    // 失敗要素の列挙に元の位置が要る・要件3.5）。
    const indexByStoreId = new Map<StoreId, number>();
    const now = Date.now();

    for (let index = 0; index < raw.length; index++) {
      // oxlint-disable-next-line no-await-in-loop
      const resolved = await this.resolveBulkElement(raw[index], existingByKey, seenIds, now);
      if (resolved.ok) {
        built.push(resolved.store);
        seenIds.add(resolved.store.storeId);
        indexByStoreId.set(resolved.store.storeId, index);
      } else {
        failures.push({
          index,
          ...(resolved.storeId !== undefined ? { storeId: resolved.storeId } : {}),
          failure: resolved.failure,
        });
      }
    }

    // all-or-nothing：1 つでも失敗すれば一切書き込まない（イデア不変）。
    if (isNonEmpty(failures)) {
      return { accepted: false, failures };
    }

    // 全要素妥当 → 一度の put-first で全イデア＋逆引きを確定し、影響全店を residual に載せて収束を 1 回起こす。
    const idealWrites: Record<string, unknown> = {};
    for (const store of built) idealWrites[storeKey(store.storeId)] = store;
    const builtIds = new Set(built.map((s) => s.storeId));
    // post-write の店舗一式（既存 − 置換分 ＋ built）で逆引きを再導出する（要件3.6）。
    const postStores = [...existingStores.filter((s) => !builtIds.has(s.storeId)), ...built];

    // Store_Code の一意性は単発経路と同じ 1 つの純粋関数を post-write の集合へ掛けて確かめる（要件3.2 / 3.5）。
    // **バッチ内の重複も同じ経路で捕まる**——両方の要素が同一コードを主張すれば衝突の storeIds に両方が現れる。
    // commitIdeal の直前ゆえ、拒否時はイデアを一切変更しない（all-or-nothing）。
    const duplicates = detectDuplicateStoreCodes(postStores);
    if (duplicates.length > 0) {
      const codeFailures: BulkStoreFailure[] = [];
      for (const store of built) {
        const failure = storeCodeInUseFailure(duplicates, store.storeId);
        const index = indexByStoreId.get(store.storeId);
        if (failure !== undefined && index !== undefined) {
          codeFailures.push({ index, storeId: store.storeId, failure });
        }
      }
      if (isNonEmpty(codeFailures)) return { accepted: false, failures: codeFailures };
    }

    Object.assign(idealWrites, this.reverseIndexWrite(chains, postStores));
    // Store_Code 逆引きも同じ post-write の店舗一式から再導出し、同一の put で確定する（pos-order-ingress 要件2.3）。
    Object.assign(idealWrites, this.codeIndexWrite(postStores));
    await this.commitIdeal(
      idealWrites,
      built.map((s) => s.storeId),
    );
    await this.converge();
    // 一括でも契機は同じで、対象は確定した全店の Store_Code である（1 件でも漏らせばその店舗の保留が詰まる）。
    await this.replayForStoreCodes(built.map((store) => store.storeCode));
    return { accepted: true, count: built.length };
  }

  /**
   * resolveBulkElement — 一括 upsert の 1 要素を検証して目標 Store を組む（書き込みはしない・all-or-nothing の
   * 検証フェーズ）。storeId は必須（冪等の鍵）。不在なら作成（name / chainId 必須・storeId は許容文字集合/長さを検証）、
   * 存在すれば更新（部分更新・省略フィールドは既存を保持）。検証は単発経路と同一の validateProvisioningInput を用いる
   * （検証の単一の真実を共有し二重定義しない）。曖昧割当検出（要件3.4）も単発 updateStore と同一。
   */
  private async resolveBulkElement(
    element: unknown,
    existingByKey: ReadonlyMap<StoreId, Store>,
    seenIds: ReadonlySet<string>,
    now: number,
  ): Promise<
    | { readonly ok: true; readonly store: Store }
    | { readonly ok: false; readonly storeId?: string; readonly failure: ProvisionFailure }
  > {
    const body = asRecord(element);
    if (body === null) {
      return {
        ok: false,
        failure: {
          kind: "validation",
          rejections: [{ path: "", reason: "type-mismatch", detail: "オブジェクトである必要がある" }],
        },
      };
    }
    // storeId は一括の冪等鍵として必須。許容文字集合・長さを検証する（採番はしない）。
    if (typeof body.storeId !== "string" || !isValidStoreId(body.storeId)) {
      return { ok: false, failure: { kind: "store-id-invalid", storeId: String(body.storeId) } };
    }
    const storeId = body.storeId;
    if (seenIds.has(storeId)) {
      return {
        ok: false,
        storeId,
        failure: {
          kind: "validation",
          rejections: [{ path: "storeId", reason: "out-of-range", detail: "同一バッチ内で storeId が重複している" }],
        },
      };
    }
    const existing = existingByKey.get(storeId);

    const rejections: Rejection[] = [];
    // 作成（不在）時は name / chainId 必須。更新（存在）時は省略可（既存を保持）。
    if (existing === undefined) {
      if (typeof body.name !== "string" || body.name.length === 0) {
        rejections.push({
          path: "name",
          reason: body.name === undefined ? "missing-required" : "type-mismatch",
          detail: "非空の文字列である必要がある",
        });
      }
      if (typeof body.chainId !== "string" || body.chainId.length === 0) {
        rejections.push({
          path: "chainId",
          reason: body.chainId === undefined ? "missing-required" : "type-mismatch",
          detail: "非空の文字列である必要がある",
        });
      }
    } else if (body.name !== undefined && (typeof body.name !== "string" || body.name.length === 0)) {
      rejections.push({ path: "name", reason: "type-mismatch", detail: "非空の文字列である必要がある" });
    }
    if (body.override !== undefined) {
      const verdict = validateProvisioningInput({ target: "storeOverride", raw: body.override });
      if (!verdict.accepted) rejections.push(...verdict.rejections);
    }
    if (body.storeRoster !== undefined) {
      const verdict = validateProvisioningInput({ target: "roster", raw: body.storeRoster });
      if (!verdict.accepted) rejections.push(...verdict.rejections);
    }
    if (body.active !== undefined && typeof body.active !== "boolean") {
      rejections.push({ path: "active", reason: "type-mismatch", detail: "真偽値である必要がある" });
    }
    if (
      body.policyIds !== undefined &&
      (!Array.isArray(body.policyIds) || body.policyIds.some((id) => typeof id !== "string"))
    ) {
      rejections.push({ path: "policyIds", reason: "type-mismatch", detail: "文字列の配列である必要がある" });
    }
    if (isNonEmpty(rejections)) {
      return { ok: false, storeId, failure: { kind: "validation", rejections } };
    }

    // Store_Code は単発経路と同一の関数で確定する（要件3.3 / 3.4 / 3.8）。既存 storeCode を優先して変更要求を
    // 黙って無視することはしない——黙殺は「受理した」と応答しながら要求と違うイデアを残し、呼び出し元の意図を偽る。
    const codeVerdict = storeCodeAfterUpdate(existing, body.storeCode);
    if (!codeVerdict.ok) return { ok: false, storeId, failure: codeVerdict.failure };

    const policyIds: readonly PolicyId[] = Array.isArray(body.policyIds)
      ? (body.policyIds as readonly PolicyId[])
      : (existing?.policyIds ?? []);
    // 曖昧割当検出（要件3.4・単発 updateStore と同一）。空なら loadAssignedPolicies は [] で自明に無衝突。
    if (policyIds.length > 0) {
      const assigned = await this.loadAssignedPolicies(policyIds);
      const conflicts = detectAmbiguousAssignment(assigned);
      if (isNonEmpty(conflicts)) {
        return { ok: false, storeId, failure: { kind: "ambiguous-assignment", conflicts } };
      }
    }

    const store: Store = {
      storeId,
      chainId: existing ? existing.chainId : (body.chainId as string),
      name: typeof body.name === "string" && body.name.length > 0 ? body.name : (existing?.name ?? ""),
      policyIds,
      override: body.override !== undefined ? (body.override as StoreOverride) : (existing?.override ?? {}),
      storeRoster:
        body.storeRoster !== undefined ? (body.storeRoster as Roster) : (existing?.storeRoster ?? []),
      // 作成時は active:true（単発 createStore と同一・作成では body.active を既定 true に畳む）。更新時は指定を尊重し既存を保持。
      active: existing ? (typeof body.active === "boolean" ? body.active : existing.active) : true,
      ...(codeVerdict.storeCode !== undefined ? { storeCode: codeVerdict.storeCode } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return { ok: true, store };
  }

  /**
   * listChains — 全チェーンの最小ビューを返す（要件2.10・GET /admin/chains）。
   *
   * chain: prefix を非同期 KV list で走査し（要件9 / tooling）、突き合わせに要る chainId / name だけへ絞る。
   * chainRoster 等の内部詳細はワイヤに載せない（読み出しは最小に留める）。
   */
  async listChains(): Promise<readonly ChainSummary[]> {
    const entries = await this.ctx.storage.list<Chain>({ prefix: "chain:" });
    return [...entries.values()].map((chain) => ({ chainId: chain.chainId, name: chain.name }));
  }

  /**
   * listStores — 店舗の最小ビューを返す（要件2.10・GET /admin/stores?chainId=）。
   *
   * chainId 指定時は当該チェーン所属だけへ絞る（省略時は全店）。採番スラッグ（storeId）と活性状態の一覧確認用。
   */
  async listStores(chainId?: ChainId): Promise<readonly StoreSummary[]> {
    const stores = await this.loadStores();
    const scoped = chainId === undefined ? stores : stores.filter((store) => store.chainId === chainId);
    return scoped.map((store) => ({
      storeId: store.storeId,
      chainId: store.chainId,
      name: store.name,
      active: store.active,
    }));
  }

  /**
   * getStore — 単一店舗のイデア全体を返す（要件2.10・GET /admin/stores/{storeId}）。不在は undefined（fetch が 404）。
   *
   * storeCode（外部マスタコード）を含む全フィールドを返し、採番スラッグと外部マスタの対応の再確認に供する。
   */
  async getStore(storeId: StoreId): Promise<Store | undefined> {
    return (await this.ctx.storage.get(storeKey(storeId))) as Store | undefined;
  }

  /**
   * storesForIdentity — Entry の行き先解決（要件7.2 / 7.4）。identity → 接続可能店舗リストを返す。
   *
   * 保持済みの逆引きインデックス（REVERSE_INDEX_KEY）の単一読み出しで完結し、全チェーン・全店舗の名簿を
   * 走査しない（要件3.6・7.4。逆引きは名簿書き込み時に buildReverseIndex で再導出済みの導出値）。
   * これが Worker の Entry へ型付き RPC として公開する唯一のメソッドであり、WS の接続・再接続経路（高頻度）
   * からは決して呼ばれない（ホットパス分離・要件7.7）。
   *
   * REVERSE_INDEX_KEY は ReadonlyMap を配列化した [identity, storeId[]] の列で永続される（reverseIndexWrite・
   * Data Models「ReverseIndex（配列化）」）。読み戻しで Map に復元し、登録順（buildReverseIndex が保証）を保った
   * storeId 列を返す。未書き込み（イデアが空）・型不一致は空インデックスとして扱い、空配列を返す。
   */
  async storesForIdentity(identity: Identity): Promise<readonly StoreId[]> {
    const raw = await this.ctx.storage.get(REVERSE_INDEX_KEY);
    const entries = Array.isArray(raw) ? (raw as readonly (readonly [Identity, readonly StoreId[]])[]) : [];
    const index: ReverseIndex = new Map(entries);
    return storesForIdentity(index, identity);
  }

  /**
   * storeChoicesForIdentity — 店舗切替 UI 用に、identity の接続可能店舗を (storeId, name) の組で返す（要件7.4）。
   *
   * storesForIdentity（逆引きインデックスの単一読み出し・登録順）で宛先 storeId 列を得てから、各店舗の
   * イデア（store:{storeId}）をバッチ get して表示名 name を引く。切替 UI の表示は name を使う——storeId は
   * ランダムスラッグゆえ人間には無意味（要件7.4）。返り順は逆引きの登録順（buildReverseIndex が保証・既定店が
   * 先頭）を保つ。storeId・name 以外のイデア内部詳細（Roster 等）はワイヤに載せない。
   *
   * Entry（起動時・低頻度）の切替リスト取得（GET /entry/stores）から呼ばれ、WS の接続・再接続経路（高頻度）
   * からは決して呼ばれない（storesForIdentity と同じくホットパス分離・要件7.7）。イデアが空・不整合（逆引きに
   * 在るが store: が欠落）な storeId は表示名を引けないため結果から除く（存在しない店舗を選択肢に出さない）。
   */
  async storeChoicesForIdentity(identity: Identity): Promise<readonly StoreChoice[]> {
    const storeIds = await this.storesForIdentity(identity);
    if (storeIds.length === 0) return [];
    // 各 storeId の name を引くためイデアをバッチ get する（Map は順序非保証ゆえ storeIds 側で順序を保つ）。
    const stores = await this.ctx.storage.get<Store>(storeIds.map(storeKey));
    const choices: StoreChoice[] = [];
    for (const storeId of storeIds) {
      const store = stores.get(storeKey(storeId));
      // 逆引きに在るが store: が欠落する不整合は選択肢から除く（存在しない宛先を UI に出さない）。
      if (store !== undefined) {
        choices.push({ storeId, name: store.name });
      }
    }
    return choices;
  }

  /**
   * 収束の残作業（RESIDUAL_KEY）を読む（不在・型不一致は空）。commitIdeal が put-first で確定した
   * 「未完了店舗の storeId 列」が収束の唯一の駆動源であり、converge / alarm はこれを起点に fan-out する。
   */
  private async loadResidual(): Promise<readonly StoreId[]> {
    const raw = await this.ctx.storage.get(RESIDUAL_KEY);
    return Array.isArray(raw) ? (raw as readonly StoreId[]) : [];
  }

  /**
   * 収束の再合成に要するイデア一式（chains / stores / policies）と現 revision を読む。
   *
   * recomposeProjection は「その時点の最新イデア」から投影を再合成するため、押し込みの直前にこの一式を
   * 読む（常に最新から再導出 → 履歴順序を持たず last-write-wins・要件5.4）。Phase 1 では policy: は空で、
   * recomposeProjection は空 Policy 群と Store_Override の縮退合成に落ちる（イデアの型は最終形ゆえ後続 Phase は追加のみ）。
   */
  private async loadIdeal(): Promise<{
    readonly chains: readonly Chain[];
    readonly stores: readonly Store[];
    readonly policies: readonly Policy[];
    readonly revision: number;
  }> {
    const chains = [...(await this.ctx.storage.list<Chain>({ prefix: "chain:" })).values()];
    const stores = await this.loadStores();
    const policies = [...(await this.ctx.storage.list<Policy>({ prefix: "policy:" })).values()];
    const revision = await this.currentRevision();
    return { chains, stores, policies, revision };
  }

  /**
   * runConvergence — 残作業を最新イデアから再合成して直列に押し込む、収束の本体（作用の端）。
   * converge（イデア変更起点）と alarm（継続）が共有する。純粋計算（recomposeProjection / nextResidual）は
   * registry/converge.ts へ委ね、ここは put・RPC・残作業の永続という作用だけを実行する（計算と作用の分離）。
   *
   * 直列規律：Promise.all を使わず 1 店ずつ await する（要件5.5・「待つなら寝かせる」— 一度に抱え込まない）。
   * 1 回の実行では CONVERGE_MAX_PUSHES_PER_RUN 店までを押し、残り（未処理分・押し込み失敗分）は RESIDUAL_KEY
   * に残して Alarm 継続へ委ねる（DO 実行時間の境界・要件5.8）。各店の押し込み成否で nextResidual を畳み、
   * その都度 RESIDUAL_KEY を永続して at-least-once の継続を durable にする（途中でこの実行が落ちても取りこぼさない）。
   *
   * @returns 実行後に残った残作業（空なら収束完了）。
   */
  private async runConvergence(): Promise<readonly StoreId[]> {
    let residual = await this.loadResidual();
    if (residual.length === 0) return residual;

    const { chains, stores, policies, revision } = await this.loadIdeal();

    // この実行で押し込む対象は先頭から上限件数まで。上限超過分は residual に残り、Alarm 継続で捌く。
    const batch = residual.slice(0, CONVERGE_MAX_PUSHES_PER_RUN);
    for (const storeId of batch) {
      // 最新イデア・現 revision から再合成（履歴順序を持たず last-write-wins・要件5.4 / 5.9）。
      const projection = recomposeProjection(storeId, chains, stores, policies, revision);
      // 店舗 DO 参照は storeId のみで保持し、押し込みの都度スタブを動的生成する（永続しない・要件5.7・Cloudflare 前提1）。
      const stub = this.env.STORE_TIMER_DO.get(this.env.STORE_TIMER_DO.idFromName(storeId));
      let pushOk = false;
      try {
        // 型付き RPC で投影を押し込み、受領 version をエコーで受ける（Cloudflare 前提1・要件5.9）。
        // oxlint-disable-next-line no-await-in-loop
        const echoed = await stub.applyProjection(projection);
        // 受領 version を収束台帳へ記録し、レジストリ revision との突き合わせを観測可能にする（要件5.9）。
        // oxlint-disable-next-line no-await-in-loop
        await this.ctx.storage.put(convergedVersionKey(storeId), echoed.version);
        pushOk = true;
      } catch {
        // 押し込み失敗は残作業に残し、Alarm 継続の冪等再送に委ねる（at-least-once・last-write-wins・要件5.4）。
        pushOk = false;
      }
      residual = nextResidual(residual, storeId, pushOk);
      // 各店ごとに残作業を確定して継続の起点を durable にする（部分確定の隙を作らない・要件5.8）。
      // oxlint-disable-next-line no-await-in-loop
      await this.ctx.storage.put(RESIDUAL_KEY, residual);
    }
    return residual;
  }

  /**
   * converge — イデア変更を影響店舗の StoreTimerDO へ収束させる作用の起点（要件5.1 / 5.4 / 5.8）。
   *
   * put-first の commitIdeal が既に「イデア＋revision＋残作業（= affectedStores）」を確定済みゆえ、ここでは
   * 確定済みの残作業（RESIDUAL_KEY）を起点に直列 fan-out を回す（確定の起点は put 成功のみ・SSOT 規律）。
   * 1 回で捌けなかった残作業は Alarm 継続へ委ねる（作業があるときだけ Alarm を張る・Cloudflare 前提3）。
   *
   * 収束本体が durable な進捗を残せず失敗しても、イデア＋残作業は既に put で確定済みゆえ、継続の Alarm を
   * 張って収束を Alarm 側へ委ね、リクエストは正常復帰させる（真実は既に確定・fan-out は at-least-once の best-effort）。
   */
  private async converge(): Promise<void> {
    let residual: readonly StoreId[];
    try {
      residual = await this.runConvergence();
    } catch {
      // fan-out が失敗しても commitIdeal の put で真実は確定済み。継続の Alarm を張って Alarm 側へ委ねる。
      await this.armAlarm(Date.now() + CONVERGE_ALARM_DELAY_MS);
      return;
    }
    if (residual.length > 0) {
      // 残作業があるときだけ Alarm を張る（Cloudflare 前提3・作業なしでは張らない）。
      await this.armAlarm(Date.now() + CONVERGE_ALARM_DELAY_MS);
    }
  }

  /**
   * replayInAlarm — Alarm ハンドラのための再生。**自身の失敗で throw しない**（design §9-a・AC 11.11）。
   *
   * throw すれば Cloudflare の自動リトライが走り `retryCount` が進む。そのカウントは収束が「上限近傍なら
   * throw せず新規 Alarm を張り直す」判断に使う唯一の材料（`ALARM_REARM_THRESHOLD`）であり、再生がこれを
   * 食えば収束の再試行余裕が奪われる。ゆえに失敗は残作業に残し、次の契機へ持ち越す（`nextResidual` と同じ形）。
   *
   * @returns 再生の残作業が残っているか。失敗時も「残っている」として扱う——残作業は
   *   `REPLAY_RESIDUAL_KEY` に在るままであり、読み直しに行けばその読みが同じ理由で落ちうる。
   *   実際には空だった場合の代償は空振りの Alarm 1 回だけで、その回が張り直さずに終わる。
   */
  private async replayInAlarm(): Promise<boolean> {
    try {
      return (await this.runReplay()).length > 0;
    } catch {
      return true;
    }
  }

  /**
   * alarm — 収束と再生を多重化した Alarm 継続（要件5.8・pos-order-ingress 要件11.11・Cloudflare 前提3）。
   *
   * DO の Alarm は 1 本ゆえ、**ハンドラは両方の残作業を見る**（片方だけを見て早期 return すれば、もう片方が
   * 永久に残る）。収束は残作業を最新イデアから再合成して冪等再送し（last-write-wins ゆえ二重押しは一度
   * 押した結果と同一・要件5.4）、再生は当該 Store_Code の保留が空になるまで押し込む。
   *
   * **収束を先に走らせる。** この回は投影を押し込む回でもあり、後にすれば同じ回の再生が必ず一度
   * `unprovisioned` で空振りする（`replayForStoreCodes` が `converge` の後に置かれているのと同じ理由）。
   * ただし収束の失敗で throw を即断せず、再生を走らせてから判断する——**片方の失敗でもう片方を止めない。**
   *
   * runConvergence は RPC 失敗を残作業へ畳んで正常復帰するため、通常この alarm 自体は throw せず自動リトライは
   * 走らない（retryCount は進まない）。ただし収束本体が durable な進捗を残せず失敗した（storage の put / list 失敗など）
   * ときは throw して Cloudflare Alarm の at-least-once 自動リトライに委ねる。retryCount が上限近傍のときは throw で
   * 枯渇させず新規 Alarm を張り直し、取りこぼしを防ぐ（StoreTimerDO の ALARM_REARM_THRESHOLD 規律と同型）。
   */
  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    let residual: readonly StoreId[] = [];
    // 失敗を値として持ち回る（throw の判断は再生の後）。`unknown` を直に持てば throw された undefined と
    // 「失敗なし」が同じ形になるため、在る／無いは包みの有無で語る。
    let convergeFailure: { readonly error: unknown } | undefined;
    try {
      residual = await this.runConvergence();
    } catch (error) {
      convergeFailure = { error };
    }

    const replayRemains = await this.replayInAlarm();

    if (convergeFailure !== undefined) {
      // 収束本体が durable な進捗を残せず失敗。上限近傍なら自動リトライを使い切る前に継続を予約する。
      if (alarmInfo !== undefined && alarmInfo.retryCount >= ALARM_REARM_THRESHOLD) {
        await this.armAlarm(Date.now() + CONVERGE_ALARM_DELAY_MS);
        return;
      }
      // 上限に余裕があれば throw して at-least-once 自動リトライに委ねる（収束は何も確定していない）。
      // 再生の残作業はキーに在るままゆえ、リトライの回が再びそれを読む（張り直しは要らない）。
      throw convergeFailure.error;
    }

    // 残作業があるときだけ張る（作業なし → 張り直さない・Cloudflare 前提3）。armAlarm を通すことで
    // 2 つの要求は最小値へ畳まれ、後から張る側が先の要求を後ろへずらさない（design §9-a）。
    if (residual.length > 0) await this.armAlarm(Date.now() + CONVERGE_ALARM_DELAY_MS);
    if (replayRemains) await this.armAlarm(Date.now() + REPLAY_ALARM_DELAY_MS);
  }

  /**
   * Provisioning_API の HTTP 面。Worker は ADMIN_TOKEN 認可のみを行い Request を素通しする（Worker 極薄・
   * 委譲配線はタスク 5.2）。ルート解釈・JSON パース・拒否型 400 応答はここに閉じる。
   *
   * チェーン／Policy／店舗 CRUD と GET 読み出しを配線する。いずれにも当たらない経路は 404。
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    const method = request.method;

    const [root, collection, id] = segments;

    // PUT /admin/chains/{chainId}
    if (method === "PUT" && id !== undefined && root === "admin" && collection === "chains") {
      const body = await readJsonBody(request);
      if (!body.ok) return malformedJson();
      return provisionResponse(await this.createOrUpdateChain(id, body.value));
    }

    // PUT /admin/policies/{policyId}
    if (method === "PUT" && id !== undefined && root === "admin" && collection === "policies") {
      const body = await readJsonBody(request);
      if (!body.ok) return malformedJson();
      return provisionResponse(await this.createOrUpdatePolicy(id, body.value));
    }

    // POST /admin/stores
    if (method === "POST" && segments.length === 2 && root === "admin" && collection === "stores") {
      const body = await readJsonBody(request);
      if (!body.ok) return malformedJson();
      return createStoreResponse(await this.createStore(body.value));
    }

    // PUT /admin/stores — 一括冪等 upsert（配列・all-or-nothing・delete-missing なし・要件2.16 系）
    if (method === "PUT" && segments.length === 2 && root === "admin" && collection === "stores") {
      const body = await readJsonBody(request);
      if (!body.ok) return malformedJson();
      return bulkStoresResponse(await this.upsertStores(body.value));
    }

    // PUT /admin/stores/{storeId}
    if (method === "PUT" && id !== undefined && root === "admin" && collection === "stores") {
      const body = await readJsonBody(request);
      if (!body.ok) return malformedJson();
      return provisionResponse(await this.updateStore(id, body.value));
    }

    // GET /admin/chains
    if (method === "GET" && segments.length === 2 && root === "admin" && collection === "chains") {
      return jsonResponse(await this.listChains(), 200);
    }

    // GET /admin/stores（?chainId= で所属チェーンに絞り込み可）
    if (method === "GET" && segments.length === 2 && root === "admin" && collection === "stores") {
      const chainId = url.searchParams.get("chainId") ?? undefined;
      return jsonResponse(await this.listStores(chainId), 200);
    }

    // GET /admin/stores/{storeId}（不在は 404・別 ID へフォールバックしない）
    if (method === "GET" && id !== undefined && root === "admin" && collection === "stores") {
      const store = await this.getStore(id);
      return store === undefined
        ? jsonResponse({ error: "not-found", storeId: id }, 404)
        : jsonResponse(store, 200);
    }

    return new Response("Not Found", { status: 404 });
  }
}

// ── HTTP 表現ヘルパ（作用と表現の分離：メソッドは結果を返し、ここで HTTP へ写す）──

/** 単一の拒否だけを持つ validation 失敗の ProvisionResult を組む簡便関数。 */
function rejectValidation(rejection: Rejection): ProvisionResult {
  return { accepted: false, failure: { kind: "validation", rejections: [rejection] } };
}

/** Request ボディを JSON として読む。解釈不能は ok:false（呼び出し側が 400 を返す）。 */
async function readJsonBody(request: Request): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}

/** JSON として解釈不能なボディへの 400 応答。 */
function malformedJson(): Response {
  return jsonResponse({ error: "malformed-json" }, 400);
}

/** JSON 応答を組む（Content-Type 付与の一箇所）。 */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** ProvisionFailure を HTTP ステータスへ写す（validation・storeId 系は 400、not-found は 404）。 */
function failureResponse(failure: ProvisionFailure): Response {
  switch (failure.kind) {
    case "validation":
      return jsonResponse({ error: "validation", rejections: failure.rejections }, 400);
    case "ambiguous-assignment":
      return jsonResponse({ error: "ambiguous-assignment", conflicts: failure.conflicts }, 400);
    case "store-id-invalid":
      return jsonResponse({ error: "store-id-invalid", storeId: failure.storeId }, 400);
    case "store-id-in-use":
      return jsonResponse({ error: "store-id-in-use", storeId: failure.storeId }, 400);
    case "store-code-in-use":
      return jsonResponse(
        { error: "store-code-in-use", storeCode: failure.storeCode, storeId: failure.storeId },
        400,
      );
    case "store-code-immutable":
      return jsonResponse(
        { error: "store-code-immutable", storeId: failure.storeId, storeCode: failure.storeCode },
        400,
      );
    case "not-found":
      return jsonResponse({ error: "not-found", storeId: failure.storeId }, 404);
  }
}

/** チェーン更新・店舗更新の結果を HTTP へ写す（受理は 200）。 */
function provisionResponse(result: ProvisionResult): Response {
  return result.accepted ? jsonResponse({ accepted: true }, 200) : failureResponse(result.failure);
}

/** 一括 upsert の結果を HTTP へ写す（全受理は 200＋件数、いずれか失敗は 400＋失敗一覧・イデア不変）。 */
function bulkStoresResponse(result: BulkStoresResult): Response {
  return result.accepted
    ? jsonResponse({ accepted: true, count: result.count }, 200)
    : jsonResponse({ accepted: false, failures: result.failures }, 400);
}

/** 店舗登録の結果を HTTP へ写す（受理は 201・採番／受理した storeId を返す・要件2.2）。 */
function createStoreResponse(result: CreateStoreResult): Response {
  return result.accepted
    ? jsonResponse({ storeId: result.storeId }, 201)
    : failureResponse(result.failure);
}
