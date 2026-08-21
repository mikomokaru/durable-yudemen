// タスク 11.4 の検査。三つの Wrangler 設定（Producer root / Tail Worker / Queue Consumer）を
// machine-readable な capability graph へ写し、その edge 集合と資源名の写しを固定する。
//
// この検査の担当は「能力境界」と「名前の写し違い」の二点だけである。
//   - 能力境界: root は Tail attachment だけ、Tail は Queue producer だけ、Consumer は Queue
//     consumer と R2 だけを持ち、Data Platform から Producer へ向かう edge が 0 件である。
//   - 名前の写し違い: 同じ事実（Producer script 名・Tail Worker 名・binding 名）が設定とコードの
//     二箇所に書かれている箇所を機械的に突き合わせ、片方だけ直した状態を落とす。
//
// 既存検査との分担（重複を作らない）:
//   - tests/operation-history/no-wake.static.test.ts … O1〜O7。AST で capability の「形」を見る。
//   - tests/operation-history/wrangler-config-keys.static.test.ts … 設定キーが Wrangler v4 schema に
//     宣言されているか。ここでは schema ではなく実設定の graph を見る。
//   - tests/operation-history/no-backfill.static.test.ts … 縮退経路（Logpush）と補完機構（backfill /
//     再出力 / outbox / DO 再起動）の不在。リポジトリ全体を対象にする。
//
// _Requirements: 1.3, 1.8, 1.9, 2.15, 4.10, 4.13, 4.14, 4.15_

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { jsoncToJson } from "./support/jsonc";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const producerConfigPath = "wrangler.jsonc";
const tailConfigPath = "wrangler.telemetry-tail.jsonc";
const consumerConfigPath = "wrangler.raw-arrival-consumer.jsonc";
const tailFilterPath = "src/operation-history/tail.ts";
const producerRoot = "src/operation-history/producer.ts";

function source(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

type WranglerConfig = {
  readonly name?: string;
  readonly main?: string;
  readonly workers_dev?: boolean;
  readonly preview_urls?: boolean;
  readonly route?: string;
  readonly routes?: readonly unknown[];
  readonly triggers?: { readonly crons?: readonly string[] };
  readonly tail_consumers?: readonly { readonly service: string }[];
  readonly queues?: {
    readonly producers?: readonly { readonly binding: string; readonly queue: string }[];
    readonly consumers?: readonly {
      readonly queue: string;
      readonly dead_letter_queue?: string;
    }[];
  };
  readonly r2_buckets?: readonly { readonly binding: string; readonly bucket_name: string }[];
  readonly kv_namespaces?: readonly unknown[];
  readonly d1_databases?: readonly unknown[];
  readonly durable_objects?: { readonly bindings?: readonly { readonly name: string; readonly class_name: string }[] };
  readonly services?: readonly { readonly binding: string; readonly service: string }[];
  readonly env?: Readonly<Record<string, { readonly name?: string }>>;
};

function config(relativePath: string): WranglerConfig {
  return JSON.parse(jsoncToJson(source(relativePath))) as WranglerConfig;
}

/**
 * 宣言されている tail attachment の service 名。root の tail_consumers は段階的有効化のため
 * コメントアウト状態で置かれる（実在しない Tail Worker を指すと wrangler deploy が壊れる）。
 * コメント記号を外した本文からも読むことで、有効化前でも同じ突き合わせが効く。
 */
function declaredTailConsumerServices(relativePath: string): readonly string[] {
  const uncommented = source(relativePath).replace(/^(\s*)\/\/ ?/gm, "$1");
  return [...uncommented.matchAll(/"tail_consumers"\s*:\s*\[([^\]]*)\]/g)].flatMap(([, body]) =>
    [...(body ?? "").matchAll(/"service"\s*:\s*"([^"]+)"/g)].map(([, service]) => service!),
  );
}

const producerConfig = config(producerConfigPath);
const tailConfig = config(tailConfigPath);
const consumerConfig = config(consumerConfigPath);

/** capability graph の一本。`from` が `to` へ、`via`（binding／設定キー）を通して到達できる。 */
type CapabilityEdge = {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly via: string;
};

function printEdge(edge: CapabilityEdge): string {
  return `${edge.from} -[${edge.kind}:${edge.via}]-> ${edge.to}`;
}

function capabilityEdges(
  configPath: string,
  parsed: WranglerConfig,
): readonly CapabilityEdge[] {
  const worker = parsed.name ?? configPath;
  const edges: CapabilityEdge[] = [];
  for (const service of declaredTailConsumerServices(configPath)) {
    edges.push({ from: worker, to: service, kind: "tail-attachment", via: "tail_consumers" });
  }
  for (const producer of parsed.queues?.producers ?? []) {
    edges.push({ from: worker, to: producer.queue, kind: "queue-producer", via: producer.binding });
  }
  for (const consumer of parsed.queues?.consumers ?? []) {
    edges.push({ from: consumer.queue, to: worker, kind: "queue-consumer", via: "queues.consumers" });
    if (consumer.dead_letter_queue !== undefined) {
      edges.push({
        from: worker,
        to: consumer.dead_letter_queue,
        kind: "dead-letter",
        via: "dead_letter_queue",
      });
    }
  }
  for (const bucket of parsed.r2_buckets ?? []) {
    edges.push({ from: worker, to: bucket.bucket_name, kind: "r2-bucket", via: bucket.binding });
  }
  for (const binding of parsed.durable_objects?.bindings ?? []) {
    edges.push({ from: worker, to: binding.class_name, kind: "durable-object", via: binding.name });
  }
  for (const service of parsed.services ?? []) {
    edges.push({ from: worker, to: service.service, kind: "service", via: service.binding });
  }
  for (const route of parsed.routes ?? []) {
    edges.push({ from: "internet", to: worker, kind: "route", via: JSON.stringify(route) });
  }
  if (parsed.route !== undefined) {
    edges.push({ from: "internet", to: worker, kind: "route", via: parsed.route });
  }
  for (const cron of parsed.triggers?.crons ?? []) {
    edges.push({ from: "cron", to: worker, kind: "scheduled", via: cron });
  }
  return edges;
}

const producerEdges = capabilityEdges(producerConfigPath, producerConfig);
const tailEdges = capabilityEdges(tailConfigPath, tailConfig);
const consumerEdges = capabilityEdges(consumerConfigPath, consumerConfig);

/** Producer を指す node 名。Data Platform 側の edge がここへ向かってはならない。 */
const producerNodes = new Set(
  [
    producerConfig.name,
    ...Object.values(producerConfig.env ?? {}).map((environment) => environment.name),
    ...(producerConfig.durable_objects?.bindings ?? []).flatMap((binding) => [binding.name, binding.class_name]),
  ].filter((name): name is string => name !== undefined),
);

/** Operation History の下流資源名（タスク 1・11.3 の確定値）。Producer 側に現れてはならない。 */
const downstreamNames = [
  "yude-men-telemetry-tail",
  "yude-men-raw-arrival-consumer",
  "operation-records",
  "operation-records-dlq",
  "operation-raw-arrivals",
  "OPERATION_RECORDS",
  "OPERATION_RAW_ARRIVALS",
] as const;
const downstreamKinds = new Set(["queue-producer", "queue-consumer", "dead-letter", "r2-bucket"]);

function isOperationHistoryEdge(edge: CapabilityEdge): boolean {
  if (edge.kind === "tail-attachment" || downstreamKinds.has(edge.kind)) return true;
  return downstreamNames.some((name) => edge.from === name || edge.to === name || edge.via === name);
}

/** Producer 観測 module の推移 import graph（相対 import だけを辿る）。 */
function producerImportGraph(): { readonly files: readonly string[]; readonly externals: readonly string[] } {
  const pending = [producerRoot];
  const files = new Set<string>();
  const externals = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || files.has(current)) continue;
    files.add(current);
    const file = ts.createSourceFile(current, source(current), ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) {
      const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        && statement.moduleSpecifier !== undefined
        && ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
      if (specifier === undefined) continue;
      if (!specifier.startsWith(".")) {
        externals.add(specifier);
        continue;
      }
      const base = resolve(repoRoot, dirname(current), specifier);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")].find(existsSync);
      if (resolved === undefined) throw new Error(`${current}: ${specifier} を解決できない`);
      pending.push(resolved.slice(repoRoot.length + 1).split("\\").join("/"));
    }
  }
  return { files: [...files].sort(), externals: [...externals].sort() };
}

/** `src/operation-history/tail.ts` の PRODUCER_SCRIPTS に列挙された script 名。 */
function producerScriptsFromTailFilter(): readonly string[] {
  const file = ts.createSourceFile(tailFilterPath, source(tailFilterPath), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "PRODUCER_SCRIPTS"
      && node.initializer !== undefined
    ) {
      found = true;
      const collect = (child: ts.Node): void => {
        if (ts.isStringLiteralLike(child)) names.push(child.text);
        child.forEachChild(collect);
      };
      collect(node.initializer);
    }
    node.forEachChild(visit);
  };
  visit(file);
  expect(found, `${tailFilterPath} に PRODUCER_SCRIPTS がない`).toBe(true);
  return names.sort();
}

/** module が宣言する Env interface の binding 名。設定の binding と突き合わせる。 */
function envBindingNames(relativePath: string, interfaceName: string): readonly string[] {
  const file = ts.createSourceFile(relativePath, source(relativePath), ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
  );
  expect(declaration, `${relativePath} に interface ${interfaceName} がない`).toBeDefined();
  const members: readonly ts.TypeElement[] = declaration?.members ?? [];
  return members
    .filter(ts.isPropertySignature)
    .map((member) => (ts.isIdentifier(member.name) ? member.name.text : ""))
    .sort();
}

/** Validates: Requirements 4.10, 4.13, 4.14 */
describe("Operation History 設定 graph — 能力境界", () => {
  it("root の Operation History 関連 edge は Tail attachment 一件だけである", () => {
    expect(producerEdges.filter(isOperationHistoryEdge).map(printEdge)).toEqual([
      "yude-men-timer -[tail-attachment:tail_consumers]-> yude-men-telemetry-tail",
    ]);
    // Queue／R2／KV／D1 は Producer 設定の SSOT へ一切置かない（要件 1.9 / 4.10 / 4.13）。
    for (const key of ["queues", "r2_buckets", "kv_namespaces", "d1_databases"] as const) {
      expect(producerConfig[key], `root が ${key} を持つ`).toBeUndefined();
    }
    // 観測専用の scheduled 起動（cron）を root へ足さない（要件 1.8 / 2.15）。
    expect(producerConfig.triggers?.crons).toBeUndefined();
  });

  it("Tail Worker の全 edge は Queue producer 一件だけである", () => {
    expect(tailEdges.map(printEdge)).toEqual([
      "yude-men-telemetry-tail -[queue-producer:OPERATION_RECORDS]-> operation-records",
    ]);
  });

  it("Consumer の全 edge は Queue consumer・dead-letter・R2 だけである", () => {
    expect(consumerEdges.map(printEdge)).toEqual([
      "operation-records -[queue-consumer:queues.consumers]-> yude-men-raw-arrival-consumer",
      "yude-men-raw-arrival-consumer -[dead-letter:dead_letter_queue]-> operation-records-dlq",
      "yude-men-raw-arrival-consumer -[r2-bucket:OPERATION_RAW_ARRIVALS]-> operation-raw-arrivals",
    ]);
  });

  it("Data Platform から Producer へ向かう edge が 0 件である", () => {
    const reverse = [...tailEdges, ...consumerEdges].filter((edge) => producerNodes.has(edge.to) || producerNodes.has(edge.from));
    expect(reverse.map(printEdge)).toEqual([]);
    // Tail／Consumer の正当な到達経路は tail attachment と Queue delivery だけ。網羅的に、
    // ネットワークからの入口（route / workers.dev / preview URL）を持たないことを確かめる。
    for (const [path, parsed] of [[tailConfigPath, tailConfig], [consumerConfigPath, consumerConfig]] as const) {
      expect(parsed.workers_dev, `${path} が workers.dev を開く`).toBe(false);
      expect(parsed.preview_urls, `${path} が preview URL を開く`).toBe(false);
      expect(parsed.routes, `${path} が route を持つ`).toBeUndefined();
      expect(parsed.route, `${path} が route を持つ`).toBeUndefined();
      expect(parsed.durable_objects, `${path} が DO namespace を持つ`).toBeUndefined();
      expect(parsed.services, `${path} が Service binding を持つ`).toBeUndefined();
      expect(parsed.tail_consumers, `${path} が tail attachment を持つ`).toBeUndefined();
    }
  });
});

/** Validates: Requirements 1.3, 4.1, 4.13 */
describe("Operation History 設定 graph — 名前の写し違い", () => {
  it("root の name が Tail filter の PRODUCER_SCRIPTS に含まれる", () => {
    // 同じ事実（現存する Producer script 名）が root wrangler.jsonc と Tail filter の二箇所に
    // 書かれている。片方だけ直すと本番の tail が全て filter で落ちるため、機械的に突き合わせる。
    const scripts = producerScriptsFromTailFilter();
    expect(producerConfig.name).toBeDefined();
    expect(scripts, `PRODUCER_SCRIPTS が root の name（${producerConfig.name}）を含まない`).toContain(
      producerConfig.name,
    );
    // 逆向きも閉じる。実在しない script 名を挙げると、それが実名だと誤認されたまま残る。
    const deployedProducerNames = new Set(
      [producerConfig.name, ...Object.values(producerConfig.env ?? {}).map((environment) => environment.name)]
        .filter((name): name is string => name !== undefined),
    );
    expect(scripts.filter((script) => !deployedProducerNames.has(script))).toEqual([]);
  });

  it("root の tail attachment が Tail Worker 設定の name を指す", () => {
    // tail_consumers は段階的有効化のためコメントアウト状態で置く。コメント内の宣言からも読み、
    // 有効化した後も同じ突き合わせが効くようにする（root 側の有効化手順を参照）。
    const declared = declaredTailConsumerServices(producerConfigPath);
    expect(declared).toEqual([tailConfig.name]);
    expect(tailConfig.name).toBe("yude-men-telemetry-tail");
  });

  it("設定の binding 名が Data Platform module の Env 宣言と一致する", () => {
    expect(envBindingNames("src/data-platform/tail-worker.ts", "TailWorkerEnv")).toEqual(
      (tailConfig.queues?.producers ?? []).map((producer) => producer.binding).sort(),
    );
    expect(envBindingNames("src/data-platform/raw-arrival-consumer.ts", "RawArrivalConsumerEnv")).toEqual(
      (consumerConfig.r2_buckets ?? []).map((bucket) => bucket.binding).sort(),
    );
  });

  it("Tail Worker と Consumer の main が実在し、Queue 名が両側で一致する", () => {
    for (const [path, parsed] of [[tailConfigPath, tailConfig], [consumerConfigPath, consumerConfig]] as const) {
      expect(parsed.main, `${path} に main がない`).toBeDefined();
      expect(existsSync(resolve(repoRoot, parsed.main ?? "")), `${path} の main が実在しない`).toBe(true);
    }
    expect((tailConfig.queues?.producers ?? []).map((producer) => producer.queue)).toEqual(
      (consumerConfig.queues?.consumers ?? []).map((consumer) => consumer.queue),
    );
  });
});

/** Validates: Requirements 1.3, 1.8, 1.9, 2.15, 4.10, 4.15 */
describe("Operation History 設定 graph — Producer 側に下流能力がない", () => {
  const graph = producerImportGraph();

  it("Producer 観測 module の import graph が platform・下流 module を含まない", () => {
    expect(graph.externals).toEqual([]);
    expect(graph.files).not.toContain(tailFilterPath);
    expect(graph.files.filter((path) => path.startsWith("src/data-platform/"))).toEqual([]);
  });

  it("Producer 観測 module のソースに下流資源名が現れない", () => {
    for (const path of graph.files) {
      const text = source(path);
      for (const name of downstreamNames) {
        expect(text.includes(name), `${path} が下流資源名 ${name} を持つ`).toBe(false);
      }
    }
  });

  it("root 設定に下流 binding・観測専用 Alarm・Queue callback・storage key が現れない", () => {
    const active = jsoncToJson(source(producerConfigPath));
    for (const name of downstreamNames) {
      // コメント内の説明（有効化手順の Tail Worker 名）は能力ではないため、
      // コメントを落とした本文だけを見る。Tail attachment の service 名は上の突き合わせが担う。
      expect(active.includes(name), `root が有効な設定として ${name} を持つ`).toBe(false);
    }
    expect(active).not.toMatch(/"(?:queues|r2_buckets|kv_namespaces|d1_databases|triggers|crons)"\s*:/);
  });
});
