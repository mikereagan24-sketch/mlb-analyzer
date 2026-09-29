# Trends — pre-registration (2026-09-29)

**Status: pre-registered. No trend result has been computed.** This file is
committed on its own, before any backtest code exists, and every trend run
records the commit SHA of this file. A definition changed after the first run
is a new pre-registration (new file, new date), and results under the old one
are reported beside it, never replaced.

**Display only.** Trends never feed the model, a signal, or a bet. They are
shown on the Trends section with their numbers, weak ones included.

## 1. Population

One row = **one team in one game**: the bet is that team's moneyline (totals
scenarios 30–31 use the game's over/under instead; §4).

A game is in the population when **all** hold:

| rule | column(s) |
|---|---|
| final score recorded | `game_log.away_score`, `home_score` NOT NULL |
| not soft-deleted | `COALESCE(is_removed, 0) = 0` |
| price was locked pre-game | `odds_locked_at` NOT NULL |
| not priced after first pitch | `market_contamination_reason` IS NULL |
| both moneylines present | `market_away_ml`, `market_home_ml` NOT NULL |
| regular season | `game_date` between **2026-04-09** (first locked price) and **2026-09-27** (last regular-season date). Postseason games (2026-09-29 on) are excluded. |

Counted on 2026-09-29 before any result: 1,671 games / 3,342 team-rows.

**History features** (previous game, streaks, runs scored/allowed, series
position) are built from **every** scored, not-removed game in `game_log`, priced
or not — a streak does not reset because a game lacked a clean price. A
scenario whose condition needs the PREVIOUS game's price (e.g. "favorite last
game") qualifies only if that previous game is itself in the population.

## 2. Prices

**Locked price.** `game_log.market_{away,home}_ml` as frozen at
`odds_locked_at` (the T-10 pregame freeze). This is the price the model locks
against, from the existing odds-source ordering (Kalshi first). The source is
recorded per row in `game_log.ml_source` and **reported per row and as a
per-scenario source mix**. On 2026-09-29 the population's sources were Kalshi
814, Polymarket 607, other 8, and **242 `NULL`** (April and July rows written
before `ml_source` was populated). NULL rows are **included** and labelled
`unrecorded`; a sensitivity run excluding them is reported beside the primary
figures, not instead of them.

**No-vig implied probability** of team T with price `m_T` against the
opponent's `m_O`, both from the same locked row:

```
imp(m)  = m < 0 ? -m / (-m + 100) : 100 / (m + 100)
nv(T)   = imp(m_T) / (imp(m_T) + imp(m_O))
```

**Favorite / underdog.** T is the favorite when `nv(T) > 0.5`, the underdog
when `nv(T) < 0.5`. Exactly 0.5 is neither and qualifies for no fav/dog
condition.

**Open price** (scenarios 25–26 only). The ML row of
`empirical_market_captures` with `market_type = 'ml'` and
`capture_track = 'morning'`: exactly one row per game, written INSERT-OR-IGNORE
by the morning capture chain (lineups → weather → odds), capture time in its
`generated_at` column (PT; 1,216 of 1,429 at 07:xx, the rest 05:xx–16:xx on
days the chain ran late). It copies `game_log.market_{away,home}_ml` at that
moment, i.e. the same Kalshi-first ordering, **but the source of the open is
not recorded** — `ml_source` is overwritten by later passes. So a move from
open to lock can include a source switch (Kalshi → Polymarket) as well as a
price move. That is a stated limitation; the sensitivity run restricts 25–26 to
rows whose lock source is `kalshi`. Morning captures begin **2026-06-11**, so
25–26 cover 2026-06-11 .. 2026-09-27 only.

**Price move in cents**, for team T:

```
c(m) = m < 0 ? m + 100 : m - 100       (-110 -> -10, +105 -> +5; -100 and +100 both 0)
toward T  :  c(open_T) - c(lock_T) >= 15      (T got more expensive)
against T :  c(lock_T) - c(open_T) >= 15
```

**Totals** (30–31): line `market_total`, prices `over_price` / `under_price`,
source `total_source`, all as locked. Additionally requires those three NOT
NULL. A final total equal to the line is a **push**: counted in n, not in W/L,
profit 0.

## 3. Outcome and money

- **Win**: T's runs > opponent's runs. (Totals: over wins when final total >
  line, under when <.)
- **Stake**: flat $100 per row at the locked price.
  Profit on a win = `m > 0 ? m : 100 * 100 / -m`; on a loss = −100.
- **$ won** = sum of profit. **ROI** = $ won / (100 × rows).
- A game where BOTH teams qualify for the same scenario contributes BOTH rows
  (they largely offset). The count of such games is reported per scenario.

## 4. Scenarios

Notation: G = the game being bet; T = the team bet; O = opponent; P = T's most
recent completed game before G (ordered by `game_date`, then first pitch, then
`game_id` so `-g2` follows the first game). "Home"/"road" are T's side in that
game. Days and times are local to the home team's ballpark (§5).

| id | scenario | exact condition on T in G |
|---|---|---|
| S01 | Home dog again | T home underdog in G AND T home underdog in P (P priced) |
| S02 | Favorite again after losing as favorite | T favorite in G AND T favorite in P AND T lost P |
| S03 | Road dog again | T road underdog in G AND T road underdog in P |
| S04 | Favorite again after winning as favorite | T favorite in G AND favorite in P AND won P |
| S05 | Dog again after winning as dog | T underdog in G AND underdog in P AND won P |
| S06 | Favorite after winning as dog | T favorite in G AND underdog in P AND won P |
| S07 | Dog after losing as favorite | T underdog in G AND favorite in P AND lost P |
| S08 | Home favorite after home loss | T home favorite in G AND T home in P AND lost P |
| S09 | Big favorite after a loss | T's locked ML in G ≤ −200 AND lost P |
| S10 | Big dog | T's locked ML in G ≥ +175 |
| S11 | After a blowout loss | T lost P by ≥ 5 runs |
| S12 | Favorite after a blowout win | T favorite in G AND won P by ≥ 5 runs |
| S13 | After being shut out | T scored 0 in P |
| S14 | After scoring 10+ | T scored ≥ 10 in P |
| S15 | After allowing 10+ | O-in-P scored ≥ 10 against T in P |
| S16 | After a one-run loss | T lost P by exactly 1 |
| S17 | Losing streak 3+ | T lost each of its last ≥ 3 completed games before G |
| S18 | Winning streak 3+ | T won each of its last ≥ 3 completed games before G |
| S19 | Dog on a 5+ losing streak | T underdog in G AND lost each of its last ≥ 5 |
| S20 | Day game after a night game | G starts before 17:00 local AND P started at or after 17:00 local on the previous calendar day (local) |
| S21 | Doubleheader game 2, dog | G's `game_id` ends in `-g2` AND T underdog in G |
| S22 | Series opener, road dog | G is game 1 of a series (§5) AND T road AND T underdog |
| S23 | Series finale, home favorite | G is the last game of a series (§5) AND T home AND T favorite |
| S24 | Favorite after losing to same opponent this series | G not game 1 of its series AND P is the previous game of the same series AND T lost P AND T favorite in G |
| S25 | Line moved toward T | open→lock move toward T ≥ 15 cents (§2) |
| S26 | Line moved against T | open→lock move against T ≥ 15 cents (§2) |
| S27 | Home dog vs division rival | T home underdog AND T and O in the same division (§5) |
| S28 | Interleague road dog | T road underdog AND T and O in different leagues |
| S29 | Opener / bullpen game, dog | T's OWN pitching side flagged `is_opener_game_{away,home} = 1` in G AND T underdog |
| S30 | Over after a 15+ run game | bet the OVER in G when either team's P had a combined final total ≥ 15; one row per game |
| S31 | Under in a day game after a night game | bet the UNDER in G when G qualifies as S20 for either team; one row per game |

S01 and S02 are the two scenarios named in the request; S03–S31 are the 29
added.

## 5. Calendar definitions

- **Local time**: first pitch = `first_pitch_utc`, else `scheduled_start_utc`,
  converted to the home team's ballpark time zone from a fixed 30-team map
  (committed with the backtest, one IANA zone per team; ATH = America/Los_Angeles).
  A game with neither timestamp qualifies for no day/night condition (S20, S31).
- **Series**: the maximal run of a team's consecutive games (its own schedule
  order, scheduled games included so the finale is known pre-game) against the
  same opponent at the same home ballpark. Game 1 = first of the run; finale =
  last. A suspended/removed game does not break a run.
- **Division / league**: the 2026 alignment (AL/NL × East/Central/West), fixed
  map committed with the backtest.

## 6. Statistics (per scenario, all rows and each split)

- **n**, record W–L(–P), **win %** with a **95% Wilson interval**.
- **Implied %** = mean no-vig implied of the bet side; **edge** = win % − implied %.
- **p-value**: two-sided, observed wins against the sum of each row's no-vig
  implied (Poisson-binomial, normal approximation:
  `z = (W − Σp) / sqrt(Σ p(1−p))`).
- **ROI** and **$ won** at the locked price, ROI with a **95% bootstrap
  interval** (10,000 row resamples, seed 20260929).
- **Source mix** of the locked price (§2), and the `unrecorded`-excluded
  sensitivity figures.
- Scenarios with n < 30 are reported and marked **too small to read**.

## 7. Multiple comparisons

31 scenarios are tested. At p < 0.05, about **31 × 0.05 ≈ 1.6** would look
significant by chance alone even if none had any edge, and they overlap (the
same team-game falls in several), so they are not independent tests. The report
prints, next to the count that clear p < 0.05:

- the chance expectation (1.6) and P(≥ k significant | no real edge) under a
  binomial(31, 0.05) — an approximation, stated as such given the overlap;
- **Benjamini–Hochberg q-values** across the 31 in-sample p-values; only
  q < 0.10 is described as "survives multiple-comparison correction".

## 8. Holdout

- **In-sample**: 2026-04-09 .. 2026-08-31. **Out-of-sample**: 2026-09-01 ..
  2026-09-27 (268 games at pre-registration).
- Every scenario is reported in-sample, out-of-sample, and all.
- **FAILS HOLDOUT** flag: in-sample p < 0.05 AND in September either the edge
  (win % − implied %) has the opposite sign or ROI ≤ 0.
- A scenario that is significant ONLY in September is reported as such, not
  promoted — September is the check, not a second search.

## 9. What would change these rules

Nothing after the first run, within this file. A correction — a bug in a
definition's implementation, a mis-mapped team — is fixed in code and the run
is repeated with a note in the report; a change to what a scenario MEANS is a
new pre-registration file.
