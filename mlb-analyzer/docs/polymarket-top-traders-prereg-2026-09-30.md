# Polymarket top traders — pre-registration (2026-09-30)

**Status: pre-registered. No outcome has been computed.** No win rate,
lean-side result, ROI or p-value exists for this question. The only numbers here
are outcome-blind feasibility counts (§10). This file is committed on its own,
before any backtest code exists, and every run records the commit SHA of this
file. A definition changed after the first run is a new pre-registration (new
file, new date), and results under the old one are reported beside it, never
replaced.

**Display only.** Whatever the result, this never feeds the model, a signal or
a bet (§8).

## 1. Question

On games where qualified top traders leaned one side pre-game, did the lean
side win more often than its no-vig implied probability?

## 2. Data

- **Source.** `data/polymarket.db`, built by the #487 backfill (commit `ddcfad2`,
  merged as `f1037bd`), tables `markets`, `fills` and `wallet_game`. It covers
  **regular-season** moneyline markets only (2026-03-25 .. 2026-09-27).
- **Games.** Markets with `status = 'done'`. Each is matched to one `game_log`
  row by `markets.game_date` + `markets.game_id`.
- **Excluded.** `game_date` 2026-04-04 and 2026-04-05 (known-bad scores, #486).
  *Decided 2026-09-30:* they are excluded **both as test games and from
  qualification history** (§3).
- **Outcome.** Polymarket's resolution, `markets.winner_idx`. Outcome index 0
  is the home team when `outcome0_is_home = 1`, otherwise the away team.
  `game_log` scores are not used.

Counted on 2026-09-30 before any result: 2,247 done markets. The 4/04–4/05
exclusion removes 19, leaving 2,228.

**Order of steps for a game:** eligibility (§3) → price (§5) → lean (§4) →
tested (§6). A game skipped at one step is counted there and goes no further.

## 3. As-of qualification

For a game dated **D**, qualification uses history **H(D)**: every
`wallet_game` row whose market has `game_date < D`, excluding §2's dates.
"Strictly before" means a same-date game (including doubleheader game 1 for
game 2) is not history.

For each wallet over H(D):

| quantity | definition |
|---|---|
| games | number of its rows in H(D) |
| profit | `SUM(wallet_game.profit)` |
| volume | `SUM(wallet_game.volume)` |
| both | number of those rows where the wallet has at least one BUY (`fills.side = +1`) on **each** outcome of that market, over all of that market's stored fills |

A wallet is **qualified as of D** when **all** of these hold:
- games ≥ 40;
- profit > 0;
- volume / profit ≤ 50;
- both / games < 0.20.

A game is **eligible** only if **at least 25** wallets are qualified as of D.

- `wallet_game` omits net-short wallet-games (the backfill's rule, #487). They
  count toward none of games, profit, volume or both.
- **Top 25** (secondary test, §6): the qualified wallets ordered by profit, highest first.
  *Decided 2026-09-30:* ties are broken by `wallets.id` ascending. The top 25
  are the first 25 in that order.

## 4. Lean

For an eligible game with market `m` whose price passed §5:

1. **Lock time L** = `game_log.odds_locked_at`, a UTC timestamp written by
   SQLite `datetime('now')`. A game with no `odds_locked_at` has already been
   skipped at the price step (§5); there is no fallback lock time.
2. **Cut.** Fills are used when `fills.ts < min(L, markets.cutoff_utc)`.
   - The backfill stores only fills strictly before the cutoff (#487: the
     earlier of scheduled start and first pitch), so fills can be cut at any
     time before the cutoff (`ts` is per fill, to the second). They cannot
     reach past it.
   - When L is at or after the cutoff, the cut is the cutoff, i.e. every stored
     pre-game fill. That is 980 of the 2,228 in-scope games (§10). This is
     stated, not a change: the data holds nothing between the cutoff and a
     later lock, and anything there would be in-game.
3. **Wallet set.** The qualified wallets as of D (primary), or the top 25
   (secondary).
4. **Net dollars per team.** For outcome k:
   `N_k = Σ side × price × size` over the cut fills of the wallet set with
   `fills.outcome = k`, where `side` is +1 for a buy and −1 for a sell. This is
   amount spent buying minus amount received selling, summed across wallets.
   - *Decided 2026-09-30:* a wallet that is net short in this game still
     contributes its fills. The rule is in dollars, not shares.
5. **Lean** = the team whose outcome has the larger N_k.
   - **Skip, no qualified money:** no fill from the wallet set before the cut.
   - **Skip, tie.** *Decided 2026-09-30:* a tie means |N_0 − N_1| < $0.005,
     i.e. equal to the cent.
   - *Decided 2026-09-30:* when both N_k ≤ 0 (the wallets only sold), the lean
     is still the larger N_k. Such games are counted and reported.

The lean is **dollar-weighted**, so one large qualified wallet can decide a
game's lean. That matches what the card will display, and the top-25
secondary test is the check on it.

## 5. Price

The same source and rule as the trends test (`docs/trends-preregistration-2026-09-29.md` §2):

- **Locked price.** `game_log.market_{away,home}_ml` of the matched row, as frozen at
  `odds_locked_at`. It requires all of:
  - `odds_locked_at` NOT NULL;
  - `market_contamination_reason` IS NULL;
  - both moneylines NOT NULL.
- **Skips.** A game that fails any of these is **skipped at the price step**,
  counted by reason and reported. It is never priced from another source,
  including an unlocked moneyline.
- **Source.** Recorded per row from `game_log.ml_source`; NULL is labelled
  `unrecorded`. It is reported as a source mix, with an `unrecorded`-excluded
  sensitivity figure beside the primary one.
- **No-vig implied probability** of the lean team L against opponent O:

```
imp(m) = m < 0 ? -m / (-m + 100) : 100 / (m + 100)
nv(L)  = imp(m_L) / (imp(m_L) + imp(m_O))
```

- The trends population's final-score requirement is not carried over, because
  the outcome here is Polymarket's resolution (§2).

### Locks stamped at or after first pitch (decided 2026-09-30)

`odds_locked_at` records when the lock flag was set, not when the frozen price
was captured (#488). Of the 1,625 tested primary games, **622** have
`odds_locked_at` at or after `first_pitch_utc` with no contamination tag.

**Measured 2026-09-30** against the last pre-first-pitch capture. The capture
comes from `empirical_market_captures`, the table the contamination check uses:
- rows with `market_type = 'ml'`;
- prices in `away_price_ml` / `home_price_ml`;
- the last capture whose `generated_at` (Pacific time, converted by
  `utils/post-start-pricing.js`) is before `first_pitch_utc`.

Captures begin **2026-06-11**, so earlier locks cannot be checked.

| the 622 | games |
|---|---|
| locked moneylines equal the last pre-first-pitch capture exactly | 330 |
| differ | 15: implied-probability difference median 0.43 pp, 90th percentile 0.92, max 1.89; 13 under 1 pp |
| no pre-first-pitch capture stored | 277 (44.5%): 273 dated before 2026-06-11, 4 inside the capture window |

By month (exact / differ / no capture):
- Apr 0/0/22
- May 0/0/187
- Jun 88/3/68
- Jul 67/0/0
- Aug 80/4/0
- Sep 95/8/0

**Decision.** The trends price rule above stays the rule for both tests. Nothing
is skipped for lock timing. A **pre-registered sensitivity run** (§6) repeats
both tests on the **confirmed set**.

**Confirmed set** = tested games where `odds_locked_at` is before
`first_pitch_utc`, **or** the locked moneylines exactly equal the last
pre-first-pitch capture (as defined above). Outside the set are games:
- whose locked price differs from that capture;
- that have no such capture;
- that have no `first_pitch_utc` (neither condition can be evaluated).

Counts are in §10.

## 6. Tests

One row per tested game: the lean team, `p = nv(lean)`, and win = the lean team
won per Polymarket.

- **Primary**: the lean from all qualified wallets.
- **Secondary**: the lean from the top 25 qualified wallets by profit as of D.

Per test:

- **p-value**, two-sided: observed lean wins against the sum of each row's no-vig implied
  probability (Poisson-binomial, normal approximation), the trends formula:
  `z = (W − Σp) / sqrt(Σ p(1−p))`.
- **ROI** at the locked price, flat $100 on the lean. Profit on a win is
  `m > 0 ? m : 100 × 100 / −m`; a loss is −100. ROI = $ won / (100 × n).
- **Bootstrap interval** on ROI: 95% percentile interval, 10,000 game resamples,
  mulberry32. *Decided 2026-09-30:* the seed is **20260930**.
- Also reported:
  - n and W–L;
  - win % with a 95% Wilson interval;
  - implied % (mean p) and edge (win % − implied %);
  - $ won;
  - the source mix and the `unrecorded`-excluded sensitivity;
  - the games skipped at each step (§10).
- **Multiple comparisons.** Benjamini–Hochberg across the **2** in-sample
  p-values; **significant = q < 0.10**. The two tests are not independent (the
  top 25 are a subset of the qualified wallets), and this is stated beside the q-values.

**Sensitivity runs (pre-registered).** The primary and secondary tests are
repeated on the **confirmed set** (§5) and reported beside the main results,
with the same statistics and splits.
- They are **not** in the Benjamini–Hochberg correction.
- They cannot make a test significant on their own.
- If only a sensitivity run clears q < 0.10, it is reported as such and nothing
  more. Its q is computed the same way, for display.
- The HOLDS / FAILS_HOLDOUT labels (§7) apply to the main tests only.

## 7. Split

- **In-sample**: `game_date` through 2026-08-31. **Holdout**: 2026-09-01 .. 2026-09-27.
- Qualification stays as-of D in the holdout too. A September game's history
  includes every earlier game, September ones included, as §3 defines.
- **Holdout labels** apply only to a test significant in-sample (q < 0.10).
  *Decided 2026-09-30:*
  - **HOLDS**: in September, both the edge and ROI keep their in-sample sign;
  - **FAILS_HOLDOUT**: otherwise.
- The labels **gate nothing**.
- A test significant only in September is reported as such, not promoted.
  September is the check, not a second search.

## 8. Display only

Never a model input, a signal or a bet, whatever the result. That includes a
significant, HOLDS result.

## 9. What would change these rules

Anything not specified here must be decided and recorded in this file
**before** any result is computed. After the first run:
- a correction to an implementation bug is fixed in code, and the run is
  repeated with a note;
- any change to a definition is reported as a **deviation** beside the
  original, or made in a new pre-registration file.

## 10. Feasibility (outcome-blind, counted 2026-09-30)

These were computed without reading any test game's resolution or any score.
Qualification uses the profit of **earlier** games, as §3 defines.

**Qualified wallets as of D** (on the first and last game date of each month):

| month | first date | qualified | last date | qualified |
|---|---|---|---|---|
| Apr | 04-04 | 0 | 04-30 | 196 |
| May | 05-01 | 196 | 05-31 | 450 |
| Jun | 06-01 | 453 | 06-30 | 622 |
| Jul | 07-01 | 627 | 07-31 | 821 |
| Aug | 08-01 | 829 | 08-31 | 964 |
| Sep | 09-01 | 956 | 09-27 | 1,050 |

The **first date with at least 25 qualified wallets is 2026-04-13** (32 qualified).
64 in-sample games before it are not eligible.

**Games, in step order (§2):**

| | primary in | primary holdout | secondary in | secondary holdout |
|---|---|---|---|---|
| eligible games | 1,814 | 350 | 1,814 | 350 |
| price skip: no `odds_locked_at` | 288 | 57 | 288 | 57 |
| price skip: contaminated | 166 | 28 | 166 | 28 |
| price skip: moneyline missing | 0 | 0 | 0 | 0 |
| lean skip: no qualified money before the cut | 0 | 0 | 82 | 66 |
| lean skip: exact tie | 0 | 0 | 0 | 0 |
| **tested** | **1,360** | **265** | **1,278** | **199** |
| … of which both N_k ≤ 0 | 0 | 0 | 1 | 0 |

**Confirmed set (sensitivity runs, §5–§6):**

| | primary in | primary holdout | secondary in | secondary holdout |
|---|---|---|---|---|
| tested | 1,360 | 265 | 1,278 | 199 |
| confirmed: lock before first pitch | 711 | 162 | 652 | 119 |
| confirmed: locked price equals the last pre-first-pitch capture | 235 | 95 | 214 | 75 |
| **confirmed set** | **946** | **257** | **866** | **194** |
| outside: no pre-first-pitch capture | 277 | 0 | 276 | 0 |
| outside: no `first_pitch_utc` | 130 | 0 | 130 | 0 |
| outside: locked price differs from the capture | 7 | 8 | 6 | 5 |

**Lock time vs the cutoff.** Among all 2,228 done games in scope:
- 980 have the lock **at or after** the cutoff (median 20 minutes after,
  90th percentile 50, max 351). For those the cut is the cutoff (§4).
- 21 have the lock more than 60 minutes **before** the cutoff: postponed games
  locked on their original date.

**Source mix of the tested primary games:**
- in-sample: kalshi 613, polymarket 540, unrecorded 200, prophet-exchange 6, novig 1;
- holdout: kalshi 207, polymarket 58.

## 11. Open items

None. Every rule above is decided as of 2026-09-30, before any result. Any later
change follows §9.
