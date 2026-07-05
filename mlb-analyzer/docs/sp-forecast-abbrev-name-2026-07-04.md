# SP forecast null on abbreviated names — investigation 2026-07-04

**Trigger:** SD@LAD 2026-07-04, Yamamoto (LAD) priced at SP weight 0.62 — the
`SP_FORECAST_LOW_CONF_TARGET` fallback that fires when a forecast resolves
null. Yamamoto has ~16 six-inning starts on prod; the low-conf fallback
should not have applied to him.

## Answer to the key question

**NOT every projected-not-yet-confirmed SP hits the 0.62 fallback.** It's
name-form-specific: SPs stored in `game_log` with an abbreviated first name
(`X. Lastname`) reliably fail forecast resolution because the resolver
does exact-match only. Full-name SPs — projected or confirmed — resolve
correctly through the same code path.

But the bug is real and recurring. Historical scan:

- 48 game rows since 2026-03-01 have an abbreviated-form SP name in
  either `away_sp` or `home_sp`.
- **20 of those (42%) have `_sp_forecast_ip = null`.** That's exactly the
  Yamamoto-style silent low-conf pricing.
- Recurring offenders (game rows with null forecast):

```
  S. Woods Richardson  × 5   (MIN)
  E. Rodriguez         × 4   (DET, likely Eduardo Rodriguez)
  C. Sanchez           × 4   (PHI, Cristopher Sanchez)
  B. Williamson        × 4   (SF, Brandon Williamson)
  S. Arrighetti        × 1   (HOU, Spencer Arrighetti)
  J. Misiorowski       × 1   (MIL, Jacob Misiorowski)
  G. Rodriguez         × 1   (BAL, Grayson Rodriguez)
```

- Frequency: ~20 misfires in ~4 months → **~1 game every 5 days is silently
  mispriced** on the SP side. That is well within the owner's morning-line
  window.

## Chain break (where it fails)

1. **RotoWire scraper** writes some projected SPs in `X. Lastname` form.
   Every other data source (statsapi probables, pitcher_game_log,
   team_rosters, FanGraphs projections) uses the full name.
2. **`sp_prefer_rotowire=true`** (live in prod) — RotoWire's name wins the
   merge (`services/jobs.js:1593`). The game row's `home_sp` becomes
   `"Y. Yamamoto"`.
3. **`forecastForPitcher` in `services/jobs.js:1402`** resolves the name to
   `mlb_id` via team_rosters using two exact-match strategies only:

   ```js
   const r = rosterLookup.get(team, pitcherName);   // exact match on team+name
   if (mlbId == null) {
     const key = team + ':' + normName(pitcherName);
     if (rosterByNorm.has(key)) mlbId = rosterByNorm.get(key);  // exact match on normalized
   }
   if (mlbId == null) return null;                  // ← the null path
   ```

   `team_rosters` has `Yoshinobu Yamamoto` for LAD. `normName('Y. Yamamoto')` =
   `'y yamamoto'`; `normName('Yoshinobu Yamamoto')` = `'yoshinobu yamamoto'`.
   Neither exact nor normalized-exact match. mlbId=null → forecast=null.
4. **`game_log`** stores `home_sp_forecast_ip = NULL`, `home_sp_forecast_n_priors = NULL`.
5. **`services/model.js` `computeSpPitWeightFromForecast`** sees a null
   forecast → returns `SP_FORECAST_LOW_CONF_TARGET` (0.62), the same weight
   assigned to a pitcher with no priors at all.

## What the debug endpoint told us

The `/api/debug/sp-ip-forecast` endpoint uses a **different resolution
path** — substring match against `pitcher_game_log`:

```sql
SELECT pitcher_mlb_id ... WHERE pitcher_name LIKE '%<query>%'
```

That's why the debug endpoint resolves Yamamoto's full name AND the last-only
form ("Yamamoto") but returns 404 on the abbreviated form ("Y. Yamamoto") —
pitcher_game_log stores the full name and LIKE '%Y. Yamamoto%' is a literal
substring miss on 'Yoshinobu Yamamoto' (no period in the source).

So the batch job's failure was invisible to the debug endpoint. The debug
endpoint's LIKE match masks the actual mlb_id resolution problem because
by the time someone queries it manually they type the full name.

## Contrast: why full-name projected SPs resolve

On today's slate (2026-07-04), all other 14 games have full-name SPs and all
of them resolve, including several with low priors:

```
BAL@CIN  home Hunter Greene    n_priors=0   forecast 5.25  (league-only)
MIN@NYY  home Brendan Beck     n_priors=1   forecast 5.04
TB@HOU   home Hunter Brown     n_priors=6   forecast 5.14
BOS@LAA  home Sam Aldegheri    n_priors=7   forecast 4.73
```

Projected-not-yet-confirmed status is orthogonal — the resolver is fine with
zero priors, it's the name-form mismatch that kills it.

## Fix direction (not implemented in this pass)

The surgical fix is a resolver upgrade in `forecastForPitcher`
(`services/jobs.js:1402`): after the two exact-match attempts, add a
first-initial + last-name fallback against `rosterByNorm`. The utility
`utils/names.js:fuzzyLookup` already implements this pattern for wOBA
lookups (see the `isAbbrev` branch); reuse it here instead of writing a
second copy.

The more thorough fix is to **expand the abbreviated form upstream** — at
`services/scraper.js` or in the RotoWire merge before `writeAwaySp` /
`writeHomeSp` are set — so every downstream column (`home_sp` itself,
`home_sp_proj_ip`, `home_sp_forecast_ip`, `home_opener_forecast_ip`,
`home_bulk_forecast_ip`, `sp_source_conflict`, opener detection, override
queries) all get consistent full names. This costs one `rosterByNorm`
lookup per SP write and eliminates a class of downstream mismatches
beyond just the forecast column.

Recommendation: **do the resolver fix first** (touch 5 lines, no upstream
data change), then follow with the scraper-side expansion so the full-name
propagation lands in `game_log.home_sp` and everything else that keys off
the SP name string sees it consistently. The scraper-side change is the
more invasive one — it needs its own regression scan to prove existing
`sp_source_conflict` counts don't shift.

## Rerun the SD@LAD card once fixed

After the resolver fix, expect Yamamoto to land at SP weight 0.80 (his
n_priors=15 puts him at max confidence per the settings). Model total for
SD@LAD moves down (better SP → fewer runs) and the LAD ML moves up. Owner's
morning line for this game was priced with Yamamoto at 0.62.

## Historical bet-outcome scan (added 2026-07-05)

Ran `bet_signals` grading on the 20 misfire games. Result: the bug did
**not** cost money in aggregate — the affected games actually netted a
profit, which is a coincidence of matchup rather than the model being
right about the mispricing.

- 20 misfire games → 14 had emitted, graded signals.
- 20 graded signals total. **Aggregate PnL +$372.00, ROI +19.52%.**
  - ML: n=10, W/L 6-4, PnL +$258.00, ROI +32.02%
  - Total: n=10, W/L 6-4, PnL +$114.00, ROI +10.36%
- Signal magnitude was extreme: 7 of 10 ML signals carried edges of
  20-40pp — precisely the calibration range PR #145's edge-sanity cap
  is designed to catch. With `signal_edge_hard_cap_pp=0.25` now live,
  the ≥25pp signals would be **suppressed** to `bet_signal_audit`
  going forward; the 10-25pp band would emit with `edge_suspect=true`.

Direction analysis (which side did the model back?):

- **7 of 10 ML signals BACKED the abbrev-priced team.** Counter to a
  naive read of the bug — under-weighting the SP should *bias against*
  that team. What actually happened: an SP weight of 0.62 (vs the
  correct ~0.78) shifts wOBA weight onto the bullpen. When the bullpen
  had good matchups vs the opposing lineup, the abbrev-team ended up
  looking BETTER, not worse. Ten of these fell that way.
- 3 of 10 backed the opposing team (the expected direction).
- Totals: 4 Overs, 6 Unders — mixed. Unders won 4 of 6.

**The +19.52% ROI is a small-n coincidence, not evidence the bug is
benign.** With 20 signals across 4 months, the sample is too thin to
draw a calibration conclusion. What the scan does say cleanly:
mispricing on the SP side propagates non-obviously through the
pitcher-side blend, and the direction of the propagation depends on
whether the pitcher is better or worse than his bullpen. Fixing the
resolver removes a source of unmodeled variance; the fact that it
happened to be net-positive on this specific 4-month cohort is not a
reason to leave it in place.

## What this PR (fix/sp-forecast-fuzzy-resolver) ships

1. **Resolver fix in `services/jobs.js` `forecastForPitcher`**:
   after the two existing exact-match steps, adds an abbreviated-name
   fallback that scans `rosterByNorm` scoped to the given team, matches
   by first-initial + last-name, and resolves only when exactly one
   candidate matches. Ambiguous cases return null (safe — no cross-
   pitcher guessing).
2. **Distinguishable log tag**: `[forecast-null-resolve]` fires on
   every null return, with `reason=unresolved-name` or
   `reason=index-fallback`. Greppable in Render logs so future
   silent-fallback firing is visible even without the health check.
3. **New health check `sp_forecast_resolution`** in `GET /api/health/:date`:
   counts games where an SP name is populated but the forecast IP is
   null. Message includes the pitcher name and side so a triage can
   start from the health-panel view. Severity 'warn' — the model still
   emits signals, but the affected side is priced at the low-conf
   fallback.
4. **Verification harness**: `scripts/test-sp-forecast-abbrev-resolver.js`.
   Covers Yamamoto, current-roster recurring offenders (C. Sanchez,
   E. Rodriguez, S. Arrighetti, J. Misiorowski), a negative case
   ('X. Nobody'), and an ambiguity guard.
5. **SD@LAD SP-weight verification**: with the fix,
   `computeSpPitWeightFromForecast(5.796, S, 15)` returns **0.7796**
   vs the pre-fix null-forecast return of **0.6200**. +16pp on the
   pitching side of the wOBA blend for LAD.

## Files

- Diagnostic script: none written (queries done inline via `node -e`).
- Resolution path: `services/jobs.js:1402` (`forecastForPitcher`).
- Fallback constant: `services/model.js` `SP_FORECAST_LOW_CONF_TARGET = 0.62`
  (set in the PR #144 low-conf fallback fix).
- Roster source: `team_rosters` table populated by the daily roster ingest.
- Prod evidence: `GET /api/games/2026-07-04` shows `home_sp: "Y. Yamamoto",
  home_sp_forecast_ip: null` for `sd-lad`; every other game has full-name
  SPs and non-null forecasts.
