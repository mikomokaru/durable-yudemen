# Access_Application 構成チェックリスト（本番 + Pilot）

> **タスク 7.1（cloudflare-access-enablement）成果物**
> 単一 Access_Application と Pilot_Access_Application を、本番同一の構成次元で構成するための運用者向けチェックリスト。
> 検証対象: `requirements.md` Requirement 2.1 / 2.2 / 2.3 / 2.4 / 2.5 / 2.6 / 1.5 / 1.1 / 10.5 / 10.7、`design.md` 節「A. Cloudflare Access 構成」「D-2 段階的切替・可逆手順」。

## この文書の性格（読む前に）

- これは **コードで自動検証できない設定タスク**の成果物である。実際の Cloudflare Access 構成は運用者が本チェックリストに従い Cloudflare ダッシュボード / API で実施する。
- **アプリコードは一切変更しない**（要件 10.1 の差分制限）。本文書が扱うのは Cloudflare Access 側の構成と、Pilot 検証用デプロイの env 値投入のみである。
- 本番の Access_Application と Pilot_Access_Application は**別のアプリ**である。両者で一致させるのは「構成次元」（許可 IdP 集合・包含/除外経路・audience が単一値に固定されているという構成）であって、aud 値そのものではない。aud 値は各アプリ固有ゆえ異なってよい（要件 1.5）。
- **本番の Access_Application には OTP_Login を追加しない**。OTP_Login は Pilot_Access_Application に限定する（要件 10.7）。

---

## 1. 本番 Access_Application の構成チェックリスト

### 1-1. アプリ定義の個数（要件 2.1 / 10.5）

- [ ] 認証を課すアプリ定義 = **1**（アプリ全体を覆う単一のセルフホストアプリ）
- [ ] 店舗別のアプリ定義 = **0**、店舗別ポリシー = **0**（店舗ごとの可否は店舗 DO の投影 Roster が担う。IdP・Access 側に店舗マスタの写しを作らない）
- [ ] 認証対象外経路のための **bypass 用アプリ定義**は許すが、その個数は**店舗数に依存しない定数個**であること
  - Cloudflare Access のセルフホストアプリはパス包含で定義され、単一アプリ定義内に「このパスだけ除外」の切り欠きを作れない。ゆえに対象外経路は**別アプリ定義 ＋ 全員 Bypass ポリシー**で実現する
  - アプリ総数はちょうど 1 にはならない（認証アプリ 1 + bypass 用アプリ）が、店舗数に対しては定数個であること

### 1-2. 認証対象に**含める**経路（要件 2.2）

認証を課すアプリ定義のパス包含に、次の 3 経路を含める。

- [ ] Entry `/`
- [ ] Store_Path `/s/{storeId}/`
- [ ] Store WS `/s/{storeId}/ws`

### 1-3. 認証対象から**除外**する経路（bypass 用アプリ定義 ＋ 全員 Bypass ポリシー・要件 2.3 / 2.4）

- [ ] `/admin/*`（Provisioning_API）
  - 未認証リクエストをログイン誘導せず Worker へ**透過**させる。`ADMIN_TOKEN` の別系統認可（`src/worker-auth.ts`）を維持し、Access を二重に被せない（要件 2.3 / 10.3）
- [ ] 既存の静的アセット経路（死活監視用・例: `/favicon.svg`）
  - 専用 `/healthz` 等は**新設しない**（Q-health 確定）。既に `public/` にある静的アセットを bypass 対象に加えるのみ（新設コードゼロ）
  - 未認証リクエストをログイン誘導せず Worker へ透過させる。アセット応答も Worker（`env.ASSETS.fetch`）経由ゆえ Worker の死活を証明できる（要件 2.4 / 8.6）
  - bypass 監視に用いる既存アセット経路（運用選択）: `/favicon.svg`（`public/favicon.svg` が存在することを確認済み）

> 実現方式: `/admin/*` 用と 既存アセット経路用の **別アプリ定義**を作り、いずれにも**全員 Bypass ポリシー**（Everyone を Bypass）を割り当てる。これらは店舗別ポリシーではない（要件 10.5）。

### 1-4. 許可するログイン方式（IdP）（要件 2.5）

- [ ] **EntraID_IdP**（人間ユーザー: 本部・SV 等。identity = 実 email）
- [ ] **Whereami_IdP**（店舗 iPad: 在圏認証。identity = `staff-{店舗コード}@yamaokaya.com`）
- [ ] 許可 IdP は上記 **2 つのみ**（OTP_Login は本番に追加しない・要件 10.7）

### 1-5. 発行 JWT の issuer / audience 固定（要件 2.6）

- [ ] 発行 JWT の **issuer** = `TEAM_DOMAIN` に固定（両 IdP 経路で同一）
- [ ] 発行 JWT の **audience** = `POLICY_AUD` に固定（両 IdP 経路で同一の単一識別子）
- [ ] いずれの IdP 経由で認証が成立しても、issuer=TEAM_DOMAIN・audience=POLICY_AUD の単一形の JWT が発行されること（Worker の `aud` 検証が両経路で同一値に照合できる）

---

## 2. Pilot_Access_Application の構成チェックリスト（本番同一構成の縮小版）

Pilot は本番の検証を先行させるためのテスト用アプリ定義であり、**本番と同一の構成次元**を持つ縮小版とする。相違は「OTP_Login を追加で許可すること」と「aud 値が Pilot 固有であること」のみ。

### 2-1. 本番と一致させる構成次元（要件 1.5）

- [ ] アプリ定義 = 1・店舗別ポリシー = 0（本番と同一）
- [ ] 認証対象に含める経路 = Entry `/`・`/s/{storeId}/`・`/s/{storeId}/ws`（本番と同一）
- [ ] 除外経路 = `/admin/*`・既存アセット経路（例: `/favicon.svg`）を bypass 用アプリ定義 ＋ 全員 Bypass ポリシーで実現（本番と同一・個数は店舗数非依存の定数個）
- [ ] audience が**単一値に固定されている**という構成（本番と同一の構成次元）
  - 一致させるのは「aud が単一値に固定されている」という構成次元であって、**aud 値そのものではない**。Pilot と本番は別の Access アプリゆえ aud 値は各アプリ固有であり異なってよい（要件 1.5）
- [ ] issuer = TEAM_DOMAIN に固定（本番と同一の構成次元）

### 2-2. Pilot に**のみ**許可する検証手段（要件 10.7）

- [ ] 許可 IdP: **EntraID_IdP ・ Whereami_IdP ・ OTP_Login**（Cloudflare Access 標準の One-Time PIN）
  - OTP_Login は開発時のアプリ側経路検証（JWT 検証 → Roster 照合 → Entry 逆引き → WS 確立）をオフィス完結で行うための開発用ログイン方式
  - Worker は単一アプリ・単一 issuer/aud のため「どの IdP 経由で JWT が生まれたか」を観測しない。ゆえに OTP_Login でアプリ側経路を検証できる（店舗・whereami 非依存）
- [ ] **本番の Access_Application には OTP_Login を追加していない**ことを再確認する（要件 10.7）

### 2-3. 本番との相違点まとめ（意図的な差分のみ）

| 構成次元 | 本番 Access_Application | Pilot_Access_Application | 一致させるか |
| --- | --- | --- | --- |
| アプリ定義数 | 1 | 1 | ○ 一致 |
| 店舗別ポリシー数 | 0 | 0 | ○ 一致 |
| 含める経路 | `/`・`/s/{id}/`・`/s/{id}/ws` | 同左 | ○ 一致 |
| 除外経路（bypass） | `/admin/*`・既存アセット | 同左 | ○ 一致 |
| 許可 IdP | EntraID・whereami | EntraID・whereami ＋ **OTP_Login** | △ Pilot のみ OTP を追加 |
| issuer | TEAM_DOMAIN 単一固定 | TEAM_DOMAIN 単一固定 | ○ 構成次元一致 |
| audience | POLICY_AUD 単一固定 | Pilot 固有 aud を単一固定 | △ 単一固定という構成は一致・**値は異なってよい** |

---

## 3. Pilot 検証用デプロイの用意手順（本番とは別）

後続のオフィス完結検証（タスク 7.4）の OTP ログインの向き先を確定させるため、Pilot_Access_Application の aud を `POLICY_AUD` に持ち、`ACCESS_REQUIRED="1"` かつ実 TEAM_DOMAIN で動く検証用デプロイを、本番とは別に用意する。

### 3-1. Pilot 用の値の確定

- [ ] Pilot_Access_Application の実 **aud 値**を控える（本番 aud とは別値でよい）
- [ ] 実 **TEAM_DOMAIN**（`https://<team>.cloudflareaccess.com` 形式の実チームドメイン）を控える。Pilot も本番と同一の Cloudflare Access チーム配下ゆえ TEAM_DOMAIN は共通
- [ ] 投入値はプレースホルダ（`https://<team>.cloudflareaccess.com` / `<access-app-aud>`）を残さない実値であること

### 3-2. デプロイ時オーバーライド方式での Pilot 検証デプロイ（env のみ・コード変更なし）

- [ ] リポジトリの `wrangler.jsonc` の vars 既定は **`ACCESS_REQUIRED="0"`・プレースホルダのまま**を保つ（要件 5.6・タスク 6.1 と整合）。Pilot 検証用の実値はデプロイ時オーバーライドで投入する
- [ ] Pilot 検証用デプロイに次の env をデプロイ時オーバーライドで投入する:
  - `ACCESS_REQUIRED="1"`
  - `TEAM_DOMAIN`=（実チームドメイン）
  - `POLICY_AUD`=（Pilot_Access_Application の aud 値）
- [ ] 本番とは**別の**デプロイ先（別の Worker 環境 / 別名）に対して行い、本番デプロイに Pilot 用の値・OTP を混入させない
- [ ] デプロイ前検査 CLI（`tools/check-access-enablement.ts`・タスク 3.1）で、投入した TEAM_DOMAIN / POLICY_AUD がプレースホルダでも形式不適合でもないこと（ガード通過）を確認する
- [ ] `wrangler.jsonc` の vars を触った場合は必ず `pnpm cf-typegen` で `Env` 型を再生成する（設定の単一の正本と型を同期・要件 5.4 / 5.5）

> **オーバーライド方式は移行期の手段であり恒久状態にしない**（恒久対処はタスク 9.4 の既定反転）。`wrangler.jsonc` の該当コメントにこの旨を保つ（タスク 6.1）。

### 3-3. Pilot 検証デプロイの確定事項（後続タスクへの橋渡し）

- [ ] Pilot_Access_Application の aud = `POLICY_AUD`（Pilot 固有値）で、`ACCESS_REQUIRED="1"`・実 TEAM_DOMAIN で動く検証用デプロイが用意できている
- [ ] これにより、後続のオフィス完結検証（タスク 7.4）の **OTP ログインの向き先**（= この Pilot 検証デプロイ）が確定する

---

## 4. 完了確認（本タスクのゴール）

- [ ] 本番 Access_Application の構成チェックリスト（§1）を満たす構成が定義できている
- [ ] Pilot_Access_Application の構成チェックリスト（§2）を満たす構成が定義できている（本番同一構成次元 ＋ OTP_Login のみ差分）
- [ ] Pilot 検証用デプロイ（§3）が本番とは別に用意でき、タスク 7.4 の OTP ログイン向き先が確定している
- [ ] アプリコードに変更を加えていない（要件 10.1 の差分制限）
- [ ] 本番の Access_Application に OTP_Login を追加していない（要件 10.7）

---

## 参照

- 要件: `requirements.md` Requirement 2（単一 Access アプリの構成と経路の包含・除外）、1.1・1.5（段階的ロールアウト・構成次元一致）、10.5（店舗別ポリシー 0）、10.7（OTP を本番に持ち込まない）
- 設計: `design.md` 節「A. Cloudflare Access 構成」（A-1 単一 Access_Application）、節「D-2 段階的切替・可逆手順」、節「Overview / 変えないもの（不変点・要件10）」
- 後続タスク: 7.2（EntraID フェデレーション）、7.3（whereami generic OIDC）、7.4（Pilot + OTP でオフィス完結検証）、8.x（本番切替）
