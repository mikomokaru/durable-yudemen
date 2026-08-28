// tests/worker/websocket-upgrade.integration.test.ts — 不正な WebSocket アップグレード要求の拒否（Workers pool）。
//
// _Validates: Requirements 9.6_
//
// 検証する不変（要件9.6・design.md「WebSocket 確立シーケンス」）：
//   9.6  受信したアップグレード要求が WebSocket アップグレードとして不正であるとき、Worker は当該要求を
//        Store_Timer_DO へ引き渡さず拒否する（拒否のステータスは 426・タスク 14.1）。
//
// **主張は二つあり、片方だけでは足りない。** ステータス 426 は拒否の表明にすぎず、「DO へ引き渡さない」は
// 転送先でしか観測できない。ゆえに転送先 `STORE_TIMER_DO` を横取りする観測ハーネス
// （tests/worker/support/storeTimerSink.ts）を差し込み、DO の `fetch` が呼ばれていないことを直接確かめる。
// 同じハーネスを identity-header.integration.test.ts が使う（観測の形を二重に持たない）。
//
// 正当な要求も 1 組みおく。すべてを拒否する実装でも通ってしまう試験は、拒否を検証していない。
//
// 実装が「不正」とみなす規則は `src/worker.ts` の `request.headers.get("Upgrade") !== "websocket"` ただ一つ
// である（厳密な文字列一致）。ゆえにヘッダ欠如・別プロトコル値・値の大小文字違いはいずれも不正であり、
// ヘッダ名の大小文字違いは（HTTP ヘッダ名が大小文字非依存ゆえ）正当である。この非対称そのものを固める。
//
// 置き場について：`tests/worker/**/*.example.test.ts` は vitest.config.ts が node（既定 pool）へ振り分ける
// が、本テストは `worker.fetch` を踏むため workerd が要る（`src/worker.ts` は DO の re-export で
// cloudflare:workers を引き込む）。ゆえに Workers pool へ載る `*.integration.test.ts` を名に採る。

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/worker";
import { capturingStoreNamespace, emptyForwardSink } from "./support/storeTimerSink";

// cloudflare:test の env を本 Worker の Env 型で解決する。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// run 間で衝突しない storeId を採番する（[a-z0-9-]・長さ 1..64 を満たす・要件1.2）。
// storeId 検証は Upgrade 検証より前段にあるため、不正な storeId では 400 が先に返り 9.6 を踏めない。
function freshStoreId(): string {
  return `upgrade-guard-${crypto.randomUUID()}`;
}

/** クライアントが送る Upgrade ヘッダ（name は表記差の検証に使う。null は「ヘッダを送らない」）。 */
interface UpgradeHeader {
  readonly name: string;
  readonly value: string;
}

/**
 * driveUpgrade — `/s/{storeId}/ws` を Worker に通し、応答と「DO が受信した Request」を返す。
 *
 * ACCESS_REQUIRED は既定 "0"（合鍵 URL のみ）で、Upgrade 検証の可否だけを見る経路に絞る。ON の場合も
 * 引数で踏めるようにしてある——426 が Access 検証より前段にあることを固めるためである。
 */
async function driveUpgrade(params: {
  readonly storeId: string;
  readonly upgrade: UpgradeHeader | null;
  readonly accessRequired?: "0" | "1";
}): Promise<{ readonly response: Response; readonly forwarded: Request | null }> {
  const sink = emptyForwardSink();
  const headers = new Headers();
  if (params.upgrade !== null) {
    headers.set(params.upgrade.name, params.upgrade.value);
  }
  const request = new Request(`https://upgrade.invalid/s/${params.storeId}/ws`, { headers });
  const testEnv = {
    ...env,
    STORE_TIMER_DO: capturingStoreNamespace(sink),
    ACCESS_REQUIRED: params.accessRequired ?? "0",
  } as unknown as Env;
  const response = await worker.fetch(request, testEnv);
  return { response, forwarded: sink.forwarded };
}

// 不正とみなされる Upgrade の代表例。いずれも `get("Upgrade") !== "websocket"` を満たす。
const INVALID_UPGRADES: readonly { readonly label: string; readonly upgrade: UpgradeHeader | null }[] = [
  // ヘッダ欠如（画面 URL の代わりに /ws を直に叩いた素の GET）。`get` は null を返す。
  { label: "Upgrade ヘッダなし", upgrade: null },
  // 別プロトコルへの昇格要求。WebSocket ではないため店舗 DO の関心事に当たらない。
  { label: "Upgrade: h2c（別プロトコル）", upgrade: { name: "Upgrade", value: "h2c" } },
  // 値が空。ヘッダは在るが昇格先を名指していない。
  { label: "Upgrade: 空値", upgrade: { name: "Upgrade", value: "" } },
  // 値の大小文字違い。実装は厳密一致ゆえ不正である（RFC 上のトークン非依存性には寄りかからない）。
  { label: "Upgrade: WebSocket（値の大小文字違い）", upgrade: { name: "Upgrade", value: "WebSocket" } },
  // 複数プロトコルを並べた値。"websocket" を含むが厳密一致しないため不正である（部分一致で通さない）。
  { label: "Upgrade: websocket, h2c（複合値）", upgrade: { name: "Upgrade", value: "websocket, h2c" } },
];

describe("worker fetch — 不正な Upgrade は 426 で拒否し店舗 DO へ引き渡さない（Requirements 9.6）", () => {
  for (const { label, upgrade } of INVALID_UPGRADES) {
    it(`${label} は 426 で拒否され DO の fetch は呼ばれない`, async () => {
      const { response, forwarded } = await driveUpgrade({ storeId: freshStoreId(), upgrade });

      expect(response.status).toBe(426);
      // 「引き渡さない」の実体はこちら。転送先 DO は一度も呼ばれていない（要件9.6 の主部）。
      expect(forwarded).toBeNull();
    });
  }

  it('ACCESS_REQUIRED="1" でも不正 Upgrade は 426（Access 検証より前段で拒否し DO へ行かせない）', async () => {
    // JWT を持たない直叩き。Access 検証まで進めば 403 になるが、Upgrade 検証が前段ゆえ 426 が返る。
    // どちらに転んでも DO へは到達しない——拒否の前段化は、署名検証を起こさずに済ませる分だけ善い。
    const { response, forwarded } = await driveUpgrade({
      storeId: freshStoreId(),
      upgrade: { name: "Upgrade", value: "h2c" },
      accessRequired: "1",
    });

    expect(response.status).toBe(426);
    expect(forwarded).toBeNull();
  });
});

describe("worker fetch — 正当な Upgrade は店舗 DO へ引き渡す（9.6 の対偶・要件9.1）", () => {
  // 対照。すべてを拒否する実装でも上の describe は通ってしまうため、正当な要求が通ることを併せて固める。
  it("Upgrade: websocket は DO へ転送される（426 にならない）", async () => {
    const storeId = freshStoreId();
    const { response, forwarded } = await driveUpgrade({
      storeId,
      upgrade: { name: "Upgrade", value: "websocket" },
    });

    expect(response.status).toBe(200);
    expect(forwarded).not.toBeNull();
    // 転送先には同じ宛先パスの Request が渡る（Upgrade ヘッダも保たれる）。
    expect(new URL(forwarded?.url ?? "https://invalid.invalid").pathname).toBe(`/s/${storeId}/ws`);
    expect(forwarded?.headers.get("Upgrade")).toBe("websocket");
  });

  it("ヘッダ名の大小文字違い（upgrade: websocket）も正当として転送される", async () => {
    // HTTP ヘッダ名は大小文字非依存ゆえ、`get("Upgrade")` は "upgrade" で送られた値を読む。
    // 不正なのは値の違いだけであるという非対称を、ここで明示する。
    const { response, forwarded } = await driveUpgrade({
      storeId: freshStoreId(),
      upgrade: { name: "upgrade", value: "websocket" },
    });

    expect(response.status).toBe(200);
    expect(forwarded).not.toBeNull();
  });
});
