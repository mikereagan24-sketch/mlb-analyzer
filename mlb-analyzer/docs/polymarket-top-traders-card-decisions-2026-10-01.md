# Polymarket top traders: live card decisions (2026-10-01)

**Status: decided by the owner. This is the spec for the card build, which has
not been built yet.** The card is **display only**. It never feeds the model, a
signal or a bet.

The pre-registered test (#489,
`docs/polymarket-top-traders-prereg-2026-09-30.md`) found **no edge after
correction**: q = 0.386 for both tests, and no holdout label applies (#490,
`docs/polymarket-top-traders-results-2026-09-30.md`). The card shows what top
traders are on as information, never as a prediction. The Trends tab's
top-traders section shows the test itself.

## The eleven decisions

1. **No wallet-count minimum.** It never binds: every tested game has 10 or more
   qualified wallets with money in it (see the distributions below).
2. **Concentration is shown, not filtered.** Every card shows the largest
   wallet's share of the lean-side dollars, with a flag at **75% or more**.
   Games are never hidden for concentration.
3. **Production storage.**
   - Per-wallet running totals: games, profit, volume and the both-teams count,
     for about 77,000 wallets.
   - A daily snapshot of the qualified set, frozen before the day's first game,
     which keeps "strictly before D" exact.
   - About 20 MB in total. **No fills in production.**
4. **Seeding.** Upload the totals as of 2026-09-27 through a new streaming
   admin-token route, following the existing `/upload/*` pattern and parsing line
   by line. **No backfill runs on Render.**
5. **Season boundary.** Whether 2026 totals carry into 2027 or reset is decided
   in a 2027 pre-registration.
6. **Lean timing.**
   - Leans shown before the game are labelled **provisional**.
   - The **final** lean uses the backtest's cut, `min(odds_locked_at, cutoff)`.
     It is computed only after both times have passed, because locks are
     stamped whenever a job happens to run (#488).
7. **Settlement.** It runs nightly, after the morning score pull, through the
   existing job queue.
8. **Lean log.** One row per displayed snapshot, plus a final row with the
   locked price, kept for a 2027 pre-registered test. Each row records:
   - the game, the time shown and the cut time;
   - the lean team, and the net dollars on each side;
   - the wallets with money and the largest-wallet share;
   - the qualified count;
   - the prices shown and their source;
   - whether it is provisional or final, and regular season or postseason.
9. **Postseason.**
   - Shown with the note "tested on 2026 regular season only — no edge found".
   - Rows are flagged postseason.
   - Qualification stays frozen at 2026-09-27.
10. **Isolation.**
    - The shared rules (qualification, price step, lean) move to a small
      utility used by both the backtest and the live card.
    - The live card gets its own router and its own job entry. `services/jobs.js`
      and `routes/api.js` are in the pricing path's require graph and must never
      reach it.
    - **After the move, the backtest must reproduce its published artifact
      exactly.**
11. **Placement and wording.**
    - In Matchups, the card goes after `renderPolyKalshiOdds`. On the Games tab's
      slate cards it gets its own anchor.
    - **Kalshi is listed first** in any odds shown.
    - The label reads: "Top Polymarket traders — display only. Tested on 2026
      regular season (#490): no edge found. Not used by the model."

## Display distributions (outcome-blind)

These are the tested primary games: 1,360 from April to August and 265 in
September. They use the pre-registered as-of qualification and lean cut, and
no resolution was read.

| Per game | Apr–Aug: P10 / P25 / P50 / P75 / P90 | Sept: P10 / P25 / P50 / P75 / P90 |
|---|---|---|
| Qualified wallets with money in the game | 28 / 35 / 45 / 58 / 72 | 16 / 21 / 27 / 37 / 44 |
| Net $ on the lean side | 3,381 / 7,623 / 19,274 / 43,461 / 82,787 | 1,000 / 3,328 / 11,967 / 28,368 / 57,679 |
| Net $ on the other side | 600 / 1,531 / 4,648 / 12,174 / 29,192 | 199 / 584 / 1,945 / 6,046 / 18,689 |
| Largest wallet's share of lean $ | 40% / 51% / **68%** / 87% / 95% | 43% / 56% / **78%** / 93% / 97% |

| Concentration | Apr–Aug | Sept |
|---|---|---|
| Largest wallet ≥ 75%: **flagged** | 573 of 1,360 (42%) | 145 of 265 (55%) |
| Largest wallet under 75% | 787 (58%) | 120 (45%) |
| Largest wallet under 50% | 326 (24%) | 47 (18%) |
| At least 3, 5 or 10 qualified wallets with money | 1,360 (all) | 265 (all) |

## Related

- #489: the pre-registration.
- #490: the backtest and its results.
- #488: lock timing.
- #487: the backfill.
