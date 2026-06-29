# Requirements Document

## Introduction

本ドキュメントは、ラーメン店厨房向け「ゆで麺タイマー」パイロットの要件を定義する。麺を茹で始めるとタイマーが茹で時間をカウントダウンし、茹で上がり時刻に通知を発火する。本パイロットの主眼は、店舗内の複数 iPad（2〜3 台）が同一のタイマー状態をリアルタイムに共有することにある。クライアントのローカル状態だけでは複数デバイス共有が成立しないため、サーバ側（Cloudflare Durable Object）に状態の単一の正本を置く。

本パイロットは Cloudflare Durable Objects を用い、WebSocket Hibernation による省コスト常時接続、Alarm API による確実なタイマー発火、再接続時の状態同期、hibernate 復帰時の状態復元の各挙動を検証することを目的とする。対象範囲は 1 テナント・1 店舗のみであり、マルチテナント・調理順最適化・分析基盤連携・オフライン耐性・認証認可の作り込み・POS 連携は本 spec のスコープ外とする。なお WebSocket の同時接続数には人工的な上限を設けない。Durable Object は 1 インスタンスで多数のクライアント接続を収容でき、本パイロットの iPad は 2〜3 台にとどまるため、接続数上限はプラットフォーム制約としても運用上の必要としても存在しない（YAGNI）。

## Glossary

- **Store_Timer_DO**: 1 店舗あたり 1 インスタンスとして存在する Durable Object。店舗内の全タイマー状態の正本を保持し、WebSocket 接続の収容、Alarm によるタイマー発火、状態の永続化を担う。店舗 ID を名前として `getByName` で名前引きされる。
- **Worker**: Hono を用いた極薄のエントリポイント。HTTP リクエストを受けて対象の Store_Timer_DO に委譲し、WebSocket アップグレード要求を Store_Timer_DO に引き渡す。React フロントの静的アセットも同一 Worker（Workers Static Assets）から配信する。
- **iPad_Client**: 厨房に設置された iPad 上で動作する React フロント。サーバ状態を映す表示であり、残り時間の秒読みのみローカル計算する。
- **Slot**: 麺釜（ゆで釜）。スロット（Slot）と呼ぶ。1 店舗に複数（最大 18 個程度）存在し、各 Slot で独立にタイマーを走行させられる。0 始まりで採番され、連続する 6 スロットを 1 ユニット（Unit）として扱う。iPad の担当分割を述べる文脈でもこの Slot 語を用いる。
- **Unit**: 連続する 6 スロットのまとまり（unit 0 = slot 0-5、unit 1 = slot 6-11、unit 2 = slot 12-17）。iPad_Client への担当割り当ての単位であり、unit u は slot 6u 〜 6u+5 を含む。
- **Timer**: 1 つ以上の Slot 上で走行する 1 件のゆで麺タイマー。麺種と絶対終了時刻（endTime）を保持する。状態として **running**（走行中・endTime 未到来）と **boiled**（茹で上がり済み・ユーザーの明示完了待ち）を取る。boiled への遷移は Alarm 発火で起こり、boiled は明示完了（要件 15）まで集合に残る。running か boiled かは endTime と現在時刻から導出でき、ワイヤには status を乗せない（サーバ内部に発火事実を持つのみ）。
- **timerId**: 各 Timer を一意に識別する識別子。Store_Timer_DO が Timer 生成時に付与し、状態更新・茹で上がり・キャンセルの各通知に含めてクライアントへ伝える。同一 Slot 上で先行 Timer の完了後に新たな Timer を開始しても両者は異なる timerId を持つため、iPad_Client は timerId を基準として通知の重複を判定する。
- **endTime**: タイマーの絶対終了時刻。開始時刻に茹で時間を加えたエポックミリ秒で表現する。
- **Active_Timers_Snapshot**: 現在アクティブな全タイマーの集合を表すオブジェクト。永続層に単一キー（例: "activeTimers"）で丸ごと保存され、再接続時の同期にも使用される。スキーマバージョン番号を含む。
- **Alarm**: Durable Object Alarm API による発火機構。1 つの Durable Object は同時に 1 つの Alarm のみ保持できる。
- **Working_Copy**: Store_Timer_DO のメモリ上に保持するタイマー集合の作業コピー。hibernate により揮発する。永続層とは別物であり、同期は明示的な永続化操作によって行われる。
- **Hibernation**: WebSocket Hibernation API により接続を保持したまま Durable Object のメモリ状態を退避し、アイドル時のコストを抑える状態。
- **Rehydrate**: hibernate 復帰後など Working_Copy が未ロードの状態で、永続層の Active_Timers_Snapshot を読み出してメモリ作業コピーを再構築する操作。
- **Hydration**: iPad_Client が WebSocket を開いた直後に、現在アクティブな全タイマーのスナップショットを丸ごと受け取り、正しい状態へ追いつく操作。
- **許容誤差 ε**: Alarm の発火判定に用いる小さな時間的余裕。Cloudflare Durable Object の Alarm は at-least-once で起動するため、まれに複数回、また境界付近の時刻で起動されうる。境界に位置する Timer を取りこぼさず、多重発火に対しても冪等に一括処理するための許容窓として用いる（クロック境界に対する安全網も兼ねる）。本パイロットでは ε を 500 ミリ秒として扱う。
- **クロックオフセット**: iPad_Client が受信した serverTime（サーバ現在時刻）と、その受信時点のローカル時刻との差分。ローカル時刻を補正してサーバ基準の現在時刻を推定するために用いる。

## Requirements

### 要件 1: タイマー開始と全デバイスへの即時反映

**ユーザーストーリー:** 厨房スタッフとして、ある釜で麺の茹で始めにタイマーを開始したとき、店舗内の全 iPad に対象の釜・麺種・終了時刻が即時に反映されてほしい。これにより誰がどの iPad を見ても同じ茹で状況を把握できる。

#### 受け入れ基準

1. WHEN Slot 識別子・麺種・茹で時間を含むタイマー開始操作を受信したとき、THE Store_Timer_DO SHALL 当該 Slot の識別子・麺種・算出した endTime を持つ Timer を Working_Copy に登録する。
2. WHEN タイマー開始操作を受信したとき、THE Store_Timer_DO SHALL endTime を「操作受信時刻 + 指定された茹で時間（1〜1800秒の範囲内）」として絶対エポックミリ秒で算出する。
3. WHEN Timer を Working_Copy に登録したとき、THE Store_Timer_DO SHALL 接続中の全 WebSocket に対し、当該 Timer の Slot 識別子・麺種・endTime を含む状態更新を、登録完了から 1000 ミリ秒以内にブロードキャストする。
4. WHEN iPad_Client が状態更新ブロードキャストを受信したとき、THE iPad_Client SHALL 受信から 1000 ミリ秒以内に、当該 Slot のカウントダウン表示を受信した endTime に基づいて開始する。
5. IF タイマー開始操作に含まれる茹で時間が 1〜1800 秒の範囲外であるか、Slot 識別子または麺種が未定義の値である場合、THEN THE Store_Timer_DO SHALL 当該操作を拒否し、Working_Copy を変更せず、操作元へ拒否理由を示すエラー応答を返す。

### 要件 2: 茹で上がり時刻での通知発火

**ユーザーストーリー:** 厨房スタッフとして、茹で上がり時刻にタイマーが必ず通知を発火してほしい。Durable Object がアイドルで hibernate していても確実に発火してほしい。茹で上がった Timer は自動では消えず、私が明示的に消し込む（完了する）まで「茹で上がり（boiled）」として残ってほしい（消し込みは要件 15）。

#### 受け入れ基準

1. WHEN タイマーを開始したとき、THE Store_Timer_DO SHALL Alarm を走行中（running）の全 Timer のうち最も早い endTime に設定する。
2. WHEN 開始した Timer の endTime が現在設定中の Alarm より早いとき、THE Store_Timer_DO SHALL Alarm を当該 endTime に再設定する。
3. WHEN Alarm が発火したとき、THE Store_Timer_DO SHALL endTime が「発火処理時刻 + 許容誤差 ε」以下である走行中（running）の全 Timer を茹で上がり（boiled）として処理する。
4. WHEN Alarm 発火時に endTime が「発火処理時刻 + 許容誤差 ε」以下の走行中 Timer が 0 件であるとき、THE Store_Timer_DO SHALL 茹で上がり処理を行わず、走行中 Timer のうち最も早い endTime に Alarm を再設定する。
5. WHEN ある Timer を茹で上がりとして処理したとき、THE Store_Timer_DO SHALL 接続中の全 WebSocket に対し当該 Timer の茹で上がり通知（boiled）をブロードキャストする。
6. IF 茹で上がり通知のブロードキャストが失敗したとき、THEN THE Store_Timer_DO SHALL 当該 Timer を boiled として状態を保持し、失敗した通知の状態回復を要件 4 の再接続時 Hydration（全量スナップショット送信）に委ねる。
7. WHILE Store_Timer_DO が hibernate しているとき、THE Store_Timer_DO SHALL Alarm の発火を契機に起動し、alarm ハンドラを実行して該当 Timer の茹で上がり処理を行う（Cloudflare は alarm の at-least-once 起動を保証するが発火時刻からの遅延上限は公式には保証しないため、発火遅延が 30 秒以内に収まることはパイロットでの実測確認対象とする努力目標であり、保証値ではない）。
8. WHEN 茹で上がり処理を完了したとき、THE Store_Timer_DO SHALL 当該 Timer を除去せず、boiled（茹で上がり済み・明示完了待ち）として Working_Copy および Active_Timers_Snapshot に保持し続ける。除去はユーザーの明示完了（要件 15）でのみ行う。
9. WHEN 茹で上がり処理の完了後に走行中（running）の Timer が存在するとき、THE Store_Timer_DO SHALL Alarm を走行中 Timer のうち最も早い endTime に再設定する。boiled の Timer は endTime が過去ゆえ Alarm 対象に含めない（過去時刻 Alarm による無限再発火を防ぐ）。
10. IF Alarm 再設定時に算出した次回発火時刻が「現在時刻 + 許容誤差 ε」以下であるとき、THEN THE Store_Timer_DO SHALL 当該走行中 Timer の茹で上がり処理を即時に実行するか、Alarm を可能な限り早い時刻に設定して即時の再発火を促し、境界付近に位置する Timer の取りこぼしと、同一時刻群に対する再発火の無限ループを防止する。
11. WHEN iPad_Client が、自身の表示制御用記録に未登録の timerId を持つ茹で上がり通知（boiled）を受信したとき、THE iPad_Client SHALL アラーム音の再生など茹で上がりの提示を 1 回だけ行い、当該 timerId をアラート済みとして自身の表示制御用記録に登録する（Slot の茹で上がり表示そのものは endTime が現在時刻以下であることから導出する）。
12. IF iPad_Client が受信した茹で上がり通知の timerId が、既にアラート済みとして表示制御用記録に登録済みであるか、または既に表示から除去済みであるとき、THEN THE iPad_Client SHALL 当該茹で上がり通知を無視し、アラーム音の再生・通知表示の変更を行わない。
13. THE iPad_Client SHALL アラート済みの timerId の表示制御用記録を自身の表示制御のためにのみ保持し、当該記録によって Store_Timer_DO が保持する状態の正本を変更しない。

### 要件 3: 複数タイマー並走時の単一 Alarm 運用

**ユーザーストーリー:** 厨房スタッフとして、複数の釜で同時にタイマーを走らせたとき、それぞれが正しい時刻に発火してほしい。Durable Object が同時に 1 つの Alarm しか持てない制約下でも順序どおりに発火してほしい。

#### 受け入れ基準

1. THE Store_Timer_DO SHALL 同時に走行する複数の Timer を最大 100 件まで Working_Copy に保持する。
2. WHEN Working_Copy に複数の Timer が存在するとき、THE Store_Timer_DO SHALL Alarm を全 Timer のうち最も早い endTime（同一 endTime が複数ある場合は登録順が最も早い 1 件の endTime）に設定する。
3. WHEN Alarm の発火処理で endTime が「発火処理時刻 + 許容誤差 ε」以下の Timer を除去した後に残存 Timer が存在するとき、THE Store_Timer_DO SHALL Alarm を残存 Timer のうち最も早い endTime に再設定する。
4. WHEN Alarm の発火処理後に残存 Timer が存在しないとき、THE Store_Timer_DO SHALL Alarm を解除する。
5. THE Store_Timer_DO SHALL 最も早い endTime を Working_Copy 上の JavaScript 処理によって算出する。
6. WHEN 複数の Timer の茹で上がりを処理するとき、THE Store_Timer_DO SHALL endTime 昇順（同一 endTime の場合は登録順）で各 Timer を処理する。
7. IF Alarm の設定または解除操作が失敗したとき、THEN THE Store_Timer_DO SHALL Working_Copy の Timer 状態を保持し、操作失敗を示すエラーを返す。
8. IF 走行中の Timer が 100 件存在する状態でさらにタイマー開始操作を受信したとき、THEN THE Store_Timer_DO SHALL 当該操作を拒否し、Working_Copy を変更せず、上限超過を示すエラー応答を返す。

### 要件 4: 再接続時の状態同期（Hydration）

**ユーザーストーリー:** 厨房スタッフとして、iPad の WebSocket が一度切断され再接続したとき、その時点でアクティブな全タイマーの状態が復元され、カウントダウン表示が正しい残り時間に追いつくようにしてほしい。

#### 受け入れ基準

1. WHEN iPad_Client が WebSocket 接続を確立したとき、THE Store_Timer_DO SHALL 現在アクティブな全 Timer のスナップショットを当該 WebSocket に差分ではなく全量で、接続確立から 2 秒以内に送信する。
2. WHEN iPad_Client が全量スナップショットを受信したとき、THE iPad_Client SHALL 自身のタイマー表示を受信したスナップショットの Timer 集合へ完全に置き換える。
3. WHEN iPad_Client が各 Timer の endTime を受信したとき、THE iPad_Client SHALL 残り時間を「endTime - 現在時刻」として算出し、その結果をカウントダウン表示へ反映する。
4. IF 算出した残り時間が 0 秒以下である場合、THEN THE iPad_Client SHALL 当該 Slot の残り時間を 0 秒として表示し、カウントダウンを停止する。
5. IF 受信したスナップショットに含まれない Timer を iPad_Client が表示しているとき、THEN THE iPad_Client SHALL 当該タイマー表示を除去する。
6. IF iPad_Client が接続確立から 2 秒以内に全量スナップショットを受信できないとき、THEN THE iPad_Client SHALL 同期失敗を示すエラー表示を行い、既存の表示を保持したまま再接続を試行する。

### 要件 5: 切断中のカウントダウン表示継続

**ユーザーストーリー:** 厨房スタッフとして、WebSocket が瞬断している間も iPad のカウントダウン表示が止まらず継続してほしい。回線が不安定でも茹で残り時間を見失いたくない。

#### 受け入れ基準

1. WHILE iPad_Client の WebSocket が切断されているとき、THE iPad_Client SHALL 切断前に受信した endTime と、接続中に確立して保持した最新のクロックオフセットに基づき、残り時間を「endTime -（ローカル時刻 + クロックオフセット）」として 1000 ミリ秒以内ごとにローカル再算出し続ける。
2. THE iPad_Client SHALL 接続中に確立した最新のクロックオフセットを保持し、WebSocket 切断中は新規の serverTime を受信できないため、当該保持したクロックオフセットを使い続けて残り時間を算出する。
3. THE iPad_Client SHALL カウントダウンの残り時間表示をサーバへ問い合わせず、ローカル計算のみで更新する。
4. THE iPad_Client SHALL 残り時間を MM:SS 形式で最小単位 1 秒で表示する。
5. IF 切断時点で当該 Slot の endTime を未受信であるとき、THEN THE iPad_Client SHALL 当該 Slot を残り時間未受信である旨の表示に切り替える。
6. WHEN 残り時間がゼロ以下になったとき、THE iPad_Client SHALL 当該 Slot のカウントダウン表示を 00:00 に固定して茹で上がり相当の表示に切り替え、負の残り時間を表示しない。

### 要件 6: 走行中タイマーのキャンセル

**ユーザーストーリー:** 厨房スタッフとして、走行中のタイマーを途中でキャンセルできてほしい。キャンセルは全 iPad に反映され、該当タイマーは発火しないでほしい。

#### 受け入れ基準

1. WHEN ある Timer に対するキャンセル操作を受信し、かつ当該 Timer が Working_Copy に存在するとき、THE Store_Timer_DO SHALL 当該 Timer を Working_Copy から除去し、永続化された状態を更新する。
2. WHEN Timer をキャンセルにより Working_Copy から除去したとき、THE Store_Timer_DO SHALL 接続中の全 WebSocket に対し当該 Timer のキャンセルを 1000 ミリ秒以内にブロードキャストする。
3. WHEN キャンセル対象の Timer が Alarm 設定対象（最も早い endTime）であり、かつ残存 Timer が 1 件以上存在するとき、THE Store_Timer_DO SHALL 残存 Timer のうち最も早い endTime に Alarm を再設定する。
4. WHEN キャンセル対象の Timer が Alarm 設定対象（最も早い endTime）であり、かつ残存 Timer が 0 件であるとき、THE Store_Timer_DO SHALL 設定中の Alarm を解除する。
5. WHEN Timer をキャンセルしたとき、THE Store_Timer_DO SHALL 当該 Timer の茹で上がり通知を発火しない。
6. IF キャンセル操作を受信した Timer が Working_Copy に存在しない場合、THEN THE Store_Timer_DO SHALL Working_Copy を変更せず、キャンセル対象が存在しない旨を示すエラー応答を要求元に返す。
7. WHEN iPad_Client がキャンセルのブロードキャストを受信したとき、THE iPad_Client SHALL 当該 Slot のカウントダウン表示を 1000 ミリ秒以内に除去する。
8. IF iPad_Client が受信したキャンセル通知の timerId が既に表示から除去済みであるとき、THEN THE iPad_Client SHALL 当該キャンセル通知を無視し、カウントダウン表示および表示状態を重複して変更しない。

### 要件 7: Hibernate 復帰時の状態復元（Rehydrate）

**ユーザーストーリー:** システム運用者として、Durable Object が hibernate からの復帰でメモリ状態を失った後でも、永続層のスナップショットから全タイマーが復元され、Alarm が正しく再設定されてほしい。

#### 受け入れ基準

1. WHEN Store_Timer_DO の各エントリポイント（fetch / WebSocket メッセージ / alarm）が起動し Working_Copy が未ロードであるとき、THE Store_Timer_DO SHALL 本処理を開始する前に永続層から Active_Timers_Snapshot を読み出して Working_Copy を再構築する。
2. WHEN Working_Copy を永続層スナップショットから再構築し、かつ残存 Timer が 1 件以上存在するとき、THE Store_Timer_DO SHALL 残存 Timer のうち最も早い endTime に Alarm を再設定する。
3. WHILE Store_Timer_DO の初期化処理が進行中であるとき、THE Store_Timer_DO SHALL blockConcurrencyWhile により後続リクエストを待機させ、中途半端な状態を外部へ応答しない。
4. IF 永続層に Active_Timers_Snapshot が存在しないとき、THEN THE Store_Timer_DO SHALL 空の Working_Copy で初期化し、Alarm を設定しない。
5. IF 永続層からの Active_Timers_Snapshot の読み出しが失敗したとき、THEN THE Store_Timer_DO SHALL Working_Copy の再構築を確定せず、永続層を変更せず、初期化失敗を示すエラー応答を返す。
6. WHEN Working_Copy の再構築時に endTime が「現在時刻 + 許容誤差 ε」以下である Timer が存在するとき、THE Store_Timer_DO SHALL 当該 Timer を即時に茹で上がりとして処理する。
7. WHEN Working_Copy を再構築した結果、残存 Timer が 0 件であるとき、THE Store_Timer_DO SHALL 既存の Alarm を解除し、新たな Alarm を設定しない。

### 要件 8: 離散イベントごとの永続化（KV 方式）

**ユーザーストーリー:** システム運用者として、タイマー状態が開始・キャンセル・完了の各イベントで確実に永続化され、hibernate でメモリが揮発しても失われないようにしてほしい。

#### 受け入れ基準

1. WHEN タイマーの開始・キャンセル・茹で上がり（boiled への遷移）・明示完了（除去）のいずれかのイベントが発生したとき、THE Store_Timer_DO SHALL 同一イベント処理内で、更新後の Active_Timers_Snapshot 全体を単一の固定キーに対する storage.put により永続化する。
2. THE Store_Timer_DO SHALL タイマー状態の永続化および読み出しを Durable Object ストレージ API の KV 方式（storage.put / storage.get）のみで行い、SQL ストレージ API を使用しない。
3. THE Store_Timer_DO SHALL アクティブタイマー全体を 1 つの Active_Timers_Snapshot オブジェクトとして単一キーに丸ごと put / get する。
4. THE Store_Timer_DO SHALL Working_Copy へのメモリ上の代入を永続化操作とは独立に扱い、永続化は明示的な storage.put 呼び出しが正常完了した時点でのみ確定したものとみなす。
5. IF storage.put による永続化が失敗したとき、THEN THE Store_Timer_DO SHALL 当該イベントを失敗として呼び出し元に通知し、永続化失敗を示すエラー指示を返すとともに、永続化前の最新の Active_Timers_Snapshot を保持して部分的な書き込みを確定しない。
6. WHEN hibernate からの復帰後に最初のイベントを処理するとき、THE Store_Timer_DO SHALL storage.get により単一キーから Active_Timers_Snapshot を読み出し、Working_Copy を当該スナップショットの内容に復元する。
7. WHEN アクティブタイマー件数が 0 件になるイベント（最後のタイマーのキャンセルまたは完了）が発生したとき、THE Store_Timer_DO SHALL アクティブタイマー集合が空であることを表す Active_Timers_Snapshot を単一キーに対する storage.put により永続化する。

### 要件 9: WebSocket Hibernation による接続収容

**ユーザーストーリー:** システム運用者として、常時接続のコストを抑えつつ複数 iPad の接続を保持してほしい。アイドル時には hibernate し、メッセージ受信時に復帰してほしい。

#### 受け入れ基準

1. WHEN iPad_Client からの WebSocket アップグレード要求を受信したとき、THE Worker SHALL 店舗識別子に基づき対象の Store_Timer_DO に当該要求を引き渡す。
2. WHEN WebSocket 接続を収容するとき、THE Store_Timer_DO SHALL WebSocket Hibernation API（ctx.acceptWebSocket）により接続を受理する。
3. WHEN 収容済み WebSocket からメッセージを受信したとき、THE Store_Timer_DO SHALL webSocketMessage ハンドラで当該メッセージを 1 秒以内に処理する。
4. WHEN 収容済み WebSocket が閉じられたとき、THE Store_Timer_DO SHALL webSocketClose ハンドラで当該接続を接続管理対象から除去し、関連する一時状態を解放する。
5. THE Store_Timer_DO SHALL カウントダウンの秒読みを目的とした setInterval および終了しない setTimeout ループをメモリ常駐させず、時間管理を Hibernation 互換の手段（Alarm）で行う。
6. IF 受信したアップグレード要求が WebSocket アップグレードとして不正であるとき、THEN THE Worker SHALL 当該要求を Store_Timer_DO へ引き渡さず拒否する。
7. IF 収容済み WebSocket から不正な形式のメッセージを受信したとき、THEN THE Store_Timer_DO SHALL 当該メッセージを破棄し、Working_Copy を変更しない。

### 要件 10: 絶対終了時刻ベースの状態モデル

**ユーザーストーリー:** 開発者として、タイマー状態を残り秒ではなく絶対終了時刻で保持してほしい。これにより瞬断中もカウントダウンが継続でき、再接続時に正しい残り時間へ追いつける。

#### 受け入れ基準

1. THE Store_Timer_DO SHALL 各 Timer の状態を残り秒ではなく絶対終了時刻 endTime（協定世界時のエポックミリ秒、0 以上の整数）で保持する。
2. WHEN iPad_Client へ Timer の状態を送信するとき、THE Store_Timer_DO SHALL 残り時間を含めず、endTime（エポックミリ秒）と送信時点のサーバ現在時刻 serverTime（エポックミリ秒）を含めて送信する。
3. WHEN Timer の状態を受信したとき、THE iPad_Client SHALL endTime と serverTime の差分からローカル時刻とのクロックオフセットを算出して最新値として保持し、補正後の現在時刻（ローカル時刻 + クロックオフセット）と endTime の差として残り時間を算出する。なお当該保持したクロックオフセットは、要件 5-2 に従い WebSocket 切断中の残り時間算出にも継続して用いる。
4. IF 補正後の現在時刻が endTime 以上である場合、THEN THE iPad_Client SHALL 表示する残り時間を 0 とする。
5. WHILE Timer がカウントダウン中である間、THE iPad_Client SHALL 残り時間の表示を 1000 ミリ秒以下の間隔で再算出して更新する。
6. WHEN 瞬断後に iPad_Client が再接続したとき、THE iPad_Client SHALL 再受信した endTime と serverTime に基づき残り時間を再算出し、再接続完了から 1000 ミリ秒以内に表示へ反映する。

### 要件 11: 永続データのスキーマバージョン管理

**ユーザーストーリー:** システム運用者として、将来のスキーマ変更に備えて永続データにバージョン番号を持たせ、起動時に確認できる枠組みを用意してほしい。

#### 受け入れ基準

1. THE Store_Timer_DO SHALL Active_Timers_Snapshot を永続化する際に、1 以上の整数で表されるスキーマバージョン番号を含めて書き込む。
2. WHEN 永続層から Active_Timers_Snapshot を読み出したとき、THE Store_Timer_DO SHALL 読み出したデータからスキーマバージョン番号を取得し、現行バージョン番号と一致するか比較する。
3. IF 読み出したスキーマバージョン番号が現行バージョン番号より小さいとき、THEN THE Store_Timer_DO SHALL 当該データを現行バージョンへ移行する処理を実行し、移行後のデータを現行バージョン番号付きで永続化する。
4. IF 読み出したデータにスキーマバージョン番号が存在しないとき、THEN THE Store_Timer_DO SHALL 当該データを現行バージョンより前の旧データとして扱い、現行バージョンへ移行する処理を実行する。
5. IF 読み出したスキーマバージョン番号が現行バージョン番号より大きいとき、THEN THE Store_Timer_DO SHALL 移行処理を実行せず、未対応バージョンである旨を示すエラーを返し、読み出した元データを変更しない。
6. IF 移行処理が失敗したとき、THEN THE Store_Timer_DO SHALL 移行前の元データを保持したまま変更せず、移行失敗を示すエラーを返す。
7. THE Store_Timer_DO SHALL 現行スキーマバージョン番号を Active_Timers_Snapshot の構造拡張に伴って増加させる。slotIds の複数化を v2、boiled の発火事実（boiledAt）の追加を v3 とし、本パイロットの現行バージョン番号は 3 とする。旧版（v1 単一 slotId・v2 boiledAt 欠如）は移行時に現行へ写す（slotId→[slotId]、boiledAt 欠如→走行中=null）。

### 要件 12: iPad ごとのスロット担当（表示・操作範囲の分割）

**ユーザーストーリー:** 厨房運用者として、各 iPad に担当する範囲をユニット単位で割り当て、各 iPad が担当するスロット（釜）のみを表示・操作できるようにしてほしい。これにより 2〜3 台の iPad で店舗内の釜を分担して受け持ち、各端末の画面を担当範囲に集中させられる。

#### 受け入れ基準

1. THE iPad_Client SHALL ユーザー指定により 1 ユニット（6 スロット）または 2 ユニット（12 スロット）の担当ユニットを保持する。
2. WHEN iPad_Client が全量スナップショットまたは状態更新ブロードキャストを受信したとき、THE iPad_Client SHALL 受信した Timer 集合のうち担当スロットに属する Timer のみを表示対象とし、担当外スロットに属する Timer を表示対象から除外する。
3. THE iPad_Client SHALL タイマー開始操作およびキャンセル操作を担当スロットに対してのみ提供し、担当外スロットに対する操作手段を画面上に提示しない。
4. THE iPad_Client SHALL 担当範囲の更新をユーザーによる明示的な再指定の場合に限って行い、店舗内の WebSocket 接続台数の増減を契機とした担当範囲の変更を行わない。
5. WHERE スロット番号により担当範囲を表す場合、THE iPad_Client SHALL スロットの採番を 0 始まりとし、unit u の担当スロットを 6u から 6u+5 までの連続する 6 スロットとして解釈する。
6. THE Store_Timer_DO SHALL 担当分割に関与せず、全 Timer の全量スナップショット送信と接続中の全 WebSocket への全量ブロードキャストを維持し、接続ごとの担当状態を保持しない。
7. THE システム（Store_Timer_DO および iPad_Client 群） SHALL 担当ユニット割り当てにおける全スロットの被覆および担当の非重複を現場運用の責任に委ね、被覆および非重複をシステムによって強制せず、割り当ての整合性をシステムの保証範囲外として扱う。
8. IF どの iPad_Client も担当しないスロット（担当の穴）または複数の iPad_Client が同一スロットを担当する状態（担当の重複）が生じた場合、THEN THE Store_Timer_DO SHALL 当該の穴および重複から影響を受けず、全 Timer の正本の保持と接続中の全 WebSocket への全量ブロードキャストを維持する。
9. THE システム（Store_Timer_DO および iPad_Client 群） SHALL 担当の穴および担当の重複を iPad_Client の表示上の事象として扱い、その解消を現場運用における物理的な担当分担に委ねる。

### 要件 13: 茹で上がりの明示完了と直前結果の表示

**ユーザーストーリー:** 厨房スタッフとして、茹で上がった釜は自動で消えるのではなく、私が「完了（消し込み）」を押すまで茹で上がり表示のまま残ってほしい。完了した直後は、その釜で何を茹でていたか（直前の結果）が少しの間見えると、配膳や次の仕込みの確認に役立つ。

明示完了（complete）は走行中の中断（cancel・要件 6）とは別概念である。cancel は茹で上がる前の取り消し、complete は茹で上がった釜の確認消し込みであり、両者は別のワイヤメッセージ（cancelled / completed）として区別される。

#### 受け入れ基準

1. WHEN iPad_Client が boiled 状態の Slot に対するユーザーの完了操作を受け付けたとき、THE iPad_Client SHALL 当該 Timer の明示完了（complete）を Store_Timer_DO へ送る。WHILE 回線不通（degraded）であるとき、THE iPad_Client SHALL 当該 Timer をローカル表示から除去し、WebSocket へ送らない。
2. WHEN Store_Timer_DO が明示完了（complete）を受信したとき、THE Store_Timer_DO SHALL 当該 Timer を Working_Copy および Active_Timers_Snapshot から除去し、走行中（running）の Timer のうち最も早い endTime に Alarm を張り直し（走行中が 0 件なら Alarm を解除し）、接続中の全 WebSocket へ完了通知（completed）をブロードキャストする。
3. IF 明示完了の対象 Timer が Working_Copy に存在しないとき、THEN THE Store_Timer_DO SHALL Working_Copy を変更せず、対象が存在しない旨を示すエラー応答を要求元へ返す。
4. WHEN iPad_Client が完了通知（completed）を受信したとき、THE iPad_Client SHALL 当該 timerId を表示から除去し、当該 Slot を待機（idle）表示へ戻す。
5. WHEN ある Slot の Timer が明示完了で除去されたとき、THE iPad_Client SHALL 当該 Slot に直前の調理結果（麺種）を完了からおよそ 30 秒間ベストエフォートで表示し、その後通常の待機表示へ戻す。表示時間の制御はクライアント側で行う。
6. THE iPad_Client SHALL 直前の調理結果をクライアント保持のみのベストエフォート情報として扱い、Store_Timer_DO の状態の正本（SSOT）に持たせず、リロードや別端末との共有が失われることを許容する。
7. WHEN ある Slot で新たなタイマー開始が行われたとき、THE iPad_Client SHALL 当該 Slot の直前結果表示を解除する。
