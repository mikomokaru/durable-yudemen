# 本番切替 完了条件チェックリスト（cloudflare-access-enablement）

> 対象 spec: `cloudflare-access-enablement` / タスク 8.4「本番切替の完了条件を検証する」
> 種別: ［手続き］（コードで自動検証できない Integration/手続きタスク。本番構成に対する外形確認である。実際の検証は運用者が本チェックリストに従い実施する。アプリコードは変更しない・要件 10.1）
> 正本: `requirements.md` 要件 7.4 / 8.4 / 8.5、`design.md` 節「Error Handling B」（7.1 / 7.2 / 7.4 の休眠経路）・節「Architecture」（VERIFY / HDR）・節「Testing Strategy」Integration 表（7.4(a) / (b)・8.4）
> 直前の関門: `docs/access-enablement/production-cutover-procedure.md`（タスク 8.2・本番 ON）／`production-cutover-preconditions.md`（タスク 8.1・前提条件 (a)〜(d)）

---

## 0. この文書の位置づけ（読む前に）

本チェックリストは、`ACCESS_REQUIRED="1"`（ON）へ切り替えた**本番構成**が、認証境界として正しく作動していることを外形から確認する**切替の完了条件**である。前提条件チェックリスト（タスク 8.1）が切替**前**の関門であるのに対し、本書は切替**後**の関門であり、実店舗最終疎通（タスク 8.3）と同じ切替波（wave 8）に属する。

本書が確認する完了条件は三つに尽きる（要件 7.4 / 8.4）。

| 記号 | 完了条件 | 正本 |
| --- | --- | --- |
| **(a)** | 有効な JWT を伴わない `/s/{storeId}/ws` 直叩きが **HTTP 403** で拒否され、**店舗 DO に到達しない** | 要件 7.4(a) |
| **(b)** | クライアントが偽装した `X-Yudemen-Identity`（`IDENTITY_HEADER`）値が**店舗 DO の受信ヘッダに現れない** | 要件 7.4(b) |
| **(c)** | タイマー機能（開始・キャンセル・完了・調整・再接続 hydration）が**認証無効時と同一の観測結果**を返す（回帰なし） | 要件 8.4 |

- いずれかが**期待どおりに作動しない**とき、本書は**回帰あり**と判定し、運用者へ通知する（要件 8.5）。回帰ありは系統性障害の候補として切戻し判断（タスク 9.2・要件 1.3）へ引き渡す。
- **バイパス防御は再実装・再検証しない**（要件 10.1）。JWT 検証 → 403（`verifyAccessIdentity`）と `IDENTITY_HEADER` の無条件除去は per-store-provisioning で実装・PBT 検証済みの休眠経路であり、本 spec の作動確認テスト（タスク 5.1 / 5.2）でも本番構成で確認済みである。本書はその**本番構成での作動を外形から最終確認する**のみ（新たな防御を足さない・引き算）。
- **アプリコードを変更しない**（要件 10.1）。本書の成果物は本チェックリスト（markdown）のみである。

### 完了条件が拠って立つ既存経路（すべて実装済み・休眠中→ ON で作動）

`design.md` 節「Architecture」の太字判定点。本書はこれらの本番構成での作動を確認する。

- **VERIFY**（`src/worker.ts` `verifyAccessIdentity`）: `ACCESS_REQUIRED==="1"` のとき `Cf-Access-Jwt-Assertion` を JWKS 署名検証（署名・issuer=`TEAM_DOMAIN`・audience=`POLICY_AUD`・期限）。ヘッダ欠如・検証失敗は **null → 403、店舗 DO を呼ばない**（要件 7.1・完了条件 (a)）。
- **HDR**（`src/worker.ts`）: クライアント由来の `IDENTITY_HEADER`（`X-Yudemen-Identity`）を、大小文字表記を問わず**転送前に無条件除去**（ON / OFF 共通・`forwarded.delete(IDENTITY_HEADER)`）。除去後、ON かつ署名検証成功時のみ検証済み identity を付け直す（この経路が唯一の付与元・完了条件 (b)）。
- **タイマー SSOT**（`src/shell/store-timer-do.ts`・`src/engine` / `src/domain`）: 認証境界は WS 確立の可否を決めるのみで、確立後のタイマー機能の観測結果に影響しない（回帰なし基準・完了条件 (c)）。

---

## 1. 前提条件

本チェックリストを開始する前に、以下がそろっていること。

| 前提 | 内容 | 参照 |
| --- | --- | --- |
| 本番 ON 済み | `ACCESS_REQUIRED="1"` がデプロイ時オーバーライドで本番に投入され、新バージョンが公開済み | タスク 8.2 |
| 前提条件 (a)〜(d) 充足 | 切替前の前提条件チェックリストがすべて成立して切替に至った | タスク 8.1 |
| 実店舗最終疎通 | パイロット 1 号店で実ネットワーク前提の whereami 在圏認証疎通が済んでいる（本書と同波・順不同でよい） | タスク 8.3・要件 1.9 |
| 認証無効時の基準 | 完了条件 (c) の比較基準として、OFF 期（`ACCESS_REQUIRED="0"`）または切替前のタイマー機能の観測結果が既知である | 要件 8.4 |
| 外部からの直リクエスト手段 | Access を経由しない外部クライアント（例: `curl` / WS クライアント）で本番 `/s/{storeId}/ws` へ直リクエストできる | 要件 7.4(a) |

> **正準形の一致（要件 6.3・参照）**: 完了条件 (a)(b) は認可の成否に依らず作動する（未認証・偽装はいずれも identity 不成立）。(c) の正常系で用いる identity は、Roster 登録値と Access が JWT に載せる email クレームの `normalize` 後の正準形が完全一致していること（`normalize` は既存 PBT 済み・再検証しない）。

---

## 2. 完了条件 (a) — 未認証直叩きが 403・店舗 DO 未到達（要件 7.4(a)）

**目的**: 有効な `Cf-Access-Jwt-Assertion` を伴わない `/s/{storeId}/ws` 直叩きが、Worker で **HTTP 403** に拒否され、**店舗 DO に一切到達しない**こと（Access バイパス防御の本番作動）。

判定点は `src/worker.ts` の VERIFY：`ACCESS_REQUIRED==="1"` のとき `verifyAccessIdentity` が null を返せば WebSocket アップグレードを行わず、店舗 DO を呼ばずに 403 を返す（`return new Response("Forbidden", { status: 403 })`）。

### 2-1. JWT 欠如の直叩き

- [ ] Access を経由しない外部リクエストで、認証情報（`CF_Authorization` Cookie / `Cf-Access-Jwt-Assertion` ヘッダ）を**伴わずに**本番 `/s/{storeId}/ws` を直叩きすると、**HTTP 403** が返ること（要件 7.1 / 7.4(a)）
- [ ] 当該直叩きで **WebSocket アップグレードが成立しない**こと（101 応答が返らない）
- [ ] 当該直叩きが**店舗 DO に到達していない**こと（対象店舗の DO 状態が一切変わらない。§2-3 で確認）

### 2-2. 検証失敗の JWT（署名・issuer・audience・期限のいずれか不正）

- [ ] 別 aud の JWT／期限切れ JWT／署名不正 JWT のいずれかを載せた `/s/{storeId}/ws` 接続要求が、同様に **403・店舗 DO 未到達**であること（`verifyAccessIdentity` の catch → null → 403・要件 7.1）
- [ ] issuer が `TEAM_DOMAIN` と一致しない JWT も同様に **403** で拒否されること

### 2-3. 店舗状態の不変（拒否は書き込みゼロ）

- [ ] §2-1・§2-2 のいずれの拒否でも、対象店舗の DO のタイマー状態（実行中スロット・`endTime`・`seq` 等）が**一切変更されていない**こと（拒否は WebSocketPair 生成・`acceptWebSocket` より前で完結・要件 6.5 / 7.4(a)）
- [ ] （参照・任意）Workers Logs（`observability.enabled=true`）で当該直叩きが 403 として記録され、DO 呼び出しに至っていないことを確認する（R8.7 能動プローブ・タスク 9.1 と同じ観測点）

> 本項 (a) は本番切替の**完了条件**であると同時に、切替後の R8.7 能動プローブ（未認証直叩き＝403 の 5 分周期確認・タスク 9.1・要件 8.7）が継続監視する対象そのものである。ここで一度 403 を確認し、以後はプローブが「認証が要求されること」を短周期で見張る。

---

## 3. 完了条件 (b) — 偽装 `X-Yudemen-Identity` が DO 受信ヘッダに現れない（要件 7.4(b)）

**目的**: クライアントが偽装して送った `X-Yudemen-Identity`（`IDENTITY_HEADER`）値が、Worker の**無条件除去**により**店舗 DO の受信ヘッダに現れない**こと（内部ヘッダ偽装によるロスター認可迂回の防御）。

判定点は `src/worker.ts` の HDR：`forwarded.delete(IDENTITY_HEADER)` を ON / OFF いずれでも実行し、除去後に ON かつ署名検証成功時のみ検証済み identity を付け直す。ゆえにクライアント由来の同名ヘッダは決して透過しない。

- [ ] 各種大小文字表記（`X-Yudemen-Identity` / `x-yudemen-identity` / `X-YUDEMEN-IDENTITY` 等）でクライアントが偽装した `IDENTITY_HEADER` を載せて `/s/{storeId}/ws` へ接続を試みたとき、店舗 DO が受信するリクエストヘッダに**当該偽装値が現れない**こと（要件 7.2 / 7.4(b)）
- [ ] ON かつ有効な JWT を伴う正当な接続では、店舗 DO が受信する `IDENTITY_HEADER` が**検証済み JWT のクレームから導出した identity**（`canonicalIdentity` の正準形）**のみ**であり、クライアントが偽装した値でないこと（付与元は Worker の署名検証成功経路が唯一・要件 7.3）
- [ ] 偽装 `IDENTITY_HEADER` を有効 JWT なしで送った直叩きは、(a) と同じく **403・DO 未到達**であること（偽装ヘッダは除去され、identity 不成立で 403・要件 7.1 / 7.2）
- [ ] 偽装 `IDENTITY_HEADER` を送った試行のいずれでも、Roster 認可を**迂回して WS が確立していない**こと（偽装値による `isRostered` 一致が成立しない・要件 6.5）

> 本項 (b) の除去は `ACCESS_REQUIRED` が `"0"` / `"1"` のいずれでも作動する（HDR は ON / OFF 共通）。本番完了条件としては ON 構成で確認するが、作動自体は切替に依存しない（タスク 5.2 の作動確認テストで両構成を確認済み・本書はその本番外形確認）。

---

## 4. 完了条件 (c) — タイマー機能の回帰なし（要件 8.4）

**目的**: 認証を有効化した本番構成（`ACCESS_REQUIRED="1"`）で、既存のタイマー機能が**認証無効時と同一の観測結果**を返すこと（認証境界は WS 確立の可否のみを決め、確立後の機能挙動に影響しない・回帰なし）。

認証境界（VERIFY / HDR / Roster ゲート）はいずれも WS 確立の**前段**にあり、確立後のタイマー SSOT（`src/engine` の状態遷移・`src/domain` の Timer 契約）には触れない。ゆえに正当な identity で WS が確立した後の観測結果は、OFF 期（合鍵 URL 接続）と同一であるべきである。

### 4-1. 各機能の観測（認証有効時）

正当な JWT で WS を確立した状態で、次を観測する（比較基準は前提の「認証無効時の観測結果」）。

- [ ] **開始**: タイマー開始が受理され、実行中スロットが `endTime`（絶対時刻）とともに全接続へ broadcast される。残り秒はクライアントのローカル計算で表示される（サーバは秒読みしない）
- [ ] **キャンセル**: 実行中タイマーのキャンセルが受理され、当該スロットが解放され broadcast される
- [ ] **完了**: `endTime` 到達で発火（drain）し、完了が観測される。Alarm の許容窓を含め OFF 期と同一に振る舞う
- [ ] **調整**: 実行中タイマーの時間調整（`endTime` の変更）が受理され、新しい `endTime` が broadcast される
- [ ] **再接続 hydration**: WS を切断→再接続したとき、現在の実行中タイマー群のスナップショットが rehydrate され、切断前と整合した状態が復元される（`reconcile` / hydration）

### 4-2. 回帰なしの判定

- [ ] 上記 5 機能すべてが、認証無効時（OFF 期または切替前）と**同一の観測結果**を返した（要件 8.4）→ **回帰なし**と判定する
- [ ] 認証有効化によって新たなエラー・遅延・状態不整合・broadcast 欠落が**生じていない**こと

---

## 5. 回帰ありの判定と通知（要件 8.5）

完了条件 (a)(b)(c) のいずれかが期待どおりに作動しないとき、本書は**回帰あり**と判定し、運用者へ通知する。

- [ ] **(a) の逸脱**: 未認証直叩きが 403 以外（特に認証を経ない接続成立）を返す、または店舗 DO に到達している → 「静かな認証 OFF」への退行の疑い。**回帰ありとして通知**（要件 7.4(a) / 8.5・R8.7 プローブの検知入力と同種）
- [ ] **(b) の逸脱**: 偽装 `IDENTITY_HEADER` が店舗 DO 受信ヘッダに現れる、または偽装値で Roster 認可を迂回して WS が確立する → **回帰ありとして通知**（要件 7.4(b) / 8.5）
- [ ] **(c) の逸脱**: タイマー機能の観測結果が認証無効時と異なる → **回帰ありとして通知**（要件 8.4 / 8.5）
- [ ] 通知先・エスカレーション経路は Synthetic_Monitor の通知経路（タスク 9.1・要件 8.3）に合わせる

> **回帰ありと切戻しの関係**: (a) の逸脱（認証が要求されないこと）は系統性障害の検知入力の一つであり、切戻し（検出から 5 分以内に `ACCESS_REQUIRED="0"` へ・タスク 9.2・要件 1.3）の対象になりうる。(b)(c) の逸脱は、原因究明の上で切戻しまたは修正デプロイを判断する。**個別 identity / 店舗の認可失敗**（正当 identity の Roster 登録漏れ等）は全体 OFF の根拠とせず、Provisioning_API 経由の Roster 修正で対処する（要件 1.7・本書の完了条件 (a)(b)(c) の逸脱とは区別する）。

---

## 6. 完了判定 — 本番切替は完了とみなせるか

以下の三つがすべて成立したときに限り、本番切替の完了条件を満たしたとみなす。ひとつでも逸脱するときは §5 に従い回帰ありとして通知し、完了とみなさない。

- [ ] **(a)** 有効な JWT を伴わない `/s/{storeId}/ws` 直叩きが **403・店舗 DO 未到達**で拒否された（要件 7.4(a)）
- [ ] **(b)** クライアント偽装の `X-Yudemen-Identity` が**店舗 DO 受信ヘッダに現れず**、Roster 認可を迂回した WS 確立が起きなかった（要件 7.4(b)）
- [ ] **(c)** タイマー機能（開始・キャンセル・完了・調整・再接続 hydration）が**認証無効時と同一観測結果**を返した（回帰なし・要件 8.4）
- [ ] すべて**本番構成**（`ACCESS_REQUIRED="1"`）に対して外形から確認し、**アプリコードに変更を加えていない**（要件 10.1）

> **次のステップ**: 完了条件を満たしたら、継続監視（タスク 9.1・外形監視）へ移り、(a) は R8.7 能動プローブ（未認証直叩き＝403 の 5 分周期）が、whereami 経路は Workers Logs パッシブ指標が、以後見張り続ける。系統性障害を検出したら検出から 5 分以内に `ACCESS_REQUIRED="0"` へ戻す（タスク 9.2・要件 1.3）。移行期の終着点は既定反転（タスク 9.4・要件 5.7）である。

---

## スコープ境界（触らないもの・要件 10）

- 休眠機構（`verifyAccessIdentity` / `canonicalIdentity` / `IDENTITY_HEADER` 除去・付与 / `resolveEntryDestination` / 店舗 DO の `isRostered`・`effectiveRoster`）を**再実装・再検証しない**。本書は本番構成での作動を外形から確認するのみ（要件 10.1）。
- Whereami_IdP の内部実装・split-horizon の内部配線に触れない（要件 10.2）。
- `ADMIN_TOKEN`（Provisioning_API・`/admin/*`）は Access と独立した別系統。認可判定は `ACCESS_REQUIRED` の切替に影響されない（要件 10.3 / 10.6）。
- セッションの継続・失効は Cloudflare Access に委ねる。アプリ側にセッションストア・失効ロジックを新設しない（要件 10.4・失効運用はタスク 9.3）。
- 本番の Access_Application へ OTP_Login を追加しない（要件 10.7）。本番 Whereami_IdP の対応表・コードへテストデータ・分岐を入れない（要件 10.8）。
- タイマー機能の観測結果（`src/engine` / `src/domain` の Timer 契約）は回帰なし基準そのものであり、本書のために改変しない（要件 8.4）。

---

## 参照

- 要件: `requirements.md` Requirement 7.4（(a) 未認証直叩き 403・DO 未到達／(b) 偽装 `IDENTITY_HEADER` が DO 受信に現れない）、7.1（JWT 検証失敗→403・DO 未到達）、7.2（`IDENTITY_HEADER` 無条件除去）、7.3（検証済み identity のみ付与）、8.4（タイマー機能が認証無効時と同一観測結果＝回帰なし）、8.5（差異は回帰ありと判定し通知）、6.5（Roster 非一致は 403・状態不変）、1.3 / 1.7（切戻し・局所認可失敗の扱い）、10.1（休眠機構を再実装しない）
- 設計: `design.md` 節「Architecture」（VERIFY / HDR / Roster ゲート）、節「Error Handling B」（7.1 / 7.2 / 6.5 / 4.2 の既存応答）、節「Error Handling C」（回帰ありの通知・切戻し）、節「Testing Strategy」Integration 表（7.4(a) / (b)・8.4）
- コード（参照のみ・変更しない）: `src/worker.ts`（`verifyAccessIdentity` / `canonicalIdentity` / `IDENTITY_HEADER` 除去・付与）、`src/shell/store-timer-do.ts`（`IDENTITY_HEADER` 定義・`isRostered` / `effectiveRoster` の Roster ゲート・タイマー SSOT）、`src/engine` / `src/domain`（Timer 契約・回帰なし基準）
- 兄弟文書: `production-cutover-preconditions.md`（タスク 8.1・切替前の関門）、`production-cutover-procedure.md`（タスク 8.2・本番 ON・§4 で本書へ引き渡し）、`pilot-otp-office-verification.md`（タスク 7.4・§3 バイパス防御を Pilot で先行確認）
- 後続タスク: 9.1（外形監視・R8.7 能動プローブが (a) を継続監視）、9.2（切戻しランブック・回帰あり時の切戻し判断）、9.4（既定反転＝移行期の終着点）
