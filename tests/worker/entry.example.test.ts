// tests/worker/entry.example.test.ts — Entry の行き先解決と接続admissionの example / edge-case テスト。
//
// 本ファイルは per-store-provisioning の行き先解決（resolveEntryDestination）と、Access_Required_Flag に
// よる接続admission意味論を、代表例・境界例で確かめる（property 検証は entry.property.test.ts が担う）。
//
// resolveEntryDestination / EntryDestination は cloudflare:workers・jose に依存しない純粋な型・関数として
// src/worker-entry.ts に隔離されており（src/worker.ts は DO の re-export 経由で cloudflare:workers を、
// Access 検証で jose を引き込むため既定 pool でロードできない）、本テストはそこから直接 import して
// DO ランタイムなしに検証する。接続admissionの純粋部分（normalize による正準化・実効 Roster の所属判定）も
// 既定 pool で import できる純粋核（src/registry/authz.ts・src/registry/roster.ts）から踏む。
// ゆえに本ファイルは Workers pool ではなく node（既定 pool）で実行する（vitest.config.ts の worker project）。

import { describe, expect, it } from "vitest";
import { resolveEntryDestination } from "../../src/worker-entry";
import type { EntryDestination } from "../../src/worker-entry";
import { normalize } from "../../src/registry/authz";
import { effectiveRoster } from "../../src/registry/roster";
import type { Identity, Roster } from "../../src/registry/ideal";

// ── Access_Required_Flag による接続admissionの純粋モデル ──
//
// StoreTimerDO の接続admission判定（fetch 内・要件6.3 / 6.4）は
//   `if (accessRequired && !isRostered(roster, identity)) reject`
// という形で、accessRequired（＝ ACCESS_REQUIRED === "1"）と Roster 所属の連言だけで決まる。
// この判定は DO 内の private メソッド（cloudflare:workers を引き込むため node pool で import 不能）だが、
// 判定を構成する純粋核——ACCESS_REQUIRED フラグの解釈・normalize による正準化・実効 Roster の所属判定——は
// いずれも既定 pool で import できる。ここではその純粋核だけを組み上げ、DO と同一の判定を再現して踏む
// （DO ランタイムを跨ぐ配線そのものは access-jwt / deactivation 等の Workers pool 統合テストが担う）。

/** ACCESS_REQUIRED（env 文字列）の解釈。"1" のときだけ ON（DO の `env.ACCESS_REQUIRED === "1"` と同一規則）。 */
function accessRequired(flag: string): boolean {
  return flag === "1";
}

/** 実効 Roster への所属判定（両辺を normalize して照合・DO の isRostered と同一規則・要件6.3 / 9.5）。 */
function isRostered(roster: Roster, identity: Identity | null): boolean {
  if (identity === null) return false;
  const target = normalize(identity);
  return roster.some((entry) => normalize(entry) === target);
}

/** 接続admission（true = 接続許可）。ACCESS ON かつ非所属のときだけ拒否する（要件6.4 / 7.8）。 */
function admits(flag: string, roster: Roster, identity: Identity | null): boolean {
  return !accessRequired(flag) || isRostered(roster, identity);
}

describe("worker-entry — Entry の行き先解決（example / edge-case）", () => {
  // 0 店舗 → 接続先なし（要件7.5）。いかなる店舗へもフォールバックしない。
  // **Validates: Requirements 7.5**
  it("0 店舗は { kind: \"none\" } を返す（要件7.5）", () => {
    const destination: EntryDestination = resolveEntryDestination([]);
    expect(destination).toEqual({ kind: "none" });
  });

  // 1 店舗 → その店舗へリダイレクト（要件7.3）。
  // **Validates: Requirements 7.5**
  it("1 店舗はその店舗へリダイレクトする（要件7.3）", () => {
    const oneStore = "yudemen-honten";
    expect(resolveEntryDestination([oneStore])).toEqual({ kind: "redirect", storeId: oneStore });
  });

  // 複数店舗 → 既定店（登録順の先頭）へリダイレクト（要件7.4）。先頭以外を宛先に選ばない。
  // **Validates: Requirements 7.5**
  it("複数店舗は登録順の先頭へリダイレクトする（要件7.4）", () => {
    const a = "store-a";
    const b = "store-b";
    const c = "store-c";
    expect(resolveEntryDestination([a, b, c])).toEqual({ kind: "redirect", storeId: a });
  });
});

describe("接続admission — Access_Required_Flag の意味論（example / edge-case）", () => {
  // DO の接続admission判定は private ゆえ node pool で直接踏めないため、判定を構成する純粋核
  // （フラグ解釈・normalize・実効 Roster 所属）を組み上げて確かめる。DO ランタイムを跨ぐ統合は
  // tests/shell の deactivation / autonomy・tests/worker の access-jwt が別に担う。

  const roster: Roster = ["alice@example.com", "bob@example.com"];
  const insider: Identity = "alice@example.com";
  const outsider: Identity = "mallory@example.com";

  // OFF（"0"）: 非所属 identity でも接続を許す（合鍵 URL のみで接続でき、Roster 照合を行わない・要件6.4 / 7.8 / 8.7）。
  // **Validates: Requirements 6.4, 7.8, 8.7**
  it("ACCESS_REQUIRED=\"0\" は非所属 identity の接続を許す（要件6.4 / 7.8）", () => {
    expect(admits("0", roster, outsider)).toBe(true);
    // identity 欠如（合鍵 URL 直叩き・OFF 期の通常経路）でも許す。
    expect(admits("0", roster, null)).toBe(true);
  });

  // ON（"1"）: 非所属 identity は拒否し、所属 identity のみ許す（Roster 判定が必須・要件6.4）。
  // **Validates: Requirements 6.4, 8.7**
  it("ACCESS_REQUIRED=\"1\" は非所属 identity を拒否し所属 identity を許す（要件6.4）", () => {
    expect(admits("1", roster, outsider)).toBe(false);
    expect(admits("1", roster, insider)).toBe(true);
    // ON かつ identity 欠如は拒否（未検証・null は非所属扱い）。
    expect(admits("1", roster, null)).toBe(false);
  });

  // ON でも所属判定は normalize（大小文字・前後空白の差の吸収）を通す（要件9.5）。表現差があっても同一人物として許す。
  // **Validates: Requirements 6.4**
  it("ACCESS_REQUIRED=\"1\" の所属判定は normalize 後に照合する（大小文字・空白差を吸収・要件9.5）", () => {
    expect(admits("1", roster, "  ALICE@Example.com  ")).toBe(true);
  });

  // 実効 Roster（チェーン Roster と店舗 Roster の和集合）を用いた所属判定も同型に振る舞う（要件3.5 との整合）。
  // **Validates: Requirements 6.4**
  it("実効 Roster（和集合）で所属する identity は ON でも許される（要件6.4）", () => {
    const chainRoster: Roster = ["chain-admin@example.com"];
    const storeRoster: Roster = ["carol@example.com"];
    const effective = effectiveRoster(chainRoster, storeRoster);
    expect(admits("1", effective, "chain-admin@example.com")).toBe(true);
    expect(admits("1", effective, "carol@example.com")).toBe(true);
    expect(admits("1", effective, outsider)).toBe(false);
  });
});
