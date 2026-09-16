import { parseCpsatObservation, type CpsatObservation } from "../../../src/cpsat/observation";
import { observeCpsat } from "../../../src/cpsat/observe";
import { checkQueuePayload, QUEUE_PAYLOAD_LIMIT_BYTES, type CpsatQueueMessage } from "./queue";
import manifest from "./manifest.json";

type Dispatch = Extract<CpsatObservation["fact"], { type: "cpsat.request-dispatched" }>;
type Origin = Dispatch["origin"];

/**
 * Fixed transport input, not an online model. Authorization and provenance
 * come from the trusted caller, never from the request body. The HTTP probe
 * checks Bearer/Origin before calling; the Effect caller must establish its
 * own successful Persist and the matching store/decision/effect context.
 *
 * This conversion does not grant a time window. Check the window at entry
 * and again in dispatch, after all asynchronous authorization/body reads.
 */
export function toCpsatTransportRequest(
  text: string | null,
  authorization:
    | { readonly allowed: boolean; readonly origin: Extract<Origin, { kind: "probe" }> }
    | {
        readonly allowed: boolean;
        readonly origin: Extract<Origin, { kind: "engine" }>;
        readonly parentEventId: string;
        readonly storeRef: string;
      },
): (CpsatObservation & { readonly fact: Dispatch }) | null {
  if (
    authorization.allowed !== true ||
    text === null ||
    text.length > 16_384 ||
    new TextEncoder().encode(text).byteLength > 16_384
  )
    return null;
  const input = parseCpsatObservation(text);
  if (
    input === null ||
    input.mode !== (authorization.origin.kind === "probe" ? "probe" : "live") ||
    input.backend !== "cpsat" ||
    input.fact.type !== "cpsat.request-dispatched" ||
    input.fact.sameInputRetry !== false ||
    input.versions.code !== manifest.code ||
    input.versions.codec !== manifest.codec ||
    input.versions.wasm !== manifest.wasm ||
    input.versions.glue !== manifest.glue ||
    input.versions.profile !== manifest.profile ||
    input.versions.missingReason !== null ||
    input.at < manifest.notBefore ||
    input.at > Date.now() ||
    !manifest.stores.some((store) => store.ref === input.storeRef) ||
    !manifest.problems.some(
      (problem) =>
        problem.sha256 === input.versions.model && String(problem.budget) === input.versions.budget,
    )
  )
    return null;
  const origin = input.fact.origin;
  if ("parentEventId" in authorization) {
    if (
      origin.kind !== "engine" ||
      origin.instanceId !== authorization.origin.instanceId ||
      origin.decisionId !== authorization.origin.decisionId ||
      origin.effectIndex !== authorization.origin.effectIndex ||
      input.instanceId !== origin.instanceId ||
      input.parentEventId !== authorization.parentEventId ||
      input.storeRef !== authorization.storeRef
    )
      return null;
  } else if (origin.kind !== "probe" || input.parentEventId !== null) {
    return null;
  }
  return { ...input, fact: input.fact };
}

/** One observed binding attempt; no retries, alternate URL or TS fallback. */
export async function dispatchCpsatTransportRequest(
  input: NonNullable<ReturnType<typeof toCpsatTransportRequest>>,
  solver: Pick<Fetcher, "fetch">,
  withinWindow: () => boolean,
): Promise<Response> {
  const dispatched: CpsatObservation = {
    ...input,
    eventId: crypto.randomUUID(),
    at: Date.now(),
    // An Effect dispatch must retain its DO execution identity and Persist
    // parent. A direct probe must not borrow the caller's supplied identity.
    instanceId: input.fact.origin.kind === "probe" ? crypto.randomUUID() : input.instanceId,
    invocationId: input.fact.origin.kind === "probe" ? crypto.randomUUID() : input.invocationId,
  };
  const request = new Request("https://solver.invalid/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dispatched),
  });
  // Mandatory, fresh check at the effect boundary, not a boolean captured
  // before an await. No asynchronous work separates this check and fetch.
  // Window expiry is deliberately observation-free here: no send happened.
  // Its 503/reason belongs to the caller's trial ledger, not dispatch counts.
  if (!withinWindow()) return new Response(null, { status: 503 });
  if (!observeCpsat(dispatched)) return new Response(null, { status: 503 });
  let status = 503;
  try {
    const response = await solver.fetch(request);
    status = response.status;
    await response.body?.cancel();
  } catch {
    // Transport failure is recorded below, never retried here.
  }
  const recorded = observeCpsat({
    ...dispatched,
    eventId: crypto.randomUUID(),
    at: Date.now(),
    parentEventId: dispatched.eventId,
    fact: {
      type: "cpsat.dispatch-result",
      requestId: input.fact.requestId,
      outcome: status === 202 ? "accepted" : status === 429 ? "busy" : "failed",
    },
  });
  return Response.json(
    { accepted: status === 202, requestId: input.fact.requestId },
    { status: recorded && status === 202 ? 202 : recorded && status === 429 ? 429 : 503 },
  );
}

/**
 * 輸送への投入（Queue 版）。`dispatchCpsatTransportRequest` の兄弟で、**違いは送り先だけ**である。
 *
 * 期限の再検査・観測・結果の記録は同じ順序で行う。違うのは 2 点。
 *
 * 1. **送出前にサイズを検査する**（R6.4）。1 通の上限を超える要求は送らず、`too-large` として
 *    記録する。黙って落とすと、届かない要求と送っていない要求が観測から区別できなくなる。
 * 2. **await するのは投入の完了だけ**である（R6.7）。求解の結末も配送の結末も待たない——
 *    待てば呼出元が求解に握られ、それが初期案を不成立にした当のものである。
 */
export async function sendCpsatTransportRequest(
  input: NonNullable<ReturnType<typeof toCpsatTransportRequest>>,
  queue: Queue<CpsatQueueMessage>,
  withinWindow: () => boolean,
): Promise<Response> {
  const dispatched: CpsatObservation = {
    ...input,
    eventId: crypto.randomUUID(),
    at: Date.now(),
    instanceId: input.fact.origin.kind === "probe" ? crypto.randomUUID() : input.instanceId,
    invocationId: input.fact.origin.kind === "probe" ? crypto.randomUUID() : input.invocationId,
  };
  // Mandatory, fresh check at the effect boundary, with nothing asynchronous
  // between it and the send.
  if (!withinWindow()) return new Response(null, { status: 503 });
  // **親を先に出す。** 結末の行は `dispatched.eventId` を親に指すので、検査で落ちる
  // 経路でも親が観測に載っていなければ、結末だけが親のいない孤児になる。
  if (!observeCpsat(dispatched)) return new Response(null, { status: 503 });
  const payload = checkQueuePayload({ row: dispatched });
  if (!payload.ok) {
    // 記録して落とす（R6.4）。`outcome` の和型に「大きすぎる」を表す値が無いため、
    // 結末は `failed` にしつつ、理由は非 H1 の受領ログで残す——観測スキーマへ
    // 種別を足すかは src への追加変更であり、別に判断する。この 2 行が揃って
    // はじめて「送っていない要求」と「送って届かなかった要求」が区別できる。
    console.log(
      JSON.stringify({
        transport: "cpsat-queue-producer",
        outcome: "too-large",
        requestId: input.fact.requestId,
        storeRef: dispatched.storeRef,
        bytes: payload.bytes,
        limit: QUEUE_PAYLOAD_LIMIT_BYTES,
      }),
    );
    observeCpsat({
      ...dispatched,
      eventId: crypto.randomUUID(),
      at: Date.now(),
      parentEventId: dispatched.eventId,
      fact: {
        type: "cpsat.dispatch-result",
        requestId: input.fact.requestId,
        outcome: "failed",
      },
    });
    return new Response(null, { status: 413 });
  }
  let sent = false;
  try {
    await queue.send({ row: dispatched });
    sent = true;
  } catch {
    // Transport failure is recorded below, never retried here.
  }
  const recorded = observeCpsat({
    ...dispatched,
    eventId: crypto.randomUUID(),
    at: Date.now(),
    parentEventId: dispatched.eventId,
    fact: {
      type: "cpsat.dispatch-result",
      requestId: input.fact.requestId,
      outcome: sent ? "accepted" : "failed",
    },
  });
  return Response.json(
    { accepted: sent && recorded, requestId: input.fact.requestId },
    { status: sent && recorded ? 202 : 503 },
  );
}
