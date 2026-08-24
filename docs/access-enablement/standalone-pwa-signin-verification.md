# インストール済み PWA（standalone）での認証往復 実機検証記録（V-4）

> 対象 spec: `signin-required-misreported-as-offline` / タスク 7「V-4: 実機で認証往復を検証する」
> 種別: ［手続き＋記録］（自動化できない受入条件。実施は運用者・開発者が実機で行う）
> 正本: `design.md`「R-1. インストール済み PWA（standalone）での認証往復」「R-2」「ロールアウト手順（RO-1）」／`requirements.md` 要件 4（AC 4.5 / 4.6）
> 関連手順: `revocation-runbook.md` 第 1 章（Access セッションの失効）
>
> **本書の状態: 未実施。** 第 3 章・第 4 章・第 5 章の結果欄は**すべて空欄**である。実施者が実機で観測した事実だけを記入する。**推測を結果欄に埋めない。**
> 本書は運用記録であり、アプリコードの変更を伴わない。

---

## 0. 前提と原則

### なぜ自動化できないのか

本検証が確かめるのは、**iPadOS の standalone PWA が Cloudflare Access のログイン往復を通せるか**である。往復に関与するのは Access_Application・EntraID・iPadOS のアプリ内ブラウザのオーバーレイ・PWA の Cookie ストレージであり、いずれもテストランナーの中に置けない。ゆえに手順と結果を記録する形で受入とする。

### なぜ任意テストにしないのか

ここを飛ばすと **AC 4.5（Sign_In_Affordance が認証へのトップレベル遷移を起こす）と AC 4.6（認証後に当該店舗の画面へ戻り再接続する）の成立が未確認のまま残る**。design R-1 は本検証を分岐点として置いており、結果によっては requirements の修正へ戻る（第 5 章）。未確認のまま先へ進めば、実装が成立しない前提の上に建つ。

### 三つの条件（すべて満たすこと）

| 条件 | 内容 |
| --- | --- |
| **インストール済み PWA** | ホーム画面に追加済みのアイコンから **standalone で起動**した状態。Safari のタブではない |
| **実 iPad** | 実機。シミュレータ・Mac の Safari・レスポンシブデザインモードのいずれでもない |
| **実 Access 構成** | `timer-dev.yamaokaya.org`（Access_Application がホスト全体を保護し、`ACCESS_REQUIRED="1"`） |

### Safari タブでの動作から standalone の動作を推定してはならない

design R-1 の禁止事項である。**iPadOS のホーム画面 Web アプリは Safari と Cookie ストレージを共有しない**（してこなかった）。ゆえに Safari タブで認証往復が成立しても、standalone で `CF_Authorization` がアプリのコンテキストに残るとは言えない。**Safari で確認して「通った」と記録することは、この検証をしていないことと同じである。**

---

## 1. 検証の準備

### 1-A. 修正のデプロイが済んでいること（前提 1）

タスク 4（分類の差し替え）・5（SW のフォールバック除外）・6（Worker の `/entry/signin/` 分岐）が `timer-dev` にデプロイ済みで、**検証用 iPad の standalone PWA で新しい Service_Worker が有効になっている**こと。

旧 SW（`/entry/` を除外していない）のままでは、`/entry/signin/` への遷移がキャッシュ済み App_Shell に飲まれ、**往復がそもそも始まらない**。それ自体が本 spec のバグであり、検証にならない。

- [ ] `main` へマージし、CI 経由でデプロイが成功している
- [ ] 検証用 iPad の standalone PWA で新 SW が有効である（確認方法は 2-C。①が「ネットワークへ出た」になること自体が新 SW の証拠を兼ねる）

### 1-B. 端末が既に詰まっていれば、まず一度手動で復旧する（前提 2）

design R-2 のとおり、**修正は自分自身を配れない**。Access セッションが切れた端末は `sw.js` の再取得が 302 でログイン HTML を受け、更新に失敗する。検証用端末が既にこの状態なら、先に一度手動で復旧して新 SW を受け取らせる。

**この復旧作業そのものが第 4 章（成果物 b）の下書きになる。** ここで実際に効いた手・効かなかった手を、その場で 4 章へ書き留める。

### 1-C. 未認証状態の再現手段 — Access セッションを失効させる

Access セッションが有効なまま `/entry/signin/{storeId}` へ遷移しても、**Worker の 302 しか試せない**。R-1 の核心（standalone でのログイン往復・Cookie の残り方）を一度も踏まないまま「通った」ように見える。

ゆえに**毎回の試行の起点を、Zero Trust ダッシュボードでの当該ユーザーの Access セッション失効（Revoke session）に置く**。これで端末は強制的に 302 へ落ちる。

**具体手順は `revocation-runbook.md` 第 1 章（1-A 対象 identity の特定／1-B セッションの失効）を参照する。** 本書に書き写さない。対象 identity は本検証で使う identity（EntraID 実 email、または whereami 合成 email `staff-{店舗コード}@yamaokaya.com`）である。

> 失効は**店舗単位の合成 email では当該店舗の全共用端末に及ぶ**（`revocation-runbook.md` 1-A の注記）。検証中に他端末を巻き込みうる点を、実施前に確認する。

### 1-D. 試行の識別（記録テンプレート・試行ごとにコピーして埋める）

```
- 実施日時      : （タイムゾーン明記）
- 実施者        : 
- 端末          : iPad 個体識別
- iPadOS バージョン : 
- 起動形態      : standalone（ホーム画面アイコン）
- ホスト        : timer-dev.yamaokaya.org
- storeId       : 
- identity      : 
- セッション失効 : [ ] 実施済み（revocation-runbook 第 1 章）
- 新 SW 有効    : [ ] 確認済み
```

---

## 2. 遷移の起こし方（standalone にアドレスバーが無い）

### 2-A. できないこと

- **URL を直接開けない。** standalone PWA にアドレスバーが無いため、`/entry/signin/{storeId}` を手で入力する手段がない。
- **Safari で開いてはならない。** Safari のコンテキストになり、第 0 章の禁止事項（standalone の動作を Safari から推定する）に触れる。

`SignInPrompt`（タスク 8）はまだ無い。ゆえに操作点から遷移を起こすこともできない。

### 2-B. 唯一の手 — Safari Web Inspector でリモートアタッチしてコンソールから遷移する

**Mac の Safari Web Inspector で standalone PWA にリモートアタッチし、コンソールで次を実行する。**

```js
location.assign("/entry/signin/yamaokaya-1263")   // storeId は検証対象の店舗に置き換える
```

これが `SignInPrompt` を書く前に standalone のコンテキストで遷移を起こす唯一の手である。タスク 8 が実装するのはこの 1 行の作用であり、ここで踏むのは同じ経路である。

### 2-C. リモートアタッチの前提設定

- [ ] **iPad 側**: 設定 → Safari → 詳細 → **Web インスペクタ**を有効にする
- [ ] **Mac 側**: Safari → 設定 → 詳細 → **Web 開発者向けの機能（開発メニューを表示）**を有効にする
- [ ] iPad を Mac に接続し、iPad 側で「このコンピュータを信頼」を許可する
- [ ] iPad の**ホーム画面アイコンから PWA を起動しておく**（起動していないとアタッチ対象に現れない）
- [ ] Mac Safari の**開発メニュー**に当該 iPad が現れ、その配下に **standalone PWA のコンテキスト**が列挙されることを確認する（Service_Worker は別項目として現れる。新 SW の確認はここで行う）

> アタッチ対象に PWA が現れない場合、上の前提のいずれかが未成立である。この時点では検証を始めない（アタッチできないことは R-1 の結果ではない）。

### 2-D. `CF_Authorization` の残存確認も同じ Inspector で見る

アタッチした standalone PWA のコンテキストで、Inspector の **Storage タブ → Cookies** を開き、`CF_Authorization` の有無を見る。これが第 3 章⑥の観測点である。

> **見る対象を取り違えない。** オーバーレイ（Access / EntraID のログイン画面）は別のコンテキストである。⑥が問うのは**アプリのオリジンのコンテキストに** `CF_Authorization` が在るかであり、オーバーレイ側に在ることは⑥の成立を意味しない。

---

## 3. 成果物 (a) — 往復の成否と停止段

連鎖の各段でどこまで進んだかを記録する。**どの段で止まったかが分かれば、「Cookie が残らない」「オーバーレイから復帰しない」「SW が殻を返した」の切り分けが一発でつく**（3-B の対応表）。

### 3-A. 9 段のチェックリスト

> **本表は未実施である。**「結果」「観測した事実」の両欄は空欄であり、実機で観測した実測のみを記入する。結果は `是` / `否` / `未到達` のいずれかで書く（前段で止まったなら以降は `未到達`）。

| # | 段 | 何を見れば分かるか（Inspector のどこを・何を） | 結果 | 観測した事実 |
| --- | --- | --- | --- | --- |
| ① | `/entry/signin/{storeId}` への遷移が**ネットワークへ出た**か（SW に飲まれなかったか） | **Network タブ**。`/entry/signin/{storeId}` のエントリが在り、Service_Worker 由来（キャッシュ応答）でないこと。エントリが無い、または `index.html` の中身が返っていれば SW に飲まれている | | |
| ② | **Access の 302** が返ったか | **Network タブ**。①の要求に対する応答が 302 で、`Location` が team domain 配下の `/cdn-cgi/access/login/timer-dev.yamaokaya.org` であること。200 で App_Shell が返るならセッションがまだ有効（1-C の失効をやり直す） | | |
| ③ | ログイン画面が **standalone のオーバーレイ**で開いたか | **画面（実機の目視）**。アプリ内にログイン画面が現れること。Safari アプリへ切り替わってしまう／何も起きない／白画面のままは否。開発メニューに新しいコンテキストが増えるかも併せて見る | | |
| ④ | **EntraID の認証**が通ったか | **画面（目視）**。EntraID のログインを完了できること。オーバーレイ内で入力・多要素認証が完了できるか。オーバーレイが入力を受け付けない・途中で閉じるは否 | | |
| ⑤ | `redirect_url` で**アプリのオリジンへ戻った**か | **Network タブ**（アタッチが維持されていれば）と**画面**。`timer-dev.yamaokaya.org/entry/signin/{storeId}` への要求が現れること。オーバーレイが閉じてアプリへ復帰すること。オーバーレイに留まるなら否 | | |
| ⑥ | `CF_Authorization` が**アプリのコンテキストに残った**か | **Storage タブ → Cookies**（アプリのオリジンのコンテキストで・2-D）。`CF_Authorization` が在ること。**オーバーレイ側に在っても⑥の成立ではない** | | |
| ⑦ | Worker の 302 で `/s/{storeId}/` へ進んだか | **Network タブ**。`/entry/signin/{storeId}` の応答が 302 で `Location: /s/{storeId}/` であること。400（Invalid storeId）なら storeId の綴りを疑う | | |
| ⑧ | **SW が殻を返して起動した**か | **Network タブ**（`/s/{storeId}/` のナビゲーションが解決すること）と**画面**（店舗画面が描画されること）。App_Shell がキャッシュから返るのは正常（要件 6.1） | | |
| ⑨ | **WS が繋がり snapshot を再取得した**か | **Network タブ → WS**（`wss://.../s/{storeId}/ws` が 101 で確立すること）と**Console**（`snapshot` 受信後にタイマー表示が復元されること）。1006 で切れ続けるなら Roster か `POLICY_AUD` の構成不備を疑う（3-C） | | |

### 3-B. 停止段から読み取れること（切り分け表）

| 停止段 | 読み取れる事実 | 次に当たる先 |
| --- | --- | --- |
| ① | **SW が殻を返した。** フォールバック除外が効いていない | 新 SW が有効か（1-A・2-C）。`vite.config.ts` の `navigateFallbackDenylist` に `/^\/entry\//` が在るか（タスク 5・V-5） |
| ② | Access セッションがまだ有効、または Access_Application の保護範囲外 | 1-C の失効をやり直す。Access_Application がホスト全体を保護しているか |
| ③ ④ ⑤ | **オーバーレイから復帰しない。** standalone のクロスオリジン往復が成立しない | **R-1 は否。** 第 5 章の分岐へ |
| ⑥ | **Cookie が残らない。** オーバーレイとアプリでストレージが分かれている | **R-1 は否。** 第 5 章の分岐へ |
| ⑦ | Worker の分岐に届いていない、または storeId が関門で弾かれた | タスク 6 の実装と storeId の綴り。400 が返っていないか |
| ⑧ | 店舗画面の起動に失敗（本 spec の範囲外の別事象） | App_Shell とアセットの配信 |
| ⑨ | 認証は通ったが**接続が拒まれる** | 3-C |

### 3-C. ⑨で止まったときに区別すべきこと（既知の限界）

⑨だけが否のとき、症状は「サインインしたのに直らない」になり、**本 spec が直した症状と区別がつかない**。切り分けの起点は次の 2 つ。いずれも本 spec のスコープ外の構成不備である。

- **`POLICY_AUD` 不一致**: ログイン URL（②の `Location`）の `kid` と、デプロイ済み Worker の `POLICY_AUD` を照合する。
- **Roster 非一致**: 当該 identity が実効 Roster（店舗 Roster ∪ チェーン Roster）に載っているか。`identity-roster-registration.md` を参照する。

---

## 4. 成果物 (b) — 詰まった standalone 端末の復旧手順

**本章がタスク 11（RO-1）手順 2 の正本である。** タスク 11 は本書のこのパスを参照する。design RO-1 の規律により、**実測で確定するまで手順を断定しない**（先に書けばロールアウト時に嘘になる）。

### 4-A. 候補と見込み

| 候補 | 内容 | 見込み（**推定であり結果ではない**） |
| --- | --- | --- |
| **A. Safari でサインインする** | Safari で `timer-dev.yamaokaya.org` を開いて認証を通し、PWA を開き直す | **効かない見込み。** iPadOS のホーム画面 Web アプリは Safari と Cookie ストレージを共有しない（してこなかった）ため、Safari 側の Access セッションは PWA 側に及ばず、キャッシュ済み SW も直らないと考えられる |
| **B. アプリを削除して入れ直す** | ホーム画面のアイコンを削除し、Safari から再度ホーム画面に追加する | 確実な手と見込まれる。ただし**これも推定である** |

> **A の「効かない見込み」は見込みとして扱う。** 断定しない。実測で否定されれば A が最も安い手になるため、B を試す前に A を試して結果を記録する。

### 4-B. 実測（未実施・実施者が埋める）

```
- 候補 A（Safari でサインイン）を試したか : [ ] 試した  結果: 
  観測した事実 : 
- 候補 B（削除して再インストール）を試したか : [ ] 試した  結果: 
  観測した事実 : 
- 他に効いた手（あれば） : 
```

### 4-C. 確定した復旧手順（未確定・4-B の実測後に記入する）

> **未確定。** 4-B の実測が済むまで、ここに手順を書かない。確定したら手順と確定日を記入し、タスク 11 はこの節を読んで端末台数ぶんの復旧を実施する。

```
確定した手順（確定日: 　　　　／確定者: 　　　　）:
1. 
2. 
```

サインインが一度通れば、`registerType: "autoUpdate"` ＋ `skipWaiting` ＋ `clientsClaim` により**新 SW は即時有効化される**（design R-2）。詰まりの原因は更新戦略ではなく認証である。

---

## 5. R-1 の判定と分岐

### 5-A. 判定（未実施）

```
R-1（standalone PWA での認証往復）の判定 : [ ] 是  [ ] 否
判定日 : 
判定者 : 
根拠（第 3 章のどの段までが是か） : 
```

### 5-B. 分岐

| 判定 | 進む先 |
| --- | --- |
| **是**（⑨まで是） | client 側へ進む（タスク 8: `SignInPrompt` と `goToSignIn`）。design のとおり Sign_In_Affordance がトップレベル遷移を起こす |
| **否**（③〜⑥のいずれかで止まる） | **requirements の AC 4.5 を「遷移を起こす」から「認証手段を現場へ示す」へ緩める修正に戻る。** `SignInPrompt` の実体は運用手順の提示（「Safari で開いてサインインしてください」等）に変わり、遷移は起こさない。`/entry/signin/` 自体が不要になる可能性がある |

**この判断はここで下す。遷移コードを書いてから引き返さない**（tasks の制約 1）。

---

## 6. 参照

| 対象 | 場所 | 役割 |
| --- | --- | --- |
| R-1 / R-2 / RO-1 | `.kiro/specs/signin-required-misreported-as-offline/design.md` | 本検証が確定させる前提と、ロールアウトの順序 |
| AC 4.5 / 4.6 | `.kiro/specs/signin-required-misreported-as-offline/requirements.md` 要件 4 | 本検証が成立可否を決める受入基準 |
| Access セッションの失効手順 | `revocation-runbook.md` 第 1 章 | 未認証状態の再現（1-C。手順は当該文書が正本） |
| identity ↔ Roster 整合登録 | `identity-roster-registration.md` | ⑨で止まったときの Roster 非一致の確認（3-C） |
| `/entry/signin/{storeId}` の分岐 | `src/worker.ts`（`SIGNIN_ENTRY_PATH`） | ⑦の 302 の実装（タスク 6・本検証では変更しない） |
| SW のフォールバック除外 | `vite.config.ts`（`navigateFallbackDenylist`） | ①がネットワークへ出る根拠（タスク 5・本検証では変更しない） |
| Access_Application の構成 | `access-application-config-checklist.md` | 保護範囲と bypass 経路の確認 |
