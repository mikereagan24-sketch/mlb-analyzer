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
  shown once per scenario (one test, both directions). (2026-09-30: now
  sortable, with a slate-fit column. See the addendum.)
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

## Addendum 2026-09-30: sortable table and a "Fits the slate" column

**Added at the owner's request, for interest only.** The tab states this
directly: "Fits are for interest only. No trend passed the test." Display only;
nothing here feeds the model, a signal or a bet. It is still the tab, not a
per-game block on slate cards or Matchups, which remain deferred.

**Sorting.** Click any column header to sort by it; click again to reverse.
The default is still scenario ID ascending. Numbers sort numerically. On every
column except ID and Scenario, "too small to read" rows (n < 30) and blank
values sort last in both directions, so the default view is unchanged. The
active column shows ▲ or ▼. Styling stays neutral.

**The slate column.** `GET /api/trends/slate[?date=]` defaults to the current
PT date. It is served from `routes/trends-results.js`, still not
`routes/api.js`.
- **Same definitions.** It uses the same predicates
  (`utils/trends/scenarios.js`, unchanged) and the same context code. The
  team-game context was moved, unchanged, from `buildRows` into
  `utils/trends/context.js`, and both the backtest and
  `services/trends-slate.js` call it.
- **Refactor proof.** The re-run on a scratch copy reproduces
  `docs/trends-results-2026-09-29.json` exactly (192 rows, 3,648 fields), and
  `buildRows` output is row-identical (3,342 team rows, 3,334 totals rows).
- **Live = test where they should coincide.** On all 167 population dates, the
  slate's fits equal the backtest's own scenario membership on locked,
  unflagged games: 56,755 of 56,755 checks.

**How each live-matching caveat is handled**

1. **Price before the odds lock** (S01–S10, S12, S19, S21–S29). The game's
   current stored price is used, and a fit is labelled "provisional — price not
   locked" until `odds_locked_at` is set.
   - **"No reliable price" blocks only on a MONEYLINE problem** (narrowed on
     2026-09-30). The game is not classified when any of these hold:
     - its moneyline is flagged;
     - it carries a flag that cannot be attributed to one market;
     - `market_contamination_reason` is set.
   - **How a flag is attributed.** `odds_flag_reason` is the odds job's
     reasons joined with " | " (`services/jobs.js:5208`). Each fragment is
     attributed by where its text is produced (`FLAG_RULES` in
     `services/trends-slate.js`).
     - **Moneyline, blocks:**
       - `single-source, no cross-check available` (`jobs.js:5090`);
       - `no sane odds` (`jobs.js:5088`);
       - `impossible line pair` / `implausible line magnitude`
         (`utils/market-sanity.js:101,108,116`, via `jobs.js:5092`);
       - `extreme line` (`jobs.js:475-476`);
       - `Kalshi vs … disagree on favorite` / `divergence`
         (`jobs.js:508,516`).
     - **Totals only, does not block:**
       - `no sane totals` (`jobs.js:5146`);
       - `single-source total, no cross-check available` (`jobs.js:5148`);
       - the historical `totals [juice|line] divergence` and
         `no primary totals; …` texts (`jobs.js:4924,4977,4980` at
         `83bb54a^`, removed 2026-09-17).
     - **Unattributable, still blocks:**
       - the double-header start-time guard
         (`utils/dh-assignment-guard.js:97`), which rejects a source's whole
         write for the game, moneyline and totals alike
         (`jobs.js:5566-5567`, `5731-5732`);
       - a flag with no reason text;
       - any unrecognised text.

       No stored flag this season is unattributable.
   - **Effect in September.** Of 361 games with a stored moneyline, 53
     changed from "no reliable price" to classified, all of them
     totals-divergence-only flags. 137 still block: 103 single-source
     moneylines and 34 contaminated.
   - A game with no stored moneyline yet shows "no price yet".
2. **S25/S26 need the lock price.** They show "pending lock" until it exists,
   then compare the morning open with the lock price, as the test does.
3. **The hardcoded population window** (`services/trends-backtest.js`
   `inPopulation`). The live rule is: **the previous game counts as priced
   when it has both stored moneylines, `odds_locked_at` set and no
   `market_contamination_reason`, whatever its date.** That is the population
   rule without its 2026-04-09..2026-09-27 window, so S01–S07 can match after
   09-27.
4. **S23 when the next game isn't loaded.** The slate reads 7 days ahead.
   - If the team's next game is not in `game_log`, a finale is never assumed.
     When the answer depends on it, the fit shows **"unknown"**.
   - Otherwise the series grouping is the test's own.
5. **Context only for population games.** The context code was extracted, as
   noted above, rather than re-running the backtest. The slate reads one
   bounded date range (45 days back, widened only if a streak reaches the
   window's start) through its own read-only connection.
   - It is cached per date for 10 minutes.
   - Measured on the local copy: 49 ms mean and 100 ms max per date, across
     167 dates.
6. **Postseason.** Games after 2026-09-27 are matched, and each fit carries
   "tested on regular season only".

## Related

- `docs/trends-preregistration-2026-09-29.md` (#478), the backtest (#480)
- `utils/trends/context.js`, `services/trends-slate.js` (2026-09-30)
- `services/trends-backtest.js`, `utils/trends/scenarios.js`, `utils/trends/teams.js`
- `scripts/run-trends-backtest.js`, `scripts/export-trends-results.js`,
  `scripts/test-trends-backtest.js`, `scripts/test-trends-results-tab.js`
