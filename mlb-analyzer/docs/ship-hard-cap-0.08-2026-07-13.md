# Ship: `signal_edge_hard_cap_pp` 0.25 → 0.08 — 2026-07-13

Owner-approved ship from the weight-sensitivity holdout backtest. No code change — settings-value flip via the app's settings tab.

## Ship

- `signal_edge_cap_enabled` = **true** (already true in prod — no change)
- `signal_edge_hard_cap_pp` = **0.08** (was 0.25)
- `signal_edge_soft_cap_pp` = **0.06** (unchanged)

## Data supporting the ship

Holdout backtest (fit Apr-Jun n=522, val Jul n=74) from PR #174:

| metric | current cap=0.25 | new cap=0.08 | delta |
|---|---|---|---|
| Val book ROI | -5.07% | **+0.28%** | **+5.35pp** |
| Val 1-2pp band ROI | +21.17% | +21.17% | 0 (unchanged) |
| Val 1-2pp band n | 12 | 12 | 0 (unchanged) |
| Val big+FAV subset ROI | 0.00% (n=4) | 0.00% (n=4) | 0 (unchanged) |
| Val big+DOG+HOME n | 13 | 1 | 12 losing signals dropped |
| Signals suppressed (Val) | 0 | 21 | all in 6-10 + 10+ bands |
| Fit ROI (in-sample) | +0.37% | +0.99% | +0.62pp |
| In-sample optimism | — | 0.71pp | (fit − val; modest, not overfit) |

Zero touch on the productive 1-2pp band, zero touch on the big+FAV band, 12 of 13 big+DOG+HOME losing signals dropped, book recovers +5.35pp out-of-sample.

## Owner UI flip instructions

1. Open the app → **Settings tab** → scroll to the "Model" section, "Continuous-edge signals" subsection.
2. Locate **"Edge hard cap (prob pts)"** — currently 0.25.
3. Change to **0.08**.
4. Confirm **"Edge-sanity cap enabled"** is still checked (should already be on).
5. Click **Save settings** at the bottom.

## Observable verification protocol (owner's explicit ask)

Two-mode harness: `tmp/verify-hard-cap-live.js`.

### MODE 1 — synthetic (code-level enforcement) — RUN PRE-MERGE

Constructs a synthetic 9pp-edge signal and a 30pp-edge signal, calls `model.getSignals()` with two settings shapes, asserts suppression behavior matches the ship intent. **Ran pre-PR** with these results:

```
9pp edge:
  cap=0.25  emitted ML sigs: 1  suppressed ML: 0
  cap=0.08  emitted ML sigs: 0  suppressed ML: 1
  ✓ cap=0.25: 9pp signal EMITS (below old hard cap)
  ✓ cap=0.08: 9pp signal SUPPRESSES (above new hard cap)
  ✓ cap=0.08: reason=edge_hard_cap present in outSuppressed[0]

30pp edge:
  cap=0.25  emitted ML sigs: 0  suppressed ML: 1
  cap=0.08  emitted ML sigs: 0  suppressed ML: 1
  ✓ cap=0.25: 30pp signal SUPPRESSES (baseline sanity)
  ✓ cap=0.08: 30pp signal SUPPRESSES (baseline sanity)
```

All 5 assertions pass. The code path enforces the cap correctly under both threshold values. The 9pp scenario is the definitive proof: **a signal that currently emits (edge in 0.06 < 9pp < 0.25) will suppress after the flip**, with a `reason=edge_hard_cap` marker on the suppressed audit entry.

### MODE 2 — live (post-flip observable) — RUN POST-FLIP

After owner saves the settings change:

1. Pull a fresh prod DB: `bash refresh-db.sh && mv data/mlb.db.new data/mlb.db`
2. Wait for the next odds cron (8/11/15/17 PT) so signals get emitted under the new cap
3. Re-run `tmp/verify-hard-cap-live.js` — MODE 2 will report:
   - Current live value of `signal_edge_hard_cap_pp` — must equal 0.08 (proof of flip)
   - Recent `suppressed_edge_cap` audit rows

**Owner-facing proof query** (SQL for the observable):

```sql
SELECT COUNT(*) FROM bet_signal_audit
WHERE action = 'suppressed_edge_cap'
  AND created_at > '<flip_timestamp_UTC>'
  AND JSON_EXTRACT(detail, '$.edge') BETWEEN 0.08 AND 0.25;
```

**Non-zero result = the new cap is catching rows the OLD cap would have missed.** The reference `docs/data/pythag-holdout-grid.tsv` shows ~21 signals in this window per Jul-2026 slate. Expect similar volumes post-flip.

If `signal_edge_hard_cap_pp` in `app_settings` reads 0.08 AND the query returns >0 rows within a full day of odds crons AND those rows have edges in [0.08, 0.25) — cap is enforcing. Ship confirmed live.

## Rollback

Settings-only change. To revert: flip the value back to 0.25 in the UI, save. No code change to roll back, no deploy required. Instant.

## What this does NOT fix

- **Pythag 1.65** — deferred pending time-honest runModel infrastructure (per PR #174 analytic-proxy ambiguity). Owner ruling: only ship Pythag when real-model harness can validate it properly, because it's a global lever with real downside if wrong.
- **2-3pp band -20%** — a different mechanism (likely emit-floor meets noise-floor); needs its own investigation.
- **NYM team-specific bleed** — needs input-audit follow-up.

Cap is the belt. The suspenders are deferred.

## Files

- `docs/ship-hard-cap-0.08-2026-07-13.md` — this doc
- `tmp/verify-hard-cap-live.js` — MODE 1 + MODE 2 harness
- References: `docs/weight-sensitivity-2026-07.md`, `docs/data/pythag-holdout-grid.tsv` (PR #174)
