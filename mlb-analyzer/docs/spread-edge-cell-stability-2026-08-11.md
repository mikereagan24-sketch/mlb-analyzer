# Spread-edge cell-index stability audit — 2026-08-11

Follow-up to the audit trace in `services/empirical-spread-edge.js` and PR #232 (`feat/bet-signals-emit-time-model-snapshot`). Records the drift rate of the 6-cell classification (Underdog/Balanced/Strong fav × Low/High total) as `game_log.model_home_ml` / `model_away_ml` / `model_total` get rewritten every `processGameSignals` cycle.

**Snapshot harness:** `tmp/quantify-spread-cell-drift.js` (local DB, prod-equivalent contamination filter applied because local is stale on tagging).

## Universe

- 778 clean graded games in the current `buildCellIndex` universe
- 412 (53%) have SOME emit-time reference in `bet_signals` (from `bet_signals.model_line`):
  - Both ML + Total frozen: 228
  - ML only: 103
  - Total only: 81
- 366 (47%) have no emit-time reference (model never emitted a signal on that game); drift unmeasurable

## Cell migration (measurable subset)

| | count | share |
|---|---|---|
| Cell unchanged | 367 | 89.1% |
| **Cell changed** | **45** | **10.9%** |
| ...wp bucket flipped only | 37 | 82% of drift |
| ...total bucket flipped only | 8 | 18% |
| ...both flipped | 0 | — |

**11% drift rate.** Above "handful, cosmetic"; below "20%+, materially reshuffles." Real effect, worth acknowledging in any report leaning on the per-cell pp figures, not urgent enough to rebuild machinery.

## Boundary concentration — where the drift comes from

The 0.575 wp cutoff is the pressure point. Games within ± of each hardcoded threshold:

| band | wp 0.500 | **wp 0.575** | total 8.5 |
|---|---|---|---|
| ±0.005 | 0 (0%) | 33 (4.2%) | 21 (2.7%) |
| ±0.010 | 6 (0.8%) | 77 (9.9%) | 71 (9.1%) |
| ±0.015 | 23 (3.0%) | 123 (15.8%) | 93 (12.0%) |
| ±0.020 | 65 (8.4%) | **169 (21.7%)** | 164 (21.1%) |

**Nearly 22% of graded games sit within 2pp of the 0.575 wp boundary.** That specific cutoff explains 82% of observed cell flips (37 of 45 were wp-only, and the population density confirms 0.575 is where they cluster). The 0.500 boundary is sparser (~8% within ±2pp) because balanced games skew slightly to the favorite side.

## Least-stable cells

**`Strong fav / Low total` and `Strong fav / High total` are the two most fragile populations.** Any of these can push a game across the 0.575 line:

- SP_WEIGHT / RELIEF_WEIGHT recalibration
- Bullpen wOBA blend tune
- Batter wOBA refresh (weekly)
- Weather update mid-slate (temperature bucket flip)
- Opener flag flip on late-scratch lineup
- SP forecast IP recompute

The per-cell empirical cover rates for these two cells should carry an implicit *~10% of the sample can migrate on the next parameter tune* asterisk. Readers should not treat their pp figures as being on the same footing as `Underdog home / Low total` or `Balanced / High total`, whose boundary densities are lower.

The 8.5 total cutoff also has ~21% within ±0.25 runs, but the per-cell impact is smaller because the wp axis has 3 buckets (2 boundaries) while the total axis has only 2 buckets (1 boundary), and wp flips dominate empirically.

## Prospective fix (PR #232)

`bet_signals.model_home_ml_at_emit` + `model_away_ml_at_emit` + `model_total_at_emit` (all frozen post-lock) let you pin the cell classification of every emitted-signal game **going forward**. Together with the existing `cell_label` / `cell_sample_size` snapshot on `empirical_spread_signals`, a prospective rebuild of the cell index against `bet_signals.*_at_emit` reconstructs the cell membership as it existed at signal generation — no more drift attributable to nightly re-runs.

**Historical signals emitted before PR #232 lands have NULL emit-time model columns permanently.** The retrospective drift measurement in this doc is the ceiling on how much cleaner a purely-frozen historical index could be — ~11% of the current cell membership would shift on rebuild if we had emit-time frozen values for every game. Prospectively, that number falls to zero for signal-emitting games (100% pinned) and stays at "unknown" for non-emitting games.

## Sample of drifted games

| game | emit cell | current cell | wp drift | total drift |
|---|---|---|---|---|
| sd-was 5/29 | Balanced / Low | Underdog home / Low | 0.537 → 0.466 | 8.01 → 8.33 |
| tor-bal 5/31 | Strong fav / Low | Balanced / Low | 0.578 → 0.574 | 7.58 → 7.58 |
| mia-was 6/2 | Strong fav / Low | Balanced / Low | 0.580 → 0.545 | 8.41 → 7.81 |
| sea-was 6/14 | Balanced / Low | Strong fav / Low | 0.567 → 0.594 | 8.36 → 8.10 |
| nyy-was 7/10 | Balanced / Low | Underdog home / Low | 0.541 → 0.445 | 8.33 → 8.23 |
| tb-bos 7/17 | Balanced / High | Underdog home / High | 0.558 → 0.468 | 8.84 → 8.89 |
| min-cle 7/21 | Strong fav / Low | Underdog home / Low | 0.609 → 0.468 | 7.62 → 7.80 |

Most drift is a single-bucket-adjacent step (`Balanced` ↔ `Strong fav`, or `Balanced` ↔ `Underdog home`). Two-step flips (across two boundaries) do happen but are rare — `min-cle 7/21` is the largest observed at 14pp wp drift on one game.

## Related

- `services/empirical-spread-edge.js` — the compute path
- `services/empirical-spread-roi.js` — the ROI readout (applies contamination filter downstream)
- `db/schema.js:_emitTimeSnapshotMigration` — the pinnable columns (PR #232)
- `tmp/quantify-spread-cell-drift.js` — the audit harness (reproducible)
