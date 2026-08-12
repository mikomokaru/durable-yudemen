// タスク 11.1 の確認結果を実行可能な形で残す検査。
// 導入済み Wrangler v4 の config-schema.json（`node_modules/wrangler/config-schema.json`）だけを
// 出所として、tail_consumers・queues.producers・queues.consumers・r2_buckets のキーと配置を固定する。
// 後続タスク 11.2（root は Tail attachment だけ）と 11.3（Tail は Queue producer、Consumer は
// Queue consumer と R2）は、ここで検査に通った fragment 形をそのまま設定へ写す。
// 公式資料（Wrangler configuration / Tail Workers / Queues / R2）と照合した差分は下のコメントに残す。
//
// 名前の扱い: binding 名と Queue 名はタスク 1 で確定した実名を使う。Tail Worker script 名と
// R2 bucket 名は本タスクで確定していないため placeholder のままにし、推測で固定しない。
//
// _Requirements: 4.1, 4.3, 4.5, 4.12, 4.13_

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type SchemaNode = {
  readonly $ref?: string;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | SchemaNode;
};
type ConfigSchema = { readonly definitions: Readonly<Record<string, SchemaNode>> };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schema = JSON.parse(
  readFileSync(resolve(repoRoot, "node_modules/wrangler/config-schema.json"), "utf8"),
) as ConfigSchema;

function deref(node: SchemaNode): SchemaNode {
  const ref = node.$ref;
  if (ref === undefined) return node;
  const name = ref.replace("#/definitions/", "");
  const target = schema.definitions[name];
  expect(target, `definition ${name}`).toBeDefined();
  return deref(target!);
}

function schemaAt(path: readonly string[]): SchemaNode {
  return path.reduce<SchemaNode>((node, key) => {
    const next = key === "[]" ? deref(node).items : deref(node).properties?.[key];
    expect(next, `schema path ${path.join(".")} (${key})`).toBeDefined();
    return next!;
  }, schema.definitions.RawConfig!);
}

function declaredKeys(path: readonly string[]): readonly string[] {
  return Object.keys(deref(schemaAt(path)).properties ?? {}).sort();
}

function requiredKeys(path: readonly string[]): readonly string[] {
  return [...(deref(schemaAt(path)).required ?? [])].sort();
}

/** 設定 fragment のキーが schema に宣言されているか、必須キーが揃っているかを再帰的に照合する。 */
function schemaViolations(fragment: unknown, node: SchemaNode, path = "$"): readonly string[] {
  const resolved = deref(node);
  if (Array.isArray(fragment)) {
    const items = resolved.items;
    if (items === undefined) return [`${path}: array not allowed`];
    return fragment.flatMap((entry, index) => schemaViolations(entry, items, `${path}[${index}]`));
  }
  if (typeof fragment !== "object" || fragment === null) return [];
  const properties = resolved.properties;
  if (properties === undefined) return [`${path}: object not allowed`];
  const entries = Object.entries(fragment as Record<string, unknown>);
  const unknown = entries
    .filter(([key]) => !(key in properties))
    .map(([key]) => `${path}.${key}: unknown key`);
  const missing = (resolved.required ?? [])
    .filter((key) => !(key in (fragment as Record<string, unknown>)))
    .map((key) => `${path}.${key}: missing required key`);
  const nested = entries.flatMap(([key, value]) =>
    key in properties ? schemaViolations(value, properties[key]!, `${path}.${key}`) : [],
  );
  return [...unknown, ...missing, ...nested];
}

const rawConfig = schema.definitions.RawConfig!;

// タスク 11.2 が root `wrangler.jsonc` へ写す fragment。Tail attachment だけを持つ。
const producerFragment = {
  tail_consumers: [{ service: "<TAIL_WORKER_SCRIPT_NAME>" }],
} as const;

// タスク 11.3 が Data Platform 側 Tail Worker 設定へ写す fragment。Queue producer だけを持つ。
const tailWorkerFragment = {
  queues: {
    producers: [{ binding: "OPERATION_RECORDS", queue: "operation-records" }],
  },
} as const;

// タスク 11.3 が Data Platform 側 Consumer 設定へ写す fragment。
// Queue consumer（再配送・dead-letter 方針を含む）と R2 binding を持つ。
const consumerFragment = {
  queues: {
    consumers: [
      {
        queue: "operation-records",
        max_retries: 5,
        dead_letter_queue: "operation-records-dlq",
      },
    ],
  },
  r2_buckets: [{ binding: "OPERATION_RAW_ARRIVALS", bucket_name: "<R2_BUCKET_NAME>" }],
} as const;

describe("Wrangler v4 schema で確認した Operation History の設定キー", () => {
  it("導入済み Wrangler は v4 系である", () => {
    const installed = JSON.parse(
      readFileSync(resolve(repoRoot, "node_modules/wrangler/package.json"), "utf8"),
    ) as { readonly version: string };
    expect(installed.version.startsWith("4.")).toBe(true);
  });

  it("tail_consumers は top-level と named environment の両方に置ける配列である", () => {
    // 公式 Tail Workers 資料と同じ形: `"tail_consumers": [{ "service": "<TAIL_WORKER_NAME>" }]`。
    // 名前付き environment へは継承されないため、環境ごとに書く必要がある（schema description）。
    for (const definition of ["RawConfig", "RawEnvironment"] as const) {
      expect(schema.definitions[definition]?.properties?.tail_consumers).toBeDefined();
    }
    expect(declaredKeys(["tail_consumers", "[]"])).toEqual(["environment", "service"]);
    expect(requiredKeys(["tail_consumers", "[]"])).toEqual(["service"]);
  });

  it("Queue producer は queues.producers 配列で binding と queue を必須にする", () => {
    expect(declaredKeys(["queues"])).toEqual(["consumers", "producers"]);
    expect(requiredKeys(["queues", "producers", "[]"])).toEqual(["binding", "queue"]);
    // 一部の外部サンプルにある `name` は schema に無い（additionalProperties: false のため不正）。
    expect(declaredKeys(["queues", "producers", "[]"])).not.toContain("name");
    expect(deref(schemaAt(["queues", "producers", "[]"])).additionalProperties).toBe(false);
  });

  it("Queue consumer は queues.consumers 配列で queue だけを必須にし、再配送方針を同じ item に置く", () => {
    expect(requiredKeys(["queues", "consumers", "[]"])).toEqual(["queue"]);
    for (const key of ["dead_letter_queue", "max_retries", "retry_delay", "max_batch_size"]) {
      expect(declaredKeys(["queues", "consumers", "[]"])).toContain(key);
    }
    expect(declaredKeys(["queues", "consumers", "[]"])).not.toContain("name");
  });

  it("R2 binding は r2_buckets 配列で binding と bucket_name を使う", () => {
    // schema の required は binding だけだが（draft binding を許すため）、公式 R2 資料は
    // bucket_name も required と示す。実設定では常に両方書く。
    expect(requiredKeys(["r2_buckets", "[]"])).toEqual(["binding"]);
    expect(declaredKeys(["r2_buckets", "[]"])).toContain("bucket_name");
  });

  it("後続タスクが写す三つの fragment は schema 違反を持たない", () => {
    expect(schemaViolations(producerFragment, rawConfig)).toEqual([]);
    expect(schemaViolations(tailWorkerFragment, rawConfig)).toEqual([]);
    expect(schemaViolations(consumerFragment, rawConfig)).toEqual([]);
  });

  it("Producer fragment は Queue／R2 キーを持たない", () => {
    const producerKeys = Object.keys(producerFragment);
    expect(producerKeys).toEqual(["tail_consumers"]);
    expect(producerKeys).not.toContain("queues");
    expect(producerKeys).not.toContain("r2_buckets");
  });
});
