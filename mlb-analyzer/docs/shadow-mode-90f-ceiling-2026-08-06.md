# Shadow-mode data collection — 90°F+ temp ceiling extension

## The open question

The current step-function temp adjustment
(`services/jobs.js:3118`) caps at `+0.6` for `temp ≥ 80°F` — an
81° game and a 98° game get identical treatment.

Phase C1 distributional analysis (2026-08-06) found that the
90°F+ bucket had:
- median residual = **+1.05 runs** (currently delivered: +0.6)
- 95% CI on the mean = (+0.52, +2.83) — excludes zero but wide
- **n = 55 rows** — small

This is the ONE residual pattern that survived the mean → median
distributional cross-check (see
`retraction-c1-mean-bias-findings-2026-08-06.md`). Every other
"under-forecast" signal from the earlier mean-based pass was tail
skew. So the 90°F+ ceiling question is the only live temp-curve
question worth carrying forward.

## Why not act now

- **n=55 is too small** given the wide CI. A single scorching-hot
  slate can shift the point estimate materially.
- The proposed change (add a +0.3 step at 90°F+, keeping +0.6 at
  80-89°F, so 90°+ gets +0.9 total) would flip Under signals to
  Overs in a temperature band where Overs currently perform WORSE
  than Unders (in the 90°+ signal window: Over −45% ROI n=3, Under
  −15% ROI n=31 — small samples both ways but Overs are worse
  everywhere in this window).
- If we commit early on wrong-direction evidence, we damage the
  working Under-lean.

## Shadow-mode plan

**No code change needed for the shadow-mode itself** — the current
model writes `temp_f`, `temp_run_adj`, and `model_total`. The
distributional analysis (`tmp/temp-attribution-c1-distributional-2026-08-06.js`)
can be re-run at any point with the additional hot-weather rows the
season accumulates.

**Revisit date target:** 2026-08-27 (three weeks from 2026-08-06)
OR when the 90°F+ clean-row count reaches n≥100. Whichever comes
first.

**Decision rule for the flip:**
1. Rerun `tmp/temp-attribution-c1-distributional-2026-08-06.js`
   against the latest prod DB.
2. Filter to 90°F+ bucket.
3. Report on:
   - median residual (require ≥ +0.5 to justify any change)
   - 95% CI on the median (require the CI's lower bound > 0)
   - sign-split (require > 55% under-forecast at 90°F+)
   - blowout-excluded median at 90°F+ (require ≥ +0.3)
4. If all four hold at n≥100, propose the +0.3 ceiling extension
   as a settings flag (`temp_curve_90plus_ceiling_enabled`),
   default off, byte-identical when off. Ship dark for another 2
   weeks of shadow, then flip.

**If the median collapses toward zero as n grows**, the 90°F+
finding was also tail skew (55 rows is small enough that a couple
of blowouts pulled the median). Close the question and stop
tracking.

## What we're NOT doing

- **No live "shadow prediction" column.** The alternative predicted
  adjustment is trivially computed from `temp_f` at analysis time
  (`Math.max(0.6, 0.9 if temp >= 90 else 0.6)`); no need to persist
  it to game_log.
- **No settings flag yet.** The flag proposal is contingent on the
  decision rule above passing.
- **No Continuous-form replacement.** The earlier
  continuous-vs-step CV win (~1.2% MSE) was intercept-driven; the
  medians show no meaningful temp slope from 55°F through 89°F. If
  90°+ needs adjustment, a specific ceiling extension is the right
  scope, not a wholesale continuous replacement.

## Owner

Reopens with whoever picks up temp-curve work after the revisit
date. If nobody picks it up and no operator has flagged a hot-slate
weirdness, the question can sunset — a small under-forecast at
90°+ is bounded and the working Under-lean is more valuable than
the marginal calibration gain.
