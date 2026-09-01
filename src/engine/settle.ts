// engine/settle.ts — 集合変更後の全体再同期と Effect 列組み立てを一箇所へ畳み込む純粋ヘルパ。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// start / cancel / complete / fire / adjust の各遷移は「基底の集合変更」までを担い、その後の
// 「running の全体再同期 → 確定結果の no-op 検出 → Persist 先頭の Effect 列」を settle に委ねる。
// 再同期・no-op 規律・Effect 列の順序を二度書けば二つの真実になるため、この後段をここ一箇所に集約する。
//
// 不変条件（SSOT 規律）: 確定結果が直前と変わるときのみ Effect を出し、その列は必ず Persist が先頭。
// 確定結果が直前と同一なら put も broadcast もしない（要件7.7）。
//
// 調理順スケジューリングが足したのは 3 点。確定結果に Pending_Order 集合と採用済み PlanSlice 列を加え、
// snapshot に確定計画からの推奨を同乗させ、外部計画を要求してよいかの旗（mayRequestPlan）を受ける。
//
// snapshot の組み立て（toWireSnapshot）は公開する。確定変化の broadcast と接続直後の hydration が同じ形を
// 送るための唯一の射影であり、shell が自前で組めば待ち行列と推奨が経路ごとにずれる（AC 2.4 が破れる）。
// Boil_Sync（synchronize）の入力と計算規律は一切変えない（AC 9.2 / 9.4・検証は Property 14）。

import type { EpochMillis } from "./types";
import type { TimerState } from "./state";
import type { Timer } from "./timer";
import type { Outcome, Effect } from "./effect";
import { synchronize } from "./sync";
import type { SyncParams } from "./sync";
import { toSnapshot } from "./snapshot";
import { nextAlarmEffect } from "./alarm";
import { toWireTimer } from "./project";
import { committedSchedule } from "./commit";
import { recommend } from "./recommend";
import { isSamePending } from "./pending";
import { digestInput, type InputDigest } from "./digest";
import type { ScheduleParams } from "./objective";
import { planTargets, type AcceptedSlice, type Placement } from "./schedule";
import type { PendingOrder } from "../domain/order";
import type { NoodlePreset } from "../domain/store";
import type { ServerMessage } from "../domain/messages";

/**
 * SettleParams — settle（と decide）が要する値の束。
 *
 * Boil_Sync の 2 値（SyncParams）と計画の採点の 8 値（ScheduleParams）に、麺プリセットを足した形。
 * 意味を定めるのは各モジュール（sync.ts / objective.ts）であり、ここはそれらの合成でしかない
 * ——同じ値の意味を二箇所で語らないため、フィールドを列挙し直さず継承で組む。
 *
 * **design の署名からの追加が 1 つある。** design は「SyncParams ＋ ScheduleParams」と定めるが、
 * 確定計画の合成（committedSchedule → baselineSchedule）は茹で時間を引くために麺プリセットを要する
 * （タスク 9.1 / 11.1 の判断）。採点には要らないため ScheduleParams へは混ぜられず、かつ settle の
 * 引数を 1 本増やすと全遷移の署名が二つの束を運ぶことになる。ゆえに settle が要する束の側へ足す。
 */
export interface SettleParams extends SyncParams, ScheduleParams {
  /** 麺種ごとの硬さ別茹で時間。startAt と serveAt を結ぶ唯一の値（StoreConfig と同名・同形）。 */
  readonly noodlePresets: readonly NoodlePreset[];
}

/**
 * 集合変更後の共通後処理（全体再同期＋no-op 検出＋Effect 列組み立て）。
 *
 * running のみ synchronize で Adjustment を全体置換し、boiled は据え置く（発火時の調整を凍結保持）。
 * 確定結果（Timer 集合・Pending_Order 集合・採用済み PlanSlice 列）が直前と同一なら Effect を出さず
 * 状態も prev へ戻す。変化があれば Persist を先頭に、SetAlarm|ClearAlarm（実効最早）・全量 snapshot
 * Broadcast（待ち行列と推奨を同乗）の順で Effect 列を組み、要求を出す遷移では末尾に RequestPlan を積む。
 *
 * **要求は確定変化に相乗りする。** 抑制の判定（指紋の一致）は no-op 検出の**後**に置く。指紋だけが変わった
 * 遷移（確定結果は同一）で要求を出すには新しい指紋を永続する必要があり、それは「確定結果が変わらないなら
 * put も broadcast もしない」（AC 7.6）に反する。永続せずに要求すれば、以後どの no-op でも同じ要求が
 * 出続けて抑制の意味が失われる。ゆえに要求は確定変化のある遷移でだけ出て、取り逃した機会は次の確定変化が
 * 回収する（そのとき指紋はまだ食い違っているので必ず要求が出る）。
 *
 * @param prev    遷移前の状態（no-op 比較の基準）
 * @param moved   基底の集合変更後・同期前の状態
 * @param params  同期・採点のパラメータ（値）と麺プリセット
 * @param now     snapshot の serverTime
 * @param mayRequestPlan 外部計画を要求してよい遷移か（計画受領の遷移は false・AC 5.7）
 */
export function settle(
  prev: TimerState,
  moved: TimerState,
  params: SettleParams,
  now: EpochMillis,
  mayRequestPlan: boolean,
): Outcome {
  // running のみ再同期し、boiled は据え置いて元の並び順のまま合成する。
  const running = moved.timers.filter((t) => t.boiledAt === null);
  const synced = synchronize(running, params);
  const nextTimers = mergeBoiled(moved.timers, synced);
  const nextState: TimerState = { ...moved, timers: nextTimers };

  // no-op 検出（要件7.7）：確定結果が prev と同一なら put も broadcast もしない。状態も prev を返す。
  if (isSameConfirmedResult(prev, nextState)) {
    return { ok: true, state: prev, effects: [] };
  }

  // 現在の指紋は導出値ゆえ確定後の入力から毎回導く（状態には持たない・AC 7.2）。
  const digest = digestInput(nextState.pendingOrders, nextState.timers, params);
  // 計画対象は planTargets ただ一つから引く（「何が計画対象か」を二度書かない）。抑制の判定と、要求が運ぶ
  // 集合が同じ値を見ることで、空判定と送出範囲が食い違う余地が構造から消える。
  const targets = planTargets(nextState.pendingOrders);
  // 抑制の条件は 3 つ（AC 5.6 / 5.7）。要求してよい遷移か、入力が前回の要求時から変わったか、そして
  // 計画する対象が在るか。**空の待ち行列では要求しない** ——改善しうるものが存在しない要求だからである
  // （このとき新しい指紋も永続しない。次に対象が現れた遷移で指紋はまだ食い違っており、要求はそこで出る）。
  if (!mayRequestPlan || digest === nextState.requestedDigest || targets.length === 0) {
    return { ok: true, state: nextState, effects: assembleEffects(nextState, params, now) };
  }

  // **新しい指紋を状態へ書いてから Effect 列を組む。** 逆にすると Persist に古い指紋が乗り、次のイベントで
  // 同じ要求がもう一度出る（永続した指紋が「直前に要求した時点の値」でなくなる・AC 5.4）。
  const requested: TimerState = { ...nextState, requestedDigest: digest };
  return {
    ok: true,
    state: requested,
    effects: [
      ...assembleEffects(requested, params, now),
      requestPlan(requested, params, digest, targets),
    ],
  };
}

/**
 * 外部への計画要求を組む（AC 5.1 / 5.3）。列の**末尾**に置かれる（順序の規律は assembleEffects の注記）。
 *
 * 運ぶ対象集合は**計画対象**（planTargets の出力）である。全 Pending_Order を渡して外部に切り直させれば、
 * 「何が計画対象か」の規則が engine と Solver_Worker の二箇所に生まれる。指紋が畳んだ範囲と要求が運ぶ範囲を
 * 同一にしておくことが、受領時に「この計画はどの入力に対するものか」を指紋で同定できる根拠でもある。
 * その集合は呼び出し側から受け取る——抑制の空判定が見た対象と、要求が運ぶ対象が同一の値であることを、
 * 引数で保証する（同じ整列をもう一度走らせない）。ここに来た時点で targets は非空である。
 *
 * running は生きた Timer 全体を渡す（boiled も含む）。解放表（initialRelease）が同じ集合を所与として
 * 受け取るため——外部が別の集合から解放表を組めば、こちらの feasibility 判定と噛み合わない。
 *
 * params は SettleParams（ScheduleParams の上位集合）をそのまま載せる。Effect が契約として宣言するのは
 * ScheduleParams の 8 値であり、読み手はそこだけを見る。同期パラメータと麺プリセットを 8 値へ削ぐ射影を
 * 立てないのは、削ぐために同じフィールド名の列挙をもう一箇所に置くことになるためである（何を外へ送るかは
 * 送出の関心事で、shell 側の担当・タスク 19.2）。
 */
function requestPlan(
  state: TimerState,
  params: SettleParams,
  digest: InputDigest,
  targets: readonly PendingOrder[],
): Effect {
  return {
    type: "RequestPlan",
    pending: targets,
    running: state.timers,
    params,
    digest,
  };
}

/**
 * 同期済みの running（synced）を moved.timers の並び順へ差し戻す。boiled は moved のまま据え置く。
 *
 * synchronize には running のみを渡すため synced は running だけを含む。id をキーに running を synced で
 * 差し替え、boiled はそのまま通すことで、moved の元の並び順を保ったまま再合成する（順序を乱さない）。
 */
function mergeBoiled(movedTimers: readonly Timer[], synced: readonly Timer[]): readonly Timer[] {
  const syncedById = new Map<string, Timer>(synced.map((t) => [t.id, t]));
  return movedTimers.map((t) => (t.boiledAt === null ? (syncedById.get(t.id) ?? t) : t));
}

/**
 * 確定結果の同一性判定（要件7.7 / AC 7.6）。永続され broadcast される事実のすべてが prev と next で一致するか。
 *
 * 突き合わせるのは 4 つ——Timer 集合・Pending_Order 集合・採用済み PlanSlice 列・取り込みの判定材料。
 * **待ち行列と採用済み計画を見なければオーダー到着が握り潰される**（Timer は 1 つも動かないため、Timer
 * だけを見る判定は「変化なし」と答えて Persist も Broadcast も出さない）。
 *
 * **判定材料（lastSequenceByTerminal）を含めるのは、集合が変わらずに材料だけが進む受領が実在するため
 * である**——翻訳結果が 0 件で当該注文が集合に無い受領（麺を含まない注文）がそれで、材料を確定させ
 * なければ同じ注文が再送のたびに翻訳をやり直される（pos-order-ingress AC 6.12・Property 16）。材料は
 * 永続され Pending_Order 集合と同一の `Persist` で確定する事実であり、確定結果の一部である（Property 14）。
 * 受領以外の遷移はこの材料を一切動かさないため、判定を足しても他の分岐の挙動は変わらない。
 *
 * `requestedDigest` は含めない（design が挙げる 2 つに限る）。指紋だけが変わる確定結果は存在しない——
 * 要求の生成（タスク 17.2）は、この判定を抜けて Effect 列を組む経路の中だけで起こり、新しい指紋は
 * その列の `Persist` に同乗するためである。
 */
function isSameConfirmedResult(prev: TimerState, next: TimerState): boolean {
  return (
    isSameTimers(prev.timers, next.timers) &&
    isSamePending(prev.pendingOrders, next.pendingOrders) &&
    isSameAccepted(prev.acceptedSlices, next.acceptedSlices) &&
    isSameLastSequence(prev.lastSequenceByTerminal, next.lastSequenceByTerminal)
  );
}

/**
 * 端末ごとの判定材料が一致するか（端末の集合と各値）。
 *
 * 内容で突き合わせるのは、判定を呼び出し側のオブジェクトの作り方に依存させないためである——受領の遷移は
 * 1 件も受理しなくても写しを渡すので、参照の一致だけを見れば重複ばかりの受領が「変化」に見え、
 * AC 7.6 が禁じる空振りの Persist / Broadcast が出る。
 */
function isSameLastSequence(
  prev: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
): boolean {
  if (prev === next) return true;
  const terminalIds = Object.keys(prev);
  if (terminalIds.length !== Object.keys(next).length) return false;
  return terminalIds.every((terminalId) => prev[terminalId] === next[terminalId]);
}

/**
 * Timer 集合（id）＋各 timer の確定結果フィールドが完全一致するか。id をキーに突き合わせるため列挙順に依存しない。
 *
 * 「確定結果」とは永続（toSnapshot）され broadcast（toWireTimer）される事実そのもの。ゆえに遷移で変わりうる
 * フィールドをすべて突き合わせる必要がある——sync/fire が動かす adjustment / boiledAt に加え、adjust が動かす
 * endTime（アンカー）と firmness も含める。ここが adjustment / boiledAt だけを見ていると、単独 running への
 * 茹で加減変更（adjustment が 0 のまま）が no-op と誤判定され、Persist も Broadcast も出ずに握り潰される。
 * id / slotIds / noodleType / startTime / seq / orderItem は生成後に変わらないため比較不要
 * （集合の id 一致で足りる）。
 */
function isSameTimers(prev: readonly Timer[], next: readonly Timer[]): boolean {
  if (prev.length !== next.length) return false;
  const prevById = new Map<string, Timer>(prev.map((t) => [t.id, t]));
  for (const t of next) {
    const p = prevById.get(t.id);
    if (p === undefined) return false;
    if (
      p.endTime !== t.endTime ||
      p.firmness !== t.firmness ||
      p.adjustment !== t.adjustment ||
      p.boiledAt !== t.boiledAt
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 採用済み PlanSlice 列が一致するか（並びも含む全フィールド）。
 *
 * 並びを含めるのは、この列が計画順（接頭辞採用の順序）そのものであり、順序が変われば確定計画が変わるためである。
 * 内容で突き合わせるのは、判定を呼び出し側の配列インスタンスの扱いに依存させないため——同じ内容の列を
 * 作り直した遷移が「変化」に見えれば、AC 7.6 が禁じる空振りの Persist / Broadcast が出る。
 * Pending_Order 側の同一性は pending.ts の isSamePending ただ一つ（同じ概念を二度書かない）。
 */
function isSameAccepted(prev: readonly AcceptedSlice[], next: readonly AcceptedSlice[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  return prev.every((slice, index) => isSameSlice(slice, next[index]));
}

/** 一片の同一性（分解軸の鍵・部分和・配置列）。 */
function isSameSlice(left: AcceptedSlice, right: AcceptedSlice | undefined): boolean {
  return (
    right !== undefined &&
    left.tableKey === right.tableKey &&
    left.score === right.score &&
    left.placements.length === right.placements.length &&
    left.placements.every((placement, index) => isSamePlacement(placement, right.placements[index]))
  );
}

/** 1 配置の同一性（対象品目・釜・開始と提供の時刻）。 */
function isSamePlacement(left: Placement, right: Placement | undefined): boolean {
  return (
    right !== undefined &&
    left.externalOrderId === right.externalOrderId &&
    left.itemIndex === right.itemIndex &&
    left.startAt === right.startAt &&
    left.serveAt === right.serveAt &&
    left.slotIds.length === right.slotIds.length &&
    left.slotIds.every((slotId, index) => slotId === right.slotIds[index])
  );
}

/**
 * toWireSnapshot — 確定状態を配信する snapshot メッセージへ写す唯一の関数（AC 2.3 / 2.4 / 8.1）。
 *
 * **配信の経路は 2 つあるが、形は 1 つである。** 確定変化ごとの broadcast（assembleEffects）と、接続直後の
 * hydration（shell の fetch）が同じ全量 snapshot を送る。組み立てが二箇所に在れば、片方だけが待ち行列や
 * 推奨を載せる形に容易にずれる——再取得完了時点で他端末と同一の内容を持つという AC 2.4 は、その食い違いで
 * まさに破れる。ゆえに射影をここへ集約し、shell は状態と時計を渡すだけにする（`toWireTimer` の
 * 「射影はここ一箇所」と同じ規律を、Timer 単体から確定状態の全量へ広げた形）。
 *
 * **確定計画と推奨は導出値ゆえ毎回導く。** 状態に持てば計画と状態の二つの真実が生まれる。導出の起点は
 * 確定後の状態そのものであり、shell が `committedSchedule` → `recommend` を自前で呼ぶ経路を持たないことが
 * 「導出は engine の内側だけ」を構造で保証する。
 */
export function toWireSnapshot(
  state: TimerState,
  params: SettleParams,
  now: EpochMillis,
): ServerMessage {
  // 生きた Timer は running / boiled とも釜の解放表に効く（boiled は実効 endTime の時点で解放済み扱い）。
  const committed = committedSchedule(
    state.acceptedSlices,
    state.pendingOrders,
    state.timers,
    now,
    params.noodlePresets,
    params,
  );
  return {
    type: "snapshot",
    serverTime: now,
    // 全量 snapshot は実効 endTime（toWireTimer が畳み込む）を載せ、集合全体の調整変化を一度に反映する。
    timers: state.timers.map(toWireTimer),
    // 待ち行列は全量（計画対象 64 件を超える分も含む・AC 2.3 / 2.4）。推奨は確定計画からの導出値。
    pendingOrders: state.pendingOrders,
    recommendations: recommend(committed),
  };
}

/**
 * Persist 先頭の Effect 列を組む（design「broadcast 戦略」＝厳守）。
 *
 * 順序は Persist → SetAlarm|ClearAlarm（実効最早）→ 全量 snapshot Broadcast（実効 endTime を載せる）。
 * 確定変化ごとに送るのは snapshot ただ一つ（唯一の権威表現・SSOT）——意味論 Broadcast と Reply は撤去した。
 * Persist を先頭に置くのは SSOT 規律の表明であり、shell は put 成功の上にのみ Alarm / Broadcast を立てる。
 */
function assembleEffects(
  nextState: TimerState,
  params: SettleParams,
  now: EpochMillis,
): readonly Effect[] {
  return [
    { type: "Persist", snapshot: toSnapshot(nextState) },
    nextAlarmEffect(nextState.timers),
    { type: "Broadcast", message: toWireSnapshot(nextState, params, now) },
  ];
}
