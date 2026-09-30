# Trends: a results tab only (2026-09-29)

**Status: decided.** The Trends feature ships as a single **results tab** showing
the one recorded run of the pre-registered backtest
(`docs/trends-preregistration-2026-09-29.md`, #478, commit `8865cba`), both sides
of every scenario. **Display only — nothing here feeds the model or a bet.**
The per-game block on slate cards and Matchups is **deferred**.

## Why a results tab and nothing per-game

The backtest (#480) found **0 of 31** scenarios significant in-sample
(p < 0.05), where about 1.6 would be expected by chance alone, and none
survives Benjamini–Hochberg at q < 0.10. The September holdout was never
reached, because nothing was significant to carry to it. A per-game block
would put a scenario label next to tonight's games — which reads as a
suggestion — for 31 situations that, on this season's locked prices, do not
beat the market by more than chance. The tab shows the full result, weak
rows and all, and makes no suggestion about any game.

## The other side of each scenario was already tested

The pre-registered win-rate test is **two-sided** (§6: "two-sided, observed
wins against the sum of each row's no-vig implied"), and the implied % is
**vig-removed** (§2: `nv(T) = imp(m_T) / (imp(m_T) + imp(m_O))`). Betting the
opposite side of the same games swaps W and L and turns every row's implied
p into 1 − p, so z changes sign and the two-sided p-value is identical.

Verified on all 31 (the artifact's `other_side` block, computed with the
backtest's own `buildRows` / `summarize` / `bootRoi`, seed 20260929): every
other-side p equals the original within 1.3e-14, every other-side implied %
equals 1 − the original within 1e-15, and no other side is significant. **No
new pre-registration is needed for the opposite sides**; they are the same
test, and the artifact labels them "derived, not separately pre-registered".
ROI is not a mirror image — both sides pay the vig — so both sides can lose.

Where both teams qualify for a scenario, "the other side" overlaps the
original bets: S20 (day game after a night game) in 359 of its 362 in-sample
games (718 of 721 bets), and a few games each in S11 and S13–S18. The tab
footnotes these counts.

## What shipped

- `docs/trends-results-2026-09-29.json` — the recorded run (run 1: 192
  `trend_results` rows plus the `trend_runs` row) and the other-side block,
  exported by `scripts/export-trends-results.js` from a scratch copy of the
  database the run was recorded on. It carries the pre-registration commit and
  content hash, the windows, the summary, and the `main` commit it was
  generated from.
- `GET /api/trends/results` — serves that file, read once and cached; no
  database, no computation, no settings; an error JSON (503) if the file is
  missing or unreadable. **It lives in its own router, `routes/trends-results.js`,
  mounted under `/api` in `server.js`, not in `routes/api.js`**: `services/jobs.js`
  requires `routes/api.js` (for `ingestWobaCSV`), which puts `routes/api.js`
  inside the pricing path's require graph, and the trends artifact must stay
  out of that graph.
- A "Trends" tab next to Backtest, neutral styling, rows in ID order, p and q
  shown once per scenario (one test, both directions).
- `scripts/test-trends-results-tab.js` — the renderer is wired in; the route
  reads only the artifact; the artifact is the pre-registered run with both
  sides of one test; and no file in the pricing path's full require graph
  references the trends modules, router or artifact (with self-tests proving
  that check catches a planted violation).

## Caveats a future per-game block must handle

These are why a per-game block cannot simply call the backtest's selection on
tonight's games:

1. **Price classification before the odds lock.** Every fav/dog or price
   threshold condition reads the LOCKED price (`market_*_ml` at
   `odds_locked_at`, the T-10 freeze). Before the lock only the current market
   exists, so the label can change until T-10. Affected: S01–S10, S12, S19,
   S21–S29; S25/S26 also need the lock price itself (open → lock move).
2. **The population window is hardcoded.** `services/trends-backtest.js:72`
   restricts the population to `2026-04-09 .. 2026-09-27`, and "previous game
   priced" (S01–S07) requires the previous game to be in that population — so
   outside the window those seven can never qualify. A live evaluator needs a
   population rule separate from the backtest window.
3. **S23 defaults to "finale" when the next game isn't loaded.**
   `services/trends-backtest.js:120` (`seriesLast`) treats a team's last listed
   game as a series finale, so a finale is only known once the following
   game is in `game_log`.

Also for that future block: the backtest builds its per-game context only
for population (scored) games (`services/trends-backtest.js:145`); a live
evaluator needs that context assembly extracted, not the backtest re-run.

## Related

- `docs/trends-preregistration-2026-09-29.md` (#478), the backtest (#480)
- `services/trends-backtest.js`, `utils/trends/scenarios.js`, `utils/trends/teams.js`
- `scripts/run-trends-backtest.js`, `scripts/export-trends-results.js`,
  `scripts/test-trends-backtest.js`, `scripts/test-trends-results-tab.js`
