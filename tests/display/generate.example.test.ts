// tests/display/generate.example.test.ts — 札 1 件の生成の全分岐。
//
// 実 AI も実 KV も使わない。`now` も注入して**実時間を待たずに**期限の分岐を回す（待てばテストが遅くなり、
// 遅いテストは境界を踏まなくなる）。確かめるのは「必ず何かを書いて終わること」と、その中身である。

import { describe, expect, it, vi } from "vitest";
import {
  SHORT_NAME_CALL_TIMEOUT_MS,
  generateShortName,
  type ShortNameDeps,
  type ShortNameModel,
} from "../../src/display/generate";
import {
  readShortName,
  type ShortNameRecord,
  type ShortNameStore,
} from "../../src/display/dictionary";

const MODEL = "@cf/zai-org/glm-5.3-flash";

/** 記憶だけの辞書。書き込みを失敗させられる。 */
function fakeStore(options: { readonly failWrites?: boolean } = {}) {
  const values = new Map<string, string>();
  const metadata = new Map<string, unknown>();
  const store: ShortNameStore = {
    list: () => Promise.resolve({ keys: [], list_complete: true }),
    getWithMetadata: (key) =>
      Promise.resolve({ value: values.get(key) ?? null, metadata: metadata.get(key) ?? null }),
    put: (key, value, opts) => {
      if (options.failWrites === true) return Promise.reject(new Error("kv down"));
      values.set(key, value);
      metadata.set(key, opts?.metadata);
      return Promise.resolve();
    },
  };
  const recordOf = (key: string): ShortNameRecord | null => {
    const raw = values.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as ShortNameRecord);
  };
  return { store, recordOf };
}

/** `short` に与えた文字列を返す応答（OpenAI 形）。 */
const reply = (short: string): unknown => ({
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ short }) } }],
});

/** 時計。`advance` した分だけ budget が減る。 */
function clock(start = 1_789_000_000_000) {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

function deps(ai: ShortNameModel, store: ShortNameStore, now: () => number): ShortNameDeps {
  return { ai, store, model: MODEL, now };
}

describe("AI を呼ばない経路", () => {
  it("8 コードポイント以下の名前は AI を呼ばず plain を書く", async () => {
    const { store, recordOf } = fakeStore();
    const run = vi.fn();
    await generateShortName(
      deps({ run }, store, clock().now),
      "醤油ラーメン",
      "醤油ラーメン",
      8_000,
    );
    expect(run).not.toHaveBeenCalled();
    expect(await readShortName(store, "醤油ラーメン")).toEqual({ kind: "plain" });
    // 呼んでいないのでモデル ID は残さない。
    expect(recordOf("醤油ラーメン")?.model).toBeNull();
    expect(recordOf("醤油ラーメン")?.attempts).toEqual([]);
  });

  it("境界：8 字は呼ばず、9 字は呼ぶ", async () => {
    const { store } = fakeStore();
    const run = vi.fn().mockResolvedValue(reply("特味噌ネギ"));
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ラーメン",
      "特味噌ラーメン",
      8_000,
    );
    expect(run).not.toHaveBeenCalled();
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("生成が通る経路", () => {
  it("初回で通れば short を書く。保存されるのは正規化後の札", async () => {
    const { store, recordOf } = fakeStore();
    // 半角カナの候補。正規化してはじめて 8 字かつ部分列になる。
    const run = vi.fn().mockResolvedValue(reply("特味噌ﾈｷﾞﾗｰﾒ"));
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
    );
    expect(await readShortName(store, "特味噌ネギラーメン")).toEqual({
      kind: "short",
      label: "特味噌ネギラーメ",
    });
    expect(recordOf("特味噌ネギラーメン")?.model).toBe(MODEL);
  });

  it("記録には正規化前の申告名が残る（鍵からは復元できない）", async () => {
    const { store, recordOf } = fakeStore();
    const run = vi.fn().mockResolvedValue(reply("旨辛スタミナ"));
    await generateShortName(
      deps({ run }, store, clock().now),
      "旨辛スタミナラーメン",
      "旨辛ｽﾀﾐﾅﾗｰﾒﾝ",
      8_000,
    );
    expect(recordOf("旨辛スタミナラーメン")?.declaredName).toBe("旨辛ｽﾀﾐﾅﾗｰﾒﾝ");
  });

  it("モデルには正規化後の鍵を渡し、待機を AbortSignal で切る", async () => {
    const { store } = fakeStore();
    const run = vi.fn().mockResolvedValue(reply("特味噌ネギ"));
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
    );
    const [model, inputs, options] = run.mock.calls[0] ?? [];
    expect(model).toBe(MODEL);
    expect(JSON.stringify(inputs)).toContain("特味噌ネギラーメン");
    // 既存の札一覧を渡さない（判断 7）。
    expect(JSON.stringify(inputs)).not.toContain("既存");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("**思考を切って呼ぶ**（推論モデルの既定は遅く高い）", async () => {
    const { store } = fakeStore();
    const run = vi.fn().mockResolvedValue(reply("特味噌ネギ"));
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
    );
    // 実測（2026-09-15）: 既定 18,449ms・33.6 Neurons → 切ると 3,269ms・4.8 Neurons。
    expect(run.mock.calls[0]?.[1]?.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("既に使われている札を渡すと、指示に含まれる", async () => {
    const { store } = fakeStore();
    const run = vi.fn().mockResolvedValue(reply("特味噌ネ"));
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
      ["特味噌ネギ", "辛味噌ネギ"],
    );
    const user = run.mock.calls[0]?.[1]?.messages?.[1]?.content ?? "";
    expect(user).toContain("特味噌ネギ");
    expect(user).toContain("辛味噌ネギ");
    expect(user).toContain("特味噌ネギラーメン");
  });

  it("既存の札が無ければ、その行を載せない", async () => {
    const { store } = fakeStore();
    const run = vi.fn().mockResolvedValue(reply("特味噌ネギ"));
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
    );
    expect(run.mock.calls[0]?.[1]?.messages?.[1]?.content).not.toContain("既に使われている札");
  });

  it("json_schema は name を持ち、本体は schema に入る", async () => {
    const { store } = fakeStore();
    const run = vi.fn().mockResolvedValue(reply("特味噌ネギ"));
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
    );
    const format = run.mock.calls[0]?.[1]?.response_format;
    expect(format?.type).toBe("json_schema");
    expect(format?.json_schema?.name).toBe("short_name");
    expect(format?.json_schema?.schema?.required).toEqual(["short"]);
  });
});

describe("落ちる経路", () => {
  it("検査落ちは 1 回だけ再試行し、通れば short を書く", async () => {
    const { store, recordOf } = fakeStore();
    const run = vi
      .fn()
      .mockResolvedValueOnce(reply("醤油ネギ")) // 元名に無い文字 → 落ちる
      .mockResolvedValueOnce(reply("特味噌ネギ"));
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(await readShortName(store, "特味噌ネギラーメン")).toEqual({
      kind: "short",
      label: "特味噌ネギ",
    });
    // 落ちた候補は記録に残る。理由は粗く、候補そのものが手がかりになる。
    expect(recordOf("特味噌ネギラーメン")?.attempts).toEqual([
      { candidate: "醤油ネギ", rejected: "failed-check" },
    ]);
  });

  it("二度とも落ちれば plain を書き、3 回目は呼ばない", async () => {
    const { store, recordOf } = fakeStore();
    const run = vi.fn().mockResolvedValue(reply("醤油ネギ"));
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(await readShortName(store, "特味噌ネギラーメン")).toEqual({ kind: "plain" });
    expect(recordOf("特味噌ネギラーメン")?.attempts).toHaveLength(2);
  });

  it("復号できない応答も再試行の対象になる", async () => {
    const { store, recordOf } = fakeStore();
    const run = vi.fn().mockResolvedValue({ response: { short: "特味噌ネギ" } });
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(recordOf("特味噌ネギラーメン")?.attempts).toEqual([
      { candidate: null, rejected: "undecodable" },
      { candidate: null, rejected: "undecodable" },
    ]);
  });

  it("呼び出しが例外を投げても外へ出さず plain へ畳む（JSON Mode エラーを含む）", async () => {
    const { store, recordOf } = fakeStore();
    const run = vi.fn().mockRejectedValue(new Error("JSON Mode couldn't be met"));
    await expect(
      generateShortName(
        deps({ run }, store, clock().now),
        "特味噌ネギラーメン",
        "特味噌ネギラーメン",
        8_000,
      ),
    ).resolves.toEqual({ kind: "plain" });
    expect(await readShortName(store, "特味噌ネギラーメン")).toEqual({ kind: "plain" });
    expect(recordOf("特味噌ネギラーメン")?.attempts).toEqual([
      { candidate: null, rejected: "call-failed" },
      { candidate: null, rejected: "call-failed" },
    ]);
  });
});

describe("期限", () => {
  it("budget を使い切ったら再試行せず plain を書く", async () => {
    const { store, recordOf } = fakeStore();
    const time = clock();
    // 1 回目の呼び出しで budget を丸ごと消費する。
    const run = vi.fn().mockImplementation(() => {
      time.advance(8_000);
      return Promise.resolve(reply("醤油ネギ"));
    });
    await generateShortName(
      deps({ run }, store, time.now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readShortName(store, "特味噌ネギラーメン")).toEqual({ kind: "plain" });
    expect(recordOf("特味噌ネギラーメン")?.attempts).toEqual([
      { candidate: "醤油ネギ", rejected: "failed-check" },
      { candidate: null, rejected: "deadline" },
    ]);
  });

  it("budget が 0 なら一度も呼ばずに plain を書く", async () => {
    const { store } = fakeStore();
    const run = vi.fn();
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      0,
    );
    expect(run).not.toHaveBeenCalled();
    expect(await readShortName(store, "特味噌ネギラーメン")).toEqual({ kind: "plain" });
  });

  it("渡す待機上限は min(1 回の上限, 残り budget) である", async () => {
    const { store } = fakeStore();
    const time = clock();
    // `AbortSignal.timeout` を差し替えて、渡されたミリ秒そのものを読む。
    const timeouts: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    const run = vi.fn().mockImplementation(() => {
      time.advance(1_000);
      return Promise.resolve(reply("醤油ネギ"));
    });
    // budget 1,500ms は 1 回の上限（3,500ms）より短い。1 回目は 1,500ms、1,000ms 使った後の
    // 2 回目は残り 500ms で切られる。
    await generateShortName(
      deps({ run }, store, time.now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      1_500,
    );
    expect(timeouts).toEqual([1_500, 500]);
    expect(await readShortName(store, "特味噌ネギラーメン")).toEqual({ kind: "plain" });
    timeout.mockRestore();
  });

  it("budget に余裕があれば 1 回の上限で切る", async () => {
    const { store } = fakeStore();
    const timeouts: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    const run = vi.fn().mockResolvedValue(reply("特味噌ネギ"));
    // budget は 1 回の上限より大きく取る（小さいと `min` で budget 側が採られ、上限を主張できない）。
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      SHORT_NAME_CALL_TIMEOUT_MS * 2,
    );
    expect(timeouts).toEqual([SHORT_NAME_CALL_TIMEOUT_MS]);
    timeout.mockRestore();
  });

  it("待機が切れて run が拒否されれば plain を保存して終わる", async () => {
    const { store, recordOf } = fakeStore();
    // 実際の中断と同じ形：signal が発火し、run はその理由で拒否される。
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      controller.abort(new DOMException("The operation was aborted", "TimeoutError"));
      return controller.signal;
    });
    const run = vi
      .fn()
      .mockImplementation((_model, _inputs, options) =>
        options.signal.aborted
          ? Promise.reject(options.signal.reason)
          : Promise.resolve(reply("特味噌ネギ")),
      );
    await generateShortName(
      deps({ run }, store, clock().now),
      "特味噌ネギラーメン",
      "特味噌ネギラーメン",
      8_000,
    );
    expect(await readShortName(store, "特味噌ネギラーメン")).toEqual({ kind: "plain" });
    expect(recordOf("特味噌ネギラーメン")?.attempts).toEqual([
      { candidate: null, rejected: "call-failed" },
      { candidate: null, rejected: "call-failed" },
    ]);
    timeout.mockRestore();
  });
});

describe("保存の失敗", () => {
  it("書き込みが失敗すれば呼び出し側へ伝える（エントリは残らない）", async () => {
    const { store } = fakeStore({ failWrites: true });
    const run = vi.fn().mockResolvedValue(reply("特味噌ネギ"));
    await expect(
      generateShortName(
        deps({ run }, store, clock().now),
        "特味噌ネギラーメン",
        "特味噌ネギラーメン",
        8_000,
      ),
    ).rejects.toThrow("kv down");
    expect(await readShortName(store, "特味噌ネギラーメン")).toBeNull();
  });
});
