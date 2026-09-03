import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const producerRoot = "src/operation-history/producer.ts";
const shellPath = "src/shell/store-timer-do.ts";
const workerPath = "src/worker.ts";
const messagesPath = "src/domain/messages.ts";

function source(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function parse(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    source(relativePath),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function pathFromRoot(absolutePath: string): string {
  return relative(repoRoot, absolutePath).split(sep).join("/");
}

function nodeName(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    return name.text;
  return undefined;
}

function walk(node: ts.Node, visit: (child: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function relativeImports(file: ts.SourceFile): readonly string[] {
  const imports: string[] = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      imports.push(statement.moduleSpecifier.text);
    }
  }
  return imports;
}

function resolveRelativeImport(importer: string, specifier: string): string {
  const base = resolve(repoRoot, dirname(importer), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")];
  const resolved = candidates.find(existsSync);
  if (resolved === undefined) throw new Error(`${importer}: ${specifier} を解決できない`);
  return pathFromRoot(resolved);
}

function producerImportGraph(): {
  readonly files: readonly string[];
  readonly externalImports: readonly string[];
} {
  const pending = [producerRoot];
  const files = new Set<string>();
  const externalImports = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || files.has(current)) continue;
    files.add(current);
    for (const specifier of relativeImports(parse(current))) {
      if (!specifier.startsWith(".")) externalImports.add(specifier);
      else pending.push(resolveRelativeImport(current, specifier));
    }
  }
  return { files: [...files].sort(), externalImports: [...externalImports].sort() };
}

function classDeclaration(file: ts.SourceFile, name: string): ts.ClassDeclaration {
  const found = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === name,
  );
  if (found === undefined) throw new Error(`${file.fileName}: class ${name} がない`);
  return found;
}

function functionDeclaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (found === undefined) throw new Error(`${file.fileName}: function ${name} がない`);
  return found;
}

function methodDeclaration(target: ts.ClassDeclaration, name: string): ts.MethodDeclaration {
  const found = target.members.find(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && nodeName(member.name) === name,
  );
  if (found === undefined) throw new Error(`${target.name?.text ?? "class"}.${name} がない`);
  return found;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  );
}

function constructorDeclaration(target: ts.ClassDeclaration): ts.ConstructorDeclaration {
  const found = target.members.find((member): member is ts.ConstructorDeclaration =>
    ts.isConstructorDeclaration(member),
  );
  if (found === undefined) throw new Error(`${target.name?.text ?? "class"}.constructor がない`);
  return found;
}

function projectFiles(relativeDirectory: string): readonly string[] {
  const ignoredDirectories = new Set([
    ".git",
    ".kiro",
    ".wrangler",
    "dist",
    "node_modules",
    "public",
  ]);
  const absoluteDirectory = resolve(repoRoot, relativeDirectory);
  if (!existsSync(absoluteDirectory)) return [];

  return readdirSync(absoluteDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry): readonly string[] => {
      const relativePath =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        return ignoredDirectories.has(entry.name) ? [] : projectFiles(relativePath);
      }
      return entry.isFile() ? [relativePath] : [];
    });
}

function hasAncestor(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

const graph = producerImportGraph();
const graphFiles = graph.files.map((path) => ({ path, file: parse(path) }));
const forbiddenCapabilityName =
  /^(?:ctx|context|env|bindings?|storage|alarm|alarminvocationinfo|scheduled(?:event)?|queue|r2(?:bucket)?|websocket|fetch(?:er)?|httpclient|durableobject(?:namespace|stub)?|workerstub|servicebinding|tailworker|consumer|snowpipe|snowflake|logpush|client)$/i;
const forbiddenObservationMarker = /(?:operation[-_ ]?history|telemetry)/i;
const eventCallbackNames = new Set([
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
  "scheduled",
  "queue",
]);
/** Validates: Requirements 1.3, 1.8, 1.9, 2.15 */
describe("Operation History O1 — Producer capability の閉包", () => {
  it("推移 import graph を純粋層だけに閉じ、platform・下流 client を取り込まない", () => {
    expect(graph.externalImports).toEqual([]);
    expect(graph.files).toContain(producerRoot);
    for (const path of graph.files) {
      expect(
        path.startsWith("src/operation-history/") ||
          path.startsWith("src/engine/") ||
          path.startsWith("src/domain/") ||
          path.startsWith("src/registry/"),
        `${path} が Producer の許可された純粋層外にある`,
      ).toBe(true);
      expect(path, `${path} が作用の端または下流 client である`).not.toMatch(
        /(?:^|\/)(?:client|shell|observe|transport|tools)(?:\/|$)|src\/worker\.ts$/,
      );
      expect(path, `${path} が下流 Operation History module である`).not.toMatch(
        /src\/operation-history\/(?:tail|correlation|quality|slo)\.ts$/,
      );
    }
  });

  it("graph の import・識別子・引数に runtime capability を持たない", () => {
    for (const { path, file } of graphFiles) {
      for (const specifier of relativeImports(file)) {
        expect(specifier, `${path} が platform module を import している`).not.toBe(
          "cloudflare:workers",
        );
      }
      walk(file, (node) => {
        if (ts.isIdentifier(node)) {
          expect(
            forbiddenCapabilityName.test(node.text),
            `${path} が capability 識別子 ${node.text} を参照している`,
          ).toBe(false);
        }
        if (ts.isParameter(node)) {
          const parameter = node.getText(file);
          expect(parameter, `${path} の引数が runtime capability を受け取る`).not.toMatch(
            /\b(?:ctx|env|binding|storage|Alarm|Queue|R2|WebSocket|Fetcher|HTTPClient|DurableObjectNamespace|DurableObjectStub|WorkerStub|TailWorker|Consumer)\b/i,
          );
        }
      });
    }
  });

  it("同期 Producer 終端の作用を一引数 console.log 一点に限定する", () => {
    const file = parse(producerRoot);
    const terminal = functionDeclaration(file, "tryWriteOperationLines");
    expect(hasModifier(terminal, ts.SyntaxKind.AsyncKeyword)).toBe(false);
    expect(terminal.type?.getText(file)).toBe("void");
    expect(
      terminal.parameters.map((parameter) => [
        nodeName(parameter.name),
        parameter.type?.getText(file),
      ]),
    ).toEqual([
      ["enabled", "boolean"],
      ["observation", "OperationObservation"],
    ]);

    const calls: string[] = [];
    let awaits = 0;
    walk(terminal, (node) => {
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(file));
      if (ts.isAwaitExpression(node)) awaits += 1;
    });
    expect(calls).toEqual([
      "recordsFromCommittedDiff",
      "printCanonicalOperationLine",
      "console.log",
    ]);
    expect(awaits).toBe(0);
  });
});
describe("Operation History O2 — 観測に由来する起動原因ゼロ", () => {
  it("Producer graph に Worker/DO event callback の受口を定義しない", () => {
    for (const { path, file } of graphFiles) {
      walk(file, (node) => {
        if (!ts.isMethodDeclaration(node) && !ts.isMethodSignature(node)) return;
        const name = nodeName(node.name);
        expect(
          eventCallbackNames.has(name ?? ""),
          `${path} が event callback ${name ?? "?"} を定義する`,
        ).toBe(false);
      });
    }
  });

  it("Worker と StoreTimerDO に scheduled・Queue callback や観測用公開 RPC を追加しない", () => {
    const worker = parse(workerPath);
    const defaultExport = worker.statements.find(
      (statement): statement is ts.ExportAssignment =>
        ts.isExportAssignment(statement) && !statement.isExportEquals,
    );
    expect(defaultExport).toBeDefined();
    const defaultExpression = defaultExport?.expression;
    const defaultHandler =
      defaultExpression !== undefined && ts.isSatisfiesExpression(defaultExpression)
        ? defaultExpression.expression
        : defaultExpression;
    expect(defaultHandler !== undefined && ts.isObjectLiteralExpression(defaultHandler)).toBe(true);
    if (defaultHandler === undefined || !ts.isObjectLiteralExpression(defaultHandler)) return;
    expect(defaultHandler.properties.map((property) => nodeName(property.name))).toEqual(["fetch"]);

    const storeTimer = classDeclaration(parse(shellPath), "StoreTimerDO");
    const callbacks = storeTimer.members
      .filter((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member))
      .map((member) => nodeName(member.name))
      .filter((name): name is string => name !== undefined && eventCallbackNames.has(name));
    expect(callbacks).toEqual(["fetch", "webSocketMessage", "webSocketClose", "alarm"]);

    for (const member of storeTimer.members) {
      const name = nodeName(member.name);
      if (name !== undefined && forbiddenObservationMarker.test(name)) {
        expect(
          hasModifier(member, ts.SyntaxKind.PrivateKeyword),
          `${name} が観測用公開 RPC になっている`,
        ).toBe(true);
      }
    }
  });

  it("観測用 fetch route と WebSocket frame を追加しない", () => {
    for (const path of [workerPath, messagesPath]) {
      const file = parse(path);
      walk(file, (node) => {
        if (ts.isStringLiteralLike(node)) {
          expect(node.text, `${path} に観測専用 route/frame がある`).not.toMatch(
            forbiddenObservationMarker,
          );
        }
      });
      expect(
        relativeImports(file).some((specifier) => specifier.includes("operation-history")),
      ).toBe(false);
    }

    // ワイヤ復号は domain/wire.ts へ移った（verified-wire-contract）。守る不変は同じ——観測のために
    // WebSocket frame を増やさないこと——であり、見る場所だけを関門の現住所へ合わせる。
    const wire = parse("src/domain/wire.ts");
    const parser = functionDeclaration(wire, "toClientMessage");
    const frames = new Set<string>();
    walk(parser, (node) => {
      if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression))
        frames.add(node.expression.text);
    });
    expect(frames).toEqual(new Set(["start", "cancel", "complete", "adjust"]));
  });

  it("生成 Env の観測能力を同期 ON/OFF flag だけに限定する", () => {
    const generated =
      source("worker-configuration.d.ts").split("// Begin runtime types", 1)[0] ?? "";
    const file = ts.createSourceFile(
      "worker-configuration.d.ts",
      generated,
      ts.ScriptTarget.Latest,
      true,
    );
    const baseEnv = file.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === "__BaseEnv_Env",
    );
    expect(baseEnv).toBeDefined();
    const observationFields: ts.PropertySignature[] = [];
    for (const member of baseEnv?.members ?? []) {
      if (!ts.isPropertySignature(member)) continue;
      const name = nodeName(member.name);
      if (name !== undefined && /(?:OPERATION|HISTORY|TELEMETRY)/i.test(name)) {
        observationFields.push(member);
      }
    }
    expect(observationFields.map((member) => nodeName(member.name))).toEqual([
      "OPERATION_HISTORY_ENABLED",
    ]);
    expect(observationFields[0]?.type?.getText(file)).toBe('"0"');
    expect(observationFields[0]?.type?.getText(file)).not.toMatch(
      /Queue|R2|Fetcher|DurableObject|WorkerStub|Service/i,
    );
  });
});
describe("Operation History O3 — 観測用の永続 read/write ゼロ", () => {
  it("Producer graph に storage key と永続 API 呼び出しを持たない", () => {
    for (const { path, file } of graphFiles) {
      walk(file, (node) => {
        if (ts.isVariableDeclaration(node)) {
          const name = nodeName(node.name);
          expect(
            name ?? "",
            `${path} が観測用 storage key/state ${name ?? "?"} を定義する`,
          ).not.toMatch(/(?:_KEY$|STORAGE|OUTBOX|RECORD_SEQ|DELIVERY_STATE|CHECKPOINT)/i);
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const receiver = node.expression.expression.getText(file);
          const method = node.expression.name.text;
          if (/^(?:get|put|set|delete|list|transaction|transactionSync)$/i.test(method)) {
            expect(receiver, `${path} が ${receiver}.${method} で永続層へ到達する`).not.toMatch(
              /(?:storage|kv|r2|bucket|database|\bdb\b)/i,
            );
          }
        }
      });
    }
  });

  it("StoreTimerDO の観測境界は既存 readonly 値を Producer へ渡すだけで永続処理を起動しない", () => {
    const shell = parse(shellPath);
    const boundary = methodDeclaration(
      classDeclaration(shell, "StoreTimerDO"),
      "tryWriteCommittedOperation",
    );
    const calls: string[] = [];
    walk(boundary, (node) => {
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(shell));
      if (ts.isIdentifier(node)) {
        expect(node.text, `観測境界が永続・再起動能力 ${node.text} を参照する`).not.toMatch(
          /^(?:storage|ensureLoaded|ensureProvisioned|runEffects|setAlarm|deleteAlarm|transaction|list|put|get)$/,
        );
      }
    });
    expect(calls).toEqual(["effects.some", "tryWriteOperationLines"]);
  });
});
/** Validates: Requirements 1.8, 1.9, 4.13, 4.14, 4.15 */
describe("Operation History O4 — Data Platform からの逆方向到達不能", () => {
  const dataPlatformSources = projectFiles("src").filter((path) => {
    if (!/\.(?:ts|tsx)$/.test(path) || !/(?:tail|consumer)/i.test(path)) return false;
    return (
      /operation-history/i.test(path) ||
      /OperationRecord|operationLinesFromTailEvents|operation-history/.test(source(path))
    );
  });
  const dataPlatformConfigs = projectFiles("").filter((path) => {
    if (path === "wrangler.jsonc" || !/(?:^|\/)wrangler[^/]*\.jsonc$/.test(path)) return false;
    return /(?:operation-history|tail|consumer)/i.test(`${path}\n${source(path)}`);
  });
  const forbiddenCallbacks = new Set([
    "fetch",
    "alarm",
    "scheduled",
    "webSocketMessage",
    "webSocketClose",
    "webSocketError",
  ]);

  it("Producer root に下流 binding を与えず、将来の Data Platform 設定にも逆 edge を許さない", () => {
    const producerConfig = source("wrangler.jsonc");
    expect(producerConfig).not.toMatch(/"(?:queues|r2_buckets)"\s*:/);
    // services は種別ごと禁じるのではなく、**下流（Data Platform）を指す binding だけを**禁じる。
    // online-cook-scheduling が root へ Solver_Worker への Service binding（SOLVER → yude-men-solver）を
    // 足した。あちらは計画計算の端であって Operation History の下流ではなく、この検査が守る不変
    // （Producer から Queue / Consumer / R2 へ到達できないこと）には触れない。ゆえに検査対象を
    // 「service 名が Tail / Consumer / Operation History を指すか」へ絞る（他 spec の正当な追加に追随する）。
    // 行コメントを除いてから走査する。root には無効化された tail_consumers 見本（有効化手順）が
    // コメントで残っており、生のテキストを見るとその service 名が実在の binding に見えてしまう。
    const activeBindings = producerConfig.replace(/^\s*\/\/.*$/gm, "");
    for (const [, service] of activeBindings.matchAll(/"service"\s*:\s*"([^"]*)"/g)) {
      expect(service, `root が下流 service ${service} への binding を持つ`).not.toMatch(
        /(?:operation-history|tail|consumer|queue|r2)/i,
      );
    }

    for (const path of dataPlatformConfigs) {
      const config = source(path);
      expect(config, `${path} が Producer/StoreTimerDO への capability を持つ`).not.toMatch(
        /"(?:STORE_TIMER_DO|durable_objects|services|routes|triggers|tail_consumers|PRODUCER_URL|PRODUCER_ENDPOINT)"\s*:/i,
      );
      expect(config, `${path} が Producer URL を持つ`).not.toMatch(
        /https?:\/\/[^"\s]*(?:yude-men-timer|\/s\/|\/admin\/)/i,
      );
    }
  });

  it("Tail/Consumer module に URL・Service Binding・DO stub・RPC・WebSocket・起動 callback を許さない", () => {
    for (const path of dataPlatformSources) {
      const file = parse(path);
      walk(file, (node) => {
        if (ts.isIdentifier(node)) {
          expect(node.text, `${path} が逆方向 capability ${node.text} を参照する`).not.toMatch(
            /^(?:STORE_TIMER_DO|producerUrl|producerEndpoint|producerBinding|producerService|serviceBinding|DurableObjectNamespace|DurableObjectStub|WorkerStub|WebSocket|WebSocketPair)$/i,
          );
        }
        if (ts.isStringLiteralLike(node)) {
          expect(node.text, `${path} が Producer route/URL を保持する`).not.toMatch(
            /^(?:https?:\/\/|\/s\/|\/admin\/)|STORE_TIMER_DO/i,
          );
        }
        if (
          (ts.isMethodDeclaration(node) ||
            ts.isMethodSignature(node) ||
            ts.isPropertyAssignment(node)) &&
          forbiddenCallbacks.has(nodeName(node.name) ?? "")
        ) {
          expect.fail(`${path} が逆方向 callback ${nodeName(node.name) ?? "?"} を定義する`);
        }
        if (ts.isNewExpression(node)) {
          expect(
            node.expression.getText(file),
            `${path} が逆方向 connection/stub を構築する`,
          ).not.toMatch(/(?:WebSocket|DurableObject|WorkerStub|EventSource)/i);
        }
        if (!ts.isCallExpression(node)) return;
        const called = node.expression.getText(file);
        expect(called, `${path} が逆方向 call ${called} を行う`).not.toMatch(
          /^(?:fetch|connect|rpc)$|\.(?:fetch|connect|rpc|idFromName|getByName|setAlarm|deleteAlarm)$/i,
        );
      });
    }
  });

  it("Queue ack は Consumer から受領 Queue message への内部通信だけに閉じる", () => {
    for (const path of dataPlatformSources) {
      const file = parse(path);
      walk(file, (node) => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
        const method = node.expression.name.text;
        if (method !== "ack" && method !== "ackAll") return;
        const receiver = node.expression.expression.getText(file);
        expect(receiver, `${path} の ack 宛先 ${receiver} が Queue message/batch ではない`).toMatch(
          /(?:message|batch|queue)/i,
        );
      });
    }
  });
});

/** Validates: Requirements 1.10 */
describe("Operation History O5 — invocation 終了時の観測資源ゼロ", () => {
  it("同期 Producer 終端は Promise・待機・timer・subscription・connection・Alarm を作らない", () => {
    const file = parse(producerRoot);
    const terminal = functionDeclaration(file, "tryWriteOperationLines");
    const forbiddenLiveResource =
      /^(?:Promise|AbortController|WebSocket|WebSocketPair|EventSource|Alarm|Connection|Subscription)$/i;

    walk(terminal, (node) => {
      if (
        node !== terminal &&
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node))
      ) {
        expect.fail(`Producer 終端が保持され得る closure/class ${node.getText(file)} を作る`);
      }
      if (ts.isIdentifier(node)) {
        expect(node.text, `Producer 終端が live resource ${node.text} を参照する`).not.toMatch(
          forbiddenLiveResource,
        );
      }
      if (ts.isAwaitExpression(node) || ts.isNewExpression(node)) {
        expect.fail(`Producer 終端が非同期または live resource を作る: ${node.getText(file)}`);
      }
      if (ts.isCallExpression(node)) {
        expect(node.expression.getText(file), `Producer 終端が待機/接続作用を呼ぶ`).not.toMatch(
          /^(?:setTimeout|setInterval|queueMicrotask|fetch|connect|subscribe)$|\.(?:waitUntil|setAlarm|deleteAlarm|subscribe|connect)$/i,
        );
      }
    });
  });

  it("Producer module と終端に保持 closure・mutable state を作らない", () => {
    const file = parse(producerRoot);
    const terminal = functionDeclaration(file, "tryWriteOperationLines");
    expect(file.statements.filter(ts.isVariableStatement)).toEqual([]);

    walk(terminal, (node) => {
      if (ts.isVariableDeclaration(node)) {
        expect(ts.isVariableDeclarationList(node.parent)).toBe(true);
        if (ts.isVariableDeclarationList(node.parent)) {
          expect(
            (node.parent.flags & ts.NodeFlags.Const) !== 0,
            `Producer 終端の ${node.name.getText(file)} が mutable binding である`,
          ).toBe(true);
        }
      }
      if (ts.isBinaryExpression(node)) {
        expect(node.operatorToken.getText(file), `Producer 終端が代入で状態を変更する`).not.toMatch(
          /^(?:=|\+=|-=|\*=|\/=|%=|&&=|\|\|=|\?\?=)$/,
        );
      }
      if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        expect(node.operator, `Producer 終端が increment/decrement で状態を変更する`).not.toBeOneOf(
          [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken],
        );
      }
    });
  });
});

/** Validates: Requirements 1.8, 1.9, 2.7, 2.8, 2.15 */
describe("Operation History O6 — Reconcile の一方向因果", () => {
  it("Producer graph から constructor・rehydrate・Reconcile へ戻る edge がない", () => {
    expect(graph.files.some((path) => path.startsWith("src/shell/") || path === workerPath)).toBe(
      false,
    );
    for (const { path, file } of graphFiles) {
      walk(file, (node) => {
        if (!ts.isIdentifier(node)) return;
        expect(node.text, `${path} が lifecycle ${node.text} を起動し得る`).not.toMatch(
          /^(?:constructor|ensureLoaded|ensureProvisioned|runEffects|blockConcurrencyWhile|tryWriteCommittedOperation)$/,
        );
      });
    }
  });

  it("既存 constructor だけが Reconcile を実行し、既存作用完了後に観測する", () => {
    const shell = parse(shellPath);
    const storeTimer = classDeclaration(shell, "StoreTimerDO");
    const constructor = constructorDeclaration(storeTimer);
    let callback: ts.ArrowFunction | undefined;
    walk(constructor, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "blockConcurrencyWhile" &&
        node.arguments[0] !== undefined &&
        ts.isArrowFunction(node.arguments[0])
      ) {
        callback = node.arguments[0];
      }
    });
    expect(callback).toBeDefined();
    expect(callback !== undefined && hasModifier(callback, ts.SyntaxKind.AsyncKeyword)).toBe(true);
    if (callback === undefined) return;

    const calls: ts.CallExpression[] = [];
    walk(callback.body, (node) => {
      if (ts.isCallExpression(node)) calls.push(node);
    });
    const callByName = (name: string): ts.CallExpression | undefined =>
      calls.find((call) => {
        const expression = call.expression;
        return ts.isIdentifier(expression)
          ? expression.text === name
          : ts.isPropertyAccessExpression(expression) && expression.name.text === name;
      });
    const loaded = callByName("ensureLoaded");
    const provisioned = callByName("ensureProvisioned");
    const reconciled = callByName("decide");
    const effectsRun = callByName("runEffects");
    const observed = callByName("tryWriteCommittedOperation");
    expect(
      [loaded, provisioned, reconciled, effectsRun, observed].every((call) => call !== undefined),
    ).toBe(true);
    if (
      loaded === undefined ||
      provisioned === undefined ||
      reconciled === undefined ||
      effectsRun === undefined ||
      observed === undefined
    )
      return;
    expect([loaded.pos, provisioned.pos, reconciled.pos, effectsRun.pos, observed.pos]).toEqual(
      [...[loaded.pos, provisioned.pos, reconciled.pos, effectsRun.pos, observed.pos]].sort(
        (left, right) => left - right,
      ),
    );
    expect(ts.isAwaitExpression(effectsRun.parent)).toBe(true);
    expect(observed.arguments[0]?.getText(shell)).toBe('"Reconcile"');
    const reconcileEvent = reconciled.arguments[1];
    expect(reconcileEvent !== undefined && ts.isObjectLiteralExpression(reconcileEvent)).toBe(true);
    expect(reconcileEvent?.getText(shell)).toContain('type: "Reconcile"');

    const reconcileObservations: ts.CallExpression[] = [];
    walk(storeTimer, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "tryWriteCommittedOperation" &&
        node.arguments[0]?.getText(shell) === '"Reconcile"'
      ) {
        reconcileObservations.push(node);
      }
    });
    expect(reconcileObservations).toHaveLength(1);
    expect(hasAncestor(reconcileObservations[0]!, constructor)).toBe(true);
  });

  it("観測境界は Persist 成功差分だけを渡し、Reconcile は running→boiled だけを導出する", () => {
    const shell = parse(shellPath);
    const boundary = methodDeclaration(
      classDeclaration(shell, "StoreTimerDO"),
      "tryWriteCommittedOperation",
    );
    const guard = boundary.body?.statements[0];
    expect(guard !== undefined && ts.isIfStatement(guard)).toBe(true);
    if (guard !== undefined && ts.isIfStatement(guard)) {
      const condition = guard.expression.getText(shell);
      expect(condition).toContain("!result.persisted");
      expect(condition).toContain('effect.type === "Persist"');
    }

    const derive = parse("src/operation-history/derive.ts");
    const records = functionDeclaration(derive, "recordsFromCommittedDiff");
    const cases: ts.CaseClause[] = [];
    walk(records, (node) => {
      if (ts.isCaseClause(node)) cases.push(node);
    });
    const reconcile = cases.find((clause) => clause.expression.getText(derive) === '"Reconcile"');
    expect(reconcile).toBeDefined();
    const reconcileBranch = reconcile?.getText(derive) ?? "";
    expect(reconcileBranch).toContain('operationKind: "boiled"');
    expect(reconcileBranch).toContain("previous.engineTimer.boiledAt !== null");
    expect(reconcileBranch).toContain("engineTimer.boiledAt === null");
    expect(reconcileBranch).not.toMatch(
      /constructor|ensureLoaded|ensureProvisioned|runEffects|tryWriteOperationLines/,
    );
  });
});

/** Validates: Requirements 1.3, 1.8, 1.10 */
// O 番号は付けない。design.md の O7 は runtime の比較 trace であり、こちらは非共有の静的検査である。
describe("Operation History — hibernation debug harness (src/observe) との非共有", () => {
  const observeRoot = "src/observe";
  const observeFiles = projectFiles(observeRoot).filter((path) => /\.(?:ts|tsx)$/.test(path));

  it("harness が実在し、その module 集合を静的検証の基準にできる", () => {
    // 非共有の主張は harness が現に存在してこそ意味を持つ（空集合との素は自明で無力）。
    expect(observeFiles.length).toBeGreaterThan(0);
    expect(observeFiles).toContain("src/observe/log.ts");
  });

  it("Producer import graph が src/observe の module を一件も含まない", () => {
    for (const path of graph.files) {
      expect(
        path.startsWith(`${observeRoot}/`),
        `${path} が hibernation debug harness の module である`,
      ).toBe(false);
    }
    // graph と harness の module 集合が素であることを直接確かめる。
    expect(graph.files.filter((path) => observeFiles.includes(path))).toEqual([]);
  });

  it("graph の各 module が src/observe の型・flag・出力関数へ到達する import を持たない", () => {
    for (const { path, file } of graphFiles) {
      for (const specifier of relativeImports(file)) {
        if (!specifier.startsWith(".")) {
          expect(specifier, `${path} が harness を外部 specifier で取り込む`).not.toMatch(
            /observe/i,
          );
          continue;
        }
        const resolved = resolveRelativeImport(path, specifier);
        expect(
          resolved.startsWith(`${observeRoot}/`),
          `${path} が ${specifier} 経由で harness の型・flag・出力関数へ到達する`,
        ).toBe(false);
      }
    }
  });

  it("graph が Operation History 固有の純粋層と同期終端だけに閉じる", () => {
    expect(graph.files).toContain(producerRoot);
    for (const path of graph.files) {
      expect(
        path.startsWith("src/operation-history/") ||
          path.startsWith("src/engine/") ||
          path.startsWith("src/domain/") ||
          path.startsWith("src/registry/"),
        `${path} が Operation History 固有の純粋層外にある`,
      ).toBe(true);
    }
  });
});
