# 切戻し（可逆性）ランブック — ACCESS_REQUIRED を "0" へ戻す（cloudflare-access-enablement）

> 対象 spec: `cloudflare-access-enablement` / タスク 9.2「切戻し（可逆性）手順を整備する」
> 種別: ［手続き］（コードで自動検証できない運用手続きタスク。実際の切戻しは運用者が本ランブックに従い実施する。アプリコード・`wrangler.jsonc` を変更しない・要件 10.1）
> 正本: `requirements.md` 要件 1.3（検出から 5 分以内に OFF へ）・1.6（戻し完了から 1 分以内に合鍵接続を確認）・1.7（局所認可失敗を全体 OFF の根拠としない）、`design.md` 節「D-2 段階的切替・可逆手順」step 5（切戻し）・節「Error Handling C」
> 検知入力の出所: `docs/access-enablement/synthetic-monitor-runbook.md`（タスク 9.1・外形監視）／`production-cutover-completion-check.md`（タスク 8.4・完了条件の逸脱）

---

## 0. この文書の位置づけ（読む前に）

本ランブックは、本番の `ACCESS_REQUIRED` を `"1"`（ON）から `"0"`（OFF）へ**戻す一手**を、検知から確認までの時間規律とともに与える。切替は **env の投入のみ**で成立し、**アプリコードは一切変更しない**（`ACCESS_REQUIRED` の 3 分岐＝WS の JWT 検証・店舗 DO の Roster 判定・Entry `/` の逆引きは、いずれも実行時に `env.ACCESS_REQUIRED` を読む休眠経路であり、env 値の切替だけで OFF 期の休眠挙動へ戻る・要件 1.4）。

切戻しは可逆性の担保そのものである。ON は「経路の目覚め」であり OFF は「経路の再休眠」にすぎない。ゆえに戻しはコード差分ゼロ・deploy override のみで完結し、戻した瞬間に OFF 期の現行運用（合鍵 URL 接続）へ復する。

本ランブックが統べるのは三点に尽きる。

| 記号 | 事項 | 正本 |
| --- | --- | --- |
| **(R1)** | **系統性障害**の検知入力を受けたら、**検出から 5 分以内**に `ACCESS_REQUIRED` を `"0"` へ戻す（env のみ・可逆） | 要件 1.3 |
| **(R2)** | 戻し完了から **1 分以内**に、合鍵 URL による店舗接続が **JWT 検証を経ずに成立する**ことを確認する | 要件 1.6 |
| **(R3)** | **個別 identity／店舗の認可失敗**は全体 OFF の根拠と**せず**、Provisioning_API 経由の Roster 修正で対処する（局所の登録ミスを全体 OFF の根拠にしない） | 要件 1.7 |

- 本書の成果物は本ランブック（markdown）のみである。実際の切戻し・確認は運用者が本手順に従い実施する。

---

## 1. 切戻しの判断 — 何を「系統性障害」とみなすか（要件 1.3）

切戻し（R1）を発動するのは、**系統性障害**を検知したときに限る。系統性障害の検知入力は次の二つであり、いずれも外形監視（タスク 9.1・`synthetic-monitor-runbook.md`）が継続的に見張っている。

| 検知入力 | 観測手段 | 異常の内容 | 正本 |
| --- | --- | --- | --- |
| **(a) whereami 経路のパッシブ指標が正常域を外れる** | Workers Logs（`observability.enabled=true`・有効化済み）の閾値観測。合成試行なし | `/s/*/ws` の **403 レート急騰**、または **WebSocket アップグレード成功数の崩落**が正常域を外れる | 要件 8.2・1.3(a) |
| **(b) 未認証直叩きが 403 で拒否される作動が崩れる** | R8.7 能動プローブ（未認証直叩き＝403 の周期確認・IdP 非依存・外部実行可・既定 5 分周期） | プローブが **403 以外**を検出（特に**認証を経ない接続成立**＝「静かな認証 OFF」への退行） | 要件 8.7・1.3(b) |

### 判断の分岐（系統性か、局所か）

- **(a) の 403 レート急騰**が全店・広範に及ぶなら**系統性障害**の候補である。認証境界が正当な接続まで巻き込んで拒否している（例: JWT 検証設定の破綻・`TEAM_DOMAIN`／`POLICY_AUD` の不整合・Access 側構成の事故）疑いがあり、R1（全体 OFF）の対象になりうる。
- **(a) の 403 レート急騰が特定の identity／特定店舗に限局**するなら、それは**局所の認可失敗**であって系統性障害ではない。→ §4（R3）へ回す。全体 OFF にしない。
- **(b) の 403 以外検出（認証を経ない接続成立）**は、認証が黙って OFF に退行した疑い（静かな認証 OFF）であり、認証境界の存在意義に関わる**系統性障害**である。→ 原因究明と並行して R1 を発動しうる。
- **WebSocket アップグレード成功数の崩落**（(a)）は、正当な接続が全体として成立しなくなった兆候であり、系統性障害の候補である。→ R1 の対象になりうる。

> **迷ったときの原則（安全側）**: 「広範・全店に及ぶ／認証境界そのものの破綻」なら R1（全体 OFF）。「特定 identity・特定店舗に限局する認可の成否」なら R3（Roster 修正）。切戻しは可逆ゆえ、系統性の疑いが濃いときは戻すことをためらわない。ただし局所の登録ミスを全体 OFF の口実にしない（要件 1.7・§4）。

---

## 2. 切戻しの実行 — 検出から 5 分以内に OFF へ（R1・要件 1.3）

系統性障害と判断したら、**検出から 5 分以内**に `ACCESS_REQUIRED` を `"0"` へ戻す。戻しは `wrangler deploy` のデプロイ時オーバーライドで行い、**`wrangler.jsonc` を編集しない**（リポジトリ既定は `"0"`・プレースホルダのまま・要件 5.6／10.1）。

### 2-1. 検出時刻を記録する（5 分窓の起点）

- [ ] 検知入力（(a) Workers Logs 指標の逸脱／(b) R8.7 プローブの 403 以外検出）を受けた**検出時刻**を記録する。この時刻が 5 分窓の起点である（要件 1.3）。

### 2-2. assets ビルド（デプロイ前に必須）

`assets` バインディング（`dist`）が要るため、デプロイ前に本番ビルドする（`build = tsc --noEmit && vite build`）。

```sh
pnpm build
```

### 2-3. ACCESS_REQUIRED を "0" にしてデプロイする

`ACCESS_REQUIRED` だけを `"0"` にオーバーライドして戻す。`TEAM_DOMAIN`／`POLICY_AUD` は投入したままでよい（OFF 経路では読まれないため、戻す必要はない）。`--var` で指定した key のみが上書きされ、他の vars は `wrangler.jsonc` の既定を引き継ぐ。

```sh
pnpm wrangler deploy --var "ACCESS_REQUIRED:0"
```

- [ ] `wrangler deploy` がゼロ終了し、新バージョンが公開されたこと（`pnpm wrangler deployments status` で現行バージョンを確認）。
- [ ] この戻しが**検出時刻から 5 分以内**に完了したこと（要件 1.3）。

> **なぜ `--var` か（`wrangler.jsonc` を編集しない・要件 5.6／10.1）**: 戻しはデプロイの瞬間に env 値を注入するだけであり、リポジトリの正本（`wrangler.jsonc`）は `ACCESS_REQUIRED="0"`・プレースホルダを保つ。コード差分ゼロ・env のみの可逆な切戻しを成立させる。

> **CI/CD 経由で戻す場合（任意）**: GitHub Actions（`.github/workflows/ci-cd.yml`・`cloudflare/wrangler-action@v3`・`command: deploy`）経由なら、`command` を `deploy --var "ACCESS_REQUIRED:0"` にして実行する。ただし系統性障害への即時対応では、5 分窓を守れる最短経路（運用者の手元での `wrangler deploy`）を優先する。

---

## 3. 戻し後の確認 — 1 分以内に合鍵接続の成立を確認（R2・要件 1.6）

戻し完了（§2-3 のデプロイ成立）から **1 分以内**に、OFF 期の現行運用（合鍵 URL 接続）が **JWT 検証を経ずに**成立することを確認する。これは「可逆性が実際に効いた」ことの外形確認である。

判定点は `src/worker.ts`：`ACCESS_REQUIRED==="0"` のとき Worker は JWT 検証・identity 引き渡しを**行わず**、利用者は合鍵 URL（推測困難な Store_Path 直叩き）で接続できる（既存の休眠挙動・要件 1.4）。なお `IDENTITY_HEADER` の無条件除去は OFF でも作動する（偽装防御は ON／OFF 共通・要件 7.2）。

- [ ] 戻し完了から **1 分以内**に、合鍵 URL（`/s/{storeId}/` および `/s/{storeId}/ws`）による店舗接続が成立すること（要件 1.6）。
- [ ] 当該接続が **JWT 検証を経ずに**成立していること（`Cf-Access-Jwt-Assertion` を伴わなくても WS が確立する＝OFF 期の休眠挙動へ復帰）。
- [ ] タイマー機能（開始・キャンセル・完了・調整・再接続 hydration）が OFF 期どおりに観測できること（認証境界の再休眠が機能挙動に影響しないこと）。
- [ ] （参照・任意）Workers Logs で、戻し後の `/s/*/ws` が 403 急騰・アップグレード成功数の崩落から**正常域へ復した**ことを確認する（外形監視・タスク 9.1）。

> **確認できないとき**: 戻し後 1 分以内に合鍵接続が成立しないなら、それは OFF への戻しが効いていない（デプロイ未反映・別バージョンが公開中など）疑いである。現行バージョンを確認し（`pnpm wrangler deployments status`）、戻しデプロイが公開されているかを検める。

---

## 4. 局所の認可失敗は全体 OFF の根拠としない（R3・要件 1.7）

**個別 identity または個別店舗**の認可失敗——すなわち (i) 正当でない identity の拒否（想定どおりの拒否）、または (ii) Roster 登録漏れによる**正当 identity の拒否**——が確認されたとき、これを**全体ロールバック（`ACCESS_REQUIRED="0"` への切戻し）の対象とせず**、Provisioning_API 経由の Roster 修正で対処する（要件 1.7）。局所の登録ミスを全体 OFF の根拠にしない。

### 4-1. 局所か系統性かの切り分け

- [ ] 拒否（403）が**特定の identity／特定店舗に限局**しているか（他店・他 identity は正常に接続できているか）を確認する。限局していれば**局所の認可失敗**であり、R3 で対処する（全体 OFF にしない）。
- [ ] 逆に、拒否が**広範・全店に及ぶ**なら §1 の系統性障害判断へ戻し、R1（全体 OFF・§2）の対象とする。

### 4-2. 局所の認可失敗の対処（Roster 修正・全体 OFF にしない）

- [ ] **(ii) 正当 identity の Roster 登録漏れ**なら、Provisioning_API（`/admin/*`・`ADMIN_TOKEN` の別系統認可）経由で当該 identity を該当 Roster（店舗 Roster またはチェーン Roster）へ登録する。登録値と Access が JWT に載せる email クレームの双方に同一 `normalize`（trim・小文字化）を適用し、正準形を完全一致させる（要件 6.1／6.2／6.3・`identity-roster-registration.md`）。
- [ ] Roster 修正は**次回再接続時に反映**される（名簿改定は次接続から反映され、現接続は維持される・要件 9.2）。厨房 WS の再接続頻度により実効窓は小さい。
- [ ] **(i) 正当でない identity の拒否**は、認証境界が正しく作動している証左であり、対処不要（Roster に登録しない）。
- [ ] いずれの局所対処でも `ACCESS_REQUIRED` は `"1"`（ON）のまま維持する（全体 OFF にしない・要件 1.7）。

> **区別の要点**: 完了条件 (a)(b)(c) の逸脱（`production-cutover-completion-check.md`）や whereami 経路の広範な 403 急騰は**系統性障害**の候補で R1 の対象になりうる。対して**特定 identity／店舗に限局した認可の成否**は R3 の対象であり、Roster 修正で閉じる。両者を混同しない。

---

## 5. 切戻し後の記録と後続

切戻し（R1）を実施したら、事後の追跡のために次を運用記録に残す（アプリ内に永続キーを新設しない・運用側の記録媒体に残す・要件 10.4 と同じ方針）。

- [ ] 検知入力（(a) Workers Logs 指標の逸脱／(b) R8.7 プローブの 403 以外検出）と**検出時刻**
- [ ] 系統性障害と判断した根拠（広範性・認証境界破綻の別）
- [ ] 戻し実施時刻（検出から 5 分以内であること・要件 1.3）と、戻しデプロイのバージョン
- [ ] 戻し後の合鍵接続成立確認（戻し完了から 1 分以内であること・要件 1.6）
- [ ] 根本原因の究明状況と、再度の ON（再切替）に向けた是正事項

> **再度の ON（再切替）に向けて**: 戻したのちの再切替は、原因を是正した上で本番切替の関門（`production-cutover-preconditions.md`＝タスク 8.1 の前提条件 (a)〜(d)）を改めて通し、`production-cutover-procedure.md`（タスク 8.2）に従って再度 ON にする。デプロイ前検査 CLI（`pnpm access-preflight`）を必ず通す（要件 5.3／5.5）。移行期の終着点は既定反転（タスク 9.4・要件 5.7）である。

---

## スコープ境界（触らないもの・要件 10）

- 休眠機構（`verifyAccessIdentity` / `canonicalIdentity` / `IDENTITY_HEADER` 除去・付与 / `resolveEntryDestination` / 店舗 DO の `isRostered`・`effectiveRoster`）を**再実装しない**。切戻しは env 値の切替のみ（要件 10.1）。
- **`wrangler.jsonc` を編集しない**（`ACCESS_REQUIRED="0"`・プレースホルダを保つ・要件 5.6）。戻しはデプロイ時オーバーライドで注入する。
- Whereami_IdP の内部実装・split-horizon の内部配線に触れない（要件 10.2）。
- `ADMIN_TOKEN`（Provisioning_API・`/admin/*`）は Access と独立した別系統。R3 の Roster 修正は既存 Provisioning_API を用い、認可ロジックを変更しない（要件 10.3／10.6）。
- セッションの継続・失効は Cloudflare Access に委ねる。アプリ側にセッションストア・失効ロジックを新設しない（要件 10.4・失効運用はタスク 9.3）。
- 本番の Access_Application へ OTP_Login を追加しない（要件 10.7）。本番 Whereami_IdP の対応表・コードへテストデータ・分岐を入れない（要件 10.8）。

---

## 参照

- 要件: `requirements.md` Requirement 1.3（系統性障害の検知入力を受けたら検出から 5 分以内に `ACCESS_REQUIRED="0"` へ・env のみで可逆）、1.6（戻し完了から 1 分以内に合鍵 URL 接続が JWT 検証を経ず成立することを確認）、1.7（局所の認可失敗を全体 OFF の根拠とせず Provisioning_API 経由の Roster 修正で対処）、1.4（OFF 期の休眠挙動）、8.2（whereami 経路のパッシブ指標）、8.7（R8.7 能動プローブ）、5.6（デプロイ時オーバーライド・`wrangler.jsonc` 既定 `"0"`）、6.1／6.2／6.3（Roster 整合登録・正準形一致）、9.2（Roster 改定は次接続から反映）
- 設計: `design.md` 節「D-2 段階的切替・可逆手順」step 5（切戻し）、節「Error Handling C」（系統性障害の切戻し・回帰ありの通知）、状態機械「段階的ロールアウト」（ON→OFF の可逆遷移）、節「Architecture」OFF 期フロー（合鍵 URL 接続）
- コード（参照のみ・変更しない）: `src/worker.ts`（`ACCESS_REQUIRED` 分岐・`verifyAccessIdentity` / `canonicalIdentity` / `IDENTITY_HEADER` 除去・付与）、`src/shell/store-timer-do.ts`（`isRostered` / `effectiveRoster` の Roster ゲート）、`wrangler.jsonc`（vars 既定 `"0"`）、`.github/workflows/ci-cd.yml`（CI/CD デプロイ）
- 兄弟文書: `synthetic-monitor-runbook.md`（タスク 9.1・検知入力の出所＝Workers Logs パッシブ指標＋ R8.7 能動プローブ）、`production-cutover-procedure.md`（タスク 8.2・本番 ON・§5 で切戻しの一手を提示・本書がその詳細）、`production-cutover-completion-check.md`（タスク 8.4・完了条件の逸脱＝回帰ありの検知入力）、`production-cutover-preconditions.md`（タスク 8.1・再切替時の前提条件）、`identity-roster-registration.md`（タスク 7.6・R3 の Roster 修正手順）
- 後続タスク: 9.3（失効運用ランブック）、9.4（既定反転＝移行期の終着点）
