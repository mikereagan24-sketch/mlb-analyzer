# W_PROJ/W_ACT sweep on the snapshot corpus — 2026-08-21

> **Measurement pass only. NO parameter changes shipped.**
> Result: nothing distinguishable. Production `w_proj=0.45 / w_act=0.55`
> stays exactly where it is.

## TL;DR

- **The Phase-3 look-ahead block is resolved** for 2026-06-01 onward.
  Per-date `woba_data_snapshot` exists and is **verified as-of-morning**
  (§2), and `services/parameter-sweep.js` already binds each game to its
  own game-date snapshot. The 2026-07-14 exclusion was correct *for the
  harness it was written about* and is now obsolete for this one.
- **Pre-flight predicted a null before the sweep ran** (§3): the full
  0.1→0.9 range moves team wOBA by a median of 0.0039 = **0.18 runs**,
  which is *smaller than the median weather adjustment* (0.300 runs) that
  the 2026-08-19 pooled fit already showed is undetectable at these
  sample sizes.
- **The sweep confirms it** (§4). Across 9 non-baseline candidates:
  **0 of 9** bootstrap CIs exclude zero, **0 of 9** hold one sign across
  five folds, 2 of 9 pass Val:Fit but fail both other gates.
  **Nothing clears all three.**
- **Found en route:** `blendWoba` silently ignores a zero weight, and the
  settings schema permits the value that triggers it. Filed separately —
  `docs/blendwoba-zero-weight-open-question-2026-08-21.md`.
- **Recommendation:** stop here on W_PROJ/W_ACT. Proceed to the wind
  deadband cliff on mechanism grounds, per
  `docs/wind-deadband-cliff-open-question-2026-08-19.md`.

## 1. Why this was blocked, and why it no longer is

The 2026-07-14 pass excluded `W_PROJ / W_ACT` because
`scripts/sweep-look-ahead-safe-weights.js:88` calls
`jobs.getWobaIndex()` — today's **season-cumulative** `woba_data`. W_ACT
is the weight *on* that contaminated quantity, so different candidates
weight the contamination differently and it does not cancel the way it
does for a post-WP transform like `pyth_exp`. That reasoning was and
remains correct for that script.

Since then, `woba_data_snapshot` accumulated **76 per-date snapshots,
2026-05-20 → 2026-08-07** (~31k rows each, 2.2M total), and
`services/parameter-sweep.js` was made snapshot-aware: it loads the
snapshot for each game's own date and **skips** games with no snapshot
rather than falling back to current `woba_data`. `W_PROJ_W_ACT` is
already a wired sweep parameter there.

Snapshot gaps: 2026-06-26, 07-14, 07-15, 07-19 (32 games dropped).

## 2. Verifying the snapshots are as-of-morning

`snapshot_date` is stamped from the PT calendar date **at ingest time**
(`routes/api.js:512`), so whether it is look-ahead-safe depends entirely
on *when the ingest runs* — a snapshot written after the evening slate
would carry same-day results and reintroduce exactly the leak this is
meant to remove. Upload timestamps alone don't settle it (timezone
ambiguity), so this was tested directly.

**Method:** match players across consecutive snapshot dates, sum the
positive `sample_size` deltas (matching removes roster churn, which
makes raw totals useless — they go *negative* on many days), then
correlate that daily PA growth against league game counts on D-1 vs D.

| | correlation with matched ΔPA |
|---|---|
| games on **D-1** | **+0.474** |
| games on **D** | −0.194 |

The discriminating low-game days are unambiguous:

| date | games D-1 | games D | matched ΔPA |
|---|---|---|---|
| 2026-05-28 | 15 | 6 | **789** |
| 2026-05-29 | 6 | 15 | 321 |
| 2026-07-23 | 17 | 5 | **473** |
| 2026-07-24 | 5 | 15 | 135 |
| 2026-07-17 | 1 | 15 | 49 |

PA growth tracks the **prior** day's slate every time. **Snapshot D
contains games through D-1 only.** No same-day leak.

Window restricted to **≥ 2026-06-01** regardless: rows from 05-20..05-27
are ET-tagged and later rows PT-tagged (cutover noted at
`routes/api.js:505`), so the earlier week has a ~2h boundary shift.

## 3. Pre-flight — the effect size, before spending the sweep

`tmp/preflight-wproj-wact-leverage.js`, 827 games, per-date snapshots.

The lever does reach most players — **70.4% of 14,652 lineup slots reach
`source='blend'`** (the rest have no actuals row clearing `MIN_PA=60`,
where W_PROJ/W_ACT is a no-op). But the effect does not survive
aggregation:

| | median | p90 | max |
|---|---|---|---|
| per-slot wOBA move, W_PROJ 0.1→0.9 | 0.0116 | 0.0332 | 0.1352 |
| **team-level** wOBA move, same range | **0.0039** | 0.0109 | 0.0285 |
| team-level, in runs (RUN_MULT=46) | **0.18** | 0.50 | 1.31 |

**Mechanism.** Across 589 batters with ≥60 PA of actuals matched to a
projection, `(actual − projected)` wOBA has **mean −0.0052** and mean
absolute value 0.0198, with 40% above zero. W_PROJ is therefore a
near-mean-preserving **reallocation**: individual batters move ~0.02
wOBA, but a 9-slot lineup averages most of that away. What survives at
team level is essentially just the −0.005 mean bias — and
0.8 × 0.0052 ≈ 0.0042 matches the measured team median of 0.0039.

For calibration: the median league-wide weather adjustment is **0.300
runs**, and `docs/wind-deadband-cliff-open-question-2026-08-19.md`
records that the aggregate wind response is not distinguishable from
zero at current sample sizes. W_PROJ's *entire range* moves less than
that.

## 4. The sweep

`tmp/sweep-wproj-wact-disciplined.js`. Reuses the engine's own corpus
builder (`loadGames` / `loadWobaSnapshot` / `preScreenGame`) and scorer
(`scoreGames`) rather than reimplementing either. Each grid value is
scored **once** into a signal table carrying `game_date`; folds and
bootstrap replicates are pure resamples of those tables, so they are
exact rather than re-simulated. Deterministic LCG seed — the bootstrap
section reproduced byte-identically across two runs.

**Corpus:** 814 scoreable games, 63 dates, 2026-06-01 → 2026-08-07
(859 loaded, 32 no-snapshot, 13 suppressed).

### 4.1 Headline

| W_PROJ | nSig | ROI% | ML ROI% | TOT ROI% |
|---|---|---|---|---|
| 0.10 | 775 | −4.97 | −9.02 | −0.99 |
| 0.20 | 758 | −5.18 | −9.32 | −1.22 |
| 0.30 | 755 | −6.41 | −10.54 | −2.67 |
| 0.40 | 749 | −5.72 | −10.34 | −1.66 |
| **0.45** | **742** | **−6.06** | **−10.61** | **−2.07** |
| 0.50 | 736 | −4.89 | −8.13 | −2.10 |
| 0.60 | 733 | −4.50 | −6.28 | −3.04 |
| 0.70 | 739 | −4.85 | −6.39 | −3.61 |
| 0.80 | 741 | −4.84 | −7.16 | −3.02 |
| 0.90 | 748 | −5.90 | −9.02 | −3.45 |

Whole-range spread is ~1.9pp of ROI with no monotone shape and the
production value sitting at the *worst* point — which is itself a tell
that the ordering is noise, not a curve.

**Methodological caveat:** the signal count varies with W_PROJ
(775 → 733 → 748). Higher projection weight gives more regressed inputs,
smaller edges, and fewer signals clearing the 1pp emit floor. So grid
values are **not** compared on an identical bet set — this is
strategy-vs-strategy, not the same wagers repriced.

### 4.2 Rolling folds — 5 contiguous date blocks, dROI vs baseline

| W_PROJ | F1 | F2 | F3 | F4 | F5 | all same sign |
|---|---|---|---|---|---|---|
| 0.10 | +0.05 | +0.08 | +4.22 | +0.22 | −0.34 | no |
| 0.20 | +0.74 | −1.17 | +2.25 | +0.43 | +1.58 | no |
| 0.30 | −2.75 | −1.82 | +1.09 | −1.88 | +2.84 | no |
| 0.40 | −0.52 | −0.42 | +2.21 | −2.65 | +2.60 | no |
| 0.50 | −0.65 | +1.48 | −0.22 | +7.08 | −1.86 | no |
| 0.60 | −1.21 | +3.00 | −1.58 | +11.21 | −3.86 | no |
| 0.70 | +2.17 | +2.94 | −7.17 | +12.14 | −4.17 | no |
| 0.80 | +3.39 | +5.29 | −6.35 | +8.82 | −4.50 | no |
| 0.90 | −0.46 | +6.44 | −10.62 | +9.80 | −3.33 | no |

**0 of 9 hold a sign.** Note fold F4 is positive for every candidate and
F5 negative for most — the folds are picking up *time*, not the
parameter.

### 4.3 Date-clustered bootstrap (B=2000)

Dates resampled with replacement, not signals: signals on one slate
share lineups, weather and market state, so signal-level resampling
would understate the interval.

| W_PROJ | dROI% | 95% CI | excludes 0? |
|---|---|---|---|
| 0.10 | +1.09 | [−3.48, +4.63] | no |
| 0.20 | +0.88 | [−3.10, +4.08] | no |
| 0.30 | −0.35 | [−3.45, +2.30] | no |
| 0.40 | +0.34 | [−1.23, +2.07] | no |
| 0.50 | +1.17 | [−0.61, +3.29] | no |
| 0.60 | +1.56 | [−1.29, +4.21] | no |
| 0.70 | +1.21 | [−2.83, +4.84] | no |
| 0.80 | +1.22 | [−3.39, +5.54] | no |
| 0.90 | +0.16 | [−5.26, +4.57] | no |

**0 of 9 exclude zero.** Point estimates are ~1pp against CI half-widths
of 3–5pp — the corpus is underpowered for effects of this size by
roughly 3–5×. Closing that needs ~16× the data (CI width scales as
1/√n): on the order of **13,000 games, or eight seasons** of snapshot
coverage. Not reachable by accumulation.

### 4.4 Val:Fit (fit ≤ 2026-07-18)

| W_PROJ | Fit dROI% | Val dROI% | Val:Fit | same sign | passes |
|---|---|---|---|---|---|
| 0.10 | +2.27 | −1.89 | 0.83 | NO | no |
| 0.20 | +1.24 | −0.10 | 0.08 | NO | no |
| 0.30 | −0.66 | +0.47 | 0.71 | NO | no |
| 0.40 | +0.01 | +1.20 | 97.86 | yes | no |
| 0.50 | +0.97 | +1.65 | 1.71 | yes | no |
| **0.60** | +1.68 | +1.21 | 0.72 | yes | **yes** |
| **0.70** | +1.40 | +0.65 | 0.46 | yes | **yes** |
| 0.80 | +2.31 | −1.71 | 0.74 | NO | no |
| 0.90 | −0.30 | +1.33 | 4.47 | NO | no |

0.60 and 0.70 pass — and both have bootstrap CIs spanning zero by a wide
margin and two sign flips across folds. This is the single-gate pass
that looks like a finding and isn't; the 2026-07-14 pass flagged the
same shape for PA_WEIGHTS ("Val movement without fit signal — noise
catch"). W_PROJ=0.40's ratio of 97.86 is a divide-by-near-zero artifact
(Fit dROI = +0.01), not a signal.

### 4.5 Per-band

By category:

| W_PROJ | favs | dogs | overs | unders |
|---|---|---|---|---|
| 0.50 | +3.00 | +1.94 | −2.37 | +1.10 |
| 0.60 | +4.82 | +3.70 | −6.10 | +1.60 |
| **0.70** | **+11.41** | −1.47 | −5.15 | +0.67 |
| 0.80 | +9.33 | −1.00 | −5.89 | +2.27 |
| 0.90 | +7.83 | −3.10 | −3.30 | +0.83 |

By edge band:

| W_PROJ | 1-2pp (163) | 2-3pp (160) | 3-5pp (221) | 5pp+ (198) |
|---|---|---|---|---|
| 0.20 | −14.92 | **+21.09** | −7.03 | +5.54 |
| 0.30 | −12.35 | +16.07 | −5.00 | +1.19 |
| 0.70 | −9.04 | +6.61 | −5.11 | +11.93 |
| 0.80 | −19.09 | +14.45 | −2.62 | +12.30 |
| 0.90 | −19.19 | +9.10 | −1.59 | +11.63 |

The `favs +11.41` cell and the `2-3pp +21.09` cell are the numbers most
likely to be over-read. Both sit in cells of n≈160–200 where signs
alternate between adjacent bands within the same row — the signature of
noise, not of a mechanism that would have to act coherently across
neighbouring edge bands. Neither candidate clears any other gate.

**Banding correction:** the first run of this harness banded `signal.edge`
as if it were already in percentage points. It is a **fraction**
(`services/model.js:1364`; `SIGNAL_EMIT_FLOOR_PP` defaults to `0.01` =
1pp), so all 742 signals collapsed into one bucket. Fixed (×100) and
re-run; §4.5 is the corrected output. Every other section was unaffected
and reproduced identically.

## 5. Verdict

**Nothing clears all three gates. No candidate is recommended.**

| gate | passing candidates |
|---|---|
| bootstrap CI excludes 0 | **0 / 9** |
| all folds same sign | **0 / 9** |
| Val:Fit ≤ 1.5× | 2 / 9 |
| **all three** | **0 / 9** |

The pre-flight said this would happen and gave the reason: W_PROJ is a
per-batter reallocation that a 9-slot lineup averages away, leaving a
whole-range team effect (0.18 runs) below a signal the model already
cannot resolve. The sweep is the confirmation, not the discovery.

This is a *clean* null, not an inconclusive one — the blocker was
genuinely removed, the corpus is real, and the measurement was run at
full discipline. W_PROJ/W_ACT should now move from "Phase-3-blocked,
pending" to **"measured, no distinguishable effect"** in the weight
inventory.

## 6. What this does NOT establish

- **Not** that 0.45 is optimal — only that no other value on the grid is
  distinguishable from it on this corpus.
- **Not** anything about `BULLPEN_W_PROJ / BULLPEN_W_ACT`. That pair is
  still unmeasured. It routes through a *different* blend
  (`db/schema.js:3294`) with a different actuals gate (`minBF=100`) and a
  much smaller player set, so nothing here transfers.
- **Not** a totals-specific read. TOT ROI is reported but the corpus was
  not built for a totals-first evaluation.

## 7. Recommendation

Skip to the wind deadband cliff on mechanism grounds, as pre-authorised.
That question at least has a defensible-by-construction fix (continuity
at 8 mph) that does not depend on resolving an effect the data cannot
resolve.

Optionally take the one-line `blendWoba` fix on its own `fix/` branch —
it is unrelated to this null, but it is a live footgun the schema
permits and it blocks the most informative endpoint of any future blend
work.

## Artifacts

- `tmp/preflight-wproj-wact-leverage.js` — slot coverage + leverage bound.
- `tmp/sweep-wproj-wact-disciplined.js` — the sweep, folds, bootstrap,
  Val:Fit, bands. Dumps its scored signal tables so any re-analysis
  needs no re-scoring (~20 min).
- `services/parameter-sweep.js` — additive only: `game_date` + `wagered`
  on the signal record, and three internal builders exported.

## Related

- `docs/weight-sensitivity-sweep-2026-07.md` — the pass that blocked this.
- `docs/blendwoba-zero-weight-open-question-2026-08-21.md`
- `docs/wind-deadband-cliff-open-question-2026-08-19.md` — where to go next.
