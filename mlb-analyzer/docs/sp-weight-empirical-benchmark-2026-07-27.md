# SP_WEIGHT empirical benchmark — 2026-07-27

**Supersedes:** the modeled benchmark in
`docs/sp-weight-benchmark-correction-2026-07-26.md`, which used the
league-average bullpen composition (69/31) to estimate the correct
handedness-exposure fraction. This doc measures the same quantity
*directly* from `pitcher_game_log` — actual BF-per-pitcher, per game.

**Also note:** per the naming clarification in `CLAUDE.md`, this doc
is *exclusively* about `SP_WEIGHT` (the batter-side handedness weight).
It does not touch `SP_PIT_WEIGHT` (the pitching-side blend). Any
discussion of `sp_forecast_ip`, shrinkage, or compression belongs to
the SP_PIT_WEIGHT thread and does not appear here.

## Method

For every (game_date, team) pair since 2026-04-01 (n=2900 team-games),
compute:
- The starter's handedness (from `team_rosters` / `team_rosters_season`
  by mlb_id — 1250 pitcher mlb_ids resolved)
- Total BF by RHP for that team in that game
- Total BF by LHP for that team in that game
- `same_hand_share = BF_by_starter_hand / (BF_by_R + BF_by_L)`
  (unknown-hand rows excluded from denominator; total 12414 pitcher-game
  rows loaded)

Bucket by starter handedness; aggregate BF-weighted (each PA counts
once) and per-game (each team-game counts once). Report per-team
spread of the opposing pitching staff's same-hand fraction.

## Result

### Per-hand aggregates

| Starter hand | n team-games | BF-weighted same-hand share | per-game avg | delta from 0.80 |
|---|---|---|---|---|
| **RHP** | 2035 | **0.8650** | 0.8678 | **+6.5pp** (0.80 is LOW) |
| **LHP** | 865 | **0.6486** | 0.6583 | **−15.1pp** (0.80 is HIGH) |
| **Volume-weighted overall** (~70/30 R/L SPs) | 2900 | **0.800** | — | **0.0pp** (exact) |

The 0.80 default is precisely the volume-weighted correct value.
Historically undocumented but empirically dead-on for the average game.

### Per-game spread (RHP-starter games)

| Percentile | same-hand share |
|---|---|
| min | 0.156 |
| p05 | 0.647 |
| p25 | 0.809 |
| **median** | **0.889** |
| p75 | 0.958 |
| p95 | 1.000 |
| max | 1.000 |

- p05→p95 spread: **35pp**
- p25→p75 spread: **15pp**
- Median (0.889) is above the mean (0.865) — right-skewed toward high same-hand.

### Per-game spread (LHP-starter games)

| Percentile | same-hand share |
|---|---|
| min | 0.079 |
| p05 | 0.282 |
| p25 | 0.574 |
| **median** | **0.690** |
| p75 | 0.778 |
| p95 | 0.897 |
| max | 1.000 |

- p05→p95 spread: **62pp** (much wider than RHP case)
- p25→p75 spread: **20pp**
- LHP-starter same-hand share is significantly more variable game-to-game.

### Per-team spread (opposing pitching staff's same-hand share, RHP-starter games only)

Extreme teams:

| Team | BF-weighted same-hand share | n games | Roster note |
|---|---|---|---|
| **CWS** | **0.779** (lowest) | 53 | L-heavy pen (4L/4R vs typical 1-3L / 5-7R) |
| MIL | 0.804 | 57 | |
| ... | ... | ... | |
| KC | 0.913 | 63 | |
| SEA | 0.915 | 97 | |
| COL | 0.937 | 66 | |
| **AZ** | **0.958** (highest) | 74 | Very R-heavy pen |

**Cross-team spread: 17.8pp** (0.779 → 0.958). Comparable to the R/L
constant gap (21.6pp). Team-specific data captures roughly as much
signal as R/L conditioning does.

## Reconciliation with the modeled benchmark

The `sp-weight-benchmark-correction-2026-07-26.md` modeled benchmark
used league-avg bullpen composition (69/31 R/L):

| | Modeled (2026-07-26) | Empirical (this doc) | Delta |
|---|---|---|---|
| RHP starter | 0.857 | **0.865** | +0.008 |
| LHP starter | 0.683 | **0.649** | −0.034 |
| Overall | 0.805 | **0.800** | −0.005 |

Model was close on RHP, slightly high on LHP. Likely explanation: when
the starter is L, managers pinch-hit RHBs and bring in RHP relievers,
so the opposing pen leans MORE right than the league average predicts
when there's an L starter to leverage against. The 3.4pp gap on LHP is
this PH-strategy correction — the modeled assumption of "same-hand
bullpen fraction = league average" doesn't hold when there's an L
starter to swap around.

Empirical numbers should replace modeled ones as the benchmark target
for any future design work.

## Implications for the design

1. **The 0.80 volume-weighted overall is empirically correct**, not
   just historically defensible. Not a coincidence.

2. **Per-hand: R undershoots by 6.5pp (should be 0.865), L overshoots
   by 15.1pp (should be 0.649).** A hand-conditional constant is the
   natural next step; empirical data now supports it.

3. **Per-team refinement captures another ~17.8pp of spread** on top of
   the R/L constant. Using the opposing pitching staff's actual
   same-hand share (computed from a rolling window of `pitcher_game_log`)
   gives per-game values that already exist in the data — no
   assumptions needed.

4. **The p05→p95 spread within each starter-hand bucket** (35pp for R,
   62pp for L) is much larger than the R/L constant gap (21.6pp).
   A hand-conditional constant is a good approximation but leaves
   significant per-game structure unmodeled. Per-team refinement is
   NOT a marginal improvement over hand-conditional — it's roughly the
   same magnitude of information.

5. **LHP-starter games have the widest per-game spread** (p05→p95 =
   62pp). If a per-game feature ships, it will move LHP-starter
   pricing more than RHP-starter pricing — worth flagging in shadow
   mode.

## Recommended sequencing (design side)

Unchanged from `sp-weight-hand-conditional-design-2026-07-26.md`:

1. **Phase 1:** Two constants — SP_WEIGHT_R=0.865, SP_WEIGHT_L=0.649.
   Behind flag. Simple, deterministic, no per-game lookup.
2. **Phase 2:** Per-game from opposing team's rolling `pitcher_game_log`
   BF-per-hand share. Fallback to Phase 1 constants when the rolling
   sample is thin or the team-game has anomalous mix.

The empirical benchmark strengthens the case for BOTH phases: Phase 1's
constants are now empirically-grounded (0.865/0.649 vs the modeled
0.857/0.683), and Phase 2's per-team refinement is justified by the
17.8pp cross-team spread that Phase 1 leaves unmodeled.

## Test-time posture

The design halt (`sp-weight-hand-conditional-design-2026-07-26.md`
preamble) still applies: v7 alone has n<40 per candidate for R-facing.
Empirical benchmark strengthens the *direction* argument but doesn't
change the *statistical power* problem for the sweep. Ship when v7
accumulates n≥100 per candidate — roughly 6-8 more weeks. Un-halt
once the numbers can distinguish 0.80 from 0.865.

## Data source and caveats

- Universe: `pitcher_game_log` rows 2026-04-01 → 2026-07-22, batters_faced > 0
- Hand resolution: `team_rosters ∪ team_rosters_season` by mlb_id
  (1250 pitcher mlb_ids resolved out of ~1400 who appeared). Unknown-hand
  BF excluded from denominator (not treated as a hand class).
- Doubleheaders: aggregated to (game_date, team) which collapses both
  games in a DH to a single unit. Small effect on totals; per-team spread
  unaffected because doubleheaders are rare.
- Position-player pitcher garbage-time appearances are included but their
  BF is tiny (~1-2 batters per appearance) and hand-resolution rate is
  similar to real pitchers.
