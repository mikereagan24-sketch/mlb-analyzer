# Polymarket top traders — backtest results (2026-09-30)

**Display only. Never a model input, a signal or a bet** (pre-registration §8).

**Verdict: no edge.** Neither pre-registered test is significant after
correction: q = 0.386 for both, against a threshold of q < 0.10. No holdout
label applies.

On the games where qualified top traders leaned one side pre-game, the lean
side won slightly more often than its no-vig price implied in April–August
(about 1 point). That difference is well within chance. In September it
reversed. Betting the lean at the actual locked price, which includes the vig,
lost money in both periods.

## What was tested

This is exactly the pre-registration `docs/polymarket-top-traders-prereg-2026-09-30.md`:
- commit `f23d86f`, merged in #489;
- content sha256 `1d67059c…`, pinned in code and checked at run time;
- run from main `b686e59`.

A game's **lean** is the team the qualified wallets put more net pre-game
dollars on. Qualification is as of the day before the game:
- 40+ games;
- profit > 0;
- volume no more than 50× profit;
- bought both teams in under 20% of their games;
- the game needs at least 25 qualified wallets.

The **primary** test uses all qualified wallets; the **secondary** test uses
the top 25 by profit.

Each test compares lean-side wins (Polymarket's resolution) with the sum of the
lean side's no-vig implied probabilities at the trends test's locked price. It
is two-sided, with Benjamini–Hochberg across the 2 tests.

**Gate 1.** Before any resolution was read, all 27 outcome-blind counts
reproduced the pre-registration's §2, §5 and §10 exactly.

**Full numbers:** `docs/polymarket-top-traders-results-2026-09-30.json`.

## Results

Win % is shown with its 95% Wilson interval. Edge = win % − implied %, in
points. ROI is on a flat $100 at the locked price, with a 95% bootstrap
interval (10,000 resamples, seed 20260930).

**Main tests**

| test | split | n | W–L | win % | implied % | edge | p | BH q | ROI [95%] | $ won |
|---|---|---|---|---|---|---|---|---|---|---|
| primary | Apr–Aug | 1,360 | 721–639 | 53.0 [50.4, 55.7] | 51.9 | +1.2 | 0.386 | 0.386 | −1.8% [−6.9, +3.3] | −2,464 |
| primary | Sept | 265 | 133–132 | 50.2 [44.2, 56.2] | 51.3 | −1.1 | 0.721 | — | −8.9% [−20.1, +2.1] | −2,370 |
| secondary | Apr–Aug | 1,278 | 674–604 | 52.7 [50.0, 55.5] | 51.5 | +1.2 | 0.377 | 0.386 | −1.7% [−6.8, +3.7] | −2,163 |
| secondary | Sept | 199 | 100–99 | 50.3 [43.4, 57.1] | 51.2 | −1.0 | 0.776 | — | −8.1% [−21.5, +5.0] | −1,619 |

**Sensitivity: the confirmed set** (#488). This run is outside BH and cannot
make a test significant. Its q is shown for display only.

| test | split | n | W–L | win % | implied % | edge | p | q (display) | ROI [95%] | $ won |
|---|---|---|---|---|---|---|---|---|---|---|
| primary | Apr–Aug | 946 | 510–436 | 53.9 [50.7, 57.1] | 51.9 | +2.0 | 0.212 | 0.212 | −0.1% [−6.2, +6.0] | −88 |
| primary | Sept | 257 | 130–127 | 50.6 [44.5, 56.6] | 51.4 | −0.8 | 0.797 | — | −8.5% [−19.9, +2.9] | −2,182 |
| secondary | Apr–Aug | 866 | 465–401 | 53.7 [50.4, 57.0] | 51.4 | +2.2 | 0.181 | 0.212 | +0.4% [−6.1, +6.8] | +346 |
| secondary | Sept | 194 | 99–95 | 51.0 [44.0, 58.0] | 51.4 | −0.3 | 0.925 | — | −6.8% [−20.0, +6.6] | −1,320 |

**Sources with no recorded price source excluded** (§5 sensitivity):

| | in-sample p (n) | in-sample ROI | Sept ROI |
|---|---|---|---|
| main primary | 0.307 (1,160) | −1.1% | −8.9% |
| main secondary | 0.287 (1,086) | −0.9% | −8.1% |
| confirmed primary | 0.118 (861) | +1.2% | −8.5% |
| confirmed secondary | 0.066 (789) | +2.4% | −6.8% |

None of these are corrected or significance-bearing. The 0.066 is a
sensitivity cut of a sensitivity run; under §6 it is reported and nothing
more.

**Source mix of the tested primary games:**
- Apr–Aug: Kalshi 613, Polymarket 540, unrecorded 200, prophet-exchange 6, novig 1;
- Sept: Kalshi 207, Polymarket 58.

## Plain-language reading

- **Leans and win rate.** Top traders' leans won about 1 point more often than
  the no-vig price implied in April–August, and about 1 point less often in
  September. Neither is distinguishable from no edge.
- **Leans and money.** At the price actually available, which includes the
  vig, following the lean lost about 2% in April–August and about 8–9% in
  September.
- **The cleaner subset.** Restricting to games whose locked price is confirmed
  pre-game nudges the in-sample edge up to about +2 points. It is still not
  significant, and September is still negative.
- **For the card.** The card can show what top traders are on as information.
  This backtest gives no basis for calling it predictive.

## Limitations

- **#488.** `odds_locked_at` records when the lock flag was set, not when the
  frozen price was captured. 622 of the 1,625 tested primary games lock at or
  after first pitch. The confirmed-set sensitivity run above is the
  pre-registered check on that. Locks before 2026-06-11 cannot be checked,
  because there were no captures yet.
- **#486.** game_log is missing 2026-03-25 .. 04-03 and 04-07 .. 04-08, and the
  4/04–4/05 scores are bad. Those dates are not in the test.
- **Bootstrap reuse.** The trends test's `bootRoi` gained an optional `seed`
  argument so this run could reuse it with its own registered seed. The trends
  runs are unchanged, because they pass no seed.
