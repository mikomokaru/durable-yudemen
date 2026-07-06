# EntraID フェデレーション設定手順（Cloudflare Access 本番有効化）

> 対象 spec: `cloudflare-access-enablement` / タスク 7.2「EntraID_IdP をフェデレーションし Access_Application のログイン方式に加える」
> 種別: ［手続き］（コードで自動検証できない設定タスク。実際の Cloudflare / EntraID 構成は運用者が本手順に従い実施する。アプリコードは変更しない・要件10.1）
> 正本: `requirements.md` 要件3.1 / 3.2、`design.md`「A-2. EntraID フェデレーション（要件3）」

---

## 0. この手順の位置づけと未決事項（必読）

本手順は、人間ユーザー（本部・SV 等）向けの IdP である **EntraID_IdP** を Cloudflare Access（`Cloudflare_Access`）にフェデレーションし、単一の `Access_Application` のログイン方式に加えるための設定手順である。iPad の在圏認証を担う `Whereami_IdP`（generic OIDC・split-horizon）は別手順（タスク 7.3）で扱う。本手順は EntraID 経路のみを対象とする。

### 方式は [Q-idp] 未決・OIDC 推奨（暫定手順）

**フェデレーション方式（OIDC / SAML のいずれか一方）は要確認事項 [Q-idp] として未決である**（要件3.1）。本手順は次の方針で暫定的に記述する。

- **OIDC を推奨する。** 理由: `Whereami_IdP` が generic OIDC であり、検証経路（アプリ JWT の署名検証・issuer / audience 照合）を 2 IdP で揃えられるため、運用・診断の一貫性が高い（要件3.1 の推奨）。
- 本手順は **OIDC 前提で本文を記述**し、**SAML を選ぶ場合の分岐を各所に注記**する（`> SAML の場合:` ブロック）。
- **方式が [Q-idp] として確定したら、採用しない一方の記述を削除して一方へ確定すること。** 確定前は本手順を暫定として扱う。

> ⚠ どちらの方式でも、Cloudflare Access が後段アプリ（本アプリ）へ発行する **アプリ JWT の形（issuer = `TEAM_DOMAIN`・audience = `POLICY_AUD` に固定）は同一**である。方式差は「Access ↔ EntraID 間の認証プロトコル」に閉じ、Worker が検証・参照するアプリ JWT には現れない（`design.md` Cloudflare Access 前提 3）。したがって方式選択はアプリコードに一切影響しない。

---

## 1. 前提条件

本手順を開始する前に、以下がそろっていること。

| 前提 | 内容 | 参照 |
| --- | --- | --- |
| Access_Application の存在 | 認証を課す単一の `Access_Application` が構成済み（タスク 7.1 の構成チェックリスト） | 要件2.1 |
| issuer / audience の固定 | 発行 JWT の issuer = `TEAM_DOMAIN`・audience = `POLICY_AUD` に単一固定されている | 要件2.6 |
| EntraID テナントの管理権限 | Microsoft Entra 管理センターでアプリ登録（OIDC）またはエンタープライズ アプリケーション（SAML）を作成できる権限 | — |
| Cloudflare Zero Trust 管理権限 | Cloudflare One（Zero Trust）ダッシュボードで IdP を追加できる権限 | — |
| テストユーザー | EntraID テナント上に、認証確認に使える実 email を持つテストユーザーが 1 名以上ある | 要件3.1 観測点 |

> `TEAM_DOMAIN` / `POLICY_AUD` は本番では実値をデプロイ時オーバーライドで投入する（プレースホルダのまま ON にしない・要件5）。本手順は「フェデレーションを成立させ、POLICY_AUD を aud とする JWT を発行できること」の観測までを担い、`ACCESS_REQUIRED` の本番切替そのものはタスク 8 で扱う。

---

## 2. OIDC 方式でフェデレーションする手順（推奨・本文）

### 2.1 EntraID 側: アプリ登録（OIDC クライアント）を作成する

1. Microsoft Entra 管理センター → **アプリの登録** → **新規登録**。
2. 名前を任意（例: `Cloudflare Access - Yudemen`）で作成する。
3. **リダイレクト URI**（Web）に Cloudflare Access のコールバック URL を登録する。形式は次のとおり（`<team>` は自チームドメインのサブドメイン部）。

   ```
   https://<team>.cloudflareaccess.com/cdn-cgi/access/callback
   ```

4. 登録後、次の値を控える（手順 2.2 で使う）。
   - **アプリケーション (クライアント) ID**
   - **ディレクトリ (テナント) ID**
5. **証明書とシークレット** → **新しいクライアント シークレット** を作成し、シークレット値を控える（作成直後しか表示されない）。
6. **API のアクセス許可** → Microsoft Graph の委任アクセス許可に **`openid`・`email`・`profile`** を追加し、必要なら管理者の同意を付与する。

   > **`email` クレームを確実に載せるための要点（要件3.2）**: `email` スコープを付与し、ユーザーに検証済みの email（メール属性）が設定されていることを確認する。ゲストユーザー等で email 属性が欠落しうる構成では、オプションのクレーム設定（**トークン構成** → **オプションの要求** で `email` を ID トークンに追加）を併用し、email クレームが**欠落・空文字なく**発行されるようにする。

### 2.2 Cloudflare 側: OIDC IdP を追加する

1. Cloudflare One（Zero Trust）ダッシュボード → **Settings** → **Authentication** → **Login methods** → **Add new**。
2. IdP 種別として **OpenID Connect (Generic OIDC)** を選ぶ（Entra 専用テンプレートがあればそれでもよいが、本アプリは汎用 OIDC で一貫させて差し支えない）。
3. 次を入力する。
   - **App ID (Client ID)**: 手順 2.1-4 のアプリケーション (クライアント) ID
   - **Client secret**: 手順 2.1-5 のシークレット値
   - **Auth URL**: `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize`
   - **Token URL**: `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token`
   - **Certificate URL (JWKS)**: `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys`
   - **OIDC Claims / スコープ**: `openid`・`email`・`profile` を要求する（`email` を必ず含める）
4. 保存し、Cloudflare の **Test** 機能で疎通を確認する。

   > ここで得るのは「Access ↔ EntraID 間の OIDC 疎通」の確認である。アプリ JWT（`Cf-Access-Jwt-Assertion`）の形の確認は手順 4 で行う。

### 2.3 email クレームのマッピングを確認する（要件3.2）

- Cloudflare の IdP 設定で、EntraID が返す `email` クレームが Access の identity（email）に正しく対応することを確認する。
- 目的は、**Access が発行するアプリ JWT の `email` クレームに検証済み実 email が欠落・空文字なく載る**ことである。これにより Worker 側の `canonicalIdentity` が email を正準として抽出し、`normalize`（trim・小文字化）後の正準形で Roster 照合の単位に一致する（`design.md` A-2）。
- Roster への実 email 登録は本手順のスコープ外（タスク 7.6・Provisioning_API 経由）。ここでは「JWT に実 email が載る」ことの担保までを行う。

---

## 3. SAML 方式でフェデレーションする場合（分岐・[Q-idp] で SAML 確定時のみ）

> **[Q-idp] が SAML で確定した場合にのみ本節を採用し、手順 2（OIDC）は削除すること。** 確定前は本節も暫定注記として残す。

### 3.1 EntraID 側: エンタープライズ アプリケーション（SAML）を作成する

1. Microsoft Entra 管理センター → **エンタープライズ アプリケーション** → **新規アプリケーション** → **独自のアプリケーションの作成**（ギャラリー以外）。
2. **シングル サインオン** → **SAML** を選ぶ。
3. 基本 SAML 構成に Cloudflare Access の値を設定する。
   - **識別子 (エンティティ ID)** / **応答 URL (ACS URL)**: Cloudflare の SAML IdP 追加画面が提示する値を貼り付ける（形式は `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` 系）。
4. **属性とクレーム**で、**email 属性を必須の claim として出力**する。ソース属性に `user.mail`（または検証済み email を保持する属性）を割り当て、**空にならない**ことを確認する（要件3.2）。
5. **SAML 署名証明書**（Federation Metadata / 証明書）と **ログイン URL**・**Entra 識別子** を控える。

### 3.2 Cloudflare 側: SAML IdP を追加する

1. Cloudflare One → **Settings** → **Authentication** → **Login methods** → **Add new** → **SAML**。
2. 次を入力する。
   - **Single Sign-On URL**: 手順 3.1-5 のログイン URL
   - **IdP Entity ID / Issuer**: 手順 3.1-5 の Entra 識別子
   - **Signing certificate**: 手順 3.1-5 の SAML 署名証明書（X.509）
   - **Email attribute name**: EntraID が email を出力する属性名（例: `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`）
3. 保存し、Cloudflare の **Test** で疎通を確認する。

> SAML でも、Access が後段アプリへ発行する**アプリ JWT の形（issuer=`TEAM_DOMAIN`・audience=`POLICY_AUD`）は OIDC 時と同一**である。したがって手順 4 の観測点・アプリコードは方式に依存しない。

---

## 4. Access_Application のログイン方式に加える

方式（OIDC / SAML）にかかわらず共通。

1. Cloudflare One → **Access** → **Applications** → 対象の `Access_Application` を開く。
2. **Authentication**（ログイン方式）で、手順 2 または 3 で追加した **EntraID_IdP を許可**する。
3. 併せて `Whereami_IdP`（タスク 7.3 で構成）も許可する構成であること（本番は EntraID_IdP と Whereami_IdP の 2 つを許可・要件2.5）。**本番の `Access_Application` に OTP_Login を追加しない**（OTP は Pilot 限定・要件10.7）。
4. issuer が `TEAM_DOMAIN`・audience が `POLICY_AUD` に単一固定されている構成を崩さないこと（要件2.6）。

---

## 5. 観測点（この手順の完了条件・要件3.1）

以下をすべて満たしたとき、本手順は完了とする。

- [ ] **テストユーザーが EntraID 経由で認証を完了できる。** テストユーザーの実 email で EntraID ログインが成立し、Access のログイン方式選択に EntraID_IdP が現れ、選択して認証を通過できる。
- [ ] **`POLICY_AUD` を `aud` とする JWT を発行できる。** 認証成功後、Access が発行するアプリ JWT（`Cf-Access-Jwt-Assertion` ヘッダ、または `CF_Authorization` Cookie）の `aud` が `POLICY_AUD` に一致し、`iss` が `TEAM_DOMAIN` に一致する。
- [ ] **`email` クレームに検証済み実 email が欠落・空文字なく載る（要件3.2）。** 発行 JWT の `email` クレームがテストユーザーの実 email に一致し、空文字・欠落でない。

### 観測方法（例）

- Access の **My Team → ログイン確認**、または対象アプリへブラウザでアクセスして EntraID ログインを実行する。
- 認証後のアプリ JWT のクレームは、Cloudflare Access の診断（Authentication logs）、またはブラウザの `CF_Authorization` Cookie / `Cf-Access-Jwt-Assertion` ヘッダをデコードして `iss` / `aud` / `email` を目視確認する（JWT のペイロード部を Base64URL デコード。署名検証は Access が担う）。
- `email` が `normalize`（trim・小文字化）後に Roster の正準形と一致することは、後続タスク（7.4 のオフィス完結検証・7.6 の Roster 整合登録）で確認する。本手順では「JWT に実 email が載る」ことまでを担保する。

> **アプリ側の逆引き挙動（要件3.3）は本手順のスコープ外。** 認証後 Entry `/` へ到達すると Worker が実 email で逆引き（`resolveEntryDestination`）するが、この挙動は IdP 経路に依存しないため、Pilot_Access_Application の OTP_Login で登録したテスト email によりオフィスで検証する（タスク 7.4）。本手順は「EntraID 固有のフェデレーション成立」＝ 上記観測点の確認に限る。

---

## 6. スコープ境界（触らないもの・要件10）

- 休眠機構（`verifyAccessIdentity` / `canonicalIdentity` / `IDENTITY_HEADER` 除去・付与 / Entry 逆引き / 店舗 DO の Roster 照合）を**再実装しない**。本手順は Access 構成側の設定のみ（要件10.1）。
- `Whereami_IdP` の内部実装・split-horizon の内部配線に触れない（タスク 7.3 の Access 側接続設定は別手順・要件10.2）。
- `ADMIN_TOKEN`（Provisioning_API・`/admin/*`）は Access と独立した別系統。本手順で変更しない（要件10.3）。
- セッションの継続・失効は Cloudflare Access に委ねる。アプリ側にセッションストア・失効ロジックを新設しない（要件10.4・失効運用はタスク 9.3）。

---

## 7. 確定時のチェック（[Q-idp] クローズ時に実施）

- [ ] [Q-idp] が OIDC / SAML のいずれかで確定した。
- [ ] 採用しない方式の節（手順 2 または 3）を本手順から削除し、一方へ確定した。
- [ ] 冒頭 §0 の「方式は Q-idp 未決・OIDC 推奨」の注記を、確定内容に更新した。
