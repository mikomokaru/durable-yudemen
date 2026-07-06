# 本番切替手順 — ACCESS_REQUIRED をデプロイ時オーバーライドで "1" にする（cloudflare-access-enablement）

> 対象 spec: `cloudflare-access-enablement` / タスク 8.2「ACCESS_REQUIRED をデプロイ時オーバーライドで "1" に切り替える」
> 種別: ［手続き］（コードで自動検証できないデプロイ手続きタスク。実際のデプロイは運用者が本手順に従い実施する。アプリコード・`wrangler.jsonc` を変更しない・要件 10.1／リポジトリ既定 `"0"` を保つ）
> 正本: `requirements.md` 要件 5.6（＋前提として 1.1／1.2／1.5／5.3／5.5）、`design.md` 節「B. Deployment_Config」・節「D-2 段階的切替・可逆手順」step 3（本番 ON）
> 直前の関門: `docs/access-enablement/production-cutover-preconditions.md`（タスク 8.1・前提条件 (a)〜(d)）

---

## 0. この文書の位置づけ（読む前に）

本手順は、本番の `ACCESS_REQUIRED` を**デプロイ時オーバーライド**により `"1"`（ON）へ切り替える一手を、具体的なコマンドとして与える。切替は **env の投入のみ**で成立し、**アプリコードは一切変更しない**（`ACCESS_REQUIRED` の 3 分岐＝WS の JWT 検証・店舗 DO の Roster 判定・Entry `/` の逆引きは、いずれも実行時に `env.ACCESS_REQUIRED` を読む休眠経路であり、env 値の切替だけで作動する・要件 1.4）。

- **前提**: 本手順を実行してよいのは、タスク 8.1 の前提条件 (a)〜(d) が**すべて満たされたとき**に限る（§1）。ひとつでも欠けるときは `ACCESS_REQUIRED="0"`（OFF）に留め、切替を実行しない（安全側の既定・要件 5.3）。
- **リポジトリ既定は OFF のまま**: 実値の投入と ON はデプロイ時オーバーライドで行い、リポジトリの `wrangler.jsonc` は `ACCESS_REQUIRED="0"`・`TEAM_DOMAIN`／`POLICY_AUD` のプレースホルダを**そのまま保つ**（要件 5.6・タスク 6.1 と整合）。**本手順で `wrangler.jsonc` を編集しない。**
- **オーバーライド方式は移行期の手段**: デプロイ時オーバーライドは段階的有効化の「移行期」の手段であり、恒久状態にしない。オーバーライドを伴わない素のデプロイが認証を黙って OFF に戻す footgun を、移行期に限って受容する。**恒久対処はタスク 9.4 の既定反転**（`wrangler.jsonc` 既定を `"1"` へ・`.dev.vars` でローカル OFF 維持・要件 5.7）で行う（§6）。
- 本書の成果物は本手順書（markdown）のみである。

### 切替の一文

「前提条件 (a)〜(d) が揃った」ことを確認し（§1）→「実 `TEAM_DOMAIN`／`POLICY_AUD` を投入した状態でデプロイ前検査 CLI を通し」（§2）→「同じ実値を `--var` オーバーライドで与えて `ACCESS_REQUIRED="1"` のままデプロイする」（§3）。これだけである。コード差分はゼロ。

---

## 1. 前提条件の充足確認（タスク 8.1・要件 1.1／1.2／1.5／5.3／5.5）

切替の直前に、`production-cutover-preconditions.md` の 4 前提条件がすべて成立していることを確認する。詳細は同文書に委ね、ここでは最終ゲートとして再掲する。

- [ ] **(a)** デプロイ前検査 CLI が通過（実 `TEAM_DOMAIN`／`POLICY_AUD` 投入済み・プレースホルダ残存なし・形式適合）（要件 1.2／5.3）
- [ ] **(b)** `pnpm cf-typegen`（Env 型再生成）が成功し Env 型が同期（要件 5.5）
- [ ] **(c)** Pilot 検証で 2 IdP 経路 各 1 回成功 ＋ バイパス防御作動を確認済み（要件 1.1）
- [ ] **(d)** Pilot と本番の構成次元が一致（許可 IdP 集合・包含/除外経路・audience 単一固定という構成）（要件 1.5）

> ひとつでも欠けるときは切替を実行しない。`ACCESS_REQUIRED="0"`（OFF）に留め、`production-cutover-preconditions.md` に戻って不足を解消する。

---

## 2. 実値の投入とデプロイ前検査 CLI の通過（要件 5.1／5.2／5.3／5.5／5.6）

本番切替に用いる実値を**環境変数（デプロイ時オーバーライド）**として与え、デプロイ前検査 CLI（`tools/check-access-enablement.ts`）を通す。CLI はオーバーライド（環境変数）を最優先し、無ければ `wrangler.jsonc` vars を用いる（要件 5.6）。**リポジトリ既定が OFF のままでも、オーバーライド値で本番切替の実値を検査できる。**

### 2-1. 実値をシェル変数に置く（ドリフト防止）

投入する実値を一箇所に定義し、CLI 検査（§2）とデプロイ（§3）で**同一値**を使い回す。値のズレ（検査した値と違う値でデプロイする事故）を防ぐ。

```sh
# 実チームドメイン（https:// + 実チーム名 + .cloudflareaccess.com）。プレースホルダを残さない（要件5.1）。
export TEAM_DOMAIN="https://<実チーム名>.cloudflareaccess.com"

# 本番 Access_Application の実 audience（AUD）タグ。非空・非プレースホルダ（要件5.2）。
export POLICY_AUD="<本番 Access アプリの実 AUD>"

# 有効化の意図。CLI はこの意図があるときのみ型再生成を走らせ、プレースホルダ残存・形式不適合を弾く。
export ACCESS_REQUIRED="1"
```

- `TEAM_DOMAIN` は Cloudflare Zero Trust ダッシュボードのチーム URL（`https://<team>.cloudflareaccess.com`）。
- `POLICY_AUD` は本番 Access_Application の **Application Audience (AUD) Tag**（Pilot の AUD とは別値でよい・要件 1.5）。

### 2-2. デプロイ前検査 CLI を実行する

```sh
pnpm access-preflight
```

- [ ] CLI が**ゼロ終了**し、次を出力すること:
  `All deploy-time preconditions are satisfied; enabling Access (ACCESS_REQUIRED="1") may proceed.`
- CLI は `ACCESS_REQUIRED="1"` の意図を検知して内部で `pnpm cf-typegen` を実行し、その失敗も同一の関門で弾く（前提条件 (b) と整合・要件 5.5）。

### 2-3. 不成立時の扱い（安全側の既定・要件 5.3／5.5）

- [ ] CLI が**非ゼロ終了**したときは、**切替を実行しない**。`ACCESS_REQUIRED` は `"0"`（OFF）に留める。
  - CLI は `Refusing to enable Cloudflare Access (ACCESS_REQUIRED="1"): deploy-time preconditions are not met.` に続けて、どの変数が・なぜ不正か（空・未設定・プレースホルダ一致・形式不適合・型再生成失敗）を英語 1 行ずつ提示する。提示に従って実値を直し、§2 を再確認する。
  - 例: `TEAM_DOMAIN still holds the repository placeholder ...` / `POLICY_AUD is empty or unset. ...` / `Env type regeneration (pnpm cf-typegen) failed ...`

---

## 3. ACCESS_REQUIRED を "1" にしてデプロイする（要件 5.6・design D-2 step 3）

デプロイ前検査を通過したら、**同じ実値**を `wrangler deploy` の `--var` オーバーライドで与えてデプロイする。`--var key:value` は `wrangler.jsonc` の vars に対する**デプロイ時オーバーライド**であり、両方に定義がある場合は `--var` の値が使われる（Wrangler v4）。値は常に文字列として Worker の `env` に渡る。

> **なぜ `--var` か（`wrangler.jsonc` を編集しない・要件 5.6／10.1）**: リポジトリの `wrangler.jsonc` は `ACCESS_REQUIRED="0"`・プレースホルダを保つ。実値と ON は**デプロイの瞬間だけ**オーバーライドで注入し、リポジトリの正本には残さない。コード差分ゼロ・env のみの切替を成立させる。

### 3-1. assets ビルド（デプロイ前に必須）

`assets` バインディング（`dist`）が要るため、デプロイ前に本番ビルドする（`build = tsc --noEmit && vite build`）。

```sh
pnpm build
```

### 3-2. オーバーライド付きデプロイ

§2-1 で `export` した `TEAM_DOMAIN`／`POLICY_AUD`／`ACCESS_REQUIRED` を、`--var` に**同一値**で渡す。

```sh
pnpm wrangler deploy \
  --var "ACCESS_REQUIRED:${ACCESS_REQUIRED}" \
  --var "TEAM_DOMAIN:${TEAM_DOMAIN}" \
  --var "POLICY_AUD:${POLICY_AUD}"
```

> **⚠ `--var key:value` の分割規則**: `--var` は**最初のコロン**でキーと値を分割する。`TEAM_DOMAIN` の値 `https://…` はコロンを含むが、分割は先頭コロンのみゆえ `key=TEAM_DOMAIN`・`value=https://<実チーム名>.cloudflareaccess.com` と正しく解釈される。値に `//` を含むため、シェルのクォート（上記の `"..."`）を必ず付す。

- 上記は `ACCESS_REQUIRED`／`TEAM_DOMAIN`／`POLICY_AUD` の 3 つだけをオーバーライドする。`OBSERVE_DEBUG` は `wrangler.jsonc` の既定 `"0"` のまま引き継がれる（`--var` で指定した key のみが上書きされる）。
- `ADMIN_TOKEN` は secret ゆえ vars ではなく `wrangler secret put ADMIN_TOKEN` の別系統で投入済み（本手順で変えない・要件 10.3）。secret はデプロイで削除されない。

### 3-3. デプロイの確認

- [ ] `wrangler deploy` がゼロ終了し、新バージョンが公開されたこと（`pnpm wrangler deployments status` で現行バージョンを確認）。
- [ ] デプロイ後の本番 Worker が `ACCESS_REQUIRED="1"` で動作していること（次の疎通・完了条件で確認する。§4）。

---

## 4. 切替直後にすること（本手順の完了条件ではない・後続タスクへ引き渡す）

本手順（8.2）の完了は「オーバーライドで `ACCESS_REQUIRED="1"` のデプロイが成立したこと」までである。切替後の疎通・完了条件・監視・切戻しは後続タスクが担う。ここでは引き渡し先だけを示す。

- [ ] 実店舗ネットワーク上の本番構成 最終疎通を **1 回のみ**実施し、パイロット 1 号店の立ち上げと兼ねる（タスク 8.3・要件 1.9）。
- [ ] 本番切替の完了条件を検証する: 未認証直叩きが 403・店舗 DO 未到達／偽装 `X-Yudemen-Identity` が DO 受信ヘッダに現れない／タイマー機能が回帰なし（タスク 8.4・要件 7.4／8.4／8.5）。
- [ ] 外形監視（Workers Logs パッシブ指標＋未認証直叩き 403 の能動プローブ 5 分周期）を整備・稼働（タスク 9.1・要件 8）。
- [ ] 系統性障害を検出したら**検出から 5 分以内**に `ACCESS_REQUIRED="0"` へ戻す（§5・タスク 9.2・要件 1.3／1.6）。

---

## 5. 切戻し（可逆性・要件 1.3／1.6）

切替は env のみゆえ可逆である。系統性障害（whereami 経路の Workers Logs パッシブ指標が正常域を外れる／R8.7 能動プローブが 403 以外を検出）を受けたら、**検出から 5 分以内**に OFF へ戻す。

```sh
# ACCESS_REQUIRED を "0" に戻す（TEAM_DOMAIN / POLICY_AUD は投入したままでよい＝OFF 経路では読まれない）。
pnpm build
pnpm wrangler deploy --var "ACCESS_REQUIRED:0"
```

- [ ] 戻し完了から **1 分以内**に、合鍵 URL による店舗接続が JWT 検証を経ずに成立することを確認する（要件 1.6）。
- 詳細な切戻し判断・手順はタスク 9.2 の切戻しランブックに従う。個別 identity／店舗の認可失敗は全体 OFF の根拠とせず、Provisioning_API 経由の Roster 修正で対処する（要件 1.7）。

---

## 6. 移行期の終着点（恒久対処はタスク 9.4・要件 5.7）

デプロイ時オーバーライド方式は**移行期に限る**。本番が安定運用に達したら、タスク 9.4（既定反転）で終着点へ移す。

- リポジトリ既定の `ACCESS_REQUIRED` を `"1"` へ反転し、オーバーライドなしの素のデプロイでも認証が ON を保つ状態を終着点とする（「静かな認証 OFF」への退行余地を構造から除く）。
- 反転と同時に `.dev.vars` へ `ACCESS_REQUIRED="0"` を明示し、ローカル開発環境（`pnpm dev`）は OFF を維持する。
- 反転時の `wrangler.jsonc` 編集は `pnpm cf-typegen` を伴わせる（設定の正本と型の同期）。
- **本手順（8.2）ではこの反転を行わない。** 8.2 はあくまでオーバーライドによる移行期の ON である。

---

## 付録: CI/CD 経由でオーバーライドする場合（任意）

本手順は運用者の手元での `wrangler deploy` を主とする。GitHub Actions（`.github/workflows/ci-cd.yml`・`cloudflare/wrangler-action@v3`・`command: deploy`）経由でオーバーライドを注入する場合は、実値をリポジトリに直書きせず GitHub の Secrets/Variables から与え、`command` に `--var` を追加する。

```yaml
# 例（抜粋）: deploy ステップの command にオーバーライドを付す。実値は secrets/vars から注入する。
- name: Deploy with Wrangler
  uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    packageManager: pnpm
    command: >-
      deploy
      --var "ACCESS_REQUIRED:1"
      --var "TEAM_DOMAIN:${{ secrets.ACCESS_TEAM_DOMAIN }}"
      --var "POLICY_AUD:${{ secrets.ACCESS_POLICY_AUD }}"
```

- **リポジトリの `wrangler.jsonc` 既定は `"0"`・プレースホルダのまま**（要件 5.6）。実値は secrets 経由のオーバーライドでのみ注入する。
- CI 経由でも切替前にデプロイ前検査 CLI（`pnpm access-preflight`・実値を env で与える）を通す関門を挟むこと（要件 5.3／5.5）。
- この CI 経路も移行期の手段であり、恒久対処は既定反転（タスク 9.4・§6）である。

---

## スコープ境界（触らないもの・要件 10）

- 休眠機構（`verifyAccessIdentity` / `canonicalIdentity` / `IDENTITY_HEADER` 除去・付与 / `resolveEntryDestination` / 店舗 DO の `isRostered`・`effectiveRoster`）を**再実装しない**。本手順は env 値の切替のみ（要件 10.1）。
- **`wrangler.jsonc` を編集しない**（`ACCESS_REQUIRED="0"`・プレースホルダを保つ・要件 5.6）。実値と ON はデプロイ時オーバーライドで注入する。
- Whereami_IdP の内部実装・split-horizon の内部配線に触れない（要件 10.2）。
- `ADMIN_TOKEN`（Provisioning_API・`/admin/*`）は Access と独立した別系統。認可ロジックを変更しない（要件 10.3／10.6）。
- セッションの継続・失効は Cloudflare Access に委ねる。アプリ側にセッションストア・失効ロジックを新設しない（要件 10.4・失効運用はタスク 9.3）。
- 本番の Access_Application へ OTP_Login を追加しない（要件 10.7）。本番 Whereami_IdP の対応表・コードへテストデータ・分岐を入れない（要件 10.8）。

---

## 参照

- 要件: `requirements.md` Requirement 5.6（移行期はデプロイ時オーバーライドで投入し `wrangler.jsonc` 既定 `"0"` を保つ）、5.1／5.2／5.3（実値投入とプレースホルダ残存時の ON 阻止）、5.5（型再生成失敗時の ON 阻止）、5.7（既定反転の終着点）、1.1／1.2／1.5（本番切替の前提条件）、1.3／1.6／1.7（可逆な切戻し）、1.4（OFF 期の休眠挙動）、1.9（実店舗最終疎通 1 回）
- 設計: `design.md` 節「B. Deployment_Config」（vars の値モデル・オーバーライド方式・既定反転）、節「D-2 段階的切替・可逆手順」step 3（本番 ON）・step 5（切戻し）、状態機械「段階的ロールアウト」
- コード: `tools/check-access-enablement.ts`（デプロイ前検査 CLI・`pnpm access-preflight`・タスク 3.1）、`src/access-enablement.ts`（純粋述語 `enablementReadiness`・タスク 2.1）、`wrangler.jsonc`（vars 既定・タスク 6.1）、`package.json`（scripts）、`.github/workflows/ci-cd.yml`（CI/CD デプロイ）
- 兄弟文書: `production-cutover-preconditions.md`（タスク 8.1・前提条件 (a)〜(d)・本手順の直前の関門）
- 後続タスク: 8.3（実店舗最終疎通・1 回）、8.4（切替完了条件）、9.1（外形監視）、9.2（切戻しランブック）、9.4（既定反転＝恒久対処）
