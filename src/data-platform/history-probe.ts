// 合成プローブの Producer（operation-history-log 要件 7.3）。console → Tail → Pipelines → Iceberg の
// 経路が生きているかだけを確かめるために、業務とは別の Worker として定期的に合成行を出す。
//
// 業務の Producer とは別 script にするのは、合成かどうかを script 名という**発信元の事実**で決める
// ためである。payload の申告で合成を名乗れる設計にすると、業務行を合成として分析から外す道が開く。
//
// この Worker は公開の入口を持たない。到達経路は定期実行だけで、fetch handler も route も無い。

import { operationRecordPayload } from "../operation-history/codec";
import type { OperationRecord } from "../operation-history/record";
import { liftDelayPayload } from "../lift-delay/codec";
import { liftDelayEventId, type LiftDelayRecord } from "../lift-delay/record";

/** 合成行だけが使う店舗。実店舗の slug と衝突しない固定値。 */
export const PROBE_STORE_ID = "probe-store";

/** 1 回の実行で出す行数。経路の生死を見るだけなので最小で足りる。 */
const PROBE_LINES = 1;

/**
 * 合成の Operation Record。形式は業務行と同じ既存契約で、内容だけが合成である。
 * probe ID には Timer ID を使う——Tail はこれを probeId 列へ写し、行の照合に使う。
 */
export function probeRecord(probeId: string, now: number): OperationRecord {
  return {
    storeId: PROBE_STORE_ID,
    timerId: probeId,
    operationKind: "completed",
    eventTime: now as OperationRecord["eventTime"],
    slotIds: ["probe-slot"],
    noodleType: "probe",
    firmness: "normal",
  };
}

/** 遅延 dataset の合成記録。経路の確認だけが目的で、完了遅延の統計には入れない。 */
export function probeLiftDelayRecord(probeId: string, now: number): LiftDelayRecord {
  return {
    recordType: "lift-delay",
    payloadVersion: 1,
    eventId: liftDelayEventId(PROBE_STORE_ID, probeId, "completed"),
    storeId: PROBE_STORE_ID,
    timerId: probeId,
    outcome: "completed",
    startedAt: now - 90_000,
    dueAt: now,
    terminalAt: now,
    noodleType: "probe",
    firmness: "normal",
    slotIds: ["probe-slot"],
  };
}

const historyProbe: ExportedHandler = {
  async scheduled(_controller, _env, _ctx): Promise<void> {
    const now = Date.now();
    for (let index = 0; index < PROBE_LINES; index += 1) {
      const probeId = crypto.randomUUID();
      // 送出予定を運用証跡に残す。Tail が観測できたかは Iceberg 側の照合で確かめる。
      console.warn(JSON.stringify({ observation: "history-probe-emitted", probeId, at: now }));
      // 業務の Producer と同じ形で出す。経路を確かめる意味が保たれるのは、同じ形のときだけである。
      console.log(operationRecordPayload(probeRecord(probeId, now)));
      // 遅延 dataset の経路も同じプローブで確かめる（lift-delay-log タスク 5.3）。
      console.log(liftDelayPayload(probeLiftDelayRecord(probeId, now)));
    }
  },
};

export default historyProbe;
