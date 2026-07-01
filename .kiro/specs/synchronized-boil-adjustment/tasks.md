# Implementation Plan: 近接同時茹で上がり調整（synchronized-boil-adjustment / Boil_Sync）

## Overview

設計（`design.md`）の骨格「engine に純粋変換を一つ足すだけ」に厳密に対応した実装計画である。実装言語は **TypeScript（strict）**、ツールは `tooling.md` に従い **pnpm / Vitest v4（`cloudflareTest` プラグイン）/ fast-check v4 / oxlint / `tsc --noEmit`** を用いる。engine/domain の純粋テストは workerd 不要（既定 pool）、shell/DO の統合テストは Workers pool で実行する。

実装は依存順に、`domain/store.ts`（設定）→ `engine/timer.ts`（Adjusted 合成）→ `engine/project.ts`（射影単一化）→ `engine/sync.ts`（同期計算）→ `decide` 統合 → Alarm/発火の実効時刻化 → スキーマ v6 → shell 配線、の順で積み上げる。各段は前段の上に立ち、宙に浮くコードを残さない。

PBT は設計の 14 プロパティを各 1 サブタスクとして実装する。テスト系サブタスク（`*` 付き）は任意で、スキップしても中核実装は成立する。

**命名確認（実装ゲート・`naming.md`）:** 下表の公開シンボルは概念境界の表明であり、**実装に着手する前にユーザー確認を得る**（タスク 1）。確認前に公開シンボルを確定実装しない。

| 概念（要件の仮名） | 候補シンボル | 場所 |
| --- | --- | --- |
| Adjustment | `Adjusted { adjustment }` | `engine/timer.ts` |
| Boil_Sync | `synchronize` | `engine/sync.ts`（新規） |
| 調整パラメータ | `SyncParams { arms; toleranceRatio }` | `engine/sync.ts` |
| Adjusted_Boil_Time | `adjustedEndTime` | `engine/project.ts`（新規） |
| Timer→TimerFact 射影 | `toTimerFact`（旧 `toWireTimer` を集約） | `engine/project.ts` |
| 腕の本数 | `arms` / `ARMS_MIN` / `ARMS_MAX` / `DEFAULT_ARMS` | `domain/store.ts` |
| 許容調整割合 | `toleranceRatio` / `TOLERANCE_RATIO_MIN` / `TOLERANCE_RATIO_MAX` / `DEFAULT_TOLERANCE_RATIO` | `domain/store.ts` |
| 設定検証 | `toArms` / `toToleranceRatio` | `domain/store.ts` |
| env シード | `STORE_ARMS` / `STORE_TOLERANCE_RATIO` | env / shell |
| `decide` 第3引数 | `decide(state, event, params: SyncParams)` | `engine/decide.ts` |

**確認を要する設計判断（併せて承認を仰ぐ）:** ① Adjustment を永続する（スキーマ v6・欠如は 0 で移行）② タイブレーク＝ `g*` 固定下で Window_Intersection 中点への二乗偏差和最小 ③ broadcast＝確定変化時に実効 `endTime` を載せた全量 `snapshot` を追加配信 ④ membership は昇順チャンク固定 ⑤ arms/toleranceRatio は client へ非配信。

各タスクの完了条件は共通で **`pnpm typecheck` / `pnpm lint` / `pnpm test`（`--run`）がすべて通ること**。テストは watch を使わず単発実行する。

## Tasks

- [x] 1. 公開シンボルの命名確認を得る（実装ゲート）
  - Overview の命名確認表の候補シンボル（`Adjusted`/`adjustment`・`synchronize`・`SyncParams`・`adjustedEndTime`・`toWireTimer`・`arms`・`toleranceRatio`・`toArms`/`toToleranceRatio`・各定数・`STORE_ARMS`/`STORE_TOLERANCE_RATIO`・`decide` 第3引数）についてユーザー確認を得る
  - 併せて設計判断①〜⑤（永続/タイブレーク/broadcast/membership/非配信）の承認を得る
  - 確認結果を以後のタスクの確定シンボル名として用いる（`naming.md`：公開シンボルは実装前に確認）
  - _Requirements: 4.1, 6.1_

- [x] 2. StoreConfig に調整パラメータを追加（domain/store.ts・config サンプル）
  - [x] 2.1 `arms` / `toleranceRatio` フィールドと定数・検証関数を実装
    - `StoreConfig` に `arms` / `toleranceRatio` を追加し、`ARMS_MIN=1`/`ARMS_MAX=10`/`DEFAULT_ARMS=2`・`TOLERANCE_RATIO_MIN=1`/`TOLERANCE_RATIO_MAX=50`/`DEFAULT_TOLERANCE_RATIO=10` を定義
    - `toArms` / `toToleranceRatio` を `toUnitCount` と同形で実装（型不一致・非整数・非有限・範囲外を当該パラメータのみ既定へ畳み、範囲内はクランプ）
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 2.1, 2.7_
  - [ ]* 2.2 `toArms` / `toToleranceRatio` の property test
    - **Property 13: 調整パラメータ検証はパラメータ独立に妥当域へ畳む**
    - **Validates: Requirements 6.3, 6.4**
  - [ ]* 2.3 検証関数の example / edge-case test
    - `toArms(undefined)===2` / `toArms(0)===2` / `toArms(11)===2` / `toArms(3.5)===2`、`toToleranceRatio(undefined)===10` / `toToleranceRatio(0)===10` / `toToleranceRatio(51)===10`
    - _Requirements: 6.2_
  - [x] 2.4 config サンプルに `arms` / `toleranceRatio` を追記
    - `config/store-config.sample.json` に `"arms": 2` / `"toleranceRatio": 10` を追加（既存キーは不変）
    - _Requirements: 6.1, 6.2_

- [x] 3. engine 専用基底 Adjusted を定義し Timer へ合成（engine/timer.ts）
  - [x] 3.1 `Adjusted { adjustment }` を定義し `Timer` へ合成・`createTimer` を拡張
    - `Sequenced` / `Boilable` と同じ場所に `Adjusted`（符号付きミリ秒オフセット・初期値 0）を定義し `Timer extends ... Adjusted`
    - `createTimer` に `adjustment?: number`（省略時 0）を追加。domain・wire・client には露出しない
    - _Requirements: 4.1_
  - [ ]* 3.2 `createTimer` の unit test
    - `adjustment` 省略時 0・指定時保持を確認
    - _Requirements: 4.1_

- [x] 4. Timer→TimerFact 射影を単一化（engine/project.ts・新規）
  - [x] 4.1 `toWireTimer` / `adjustedEndTime` を実装し重複射影を集約
    - `adjustedEndTime(timer) = endTime + adjustment`、`toWireTimer` は `seq`/`boiledAt`/`adjustment` を削ぎ実効 `endTime` を載せる唯一の射影
    - 既存 `start.ts` / `adjust.ts` のローカル射影を撤去し `project.ts` を import して用いる（shell 側は task 11 で委譲）
    - _Requirements: 4.2, 4.5_
  - [ ]* 4.2 射影とアンカー不変の property test
    - **Property 10: アンカー不変と実効 endTime の射影**
    - **Validates: Requirements 4.2, 4.5, 4.7**
  - [ ]* 4.3 `toWireTimer` の example test
    - 出力が `TimerFact` の 6 フィールドのみを持ち `adjustment` を含まないことを確認
    - _Requirements: 4.1_

- [x] 5. 同期計算 synchronize を実装（engine/sync.ts・新規）
  - [x] 5.1 分類段（半幅・クラスタ形成・Sync_Set 分割）を実装
    - `SyncParams { arms; toleranceRatio }` を定義。`arms<1` の下限ガードを一行だけ置く（二重の安全網）
    - 半幅 `h_i=(endTime_i−startTime_i)×toleranceRatio/100`（クランプなし）、窓量は 100 倍スケール整数で扱う
    - 区間掃引（左端昇順・最大右端連結・境界一致を包含）で Proximity_Cluster を形成、各クラスタをオリジナル `endTime` 昇順（同着 `seq` 昇順）に arms 本ずつチャンク化して Sync_Set へ分割
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5_
  - [x] 5.2 決定段（Window_Intersection・maximin・Adjustment 割り当て）を実装
    - Window_Intersection `[Lmax, Rmin]` と同期可能判定（`Lmax ≤ Rmin`）
    - maximin: 間隔下限 `g` の貪欲左詰め実行可能性判定を整数スケールで二分探索して `g*` を得る。`g*` 固定下で Window_Intersection 中点への二乗偏差和を最小化（単調回帰）して一意化。単独セットは中点＝自 `endTime` に落ちて 0
    - Sync_Target を整数ミリ秒へ決定的丸め（`I` 内クランプ）、`adjustment = Sync_Target − endTime_i`。同期見送りセット・単独クラスタ・単独メンバーは 0。running のみを対象とし boiled は入力に含めない
    - _Requirements: 1.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.3_
  - [ ]* 5.3 running 限定・boiled 凍結の property test
    - **Property 1: 同期は Running_Timer のみに作用し boiled を凍結する**
    - **Validates: Requirements 1.1, 7.3**
  - [ ]* 5.4 窓内収束の property test
    - **Property 2: Adjustment は許容調整窓内に収まる**
    - **Validates: Requirements 3.3, 3.7, 4.3**
  - [ ]* 5.5 クラスタ連結成分の property test（境界一致生成器を含む）
    - **Property 3: Proximity_Cluster は窓重なりの連結成分に一致する**
    - **Validates: Requirements 1.3, 1.4, 1.5, 1.6**
  - [ ]* 5.6 分割の property test
    - **Property 4: Sync_Set は Running_Timer 集合の分割である**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
  - [ ]* 5.7 確定セット実効時刻一致の property test
    - **Property 5: 同期確定セットのメンバーは実効 endTime が完全一致する**
    - **Validates: Requirements 2.6**
  - [ ]* 5.8 同期可能性とフォールバックの property test
    - **Property 6: 同期可能性とフォールバック（窓の積が空・孤立は Adjustment 0）**
    - **Validates: Requirements 1.7, 3.2, 3.6, 7.4**
  - [ ]* 5.9 maximin 最適性の property test（モデルベース・m≤4）
    - **Property 7: maximin 最適性（連続確定セット間隔の最小値の最大化）**
    - **Validates: Requirements 3.4**
  - [ ]* 5.10 順序非依存の property test（`fc.shuffle`）
    - **Property 8: 順序非依存（決定的タイブレークによる一意性）**
    - **Validates: Requirements 3.5, 7.5**
  - [ ]* 5.11 冪等性の property test
    - **Property 9: 冪等性（再同期は no-op）**
    - **Validates: Requirements 7.5, 7.7**
  - [ ]* 5.12 退化・具体シナリオの example / edge-case test
    - 空 running → 空、3 本・arms=2 が `[2 本][1 本]` に分割され 2 本セットが同期・残余が maximin で離される具体例
    - _Requirements: 1.8, 2.2, 2.6, 3.4_

- [x] 6. Checkpoint - 同期計算コアの検証
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. decide への設定注入と全体再同期の統合（engine/decide.ts ほか遷移）
  - [x] 7.1 `settle` 純粋ヘルパを実装（全体再同期＋no-op 検出＋Effect 列組み立て）
    - running のみ `synchronize` で全体置換し boiled は据え置き（`mergeBoiled`）。確定結果（集合＋各 `adjustment`＋`boiledAt`）が直前と同一なら Effect 空
    - Persist 先頭・SetAlarm は実効最早・Broadcast は trigger 意味論＋全量 `snapshot`（Persist→意味論 Broadcast→snapshot Broadcast→Reply の順）
    - _Requirements: 5.2, 7.6, 7.7, 7.4_
  - [x] 7.2 `decide` 署名に `SyncParams` を追加し start/cancel/complete を settle 経由に統合
    - `decide(state, event, params: SyncParams)`。engine は `StoreConfig` を import せず値のみ受け取る
    - Start（`started`＋全量 `snapshot`）・Cancel（`cancelled`）・Complete（`completed`）を `settle` に通す
    - _Requirements: 7.1, 7.2_
  - [x] 7.3 Adjust 経路を settle に統合（engine/adjust.ts）
    - `adjustTimer` がオリジナル `endTime`（アンカー）を引き直した後、`settle` で全体再同期する
    - 既存拒否（`TimerNotFound` / `InvalidBoilSeconds`）は不変・新種別を増やさない
    - _Requirements: 7.1_
  - [ ]* 7.4 集合変化後の確定結果の property test
    - **Property 12: 集合変化後の確定結果は現在の running 集合の純粋な関数である**
    - **Validates: Requirements 7.1, 7.2, 7.3**
  - [ ]* 7.5 Effect 列順序と no-op 抑止の property test
    - **Property 14: 確定結果が変化するときのみ Persist 先頭の Effect 列を出す**
    - **Validates: Requirements 5.2, 7.6, 7.7**

- [x] 8. Alarm・発火を実効時刻基準へ精緻化（engine/alarm.ts・engine/fire.ts）
  - [x] 8.1 最早算出を実効 `endTime` 基準にする（engine/alarm.ts）
    - `earliestEndTime` / `nextAlarmEffect` を `adjustedEndTime` で算出、running の実効最早・同着 `seq` 昇順で Alarm を張る
    - _Requirements: 4.4_
  - [x] 8.2 due 判定を実効時刻化し発火後に残り running を再同期（engine/fire.ts）
    - `fireDueTimers` の due 判定を `adjustedEndTime(t) ≤ now + ε` に精緻化。due を先に boiled へ写して Adjustment を凍結し、その後 `settle` で残り running を再同期
    - _Requirements: 4.4, 7.3_
  - [ ]* 8.3 発火基準の property test
    - **Property 11: 発火は Adjusted_Boil_Time を基準にする**
    - **Validates: Requirements 4.4**

- [x] 9. 永続スキーマ v6 と移行（engine/types.ts・snapshot.ts・migrate.ts）
  - [x] 9.1 スキーマを v6 に上げ snapshot に `adjustment` を含める
    - `CURRENT_SCHEMA_VERSION = 6`、`toSnapshot` / `fromSnapshot` が `adjustment` を写す。単一キー put/get の形は不変・SQL 不使用
    - _Requirements: 4.1_
  - [x] 9.2 `adjustment` 欠如を 0 で移行（engine/migrate.ts）
    - `reviveStartTime` / `reviveFirmness` と同形で `adjustment` 欠如（v5 以前）を 0 で埋める。`MigrationFailed` を増やさない
    - _Requirements: 4.5_
  - [ ]* 9.3 移行の property / example test
    - v5→v6 round-trip・`adjustment` 欠如が 0 で復元されることを確認
    - _Requirements: 4.5_

- [x] 10. Checkpoint - engine 全体の検証
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. shell 配線（src/shell/store-timer-do.ts）
  - [x] 11.1 `StoreConfig` から arms/toleranceRatio をロードし `decide` へ注入
    - `ensureConfigLoaded` が env シード（`STORE_ARMS` / `STORE_TOLERANCE_RATIO`）または永続値から `this.arms` / `this.toleranceRatio` を確立し、`applyStoreConfig`（PUT /admin/config）も全体置換。`decide` 呼び出しに `{ arms, toleranceRatio }` を渡す
    - _Requirements: 6.1, 6.4_
  - [x] 11.2 snapshot 射影を project.ts へ委譲し確定変化時に全量 snapshot を broadcast・client 非配信
    - shell のローカル snapshot 射影を撤去し `toWireTimer` を用いる。確定変化時に実効 `endTime` を載せた全量 `snapshot` を Persist 成功後に全 WS へ配信。`config` メッセージに arms/toleranceRatio を含めない
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 6.5_
  - [ ]* 11.3 Persist 失敗時の broadcast 抑止の統合テスト（Workers pool）
    - Persist 失敗を注入 → broadcast されず SSOT が失敗前の確定 Adjustment を保持
    - _Requirements: 5.3, 7.8_
  - [ ]* 11.4 全端末一致の統合テスト（Workers pool）
    - 2 端末接続 → start で同期 → 双方の hydration/snapshot が同一の実効 `endTime`
    - _Requirements: 5.4, 5.5_
  - [ ]* 11.5 broadcast 失敗からの回復の統合テスト（Workers pool）
    - 一方の broadcast を落とす → 再接続の snapshot で実効 `endTime` が一致に回復
    - _Requirements: 5.6_
  - [ ]* 11.6 client 非配信の example test
    - `config` メッセージに `arms` / `toleranceRatio` が含まれないことを確認
    - _Requirements: 5.1, 6.5_

- [x] 12. engine 純粋性の静的検査（smoke）
  - [ ]* 12.1 sync.ts / project.ts の純粋性 smoke test
    - `engine/sync.ts` / `engine/project.ts` が `cloudflare:workers` / storage / `setInterval` / `waitUntil` / 外部 await に依存しないことを既存 engine 純粋性検査に追随して確認
    - _Requirements: 4.6, 8.2, 8.3_

- [x] 13. Final checkpoint - 全テストと静的検査の通過
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- `*` 付きサブタスクは任意（テスト）で、スキップしても中核実装は成立する。トップレベルタスクは任意化しない。
- 各タスクは特定の要件条項と設計プロパティ／コンポーネントに紐付く（トレーサビリティ）。
- PBT は fast-check で各プロパティ **最低 100 イテレーション**、タグ形式 `Feature: synchronized-boil-adjustment, Property {番号}: {本文}` を付す。sync の各 property test は独立ファイル（`tests/core/sync.p{N}.property.test.ts` 等）に置き、並行実行を妨げない。
- 統合テスト（11.3〜11.5）は Workers pool、engine/domain のテストは既定 pool で実行する。
- スコープ外（含めない）: バッチ membership の最適化、client 変更、新メッセージ種別、最小インターバル下限。
- 各タスク完了時に `pnpm typecheck` / `pnpm lint` / `pnpm test`（`--run`）が通ることを完了条件とする。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1", "2.4", "3.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "3.2", "4.1", "9.1"] },
    { "id": 2, "tasks": ["4.2", "4.3", "5.1", "8.1", "9.2"] },
    { "id": 3, "tasks": ["5.2", "9.3"] },
    { "id": 4, "tasks": ["5.3", "5.4", "5.5", "5.6", "5.7", "5.8", "5.9", "5.10", "5.11", "5.12", "8.2"] },
    { "id": 5, "tasks": ["7.1", "8.3"] },
    { "id": 6, "tasks": ["7.2", "7.3"] },
    { "id": 7, "tasks": ["7.4", "7.5"] },
    { "id": 8, "tasks": ["11.1"] },
    { "id": 9, "tasks": ["11.2"] },
    { "id": 10, "tasks": ["11.3", "11.4", "11.5", "11.6", "12.1"] }
  ]
}
```
