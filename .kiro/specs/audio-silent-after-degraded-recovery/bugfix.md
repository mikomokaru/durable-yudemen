# Bugfix Requirements Document

## Introduction

縮退（degraded）状態から復旧した後、ユーザーのクリック（ジェスチャ）を 1 回挟むまで茹で上がり音（Done_Cue）が鳴らない不具合を修正する。

**観測された症状（手動 `pnpm dev` テスト）:**
タイマー投入 → サーバ down（縮退 / degraded）→ サーバ復旧、という流れの後、クリックを挟まないと音が鳴らない。ブラウザのタブはこの間ずっとアクティブ（バックグラウンドにしていない）。クリック（何らかのジェスチャ）を 1 回挟むと、以降は鳴る。

この不具合は、要件8「茹で上がりは回線状態に関わらずローカルで必ず一度鳴る」（`.kiro/specs/audio-cues/` の Done_Cue 持続アラーム、要件3.1 / 5.2）が期待する「回線状態に依らず自動で鳴り続ける」挙動を、復旧直後の窓で満たせていないことを意味する。厨房スタッフが復旧に気づかない限り Done_Cue が鳴らず、麺の上げ忘れにつながりうる。

> **⚠️ 根本原因は未確定（ROOT CAUSE UNCONFIRMED）。**
> 本ドキュメントは **RECORD-ONLY**（観測事実と文脈の記録）であり、単一の根本原因を断定しない。バグ条件は「内部の推定原因」ではなく **観測可能なふるまい** を基準に定義する。復旧の窓で Audio_Session（AudioContext）が何をきっかけに `running` を離れるのかは、コードだけからは判定できない（後述の「未解決の問い」）。確定には計装（instrumentation）による観測が必要である。design / tasks へは進まない。

本不具合の変更範囲は `src/client`（音声レイヤ）に限られる見込みで、engine / domain / ワイヤ表現は不変。関連スペック: `.kiro/specs/audio-cues/`（AudioContext ライフサイクル・`readyContext` の規律・要件1/3/4/5/7）、`.kiro/specs/offline-degradation/`（degraded↔live 復旧）。

## Bug Analysis

### 検証済みの観測事実（コード由来・ふるまいの裏付け）

以下は `src/client/components/useAudioCues.ts` / `src/client/components/audioTone.ts` / `src/client/App.tsx` を読んで確認できる **検証可能な事実** であり、バグ条件の裏付けとして記録する（原因の断定ではない）。

- 音声は単一の Web Audio AudioContext（Audio_Session）に一本化されている。「鳴らせるか」は保持されず、鳴らす直前に `readyContext(allowCreate)` が `ctx.state` をライブに読む。
- AudioContext が **生成される**のはユーザージェスチャ経路（`allowCreate=true`）に限られる——`playTouchCue()` と、`UNLOCK_EVENTS`（`touchstart` / `touchend` / `click` / `keydown`）のジェスチャリスナ（`onGesture`）だけ。毎秒の評価ティック（`tick`）と `visibilitychange` ハンドラは `readyContext(false)` を呼び、AudioContext を生成しない。
- `ctx.state !== "running"` のとき `readyContext` は `ctx.resume()`（投げっぱなし）を呼ぶが `null` を返す（その回は鳴らさない）。ユーザージェスチャの外で呼ばれた `resume()` は一部ブラウザで無視 / 遅延される（コード内コメント: iOS はジェスチャ内で生成 / resume された context しか running へ上げられない）。
- 帰結（検証可能）: AudioContext が一度 `running` を離れると、非ジェスチャ経路（`tick`、`visibilitychange` → `readyContext(false)`）はそれを確実には `running` へ戻せない。確実に resume できるのはユーザージェスチャ（`onGesture` / `playTouchCue` → `readyContext(true)`）だけである。これは観測された「クリックで音が復活する」と整合する。
- `useAudioCues` は App ルートで 1 回だけマウントされ、効果の依存配列は実質 `[]`（接続状態や degraded↔live の変化で **再マウントしない**）。`sessionRef`（AudioContext）は復旧を跨いで保持される。よって「再マウントで context が閉じる」説明は原因では **ない**。

### Current Behavior (Defect)

縮退（degraded）から復旧した後、タブがアクティブなまま、boiled な Timer があっても Done_Cue が鳴らない。以降のユーザージェスチャ（クリック）1 回で初めて音声が復活する。

1.1 WHEN タイマー投入 → サーバ down（degraded）→ サーバ復旧、の後、タブがアクティブなまま Assigned_Slots に boiled な Timer が残っている、THEN the system は Done_Cue を Done_Cue_Interval（5 秒）ごとに鳴らさず、復旧の窓で無音のままになる
1.2 WHEN 上記の無音状態でユーザーが何らかのジェスチャ（クリック等）を 1 回行う、THEN the system はその時点から以降 Done_Cue を鳴らすようになる（＝音声の復活にユーザージェスチャを要する）

### Expected Behavior (Correct)

2.1 WHEN タイマー投入 → サーバ down（degraded）→ サーバ復旧、の後、タブがアクティブなまま Assigned_Slots に boiled な Timer が残っている、THEN the system SHALL ユーザージェスチャを要さずに Done_Cue を鳴らす（もしくは非ジェスチャで安全に Audio_Session を確実に再アーム（re-arm）する経路を通じて自動で鳴らす）。これは要件8「茹で上がりは回線状態に関わらずローカルで必ず一度鳴る」（要件3.1 / 5.2）と整合する
2.2 WHEN 復旧後に音声が鳴らない状態が生じうる場合、THEN the system SHALL 追加のユーザージェスチャなしに回復するか、回復にジェスチャが必要な環境（iOS の制約等）では利用者が復旧に気づける最小限の非侵襲な手段を通じて回復可能にする

2.3 WHEN 音声が鳴らせない可能性がある（AudioContext が存在しない、または `ctx.state !== "running"`）とライブ導出で判定され、かつ鳴らすべき対象（boiled もしくは直近予告）が存在する（degraded 復旧に限らず、リロード直後・バックグラウンド復帰・OS 割り込みなど「音が出ない可能性がある」任意の状況を含む）、THEN the system SHALL 非侵襲な「音声再有効化アフォーダンス」（sound re-enable affordance）を提示し、そのタップがユーザージェスチャ内で Audio_Session を再アーム（必要なら生成・`resume`）する唯一確実な解錠点として機能する。厳密な可聴性（音量・ミュート・ハード出力）は検知できないため、UI 文言は可聴性を保証しない非保証表現（例:「音が出ないかもしれません。タップで有効化」に類する表現）とする

### Unchanged Behavior (Regression Prevention)

3.1 WHEN 起動 / リロード後の最初のジェスチャで Audio_Unlock を行う、THEN the system SHALL CONTINUE TO 従来どおりジェスチャ内で AudioContext を生成・warm-up し解錠する（iOS の解錠規律 = ジェスチャ内で生成 / resume した context のみ確実に running、を崩さない・要件4）
3.2 WHEN いずれかの Cue の再生に失敗する、THEN the system SHALL CONTINUE TO best-effort として失敗を握り潰し、UI 操作・Timer 進行・視覚正本を妨げない（要件1.3 / 3.11 / 7.8）
3.3 WHEN 音声の再生可否や Audio_Session の状態が変化する、THEN the system SHALL CONTINUE TO それらを SSOT（サーバ状態）・永続へ書き戻さない（要件4.7 / 5.4 / 7.7）
3.4 WHEN degraded / 復旧を含む任意の回線状態にある、THEN the system SHALL CONTINUE TO boiled 表示・カウントダウン（視覚正本）を音声状態に依存させず継続する（要件7.8）
3.5 WHEN 変更を加える、THEN the system SHALL CONTINUE TO 変更を `src/client`（音声レイヤ）に閉じ込め、engine / domain の契約・ワイヤ表現を変えない

3.6 WHEN 音声再有効化アフォーダンスを導入する、THEN the system SHALL CONTINUE TO 現行 `useAudioCues` の規律（鳴らす直前に `ctx.state` をライブに読む・「解錠済み」等の永続 / 保持フラグを持たない）を維持し、アフォーダンスの表示要否も `ctx.state` からのライブ導出とする（導出値を状態に昇格させない）

### バグ条件と性質（構造化擬似コード）

バグ条件 C(X) は **観測可能 / ふるまい基準** で定義し、未検証の内部原因を符号化しない。

```pascal
FUNCTION isBugCondition(X)
  INPUT: X = degraded→live 復旧直後の Done_Cue 発火機会における音声サブシステムの状態
          （タブはアクティブ / 前面のまま）
  OUTPUT: boolean

  // 復旧後、Audio_Session が "running" でなく（＝tick / 可視復帰では鳴らせない）、
  // かつ復旧以降まだユーザージェスチャが発生しておらず、
  // Assigned_Slots に boiled な Timer が残っている状態を「バグ条件」とみなす。
  RETURN afterDegradedRecovery(X)
     AND audioSessionState(X) <> "running"
     AND noUserGestureSinceRecovery(X)
     AND hasBoiledTimer(X)
END FUNCTION
```

```pascal
// Property: Fix Checking — 復旧後はジェスチャなしで Done_Cue が鳴る
FOR ALL X WHERE isBugCondition(X) DO
  // F' は修正後の音声サブシステム
  ASSERT eventually_within(Done_Cue_Interval, DoneCueRings(F', X))
      OR nonIntrusiveRecoveryAffordanceOffered(F', X)  // iOS 制約下で回復にジェスチャを要する場合の代替
END FOR
```

```pascal
// Property: Preservation Checking — 非バグ入力では従来と同一のふるまい
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)   // F = 修正前 / F' = 修正後
END FOR
```

- **F**: 修正前の音声サブシステム（現状のコード）
- **F'**: 修正後の音声サブシステム
- **Counterexample（観測された再現）**: タイマー投入 → サーバ down（degraded）→ サーバ復旧 → タブは前面のまま。boiled になっても Done_Cue が鳴らず、クリックを 1 回挟むと以降鳴る。

---

## 補足 — 後続調査への申し送り（未確定・RECORD-ONLY）

> 以下は resume 時の調査を助けるための **記録メモ** であり、原因の断定でも設計判断でもない。design / tasks では改めて検討する。

### 未解決の問い（コードだけでは判定不能・正直に unknown と記す）

タブがアクティブ（前面）のまま、degraded→復旧の窓で **何が AudioContext を `running` から離脱させるのか** はコードから判定できない。候補仮説（断定しない・列挙のみ）:

- (a) 長い無音期間の後に自動 suspend が起きる
- (b) ブラウザ / iOS の "interrupted" / suspended 遷移
- (c) 再接続処理中の何らかの間接的なインタラクション

確認には計装（instrumentation）による観測が必要。

### 推奨計装（実装ではなく、将来の調査のための記録）

- `ctx.state` の遷移を時系列でログする（各 `tick` および emit / `readyContext` の各回）。
- degraded→live 復旧の瞬間にマーカーを打つ。
- これにより「AudioContext が `running` を離れる **いつ / なぜ**」を捕捉する。

### 候補となる修正方向（RECORD-ONLY・実装 / 詳細決定は design で行う）

ユーザー確認済みの **主たる修正方向** は、**音声再有効化アフォーダンス（sound re-enable affordance）** を本 bugfix スペック内で恒久の安全網として導入することである（別スペックには切り出さない）。degraded 復旧に限らず、リロード直後・バックグラウンド復帰・OS 割り込みなど「音が出ない可能性がある」任意の状況に一様に効く汎用の安全網として位置づける（要件 2.3）。特に、リロード後に走行中 / 茹で上がりの Timer があるが、まだユーザージェスチャが無く音声が未解錠のケースに対しても有効な保険となる。

以下の設計ガードレールを記録する（design で確定する）:

1. **検知は「鳴らない可能性」をライブ導出で判定する。** AudioContext が存在しない、または `ctx.state !== "running"`（`suspended` / `interrupted` / `closed` / 未生成）を「音が出ない可能性」の判定に用いる。厳密な可聴性（音量・ミュート・ハード出力）は検知できないため、UI 文言は非保証の表現（「音が出ないかもしれません。タップで有効化」に類する）とする。
2. **導出値を状態に昇格させない。** 「解錠済み」等の永続 / 保持フラグを新設しない。現行 `useAudioCues` の規律（鳴らす直前に `ctx.state` をライブに読む・解錠フラグを持たない）を維持し、アフォーダンスの表示要否も `ctx.state` からのライブ導出とする（要件 3.6）。
3. **回復はユーザージェスチャで行う。** iOS 制約上、`suspended` を確実に `running` へ戻せるのはジェスチャ内の `resume`（＋必要なら生成）だけ。アフォーダンスのタップがその唯一確実な解錠点になる（既存 `onGesture` / `playTouchCue` → `readyContext(true)` の経路と同じ）。iOS の解錠規律（ジェスチャ内で生成 / resume した context のみ確実に running）を後退させない（要件 3.1）。
4. **非侵襲・誤発火抑制。** ブロッキングな全画面モーダルより、タップ可能なバナー / トースト等の非侵襲な提示を優先する（厨房で画面を塞がない）。表示は debounce し、非 `running` が一定時間継続し、かつ鳴らすべき対象（boiled もしくは直近予告）が存在するときにのみ提示する（過剰な催促を避ける）。ブロッキング UI にするかは design で確定してよいが、非侵襲を既定方針として記録する。
5. **根本原因は依然未確定。** このアフォーダンスは恒久の安全網であり、degraded 復旧で context が `running` を離れる根本原因の解明（`ctx.state` 遷移の計装・上記「推奨計装」）を **置き換えない**。順序としては、まず計装で原因を確認し、原因側の修正が可能ならそれも別途行う。アフォーダンスは原因が確定していなくても成立する安全網として先行しうるが、計装による原因調査を免除しない。
6. **適用範囲。** degraded 復旧に限らず、リロード直後・バックグラウンド復帰・OS 割り込みなど「音が出ない可能性がある」任意の状況に一様に効くこと（汎用の安全網）。

補助的な検討（従属・任意）:

- より多くのシグナルで `resume` を試みる案 — ただしガードレール 3（iOS の解錠規律を後退させない）を尊重し、非ジェスチャ経路での確実な回復を主張しない。
