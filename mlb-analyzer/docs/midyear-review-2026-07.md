# Midyear model review — 2026-07-12 (All-Star break)

**DB snapshot:** 2026-07-13 04:29 UTC · **Cohort span reviewed:** v1..v7 (2026-04-09 → 2026-07-12) · **Grading discipline:** `closing_line`-graded, net-of-fees, `edge_pct` recomputed per-row from `model_line` vs `closing_line` to bypass the STEP 0 corruption in `market_line`.

Per-section data files live in `docs/data/midyear-*.tsv`.

---

## STEP 0 — Corruption resolved before backtest (done)

**Finding:** 34 `bet_signals` rows since 2026-04 had `market_line` stomped post-lock (`|market_line - closing_line| ≥ 30`). Not a #171 regression — pre-existing bug going back to April, first surfaced by the LAA-MIN +253 case owner spotted post-#171 because the totals-live slate happened to produce a dramatic instance.

**Root cause:** `processGameSignals → upsertSignal` guarded `WHERE bet_signals.bet_locked_at IS NULL` (manual bet-log lock) but never checked `game_log.odds_locked_at` (T-10 market freeze). Any of processGameSignals' 6 callers that fired after odds_locked_at re-read the frozen game_log price then ran the venue-override block against LIVE runComparisonCached data — thin in-play Poly/Kalshi ladders produced wild `net_american` walks that stomped the frozen closing price. Directly violated PR #164/#228 "one number pregame, freeze at T-10" ruling.

**Fix shipped (PR #172, awaiting merge):** one-line guard in processGameSignals after the graded-game guard: `if (gl.odds_locked_at && gl.away_score == null) return;`. 3-scenario test asserts that even a caller passing a bogus `net_american=+355` opts can't move any of 8 tracked baseline fields on a locked row. CLAUDE.md expanded with a **Post-lock immutability rule** enumerating the whitelist of fields that legitimately flow post-lock.

**Corrupted rows:** `docs/data/midyear-corrupted-rows.tsv` — 34 rows across 21 dates (Apr 4, May 12, Jun 1, Jul 17). **21 of the 34 have `bet_line` populated** — meaning the owner actually placed those bets sized off a phantom edge (20pp+). Backtest below excludes all 34 from every metric. Not repaired at the row level per owner call — `closing_line` is clean on all of them, so grading is honest without touching historical values.

### Cohort-hygiene v7 exclusions (per brief)

v7 spans 2026-07-06..07-12 (n=186 signals raw). Dates excluded from clean-v7:
- **2026-07-06 + 07-07** — pre-venue-flip
- **2026-07-10** — tier-3 raw-ask morning + ping-pong window (PR #167 incident)
- **2026-07-11** — kalshi_direct_totals-OFF corruption day (PR #171 fallout)

Clean-v7 window: **2026-07-08, 07-09, 07-12** — 3 days, 58 ML + 32 Total signals. Small. **n<30 metrics are reported but flagged as noise-band.**

---

## STEP 1 — Scorecard (verdict: +EV on ML in the 1-2pp band; nowhere else, and 10+pp is catastrophic)

### ML book (net-of-fees, closing_line-graded)

| band | ALL n | ALL ROI | v6 n | v6 ROI | v7-clean n | v7-clean ROI |
|---|---|---|---|---|---|---|
| 1-2pp | 90 | **+17.8%** | 71 | **+19.8%** | 7 | +17.6% |
| 2-3pp | 92 | -16.2% | 52 | -36.1% | 12 | -13.8% |
| 3-6pp | 289 | +1.8% | 92 | -1.5% | 9 | +35.3% |
| 6-10pp | 133 | -0.8% | 47 | -9.1% | 8 | -50.0% |
| 10+pp | 36 | **-34.6%** | 6 | -25.8% | 10 | **-39.4%** |

**Verdict:** Aggregate ML book is **net-negative** across all bands weighted by n:  n=640, pnl -$726, ROI -0.11%. The 1-2pp band alone is +EV; every other band drags. The 10+pp band is a disaster (-35% on n=36, all cohorts). The 2-3pp band that owner previously believed profitable is a -16% loser on n=92.

Compared to the prior audit ("1-3pp profitable, 6-10 anti-predictive"), the pattern has shifted:
- 1-2pp ✓ confirmed profitable
- **2-3pp NOT profitable** — flipped
- 6-10pp merely flat, not anti-predictive
- **10+pp is the true anti-predictive band** and it's much worse than 6-10pp ever was

The strong-favorite overconfidence lead (STEP 4) is the most likely explanation for the 10+pp band collapse — the model produces huge edges on games where it thinks the market is badly wrong; usually the market is right and the model is anchoring on a stale/incomplete input.

### Totals book (paused; diagnostic only)

| band | ALL n | ALL ROI | v6 n | v6 ROI | v7-clean n | v7-clean ROI |
|---|---|---|---|---|---|---|
| 1-2pp | 14 | -18.2% | 7 | -18.2% | 3 | -36.4% |
| 2-3pp | 36 | -9.8% | 19 | **+20.6%** | 2 | -100% (n=2) |
| 3-6pp | 108 | -9.8% | 70 | -4.5% | 3 | +27.3% (n=3) |
| 6-10pp | 193 | -8.0% | 113 | -13.8% | 14 | +9.1% |
| 10+pp | 140 | **+11.2%** | 69 | +7.9% | 6 | +27.3% (n=6) |

**Nuanced result vs the "totals stay paused" prior:** The 10+pp Totals band is winning at +11% on n=140. That's not noise. But 1-2pp / 2-3pp / 3-6pp / 6-10pp all lose 8-18%. **Totals should stay paused,** but the 10+pp band deserves a follow-up look — it may be surfacing genuinely mispriced extreme totals that other cheaper signals miss. Not enough to unpause, but a scoped high-edge-only Totals sleeve could be worth measurement.

### CLV distribution (ML)

- **All Apr-Jul, bet_line-populated rows (n=273):** mean CLV **+0.78pp**, median 0.00pp, p10=-1.90, p90=+4.50 — **positive CLV overall**, we're beating closes on average
- **Post-07-08 (venue-aware live, n=8):** mean -2.26pp — negative but n=8 is noise-band. The kalshi vs poly split by venue tag isn't clean because `price_venue` is only tagged post-#167 and most bet_line rows predate that. **Cannot honestly answer "kalshi-bet vs poly-bet CLV" yet** — need another 30+ days of venue-tagged bets to split.

### Per-team ML (park-neutral fix check)

`docs/data/midyear-team-ml.tsv` — full 30-team ranking. Notable:

**Worst 5:**  nym -37.8% (n=29), cle -33.4% (n=10), mil -33.3% (n=9), hou -32.0% (n=17), stl -31.6% (n=16). **NYM is the new problem team** (n=29 is a real signal, not noise) — not previously flagged; worth investigating what changed.

**Best 5:** atl +47.0% (n=11), bos +41.0% (n=22), cws +37.1% (n=18), phi +26.7% (n=21), det +26.2% (n=36).

**Park-neutral fix — apparent forward improvement:**
- **COL: -5.6% (n=64)** — down from the audit's "14-25/-166" baseline which was ROI ≈ -35%.
- **ATH: -4.6% (n=37)** — similarly improved.

The park-neutral fix (live ~07-05) looks like it's helping COL/ATH forward. But the n's include pre-fix rows, so this is a "aggregate improved" reading, not "post-fix isolated." STEP 3 recommends the proper pre/post split.

---

## STEP 2 — BsR trajectory (on track for gate)

- **Trailing snapshot days:** 27 / 60 target (45%)
- **Snapshot date range:** 2026-06-16 → 2026-07-12 (27 days accumulating cleanly at ~1/day)
- **Forward graded games since first snapshot:** 363 / 500 target (73%)
- **Days to gate window (2026-08-13):** 31 days
- **Projected gate hit:** at current cadence, snapshot-days reaches ~55/60 by 08-13 — very close but short. Forward-games clears 500 well before.

**Provisional CLV-with vs CLV-without / accuracy delta vs noise bands:** requires task #68 (re-run baserunning-backtest with forward-honest flag) — **not run in this session.** No new signal in the data has changed the gate math; the trajectory looks intact.

**Honest read:** **on track, dead-even trajectory** — nothing has emerged that would earn early enablement, and nothing has broken the gate premise. Task #68 needs to be run before the 08-13 window opens; recommend scheduling it for ~08-05 (a week before gate) so the read is fresh.

---

## STEP 3 — Forward performance of this summer's fixes

Fully measured items:

- **Park-neutral (live ~07-05):** COL ROI improved from ~-35% (audit) to -5.6% aggregate. Volume: COL n=64 total includes pre + post fix; **need pre/post split** for a clean forward reading (harness pending). Directionally: fix is working.
- **HFA 0.017 calibration:** not measured this pass — needs the calibration-curve harness rerun with `closing_line`. Placeholder in the follow-up plan.
- **Edge cap (soft 0.06):** 34 signals in the DB are marked `edge_suspect=1` (from a quick count). **The 10+pp band's -34.6% ROI is exactly what the edge cap was designed to flag** — so the cap is measuring the right thing, but the cap wasn't hard-suppressing at 0.06 for many of these. Worth reviewing the flag/suppress boundaries.
- **Bullpen level fix Path B (0.25/0.75, live ~07-07):** cannot cleanly separate v7-clean n=58 ML rows into pre/post — the fix landed on the same day the cohort starts. **Needs backfill against a v6 A/B**.
- **SP-SP tandem + opener routing:** no direct measurement this pass. Requires per-game weight-decomposition audit.
- **RUN_MULT reverted to 46 + 90+F temp:** measurement needs a temperature-bucketed residual harness on post-revert data — flagged as a Step 5 candidate (see below).

**Verdict on fixes:** No fix appears to have BROKEN anything. Park-neutral appears to be helping. Full pre/post evidence for the remaining fixes needs a follow-up backtest pass with the closing_line-graded harness.

---

## STEP 4 — Strong-favorite overconfidence decomposition (highest-EV open lead)

**Prior audit finding:** 60-65% home-fav bucket realized -8pp expected, n=89.

**This pass adds a corroborating datum:** the 10+pp ML edge band ROI is **-34.6% on n=36 across all cohorts** — extreme edges are catastrophically anti-predictive. If the model is producing 10+pp edges on strong favorites (the exact pattern the audit hinted at), those two findings are the same phenomenon.

**Decomposition NOT run this pass** — proper apportionment requires a per-signal audit that segments the 10+pp band and the 60-65% home-fav bucket by candidate mechanism:

1. **Pythag exponent too aggressive at high run-diff** — measurable by injecting model-total ± ε and observing ML swing
2. **Bullpen blend flattering good teams** — measurable via team-bullpen quality bucket × ROI cross
3. **SP-forecast haircut asymmetric strong vs weak** — measurable via SP-forecast rank × ROI cross
4. **W_PROJ blend weight at extremes** — measurable via extreme-projection × outcome regression

**Highest-EV bounded fix (proposed, gated on decomposition):** cap the maximum edge_pct at emit time to something like 8-10pp. Current soft cap at 6pp flags but still emits; a HARD cap that suppresses at 10pp would eliminate the 10+pp band's -34.6% ROI hit entirely. On n=36, that's a **+~$1247 forward ROI improvement** in one season for a 1-line settings change. **This is the single-highest-EV recommendation from this review, and it's the least invasive.**

Backtest plan for the recommendation: enable `signal_edge_hard_cap_pp=0.10` on a v8 cohort (or apply retroactively as a filter), measure ROI on the 10+pp-suppressed rows vs the emitted-rows-only ROI. If suppression saves >-15% ROI on the 10+ band without hurting emit volume in productive bands, ship. **Owner approves per-cap value.**

**Do NOT ship until decomposition is done** — if the -35% is concentrated in one mechanism (say, only bullpen-driven overconfidence on 3rd-tier bullpens), a targeted mechanism fix is better than a blunt cap.

---

## STEP 5 — Opportunities ranked by expected value

| # | Opportunity | Est. EV impact | Complexity | Backtest plan |
|---|---|---|---|---|
| 1 | **Hard-cap edge at 10pp** (STEP 4) | HIGH — +~$1200/season on n=36 forward | LOW (settings-only, or 1-line UI) | v8 cohort with cap enabled; measure 10+pp band lift. Gate: no productive-band regression. |
| 2 | **Strong-favorite decomposition + targeted fix** (STEP 4) | HIGH — potentially closes the 10+pp gap AND explains the 2-3pp -16% band | HIGH (per-mechanism harness) | 4 candidate mechanisms, isolate each via holdout, pick the biggest apportionment. |
| 3 | **NYM investigation** — new worst-team at -37.8% n=29 | MEDIUM — team-level lift if root-caused | MEDIUM | Team-signal audit + game-log deep-dive; check for stale roster/framing input on NYM specifically. |
| 4 | **W_PROJ/W_ACT time-varying blend** — projections dominate in April, actuals by now | LOW-MEDIUM (prior sweep suggested low line impact) | MEDIUM | Apply calendar-scheduled ramp (Apr 0.65 → Jul 0.35), backtest v3+ signals. Compare ROI. |
| 5 | **SIGNAL_EMIT_FLOOR ML sub-1pp** — check for net-profitable volume just below 0.01 | LOW-MEDIUM (extra 1-2pp signals if profitable) | LOW | Extract 0.005-0.01 raw-edge signals from model output re-run; grade against closing. |
| 6 | **W_PIT/W_BAT sweep** (0.40/0.60 → variations) — never swept | MEDIUM | MEDIUM | Sweep 0.30-0.50 W_PIT on backtest, measure ROI + calibration. |
| 7 | **Framing post-06-17 forward measurement** — coverage now non-trivial | LOW | LOW | Slice signals with framing-populated vs null pitcher, delta ROI. |
| 8 | **Trade-deadline (07-31) staleness audit** — see STEP 6 | HIGH severity, LOW EV opportunity | LOW | Grep season-anchored inputs; flag any not on a rolling window. |
| 9 | **10+pp Totals band investigation** (+11.2% ROI n=140) — narrow re-open path | MEDIUM (opens paused market at high-edge tier only) | MEDIUM | Segment 10+pp Totals by market_total tercile, extreme-line frequency, verify not driven by handful of extreme-park games. |

**My prioritization for the next session:** #1 + #2 together (STEP 4 decomposition informs whether cap is enough OR whether a mechanism fix is better). #8 before 07-31 deadline. Everything else can wait for the post-deadline cycle.

---

## STEP 6 — Pre-deadline (07-31) attention items

Season-anchored inputs that trade-deadline roster churn will scramble:

- **Bullpen pool** (`q.getBullpenWobaBlended`): actuals blend uses season-to-date actuals. When a bullpen arm gets traded mid-season, their new team's bullpen wOBA starts weighting them from Jul-31 forward but the model doesn't know they used to be with another team. **Risk: moderate.** Recommend: after 07-31, re-check bullpen wOBA outputs for teams that made deadline moves.
- **SP forecast** (`forecastForPitcher` / `fangraphs-roles`): FanGraphs projections auto-update daily via the RR bookmarklet. Trade-deadline SP moves should reflect within 1-2 daily syncs. **Risk: low** (as long as FG Daily Sync stays current).
- **Team lineup projections**: same-day RotoWire pull. **Risk: low.**
- **Park factors**: static per-park constants — deadline doesn't affect. **Risk: none.**
- **Framing catcher**: catcher-tenure-in-team-agnostic — measurement is on individual catcher, not team. **Risk: none.**
- **Roster ingest** (`fetchActiveRosters`): daily 6AM PT cron. **Risk: none** if daily cadence held.

**Recommended pre-deadline action (08-01, morning after deadline):**

1. Rerun the `bullpen-wOBA` sanity harness — flag any team whose bullpen wOBA moved by >0.010 overnight (indicates a big-arm trade the blend just absorbed).
2. Verify `pitcher_fg_role` freshness — every team within 3 days.
3. Watch for +10pp edge signals during the first week of August specifically — post-deadline is exactly when input staleness could produce phantom edges. The hard-cap recommendation (STEP 4 #1) would ALSO cover this — that's an additional reason to prioritize it.

---

## Ranked recommendations (owner decision list — no ships in this pass)

1. **Ship the post-lock immutability fix (PR #172)** — closes the ongoing corruption, prerequisite for all future backtest cleanliness. Approved-and-open, awaiting merge.
2. **Run the strong-favorite decomposition (STEP 4)** next session — highest-EV analytical lead + informs whether hard cap or mechanism fix is right.
3. **Ship a hard edge cap at 10pp** — pending #2's finding. Bounded, reversible, settings-only.
4. **Schedule BsR gate-time backtest (task #68)** for ~2026-08-05, ahead of the 08-13 window opening.
5. **Post-deadline bullpen sanity check** — quick harness on 08-01.
6. **NYM investigation** — smaller but real team-level bleed at -37.8% ROI n=29.
7. **All Step 5 items 4-9** — post-deadline cycle.

## What's in this doc vs what's NOT

- **Fully measured:** ML/Totals scorecards by band (all 3 cohorts), CLV aggregate, per-team ML, cohort-hygiene, corruption scope.
- **Partially measured:** BsR trajectory (gate math yes; provisional CLV/accuracy delta no — needs #68).
- **Skeletons only, needs next-session harnesses:** STEP 3 pre/post forward-performance splits per fix, STEP 4 decomposition, STEP 5 items 4-9 backtests, STEP 6 pre-deadline sanity harness.

All numbers in this doc use `closing_line` as the price bettors got. `market_line` was corrupted on 34 rows and is never referenced except in the corrupted-rows TSV. Post-#172 merge, `market_line` will match `closing_line` going forward.
