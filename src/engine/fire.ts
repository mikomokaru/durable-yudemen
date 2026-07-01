// core/fire.ts — 茹で上がりの一括ドレイン発火と、rehydrate 直後の整合の純粋変換。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 発火は「1 件ずつ」ではなく「実効 endTime（Adjusted_Boil_Time）≤ now + ε を満たす全 Timer を一度に」
// 処理する。Alarm は at-least-once であり多重・境界付近で起動されうるため、1 件ずつ処理すると ε 窓内の
// 複数 Timer に対して再発火が連鎖し無限スルーの恐れがある。一括ドレインにより残存最早は
// 必ず now + ε より未来となり、連鎖が構造的に断たれる（要件2.10 / 3.3 を不変条件の帰結として満たす）。
//
// 発火の基準はオリジナル endTime ではなく実効 endTime（= endTime + adjustment・要件4.4）。実効時刻で
// due になった running を「先に」boiled へ写して Adjustment を凍結し、「その後」残り running を再同期する
// （発火済みの Adjustment は動かさず、残りだけを新配置へ寄せる・要件7.3）。
//
// 凍結→再同期の固定点反復（Boil_Sync 存在下の ε 一括ドレイン不変条件の一般化）:
// 残り running を synchronize で再同期すると、負の Adjustment（前倒し）により走行中だった別の running の
// 実効 endTime が due 窓（≤ now + ε）へ押し込まれることがある。これは「A と近接していた B も同時に
// 茹で上げるべき」という本機能の意図に沿う正しい事象である。ゆえに「実効 due を boiled へ凍結 →
// 残り running を再同期 → 再同期でさらに実効 due になった running もまた凍結」を、新規 due が出なくなるまで
// 反復する（固定点）。running は毎反復で単調減少するため最大 n 回で必ず停止する。これにより
// ε 一括ドレイン不変条件（残存 running の実効最早は必ず now + ε より未来）と冪等性（Property 5：二度目の
// fire は新規 boiled なし＝settle が Effect 空を返す）が両立する。

import { EPSILON_MS } from "../engine/types";
import type { EpochMillis } from "../engine/types";
import type { TimerState } from "./state";
import type { Timer } from "./timer";
import type { Outcome } from "./effect";
import { settle } from "./settle";
import { synchronize } from "./sync";
import type { SyncParams } from "./sync";
import { adjustedEndTime } from "./project";

/**
 * 茹で上がりの一括ドレイン発火（要件2.3 / 2.5 / 2.8 / 2.9 / 3.3 / 3.4 / 3.6 / 4.4 / 7.3）。
 *
 * `adjustedEndTime(t) ≤ now + ε`（ε = EPSILON_MS）を満たす running（boiledAt === null）を boiled
 * （boiledAt = now）へ遷移させて発火時の Adjustment を凍結し、残り running を synchronize で再同期する。
 * 再同期の結果さらに実効 due（adjustedEndTime ≤ now + ε）になった running が現れたら、それも凍結して
 * 再度残りを再同期する——これを新規 boiled が出なくなるまで反復（固定点）する。boiled はユーザーの
 * 明示完了（Complete）まで集合に残り、消し込み待ちの状態として保持される。
 *
 * 固定点に到達した working（全 due を boiled 化・残り running は最終再同期済み）を moved とし、settle を
 * 一度だけ呼んで Effect 列 [Persist, (SetAlarm|ClearAlarm)（実効最早）, Broadcast(snapshot)] を組む。settle は
 * 内部でもう一度 running を synchronize するが、固定点に到達済みゆえ結果は一致する（冪等・Property 9）。
 * 新規 boiled が無く再同期でも確定結果が変わらない no-op のときは settle が Effect 空を返す（要件7.7）。
 */
export function fireDueTimers(state: TimerState, now: EpochMillis, params: SyncParams): Outcome {
  // ε 許容窓。境界に位置する Timer を取りこぼさず一括で茹で上げる閾値（要件2.3 / 2.10 / 3.3）。
  const dueThreshold = (now as number) + EPSILON_MS;

  // 凍結→再同期を、新規 due が出なくなるまで反復する（固定点）。running は毎反復で単調減少し必ず停止する。
  let working: readonly Timer[] = state.timers;
  for (;;) {
    // 現在の実効 adjustment で due 判定。running かつ実効期限到来（要件3.6 / 4.4）。
    const due = working.filter(
      (t) => t.boiledAt === null && (adjustedEndTime(t) as number) <= dueThreshold,
    );
    if (due.length === 0) break;
    // due を boiled（boiledAt = now）へ写して Adjustment を凍結する。それ以外はそのまま残す。
    const dueIds = new Set<string>(due.map((t) => t.id as string));
    const frozen = working.map((t) => (dueIds.has(t.id as string) ? { ...t, boiledAt: now } : t));
    // 残り running のみ再同期し、adjustment を全体置換する（boiled は据え置き＝凍結を保持）。
    const running = frozen.filter((t) => t.boiledAt === null);
    const synced = synchronize(running, params);
    const syncedById = new Map<string, Timer>(synced.map((t) => [t.id as string, t]));
    working = frozen.map((t) =>
      t.boiledAt === null ? (syncedById.get(t.id as string) ?? t) : t,
    );
  }

  // 固定点に到達した状態（全 due を boiled 化・残り running は最終再同期済み）。nextSeq は発火では変えない。
  const moved: TimerState = { timers: working, nextSeq: state.nextSeq };

  // settle が Persist 先頭の Effect 列・no-op 抑止・実効最早 Alarm を担う。moved は固定点ゆえ settle 内の
  // 再同期は no-op 的に一致する（synchronize 冪等）。既 boiled は再通知しないため多重発火に安定。茹で上がりの
  // 通知は snapshot 単一表現に畳まれ、client が snapshot の endTime から boiled をローカル導出する。
  return settle(state, moved, params, now);
}

/**
 * rehydrate 直後の整合（要件7.6 / 7.7）。実効期限到来分を即時発火し、残り running を再同期して Alarm を張り直す。
 *
 * 整合は発火と同形である（実効期限到来分の凍結→再同期の固定点反復 → 残り running の再同期 → Alarm 再導出）。
 * 同じ概念を二度書かず fireDueTimers に委ねることで、実効最早算出・発火処理の重複を根絶する。残存最早が
 * 必ず now + ε より未来になる保証も fireDueTimers（と settle）がそのまま担う。
 */
export function reconcile(state: TimerState, now: EpochMillis, params: SyncParams): Outcome {
  return fireDueTimers(state, now, params);
}
