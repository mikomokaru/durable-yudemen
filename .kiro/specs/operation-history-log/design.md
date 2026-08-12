# 技術設計書 — 操作履歴ログ（operation-history-log）

## Overview

本機能は、確定した Timer 操作を best-effort telemetry として観測し、R2 を経由して Snowflake で店舗の生産能力と傾向を推定可能にする。正本は最新の `requirements.md` であり、Operation Record は Timer 状態の正本、復旧元、完全履歴ではない。

最優先事項は Timer 本体への非干渉である。`StoreTimerDO` は、既存 Timer イベントが起動した同じ invocation で、既存の Timer Persist、Working Copy 更新、Alarm、Broadcast、応答が通常完了した後に限り、確定差分から Canonical JSON Line を組み立てて同期 `console.log` を試行する。record 構築、直列化、console の失敗はその場の `try/catch` で捨て、既存の戻り値または例外へ伝播させない。観測の待機、再試行、非同期資源、永続状態は持たない。

第一搬送経路は次の一方向である。

```text
StoreTimerDO console → Tail Worker → Queue → Consumer → R2 → Snowpipe → Snowflake
```

Tail Worker を利用できない環境では、観測できたログだけを `Logpush → R2 → Snowpipe → Snowflake` で搬送する。どちらの経路も Producer または `StoreTimerDO` を呼び戻さない。

### Goals

- 観測 ON/OFF と観測失敗の全てで、TimerState、Timer Persist、Working Copy、既存 Effect とその順序、Alarm、Snapshot、応答、既存例外を不変にする。
- Timer Persist に成功した確定差分だけを、本体の通常完了後に一差分一行で出力試行する。
- 既存理由の rehydrate に伴う Reconcile で running から boiled を Persist した場合だけ、同じ constructor invocation 内で boiled を出力試行する。
- canonical printer、未知属性許容 parser、行単位失敗を純粋ロジックとして定義する。
- 下流で重複、欠落、孤児、競合を評価し、品質閾値を満たす範囲だけを信頼済み分析に使う。
- R2 90日、Snowflake 25 UTC暦月、Observed telemetry の月次 99% / 15分、30分・60分通知、機密業務データのアクセス制御を設計に含める。

### Non-goals

- Timer 状態と telemetry を一体で確定または rollback しない。
- Operation Record を権威履歴、復旧元、連番付き台帳にしない。
- `Record_Seq`、`seq`、`nextSeq`、outbox、配送状態、再送状態を Operation Record または `StoreTimerDO` に持たない。
- `StoreTimerDO` に観測専用 KV、storage key、counter、Alarm、Queue binding、Promise、`waitUntil`、timer、interval、connection を追加しない。
- 観測を Effect に追加せず、既存 Effect の型、集合、順序を変えない。
- 観測目的の construct、wake、rehydrate、storage read、Reconcile、Timer Persist を起こさない。
- 下流から Alarm、scheduled event、Queue callback、RPC、Worker 間 binding、HTTP、DO stub、WebSocket その他の経路で `StoreTimerDO` を呼ばない。
- `src/observe` の debug harness と型、flag、出力関数を共用しない。
- Producer が完全に出力できなかった telemetry の総数を推定しない。完全未観測率は測定不能として扱う。

## Architecture

### 現行実装に沿った挿入位置

現行 `StoreTimerDO` は `decide` が返す Effect を `runEffects` で順に実行する。状態変化がある Effect 列は `Persist → SetAlarm または ClearAlarm → Broadcast` であり、`Persist` の `storage.put` 成功後にだけ `workingCopy` を更新する。この列、`applySideEffect`、既存 Alarm 再試行規律、WebSocket 応答を変更しない。

観測に渡す材料は、各既存入口で読み取った次の値だけである。

- `decide` 直前の確定済み TimerState
- `runEffects` 正常復帰後の確定済み TimerState
- 既存イベント種別
- その `decide` に渡した一回採取済み `now`
- Effect 列に `Persist` が存在し、その実行が成功したという同じ invocation 内の結果
- 検証済み Store Id

観測は `runEffects` の内部 Effect には入れない。呼出し側は、Effect 列に `Persist` があり、`runEffects` が Persist 成功後の既存 Alarm/Broadcast まで通常完了した場合だけ、return の直前に同期出力を試行する。Effect 空の no-op、拒否、Persist 失敗、既存作用の例外では試行しない。

現行 `SetAlarm` / `ClearAlarm` は Promise を待たずに起動する。この既存挙動も変更しない。「Alarm の通常完了」は、現行の同期呼出しが throw せず戻ることを意味し、その Promise の完了待ちを新設する意味ではない。

`toWireTimer` が engine Timer から既存 TimerFact へ実効 `endTime` を射影する唯一の正本である。観測側は `endTime + adjustment` を再実装せず、この既存射影と `boiledAt` の必要値だけを読む。`TimerFact`、engine `Timer`、TimerState、ActiveTimersSnapshot には観測属性を追加しない。

### 全体構成

```mermaid
flowchart LR
  E[既存 Timer イベント] --> D[decide]
  D --> P[既存 Persist]
  P --> W[既存 Working Copy 更新]
  W --> A[既存 Set/Clear Alarm]
  A --> B[既存 Broadcast]
  B --> R[既存応答作用まで通常完了]
  R -. 同じ invocation の終端で同期試行 .-> L[Canonical JSON Line を console]
  L --> X[既存の正常 return]
  L --> T[Tail Worker]
  T --> Q[Queue]
  Q --> C[Consumer]
  C --> O[(R2)]
  O --> S[Snowpipe]
  S --> F[(Snowflake)]
  L -. Tail 利用不可 .-> G[Logpush]
  G --> O
  T -. 逆経路なし .-x E
  C -. 逆経路なし .-x E
```

破線の console 分岐は Timer の成功条件ではない。Producer 内で許可する外向き作用は `console.log(canonicalLine)` だけであり、Tail 以降は別の Worker または外部データ基盤として実行する。

### 通常操作 sequence

```mermaid
sequenceDiagram
  participant Client
  participant DO as StoreTimerDO
  participant Core as decide
  participant Storage as DO storage
  participant WS as WebSocket群
  participant Console

  Client->>DO: 既存 WebSocket message
  DO->>DO: nowを一回採取、beforeを参照
  DO->>Core: decide(before, event(now), params)
  Core-->>DO: next state + 既存Effect列
  DO->>Storage: Persist
  alt Persist失敗
    Storage--xDO: rejection
    DO-->>Client: 既存挙動のまま終了
  else Persist成功
    Storage-->>DO: success
    DO->>DO: Working Copy更新
    DO->>Storage: 既存Set/Clear Alarm（待機追加なし）
    DO->>WS: 既存Broadcast
    DO->>DO: 既存応答経路が通常完了
    DO->>Console: canonical lineを同期試行
    Note over DO,Console: 局所catch・非伝播・再試行なし
  end
```

Start は追加された Timer の確定後事実から `boil-started`、Adjust は対象 Timer の確定後事実から `adjusted`、Complete と Cancel は除去された Timer の確定前事実からそれぞれ `completed` と `cancelled` を作る。明示操作に伴う再同期で他 Timer の adjustment が変わっても、それを別の明示操作 record へ水増ししない。

### rehydrate / Reconcile sequence

```mermaid
sequenceDiagram
  participant Runtime
  participant DO as StoreTimerDO constructor
  participant Storage as DO storage
  participant Core as decide(Reconcile)
  participant Console

  Runtime->>DO: 既存理由でconstruct / wake
  DO->>Storage: 既存snapshotとprojectionをread
  Storage-->>DO: persisted values
  DO->>DO: Working Copyをrehydrate
  DO->>DO: Reconcile用nowを一回採取、beforeを参照
  DO->>Core: Reconcile(now)
  Core-->>DO: next state + 既存Effect列
  alt running→boiled差分をPersist
    DO->>Storage: 既存Persist
    Storage-->>DO: success
    DO->>DO: Working Copy更新
    DO->>Storage: 既存Set/Clear Alarm
    DO->>DO: 既存Broadcastを通常完了
    loop boiled差分ごと
      DO->>Console: 同じnowのboiledを同期試行
    end
  else no-op / Persist失敗 / 既存作用例外
    Note over DO,Console: 出力0件
  end
```

観測は constructor を起動しない。既存理由で constructor が動いた場合だけ、その Reconcile の結果を同じ `blockConcurrencyWhile` 内で観測し得る。Reconcile 用 Event Time は constructor が `decide` へ渡すために一回採取した `now` であり、後続 fetch または WebSocket message の時刻とは共有しない。

### Tail 搬送 sequence

```mermaid
sequenceDiagram
  participant DO as Producer / StoreTimerDO
  participant CF as Cloudflare runtime
  participant Tail as Tail Worker
  participant Queue
  participant Consumer
  participant R2
  participant Snowpipe
  participant Snowflake

  DO->>CF: console.log(canonicalLine)
  DO-->>CF: Producer invocation完了
  CF->>Tail: 完了済み実行のtail events
  Tail->>Tail: envelope filter + 行parser
  alt 妥当なOperation Record
    Tail->>Queue: send(record + 観測側metadata)
    Queue->>Consumer: delivery
    Consumer->>R2: put
    R2-->>Consumer: success
    Consumer-->>Queue: ack
    R2->>Snowpipe: object available
    Snowpipe->>Snowflake: ingest
  else 不正行
    Tail->>Tail: 行番号と失敗種別を観測側へ記録
  end
  Note over Tail,DO: ack・再出力要求・呼出しなし
```

Cloudflare 公式資料の要約:

- [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) は Producer Worker の実行終了後に自動起動し、その実行の console logs、例外等を受け取る。利用対象は Workers Paid / Enterprise tiers である。
- 同資料は Producer の Wrangler 設定に `tail_consumers` と接続先 Worker 名を置く構成を示す。Tail Worker は別 Worker であり、自身の bindings を利用できるため、Queue 送信は Tail 側に置く。
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) が Workers 設定 schema の公式参照先である。実装時はリポジトリ内の導入済み Wrangler schema と公式資料の両方でキーを検証する。
- [Logpush の R2 destination](https://developers.cloudflare.com/logs/logpush/logpush-job/enable-destinations/r2/) は Cloudflare logs を R2 へ直接送る構成を提供する。Tail を利用できない環境の縮退経路に使う。

### 失敗 sequence

```mermaid
sequenceDiagram
  participant DO as StoreTimerDO
  participant Existing as 既存Alarm/Broadcast/応答
  participant Observe as 同期観測試行
  participant Downstream as Tail以降

  DO->>Existing: Persist後の既存作用
  alt 既存作用が例外終了
    Existing--xDO: 既存例外
    Note over DO,Observe: 観測しない
    DO--xDO: 同じ既存例外を伝播
  else 既存作用が通常完了
    DO->>Observe: record構築・print・console
    alt 観測内で失敗
      Observe--xObserve: 局所catch
      Observe-->>DO: 戻り値・例外・Promiseなし
    else console成功
      Observe-->>DO: 同期return
    end
    DO-->>DO: 既存の正常return
  end
  par Producer完了後の下流障害
    Downstream--xDownstream: 下流内で保持・再試行・通知
  and StoreTimerDO
    Note over Downstream,DO: 呼戻し・ack・再出力要求なし
  end
```

## Components and Interfaces

### 1. StoreTimerDO の既存入口

観測対象入口は、状態変化を Persist し得る既存 WebSocket message、既存 Alarm、既存理由の constructor Reconcile である。通常 fetch の接続確立、projection 更新、debug instrumentation は Operation Record の対象にしない。

各入口は `decide` 前の state と一回採取した `now` を保持し、既存処理を最後まで実行する。観測成否を読まず、観測結果で分岐せず、観測を `finally` へ置かない。`finally` は既存例外経路でも観測を実行してしまうため禁止する。

### 2. 確定差分の純粋導出

純粋導出は platform API、storage、console を参照しない。必要な readonly 値だけを一つの平坦な入力で受け、Operation Record 列を返す。TimerState や Working Copy への書込み能力は渡さない。大きな wall/region 階層、汎用 sink、callback 抽象は作らない。

概念入力は次の内容で十分である。

```ts
// 擬似型。公開名は未確定であり、実装前にユーザー確認を要する。
type OperationObservation = {
  readonly storeId: string;
  readonly eventTime: number;
  readonly eventKind: "Start" | "Adjust" | "Complete" | "Cancel" | "AlarmFired" | "Reconcile";
  readonly before: TimerState;
  readonly after: TimerState;
};
```

実装では `before` / `after` を直接渡すか、必要な Timer 値を先に readonly の by-value へ写すかを最小差分で選ぶ。いずれの場合も導出関数は入力を変更せず、`workingCopy` setter、storage、env、`ctx` へ到達できない。

### 3. 同期 console 終端

同期終端は「純粋導出 → canonical printer → 一 record 一 `console.log`」だけを実行する。外側から待たれる Promise を返さず、Queue や R2 を知らない。各 record の一回目の試行で失敗したらその record を捨て、再試行しない。後続 record の試行可否を一件の失敗に連動させないため、record ごとに局所 `try/catch` を置く。

console の引数は Canonical JSON Line 一個だけである。接頭辞、追加 object、複数行のまとめ出力、debug line を混ぜない。

### 4. Tail Worker

Tail Worker は接続対象 Producer の完了済み tail events を受け、次の envelope filter を順に適用する。

1. 想定 Producer script の event である。
2. log level が `log` である。
3. console 引数列が一要素で、その要素が string である。
4. string が一行であり、Operation History Codec で妥当な Operation Record へ解析できる。

全条件を満たす行だけを Queue へ送る。未知の console 出力、`src/observe` の debug JSON、不正行は Queue に送らない。不正候補は tail event 内の位置を1始まり行番号として解析失敗種別と共に観測側へ残す。Tail 側の Queue binding、非同期送信、再試行は Data Platform の能力であり、Producer env には追加しない。

### 5. Queue と Consumer

Consumer は Queue message を R2 に保存し、保存成功後だけ Queue へ ack する。保存前 ack は行わない。Queue の再配送、dead-letter 方針、Consumer の失敗記録は全て Data Platform 内に閉じる。Consumer から Producer へ到達する routing、binding、stub、URL、WebSocket は構成しない。

R2 object は canonical line と観測側 metadata を保持できる。metadata の例は初回観測時刻、到着時刻、producer script、trace 情報、canonical hash である。これらは Operation Record の属性でも Timer 本体 identity でもない。

### 6. Snowpipe と Snowflake

Snowpipe は R2 object を Snowflake に取り込み、raw arrival、重複収束後 record、品質判定を分けて保持する。raw record は欠落、重複、孤児、競合の根拠なので品質判定後も削除しない。分析 view は Store Id と期間ごとに品質閾値を適用し、best-effort 推定であることを常に表示する。

### 公開シンボル候補と確認境界

以下は概念を説明する候補であり、確定名ではない。型、公開関数、設定 flag、Worker 名、binding 名、Queue 名を実装する前に、候補と概念境界をユーザーへ提示して確認を得る。

| 概念境界 | 候補名 | 表す範囲 |
| --- | --- | --- |
| 観測入力 | `OperationObservation` | store、event、before/after、eventTime の readonly 値 |
| record 判別共用体 | `OperationRecord` | kind ごとの閉じた既知属性 |
| 確定差分の導出 | `recordsFromCommittedDiff` | 純粋な before/after → record 列 |
| canonical 一行化 | `printCanonicalOperationLine` | known-only printer |
| 複数行解析 | `parseOperationLines` | 行別 record または失敗 |
| 同期終端 | `tryWriteOperationLines` | 局所 catch を持つ console 一点 |
| Tail event 抽出 | `operationLinesFromTailEvents` | envelope filter 後の文字列列 |

`Manager`、`Handler`、`Service`、`Util`、`process`、`handle` を新しい名前に使わない。候補 module の audience は Producer と Data Platform に限定し、client/server 共有の `TimerFact` へ観測関心を混ぜない。

## Data Models

### Operation Record

JSON の既知属性と固定順は次のとおりである。

| 順序 | 属性 | 制約 | kind |
| ---: | --- | --- | --- |
| 1 | `storeId` | 既存契約を満たす non-empty string | 全て |
| 2 | `timerId` | non-empty string | 全て |
| 3 | `operationKind` | `boil-started` / `boiled` / `completed` / `cancelled` / `adjusted` | 全て |
| 4 | `eventTime` | 0より大きい整数 epoch millisecond | 全て |
| 5 | `slotIds` | 1件以上の non-empty string、順序維持 | 全て |
| 6 | `noodleType` | non-empty string | 全て |
| 7 | `firmness` | 既存 domain 契約を満たす値 | 全て |
| 8 | `startTime` | 0より大きい整数 epoch millisecond | `boil-started` のみ |
| 9 | `endTime` | 0より大きい整数 epoch millisecond | `boil-started` / `boiled` / `adjusted` |
| 10 | `boiledAt` | 0より大きい整数 epoch millisecond | `boiled` のみ |

kind ごとの属性集合は閉じている。

- `boil-started`: 共通属性 + `startTime`, `endTime`
- `boiled`: 共通属性 + `endTime`, `boiledAt`
- `adjusted`: 共通属性 + 変更後 `endTime`
- `completed`, `cancelled`: 共通属性のみ

自然人へ直接対応する属性、`Record_Seq`、`seq`、`nextSeq`、残り時間、duration、progress その他の導出値は含めない。

### 差分から kind への写像

| 確定条件 | record | Timer事実の取得元 | 件数 |
| --- | --- | --- | ---: |
| Start で Timer が追加された | `boil-started` | 確定後 Timer | 追加ごとに1 |
| 任意の既存イベントで `boiledAt: null → value` | `boiled` | 確定後 Timer | 差分ごとに1 |
| Complete で Timer が除去された | `completed` | 確定前 Timer | 対象ごとに1 |
| Cancel で Timer が除去された | `cancelled` | 確定前 Timer | 対象ごとに1 |
| Adjust で対象の firmness または実効 endTime が変わった | `adjusted` | 確定後 Timer | 対象ごとに1 |
| rejection / no-op / Persist不在 / Persist失敗 / 本体例外 | なし | なし | 0 |

boiled の判定は起動元が AlarmFired か Reconcile かで分岐せず、running→boiled の確定差分だけを見る。複数 Timer が一括発火した場合は各 Timer を一行にする。Reconcile が Alarm の張り直しや再同期だけを Persist しても、running→boiled がなければ Reconcile record は0件である。

各 record の Event Time は、その差分を決めた `decide` に渡した `now` と同じ値である。観測側で時計を読み直さない。

### Canonical JSON Line

Printer は入力 object をそのまま `JSON.stringify` せず、kind に許可された既知属性だけを上表の順で新しい object へ写してから一回直列化する。これにより未知属性は出力されず、属性順が一意になる。文字列 escape と整数表記は標準 `JSON.stringify` に従う。

一行は UTF-8 の妥当な JSON object で、BOM、埋め込み改行、先頭末尾または区切り周辺の余分な空白を持たない。複数 record のテキスト表現は LF 一個で区切り、record と各 `slotIds` の相対順を保つ。

### Unknown-tolerant parser と行失敗

Parser は LF で行へ分け、最後まで全行を独立に解析する。JSON object の member 出現回数を保持できる字句・構文解析を行い、通常の `JSON.parse` だけで既知属性重複を見落とさない。未知属性は値を検証対象にせず捨てるが、既知属性は kind 別の必須・許可・型・値制約を検証する。

一行に複数の問題がある場合は、次の優先順位で一件だけ返す。

1. 不正 JSON
2. 既知属性重複
3. 必須属性欠落
4. Operation Kind 不許可属性
5. 既知属性型違反
6. 既知属性値違反

結果は1始まり行番号を持つ判別共用体とし、不正行の後続行も処理する。`parse(print(record))` は全既知値と `slotIds` 順を保存する。canonical line に限り `print(parse(line))` が UTF-8 byte 単位で一致する。未知属性を含む非canonical入力は parse 後に既知属性だけへ正規化されるため、byte 一致の対象ではない。

### Envelope filtering

Tail envelope 自体は Operation Record ではない。script、level、console 引数数と型を先に確認し、その後に文字列一行を parser へ渡す。Cloudflare trace metadata、tail timestamp、canonical hash は別の観測側列へ保存し、printer の known-only 出力へ混ぜない。

### 相関・重複・品質

一次相関候補は `(storeId, timerId, operationKind, eventTime)` で作り、`slotIds`、`noodleType`、`firmness` と kind 別時刻の整合を確認する。判定が曖昧な場合だけ canonical hash または trace metadata を補助に使う。補助値は Operation Record の identity、連番、Timer 永続 identity ではない。

同一と判定できる到達が `n` 件なら、raw arrival は `n` 件を保持し、分析用 record は1件、`duplicateCount = n - 1` とする。次を別々の品質状態として保持する。

- 欠落: 観測済み lifecycle から存在を復元できる期待 record がない。
- 孤児: boil-started または復元可能な開始事実へ相関できない。
- 競合: 同一一次候補に両立しない既知属性がある。
- 重複: 同一と判定できる record が複数到達した。

品質率の定義は requirements 5.9〜5.13 をそのまま Snowflake 計算の正本とする。分母0は数値0ではなく算出不能である。閾値超過または算出不能の店舗・期間は信頼済み分析から除外し、対象率と理由を表示する。

Producer が出力できなかった総数は下流から観測できないため、console log 自体の完全未観測率は測定不能である。lifecycle 内欠落率とは明確に分ける。

### SLO・保持・機密性

- `firstObservedAt`: Tail Worker または Logpush が妥当な record を初めて観測した時刻。
- `firstSnowflakeAt`: 重複除外前後を関連付けた Snowflake 初回到達時刻。
- 月次到達 SLO: `firstObservedAt` の UTC 暦月ごとに、重複除外後の母集団のうち15分以内に初回到達した割合を算出し、母集団1件以上なら99%以上とする。0件月は判定対象外である。
- 通知: Snowflake 未到達の最古 record が30分帯へ入った遷移から5分以内に警告を一回、60分以上へ入った遷移から5分以内に重大通知を一回出す。Store Id、Timer Id、kind、Event Time を含める。
- R2: 保存成功から90日で削除開始、24時間以内に完了する。
- Snowflake: 初回到達月を第1月とする25 UTC暦月終了後に削除開始、24時間以内に完了する。
- Operation Record は個人情報ではない機密業務データに分類する。record、品質指標、分析結果は承認済み分析担当者だけに許可し、拒否はデータと承認状態を変更しない。
- SLO 表示には母集団数、15分以内件数、率または対象外、Timer 操作成功を保証しない旨を併記する。

## No-wake / No-rehydrate Proof Obligations

非干渉は意図ではなく、次の証明義務としてレビューとテストに残す。

### O1: Producer capability の閉包

観測 module が参照できる作用は同期 `console.log` だけである。`cloudflare:workers`、`ctx`、env binding、storage、Alarm、Queue、R2、WebSocket、HTTP client、DO namespace を import または引数で受けない。純粋部分は platform 非依存である。

### O2: 起動原因ゼロ

観測機能は fetch route、WebSocket frame、Alarm、scheduled event、Queue callback、RPC、Worker 間 binding の受口を追加しない。したがって観測 ON が新しい Producer invocation を作る経路は存在しない。

### O3: 永続読書きゼロ

観測 module は storage key を定義せず、既存 state の readonly 値だけを同じ invocation 内で受ける。Operation Record のための storage read、write、list、transaction は0件である。rehydrate は既存イベント処理に必要な現行 `ensureLoaded` だけであり、観測から呼べない。

### O4: 逆方向到達不能

Tail Worker と Consumer の設定に `STORE_TIMER_DO` namespace、Producer URL、Worker 間 binding、DO stub 作成能力を与えない。Data Platform の IAM と network 設定にも Producer 呼出し権限を付けない。Queue ack は Consumer→Queue だけで終わる。

### O5: invocation 終了時の資源ゼロ

同期終端は Promise、`waitUntil`、timer、interval、subscription、connection、Alarm を作らない。局所 `try/catch` 後に保持される closure または mutable state もない。したがって Producer invocation 終了時の観測由来 live resource は0件である。

### O6: Reconcile の因果関係

boiled 出力の必要条件は、既存理由で constructor が起動済みであり、その constructor が採取した `now` で Reconcile を実行し、running→boiled を含む state を Persist し、既存作用が通常完了したことである。出力から constructor、rehydrate、Reconcile へ戻る edge は存在しない。

### O7: 比較 trace

同一の初期永続状態、外部イベント列、各 `decide` の時刻列に対し、観測 OFF、成功、record 構築失敗、printer 失敗、console 失敗を比較する。以下の trace が byte/value 単位で一致しなければならない。

1. `decide` の outcome、次 TimerState、既存 Effect 列
2. Persist 回数、payload、順序、成否
3. Working Copy の更新列と最終値
4. SetAlarm / ClearAlarm の引数と順序
5. Broadcast payload、宛先、順序
6. Snapshot、応答、正常 return
7. 既存例外の型、内容、発生位置
8. construct、wake、rehydrate、storage read、Alarm 予定のうち、観測に因果を持つ追加件数が0

プラットフォームが任意に instance を廃棄する時点は比較対象にしない。ただし観測コードまたは下流経路が廃棄以外の追加起動原因を作っていないことは O1〜O6 で別途検証する。

## Error Handling

| 失敗点 | Producer console | Timer 本体 | 下流 |
| --- | ---: | --- | --- |
| 入力不正 / `decide` rejection | 0 | 現行の破棄または error 応答 | なし |
| no-op / Persist Effect 不在 | 0 | 現行 state と応答 | なし |
| Timer Persist rejection | 0 | Working Copy 不変、現行後続中断 | なし |
| Alarm invocation の Persist 失敗 | 0 | 現行 retryCount による throw / rearm を維持 | なし |
| Persist 後の既存 Alarm 同期 throw | 0 | 同じ例外を伝播 | なし |
| Persist 後の Broadcast stringify / send throw | 0 | 同じ例外を伝播 | なし |
| record 構築失敗 | 当該record 0 | 正常結果を維持 | 欠落許容 |
| printer 失敗 | 当該record 0 | 正常結果を維持 | 欠落許容 |
| console throw | 当該record は失敗、再試行0 | 正常結果を維持 | 欠落許容 |
| Tail envelope / parser 失敗 | Producer 完了済み | 影響なし | Queueへ送らず失敗分類を保持 |
| Queue send 失敗 | Producer 完了済み | 影響なし | Tail / Queue 方針内で処置 |
| R2 put 失敗 | Producer 完了済み | 影響なし | ackせずQueue再配送方針へ |
| Snowpipe / Snowflake 失敗 | Producer 完了済み | 影響なし | staging、通知、再取込を下流内で実施 |
| Tail 利用不可 | 通常どおりbest-effort console | 影響なし | Logpush縮退、未観測のbackfillなし |

観測失敗の診断を Producer の別 console 行へ書くと tail filtering と本体コストを増やすため行わない。必要な診断は Tail 以降で保持する。複数 boiled のうち一行が失敗しても、後続差分は各一回だけ試行し、一度失敗した行を再試行しない。

## Correctness Properties

PBT は platform 作用を含まない純粋部分だけに適用する。`StoreTimerDO`、console、Tail 起動、Queue、R2、Snowpipe、Snowflake、保持、アクセス制御を mock で純粋 property に見せかけず、integration、static、deployment smoke test で検証する。

### Property 1: 確定差分と record の一対一対応

*For all* 有効な before/after TimerState、event kind、正の Event Time について、導出される record は定義済みの対象差分だけに対応する。Start/boiled/Adjust は after facts、Complete/Cancel は before facts を使い、対象差分ごとにちょうど一件、他は0件であり、全件の Event Time は入力値と一致する。

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.11, 2.12, 2.13**

### Property 2: Operation Record schema の閉包

*For all* Property 1 が生成した record について、既知属性集合は kind ごとの定義と完全一致し、全値制約を満たし、自然人属性、`Record_Seq`、`seq`、`nextSeq`、追加導出値を含まない。

**Validates: Requirements 2.16, 2.17, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

### Property 3: Canonical printer の一意性

*For all* 有効な record 列について、printer は存在する既知属性だけを規定順で出力し、標準 JSON の escape と整数表記を使い、BOM・埋め込み改行・余分な空白を持たない。複数行は LF 一個で区切り、record と `slotIds` の順序を保つ。

**Validates: Requirements 3.8, 3.9, 3.10, 3.11**

### Property 4: 未知属性に対する既知意味の不変性

*For all* 有効な JSON record と既知名に衝突しない任意の未知属性について、未知属性を追加した解析結果の既知属性と `slotIds` 順は追加前と一致する。

**Validates: Requirements 3.12**

### Property 5: 行 parser の失敗分類と継続性

*For all* 妥当行、不正 JSON、既知属性重複、必須欠落、不許可属性、型違反、値違反を混ぜた行列について、入力一行につき結果一件を入力順で返し、失敗は1始まり行番号と規定種別を持ち、後続行も失わない。

**Validates: Requirements 3.13, 3.14, 3.15, 3.16, 3.17**

### Property 6: Codec round-trip

*For all* 有効な record について `parse(print(record))` は既知属性値と `slotIds` 順を保存する。*For all* Canonical JSON Line について `print(parse(line))` は入力 UTF-8 bytes と一致する。

**Validates: Requirements 3.18, 3.19**

### Property 7: 相関候補の閉じた構成

*For all* record 集合について、一次候補に同居するのは Store Id、Timer Id、kind、Event Time が全て一致する record だけであり、Timer事実が両立しない候補を整合済みにしない。hash と trace metadata の有無は Operation Record identity を変えない。

**Validates: Requirements 5.1, 5.2, 5.3, 5.4**

### Property 8: 重複収束と品質状態

*For all* raw arrival multiset について、同一 record が `n >= 1` 件なら分析用一件、到達数 `n`、重複数 `n - 1` となる。欠落、孤児、競合、重複は別状態となり、判定前後で raw arrival multiset は変化しない。

**Validates: Requirements 5.5, 5.6, 5.7**

### Property 9: 品質率と信頼判定

*For all* 非負の lifecycle、arrival、candidate 集計と品質閾値について、4品質率は requirements の分子・分母に一致し、分母0は算出不能となる。全対象率が算出可能かつ閾値以下の場合に限り信頼済み分析へ含める。

**Validates: Requirements 5.9, 5.10, 5.11, 5.12, 5.13, 5.15**

### Property 10: UTC月次到達 SLO

*For all* Observed telemetry 到達列について、重複除外後の record は `firstObservedAt` の UTC 暦月へ一度だけ属し、15分以内件数と母集団から月次率を得る。母集団0の月は率を作らず判定対象外となる。

**Validates: Requirements 6.1, 6.2, 6.3, 6.4**

### Property 11: Tail envelope filtering

*For all* tail event envelope 列について、想定 script、`log` level、一引数 string、妥当な一行という全条件を満たす候補だけが、入力順を保って Queue 入力候補になる。

**Validates: Requirements 4.3, 4.4**

### 要件 mapping

| Requirements | 設計上の保証 | 主検証 |
| --- | --- | --- |
| 1.1〜1.4 | 同期 console 一点、局所catch、状態/配送能力なし、成功条件非結合 | O1〜O5、StoreTimerDO integration、static test |
| 1.5〜1.7 | Application trace、純粋遷移、既存型/Effect不変 | O7、golden type test、integration |
| 1.8〜1.11 | 起動原因・逆経路・live resourceゼロ、非決定廃棄の除外 | O2〜O7、runtime counter、deployment graph check |
| 2.1〜2.8 | Persist成功差分とkind写像、Reconcile制約 | Properties 1〜2、constructor integration |
| 2.9〜2.15 | 本体通常完了後、既存例外優先、時刻共有、観測起動ゼロ | sequence test、fault injection、O2・O6・O7 |
| 2.16〜2.17 | 属性限定、Store Id、自然人属性なし | Property 2、schema snapshot |
| 3.1〜3.19 | kind別shape、canonical、unknown tolerance、行失敗、round-trip | Properties 2〜6、失敗優先順位 example |
| 4.1〜4.4 | Tail第一経路、Producer完了後起動、filtering | Property 11、Tail fixture、plan smoke |
| 4.5〜4.8 | R2成功後ack、Snowpipe、Logpush縮退、backfillなし | Queue/R2 integration、deployment smoke |
| 4.9〜4.15 | 一record一console、Producer下流呼出し0、一方向、ack限定 | O1・O4、call trace、config graph test |
| 5.1〜5.7 | 相関、補助metadata、重複、品質状態、raw保持 | Properties 7〜8 |
| 5.8〜5.15 | best-effort表示、品質率、完全未観測率、閾値除外 | Property 9、report examples |
| 6.1〜6.6 | Observed telemetry SLO、30/60分通知 | Property 10、clock-controlled integration |
| 6.7〜6.9 | R2/Snowflake保持 | lifecycle policy smoke、境界test |
| 6.10〜6.13 | 機密分類、承認制御、SLO表示 | access integration、report snapshot |

## Testing Strategy

### 1. Pure property-based tests

Vitest v4 と fast-check v4 を使い、Properties 1〜11を純粋 module に対して各100回以上実行する。独自 generator framework は作らない。主な生成対象は次のとおり。

- 0..複数 Timer、全 operation kind、複数同時 boiled、before/after の追加・除去・変更
- Unicode、quote、backslash、制御文字、複数 `slotIds`、正整数 timestamp 境界
- 未知属性、既知属性重複、不許可属性、型・値違反、妥当/不正の混在複数行
- 重複 arrival の順列、欠落、孤児、競合、分母0、閾値境界
- UTC 月境界、15分ちょうど、その前後
- tail envelope の script、level、引数数、引数型、行妥当性の組合せ

PBT は純粋関数の入力と出力だけを検証する。console、storage、Queue、R2、時計 API、Cloudflare runtime を property generator へ持ち込まない。

### 2. Codec example / edge tests

- 複数の失敗条件を同じ行へ入れ、規定優先順位の最初だけを返す。
- 未知属性の重複は無視し、既知属性の重複だけを拒否する。
- empty line、BOM、CRLF、埋め込み改行、末尾LFの扱いを契約どおり固定する。
- `boil-started` / `boiled` / `adjusted` / `completed` / `cancelled` の golden bytes を固定する。
- printer が input object の未知属性、`seq`、`nextSeq` を出力しない。

### 3. StoreTimerDO integration tests

Workers pool で観測 OFF と ON を同じ初期 snapshot、イベント列、時計列に対して実行し、O7 の全 trace を比較する。

- Start、Adjust、Complete、Cancel、AlarmFired、constructor Reconcile を含める。
- record 構築、printer、console の各 throw を独立注入する。
- rejection、no-op、Persist失敗は console 0件。
- Persist成功後、既存 Set/Clear Alarm、Broadcast、応答作用の後だけ console を試行する。
- 既存 Broadcast の stringify / send throw では console 0件で同じ例外を得る。
- Alarm Persist失敗時の retry/rearm 分岐と例外を観測 OFF と一致させる。
- Reconcile は既存 constructor でだけ実行され、running→boiled の各差分を一行、差分なしを0行とする。
- Reconcile と後続 WebSocket message が別々に採取した `now` を各 record に使う。
- TimerFact、Timer、TimerState、ActiveTimersSnapshot、Effect、Persist payload に観測属性がない。
- 観測後の未完了 Promise、timer、interval、connection、追加 Alarm が0である。

### 4. No-wake architecture tests

- Producer 観測 module の import graph に runtime capability と下流 client がない。
- root Producer 設定に Queue/R2 binding、観測用 DO binding、観測 Alarm がない。
- Tail / Consumer 設定に `STORE_TIMER_DO` と Producer 呼出し先がない。
- Tail または Consumer から Producer へ向かう URL、stub、RPC、WebSocket、scheduled/Alarm callback がない。
- 観測 ON/OFF の runtime counters で、観測に由来する construct、wake、rehydrate、storage read、Alarm 予定が全て0差分である。
- `src/observe` の型、flag、出力関数との import 共有がない。

### 5. Tail / Queue / R2 integration tests

- Producer 完了済み tail fixture から envelope filter を通る canonical line だけを抽出する。
- 不正行は Queue 0件で、1始まり位置と失敗種別を観測側へ残す。
- Queue send failure は Producer trace に現れない。
- R2 put 成功後だけ ack、失敗時は ack 0件で再配送対象となる。
- duplicate delivery でも raw arrival を残し、分析用一件へ収束する。
- Tail/Consumer の全 fixture に Producer 逆呼出しがない。

### 6. Snowflake / 運用 integration tests

- R2 fixture を Snowpipe が取り込み、`firstObservedAt` と `firstSnowflakeAt` を関連付ける。
- 欠落、孤児、競合、重複を別状態で保存し、raw record を保持する。
- 品質閾値超過または算出不能の店舗・期間を信頼済み分析から除外する。
- 完全未観測率を測定不能と表示し、lifecycle 内欠落率と混同しない。
- 15分 SLO、母集団0、30/60分通知、一連続状態一回の時刻境界を検証する。
- R2 90日、Snowflake 25 UTC暦月の期限前後と24時間以内削除を検証する。
- 承認済み分析担当者だけが record、品質指標、分析結果を読める。拒否後もデータと承認状態が不変である。

### 7. Config / deployment smoke tests

- root `wrangler.jsonc` の `tail_consumers` が実在する Tail Worker を指す。
- Tail Worker の Queue producer binding、Consumer の Queue consumer / R2 binding を各設定正本で検証する。
- Queue→Consumer→R2 の疎通後にだけ Producer attachment を有効化する。
- Tail 利用プランと対象環境を事前確認し、不可なら Logpush→R2 の疎通を確認する。
- Logpush縮退で未観測期間の backfill job、Producer再出力、DO再起動が存在しない。
- Snowpipe stage、保持 policy、通知、access role を deployment smoke で確認する。
- root `wrangler.jsonc` 変更時は `pnpm cf-typegen` を実行し、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` を最終確認する。

## Deployment and Configuration Ownership

### 所有境界

| 設定 | 正本 | 所有者 | Producer への能力追加 |
| --- | --- | --- | --- |
| Producer本体、DO、`tail_consumers` attachment | root `wrangler.jsonc` | Timer application | Tail attachmentのみ。Queue/R2なし |
| Tail Worker、Queue producer binding | Data Platform側 Worker設定 | Data Platform | なし |
| Queue consumer、R2 binding、再配送/dead-letter | Data Platform側 Worker設定 | Data Platform | なし |
| Logpush job と R2 destination | Cloudflare account設定 | Data Platform | なし |
| R2 lifecycle 90日 | R2 bucket policy | Data Platform | なし |
| Snowpipe、Snowflake table/view、25 UTC月保持 | Snowflake設定 | Data Platform | なし |
| 品質閾値、15分SLO、30/60分通知、access role | Data Platform運用設定 | Data Platform | なし |

root `wrangler.jsonc` は Producer 設定の SSOT であり、実装時に公式 schema で検証した `tail_consumers` attachment を持つ。Tail、Queue、Consumer、R2 の設定を root Producer 設定へ同居させず、Data Platform 側の設定正本へ置く。これにより `StoreTimerDO` の env から Queue/R2/Consumer へ到達できないことを設定構造でも保証する。

設定キー、Worker 名、binding 名、Queue 名はこの設計で確定しない。実装時に導入済み Wrangler の `config-schema.json` と [公式 Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) を照合する。root `wrangler.jsonc` を変更したら generated `Env` 型を `pnpm cf-typegen` で更新する。

### Plan prerequisites

第一経路の前提は対象環境が Workers Paid または Enterprise で、Tail Workers を利用可能なことである。デプロイ前に account plan、Tail Worker 作成権限、対象 Producer への attachment 可否を確認する。利用不可なら第一経路を部分的に模倣せず、Logpush縮退を選ぶ。

Logpush縮退は観測できたログだけを R2 へ送る best-effort 経路である。Tail unavailable 期間の欠落を後から埋めず、Producer に Queue、outbox、再送、再出力入口を追加しない。対象 Workers logs dataset と R2 destination の利用可否は環境ごとに Data Platform が確認する。

### Rollout order

1. R2、Queue、Consumer、Snowpipe、Snowflake、保持、access role を下流だけで検証する。
2. Tail Worker と Queue 送信を fixture で検証する。
3. plan が満たされる環境では Producer の `tail_consumers` attachment を有効化する。
4. plan が満たされない環境では Logpush→R2 を有効化する。
5. 品質率と15分 SLOを観測し、閾値を満たす店舗・期間だけを信頼済み分析へ入れる。

attachment の無効化または Logpush job の停止は Timer 本体 state の migration や rollback を必要としない。Operation Record は best-effort なので、停止期間の backfill は行わない。

## Blockers / Open Questions

実装開始前の確認事項は次の二点だけである。旧設計由来の追加 blocker は置かない。

1. **公開命名確認**: `OperationObservation`、`OperationRecord`、`recordsFromCommittedDiff`、`printCanonicalOperationLine`、`parseOperationLines`、`tryWriteOperationLines`、`operationLinesFromTailEvents`、観測 ON/OFF 設定名、各 Worker/binding/Queue 名の候補を実装前にユーザーへ提示し、概念境界と共に確定する。
2. **Tail 利用プラン確認**: 対象 dev/stage/prod account が Workers Paid / Enterprise で Tail Workers を利用可能か確認する。不可の環境は Logpush縮退とし、対象 dataset と R2 destination の可用性を確認する。
