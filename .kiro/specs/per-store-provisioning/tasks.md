# Implementation Plan: 店舗ごとのプロビジョニング（per-store-provisioning）

## Overview

本計画は `design.md`（正本）と `requirements.md`（全9要件・EARS）から演繹された実装計画である。実装言語は **TypeScript（strict）**、ツールは `tooling.md` に従い **pnpm / Vitest v4（`cloudflareTest` プラグイン）/ fast-check v4 / oxlint / `tsc --noEmit`** を用いる。`src/registry/` の純粋関数群は既定 pool、`src/shell`（DO）・`src/worker.ts` の統合テストは Workers pool（`@cloudflare/vitest-pool-workers` の `cloudflareTest()`）で走る。

実装は設計の **段階的ロールアウト（合意済みの 3 段階）** に厳密対応して構成する。イデアのスキーマ・`StoreProjection` の形・`composeEffectiveConfig` の入口は Phase 1 で全段階を受け入れられる最終形にするため、Phase 2 / 3 は**追加のみ**でスキーマ移行を要しない。

- **Phase 1（レジストリ + 単純注入）**：`StoreRegistryDO`・チェーン/店舗 CRUD・スラッグ採番・`/s/{storeId}/` 経路・合鍵 URL（`ACCESS_REQUIRED="0"`）・非活性化・GET・`applyProjection`（version 単調ガード込み）・store-scoped 永続・env シード / `DEFAULT_STORE_ID` 撤去。`composeEffectiveConfig` は「空 Policy + Override」の縮退パスだけを行使する（`policyIds` は常に空）。Roster / Access / Entry は休眠。
- **Phase 2（Policy 合成）**：Policy CRUD・割当・畳み込みの全意味論（priority 昇順・enforced/default・縦衝突・配列丸ごと置換）・曖昧割当の入口検証。
- **Phase 3（Roster + Access + Entry）**：Roster CRUD・`effectiveRoster`・逆引きインデックス・`jose` による Access JWT 検証・接続時認可・Entry リダイレクト・`GET /entry/stores`・店舗切替 UI・`ACCESS_REQUIRED="1"` 切替。

各 Phase 末尾のチェックポイントで `pnpm typecheck` / `pnpm lint` / `pnpm test`（= `vitest --run`。watch は使わない）の green を担保する。本機能は複数ファイルにまたがる協調変更であり、下位タスク途中では型エラーが残りうる。

**命名確認は完了済み（naming ゲート通過）。** 公開シンボル名（`StoreRegistryDO` / `STORE_REGISTRY_DO` / `"registry"` / `Chain` / `Policy` / `StoreOverride` / `Roster` / `PolicyFields` / `ModedValue` / `PolicyMode` / `composeEffectiveConfig` / `effectiveRoster` / `buildReverseIndex` / `storesForIdentity` / `ReverseIndex` / `converge` / `affectedStores` / `recomposeProjection` / `nextResidual` / `StoreProjection` / `applyProjection` / `isValidStoreId` / `mintStoreId` / `StoreId` / `verifyAccessIdentity` / `resolveEntryDestination` / `storeIdFromPath` / `ensureProvisioned` / `localStorageViewStore` / `scopedStorageKey` ほか）は確定済みとして、そのまま用いる（再確認しない）。

**不変点（変えない）**：`src/engine`・`src/domain` の Timer 契約（`TimerFact` ほか）、`StoreConfig` 型と検証関数（`toUnitCount` / `toArms` / `toToleranceRatio` / `toNoodlePresets`）、`ServerMessage`（`snapshot` / `config` / `error`。Roster を表現するフィールドを足さない）、SQLite バックエンド（`new_sqlite_classes`）＋非同期 KV API のみ（`ctx.storage.sql` は使わない）、`ADMIN_TOKEN` の定数時間比較（`isAdminAuthorized` / `timingSafeEqual`）。

## Tasks

### Phase 1 — レジストリ + 単純注入

- [x] 1. `src/registry/` 純粋層の骨格（イデア型・投影型・スラッグ）
  - [x] 1.1 `src/registry/ideal.ts` — イデアの型を最終形で定義
    - `StoreId` / `ChainId` / `PolicyId` / `Identity` の型別名、`PolicyMode`（`"enforced"` / `"default"`）、`ModedValue<T>`、`PolicyFields`（`unitCount` / `arms` / `toleranceRatio` / `noodlePresets` を任意で mode 付き保持）、`Policy`（`policyId` / `chainId` / `name` / `priority` / `fields`）、`StoreOverride`、`Roster`、`Chain`（`chainId` / `name` / `chainRoster`）、`Store`（`storeId` / `chainId` / `name` / `policyIds` / `override` / `storeRoster` / `active` / `storeCode?` / `createdAt` / `updatedAt`）を定義する。
    - 全段階（Phase 2/3）を受け入れる最終形で定義し、後続 Phase でのスキーマ移行を不要にする。`domain` には置かず `src/registry/` に閉じる（client も engine も見ない）。
    - _Requirements: 3.1, 3.2, 3.3, 3.8, 3.9_

  - [x] 1.2 `src/registry/projection.ts` — `StoreProjection` を最終形で定義
    - `StoreProjection`（`config: StoreConfig` / `roster: Roster` / `active: boolean` / `version: number`）を定義する。`config` だけが配信可能、`roster` はサーバ内部のみ。`src/registry/` と `src/shell/store-timer-do.ts` のみが import し、`domain` 経由で client へ到達しない構造にする（Roster のワイヤ漏洩を型で封じる）。
    - _Requirements: 5.3, 6.5_

  - [x] 1.3 `src/registry/slug.ts` — `isValidStoreId` / `mintStoreId`
    - `isValidStoreId(raw)` は `/^[a-z0-9-]{1,64}$/` を満たすかを返す。`mintStoreId(randomBytes)` は乱数バイト列を `[a-z0-9-]` へ符号化した推測困難スラッグを返し、出力は必ず `isValidStoreId` を満たす（乱数採取は shell が担い、純粋関数はバイト列→slug に留める）。
    - _Requirements: 1.2, 2.2, 2.3_

  - [x] 1.4 `isValidStoreId` の property test（Property 1）
    - **Property 1: storeId 検証は許容文字集合・長さに一致する** — 任意文字列 `s` について `isValidStoreId(s)` が真であることと `s` が `[a-z0-9-]` のみ・長さ 1〜64 であることが同値。大文字・記号・空・65 文字・境界長を生成する。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 1: storeId 検証は許容文字集合・長さに一致する`。配置 `tests/registry/slug.property.test.ts`（既定 pool）。
    - _Validates: Requirements 1.2, 2.3_

  - [x] 1.5 `mintStoreId` の property test（Property 4）
    - **Property 4: 採番スラッグは常に妥当** — 任意の乱数バイト列について `mintStoreId(bytes)` の出力は常に `isValidStoreId` を満たす。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 4: 採番スラッグは常に妥当`。配置 `tests/registry/slug.property.test.ts`（既定 pool）。
    - _Validates: Requirements 2.2_

  - [x] 1.6 イデアの KV 往復（structured clone）の property test（Property 5）
    - **Property 5: イデアのシリアライズ往復** — 妥当な Chain / Policy / Store（Roster・priority・mode 込み）を KV（`storage.put` → `storage.get`）へ格納して読み戻した値は元の値と構造的に等しい（round-trip）。DO の SQLite バックエンド KV は **structured clone** セマンティクスで格納するため、JSON シリアライズ往復ではなく `structuredClone` 往復（design.md Property 5 の「KV へ put して get」）で検証する。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 5: イデアのシリアライズ往復`。配置 `tests/registry/ideal.property.test.ts`（既定 pool・`structuredClone` 往復で structured clone 適合を検証する。実 KV の put/get 作用まで確かめる場合は Workers pool のミラーで補う）。
    - _Validates: Requirements 3.1, 3.3_

- [x] 2. 合成（縮退パス）と収束の純粋核
  - [x] 2.1 `src/registry/compose.ts` — `composeEffectiveConfig`（Phase 1 縮退パス）
    - `composeEffectiveConfig(policies, override)` を、基底 `DEFAULT_*`（`domain` 由来）に `Store_Override` を重ねる縮退実装として書く（Phase 1 は `policies` が常に空）。出力は完全な `StoreConfig`（`unitCount` / `arms` / `toleranceRatio` / `noodlePresets`）で、各値は既存検証関数の値域に収まる。priority 昇順畳み込みの全意味論はタスク 10.1 で追加する（入口・シグネチャは最終形）。
    - _Requirements: 4.1, 4.5_

  - [x] 2.2 `src/registry/converge.ts` — 収束の純粋核（`affectedStores` / `recomposeProjection` / `nextResidual`）
    - `affectedStores(idealChange, ...)` を Chain/Policy/Store/Roster 変種すべてに対して純粋に実装する（該当店舗集合を過不足なく返す）。`recomposeProjection(storeId, ..., revision)` は最新イデアから `composeEffectiveConfig` と実効 Roster（Phase 1 は空配列）で `StoreProjection`（version = revision）を再合成する。`nextResidual(residual, storeId, pushOk)` は成功で除去・失敗で保持を返す。作用（put / RPC / setAlarm）は含めない。
    - _Requirements: 3.7, 5.4, 5.8_

  - [x] 2.3 `affectedStores` の property test（Property 9）
    - **Property 9: 変更の影響店舗を過不足なく逆引きする** — イデアと変更種別（Chain / Policy / Store / Roster）について `affectedStores` が返す storeId 集合は「その変更に設定・名簿が依存する全店舗」にちょうど一致する（過剰も欠落もない）。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 9: 変更の影響店舗を過不足なく逆引きする`。配置 `tests/registry/converge.property.test.ts`（既定 pool）。
    - _Validates: Requirements 3.7_

  - [x] 2.4 `recomposeProjection` の property test（Property 14）
    - **Property 14: 投影の再合成は決定的（last-write-wins の基盤）** — 同一イデアと storeId から `recomposeProjection` は常に同一の `StoreProjection`（config・roster・active・version）を返す。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 14: 投影の再合成は決定的（last-write-wins の基盤）`。配置 `tests/registry/converge.property.test.ts`（既定 pool）。
    - _Validates: Requirements 5.4_

  - [x] 2.5 `nextResidual` の property test（Property 15）
    - **Property 15: 残作業の更新規則** — `nextResidual(residual, storeId, ok)` は `ok` 真で当該 storeId を除去し偽で保持する。反復適用は成功を漏れなく除去し失敗を保持する。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 15: 残作業の更新規則`。配置 `tests/registry/converge.property.test.ts`（既定 pool）。
    - _Validates: Requirements 5.8_

  - [x] 2.6 `src/registry/validate.ts` — レジストリ入口の拒否型検証（純粋関数）
    - `validateProvisioningInput(raw)` を `src/registry/` に純粋関数として実装する（イデア入口の値検証。`StoreRegistryDO` 内部で用いるレジストリ専用ヘルパであり、`Chain` / `Policy` / `Store` などの確定済み公開シンボル語彙に閉じる内部関数として扱う）。未知フィールド・型不一致・値域外（`toUnitCount` / `toArms` / `toToleranceRatio` / `toNoodlePresets` の値域）・必須欠落を拒否として判定し、受理／拒否（拒否理由付き）を返す。**HTTP 400 応答やイデアの put 有無は判定しない**（作用は shell が持つ）。Phase 1 で導入し、Phase 1 の Chain / Store 入口（Override・チェーン Roster の値・タスク 3.2）と Phase 2 の Policy 入口（タスク 9.1）の双方が同一の純粋判定を再利用する。純粋・決定的・作用なし。
    - _Requirements: 4.6, 3.4_

  - [x] 2.7 `validateProvisioningInput` の accept/reject example / edge-case test
    - 正常入力→受理、未知フィールド・型不一致・値域外（各境界）・必須欠落→拒否（理由付き）を例示で確かめる。純粋関数の判定のみを検証し、HTTP 面には触れない（400 応答とイデア不変の配線は Workers pool 統合テスト 10.7 が検証する）。
    - 配置 `tests/registry/validate.example.test.ts`（既定 pool）。
    - _Requirements: 4.6_

- [x] 3. `StoreRegistryDO`（新規 shell・作用の端）
  - [x] 3.1 `src/shell/store-registry-do.ts` 骨格・永続キー・put-first・`meta:revision`
    - `StoreRegistryDO extends DurableObject<Env>` を新規作成する。永続キー（`chain:{id}` / `store:{id}` / `index:reverse` / `index:code` / `meta:revision` / `converge:residual` / `converge:version:{storeId}`）を非同期 KV API のみで扱う（`ctx.storage.sql` 不使用）。自身の名は `ctx.id.name`（`"registry"`）から読む。あらゆる登録／更新は「イデア＋`meta:revision` 増分＋残作業を put で確定してから fan-out を始める」put-first 規律で書く。`meta:revision` はイデアの全書き込みで +1（狭義単調）。
    - _Requirements: 2.1, 2.5, 5.1, 5.6, 5.7_

  - [x] 3.2 チェーン／店舗 CRUD（採番・明示検証・衝突拒否・非活性化）
    - `createOrUpdateChain` / `createStore` / `updateStore` を実装する。`createStore` は storeId 未指定でランダムスラッグを採番して応答で返し、明示指定は `isValidStoreId`＋未使用チェック通過時のみ受理、違反・使用済みは HTTP 400・イデア不変・別 ID 代替なし。`updateStore` は Override・`active`・`name` を更新し、`active=false`（閉店）を受けられる（物理削除はしない）。イデア put 成功の上で当該／影響店舗の収束を開始する。
    - Override・チェーン Roster の値（`StoreConfig` 相当フィールド）の拒否型検証は `validateProvisioningInput`（タスク 2.6）で行い、拒否時は HTTP 400・イデア不変とする（storeId の文字集合・長さ・衝突検証とは別レイヤ。値域・型・未知フィールドの判定を担う）。
    - _Requirements: 2.2, 2.3, 2.4, 3.9, 4.6_

  - [x] 3.3 fan-out RPC 押し込みと Alarm 継続（`converge` / `alarm`）
    - shell の `converge(idealChange)` 手続きを実装する：影響店舗を `affectedStores` で逆引きし、各 `env.STORE_TIMER_DO.idFromName(storeId)` のスタブ（都度生成・非永続）へ `recomposeProjection` の投影を直列 RPC で `applyProjection`。受領 version を `converge:version:{storeId}` に記録し、`nextResidual` で残作業を更新。実行時間上限近傍で残作業を残し `setAlarm`。`alarm(alarmInfo)` は残作業を最新イデアから再合成して冪等再送し、`retryCount` 近傍で新規 Alarm を張り直す。
    - _Requirements: 5.1, 5.4, 5.5, 5.8, 5.9_

  - [x] 3.4 最小の読み出し（GET・ADMIN_TOKEN と同一認可）
    - `listChains` / `listStores(chainId?)` / `getStore(storeId)` を実装し、`GET /admin/chains` / `GET /admin/stores?chainId=` / `GET /admin/stores/{storeId}` の `fetch` ディスパッチに繋ぐ（外部マスタとの突き合わせ・採番スラッグの再確認用）。
    - _Requirements: 2.10_

  - [x] 3.5 revision 単調と投影 version 一致の property test（Property 16）
    - **Property 16: revision は狭義単調増加し投影 version に一致する** — イデア更新の列についてレジストリ `revision` は狭義単調増加し、各更新後に再合成される投影の `version` はその時点の `revision` に等しい（Chain・Store いずれの変更でも進む。Policy/Roster はそれぞれ Phase 2/3 のジェネレータで追加）。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 16: revision は狭義単調増加し投影 version に一致する`。配置 `tests/registry/revision.property.test.ts`（既定 pool・revision 増分の純粋モデル）。
    - _Validates: Requirements 5.6_

  - [x] 3.6 put-first の統合テスト（Workers pool）
    - イデアの `storage.put` 失敗を注入し、後続の fan-out（`applyProjection` 押し込み）が一切行われずイデアが不変であることを確認する。
    - 配置 `tests/shell/registry-converge.integration.test.ts`（Workers pool）。
    - _Validates: Requirements 5.1_

  - [x] 3.7 100 店 fan-out の Alarm 継続の統合テスト（Workers pool）
    - 100 店規模の収束で、1 回の実行に閉じず残作業を永続して Alarm 継続で全店の投影が最終的に一致する（at-least-once・last-write-wins）ことを確認する。
    - 配置 `tests/shell/registry-fanout.integration.test.ts`（Workers pool）。
    - _Validates: Requirements 5.5_

- [x] 4. `StoreTimerDO` の改修（投影受け口・撤去・接続拒否・非活性化）
  - [x] 4.1 `applyProjection`（型付き RPC・永続・config 再配信・version エコー・単調ガード）
    - `applyProjection(projection): Promise<{ version }>` を実装する（現行 `applyStoreConfig` の後継）。投影を `projection` キーへ永続し、`config` の変化を接続中の全 WS へ `config` メッセージで再配信する（既存 broadcast 経路を継承）。受領 version をエコーし、受領 version が永続済み version より小さい投影は適用せず永続済み version を返す（単調ガード）。`roster` は永続するが `ServerMessage` には決して載せない。
    - _Requirements: 5.2, 5.9, 5.4_

  - [x] 4.2 `ensureConfigLoaded` → `ensureProvisioned` 改名と env シード撤去
    - `ensureConfigLoaded` を `ensureProvisioned` に改名し、env シード分岐と `STORE_UNIT_COUNT` / `STORE_ARMS` / `STORE_TOLERANCE_RATIO` / `STORE_NOODLE_PRESETS` 依存、`applyStoreConfig`（`PUT /admin/config` の Request 処理）を撤去する。自身の storeId は `ctx.id.name` から読み、投影未永続なら「未プロビジョニング」と判定する。永続キーを `storeConfig` から `projection` へ移す。
    - _Requirements: 2.7, 2.8, 9.3_

  - [x] 4.3 未プロビジョニング接続の拒否（書き込みゼロ）
    - `fetch`（WS Upgrade）経路で `ensureProvisioned` が未プロビジョニングを検出したとき、`storage.put` を一切行わずに接続を拒否する（書き込みゼロの DO は消滅し痕跡を残さない）。
    - _Requirements: 2.6_

  - [x] 4.4 非活性化（deactivated）時の接続拒否と既存 WS 閉鎖
    - 保持する投影が `active=false` を示すとき、新規接続を拒否し、接続中の WebSocket を閉じる。タイマー状態・投影は保持し物理削除しない。
    - _Requirements: 6.6_

  - [x] 4.5 自立性（rehydrate 時の越境読みなし・最後の投影で継続）
    - rehydrate（hibernate 復帰）ホットパスがレジストリへ越境読みをしないことを保証する。レジストリ不達でも最後に受領した投影でタイマー機能・接続時条件判定を継続する。
    - _Requirements: 6.1, 6.2_

  - [x] 4.6 投影適用の version 単調の property test（Property 22）
    - **Property 22: 投影適用は version 単調（到着順に依存しない）** — 投影押し込みの列（version 順は任意）について最終永続投影は列中の最大 version の投影に等しく、version が永続済み以下の押し込みは状態を変えない。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 22: 投影適用は version 単調（到着順に依存しない）`。配置 `tests/shell/apply-projection.property.test.ts`（Workers pool・単調ガードの純粋判定を含む）。
    - _Validates: Requirements 5.4, 5.9_

  - [x] 4.7 `applyProjection` 永続・再配信・version エコー・単調ガードの統合テスト（Workers pool）
    - 投影押し込みで投影が永続され `config` が接続中クライアントへ再配信され、受領 version がエコーされることを確認する。次いで小さい version の押し込みが状態を変えず永続済み version を返すこと（単調ガード）を確認する。
    - 配置 `tests/shell/apply-projection.integration.test.ts`（Workers pool）。
    - _Validates: Requirements 5.2, 5.9_

  - [x] 4.8 未プロビジョニング拒否の書き込みゼロ統合テスト（Workers pool）
    - 未プロビジョニング storeId への WS 接続が拒否され、DO のストレージへ一切書き込まれない（痕跡が残らない）ことを確認する。
    - 配置 `tests/shell/unprovisioned.integration.test.ts`（Workers pool）。
    - _Validates: Requirements 2.6_

  - [x] 4.9 非活性化時の接続閉鎖の統合テスト（Workers pool）
    - `active=false` の投影受領後、新規接続が拒否され既存 WS が閉じられ、タイマー状態・投影は保持されることを確認する。
    - 配置 `tests/shell/deactivation.integration.test.ts`（Workers pool）。
    - _Validates: Requirements 6.6_

  - [x] 4.10 レジストリ不達時の自立稼働の統合テスト（Workers pool）
    - レジストリへの経路が不達でも、店舗 DO が最後に受領した投影でタイマー機能を継続することを確認する（rehydrate 時にレジストリ RPC を呼ばない）。
    - 配置 `tests/shell/autonomy.integration.test.ts`（Workers pool）。
    - _Validates: Requirements 6.1, 6.2_

- [x] 5. `src/worker.ts` のルーティング（Phase 1 範囲）
  - [x] 5.1 `/s/{storeId}/ws`・`/s/{storeId}/` 経路と storeId 検証・locationHint
    - `/s/{storeId}/ws`（WS）と `/s/{storeId}/`（画面・SPA フォールバック）のルーティングを追加する。ルーティング前段で `isValidStoreId` を検証し、不正・導出不能は HTTP 400 で DO へ到達させない（`DEFAULT_STORE_ID` へ落とさない）。店舗 DO スタブ取得は `idFromName(storeId)` → `get({ locationHint: "apac-ne" })`。
    - _Requirements: 1.1, 1.2, 1.4_

  - [x] 5.2 Provisioning_API ルーティングとレジストリ委譲（認可維持）
    - `POST /admin/stores`・`PUT /admin/chains/{id}`・`PUT /admin/policies/{id}`・`PUT /admin/stores/{id}`・`GET /admin/*` を `StoreRegistryDO("registry")` へ素通し委譲する。`isAdminAuthorized`（`timingSafeEqual` 定数時間比較）を維持し、`ADMIN_TOKEN` 未設定（空）や不一致は HTTP 401 でレジストリへ到達させない。ルート解釈・JSON パース・拒否型 400 応答はレジストリ `fetch` に閉じる（Worker 極薄維持）。
    - _Requirements: 2.8, 2.9, 8.1, 8.2, 8.3, 8.4_

  - [x] 5.3 `DEFAULT_STORE_ID` 配線・`/ws`・`PUT /admin/config` 直接委譲の撤去
    - 単一店舗固定の `/ws` 経路と `DEFAULT_STORE_ID` 配線、`Worker → StoreTimerDO` への `PUT /admin/config` 直接委譲を撤去する（設定投入経路を Provisioning_API → StoreRegistryDO → StoreTimerDO の一本にする）。
    - _Requirements: 2.8, 9.3_

  - [x] 5.4 定数時間トークン比較の property test（Property 21）
    - **Property 21: 定数時間トークン比較の正当性** — 任意の 2 文字列 `a`・`b` について `timingSafeEqual(a, b)` は `a === b` と同値の真偽を返し（長さ差も不一致へ織り込む）、`ADMIN_TOKEN` が空文字のとき `isAdminAuthorized` は任意の `Authorization` に対し常に偽を返す。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 21: 定数時間トークン比較の正当性`。配置 `tests/worker/admin-auth.property.test.ts`（既定 pool）。
    - _Validates: Requirements 8.1, 8.2_

  - [x] 5.5 ホットパス分離の統合テスト（Workers pool）
    - `/s/{storeId}/ws` の接続・再接続経路でレジストリ（`STORE_REGISTRY_DO`）への RPC が一切発生しないことを確認する（ホットパス分離）。
    - 配置 `tests/shell/hot-path.integration.test.ts`（Workers pool）。
    - _Validates: Requirements 7.7_

- [x] 6. クライアント接続導線（Phase 1 範囲）
  - [x] 6.1 `storeIdFromPath` と `/s/{storeId}/ws` 接続
    - `App.tsx` / `connection.ts` に `storeIdFromPath(pathname)`（`/s/{storeId}/` から storeId を読む）と `timerSocketUrl(storeId)`（`${wsProto}//${host}/s/${storeId}/ws`）を実装し、URL から読んだ同一 storeId で WS 接続する。
    - _Requirements: 1.3_

  - [x] 6.2 store-scoped オフライン永続（必須スコープ・フェイルセーフ）
    - `persistence.ts` の `scopedStorageKey(storeId)`（`yudemen.offline.view.v1:${storeId}`）と `localStorageViewStore(storeId)`（storeId を必須引数化）を実装する。現在の storeId にスコープされていない／一致しない永続ビューは空として扱い、前店舗ビューを再水和せずフェイルセーフに初期化する。
    - _Requirements: 1.5, 1.6_

  - [x] 6.3 storeId パス往復の property test（Property 2）
    - **Property 2: storeId のパス往復** — 妥当な storeId `id` について `storeIdFromPath("/s/" + id + "/")` は `id` に等しく、構成する WS URL は `/s/{id}/ws` を宛先に持つ。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 2: storeId のパス往復`。配置 `tests/client/store-path.property.test.ts`（既定 pool）。
    - _Validates: Requirements 1.3_

  - [x] 6.4 オフライン永続の storeId スコープの property test（Property 3）
    - **Property 3: オフライン永続の storeId スコープ（往復とフェイルセーフ）** — 保存時 storeId `a` と読み出し時 storeId `b` について、`a = b` のときに限り保存ビューが再水和され、`a ≠ b`（および未スコープ）のときは常に空ビュー（`EMPTY_VIEW`）が返る。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 3: オフライン永続の storeId スコープ（往復とフェイルセーフ）`。配置 `tests/client/persistence-scope.property.test.ts`（既定 pool）。
    - _Validates: Requirements 1.5, 1.6_

  - [x] 6.5 `tools/observe`・`tools/offline` を `/s/{storeId}/ws` 経路と storeId 必須シグネチャへ追随させる
    - Phase 1 でタスク 5.3 が単一店舗固定の `/ws` を撤去し、タスク 6.1 が `connection.ts` の接続を storeId 必須へ変えるため、本番検証資産が壊れる。これを追随させる（tooling フォロースルー・非 optional。実コンパイル／デプロイに影響するため）。
    - `tools/observe/probe.ts`（hibernation-observability の probe ハーネス）：接続先を `url.pathname = "/ws"` ＋ `?store=` クエリから `/s/{storeId}/ws` 経路へ移す。**storeId はパスに載せる**（`?store=` クエリではない）。`probe-cli.ts` の storeId 受け渡しも合わせる。
    - `tools/offline`（`degrade-cli.ts` / `link-gate.ts`）：本番の `openTimerConnection` を直接 import しており、storeId 必須シグネチャへの変更でコンパイルが壊れる。呼び出しを storeId 必須へ更新する。
    - `tools/observe/README.md` / `tools/offline/README.md` を新経路・新シグネチャ（storeId をパスで運ぶこと）へ更新する。
    - _Requirements: 1.1, 1.3（tooling フォロースルー — 本番の接続経路・シグネチャ変更に検証ハーネスを追随させる）_

  - [x] 6.6 前回使用店の記憶とクライアント側直行（ACCESS OFF 期の唯一の復帰経路）
    - design.md Component 10「ACCESS OFF 期の PWA 起動」に従い、前回使用店の Store_Path を記憶（保存・読み出し・不正時は「記憶なし」扱い）する。`ACCESS_REQUIRED=0` 期（＝ Phase 1〜2 全体）は Entry の行き先解決が存在しない（要件7.8）ため、start_url `/` で開いた SPA はこの記憶をクライアント側で読んで店舗パス（`/s/{storeId}/`）へ直行する。記憶が無い／不正なときは合鍵 URL 直叩きを案内する表示に落とす。
    - `persistence.ts`（前回使用店の保存・読み出し）と `App.tsx`（`/` で開いたときのクライアント側直行・案内表示）に実装する。
    - _Requirements: 7.6, 7.8（design.md Component 10「ACCESS OFF 期の PWA 起動」）_

  - [x] 6.7 前回使用店の記憶の往復の property test（Property 19）
    - **Property 19: 前回使用店の記憶の往復** — storeId を前回使用店として保存し読み出すと同一 storeId が得られる。保存が無い／不正なときは「記憶なし」を返し、（ACCESS ON 期は）Entry での解決に委ねる。タスク 6.6 の記憶の保存・読み出しを検証する。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 19: 前回使用店の記憶の往復`。配置 `tests/client/last-store.property.test.ts`（既定 pool）。
    - _Validates: Requirements 7.6_

- [x] 7. `wrangler.jsonc` と型再生成・静的検査（Phase 1）
  - [x] 7.1 `wrangler.jsonc` の更新（バインディング・マイグレーション・vars）
    - `STORE_REGISTRY_DO` バインディング（`class_name: "StoreRegistryDO"`）と `migrations` の `{ tag: "v2", new_sqlite_classes: ["StoreRegistryDO"] }` を追加する。`vars` から `STORE_UNIT_COUNT` / `STORE_ARMS` / `STORE_TOLERANCE_RATIO` / `STORE_NOODLE_PRESETS` を撤去し、`ACCESS_REQUIRED: "0"`（既定 OFF）・`TEAM_DOMAIN` / `POLICY_AUD` のプレースホルダを追加する。`ASSETS`・`ADMIN_TOKEN`（secret）は不変。
    - `.dev.vars` / `.env.development` に `STORE_*`（`STORE_UNIT_COUNT` / `STORE_ARMS` / `STORE_TOLERANCE_RATIO` / `STORE_NOODLE_PRESETS`）が残っていれば併せて削除する（ローカル環境ファイルにシードが残ると Smoke 検査 7.3 の「`STORE_*` 不在」が偽陽性で通らないため）。
    - _Requirements: 2.7, 8.7, 9.3_

  - [x] 7.2 `pnpm cf-typegen` で `Env` 型を再生成
    - `wrangler.jsonc` 変更後に `pnpm cf-typegen`（`wrangler types`）を実行し `worker-configuration.d.ts` を再生成する（`STORE_REGISTRY_DO` / `ACCESS_REQUIRED` / `TEAM_DOMAIN` / `POLICY_AUD` を反映、`STORE_*` を除去）。
    - _Requirements: 9.3_

  - [x] 7.3 撤去・不変・漏洩不能の静的検査（Smoke）
    - `src/engine`・`src/domain` の Timer 契約が不変（`TimerFact` ほか変更なし・要件9.1/9.2）、`ServerMessage` に Roster を表現するフィールドが無い（要件5.3）、`StoreProjection` および `StoreTimerDO` の永続・ワイヤに chain/policy/priority が無い（要件6.5）、`DEFAULT_STORE_ID`・`STORE_*` シードがコードベースに不在（要件9.3）、`ctx.storage.sql` 不使用（tooling）、`src/registry/` が `cloudflare:workers`／storage を import しない純粋性を静的に検査する。
    - 配置 `tests/per-store-provisioning.static.test.ts`（既定 pool）。以後の Phase で追加ファイルを本検査に追随させる。
    - _Validates: Requirements 5.3, 6.5, 9.1, 9.2, 9.3_

- [x] 8. チェックポイント — Phase 1 の green を確認
  - `pnpm typecheck` / `pnpm lint` / `pnpm test`（`vitest --run`）を実行し、Phase 1 の型・静的解析・テスト（既定 pool の registry/client、Workers pool の shell/DO）が通ることを確認する。問題があればユーザーに相談する。

### Phase 2 — Policy 合成

- [x] 9. Policy CRUD・割当・曖昧割当検証
  - [x] 9.1 `createOrUpdatePolicy` と店舗への Policy 割当
    - `StoreRegistryDO` に `createOrUpdatePolicy(input)` を実装し、`updateStore` を `policyIds`（Policy 割当）更新に対応させる。Policy／割当変更を put-first で確定し、`affectedStores` の Policy 変種で影響店舗の収束を開始する（`recomposeProjection` が割当済み Policy を `composeEffectiveConfig` に渡す配線）。
    - Policy フィールド（mode/値）の拒否型検証は Phase 1 で導入した `validateProvisioningInput`（タスク 2.6）を再利用し、未知フィールド・型不一致・値域外は HTTP 400・イデア不変とする。
    - _Requirements: 3.3, 3.7, 4.6_

  - [x] 9.2 曖昧な Policy 割当の入口検証（400）
    - 同一店舗に対し同一 priority かつ同一フィールドを主張する複数 Policy の割当が投入されたとき、入口検証で HTTP 400 拒否・イデア不変とする（曖昧な統制を表現可能にしない）。
    - _Requirements: 3.4_

  - [x] 9.3 曖昧割当検出の property test（Property 6）
    - **Property 6: 曖昧な Policy 割当の検出** — 店舗への Policy 割当集合について、同一 priority かつ同一フィールドを主張する 2 つ以上の Policy が存在するとき、かつそのときに限り入口検証が拒否する。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 6: 曖昧な Policy 割当の検出`。配置 `tests/registry/policy-validation.property.test.ts`（既定 pool）。
    - _Validates: Requirements 3.4_

- [x] 10. `composeEffectiveConfig` の全意味論
  - [x] 10.1 priority 昇順畳み込み・enforced 支配・配列丸ごと置換・Override 復活
    - `composeEffectiveConfig` を縮退実装から全実装へ拡張する：priority 昇順（同着は `policyId` 昇順）に畳み、`enforced` はその層で確定し以後ロック（後の層・Override が無視）、縦の衝突は最小 priority が勝つ、`default` は後の層が上書き可、配列（`noodlePresets`）は丸ごと置換（要素マージなし）。`Store_Override` は最終層でロック外フィールドにのみ適用され、統制解除で復活する。純粋・決定的・順序非依存。
    - _Requirements: 4.2, 4.3, 4.4, 4.7_

  - [x] 10.2 合成の純粋・完全・値域内の property test（Property 10）
    - **Property 10: 合成は純粋・完全・値域内** — `composeEffectiveConfig` は同入力に同出力（決定的・順序非依存）で、出力は `StoreConfig` の全フィールドを持ち各値が対応検証関数の値域に収まる。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 10: 合成は純粋・完全・値域内`。配置 `tests/registry/compose.property.test.ts`（既定 pool）。
    - _Validates: Requirements 4.1, 4.5_

  - [x] 10.3 enforced 支配の property test（Property 11）
    - **Property 11: enforced 支配（最小 priority が勝ち default は最後の層が勝つ）** — あるフィールドを enforced 主張する層があるとき出力はその最小 priority の enforced 層の値に等しく後続を無視する。enforced 主張が無いフィールドは最大 priority の主張層（無ければ Override、無ければ `DEFAULT_*`）の値。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 11: enforced 支配（最小 priority が勝ち default は最後の層が勝つ）`。配置 `tests/registry/compose.property.test.ts`（既定 pool）。
    - _Validates: Requirements 4.2, 4.3_

  - [x] 10.4 配列丸ごと置換の property test（Property 12）
    - **Property 12: 配列フィールドは丸ごと置換される** — 複数層が `noodlePresets` を主張するとき、出力 `noodlePresets` は勝った単一層の配列と要素まで完全一致する（層をまたぐ要素マージが起きない）。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 12: 配列フィールドは丸ごと置換される`。配置 `tests/registry/compose.property.test.ts`（既定 pool）。
    - _Validates: Requirements 4.4_

  - [x] 10.5 統制解除で Override 復活の property test（Property 13）
    - **Property 13: 統制解除で Store_Override が復活する** — フィールド `f` を enforced 主張する層があるときの合成は override を無視し、その enforced 主張を取り除いた同一イデアの合成は保持されていた `override.f` を反映する。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 13: 統制解除で Store_Override が復活する`。配置 `tests/registry/compose.property.test.ts`（既定 pool）。
    - _Validates: Requirements 4.7_

  - [x] 10.6 合成の example / edge-case test（合成の値決定のみ）
    - 空 Policy 群・空 Override → 合成結果が全フィールド `DEFAULT_*`。priority 昇順・enforced 支配・default 上書き・配列丸ごと置換の代表例。`composeEffectiveConfig` の値決定だけを検証する純粋テスト（HTTP 面・入口検証には触れない — 入口の拒否判定は `validateProvisioningInput` の責務でタスク 2.7 が検証、400 応答の配線はタスク 10.7 が検証）。
    - 配置 `tests/registry/compose.example.test.ts`（既定 pool）。
    - _Requirements: 4.1, 4.5_

  - [x] 10.7 入口拒否の HTTP 400・イデア不変の統合テスト（Workers pool）
    - Provisioning_API へ未知フィールド・型不一致・値域外の投入を送り、`StoreRegistryDO` の入口（`validateProvisioningInput` を用いる Policy／Store／Chain 経路）が HTTP 400 を返し、イデア（`chain:*` / `policy:*` / `store:*` / `meta:revision`）を一切変更しない（黙って既定へ畳まない）ことを確認する。`composeEffectiveConfig` の default-pool 例示テストでは検証できない HTTP 表面と put 不変の配線を担う。
    - 配置 `tests/shell/registry-ingress.integration.test.ts`（Workers pool）。
    - _Validates: Requirements 4.6_

- [x] 11. チェックポイント — Phase 2 の green を確認
  - `pnpm typecheck` / `pnpm lint` / `pnpm test`（`vitest --run`）を実行し、Phase 2 追加分を含め全テストが通ることを確認する。問題があればユーザーに相談する。

### Phase 3 — Roster + Access + Entry

- [x] 12. Roster と逆引きインデックス
  - [x] 12.1 `src/registry/roster.ts` — `effectiveRoster`（和集合・deny なし）
    - `effectiveRoster(chainRoster, storeRoster)` をチェーン Roster と店舗 Roster の和集合（重複排除）として実装する。priority / enforced の統制意味論を持たず deny 手段も持たない。純粋・冪等・順序非依存。
    - _Requirements: 3.5_

  - [x] 12.2 `src/registry/reverse-index.ts` — `buildReverseIndex` / `storesForIdentity`
    - `ReverseIndex`（`ReadonlyMap<Identity, readonly StoreId[]>`）と `buildReverseIndex(chains, stores)`（活性店舗のみを `createdAt` 昇順・同着 storeId 昇順で走査し `effectiveRoster` から identity→storeId を積む）、`storesForIdentity(index, identity)`（単一読み出し・未登録は空配列）を実装する。イデアからの導出値であり全イデアから再構築可能。
    - _Requirements: 3.6, 7.4_

  - [x] 12.3 `updateRoster` と逆引き再導出・投影への Roster 配線
    - `StoreRegistryDO` に `updateRoster(target, roster)`（チェーン／店舗）を実装し、名簿書き込み時に `buildReverseIndex` で `index:reverse` を再導出する。`affectedStores` の Roster 変種と `recomposeProjection` に `effectiveRoster` を配線し、名簿変更が影響店舗の投影 `roster` へ反映されるようにする（Phase 1 の空配列から実効名簿へ）。
    - `updateRoster` は内部メソッドであり、新規の公開ルートを追加しない。Roster は `PUT /admin/chains/{id}` / `PUT /admin/stores/{id}` のボディに載せて運ぶ（design.md Component 7 のルート表に一致。チェーン Roster はチェーンのボディ全置換、店舗 Roster は店舗更新のボディに含める）。
    - _Requirements: 3.5, 3.6, 3.7_

  - [x] 12.4 実効 Roster の property test（Property 7）
    - **Property 7: 実効 Roster は和集合であり冪等・順序非依存** — `effectiveRoster` の結果は両 Roster の和集合（集合として）に等しく、いずれの要素も除外されず（deny なし）、`effectiveRoster(a, effectiveRoster(a, b))` は `effectiveRoster(a, b)` に等しく入力順序に依らない。identity は非 ASCII・空に近い・重複を含む文字列で生成する。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 7: 実効 Roster は和集合であり冪等・順序非依存`。配置 `tests/registry/roster.property.test.ts`（既定 pool）。
    - _Validates: Requirements 3.5_

  - [x] 12.5 逆引きインデックスの property test（Property 8）
    - **Property 8: 逆引きインデックスはイデアと整合し再構築可能** — `buildReverseIndex` の結果は全活性店舗の `effectiveRoster` を走査した参照実装と一致し、任意 identity `e` の `storesForIdentity(index, e)` は「`e` が実効 Roster に含まれる活性店舗の storeId 集合（登録順）」にちょうど等しく非活性店舗を含まない。店舗数 1..N（個人店＝1 店チェーンを含む）で振り同型性を担保する。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 8: 逆引きインデックスはイデアと整合し再構築可能`。配置 `tests/registry/reverse-index.property.test.ts`（既定 pool）。
    - _Validates: Requirements 3.6, 3.2_

- [x] 13. Access JWT 検証と接続時認可
  - [x] 13.1 `jose` 依存の追加
    - `pnpm add jose` を実行し、Access JWT の JWKS 署名検証依存を追加する（`npm`/`yarn`/`npx` は使わない）。
    - _Requirements: 8.6_

  - [x] 13.2 `verifyAccessIdentity`（JWKS 署名検証・未検証は 403）
    - `src/worker.ts` に `verifyAccessIdentity(request, env)` を実装する：`createRemoteJWKSet(new URL(`${TEAM_DOMAIN}/cdn-cgi/access/certs`))`（モジュールスコープに保持しキャッシュを跨リクエスト再利用）と `jwtVerify(token, JWKS, { issuer: TEAM_DOMAIN, audience: POLICY_AUD })` で `Cf-Access-Jwt-Assertion` を検証し、欠如・無効は 403。`ACCESS_REQUIRED` が ON のときのみ経路に入る。
    - _Requirements: 8.5, 8.6_

  - [x] 13.3 内部 identity ヘッダの偽装防御
    - 店舗 DO へ identity を運ぶ内部ヘッダを、転送時に必ず無条件で除去した上で、`ACCESS_REQUIRED` ON かつ検証成功時にのみ Worker が付与し直す（クライアント由来の同名ヘッダを決して透過しない。OFF 時も除去する）。
    - _Requirements: 8.6_

  - [x] 13.4 接続時 Roster 認可（投影のみ・レジストリ照会なし）と identity 正規化
    - `StoreTimerDO` の接続経路で、`ACCESS_REQUIRED` ON 時に Worker が付与した検証済み identity を永続投影の Roster にローカル照合し、不一致なら接続拒否する（レジストリへ照会しない）。identity の正準クレーム正規化 `normalize`（冪等・決定的）を実装し照合に用いる。OFF 時は Roster 照合を行わずプロビジョニング済みのみを条件とする。
    - _Requirements: 6.3, 6.4, 9.5_

  - [x] 13.5 接続時認可の property test（Property 17）
    - **Property 17: 接続時認可は実効 Roster の所属判定** — Access ON 時の接続許可は identity が実効 Roster に含まれることと同値である（判定は投影のみで完結しレジストリへ照会しない）。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 17: 接続時認可は実効 Roster の所属判定`。配置 `tests/registry/authz.property.test.ts`（既定 pool・所属判定の純粋関数）。
    - _Validates: Requirements 6.3_

  - [x] 13.6 identity 正規化の property test（Property 20）
    - **Property 20: identity 正規化は冪等・決定的** — 生の identity クレーム文字列について `normalize` は決定的であり `normalize(normalize(x))` は `normalize(x)` に等しい。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 20: identity 正規化は冪等・決定的`。配置 `tests/registry/authz.property.test.ts`（既定 pool）。
    - _Validates: Requirements 9.5_

  - [x] 13.7 Access JWT 検証の統合テスト（Workers pool）
    - 有効・無効・欠如トークンの 1〜3 例で、有効時のみ検証済み identity が店舗 DO へ引き渡され、無効・欠如は 403 になることを確認する（`jose`/JWKS の外部挙動）。
    - 配置 `tests/worker/access-jwt.integration.test.ts`（Workers pool）。
    - _Validates: Requirements 8.6_

- [x] 14. Entry と行き先解決・店舗切替
  - [x] 14.1 `resolveEntryDestination` と Entry `/` 逆引きリダイレクト
    - `src/worker.ts` に `resolveEntryDestination(stores)` を実装し、Entry `/`（Access ON）で JWT 検証 → `storesForIdentity`（レジストリ RPC・低頻度）で行き先を解決する：1 店舗は当該 Store_Path へリダイレクト、複数は既定店（登録順の先頭）へリダイレクト、0 店舗は「接続先なし」を返す（いずれもフォールバックしない）。PWA の start_url は共通 `/` に固定。
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 14.2 `GET /entry/stores` と店舗切替 UI
    - `GET /entry/stores`（Access ON・JSON `(storeId, name)[]` を返す）を Worker に実装する。クライアント（`App.tsx` / `connection.ts`）で複数店舗担当向けの店舗切替 UI（表示は `name`）を設定画面に出し、接続拒否時は Entry へ戻って再解決する。
    - 前提：Entry `/` の逆引きリダイレクト（タスク 14.1）が既に存在すること（「接続拒否時に Entry へ戻って再解決」は 14.1 の Entry リダイレクトに委ねる）。前回使用店の記憶とクライアント側直行は Phase 1 のタスク 6.6 で実装済みのため本タスクからは除く。
    - _Requirements: 7.4, 7.6_

  - [x] 14.3 `ACCESS_REQUIRED="1"` への切替（env のみ・コード変更なし）
    - `wrangler.jsonc` の `ACCESS_REQUIRED` を `"1"` へ切り替えたとき、JWT 検証＋Roster 判定＋Entry 解決が有効化され、`"0"` では合鍵 URL 直叩きに戻る分岐が env のみで切り替わることを確認する（フラグ切替にコード変更を要しない）。
    - _Requirements: 8.7_

  - [x] 14.4 行き先解決の property test（Property 18）
    - **Property 18: Entry の行き先解決** — `resolveEntryDestination` は要素数 1 で当該店舗の Store_Path へのリダイレクト、複数で先頭（登録順）へのリダイレクトと全リストの受け渡し、0 で「接続先なし」を返す（いずれもフォールバックしない）。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: per-store-provisioning, Property 18: Entry の行き先解決`。配置 `tests/worker/entry.property.test.ts`（既定 pool）。
    - _Validates: Requirements 7.3, 7.4, 7.5_

  - [x] 14.5 Entry と分岐の example / edge-case test
    - `ACCESS_REQUIRED="0"` 時は Entry の行き先解決を提供しない（合鍵 URL 直叩き）。`resolveEntryDestination([])` が「接続先なし」。`"0"` で Roster 外 identity でも接続可・`"1"` で拒否。
    - 配置 `tests/worker/entry.example.test.ts`（既定 pool）。
    - _Requirements: 6.4, 7.5, 7.8, 8.7_

- [x] 15. 最終チェックポイント — 全 Phase の green と静的検査を確認
  - `pnpm typecheck` / `pnpm lint` / `pnpm test`（`vitest --run`）を実行し、全タスク完了後に型・静的解析・全テスト（既定 pool の registry/client/worker、Workers pool の shell/DO）と Smoke 静的検査が通ることを確認する。問題があればユーザーに相談する。

## Notes

- `*` 付き下位タスクは property / integration / example / smoke テストで、MVP 短縮時にスキップ可能（コア実装のトップレベルタスクは非 optional）。
- PBT は `fast-check`（v4 系）で各プロパティ **最低 100 イテレーション**、タグ形式 `Feature: per-store-provisioning, Property {番号}: {本文}` を付す。設計の 22 Correctness Properties を各 1 サブタスクに割り当て、その関数を実装する Phase 直下に配置して早期に誤りを捕える。
- 統合テスト（put-first・`applyProjection`・未プロビジョニング拒否・非活性化・100 店 fan-out・自立性・ホットパス分離・入口拒否 HTTP 400・JWT 検証）は Workers pool（`cloudflareTest()`）、`src/registry/` の純粋関数・client の純粋ロジックは既定 pool で実行する。
- 入口の拒否型検証（要件4.6）は純粋関数 `validateProvisioningInput`（タスク 2.6・`src/registry/` のレジストリ内部ヘルパ）に切り出し、Phase 1 の Chain / Store 入口（タスク 3.2・Override とチェーン Roster 値）と Phase 2 の Policy 入口（タスク 9.1）が同一判定を再利用する。検証は二層に分ける：判定（accept/reject）は default pool の example（タスク 2.7）、HTTP 400 応答＋イデア不変の配線は Workers pool の統合テスト（タスク 10.7）。`composeEffectiveConfig` の example（タスク 10.6）は合成の値決定のみを担い、HTTP 面を検証しない。
- tools フォロースルー（タスク 6.5）：Phase 1 でタスク 5.3（`/ws` 撤去）とタスク 6.1（`connection.ts` の storeId 必須シグネチャ）が本番接続経路を変えるため、検証ハーネス `tools/observe`（probe は storeId を**パス**で運ぶ）と `tools/offline`（`openTimerConnection` を直接 import）を同 Phase 内で追随させる（非 optional。放置すると Phase 1 デプロイでコンパイル／接続不能になるため deferしない）。
- 前回使用店の記憶（タスク 6.6・Property 19＝タスク 6.7）は Phase 1 へ前倒し。`ACCESS_REQUIRED=0` 期（Phase 1〜2）は Entry の行き先解決が存在せず（要件7.8）、start_url `/` の PWA がクライアント側の記憶で店舗パスへ直行するのが唯一の復帰経路（design.md Component 10）。Phase 3 のタスク 14.2 は `GET /entry/stores`・店舗切替 UI・拒否時 Entry 復帰のみを担う。
- Smoke 静的検査（タスク 7.3）は engine/domain 不変・`ServerMessage` に Roster なし・`StoreProjection`/DO ワイヤに chain/policy/priority なし・`DEFAULT_STORE_ID`/`STORE_*` 不在・`ctx.storage.sql` 不使用・`src/registry/` 純粋性を担保し、Phase が進むごとに追加ファイルへ追随させる。
- ツール規律（`tooling.md`）：`pnpm` / `Vitest v4`（`cloudflareTest()`）/ `oxlint` / `tsc --noEmit`。`wrangler.jsonc` 変更後は必ず `pnpm cf-typegen`。テストは `vitest --run`（watch を使わない）。
- 段階規律：イデアのスキーマ・`StoreProjection` の形・`applyProjection` の受け口は Phase 1 で最終形。Phase 2/3 は追加のみでスキーマ移行を要しない。
- 命名確認は完了済み（naming ゲート通過）。公開シンボル名は Overview 記載の確定名をそのまま用いる。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "6.2", "7.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "6.1", "7.2"] },
    { "id": 2, "tasks": ["2.2", "2.6", "4.1", "5.1"] },
    { "id": 3, "tasks": ["3.1", "4.2"] },
    { "id": 4, "tasks": ["3.2", "4.3", "5.2"] },
    { "id": 5, "tasks": ["3.3", "4.4", "5.3"] },
    { "id": 6, "tasks": ["3.4", "4.5", "6.5", "6.6"] },
    { "id": 7, "tasks": ["1.4", "1.5", "1.6", "2.3", "2.4", "2.5", "2.7", "3.5", "3.6", "3.7", "4.6", "4.7", "4.8", "4.9", "4.10", "5.4", "5.5", "6.3", "6.4", "6.7", "7.3"] },
    { "id": 8, "tasks": ["9.1", "10.1"] },
    { "id": 9, "tasks": ["9.2"] },
    { "id": 10, "tasks": ["9.3", "10.2", "10.3", "10.4", "10.5", "10.6", "10.7"] },
    { "id": 11, "tasks": ["12.1", "12.2", "13.1"] },
    { "id": 12, "tasks": ["12.3", "13.2", "13.4"] },
    { "id": 13, "tasks": ["13.3"] },
    { "id": 14, "tasks": ["14.1"] },
    { "id": 15, "tasks": ["14.2", "14.3"] },
    { "id": 16, "tasks": ["12.4", "12.5", "13.5", "13.6", "13.7", "14.4", "14.5"] }
  ]
}
```
