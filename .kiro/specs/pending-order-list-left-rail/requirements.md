# Requirements Document

## Introduction

調理待ちオーダーの一覧を、画面上部の横帯から画面左の縦レールへ移す UX 改善である。

得るものは**待ちオーダーの可視件数**である。上部の横帯（Order_Band）は固定高の 1 段であり、件数が増えると横スクロールに逃げる。一度に見える件数はそこで頭打ちになる。一覧を左の縦レールへ移すと、縦方向の余りを可視件数へ変換できる。同じ画面で見える件数が増える。

払う代償は**釜カードの残り時間の文字寸法**である。レールは Board_Area の幅を割く。残り時間の文字寸法は釜カードの**幅**で決まるため、幅が減れば数字は小さくなる。この取引は避けられない。ゆえに縮みに下限（AC 2.2 の 80%）を設けて管理する。

### 文字寸法が幅で決まる根拠（調査済み）

`src/client/components/SlotCard.tsx` の `cardBase` は `@container` を持ち、釜カード自身をコンテナにしている。同ファイルの `timeBig` は `text-[clamp(2.7rem,35cqi,8.4rem)]` である。`cqi` はコンテナのインライン方向（＝幅）を基準にする単位であり、釜カードの高さを参照しない。

この帰結として、次の 2 点が事実である。

- 現行の上部横帯は Slot_Grid の**高さ**を奪うが、残り時間の文字寸法を 1px も縮めていない。
- 左レールは Board_Area の**幅**を奪うため、残り時間の文字寸法を直接縮める。

### 縮み幅の実測（概算）

`App.tsx` の `main` の左右 padding が `clamp(0.5rem,1.4vw,1rem)`、釜グリッドの gap が `clamp(0.75rem,1.8vw,1.375rem)`、`box-sizing: border-box`、root 16px として算出した、残り時間（分）の文字寸法である。

| 画面 | 列数 | レールなし | レール 8rem | レール 10rem |
| --- | --- | --- | --- | --- |
| iPad 横 1024pt（担当窓 k=2） | 計 4 列 | 約 82px | 約 70px（85%） | 約 67px（81%） |
| iPad 縦 768pt（担当窓 k=1） | 計 2 列 | 約 128px | 約 104px（81%） | 約 98px（76%） |

縦向きの 10rem は 76% となり AC 2.2 の 80% 下限を満たさない。8rem は縦横いずれも 80% 以上に収まる。ゆえに AC 2.2 の制約は 8rem 前後の固定幅を要求する見通しである。値の確定は design フェーズで行う（要件は制約と不変点だけを述べる）。

レール幅が狭いことで行内の切り詰めが増えることは受容する（AC 3.5 がこれを引き受ける）。

### 変更の範囲

本 spec が変えるのは**表示層の配置だけ**である。次はいずれも変えない。

- サーバ側の状態・永続・ワイヤ（`Pending_Order` 集合と `Cook_Recommendation` の配信形）
- engine の純粋変換（`decide`）
- client の純粋導出（到着順の並び・待ち時間の算出・担当範囲での提案の絞り込み）
- 提案の意味論（機械は開始を指示しない。`Suggested_Start` は提案であり、推奨開始時刻の到来では何も起きない）

### 現状（調査済み）

- 一覧は `src/client/components/OrderQueue.tsx` が `Order_Band`（`aria-label="Waiting orders"` の `section`、`flex-none` の固定高帯）として描く。行は横 1 列の `ul` で、`overflow-x-auto` により横スクロールする。
- `Order_Band` は `SlotBoard`（`src/client/components/SlotBoard.tsx`）が返す並びの中で、エラー帯の直後・`Slot_Grid` の直前に置かれる。`Board_Area`（`App.tsx` の `main`）は縦フレックスであり、`Slot_Grid` が残り高さを満たす。
- 表示内容の導出は `src/client/components/queueDisplay.ts` の `orderQueueEntries`（純粋関数）が済ませている。並び・待ち時間・提案の絞り込みはすべてここにあり、`OrderQueue.tsx` は導出済みの値を人が読む形へ写すだけを担う。
- `Pending_Order` 集合が空のとき `OrderQueue` は何も描かず、`Slot_Grid` が領域を全取りする。
- 茹で加減の表示語は `src/client/components/firmness.ts` の `FIRMNESS_LABEL`（日本語）である。`tests/offline-degradation.static.test.ts` が合意済みの調理母語として明示的に許可している。

### 確定した判断

以下はユーザー確認を経て確定した論点である。

1. **レール幅** — Board_Area の幅への比例をやめ、単一の固定値とする。従来の「Board_Area 幅の 25% 以下」「40rem 以上で 10rem 以上」という比例＋下限の規則は廃する。値は AC 2.2（残り時間の文字寸法を非表示時の 80% 以上に保つ）から design で導出する（8rem 前後になる見通し）。
2. **向きによる出し分け** — しない。画面の向きに関わらず左レールとする。
3. **レールの手動折りたたみ** — 設けない。
4. **`Suggested_Start` の最小可触寸法** — 2.75rem で確定する。
5. **公開シンボル名** — `OrderRail` / `OrderRow` で確定する。`Suggested_Start` に相当する独立した名は与えず、`OrderRow` 内の `button` に留める。
6. **Order_Row の文字寸法の下限** — 麺種 0.875rem 以上・その他 0.6875rem 以上で確定する。

## Glossary

- **Timer_Screen（店舗タイマー画面・概念名・仮）**: 店舗パス（`/s/{storeId}/`）の全画面 UI 全体。上端の Header_Bar と、その下の Board_Area からなる。
- **Header_Bar（上部固定バー）**: ロゴ・店舗識別・同期インジケータ・設定ボタンを収める、画面上端の固定高の領域。本 spec で変更しない。
- **Board_Area（盤面領域・概念名・仮）**: Header_Bar の下の残り領域全体。エラー帯・待ちオーダー一覧・Slot_Grid を収める器。
- **Order_Rail（待ちオーダーレール）**: 本 spec で新設する、Board_Area の**左端に置く縦方向**の調理待ちオーダー一覧領域。実装名は `OrderRail`。
- **Order_Band（待ちオーダー帯・現行）**: 移動前の、Board_Area の**上部に置く横 1 列**の調理待ちオーダー一覧。本 spec で Order_Rail に置き換えて廃する。
- **Order_Row（レール 1 行）**: Order_Rail 内の 1 件分の表示単位。1 件の Pending_Order の事実（麺種・茹で加減・卓番・待ち時間）と、提案がある場合の Suggested_Start を収める。実装名は `OrderRow`。
- **Slot_Grid（釜グリッド）**: 担当窓（Assigned_Unit_Window）のユニットを横並びにし、各ユニットを 2 列 × 3 行で等分充填する釜カードの領域。全カードがスクロールなしで収まることが既存の規律である。
- **Pending_Order（未着手オーダー）**: 既存語彙（`online-cook-scheduling`）。POS 由来の、まだ茹で始めていないオーダー品目。DO の永続層が正本（SSOT）。
- **Cook_Recommendation（開始推奨）**: 既存語彙（`online-cook-scheduling`）。Committed_Plan から導出される開始の提案。指示ではない。
- **Suggested_Start（提案からの開始操作・概念名）**: Order_Row 上の、Cook_Recommendation の内容（釜・開始時刻）を示し、押下でその内容の開始を送る操作。提案が揃った行にのみ現れる。独立したコンポーネント名を持たず、`OrderRow` 内の `button` として実装する。
- **Queue_Entry（待ち行列 1 行の表示状態）**: 既存の純粋導出 `orderQueueEntries` の出力要素（Pending_Order の事実・待ち時間・担当範囲内の提案）。本 spec で形を変えない。
- **Arrival_Order（到着順）**: 既存の並び規則（`arrivalTime` 昇順、次に `externalOrderId` 昇順、次に `itemIndex` 昇順）。端末間・再描画間で揺れない全順序。
- **Assigned_Unit_Window（担当窓）**: 既存語彙（`yude-men-timer`）。アンカー b と長さ k（縦向き = 1 / 横向き = 2）で定まる担当ユニットの集合。
- **FIRMNESS_LABEL（茹で加減の表示語）**: 既存の `src/client/components/firmness.ts` が持つ、茹で加減 id から日本語表示語（バリカタ／かため／ふつう／やわめ）への対応。合意済みの調理母語であり、英語化の対象外である。
- **Safe_Area_Inset**: iOS の `env(safe-area-inset-*)`。black-translucent 表示でコンテンツが隠れない余白。
- **Radial_Menu（ラジアルメニュー）**: 釜カードのタップで開く麺種選択のオーバーレイ。本 spec で挙動を変えない。

## Requirements

### Requirement 1: 一覧の配置を左の縦レールへ移す

**User Story:** 厨房スタッフとして、調理待ちオーダーの一覧を画面の左側で縦に見たい。上部の横帯は 1 段しかなく、待ちが増えると横スクロールの向こうへ隠れて一度に見える件数が頭打ちになるからだ。

#### Acceptance Criteria

1. THE Timer_Screen SHALL Board_Area を、左に Order_Rail・右に Slot_Grid を置く横並び 1 段の構成で組み、Order_Rail と Slot_Grid の上端および下端を揃える
2. THE Order_Rail SHALL Pending_Order 1 件を Order_Row 1 行として縦 1 列に並べ、Arrival_Order の n 番目の Pending_Order を上端から n 番目の Order_Row に置く
3. THE Timer_Screen SHALL 調理待ちオーダーの一覧を Order_Rail ただ 1 箇所に描き、Board_Area の上部に横 1 列の一覧（Order_Band）を描かない
4. WHILE Pending_Order 集合が空である、THE Timer_Screen SHALL Order_Rail を描かず、Board_Area の幅の全量を Slot_Grid へ与え、Slot_Grid の内容を画面左端の Safe_Area_Inset（`safe-area-inset-left`）の内側に収める
5. WHEN Pending_Order 集合が空から 1 件以上へ変化する、THE Timer_Screen SHALL 変化後の描画で Order_Rail を Board_Area の左端に表示し、Board_Area の幅から Order_Rail の幅を除いた残り幅の全量を Slot_Grid へ与える
6. WHILE Order_Rail が表示されている、THE Order_Rail SHALL Order_Row の内容を画面左端の Safe_Area_Inset（`safe-area-inset-left`）の内側に収める
7. THE Timer_Screen SHALL エラー帯を Board_Area の全幅で、Order_Rail と Slot_Grid の横並びより縦方向で上の段に置き、横並びに重ねない
8. THE Board_Area SHALL エラー帯の高さを除いた残り高さの全量を Order_Rail と Slot_Grid の横並びへ与え、Board_Area 自身に縦方向・横方向のスクロールを生じさせない

### Requirement 2: 領域配分と Slot_Grid の不変点

**User Story:** 厨房スタッフとして、レールに幅を割く代わりに釜の残り時間が小さくなるのは受け入れる。ただし小さくなる度合いに歯止めがほしい。残り時間は数歩離れた場所から読むもので、そこが崩れると本末転倒だからだ。

#### Acceptance Criteria

1. WHILE Order_Rail が表示されている、THE Order_Rail SHALL 自身の外形幅（Safe_Area_Inset の吸収分を含む）を、Board_Area の外形幅・Pending_Order の件数・Order_Row の内容のいずれにもよらない単一の固定値に保つ（端数丸めによる 1 ピクセル以内の差を許容する）
2. WHILE Order_Rail が表示されている、THE Slot_Grid SHALL 釜カードの残り時間の文字寸法を、同一の画面寸法・同一の Assigned_Unit_Window における Order_Rail 非表示時の同じ文字寸法の 80% 以上に保つ
3. WHILE Order_Rail が表示されている、THE Slot_Grid SHALL Assigned_Unit_Window の全釜カードの外形を自身の可視領域の内側に収め、縦方向・横方向いずれのスクロール可能領域も生じさせない
4. THE Slot_Grid SHALL 既存の配置規則（担当窓のユニットを等幅の列として横並び、各ユニットを 2 列 × 3 行の等分充填）を、Order_Rail の表示・非表示のいずれにおいても保つ
5. THE Timer_Screen SHALL Order_Rail の表示・非表示を Pending_Order 集合が空か否かのみで決め、Board_Area の幅・画面の向き・人の操作では切り替えず、Order_Rail を畳むための操作を設けない
6. THE Timer_Screen SHALL Header_Bar の高さ・内容・Safe_Area_Inset の吸収を、本変更の前後で同一に保つ
7. WHILE Order_Rail が表示されている、THE Slot_Grid SHALL Board_Area の幅から Order_Rail の外形幅を差し引いた残り全量を自領域として占める
8. WHEN Board_Area の幅が変化する（画面の向きの変更・表示領域の寸法変化を含む）、THE Timer_Screen SHALL Order_Rail の外形幅を変えず、変化後の Board_Area の幅から Order_Rail の外形幅を差し引いた残り全量を Slot_Grid へ与え直す

> **AC 2.1 と AC 2.2 の関係:** レール幅は Board_Area の幅に比例しない単一の固定値である（AC 2.1）。その固定値は AC 2.2 の 80% 下限から導出する。導出の実施と具体値の確定は design フェーズの仕事であり、AC には実装値を書かない。

### Requirement 3: レール内の 1 件の組み方

**User Story:** 厨房スタッフとして、縦に細いレールでも 1 件ごとの麺種・卓番・待ち時間が一目で読めてほしい。横帯のときと同じ事実が、詰まって読めなくなると困るからだ。

#### Acceptance Criteria

1. THE Order_Row SHALL 1 件の Pending_Order について、麺種・茹で加減・卓番・待ち時間の 4 つの事実を、この順序で 1 つの Order_Row の中に示し、待ち時間を移動前の Order_Band と同一の表記（分と秒）で示す
2. THE Order_Row SHALL 麺種の表示色を、Slot_Grid の釜カードが同一の麺種に用いる色と同一の値とし、Order_Rail 側に別の色の出所を持たない
3. IF Pending_Order が卓番を持たない、THEN THE Order_Row SHALL 卓番の表示を省き、残る 3 つの事実（麺種・茹で加減・待ち時間）を卓番を持つ場合と同一の順序・同一の行内位置に置き、Order_Row の高さを卓番を持つ場合と同一に保つ
4. THE Order_Row SHALL 自身の内容の描画幅を Order_Rail の内容幅（AC 2.1 で定まる固定幅から左右余白を除いた幅）以内に収め、Order_Rail と Timer_Screen のいずれにも横方向のスクロールを生じさせない
5. IF 麺種名または卓番の文字列が Order_Rail の内容幅に収まらない、THEN THE Order_Row SHALL その文字列を 1 行のまま切り詰めて末尾が省略されていることを示し、Order_Rail の横幅を広げず、横方向のスクロールを生じさせない
6. THE Order_Row SHALL 麺種の文字寸法を 0.875rem 以上に保ち、茹で加減・卓番・待ち時間の文字寸法を 0.6875rem 以上に保つ
7. THE Order_Rail SHALL 見出しに、自身が現在並べている Order_Row の件数と等しい数を示す
8. WHEN Pending_Order 集合が変化する、THE Order_Rail SHALL 見出しの件数を変化後の Order_Row の件数と一致させる
9. THE Order_Rail SHALL 見出し・提案の語を含む、本 spec で新たに書く自領域の固定文言をすべて英語で示し、麺種名・卓番のような Pending_Order 由来の値は受け取った値をそのまま示す
10. THE Order_Row SHALL 茹で加減の表示に既存の FIRMNESS_LABEL（合意済みの調理母語・日本語）の語をそのまま用い、Order_Rail 専用の別の茹で加減ラベルを持たない

### Requirement 4: 件数の溢れと全件への到達

**User Story:** 厨房スタッフとして、待ちが多いときも全件に手が届いてほしい。見えない件があると取りこぼすからだ。

#### Acceptance Criteria

1. WHILE 描画対象の Order_Row の総高が Order_Rail の可視高さを超えている、THE Order_Rail SHALL 自領域内の縦スクロールのみで、Arrival_Order の末尾の Order_Row の四辺すべてが可視領域に収まる位置まで到達可能にする
2. WHILE Order_Rail が縦スクロール可能である、THE Order_Rail SHALL 自領域のスクロールを Board_Area および Timer_Screen へ波及させず、Header_Bar と Slot_Grid の画面上の位置を変えない
3. THE Order_Rail SHALL 描画する Order_Row の件数を Pending_Order 集合の件数と常に等しく保ち、Cook_Recommendation の有無を並び順および表示可否の判断に用いず、Cook_Recommendation を持たない件も Arrival_Order の位置に並べる
4. WHEN Pending_Order 集合が変化する、THE Order_Rail SHALL 変化後の集合を Arrival_Order で並べ直して示し、描画する Order_Row の件数を変化後の件数に一致させる
5. WHEN Pending_Order 集合の変化により Order_Row が追加または除去される、THE Order_Rail SHALL 変化前の縦スクロール位置を保ち、変化後の内容で到達可能な最大位置を超える場合はその最大位置に留める
6. IF Order_Rail の縦スクロールが上端または下端に達した状態で同方向のスクロール操作が続く、THEN THE Order_Rail SHALL 自領域と Timer_Screen のいずれもスクロールさせず、Slot_Grid の位置と寸法を変えない
7. WHILE Order_Rail の縦スクロールが下端に達している、THE Order_Rail SHALL Arrival_Order の末尾の Order_Row の全体を画面下端の Safe_Area_Inset（`safe-area-inset-bottom`）の内側に収める

### Requirement 5: 操作性と既存の開始経路の維持

**User Story:** 厨房スタッフとして、レールに移っても提案からの開始が確実に押せてほしい。濡れた手や急ぎの手で狙いを外すと、間違った釜を動かすことになるからだ。

#### Acceptance Criteria

1. WHERE Order_Row が Cook_Recommendation を持つ、THE Suggested_Start SHALL 自身の可触領域の幅と高さをいずれも 2.75rem 以上に保ち、AC 2.1 で定まる Order_Rail の固定幅においてもこれを下回らせず、隣接する Order_Row の可触領域と重ならせない
2. WHERE Order_Row が Cook_Recommendation を持つ、THE Suggested_Start SHALL 推奨する釜の識別（推奨が複数の釜を含むときはその全て）と、推奨開始時刻を端末のローカル壁時計の時と分で示す
3. WHEN 人が Suggested_Start を押下する、THE Timer_Screen SHALL Order_Band からの押下と同一の内容（推奨する釜の全て・麺種・茹で加減から引いた茹で秒・対象品目の識別）で開始を送る
4. THE Timer_Screen SHALL Suggested_Start の文言に提案であることを示す語を含め、命令形の文言と自動開始を示唆する文言を置かない
5. THE Timer_Screen SHALL 推奨開始時刻の到来を契機とする動作を持たず、補正後現在時刻が推奨開始時刻を過ぎた後も、その推奨開始時刻をそのまま示し、Suggested_Start を押下可能に保つ
6. THE Timer_Screen SHALL 釜カードからの既存の開始経路（Radial_Menu）・キャンセル・完了・茹で加減変更について、操作手順・可触領域・表示のいずれも変更しない
7. WHILE Radial_Menu が開いている、THE Timer_Screen SHALL Order_Rail と重なる領域を含めて Radial_Menu の全体を Order_Rail より前面に描き、Radial_Menu の可触領域を Order_Rail に奪わせない
8. WHEN 人が Suggested_Start を押下する、THE Timer_Screen SHALL 釜カードからの開始と同一のタップ音を 1 回鳴らす
9. IF 対象品目の Cook_Recommendation について開始に要る事実（1 つ以上の釜・茹で秒・対象品目の識別）のいずれかが欠ける、THEN THE Order_Row SHALL Suggested_Start を描かず、Pending_Order の事実の表示を Arrival_Order の位置に保つ

### Requirement 6: 変更を表示層に閉じる

**User Story:** 開発者として、この配置変更がサーバの状態やワイヤや純粋導出に触れないでほしい。表示の話が状態の話へ漏れると、真実の源が増えるからだ。

#### Acceptance Criteria

1. THE Timer_Screen SHALL 本変更のために新しい保持値（可変状態・参照保持・常設タイマー）を client 側に追加せず、Order_Rail の表示・非表示と Order_Row の並びおよび各行の内容を、Pending_Order 集合・Cook_Recommendation 集合・現在時刻のみからの導出で決める
2. THE Timer_Screen SHALL 同一の Pending_Order 集合・Cook_Recommendation 集合・現在時刻に対して常に同一の Order_Rail 表示を示し、描画の回数・順序・直前の表示内容に依存する差異を生じさせない
3. THE Timer_Screen SHALL 既存の純粋導出（`orderQueueEntries`）の引数の個数・順序・型と、戻り値 Queue_Entry の 3 要素の構成（Pending_Order の事実・待ち時間・担当範囲内の提案）を変更しない
4. THE Timer_Screen SHALL Arrival_Order による並び・待ち時間の算出規則・担当範囲での提案の絞り込み規則を変更せず、`orderQueueEntries` の既存テストを 1 件も書き換えずに通す
5. THE Timer_Screen SHALL `src/domain`・`src/engine`・`src/shell` 配下のファイルとワイヤのメッセージ型に差分を生じさせず、本変更の差分を client の表示層に限る
6. THE Timer_Screen SHALL 待ち時間を保持値として持たず、`arrivalTime` と補正後現在時刻の差（下限 0・時計ずれで負となる場合は 0）として描画のたびに算出する
7. THE Timer_Screen SHALL 待ち時間の再算出を既存の 1 秒間隔の描画契機に相乗りさせ、待ち時間のための新しい常設タイマーを追加しない
8. WHEN サーバ由来の Pending_Order 集合または Cook_Recommendation 集合が置き換わる、THE Timer_Screen SHALL 置換後の集合のみから Order_Rail の表示を導出し、置換前の集合に由来する行・提案を残さない
9. IF Cook_Recommendation が担当範囲外である、または推奨する釜の集合が空である、または茹で秒を引けない、THEN THE Order_Row SHALL 提案なしとして描き、理由別の表示や理由を覚えるための保持値を持たない
10. THE Timer_Screen SHALL 釜カードの表示状態の既存の優先規律（running > boiled > idle）を変更せず、Order_Rail と釜カードの間に新しい重畳規則を持ち込まない
11. THE Timer_Screen SHALL Order_Rail の表示・非表示・スクロール位置を釜カードの表示状態の入力にしない

### Requirement 7: スタイルの規律とアクセシビリティ

**User Story:** 開発者として、この変更が既存のデザインシステムの外に出ないでほしい。色や寸法の出所が増えると、後から一箇所を触って全体を直せなくなるからだ。

#### Acceptance Criteria

1. THE Order_Rail SHALL 色・フォント・アニメーションを `src/client/styles.css` の `@theme` で定義済みのトークン（`--color-*` / `--font-*` / `--animate-*`）由来のユーティリティクラスからのみ引き、AC 7.2 の麺種色を除いて色値リテラル（16 進・`rgb()`・`hsl()`・`oklch()`）を Order_Rail の実装に置かない
2. THE Order_Rail SHALL インラインスタイルを麺種色を反映する色プロパティ 1 つに限り、余白・寸法・文字寸法・枠線・影・レイアウト・フォントを含むそれ以外のすべてのスタイルをユーティリティクラスで与え、状態や条件によるクラスの出し分けを `cn` で行う
3. THE Order_Rail SHALL 自領域を、待ちオーダーの一覧であることを示す英語ラベル（移動前の Order_Band と同一の語）を持つ領域として支援技術に提示し、その内側で Order_Row 群をリスト、1 件の Order_Row を 1 個のリスト項目として提示する
4. WHERE Suggested_Start が表示されている、THE Suggested_Start SHALL 支援技術へ渡す名前に、提案であることを示す語・推奨する釜の識別・推奨開始時刻を、可視表示と同一の語で含め、命令形の語と自動開始を示唆する語を含めない
5. THE Order_Rail SHALL 新しい `@keyframes` と新しい `--animate-*` トークンを定義せず、Order_Row の出現・消滅・並べ替え・スクロールに遷移効果を付けず、既存の点滅・グロー（`animate-boiled` / `animate-badge-blink`）を Order_Rail に用いない
6. THE Order_Row SHALL 文字色と直下の背景色のコントラスト比を 4.5:1 以上に保ち、麺種色で着色する麺種名にも同一の下限を適用する
7. THE Order_Rail SHALL 支援技術が読み取る Order_Row の順序を、可視表示の Arrival_Order の並びと一致させる
