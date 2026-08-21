# 先行実装調査 — boilit（forgevision 製）から仕様上参考になる事実（非規範）

> 本メモは要件・設計のいずれでもない**調査記録**である。対象: `~/github/boilit-api`（FastAPI + Redis）・`~/github/boilit-web`（React）。同一ドメイン（丸千代山岡家「Boil it!」ゆで麺タイマー）の先行実装。実質的な仕様は boilit-web の `.kiro/`（steering/specs）とコード・git log にあり、両リポジトリの `aidlc-docs/` は大半がテンプレ/プレースホルダで信頼度が低い。本メモは online-cook-scheduling を主対象とするが、client UX・Order_Ingress・operation-history-log にも波及する。

## A. 私たちの設計判断を裏付けるもの（先行実装に同型あり）

| 私たちの決定 | 先行実装の対応物 | 根拠 |
| --- | --- | --- |
| Cook_Recommendation（サーバ計算・空き釜へ提示・人が START で確定・自動開始しない） | `recommended_slot[]` / `recommended_order` をサーバが計算し、空きスロット枠内に食券番号・麺種をゴースト表示、人がタップで確定 | web: `TimerStage.tsx` / `InitialScreen.tsx` |
| 推奨の変動（churn）対策 | **前回推奨の粘着ルール**（未投入の前回推奨スロットは絶対に変更しない）＋ **前回とのマッチ率 80% 未満で結果ごと棄却** | api: `bedrock.py:471-796` |
| PLAN_TARGET_LIMIT による計画対象の打ち切り | 1 回の最適化出力をスロット数（バッチ上限）で打ち切り、以降は推奨なし | api: プロンプト規則 9 |
| baselineSchedule（到着順の貪欲・空き釜即割当） | ルールベースフォールバック: 時刻昇順→空きスロット番号順に slot_occupancy 個ずつ、足りなければ打ち切り | api: `bedrock.py:741-795` |
| slotRelease で boiled を解放済み扱い | 「提供済みを空きとして計算する」で確定（試行錯誤の跡がコメントに残る） | api: `ai_manager.py:299-306` |
| Boil_Sync（近接茹で上がりの同期） | 15 秒以内の goOff を単純平均へ丸め `multi=True`（PUT/PATCH 時のみ発火）。私たちの割合窓・maximin はこの一般化 | api: `state_transition.py:1061-1152` |
| ユニット= 3 行 × 2 列の物理配置・グリッド表示 | 1 ゆで麺機 = 3×2 の 6 スロット固定、店舗は 6/12/18/24 の 4 値、スクロール禁止 | web: `deviceRole.ts` / steering |
| ORDER_INGRESS_TOKEN（POS 認証） | 先行実装は **POS Webhook 認証ゼロ**（レビューで Critical 指摘）。後付け設計案は「API キー＋許可 IP・定数時間比較・失敗時は書き込まない」 | api: `lio_webhook.py` / `aidlc-docs/construction/lio-auth/` |
| 同卓（Table_Group）同時提供 | **未実装**（`table_no` は取り込むが未使用）。私たちの純粋な新規機能であることの確認 | api: grep 結果 |
| 同一オーダーの束ね | `order_items_no` 単位で複数スロットを PUT/PATCH/DELETE 一括操作 | api: `state_transition.py:597-643` |
| AI 推奨入出力の記録（simulation メモの発想） | 最適化の入出力ペアを S3 に全量保存（エラー時も。保存失敗は本処理に影響させない） | api: `optimization.py:140-193` |

## B. 仕様追補の検討候補（ユーザー判断が要るもの）

1. **slot_occupancy / 玉数（noodle_size 1.0/1.5/2.0）** — 大盛は 2 釜占有。空きが足りなければ部分割当せず待たせる。私たちの `Placement.slotIds` は複数 slot を表現できるが、**「この品目は k slot 必要」という事実の出所（PendingOrder か noodlePresets か）が未定義**。計画の feasibility に直結する。
2. **Pending_Order の時間失効** — 先行実装は多段の失効を実運用で必要とした: 受信 2 時間鮮度フィルタ / 未調理 2 時間で強制削除 / 全体 24 時間保持。「客が帰った・誤送信」で待ち行列が汚れる現実がある。私たちの spec はキャンセル到着以外に Pending_Order が消える経路を持たない。
3. **固さ（ゆで加減）は PLU オプション商品として POS から届く** — child_items の PLU → `boiltime_hard` 等へのマッピング表（OPTIONS マスタ・`offset_sec` 付き）。Order_Ingress の検証・変換（AC 1.4）の実装形に影響。
4. **boiltime_offset（店舗 × PLU × 固さの秒補正）** — 「同じ麺でも店舗の釜・火力で秒単位調整したい」が実要求（負は 0 クランプ）。noodlePresets の店舗別化で大半は覆えるが、固さ別オフセットの粒度は未対応。
5. **メンテナンスモード（釜の一時離脱）** — 釜掃除・湯替えでスロットを割当対象から外す。調理中なら「予約」して麺上げ後に自動移行。**計画の slot 可用性に直結**し、私たちのスケジューリングは全 slot 常時可用を仮定している。
6. **運用モード（職人 = 推奨なし / おまかせ = 推奨あり）** — 店舗単位・サーバ権威。職人へ切替時に推奨属性を全削除する明快な規則。私たちは推奨常時表示前提。
7. **麺仕込み数量の集計**（noodle_style 単位・未調理/調理中の玉数、0.5 刻み）—「あと何玉茹でるか」の現場要求。
8. **telemetry に actor（誰が操作したか）** — 先行実装の最大の欠落としてレビュー指摘。operation-history-log の Operation_Record は actor を持たない（既知属性は閉集合）→ あちらの改訂候補。

## C. client 実装フェーズの UX 参考（実運用でチューニングされた判断）

- **deviceRole（ビュー範囲 A/B/C/D/AB/BC/CD）**: 1 台の iPad が担当する釜を選び、**画面の向きで自動切替**（縦=1 機・横=2 機）。localStorage+sessionStorage 二重保存でタブ別ロール
- **SlotGrid ミニマップ**: 注文カード内に釜レイアウトの縮小図で「どの穴に入っているか」を示し、担当範囲外はステージ記号（A/B/…）のみ
- **リンクアルファベット**: 複数釜にまたがる 1 オーダーを鎖アイコン＋ A/B/C で結ぶ
- **+5 秒カウントダウン投入合図**: 投入時に茹で時間へ +5 秒し、その 5 秒を巨大数字で 5,4,3,2,1 表示 =「今入れろ」の秒合わせ。goOff が揃うので**タイムオーバーの一括クリア（goOff 完全一致で 1 タップ全上げ）**と対になる
- **確認 UI の使い分け**: 残り >60 秒の STOP のみ確認（インライン・モーダル禁止）、≤60 秒は即実行。削除は**確認ではなく 2 秒 Undo**（API を遅延実行し、カードが縮むアニメーションで猶予を可視化）
- **音**: 重要アラートは mp3 でなく **Web Audio 合成音**（iPad で mp3 再生が不安定・実障害起因）、音量 ×3.0、タイムオーバー音は 5 秒毎に永久リピートで**止める操作なし（麺を上げるしか止まらない）**、鳴動位相は絶対時刻基準（リロードで維持）、iOS 音声アンロック必須
- **HTTP 409 は無視**（マルチ端末の競合＝他端末が先に処理は正常系）
- **非対称権限**: 投入は全スロット可・取り出しは担当ビュー範囲のみ
- **hour_mask（時間帯別提供可否・24bit）に前後 15 分バッファ**（時報ちょうどの切替が現場で厳しすぎた）
- **「3 分半」丸め表記**（秒 OFF 時: <15 秒→N 分 / 15–44 秒→N 分半 / ≥45 秒→N+1 分、残り 60 秒未満のみ秒表示）
- 経過時間 3 段階カラー（<5 分緑 / 5–10 分黄 / ≥10 分赤）・ピンチ/ダブルタップ全面禁止・トーストは大幅削減済み（autoClose なし・同時 1 件）・TopBar に常設リロードボタン

## D. 反面教師（私たちの規律の正しさを示す欠陥）

- 茹で上がり時刻を**クライアントが計算して送る**（サーバ権威でない）→ 私たちは endTime サーバ権威で正しい
- 麺上げ DELETE を **2 回叩く**非冪等 API / 冪等キーなし / キャンセル・変更未実装
- **接続状態表示が未実装**（設計書には書いてあるのに）・WS 再接続 5 回で無音死
- read-modify-write レースで「消えない調理中」（CYMY-721）→ DO の単一実行で構造的に消える問題
- 同一マッピング表が 4 箇所に重複・Enum と生文字列の混在比較・仕様書と実装の乖離（音の実体・間隔）

## E. 主要参照パス

- web 仕様: `boilit-web/.kiro/steering/{product,domain,structure}.md`・`.kiro/specs/{timer,order,authentication}/`
- 推奨表示: `boilit-web/src/features/timer/components/TimerStage/TimerStage.tsx`
- スケジューリング規則: `boilit-api/app/infrastructure/bedrock.py:288-796`
- 同期調整: `boilit-api/app/core/state_transition.py:1061-1152`
- 総合レビュー: `boilit-api/aidlc-docs/reviews/11-agent-review-2026-06-25.md`
