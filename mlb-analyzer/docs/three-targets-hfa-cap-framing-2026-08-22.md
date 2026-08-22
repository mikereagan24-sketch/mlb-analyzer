# HFA_BOOST, the edge-cap level, and CATCHER_FRAMING_MUTE (2026-08-22)

> Three targets from the provenance ledger, in the order set.
> **Two of the three live values turn out to be defensible. The third —
> the 8pp cap — is the worst level on the grid.**
> **Nothing flipped.** One harness defect found, which invalidates the
> *absolute* numbers in four earlier evaluations.

## 0. A correction to the ledger's framing of ROI

The ledger filed the edge-cap trio under **ROI-selection** — the
invalidity class from `docs/sweep-selection-effect-2026-08-21.md`. That
classification was wrong, and the reason it was wrong is worth stating
because it bounds how far that finding generalises.

ROI over emitted signals is invalid for **pricing** parameters because
`calcPnl` never sees a model number — a kept bet's P&L is byte-identical
across arms, so only composition can move the aggregate.

The hard cap is not a pricing parameter. `services/model.js:1546`:

```js
if (s.edge >= HARD) { ...; continue; }   // do not emit
```

It **suppresses**. Changing the cap changes exactly one thing: the bet
set. Selection *is* the mechanism, so ROI measures the intended effect
directly. The caveat does not apply.

**The open question was never "is ROI valid here" — it was "why 8pp".**
That is what §2 measures.

## 1. HFA_BOOST = 0.017 — keep it

The ledger called this "a hardcoded boost for an effect we cannot
demonstrate." That overstated the case, and the overstatement was mine.

Two separate claims were being run together:

1. *Is home-field advantage statistically established in this corpus?*
   No — home win rate 51.83%, well under 1 SE from 50%.
2. *Is 0.017 the right value for the parameter?* **Yes, essentially
   exactly.**

These are compatible, and only the second is a question about the
parameter.

```
realized home win rate : 51.828%
mean rawHW (pre-boost) : 50.156%
implied mean-matching boost = 0.01673      live value = 0.01700
```

The log-loss curve in the boost is smooth and unimodal, and **0.017 sits
at its minimum**:

```
boost   -0.010   0.000   0.010   0.015   0.017   0.020   0.030   0.045   0.060
logLoss 0.69123 0.69033 0.68985 0.68976 0.68975 0.68977 0.69010 0.69137 0.69358
                                          ^ live, argmin
```

A/B, 0 vs 0.017, on the corrected harness (§4):

| arm | logLoss | Brier | ECE | AUC | edge slope |
|---|---|---|---|---|---|
| 0 (off) | 0.68989 | 0.24836 | 0.0147 | 0.5518 | −0.243 |
| **0.017 (live)** | **0.68944** | **0.24815** | **0.0074** | 0.5518 | −0.243 |

Δ log loss **−0.00045**, CI [−0.00262, +0.00186] — not significant.
4/5 windows favourable.

**The structural point that settles it: AUC and edge slope are identical
to five decimals.** A constant added to every `p(home)` is a monotone
transform — it cannot reorder anything. `HFA_BOOST` is a *pure
calibration* parameter, and on the only axis it can move it **halves
ECE, 0.0147 → 0.0074**.

**Verdict: keep 0.017.** Removing it is a strict calibration loss for no
compensating gain. Under the tiered standard it is Tier 3 — mechanism
(centre the prediction on the observed rate) plus no-harm, with the
harm side of the interval at +0.0019. The ledger line is corrected.

## 2. The 8pp edge cap — the level is not merely unsupported, it is the worst tested

`scripts/edge-cap-level.js` (new). Scores the corpus **once with the cap
disabled**, retaining every signal; each candidate level is then a
post-hoc filter over that fixed population. All levels are therefore
compared on an identical set, and the suppressed population is directly
observable rather than inferred.

947 scoreable games, 1026 signals, 2026-04-01 .. 2026-08-07.

### Realized ROI by edge band, uncapped

```
edge (pp)     n     ROI%     95% CI (date-clustered)
0-2         183    +1.96    [-12.60, +16.89]
2-4         358   -10.95    [-21.91,  -0.43]
4-6         221    -6.09    [-17.73,  +4.97]
6-8         134   -13.49    [-30.71,  +4.21]
8-10         81   +15.11    [ -4.52, +35.49]   <- the only positive band with n
10-15        45   -19.20    [-56.52, +14.96]
15-25         4   +45.68    [-44.78, +90.91]
25+           0
```

### What each candidate cap keeps versus throws away

A cap is justified only if what it **suppresses** does worse than what it
**keeps**.

```
cap    kept_n  kept_ROI   supp_n  supp_ROI   delta
0.04     541    -6.51       485    -5.43     -1.09
0.06     762    -6.39       264    -4.85     -1.54
0.08     896    -7.43       130    +4.53    -11.96   <- PROD
0.10     977    -5.69        49   -13.03     +7.34
0.12    1007    -6.10        19    -1.47     -4.63
0.15    1022    -6.23         4   +45.68    -51.91
none    1026    -6.02         0      n/a
```

**The 8pp cap suppresses the one positive band.** It is the only level
where the discarded population outperforms the retained one by a wide
margin, and it costs the book 1.41pp of ROI against no cap at all:

```
cap     0.04   0.06   0.08   0.10   0.12   0.15   0.25   none
ROI%   -6.51  -6.39  -7.43  -5.69  -6.10  -6.23  -6.02  -6.02
                     ^ PROD, worst on the grid
```

Window sign test, prod cap vs no cap: **cap better in 2 / 5 windows.**

### What this does and does not establish

Stated honestly, because the subset sizes here are exactly the regime
where direction flips:

- The suppressed-population ROI at 0.08 is **+4.53% with CI
  [−10.89, +19.30]** — includes zero. "The bets it throws away are good"
  is **not** established.
- The 8–10pp band is n=81, CI includes zero.
- The whole book is negative at *every* cap level (−5.7% to −7.4%).
  **No cap level makes this a winning book**, which is consistent with
  the model being significantly worse than the market. Re-siting the cap
  is not a profit lever.
- Nine levels were tested; prod landing on the worst is partly a
  multiple-comparisons artifact.
- The delta flips sign between 0.08 (−11.96, n=130) and 0.10 (+7.34,
  n=49). That is the documented n≈25–130 subset sign-flip pattern, and
  it is a reason to read the *shape* rather than any single cell.

**The defensible claim is the weaker one: there is no measured support
for 8pp, the level sits exactly at the left edge of the only positive
band, and every alternative tested is closer to no-cap than 8pp is.**

### The mechanism argument, which is the cap's real defence

The cap is named *edge-sanity*, not *edge-optimiser*. Its honest purpose
is catching **data errors** — a stale line, the wrong probable pitcher, a
mis-keyed total — which surface as implausibly large edges. That is a
legitimate mechanism argument and it does not depend on ROI at all.

But it argues for a threshold sited where plausibility actually breaks,
and **an 8pp edge is not a data error** — it is an ordinary
disagreement. The code's own comment says so:

```
// Thresholds are fractional pp (0.10 = 10pp). Data-driven defaults
// from scripts/edge-calibration-curve.js — see settings-schema.js.
const SOFT = ... : 0.10;
const HARD = ... : 0.25;
```

**The in-code data-driven defaults are SOFT 0.10 / HARD 0.25. Prod runs
0.06 / 0.08 — three times tighter than the value the code documents as
derived.** Where 0.06/0.08 came from is `ship-hard-cap-0.08`, and the
2026-08-22 edge-honesty scope looked specifically for support for that
level and found none.

Also worth recording: **the soft cap is inert on P&L.** It only sets
`edge_suspect: true`, which is persisted for audit
(`services/jobs.js:1332`) and de-emphasised in the UI. It never changes
emission or staking. `SIGNAL_EDGE_SOFT_CAP_PP` is an advisory flag, not
a selection lever — which is fine, but it should not be described as a
cap.

**Recommendation, not applied:** move `SIGNAL_EDGE_HARD_CAP_PP` to the
documented default **0.25**, keeping the cap as the data-error trap it
was built to be and removing the level that has no support. At 0.25 it
suppresses 0 of 1026 signals on this corpus — it becomes a genuine
outlier guard rather than a selection filter. **Not changed here:** it
is a live prod value in the emission path and the decision is yours.

## 3. CATCHER_FRAMING_MUTE = 1.0 vs schema default 0.65 — keep 1.0

Prod's divergence from the schema default is, if anything, in the right
direction.

| arm | logLoss | Brier | ECE | AUC | edge slope |
|---|---|---|---|---|---|
| 0.65 (schema default) | 0.68951 | 0.24818 | 0.0084 | 0.5510 | −0.269 |
| **1.0 (live)** | **0.68944** | **0.24815** | **0.0074** | **0.5518** | **−0.243** |

Δ log loss **−0.00007**, CI [−0.00049, +0.00038] — not significant.
3/5 windows. Blast radius 789/790 games, mean |Δp| = 0.00267.

**Live 1.0 is directionally better on all five metrics.** Not enough for
Tier 2 (the sign test is 3/5, p=0.5), but there is no case for moving to
0.65. The unexplained divergence the ledger flagged is unexplained but
benign.

**Recommendation:** leave prod at 1.0, and update the *schema default*
to 1.0 so the two stop disagreeing. A default that no deployment uses is
a trap for the next person who reads it.

## 4. The harness defect this uncovered — and what it invalidates

The first `CATCHER_FRAMING_MUTE` run reported **0 / 790 games changed —
the flag is inert**. That was false.

`game.{away,home}CatcherFramingRvPerGame` are **caller-populated**:
`runModel` reads them but never computes them (`services/model.js:1288`).
`parameter-sweep.js` has zero mentions of framing, so `preScreenGame`
left them `undefined`, `applyCatcherFramingDelta` returned 0 on both
arms, and the arms were identical **for a harness reason, not a model
reason**.

This is the same false negative `DEFENSE_FRV_ENABLED` hit on
2026-08-22 — where the conclusion would have been "FRV does nothing,
leave it off forever," the exact opposite of the truth.

**The guard built to prevent exactly this did not fire.** It was keyed by
exact parameter name:

```js
const CALLER_POPULATED_INPUTS = {
  CATCHER_FRAMING_ENABLED: [...],   // I passed CATCHER_FRAMING_MUTE
};
```

`CALLER_POPULATED_INPUTS[PARAM]` was `undefined`, so the check was
skipped silently. **A guard that fails open on an unrecognised key is
not a guard.** It has been re-keyed to match parameter *families* by
regex, because a whole family reads one field:

```js
{ match: /^CATCHER_FRAMING_/, fields: ['awayCatcherFramingRvPerGame', ...] },
{ match: /^DEFENSE_FRV_/,     fields: ['awayFieldingRunsPerGame', ...] },
```

and framing is now populated in the harness the way prod does it
(coverage 749/790 and 754/790).

### What this invalidates

**The absolute calibration numbers in every A/B run before this fix were
computed with catcher framing silently disabled.** The corrected
baseline moves:

```
OFF-arm log loss, framing absent : 0.68975      AUC 0.5494   slope -0.313
OFF-arm log loss, framing present: 0.68951      AUC 0.5518   slope -0.243
```

The edge slope in particular moves materially, −0.313 → −0.243, so
`docs/edge-honesty-scope-2026-08-22.md`'s headline slope is understated.

The reported **deltas** are probably close to intact — both arms lacked
framing equally — but that is an argument, not a measurement. These need
re-running on the corrected harness before their numbers are quoted
again:

- `docs/gate-evaluations-2026-08-23.md` — park_neutral, FRV, BsR
- `docs/getsettings-whitelist-audit-2026-08-23.md` §2 — hand_conditional
- `docs/edge-honesty-scope-2026-08-22.md` — the −0.313 slope
- `docs/component-signal-diagnostic-2026-08-23.md`

**FRV is the one to re-run first**, because framing and fielding are the
two caller-populated defensive inputs and its evaluation is the live
gate candidate at 4/5 windows.

Not done here — flagged rather than silently re-run, so the numbers on
those pages are not quietly replaced underneath their conclusions.

### And a duplication finding

`computeFramingRvPerGame` exists **five times verbatim** —
`frv-backtest.js:51`, `baserunning-backtest.js:65`,
`runmult-totals-backtest.js:106`, `temp-backtest.js:66`,
`under-selection-diagnostic.js:57` — plus a sixth state-aware variant
inline at `jobs.js:~700`. Any correction to framing has to be made in
six places. Filed, not fixed.

### Units trap, recorded

`parameter-sweep.js:483` stores `edge_pp: Number(s.edge)` — the value is
a **fraction** (0.08 = 8pp) under a name asserting pp. It read as 0
signals in a band filter before being caught. This is the second time
this unit has cost a re-run. The field should be renamed or converted;
`scripts/edge-cap-level.js` normalises it explicitly at the boundary.

## 5. Housekeeping: `odds_api_key` removed from the model settings blob

`getSettings()` returned the credential inside the object handed to
`runModel`, so any log, sweep manifest, or debug dump of settings leaked
it. It has two genuine consumers, so it could not simply be deleted;
both now use a dedicated accessor:

```js
// Credential accessor, deliberately NOT part of getSettings().
function getOddsApiKey() { ... }
```

- `services/jobs.js:4034` and `routes/api.js:6302` → `getOddsApiKey()`
- `GET /api/settings` reads `app_settings` directly (`routes/api.js:5082`),
  so the settings UI is unaffected — verified before removing.

`getSettings()` now returns exactly **71** keys, which is now literally
the live model-parameter count in the ledger rather than 71 parameters
plus a secret.

## 6. Summary

| target | live | verdict | action |
|---|---|---|---|
| `HFA_BOOST` | 0.017 | **At the argmin of the log-loss curve**; halves ECE; pure calibration (AUC unmoved) | **Keep.** Ledger line corrected |
| `SIGNAL_EDGE_HARD_CAP_PP` | 0.08 | **Worst of 9 levels tested**; suppresses the only positive band; costs 1.41pp vs no cap; code's own default is 0.25 | **Recommend 0.25. Not applied** — your call |
| `SIGNAL_EDGE_SOFT_CAP_PP` | 0.06 | Inert on P&L — advisory `edge_suspect` flag only | No action; stop calling it a cap |
| `CATCHER_FRAMING_MUTE` | 1.0 | Better than schema default 0.65 on all 5 metrics | **Keep 1.0**; align the schema default |
| `odds_api_key` | — | Credential in the model settings blob | **Removed** |

Two of the three targets came back defensible. That is worth noting
against the ledger's overall tone: *unexamined* really is not the same
as *wrong*, and two of the first three examined landed right.

The exception is the cap, and it is the one the ledger called "the most
consequential entry on the page." That held up.

## Related

- `docs/parameter-provenance-ledger-2026-08-23.md` — the source list; §0 and §1 here correct two of its entries.
- `docs/sweep-selection-effect-2026-08-21.md` — the ROI caveat, and §0 above bounds where it applies.
- `docs/edge-honesty-scope-2026-08-22.md` — its slope figure is superseded by §4.
- `docs/getsettings-whitelist-audit-2026-08-23.md` §3 — the tiered standard applied here.
- `scripts/edge-cap-level.js`, `scripts/calibration-ab.js` — the harnesses.
