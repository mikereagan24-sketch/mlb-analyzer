# Cohort v7 — birth certificate — 2026-07-05

The signal-generation stack has materially changed vs v6. Cohort tag
bumped to `v7` for signals emitted on games with `game_date >= 2026-07-06`.
This doc is the birth certificate: what defines v7, what settings state
it was born under, and what accumulation clocks reset.

## Amendment 2026-07-08 — venue-aware pricing enabled inside v7

The `SIGNAL_VENUE_AWARE_ENABLED` toggle
(`services/settings-schema.js`, PR feat/venue-aware-signals) is
flipped ON as of **2026-07-08**. Emitted rows continue to carry
`cohort='v7'` — the owner's explicit call to avoid a v8 split for
one day of Kalshi-baseline signals.

**Known small heterogeneity inside v7**:

- `game_date` in `{2026-07-06, 2026-07-07}` → ~30 signals emitted
  with Kalshi-only ML baseline (the v7-original semantics).
- `game_date >= 2026-07-08` → signals emitted with the venue-best
  (Poly | Kalshi) net-at-size ML baseline, fillable-at-stake
  guarded.

Both populations share cohort='v7'. Backtest segmentation on this
sub-population is available via `bet_signals.price_venue`
(`'poly'`|`'kalshi'`|NULL) and `bet_signals.venue_stale` (0/1). NULL
`price_venue` on a game_date ≥ 2026-07-08 row indicates a Totals
signal (Totals stay Kalshi-baseline in this amendment — see
follow-ups in `docs/venue-aware-signals-2026-07-07.md`); NULL on a
game_date ≤ 2026-07-07 row is a pre-amendment v7 row.

Rationale for staying in v7:
- ~30 pre-amendment rows is a rounding error against the expected
  v7 accumulation window.
- The venue-aware fix is a market-baseline correction, not a
  model-stack change — the underlying model (park-neutral inputs,
  edge cap, opener detection, tandem split, fuzzy resolver, RUN_MULT
  46) is unchanged.
- CLV closing-line capture still Kalshi-baseline in this amendment
  (documented follow-up). CLV on Poly-anchored rows will show a
  venue mismatch until that follow-up lands; call it out when
  reading v7 CLV numbers for the amendment window.

Accumulation clocks noted in the "Standing-watch accumulation
clocks — RESET" section below do **not** reset again for this
amendment. Watches count the whole v7 population.



**Cutover boundary**: `game_date >= '2026-07-06'` → cohort `'v7'`.
Games with `game_date <= '2026-07-05'` continue to emit as `'v6'`.
Signals emitted during the brief RUN_MULT=50 window (2026-07-04 → 2026-07-05)
had `game_date <= 2026-07-05` and remain `v6` correctly — no leak into v7.

**Ship discipline**: this is a small bounded PR — cohort ladder bump in
`services/jobs.js:896` plus default-cohort updates in
`routes/api.js:1071/1171` and the backtest cohort dropdown in
`public/index.html:363`. Verified locally before push (see Verification
section). Post-merge follow-ups are their own PR.

## What defines v7 (birth certificate)

Material changes shipped between the v6 boundary (2026-05-30) and v7:

| Feature | State at v6 birth | State at v7 birth | PRs |
|---|---|---|---|
| Park-neutral wOBA inputs | schema key existed, OFF | **LIVE**: actuals-only, PA-weighted stints | #142, #144, #146 |
| Edge-sanity cap | schema keys existed, OFF | **LIVE**: soft 0.06 / hard 0.25* | #145 (settings-only flip) |
| Opener detection | pattern-match only | + RR-rotation gate with precedence fix | #148, #149 |
| SP-SP tandem forecast split | did not exist | **LIVE**: SP forecast source + flat per-position weights | #150, #151 |
| SP-forecast fuzzy resolver | exact-match only (silent nulls) | **LIVE**: abbreviated-name fallback + health check | #154 |
| Framing | mute=1.0 but data thin | mute=1.0, coverage 75%+ from 2026-06-17 ingest | pre-v6, effectively live |
| HFA | 0.02 (schema default) | 0.017 (recalibrated) | (settings-only, historical) |
| RUN_MULT | 46 (v6-era) | 46 (v7-era; brief 50 window reverted) | schema default 45.5, prod historically 46 |

*Note on soft cap: the user's v7 definition specified `signal_edge_soft_cap_pp = 0.06`.
Prod snapshot at cutover (below) shows **0.10**. This is a settings-only
flip that must happen before or with the code deploy to make v7's
signal population match the definition. Called out in Verification.

## Prod settings snapshot at cutover (curl `/api/settings` on 2026-07-05)

Filtered to model-relevant keys (secrets and audit stamps redacted):

```
# Weights & blends
w_pit                      = 0.40
w_bat                      = 0.60
w_proj                     = 0.45
w_act                      = 0.55
sp_weight                  = 0.80
relief_weight              = 0.20
sp_pit_weight              = 0.75
relief_pit_weight          = 0.25
bp_strong_weight_r         = 0.55
bp_weak_weight_r           = 0.45
bp_strong_weight_l         = 0.35
bp_weak_weight_l           = 0.65

# Opener/tandem
opener_pit_weight          = 0.15
bulk_pit_weight            = 0.60
opener_relief_pit_weight   = 0.25
use_opener_logic           = true

# Runs formula
run_mult                   = 46
woba_baseline              = 0.230
pyth_exp                   = 1.83
wind_scale                 = 2.0
tot_slope                  = 0.08
tot_prob_lo                = 0.20
tot_prob_hi                = 0.80
wp_clamp_lo                = 0.25
wp_clamp_hi                = 0.75
hfa_boost                  = 0.017
fav_adj                    = 8
dog_adj                    = 4
market_total_dflt          = 8.5
bat_dflt_start             = 0.285
bat_dflt_opp               = 0.310
unknown_pitcher_woba       = 0.335
min_pa                     = 60
min_bf                     = 100
bullpen_avg                = 0.318
pa_weights                 = [4.65,4.6,4.55,4.5,4.25,4.13,4,3.85,3.65]

# Per-hand batter/pitcher defaults
bat_dflt_l_vs_lhp          = 0.290
bat_dflt_l_vs_rhp          = 0.330
bat_dflt_r_vs_lhp          = 0.325
bat_dflt_r_vs_rhp          = 0.305
bat_dflt_s_vs_lhp          = 0.308
bat_dflt_s_vs_rhp          = 0.322
pit_dflt_l_vs_lhb          = 0.285
pit_dflt_l_vs_rhb          = 0.330
pit_dflt_r_vs_lhb          = 0.320
pit_dflt_r_vs_rhb          = 0.295

# Feature flags
park_neutral_inputs_enabled = true            ← v7-defining
signal_edge_cap_enabled     = true            ← v7-defining
signal_edge_soft_cap_pp     = 0.10            ← v7 spec is 0.06 (see note)
signal_edge_hard_cap_pp     = 0.25
catcher_framing_enabled     = true            ← v7-defining
catcher_framing_mute        = 1.0

# Signal emission
signal_emit_floor_pp        = 0.01
ui_highlight_ml_fav_min_pp  = 0.02
ui_highlight_ml_dog_min_pp  = 0.045
ui_highlight_tot_under_min_pp = 0.07
ui_highlight_tot_overs_enabled = false

# Data source flags
sp_prefer_rotowire         = true
kalshi_direct_primary_enabled = true
kalshi_direct_totals_enabled  = true
```

Full raw fetch also captured in `tmp/settings-snapshot-cohort-v7.json`
(not persisted to repo).

## edge_pct convention: fractional (unchanged from v6)

v7 inherits v6's fractional edge encoding. `insertSignal` writes
`edge_pct: sig.edge` where `sig.edge` comes directly from
`getSignals` — which returns a fraction (0.0104 for 1.04pp). This is
consistent with the v5+ convention documented in
`scripts/edge-calibration-curve.js:26`:
`PP_COHORTS = new Set(['v1','v2-tainted','v3','v3-pretuning','v4'])` —
v5, v6, and v7 are all fractional. No change needed to the
calibration-curve script; v7 rows will normalize identically.

## Standing-watch accumulation clocks — RESET

The following watches count v7 signals only from cutover forward.
Prior v6 counts do NOT carry over.

- **Sub-1pp Totals watch** (`docs/sub-1pp-totals-stress-2026-07-05.md`):
  trigger at n ≥ 250 v7 signals with ROI ≥ 10% net_morning at p < 0.01.
  Prior v6 count of 130 does not roll forward.
- **Edge-calibration curve re-runs** (`scripts/edge-calibration-curve.js`):
  reset. Next re-run should target v7 only. Recommended trigger: 2-3
  weeks of v7 accumulation (≈150-300 signals expected based on v6 pace).
- **Emit-floor sweep** (`docs/signal-emit-floor-sweep-2026-07-05.md`):
  reset. Recommendations pending v7 re-evaluation.
- **Edge-cap SOFT threshold study** (`docs/emit-floor-reconciliation-2026-07-05.md`):
  reset. The 3-6pp Total band flagging recommendation targets v7 data.

The **July 19-20 check-in** (2 weeks post-flip) reads v6 for HFA and
park-neutral re-verifications — those measure GAMES, not signals, so
they use the resolved game population regardless of cohort. Any
signal-calibration work at that check-in must wait for v7 volume.

## Verification

1. **Code review** — three files touched:

   ```
   services/jobs.js:896-916    cohort ladder: v7 added at top; comment
                                block documents v7 birth certificate
                                pointer.
   routes/api.js:1067-1071      /backtest cohort filter default v6 → v7,
                                comment updated.
   routes/api.js:1170-1171      /backtest/lineup-sensitivity mirror.
   public/index.html:363-368    bt-cohort dropdown: v7 (current) selected;
                                v6 preserved for legacy inspection.
   ```

2. **Fractional edge_pct verified** — `services/jobs.js:873` writes
   `edge_pct: sig.edge`. `services/model.js` `getSignals` returns
   `sig.edge` as a fraction (see `signals.push({... edge:
   parseFloat(overEdge.toFixed(4)) ...})` at model.js:1028/1031).
   No cohort-specific transform; v7 rows will match v6's scale.

3. **Newly-emitted signal carries cohort='v7'** — the cutover expression
   is `gameRow.game_date >= '2026-07-06' ? 'v7' : ...`. Any game_date
   ≥ 2026-07-06 emitted after this deploys tags v7. Anything earlier
   stays on its historical cohort. Deterministic and self-contained.

4. **Old rows untouched** — cohort is written by `q.insertSignal.run(...)`
   only. No `UPDATE bet_signals SET cohort=...` exists anywhere in the
   code (verified via grep). Row insertion updates on re-score go
   through `INSERT OR REPLACE`, but the cohort computation uses
   `gameRow.game_date` which is stable — so replacing a row uses the
   same cohort it originally had unless the game_date changes (it
   doesn't).

5. **Backtest UI can filter v7** — `/backtest?cohort=v7` returns only v7
   rows once they exist; `?cohort=v6` remains available for legacy
   inspection; `?cohort=all` unchanged.

6. **RUN_MULT=50 window signals stayed v6** — signals emitted on
   game_date 2026-07-04 and 2026-07-05 (during the flip window) are
   v6 by the date cutover, correctly. Verified: the v7 boundary is
   2026-07-06, strictly after the flip window closed.

7. **Soft-cap gap warning** — prod's `signal_edge_soft_cap_pp` was 0.10
   at cutover snapshot time, but the user's v7 definition specifies
   0.06. **Flip via the settings UI before the first v7 signals emit**
   (or accept that early v7 signals will be under the 0.10 SOFT
   threshold and re-flag once dropped). No code change involved.

## Follow-ups (their own PR)

- Once v7 volume ≥ 50 signals: initial spot-check of v7 win rate vs v6
  same-band comparison. If v7 flips substantially in either direction,
  investigate before the 2-3 week window closes.
- Once v7 volume ≥ 150: re-run edge-calibration-curve on v7 only,
  update `signal_edge_soft_cap_pp` recommendation.
- Owner watch: framing coverage percentage climbs. Once ≥ 90% of
  games have framing data, the `catcher_framing_mute=1.0` at full
  weight is genuinely live. Currently ~75% July coverage per
  `docs/framing-mute-semantics-2026-07-05.md`.

## Files

- Code changes: `services/jobs.js`, `routes/api.js`, `public/index.html`
- Doc: this file
