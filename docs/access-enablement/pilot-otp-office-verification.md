# アプリ側経路 オフィス完結検証手順・チェックリスト（Pilot + OTP_Login）

> 対象 spec: `cloudflare-access-enablement` / タスク 7.4「アプリ側経路を Pilot + OTP_Login でオフィス完結検証する」
> 種別: ［手続き］（コードで自動検証できない Integration/手続きタスク。実際の検証は運用者・開発者が本手順に従い実施する。アプリコードは変更しない・要件10.1）
> 正本: `requirements.md` 要件1.1 / 1.8 / 3.3 / 6.4 / 6.5 / 7.1 / 7.4、`design.md`「D-2 段階的切替・可逆手順（step 1 アプリ側経路）」「Cloudflare Access 前提 7」

---

## 0. この手順の位置づけ（必読）

本手順は、本番切替（タスク 8）に先立ち、**アプリ側経路**——JWT 検証 → Roster 照合 → Entry 逆引き → WS 確立——が本番構成で正しく作動することを、**実店舗へ赴かずオフィス完結**で検証するための手順・チェックリストである。

検証が成り立つ根拠は一点に尽きる。**Worker は単一アプリ・単一 issuer/aud であり「どの IdP 経由で JWT が生まれたか」を観測しない**（`design.md` Cloudflare Access 前提 3・7）。ゆえに、Pilot_Access_Application に許可した **OTP_Login**（Cloudflare Access 標準の One-Time PIN）で発行された JWT でも、EntraID / whereami 経由の JWT と同一形（issuer=`TEAM_DOMAIN`・audience=Pilot 固有 aud）で流れ、アプリ側経路の検証には十分である。店舗にも whereami にも依存しない。

### 検証対象は「Pilot 検証デプロイ」（本番とは別）

- 検証対象は、**タスク 7.1 が用意した Pilot 検証用デプロイ**である（`docs/access-enablement/access-application-config-checklist.md` §3）。
  - Pilot_Access_Application の aud を `POLICY_AUD` に持ち、`ACCESS_REQUIRED="1"`・実 `TEAM_DOMAIN` で動く、**本番とは別のデプロイ先**。
  - OTP ログインの向き先はこの Pilot 検証デプロイ。**本番デプロイに対して本手順を実施しない**。
- **本番構成へ OTP・テストデータ・分岐を持ち込まない**（要件10.7）。OTP_Login は Pilot 限定であり、テスト店舗・テスト用チェーン・開発者 email の Roster 登録はすべて **Pilot 検証環境のデータ**として投入する（本番のイデア＝正本に偽物を住まわせない・環境分離）。
- **アプリコードを変更しない**（要件10.1）。休眠機構（`verifyAccessIdentity` / `canonicalIdentity` / `IDENTITY_HEADER` 除去・付与 / `resolveEntryDestination` / 店舗 DO の `isRostered`・`effectiveRoster`）は per-store-provisioning で実装・PBT 検証済みであり、本手順は**本番構成での作動確認**に限る（再実装・再検証しない）。

### スコープ外（本手順では扱わない）

- **whereami 固有部分**（合成 email 形式・Store_Id_Claim 引き継ぎ・split-horizon）→ タスク 7.5（Whereami_Dev_Stage）。
- **EntraID 固有のフェデレーション成立**（実 email で EntraID ログインが通ること）→ タスク 7.2 の観測点。
- **実店舗ネットワーク上の最終疎通**（whereami 在圏認証の実ネットワーク疎通）→ タスク 8.3（パイロット 1 号店立ち上げと兼用・1 回のみ）。

---

## 1. 前提条件

本手順を開始する前に、以下がそろっていること。

| 前提 | 内容 | 参照 |
| --- | --- | --- |
| Pilot 検証デプロイの用意 | Pilot_Access_Application の aud=`POLICY_AUD`・`ACCESS_REQUIRED="1"`・実 `TEAM_DOMAIN` で動く検証デプロイが本番とは別に存在する | タスク 7.1 §3 |
| OTP_Login の許可（Pilot のみ） | Pilot_Access_Application のログイン方式に OTP_Login（One-Time PIN）が許可されている。本番には追加していない | 要件10.7・タスク 7.1 §2-2 |
| 構成次元の一致 | Pilot と本番の構成次元（許可 IdP 集合・包含/除外経路・audience が単一値に固定されている構成）が一致している | 要件1.5・タスク 7.1 §2 |
| デプロイ前検査 CLI 通過 | `tools/check-access-enablement.ts` が Pilot 投入値（実 TEAM_DOMAIN / Pilot aud）で通過している（プレースホルダ・形式不適合でない） | タスク 3.1 |
| Provisioning_API 到達 | `/admin/*`（ADMIN_TOKEN 別系統）が Pilot 検証環境で到達可能。Roster 登録に用いる | 要件10.3 |
| 開発者 email | OTP ログインに使える開発者の受信可能な email が 1 つ以上ある | 要件1.8 |

> **正準形の一致（要件6.3）**: Roster へ登録する identity 文字列と、Access が JWT に載せる email クレームは、双方に同一の `normalize`（trim・小文字化）を適用した正準形が完全一致する必要がある。OTP ログインに使う開発者 email と Roster 登録値の正準形を一致させること（`normalize` ロジックは既存 PBT 済み・再検証しない）。

---

## 2. 検証 A — 単一店舗のアプリ側経路（JWT 検証 → Roster 照合 → Entry 逆引き → WS 確立）

**目的**: 有効な JWT を伴う正当な identity が、テスト店舗へ Entry 逆引き経由で到達し WS を確立できること（要件3.3 / 6.4・アプリ側経路の正常系）。

### 2-1. テスト店舗の用意と開発者 email の Roster 登録（Pilot データ）

- [ ] Pilot 検証環境に**テスト店舗**を 1 つ用意する（Provisioning_API `POST /admin/stores`。既存のテスト店舗を流用可）。`storeId`（スラッグ）を控える
- [ ] 開発者 email を、当該テスト店舗の**店舗 Roster** へ登録する（Provisioning_API `PUT /admin/stores/{storeId}`・要件6.1）
  - 登録値は `normalize`（trim・小文字化）後の正準形で、OTP ログインに使う email の正準形と完全一致させる（要件6.3）
- [ ] この登録がすべて **Pilot 検証環境のデータ**であること（本番 Roster に開発者 email・テスト店舗を投入していない）を確認する（要件10.7）

### 2-2. OTP ログイン → Entry 逆引き → WS 確立の観測

- [ ] Pilot 検証デプロイの Entry `/` にブラウザでアクセスし、**OTP_Login** を選び、開発者 email に届いた One-Time PIN で認証を通過する
- [ ] 認証後、Access が発行するアプリ JWT の `iss`=`TEAM_DOMAIN`・`aud`=Pilot 固有 aud・`email`=開発者 email（欠落・空文字なし）であることを確認する（`CF_Authorization` Cookie / `Cf-Access-Jwt-Assertion` をデコードして目視。署名検証は Access が担う）
- [ ] Entry `/` で Worker が検証済み email により逆引きし、**1 店舗に解決 → その店舗 `/s/{storeId}/` へリダイレクト**すること（`resolveEntryDestination` の 1 店舗解決・要件3.3 / per-store-provisioning 要件7.3）
- [ ] リダイレクト先の店舗画面から `/s/{storeId}/ws` への **WS 接続が確立**すること（Worker の JWT 検証成功 → 検証済み identity 付与 → 店舗 DO の `isRostered` が実効 Roster に一致 → 接続確立・要件6.4）
- [ ] 接続後、タイマー機能（開始・キャンセル・完了・調整・再接続 hydration）が認証無効時と同一に観測できること（回帰なしの目視確認。厳密な回帰判定はタスク 8.4）

> **アプリ側経路の作動点（すべて実装済み・休眠中）**: `verifyAccessIdentity`（署名/issuer/audience/期限）→ `canonicalIdentity`（email 優先）→ `resolveEntryDestination`（Entry 逆引き）→ `isRostered` / `effectiveRoster`（店舗 DO の Roster 照合）。本手順はこれらの**本番構成での作動を確認する**のみ（要件10.1）。

---

## 3. 検証 B — バイパス防御の作動（有効な JWT を伴わない直叩きの 403）

**目的**: 有効な `Cf-Access-Jwt-Assertion` を伴わない `/s/{storeId}/ws` 直叩きが **HTTP 403 で拒否され店舗 DO に到達しない**こと（要件7.1 / 7.4）。バイパス防御が本番構成で作動することを確認する。

- [ ] **JWT 欠如**: 認証情報（Cookie / JWT ヘッダ）を伴わずに `/s/{storeId}/ws` を直叩きすると、Worker が WebSocket アップグレードを行わず**店舗 DO を呼び出さずに HTTP 403** を返すこと（要件7.1）
  - Access の前段があるため通常はログイン誘導されるが、Access を経由しない外部からの直リクエスト（例: `curl` / 別クライアントでの WS アップグレード試行）で 403 が返り DO に到達しないことを確認する
- [ ] **検証失敗**: 署名・issuer・audience・期限のいずれかが不正な JWT（例: 別 aud・期限切れ）を載せた `/s/{storeId}/ws` 接続要求が、同様に **403・DO 未到達**であること（要件7.1）
- [ ] **店舗状態不変**: 上記いずれの拒否でも、対象テスト店舗の DO 状態が一切変更されていないこと（拒否は書き込みゼロ・要件6.5 / 7.4(a)）
- [ ] **Roster 非一致の拒否**: テスト店舗 Roster に**登録していない**別の正当 JWT identity で `/s/{storeId}/ws` に接続すると、店舗 DO が `isRostered` false により **403・店舗状態不変**を返すこと（要件6.5）

> 本手順の (a) 直叩き 403・DO 未到達は、本番切替の完了条件（要件7.4(a)）と R8.7 の能動プローブ（未認証直叩き＝403 の周期確認・タスク 9.1）の作動を、切替前に Pilot で先行確認するものである。クライアント偽装ヘッダ `X-Yudemen-Identity` の除去（要件7.2 / 7.4(b)）は作動確認テスト（タスク 5.2）と本番完了条件（タスク 8.4）で担保する。

---

## 4. 検証 C — 複数テスト店舗の切替（チェーン Roster + Entry 複数店舗解決）

**目的**: 複数のテスト店舗を切り替えてアプリ側経路を検証するとき、**店舗選択機構を新設せず**、既存の Entry 逆引き・チェーン Roster・切替リストで足りることを確認する（要件1.8 / 7.4・per-store-provisioning 要件7.4 の SV フロー）。

### 4-1. テスト用チェーンと複数テスト店舗の用意（Pilot データ）

- [ ] Pilot 検証環境に**テスト用チェーン**を 1 つ用意し、複数のテスト店舗（2 店舗以上）を当該チェーンに所属させる（Provisioning_API）
- [ ] 開発者 email を、テスト用チェーンの**チェーン Roster** へ登録する（当該チェーンの全店舗へ有効・要件6.1・`effectiveRoster` はチェーン Roster ∪ 店舗 Roster）
  - これにより開発者 email は複数のテスト店舗すべての実効 Roster に含まれる
- [ ] すべて Pilot 検証環境のデータであること（本番へテスト用チェーン・テストデータを投入していない）を確認する（要件10.7）

### 4-2. Entry 複数店舗解決 → 切替リスト → 店舗選択の観測

- [ ] OTP ログイン後、Entry `/` で Worker が逆引きし、**複数店舗に解決 → 既定店（登録順の先頭）へリダイレクト**すること（`resolveEntryDestination` の複数店舗解決・per-store-provisioning 要件7.4 の SV フロー＝既定店へ解決し切替リストを渡す）
- [ ] SPA が `GET /entry/stores` を取得し、開発者 email の接続可能店舗が `(storeId, name)[]` の**切替リスト**として返ること（Access ON のときのみ供される経路・要件7.4）
  - 表示は `name` を用いる（`storeId` はスラッグゆえ）
- [ ] 切替リストから**別のテスト店舗を選択**すると、当該店舗の `/s/{storeId}/ws` へ WS 接続が確立すること（切替先店舗の実効 Roster にチェーン Roster 経由で一致・要件6.4）
- [ ] whereami・Access 側に**店舗選択機構を新設していない**こと（切替は既存の Entry 逆引き・チェーン Roster・`GET /entry/stores` 切替リストで完結・要件1.8）

---

## 5. 完了条件（本タスクのゴール・要件1.1 のオフィス完結分）

以下をすべて満たしたとき、本手順（アプリ側経路のオフィス完結検証）は完了とする。これは本番切替の前提条件（タスク 8.1）の一部を構成する。

- [ ] **検証 A**: OTP ログイン → Entry 逆引き（1 店舗解決）→ WS 確立 が成功した（要件3.3 / 6.4）
- [ ] **検証 B**: 有効な JWT を伴わない直叩きが 403・DO 未到達で拒否され、Roster 非一致も 403・店舗状態不変で拒否された（バイパス防御作動・要件6.5 / 7.1 / 7.4(a)）
- [ ] **検証 C**: チェーン Roster + Entry 複数店舗解決 + `GET /entry/stores` 切替リストで、複数テスト店舗の切替が店舗選択機構の新設なしに成立した（要件1.8 / 7.4）
- [ ] すべて **Pilot 検証デプロイ**（本番とは別）に対して実施し、**本番構成へ OTP・テストデータ・分岐を持ち込んでいない**（要件10.7）
- [ ] **アプリコードに変更を加えていない**（要件10.1 の差分制限）。本手順の成果物は本検証手順書（markdown）のみ

> 要件1.1 が課す「各 IdP 経路につき最低 1 回の認証成功」のうち、**アプリ側経路の成立**は本手順（Pilot + OTP_Login）が担い、**IdP 固有の成立**は EntraID=タスク 7.2 の観測点・whereami=タスク 7.5（Whereami_Dev_Stage）が担う。実店舗ネットワーク上の最終疎通はタスク 8.3（パイロット 1 号店立ち上げと兼用・1 回のみ）。

---

## 6. スコープ境界（触らないもの・要件10）

- 休眠機構（`verifyAccessIdentity` / `canonicalIdentity` / `IDENTITY_HEADER` 除去・付与 / `resolveEntryDestination` / 店舗 DO の `isRostered`・`effectiveRoster`）を**再実装しない**。本手順は本番構成での作動確認に限る（要件10.1）。
- Whereami_IdP の内部実装・split-horizon の内部配線に触れない。whereami 固有部分の事前検証はタスク 7.5（要件10.2）。
- `ADMIN_TOKEN`（Provisioning_API・`/admin/*`）は Access と独立した別系統。Roster 登録に用いるが認可ロジックは変更しない（要件10.3 / 10.6）。
- セッションの継続・失効は Cloudflare Access に委ねる。アプリ側にセッションストア・失効ロジックを新設しない（要件10.4・失効運用はタスク 9.3）。
- 本番の Access_Application へ OTP_Login を追加しない。OTP_Login は Pilot 限定（要件10.7）。
- 本番 Whereami_IdP の対応表・コードへテストデータ・分岐を入れない（要件10.8・タスク 7.5）。

---

## 参照

- 要件: `requirements.md` Requirement 1.1・1.8（オフィス完結検証・環境分離）、3.3（Entry 逆引き）、6.4・6.5（Roster 照合の成立/拒否）、7.1・7.4（バイパス防御・完了条件）、10.1・10.7（差分制限・OTP を本番に持ち込まない）
- 設計: `design.md` 節「D-2 段階的切替・可逆手順」（step 1 アプリ側経路）、節「Cloudflare Access 前提 7」（環境分離で二分・アプリ側経路は OTP でオフィス完結）
- 兄弟文書: `docs/access-enablement/access-application-config-checklist.md`（タスク 7.1・Pilot 検証デプロイの用意）、`entraid-federation-procedure.md`（7.2）、`whereami-generic-oidc-procedure.md`（7.3）
- 後続タスク: 7.5（whereami 固有部分の Whereami_Dev_Stage 検証）、7.6（identity ↔ Roster 整合登録）、8.1（本番切替の前提条件充足）、8.3（実店舗最終疎通・1 回）、8.4（本番切替の完了条件）
