---
status: accepted
date: 2026-09-04
specs: lift-group-display
---

# 群の識別はワイヤで運ばず、client が startAt + 茹で秒で serveAt を再計算して等号で組む

client が「同時に上げる群」を知るには手がかりが要るが、`CookRecommendation` に `serveAt` も群の識別子も足さない。計画側（`schedule.ts`）と client 側（`boilSecondsOf`）は同じプリセット・同じ硬さで茹で秒を引くため、`startAt + 茹で秒` は両端で整数ミリ秒として一致する。等しいものを一群とすれば、ワイヤも契約も変えずに群が読める。

`serveAt` は導出値であり、ワイヤに載せれば導出値を運ぶことになる。許容幅で「近いものを一群」と判定する規則も置かない。等号で組む限り、揃っていないものを揃っていると言う経路が構造的に存在しない。config と snapshot の到着ずれの窓では `boilSecondsOf` が既に提案を落としており、その窓で誤った群ができることはない。

## Consequences

- 計画が群の serveAt を一致させない限り、client には単独の群しか見えない。表示 spec（lift-group-display）は計画 spec（lift-group-planning）の後に着地する。
- 現場にとって serveAt は存在しない。client にとっては群の鍵、engine にとっては採点の量である。
