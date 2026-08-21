# Design Document

## Overview

券売機のイベントストリームから転送される Record 群を単一の URL で受け、宛先店舗を解決して未着手オーダー（Pending_Order）として確定させる経路を新設する。既存の `POST /s/{storeId}/orders`（宛先を URL で直指定する Order_Ingress）は残し、本経路は「宛先をボディから解決する」形として併存する。

設計の芯は 4 つある。

**宛先解決を導出値と不変な memo で閉じる。** `payload.store_id` は外部マスタの店舗コードであり、URL に載る `StoreId`（推測困難なランダムスラッグ）とは別物である。両者の対応はイデアから再導出できる導出値（`index:code`）としてレジストリに置き、Worker は不変な写像の memo で照会を省く。`storeCode → StoreId` が不変であることが、TTL も無効化も持たない memo を正当化する唯一の根拠である。

**原子性の単位を Arrival_Batch から Record 内の品目群へ置き換える。** 既存設計は部分受理を禁じているが、その禁が守っていたのは「1 つのオーダーの品目群」という意味的まとまりである。Arrival_Batch は上流ストリームの配信単位にすぎず、複数店舗・複数端末・複数 `path` が混在する。ゆえに Record 間に原子性はなく、Record 内の品目群には既存どおり原子性がある。

**欠落と重複の分岐では必ず重複を選ぶ（Duplicate_Bias）。** 上流は部分成功を報告せず、バッチ単位の retry と bisect で絞り込む。ゆえに一時的失敗はバッチ全体を落とし、重複は本経路の冪等が吸収する。宛先未解決のレコードは捨てず保留する——4xx を返せば上流はアラームの無いカウンタを加算してレコードを捨て、欠落が気づかれないまま進む。

**POS の語彙を待ち行列の正本へ持ち込まない。** `plu_no`・「大盛」・`item_type` はいずれも本経路の内側で `noodleType` / `firmness` / `slotSpan` へ翻訳し、engine と client は翻訳後の事実だけを見る。翻訳表は店舗設定として外部から注入し、コードに埋め込まない。

## Architecture

### 経路の全体

```
POS / Record_Forwarder
        │  POST /pos/records（Bearer: ORDER_INGRESS_TOKEN）
        ▼
┌─────────────────────────────────────────────┐
│ Worker（src/worker.ts）                      │
│  1. 認可（定数時間照合）                       │
│  2. Arrival_Batch の解釈 ── 純粋関数へ委譲      │
│  3. Store_Code ごとにグループ化 ── 純粋関数     │
│  4. 宛先解決（Code_Memo → resolveStoreCode）   │
└───┬──────────────────────┬──────────────────┘
    │ 解決できた            │ 未知の Store_Code
    ▼                      ▼
StoreTimerDO           StoreRegistryDO
 receiveRecords()       holdUnrouted()
 ・冪等（seq 単調）       ・保留（unrouted:{code}）
 ・麺の仕様の解釈         ・店舗登録で再生
 ・Pending_Order 確定     ・2 時間で失効（lazy）
 ・put 成功後に broadcast ・保留が非空の間は
                           resolveStoreCode が未知を返す
```

宛先が解決できた場合でも、当該 Store_Code の保留が残っている間は直接配送しない（§8-a）。この一点が保留分の欠落を防ぐ。

Status_Path の Record はこの図に現れない。Worker が破棄先へ落とし、件数だけを数える（配線は別 spec）。

### 純粋計算と作用の分離

作用を持つのは 3 箇所だけである。Worker（認可・RPC の呼び出し）、StoreTimerDO（`storage.put`・broadcast）、StoreRegistryDO（保留の `put`・再生の RPC）。それ以外はすべて純粋関数として置き、`cloudflare:workers` にも storage にも触れない。

| 純粋計算 | 置き場 | 何を決めるか |
| --- | --- | --- |
| Arrival_Batch の解釈 | `src/ingress/` | 生値 → 検証済みの Record 列 |
| Unique_Key の導出 | `src/ingress/` | 4 要素 → 識別子 |
| Store_Code ごとの分配 | `src/ingress/` | Record 列 → 店舗別の組 |
| 麺の仕様の解釈 | `src/ingress/` | 商品コード → `noodleType` / `firmness` / `slotSpan` |
| Code_Index の構築・読み出し | `src/registry/code-index.ts` | 全店イデア → `Store_Code → StoreId` |
| Store_Code の重複検出 | `src/registry/code-index.ts` | 全店イデア → 衝突の列 |

### `src/ingress/` を新設する

上流ペイロードの解釈だけを持つ場所を立てる。既存のどのディレクトリにも収まらないためである。

`src/domain/` は両端（server / client）が共有する契約の中立地帯であり、client が知る必要のない POS ペイロード形をここに置けば混ぜ物になる（steering の timer-model「共有契約 domain に片側専用を混ぜない」）。`src/registry/` は宛先解決とイデアの語彙で、ペイロード解釈は関心事が違う。`src/engine/` は状態遷移の純粋計算で、外部形式を知らない。

`src/ingress/` は `src/domain/` にのみ依存する（`PendingOrder` / `Firmness` / `NoodlePreset` を参照して翻訳結果を組む）。逆向きの依存は持たない——domain は ingress を知らない。

## Components and Interfaces

### 1. 受け口（`src/worker.ts`）

既存の経路（`/s/{storeId}/ws`・`/s/{storeId}/orders`・`/admin/*`・`/entry/*`）に `POST /pos/records` を足す。Worker が担うのは 4 つだけで、ボディの解釈ロジックを自身に持たない。

```ts
const POS_RECORDS_PATH = "/pos/records";

// storeCode → StoreId の isolate-local memo。
// 写像が不変（Store_Code の変更・再利用を Provisioning が禁じる）ゆえ TTL も無効化も持たない。
// 持つ必要が無いことが、この形の正しさである。未知（不在）は載せない——不在は不変ではない
// （後の店舗登録で既知に転じるうえ、保留が非空の間は意図的に未知を返す・§8-a）。
//
// NOTE: モジュールスコープゆえテスト間で持ち越される。テストは isolate を共有するため、
// memo の状態に依存する検証（Property 7）は明示的に空へ戻す手段を要する。
const resolvedStoreIds = new Map<string, StoreId>();
```

認可は既存の `isOrderIngressAuthorized`（`ORDER_INGRESS_TOKEN` の定数時間照合）をそのまま用いる。内部 identity ヘッダ（`X-Yudemen-Identity`）の除去も既存経路と同じく無条件で行い、経路ごとの例外を作らない。

宛先 DO のスタブ取得は既存と同じ `idFromName` → `get({ locationHint: "apac-ne" })` の二段で引く。

### 2. Arrival_Batch の解釈（`src/ingress/`）

生値を検証済みの形へ写す唯一の関門。既存の `toPendingOrders` / `toOrderIntent` と同型（生値 → 検証済みの形 または `null`）に置く。

```ts
/**
 * 上流が送る 1 リクエストのボディ。
 *
 * **records の各要素は未検証の生値のまま保つ。** 検証に落ちた要素は隔離（`contract-violation`）へ回る
 * 経路が検証前の生値を要するため、この段で落とせば欠落になる（型違反の Record は `ArrivalRecord` を
 * 構築できない）。ゆえに本型が表明するのは「ボディが records 配列を成している」という一つの事実だけで、
 * 個々の Record の分類は `RecordOutcome` が表す。
 */
interface ArrivalBatch {
  readonly records: readonly unknown[];
}

/** Arrival_Batch の 1 要素。payload は解釈せず生のまま持つ（Pass_Through）。 */
interface ArrivalRecord {
  readonly path: string;
  readonly payload: Record<string, unknown>;
  readonly arrivalTimestampMs: number;
  readonly sequenceNumber: string;
}
```

`payload` を `Record<string, unknown>` のまま持つのが Pass_Through の型による表明である。ここに POS ペイロードの構造を型として書けば、ベンダーがフィールドを足した瞬間に型が嘘になる。**構造を知るのは翻訳の局所だけで、運搬の型は知らない。**

検証するのは 4 つの構造だけ（Requirement 14.10・14.11 の適用層に一致）。`path` が非空文字列で在るか、`payload` がオブジェクトで在るか、`arrivalTimestampMs` が非負整数で在るか、`sequenceNumber` が在るか。`payload` の中身は一切検証しない。

この 4 つの検証は **`toArrivalRecord(raw): ArrivalRecord | null`** に置き、公開する。検証規則を 1 箇所に閉じるのは、分類（`RecordOutcome`）も再生も同じ関門を通すためである——二箇所に書けば、どちらで見たかによって同じ Record の可否が分かれる余地が生まれる。

**ボディ形の判定と Record 単位の分類を分ける。** `toArrivalBatch` が `null` を返すのはボディが `records` 配列を成さないときだけで、それは 400 になる（バッチ全体）。個々の Record の分類は別の型で表す。

```ts
type RecordOutcome =
  | { readonly kind: "order"; readonly record: ArrivalRecord; readonly uniqueKey: string }
  | { readonly kind: "status"; readonly sequenceNumber?: string }
  | { readonly kind: "unknown-path"; readonly sequenceNumber?: string }
  // 診断ログは seq と理由の 2 項目（AC 9.3）。seq が取れない Record もあるため optional。
  | { readonly kind: "poison"; readonly reason: PoisonReason; readonly sequenceNumber?: string }
  // **生値を運ぶ。** 型違反の Record は ArrivalRecord になれないため（arrivalTimestampMs: number を
  // 満たせない）、隔離の対象は検証前の値である。窓外（型は正しいが値域の外）も同じ形で運び、
  // 落とし所を 1 つに保つ。
  | { readonly kind: "contract-violation"; readonly raw: unknown; readonly sequenceNumber?: string };
```

Transient_Failure はこの種別に含めない。一時的失敗は Record の分類ではなく「処理が進められなかった」という別の軸であり、`ReceiveOutcome`（§7）と例外で表す。分類に混ぜれば「一時的な Record」という表現不能な概念が型に現れる。

**契約違反の落とし所を 1 つにする。** `arrival_timestamp_ms` の異常は 2 種ある——型として解釈できない値（上流の契約違反）と、型は正しいが値域窓の外（同じく契約の範囲外）。前者は `ArrivalRecord` を構築できないため、`contract-violation` は検証前の生値を運ぶ。両者は原因が同じ（上流が保証すべき値の異常）で、扱いも同じ（`contract-violation:{storeCode}` へ 2 時間隔離・再生しない）ゆえ、種別を分けない。

### 2-a. Unique_Key のエンコード規則

上流は Python の `urllib.parse.quote` を用いる。**`safe` は既定の `/` で確定した**（`[Q19]` 解消・ユーザー確認済み）。ゆえに本経路のエンコードは次の規則に合わせる。

- `/` はエンコードしない（`quote` の既定 `safe`）。
- `! * ' ( )` はエンコードする（`quote` はこれらを予約文字として通さない。`encodeURIComponent` は素通しするため差が出る）。
- `~` はエンコードしない（Python 3.7 以降の `quote` は `~` を無予約文字として扱う。`encodeURIComponent` と一致する）。
- 英数字と `- _ . ~` はそのまま、それ以外は UTF-8 バイト列の大文字 16 進 `%XX`。

4 要素（`store_id` / `terminal_id` / `bill_no` / `datetime`）の実データは数値と `2026-08-17T20:52:19` 形式の文字列であり、この範囲では `encodeURIComponent` との差は現れない。差が出るのは店舗コードや端末 ID に記号が入った場合だけだが、**規則の正本は上流の `quote`（`safe="/"`）** であり、example test でこの差分（`/` と `! * ' ( )`）を固定する。

### 3. 宛先解決（`src/registry/code-index.ts`）

`reverse-index.ts`（identity → 店舗）と同型に置く。基数だけが違う——コードは一意ゆえ単数、identity は複数店舗に届きうる。

```ts
export type CodeIndex = ReadonlyMap<string, StoreId>;

/** 全店のイデアから索引を再導出する（buildReverseIndex と同型・純粋・決定的）。 */
export function buildCodeIndex(stores: readonly Store[]): CodeIndex;

/** 索引の単一読み出し（storesForIdentity と同型・基数は単数）。 */
export function storeForCode(index: CodeIndex, storeCode: string): StoreId | undefined;

/** Store_Code の衝突を列挙する（detectAmbiguousAssignment と同型）。 */
export function detectDuplicateStoreCodes(stores: readonly Store[]): readonly DuplicateStoreCode[];
```

非活性店舗も索引に載せる。Store_Code は全店で一意ゆえ逆引きは活性状態に依らず一意であり、閉店の判定は StoreTimerDO の既存ゲート（403）に任せる。索引を活性で絞れば「閉店だから届かない」の判断が 404 と 403 の二箇所に分かれる。

`StoreRegistryDO` 側は既存の `reverseIndexWrite` と同じ形で `codeIndexWrite(stores)` を持ち、イデアと同一の put-first の確定に含める（導出値を正本から常に再導出できる状態に保つ）。

### 4. Store_Code の一意性と不変性（`StoreRegistryDO`）

`ProvisionFailure` に 2 種を足す。

```ts
| { readonly kind: "store-code-in-use"; readonly storeCode: string; readonly storeId: StoreId }
| { readonly kind: "store-code-immutable"; readonly storeId: StoreId; readonly storeCode: string }
```

不変性の強制は既存コードの挙動を 1 箇所変える。現状 `resolveBulkElement` は既存 `storeCode` を優先して変更要求を**黙って無視**している（`existing?.storeCode !== undefined ? { storeCode: existing.storeCode } : ...`）。これを明示的な拒否に改める——黙って無視すれば呼び出し元の意図を偽る。

重複検出は `commitIdeal` の直前に post-write の店舗集合へ `detectDuplicateStoreCodes` を掛ける。createStore と upsertStores の 2 箇所で同じ 1 つの純粋関数を通し、バッチ内の重複も同じ経路で捕まる。

**`updateStore` は現状 `storeCode` を一切触らない**（`store-registry-do.ts` の `updated` は `...existing` から組み、`body.storeCode` を読まない）。ここに 2 つの解釈がありうる。

| 解釈 | 挙動 |
| --- | --- |
| 未設定 → 設定を許す | `storeCode` を持たない既存店舗に後から付与できる。付与は「変更」ではない |
| 一切受け付けない | 付与も新規作成として扱う |

**前者を採る。** `storeCode` 省略の店舗を許す規律（AC 3.8）がある以上、後から POS 連携を始める店舗が実在する。それを新規作成に強いれば `StoreId` が変わり、既存の画面 URL と WS 接続が切れる。「不変」が守るのは*一度定めた対応が変わらない*ことであり、未設定から設定への遷移は対応を変えていない。

ゆえに `updateStore` は `body.storeCode` を読み、既存が未設定なら受理、既存と同値なら受理（冪等）、既存と異なれば `store-code-immutable` で拒否する。この受理は再生の契機にもなる（保留していた Record の宛先が定まる）。

### 5. 麺の仕様の解釈（`src/ingress/`）

POS の商品コードから 3 つの事実を引く。判定と翻訳が同一の入力から導かれることが、この設計の要点である。

```ts
/**
 * 品目 1 件を解釈する。麺量（Noodle_Size）を持たない品目は null（茹でない）。
 *
 * 茹で対象の判定と slotSpan の決定を 1 つの関数で返すのは、両者が同じ入力から導かれるためである。
 * 分ければ「麺量が在るか」を二度問うことになり、判定基準が二箇所に分かれる。
 */
export function toNoodleSpec(
  orderItem: Record<string, unknown>,
  config: NoodleLookup,
): NoodleSpec | null;

interface NoodleSpec {
  readonly noodleType: string;
  readonly firmness: Firmness;
  readonly slotSpan: number;
}
```

`item_type` は判定に用いない（AC 6.23）。判定基準を「麺量コードの有無」ただ一つに保つ。`child_items` の各要素の意味は `plu_no` から引き、配列内の位置に依らない——位置に依れば、軸の指定が欠ける注文で解釈がずれる。

硬さの指定が無い品目の `firmness` は既定（`normal`）へ畳む。これは設定の欠落を畳むのではなく「POS が指定を送っていない」という入力の形に対する既定であり、`noodlePresets` に無い麺種を畳まない規律とは層が違う。

### 6. `StoreConfig` の拡張と検証

2 枚の表を足す。関心事ごとに分け、1 枚に畳まない（既存の `noodlePresets` を含めれば麺に関わる表は 3 枚になるが、あちらは変更しない）。

```ts
interface StoreConfig {
  // …既存 12 項目…
  /** 硬さの商品コード → Firmness。茹で秒は持たない（秒は noodlePresets が唯一の出所）。 */
  readonly firmnessCodes: readonly FirmnessCode[];
  /** メニュー（親品目の商品コード）→ 麺種と麺量。1 メニューがサイズ群を伴う組で増える。 */
  readonly menuItems: readonly MenuItem[];
}

interface FirmnessCode {
  readonly code: number;
  readonly firmness: Firmness;
}

interface MenuItem {
  readonly productCode: number;
  readonly noodleType: string;
  readonly sizes: NonEmptyArray<NoodleSize>;
}

interface NoodleSize {
  readonly code: number;
  readonly slotSpan: number;
}
```

`sizes` を `NonEmptyArray` にするのが小さな要点である。麺量を持たない品目は茹でないため、`MenuItem` は必ず 1 つ以上のサイズを持つ。「サイズ 0 個のメニュー」＝茹でるのか茹でないのか判らない状態を構築不能にする。

`noodlePresets` には畳まない。あちらは厨房の語彙（麺種と茹で秒）で、この 2 枚は POS の語彙（商品コード）であり、更新の契機が違う（麺の種類が増えたときと、メニューが増えたとき）。

### 6-a. 設定の投入経路に触る範囲

`StoreConfig` へ 2 項目を足すと、イデアから投影までの経路すべてに対応が要る。現状「外部から主張できるフィールド」は 4 項目（`unitCount` / `arms` / `toleranceRatio` / `noodlePresets`）に限られており、この 4 項目が 3 箇所で列挙されている。

| ファイル | 変更 |
| --- | --- |
| `src/domain/store.ts` | `StoreConfig` へ 2 項目。既定値（空配列）と検証関数（`toFirmnessCodes` / `toMenuItems`） |
| `src/registry/ideal.ts` | `StoreOverride` と `PolicyFields` へ 2 項目（後者は `ModedValue<T>` で包む） |
| `src/registry/compose.ts` | `CONFIG_FIELDS` へ 2 項目。合成の出口で検証関数を通す |
| `src/registry/validate.ts` | `ALLOWED_CONFIG_FIELDS` へ 2 項目。`validateFirmnessCodes` / `validateMenuItems` |

`compose.ts` の `CONFIG_FIELDS` が合成対象の正本であり、**ここに載せなければ常に既定（空配列）が供給される**。載せ忘れると「Provisioning_API では受理されるのに投影に現れない」という無言の欠落になる。`satisfies readonly (keyof StoreConfig)[]` が型で守るのはキー名の妥当性だけで、集合の網羅は守らない。

**合成規則は `noodlePresets` に倣い、層ごとの丸ごと置換とする**（要素マージをしない・要件4.4）。メニュー表を要素単位でマージすれば、チェーンの Policy が定めたメニューに店舗が 1 件足す形が可能になるが、そのとき「どの層がどの商品コードを定めたか」が読めなくなる。丸ごと置換なら、有効なメニュー表は常にただ 1 つの層が定めたものである。

検証は既存規律のとおり、未知フィールド・型不一致・値域外・必須欠落を黙って既定へ畳まず拒否し、拒否理由は短絡せず全件集約する。`menuItems` は入れ子（`sizes`）を持つため、`validateNoodlePresets` が `boilSeconds` の入れ子を検証する形に倣う。

**横断の整合（`menuItems[].noodleType ∈ noodlePresets`）は検証層で見ない。** 3 層の合成を経た後の組み合わせでしか判定できず、入口では片方だけが投入されうる（Policy がメニューを配り、店舗が `noodlePresets` を上書きする形が正当である）。ゆえに実行時に扱う——対応表に無い麺種の品目は取り込みの段で弾いて数える（AC 6.28）。入口で拒否すれば、正当な段階的投入が不可能になる。

`slotSpan` の値域は **1 以上 6 以下**とする。上限 6 は 1 ユニットのスロット数（`StoreConfig` の注記より 1 ユニット = 6 スロット）であり、1 品目がユニットを跨いで占有する形は現実の釜の構造に無い。0 や負値は「占有しない麺」という表現不能な状態ゆえ拒否する。

**この 2 枚は `configMessage` で client へ配る。** 現行の方針（`StoreConfig` の全項目を配信）に例外を作らないためである。`src/ingress/` を立てた論拠（client が知る必要のない POS 形を共有契約へ置かない）と緊張するが、両者は層が違う——`ArrivalRecord` は運搬の形であり、こちらは店舗設定の一部である。項目ごとに配信対象を選び直せば「client がどれを知っているか」が項目数だけ分岐し、設定が増えるたびにその表が伸びる。単純さを優先して配る。

### 7. StoreTimerDO の受け口

既存の `receiveOrder`（単一店舗の到着）と別の受け口を立てる。ボディの形が違い、冪等の鍵も違う。

```ts
async receiveRecords(records: readonly ArrivalRecord[]): Promise<ReceiveOutcome>;

/**
 * 受領の結果。**RPC ゆえ HTTP ステータスでは分類を運べない**——呼び出し元（Worker と
 * 再生）が失敗の種別で挙動を分ける必要があるため、判別可能な和型で返す。
 */
type ReceiveOutcome =
  // 確定した。件数は Worker が 1 バッチ 1 行のログにまとめるために返す。
  | { readonly kind: "settled"; readonly counts: ReceiveCounts }
  // 投影未受領。**一時的な状態ゆえ再試行に値する**（Requirement 11.15）。
  | { readonly kind: "unprovisioned" }
  // 非活性。恒久的ゆえ飛ばして数える（Requirement 11.13）。
  | { readonly kind: "deactivated" }
  // put が失敗した。何も確定していない。
  | { readonly kind: "persist-failed" };
```

**`unprovisioned` と `deactivated` を分けることが要点である。** 既存のゲート（`store-timer-do.ts` の `fetch`）はどちらも HTTP 403 で返すため区別できないが、性質が正反対である。

`createStore` が `commitIdeal` を終えた時点で Code_Index には店舗が載る。しかし投影の押し込みは `converge` の Alarm 継続（25 件/回）で非同期に進むため、**Code_Index に載った直後の到着は投影未達で拒否されうる**。これを `deactivated` と同じく「飛ばして数える」にすれば、店舗開設の瞬間に届いた注文が消える。ゆえに `unprovisioned` は一時的失敗として扱い、Worker は 5xx を返して上流の再送に委ね、再生は Alarm の次回に持ち越す。

`deactivated` は逆で、時間が経っても解消しない（再活性化は運用の判断であり、2 時間の窓に収まらない）。ゆえに飛ばして数える。

確定の規律は既存と同一である。`decide` が返す Effect 列を `runEffects` が実行し、`Persist` の成功の上にのみ broadcast が立つ。

### 7-a. engine のイベントを 1 つ足す（`RecordsReceived`）

**「新しいイベント種別を足さない」は成立しない。** 既存の `OrderArrived` / `OrderCancelled` を Record ごとに出す形は 3 つの理由で破れる。

1. **単一 `put` が保てない。** `decide` は 1 イベントにつき 1 つの `Outcome`（`Persist` を含む）を返す。N Record で N 回呼べば `Persist` が N 回生じ、AC 5.5 と Property 14 に反する。
2. **判定材料を進められない。** `lastSequenceByTerminal` は `TimerState` に属し、それを変えられるのは `decide` だけである（唯一の状態遷移）。しかし既存イベントは端末 ID も `sequence_number` も運ばない。
3. **「0 件かつ既存なし」を表現できない。** 到着イベントは `NonEmptyArray<PendingOrder>` を要求し、キャンセルは既存の除去を意味する。どちらでもない「集合は変えず判定材料だけ進める」遷移が既存の語彙に無い。

ゆえにイベントを 1 つ足す。**足すのは 1 種のみで、既存の遷移と割り当ての算術（`placeGroup`）はいずれも変更しない**（Requirement 13.5 の範囲に収まる）。

```ts
// engine/event.ts へ追加
| {
    readonly type: "RecordsReceived";
    /** 翻訳済みの受領単位。shell が店舗設定を用いて解釈した結果だけが届く。 */
    readonly received: readonly ReceivedOrder[];
    readonly now: EpochMillis;
  }

/** 1 Record の翻訳結果。engine は POS の語彙を知らず、この形だけを見る。 */
interface ReceivedOrder {
  readonly externalOrderId: string;   // Unique_Key から導出済み
  readonly terminalId: string;        // 判定材料のキー
  readonly sequenceNumber: string;    // 単調性の比較対象
  readonly items: readonly PendingOrder[];  // 空を許す（0 件は除去または無変更を意味する）
}
```

`items` を `NonEmptyArray` にしないのが要点である。空は「キャンセル、または麺を含まない注文」という**正常な入力**であり、型で禁じてはならない。既存の `OrderArrived` が非空を要求するのは 1 つの到着だけを扱うためで、受領単位では空が意味を持つ。

engine 内の 1 遷移でこう畳む。

```
for each received（到着順）:
  seq が判定材料以下 → 読み飛ばす（重複）
  seq が新しい → 判定材料を進めて:
      items 非空       → upsertOrder で置換
      items 空 かつ既存 → removeOrder で除去
      items 空 かつ無し → 集合は変えない
最後に settle を 1 回通し、単一の Persist を返す
```

**重複判定は engine の内側で行う。** 判定材料が engine 状態に属し、状態を見て決めるのが engine の役目である。shell が判定すれば、状態の読み出しが 2 箇所（shell と engine）に生じる。

**翻訳は shell 側に残る。** 麺の仕様の解釈には `StoreConfig` が要り、engine は `StoreConfig` を知らない既存の規律を保つ。shell が `toNoodleSpec` を通して `ReceivedOrder` を組み、engine は翻訳済みの事実だけを見る。

### 7-b. Record から Pending_Order への写像

属性の出所を 1 箇所に定める。

| 属性 | 出所 |
| --- | --- |
| `externalOrderId` | Unique_Key（4 要素から導出） |
| `itemIndex` | `order_items` における元の位置（欠番を許す） |
| `arrivalTime` | `arrival_timestamp_ms` |
| `tableId` | `payload.table_no` を文字列化（欠落・`0` は `null`） |
| `noodleType` / `firmness` / `slotSpan` | 商品コードからの翻訳（`toNoodleSpec`） |

**既存 `toPendingOrders` の全体拒否は本経路に持ち込まない。** あちらは「1 つのオーダーの品目群」の原子性を守るために 1 品目でも不正なら全体を `null` へ落とす。本経路では翻訳できない品目が正常に起こる——非麺の品目（丼・餃子・飲料）がそれで、実データでも 3 件中 3 件に含まれる。全体拒否を適用すれば、丼が付いたラーメンの注文がすべて弾かれる。

ゆえに品目単位で扱い、翻訳できた品目のみを写す。ただし対応表に無い麺種（`menuItems` にはあるが `noodlePresets` に無い `noodleType`）は取り込みの段で弾いて数える。`boilSeconds` を引けない品目を待ち行列へ入れれば、計画にも表示にも現れない項目が正本に溜まるためである。

**解釈が 2 段に分かれる点を明示する。** Unique_Key の導出・Poison の判定・店舗別の分配は Worker（店舗設定を要しない）、麺の仕様への翻訳は宛先 DO（`noodlePresets` と対応表を要する）。純粋関数はいずれも `src/ingress/` に置き、実行の場所だけが分かれる。

### 8. 冪等（重複排除）

`sequence_number` の**単調性**で弾く。台帳を持たない。

上流は同一 `store_id` のレコードがバッチ内でもバッチ間でも到着順で届くことを保証している（パーティションキーが `store_id`・並列度 1・Kinesis のシャード内順序）。ゆえに端末ごとに「最後に処理した `sequence_number`」を 1 つ持てば、それ以前は重複として弾ける。端末単位の鍵が店舗単位の保証の部分集合として安全なのは、同一端末のレコードが必ず同一 `store_id` に属するためである。

台帳を持たない理由は保持量である。168 時間分の `sequence_number` を持てば 100 店 × 3 端末 × 4 件/分 × 168 時間 ≈ 1,200 万件になる。単調性を使えば端末数分（100 店で 300 エントリ）で足りる。

比較は桁数を揃えた文字列比較で行う。KDS の sequence number は 56 桁の数値文字列で、桁数が同じなら辞書順が数値順に一致する。桁数が違う場合は短い方が小さい。`BigInt` へ変換する案もあるが、変換のコストと桁溢れの検討を要するうえ、比較にしか使わない値を数値へ写す理由がない。

**判定材料は engine の永続状態に含める。** 別キー（`seen:{terminalId}`）に置いて `Persist` と別の `put` にすれば、順序によって 2 つの結果が生じる。

| 順序 | 中間で失敗したとき | 帰結 |
| --- | --- | --- |
| 判定材料 → 状態 | 材料だけ進む | **欠落**。その注文は再送でも重複として弾かれ、永久に失われる |
| 状態 → 判定材料 | 状態だけ進む | 重複。再送で同じ注文がもう一度入り、`upsertOrder` が吸収する |

後者は Duplicate_Bias に沿うが、**単一の `put` で確定すればどちらも起きない。** `TimerState` に `lastSequenceByTerminal` を持たせ、`Persist` が状態ごと確定する。engine の割り当ての算術は変えないため Requirement 13.5 の範囲に収まる（スキーマ更新のみ）。

これは「engine が POS の語彙を知る」ことにはならない。`sequence_number` は上流が付与する不透明な順序の印であり、engine はそれを比較可能な文字列として持つだけである（`noodleType` のように意味を解釈しない）。

### 8-a. 保留と冪等の衝突を避ける不変

**保留が非空の間、当該 Store_Code は解決不能として応答する。** これは欠落を防ぐための不変であり、性能の工夫ではない。

衝突の経路はこうである。店舗登録の確定後、再生は Alarm 継続で非同期に進む。その間に Code_Index が既知に転じた Worker は新着（大きい `sequence_number`）を直接 StoreTimerDO へ届ける。判定材料が進む。後から再生された保留分（小さい `sequence_number`）は全件「重複」として弾かれ、消える。Requirement 11.6 の「同一の冪等・順序の規律で再生する」をそのまま適用すると、まさにこれが起きる。

```ts
async resolveStoreCode(storeCode: string): Promise<StoreId | undefined> {
  // 保留が非空なら未知として応答する。未知は Code_Memo に載らないため
  // （AC 4.4）、新着も保留へ積まれて到着順が保たれる。
  if (await this.hasUnrouted(storeCode)) return undefined;
  return storeForCode(await this.loadCodeIndex(), storeCode);
}
```

未知として応答することが同時に 2 つを満たす。新着が保留側へ流れて順序が保たれ、Code_Memo が「不在はキャッシュしない」規律ゆえ解決可能へ転じた瞬間から直接配送が始まる。**新しい状態を持たずに、既存の 2 つの規律の組み合わせで順序が守られる。**

### 8-b. この不変だけでは保留が詰まる（2 つの穴を閉じる）

§8-a は順序を守るが、それだけでは保留が永久に残る経路が 2 つ開いている。

**穴 1: 再生を起動する契機が消える。**

```
1. Worker: resolveStoreCode → 保留非空 → 未知
2. （その await 中）再生 Alarm が保留を空にして停止
3. Worker: holdUnrouted → 既知コードのキーに積む
4. 誰も再生しない。以降のバッチも「保留非空 → 未知 → 積む」を繰り返す
```

再生の契機が「店舗登録の確定」だけだと、次の登録まで放置される。**`holdUnrouted` は、当該 Store_Code が既に Code_Index に既知であれば同一リクエストの内側で再生を試み、応答を返す前に完了させる。** 上流は同一 `store_id` を直列に送るため、応答前に再生を終えれば次バッチとの順序も守られる。再生に失敗したときは一時的失敗として応答し、上流の再送に委ねる。

**穴 2: 再生中の追記が消える。**

再生が一覧を読み、RPC を await している間に `holdUnrouted` が追記する。RPC 復帰後にキーを空で上書きすれば、追記分が消える。ゆえに読み直してから削る。

**ただし「件数で削る」would be 誤りである。** 穴 1 の修正で `holdUnrouted` が同期再生を始めるため、Alarm 由来の再生と同時に 2 本走りうる（DO は単一スレッドでも await 境界で交互に進む）。両者が独立に件数で削るとこうなる。

```
1. Alarm 再生: [a,b] を読み、送信中（await）
2. hold: [c] を追記 → 既知ゆえ同期再生 → [a,b,c] を送り 3 件削る → 空
3. Alarm 再生: 復帰。sent=2 として現在の一覧（空、または追記された [d]）から 2 件削る
   → d が未送信のまま消える
```

**削除は件数ではなく「送り終えた最後の `sequenceNumber` まで」で行う**（identity ベース）。同一店舗内で `sequence_number` が昇順に届く前提（AC 10.8）があるため、この値で切れば送信済みの範囲が一意に定まる。2 本が同時に走っても、既に消えた要素を指すだけで未送信分は削られない。

```ts
const held = await this.loadHeld(storeCode);
if (held.length === 0) return;
const lastSent = await this.pushToStore(storeId, held);  // 送り終えた最後の seq
const current = await this.loadHeld(storeCode);           // 読み直す
// seq が lastSent 以下のものだけを落とす。件数では削らない。
await this.putHeld(storeCode, current.filter((h) => h.sequenceNumber > lastSent));
```

補助として**再生は同時に 1 本に限る。** in-memory の「再生中」フラグを持ち、再生中に来た `holdUnrouted` は追記のみを行う（走っている再生が空になるまで繰り返すため、追記分もそこで拾われる）。これは正しさの要件ではなく無駄な二重送信を減らすための工夫である——フラグは hibernate を跨げないが、identity ベースの削除が正しさを支えているため、フラグが失われても欠落は生じない。

**Alarm 由来の再生は保留が空になるまで再武装する。** 1 回の実行で全件を送り切ることを前提とせず、残りが在れば次の Alarm を張る（収束の `nextResidual` と同じ形）。

### 9. Unrouted_Record の保留と再生（`StoreRegistryDO`）

宛先が解決できない Record を捨てず保留する。

```
unrouted:{storeCode} → readonly HeldRecord[]（payload は解釈せず保つ）
```

生値で保持するのは、宛先が定まらない段階では麺の仕様の解釈に要る `noodlePresets` が得られないためである。解釈は再生時に行う——再生専用の解釈経路を持たず、通常の取り込みと同一の写像・冪等・順序の規律を通す。

再生の契機は 2 つある。店舗登録の確定（`createStore` / `updateStore` / `upsertStores` が `commitIdeal` を終えた後）と、既知コードへの `holdUnrouted`（§8-b の穴 1）である。

### 9-a. Alarm は 1 本しかない

`StoreRegistryDO` の `alarm()` は既に収束の残作業継続に使われている（`store-registry-do.ts`）。DO の Alarm は 1 本ゆえ、再生を「同じ Alarm 継続の規律に乗せる」とは**同一ハンドラで 2 つの残作業を多重化する**ことを意味する。3 点を守る。

**`setAlarm` は両者の要求の最小値にする。** 収束が 2 秒後を要求し、再生が即時を要求したなら即時を張る。後から張る側が先の要求を上書きすれば、上書きされた側の残作業が次の契機まで止まる。

**ハンドラは両方の残作業を見る。** `alarm()` は収束の残作業（`converge:residual`）と再生の残作業の両方を確認し、在るものを処理する。片方だけを見て早期 return すれば、もう片方が永久に残る。

**再試行回数を混ぜない。** 既存の収束は `alarmInfo.retryCount` を見て、上限近傍なら throw せず新規 Alarm を張り直す（`ALARM_REARM_THRESHOLD`）。再生の失敗でこのカウントを消費すれば、収束の再試行余裕が奪われる。再生は自身の失敗で throw せず、残作業に残して次の Alarm へ持ち越す（収束の `nextResidual` と同じ形）。

保持期間は 2 時間。上流の DLQ リプレイ可能期間（168 時間）には合わせない——再生に意味があるのは、その注文がまだ厨房で作られている可能性がある間だけである。件数上限は 1 Store_Code あたり 2000 Record とし、超過分は診断ログとカウンタを伴って破棄する（2 時間 × 4 件/分 × 3 端末 ≈ 1440 件を上回る余裕を持たせた値）。

**失効は保留の書き込み時と再生時に判定する。** 常設 Alarm を置かない——保留が無い間も DO を起こし続けることになり、hibernation の規律（待つなら寝かせる）に反する。書き込みと再生はいずれも当該キーを読む時点であり、そこで期限切れを落とせば十分である。

**再生時に値域窓を再評価し、窓の外に出た Record は再保留せず破棄する。** これがないと、保留 → 再生 → 窓外 → 再保留の循環が生まれる。

### 9-b. 契約違反の保留は別のキーに置く

Order_Arrival_Time の窓を外れた Record（Upstream_Contract_Violation）を `unrouted:{storeCode}` に混ぜてはならない。あちらの再生の契機は「店舗登録の確定」であり、Store_Code が既知の Record にはその契機が永遠に来ない。

```
contract-violation:{storeCode} → readonly HeldRecord[]
```

`HeldRecord` は 2 つのキーで共有する型で、保持を始めた時刻を添える。中身は検証済みの `ArrivalRecord`（`unrouted:` の場合）か検証前の生値（`contract-violation:` の場合——型違反の Record は `ArrivalRecord` を構築できないため）のいずれかを取る。同じ型で運ぶのは、失効・件数上限・観測の規律が同一だからである。

**このキーは再生されない。** 2 時間で失効し、破棄されるだけである。保持する意味は「上流のバグを調査するための証跡」であって、待ち行列へ入れることではない（窓の外にある時刻の注文は、入れれば並び順を壊す）。設計としては「保留」ではなく「隔離」と呼ぶほうが正確だが、規律（`put` 成功で確定してから受理・2 時間・件数上限・観測）は Unrouted_Record と共有する。

窓の検査は Worker で行い、`now` を純粋関数の引数として渡す（時計を純粋関数の内側に持ち込まない既存の規律）。

## Data Models

### 永続キーの追加

| キー | 値 | 所有者 | 種別 |
| --- | --- | --- | --- |
| `index:code` | `readonly [string, StoreId][]`（配列化した Map） | StoreRegistryDO | **導出値**（全イデアから再構築可能） |
| `unrouted:{storeCode}` | `readonly HeldRecord[]` | StoreRegistryDO | 一時保持（2 時間・再生される） |
| `contract-violation:{storeCode}` | `readonly HeldRecord[]` | StoreRegistryDO | 隔離（2 時間・**再生されない**） |

冪等の判定材料は独立したキーに置かない。`TimerState` に `lastSequenceByTerminal: Readonly<Record<string, string>>` として持たせ、`Persist` の単一 `put` で Pending_Order 集合と同時に確定する（§8）。別キーにすれば「判定材料だけ進んで注文が無い」という欠落が生じうる。

`HeldRecord` は `ArrivalRecord` に保留した時刻を添えた形とする（失効の判定に要る。`arrival_timestamp_ms` は上流の観測時刻であり、こちらが保持を始めた時刻とは別の事実である）。

`index:code` のキー名は per-store-provisioning の design.md に既に記載があり、`CODE_INDEX_KEY` として定数も宣言済みである（書き込み・読み出しが未実装だった）。本機能はその空席を埋める。

### `PendingOrder` の拡張

```ts
interface PendingOrder {
  // …既存 6 項目…
  /** 1 品目がスロット軸上で占める幅。Noodle_Size から翻訳して定める。 */
  readonly slotSpan: number;
}
```

timer-model.md の判定を通す。(1) 両者で共有される事実か——client が待ち行列を表示し、engine が計画を組むのに要るため共有される事実である。(2) god type にしないか——`slotSpan` は品目の事実であり、片側専用の関心事ではない。(3) 概念が別なら名前を分ける——`slotIds`（割り当てられた実体）とは要求と割当の関係で、別概念ゆえ別の名を持つ。

`TimerFact` には及ばない。`PendingOrder` は `TimerFact` とは別の契約である（domain/order.ts の冒頭が既にその判定を記録している）。

### スキーマ移行

engine の永続スキーマを v7 から v8 へ上げる。2 つが増える。

`PendingOrder.slotSpan` は `revivePendingOrders`（`src/engine/migrate.ts`）が欠如を 1 で埋める——v7 以前の待ち行列はすべて 1 スロット占有として解釈するのが、当時の実際の挙動に一致する。

`lastSequenceByTerminal` は欠如を空オブジェクトで埋める。v7 以前は本経路が存在せず、判定材料を持つ端末が無い。空から始めれば最初の Record が必ず受理され、以降は単調性が効く。

`StoreConfig` の 2 項目は投影（`StoreProjection`）に乗るが、永続投影は丸ごと置換されるため移行を要しない。未受領の店舗では表が空になり、茹で対象が 0 件になる（構造は成立する）。

## Error Handling

### 失敗の分類と写し

| 事象 | 分類 | 挙動 | HTTP |
| --- | --- | --- | --- |
| `path` / `payload` の欠落、`path` が空文字 | Poison_Record | 当該 Record を飛ばして継続 | バッチは 2xx |
| Unique_Key 4 要素の欠落・null・空 | Poison_Record | 同上 | バッチは 2xx |
| `sequence_number` の欠落 | Poison_Record | 同上（上流が除外済みゆえ本来届かない・Req 10.4） | バッチは 2xx |
| `arrival_timestamp_ms` が型として解釈できない | 隔離 | `contract-violation:{code}` へ（生値のまま） | 2xx |
| 未知の `path` | Permanent_Failure | 飛ばして数えて継続 | バッチは 2xx |
| Status_Path | 破棄（blackhole） | 別カウンタで数える | バッチは 2xx |
| 重複（`sequence_number` が単調でない） | 正常な入力 | 読み飛ばす（状態不変） | バッチは 2xx |
| 未知の Store_Code | 保留 | Unrouted_Record として保留（2 時間・再生される） | 2xx |
| `storage.put` 失敗・DO 到達失敗・タイムアウト | Transient_Failure | バッチ全体を落とす | 5xx |
| 全 Record が Permanent_Failure | — | バッチを受理 | 2xx |
| 認可失敗 | — | カウンタ + 診断ログ。保全を狙わない | 401 |
| ボディが `records` 配列を成さない | — | 同上 | 400 |
| POST 以外のメソッド | — | 何もしない | 405 |
| Record 件数が 1000 を超える | Transient_Failure | 何も確定しない。上流の bisect に分割させる | 5xx |
| 宛先店舗が未プロビジョニング（投影未達） | Transient_Failure | 一時的な状態ゆえ再試行に値する（§7） | 5xx |
| 宛先店舗が非活性 | Permanent_Failure | 飛ばして数える | 2xx |
| 対応表に無い麺種の品目 | — | 当該品目のみ写さず数える。Record は受理 | 2xx |
| `arrival_timestamp_ms` が値域窓の外 | 隔離 | `contract-violation:{code}` へ 2 時間（再生しない） | 2xx |

「どの Record まで確定したか」は応答に含めない。上流は部分成功を扱わずバッチ単位の retry と bisect で絞り込むため、報告しても使われない。

### 素通し原則が守る境界

拒否事由は「retry しても直らず、かつ処理を続けられない」の 1 つに限る。未知フィールド・想定外の値・想定と異なる型はいずれも拒否事由にしない。

適用対象は `payload`（ベンダー由来の申告値）のみである。`path`・`arrival_timestamp_ms`・`sequence_number` は上流が観測から付与するメタデータで層が違い、これらに構造・型の要件を課すことは素通し原則の例外にあたらない。

## Correctness Properties

`online-cook-scheduling` design の記法に揃える。

### Property 1: 解釈は全域である

*For any* 生値について、`toArrivalBatch` は検証済みの `ArrivalBatch` か `null` を返し、例外を投げない。同じく **`toRecordOutcome` は任意の生値と任意の `now` に対し 5 種のいずれかを返し、例外を投げない**（分類も解釈の一部である）。上流が何を送っても受け口が落ちない。

**Validates: Requirements 1.11, 14.1**

### Property 2: 素通しは payload に閉じる

*For any* Record と、その `payload` へ加えた任意の未知フィールド・型違い・想定外の値について、当該 Record は拒否されない。拒否されるのは **4 構造**（`path` が非空文字列・`payload` がオブジェクト・`arrival_timestamp_ms` が非負整数・`sequence_number` が非空文字列）**か Unique_Key 4 要素が欠けたときのみ**である。

4 構造のうち破れ方によって結末が分かれる——`path` / `payload` / `sequence_number` の欠落は毒（飛ばして数える）、`arrival_timestamp_ms` の型違反は上流の契約違反（隔離する）。いずれも `payload` の中身に対する検証ではないため、素通し原則の例外にあたらない（Requirement 14.10・14.11）。

**Validates: Requirements 14.2, 14.3, 14.4, 14.6, 14.10, 14.11**

### Property 3: Unique_Key は決定的で上流と一致する

*For any* payload について、`toUniqueKey` は常に同一の値を返す。かつ上流のエンコード規則（各要素をパーセントエンコードして `:` で連結）と同一の文字列になる。

**Validates: Requirements 6.1, 6.2**

### Property 4: 判定と翻訳は同じ入力から導かれる

*For any* 品目について、`toNoodleSpec` が非 `null` を返すことと当該品目が麺量コードを持つことは同値である。茹で対象でありながら `slotSpan` が定まらない状態、および茹でないのに `slotSpan` が定まる状態はいずれも存在しない。

**Validates: Requirements 6.21, 6.22, 6.24**

### Property 5: Code_Index は正本から再構築できる

*For any* 店舗イデア集合について、`buildCodeIndex` は純粋・決定的に同一の索引を返す。索引を捨てて再導出しても結果が変わらない。非活性店舗も含まれる。

**Validates: Requirements 2.1, 2.2, 2.7**

### Property 6: Store_Code は全店で一意である

*For any* 確定したイデアについて `detectDuplicateStoreCodes` は空を返す。衝突する集合は必ず検出され、確定に至らない。

**Validates: Requirements 3.1, 3.2, 3.5, 3.6**

### Property 7: Code_Memo は結果を変えない

*For any* 入力について、memo が空の状態と温まった状態で宛先解決の結果が一致する。memo を全て捨てても振る舞いは遅くなるだけである。

**Validates: Requirements 4.2, 4.3, 4.4**

### Property 8: 確定は put 成功の上にのみ立つ

*For any* 状態変化について、受理を表す応答と broadcast はいずれも `Persist` の成功後にしか起きない。`put` が失敗した経路では Pending_Order 集合が変わらず、受理も broadcast も出ない。

**Validates: Requirements 5.6, 5.7, 11.3, 11.4**

### Property 9: 冪等は収束する

*For any* Arrival_Batch について、同一内容を何度再送しても初回受理と同一の確定状態へ収束する。2 回目以降は `put` も broadcast も新たに起きない。

**Validates: Requirements 10.2, 10.7, 9.9**

### Property 10: 欠落を作らない

*For any* 宛先未解決の Record について、受理として応答されるのは保留の `put` が成功したときのみである。保留できていないものを受理と主張しない。

**Validates: Requirements 11.1, 11.3, 11.4, 9.10**

### Property 11: 原子性の単位は Record 内の品目群である

*For any* Record について、そこから生じる Pending_Order 群は単一の `put` で確定し、部分受理を作らない。一方 Record 間には原子性が無く、Poison を含むバッチでも他の Record は確定する。

**Validates: Requirements 5.5, 9.2, 9.5**

### Property 12: 移行は既存の挙動を保つ

*For any* v7 の永続スナップショットについて、復元した Pending_Order の `slotSpan` は 1 になり、`lastSequenceByTerminal` は空になる（当時の実際の挙動と一致する）。

**Validates: Requirements 6.25, 13.5**

### Property 13: 保留が非空の間は直接配送されない

*For any* Store_Code と保留状態について、当該 Store_Code の Unrouted_Record が非空であるあいだ `resolveStoreCode` は未知を返す。ゆえに新着 Record は保留へ積まれ、再生される保留分より先に判定材料を進めることがない。

**Validates: Requirements 11.20, 11.21**

### Property 18: 保留は必ず再生の契機を持つ

*For any* 保留の書き込みについて、当該 Store_Code が Code_Index に既知であれば同一リクエスト内で再生が起動し、未知であれば店舗登録の確定が契機となる。**契機を持たない保留は存在しない。**

**Validates: Requirements 11.6**

### Property 19: 再生は送り終えた範囲だけを取り除く

*For any* 再生の並び（同時に複数本走る場合を含む）と、その RPC 中に生じた追記について、再生後に残る保留は「`sequenceNumber` が送信済みの最大値を超える要素」に等しい。件数による削除は行わないため、2 本が同時に走っても未送信の要素が消えることはない。

**Validates: Requirements 11.7**

### Property 20: 1 受領は 1 遷移・1 put である

*For any* Record 群（件数を問わない）について、`receiveRecords` が起こす `decide` の呼び出しは 1 回であり、`Persist` は 1 つ、broadcast も 1 回である。Record 数に比例して `put` が増えることはない。

**Validates: Requirements 5.5, 6.8, 10.7**

### Property 14: 判定材料と状態は同時に確定する

*For any* Record 群の受領について、`lastSequenceByTerminal` の更新と Pending_Order 集合の更新は同一の `Persist` に含まれる。判定材料だけが進んだ状態は生じない。

**Validates: Requirements 10.7, 5.5**

### Property 15: 未プロビジョニングは一時的失敗として表れる

*For any* 投影未受領の店舗への Record 群について、`receiveRecords` は `unprovisioned` を返し、Pending_Order 集合を変更しない。呼び出し元は再試行に値する失敗として扱う（恒久的失敗として飛ばさない）。

**Validates: Requirements 11.19**

### Property 16: 翻訳結果 0 件は除去または無変更に写る

*For any* Record と既存状態について、翻訳した茹で対象が 0 件であれば、当該 Unique_Key の Pending_Order が在るときは除去され、無いときは集合が変わらない。いずれの場合も判定材料は進む。

**Validates: Requirements 6.11, 6.12**

### Property 17: 窓外の Record は再保留されない

*For any* 保留された Record について、再生時に Order_Arrival_Time が値域窓の外へ出ていれば破棄され、再び保留されることはない（保留 → 再生 → 窓外 → 再保留の循環が生じない）。

**Validates: Requirements 11.22**

## Testing Strategy

| 対象 | 種別 | 検証すること |
| --- | --- | --- |
| Arrival_Batch の解釈 | PBT | 任意の生値に対し、返るのは検証済みの形か `null` のみ（例外を投げない） |
| Unique_Key の導出 | PBT | 同一 payload から常に同一の値。4 要素のいずれかが欠ければ `null` |
| Unique_Key の上流一致 | example | 上流のエンコード規則（パーセントエンコード + `:` 連結）と同一の文字列を得る |
| 麺の仕様の解釈 | PBT | 麺量コードを持つ品目のみ非 `null`。同一入力から同一の `slotSpan` |
| 麺の仕様の解釈 | example | 提示された実データ 3 件で、茹で対象が期待どおり（麺 2 件・非麺 3 件） |
| `buildCodeIndex` | PBT | 純粋・決定的。非活性店舗も含まれる。全イデアから再構築できる |
| Store_Code の一意性 | PBT | 衝突する集合を必ず検出する。重複が無ければ空を返す |
| Store_Code の不変性 | integration | 変更要求が 400（`store-code-immutable`）でイデアが不変 |
| Code_Memo | integration | 2 回目の解決でレジストリへ照会しない。未知はキャッシュされない |
| fan-out | integration | 複数店舗混在のバッチが各店の DO へ 1 回ずつ届く。同一店舗内は到着順 |
| 冪等 | integration | 同一バッチの再送で `put` も broadcast も起きず、確定状態が一致する |
| 失敗分類 | integration | Poison を含むバッチが 2xx、`put` 失敗が 5xx |
| 保留と再生 | integration | 未知 Store_Code が保留され、店舗登録で宛先へ再生される |
| 素通し | PBT | `payload` に任意の未知フィールド・型違いを混ぜても Record が拒否されない |
| Pass_Through の適用層 | static | `payload` の構造を型として書いた箇所が存在しない |
| スキーマ移行 | PBT | v7 の永続から `slotSpan` が 1、`lastSequenceByTerminal` が空で復元される |
| **保留 → 再生の順序** | integration | 保留が非空の間は直接配送されない。再生後に新着が通る。保留分が重複で消えない |
| **未プロビジョニング競合** | integration | `createStore` 直後（投影未達）の到着が 5xx になり、投影到達後の再送で確定する |
| **判定材料と状態の原子性** | integration | `put` を失敗させたとき、判定材料も Pending_Order も進んでいない |
| **後着で品目が減る／0 件** | integration | 3 品目 → 1 品目で置換される。0 件で除去される。初回 0 件で無変更 |
| **値域窓と契約違反** | integration | 窓外の Record が `contract-violation:{code}` へ隔離され、再生されず 2 時間で失効する |
| **失効と件数上限** | integration | 2 時間経過分が読み出し時に落ちる。上限超過が数えられて破棄される |
| **メソッドと件数上限** | example | POST 以外が 405、1001 件が 5xx |
| **対応表に無い麺種** | example | 当該品目のみ写らず数えられ、同一 Record の他の品目は確定する |
| **既知コードへの保留で再生が起動する** | integration | 保留が空になった直後に既知コードへ `holdUnrouted` が来たとき、応答前に再生される（詰まらない・§8-b 穴 1） |
| **再生中の追記が消えない** | integration | 再生の RPC 中に追記された Record が、接頭辞削除によって残る（§8-b 穴 2） |
| **N Record が単一 put になる** | integration | 10 Record の受領で `put` が 1 回、broadcast が 1 回（§7-b） |
| **Alarm の多重化** | integration | 収束の残作業と再生の残作業が同時に在るとき、両方が進む。再生の失敗が収束の `retryCount` を消費しない |

PBT は `fast-check`、DO を要する統合テストは `@cloudflare/vitest-pool-workers`（Workers pool）で走らせる。

### テスト置き場と `vitest.config.ts` の変更

`src/ingress/` の純粋層は workerd を要しないため node（既定 pool）で実行する。ただし**現行の `workers` プロジェクトは `include: ["tests/**/*.test.ts"]` で全テストを総取りしている**ため、新しい置き場を作るだけでは workerd 側でも走る。2 箇所に書く必要がある。

1. 新しい node プロジェクト（`name: "ingress"`, `environment: "node"`）を足し、`include` に `tests/ingress/**/*.property.test.ts` と `tests/ingress/**/*.example.test.ts` を指定する。
2. `workers` プロジェクトの `exclude` に同じ 2 つの glob を足す。

既存の `registry` / `worker` / `observe` プロジェクトがまさにこの形で切り分けられており、それに倣う。統合テスト（`tests/ingress/**/*.integration.test.ts`）は書かない——DO を要する検証は `tests/shell/` に置き、Workers pool に残す。

## 確定した判断（要確認事項からの移行）

requirements の `[Q11]` `[Q13]` `[Q14]` `[Q15]` `[Q17]` はいずれも確定した。以下はその根拠の記録である。残る `[Q8]`（対応表の値）は設定投入で後から与えられ、設計と実装を止めない。

### 保全より即時性を選ぶ（確定・[Q13] の帰結）

認可失敗は 401、ボディ不正は 400 をそのまま返す。データの保全を狙わない。上流は 4xx を `workerRejected` として数えてレコードを捨てるが、それを許容する。

根拠は待ち行列の性質である。**表しているのは「今まさに厨房が茹でるべきもの」であり、遅れて復旧したデータは害になる。** 数時間前の注文を後から入れれば、現場に存在しない注文が並ぶ。DLQ から 168 時間前のレコードを再生する価値は負である。

5xx の代償はより直接的である。上流の bisect が単一レコードまで割る間、同一バッチの他店舗も止まる。つまり 5xx は**現在の注文の即時性を、過去の注文の保全のために犠牲にする**——優先順位が逆立ちしている。

Duplicate_Bias と矛盾しない。あの規律が扱うのは「同じ注文が 2 回処理されるか 1 回も処理されないか」という**同時性**の分岐であり、ここで問うているのは**鮮度**の分岐である。別の軸ゆえ、別の判断になる。

**ただし捨てていることは見えなければならない。** 上流の `workerRejected` にアラームが無いため、こちら側に認可失敗のカウンタと診断ログを持つ。これが無ければ、secret のローテーションを片側だけ行った事故が無言で続く。この観測は Worker 内で完結し、DO を起こさない。

この判断は Unrouted_Record の保持期間にも及ぶ。**168 時間から 2 時間へ短縮した**（Requirement 11.8）。再生に意味があるのは、その注文がまだ厨房で作られている可能性がある間だけである。窓を短く保てば保留領域も小さくなり、件数上限に当たりにくくなる。

### 順序基準とバッチ件数上限（確定・[Q15] の帰結）

**順序基準は `sequence_number` の単調性ただ一つ。** 冪等の鍵と同一の基準に揃える。基準が 2 つあれば、どちらで見たかによって新旧の結論が変わる余地が生まれる。`arrival_timestamp_ms` はミリ秒の同着がありうるため順序基準に用いない。

**バッチ件数上限は 1000 Record。** 超過は Transient_Failure（5xx）として返し、上流の bisect による分割で通過させる。100 店規模なら 1 バッチに全店が混在しても数百 Record であり、DO への RPC は店舗ごとに 1 回ゆえ Worker の subrequest 上限（Paid プランで 1000）に収まる。実測で調整する前提とする。

### 非活性（deactivated）店舗への到着（確定・[Q14] の帰結）

Code_Index には載っているため宛先は解決でき、StoreTimerDO の既存ゲートが 403 を返す。**保留せず飛ばして数える。**

保持期間が 2 時間である以上、閉店店舗が その間に再活性化される見込みは薄く、保留しても破棄されるだけである。保留すれば再生の契機（再活性化）を定める必要が生じ、その経路は誰も通らないままテストもされずに残る。閉店処理後の到着は業務上ありえない事象ゆえ、カウンタで気づける形にとどめる。

活性判定は StoreTimerDO の既存ゲートに委ね、本機能で新たな判定を足さない（判定を二箇所に置かない）。

### `arrival_timestamp_ms` の値域（確定・[Q17] の帰結）

窓は「受理時刻の 2 時間前から受理時刻まで」。Unrouted_Record の保持期間と同じ値であり、根拠も同じ——その注文がまだ厨房で作られている可能性がある範囲だけが有効である。

下限を固定値（`2020-01-01` など）にしない。コードに時代を焼き付けるうえ、10 年後には無意味な下限になる。受理時刻からの相対なら、窓の意味が時間とともに劣化しない。

上限は受理時刻とする。上流が保証する遅延予算は 15 秒であり、受理時刻より後の到着時刻は時計のずれを超えた異常である。

窓の外にある Record は、型として解釈できない値と同じ隔離キー（`contract-violation:{storeCode}`）へ落とす。原因が同じ（上流が保証すべき値の異常）で扱いも同じゆえ、種別を分けない（§2 の `RecordOutcome`）。Order_Arrival_Time を推測で埋めない。

### 観測値の出力先（確定・[Q11] の帰結）

**構造化 `console.log`。** `wrangler.jsonc` の `observability.enabled` により Workers Logs へ入る。新しい binding は追加しない。

既存の Instrumentation_Log（`OBSERVE_DEBUG` ゲート）には載せない——既定 OFF であり、常時数えるカウンタには向かない。Operation_History にも載せない——あちらの出力対象は Timer 状態の確定差分であり、取り込みの件数は該当しない。Workers Analytics Engine は集計に向くが、binding の追加と書き込みの作用が増える。突き合わせの頻度が上がった時点で移設を検討する。

カウンタは 12 個。上流と同名にするもの（突き合わせのため）と、本経路固有のものを分ける。

| カウンタ | 由来 | 数える事象 |
| --- | --- | --- |
| `poisonRecord` | 上流と同名 | 構造が欠けた Record |
| `unknownPath` | 上流と同名 | 既知でない `path` |
| `statusDiscarded` | 本経路固有 | Status_Path の破棄（配線前） |
| `unknownStorePending` | 本経路固有 | 宛先未解決による保留 |
| `doDedupeSkipped` | 本経路固有 | 単調性で弾いた重複 |
| `upstreamContractViolation` | 本経路固有 | 上流の契約違反（型・値域） |
| `unauthorized` | 本経路固有 | 認可失敗（4xx で捨てられる分） |
| `deactivatedStore` | 本経路固有 | 非活性店舗への到着 |
| `unknownNoodleType` | 本経路固有 | 対応表に無い麺種で写せなかった品目 |
| `heldExpired` | 本経路固有 | 保持期間の経過による保留の破棄 |
| `heldOverflow` | 本経路固有 | 件数上限の超過による保留の破棄 |
| `replayWindowExpired` | 本経路固有 | 再生時に値域窓の外へ出た Record の破棄 |

破棄の 3 つを 1 つに畳まないのは原因が異なるためである。`heldExpired` は登録の遅れ、`heldOverflow` は不正送信または大量の登録漏れ、`replayWindowExpired` は再生の遅れを示す。畳めば「保留が破棄された」しか分からず、どこを直すべきかが読めない。

上流の `dedupeSkipped` と `doDedupeSkipped` を別名にするのは、前者が「`seen` マーカーで弾いた」件数であり別の事象だからである。同名にすれば障害時に人が混同する。

**出力の地点を Worker に集める。** `doDedupeSkipped` と `unknownNoodleType` は DO の内側でしか分からないため、`ReceiveOutcome.counts` に載せて返し、Worker が 1 バッチにつき 1 行のログへまとめる。DO 側で個別に `console.log` すれば、1 バッチで最大 1000 行が出て、しかも店舗ごとに分散して読めなくなる。1 リクエスト 1 行なら、そのバッチで何が起きたかが 1 行に収まる。

`deactivatedStore` も同様に `ReceiveOutcome` の種別から Worker が数える。

### 公開シンボルの確認（naming.md の要求）

事前承認済み: `CodeIndex` / `buildCodeIndex` / `storeForCode` / `resolveStoreCode` / `slotSpan` / `store-code-in-use` / `store-code-immutable` / `POST /pos/records`。

本 design で新たに提案するもの。

| シンボル | 置き場 | 概念境界 |
| --- | --- | --- |
| `ArrivalBatch` | `src/ingress/` | 上流が送る 1 リクエストのボディ |
| `ArrivalRecord` | `src/ingress/` | その 1 要素（`payload` は生値のまま） |
| `toArrivalBatch(raw)` | `src/ingress/` | ボディの生値 → `records` 配列を成すか（成さなければ `null` → 400） |
| `toArrivalRecord(raw)` | `src/ingress/` | Record の生値 → 4 構造を通った形 または `null`（検証規則の単一の関門） |
| `toUniqueKey(payload)` | `src/ingress/` | 4 要素 → 識別子（上流のエンコード規則と一致） |
| `groupByStoreCode(records)` | `src/ingress/` | Record 列 → 店舗別の組 |
| `toNoodleSpec(orderItem, lookup)` | `src/ingress/` | 商品コード → 麺の仕様（茹でないなら `null`） |
| `NoodleSpec` | `src/ingress/` | 翻訳の結果（`noodleType` / `firmness` / `slotSpan`） |
| `detectDuplicateStoreCodes(stores)` | `src/registry/code-index.ts` | Store_Code の衝突の列 |
| `DuplicateStoreCode` | `src/registry/code-index.ts` | 衝突 1 件 |
| `HeldRecord` | `src/registry/` | 保留・隔離された Record（保持を始めた時刻を添える） |
| `RecordOutcome` | `src/ingress/` | 1 Record の分類（Transient は含めない） |
| `ReceiveOutcome` / `ReceiveCounts` | `src/shell/` | 受領の結果（RPC ゆえ判別和型で運ぶ）と件数 |
| `receiveRecords(records)` | `StoreTimerDO` | 本経路の受け口（RPC） |
| `holdUnrouted(storeCode, records)` | `StoreRegistryDO` | 保留の受け口（RPC） |
| `firmnessCodes` / `FirmnessCode` | `src/domain/store.ts` | 硬さの商品コード → `Firmness` |
| `menuItems` / `MenuItem` / `NoodleSize` | `src/domain/store.ts` | メニュー → 麺種と麺量 |
| `KNOWN_RECORD_PATHS` | `src/ingress/` | 既知 `path` の集合（判別基準の単一の出所） |
| `POS_RECORDS_PATH` | `src/worker.ts` | 受け口のパス（ローカル定数） |
| `RecordsReceived` | `src/engine/event.ts` | 1 店舗分の受領を単一遷移として運ぶイベント（§7-b） |
| `ReceivedOrder` | `src/engine/event.ts` | 1 Record の翻訳結果（engine が見る唯一の形） |
| `lastSequenceByTerminal` | `TimerState` | 端末ごとの冪等の判定材料（§8） |

確認を要する主な点は 3 つである。

**`src/ingress/` の新設。** 上流ペイロードの解釈だけを持つ場所であり、`src/domain/` にも `src/registry/` にも収まらない（§Architecture）。

**`StoreConfig` の 2 項目が `src/domain/store.ts` に入る。** POS の語彙（商品コード）が domain へ入ることを意味する。`StoreConfig` は既に「店舗設定の契約」であり投影として client へも配られるため、**この 2 枚も配る**（§6 の末尾）。項目ごとに配信対象を選び直せば「client がどれを知っているか」が項目数だけ分岐する。`src/ingress/` を立てた論拠（client が知る必要のない POS 形を共有契約へ置かない）と緊張するが、層が違う——`ArrivalRecord` は運搬の形、こちらは設定の一部である。

**engine にイベント 1 種を足す。** 「新しいイベント種別を足さない」という当初の想定は成立しなかった（§7-b に 3 つの理由）。足すのは 1 種のみで、既存の遷移と割り当ての算術は変更しない。
