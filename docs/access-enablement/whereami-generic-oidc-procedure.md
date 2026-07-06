# whereami generic OIDC 接続設定手順（split-horizon）

本書は Cloudflare Access に **whereami IdP** を generic OIDC クライアントとして据え付けるための設定手順である。対象は Access 側の generic OIDC 接続設定に限る。whereami の内部実装（OIDC 発行ロジック・ECS Fargate 運用・split-horizon の内部配線）には一切触れない（要件 10.2）。実際の構成は運用者が本手順に従い Cloudflare ダッシュボード／API 上で実施する。

- **spec**: cloudflare-access-enablement
- **対応タスク**: 7.3 whereami generic OIDC を split-horizon で構成する ［手続き］
- **充足要件**: 4.1（split-horizon）・4.3（`store_id` カスタムクレーム引き継ぎ）・4.4（唯一の generic OIDC クライアント）
- **正本**: `.kiro/specs/cloudflare-access-enablement/design.md`（A-3・Cloudflare Access 前提 6）／`requirements.md`（Requirement 4）

---

## 0. 前提の共有 — 二層の JWT を混同しない

この設定を誤らないために、まず **二層の JWT** を分けて理解する。両者は別の署名鍵・別の検証者・別のエンドポイントに属し、本手順が扱うのは前者（第 1 層）だけである。

| 層 | 発行者 → 検証者 | 検証に使う鍵の出所 | 本手順の関与 |
| --- | --- | --- | --- |
| **第 1 層**（本手順の対象） | whereami（id_token）→ **Cloudflare Access**（OIDC クライアントとして） | **whereami の `/jwks`**（外部名ホスト） | ○ ここを設定する |
| **第 2 層**（設定不要・実装済み） | Cloudflare Access（アプリ JWT）→ **Worker**（`verifyAccessIdentity`） | **Access のチームドメイン** `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`（= `TEAM_DOMAIN` + certs パス） | × 本手順では触らない |

つまり本手順で指定する whereami の `/jwks` は、**Cloudflare Access が whereami の id_token を検証するための鍵**であって、Worker がアプリ JWT を検証するための Access チームドメイン certs（`/cdn-cgi/access/certs`）とは**別層**である（要件 4.1 の但し書き）。この区別を取り違えて whereami の `/jwks` を Worker 側検証に流用してはならない。既存の `verifyAccessIdentity` は既に `TEAM_DOMAIN` 配下の certs を用いており、変更しない。

```
[iPad ブラウザ]
   │ 在圏認証（ゼロタッチ）
   ▼
[whereami IdP]  ── id_token ──►  [Cloudflare Access]   ← 第1層: Access が whereami の /jwks で検証（本手順）
                                      │ アプリ JWT を発行（iss=TEAM_DOMAIN / aud=POLICY_AUD 固定）
                                      ▼
                                  [Worker]              ← 第2層: Worker が TEAM_DOMAIN certs で検証（実装済み・不変）
```

---

## 1. split-horizon エンドポイントの個別指定（要件 4.1）

Cloudflare Access の generic OIDC 設定では、以下の 3 エンドポイントを**個別に**指定する。ディスカバリ（`/.well-known/openid-configuration`）に頼らず、各エンドポイントを明示指定することで split-horizon を成立させる。

| Access 設定項目 | 指定する URL | ホスト種別 |
| --- | --- | --- |
| **Authorization（Auth URL）** | `https://<内部名ホスト>/authorize` | **内部名**ホスト |
| **Token（Token URL）** | `https://<外部名ホスト>/token` | **外部名**ホスト |
| **Certs / Keys（JWKS URL）** | `https://<外部名ホスト>/jwks` | **外部名**ホスト |

### split-horizon の制約（必達）

- **Authorization に用いる内部名ホスト**と、**Token・Certs に用いる外部名ホスト**は、**互いに異なるホスト名でなければならない**（要件 4.1）。
- Authorization は利用者ブラウザ（店舗ネットワーク内の iPad）がリダイレクトで到達する経路ゆえ**内部名**、Token・Certs は Cloudflare Access のバックエンドがサーバ間で到達する経路ゆえ**外部名**を用いる。この非対称が split-horizon の本体である。

### 設定チェックリスト

- [ ] Authorization URL のホスト名が **内部名ホスト**であることを確認した
- [ ] Token URL のホスト名が **外部名ホスト**であることを確認した
- [ ] Certs（JWKS）URL のホスト名が **外部名ホスト**であることを確認した
- [ ] Authorization ホスト名 ≠ Token/Certs ホスト名（**両者が異なる**）であることを確認した
- [ ] 3 つのパスがそれぞれ `/authorize`・`/token`・`/jwks` であることを確認した
- [ ] Client ID / Client Secret（whereami 側で発行された値）を Access に登録した
- [ ] scope に `openid` を含む（OIDC 標準・id_token 取得に必要）

> **whereami 側との対応**: 上記の内部名／外部名ホストは whereami 側で発行される OIDC メタデータに対応する。ホスト名・証明書・到達性（内部名は店舗ネットワークから、外部名は Cloudflare から到達可能であること）は whereami 側 spec の責務であり、本手順は Access 側にそれらを**転記して個別指定する**ことに限る。

---

## 2. whereami を唯一の generic OIDC クライアントとする（要件 4.4）

- Cloudflare Access に登録する **generic OIDC ログイン方式は whereami ただ 1 つ**とする。
- **他の IdP を generic OIDC として追加しない。** とりわけ **EntraID_IdP は generic OIDC ではなく専用フェデレーション**（OIDC/SAML の専用コネクタ）を用いる（EntraID の据え付けはタスク 7.2 の手順に従う）。
- Access_Application が許可するログイン方式は「EntraID_IdP（専用フェデレーション）」と「whereami（generic OIDC）」の 2 つのみ。generic OIDC の枠に whereami 以外を混ぜない。

### チェックリスト

- [ ] generic OIDC ログイン方式が whereami の 1 つだけであることを確認した
- [ ] EntraID が generic OIDC としてではなく専用フェデレーションとして登録されていることを確認した
- [ ] Access_Application のログイン方式が「EntraID・whereami」の 2 つに固定されていることを確認した

---

## 3. `store_id` カスタムクレームのアプリ JWT への引き継ぎ（要件 4.3・推奨）

`store_id` は OIDC 標準外のカスタムクレームである。Access が発行するアプリ JWT に `store_id` を載せるには、**Access アプリの OIDC claims 設定に `store_id` を追加**して IdP のカスタムクレームを引き継ぐ設定が必要となる。本設定は**推奨（必須ではない）**である。

### 設定内容

- Access_Application の **OIDC claims 設定**に `store_id` を追加し、whereami が id_token に載せる `store_id` を**改変せず**アプリ JWT へ引き継ぐ。
- **引き継ぎ先はアプリ JWT のトップレベルではなく `oidc_fields` 配下にネストされる**（すなわち `oidc_fields.store_id`）。これは Cloudflare Access が IdP カスタムクレームを引き継ぐ際の標準挙動である。
- **値は数値または文字列のいずれの形でも到着しうる。** 実測（つくば中央店・店舗コード 1263）では `oidc_fields.store_id: 1263`（数値）で届いた。アプリは受領時に**文字列へ正規化して**扱う（数値到着も文字列到着もつねに文字列として保全）。
- `store_id` は `/whereami` の `shopCode` と**同一の値**だが、表現（数値/文字列）は異なりうる。店舗の逆引き・照合は email 由来の文字列（合成 email のローカル部）で行い、この数値の `store_id` には依存しない。

### 位置づけ（重要 — 認可には使わない）

- **`store_id` は認可判定に用いない。** 本アプリの認可単位は email（`canonicalIdentity` が email を正準として抽出）であり、`store_id` は**監査・診断のためにのみ**文字列に正規化して保全する。
- **`store_id` 引き継ぎの不成立は、認証・認可・接続の成立を妨げない**（診断性が低下するのみ）。
- したがって **`store_id` 引き継ぎは本番切替の前提条件（要件 1.1・1.2）に含めない。** 引き継ぎが未設定でも本番切替は可能であり、後追いで設定してよい。

### チェックリスト

- [ ] Access アプリの OIDC claims 設定に `store_id` を追加した（推奨・任意）
- [ ] 引き継ぎ後のアプリ JWT の `oidc_fields.store_id` が whereami 発行値と同一の値であることを確認した（設定した場合。値は数値/文字列いずれでも可・アプリは文字列に正規化）
- [ ] `store_id` を認可に使う配線を Access 側に一切加えていないことを確認した（認可は email／Roster が担う）

> 参考: 同様のカスタムクレーム `auth_method` も OIDC claims 引き継ぎ設定がなければアプリ JWT に現れない。これも認可に使わず監査・診断のみ（design.md「Access が発行するアプリ JWT のクレーム」）。

---

## 4. 合成 email クレームの確認（要件 4.2・関連）

本手順の直接の充足範囲外だが、split-horizon 設定の妥当性確認として併せて観測する。

- whereami 経由で認証が成立したとき、Access が発行する JWT の `email` クレームが合成 email **`staff-{店舗コード}@yamaokaya.com`**（ローカル部 `staff-` + 店舗コード、ドメイン部 `yamaokaya.com` に厳密一致）であること。
- 形式の壊れた email はどの Roster にも一致せず既存 Roster ゲート（`isRostered`）が拒否するため、Worker 側に IdP 経路別の形式判定を**足さない**（要件 4.2・10.1）。合成 email 形式の保証は Access 側の出口要件と whereami 側 spec の責務に置く。

> whereami 固有部分（split-horizon・合成 email 形式・`store_id` 引き継ぎ）の**事前検証**は Whereami_Dev_Stage を用いてタスク 7.5 で行う。本書は設定手順の整備までを担い、通し検証はタスク 7.5 の手順に従う。

---

## 5. 完了条件（本タスクの成果物としての観測点）

本手順に従った設定が完了したとみなす条件（実構成は運用者が実施し、通し検証はタスク 7.5・8.3 で行う）。

- [ ] Authorization=内部名ホストの `/authorize`、Token=外部名ホストの `/token`、Certs=外部名ホストの `/jwks` が個別指定されている（要件 4.1）
- [ ] Authorization ホスト ≠ Token/Certs ホスト（split-horizon）を満たす（要件 4.1）
- [ ] whereami が唯一の generic OIDC クライアントで、EntraID は専用フェデレーション（要件 4.4）
- [ ] `store_id` の OIDC claims 引き継ぎを設定した（推奨・任意・要件 4.3。未設定でも切替可）
- [ ] whereami の `/jwks`（第 1 層）を Worker のアプリ JWT 検証（第 2 層・`TEAM_DOMAIN` certs）に流用していない

---

## スコープ境界（触らないもの）

- **whereami 内部実装**（OIDC 発行ロジック・ECS Fargate 運用・split-horizon の内部配線）には触れない（要件 10.2）。
- **アプリコードを変更しない。** 本タスクの成果物は本手順書（markdown）のみであり、Worker・DO・registry のコードに差分を出さない（要件 10.1 の差分制限）。
- **Worker の第 2 層検証**（`verifyAccessIdentity` が `TEAM_DOMAIN` certs でアプリ JWT を検証する経路）は実装済み・不変。
