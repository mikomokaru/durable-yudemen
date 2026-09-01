# 本番切替 前提条件チェックリスト（cloudflare-access-enablement）

> 対象 spec: `cloudflare-access-enablement` / タスク 8.1「本番切替の前提条件チェックリストを整備・充足確認する」
> 種別: ［手続き］（コードで自動検証できない手続きタスク。CLI 実行結果と Pilot 検証結果を集約する切替判断のチェックリストである。実際の切替判断は運用者が本チェックリストに従い行う。アプリコードは変更しない・要件 10.1）
> 正本: `requirements.md` 要件 1.1 / 1.2 / 1.5 / 5.3 / 5.5、`design.md` 節「D-2 段階的切替・可逆手順」（step 1〜2 の前提条件）・節「B. Deployment_Config」・節「C-2 有効化ガード」

---

## 0. この文書の位置づけ（読む前に）

本チェックリストは、`ACCESS_REQUIRED` を本番でデプロイ時オーバーライドにより `"1"`（ON）へ切り替える（タスク 8.2）**直前の関門**である。切替を実行してよいのは、本書の**前提条件 (a)〜(d) がすべて満たされたときに限る**（要件 1.1 / 1.2 / 1.5）。

- これは**新規の検証を行う文書ではない**。先行するコードタスク（デプロイ前検査 CLI・タスク 3.1）と手続きタスク（Pilot 検証・タスク 7.1 / 7.4 / 7.5）の**結果を集約し、切替可否を一望する切替判断**の場である。個々の検証手順は各兄弟文書に委ね、本書はその成立を確認して束ねる。
- 前提条件はすべて**安全側の既定**に立つ。ひとつでも満たされないときは `ACCESS_REQUIRED="0"`（OFF）に留め、切替を実行しない（要件 5.3・「判定が付かない・前提が満たせないときは常に OFF」）。
- **アプリコードは一切変更しない**（要件 10.1）。本書の成果物は本チェックリスト（markdown）のみである。

### 前提条件の全体像（4 つの関門）

| 記号 | 前提条件 | 集約元 | 要件 |
| --- | --- | --- | --- |
| **(a)** | デプロイ前検査 CLI が通過（実 TEAM_DOMAIN / POLICY_AUD 投入済み・プレースホルダ残存なし・形式適合） | `tools/check-access-enablement.ts`（タスク 3.1） | 1.2 / 5.3 |
| **(b)** | `pnpm cf-typegen`（Env 型再生成）が成功 | タスク 6.2 / CLI（タスク 3.1） | 5.5 |
| **(c)** | Pilot 検証で 2 IdP 経路 各 1 回成功 ＋ バイパス防御作動を確認済み | タスク 7.4（アプリ側経路）・7.5（whereami 固有部分） | 1.1 |
| **(d)** | Pilot と本番の構成次元が一致 | タスク 7.1 | 1.5 |

> **切替判断の一文**: 「(a) 実値が入り」「(b) 型が同期し」「(c) 2 経路が通りバイパスが弾き」「(d) Pilot と本番の構成次元が揃った」——この 4 つが揃って初めて、本番 ON（タスク 8.2）へ進む。

---

## 前提条件 (a) — デプロイ前検査 CLI が通過（要件 1.2 / 5.3）

`ACCESS_REQUIRED` の本番切替は、実 `TEAM_DOMAIN` と実 `POLICY_AUD` が Deployment_Config に投入済みであることを前提条件とする（要件 1.2）。この充足は**デプロイ前検査 CLI（`tools/check-access-enablement.ts`）の通過**をもって確認する。CLI は純粋述語 `enablementReadiness`（`src/access-enablement.ts`）で「プレースホルダのまま ON」を弾く（要件 5.3）。

### 実行と確認

- [ ] 本番切替に用いる env（デプロイ時オーバーライド）に実値を投入した状態で、デプロイ前検査 CLI を実行する
  - `ACCESS_REQUIRED="1"`・`TEAM_DOMAIN`=（実チームドメイン）・`POLICY_AUD`=（本番 Access_Application の aud）をオーバーライドで与えて実行する
  - CLI はオーバーライド（環境変数）を最優先し、無ければ `wrangler.jsonc` vars を用いる（要件 5.6）
- [ ] CLI が**ゼロ終了**し、`All deploy-time preconditions are satisfied; enabling Access (ACCESS_REQUIRED="1") may proceed.` を出力すること
- [ ] `TEAM_DOMAIN` が形式に適合すること（`https://` + サブドメイン 1〜63 文字の DNS ラベル `[a-z0-9-]`（先頭・末尾ハイフン不可）+ `.cloudflareaccess.com`）。既定プレースホルダ `https://<team>.cloudflareaccess.com` が**残っていない**こと（要件 5.1）
- [ ] `POLICY_AUD` が非空で、既定プレースホルダ `<access-app-aud>` と**不一致**であること（要件 5.2）

### 不成立時の扱い（安全側の既定・要件 5.3）

- [ ] CLI が**非ゼロ終了**したときは、本番切替を**実行しない**。`ACCESS_REQUIRED` は `"0"`（OFF）に留める
  - CLI は `Refusing to enable Cloudflare Access (ACCESS_REQUIRED="1"): deploy-time preconditions are not met.` に続けて、どの変数が・なぜ不正か（空・未設定・プレースホルダ一致・形式不適合）を英語 1 行ずつ提示する。提示に従って実値を直し、(a) を再確認する
  - 例: `TEAM_DOMAIN still holds the repository placeholder ...` / `POLICY_AUD is empty or unset. ...`

> **リポジトリ既定は OFF のまま**（要件 5.6・タスク 6.1）。本番実値の投入はデプロイ時オーバーライドで行い、`wrangler.jsonc` にはプレースホルダ（`ACCESS_REQUIRED="0"`）を残す。CLI はオーバーライド値を評価するため、リポジトリ既定が OFF のままでも本番切替の実値を検査できる。

---

## 前提条件 (b) — `pnpm cf-typegen`（Env 型再生成）が成功（要件 5.5）

`wrangler.jsonc` の vars を変更したら `pnpm cf-typegen`（= `wrangler types`）で `Env` 型を再生成し、設定の単一の正本（`wrangler.jsonc`）と型を同期させる（要件 5.4）。再生成が失敗したら ON へ進まない（要件 5.5）。

### 確認

- [ ] `pnpm cf-typegen` が**成功**（ゼロ終了）し、`worker-configuration.d.ts` の `Env` 型が `wrangler.jsonc` の vars と同期していること
- [ ] デプロイ前検査 CLI（前提条件 (a)）の実行時、CLI が `ACCESS_REQUIRED="1"` の意図を検知して `pnpm cf-typegen` を内部実行し、その失敗を検知していないこと
  - CLI は ON の意図があるときのみ型再生成を走らせる。失敗時は `Env type regeneration (pnpm cf-typegen) failed ...` を提示して非ゼロ終了する（要件 5.5）
- [ ] 型再生成が失敗する場合は、本番切替を**実行しない**。失敗要因（例: `pnpm-workspace.yaml` の `allowBuilds` 未承認による `ERR_PNPM_IGNORED_BUILDS`・`tooling.md`）を解消してから (a)(b) を再確認する

> **(a) と (b) の関係**: デプロイ前検査 CLI（(a)）は型再生成の失敗も同一の関門で弾く。ゆえに (a) がゼロ終了していれば (b) も満たされている。本項は「型同期の成立」を独立の前提条件として明示し、CLI 出力に型再生成失敗のエラーが含まれていないことを再確認するためにある。

---

## 前提条件 (c) — Pilot 検証で 2 IdP 経路 各 1 回成功 ＋ バイパス防御作動（要件 1.1）

本番の `ACCESS_REQUIRED` を `"1"` へ切り替える前に、Pilot_Access_Application 経由で、EntraID_IdP と Whereami_IdP の**各経路につき最低 1 回の認証成功**（認証から店舗接続の確立まで到達）と、**有効な JWT を伴わない直叩きが拒否されること**（要件 7 のバイパス防御の作動）を検証し、これらすべてが成功することを前提条件とする（要件 1.1）。

検証は環境分離で二分され、それぞれ兄弟文書が担う。本書はその**成立を確認して束ねる**。

### (c-1) アプリ側経路 — Pilot + OTP_Login でオフィス完結（タスク 7.4）

集約元: `docs/access-enablement/pilot-otp-office-verification.md`（§5 完了条件）

- [ ] **検証 A（正常系）**: OTP ログイン → Entry 逆引き（1 店舗解決）→ WS 確立 が成功した（要件 3.3 / 6.4）
- [ ] **検証 B（バイパス防御）**: 有効な JWT を伴わない `/s/{storeId}/ws` 直叩きが **403・店舗 DO 未到達**で拒否され、Roster 非一致も **403・店舗状態不変**で拒否された（要件 6.5 / 7.1 / 7.4(a)）
- [ ] **検証 C（複数店舗切替）**: チェーン Roster ＋ Entry 複数店舗解決 ＋ `GET /entry/stores` 切替リストで、複数テスト店舗の切替が店舗選択機構の新設なしに成立した（要件 1.8 / 7.4）
- [ ] すべて **Pilot 検証デプロイ**（本番とは別）に対して実施し、**本番構成へ OTP・テストデータ・分岐を持ち込んでいない**（要件 10.7）

> **アプリ側経路がなぜ「2 IdP 経路」の代理になるか**: Worker は単一アプリ・単一 issuer/aud で「どの IdP 経由で JWT が生まれたか」を観測しない（`design.md` Cloudflare Access 前提 3・7）。ゆえに OTP_Login で発行された JWT でアプリ側経路（JWT 検証 → Roster 照合 → Entry 逆引き → WS 確立）を検証すれば、EntraID / whereami いずれの経路でも同一形の JWT が同一経路を通ることを担保できる。IdP 固有の成立は (c-2)・(c-3) で別途確認する。

### (c-2) whereami 固有部分 — Whereami_Dev_Stage（タスク 7.5）

集約元: `docs/access-enablement/whereami-dev-stage-verification.md`（§5 完了条件）

- [ ] **split-horizon**（観点 A）: 本番同一設定で Authorization=内部名ホスト／Token・Certs=外部名ホストの非対称を保ったまま認証が通る（要件 4.1 / 4.5）
- [ ] **合成 email 厳密一致**（観点 B）: `staff-{店舗コード}@yamaokaya.com` の厳密形式で発行され、`normalize` 後にテスト店舗 Roster と正準形が完全一致し接続が確立する（要件 4.2 / 4.5）
- [ ] **本番同一コード・同一ロジック**: 上記が IdP 経路別分岐・テスト用フラグ・裏口を含まない本番同一のコードで通った（要件 4.5 / 10.1）
- [ ] **本番非汚染**: 本番 whereami の対応表・コードにテストデータ・分岐を入れていない（要件 10.8）

#### Store_Id_Claim は前提条件に**含めない**（要件 4.3・非ブロッキング）

- [ ] （診断的確認・非ブロッキング）`oidc_fields.store_id` がアプリ JWT に**ネストして**引き継がれることを観測した（値は数値または文字列で届きうる。アプリは受領時に文字列へ正規化して監査・診断のためにのみ保全する）
  - `store_id` は **認可判定に用いない**（認可単位は email＝Canonical_Identity・Roster 照合）。ゆえに **Store_Id_Claim の引き継ぎ不成立は認証・認可・接続の成立を妨げない**（診断性が低下するのみ）。**本番切替の前提条件（要件 1.1 / 1.2）には含めない**（要件 4.3）。引き継ぎが未成立でも本番切替は可（後追い設定でよい）

### (c-3) 観測済みの実物エビデンス（つくば中央店・店舗コード 1263）

本番切替に先立ち、Cloudflare Access は既に構成され、**つくば中央店（店舗コード 1263）**で実トークンによる観測が済んでいる。これは (c) の whereami 経路に対する**エビデンス**である。

- 観測されたアプリ JWT: `email: "staff-1263@yamaokaya.com"`（トップレベル・正しい合成 email 形式）
- `oidc_fields: { store_id: 1263, auth_method: "store" }`（`store_id` は `oidc_fields` 配下に**ネスト**・**数値**で到着）

この観測は次を裏付ける。

- [ ] 合成 email 形式（ローカル部 `staff-` + 店舗コード・ドメイン部 `yamaokaya.com`）が実物で成立している（要件 4.2 の (c-2) 観点 B を補強）
- [ ] `store_id` が `oidc_fields` 配下にネストして到着し、数値表現でも届きうるという実装事実を確認済み（要件 4.3・診断のみ・非ブロッキング）

> **⚠ このエビデンスの射程（誤読しない）**: 上記トークン観測は whereami 経路の **whereami 固有部分（合成 email 形式・store_id 引き継ぎ）**に対する強いエビデンスだが、**それだけで前提条件 (c) を満たしたことにはならない**。前提条件 (c) の充足には、**アプリ側の全経路**（JWT 検証 → Roster 照合 → Entry 逆引き → WS 確立）とバイパス防御が (c-1) の手順（タスク 7.4）で、split-horizon が (c-2) の手順（タスク 7.5）で、それぞれ確認済みであることを要する。トークンが正しい形で発行されることと、その identity が Roster に一致し WS が確立し不正が 403 で弾かれることは別の事実である。両者が揃って初めて (c) は満たされる。

### (c) 全体の充足確認

- [ ] (c-1)・(c-2) の完了条件がすべて成立している（各兄弟文書の §5 を確認済み）
- [ ] EntraID_IdP・Whereami_IdP の**両経路**につき、認証から店舗接続の確立まで最低 1 回到達したことが（アプリ側経路 ＋ IdP 固有部分の組で）担保されている（要件 1.1）
- [ ] 有効な JWT を伴わない直叩きが拒否されること（バイパス防御の作動）を確認済み（要件 1.1・(c-1) 検証 B）

---

## 前提条件 (d) — Pilot と本番の構成次元が一致（要件 1.5）

本番切替は、Pilot_Access_Application と以下の**構成次元が一致する** Access_Application に対して行う（テスト経路と本番経路の構成差による見落としを避ける・要件 1.5）。

集約元: `docs/access-enablement/access-application-config-checklist.md`（§2-3 相違点まとめ・§4 完了確認）

- [ ] **許可する IdP 集合**が一致（EntraID_IdP と Whereami_IdP の**両方**）
  - Pilot にのみ OTP_Login を追加していること・**本番には OTP_Login を追加していない**こと（要件 10.7）
- [ ] **認証対象に含める経路**が一致（Entry `/`・`/s/{storeId}/`・`/s/{storeId}/ws`）
- [ ] **認証対象から除外する経路**が一致（`/admin/*`・`/pos/records`・既存アセット経路 例: `/favicon.svg` を bypass 用アプリ定義 ＋ 全員 Bypass ポリシーで実現・個数は店舗数非依存の定数個）
  - ポリシーが同一（全員 Bypass）ゆえ 3 経路は 1 つの bypass 用アプリにまとめられる。Action は **Bypass**（`Allow ＋ Everyone` では認証を要求し 302 が出続ける）
- [ ] **audience が単一値に固定されている**という構成が一致
  - 揃えるのは「aud が単一値に固定されている」という**構成次元**であって、**aud 値そのものではない**。Pilot と本番は別の Access アプリゆえ aud 値は各アプリ固有であり**異なってよい**（要件 1.5）
- [ ] **issuer** が `TEAM_DOMAIN` に単一固定という構成が一致（両 IdP 経路で同一）
- [ ] アプリ定義数 = 1・店舗別ポリシー数 = 0 が一致（要件 10.5）

---

## 最終判定 — 本番切替へ進んでよいか

以下の 4 つがすべて成立したときに限り、本番切替（タスク 8.2）へ進む。ひとつでも欠けるときは `ACCESS_REQUIRED="0"` に留め、切替を実行しない（安全側の既定・要件 5.3）。

- [ ] **(a)** デプロイ前検査 CLI が通過（実 TEAM_DOMAIN / POLICY_AUD・プレースホルダ残存なし・形式適合）（要件 1.2 / 5.3）
- [ ] **(b)** `pnpm cf-typegen` が成功し Env 型が同期（要件 5.5）
- [ ] **(c)** Pilot 検証で 2 IdP 経路 各 1 回成功 ＋ バイパス防御作動を確認済み（要件 1.1）
- [ ] **(d)** Pilot と本番の構成次元が一致（許可 IdP 集合・包含/除外経路・audience 単一固定という構成）（要件 1.5）

> **次のステップ**: 4 前提条件がすべて満たされたら、タスク 8.2（`ACCESS_REQUIRED` をデプロイ時オーバーライドで `"1"` に切替）へ進む。切替後は、実店舗ネットワーク上の最終疎通をパイロット 1 号店の立ち上げと兼ねて **1 回のみ**実施し（タスク 8.3・要件 1.9）、本番切替の完了条件（タスク 8.4・要件 7.4 / 8.4）を検証する。系統性障害を検出したら検出から 5 分以内に `"0"` へ戻す（タスク 9.2・要件 1.3）。

---

## スコープ境界（触らないもの・要件 10）

- 休眠機構（`verifyAccessIdentity` / `canonicalIdentity` / `IDENTITY_HEADER` 除去・付与 / `resolveEntryDestination` / 店舗 DO の `isRostered`・`effectiveRoster`）を**再実装しない**。本書は本番切替の前提条件の充足確認に限る（要件 10.1）。
- Whereami_IdP の内部実装・split-horizon の内部配線に触れない（要件 10.2）。
- `ADMIN_TOKEN`（Provisioning_API・`/admin/*`）は Access と独立した別系統。認可ロジックを変更しない（要件 10.3 / 10.6）。
- セッションの継続・失効は Cloudflare Access に委ねる。アプリ側にセッションストア・失効ロジックを新設しない（要件 10.4・失効運用はタスク 9.3）。
- 本番の Access_Application へ OTP_Login を追加しない（要件 10.7）。本番 Whereami_IdP の対応表・コードへテストデータ・分岐を入れない（要件 10.8）。

---

## 参照

- 要件: `requirements.md` Requirement 1.1（各 IdP 経路 各 1 回成功 ＋ バイパス防御作動が前提条件）、1.2（実 TEAM_DOMAIN / POLICY_AUD 投入が前提条件）、1.5（Pilot と本番の構成次元一致）、5.3（プレースホルダ残存時は ON にせずエラー提示）、5.5（型再生成失敗時は ON にせずエラー提示）
- 設計: `design.md` 節「D-2 段階的切替・可逆手順」（step 1 Pilot 検証・step 2 前提条件）、節「B. Deployment_Config」、節「C-2 有効化ガード」、節「Cloudflare Access 前提 4」（`oidc_fields.store_id` のネスト・数値到着・診断のみ）
- コード: `tools/check-access-enablement.ts`（デプロイ前検査 CLI・タスク 3.1）、`src/access-enablement.ts`（純粋述語 `enablementReadiness`・タスク 2.1）
- 兄弟文書: `access-application-config-checklist.md`（タスク 7.1・構成次元）、`pilot-otp-office-verification.md`（タスク 7.4・アプリ側経路）、`whereami-dev-stage-verification.md`（タスク 7.5・whereami 固有部分）、`entraid-federation-procedure.md`（タスク 7.2）、`whereami-generic-oidc-procedure.md`（タスク 7.3）
- 後続タスク: 8.2（本番 ON）、8.3（実店舗最終疎通・1 回）、8.4（切替完了条件）、9.1（外形監視）、9.2（切戻し）
