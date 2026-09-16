// display/generate.ts — 札 1 件の生成。モデルへ問い、検査に通った札だけを辞書へ書く。
//
// **生成は取り込みを待たせない。** 呼び出し側は `ctx.waitUntil` の中でこれを走らせ、`POST /pos/records` の
// 応答は生成の成否に依存しない。初出の 1 杯は全名で出る——壊れた状態ではなく、フォールバックが効いている状態。
//
// **必ず何かを書いて終わる。** 検査落ち・復号不能・呼び出し失敗・期限切れのいずれも、最後は `plain` を書く。
// 書かずに終われば初出判定が毎回その名前を未知と見て、AI を呼び続ける経路になる（requirements 判断 13）。
//
// **binding の型を持ち込まない。** `Ai` そのものではなく `ShortNameModel`（run 1 つだけの構造型）を受ける。
// `Ai.run` はモデル ID を `keyof AiModels` で縛るが、こちらのモデル ID は `vars` 由来の素の文字列である。
// 型の辻褄は配線の 1 箇所で合わせればよく、生成の中まで持ち込む理由がない。おかげで本モジュールは
// `cloudflare:workers` に触れず、node 環境で全分岐を検証できる。

import { writeShortName, type ShortNameRecord, type ShortNameStore } from "./dictionary";
import {
  SHORT_NAME_MAX_LENGTH,
  toShortName,
  toShortNameCandidate,
  type ShortNameEntry,
} from "./short-name";

/**
 * 1 回の `run` の待機上限。`AbortSignal` で切る。
 *
 * **実測に基づく**（2026-09-15・実データ 24 件を `enable_thinking: false` で実行）。中央値 1,399ms・
 * 最小 858ms と速いが**裾が長い**——`塩ラーメンAセット` 9,783ms、`特味噌ネギラーメン` 26,569ms。
 * 当初の 3,500ms では 6 件が中断され、訂正の経路が無い以上（判断 11）その商品は**恒久的に全名**になる。
 * ゆえに裾を拾う側へ倒す。それでも最長の 1 件は切れるが、2 回分＋書き込みが `waitUntil` の 30 秒に
 * 収まることを優先した。
 */
export const SHORT_NAME_CALL_TIMEOUT_MS = 11_000;

/**
 * 1 件の生成が AI の待機に費やせる上限。呼び出し側はこれと「締切までの残り」の小さいほうを budget として配る。
 *
 * 呼び出し 2 回分（22 秒）に書き込みの余裕を足した値。`ctx.waitUntil` の 30 秒（応答後）はリクエスト 1 回に
 * 対して与えられ、その中の全処理が共有するため、**この上限だけでは足りない**——初出が複数あるバッチでは
 * リクエスト共通の締切（`detect.ts`）が併せて要る。
 */
export const SHORT_NAME_DEADLINE_MS = 24_000;

/**
 * 生成の指示。**既存の札の一覧を渡さない**（requirements 判断 7）——渡せば生成順に結果が依存し、同じ商品の
 * 派生コードが機械的に別の札にされる。
 *
 * 規則 3〜5 は Distinguishing_Characters（区別の文字）で、**機械検査には持ち込まない**（判断 21）。これは
 * 技術的な制約ではなく方針の選択である——元名と候補だけで検査でき辞書も要らないが、多少の衝突を許容すると
 * 決めた以上、区別の度合いを機械が一律に裁く条件を重ねても守られる不変が生まれない。
 */
export const SHORT_NAME_PROMPT = `あなたはラーメン店の厨房で使う画面の表示名を作る。

麺を茹でる担当者が、釜に入っている丼がどの注文のものかを見分けるための「札」を作る。
札は狭い画面に並ぶため短くなければならない。

規則:
1. 元の商品名にある文字だけを使う。文字を足さない。
2. 8文字以内。規則4〜8を守れる範囲で、できるだけ短くする。
3. 「ラーメン」は**必ず省く**。「ラーメン」の 4 文字を札に残さない。
4. 味の系統（醤油・味噌・特味噌・辛味噌・塩）の違いが札だけで分かること。
   「特味噌」と「辛味噌」と「味噌」は別物であり、区別が消えてはならない。
5. 名前にある具は**どれも落とさない**。「チャーシュー」「チャーシューメン」は「チャー」と略すが、
   一緒にある「ネギ」は必ず残す。
   例: 塩ネギチャーシュー → 塩ネギチャー（「塩チャー」は別商品「塩チャーシュー」と紛らわしい）
6. 「Aセット」「Bセット」「Cセット」は、そのアルファベットを先頭へ移して略す。
   例: 味噌ラーメンAセット → A味噌 ／ 塩ラーメンBセット → B塩
7. 次の語は略さず、そのまま残す: 「お子様」「ピリ辛」。
   例: お子様ラーメン味噌 → お子様味噌
8. 「既に使われている札」が示されたら、それと同じ札にしない。

出力は JSON のみ。説明を書かない。`;

/**
 * 本モジュールが使う Workers AI の能力だけを写した型。`Ai` 全体を受けない（`ShortNameStore` と同じ理由）。
 *
 * モデル ID を `string` で取るのは、値の出所が `vars`（素の文字列）だからである。`Ai` はこの形に適合する。
 */
export interface ShortNameModel {
  run(
    model: string,
    inputs: {
      readonly messages: readonly { readonly role: string; readonly content: string }[];
      readonly response_format: unknown;
      readonly chat_template_kwargs?: { readonly enable_thinking: boolean };
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown>;
}

/** 生成が要する 4 つ。テストは実 AI も実 KV も使わずに全分岐を踏める。 */
export interface ShortNameDeps {
  /** モデルへ問う能力。 */
  readonly ai: ShortNameModel;
  /** 辞書の保存先。 */
  readonly store: ShortNameStore;
  /** モデル ID（`vars` の `SHORT_NAME_MODEL`）。呼び出しと記録の双方に使う。 */
  readonly model: string;
  /** 現在時刻。budget の消費を測るためだけに使う（実時間を待たずに期限の分岐を回せる）。 */
  readonly now: () => number;
}

/** 記録に残す不採用の理由。**候補そのものも残す**ので、細かい分類は持たない。 */
type Rejection = "undecodable" | "failed-check" | "call-failed" | "deadline";

/**
 * 札 1 件を生成し、結果（`short` か `plain`）を必ず辞書へ書く。
 *
 * `key` は NFKC 正規化後の名前で、モデルへ渡すのも検査に使うのもこちら。`declaredName` は正規化前の申告値で、
 * **記録にしか現れない**——鍵からは復元できず、訂正の経路を持たない以上（判断 11）、何が届いてこの札に
 * なったかを後から読める唯一の手がかりである。
 *
 * `budgetMs` は AI の待機に費やせる時間。呼び出し側がリクエスト共通の締切から配る。**使い切ったら再試行の
 * 可否に関わらず待つのをやめ、`plain` の保存へ進む**（Requirement 4 AC10）。
 *
 * 8 コードポイント以下の名前では **AI を呼ばない**。略す必要がなく、呼べば元の名前をそのまま返すか意味なく
 * 削るかのどちらかである。実データでは 48 件中 24 件がこれに当たる。
 *
 * **確定したエントリを返す**（`void` ではない）。呼び出し側は押し込みの積荷へ載せる。
 */
export async function generateShortName(
  deps: ShortNameDeps,
  key: string,
  declaredName: string,
  budgetMs: number,
  taken: readonly string[] = [],
): Promise<ShortNameEntry> {
  if ([...key].length <= SHORT_NAME_MAX_LENGTH) {
    // AI を呼んでいないので記録のモデル ID は null。
    const plain: ShortNameEntry = { kind: "plain" };
    await persist(deps, key, declaredName, plain, null, []);
    return plain;
  }

  const startedAt = deps.now();
  const attempts: { candidate: string | null; rejected: Rejection }[] = [];

  // 1 回目と、落ちたときの再試行 1 回。3 回目は無い（判断 13）。
  let label: string | null = null;
  for (let attempt = 0; attempt < 2 && label === null; attempt += 1) {
    const remaining = budgetMs - (deps.now() - startedAt);
    if (remaining <= 0) {
      attempts.push({ candidate: null, rejected: "deadline" });
      break;
    }
    // 逐次 await は意図的。再試行は 1 回目の結果を見てから決まるため、並列化が成り立たない。
    // oxlint-disable-next-line no-await-in-loop
    label = await ask(deps, key, Math.min(SHORT_NAME_CALL_TIMEOUT_MS, remaining), attempts, taken);
  }

  // **書き込みはループの外に 1 回だけ置く。** 中から早期 return すると経路が 2 つになり、「必ず何かを
  // 書いて終わる」がコードの形から読めなくなる（書き忘れる枝を作れてしまう）。
  const entry: ShortNameEntry = label === null ? { kind: "plain" } : { kind: "short", label };
  await persist(deps, key, declaredName, entry, deps.model, attempts);
  // **確定したエントリを返す。** 呼び出し側は押し込みの積荷へ載せる——返さないと、生成直後の札を
  // 配るためにもう一度 KV を読むことになる（judgment 29）。
  return entry;
}

/**
 * モデルへ 1 回問い、復号と検査を通った札を返す。通らなければ `null`（理由と候補を `attempts` へ積む）。
 *
 * **例外を外へ出さない。** 呼び出し失敗・中断・`JSON Mode couldn't be met` はいずれもここで捕らえ、検査落ちと
 * 同じ `null` へ畳む（判断 23）。経路を増やさないためであり、分類は記録に残せば足りる。
 *
 * 待機は `AbortSignal.timeout` で切る。切れた呼び出しの Promise は拒否で終わるので、**遅れて返った結果から
 * 追加の保存が起きることはない**——書き込みはこの関数が返った後にしか起きない。
 */
async function ask(
  deps: ShortNameDeps,
  key: string,
  timeoutMs: number,
  attempts: { candidate: string | null; rejected: Rejection }[],
  taken: readonly string[],
): Promise<string | null> {
  let response: unknown;
  try {
    response = await deps.ai.run(
      deps.model,
      {
        messages: [
          { role: "system", content: SHORT_NAME_PROMPT },
          {
            role: "user",
            content:
              taken.length === 0
                ? `次の商品名に札を作れ。\n\n${key}`
                : `既に使われている札: ${taken.join(" / ")}\n\n次の商品名に札を作れ。\n\n${key}`,
          },
        ],
        // **思考を切る。** `glm-5.3-flash` は推論モデルで、既定のままだと 1 件 18,449ms・33.6 Neurons を
        // 使う（実測・2026-09-15）。切れば 3,269ms・4.8 Neurons になり、出力の質は変わらなかった。
        chat_template_kwargs: { enable_thinking: false },
        // `json_schema` は `name` が必須で、スキーマ本体は `schema` に入る（モデルの公開入力スキーマ）。
        // JSON Mode の資料が載せているフラットな形はこのモデルでは通らない。
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "short_name",
            schema: {
              type: "object",
              properties: { short: { type: "string" } },
              required: ["short"],
              additionalProperties: false,
            },
          },
        },
      },
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch {
    attempts.push({ candidate: null, rejected: "call-failed" });
    return null;
  }

  const candidate = toShortNameCandidate(response);
  if (candidate === null) {
    attempts.push({ candidate: null, rejected: "undecodable" });
    return null;
  }
  const label = toShortName(candidate, key);
  if (label === null) {
    // 候補そのものを残す。鍵と並べれば「長すぎた」のか「元名に無い文字が入った」のかは読める——
    // 理由を機械的に分類すると、検査の条件がここにも書かれて二つ目の真実になる。
    attempts.push({ candidate, rejected: "failed-check" });
    return null;
  }
  return label;
}

/** 判断と記録を辞書へ書く。書き込みの失敗は呼び出し側へ伝える（エントリが残らない＝次の到着で再検出）。 */
async function persist(
  deps: ShortNameDeps,
  key: string,
  declaredName: string,
  entry: ShortNameEntry,
  model: string | null,
  attempts: readonly { candidate: string | null; rejected: Rejection }[],
): Promise<void> {
  const record: ShortNameRecord = {
    declaredName,
    decidedAt: deps.now(),
    model,
    attempts: attempts.map((a) => ({ candidate: a.candidate, rejected: a.rejected })),
  };
  await writeShortName(deps.store, key, entry, record);
}
