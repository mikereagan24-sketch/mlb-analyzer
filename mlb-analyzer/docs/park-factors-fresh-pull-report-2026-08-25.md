# Park factors: the fresh pull, reported before applying (2026-08-25)

> **Nothing has been applied.** `PARK_FACTORS` is untouched, no table
> migration has been built. This is the report the ticket asked for.
>
> **The stated provenance does not reproduce.** Production's values cannot
> be derived from the FanGraphs `3yr` column — COL is 1.25 in the code and
> **111** on the page. A three-year regressed factor does not move 0.14 in
> four months. That changes the task from "refresh a stale constant" to
> "decide what the source actually is", which is your call, not mine.
>
> **The ML calibration A/B is the wrong instrument** and I ran it anyway,
> because you asked. Park factor scales *both* teams equally, so it moves
> the total and barely touches the moneyline: mean |Δp| **0.00028**.
> The totals target is where it bites, and there the fresh values are
> better on MAE, RMSE and 5/5 windows.

## 1. The pull, with provenance the old code did not carry

```
source : https://www.fangraphs.com/guts.aspx?type=pf&season=2026
column : `3yr`
pulled : 2026-08-25
columns: Season | Team | Basic (5yr) | 3yr | 1yr | 1B | 2B | 3B | HR | SO
         | BB | GB | FB | LD | IFFB | FIP
```

The `Basic`/`3yr`/`1yr` columns **are** the runs factors; the component
columns are event-specific. So "FanGraphs 3-year R factor" is the `3yr`
column. Values were read twice, independently, and agreed.

The page is behind a Cloudflare interactive challenge from this machine
(`cf-mitigated: challenge`) — including the endpoints the wOBA sync uses
daily. Production reaches FanGraphs fine (wOBA 8/8, 0.7h old at time of
writing), so the block is this network, not the project.

## 2. The stated source does not reproduce the stated values

`4a2cff2` (2026-04-19) says *"FanGraphs 3-year R factor with manual
adjustments... Every other team uses the straight FanGraphs R factor."*

```
team   in code   FG 2026 3yr      team   in code   FG 2026 3yr
COL      1.25       1.11          CLE      0.95       1.03
CHC      1.08       0.94          PIT      0.97       1.04
TEX      1.03       0.93          SF       0.92       0.98
ARI      1.10       1.02          NYM      0.94       0.99
CIN      1.10       1.02          SEA      0.95       0.91
NYY      1.07       1.00          BAL      0.96       0.99
```

**Twenty-four of thirty differ, several by more than 0.10, in both
directions.** A 3-year regressed factor is a slow-moving aggregate; it
does not move that far in four months.

The commit diff makes it stranger. `4a2cff2` rewrote **all thirty**
values, and the ones it replaced were *closer* to today's FanGraphs:

```
            pre-4a2cff2    4a2cff2 (live today)    FG 2026 3yr
COL            1.16              1.25                 1.11
ATH            1.12              1.19                 1.12
CIN            1.06              1.10                 1.02
BAL            1.02              0.96                 0.99   <- sign flip
```

I could not find a transform that maps the old set to the new one — it is
not a uniform scaling, and `BAL` changes sign relative to neutral. **I am
not asserting where the live numbers came from.** What is established is
that the comment describing their origin does not reproduce them, and that
recording a source URL and pull date in April would have settled this in
one command instead of an afternoon.

## 3. The four manual adjustments, re-examined rather than carried forward

| | verdict | why |
|---|---|---|
| **ATH 1.19** | **keep** | FG `3yr` is 112 and still averages in Oakland Coliseum years; FG `1yr` is **121**, which is Sutter Health Park alone. 1.19 sits between the two — the original reasoning is confirmed by FanGraphs' own split. 49 of 64 ATH home games are at venue 2529. |
| **TB 0.95** | **keep, new uncertainty** | The premise came true: the Rays **are** back at Tropicana (56 home games at venue 12 this season). And FG `3yr` (101) now averages in the 2025 Steinbrenner season, so it is contaminated for two more years — the adjustment is **more** needed, not less. **Unresolved:** the park was rebuilt after Hurricane Milton (new roof, new turf), so "the pre-2025 Tropicana trend" may not describe the park that reopened. |
| **KC 1.02** | **drop the adjustment** | It existed because FG had not yet absorbed the 2024 fence move-in. FG 2026 `3yr` is now **102 = 1.02**, exactly the adjusted value. **The number does not change; it stops being a manual override.** |
| **Mexico City 1.20** | **keep, nearly inert** | `model.js:48`, venue 5340. It fired on **2 games** this season (2026-04-25/26) and bypasses the table entirely, so a refresh does not touch it. |

## 4. What adopting the fresh values would do

```
teams whose factor changes            : 24 of 30
home games affected                   : 1486 of 1861  (79.8%)
game-weighted mean |d(total)|         : 0.432 runs

largest movers
  COL -1.208    CHC -1.166    TEX -0.784    ARI -0.672    CIN -0.662
  CLE +0.613    PIT +0.576    SF  +0.495    NYM +0.414    MIN +0.326
```

**This is a sensitivity, not an error estimate.** Neither set has been
checked against 2026 outcomes. It is the distance between production and
the source production claims to use — the same footing as the 0.359-run
figure in the ticket, which was also a sensitivity.

## 5. The calibration A/B, and why it is the wrong instrument

Ran on the shared harness (`scripts/calibration-ab.js`, new park-factor
arm), clean corpus, 2026-06-01..2026-08-07, n=349:

```
  games where it changes p(home): 265 / 349 (75.9%)   mean |dp| = 0.00028

  arm       logLoss    Brier      ECE      AUC    edgeSlope
  OFF       0.69464   0.25069   0.0405   0.5352    -0.585
  ON        0.69469   0.25072   0.0370   0.5352    -0.592

  d logLoss +0.00005   95% CI [-0.00005, +0.00014]   NOT SIGNIFICANT
```

**Do not read that as "the change is harmless."** A park factor multiplies
*both* teams' run estimates by the same number, so it moves the **total**
and leaves the **ratio** nearly intact. Mean |Δp| of **0.00028** is an
order of magnitude below the framing flag's 0.0024, which was already
unresolvable at this n. The ML A/B measured almost nothing, by
construction.

### The totals target, which is what it actually moves

```
  arm        MAE      RMSE     mean(model - actual)
  OFF       3.4477   4.4699        -0.5752
  ON        3.4206   4.4281        -0.6402
  delta     -0.0270  -0.0419       -0.0650

  window sign test: ON better in 5 / 5 windows
  mean |d model_total| between arms: 0.3025 runs
```

The fresh values are **better on MAE and RMSE, in every window**. Two
cautions on that:

- **No n-matched control was run for this statistic.** Same-n controls for
  other features spanned 2–4 of 5; 5/5 is the strongest available reading
  of that test, but the reproducibility finding says a window count at
  n≈350 is not a precise quantity, and I have not measured the control
  distribution *for this metric*. Treat 5/5 as suggestive, not as a tier.
- **Level bias gets worse.** The model already under-predicts totals by
  **−0.575 runs**; the fresh values push that to **−0.640**. They sharpen
  dispersion and worsen the level. That under-prediction is its own
  finding and is not caused by park factors.

**No verdict changes tier**, on either target.

## 6. Not done, deliberately

- **`PARK_FACTORS` is unchanged.** The provenance mismatch in §2 is a
  decision, and adopting FanGraphs wholesale is a source change affecting
  80% of games — not the routine refresh the ticket anticipated.
- **The table + timestamp migration is not built.** It is the right
  structural fix and I will build it, but the values that go in it depend
  on §2.
- **Cadence not yet encoded.** For the record, the evidence says the
  *underlying numbers* barely move — FanGraphs' `3yr` is a regressed
  three-season aggregate. What moved by a third of a run in six days was
  two humans reading it, not the data. That argues for a **monthly**
  automated refresh with an expected lag of ~35 days, and it argues more
  strongly that the value should not be transcribed by hand at all.

## Related

- `docs/park-factors-stale-open-question-2026-08-24.md` — the ticket.
- `scripts/park-factor-refresh-report.js` — §3 and §4, re-runnable.
- `scripts/calibration-ab.js` — `PF_ON_JSON` arm added for §5.
- `4a2cff2` — the 2026-04-19 refresh whose provenance does not reproduce.
