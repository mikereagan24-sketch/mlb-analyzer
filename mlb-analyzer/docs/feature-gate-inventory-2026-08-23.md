# Feature gate inventory + self-reporting health check (2026-08-23)

> **22 gates enumerated. 8 need attention. Nothing flipped.**
> Registry: `services/feature-gate-registry.js`.
> Endpoint: `GET /api/admin/feature-gates`. Logged every morning by the
> 6AM cron.

## Why this exists

The ARI roof scraper hid for most of a season because nothing reported
its own silence. Gated features have the same shape: a flag ships OFF
"pending a backtest", the backtest never runs — or runs and is never
recorded — and the feature becomes indistinguishable from one that was
deliberately rejected.

**Nothing in the codebase could previously answer "which features are
off, and why".** That is the gap this closes.

## The 22

| # | feature | prod value | criterion type | ROI-contaminated | window | decision recorded | bucket |
|---|---|---|---|---|---|---|---|
| 1 | `use_opener_logic` | `true` | mechanism | no | — | 2026-07-05 enabled | deliberate |
| 2 | `catcher_framing_enabled` | `true` | precondition | no | — | 2026-07-05 enabled | deliberate |
| 3 | `park_neutral_inputs_enabled` | `true` | none | no | — | **none** | FORGOTTEN |
| 4 | `signal_venue_aware_enabled` | `true` | mechanism | no | — | 2026-07-07 enabled | deliberate |
| 5 | `kalshi_direct_primary_enabled` | `true` | mechanism | no | — | 2026-07-10 enabled | deliberate |
| 6 | `kalshi_direct_totals_enabled` | `true` | mechanism | no | — | 2026-07-10 enabled | deliberate |
| 7 | `signal_edge_cap_enabled` | `true` | roi | **yes** | — | 2026-07-13 enabled | deliberate |
| 8 | `bullpen_downweight_starters` | `true` | mechanism | no | — | 2026-07-07 enabled | deliberate |
| 9 | `sp_prefer_rotowire` | `true` | mechanism | no | — | 2026-07-04 enabled | deliberate |
| 10 | `defense_frv_enabled` | `(unset — schema default)` | precondition | no | — | **none** | AWAITING |
| 11 | `use_hand_conditional_sp_weight` | `false` | none | no | — | **none** | AWAITING |
| 12 | `ui_highlight_tot_overs_enabled` | `false` | roi | **yes** | — | 2026-07-05 deliberately_dark | deliberate |
| 13 | `signal_edge_hard_cap_pp` | `.08` | roi | **yes** | — | 2026-07-13 shipped_at_0.08 | deliberate |
| 14 | `signal_edge_soft_cap_pp` | `.06` | roi | **yes** | — | 2026-07-13 shipped_at_0.06 | deliberate |
| 15 | `catcher_framing_mute` | `1.0` | none | no | — | **none** | FORGOTTEN |
| 16 | `defense_frv_mute` | `(unset — schema default)` | none | no | — | **none** | FORGOTTEN |
| 17 | `catcher_framing_takes_per_game` | `(unset — schema default)` | none | no | — | **none** | FORGOTTEN |
| 18 | `sp_weight_l` | `0.7` | calibration | no | — | **none** | FORGOTTEN |
| 19 | `bsr_baserunning` | `(not a setting)` | roi | **yes** | 2026-09-14 | **none** | in window |
| 20 | `bullpen_w_proj_w_act` | `0.25` | roi | **yes** | — | **none** | FORGOTTEN |
| 21 | `at_emit_snapshot_columns` | `(not a setting)` | precondition | no | — | 2026-08-23 verified_working_on_emit_path | deliberate |
| 22 | `retractable_roof_config_branch` | `(not a setting)` | none | no | — | 2026-08-20 documented_dead | deliberate |

**Counts:** 13 decided · 6 no criterion ever written · 2 awaiting a
decision · 1 in window. **8 need attention. 6 carry ROI-based criteria.**

## Your three categories

### Deliberately dark — 1

| | |
|---|---|
| `ui_highlight_tot_overs_enabled` | OFF, decision recorded: "backtest showed no edge in overs" |

The only feature that is off *and* has a recorded reason. **But the
evidence was ROI-based**, so per the 2026-08-21 rule it measured
selection, not pricing. The decision stands; its basis needs
re-deriving on a calibration target before "no edge in overs" is
treated as settled.

### Awaiting a decision you never made — 2

**`defense_frv_enabled`** — the stated blocker was *"requires the
fielding_frv table to be populated"*. **`fielding_frv` has 552 rows and
`fielding_frv_snapshot` has 31,839.** The precondition cleared, and the
key is not even present in `app_settings` — it runs on the schema
default. Nobody decided to leave FRV off; the blocker stopped being true
and nothing noticed. This is the closest analogue to the ARI scraper in
the current system.

**`use_hand_conditional_sp_weight`** — shadow logging is live and firing
on essentially every game (`sp_weight_r=0.865`, `sp_weight_l=0.7`, both
differing from `sp_weight=0.8`). **No flip criterion was ever written
down** — no threshold, no window, no owner. The shadow watch accumulates
indefinitely because nothing defines what would end it.

### Simply forgotten — 6

| | |
|---|---|
| `park_neutral_inputs_enabled` | **ON in prod**, help text says *"Do not flip on without an A/B"*, no A/B recorded anywhere |
| `catcher_framing_mute` | prod **1.0** (no muting) vs schema default **0.65** — live divergence, no rationale |
| `defense_frv_mute` | unset; moot today, live the moment FRV flips |
| `catcher_framing_takes_per_game` | unset; the constant has no recorded derivation |
| `sp_weight_l` | prod **0.7** vs empirical benchmark **0.649** — inert now, goes live on flip |
| `bullpen_w_proj_w_act` | still Phase-3-blocked. The *global* pair was unblocked and measured 2026-08-21; the bullpen pair routes through a different blend with a different gate, so nothing transferred |

`park_neutral_inputs_enabled` is the uncomfortable one: it is **on**, in
the pricing path, with a help text that explicitly says not to enable it
without an A/B, and no A/B on record.

### In window — 1

`bsr_baserunning`, closing 2026-09-14. Status in
`docs/bsr-gate-status-2026-08-23.md`; its CLV prong is
selection-contaminated and weighted heaviest.

## The ROI problem is systemic

**6 of 22 gates carry an ROI-based criterion**, which after 2026-08-21
we know measures selection rather than pricing:

`signal_edge_cap_enabled` · `signal_edge_hard_cap_pp` ·
`signal_edge_soft_cap_pp` · `ui_highlight_tot_overs_enabled` ·
`bsr_baserunning` · `bullpen_w_proj_w_act`

Four of those are **already shipped decisions**. They are not
necessarily wrong — a contaminated criterion can still reach the right
answer — but none of them is *supported* by the evidence cited for it.
The edge-cap trio is the most consequential: the 2026-08-22 edge-honesty
scope specifically looked for support for the 8pp level and **found
none** (above-cap honesty is not worse than below-cap).

The registry marks these with `selection_contaminated: true` so the
problem stays visible rather than being rediscovered per-feature.

## The health check

`evaluateGates(db, {today})` classifies each gate:

| status | meaning | flagged |
|---|---|---|
| `decided` | a human recorded an outcome | no |
| `in_window` | evaluation window still open | no |
| `elapsed_no_decision` | **window passed, nothing recorded** | **yes** |
| `awaiting_decision` | **precondition cleared, gate still shut** | **yes** |
| `blocked` | precondition genuinely unmet | no |
| `no_criterion` | **nobody wrote down what would decide it** | **yes** |

Preconditions are **functions of the database**, not stale notes — e.g.
`fielding_frv_populated` counts rows at evaluation time. That is what
catches a blocker that quietly stopped being true.

**Surfaces:**
1. **6AM cron**, unconditionally and first, so it reports even if the
   rest of the chain fails. Non-fatal by construction.
2. **`GET /api/admin/feature-gates`**, with `?attention=1`.

Verified: today it prints 8 flagged gates. Simulating 2026-09-20 — past
the BsR window — it correctly adds `bsr_baserunning` as
`elapsed_no_decision`, which is exactly the class of silence that hid the
ARI scraper.

## How to use it

**When you flip a flag, record the decision in the registry in the same
commit.** A gate with `decision: null` and an elapsed window is a
process bug, and the check is built to say so out loud.

Do **not** fill in a decision to silence the check. `no_criterion` is
information — it means the feature shipped without anyone writing down
what would settle it, and that is worth seeing every morning until it
is fixed.

## What this does not do

- **Does not flip anything.** No gate state changed.
- **Does not re-derive the contaminated criteria.** It marks them.
- **Does not verify prod values** beyond `app_settings` in the local
  snapshot — which is ~2026-08-11 and stale. Run against prod for a
  live reading.
- The registry is **hand-seeded**. A new flag added without a registry
  entry is invisible to the check — the one failure mode it cannot
  catch about itself.

## Related

- `docs/sweep-selection-effect-2026-08-21.md` — why 6 criteria are contaminated.
- `docs/bsr-gate-status-2026-08-23.md` — the one gate currently in window.
- `docs/edge-honesty-scope-2026-08-22.md` — found no support for the 8pp cap level.
- `CLAUDE.md` — "Sweep ROI measures selection, not pricing".
