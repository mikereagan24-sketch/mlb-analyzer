# Opener/tandem blend audit — 2026-07-05

Follow-up to `docs/verify-measurement-session-2026-07-05.md` Part 3. The
earlier doc suggested PRs #148-150 (opener detection + SP-SP tandem
flat matrix) may have reduced projected SP innings materially, widening
the HI-bucket under-projection. This audit isolates the mechanism.

**Executive summary — the earlier hypothesis is REFUTED by direct
decomposition.** The opener path is not the driver. On the same games,
scoring under the opener path produces estTot **+0.15 runs higher** on
average than the non-opener SP path would. The HI-bucket under-projection
lives in the general wOBA→runs pipeline, not in the opener/tandem branch.

Data: fresh prod `/api/games` fetch across 2026-06-01 → 2026-07-05,
n=443 resolved games. Local mirror ends pre-cutoff, so all analysis
below is on prod-fetched rows.

## Phase 1 — Segmentation across the PR window

Segment × period × market bucket, mean (model − market) as "gap" and
mean (actual − model) as "err":

```
sp_sp/pre                (no games)
sp_sp/post                MID: n=1     mkt=7.50  mdl=7.13   act=11.00   gap=-0.370  err=+3.87

opener/pre                LO:  n=1     mkt=6.50  mdl=6.55   act=8.00    gap=+0.05   err=+1.45
                          MID: n=40    mkt=8.18  mdl=7.59   act=9.68    gap=-0.588  err=+2.09
                          HI:  n=14    mkt=9.71  mdl=8.57   act=8.21    gap=-1.146  err=-0.35
opener/post               MID: n=2     mkt=8.50  mdl=8.27   act=7.50    gap=-0.230  err=-0.77
                          HI:  n=3     mkt=10.17 mdl=8.59   act=9.33    gap=-1.580  err=+0.75

neither/pre               LO:  n=4     mkt=6.50  mdl=7.41   act=6.50    gap=+0.910  err=-0.91
                          MID: n=233   mkt=8.13  mdl=7.99   act=8.66    gap=-0.138  err=+0.67
                          HI:  n=100   mkt=10.16 mdl=9.27   act=11.13   gap=-0.885  err=+1.86
neither/post              LO:  n=1     mkt=6.50  mdl=7.42   act=9.00    gap=+0.920  err=+1.58
                          MID: n=19    mkt=8.13  mdl=7.83   act=9.16    gap=-0.298  err=+1.33
                          HI:  n=25    mkt=10.34 mdl=9.36   act=10.92   gap=-0.976  err=+1.56
```

Aggregate counts: sp_sp_post=1, opener_pre=55, opener_post=5,
neither_pre=337, neither_post=45. Post-cutoff samples are too small
(especially opener_post=5, sp_sp_post=1) to draw independent
conclusions about the PR merges' effect.

**What actually stands out is the pre-cutoff neither/HI gap (-0.885,
n=100).** That's the biggest population with a real gap, and it's
the *non-opener* segment — the opener bucket isn't where the pain lives.

**The pre/post gap widening reported in the earlier doc (-0.54 → -0.87)
is largely a bucket-mix effect**, not evidence of the PRs shifting
model behavior. Post-cutoff meanMkt is 9.23 vs pre 8.67 — the post
sample skewed toward HI games (which have larger gaps in every segment).
The earlier doc treated the aggregate gap as if it were per-game, but
across the same bucket mix, the shift would be substantially smaller
than the raw aggregate suggests.

## Phase 2 — Broad opener-path vs SP-path decomposition

For every June 2026 opener-flagged game (n=55), re-scored twice:
- (a) natural opener-aware path,
- (b) forced non-opener (both `is_opener_game_*` set to 0, bulk_guy nulled).

Delta = estTot(opener) − estTot(non_opener):

```
bucket   n     mean_delta   min      max     estTot_op  estTot_no  actual
LO       1     +0.040       +0.04    +0.04   6.64       6.60       8.00
MID      40    +0.143       -0.27    +0.66   7.57       7.42       9.68
HI       14    +0.191       -0.21    +0.48   8.38       8.19       8.21
```

- Overall mean delta: **+0.154 runs**
- P10 delta = -0.050; P50 = +0.152; P90 = +0.340
- Only 12% of the games had a negative delta (opener path lowered estTot)

**The opener path produces slightly HIGHER estTot than the non-opener
path on the same games.** The mean shift is +0.15 runs. If the goal is
to explain a -1.15-run gap on opener-HI games, this component moves
the wrong direction — turning opener OFF would make the gap +0.19 runs
worse, not better.

Individual worst-case openers where the opener path lowered estTot
(all still under 0.3 runs of delta):

```
2026-06-05  tb-mia    mkt=7.5   estOp=7.90  estNo=8.17  Δ=-0.271  actual=6
2026-06-01  kc-cin    mkt=9.5   estOp=8.84  estNo=9.05  Δ=-0.209  actual=11
2026-06-25  kc-tb     mkt=8.5   estOp=7.46  estNo=7.64  Δ=-0.182  actual=15
2026-06-14  tb-laa    mkt=9.5   estOp=7.67  estNo=7.80  Δ=-0.130  actual=11
```

Even on the games where the opener path is lower than SP, the delta is
small — a couple tenths of a run. The 15-run kc-tb game would have
missed reality regardless of path (11-run gap to actuals).

## Phase 3 — Where the HI-bucket under-projection actually lives

Focused on the 100 pre-cutoff Neither-HI games (the largest population
with the largest gap). Component breakdown:

```
  n=100
  mean market_total    = 10.16
  mean model estTot    = 8.98
  mean actual          = 11.13
  gap (mdl-mkt)        = -1.179
  err (act-mdl)        = +2.149   ← model under-projects reality by 2 runs
```

Model internals:

```
  aTeamWoba mean = 0.3163   (league avg ~0.320)
  hTeamWoba mean = 0.3161
  aRuns mean     = 4.271
  hRuns mean     = 4.252
  aRuns + hRuns  = 8.523    (matches estTot within wind/temp)
  wind adj mean  = 0.092
  temp adj mean  = 0.000
```

**Team wOBAs are 0.316 on games where the market projects 10+ runs.**
That's SLIGHTLY BELOW league average despite these being games the
market thinks will have above-average scoring. The model is producing
regression-to-mean team wOBAs on games where the market believes the
offenses will over-perform.

Implied wOBA at RUN_MULT=45.5 to close to the market's 10.16:

```
  Market's implied per-team runs: ~5.08
  Implied team wOBA:              0.3418
  Model's actual team wOBA mean:  0.3163
  Gap:                            25.5 wOBA points
```

Implied wOBA to match actuals (11.13):

```
  Per-team runs needed: ~5.57
  Implied team wOBA:    0.3523
  Gap from model:       36.0 wOBA points
```

**The mechanism: model team-wOBA lookups compress toward league mean on
HI-market games, but reality (and the market) extrapolate further.**
This isn't a scoring formula issue per se — the RUN_MULT × (wOBA − baseline)
math is linear and correct. It's a *wOBA-input distribution* issue: the
model's blended team wOBAs don't spread out enough at the tails.

Candidate mechanisms (not yet pinned):
1. **W_PROJ blend drag.** Steamer projections are more regressed than
   actuals. At W_PROJ=0.45 / W_ACT=0.55, blended wOBA gets pulled
   toward Steamer's regressed values.
2. **Park-neutralization (now live) deflates HI-park hitters.** COL/ATH/CIN
   home teams (which populate a lot of HI-market rows) get -2 to -5%
   deflation on the actuals half. That pulls model wOBAs *down* on the
   games where the market has projected a lot of runs. The 07-05 verify
   session flagged that HI-extreme gap actually got WORSE with park-
   neutral ON (-0.50 → -0.66).
3. **Bullpen input caps at 0.318**. On HI games where bullpens are
   weaker than league (or the SP-vs-bullpen mix produces high hitter
   exposure), the model has no way to represent "this bullpen is a
   dumpster fire" — it clamps to the average.
4. **RUN_MULT is a global scalar.** No way to say "at high market
   totals, run more sensitivity per wOBA delta."

## Part 3 — SP-SP tandem flat matrix ablation

Insufficient data. Only 1 resolved sp_sp game in the fresh prod window,
and 0 resolved sp_sp games with a graded outcome that's not the
Yamamoto TOR@SEA case. Cannot draw conclusions about the flat matrix's
impact on aggregate totals until the SP-SP tandem population has ~10-15
resolved games.

Deferred to a follow-up in ~2-3 weeks when more sp_sp games have
graded.

## Decision

**No opener/tandem-side fix is warranted this pass.** The opener
path isn't producing the HI-bucket under-projection — the mean delta
is +0.15 runs *toward* the market, and 88% of opener games benefit
from the opener path relative to what the SP path would produce.

Reverting or dampening the opener path would make the gap *larger*
on this dimension while addressing none of the underlying wOBA-input
issue.

The real HI-bucket problem is in the general Neither segment
(non-opener, non-tandem): team wOBAs blend to 0.316 on games where
the market expects 10+ runs. Closing this needs either:
- A **non-linear or lineup-strength-adjusted RUN_MULT** (code change,
  not a knob).
- **Widening the W_ACT weight on high-sample lineups** (weakens the
  Steamer regression drag).
- **Un-clamping the bullpen average** so extreme bullpens can move the
  model (needs bullpen-quality-adjusted default, not a global const).

None of these is a settings-only change. Each is a code-level
investigation of its own.

## Corrections to the earlier doc

`docs/verify-measurement-session-2026-07-05.md` Part 3 stated:

> **PR #148-150 hypothesis confirmed on fresh prod data:** pre-cutoff
> gap -0.54, post-cutoff -0.87. Opener-flagged games' gap went -0.41 →
> -1.02.

This decomposition shows the confirmation was misleading:

- The aggregate gap widening (-0.54 → -0.87) is largely a **bucket-mix
  effect** (post sample skewed toward HI games with larger baseline gaps).
- The opener-flagged pre → post gap change (-0.41 → -1.02) is on n=10 pre
  and n=3 post — well within noise.
- **The opener path itself contributes +0.15 runs vs the SP path**, so
  the mechanism the earlier doc proposed ("PRs #148-150 reduced
  projected SP innings materially") is not what's happening. Mean SP
  forecast IP itself is 5.18 pre → 5.22 post (unchanged), and the
  routing change adds runs on aggregate rather than removing them.

**The HI-bucket gap is real and pre-existing.** It's not a regression
introduced by the PRs. Investigation direction is the wOBA blend
compression, not the opener path.

## What follow-up work is warranted

1. **wOBA blend compression measurement** (own investigation): why do
   team wOBAs land at 0.316 on games where the market implies 0.342?
   Instrument the blend pipeline; report the delta per-team-half over
   a season.
2. **Park-neutralization re-evaluation on extreme parks** (still ~2wk
   old data): the 07-05 verify session showed HI-extreme gap widened
   with park-neutral ON. Worth re-running once a couple more weeks of
   data has landed under the new setting.
3. **SP-SP tandem sample accumulation** (passive): revisit the flat
   matrix vs per-position matrix ablation in ~3 weeks when there are
   10-15 resolved sp_sp games.

None of these is a settings tuning. All three are measurement PRs.
