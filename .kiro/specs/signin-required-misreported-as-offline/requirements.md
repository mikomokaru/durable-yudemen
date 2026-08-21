# Requirements: 認証切れが回線喪失として表示される（signin-required-misreported-as-offline）

## Introduction

Cloudflare Access の背後で **Access セッションが切れている状態**が、iPad_Client の画面上で「回線喪失」として表示される。表示は `Offline — running locally`、内部の分類結果は `unreachableReason === "offline"`。実際には回線は生きていて、切れているのは認証である。現場は「電波が悪い」と読み、待てば直ると考える。だが待っても直らない。

さらに、この状態からアプリ内で再認証する道が無い。Service_Worker がナビゲーションにキャッシュ済み App_Shell を返すため、Access の 302 がブラウザへ一度も渡らず、ログイン画面が出る機会が構造的に消える。**一度キャッシュが入った iPad は、認証が切れた時点で入口を失う。**

本 spec は既存の分類機構（offline-degradation 要件15）の**訂正**であり、新しい縮退運用を設計するものではない。

### 観測された失敗（本番・`timer-dev.yamaokaya.org`）

ブラウザのコンソール出力（要点）:

```
WebSocket connection to 'wss://timer-dev.yamaokaya.org/s/yamaokaya-1263/ws' failed:
  There was a bad response from the server. (x14)

Fetch API cannot load https://ymoky.cloudflareaccess.com/cdn-cgi/access/login/timer-dev.yamaokaya.org
  ?kid=c40171…836&meta=…  due to access control checks.
Origin https://timer-dev.yamaokaya.org is not allowed by Access-Control-Allow-Origin. Status code: 200
Unhandled Promise Rejection: TypeError: Load failed
```

`meta` の JWT ペイロードに `"redirect_url":"/entry/stores"` が含まれており、302 の対象が分類 fetch そのものだったことが確定している。表示は `Offline — running locally` のままだった。

環境の事実:

- Access_Application は `timer-dev.yamaokaya.org` に構成されており、その `aud`（ログイン URL の `kid`）はデプロイ済み Worker の `POLICY_AUD` と一致する
- `ACCESS_REQUIRED` は `"1"`
- 同一 Worker は `yude-men-timer.yamaokaya.workers.dev` でも公開されており、そちらには Access_Application が無い

### 三層の診断（本 spec が直す対象の切り分け）

**層 1 — 概念は分けてあった。** `UnreachableReason` は `offline` / `noAccess` / `signInRequired` の 3 値を持ち、design のコメントは区別が潰れる危険を正しく予見している。「ブラウザ WebSocket API はハンドシェイクの HTTP ステータスを隠すため、権限なしは close code 1006 に潰れて純粋なオフラインと区別できない——この HTTP fetch がその区別を回復する」。復元機構として `probeReachability` が置かれている。**ここに誤りはない。**

**層 2 — 復元の根拠が実物と違っていた（これがバグ）。** offline-degradation 要件15.3 は「HTTP 403 → `signInRequired`」と定める。しかし本物の Access_Application はブラウザに **302** を返す。403 が来るのは Worker 自身が JWT 不在で弾いたときだけで、それは Access_Application を持たないホストでしか起きない。`probeReachability` の fetch は `redirect` を指定せず既定の `"follow"` で動くため、302 を追ってクロスオリジンへ出て CORS で throw し、`catch` に落ちて `offline` になる。**区別を回復するために作った機構が、その区別が最も要る場面で穴になっていた。**

**層 3 — `offline` が二義を抱えている。** コード内の 2 箇所が違うことを言っている。

```
src/client/connection.ts   : "offline"（回線喪失・特段の理由なし）が既定
src/client/connectivity.ts : 404 / その他の非 2xx / 非配列 / パース失敗 → "offline"（分類不能・優雅に劣化）
```

前者は**事実の主張**（回線が落ちている）、後者は**知識の不在**（分からないので畳んだ）。同じ値が両方を背負っており、今回は後者の経路を通って前者の顔で表示された。`design-philosophy.md`「真 — コードは状態について嘘をつかない」に照らすと、分からないことを分かったように言っている。

### スコープ

**含む**

- 分類の証拠チャネルの訂正（Access の 302 / opaque redirect を `signInRequired` として拾う）
- `offline` の意味の確定と、コード内の記述の統一
- 認証へ戻る道（`signInRequired` のときに現場が明示操作で認証へ向かえること）
- Service_Worker が認証経路を横取りしないこと
- **Worker の既存挙動（`GET /entry/stores` が 3xx を返さない）の不変条件化**。テストまたは静的検査のみで、**Worker の挙動は変更しない**（AC 1.5。分類の正しさがこの挙動に依存するため、暗黙の前提を明示の不変へ格上げする）

**含まない**

- **Service_Worker のナビゲーション戦略の変更**。キャッシュ優先（`navigateFallback`）は縮退運用の土台であり、本 spec は変えない（決定 A）
- `src/engine/` / `src/domain/` の変更。実装は client と PWA 設定に閉じ、Worker 側は**検証を足すだけ**で挙動を変えない（上記）
- Access_Application の構成（bypass 経路・許可 IdP・ポリシー）。運用手順であり `docs/access-enablement/` の担当
- `workers.dev` を閉じるか、同一 Access_Application にホストとして加えるかの判断
- `chainRoster` の読み出し口（`GET /admin/chains/{chainId}`）の新設
- オフライン中に発生したローカル操作の再整合。offline-degradation のスコープ外を継承する

### 用語

- **Unreachable_Reason**: Connectivity が `down` のときにのみ意味を持つ分類結果。既存の型 `UnreachableReason = "offline" | "noAccess" | "signInRequired"`（offline-degradation 要件15 由来）。本 spec は**値集合を変えない**（決定 B）。
- **Access_Redirect**: Access_Application がセッション不在の要求に対して返す 302 応答。宛先は team domain 配下の `/cdn-cgi/access/login/{hostname}`。
- **Opaque_Redirect**: `fetch` に `redirect: "manual"` を与えたとき、**3xx 応答に対して返る不透明な応答**。`type === "opaqueredirect"`・`status === 0`・ヘッダ空・本文読み出し不可で、**`Location`（宛先）は読めない**。オリジンを問わず（同一オリジン宛の 3xx を含め）すべての 3xx がこの形になる点が重要で、「リダイレクトされた」という事実だけが観測でき、「どこへ」は観測できない。リダイレクトを追跡すればクロスオリジンで CORS に潰れて事実ごと失われるため、これが Access_Redirect を観測可能な事実として受け取る唯一の形である。
- **Sign_In_Affordance**: `signInRequired` のときに現場が押せる、認証へ向かう明示的な操作点。押されたときにのみトップレベル遷移を起こす。
- **Reachability_Probe**: 到達不能理由を分類する作用の端。既存の `probeReachability`（offline-degradation で確定済みの名）。
- **App_Shell** / **Service_Worker**: offline-degradation の定義を継承する。

---

## 要件

### 要件 1: Access セッション切れを認証切れとして名指す

**ユーザーストーリー:** 厨房スタッフとして、サーバへ繋がらない理由が「電波」なのか「サインインし直しが要る」のかを知りたい。前者は待てば直るが、後者は待っても直らないので、行動が変わる。

#### 受け入れ基準

1. WHEN Reachability_Probe が Access_Redirect を受けたとき、THE iPad_Client SHALL Unreachable_Reason を `signInRequired` として分類する。
2. THE Reachability_Probe SHALL 分類 fetch のリダイレクト追跡を抑止し、リダイレクトを Opaque_Redirect として観測する（追跡すればクロスオリジンの CORS 失敗に潰れ、302 という事実が失われる）。
3. WHEN Reachability_Probe が Opaque_Redirect を受けたとき、THE iPad_Client SHALL 当該応答を Access_Redirect として扱い、`signInRequired` を返す。
4. THE Reachability_Probe SHALL 分類のために追加のエンドポイントを新設せず、既存の `GET /entry/stores` のみを用いる。
5. THE Worker SHALL `GET /entry/stores` に対して 3xx を返さない。**これは AC 1.3 が依存する不変条件である**——Opaque_Redirect は宛先を観測できず、かつオリジンを問わずあらゆる 3xx が同じ形になるため、Worker 自身がこの経路でリダイレクトを返すようになれば、それが黙って `signInRequired` へ化ける。当該不変は Worker 側のテストまたは静的検査で固定する。

### 要件 2: Access_Application を持たないホストでの分類を保つ

**ユーザーストーリー:** 運用担当として、Access を課していないホスト（`workers.dev`）でも従来どおり理由が分かってほしい。段階的有効化の途中で分類が壊れては困る。

#### 受け入れ基準

1. WHEN Reachability_Probe が HTTP 403 を受けたとき、THE iPad_Client SHALL Unreachable_Reason を `signInRequired` として分類する（既存 offline-degradation 要件15.3 の挙動を保つ）。
2. THE iPad_Client SHALL 403 の分類を 302 の分類で置き換えず、**両方**を `signInRequired` へ写す（403 は Worker 自身の拒否、302 は Access_Application の拒否であり、いずれも「認証が要る」という同一の現場行動へ収束する）。
3. WHEN Reachability_Probe が HTTP 200 を受け、かつ返却リストに当該 storeId が在るとき、THE iPad_Client SHALL `offline` を返す（既存 要件15.5 を保つ）。
4. WHEN Reachability_Probe が HTTP 200 を受け、かつ返却リストに当該 storeId が無いとき、THE iPad_Client SHALL `noAccess` を返す（既存 要件15.4 を保つ）。
5. THE 本 spec SHALL 403 由来の `signInRequired` では Sign_In_Affordance が復旧手段にならないことを限界として記録する。403 を返すのは Access_Application を持たないホストであり、そこへ遷移しても Access が無いため再び 403 になる。**302 は再認証で復旧するが、403 は復旧手段を持たない。** この非対称は `workers.dev` が過渡的ホストであることに起因し、その閉鎖（本 spec のスコープ外）によって解消する。

### 要件 3: `offline` の意味を確定する

**ユーザーストーリー:** 保守する者として、`offline` が「回線が落ちている」と断定しているのか「サーバへ届かない、理由は特定できない」なのかを、コードの 1 箇所で読み取れてほしい。

#### 受け入れ基準

1. THE `offline` SHALL 「サーバへ到達できていない。理由は特定できない」を意味するものと定義される（回線喪失を**断定しない**）。
2. THE iPad_Client SHALL `offline` の意味の記述を 1 箇所に持ち、`src/client/connection.ts` と `src/client/connectivity.ts` の記述を当該定義へ揃える（同一概念を二箇所で違う言葉で定義しない）。
3. WHEN Reachability_Probe が分類不能な応答（404・その他の非 2xx・非配列・パース失敗・ネットワークエラー）を受けたとき、THE iPad_Client SHALL `offline` を返す（既存 要件15.2 / 15.6 の畳み込みを保つ）。
4. THE iPad_Client SHALL Unreachable_Reason の値集合を `offline` / `noAccess` / `signInRequired` の 3 値に保ち、「分類不能」を表す 4 値目を追加しない（決定 B）。

### 要件 4: 認証へ戻る道を持つ

**ユーザーストーリー:** 厨房スタッフとして、サインインし直せと言われたら、その場で戻れてほしい。ただし麺を茹でている最中に画面を奪われたくない。

#### 受け入れ基準

1. WHILE Unreachable_Reason が `signInRequired` であるとき、THE iPad_Client SHALL Sign_In_Affordance を提示する。
2. THE iPad_Client SHALL Sign_In_Affordance が押されたときにのみ認証へのトップレベル遷移を起こし、それ以外の契機で自動的に遷移しない（決定 C）。
3. WHILE Unreachable_Reason が `signInRequired` であるとき、THE iPad_Client SHALL 走行中タイマーの秒読み・茹で上がり発火・ローカル権限を継続する（offline-degradation 要件5〜8 を損なわない）。
4. WHERE Unreachable_Reason が `signInRequired` 以外であるとき、THE iPad_Client SHALL Sign_In_Affordance を提示しない（押しても意味のない操作点を常設しない）。
5. THE iPad_Client SHALL Sign_In_Affordance の遷移先を**同一オリジンのパス**とし、当該パスは Access_Application の保護下に在り、かつ Service_Worker のフォールバック除外対象である。Access への誘導は当該パスへのトップレベル遷移に対する 302 をブラウザが追うことで成立させ、team domain・アプリ識別子・ログイン URL をクライアントへ定数として埋め込まない。
   - **宛先を Access_Redirect から導くことはできない。** Opaque_Redirect は `Location` を読めず（用語定義）、追跡すれば CORS で潰れる。ゆえに「302 が来た」事実だけを分類に用い、誘導は**ブラウザのナビゲーションに委ねる**。トップレベル遷移は CORS の制約を受けないため、Access のログインへ正しく運ばれる。
6. WHEN 認証が完了したとき、THE iPad_Client SHALL 当該店舗の画面へ戻り、再接続して状態を再取得する（Access は `redirect_url` が示す元の遷移先へ戻すため、戻り先が API の生 JSON であってはならない）。戻り先パスの決定方法は design で定める。

### 要件 5: Service_Worker が認証経路を横取りしない

**ユーザーストーリー:** 運用担当として、サインインの操作が Service_Worker のキャッシュに飲まれず、確実にネットワークへ出てほしい。

#### 受け入れ基準

1. THE Service_Worker SHALL Access の認証エンドポイント（`/cdn-cgi/` 配下）へのナビゲーションを App_Shell へフォールバックさせない。
2. THE Service_Worker SHALL 機械が叩く API 経路（`/entry/`・`/pos/`・`/admin/` 配下）へのナビゲーションを App_Shell へフォールバックさせない。
3. THE Service_Worker のフォールバック除外設定 SHALL 意図のある経路（AC 5.1・5.2）のみを列挙し、WebSocket の項（現行の `/^\/ws$/`）を持たない。**正規表現を実在パス `/s/{storeId}/ws` へ直すのではなく、項ごと削る**——WebSocket の upgrade はナビゲーション要求ではないため、そもそもフォールバック除外の対象にならない。直せば「除外が必要である」という誤解を温存する。
4. THE Service_Worker SHALL 分類 fetch（`GET /entry/stores`）を自身の戦略を素通りさせ、キャッシュの読み書きの対象に含めない。**Workbox の戦略が Opaque_Redirect（`status === 0`）を失敗と見なしてキャッシュ済みの古い 200 を返せば、分類は `noAccess` か `offline` へ誤る**——本 spec が直したのと同じ経路の再発形である。

### 要件 6: 縮退運用を損なわない

**ユーザーストーリー:** 厨房スタッフとして、回線が落ちている最中にアプリを開き直しても、これまでどおり起動して茹で状況を見続けたい。

#### 受け入れ基準

1. THE Service_Worker SHALL App_Shell のナビゲーションに対するキャッシュ優先の解決を維持する（決定 A）。
2. WHILE Connectivity が `down` であるとき、WHEN ユーザーがアプリをリロードまたは再起動したとき、THE iPad_Client SHALL キャッシュ済みの App_Shell から起動する（offline-degradation 要件10.2 を保つ）。
3. THE iPad_Client SHALL 分類の失敗・遅延によって秒読み・発火・ローカル権限を妨げない（分類は付加情報であり、縮退運用の前提条件ではない）。
4. THE Reachability_Probe SHALL Connectivity が `down` へ確定した契機に 1 回だけ実行され、常駐ポーリングを行わない（既存 要件15.13 を保つ）。

### 要件 7: 既存 spec の訂正を明示する

**ユーザーストーリー:** 保守する者として、offline-degradation 要件15.3 の記述が実環境と食い違っていた経緯を、後から辿れてほしい。

#### 受け入れ基準

1. THE 本 spec SHALL offline-degradation 要件15.3（「HTTP 403 → `signInRequired`」）が Access_Application の背後では成立しないことを記録し、要件 1・要件 2 が当該基準を置き換える関係を明示する。
2. THE 本 spec SHALL cloudflare-access-enablement の要件群が PWA / Service_Worker との相互作用を扱っていない事実を申し送りとして記録する。

---

## 決定

### 決定 A: ナビゲーションのキャッシュ戦略 → **キャッシュ優先を維持する**

当初、ナビゲーションを network-first（ネットワーク優先・失敗時キャッシュ）へ変える案を検討した。オンラインなら Access の 302 が通ってログインでき、オフラインならキャッシュに落ちるため、要件10.2 と認証が同時に満たされるように見えた。**採らない。** 理由は 2 つ。

**走行中の表示を奪う。** Access セッションが切れているときにナビゲーションがネットワークへ出ると、ブラウザはログイン画面へ遷移する。麺を茹でている最中にそれが起きれば、現場は残り時間を見失う。永続と再水和で値は戻るが、戻るまでの間、画面から茹で状況が消える。`design-philosophy.md`「厨房スタッフへの善 — 失敗は優雅に劣化する。瞬断で表示は死なない」に正面から反する。

**半開通でハングする。** 回線が生きているのに応答が返らない状態（このコードベースが silent-loss として検知している状況）では、ネットワーク優先の解決が待たされる。`networkTimeoutSeconds` で切れるが、縮退運用の起動経路に新しい時間パラメータを持ち込むことになる。

そして本質的に、network-first は**症状の側を触る対処**である。原因は分類が理由を名指せていないこと（要件 1）と、認証へ戻る道が無いこと（要件 4）であり、そちらを直せばキャッシュ優先を変える必要がない。

### 決定 B: 「分類不能」を表す 4 値目 → **追加しない**

層 3 の二義（事実の主張と知識の不在）を型で分けることを検討した。**採らない。** 現場の行動が分岐しないためである——「回線が落ちている」と「理由が分からない」のいずれでも、staff がすることは同じ（ローカルで秒読みを続け、待つ）。表示も同じ文言になる。行動が分岐しない区別を型に持ち込めば、値が増えた分だけ分岐が増え、得るものが無い（YAGNI）。

代わりに `offline` の意味を「到達できない・理由は特定できない」に確定させ（要件 3.1）、記述を 1 箇所へ揃える（要件 3.2）。**嘘を消すのに、値を増やす必要はない。断定をやめればよい。**

### 決定 C: 認証への遷移の契機 → **ユーザーの明示操作のみ**

自動遷移（`signInRequired` を検知したら即ログインへ飛ばす）を検討した。**採らない。** 決定 A と同じ理由で、走行中の表示を奪う。加えて、分類は誤りうる（要件 6.3 が示すとおり付加情報にとどまる）ため、誤分類が画面遷移という取り返しのつかない作用へ直結する形を避ける。

現場が手の空いた瞬間を選べることが、この設計の要点である。

### 決定 D: 403 の分類 → **残す（302 と併存させる）**

302 が実物だと判明したので 403 の分岐を置き換える案を検討した。**採らない。** 403 は Access_Application を持たないホスト（現状の `workers.dev`）で Worker 自身が返す実在の応答であり、段階的有効化の途中では両方のホストが生きている。片方を消せば、そのホストでの分類が `offline` へ退行する。

2 つの入力が同一の Unreachable_Reason へ収束するのは重複ではない。拒否した主体が違う（Worker / Access）だけで、**現場に示すべき事実は同一**である——「認証が要る」。

**ただし復旧可能性は同一ではない。** 当初「要求される行動は同一」と書いたが、これは正確でなかった。302 は再認証で復旧するが、**403 は復旧手段を持たない**。403 を返すのは Access_Application の無いホストであり、Sign_In_Affordance を押して同一オリジンへ遷移しても Access が居ないので再び 403 になる。この非対称は要件 2.5 に限界として明記した。原因は `workers.dev` が過渡的ホストとして残っていることであり、その閉鎖（スコープ外）が解消する。

**302 と 403 の別を証拠として保持し、Affordance の出し分けに使う案は採らない。** 「復旧できる signInRequired」と「復旧できない signInRequired」を実質的に分けることになり、決定 B（4 値目を足さない）の裏口になる。過渡的ホストの存在に起因する限界を、恒久的な型の分岐で受け止めるのは釣り合わない。`workers.dev` を閉じれば消える問題に、消えない構造を足さない。

---

## 参照

### 訂正・依存する既存 spec

| spec | 関係 |
| --- | --- |
| `offline-degradation` 要件15.3 | **訂正対象。** 「HTTP 403 → signInRequired」が Access_Application の背後で成立しない。本 spec 要件 1・2 が置き換える |
| `offline-degradation` 要件15.2 / 15.4 / 15.5 / 15.6 / 15.13 | 保つ（本 spec 要件 2・3・6 が明示的に継承する） |
| `offline-degradation` 要件10.1 / 10.2 | 保つ（本 spec 要件 6。キャッシュ優先を変えない） |
| `offline-degradation` 要件5〜8 | 保つ（秒読み・発火・ローカル権限を損なわない） |
| `cloudflare-access-enablement` | **申し送り。** PWA / Service_Worker への言及が要件群に 1 つも無く、この相互作用は当該 spec で検討されていない |
| `per-store-provisioning` 要件7 | `GET /entry/stores` の意味論（200 リスト / 403 / 404）の出所。本 spec は当該エンドポイントを改変しない |

### 実装が触る見込みの箇所

| ファイル | 変更の性質 |
| --- | --- |
| `src/client/connectivity.ts` | `probeReachability` の証拠チャネル（リダイレクト抑止・Opaque_Redirect の判定）と `offline` の記述 |
| `src/client/connection.ts` | `offline` の意味の記述を要件 3.1 へ揃える |
| `src/client/components/ConnectionStatus.tsx` | 現状 `signInRequired` は `role="status"` のピル（`Sign-in required`）で**操作点を持たない**。Sign_In_Affordance の追加先の候補 |
| `vite.config.ts` | VitePWA の `navigateFallbackDenylist`（現行 `[/^\/ws$/]` は実在パスに不一致） |

### 未確定事項

- **公開シンボルの命名は実装前にユーザー確認を要する**（`naming.md`）。Opaque_Redirect の判定関数・Sign_In_Affordance のコンポーネント名・遷移先の導出関数はいずれも公開シンボルであり、design 段階で候補を提示して確定させる。
- **Sign_In_Affordance の置き場**。上部バーのピル自体を押せるようにするか、別の操作点を設けるかは design で決める。`ConnectionStatus` は現在状態を持たない純粋な表示であり、操作点を持たせると役割が変わる。
- **検証方法**。本番の Access_Application が無いローカル dev では Access_Redirect が再現しない。分類は純粋関数として fetch を注入できる形に切り出せるため、Opaque_Redirect / 403 / 200 / throw の各入力に対する分類は property で踏める。Service_Worker の除外設定は設定を読む静的検査で固定できる（`tests/entry-routing.static.test.ts` と同型）。
- **Sign_In_Affordance の遷移先パス**。AC 4.5・4.6 を同時に満たすため、design は次の **4 条件**を満たすパスを選ぶ必要がある——(a) Service_Worker のフォールバック除外対象である、(b) Access_Application の保護下に在る、(c) **`storeId` を運ぶ**、(d) 認証後に Worker が当該店舗の画面へ導く。
  - (c) が要るのは、Access が `redirect_url`（＝遷移先パス）へ戻すため。**identity からの行き先解決（Entry `/` の逆引き）に委ねると、多店舗 identity（SV・本部）では別店舗や選択画面へ着地しうる**——per-store-provisioning が「同定と認可の分離」で退けたのと同じ論点である。現場が居る店舗へ戻らなければ AC 4.6 を満たさない。
  - `/entry/stores` そのものを遷移先にすると、認証後に生 JSON へ着地して AC 4.6 に反する。
- **AC 1.5 の不変条件の固定方法**。「Worker は `GET /entry/stores` に 3xx を返さない」を、Worker 側の integration で踏むか、`src/worker.ts` の当該分岐を読む静的検査にするかは design で決める。前者は現在の挙動を、後者は将来の追加を止める。分類の正しさが Worker 側の挙動に依存するという**spec を跨いだ結合**がここに在ることを、design で明示する。
- **表示文言**。`offline` を「到達できない・理由は特定できない」に確定させても（AC 3.1）、表示 `Offline — running locally` は依然「電波」と読ませる。`signInRequired` が分離された後に残る `offline` はほぼ真のオフラインだが、**層 3 の論法（断定をやめる）は文言にも当てはまる**。文言を到達不能寄りへ寄せるかは design で判断する。UI コンテンツは英語（`tooling.md`）。

### ツールと言語

`tooling.md` に従う。pnpm / TypeScript(strict) / Vite ＋ @cloudflare/vite-plugin / Wrangler v4 / Vitest ＋ fast-check / oxlint。PWA は vite-plugin-pwa / Workbox。フロントのユーザー向け表示は英語、コードコメントは日本語、Kiro 出力は日本語。
