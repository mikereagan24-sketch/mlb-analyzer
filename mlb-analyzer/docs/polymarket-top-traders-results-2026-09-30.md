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

## Correction (2026-10-01): repeat trades restored

The results above stand as first reported. This section repeats the run on
corrected data under pre-registration §9: an implementation bug was fixed in
code and the run repeated with a note. No rule or definition changed. The
document hash pin passed.

**Verdict: unchanged, no edge.** Neither main test is significant after
correction: q = 0.297 for both, against q < 0.10. No holdout label applies.

**Full numbers:** `docs/polymarket-top-traders-results-2026-09-30-corrected.json`.
The original JSON is unchanged.

**Reproduce.** The committed runner reproduces both files:
- `scripts/run-polymarket-top-traders-backtest.js --corrected` on
  `data/polymarket.db` gives the corrected file;
- the default mode on the pre-fix backup gives the original.

`scripts/test-top-traders-card-a.js` (check a) asserts both, field by field.

### Cause

Polymarket's `/trades` response has **no trade ID**. Identical rows are
separate real fills: one taker order matched against several identical maker
orders. The backfill removed identical rows within each time window, so it
**dropped 18,671 real trades in 1,846 of the 2,247 markets** (0.73% of
pre-game trades).

### Fix and re-fetch

- **Code:** #496 (commit `1e3330d`, merged in `c8dd507`) keeps every row and
  uses half-open time windows.
- **Re-fetch:** the 1,846 affected markets were re-fetched on 2026-10-01: 7,357
  requests, 5 retries (all 429s), peak 130 MB.
- **Backup:** the pre-fix store is kept at `data/polymarket-before-repeats.db`.

Checks on the corrected store:
- **Nothing pending.** Every market's windows tile [0, cutoff) with no gaps or
  overlaps, and no fill is at or after its cutoff.
- **Every count adds up.** For 1,844 of the 1,846 re-fetched markets, new fills
  = old fills + the old run's dropped count, exactly.
  - The two exceptions, `mlb-pit-hou-2026-06-02` (−1) and `mlb-sf-atl-2026-06-16`
    (−25), are among the 21 markets truncated by the earlier recut. That recut
    kept the dropped count of the window the new cutoff fell in, so part of the
    count belonged to trades after the cutoff.
  - The 401 unaffected markets are unchanged.
- **Spot check.** In `mlb-tb-phi-2026-09-27`, the 71,787.21-share buy now has
  all 48 counterparty rows, totalling 71,787.21 shares (before: 44 rows,
  61,387.21).

| store | before | after |
|---|---|---|
| fills | 2,528,390 | 2,547,035 |
| wallet-game rows | 729,647 | 730,161 |
| net-short positions | 4,712 | 4,192 |
| season wallet profit, all wallets | −$520,374 | +$25,507 |
| season wallet volume | $513.26M | $518.09M |

The season profit summed over every wallet should be close to zero, because
every trade has two sides. The dropped repeats pushed it to −$520k; restored,
it is +$26k.

### Gate 1, split by what the fix can affect

**a. game_log only: must match §10.** All 11 fields match:
- done markets 2,247, and the 4/04–4/05 exclusion of 19;
- 2,228 in-scope games;
- price skips by reason;
- lock versus cutoff;
- the 622-game lock table, with its by-month rows and the first capture date.

**b. Depend on trades: may differ.** 13 of 20 unchanged.

| field | original | corrected |
|---|---|---|
| first eligible date (qualified) | 04-13 (32) | 04-13 (32) |
| games not eligible, in / holdout | 64 / 0 | 64 / 0 |
| qualified, May 31 | 450 | 451 |
| qualified, Jun 30 | 622 | 625 |
| qualified, Jul 1 / Jul 31 | 627 / 821 | 630 / 823 |
| qualified, Aug 1 / Aug 31 | 829 / 964 | 831 / 964 |
| qualified, Sep 27 | 1,050 | 1,051 |
| eligible games, in / holdout | 1,814 / 350 | 1,814 / 350 |
| secondary lean skips, in-sample (no qualified money) | 82 | 76 |
| tested: primary in / hold, secondary in / hold | 1,360 / 265 / 1,278 / 199 | 1,360 / 265 / **1,284** / 199 |
| confirmed set, secondary in-sample | 866 | 870 |
| confirmed set, other three | 946 / 257 / 194 | unchanged |

The other qualified counts (Apr, May 1, Jun 1, Sep 1) and the primary tested
source mix are unchanged.

**Leans that changed:**
- primary: 6 in-sample and 1 September game flipped side;
- secondary: 5 in-sample games flipped, and 6 are newly tested.

### Corrected results

The format is as above.

**Main tests**

| test | split | n | W–L | win % | implied % | edge | p | BH q | ROI [95%] | $ won |
|---|---|---|---|---|---|---|---|---|---|---|
| primary | Apr–Aug | 1,360 | 725–635 | 53.3 [50.7, 55.9] | 51.8 | +1.5 | 0.272 | 0.297 | −1.2% [−6.2, +3.9] | −1,641 |
| primary | Sept | 265 | 132–133 | 49.8 [43.8, 55.8] | 51.2 | −1.4 | 0.636 | — | −9.6% [−20.7, +1.4] | −2,549 |
| secondary | Apr–Aug | 1,284 | 680–604 | 53.0 [50.2, 55.7] | 51.5 | +1.4 | 0.297 | 0.297 | −1.3% [−6.5, +3.8] | −1,649 |
| secondary | Sept | 199 | 100–99 | 50.3 [43.4, 57.1] | 51.2 | −1.0 | 0.776 | — | −8.1% [−21.5, +5.0] | −1,619 |

**Sensitivity: the confirmed set.** Outside BH; its q is for display only.

| test | split | n | W–L | win % | implied % | edge | p | q (display) | ROI [95%] | $ won |
|---|---|---|---|---|---|---|---|---|---|---|
| primary | Apr–Aug | 946 | 511–435 | 54.0 [50.8, 57.2] | 51.9 | +2.1 | 0.184 | 0.184 | +0.1% [−5.9, +6.2] | +141 |
| primary | Sept | 257 | 129–128 | 50.2 [44.1, 56.3] | 51.3 | −1.2 | 0.707 | — | −9.2% [−20.4, +2.1] | −2,361 |
| secondary | Apr–Aug | 870 | 468–402 | 53.8 [50.5, 57.1] | 51.4 | +2.4 | 0.157 | 0.184 | +0.6% [−6.0, +7.0] | +506 |
| secondary | Sept | 194 | 99–95 | 51.0 [44.0, 58.0] | 51.4 | −0.3 | 0.925 | — | −6.8% [−20.0, +6.6] | −1,320 |

**Sources with no recorded price source excluded** (§5 sensitivity):

| | in-sample p (n) | in-sample ROI | Sept ROI |
|---|---|---|---|
| main primary | 0.203 (1,160) | −0.4% | −9.6% |
| main secondary | 0.216 (1,092) | −0.4% | −8.1% |
| confirmed primary | 0.099 (861) | +1.5% | −9.2% |
| confirmed secondary | 0.055 (793) | +2.6% | −6.8% |

As in the original, none of these are corrected or significance-bearing. The
0.099 and 0.055 are sensitivity cuts of a sensitivity run; under §6 they are
reported and nothing more.

**Original versus corrected, main in-sample:**
- **primary:** edge +1.2 → +1.5 points, p 0.386 → 0.272, ROI −1.8% → −1.2%;
- **secondary:** edge +1.2 → +1.4 points, p 0.377 → 0.297, ROI −1.7% → −1.3%;
- **both:** BH q 0.386 → 0.297.

**Reading.** The restored trades moved the in-sample numbers slightly in the
lean's favour. Neither test is anywhere near significant, the lean still loses
money at the actual price, and September is still negative. The card can
show what top traders are on as information. Nothing here supports calling
it predictive.
