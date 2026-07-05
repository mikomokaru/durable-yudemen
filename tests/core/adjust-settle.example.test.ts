// engine/settle の no-op 判定が adjust（endTime/firmness 変更）を握り潰さないことの回帰テスト。
//
// 背景（デグレの経緯）: synchronized-boil-adjustment 機能が start/cancel/complete/fire/adjust の後段処理を
// settle に集約し no-op 検出を導入した際、その等価判定が sync/fire の動かす adjustment/boiledAt だけを見て
// adjust の動かす endTime/firmness を見落とした。単独 running（adjustment が 0 のまま）への茹で加減変更が
// no-op と誤判定され、Persist も Broadcast も出ず変更が握り潰されていた。ここではその再発を防ぐ。

import { describe, it, expect } from "vitest";
import { decide } from "../../src/engine/decide";
import { createTimer } from "../../src/engine/timer";
import type { Timer } from "../../src/engine/timer";
import type { TimerState } from "../../src/engine/state";
import type { EpochMillis, SlotId, NoodleType, TimerId } from "../../src/engine/types";
import type { ServerMessage } from "../../src/domain/messages";
import { nonEmpty } from "../nonEmpty";

const params = { arms: 2, toleranceRatio: 10 };

/** 単独 running（normal・60s・adjustment 0）。 */
function singleRunning(): TimerState {
  const timer = createTimer({
    id: "t1" as TimerId,
    slotIds: nonEmpty(["0" as SlotId]),
    noodleType: "Thin" as NoodleType,
    firmness: "normal",
    startTime: 0 as EpochMillis,
    endTime: 60_000 as EpochMillis,
    seq: 0,
  });
  return { timers: [timer], nextSeq: 1 };
}

describe("adjust — settle no-op 判定は endTime/firmness を確定変化とみなす", () => {
  it("単独 running への茹で加減変更は Persist + Broadcast を出し、状態を引き直す", () => {
    const outcome = decide(
      singleRunning(),
      { type: "Adjust", timerId: "t1", firmness: "hard", boilSeconds: 52, now: 10_000 as EpochMillis },
      params,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // 確定変化ゆえ effects が出る（Persist 先頭・Broadcast を含む）。
    expect(outcome.effects.length).toBeGreaterThan(0);
    expect(outcome.effects[0]?.type).toBe("Persist");
    const broadcast = outcome.effects.find((e) => e.type === "Broadcast");
    expect(broadcast).toBeDefined();

    // 状態は新しいアンカー（startTime 0 + 52s）と firmness に引き直される。
    const adjusted = outcome.state.timers.find((t: Timer) => t.id === "t1");
    expect(adjusted?.firmness).toBe("hard");
    expect(adjusted?.endTime).toBe(52_000);

    // broadcast される snapshot にも新しい実効 endTime / firmness が載る。
    const message = (broadcast as { message: ServerMessage } | undefined)?.message;
    expect(message?.type).toBe("snapshot");
    if (message?.type === "snapshot") {
      const wire = message.timers.find((t) => t.id === "t1");
      expect(wire?.firmness).toBe("hard");
      expect(wire?.endTime).toBe(52_000);
    }
  });

  it("同一 firmness への調整（値が変わらない）は no-op（effects 空・状態は prev）", () => {
    const state = singleRunning();
    // 現在と同じ normal・同じ 60s。確定結果は変わらないので no-op であるべき。
    const outcome = decide(
      state,
      { type: "Adjust", timerId: "t1", firmness: "normal", boilSeconds: 60, now: 10_000 as EpochMillis },
      params,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.effects).toEqual([]);
    expect(outcome.state).toBe(state);
  });
});
