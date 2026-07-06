# Requirements Document

## Introduction

本機能は、既に実装済みで休眠しているアプリ側の Cloudflare Access 統合機構（`ACCESS_REQUIRED` パイロットスイッチ・既定 `"0"`=OFF）を、**実運用で有効化（ON）する**作業である。ゼロからの認証実装ではない。JWT 検証（`src/worker.ts` の `verifyAccessIdentity`）・内部ヘッダ偽装防御（`IDENTITY_HEADER` の無条件除去）・Entry `/` の逆引き解決・店舗 DO の Roster 認可（`src/shell/store-timer-do.ts`）はすべて実装済みで、`ACCESS_REQUIRED === "1"` の経路に入るのを待っている。本機能の中核は、これらを本番で立ち上げるための **Cloudflare Access の構成・IdP の据え付け・実設定値の投入・段階的切替・切替後の検証と失効運用**にある。

据える IdP は 2 つ:

- **EntraID**: 本部・SV など人間ユーザー向けの標準 OIDC/SAML IdP。identity は実 email。Access 経由でフェデレーションする。
- **whereami IdP**: 別途開発中の最小 OIDC IdP（本 spec の外部依存）。「店舗ネットワーク内に居る」物理的事実を認証根拠とし、店舗共用 iPad にブラウザのみのゼロタッチ認証を成立させる。合成 email `staff-{店舗コード}@yamaokaya.com` を identity として発行する。Cloudflare Access の唯一の generic OIDC クライアントであり、split-horizon（Auth URL=内部名・Token/Certs URL=外部名）で接続する。セッションは Cloudflare Access が管理し、whereami はステートレスで、再認証は「店舗ネットワーク内に居る事実」でのみ成立する（ゼロタッチ）。

Cloudflare Access はこの 2 つの IdP を単一アプリケーションで束ねる。iPad は whereami 経由、人間ユーザーは EntraID 経由で認証し、いずれも Access が発行する JWT の正準クレーム（email）が Roster の認可単位に一致する。認可（店舗ごとの可否）は Access ではなく店舗 DO の投影 Roster が担う（per-store-provisioning の設計を継承）。

### whereami IdP からの申し送り（前提の訂正）

whereami IdP 側の設計確定により、本 spec の前提を次のとおり訂正する。いずれも「後段アプリ（本アプリ＝ゆで麺タイマー）が何を検証・参照するか」の境界を明確にするものである。

- **本アプリが検証・参照するのは Cloudflare Access が発行するアプリ JWT である。** 本アプリは whereami の id_token を直接受け取らない。二層の JWT を混同しない: (1) Cloudflare_Access ↔ whereami の OIDC は Access が OIDC クライアントとして whereami の `/jwks` で whereami の id_token を検証する（Requirement 4.1 の split-horizon 設定）。(2) Worker ↔ Cloudflare_Access は Worker が Access のチームドメイン certs（`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`）でアプリ JWT を署名検証する（`verifyAccessIdentity`・実装済み）。既存コードは TEAM_DOMAIN 配下の certs を用いており整合している。
- **store_id はアプリ JWT の `oidc_fields.store_id` にネストして受け取る。** これは OIDC 標準外のカスタムクレームゆえ、Access 側で「IdP のカスタム OIDC クレームをアプリ JWT へ引き継ぐ設定」（Access の OIDC claims 設定へ `store_id` を追加すること）が必要であり、この引き継ぎ設定の成立を前提とする（Requirement 4.3）。実物のアプリ JWT では `store_id` は Access が `oidc_fields.store_id` にネストして引き継ぐカスタムクレームであり、値は数値または文字列で届きうる。本アプリは受領時に文字列として正規化して監査保全するという自らの契約を、本 spec で定義する（whereami 側の内部表現差異は本 spec の関心外）。
- **`store_id` と `/whereami` の `shopCode` は同一値である。** 表現は数値／文字列で届きうるが、アプリは文字列として扱う（正規化して保全）。合成 email のローカル部 `staff-{店舗コード}` の店舗コードと Registry の `storeCode` は同一の外部マスタを正本とする（Requirement 6.2）。合成 email のローカル部 `staff-{店舗コード}` は文字列連結ゆえ、逆引き・照合は email 由来の文字列で行い `store_id` の数値表現には依存しない。
- **whereami 側 spec へのフィードバック事項。** 申し送り契約は `store_id` を「文字列・（暗黙に）top-level」としていたが、実トークン（つくば中央店・店舗コード 1263 の実測）は数値かつ `oidc_fields` 配下ネストであった。認可には email（Canonical_Identity）を用い `store_id` は使わないため実害はないが、契約と実装の齟齬として whereami 側 spec へ申し送る。

設計哲学の上位制約（`.kiro/steering/`）に従い、本 spec は**足し算より引き算**を貫く。既に実装・検証済みの休眠機構の内部挙動を新規要件として重複定義しない。認証状態・セッションの継続と失効は Cloudflare Access に委ね、アプリはステートレス志向を保つ。

### 開発時の認証経路検証（環境分離の原則）

開発中に実店舗へ赴かずに認証経路を検証するにあたり、本 spec は本番の純度を落とさず環境分離で達成する。原則は一文に尽きる——**迂回はコードで作らず、開発環境のデータで作る**。開発環境のデータはテストデータであることが存在理由であり、本番のイデア（正本）に偽物が恒久に住むわけではない。裏口・コード分岐・本番へのテストデータ投入は行わない。

この原則は検証対象を二つに割る。

- **アプリ側経路**（JWT 検証 → Roster 照合 → Entry 逆引き → WS 確立）は、Worker が単一アプリ・単一 issuer/aud のため「どの IdP 経由で JWT が生まれたか」を観測しない。ゆえに Pilot_Access_Application に許可した開発用の One-Time PIN（OTP）ログイン（Cloudflare Access 標準機能）で、店舗にも whereami にも依存せずオフィス完結に検証できる。手順は、開発者の email で OTP ログイン → 当該 email をテスト店舗の Roster に登録 → アプリ側経路を検証、である。本番の Access_Application には OTP を追加しない。
- **whereami 固有部分**（合成 email 形式・`store_id` クレーム引き継ぎ・split-horizon 設定）は、whereami の開発ステージを用い、その IP→店舗の対応表（正本データ）に「テスト店舗＝開発拠点のネットワーク」をデータとして登録して検証する。これにより本番とまったく同じコード・同じ検証ロジックで認証が通り、コード分岐・フラグ・裏口を一切コードに入れない。本番 whereami の対応表・コードにはテストデータ・分岐を持ち込まない。当該データ登録は whereami 側 spec への依頼事項（本 spec のスコープ外だが依存として記す）。

実店舗ネットワーク上での本番構成の最終疎通は 1 回のみで足り、パイロット 1 号店の立ち上げと兼ねられる（本検証のための専用の店舗訪問はゼロにできる）。

### スコープ外（重複・越境の回避）

- **休眠機構そのものの再実装**: `verifyAccessIdentity`・`IDENTITY_HEADER` 除去/付与・Entry 逆引き・店舗 DO の Roster 照合は per-store-provisioning で実装・検証済み。本 spec は「その経路を本番で有効化し、正しく作動することを確認する」ことに限る。
- **whereami IdP の内部要件**: whereami の OIDC 実装・ECS Fargate 運用・split-horizon の内部配線は別 spec（外部依存）。本 spec は Access 側の generic OIDC 接続設定と、whereami が発行する identity クレームの Roster 整合にのみ関心を持つ。
- **Provisioning_API（`/admin/*`）の認可**: `ADMIN_TOKEN` の定数時間 Bearer 照合（`src/worker-auth.ts`）は Access と独立した別系統であり、本 spec で変更しない。
- **セッション寿命・失効の実装**: 認証セッションの継続と失効判断は Cloudflare Access に委ねる。アプリ側にセッションストアや失効ロジックを新設しない。
- **開発時検証のための本番汚染**: 本番 Access_Application への OTP ログイン追加、本番 Whereami_IdP の対応表・コードへのテストデータ・分岐投入は行わない。開発時の認証経路検証は環境分離により、Pilot_Access_Application の OTP ログイン（アプリ側経路）と whereami 開発ステージ（whereami 固有部分）で行う。後者のデータ登録は whereami 側 spec への依頼事項（本 spec 外）。

## Glossary

- **Cloudflare_Access**: 本アプリ全体を覆う認証境界。2 つの IdP を束ね、認証済みリクエストに `Cf-Access-Jwt-Assertion` を付与する。認可（店舗ごとの可否）は担わない。
- **Access_Application**: Cloudflare_Access 上に構成する単一のアプリケーション定義。Entry `/` と Store_Path `/s/{storeId}/`・`/s/{storeId}/ws` を対象に含め、`/admin/*` と ヘルスチェック経路を対象外とする。店舗別の Access アプリは作らない。
- **EntraID_IdP**: 人間ユーザー（本部・SV 等）向けの OIDC/SAML IdP。Cloudflare_Access にフェデレーションされ、identity として実 email を発行する。
- **Whereami_IdP**: 店舗内在圏を認証根拠とする最小 OIDC IdP（外部依存）。合成 email `staff-{店舗コード}@yamaokaya.com` を identity として発行し、`store_id` カスタムクレームを載せる（値は数値／文字列で届きうる。アプリは文字列として扱う）。Cloudflare_Access の唯一の generic OIDC クライアント。セッションは Cloudflare_Access が管理し、whereami はステートレス。
- **Store_Id_Claim**: Access が発行するアプリ JWT の `oidc_fields.store_id` にネストして届くカスタムクレーム。値は数値または文字列で届きうるが、アプリは文字列として正規化して扱う。OIDC 標準外のカスタムクレームであり、Access の OIDC claims 設定で IdP のカスタムクレームをアプリ JWT へ引き継ぐ設定を要する。`/whereami` の `shopCode` と同一値。認可判定には用いず、監査・診断のためにのみ保全する（Canonical_Identity は email）。
- **Worker**: `src/worker.ts` の極薄エントリポイント。`ACCESS_REQUIRED === "1"` のとき `Cf-Access-Jwt-Assertion` を JWKS 署名検証し、検証済み identity のみを店舗 DO へ引き渡す（実装済み・休眠中）。
- **StoreTimerDO**: 店舗の状態を保持する Durable Object。`ACCESS_REQUIRED === "1"` のとき投影 Roster に検証済み identity をローカル照合する（実装済み・休眠中）。
- **ACCESS_REQUIRED**: Access 統合の有効化フラグ（`wrangler.jsonc` の vars）。既定 `"0"`（OFF）。`"1"` で JWT 検証・Roster 判定・Entry 逆引き解決が経路に入る。切替は env のみでコード変更を要しない。
- **TEAM_DOMAIN**: Cloudflare_Access のチーム URL（`https://<team>.cloudflareaccess.com`）。JWKS 取得と JWT の issuer 検証に用いる。現状はプレースホルダ。
- **POLICY_AUD**: Access_Application の audience 識別子。JWT の aud 検証に用いる。現状はプレースホルダ。
- **Deployment_Config**: `wrangler.jsonc` の vars と Wrangler secret による本番設定の集合。`ACCESS_REQUIRED` / `TEAM_DOMAIN` / `POLICY_AUD` の実値と、その投入・切替の対象。
- **Access_Enablement**: 本 spec が実施する段階的有効化の手続き。テスト用アプリでの検証を先行させ、本番切替の順序と可逆性を統べる。
- **Pilot_Access_Application**: 本番切替に先立って検証を行うためのテスト用 Access アプリ定義（本番と同一構成の縮小版）。検証手段として開発用の One-Time PIN（OTP_Login）を許可してよい（Cloudflare Access 標準機能）。アプリ側経路（JWT 検証 → Roster 照合 → Entry 逆引き → WS 確立）は、Worker が単一アプリ・単一 issuer/aud のためどの IdP 経由で JWT が生まれたかを観測できず、Pilot + OTP_Login でオフィス完結に検証できる（whereami 不要・実店舗不要）。本番の Access_Application には OTP_Login を追加しない。
- **OTP_Login**: Pilot_Access_Application にのみ許可する開発用の One-Time PIN ログイン方式（Cloudflare Access 標準機能）。開発者の email で認証を成立させ、当該 email をテスト店舗の Roster に登録することでアプリ側経路をオフィスで検証する。本番の Access_Application には追加しない。
- **Whereami_Dev_Stage**: Whereami_IdP の開発ステージ（本 spec の外部依存）。IP→店舗の対応表（正本データ）に「テスト店舗＝開発拠点のネットワーク」をデータとして登録し、本番とまったく同一のコード・同一の検証ロジックで whereami 固有部分（合成 email 形式・Store_Id_Claim の引き継ぎ・split-horizon）を検証する。本番 whereami の対応表・コードにはテストデータ・分岐を持ち込まない。当該データ登録は whereami 側 spec への依頼事項であり本 spec のスコープ外。
- **Canonical_Identity**: Access の JWT から抽出する正準 identity。email を優先し、無ければ sub にフォールバックする（`canonicalIdentity`・実装済み）。Roster 照合の単位。
- **Roster**: 店舗への接続を許可する identity の集合（per-store-provisioning のイデア）。投影として店舗 DO が保持する。
- **Synthetic_Monitor**: 有効化後、認証境界の作動を継続的に確認する監視。合成試行（能動的な試行）に限らず、パッシブ観測を含む監視の総体を指す（名称は合成監視に由来するが、実態はパッシブ観測を主とする）。監視モデルは三層で確定する: (a) **whereami 経路のパッシブ観測**——`/s/*/ws` の 403 レート急騰・WebSocket アップグレード成功数の崩落を Workers Logs（`wrangler.jsonc` の `observability.enabled = true` により有効化済み）の指標アラートで捉える。24h 営業・常時接続の実機群が全店で再接続のたびに全経路を検証するため、系統性障害は実トラフィックのパッシブ観測で検知でき、合成試行を要さない。(b) **認証要求の能動プローブ**（Requirement 8.7）——未認証直叩き＝HTTP 403 の周期確認。IdP 非依存で外部から実行可能。既定 5 分周期。(c) **EntraID 経路の低頻度確認**——切替時検証（Requirement 1.1・Pilot）に加え、低頻度（日次以下）確認または申告ベース。対話型ログインゆえ短周期のヘッドレス自動化は行わない。店内端末のヘルスビーコンは採用しない。
- **Bookmark_URL / 合鍵 URL**: OFF 期に用いる、推測困難な Store_Path の直叩き URL。ON 移行で Access 認証が前段に入る。

## Requirements

### Requirement 1: 段階的ロールアウトと可逆な切替

**User Story:** 運用者として、認証の有効化を一息に本番へ適用せず、テスト用 Access アプリでの検証を先行させ、問題があれば即座に元の状態へ戻せる形で切り替えたい。

#### Acceptance Criteria

1. THE Access_Enablement SHALL 本番の `ACCESS_REQUIRED` を `"1"` へ切り替える前に、Pilot_Access_Application 経由で、EntraID_IdP と Whereami_IdP の各経路につき最低 1 回の認証成功（認証から店舗接続の確立まで到達すること）と、有効な JWT を伴わない直叩きが拒否されること（Requirement 7 のバイパス防御の作動）を検証し、これらすべてが成功することを本番切替の前提条件とする。
2. THE Access_Enablement SHALL `ACCESS_REQUIRED` の本番切替を、実 TEAM_DOMAIN と実 POLICY_AUD が Deployment_Config に投入済みであることを前提条件とする（Requirement 5）。
3. IF 本番切替後に Synthetic_Monitor が系統性障害を検出したとき、THEN THE Access_Enablement SHALL 検出から 5 分以内に `ACCESS_REQUIRED` を `"0"` へ戻す（切替はコード変更を要さず env のみで可逆）。ここで系統性障害の検知入力は次の二つである: (a) whereami 経路の実トラフィック指標——`/s/*/ws` の 403 レート急騰または WebSocket アップグレード成功数の崩落——が Workers Logs のパッシブ観測で正常域を外れること（Requirement 8.2）、(b) 未認証直叩きが HTTP 403 で拒否される作動（認証が要求されること）が R8.7 の能動プローブで崩れること（静かな認証 OFF への退行）。
4. WHILE `ACCESS_REQUIRED` が `"0"`（OFF 期）であるとき、THE Worker SHALL JWT 検証と identity 引き渡しを行わず、利用者は合鍵 URL で接続できる（既存の休眠挙動を維持し、切替まで現行運用を妨げない）。
5. THE Access_Enablement SHALL 本番切替を、Pilot_Access_Application と以下の構成次元が一致する Access_Application に対して行う: 許可する IdP 集合（EntraID_IdP と Whereami_IdP の両方）・認証対象に含める経路と除外する経路・audience が単一値に固定されているという構成（Pilot と本番は別の Access アプリゆえ aud 値そのものは各アプリ固有であり異なってよい。揃えるのは「aud が単一値に固定されている」という構成次元であって値そのものではない）（テスト経路と本番経路の構成差による見落としを避ける）。
6. WHEN `ACCESS_REQUIRED` が `"1"` から `"0"` へ戻されたとき、THE Access_Enablement SHALL 戻し完了から 1 分以内に、合鍵 URL による店舗接続が JWT 検証を経ずに成立することを確認する。
7. IF 個別 identity または個別店舗で認可失敗（正当でない identity の拒否、または Roster 登録漏れによる正当 identity の拒否）が確認されたとき、THEN THE Access_Enablement SHALL 当該事象を全体ロールバック（`ACCESS_REQUIRED="0"` への切戻し）の対象とせず、Provisioning_API 経由の Roster 修正で対処する（局所の登録ミスを全体 OFF の根拠としない）。
8. THE Access_Enablement SHALL Requirement 1.1 が定める「各 IdP 経路につき最低 1 回の認証成功」の検証を実店舗へ赴かずオフィス完結で成立させるため、アプリ側経路（JWT 検証 → Roster 照合 → Entry 逆引き → WS 確立）を Pilot_Access_Application の OTP_Login（開発者 email で OTP ログイン → 当該 email をテスト店舗 Roster に登録 → アプリ側経路を検証）で検証し、whereami 固有部分（合成 email 形式・Store_Id_Claim の引き継ぎ・split-horizon）を Whereami_Dev_Stage で検証する。WHERE 複数のテスト店舗を切り替えて検証するとき、THE Access_Enablement SHALL 開発者 email をテスト用チェーンのチェーン Roster へ登録し、Entry の複数店舗解決（per-store-provisioning Requirement 7.4 の SV フロー：複数店舗担当は既定店へ解決し切替リストを渡す）で店舗を選択する（whereami・Access 側に店舗選択機構を新設せず、既存の Entry 逆引き・チェーン Roster・切替リストで足りる）。
9. THE Access_Enablement SHALL 実店舗ネットワーク上での本番構成の最終疎通確認を 1 回に限り実施し、当該確認をパイロット 1 号店の立ち上げと兼ねる（本検証のための専用の店舗訪問を要さない）。

### Requirement 2: 単一 Access アプリケーションの構成と経路の包含・除外

**User Story:** 運用者として、認証境界を店舗ごとに分散させず、アプリ全体を覆う単一の Access アプリで一貫して管理したい。運用系エンドポイントは Access の背後に置きたくない。

#### Acceptance Criteria

1. THE Access_Application SHALL 認証を課すアプリケーションを単一とし、店舗別のアプリ・ポリシーを 0 個とする（店舗別の可否は Roster が担う。IdP・Access 側に店舗マスタの写しを作らない）。認証対象外経路（`/admin/*`・ヘルスチェック）のための bypass 定義は許すが、その個数を店舗数に依存しない定数個とする（Cloudflare Access のセルフホストアプリはパス包含で定義され、単一アプリ定義内に「このパスだけ除外」の切り欠きを作れないため、対象外経路は別アプリ定義＋全員 Bypass ポリシーで実現する。総数がちょうど 1 とはならないが、店舗数に対しては定数）。
2. THE Access_Application SHALL Entry `/` と Store_Path（`/s/{storeId}/` および `/s/{storeId}/ws`）を認証対象に含める。
3. WHEN Provisioning_API 経路（`/admin/*`）への未認証リクエストを受けたとき、THE Access_Application SHALL 当該リクエストをログイン誘導せず Worker へ透過させる（`ADMIN_TOKEN` の別系統認可を維持し、Access を二重に被せない）。
4. WHEN 認証対象外の死活監視経路（専用経路を新設せず、Access の bypass 対象とした既存の静的アセット経路。例: `/favicon.svg`）への未認証リクエストを受けたとき、THE Access_Application SHALL 当該リクエストをログイン誘導せず Worker へ透過させる（外形監視・死活監視が認証なしで到達できる）。専用 `/healthz` 等を新設せず既存アセット経路を bypass 対象とすることで、アセット応答も Worker の `env.ASSETS.fetch` 経由ゆえ Worker の死活を証明でき、新設コードがゼロのため Requirement 10.1 の差分制限と衝突しない（Q-health で確定）。専用経路が将来必要になれば後続 spec で扱う。
5. THE Access_Application SHALL EntraID_IdP と Whereami_IdP の 2 つをログイン方式として許可する。
6. WHEN いずれかの IdP 経由で認証が成立したとき、THE Access_Application SHALL issuer を TEAM_DOMAIN・audience を POLICY_AUD と一致する単一の識別子に固定した JWT を発行する（Worker の aud 検証が両 IdP 経路で同一値に照合できる）。

### Requirement 3: EntraID フェデレーション設定

**User Story:** 本部・SV の人間ユーザーとして、EntraID の資格情報で認証し、自分の email で担当店舗へ入りたい。

#### Acceptance Criteria

1. THE Cloudflare_Access SHALL EntraID_IdP を OIDC または SAML のいずれか一方の方式で IdP としてフェデレーションし、Access_Application のログイン方式として選択可能にする（テストユーザーが認証を完了し、POLICY_AUD を aud とする JWT を発行できることを観測点とする）。方式の確定は未決であり、whereami と検証経路が揃う OIDC を推奨するが本 spec では確定しない（要確認事項 Q-idp）。
2. WHEN EntraID_IdP 経由で認証が成立したとき、THE Cloudflare_Access SHALL 発行するすべての JWT の email クレームに、ユーザーの検証済み実 email を欠落・空文字なく載せる（Canonical_Identity が email を正準として抽出でき、`normalize` の正準形で Roster 照合の単位に一致する）。
3. WHEN EntraID_IdP 経由で認証したユーザーが Entry `/` へ到達したとき、THE Worker SHALL 検証済み実 email でレジストリの逆引きを行い、per-store-provisioning Requirement 7 が定める解決（1 店舗はその店舗、複数店舗は既定店、0 店舗は接続先なし）を実 email で作動させる。当該逆引きのアプリ側挙動は、Worker が IdP 経路を観測しないため Pilot_Access_Application の OTP_Login で登録したテスト email によりオフィスで検証できる（EntraID_IdP 固有のフェデレーション成立は Requirement 3.1 の観測点で別途確認する）。

### Requirement 4: whereami generic OIDC 設定（split-horizon）

**User Story:** 店舗スタッフとして、共用 iPad のブラウザを開くだけで、キッティングなしに自店舗のタイマー画面へ着きたい。

#### Acceptance Criteria

1. THE Cloudflare_Access SHALL Whereami_IdP を generic OIDC クライアントとして構成し、Authorization エンドポイントに内部名の `/authorize`、Token エンドポイントに外部名の `/token`、Certs（JWKS）エンドポイントに外部名の `/jwks` を個別に指定する。かつ Authorization に用いる内部名ホストと、Token・Certs に用いる外部名ホストが互いに異なるホスト名であること（split-horizon）を満たす（この `/jwks` は Cloudflare_Access が whereami の id_token を検証するための設定であり、Worker がアプリ JWT を検証する Access のチームドメイン certs `/cdn-cgi/access/certs` とは別層である）。
2. WHEN Whereami_IdP 経由で認証が成立したとき、THE Cloudflare_Access SHALL 発行する JWT の email クレームに、ローカル部が `staff-` + 店舗コード、ドメイン部が `yamaokaya.com` に厳密一致する合成 email `staff-{店舗コード}@yamaokaya.com` を載せる（`normalize` 後に Canonical_Identity が Roster 照合の単位として抽出できる）。合成 email 形式の保証は本項（Access 側の出口要件）と whereami 側 spec の責務に置き、Worker 側で IdP 経路別の形式判定を行わない（形式の壊れた email はどの Roster にも一致せず既存 Roster ゲートが拒否するため追加の防御を要さず、Worker は単一アプリ・単一 issuer/aud のためどの IdP 経由かを観測できない。Requirement 10.1 の差分制限とも整合）。
3. THE Cloudflare_Access SHALL Whereami_IdP が発行する `store_id` カスタムクレームを、OIDC claims 設定でアプリ JWT へ引き継ぐ設定（Access の OIDC claims 設定へ `store_id` を追加すること）を伴い、当該クレームを改変せず `oidc_fields.store_id` にネストした Store_Id_Claim としてアプリ JWT へ載せる（`store_id` は OIDC 標準外のカスタムクレームゆえ、この引き継ぎ設定を推奨する。値は数値または文字列で届きうるが、アプリ側の Canonical_Identity は email を用いるため認可判定には使わず、監査・診断のためにのみ受領時に文字列として正規化して保全する）。Store_Id_Claim の引き継ぎ不成立は認証・認可・接続の成立を妨げない（診断性のみ低下する）。ゆえに本番切替の前提条件（Requirement 1.1・1.2）には含めない。
4. THE Cloudflare_Access SHALL Whereami_IdP を唯一の generic OIDC クライアントとして扱い、他の IdP を generic OIDC として追加しない（EntraID_IdP は専用フェデレーションを用いる）。
5. THE Access_Enablement SHALL 本 Requirement が定める whereami 固有部分（split-horizon 設定・合成 email 形式・Store_Id_Claim の引き継ぎ）の事前検証を Whereami_Dev_Stage を用いて行い、本番とまったく同一のコード・同一の検証ロジックで認証が通ることを確認する。Whereami_Dev_Stage の対応表への「テスト店舗＝開発拠点のネットワーク」のデータ登録は whereami 側 spec への依頼事項であり本 spec のスコープ外である（本項は当該登録の成立を前提として Access 側の generic OIDC 接続設定の検証にのみ関与する）。

### Requirement 5: 実設定値の投入と secret 管理

**User Story:** 運用者として、プレースホルダのままの認証設定で有効化してしまう事故を防ぎ、実値の投入と型再生成を確実に伴わせたい。

#### Acceptance Criteria

1. THE Deployment_Config SHALL TEAM_DOMAIN に `https://<team>.cloudflareaccess.com` の形式（`https://` で始まり `.cloudflareaccess.com` で終わり、サブドメイン部分が 1〜63 文字の実チーム名である）を満たす実値を設定する（プレースホルダ `https://<team>.cloudflareaccess.com` を残さない）。
2. THE Deployment_Config SHALL POLICY_AUD に Access_Application の実 audience 識別子（空文字でなく、リポジトリ既定のプレースホルダ `<access-app-aud>` と一致しない 1 文字以上の値）を設定する。
3. IF TEAM_DOMAIN もしくは POLICY_AUD が「空」「未設定」「リポジトリ既定のプレースホルダ文字列と一致」のいずれかに該当するとき、THEN THE Access_Enablement SHALL `ACCESS_REQUIRED` を `"1"` へ切り替えず `ACCESS_REQUIRED="0"` を維持し、プレースホルダが残存している旨を示すエラーを提示する。
4. WHEN 運用者が `wrangler.jsonc` の vars を変更したとき、THE Access_Enablement SHALL `pnpm cf-typegen` を実行して `Env` 型を再生成する（設定の単一の正本と型の同期・tooling 規律）。
5. IF `pnpm cf-typegen` による `Env` 型の再生成が失敗するとき、THEN THE Access_Enablement SHALL `ACCESS_REQUIRED` を `"1"` へ切り替えず、型再生成が失敗した旨を示すエラーを提示する。
6. WHILE 段階的有効化の移行期であるとき、THE Deployment_Config SHALL 本番の実設定値の投入をデプロイ時のオーバーライドで行い、`wrangler.jsonc` に記録する `ACCESS_REQUIRED` の既定値として `"0"` を保つ（リポジトリの既定を OFF に据えたまま本番のみ ON にする）。オーバーライド方式は移行期の手段であり恒久状態にしない（オーバーライドを伴わない素のデプロイが認証を黙って OFF に戻す footgun を、移行期に限って受容する。恒久対処は 5.7）。
7. WHEN 本番で認証が安定運用に達したとき、THE Deployment_Config SHALL リポジトリ既定の `ACCESS_REQUIRED` を `"1"` へ反転し、以後はオーバーライドなしの素のデプロイでも認証が ON を保つ状態を終着点とする（デプロイ時オーバーライドへの依存を解消し、「静かな認証 OFF」への退行余地を構造から取り除く）。反転と同時に `.dev.vars` へ `ACCESS_REQUIRED="0"` を明示し、ローカル開発環境は OFF を維持する（本番のみ ON・ローカルは合鍵 URL 相当で開発を続けられる）。

### Requirement 6: identity と Roster の整合

**User Story:** 運用者として、Access が発行する identity（人間の実 email・iPad の合成 email）が、認可の単位である Roster と齟齬なく突き合わさることを保証したい。

#### Acceptance Criteria

1. THE Access_Enablement SHALL EntraID_IdP が発行する実 email を、対象ユーザーの権限範囲に応じてチェーン Roster（所属チェーンの全店舗へ有効）または店舗 Roster（当該店舗のみへ有効）のいずれかへ Provisioning_API 経由で登録する。
2. THE Access_Enablement SHALL Whereami_IdP が発行する合成 email `staff-{店舗コード}@yamaokaya.com` を、当該店舗の店舗 Roster へ Provisioning_API 経由で登録する。合成 email のローカル部 `staff-{店舗コード}` の店舗コード（文字列）と Registry の `storeCode`（文字列）は同一の外部マスタを正本とするため、この登録は文字列の完全一致による Registry の `storeCode` → `storeId` 逆引きで自動化できる。
3. THE Access_Enablement SHALL Roster へ登録する identity 文字列と Access が JWT に載せる email クレームの双方へ同一の `normalize`（前後空白の除去・小文字化）を適用したうえで、両者の正準形が完全一致するように登録値を定める（正準形が一致した場合にのみ同一 identity とみなす）。
4. WHERE `ACCESS_REQUIRED` が `"1"` であるとき、WHEN `/s/{storeId}/ws` への接続要求を受け、検証済み identity の正準形が対象店舗の実効 Roster（当該店舗の店舗 Roster と所属チェーンのチェーン Roster を投影・和集合した identity 集合）に含まれるとき、THE StoreTimerDO SHALL 当該 WS 接続を確立する。
5. WHERE `ACCESS_REQUIRED` が `"1"` であるとき、WHEN `/s/{storeId}/ws` への接続要求を受け、検証済み identity の正準形が対象店舗の実効 Roster に含まれないとき、THEN THE StoreTimerDO SHALL 当該 WS 接続を確立せず、認可失敗を示すエラー応答を返し、店舗の状態を一切変更しない。

### Requirement 7: Access バイパス防御の作動確認

**User Story:** 運用者として、有効化後に Worker への直叩きや内部ヘッダ偽装で認証を迂回できないことを、本番構成で確認したい。

#### Acceptance Criteria

1. WHERE `ACCESS_REQUIRED` が `"1"` であるとき、IF `/s/{storeId}/ws` への接続要求が有効な `Cf-Access-Jwt-Assertion` を欠く、または署名・issuer・audience・期限のいずれかの検証に失敗するとき、THEN THE Worker SHALL WebSocket アップグレードを行わず、かつ店舗 DO を呼び出さずに、要求が拒否されたことを示す HTTP 403 応答を返す。
2. WHEN `/s/{storeId}/ws` への接続要求を受理するとき、WHERE `ACCESS_REQUIRED` が `"1"` または `"0"` のいずれであっても、THE Worker SHALL クライアント由来の `X-Yudemen-Identity`（`IDENTITY_HEADER`）ヘッダを、送信された大文字小文字表記を問わず、店舗 DO への転送前に除去する。
3. WHEN `ACCESS_REQUIRED` が `"1"` のもとで `Cf-Access-Jwt-Assertion` の署名・issuer・audience・期限の検証に成功するとき、THE Worker SHALL 検証済み JWT のクレームから導出した `X-Yudemen-Identity`（`IDENTITY_HEADER`）値のみを設定して、要求を店舗 DO へ転送する。
4. THE Access_Enablement SHALL 本番構成（`ACCESS_REQUIRED` が `"1"`）に対して、次の 2 点を本番切替の完了条件として検証する: (a) 有効な `Cf-Access-Jwt-Assertion` を伴わない `/s/{storeId}/ws` 直叩きが HTTP 403 で拒否され、店舗 DO に到達しないこと、(b) クライアントが偽装した `X-Yudemen-Identity` 値が店舗 DO の受信ヘッダに現れないこと。

### Requirement 8: 有効化後の検証と外形監視

**User Story:** 運用者として、有効化後に 2 つの IdP 経路が実際に通り、既存のタイマー機能が回帰していないことを継続的に確認したい。

#### Acceptance Criteria

1. THE Access_Enablement SHALL EntraID_IdP 経由の認証から店舗接続までの経路を、切替時検証（Requirement 1.1・Pilot_Access_Application）に加え、日次以下の低頻度確認または運用者の申告ベースで確認する。EntraID_IdP は対話型ログインゆえ、短周期のヘッドレス自動化による常時合成監視を行わない（テストアカウント・MFA・条件付きアクセスにより脆いため、低頻度確認へ寄せる）。
2. THE Synthetic_Monitor SHALL Whereami_IdP 経由の経路について合成試行を行わず、Workers Logs（`wrangler.jsonc` の `observability.enabled = true` により有効化済み）のパッシブ指標——`/s/*/ws` の 403 レート急騰、および WebSocket アップグレード成功数の崩落——を観測し、いずれかの指標が正常域を外れる異常を検出した場合を系統性障害の候補と記録する（Whereami_IdP 経路は店舗ネットワーク内でのみ認証が成立するため外部からの合成試行は原理的に通れず、24h 常時接続の実機群のパッシブ観測で検知する。店内端末のヘルスビーコンは採用しない）。
3. IF Whereami_IdP 経路のパッシブ指標（403 レート・WebSocket アップグレード成功数）が正常域の異常閾値を超えたとき、または R8.7 の能動プローブが 403 以外を検出したとき、THEN THE Synthetic_Monitor SHALL 運用者へ通知する。
4. WHEN 本番切替後に既存のタイマー機能（開始・キャンセル・完了・調整・再接続 hydration）を検証するとき、THE Access_Enablement SHALL 認証無効時と同一の観測結果を返す場合を回帰なしと判定する。
5. IF 認証有効時のタイマー機能の観測結果が認証無効時と異なるとき、THEN THE Access_Enablement SHALL 回帰ありと判定し運用者へ通知する。
6. THE Synthetic_Monitor SHALL bypass 対象とした既存アセット経路（Requirement 2.4 の認証対象外経路。例: `/favicon.svg`）へ認証情報なしで到達し、5 秒以内に正常応答を受領した場合を死活確認成功とする。
7. WHILE `ACCESS_REQUIRED` が `"1"` であるとき、THE Synthetic_Monitor SHALL 認証情報なしの `/s/{storeId}/ws` 直叩きが HTTP 403 で拒否され店舗 DO に到達しないこと（Requirement 7.4 の (a)）を、既定 5 分周期の能動プローブで確認し、403 以外の応答（特に認証を経ない接続成立）を検出したとき運用者へ通知する。当該プローブは未認証の直叩きを外部から発するのみで IdP に依存せず、EntraID_IdP・Whereami_IdP のいずれの経路にも依存せずに外部から実行できる（Requirement 8.1 が「認証が通ること」を低頻度で見るのに対し、本項は「認証が要求されること」を短周期で見て「静かな認証 OFF」への退行を検知する）。

### Requirement 9: 失効運用

**User Story:** 運用者として、iPad の紛失や担当者の離任時に、当該 identity の店舗接続を確実に断ちたい。

#### Acceptance Criteria

1. WHEN iPad の紛失または担当者の離任が判明したとき、THE Access_Enablement SHALL Cloudflare_Access 上で当該 identity のセッションを失効させ、失効後は Access が再認証を要求して Entry `/`・WS への到達を遮断する状態にする（セッション寿命・失効判断は Access に委ね、アプリ側にセッションストアを設けない）。
2. WHEN 当該 identity の店舗接続を恒久的に断つとき、THE Access_Enablement SHALL Provisioning_API 経由で当該 identity を該当 Roster から除去し、かつ 9.1 のセッション失効を併せて行う。Roster 除去後、既存 WS は次回再接続時に Roster ゲートで拒否される（名簿改定は次接続から反映され、現接続は維持される。即時切断は per-store-provisioning の deactivated のみが担う確定挙動であり、生存中の既存 WS の即時切断は本 spec のスコープに入れない。厨房 WS の再接続頻度により実効窓は小さい）。
3. IF Roster からの identity 除去が失敗したとき、THEN THE Access_Enablement SHALL 除去前の Roster 状態を保持し、失効未完了を運用者へ通知し、失効完了を主張しない。
4. WHEN 失効を実施したとき、THE Access_Enablement SHALL 対象 identity・対象端末・実施日時・失効理由・実施措置を運用記録として残す（監査可能性。実装機構は設計時に確定する）。
5. THE Access_Enablement SHALL Access_Application のセッション寿命を Cloudflare_Access 上で明示的に設定する（具体値は未決であり要確認事項 Q-session とする。紛失 iPad の実効失効は「whereami 再認証が店舗ネットワーク内でのみ成立すること」と「セッション寿命」の二つで上限が決まる構造であり、セッション寿命を規定しない限り 9.1 の遮断保証の時間上限が定まらない依存構造を持つ）。

### Requirement 10: スコープ境界と既存資産の扱い

**User Story:** 保守者として、本機能が触る対象（Access 構成・設定投入・切替・検証・失効運用）と、触らない対象（休眠機構の内部実装・whereami 内部・別系統認可）を明確にしたい。

#### Acceptance Criteria

1. THE Access_Enablement SHALL 本機能の変更差分に、既存の休眠機構（`verifyAccessIdentity`・`IDENTITY_HEADER` の除去/付与・Entry 逆引き・店舗 DO の Roster 照合）の再実装が現れないようにし、`ACCESS_REQUIRED === "1"` 経路の有効化と本番構成での作動確認に限定する。
2. THE Access_Enablement SHALL 本機能の変更差分に Whereami_IdP の内部実装（OIDC 発行ロジック・ECS Fargate 運用・split-horizon の内部配線）が現れないようにし、Access 側の generic OIDC 接続設定と identity クレームの Roster 整合にのみ関与する。
3. THE Access_Enablement SHALL 本機能の変更差分に `src/worker-auth.ts` の `ADMIN_TOKEN` 照合ロジックの変更が現れないようにし、Provisioning_API（`/admin/*`）の認可を Access と独立した別系統として維持する。
4. THE Access_Enablement SHALL 本機能の変更差分にセッション状態の永続キー・失効ロジックのモジュールが現れないようにし、認証セッションの継続と失効判断を Cloudflare_Access に委ねる（ステートレス志向の維持）。
5. THE Access_Application SHALL 店舗別ポリシー数を 0 とし、認可（店舗ごとの可否）を店舗 DO の投影 Roster に委ねる（per-store-provisioning の設計継承。認証対象外経路のための bypass 定義は Requirement 2.1 のとおり店舗数に依存しない定数個を許すが、これは店舗別ポリシーではない）。
6. IF `ACCESS_REQUIRED` が `"0"` と `"1"` のいずれに切り替わっても、THEN THE Worker SHALL `/admin/*` 経路の `ADMIN_TOKEN` 認可判定を変更しない（別系統が Access 有効化の切替に影響されないことを確認する）。
7. THE Access_Enablement SHALL 開発時の認証経路検証のために本番の Access_Application へ OTP_Login を追加せず、OTP_Login を Pilot_Access_Application に限定する（迂回をコードや本番構成に持ち込まず、開発時検証は環境分離により開発環境のデータで行う）。
8. THE Access_Enablement SHALL 本機能の変更差分に本番 Whereami_IdP の対応表・コードへのテストデータ・分岐の投入が現れないようにし、whereami 固有部分の事前検証を Whereami_Dev_Stage のデータ登録（whereami 側 spec の責務・本 spec 外）に委ねる。

## 要確認事項（Q）

設計へ進む前に解決が必要な未決事項を集約する。ただし Q-idp・Q-session はいずれも本 spec の外部（IdP・運用・Cloudflare_Access の設定）の決定に属し、design へ進むことをブロックしない（確定するまで該当要件は上記の記述で暫定とする）。

- **[Q-idp] EntraID フェデレーション方式（OIDC / SAML）**: Requirement 3.1。whereami と検証経路が揃う OIDC を推奨するが確定しない。
- **[Q-session] Access_Application のセッション寿命の具体値**: Requirement 9.5。紛失 iPad の実効失効の時間上限を決める値であり、9.1 の遮断保証が寿命に依存する。

### 解決済み（確定）

- **[Q-monitor] 外形監視の実装形と周期**: Requirement 8.1・8.2・8.7・1.3。監視モデルを次のとおり確定した——(1) whereami 経路は合成試行を行わず、Workers Logs のパッシブ指標（`/s/*/ws` の 403 レート急騰・WebSocket アップグレード成功数の崩落）の閾値アラートで系統性障害を検知する（24h 常時接続の実機群が実トラフィックで全経路を検証するため）。(2) 認証が要求されること（静かな認証 OFF への退行）は R8.7 の能動プローブ（未認証直叩き＝403 の周期確認・IdP 非依存・外部実行可・既定 5 分周期）で検知する。(3) EntraID 経路は切替時検証＋低頻度（日次以下）確認または申告ベースとし、対話型ログインの短周期ヘッドレス自動化は行わない。(4) 店内端末のヘルスビーコンは採用しない。なお本項は**本番稼働の外形監視**の関心事であり、**開発時の認証経路検証**（Pilot_Access_Application の OTP_Login・Whereami_Dev_Stage による Requirement 1.8 のオフィス検証）とは別物である。両者を混同しない。
- **[Q-health] ヘルスチェック経路の要否と新設可否**: Requirement 2.4・8.6。専用 `/healthz` を新設せず、既存の静的アセット経路（例: `/favicon.svg`）を Access の bypass 対象として死活監視する案で確定する。死活監視の目的が「Worker が生きて応答すること」であればこれで足り、アセット応答も Worker（`env.ASSETS.fetch`）経由ゆえ Worker の死活を証明できる。新設コードがゼロのため Requirement 10.1 の差分制限と一切衝突しない。専用 `/healthz` が必要になれば後続 spec で扱う。

## 命名候補（要確認 — `naming.md` の公開シンボル確認事項）

以下は新規に必要となりうる公開シンボル。命名規律により**実装前にユーザー確認**を要する。候補の提示にとどめ、確定は保留する。

- **ヘルスチェック経路名**: Q-health の確定により当面新設不要（既存の `/favicon.svg` 等の静的アセット経路を bypass 対象として用いる）。専用経路を将来新設する場合の候補として `/healthz` を保留する。
