# Implementation Plan: Cloudflare Access の本番有効化（cloudflare-access-enablement）

## Overview

本計画は `design.md`（正本 `requirements.md` から演繹）に従い、休眠中の Access 統合機構を本番で有効化するための作業列である。本 spec の中核は**アプリの外**（Cloudflare Access 構成・運用手続き）にあり、アプリコードへの新規追加は**有効化ガード（純粋述語）ただ一点**に限る。休眠機構（`verifyAccessIdentity` / `IDENTITY_HEADER` 除去・付与 / Entry 逆引き / 店舗 DO の Roster 照合）は per-store-provisioning で実装・検証済みゆえ**再実装しない**（作動確認のみ）。ヘルスチェックは新設せず、既存の静的アセット経路（例: `/favicon.svg`）を Access の bypass 対象にするのみ（新設コードゼロ・Q-health 確定・要件2.4 / 8.6）。

実装言語は既存コードベースに従い **TypeScript**（strict）。ツールは確定スタック（pnpm / Vitest v4 + `@cloudflare/vitest-pool-workers` / fast-check v4 / oxlint / `tsc --noEmit` / Wrangler / `pnpm cf-typegen`）に従う（`tooling.md`）。有効化ガードの property-based test は既定 pool（node・`cloudflare:workers` 非依存の純粋モジュールを端に置く）、既存経路の作動確認（DO 到達）は Workers pool で駆動する。ユーザー向け CLI 出力は英語、コードコメントは日本語。

**タスク種別の凡例**（コードで自動検証できるか否かの区別。要件・設計の趣旨に沿ってタスクを二分する）:

- **［コード］** — コーディングエージェントが writing / modifying / testing で完結できるタスク（純粋モジュール実装・PBT・CLI・作動確認テスト・`wrangler.jsonc` 編集・`cf-typegen`）。
- **［手続き］** — Cloudflare Access ダッシュボード/API・IdP・外形監視・失効運用など**コードで自動検証できない**設定/運用タスク。成果物はチェックリスト・ランブック・スモーク手順（markdown）であり、実際の Cloudflare 構成・切替・監視・失効は運用者が手順に従って実施する。コーディングエージェントはチェックリスト/ランブックの整備までを担う。

> **公開シンボル名（`naming.md`・確定済み）:** 本 spec で新規に導入する公開シンボルは**有効化ガードの純粋関数・結果型・モジュール配置**と、それを呼ぶ**デプロイ前検査 CLI の配置**のみであり（design.md「命名の確認事項」節 2）、**いずれもユーザー最終決定として確定している**。公開関数は `enablementReadiness`（名詞形。`is〜` は真偽のみ示唆し名前が嘘をつくため不採用・`naming.md` の禁止汎用語 `validate` / `check` / `Config` も避ける）、結果型は `EnablementReadiness`（`{ ready: true } | { ready: false; invalid: (...)[] }` の判別可能型で「不正変数を過不足なく含む」を型で表明）、純粋モジュールは `src/access-enablement.ts`（`src/registry` には置かない）、デプロイ前検査 CLI は `tools/check-access-enablement.ts`。後続の全コードタスクでこれらの確定名を一貫して用いる。既存シンボル（`verifyAccessIdentity` / `canonicalIdentity` / `IDENTITY_HEADER` / `isRostered` / `effectiveRoster` / `resolveEntryDestination` / `normalize` / `isAdminAuthorized`）は名称・意味とも変更しない（要件10）。

> **未決事項（外部決定・コーディングを直接ブロックしない）:** [Q-idp] EntraID のフェデレーション方式（OIDC/SAML・要件3.1）と [Q-session] Access セッション寿命の具体値（要件9.5）は外部決定に属す。これらの確定を要する**設定タスク**（3.1 は 7.2 に、9.5 は 9.3 に対応）には依存として明記する。コードタスク（有効化ガード・CLI・作動確認テスト・`wrangler.jsonc`）はこれらの確定を待たずに着手できる。

## Tasks

- [x] 1. 公開シンボル名とモジュール配置の確定（実装の前提）
  - [x] 1.1 有効化ガードの公開シンボル名とモジュール配置を確定する ［手続き］
    - **（完了: 関数 `enablementReadiness`／型 `EnablementReadiness`／モジュール `src/access-enablement.ts`／CLI `tools/check-access-enablement.ts` に確定。すべてユーザー最終決定。）** 後続の全コードタスクでこれらの確定名・確定配置を一貫して用いる
    - 確定内容: 公開関数名 `enablementReadiness`（名詞形。`is〜` は真偽のみ示唆し名前が嘘をつくため不採用・`naming.md` の禁止汎用語 `validate` / `check` / `Config` を避ける）、結果型名 `EnablementReadiness`（`{ ready: true } | { ready: false; invalid: (...)[] }` の判別可能型で「不正変数を過不足なく含む」を型で表明）、純粋モジュール配置 `src/access-enablement.ts`（`src/registry` には置かない）、デプロイ前検査 CLI 配置 `tools/check-access-enablement.ts`
    - design.md「命名の確認事項」節 2 の概念境界・既存ドメイン語彙との対応と整合。既存シンボルは不変（要件10）
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 2. 有効化ガード（純粋述語）の実装と property テスト
  - [x] 2.1 有効化ガードの純粋モジュールを実装する ［コード］
    - 確定配置 `src/access-enablement.ts`（プラットフォーム非依存を端に寄せる方針＝`worker-auth.ts` / `worker-entry.ts` と同型・構造の主権。`src/registry` には置かない）に、`TEAM_DOMAIN` / `POLICY_AUD` 文字列を入力に取り「本番有効化に足る実値か」を判定する純粋述語 `enablementReadiness` を実装する。結果は判別可能型 `EnablementReadiness`（`{ ready: true } | { ready: false; invalid: (...)[] }`）で返す
    - `TEAM_DOMAIN` 形式判定: `https://` で始まり、サブドメイン部が DNS ラベルの文字集合 `[a-z0-9-]`（先頭・末尾ハイフン不可等の妥当な DNS ラベル規則）に収まる 1〜63 文字、末尾が `.cloudflareaccess.com`、かつ既定プレースホルダ `https://<team>.cloudflareaccess.com` と不一致（`<` `>` を含むタイポ版プレースホルダを文字集合検査で弾く）
    - `POLICY_AUD` 判定: 非空かつ既定プレースホルダ `<access-app-aud>` と不一致
    - 出力: 有効化可否（真偽）と、不成立時にどの変数が不正（空・未設定・プレースホルダ一致・形式不適合）かを過不足なく示す診断（要件5.3 のエラー提示に用いる判別可能型）。述語は純粋に保ち、作用（デプロイ中止・エラー提示）は呼び出す CLI 側（タスク 3.1）へ寄せる
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 2.2 TEAM_DOMAIN 形式適合の property テストを書く ［コード］
    - **Property 1: TEAM_DOMAIN 形式適合の判定**
    - **Validates: Requirements 5.1**
    - fast-check（v4）・既定 pool（node）・最低 100 回反復（`numRuns: 100` 以上）。generator に「正しい形式」「空」「プレースホルダ一致」「サブドメイン長 0/1/63/64」「スキーム欠如（`http://`・スキームなし）」「末尾ドメイン不一致」「`<` `>` を含む擬似プレースホルダ」「DNS ラベル文字集合外（大文字・記号・先頭/末尾ハイフン）」を織り込む
    - タグコメント `// Feature: cloudflare-access-enablement, Property 1: TEAM_DOMAIN 形式適合の判定`

  - [x] 2.3 有効化ガードの合成判定と不正変数診断の property テストを書く ［コード］
    - **Property 2: 有効化ガードの合成判定と不正変数の診断**
    - **Validates: Requirements 5.2, 5.3**
    - fast-check（v4）・既定 pool（node）・最低 100 回反復。`(teamDomain, policyAud)` の 2 文字列に対し「両者が有効なときかつそのときに限り有効化可」を検証し、有効化不可のとき診断が不正変数（空・未設定・プレースホルダ一致・形式不適合）を過不足なく含むことを検証。`policyAud` は「空」「プレースホルダ一致」「任意の非空文字列」を織り込む
    - タグコメント `// Feature: cloudflare-access-enablement, Property 2: 有効化ガードの合成判定と不正変数の診断`

- [x] 3. デプロイ前検査 CLI（`tools/` 配下）
  - [x] 3.1 有効化ガードを呼ぶデプロイ前検査 CLI を実装する ［コード］
    - 確定配置 `tools/check-access-enablement.ts` に、`wrangler.jsonc` vars またはデプロイ時オーバーライドの値を読み、タスク 2.1 の純粋述語 `enablementReadiness`（`src/access-enablement.ts`）で判定する CLI を実装する。不成立（プレースホルダ残存・形式不適合）なら `ACCESS_REQUIRED="1"` を伴うデプロイを中止し、どの変数が・なぜ不正かを英語で提示して非ゼロ終了する（作用は端・安全側の既定＝判定不能なら OFF に留める）
    - `pnpm cf-typegen`（`Env` 型再生成）の失敗を検知したときも `ACCESS_REQUIRED="1"` へ切り替えず、型再生成失敗を示すエラーを提示する（要件5.5）
    - 純粋述語モジュールは `src/` 配下、それを呼ぶ CLI は `tools/` 配下という分離を保つ（構造の主権）。runtime の Worker に恒久ガードを足さない（要件が課すのは切替手続きの前提条件・足し算回避）
    - _Requirements: 5.3, 5.5_

  - [x] 3.2 デプロイ前検査 CLI の example テストを書く ［コード］
    - プレースホルダ残存・形式不適合・型再生成失敗の各ケースで非ゼロ終了と不正変数の提示を、正常値ケースでゼロ終了を、具体例で固める。ユーザー向け出力が英語であることも確認
    - _Requirements: 5.3, 5.5_

- [x] 4. チェックポイント — 有効化ガードとデプロイ前検査 CLI のテストが通ることを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. 既存休眠経路の本番構成での作動確認テスト（既存コードを再実装しない・要件10.1）
  - [x] 5.1 合成 email 非一致で 403 になる作動確認テストを書く ［コード］
    - `ACCESS_REQUIRED="1"` の env override 下で、合成 email 形式でない（＝どの Roster 正準形にも一致しない）identity を載せた JWT による `/s/{storeId}/ws` 接続が既存 Roster ゲートの帰結として 403 になり店舗 DO の状態を変えないことを、Workers pool（`@cloudflare/vitest-pool-workers`）で確認する。新たな形式バリデーションは足さない（既存 `isRostered` の帰結を確認するのみ）
    - _Requirements: 4.2, 6.5_

  - [x] 5.2 クライアント由来 IDENTITY_HEADER 偽装除去の作動確認テストを書く ［コード］
    - `ACCESS_REQUIRED` が `"0"` / `"1"` のいずれの構成でも、各種大小文字表記のクライアント由来 `X-Yudemen-Identity`（`IDENTITY_HEADER`）が店舗 DO への転送前に無条件除去され DO 受信ヘッダに現れないこと、および `"1"` かつ JWT 検証成功時のみ検証済み identity が付与されることを Workers pool で確認する（既存の無条件除去・検証済み付与の作動確認）
    - _Requirements: 7.2, 7.3_

  - [x] 5.3 ADMIN_TOKEN 判定の ACCESS_REQUIRED 非依存の作動確認テストを書く ［コード］
    - `ACCESS_REQUIRED` が `"0"` / `"1"` の両構成で `/admin/*` の認可判定（`ADMIN_TOKEN` 一致で透過・不一致/空で 401）が同一であることを確認する（別系統が Access 有効化の切替に影響されない・`isAdminAuthorized` ロジックは既存 PBT を参照し再検証しない）
    - _Requirements: 10.3, 10.6_

- [x] 6. Deployment_Config の投入方式と型再生成
  - [x] 6.1 wrangler.jsonc の既定を OFF に保ち実値投入をデプロイ時オーバーライドに寄せる ［コード］
    - `wrangler.jsonc` の vars で `ACCESS_REQUIRED` の**リポジトリ既定を `"0"`（OFF）に保つ**ことを確認し、`TEAM_DOMAIN` / `POLICY_AUD` はプレースホルダを残す（実値はデプロイ時オーバーライドで投入する移行期方式・要件5.6）。実値の投入はタスク 8.2 の切替手順に組み込む。vars を編集した場合は必ずタスク 6.2 の型再生成を伴わせる
    - オーバーライド方式は移行期の手段であり恒久状態にしない旨（恒久対処はタスク 9.4 の既定反転）を `wrangler.jsonc` の該当コメントに保つ
    - _Requirements: 5.6_

  - [x] 6.2 pnpm cf-typegen で Env 型を再生成する ［コード］
    - `wrangler.jsonc` の vars を変更したら `pnpm cf-typegen`（`wrangler types`）で `Env` 型を再生成し、設定の単一の正本と型を同期する（`wrangler.jsonc` を唯一の出所とする）。再生成失敗時は ON へ進まない（タスク 3.1 のガードと整合）
    - _Requirements: 5.4, 5.5_

- [x] 7. Cloudflare Access 構成と環境分離検証（Pilot 先行）
  - [x] 7.1 単一 Access_Application と Pilot_Access_Application を本番同一の構成次元で構成する ［手続き］
    - 成果物: 構成チェックリスト（markdown）。認証を課すアプリ定義=1・店舗別ポリシー=0、認証対象に含める経路（Entry `/`・Store_Path `/s/{storeId}/`・`/s/{storeId}/ws`）、除外経路（`/admin/*`・既存アセット経路 例: `/favicon.svg` を bypass 用アプリ定義＋全員 Bypass ポリシーで実現・個数は店舗数非依存の定数個）、issuer=TEAM_DOMAIN・audience=POLICY_AUD の単一固定、許可 IdP=EntraID・whereami の 2 つ。Pilot は本番同一構成の縮小版で OTP_Login を許可（本番の Access_Application には OTP_Login を追加しない）。Pilot と本番の構成次元（許可 IdP 集合・包含/除外経路・audience が単一値に固定されている構成。aud 値そのものは各アプリ固有ゆえ異なってよい）を一致させる
    - 検証対象は、Pilot_Access_Application の aud を POLICY_AUD に持ち `ACCESS_REQUIRED="1"`・実 TEAM_DOMAIN で動く検証用デプロイ（本番とは別）である。この検証デプロイの用意（Pilot 用の値でのデプロイ）を本タスクに含める。これにより後続のオフィス完結検証（タスク 7.4）の OTP ログインの向き先が確定する
    - コードで自動検証できない設定タスク。実際の Cloudflare 構成は運用者が本チェックリストに従い実施する
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 1.5, 1.1, 10.5, 10.7_

  - [x] 7.2 EntraID_IdP をフェデレーションし Access_Application のログイン方式に加える ［手続き］
    - 成果物: フェデレーション設定手順（markdown）。EntraID_IdP を OIDC または SAML の**いずれか一方**でフェデレーションし、発行 JWT の `email` クレームに検証済み実 email を欠落・空文字なく載せる。観測点＝テストユーザーが認証を完了し POLICY_AUD を aud とする JWT を発行できること
    - **依存 [Q-idp]**: フェデレーション方式（OIDC/SAML）の確定を要する（whereami と検証経路が揃う OIDC を推奨・要件3.1）。方式確定前は手順を暫定とし、確定後に一方へ確定する。コードで自動検証できない設定タスク
    - _Requirements: 3.1, 3.2_

  - [x] 7.3 whereami generic OIDC を split-horizon で構成する ［手続き］
    - 成果物: generic OIDC 接続設定手順（markdown）。Authorization=内部名ホストの `/authorize`、Token=外部名ホストの `/token`、Certs（JWKS）=外部名ホストの `/jwks` を個別指定し、Authorization ホストと Token/Certs ホストが互いに異なる（split-horizon）ことを満たす。whereami を唯一の generic OIDC クライアントとする。`store_id` カスタムクレームをアプリ JWT へ引き継ぐ設定（Access の OIDC claims に `store_id` を追加）を推奨（認可に使わず監査・診断のみ・引き継ぎ不成立は切替前提条件に含めない）。whereami 内部実装には触れない（要件10.2）
    - コードで自動検証できない設定タスク。実際の構成は運用者が実施する
    - _Requirements: 4.1, 4.3, 4.4_

  - [x] 7.4 アプリ側経路を Pilot + OTP_Login でオフィス完結検証する ［手続き］
    - 成果物: 検証手順・チェックリスト（markdown）。検証対象は 7.1 が用意した Pilot 検証デプロイ（本番とは別）。開発者 email で OTP ログイン → 当該 email をテスト店舗 Roster に登録 → アプリ側経路（JWT 検証 → Roster 照合 → Entry 逆引き → WS 確立）を検証。有効な JWT を伴わない直叩きが 403 で拒否され店舗 DO に到達しないこと（バイパス防御作動・要件7.1 / 7.4）もここで確認。複数テスト店舗の切替はテスト用チェーンのチェーン Roster へ開発者 email を登録し Entry の複数店舗解決（既定店＋切替リスト）で選択する（店舗選択機構を新設しない）。本番構成へ OTP・テストデータ・分岐を持ち込まない
    - Worker は単一アプリ・単一 issuer/aud で IdP 経路を観測しないため店舗・whereami 非依存でオフィス完結する。コードで自動検証できない Integration/手続きタスク
    - _Requirements: 1.1, 1.8, 3.3, 6.4, 6.5, 7.1, 7.4_

  - [x] 7.5 whereami 固有部分を Whereami_Dev_Stage で事前検証する ［手続き］
    - 成果物: 検証手順（markdown）。合成 email 形式（`staff-{店舗コード}@yamaokaya.com` の厳密一致）・Store_Id_Claim の引き継ぎ・split-horizon を、本番とまったく同一のコード・同一の検証ロジックで検証する。Whereami_Dev_Stage の対応表への「テスト店舗＝開発拠点のネットワーク」のデータ登録は whereami 側 spec への依頼事項（本 spec 外・外部依存）であり、本タスクは当該登録の成立を前提として Access 側 generic OIDC 接続設定の検証に関与する。本番 whereami の対応表・コードにテストデータ・分岐を入れない（要件10.8）
    - コードで自動検証できない Integration/手続きタスク（外部依存）
    - _Requirements: 4.5, 4.2_

  - [x] 7.6 identity ↔ Roster 整合登録を Provisioning_API 経由で行う ［手続き］
    - 成果物: 登録手順・チェックリスト（markdown）。EntraID 実 email を権限範囲に応じてチェーン Roster または店舗 Roster へ、whereami 合成 email を当該店舗の店舗 Roster へ Provisioning_API（`/admin/*`・ADMIN_TOKEN）経由で登録する。合成 email は `storeCode`→`storeId` の文字列完全一致逆引きで自動化する。登録値と Access が JWT に載せる email クレームの双方に同一 `normalize`（trim・小文字化）を適用し正準形を完全一致させる（`normalize` ロジックは既存 PBT を参照・再検証しない）
    - コードで自動検証できない運用タスク（既存 Provisioning_API を用いる・新規実装なし）
    - _Requirements: 6.1, 6.2, 6.3_

- [x] 8. 本番切替（前提条件充足 → ON → 実店舗最終疎通 1 回）
  - [x] 8.1 本番切替の前提条件チェックリストを整備・充足確認する ［手続き］
    - 成果物: 切替前提条件チェックリスト（markdown）。(a) デプロイ前検査 CLI（タスク 3.1）が通過（実 TEAM_DOMAIN / POLICY_AUD 投入済み・プレースホルダ残存なし）、(b) `pnpm cf-typegen` 成功、(c) Pilot 検証（タスク 7.4・7.5）で 2 IdP 経路 各 1 回成功＋バイパス防御作動を確認済み、(d) Pilot と本番の構成次元一致（タスク 7.1）。すべて満たすことを本番切替の前提条件とする
    - コードで自動検証できない手続きタスク（CLI 実行結果と Pilot 検証結果を集約する切替判断）
    - _Requirements: 1.1, 1.2, 1.5, 5.3, 5.5_

  - [x] 8.2 ACCESS_REQUIRED をデプロイ時オーバーライドで "1" に切り替える ［手続き］
    - 成果物: 切替手順（markdown）。前提条件（タスク 8.1）充足を確認した上で、実 TEAM_DOMAIN / POLICY_AUD を投入し `ACCESS_REQUIRED` をデプロイ時オーバーライドで `"1"` にする。リポジトリの `wrangler.jsonc` 既定は `"0"` を保つ（要件5.6）。切替は env のみ・コード変更なし
    - コードで自動検証できないデプロイ手続きタスク。実際のデプロイは運用者が実施する
    - _Requirements: 5.6_

  - [x] 8.3 実店舗ネットワーク上の本番構成 最終疎通を 1 回実施する ［手続き］
    - 成果物: 最終疎通チェックリスト（markdown）。実店舗ネットワーク上での本番構成の最終疎通確認を **1 回に限り**実施し、パイロット 1 号店の立ち上げと兼ねる（本検証のための専用の店舗訪問を要さない）。オフィス検証（タスク 7.4）済みゆえ残るは実ネットワーク前提の whereami 在圏認証の疎通のみ
    - コードで自動検証できない Integration/手続きタスク
    - _Requirements: 1.9, 4.1, 4.2, 4.3, 6.2_

  - [x] 8.4 本番切替の完了条件を検証する ［手続き］
    - 成果物: 完了条件チェックリスト（markdown）。(a) 有効な JWT を伴わない `/s/{storeId}/ws` 直叩きが 403 で拒否され店舗 DO に到達しない、(b) クライアントが偽装した `X-Yudemen-Identity` 値が店舗 DO 受信ヘッダに現れない、(c) タイマー機能（開始・キャンセル・完了・調整・再接続 hydration）が認証無効時と同一観測結果（回帰なし）。異なれば回帰ありと判定し運用者へ通知
    - コードで自動検証できない Integration/手続きタスク（本番構成に対する外形確認）
    - _Requirements: 7.4, 8.4, 8.5_

- [x] 9. 外形監視・切戻し・失効運用の整備と既定反転
  - [x] 9.1 Synthetic_Monitor を整備する ［手続き］
    - 成果物: 監視設定ランブック（markdown）。三層で構成——(a) whereami 経路は合成試行を行わず Workers Logs（`observability.enabled = true` 有効化済み）のパッシブ指標（`/s/*/ws` の 403 レート急騰・WebSocket アップグレード成功数の崩落）を閾値観測、(b) 認証要求の能動プローブ（未認証直叩き＝403 の周期確認・IdP 非依存・外部実行可・既定 5 分周期）、(c) EntraID 経路は低頻度（日次以下）確認または申告。既存アセット経路（例: `/favicon.svg`）へ認証なしで到達し 5 秒以内正常応答＝死活確認成功。異常閾値超過またはプローブ 403 以外検出で運用者へ通知。店内端末のヘルスビーコンは採用しない
    - コードで自動検証できない監視設定/運用タスク
    - _Requirements: 8.1, 8.2, 8.3, 8.6, 8.7_

  - [x] 9.2 切戻し（可逆性）手順を整備する ［手続き］
    - 成果物: 切戻しランブック（markdown）。系統性障害の検知入力（Workers Logs パッシブ指標が正常域を外れる／R8.7 能動プローブが 403 以外を検出）を受けたら検出から **5 分以内**に `ACCESS_REQUIRED` を `"0"` へ戻す（env のみ・可逆）。戻し完了から **1 分以内**に合鍵 URL 接続が JWT 検証を経ず成立することを確認。個別 identity/店舗の認可失敗は全体 OFF の根拠とせず Provisioning_API 経由の Roster 修正で対処（要件1.7）
    - コードで自動検証できない運用手続きタスク
    - _Requirements: 1.3, 1.6, 1.7_

  - [x] 9.3 失効運用ランブックを整備する ［手続き］
    - 成果物: 失効運用ランブック（markdown）。iPad 紛失・担当者離任時に Cloudflare_Access 上で当該 identity のセッションを失効させ（再認証要求で Entry `/`・WS 到達を遮断）、恒久的に断つときは Provisioning_API 経由で Roster から除去し併せてセッション失効する（Roster 除去は次回再接続時に反映・現接続維持・即時切断はスコープ外）。Roster 除去失敗時は除去前状態を保持し失効未完了を通知し失効完了を主張しない。失効記録（対象 identity・対象端末・実施日時・失効理由・実施措置）を運用記録に残す（アプリ内に永続キーを新設しない・要件10.4）
    - **依存 [Q-session]**: Access_Application のセッション寿命の具体値の確定を要する（紛失 iPad の実効失効の時間上限を決める・要件9.5）。ランブックにセッション寿命の明示設定手順を含め、具体値は Q-session 確定後に確定する。コードで自動検証できない運用/設定タスク
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 9.4 既定反転の終着点手順を整備する ［手続き］
    - 成果物: 既定反転手順（markdown）。本番が安定運用に達したらリポジトリ既定の `ACCESS_REQUIRED` を `"1"` へ反転し、オーバーライドなしの素のデプロイでも認証が ON を保つ状態を終着点とする（「静かな認証 OFF」への退行余地を構造から除く）。反転と同時に `.dev.vars` へ `ACCESS_REQUIRED="0"` を明示しローカル開発環境は OFF を維持する。反転時の `wrangler.jsonc` 編集は `pnpm cf-typegen` を伴わせる
    - `wrangler.jsonc` / `.dev.vars` の編集はコードだが、反転の実行可否判断（安定運用到達）は運用判断ゆえ手続きに含める
    - _Requirements: 5.7_

- [x] 10. 最終チェックポイント — 全テスト・静的検査が通り、切替チェックリスト/ランブックが整備されていることを確認
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- **タスク種別**: ［コード］はコーディングエージェントが writing / modifying / testing で完結できるタスク、［手続き］はコードで自動検証できない設定/運用タスク（成果物はチェックリスト/ランブック/スモーク手順・実際の Cloudflare 構成/切替/監視/失効は運用者が実施）。本 spec の中核は［手続き］側にあり、［コード］は有効化ガード＋PBT・デプロイ前検査 CLI・既存経路の作動確認テスト・`wrangler.jsonc`／`cf-typegen` に限る。
- `*` を付したサブタスクは省略可能（PBT・example・作動確認テスト。MVP を急ぐ場合スキップ可）。トップレベルタスクには `*` を付さない。
- 各タスクは特定の受け入れ基準を `_Requirements: x.y_` で参照し、各 property テストタスクは `Validates: Requirements x.y` を明記する（設計「要件トレーサビリティ」節と整合）。
- 各 Correctness Property（Property 1・2）は**単一の** property テストとして実装し、最低 100 回反復（fast-check `numRuns: 100` 以上）・既定 pool（node）で駆動し、`// Feature: cloudflare-access-enablement, Property N: ...` のタグコメントを付す（PBT は fast-check を用い自前実装しない）。既存経路の作動確認（DO 到達）は Workers pool で駆動する。
- ウォーキングスケルトン相当（最小の検証可能単位）を先に置く: 命名確定 → 有効化ガード（実装＋PBT）→ デプロイ前検査 CLI。以降に既存経路の作動確認、`wrangler.jsonc` 実値投入方式＋`cf-typegen`、Access 構成（Pilot 先行）、本番切替、監視・失効を積む。
- **休眠機構を再実装しない**（要件10.1）。`verifyAccessIdentity` / `IDENTITY_HEADER` 除去・付与 / Entry 逆引き / 店舗 DO の Roster 照合 / `normalize` / `effectiveRoster` / `isRostered` / `isAdminAuthorized` は per-store-provisioning で実装・PBT 検証済みゆえ、本 spec は本番構成での作動確認に留める。新規に足す純粋ロジックは有効化ガードただ一点。
- **公開シンボル名・配置はすべて確定済み**（ユーザー最終決定・タスク 1.1 完了）: 関数 `enablementReadiness`／結果型 `EnablementReadiness`／純粋モジュール `src/access-enablement.ts`（`src/registry` には置かない）／デプロイ前検査 CLI `tools/check-access-enablement.ts`。後続の全コードタスクでこの確定名・確定配置を一貫して用いる（`naming.md`）。
- [Q-idp]（EntraID 方式・タスク 7.2）と [Q-session]（セッション寿命・タスク 9.3）は外部決定でコードタスクをブロックしない。該当設定タスクに依存として明記済み。
- 静的検査は `pnpm typecheck`（`tsc --noEmit`）・`pnpm lint`（oxlint）、テスト実行は `pnpm test`（`vitest --run`・watch は使わない）。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["6.1"] },
    { "id": 1, "tasks": ["2.1", "6.2"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.1"] },
    { "id": 3, "tasks": ["3.2", "5.1", "5.2", "5.3"] },
    { "id": 4, "tasks": ["7.1", "7.2", "7.3"] },
    { "id": 5, "tasks": ["7.4", "7.5", "7.6"] },
    { "id": 6, "tasks": ["8.1"] },
    { "id": 7, "tasks": ["8.2"] },
    { "id": 8, "tasks": ["8.3", "8.4"] },
    { "id": 9, "tasks": ["9.1", "9.2", "9.3", "9.4"] }
  ]
}
```
