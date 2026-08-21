# Design: 認証切れが回線喪失として表示される（signin-required-misreported-as-offline）

## Overview

修正は 3 つの薄い変更に分かれる。**分類の証拠チャネルを直す**（`probeReachability` が Access の 302 を観測できるようにする）、**認証へ戻る道を 1 本立てる**（`signInRequired` のときだけ現れる操作点と、それが向かう同一オリジンのパス）、**Service_Worker の除外を意図のあるものに揃える**。Service_Worker のキャッシュ優先は変えない（要件 6・決定 A）。

設計の骨格は既存の規律をそのまま使う。**観測（作用）と分類（純粋）を分ける**、**遷移という作用は端へ寄せる**、**判定を二箇所に置かない**。新しい機構は増えない。

---

## 前提とリスク（設計の成否がここに掛かる）

以下 2 点は**設計判断ではなく検証事項**であり、実機で確かめるまで確定しない。design の他の部分はこの 2 点の結果に依存する。

### R-1. インストール済み PWA（standalone）での認証往復（最大のリスク）

`InstallPrompt.tsx` が在り、現場の iPad はホーム画面から standalone で起動している可能性が高い。iPadOS の standalone PWA は**クロスオリジンへのトップレベル遷移**（team domain → EntraID → callback）をアプリ内ブラウザのオーバーレイで開く。Cookie ストレージがアプリのコンテキストと共有されるか、アプリのオリジンへ戻った時点でオーバーレイが閉じて復帰するかは、OS バージョンで揺れてきた領域である。

**Safari タブでの動作から standalone の動作を推定してはならない。** AC 4.5 / 4.6 の成立可否がここに掛かる。

**分岐:**

- **往復が成立する** → 本 design のとおり Sign_In_Affordance がトップレベル遷移を起こす
- **往復が壊れる**（`CF_Authorization` がアプリのコンテキストに残らない・オーバーレイから復帰しない）→ Sign_In_Affordance の実体は**運用手順の提示**になる。「Safari で URL を開いてサインインしてください」を画面に出し、遷移は起こさない。この場合 AC 4.5 は「遷移を起こす」から「認証手段を現場へ示す」へ緩める必要があり、requirements の修正を要する

検証は tasks の**受入条件**とし、実装完了の判定に含める（後述の検証計画 V-4）。

### R-2. いま詰まっている端末に、この修正は OTA で届かない

Service_Worker の更新チェック（`sw.js` の再取得）はネットワーク要求である。Access セッションが切れた端末では **302 でログイン HTML が返り、更新に失敗する**。つまりバグ状態に入った端末は、誰かが一度サインインするまで、新しい SW（除外設定の修正）も新しい client（分類の修正）も受け取れない。

**修正は自分自身を配れない。** 初回ロールアウトは「全端末で一度手動サインインする」という運用作業を伴う。

`registerType: "autoUpdate"` ・ `skipWaiting: true` ・ `clientsClaim: true` は既に設定されているため、**サインインが一度通れば**新 SW は即時有効化され、厨房の iPad がタブを閉じないことによる「永久に waiting」は起きない。詰まりの原因は更新戦略ではなく認証である。

ロールアウト手順は後述（RO-1）。

---

## 全体の流れ

修正後の一巡。左が既存、太字が本 spec で足す部分。

```
WS 切断 → Connectivity: down 確定
  └─ Reachability_Probe（down 契機に 1 回・要件6.4）
       └─ 観測（作用の端）: fetch("/entry/stores", { redirect: "manual", cache: "no-store" })
            ├─ opaqueredirect      → 観測 = Redirected      **新**
            ├─ status + body       → 観測 = Responded
            └─ throw               → 観測 = Failed
       └─ 分類（純粋関数）: 観測 → UnreachableReason
            ├─ Redirected          → signInRequired         **新**
            ├─ 403                 → signInRequired
            ├─ 200 かつ storeId 在 → offline
            ├─ 200 かつ storeId 無 → noAccess
            └─ それ以外 / Failed   → offline
  └─ 表示: ConnectionStatus（純粋な導出のまま）
  └─ **Sign_In_Affordance（signInRequired のときだけ現れる）**
       └─ 押下 → App の端が window.location.assign("/entry/signin/{storeId}")
            └─ SW 除外（/entry/ 配下）ゆえネットワークへ出る
                 └─ Access が 302 → ログイン → EntraID
                      └─ redirect_url = /entry/signin/{storeId} へ復帰（CF_Authorization 付き）
                           └─ Worker が 302 → /s/{storeId}/
                                └─ SW がキャッシュから殻を返す → 再接続 → snapshot 再取得
```

**秒読み・発火・ローカル権限が続くのは Affordance を押すまでである**（要件 4.3）。押した後はトップレベル遷移でページが無くなるため、Access 往復の間は秒読みの表示も茹で上がりの合図（音）も起きず、復帰後に offline-degradation の永続から再水和して戻る。

**往復中に茹で上がる麺があれば、その合図を失う。** これは決定 C（遷移はユーザーの明示操作のみ）の裏面であり、受け入れた代償である。現場が手の空いた瞬間を選べることと引き換えに、選んだ瞬間の数秒〜数十秒は画面が無い。自動遷移にすればこの代償が**現場の選べないタイミングで**発生するため、明示操作に限る判断は変えない。

---

## 判断 1: 分類の切り出し方 — 観測の直和型で切る

**現状の問題。** `probeReachability` は fetch と分岐が 1 つの関数に混ざっており、`fetch` を差し替えないと分類を試せない。結果として今回のバグ（302 の取り違え）はテストで踏めなかった。

**設計。** 作用の端が fetch の結果を**小さな直和**へ写し、分類はその直和だけを受ける純粋関数にする。

```ts
/** 分類 fetch から観測できた事実。これ以外の形は存在しない（3 つで全域）。 */
type ProbeObservation =
  | { readonly kind: "redirected" }                                       // 3xx（宛先は観測不能）
  | { readonly kind: "responded"; readonly status: number; readonly body: ObservedBody }
  | { readonly kind: "failed" };                                          // fetch 自体が throw

/** 本文の読み取り結果。**読めなかったことを値として持つ**——status を失わないため。 */
type ObservedBody =
  | { readonly parsed: true; readonly value: unknown }
  | { readonly parsed: false };
```

分類はこの直和 × `storeId` から `UnreachableReason` への純粋関数になる。**fast-check が素直に乗る**——直和の 3 枝と status の値域を生成すれば全域を踏める。

### 観測の構築規則（ここを外すと 403 が `offline` へ退行する）

現行コードは **status 403 を見てから本文を parse する**（`connectivity.ts` の分岐順）。切り出しの過程でこの順序を失うのが、最も起きやすい退行である。作用の端が全応答に `response.json()` を試みて失敗を `failed` へ畳むと、**Worker の 403（本文が JSON でない可能性が高い）が `failed` → `offline` に化け、要件 2.1（旧 15.3）が退行する。**

ゆえに構築規則を 3 つ固定する。

1. **`status` は常に保持する。** 本文の読み取り結果に関わらず失わない
2. **本文の読み取りは `status === 200` のときだけ試みる。** それ以外は `{ parsed: false }` とし、**403 に parse を掛けない**（現行の分岐順をそのまま保つ）
3. **`failed` は fetch 自体の throw のみ。** 本文の読み取り失敗を `failed` へ畳まない

`ObservedBody` を入れ子の直和にしているのは、要件 3.3 が「パース失敗 → `offline`」を要求する一方、「200 かつリストに storeId が無い」は `noAccess`（要件 2.4）だからである。**`{ parsed: false }` を空配列と同一視すると `noAccess` へ誤る。** 読めなかったことと、読めて不在だったことは別の事実である。

**判定は `response.type === "opaqueredirect"` で行い、`status === 0` で代用しない。** `no-cors` の opaque 応答も `status === 0` になるため、後者では別物を取り違える。今回のバグが「別の信号を同じ形に潰した」ことに起因するので、同じ誤りを繰り返さない。

**`cache: "no-store"` を付ける。** 要件 5.4 は Service_Worker の戦略を素通りさせるが、**ブラウザの HTTP キャッシュは別の層**であり、そこが古い 200 を返せば `noAccess` / `offline` へ誤分類する。塞ぐ層は 2 つある。

**`offline` の意味（要件 3.1）** は分類関数の docstring に 1 箇所だけ書き、`connection.ts` の型宣言はそこを参照する形にする（同一概念を二箇所で定義しない・要件 3.2）。

---

## 判断 2: Sign_In_Affordance の置き場 — `ConnectionStatus` の兄弟に置く

**`ConnectionStatus` は状態を持たない純粋な表示**（`view` を購読して導出するだけ・`role="status"`）である。ここに操作点を持たせると役割が変わり、`connectionStatus()` の純粋導出に「押せるか」という別軸が混ざる。

**設計。** 兄弟コンポーネントとして隣に置く。`App.tsx:220` の描画位置がそのまま使える。

```tsx
{connection && <ConnectionStatus connection={connection} />}
{connection && <SignInPrompt connection={connection} onSignIn={goToSignIn} />}
```

- `SignInPrompt`（仮称）は `view.unreachableReason === "signInRequired"` のときだけ描画し、それ以外は `null` を返す（要件 4.4）
- **遷移という作用は持たない。** `onSignIn` を受けて呼ぶだけ
- 遷移の実体（`window.location.assign`）は `App` の端に置く。「計算と作用の分離」を崩さない

`ConnectionStatus` 側の変更は文言 1 箇所のみ（判断 5）。

---

## 判断 3: 遷移先パス — `/entry/` 配下に 1 本立て、Worker が店舗画面へ 302 する

要件の未確定事項が挙げた 4 条件を満たす必要がある。(a) SW のフォールバック除外対象 (b) Access の保護下 (c) `storeId` を運ぶ (d) 認証後に Worker が店舗画面へ導く。

**既存パスでは解けない。**

| 候補 | 判定 |
| --- | --- |
| `/s/{storeId}/` | **不可。** 除外に入れると AC 6.2（オフライン時のキャッシュ起動）が壊れる |
| `/entry/stores` | **不可。** 認証後に生 JSON へ着地し AC 4.6 に反する |
| `/`（Entry） | **不可。** `storeId` を運ばない。identity からの逆引きに委ねると、多店舗 identity（SV・本部）で別店舗や選択画面へ着地しうる（per-store-provisioning が「同定と認可の分離」で退けた論点） |

**設計。** `/entry/signin/{storeId}` を 1 本立てる（名称は確認待ち・判断 6）。

- (a) **満たす。** AC 5.2 が `/entry/` 配下を除外対象と定めており、この 1 本もそこに含まれる。除外設定を個別に足す必要がない
- (b) **満たす（Access 側の変更不要）。** 実測で `timer-dev` は `/`・`/entry/stores`・`/pos/records`・`/admin/chains`・`/favicon.svg`・`/pwa-192x192.png` の**全経路が 302** だった。保護はホスト全体で、パス指定ではない。ゆえに新パスは自動的に保護下に入る
- (c) **満たす。** パスに `storeId` を載せる
- (d) **満たす。** Worker が `/s/{storeId}/` へ 302 する

**Worker の挙動。**

```
GET /entry/signin/{storeId}
  → storeId の形式検証（既存の /s/{storeId}/ 分岐と同じ関門を通す）
  → 302 Location: /s/{storeId}/
```

**Roster 判定をここに置かない。** 接続可否の判定は店舗 DO の投影 Roster が担う既存の一本道であり、ここに足せば判定が二箇所に分かれる。このパスは「認証を経て店舗画面へ導く」だけの通し口である。

**`ACCESS_REQUIRED` を見ない。** OFF（ローカル dev・`workers.dev`）でも同じく 302 するだけで無害であり、フラグで分岐させる理由がない。分岐を増やさない。

**`run_worker_first` は不要。** `/entry/signin/...` に一致する実在アセットが無いため、既定でアセット層を抜けて Worker に届く（PR #2 が足す `/` とは事情が違う）。

**AC 1.5 との関係。** 新パスは 3xx を返すが、不変条件が縛るのは `GET /entry/stores` のみで衝突しない。ただし **Reachability_Probe が誤ってこのパスを叩けば、それは常に `signInRequired` に見える**。分類の入力は `/entry/stores` に固定されていることをテストで踏む（V-1）。

---

## 判断 4: AC 1.5 の固定方法 — integration で踏む

**静的検査ではなく integration を採る。** `src/worker.ts` の分岐を読む静的検査はリファクタで壊れ、しかも**挙動を見ていない**。分類の正しさが Worker の挙動に依存するのだから、挙動そのものを踏むべきである。

`cloudflareTest()` で `GET /entry/stores` を次の組合せで叩き、**いずれも 3xx を返さない**ことを主張する。

| `ACCESS_REQUIRED` | JWT | 期待 |
| --- | --- | --- |
| `"0"` | なし | 404（3xx でない） |
| `"1"` | なし | 403（3xx でない） |
| `"1"` | 妥当 | 200（3xx でない） |
| `"1"` | 不正 | 403（3xx でない） |

主張は「特定の status であること」ではなく「**3xx でないこと**」に置く。既存の status を再検証するのは他のテストの仕事であり、ここが守るのは AC 1.3 が依存する不変だけである。

---

## 判断 5: 表示文言 — `offline` は据え置き、`signInRequired` を操作可能に見せる

**`offline` の文言は変えない。** offline-degradation 要件15.9 が「既存文言・既存 tone 据え置き」を明示的に定めている。加えて `signInRequired` が正しく分離された後に残る `offline` は、ほぼ真のオフラインか分類不能であり、`Offline — running locally` の実害が小さい。**要件が据え置きを定めている箇所を、別 spec の判断で動かさない。**

層 3 の論法（断定をやめる）が文言にも当てはまるという指摘は正しいが、それは offline-degradation 要件15.9 の再検討であり、本 spec のスコープ外として申し送る。

**`signInRequired` の文言は変える。** 現状 `Sign-in required` は状態の記述にとどまり、操作できることが読めない。Affordance と対にして、押せることが文言から分かる形にする。

| Unreachable_Reason | 現状 | 変更後 |
| --- | --- | --- |
| `offline` | `Offline — running locally` | 据え置き |
| `noAccess` | `No access to this store` | 据え置き |
| `signInRequired` | `Sign-in required` | `Sign-in required — tap to sign in`（`SignInPrompt` 側に置くか、ピルの文言を変えるかは実装で決める） |

既存語彙（`running locally`）との一貫性を保ち、新しい語彙を増やさない。UI コンテンツは英語（`tooling.md`）。

---

## 判断 6: 公開シンボルの命名 — **確定**

`naming.md` の要求に従いユーザー確認を経て確定した。

| 種別 | 名 | 表明する概念境界 |
| --- | --- | --- |
| 型（観測の直和） | `ProbeObservation` | 分類 fetch から**観測できた事実**。宛先は観測できないという限界を含む |
| 直和の枝 | `redirected` / `responded` / `failed` | 3xx / 応答あり / fetch 自体が throw |
| 型（本文の読み取り） | `ObservedBody` | 読めたか読めなかったかを**値として**持つ。`status` を失わないための入れ子 |
| `ObservedBody` の判別子 | `parsed` | 読み取りが成立したか |
| 純粋関数（分類） | `classifyReachability` | 観測 → `UnreachableReason` の写像。`probeReachability`（作用の端）と対 |
| コンポーネント | `SignInPrompt` | `signInRequired` のときだけ現れる操作点 |
| 遷移の端（`App` 内） | `goToSignIn` | トップレベル遷移を起こす唯一の地点 |
| Worker のパス定数 | `SIGNIN_ENTRY_PATH` = `/entry/signin/` | 認証を経て店舗画面へ導く通し口 |

**確定にあたって残す理由。**

- **`redirected` を `accessRedirect` と名指さない。** 前者は HTTP の事実、後者は解釈である。観測の層で解釈を混ぜると、Worker が 3xx を返し始めたときに名前が嘘になる——AC 1.5 が警戒しているのはまさにそれで、**名前が先に嘘をつく形を作らない**
- **`SignInPrompt` は `InstallPrompt` の並びに乗せる。** `InstallPrompt` は自動で消える導線、こちらは状態依存という性質差はあるが、いずれも「現場へ次の一手を示す」ものであり `*Prompt` の語で括れる。新しい語彙を増やさない
- **`/entry/signin/` の `signin` は動詞的だが目的を指す。** `/entry/resume/` 案（この店舗へ戻る）を退けた理由は、**戻ることは結果であって目的ではない**——このパスが存在する理由は認証を経ることである。R-1 が否に出て運用手順の提示に変わる場合、このパスは不要になる（その判断は V-4 の後）
- 禁止汎用語（`Manager` / `Handler` / `Service` / `Util` / `Helper` / `Data` / `Info` / `process` / `handle` / `manage`）は用いていない

---

## 検証計画

| ID | 対象 | 種別 | pool | 内容 |
| --- | --- | --- | --- | --- |
| V-1 | `classifyReachability` | property | node | 観測の直和 3 枝 × status 値域 × storeId の在不在で全域。`redirected` は常に `signInRequired`。`{ parsed: false }` は空配列と同一視されず `offline` になること（`noAccess` へ落ちない） |
| V-2 | `probeReachability`（作用の端） | example | node | fetch を注入し、`opaqueredirect` / 403 / 200 / throw が正しい観測へ写ること。**`403` ＋ 非 JSON 本文 → `signInRequired`**（parse を掛けない構築規則の固定）。`redirect: "manual"` と `cache: "no-store"` が渡ること。**叩く URL が `/entry/stores` に固定されていること**（URL は作用の端の性質であり、`classifyReachability` は URL を知らない） |
| V-3 | Worker | integration | workers | AC 1.5（`GET /entry/stores` が 3xx を返さない・4 組合せ）。`/entry/signin/{storeId}` が `/s/{storeId}/` へ 302 すること・不正 storeId を拒むこと |
| V-4 | **認証往復** | **実機** | — | **インストール済み PWA・実 iPad・実 Access 構成**で、Sign_In_Affordance → EntraID → 店舗画面への復帰と再接続。R-1 の分岐を確定させる。**あわせて「詰まった standalone 端末の復旧手順」を記録し、RO-1 手順 2 の正本とする**。**tasks の受入条件に含める** |
| V-5 | SW の設定 | static | node | 意図のある経路（`/cdn-cgi/`・`/entry/`・`/pos/`・`/admin/`）のみが除外に列挙され、`ws` の項が無いこと。**あわせて `/entry/` に一致する `runtimeCaching` 規則が存在しないこと**——AC 5.4 が今成り立っているのは `runtimeCaching` が無いからであり、誰かが API 向けに `NetworkFirst` を足した瞬間に本 spec が直した経路が再発する。`tests/entry-routing.static.test.ts` と同型 |
| V-6 | `SignInPrompt` | example | workers | `signInRequired` のときだけ描画され、それ以外は `null`。`onSignIn` を呼ぶだけで遷移を起こさないこと |

**V-4 は自動化できない。** 本番の Access 構成と実機を要するため、手順と結果を記録する形で受入とする。ここを飛ばすと AC 4.5 / 4.6 の成立が未確認のままになる。

---

## ロールアウト手順（RO-1）

修正は自分自身を配れない（R-2）。順序を固定する。

1. **修正をデプロイする**（CI 経由。`main` へマージ）
2. **詰まっている端末を 1 台ずつ復旧する。手順は V-4 の結果を正本とする。** ブラウザのタブなら、シークレット/プライベートウィンドウか、DevTools で SW を Unregister してから開けば通る。
   - **standalone の PWA では「Safari でサインインする」が効かない可能性が高い。** iPadOS のホーム画面 Web アプリは Safari と Cookie ストレージを共有しない（してこなかった）ため、Safari 側で認証しても PWA 側の Access セッションもキャッシュ済み SW も直らない。確実な手は**アプリを削除して入れ直す**ことだが、これは推定である
   - **ゆえに手順をここで断定しない。** R-1 の実機検証（V-4）と同じ端末・同じセッションで確定できる事実なので、V-4 の記録項目に「詰まった standalone 端末の復旧手順」を含め、本手順はその結果を参照する。**先に手順を書けば、ロールアウト時に嘘になる**
3. サインインが通れば `autoUpdate` + `skipWaiting` により新 SW が即時有効化され、以降は分類が正しく働く
4. 以後は Access セッションが切れても Sign_In_Affordance から復帰できる（V-4 が成立した場合）

**2 は端末台数ぶんの作業になる。** 本番利用者が居ない今のうちに済ませるのが最も安い。

---

## 触るファイル

| ファイル | 変更の性質 |
| --- | --- |
| `src/client/connectivity.ts` | 観測の直和と分類の切り出し。`redirect: "manual"` / `cache: "no-store"`。`offline` の意味の記述を 1 箇所へ |
| `src/client/connection.ts` | `offline` の意味の記述を分類関数の定義へ参照させる（重複を消す） |
| `src/client/components/ConnectionStatus.tsx` | `signInRequired` の文言のみ |
| `src/client/components/SignInPrompt.tsx` | 新規。`signInRequired` のときだけ現れる操作点 |
| `src/client/App.tsx` | `SignInPrompt` の描画と `goToSignIn`（遷移の端） |
| `src/worker.ts` | `/entry/signin/{storeId}` の 1 分岐 |
| `vite.config.ts` | `navigateFallbackDenylist` を意図のある経路へ。`ws` の項を削る |
| `tests/` | V-1〜V-3・V-5・V-6 |

`src/engine/` / `src/domain/` は触らない。

---

## 残るリスクと申し送り

- **R-1 が否になった場合、requirements の AC 4.5 を緩める必要がある**（遷移を起こす → 認証手段を示す）。design のこの部分は R-1 の結果に依存する
- **`workers.dev` 由来の 403 では Sign_In_Affordance が機能しない**（要件 2.5 の限界）。押しても再び 403 になる。`workers.dev` の閉鎖（別スコープ）が解消する
- **構成不整合による「押しても戻ってくる」ループ。** Access セッションは有効なのに Worker が JWT を拒む状態（`POLICY_AUD` 不一致・issuer 不一致・複数 Access アプリで `aud` が 2 つになった場合など）では、403 → `signInRequired` → Affordance → Access は通過 → Worker が 302 → 店舗画面 → **再び WS 拒否**、と一巡して戻る。スコープ外の構成不備だが、**現場から見た症状は「サインインしたのに直らない」で、本 spec が直した症状と区別がつかない。** 切り分けの起点はログイン URL の `kid` とデプロイ済み `POLICY_AUD` の照合（本 spec の調査で用いた手法）
- **`offline` の表示文言**は offline-degradation 要件15.9 が据え置きを定めているため本 spec では変えない。層 3 の論法が文言にも当てはまることは、当該要件の再検討として申し送る
- **cloudflare-access-enablement は PWA / Service_Worker を要件で扱っていない。** 本 spec が足す `/entry/signin/` は Access の保護対象に自動的に入るが（ホスト全体保護のため）、将来パス指定の保護へ移すなら当該 spec のチェックリストに `/entry/signin/` を加える必要がある
- **`/pos/records` の bypass が未構成**のため `timer-dev` では POS 経路が 302 で死んでいる。本 spec のスコープ外だが、同じホストの構成として関連する
