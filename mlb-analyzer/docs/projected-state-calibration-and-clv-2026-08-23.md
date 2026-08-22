# Projected-state calibration, and why the CLV panel is empty (2026-08-23)

> **Measurement + diagnosis. Nothing shipped.**

Three questions: why the CLV panel is blank, how CLV is actually
computed, and — the important one — whether the **day-before** model
beats the **day-before** market, since that is the state money is
committed in.

Harness: `scripts/projected-vs-closing-calibration.js`.

## TL;DR

- **The panel is empty because the default window is the last 30 days
  and the last CLV-eligible row is 2026-07-10.** Not a code bug —
  `bet_line` is written only by a manual lock action, and it fell from
  ~140/month in Apr–May to 13, 20, then **0** in Jun/Jul/Aug.
- **CLV involves no model line at all.** It is
  `implied(closing_line) − implied(bet_line)` in percentage points.
  Nothing mutating, nothing model-derived.
- **The day-before model does NOT beat the day-before market.** It is
  significantly worse: +0.00633 log loss, CI [+0.00169, +0.01303].
- **But the intuition behind the question was half right.** The gap is
  *narrower* against the softer day-before line (+0.00633) than against
  the close (+0.00902), because the market sharpens and the model does
  not.
- **The CLV record is real and significant: +0.779pp, t=4.01.** It is
  also **smaller than the vig** (~2.25pp/side). +0.78 − 2.25 = **−1.47pp**
  — which is exactly why the record is 126W-142L and −420.47.

## 1. Why the CLV panel is empty

`_clvDefaultRange()` (`public/index.html:2456`) requests the **last 30
days** → today that is 2026-07-24 → 2026-08-23.

| | |
|---|---|
| bet_signals rows in that window | 396 |
| **CLV-eligible rows in that window** | **0** |
| last eligible `game_date` anywhere | **2026-07-10** |

`buildClvStats` keeps rows where `closing_line`, `clv` and `outcome` are
all non-null. Across the whole table:

| month | rows | bet_line | closing_line | clv | eligible |
|---|---|---|---|---|---|
| 2026-04 | 214 | 140 | 212 | 104 | 104 |
| 2026-05 | 293 | 139 | 293 | 136 | 136 |
| 2026-06 | 454 | **13** | 453 | 13 | 13 |
| 2026-07 | 658 | **20** | 615 | 20 | 20 |
| 2026-08 | 188 | **0** | 74 | 0 | **0** |

**`closing_line` is fine** (1647/1807). The binding constraint is
`bet_line`, which is written **only** by
`POST /signals/:id/bet-line` — a manual operator action. No manual lock,
no `bet_line`; no `bet_line`, no CLV. The BsR section at the bottom
renders because it reads a different source that does not depend on it.

**The route does not fail silently** — it returns 500 and logs on error
(`routes/api.js:3392`). This is a genuinely empty aggregate over an
empty window.

Two secondary notes, neither a bug:

- The 37 rows with `bet_line` + `closing_line` but null `clv` are all
  `Total` signals. CLV is ML-only by design, and
  `routes/api.js:1415` actively NULLs Total CLV. ML is 273/273 complete.
- The recompute path is healthy: when `closing_line` lands later,
  `services/jobs.js:2301` and `:3764` recompute CLV from `bet_line`.

## 2. How CLV is computed

`services/clv.js` is the single source of truth:

```js
function calcCLV(bet_line, closing_line) {
  const pBet   = americanToImplied(bet_line);
  const pClose = americanToImplied(closing_line);
  return Math.round((pClose - pBet) * 1000) / 10;   // percentage points
}
```

| | |
|---|---|
| columns | `bet_signals.bet_line`, `bet_signals.closing_line` |
| comparison | implied-probability distance, closing minus bet |
| units | percentage points (+1.5, −2.0) |
| **model line involved** | **none — at any stage** |

**Direct answer to the concern: CLV compares your bet price against the
closing price only.** No model line, emit-time or otherwise, enters the
computation. There is no mutating-column exposure here. `bet_signals`
does carry `model_line`, but `calcCLV` never reads it.

Both inputs are also protected: `bet_line`/`bet_locked_at` are the
manual lock itself, and `closing_line`/`clv` are on the explicit
post-lock whitelist in the CLAUDE.md immutability rule.

**One correction on the emit-time columns.** They exist —
`model_total_at_emit`, `opener_model_total_at_emit`,
`model_home_ml_at_emit`, `model_away_ml_at_emit` — and `q.upsertSignal`
does write them. But **all 1807 rows in the local snapshot have them
NULL**, including the 172 created since 2026-08-01. The snapshot's
newest `created_at` is 2026-08-07, so the most likely explanation is
that the columns were added after that and prod has been populating them
since. **I cannot confirm from local data either way** — worth a check
against prod before relying on them.

## 3. The main question: projected state vs closing state

Both states read from **persisted columns**, so no re-scoring — the
model values are the ones that actually existed at the time.

| state | model | market |
|---|---|---|
| projected | `proj_model_{home,away}_ml` | `proj_market_{home,away}_ml` |
| closing | `model_{home,away}_ml` | `market_{home,away}_ml` |

Model ML passes through `rawToML` + `applySpread` (FAV_ADJ/DOG_ADJ), so
its two sides do not sum to 1. **All four series are de-vigged from
their own two sides**, which recovers the model's implied probability
net of its own padding and keeps everything on one construction.

1,227 games, 2026-05-01 → 2026-08-07, **identical game set in both
states** — the only thing that differs is state.

### Absolute performance

| series | log loss | Brier | AUC |
|---|---|---|---|
| **close market** | **0.68173** | 0.24438 | **0.5799** |
| proj market | 0.68481 | 0.24590 | 0.5676 |
| close model | 0.69075 | 0.24877 | 0.5472 |
| proj model | 0.69114 | 0.24897 | 0.5431 |
| base rate | 0.69253 | 0.24969 | — |

**Both market states beat both model states.**

### Does the model beat the market, in each state?

| comparison | Δ log loss | 95% CI | |
|---|---|---|---|
| **PROJECTED: model − market** | **+0.00633** | **[+0.00169, +0.01303]** | **model significantly worse** |
| CLOSING: model − market | +0.00902 | [+0.00403, +0.01462] | model significantly worse |

**No. The model loses to the market at both states, significantly.**

Against the base rate:

| | Δ | 95% CI | |
|---|---|---|---|
| proj model − base | −0.00139 | [−0.01046, +0.00569] | not significant |
| close model − base | −0.00178 | [−0.01074, +0.00535] | not significant |
| **proj market − base** | −0.00772 | [−0.01546, −0.00159] | **better** |
| **close market − base** | −0.01080 | [−0.01893, −0.00401] | **better** |

Neither model state is distinguishable from a constant. Both market
states are.

### The half that *was* right

The **gap narrows** at projected state: +0.00633 vs +0.00902. The model
is meaningfully *less far behind* the day-before line. Mechanism:

| | Δ log loss | 95% CI | |
|---|---|---|---|
| close market − proj market | −0.00308 | [−0.00668, +0.00031] | market sharpens (marginal) |
| close model − proj model | −0.00039 | [−0.00348, +0.00226] | model barely moves |

**The market improves between the two states and the model does not.**
That is a real asymmetry and it is the mechanism a positive CLV record
reflects. It is just not enough to put the model ahead.

The edge slope agrees, directionally:

| state | slope | 95% CI |
|---|---|---|
| PROJECTED | −0.036 | [−0.609, +0.371] |
| CLOSING | −0.434 | [−1.029, +0.072] |

At projected state the claimed edge is indistinguishable from *noise*;
at closing it drifts toward *backwards*. Both span zero — a difference
in flavour, not a finding.

### The control that settles it

`proj_model_*` is the **last** projected-lineup value, but
`proj_market_*` is written through `COALESCE`, so it is the **first**
market seen. They are not the same instant, and the asymmetry **flatters
the model** — it gets a later, better-informed snapshot than the market
it is scored against. The gap is not small: `|proj_market − close_market|`
averages **2.44pp** and moves >0.5pp on **86%** of games.

So score the projected model against the **closing** market, removing
the stale-market advantage entirely:

| | Δ log loss | 95% CI | |
|---|---|---|---|
| proj model − CLOSE market | **+0.00941** | [+0.00420, +0.01564] | **significantly worse** |

**Even with the asymmetry helping it, the model loses. Removing the
help, it loses by more.** The conclusion is robust in the direction that
matters.

## 4. The CLV paradox, resolved

The actual record, over the 273 locked ML bets:

| | |
|---|---|
| mean CLV | **+0.779pp** |
| SE / t | 0.194 / **t = 4.01** — significant |
| positive CLV | 135/273 (49%) |
| record | **126W – 142L** |
| total P&L | **−420.47** |

> **QUALIFIED 2026-08-23 by `docs/one-click-bet-logging-design-2026-08-23.md`.**
> `GET /api/backtest` (`routes/api.js:1415`) backfills
> `closing_line = market_line` for any resolved signal lacking one. As a
> result **211 of these 273 rows have `closing_line == market_line`**,
> and for a locked row `market_line` is frozen at lock time — so those
> rows measure *bet price vs the card's line at lock*, not vs the close.
> Split:
>
> | | n | mean CLV |
> |---|---|---|
> | genuine capture (`closing != market`) | 62 | **+2.218pp** |
> | backfilled (`closing == market`) | 211 | +0.356pp |
> | pooled (reported below) | 273 | +0.779pp |
>
> The +0.779pp and t=4.01 stand as computed, but they blend two
> different quantities and should not be read as a single
> closing-line-value figure. The vig conclusion is unaffected: even
> +2.218pp on the genuine subset is around the ~2.25pp per-side vig,
> i.e. roughly breakeven, on n=62.

**The CLV is real.** The picks genuinely beat the closing line, and not
by luck at t=4.01. So how is the P&L negative?

| | |
|---|---|
| measured CLV edge | +0.78pp |
| closing overround | 4.50pp → **~2.25pp per side** |
| **net** | **−1.47pp** |

**You beat the close by 0.78pp and pay 2.25pp to do it.** Positive CLV
is necessary for profitability, not sufficient — it has to exceed the
vig, and here it is about a third of it. That single line explains
126W-142L and −420.47 without needing anything else.

Note also the shape: CLV is positive on only **49%** of bets, so the
+0.78pp mean comes from magnitude on a near-even split, not from being
right more often.

**And a selection caveat that cuts both ways:** the CLV record is
measured on the 273 bets that were hand-picked and manually locked. The
calibration corpus is all 1,227 games. Those are different populations,
and per the 2026-08-21 selection rule, a statistic computed on a
hand-selected subset cannot be read as a property of the model. The
picks may well be better than the model's average output — that would be
operator skill, not model skill, and this analysis cannot separate them.

## 5. What this does and does not establish

**Does:**
- The day-before model is significantly worse than the day-before
  market, and worse still against the closing market.
- The market sharpens between the two states while the model does not.
- CLV is real, significant, and smaller than the vig.

**Does not:**
- **Not** that betting the day before is wrong. It is better than
  betting at close — the gap is genuinely narrower — just not enough.
- **Not** anything about totals. ML only throughout.
- **Not** a verdict on the operator's *selection*. The 273 picks are a
  chosen subset; their CLV is not the model's CLV.
- **Not** confirmation that the emit-time columns are broken in prod —
  only that they are NULL in a snapshot that predates them.

## 6. Open questions

Recorded, not proposed.

1. **Is operator selection adding value the model does not have?** The
   273 picks have significant CLV; the model as a whole loses to the
   market. Comparing pick-level CLV against the CLV of *all* emitted
   signals over the same dates would separate operator skill from model
   skill. That is the single most interesting question raised here.
2. Would fixing the `proj_market_*` COALESCE to store a *matched-instant*
   snapshot make the projected comparison cleaner? It would cost nothing
   going forward and remove a known bias.
3. Does the day-before/closing gap look different for totals?
4. Is `bet_line` capture worth automating, given CLV analysis dies
   without it?

## Related

- `docs/component-signal-diagnostic-2026-08-23.md` — closing-state decomposition.
- `docs/edge-honesty-scope-2026-08-22.md` — the edge-slope finding.
- `docs/sweep-selection-effect-2026-08-21.md` — why the 273-pick subset is a different population.
- `services/clv.js` — CLV math.
- `services/clv-stats.js` — panel aggregation and eligibility filter.
