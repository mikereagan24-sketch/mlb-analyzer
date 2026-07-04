# SEA Tandem Analysis (2026-07-04)

Investigation of Seattle's 6-man piggyback rotation as it appears in the
model's data. Motivating question: is PR #150's low Gilbert opener
share (~0.34) approximately correct for SEA's tandem subtype, or does
the realized data suggest the SP-role forecast blend is the right fix?

## Population

**Two sets scanned across 2026 (from 2026-03-01 to 2026-07-04):**

- **Set A** (opener-flagged): SEA sides with `is_opener_game_*=1`.
  Result: **3** completed games (below) + 1 pending today (Gilbert/Hancock,
  TOR@SEA 2026-07-04).
- **Set B** (broader: both listed pitchers RR rotation SPs, regardless
  of opener flag): **1 additional** (tor-sea 2026-07-04 Gilbert+Hancock,
  already in Set A). No additional un-flagged SEA piggybacks — nothing
  else in the local DB has two SEA rotation SPs pitching on the same
  date.

Note on cadence: owner reports "every 5th-slot turn" ≈ every 5 days. If
that pattern were fully live back to April, we'd expect ~15-20 SEA
tandems in the window. We see 3 — meaning either the 6-man piggyback
started recently or many quiet piggybacks aren't tripping the opener
detector. Either way, this is a **small sample**.

## Realized outings (Set A, completed)

| Date | Game | Opener | IP | BF | pit | Bulk | IP | BF | pit | planned_batters | source |
|---|---|---|--:|--:|--:|---|--:|--:|--:|--:|---|
| 2026-05-19 | cws-sea H | Bryce Miller (SP4) | **5.67** | 19 | 72 | Luis Castillo (SP3-at-time) | **2.33** | 11 | 54 | 4 | PRIM (announced) |
| 2026-05-25 | sea-ath A | Luis Castillo | **4.00** | 17 | 68 | Bryce Miller (SP4) | 5.00 | 18 | 83 | 4 | PRIM |
| 2026-05-31 | ari-sea H | Bryce Miller (SP4) | **5.00** | 17 | 71 | Luis Castillo | 5.00 | 20 | 71 | 4 | PRIM |

Pending today: Gilbert (SP1) opens; Hancock (SP5) bulk-announced PRIM;
`opener_planned_batters_home=4`, `home_opener_forecast_ip=3.38`,
`home_sp_forecast_ip=5.67`, `home_bulk_forecast_ip=5.44`.

## Aggregate (n=3)

- **Opener mean IP: 4.89** | BF 17.7 | pitches ~70
- **Bulk mean IP: 4.11** | BF 16.3 | pitches ~69
- **Realized opener share: 54.3%** (opener_IP / (opener_IP + bulk_IP))
- **Realized bulk share: 45.7%**
- Combined workload: exactly 9.00 IP every game — SEA's tandems close
  out full games between the two pitchers.

**Opener IP distribution**:
- <1 IP: 0
- 1-2 IP: 0
- 2-3 IP: 0
- 3-4 IP: 0
- 4-5 IP: 1  (Castillo 4.00 on 5/25)
- **5+ IP: 2** (Miller 5.00 and 5.67 on 5/31 and 5/19)

**Zero SEA "openers" have gone <4 IP.** The label "opener" is misleading
for this pattern — SEA is running short-side tandem starters, not
classic 1-2-IP opener + long-relief bulk.

## Provenance of `opener_planned_batters`

Not a scraped announcement. **Always the hardcoded default `4`.** Set
in `services/jobs.js` in three code paths:
1. Announced-bulk branch (`jobs.js:4243`): `plannedBatters = 4;` with
   comment `// spec default until per-pitcher tuning lands`.
2. FG-role-reliever pattern-match branch (`jobs.js:4282`): same
   `plannedBatters = 4;` with the identical comment.
3. Manual `opener_override` row (`jobs.js:4047`): whatever value the
   operator inserted (nullable).

RotoWire's PRIM tag is a binary yes/no signal (bulk-announced or not).
It does **not** carry a "how many batters" hint. Neither does statsapi's
probable-SP feed. So `opener_planned_batters=4` in the three SEA
tandems above is uniform default — reflects the spec, not the actual
plan. Every actual outing exceeded 4 batters by a lot (17-19 BF).

## Answer to the fix-direction question

**The blend approach stands.** PR #150's 3.38 forecast for Gilbert
under-predicts by construction — the role='opener' Bayesian shrinkage
pulls his 6.26 EWMA halfway toward the 1.35 IP class anchor. Realized
SEA tandem openers have averaged 4.89 IP, which corresponds to an
opener share of ~54%, not the ~34% PR #150 computes today.

**Numerical mapping** (SEA tandem subtype, from the 3 realized games):

| Approach | Opener share | Bulk share | Total |
|---|--:|--:|--:|
| PR #150 (opener-role forecast × QH / 9) | 0.338 | 0.604 | 0.942 |
| PR #150 with SP-role forecast × QH / 9 | 0.567 | 0.390* | 0.957 |
| **Realized SEA tandem average** | **0.543** | 0.457 | 1.000 |

*Bulk clamped by `9 − opener_IP × QH = 9 − 5.10 = 3.90` when SP-role
forecast used. Gives a modest under-count on bulk; the real bulk gets 4.11 IP.

The SP-role-forecast × QH path (**0.567** for Gilbert) is much closer
to the realized 0.543 than PR #150's opener-role path (**0.338**).

## Suggested follow-up (new PR, not this doc)

Two design options, both fall inside the existing `tandem_subtype='sp_sp'`
gate — no changes needed to detectOpeners or the classic path:

### Option A — SP-forecast blend (simpler)

In `model.js buildOpenerOpts` when `tandem_subtype='sp_sp'`, use the
SP-role forecast instead of the opener-role forecast:

```js
const openerFc = side === 'away' ? game.away_sp_forecast_ip : game.home_sp_forecast_ip;
const bulkFc   = side === 'away' ? game.away_bulk_forecast_ip : game.home_bulk_forecast_ip;
// formula unchanged
```

For Gilbert today: opener_share ≈ 5.67 × 0.90 / 9 = **0.567**.

Downside: does not distinguish a "ramping SP on a pitch limit" (Gilbert
today) from a fully-stretched SP (Miller/Castillo on non-ramp days).
Uses full SP baseline for both. But: (a) realized SEA openers averaged
4.89 IP with no known IL-ramp adjustments, and (b) the confidence
haircut on Gilbert's forecast (n_priors=18) already shrinks his SP
forecast slightly. Simplicity wins here.

### Option B — Planned-batters gate (finer)

Read `opener_planned_batters` and blend between opener-role and SP-role
forecasts by that value:

```js
const planned = game['opener_planned_batters_' + side] || 4;
// planned=4 (default) → blend 50/50 between opener_fc and sp_fc
// planned≥15 → SP forecast dominates
// planned≤4 → opener forecast dominates
```

Currently the default is 4 in every case (see Provenance above), so
this doesn't help until either (a) the RotoWire scraper picks up a real
pitch count from PRIM sub-tags, or (b) the operator manually overrides
via `opener_override.planned_batters`. Neither exists today. This is a
"come back after we can populate planned_batters" fix.

**Recommendation: Option A.** Small edit inside the tandem gate, gets
Gilbert (and any future SEA tandem opener) into the ~0.55 share band
where the realized data lives.

## Caveats

- **n=3 completed tandems.** Small sample; the 54.3% realized share
  could easily be 45% or 65% on the true population. But it's clearly
  not 34% — every observed outing exceeded 4 IP.
- Miller/Castillo tandems may not perfectly represent the Gilbert case:
  Gilbert is IL-ramping (announced pitch limit implicit) while
  Miller/Castillo on 5/19-5/31 were fully stretched. The IL-ramp
  distinction isn't captured in the model — Option A treats them the
  same (both get SP-forecast × QH), which will slightly over-predict
  Gilbert IP tonight. That's the direction the confidence haircut
  already partially corrects (Gilbert's n_priors=18 is high, so
  haircut is small — but he is a rotation SP, not a rookie).
- If SEA starts pushing openers to <4 IP as the season progresses,
  re-run this analysis and consider Option B once planned_batters can
  carry real values.

## Bottom line

**Openers in SEA's tandem subtype have been going 4-5.67 IP — not 1-2 IP.**
The blend approach (use SP-role forecast, not opener-role forecast) is
the right direction for `tandem_subtype='sp_sp'`. `opener_planned_batters`
provenance is a hardcoded default that carries no real information
today, so blending on it would be no-op until a new signal source lands.
