// tests/client/wireDecodeFailure.integration.test.ts — Property 6（client 側）。
//
// **Validates: Requirements 2.9, 2.10, 2.11**
//
// 記録を出すのは Decoder ではなく受け口である。domain のテストからは console.error の呼び出しが見えない
// ため、ここで Connectivity_Watch を実際に走らせて観測する。
//
// 押さえるのは三つ。壊れた ServerMessage で記録が 1 件残ること。記録に Wire_Text の中身が入らないこと
// （snapshot の pendingOrders は externalOrderId / tableId を含み、これは POS 由来の業務データである）。
// そして Decode_Failure が Connectivity を動かさないこと——凍っていることは到達性の問題ではなく、
// pong による up の確定は変えない。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connectivity, Socket, SocketListeners } from "../../src/client/connection";
import { PONG_RESPONSE, watchConnectivity } from "../../src/client/connectivity";

const WS_URL = "wss://example.test/ws";
const RECEIVED_AT = 1_700_000_000_000;

interface FakeSocket extends Socket {
  readonly sent: string[];
}

function openFakeSocket(): { socket: FakeSocket; listeners: SocketListeners } {
  const sent: string[] = [];
  let captured: SocketListeners | undefined;
  const socket: FakeSocket = {
    sent,
    send: (frame: string) => {
      sent.push(frame);
    },
    close: () => {},
  };
  const opener = (_url: string, listeners: SocketListeners): Socket => {
    captured = listeners;
    return socket;
  };
  const watch = watchConnectivity(WS_URL, opener, () => RECEIVED_AT);
  const statuses: Connectivity[] = [];
  watch.onConnectivity((status) => statuses.push(status));
  if (captured === undefined) throw new Error("listeners was not captured");
  Object.assign(socket, { statuses, watch });
  return { socket, listeners: captured };
}

describe("Feature: verified-wire-contract, Property 6: Decode_Failure の可観測性（client）", () => {
  let errors: unknown[][];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("壊れた ServerMessage を受けると記録が 1 件残る", () => {
    const { listeners } = openFakeSocket();
    listeners.onOpen();
    listeners.onMessage(JSON.stringify({ type: "snapshot", serverTime: 1, timers: [] }));
    expect(errors).toHaveLength(1);
    expect(JSON.parse(String(errors[0]?.[0]))).toEqual({
      kind: "decode-failure",
      contract: "ServerMessage",
    });
  });

  it("記録に Wire_Text の中身（POS 由来の識別子）が入らない", () => {
    const { listeners } = openFakeSocket();
    listeners.onOpen();
    listeners.onMessage(
      JSON.stringify({
        type: "snapshot",
        serverTime: 1,
        timers: [],
        pendingOrders: [{ externalOrderId: "secret-order", tableId: "secret-table" }],
      }),
    );
    const line = String(errors[0]?.[0]);
    expect(line).not.toContain("secret-order");
    expect(line).not.toContain("secret-table");
  });

  it("撤去済み種別も記録される（無音で消えない）", () => {
    const { listeners } = openFakeSocket();
    listeners.onOpen();
    listeners.onMessage(JSON.stringify({ type: "boiled", serverTime: 1, timerId: "T" }));
    expect(errors).toHaveLength(1);
  });

  it("Decode_Failure は Connectivity を動かさない（pong による up の確定は変わらない）", () => {
    const statuses: Connectivity[] = [];
    let captured: SocketListeners | undefined;
    const watch = watchConnectivity(
      WS_URL,
      (_url, listeners) => {
        captured = listeners;
        return { send: () => {}, close: () => {} };
      },
      () => RECEIVED_AT,
    );
    watch.onConnectivity((status) => statuses.push(status));
    if (captured === undefined) throw new Error("listeners was not captured");
    captured.onOpen();
    captured.onMessage(JSON.stringify({ type: "snapshot", serverTime: 1, timers: [] }));
    expect(statuses).toEqual([]); // 復号失敗だけでは up も down も確定しない
    captured.onMessage(PONG_RESPONSE);
    expect(statuses).toEqual(["up"]); // pong の経路は無傷
    watch.close();
  });
});
