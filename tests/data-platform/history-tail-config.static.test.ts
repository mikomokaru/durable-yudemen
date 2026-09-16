// 新経路の能力境界を設定から機械的に固定する（operation-history-log 要件 4.1・P1）。
//
// 見るのは二点だけである。
//   - Tail には Stream binding だけがあり、Producer／StoreTimerDO へ戻る能力を持たない。
//   - Producer root には Stream binding が無い。本体から Pipelines へ直接送れないことを、
//     生成される Env 型に当該能力が現れないという形で保証する。
//
// 旧 Snowpipe 方式の設定 graph は tests/operation-history/config-graph.static.test.ts が
// 見ている。あちらは旧構成の検査として残し、こちらが新構成を見る。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsoncToJson } from "../operation-history/support/jsonc";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type WranglerConfig = Record<string, unknown> & {
  readonly name?: string;
  readonly main?: string;
  readonly workers_dev?: boolean;
  readonly preview_urls?: boolean;
  readonly pipelines?: readonly { readonly binding?: string; readonly stream?: string }[];
};

function config(relativePath: string): WranglerConfig {
  return JSON.parse(jsoncToJson(readFileSync(resolve(repoRoot, relativePath), "utf8")));
}

const tail = config("wrangler.history-tail.jsonc");
const producer = config("wrangler.jsonc");
const tailSource = readFileSync(resolve(repoRoot, "src/data-platform/history-tail.ts"), "utf8");

/** Data Platform から Producer へ戻り得る能力。どれか一つでも現れたら逆経路が開く。 */
const REVERSE_CAPABILITIES = [
  "durable_objects",
  "services",
  "queues",
  "r2_buckets",
  "kv_namespaces",
  "d1_databases",
  "routes",
  "route",
  "triggers",
  "assets",
  "vars",
] as const;

describe("Tail の能力境界", () => {
  it("入口のソースと名前が設定と一致する", () => {
    expect(tail.name).toBe("yude-men-history-tail");
    expect(tail.main).toBe("src/data-platform/history-tail.ts");
  });

  it("Stream binding は dataset ごとの 3 つだけである", () => {
    // 共有 Stream に pipeline SQL で振り分ける形を採らない（要件 4.9）。dataset が増えれば
    // ここも増えるが、**それ以外の binding は増えない**ことをこの一致で固定する。
    expect(tail.pipelines?.map((binding) => binding.binding)).toEqual([
      "HISTORY_ARRIVALS",
      "LIFT_DELAY_ARRIVALS",
      "ORDER_ARRIVAL_ARRIVALS",
    ]);
  });

  it("binding 名がコードの env 型と一致する", () => {
    expect(tailSource).toContain("HISTORY_ARRIVALS");
    expect(tailSource).toContain("LIFT_DELAY_ARRIVALS");
    expect(tailSource).toContain("ORDER_ARRIVAL_ARRIVALS");
  });

  it("どの binding も別の Stream を指す", () => {
    const streams = tail.pipelines?.map((binding) => binding.stream) ?? [];

    expect(new Set(streams).size).toBe(streams.length);
  });

  it("Producer へ戻る能力を一つも持たない", () => {
    for (const capability of REVERSE_CAPABILITIES) {
      expect(tail[capability], `${capability} が Tail 設定にある`).toBeUndefined();
    }
  });

  it("ネットワークへ露出しない", () => {
    expect([tail.workers_dev, tail.preview_urls]).toEqual([false, false]);
  });

  it("StoreTimerDO へ到達する名前をコードに持たない", () => {
    expect(tailSource).not.toContain("STORE_TIMER_DO");
    expect(tailSource).not.toContain("DurableObject");
  });
});

describe("Producer root の能力境界", () => {
  it("Stream binding を持たない", () => {
    expect(producer.pipelines).toBeUndefined();
  });

  it("新旧の Tail を同時に attach しない", () => {
    const attached = producer.tail_consumers;
    // 現状はどちらも未 attach（review-evidence.md の棚卸しと一致）。有効化はタスク 7.2 で
    // 片方だけを繋ぐ。両方が並ぶ状態を設定として許さない。
    expect(Array.isArray(attached) ? attached.length : 0).toBeLessThanOrEqual(1);
  });
});
