# Implementation Plan: hibernation 観測ハーネス（hibernation-observability）

## Overview

本計画は `design.md` の純粋／非純粋の境界に沿って、観測ハーネスをインクリメンタルに実装するための TypeScript / Cloudflare Workers + Durable Objects タスク列である。設計の中心は「観測の正しさそのものを純粋関数の property で保証する」ことにあるため、純粋層（`src/observe/`）を先に完成・検証してから、shell 計装・CLI 端・静的検査・デプロイ手順へ進む。

実装の順序は次のとおり。

1. **純粋層（`src/observe/`）を先に** — log codec（Operation_Log / Instrumentation_Log の直列化・解析）→ 引数検証（`validateProbeArgs`）→ シナリオモデルと検証（`validateScenario` / `orderedSteps` / `shouldStopAwaiting`）→ Correlator（`mergeByTime` / `classifyInstances` / `verifyAlarmFiredInIdle` / `verifyRehydrateCount` / `determineVerdict`）。いずれも時計も storage も WS も持たない決定的純粋関数なので、各 Correctness Property（P1〜P13）を fast-check の単一 property テストで検証する。
2. **shell 計装（`src/shell/store-timer-do.ts` を編集）** — 4継ぎ目（construct / rehydrate / alarm / broadcast）に `emitSeam` を差し込み、instanceId を採番し、debug flag でゲートする。**core（`src/engine/`）は一文字も変更しない。** 計装の統合検証は `@cloudflare/vitest-pool-workers` で行う。
3. **CLI 端（`tools/observe/`）** — Probe_Client（`connectProbe` / `ProbeConnection` / `send`）・Scenario_Runner（`runScenario`）・突き合わせ CLI。WS 接続・JSONL ファイル IO・実時間スケジューリング・終了コードはここに閉じる。
4. **静的検査** — core 無変更・4継ぎ目限定（`emitSeam` 4点）・`setInterval` 不在／`acceptWebSocket` 維持・既存ワイヤ形式のみ・CLI 出力英語のみ。
5. **Deploy_Procedure** — `tools/observe/` の README に手順を整備し、ライブ観測まで検証する。

設計哲学と規律をタスクの不変点として貫く。

- **計算と作用の分離** — Correlator・log codec・scenario 検証・引数検証は `src/observe/`（純粋・I/O 非依存）に置き、WS・ファイル・実時間・`console.log`・`wrangler` 実行は端（`tools/observe/`・shell）へ寄せる。
- **core/shell 分離を壊さない** — 計装は `src/shell/` と `tools/observe/`・`src/observe/` のみ。`src/engine/` を追加・変更・削除しない（要件4.5 / 9.5）。
- **SSOT 規律を計装でも崩さない** — 計装は継ぎ目で既に得られている値を読むだけで、Working_Copy・永続スナップショット・Effect 実行順序（Persist 先頭）を変えない（要件4.6）。
- **「待つなら寝かせる、抱えると漏れる」** — 計装に `setInterval` も終わらない `setTimeout` も持ち込まない。`ctx.acceptWebSocket` による hibernate 可能構成を維持する（要件4.7）。
- **既存ワイヤ形式のみ** — Probe_Client は `src/domain/messages.ts` の `ClientMessage` / `ServerMessage` のみで送受信し、新種別・新フィールドを足さない（要件9.6）。

ツールは確定スタックに従う（pnpm / TypeScript strict / Vitest + `@cloudflare/vitest-pool-workers` / fast-check / oxlint / Wrangler）。CLI のユーザー向け出力は英語のみ、コードコメントは日本語。Property-Based Testing は fast-check を採用し、各 Correctness Property（P1〜P13）を**単一の** property テストとして最低 100 回反復で実装し、各テストに `// Feature: hibernation-observability, Property {番号}: {本文}` のタグコメントを付す。

> **公開シンボル名の確認（命名規律）:** 本ハーネスの公開シンボル（`SeamKind` の値・判定区分 `HarnessVerdict`・分類カテゴリ `ConstructClass`・検証失敗理由・ログ entry 属性名・CLI コマンド名・debug flag の env キー `OBSERVE_DEBUG`・値表現など）は概念境界の表明であり、**実装着手前にユーザー確認を要する**（design.md「公開シンボル命名の確認」節）。タスク 1.1 でこれを確定してから後続のコードタスクへ進む。本計画中の名前はすべて暫定候補である。

## Tasks

- [x] 1. プロジェクト基盤と公開シンボル名の確定
  - [x] 1.1 公開シンボル名をユーザーと確認・確定する
    - design.md「公開シンボル命名の確認」節の 1〜8 を提示し、候補名・概念境界・既存ドメイン語彙との対応とともにユーザーの判断を仰ぐ
    - 確定対象: `SeamKind` の値（`construct` / `rehydrate` / `alarm` / `broadcast`）、シナリオ操作値（`start` / `cancel` / `wait` / `await-done`）、判定区分 `HarnessVerdict`（`confirmed` / `inconclusive` / `fail`）、再 construct 分類 `ConstructClass`（`hibernation-wake` / `cold-start-or-redeploy` / `initial-construct` / `unclassifiable`）、検証失敗理由（`NoAlarm` / `AlarmAfterDone`）、ログ entry 属性名（`seq` / `at` / `atIso` / `direction` / `messageType` / `payload` / `instanceId` / `restoredCount` / `seam`）、CLI コマンド名（`probe` 等）、debug flag の env キー名と値表現（暫定 `OBSERVE_DEBUG`・`"1"`）
    - 確定した名前を後続の全タスクで一貫して用いる（本計画の暫定名はすべて差し替え対象）
    - _Requirements: 9.6_

  - [x] 1.2 観測ハーネスのディレクトリとテスト基盤を用意する
    - `src/observe/`（純粋）・`tools/observe/`（端）・`tests/observe/`（テスト）のディレクトリを作成し、`src/observe/` が `cloudflare:workers`・`fs`・WS に依存しないことを構造で表現する（`src/worker.ts` から import されない＝デプロイ Worker バンドルに含めない）
    - `@cloudflare/vitest-pool-workers` の Workers pool で shell 計装の統合テストを駆動できるよう Vitest 設定を確認（`wrangler.jsonc` を唯一の出所とする）。純粋層テストは Workers pool 不要であることを設定に反映
    - PBT のタグコメント規約（`Feature: hibernation-observability, Property N: ...`）と「最低 100 回反復（fast-check `numRuns: 100` 以上）」を `tests/observe/` の README または設定に明文化
    - CLI の WS クライアントライブラリ（`ws` 等）は `tools/observe/` に閉じ、`src/observe/` には漏らさない方針を明記（追加は `pnpm add -D`）
    - _Requirements: 9.1, 9.2, 9.3, 9.5_

- [x] 2. 純粋層: log codec（Operation_Log / Instrumentation_Log の直列化・解析）
  - [x] 2.1 Operation_Log entry の型・直列化・解析・seq 付番を実装する
    - `src/observe/log.ts`: `OperationLogEntry`（`seq` / `at` / `atIso` / `direction` / `messageType` / `payload`）、`serializeOperationEntry`（改行を含まない 1 行 JSON）、`parseOperationLine`（JSON 不正・必須属性欠如は `ok:false` で `raw` 保持）、`parseOperationLog`（行順保持の `entries` と判別可能な `failures` に分離）、および起動時 0 から +1 の欠番・重複なし seq 付番
    - `at` は 0 以上の整数エポックミリ秒、`atIso` は UTC・末尾 `Z`・ミリ秒精度で `at` と同一時刻を表す
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 2.2 Operation_Log round-trip の property テストを書く
    - **Property 1: Operation_Log は直列化→解析で全属性を保存する（round-trip・JSON Lines 健全性）**
    - **Validates: Requirements 2.1, 2.2, 2.4, 2.7**

  - [ ]* 2.3 シーケンス番号の property テストを書く
    - **Property 2: シーケンス番号は 0 から欠番・重複なく単調増加する**
    - **Validates: Requirements 2.3**

  - [ ]* 2.4 解析の行順保存・不正行分離の property テストを書く
    - **Property 3: 解析は行順を保存し、不正行を分離しつつ有効行を保持する**
    - **Validates: Requirements 2.5, 2.6**

  - [x] 2.5 Instrumentation_Log entry の型・組み立て・直列化・解析を実装する
    - `src/observe/log.ts`（続き）: `SeamKind`（4継ぎ目限定）、`InstrumentationLogEntry`（`seam` / `at` / `atIso` / `instanceId`、`rehydrate` のみ `restoredCount`・`broadcast` のみ `messageType`）、`buildSeamEntry`（継ぎ目の値から entry を組み立てる純粋関数）、`parseInstrumentationLine`
    - 継ぎ目種別ごとに必要なフィールドのみを持つ（`restoredCount` は `rehydrate` のみ、`messageType` は `broadcast` のみ。不正な状態を構築不能にする）
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 2.6 Instrumentation_Log round-trip の property テストを書く
    - **Property 13: Instrumentation_Log は組み立て→直列化→解析で全属性を保存する（round-trip）**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

- [x] 3. 純粋層: 起動引数検証とシナリオモデル
  - [x] 3.1 起動引数の検証 validateProbeArgs を実装する
    - `src/observe/args.ts`: `ProbeArgs`（`ok:true` で `endpoint`/`storeId`、`ok:false` で `NotWssScheme` / `EmptyStoreId`）と `validateProbeArgs`。`wss://` スキームかつ空でない店舗識別子のときのみ受理。WS も `process` も触れない純粋関数
    - _Requirements: 1.1_

  - [ ]* 3.2 起動引数検証の property テストを書く
    - **Property 12: 起動引数の検証は wss スキームと非空店舗識別子に対してのみ成功する**
    - **Validates: Requirements 1.1**

  - [x] 3.3 シナリオの型・検証・整列・待機判定を実装する
    - `src/observe/scenario.ts`: `ScenarioStep`（`start` / `cancel` / `wait` / `await-done`）・`Scenario`（`steps` 1〜100・`idleIntervalSeconds` 1〜3600 整数秒）、`validateScenario`（範囲外は対応理由で `ok:false`・既存設定不変）、`orderedSteps`（相対時刻 `at` 昇順の安定ソート・同時刻は記述順保持）、`shouldStopAwaiting`（指定 `timerId` の `done` のみ `true`）
    - 実時間・`setTimeout` を持たない純粋関数。範囲は相対時刻 0〜3,600,000ms・`wait` 0〜600,000ms・`await-done` 1,000〜600,000ms・idle 1〜3600 整数秒
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 7.2, 7.3_

  - [ ]* 3.4 シナリオ検証と安定整列の property テストを書く
    - **Property 4: シナリオ検証は範囲内のみ受理し、範囲外を拒否して既存設定を変えず、整列は安定である**
    - **Validates: Requirements 3.1, 3.3, 3.4, 7.3**

  - [ ]* 3.5 await-done 終了判定の property テストを書く
    - **Property 5: await-done の終了判定は「指定 timerId の done」に限る**
    - **Validates: Requirements 3.4, 3.5**

  - [ ]* 3.6 idle interval 受理の example テストを書く
    - idle interval を 1〜3600 秒の整数秒パラメータとして受理し、範囲外・非整数を拒否することを具体例で固める
    - _Requirements: 7.2_

- [x] 4. 純粋層: Correlator（突き合わせと検証条件判定）
  - [x] 4.1 共通時刻軸マージ mergeByTime を実装する
    - `src/observe/correlate.ts`: `MergedRow` / `MergedSource` と `mergeByTime`。Operation_Log と Instrumentation_Log を epoch ms 昇順で安定マージし、同一 epoch ms の行は各入力の元の出現順を保持、出力長は両入力行数の合計に等しく欠落・重複なし、片方/両方 0 行でも保存性を満たし、同一入力に常に同一系列を返す
    - _Requirements: 6.1, 6.6_

  - [ ]* 4.2 共通時刻軸マージの property テストを書く
    - **Property 8: 共通時刻軸マージは保存的・安定・決定的である**
    - **Validates: Requirements 6.1, 6.6**

  - [x] 4.3 instanceId 区間の分類 classifyInstances を実装する
    - `src/observe/correlate.ts`（続き）: `ConstructClass` / `InstanceInterval` と `classifyInstances`。各 instanceId の出現区間を採番時刻昇順（同時刻は採番順）で安定整列し、先行 instanceId 無し＝`initial-construct`、対応 Operation_Log 欠落＝`unclassifiable`（他区間は継続）、区間内再接続 0 件＝`hibernation-wake`、1 件以上＝`cold-start-or-redeploy` に分類
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 4.4 instanceId 分類の property テストを書く
    - **Property 6: instanceId 区間の分類は再接続有無・先行有無・op 欠落で一意に定まる**
    - **Validates: Requirements 5.2, 5.3, 5.5, 5.6**

  - [ ]* 4.5 instanceId 区間の安定整列の property テストを書く
    - **Property 7: instanceId 区間は採番時刻昇順で安定整列される**
    - **Validates: Requirements 5.4**

  - [x] 4.6 検証条件 a / b（verifyAlarmFiredInIdle / verifyRehydrateCount）を実装する
    - `src/observe/correlate.ts`（続き）: `IdleInterval` / `ConditionA` / `ConditionB`、`verifyAlarmFiredInIdle`（idle 区間内で当該タイマーの `done` に対し `alarm` の epoch ms が `done` 以下で先行すれば `pass`、alarm 欠如は `fail(NoAlarm)`、順序逆転は `fail(AlarmAfterDone)`）、`verifyRehydrateCount`（idle 後最初のイベントで新 instanceId の `construct`→`rehydrate` の復元件数が直前 active 数と一致すれば `pass`、不一致は期待件数と観測件数を識別可能に `fail`）。直前 active 数は Operation_Log から導出
    - _Requirements: 6.2, 6.3, 6.4, 6.5_

  - [ ]* 4.7 検証条件 a の property テストを書く
    - **Property 9: 検証条件 a — idle 区間内の alarm→done 順序で合否が一意に定まる**
    - **Validates: Requirements 6.2, 6.3**

  - [ ]* 4.8 検証条件 b の property テストを書く
    - **Property 10: 検証条件 b — rehydrate 復元件数と直前 active 数の一致で合否が一意に定まる**
    - **Validates: Requirements 6.4, 6.5**

  - [x] 4.9 実行全体の判定 determineVerdict を実装する
    - `src/observe/correlate.ts`（続き）: `HarnessVerdict`（`confirmed` / `inconclusive` / `fail`）と `determineVerdict`・`OBSERVATION_TAIL_MS`(60,000)。観測ウィンドウ満了点（idle 経過時点 + 最大 60 秒）までに hibernation wake signal（新 instanceId + `rehydrate` の組）が無ければ `inconclusive`、有れば検証条件 a/b に従い `confirmed`（fail 無し）または `fail`。`inconclusive` は `fail` の集計に含めず三区分は相互独立
    - _Requirements: 7.1, 7.4, 7.5, 7.6_

  - [ ]* 4.10 実行判定の排他性の property テストを書く
    - **Property 11: 実行判定は confirmed / inconclusive / fail を排他に出力し、inconclusive を fail に含めない**
    - **Validates: Requirements 7.4, 7.5, 7.6**

- [x] 5. チェックポイント — 純粋層（src/observe/）の全テストが通ることを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. shell 計装（src/shell/store-timer-do.ts への最小の差し込み・core 不変）
  - [x] 6.1 instanceId 採番・debug flag ゲート・emitSeam を実装する
    - `src/shell/store-timer-do.ts`: `instanceId`（`crypto.randomUUID()` で constructor 一度のみ採番・存続期間中不変）・`instanceBornAt`、debug flag ゲート（env キーで有効/無効・無効時は即 return）、`emitSeam`（`src/observe/log.ts` の `buildSeamEntry` で組み立てた entry を `console.log(JSON.stringify(...))` で吐くだけ）。debug ゲートは `emitSeam` の一点に集約する
    - **core（`src/engine/`）を一切呼ばず変えない。** Working_Copy・永続スナップショット・Effect 実行順序（Persist 先頭）を不変に保ち、`setInterval`／終わらない `setTimeout` を導入せず `ctx.acceptWebSocket` 構成を維持する
    - _Requirements: 4.5, 4.6, 4.7, 4.8, 4.10, 5.1_

  - [x] 6.2 4継ぎ目に emitSeam を差し込む
    - `src/shell/store-timer-do.ts`: `construct`（constructor の `super` 直後・採番後）・`rehydrate`（`ensureLoaded` の `fromSnapshot` 直後・`restoredCount = workingCopy.timers.length`）・`alarm`（`alarm()` 先頭・`ensureLoaded` 後）・`broadcast`（`applySideEffect` の `case "Broadcast"` の送信ループ前・`messageType = effect.message.type`）の4点のみで `emitSeam` を呼ぶ。各継ぎ目で 1 件出力、broadcast は操作ごとに 1 件
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.9_

  - [ ]* 6.3 shell 計装の統合テストを書く（@cloudflare/vitest-pool-workers）
    - Workers pool で DO を構築・rehydrate・alarm 発火・broadcast させ、(a) debug 有効時に各継ぎ目で 1 件ずつ正しい `seam`/`instanceId`/`restoredCount`/`messageType` を含むログが出る、(b) debug 無効で 0 件、(c) 再 construct ごとに instanceId が相異なり存続期間中は不変、(d) 計装の有効/無効で Working_Copy・永続スナップショット・Effect 列順序が不変、を確認
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6, 4.8, 4.10_

  - [x] 6.4 wrangler.jsonc に debug flag を定義し型を再生成する
    - `wrangler.jsonc` に debug flag の env キー（タスク 1.1 で確定した名前・値表現）を定義し、`pnpm cf-typegen`（`wrangler types`）で `Env` 型を再生成する。`wrangler.jsonc` を唯一の出所とし設定の二重管理をしない
    - _Requirements: 4.10, 8.3, 8.4_

- [x] 7. チェックポイント — shell 計装のテストが通ることを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. CLI 端（tools/observe/・WS・JSONL・実時間・終了コード）
  - [x] 8.1 Probe_Client（connectProbe / ProbeConnection / send）を実装する
    - `tools/observe/probe.ts`: `/ws` への WS 接続確立（確立試行開始から 10,000ms 以内に確立できなければ理由を記録し非ゼロ終了）、`start`/`cancel` を既存 `ClientMessage` 形式で送信（送信失敗は理由と種別を記録し非ゼロ終了）、受信全件を受信順・本文不改変で `src/observe/log.ts` 経由で Operation_Log（JSONL ファイル）へ逐次追記。判定は一切せず I/O とログ書き込みのみを担う
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [ ]* 8.2 Probe_Client の統合テストを書く
    - モック WS サーバまたは実接続に対し、接続確立・タイムアウト（10,000ms）・送信失敗時の非ゼロ終了・受信全件の順序保持/本文不改変記録を 1〜3 例で確認
    - _Requirements: 1.2, 1.3, 1.6, 1.7_

  - [x] 8.3 Scenario_Runner（runScenario）を実装する
    - `tools/observe/runner.ts`: `src/observe/scenario.ts` の `orderedSteps` を実時間に沿って駆動。各ステップの相対時刻に達したら 250ms 以内に開始、`wait` 中はコマンドを送らず受信記録のみ継続、`await-done` は `shouldStopAwaiting` が true か上限待機時間まで待ち（不一致 `done` は記録し継続）、タイムアウト/接続未確立はログ保持のまま非ゼロ終了、全ステップ完了で WS を閉じログを確定しゼロ終了。各ステップは一度きりの遅延起動で `setInterval`/終わらない `setTimeout` を使わない
    - _Requirements: 3.2, 3.6, 3.7, 3.8_

  - [ ]* 8.4 Scenario_Runner の example/統合テストを書く
    - wait 中の送信抑止と受信記録継続、await-done タイムアウト時のログ保持＋非ゼロ終了、操作時の接続未確立での非ゼロ終了を確認
    - _Requirements: 3.3, 3.6, 3.7_

  - [x] 8.5 突き合わせ CLI を実装する
    - `tools/observe/correlate-cli.ts`: Operation_Log（JSONL ファイル）と Instrumentation_Log（`wrangler tail` 収集テキスト）を読み、`src/observe/correlate.ts` の純粋関数（`mergeByTime` → `classifyInstances` → `verifyAlarmFiredInIdle` / `verifyRehydrateCount` → `determineVerdict`）を呼んで判定（confirmed / inconclusive / fail と検証条件 a/b の内訳）を出力する。ユーザー向け出力はすべて英語
    - _Requirements: 9.4_

  - [x] 8.6 CLI エントリを配線する
    - `tools/observe/` の実行体エントリで `validateProbeArgs`（引数不正は接続試行せず記録・非ゼロ終了）→ `connectProbe` → `runScenario` → ログ確定 → 終了コード決定をつなぐ。ヘルプ・エラー表示を含むユーザー向け出力は英語のみ
    - _Requirements: 1.1, 3.8, 9.4_

- [x] 9. 静的検査と Deploy_Procedure
  - [x] 9.1 静的検査（core 無変更・4継ぎ目限定・hibernation 規律・ワイヤ形式・英語）を実装する
    - `tests/observe/`（または `tests/`）に静的検査を実装。(a) `src/engine/` 配下に差分が無く計装が `src/shell`・`tools/observe`・`src/observe` のみに存在、(b) `emitSeam`（確定名）の呼び出しが4点のみ、(c) shell ソースに秒読み目的の `setInterval`／終端のない `setTimeout` が無く `ctx.acceptWebSocket` を使う、(d) Probe_Client が `src/domain/messages.ts` の既存型のみを用い新種別/フィールドを定義しない、(e) CLI のユーザー向け文字列に日本語を含めない、を検証
    - _Requirements: 4.5, 4.7, 4.9, 9.4, 9.5, 9.6_

  - [x] 9.2 Deploy_Procedure を tools/observe/ の README に整備する
    - `tools/observe/README.md` に手順を記述: `pnpm build` → `wrangler deploy`（成功と `StoreTimerDO` バインディング公開の確認）、`wrangler tail` で `construct`/`rehydrate`/`alarm`/`broadcast` のライブ観測、観測開始時の debug flag 有効化、観測完了時の無効化（既定）へ戻し無出力確認、WS エンドポイント無認証公開リスクの明記（パイロット前提・アクセス制御はスコープ外・本番化時は認証必須）。Instrumentation_Log の収集（tail 出力のリダイレクトと `parseInstrumentationLine` 前処理）も記述する
    - 実際の本番デプロイ実行（認証情報を要する `wrangler deploy` / `wrangler tail` の発行）は手順に従いユーザーが行う。本タスクは手順整備までを対象とする
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 10. 最終チェックポイント — 全テストと静的検査が通ることを確認
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- `*` を付したサブタスクは省略可能（PBT・example。MVP を急ぐ場合スキップ可）。トップレベルタスクには `*` を付さない。
- 各タスクは特定の要件（granular な受け入れ基準）を `_Requirements: x.y_` 形式で参照し、各 Property テストタスクは `Validates: Requirements x.y` を明記する。
- 各 Correctness Property（P1〜P13）は単一の property テストとして実装し、最低 100 回反復、`Feature: hibernation-observability, Property N: ...` のタグコメントを付す（PBT は fast-check を用い自前実装しない）。
- 純粋層（`src/observe/`）を先に完成・検証してから shell 計装・CLI 端へ進む。純粋層テストは `Date.now()` のスタブや `vi.useFakeTimers()` を用いない（時刻は引数で渡す。暗黙時計への漏れは境界の引き直しサイン）。
- **core（`src/engine/`）は追加・変更・削除しない。** 計装は `src/shell` と `tools/observe`・`src/observe` のみ。SSOT 規律（Persist 先頭・`put` 成功が確定の起点）と hibernation 規律（`setInterval` 不使用・`acceptWebSocket` 維持）を計装でも崩さない。
- 公開シンボル名は 1.1 で確定してからコードに用いる。本計画中の名前はすべて暫定候補。
- 実時間タイミング（250ms 窓・await-done 待機・接続タイムアウト）・プラットフォーム挙動（hibernation の発生・4継ぎ目出力）・運用手順は Integration / Example / Smoke（静的検査・実デプロイ観測）で検証する。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1", "3.3", "4.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.2", "3.4", "3.5", "3.6", "4.2", "4.3"] },
    { "id": 3, "tasks": ["2.6", "4.4", "4.5", "4.6", "6.1", "6.4", "8.1"] },
    { "id": 4, "tasks": ["4.7", "4.8", "4.9", "6.2", "8.2", "8.3"] },
    { "id": 5, "tasks": ["4.10", "6.3", "8.4", "8.5", "8.6"] },
    { "id": 6, "tasks": ["9.1", "9.2"] }
  ]
}
```
