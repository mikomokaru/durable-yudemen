# Requirements Document

## Introduction

厨房スタッフが画面を注視していなくても、ゆで麺タイマーの進行を「音」で把握できるようにする機能である。3 種類の音を扱う。

1. **タッチ反応音** — スロット操作やメニュー選択などの UI 操作に対する即時フィードバック音。
2. **プレアラート音** — 各 Timer の茹で上がり 1 分前（残り 60 秒）に鳴らす予告音。
3. **茹で上がり音** — Timer が茹で上がり（boiled）に達し、まだ消し込まれていないことを知らせる音。

茹で上がり音は「done 通知への一度きりの反応」ではなく、**未完了の茹で上がりが残り続ける限り鳴り続ける持続アラーム**である。すなわち、このデバイスの管理スロットに boiled（茹で上がり・未完了）な Timer が 1 つ以上存在する限り、一定間隔（5 秒）で繰り返し再生する。ユーザーが Complete（消し込み）または cancel を行い、管理スロットの boiled Timer が無くなったとき鳴動を止める。鳴動の主体は「未完了の茹で上がりが残っている」という事実であって個々の done 通知ではない。

本機能は **client 側の端の作用**であり、サーバの状態（SSOT）・状態遷移（`decide`）・ワイヤ表現（`TimerFact` / メッセージ型）には一切触れない（設計哲学「計算と作用の分離」「待つなら寝かせる、抱えると漏れる」）。再生すべきかどうかの判定は、サーバ状態と `endTime` からの**導出値**（残り時間・boiled 表示状態）および表示制御用のローカル情報の上だけで行い、残り時間・boiled 集合・「鳴らした事実」を状態へ昇格させない（設計哲学「導出値を状態に昇格させない」）。

音の対象は、**このデバイスが管理する担当スロット（Assigned_Slots）に属する Timer に限る**。プレアラート音・茹で上がり音のいずれも、担当外スロットの Timer に対しては鳴らさない。担当範囲（担当ユニット窓）は「これ以上分解できない事実＝設定」であり、Assigned_Slots はそこからの純粋導出にすぎない（`client/assignment.ts` の `slotsOfUnits` / `assignedTimers` / `unitsForCount`）。

対象実行環境は **iOS 上の PWA（standalone）**である。iOS の WebView は、ユーザー操作を起点としない音声の自動再生を制限するため、最初のユーザージェスチャを起点に音声出力を**解錠（unlock）**する必要がある。解錠前および非対応環境では、機能を停止させず**優雅に劣化**させる（`useWakeLock` の作用フックと同じ規律）。

iOS / PWA では、解錠後であっても音声が止まりうる複数の失敗モードが存在する。Web 調査により確定した代表的な失敗モードは次のとおりである——(a) バックグラウンド・画面ロックで音声セッション（Audio_Session）が **suspended** になり、前面復帰しても自動的には running へ戻らない、(b) 電話着信・他アプリの音声・アラーム等、アプリ制御外の要因でブラウザ判断により **interrupted** にされる、(c) 一部 iOS バージョンで resume が `InvalidStateError`（Failed to start the audio device）で失敗する、(d) Silent_Switch（サイレント / マナースイッチ）がハードウェア的に Web Audio をミュートする（Web 側から回避できないハードウェア制約）。本機能は、これらからの**自己回復を設計の中心に据える**——可視復帰やユーザージェスチャを起点とした **resume**、resume 失敗時の Audio_Session の**破棄・再生成と再ウォームアップ**、そして Done_Cue の **5 秒周期そのものを再生失敗・中断からの自己修復リトライの機会**として用いる（`useWakeLock` の「可視時のみ・前面復帰のたびに取り直す」規律に倣う）。

音声信頼性の主戦略は、バックグラウンド再生と戦うことではなく、**アプリを前面・画面点灯のまま維持する（Wake Lock）こと**である。前面・画面点灯を保つことで OS の音声制限（suspended 化・interrupted 化）に晒される機会そのものを最小化し、Cue が鳴る前提条件を成り立たせる。本機能はこの前面維持を既存の `useWakeLock`（`src/client/components/useWakeLock.ts`：可視時のみ取得・前面復帰のたびに取り直す・iOS 16.4+ 対応・非対応は優雅に劣化）に依拠し、音声信頼性が前面維持を前提に成り立つという**依存関係**を述べるにとどめる（Wake Lock 機能自体は本スペックで再実装しない）。これは「待つなら寝かせる、抱えると漏れる」（サーバ側 hibernation 規律）とは別レイヤの、client 端における「前面維持で OS の音声制限を最小化する」方針であり、両者を混同しない。

音声の警告は **best-effort** である。Silent_Switch（サイレント / マナースイッチ）のように、ハードウェアが鳴動を禁じる制約は Web 側から回避できない。ゆえに**正しさを音声に依存させない**。全ての Cue（Touch_Cue・Pre_Alert_Cue・Done_Cue）を一律 best-effort として扱い、音が鳴らない環境でも boiled の**視覚表示**（`slotDisplay.ts` の boiled）とカウントダウンが信頼できる正本として継続する。音声はあくまで強化であって視覚を消さない。Audio_Session の状態名（running / suspended / interrupted / closed）はプラットフォーム由来の語であり要件記述に用いる。

通知の二重発火防止（表示制御）は既存の `client/notification.ts` の冪等規律（`timerId` 基準・処理済み集合 `processedIds` による二重発火防止・done と cancelled の規律共有）が引き続き担う。一方、茹で上がり音の鳴動はワンショットの `markProcessed` ではなく **boiled 導出状態に基づく持続再生**である。Alarm は at-least-once であり同一 `timerId` の done が二度届きうるが、音が現在の boiled 集合の関数である以上、done 通知の重複は鳴動を二重化しない。

> 注: 本書に現れる `Audio_Cue_System` / `Touch_Cue` / `Pre_Alert_Cue` / `Done_Cue` / `Audio_Unlock` / `Audio_Session` / `Assigned_Slots` 等は、要件記述のために導入した概念名である。Audio_Session の状態名（running / suspended / interrupted / closed）はプラットフォーム由来の語であり使用してよいが、公開シンボル（型・関数・フック名など）の確定名は、命名規律（`naming.md`）に従い design / 実装フェーズでユーザー確認を経て決める。

## 非目標 / 制約（Non-Goals）

本スペックが**意図的に範囲外とする**事項を明示する。これらに主たる信頼性を依存させない。

- **主アラーム（Done_Cue）の鳴動を Web Push / Service Worker の背景通知に依存させない。** iOS PWA の Push は制約が厳しく、音も限定的で遅延も伴うため、麺の上げ忘れを防ぐ主たる信頼性の担保には用いない。主たる信頼性は、前面維持（Wake Lock）と可視復帰時の boiled 集合の再評価によって確保する。Web Push は将来的な保険レベルの位置づけであり、本スペックのスコープ外とする。
- **音声ガイド（読み上げ・speechSynthesis による発話）はスコープ外とする。** 本スペックが扱う音は「音（トーン）」のみであり、テキストの音声読み上げ・発話は対象としない。

## Glossary

- **Audio_Cue_System（音声キュー機構）**: client 側で音声出力を担う端の作用の単位。サーバ状態を変更せず、導出値とローカル情報のみに基づいて音を鳴らす。
- **Touch_Cue（タッチ反応音）**: UI 操作（タップ）に対する即時フィードバック音。
- **Pre_Alert_Cue（プレアラート音）**: Timer の残り時間が 60 秒に達したときに鳴らす予告音。
- **Done_Cue（茹で上がり音）**: 管理スロットに boiled な Timer が残る限り、一定間隔で繰り返し鳴らす持続アラーム音。
- **Done_Cue_Interval（茹で上がり音リピート間隔）**: Done_Cue を繰り返し再生する間隔。5 秒（5000 ミリ秒）。連続ループではなく間欠リピートである。
- **Audio_Unlock（音声解錠）**: iOS PWA の自動再生制限を、ユーザージェスチャを起点に解除し、以後の音声出力を可能にする状態遷移。
- **Audio_Session（音声セッション）**: client が音声出力に用いる音声処理コンテキスト（AudioContext を指す概念名）。状態 running / suspended / interrupted / closed を持つ。SSOT ではなく client の端の作用が抱えるローカルな実行資源であり、状態を SSOT へ昇格させない。
- **running（稼働中）**: Audio_Session が音声を再生可能な状態。
- **suspended（一時停止）**: バックグラウンド・画面ロック等で音声処理が止まった状態。前面復帰しても自動的には running へ戻らず、明示的な resume を要する。
- **interrupted（中断）**: 電話着信・他アプリの音声・アラーム等、アプリ制御外の要因でブラウザ判断により一時停止された状態。中断終了後に音声を再開するには Audio_Session の再アクティブ化（resume）を要する。
- **closed（終了）**: Audio_Session が破棄され再生不能になった状態。回復には新たな Audio_Session の生成を要する。
- **resume（再開）**: suspended / interrupted な Audio_Session を running へ戻す試行。ユーザージェスチャまたは可視化を起点に行う。
- **warm-up（ウォームアップ）**: ユーザージェスチャ内で Audio_Session を生成し、無音バッファを 1 回再生して running 状態へ遷移させる解錠手法。Audio_Unlock と Audio_Session 再生成後の回復で用いる。
- **Silent_Switch（サイレントスイッチ / マナーモード）**: iOS のハードウェアミュートスイッチ。有効時は Web Audio がミュートされ、Web 側から回避できないハードウェア制約である。
- **best-effort（最善努力）方針**: 音声の鳴動は環境が許す範囲で行う努力目標であり、正しさを音声に依存させない方針。音が鳴らない環境でも boiled の視覚表示（`slotDisplay.ts` の boiled）とカウントダウンを信頼できる正本として継続する。全ての Cue（Touch_Cue・Pre_Alert_Cue・Done_Cue）を一律 best-effort として扱う。
- **Wake_Lock（画面点灯維持）**: 既存の `useWakeLock`（`src/client/components/useWakeLock.ts`）が担う、可視時のみ取得し前面復帰のたびに取り直す画面点灯維持の作用。アプリを前面・画面点灯のまま保つことで OS の音声制限への露出を最小化する、音声信頼性の主戦略の前提。本スペックでは再実装せず依存するのみ。
- **Timer**: ゆで麺の計時単位。`id`（timerId）・`slotIds`・`noodleType`・`endTime` を事実として持つ（`TimerFact`、`domain/timer.ts`）。
- **endTime**: Timer の茹で上がり絶対時刻。事実（状態）であり、残り時間はここからの導出値。
- **remaining（残り時間）**: `endTime - now` で計算される導出値。状態ではない。
- **Pre_Alert_Threshold（プレアラート閾値）**: プレアラート音を鳴らす残り時間。60 秒。
- **Assigned_Unit_Window（担当ユニット窓）**: このデバイスが担当するユニットの連続窓（左アンカー b・長さ k）。viewport が k を決め、`unitsForCount`（`client/assignment.ts`）が導出する。担当範囲は設定であり事実。
- **Assigned_Slots（管理スロット / 担当スロット）**: 担当ユニット窓から導出される、このデバイスが表示・管理するスロット番号の集合（`slotsOfUnits`）。担当範囲からの純粋導出であり状態ではない。Timer の担当判定は any-overlap（`slotIds` のいずれかが Assigned_Slots に入れば担当対象）で、`assignedTimers` が射影する。
- **boiled（茹で上がり・未完了の導出状態）**: ある担当スロットの Timer が `endTime` ≤ 現在時刻に達し（remaining ≤ 0）、まだ Complete されていない表示状態（`slotDisplay.ts` の `SlotDisplay` の `kind: "boiled"`）。endTime（事実）と now からの導出値であり、状態へ昇格させない。
- **Complete（消し込み操作）**: ユーザーが boiled なスロットを完了させる操作。当該 Timer は completed として `view.timers` から除去され、当該スロットは idle になる。
- **processedIds（処理済み集合）**: done / cancelled を処理済みとして記録する `timerId` のローカル集合。通知の二重発火防止（表示制御）専用であり SSOT のコピーではない（`client/notification.ts`）。
- **done**: Timer が `endTime` 到達により完了した事実。サーバから broadcast される。
- **cancelled**: Timer がユーザー操作により取り消され、`view.timers` から除去された状態。
- **PWA standalone**: ホーム画面に追加され、独立ウィンドウとして起動した Progressive Web App の表示モード。

## Requirements

### Requirement 1: タッチ反応音

**User Story:** 厨房スタッフとして、操作したことが音で分かってほしい。画面を見続けなくても操作が受理されたと確信できるからだ。

#### Acceptance Criteria

1. WHEN ユーザーが再生対象として指定された UI 操作（タップ）を行う、THE Audio_Cue_System SHALL Touch_Cue を 1 回再生し、タップ受理から 100 ミリ秒以内に再生を開始する
2. WHILE Audio_Unlock が未完了である、THE Audio_Cue_System SHALL Touch_Cue を再生せずに当該 UI 操作の本来の動作を継続させる
3. IF Touch_Cue の再生がブラウザ制限または再生失敗により完了しない、THEN THE Audio_Cue_System SHALL ユーザーへエラー表示を行わず、当該 UI 操作の本来の動作を妨げずに継続させる
4. THE Audio_Cue_System SHALL Touch_Cue の再生をサーバ状態・状態遷移・ワイヤ表現の変更なしに行う
5. IF ユーザーが再生対象として指定されていない UI 操作（タップ）を行う、THEN THE Audio_Cue_System SHALL Touch_Cue を再生しない
6. WHEN 直前の Touch_Cue の再生完了前にユーザーが再生対象の UI 操作を再度行う、THE Audio_Cue_System SHALL Touch_Cue を先頭から再トリガして 1 回再生する

> **再生対象として指定された UI 操作（確定済み）:** Start ボタン押下（ラジアルメニューを開く操作）・麺種選択の確定（RadialMenu）・Cancel・Complete（消し込み）・茹で加減変更（FirmnessCornerControl の選択）。Start の「押下（開く）」と「麺選択の確定」は別タップであり、各タップに 1 回ずつ Touch_Cue が乗る。設定ポップオーバーの開閉や茹で加減メニューの開閉のみといった操作は指定外で、Touch_Cue を鳴らさない（要件1.5）。

### Requirement 2: プレアラート音（茹で上がり 1 分前）

**User Story:** 厨房スタッフとして、自分が担当するスロットの茹で上がりの 1 分前に音で予告してほしい。湯切りや盛り付けの準備に取りかかれるからだ。

#### Acceptance Criteria

1. WHEN Assigned_Slots に属するある Timer の remaining が Pre_Alert_Threshold（60 秒）超から 60 秒以下へ初めて遷移したことを検知する、THE Audio_Cue_System SHALL 当該 Timer に対して Pre_Alert_Cue を 1 回再生する
2. IF ある Timer が Assigned_Slots に属さない（担当外）、THEN THE Audio_Cue_System SHALL 当該 Timer に対する Pre_Alert_Cue を再生しない
3. THE Audio_Cue_System SHALL remaining を `endTime` と現在時刻からの導出値として算出し、remaining を状態として保持しない
4. WHILE Assigned_Slots に属するある Timer に対して Pre_Alert_Cue を既に再生済みである、THE Audio_Cue_System SHALL 当該 Timer に対する Pre_Alert_Cue の再生を行わない
5. IF Assigned_Slots に属するある Timer が表示に現れた時点で既に remaining が Pre_Alert_Threshold 以下（remaining ≤ 0 を含む）である、THEN THE Audio_Cue_System SHALL 当該 Timer に対する Pre_Alert_Cue を再生しない
6. WHERE ある Timer が cancelled である、THE Audio_Cue_System SHALL 当該 Timer に対する Pre_Alert_Cue を再生しない
7. THE Audio_Cue_System SHALL Pre_Alert_Cue の再生済み記録を `timerId` 基準の表示制御用ローカル情報として保持し、サーバ状態へ昇格させない
8. WHEN Assigned_Slots に属する複数の Timer が同時に Pre_Alert_Threshold への遷移を検知される、THE Audio_Cue_System SHALL 各 Timer に対して独立に Pre_Alert_Cue を 1 回ずつ再生する
9. WHEN Assigned_Slots に属するある Timer の remaining が Pre_Alert_Threshold への遷移を起こす、THE Audio_Cue_System SHALL 当該遷移の発生から 1 秒以内に Pre_Alert_Cue の再生可否を判定する
10. WHEN ある Timer が done または cancelled に遷移する、THE Audio_Cue_System SHALL 当該 Timer の Pre_Alert_Cue 再生済み記録を破棄する

### Requirement 3: 茹で上がり音（boiled 持続アラーム）

**User Story:** 厨房スタッフとして、自分が担当するスロットに上げ忘れの茹で上がりが残っている限り、音で鳴らし続けてほしい。麺を上げる瞬間を逃さず、消し込むまで気づけるからだ。

#### Acceptance Criteria

1. WHILE Assigned_Slots に boiled な Timer が 1 つ以上存在する、THE Audio_Cue_System SHALL Done_Cue を Done_Cue_Interval（5 秒）ごとに繰り返し再生する
2. THE Audio_Cue_System SHALL Done_Cue を鳴らすか否かを、現在の boiled 集合（`endTime` ≤ 現在時刻 かつ未 Complete の導出）の関数として判定し、done 通知の受信回数に基づかない
3. WHEN Assigned_Slots に boiled な Timer が未存在から 1 つ以上ありへ遷移する、THE Audio_Cue_System SHALL 当該遷移の検知から 1 秒（1000 ミリ秒）以内に最初の Done_Cue を再生する
4. WHEN ユーザーが Complete（消し込み）または cancel を行った結果、Assigned_Slots に boiled な Timer が 1 つも存在しなくなる、THE Audio_Cue_System SHALL Done_Cue の繰り返し再生を停止する
5. IF ある boiled な Timer が Assigned_Slots に属さない（担当外）、THEN THE Audio_Cue_System SHALL 当該 Timer を Done_Cue の鳴動判定に含めない
6. WHILE Assigned_Slots に複数の boiled な Timer が同時に存在する、THE Audio_Cue_System SHALL Done_Cue を Timer 件数に比例させず、Done_Cue_Interval ごとに 1 回の鳴動へ集約して再生する
7. WHEN 同一 `timerId` の done 通知が二度以上届く、THE Audio_Cue_System SHALL boiled 導出状態に基づき鳴動するため、done 通知の重複によって Done_Cue の鳴動周期を二重化しない
8. IF ある Timer が cancelled である、THEN THE Audio_Cue_System SHALL 当該 Timer を boiled として扱わず、当該 Timer に起因する Done_Cue を再生しない
9. THE Audio_Cue_System SHALL Done_Cue の鳴動主体である boiled 集合・残り時間・「鳴らした事実」を SSOT（サーバ状態）へ昇格させず、導出値と表示制御用ローカル情報のみに基づいて判定する
10. THE Audio_Cue_System SHALL 通知の二重発火防止（表示制御）を `client/notification.ts` の `timerId` 基準の冪等規律（`shouldHandleDone` / `markProcessed`）に委ね、Done_Cue の鳴動可否はワンショットの `markProcessed` ではなく boiled 導出状態に基づいて判定する
11. IF ある鳴動周期で Done_Cue の再生に失敗する、THEN THE Audio_Cue_System SHALL 当該失敗を握り潰さず、boiled な Timer が残る限り次の鳴動周期で再生を継続し、boiled 表示更新を継続する

### Requirement 4: iOS PWA における音声解錠（Audio_Unlock）

**User Story:** 厨房スタッフとして、iPad のホーム画面アプリでも音が鳴ってほしい。実機の運用環境が iOS PWA だからだ。

#### Acceptance Criteria

1. WHEN ユーザーが起動後またはリロード後の最初のジェスチャ（タップ）を行う、THE Audio_Cue_System SHALL Audio_Unlock を 1 回試行する
2. WHEN Audio_Unlock を試行する、THE Audio_Cue_System SHALL ユーザージェスチャ内で Audio_Session を生成し、無音バッファを 1 回再生する warm-up により Audio_Session を running 状態へ遷移させる
3. WHILE Audio_Unlock が未完了である、THE Audio_Cue_System SHALL Pre_Alert_Cue および Done_Cue を再生しない
4. WHEN Audio_Unlock が完了する、THE Audio_Cue_System SHALL 以後の Touch_Cue・Pre_Alert_Cue・Done_Cue を再生可能な状態にする
5. IF 実行環境が音声出力 API を提供しない、THEN THE Audio_Cue_System SHALL 音声再生を行わずに UI と Timer の動作を継続させる
6. IF Audio_Unlock の試行が失敗する、THEN THE Audio_Cue_System SHALL 次のユーザージェスチャを起点に Audio_Unlock を再試行する
7. THE Audio_Cue_System SHALL Audio_Unlock の完了状態をセッション内のローカル情報として保持し、サーバ状態へ昇格させず永続化しない

### Requirement 5: バックグラウンド・非可視時の優雅な劣化

**User Story:** 運用者として、アプリが背面や画面オフの状態で音が制限されても、復帰後に破綻しないでほしい。iOS の制限を抱え込みたくないからだ。

#### Acceptance Criteria

1. IF アプリが非可視（背面・画面オフ）の間に Pre_Alert_Cue または Done_Cue の再生条件が成立し、かつ環境が非可視時の再生を許可しない、THEN THE Audio_Cue_System SHALL 例外送出・クラッシュ・暗黙の無視を行わず、可視復帰時に再評価できる形で劣化する
2. WHEN アプリが非可視から可視へ復帰し、かつ Assigned_Slots に boiled な Timer が残っている、THE Audio_Cue_System SHALL 可視化の検知から 1000 ミリ秒以内に、Audio_Session が suspended または interrupted であれば resume を試みた上で（状態回復の詳細は Requirement 7）、Done_Cue の Done_Cue_Interval（5 秒）ごとの繰り返し再生を再開する
3. WHEN アプリが非可視から可視へ復帰し、かつ Assigned_Slots に boiled な Timer が 1 つも存在しない、THE Audio_Cue_System SHALL Done_Cue を再生しない
4. THE Audio_Cue_System SHALL 音声の再生可否・再生失敗を SSOT（サーバ状態）へ書き戻さない
5. WHILE アプリが非可視である、THE Audio_Cue_System SHALL UI 表示と Timer の動作を継続し、remaining を `endTime` からの導出値として 1000 ミリ秒以下ごとに再算出する
6. WHEN 可視復帰時に Assigned_Slots に複数の boiled な Timer が存在する、THE Audio_Cue_System SHALL Done_Cue を Timer 件数に比例して連続再生せず、Done_Cue_Interval ごとに 1 回の鳴動へ集約する
7. WHEN 可視復帰時に、非可視中に Pre_Alert_Threshold を跨いだが既に boiled となった Timer がある、THE Audio_Cue_System SHALL 当該 Timer の Pre_Alert_Cue を遡って再生せず、boiled 持続アラームとしての Done_Cue の鳴動のみを行う
8. THE Audio_Cue_System SHALL 音声信頼性の主戦略として既存の Wake_Lock（`useWakeLock`）による前面・画面点灯維持に依拠し、非可視化そのものへの露出を最小化する前提に立つ（Wake_Lock 機能自体は本スペックで再実装しない）
9. IF Wake_Lock が非対応または取得失敗により前面・画面点灯を維持できない、THEN THE Audio_Cue_System SHALL 例外を送出せず、可視復帰時の boiled 集合の再評価による Done_Cue の再開に依拠して優雅に劣化する

### （欠番）Requirement 6 — 削除済み: 音声の有効・無効切り替え

> 音声の有効・無効切り替え（アプリ内トグル）は不要と判断し、本要件を削除した。音声 3 種（Touch_Cue / Pre_Alert_Cue / Done_Cue）は常に best-effort で鳴り、アプリ内のミュート手段は持たない（ハードウェアの Silent_Switch のみがミュートしうる・要件7.9）。Requirement 番号は他ドキュメントの参照を壊さないため繰り上げず、欠番として残す。

### Requirement 7: 音声セッションの堅牢性と自己回復（Audio_Session Resilience）

**User Story:** 厨房スタッフとして、バックグラウンド復帰・着信・OS の音声中断のあとでも音が自動で復活してほしい。iOS の制約で音が止まったまま気づけないと、麺の上げ忘れにつながるからだ。

#### Acceptance Criteria

1. THE Audio_Cue_System SHALL Audio_Session の状態を running / suspended / interrupted / closed の観点で監視する
2. WHEN アプリが可視へ復帰し、かつ Audio_Session が suspended または interrupted である、THE Audio_Cue_System SHALL ユーザージェスチャまたは可視化を起点に Audio_Session の resume を試行する
3. WHEN Audio_Session が interrupted から復帰可能になる、THE Audio_Cue_System SHALL Audio_Session を再アクティブ化（resume）し、以後の Cue 再生を回復する
4. IF Audio_Session の resume が失敗する（`InvalidStateError` 等）、THEN THE Audio_Cue_System SHALL 現在の Audio_Session を破棄して新たな Audio_Session を生成し、次のユーザージェスチャで warm-up を行って回復を試行する
5. WHILE Assigned_Slots に boiled な Timer が残り Done_Cue を Done_Cue_Interval（5 秒）ごとに繰り返している、THE Audio_Cue_System SHALL 各鳴動周期の冒頭で Audio_Session の状態を確認し、suspended または interrupted であれば resume を試みた上で Done_Cue を再生する
6. THE Audio_Cue_System SHALL Done_Cue の Done_Cue_Interval（5 秒）ごとの繰り返しを Audio_Session の自己回復の機会として用い、再生失敗・中断からの自己修復リトライとして機能させる
7. THE Audio_Cue_System SHALL 音声の鳴動可否・Audio_Session の状態を SSOT（サーバ状態）へ書き戻さず、導出値と表示制御用ローカル情報のみに基づいて判定する
8. THE Audio_Cue_System SHALL 音声の警告を best-effort として扱い、boiled の視覚表示（`slotDisplay.ts` の boiled）とカウントダウンを Audio_Session の状態および音声の鳴動可否に依存させず常に継続する
9. WHERE 実行環境が Silent_Switch によりミュートしている、THE Audio_Cue_System SHALL Done_Cue および Pre_Alert_Cue が鳴らないことを既知の制約として受容し、例外を送出せず優雅に劣化し、boiled 表示とカウントダウンを継続する
10. WHEN Audio_Session の自己回復（resume・破棄と再生成・再 warm-up）を行う、THE Audio_Cue_System SHALL 当該回復をサーバ状態・状態遷移・ワイヤ表現の変更なしに client の端の作用として実行する
