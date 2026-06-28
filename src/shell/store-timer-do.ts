import { DurableObject } from "cloudflare:workers";
import { decide } from "../engine/decide";
import type { Effect } from "../engine/effect";
import { migrate } from "../engine/migrate";
import type { ShellFailure } from "../engine/rejection";
import { fromSnapshot } from "../engine/snapshot";
import { EMPTY_STATE, type TimerState } from "../engine/state";
import type { EpochMillis, TimerId } from "../engine/types";
import { buildSeamEntry, type InstrumentationLogEntry } from "../observe/log";
import { PING_REQUEST, PONG_RESPONSE } from "../transport/heartbeat";
import type { ClientMessage, ServerMessage } from "../domain/messages";
import type { TimerFact } from "../domain/timer";

/** 永続層の単一キー。状態は丸ごとこのキーへ put / get する（要件8.3・SQL 不使用）。 */
const SNAPSHOT_KEY = "activeTimers";

/** Cloudflare Alarm の自動リトライ上限（公式: 初回2秒・指数バックオフ・最大6回）。 */
const ALARM_MAX_RETRIES = 6;

/**
 * retryCount がこの値以上なら throw せず新規 Alarm を張り直す（リトライ枯渇の一歩手前）。
 * throw による at-least-once リトライを使い切る前に新しい Alarm を予約し、取りこぼしを防ぐ（公式推奨）。
 */
const ALARM_REARM_THRESHOLD = ALARM_MAX_RETRIES - 1;

/** 張り直す Alarm の遅延。put が回復するまでの猶予を置く（公式推奨パターンの例値）。 */
const ALARM_REARM_DELAY_MS = 30_000;

/** runEffects の結果。Persist が確定したか（put 成功か）だけを呼び出し元へ返す。 */
interface RunResult {
  /** Persist が成功して状態が確定したら true。put 失敗で後続を中断したら false。 */
  readonly persisted: boolean;
}

/**
 * 初期化（rehydrate）失敗。移行不能（UnsupportedSchemaVersion / MigrationFailed）を包んで throw し、
 * blockConcurrencyWhile による DO 再初期化に委ねる（要件7.5）。Working_Copy は確定しないまま破棄される。
 */
class InitError extends Error {
  constructor(readonly failure: ShellFailure) {
    super(`rehydrate failed: ${failure.code}`);
    this.name = "InitError";
  }
}

/**
 * 受信した文字列を ClientMessage として防御的に解釈する。core を呼ぶ前段の検証はここに集約する。
 *
 * JSON parse 失敗・未知の type・必須フィールドの欠如や型不一致はすべて undefined を返し、
 * 呼び出し側で破棄させる（要件9.7。throw せず Working_Copy を一切変えない）。
 * 「不正な状態を表現可能にしない」規律の入口側で、検証済みの形だけが core へ進む。
 */
function parseClientMessage(raw: string): ClientMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  switch (candidate.type) {
    case "start":
      if (
        Array.isArray(candidate.slotIds) &&
        candidate.slotIds.length > 0 &&
        candidate.slotIds.every((slotId) => typeof slotId === "string") &&
        typeof candidate.noodleType === "string" &&
        typeof candidate.boilSeconds === "number"
      ) {
        return {
          type: "start",
          slotIds: candidate.slotIds as readonly string[],
          noodleType: candidate.noodleType,
          boilSeconds: candidate.boilSeconds,
        };
      }
      return undefined;
    case "cancel":
      if (typeof candidate.timerId === "string") {
        return { type: "cancel", timerId: candidate.timerId };
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * StoreTimerDO — 店舗の全タイマー状態の正本（SSOT）を保持する Durable Object。
 *
 * core（decide）が返す Effect 列を shell が先頭から順に実行する。SSOT 規律はこの実行規則に宿る。
 * 確定の起点は storage.put の成功のみ。Persist が成功して初めて Working_Copy を確定反映し、
 * その上に SetAlarm / ClearAlarm / Broadcast / Reply が立つ。
 *
 * rehydrate（task 11）・Alarm（task 12）・WebSocket メッセージ処理（task 13）は後続タスクで配線する。
 */
export class StoreTimerDO extends DurableObject<Env> {
  /**
   * Working_Copy — メモリ上に保持する TimerState そのもの。
   *
   * メモリへの代入は永続化ではない。永続層が SSOT であり、この複製は storage.put 成功時にのみ
   * 確定反映される（runEffects 参照）。hibernate 復帰後は揮発するため task 11 でロードを保証する。
   */
  private workingCopy: TimerState = EMPTY_STATE;

  /**
   * ロード済みフラグ。ensureLoaded を一度きりにして冪等に保つ。
   *
   * constructor の blockConcurrencyWhile で必ず初期化されるが、各エントリポイントの前段でも
   * ensureLoaded を呼ぶため、このフラグで二重ロードを防ぐ（hibernate 復帰ごとに false へ戻る）。
   */
  private loaded = false;

  /**
   * instanceId — この in-memory 生存期間を一意に識別する観測キー（要件4.8 / 5.1）。
   *
   * 採番は crypto.randomUUID() という shell の作用であり、フィールド初期化子により construct 時に
   * 一度だけ行う。readonly ゆえ存続期間中は不変で、再 construct（cold start / 再デプロイ / hibernation
   * wake）ごとに必ず別値になる。これは永続状態ではなくメモリ上の事実であり、Working_Copy や
   * 永続スナップショットには一切混ざらない（計装は観測点であって作用点ではない）。
   */
  private readonly instanceId: string = crypto.randomUUID();

  /** instanceId の採番時刻（construct 時刻）。区間分類の昇順整列に用いる観測値（要件5.1）。 */
  private readonly instanceBornAt: EpochMillis = Date.now() as EpochMillis;

  /**
   * debug flag ゲート。計装出力の有効/無効をこの一点で判定する（要件4.10）。
   *
   * OBSERVE_DEBUG は env 経由の公開設定キー。既定値は "0"（無効）で、観測時のみデプロイ時の
   * オーバーライドで "1" に上書きする。wrangler types は既定値から literal 型 "0" を生成するため、
   * "1" との直接比較は型の重なりが無く TS2367 になる。実行時は "1" を取りうる事実を表すため
   * string へ広げて比較する。
   */
  private get instrumentationEnabled(): boolean {
    return (this.env.OBSERVE_DEBUG as string) === "1";
  }

  /**
   * 計装 entry を Instrumentation_Log として吐く唯一の作用点（要件4.1〜4.4 / 4.10）。
   *
   * debug 無効時は即 return し、いずれの継ぎ目からも出力しない。ゲートをこの一点に集約することで
   * 「4継ぎ目限定」（要件4.9）が構造で守られる。entry の組み立ては純粋関数（src/observe/log.ts の
   * buildSeamEntry）に委ね、shell は console.log(JSON.stringify(...)) で吐くだけ。同期的な
   * console.log のみで待機も状態も持たず、Working_Copy・永続スナップショット・Effect 実行順序
   * （Persist 先頭）を一切変えない（要件4.6）。wrangler tail がこの出力を拾う。
   */
  private emitSeam(entry: InstrumentationLogEntry): void {
    if (!this.instrumentationEnabled) return;
    console.log(JSON.stringify(entry));
  }

  /**
   * hibernate 復帰後の初期化を blockConcurrencyWhile で囲い、完了まで後続イベント配送を止める（要件7.3）。
   *
   * 中途半端な Working_Copy を外部へ応答しないための規律。ロード後に reconcile を 1 回適用し、
   * 期限到来分の即時発火・残存からの Alarm 再導出を回収する（要件7.6 / 7.2 / 7.7）。
   * blockConcurrencyWhile 内で投げられた例外（読み出し失敗 / 移行不能）は DO を再初期化させる（要件7.5）。
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 継ぎ目1: construct（要件4.1）。なぜ先頭か——この呼び出し自体が「新しい in-memory が生まれた」
    // 事実そのものであり、blockConcurrencyWhile（rehydrate）より前に採番済みの instanceId を確定の
    // 起点として記録しなければ、cold start / wake の境界を後続の継ぎ目と突き合わせられないため。
    // at は採番時刻（instanceBornAt）を用い、instanceId と同一時点を指させる。
    this.emitSeam(buildSeamEntry({ seam: "construct", at: this.instanceBornAt, instanceId: this.instanceId }));
    void ctx.blockConcurrencyWhile(async () => {
      await this.ensureLoaded();
      // ロード後の整合（要件7.6 / 7.2 / 7.7）。now は shell が採取して core へ渡す（core は時計を持たない）。
      const now = Date.now() as EpochMillis;
      const outcome = decide(this.workingCopy, { type: "Reconcile", now });
      // reconcile は常に成功する（fireDueTimers と同形）。Persist 先頭の Effect 列を runEffects が実行し、
      // 即時発火による状態変化は put 成功時にのみ確定する（SSOT 規律）。Reconcile 経路に Reply 宛先はない。
      if (outcome.ok) {
        await this.runEffects(outcome.effects);
      }
    });
  }

  /**
   * Working_Copy のロードを保証する（要件7.1 / 8.6）。全エントリポイント共通の前段。
   *
   * 未ロード時のみ storage.get → migrate → fromSnapshot で TimerState を再構築する。
   * - 読み出し失敗（storage.get の reject）は握り潰さず呼び出し元へ伝播し、再初期化に委ねる（要件7.5）。
   * - migrate は snapshot 不在を空スナップショットへ写すため、不在は空状態になる（Alarm 設定なし・要件7.4）。
   * - 移行不能（UnsupportedSchemaVersion / MigrationFailed）は Working_Copy を確定せず throw（要件7.5）。
   * loaded フラグにより二度目以降は何もしない（冪等）。
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    // 読み出し失敗はここで確定せず伝播させる（要件7.5）。
    const raw = await this.ctx.storage.get(SNAPSHOT_KEY);
    // version 検査・移行（要件11）。不在は空スナップショットへ写される（要件7.4）。
    const migrated = migrate(raw);
    if (!migrated.ok) {
      // 移行を確定しない。Working_Copy も loaded も触らず throw し、再初期化に委ねる（要件7.5）。
      throw new InitError(migrated.failure);
    }
    // ここで初めて Working_Copy を再構築する。確定後にロード済みとし、以後は冪等。
    this.workingCopy = fromSnapshot(migrated.snapshot);
    // 継ぎ目2: rehydrate（要件4.2）。なぜ fromSnapshot 直後か——hibernate 復帰で揮発した Working_Copy が
    // 永続スナップショットから何件復元されたかは、再構築が済んだこの時点でしか正確に採れないため。
    // restoredCount は復元後の copy を読むだけで、ロード制御（loaded フラグ）や状態を一切変えない。
    this.emitSeam(
      buildSeamEntry({
        seam: "rehydrate",
        at: Date.now(),
        instanceId: this.instanceId,
        restoredCount: this.workingCopy.timers.length,
      }),
    );
    this.loaded = true;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation 互換の収容（server.accept() は使わない）
    this.ctx.acceptWebSocket(server);

    // auto-response（要件1.1 / 12.3）: 所定の ping 要求に所定の pong を登録する。ランタイムが直接
    // 応答するため webSocketMessage ハンドラを起動せず、hibernate からの wake を伴わない。心拍は
    // 接続を生かすだけで Working_Copy も Effect 実行順序も一切変えない（client と同一の確定値を共有）。
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_REQUEST, PONG_RESPONSE));

    // Hydration（要件4.1 / 9.2）。接続確立の一環として、収容直後にこの WS だけへ
    // 現在のアクティブ Timer 全量を snapshot として送る（差分ではなく全量）。
    // serverTime は送信時点のサーバ現在時刻（残り秒は送らず endTime から各クライアントが導出する）。
    const snapshot: ServerMessage = {
      type: "snapshot",
      serverTime: Date.now(),
      timers: this.workingCopy.timers.map(
        (timer): TimerFact => ({
          id: timer.id,
          slotIds: timer.slotIds,
          noodleType: timer.noodleType,
          endTime: timer.endTime,
        }),
      ),
    };
    server.send(JSON.stringify(snapshot));

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ensureLoaded();

    // 受理するのは文字列 JSON のみ。ArrayBuffer など非文字列は破棄して Working_Copy を一切変えない（要件9.7）。
    if (typeof message !== "string") return;
    const command = parseClientMessage(message);
    // 不正形式（JSON parse 失敗 / 未知 type / 必須フィールド欠如・型不一致）は破棄する（要件9.7）。
    if (command === undefined) return;

    // ClientMessage を core への Event へ写す。crypto.randomUUID() と Date.now() は shell の作用であり、
    // core は時計も乱数も持たない（core/event.ts 参照）。
    const now = Date.now() as EpochMillis;
    const event =
      command.type === "start"
        ? {
            type: "Start" as const,
            slotIds: command.slotIds,
            noodleType: command.noodleType,
            boilSeconds: command.boilSeconds,
            newTimerId: crypto.randomUUID() as TimerId,
            now,
          }
        : { type: "Cancel" as const, timerId: command.timerId, now };

    const outcome = decide(this.workingCopy, event);
    if (outcome.ok) {
      // Reply は要求元の WS（ws）へ返す。Persist 先頭の Effect 列を runEffects が実行する（SSOT 規律）。
      await this.runEffects(outcome.effects, ws);
      return;
    }
    // 拒否は Effect 列を生まない（outcome.ok === false）。要求元の WS だけへ error を返す（要件1.5 / 3.8 / 6.6）。
    const error: ServerMessage = {
      type: "error",
      serverTime: Date.now(),
      code: outcome.rejection.code,
      message: outcome.rejection.message,
    };
    ws.send(JSON.stringify(error));
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // 接続管理は ctx.getWebSockets() を正とし、自前の接続リストという隠れ状態を持たない（要件9.4）。
    // よって切断時に除去すべき独自状態は存在しない。web_socket_auto_reply_to_close は
    // compatibility_date(2026-06-26) で既定化済みのため ws.close() も不要。ハンドラ本体は空でよい。
    void ws;
    void code;
    void reason;
    void wasClean;
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.ensureLoaded();
    // 継ぎ目3: alarm（要件4.3）。なぜ ensureLoaded 後の先頭か——Alarm 起動も hibernate からの wake を
    // 伴いうるため、Working_Copy のロードが済んだ起動直後に「この instance で Alarm が走った」事実を
    // 記録する。decide / runEffects より前なので発火・永続・broadcast の順序には一切干渉しない。
    this.emitSeam(buildSeamEntry({ seam: "alarm", at: Date.now(), instanceId: this.instanceId }));
    // now は shell が採取して core へ渡す（core は時計を持たない＝純粋）。
    const now = Date.now() as EpochMillis;
    // AlarmFired は fireDueTimers と同形で常に成功する（拒否経路を持たない）。Alarm 経路に Reply 宛先はない。
    const outcome = decide(this.workingCopy, { type: "AlarmFired", now });
    if (!outcome.ok) return;
    // Persist 先頭の Effect 列を runEffects が実行する。SetAlarm/ClearAlarm は applySideEffect が
    // storage.setAlarm/deleteAlarm へ写し、done の Broadcast は put 成功の上にのみ立つ（SSOT 規律）。
    const result = await this.runEffects(outcome.effects);
    if (result.persisted) return;
    // ここに来たら Persist 失敗 = 何も確定していない（Working_Copy も put 前のまま据え置き）。
    // 原則は throw して Cloudflare Alarm の at-least-once 自動リトライに委ねる。ただし retryCount が
    // 上限近傍のときは throw せず新規 Alarm を張り直し、リトライ枯渇による取りこぼしを防ぐ（公式推奨）。
    if (alarmInfo !== undefined && alarmInfo.retryCount >= ALARM_REARM_THRESHOLD) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_REARM_DELAY_MS);
      return;
    }
    throw new Error(
      `alarm persist failed (store=${this.ctx.id.name ?? "unknown"}, retryCount=${alarmInfo?.retryCount ?? 0})`,
    );
  }

  /**
   * core が返した Effect 列を先頭から順に実行する（要件8.1・8.4・8.5・3.7）。
   *
   * Persist は確定の起点。await で書き込み完了を保証してから後続へ進む。put 成功時にのみ
   * Working_Copy を確定反映する。put が失敗したら後続 Effect（SetAlarm/ClearAlarm/Broadcast/Reply）
   * を実行せず、Working_Copy も put 前のまま据え置く（成功するまで代入しないので「戻す」操作は不要）。
   *
   * @param replyTo Reply の宛先 WS（要求元）。WS メッセージ処理（task 13）から渡す。Alarm 経路では無い。
   */
  private async runEffects(effects: readonly Effect[], replyTo?: WebSocket): Promise<RunResult> {
    for (const effect of effects) {
      if (effect.type === "Persist") {
        try {
          // 逐次 await は意図的。確定の起点である put の完了を保証してから後続へ進むため、
          // 並列化（Promise.all）は SSOT 規律に反する。
          // oxlint-disable-next-line no-await-in-loop
          await this.ctx.storage.put(SNAPSHOT_KEY, effect.snapshot);
        } catch {
          // put 失敗 = 何も確定していない。後続 Effect を実行せず Working_Copy も据え置く。
          return { persisted: false };
        }
        // 確定の起点。put 成功したスナップショットだけが新しい Working_Copy になる。
        this.workingCopy = fromSnapshot(effect.snapshot);
      } else {
        // Persist 成功の後でのみ到達する。put 成功の上に broadcast / alarm が立つ。
        this.applySideEffect(effect, replyTo);
      }
    }
    return { persisted: true };
  }

  /**
   * Persist 以外の Effect を対応するプラットフォーム作用へ写す。
   *
   * これらは永続済み状態から再構成可能な派生作用であり、Persist のように完了を await しない
   * （欠落は Alarm なら次回起動の reconcile、Broadcast なら再接続時の全量 hydration が回収する）。
   */
  private applySideEffect(effect: Exclude<Effect, { readonly type: "Persist" }>, replyTo?: WebSocket): void {
    switch (effect.type) {
      case "SetAlarm":
        void this.ctx.storage.setAlarm(effect.at);
        break;
      case "ClearAlarm":
        void this.ctx.storage.deleteAlarm();
        break;
      case "Broadcast": {
        // 接続中の全 WS へ全量送信。送信失敗は握り潰さず、回復は再接続 hydration に委ねる（要件2.6）。
        const payload = JSON.stringify(effect.message);
        // 継ぎ目4: broadcast（要件4.4）。なぜ送信ループ前に 1 回か——「この broadcast 作用が起きた」事実は
        // 宛先 WS の数とは独立した 1 回の出来事であり、ループ内に置くと接続数ぶん増殖して観測点が
        // 4 継ぎ目限定（要件4.9）から外れるため。messageType は送る ServerMessage の種別を読むだけで、
        // payload の中身・送信内容・送信タイミングは一切変えない（要件4.6）。
        this.emitSeam(
          buildSeamEntry({
            seam: "broadcast",
            at: Date.now(),
            instanceId: this.instanceId,
            messageType: effect.message.type,
          }),
        );
        for (const ws of this.ctx.getWebSockets()) {
          ws.send(payload);
        }
        break;
      }
      case "Reply":
        // 要求元の WS のみへ返す。宛先が無い経路（Alarm）では Reply Effect は発生しない。
        if (replyTo !== undefined) {
          replyTo.send(JSON.stringify(effect.message));
        }
        break;
    }
  }
}
