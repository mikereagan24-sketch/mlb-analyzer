# mlb-analyzer — Claude Code project rules

## SP_WEIGHT vs SP_PIT_WEIGHT — do not conflate (2026-07-27)

Two similarly-named settings that measure entirely different things.
Distinguish them before doing any analysis; conflation has caused real
errors (see `docs/sp-weight-mechanism-rationale-2026-07-25.md`
retraction and the docs it links).

**`SP_WEIGHT` (schema `sp_weight`, default 0.80)** — batter-side
handedness weight. In `services/model.js:perBatterEW:498-502`:
`batW = vsStart * SP_WEIGHT + vsOpp * RELIEF_WEIGHT` where `vsStart` is
the batter's split against the *starter's handedness* and `vsOpp` is
against the opposite hand. It controls which of the hitter's platoon
splits is weighted. The correct benchmark is: *when a RHP starts, what
fraction of the game's PAs are thrown by right-handed pitchers*
(starter + same-hand relievers). Empirical benchmark from
`pitcher_game_log` BF data: **0.865 vs RHP, 0.649 vs LHP,
0.800 volume-weighted overall** (docs/sp-weight-empirical-benchmark-2026-07-27.md).
**Has no dependency on `sp_forecast_ip`.** Bullpen composition, LOOGY
usage, and PH strategy determine the true value.

**`SP_PIT_WEIGHT` (schema `sp_pit_weight`, default 0.80,
production effective ~0.71)** — pitching-side SP-vs-bullpen blend. In
`services/model.js:runModel:1045`: computed per game via
`computeSpPitWeightFromForecast(game.sp_forecast_ip, settings, n_priors)`.
Controls how much of the opposing pitching quality comes from the
starter's wOBA-against vs the bullpen's. **No handedness component.**
Depends entirely on `sp_forecast_ip` (a Bayesian-shrunk innings-per-start
forecast from `services/model.js:forecastSpIP`). Currently subject to
shrinkage-ceiling compression (max forecast ≈5.93 IP → max weight ≈0.79),
so the schema's 0.95 clamp is dead code.

**Rule:** any doc, sweep, or design that says "SP_WEIGHT" should name
which one. Mechanism analyses of one CANNOT be repurposed for the
other. Backfilling `sp_forecast_ip` affects `SP_PIT_WEIGHT` only; it
does not change `SP_WEIGHT` computations at all.

## Settings-key UI-parity rule (2026-07-04)

**Any PR that adds a new key to `services/settings-schema.js` MUST also add
its UI control to `public/index.html` in the same PR.** Schema-only settings
are invisible to the user and stay dark in prod — this has now happened at
least twice (`park_neutral_inputs_enabled` shipped in PR #142/#144/#146 with
no UI; `signal_edge_cap_enabled` + `signal_edge_soft_cap_pp` +
`signal_edge_hard_cap_pp` shipped in PR #145 with no UI). Both required a
dedicated later PR (`feat/expose-dormant-settings`) to become reachable
without a raw API call.

For each new schema key, add three things in `public/index.html`:

1. **HTML input** in the settings form (`sec-model` card). Match the existing
   layout patterns:
   - Numeric → `<div class="setting-row"><label title="...">Label</label>
     <input type="number" id="s-...">` — inside the "Formula parameters" or
     an equivalent group.
   - Boolean → checkbox in a `grid-column:1/-1` flex row alongside the other
     toggles (see `s-hl-tot-overs` for the pattern).
   - Free-form text (API keys, JSON) → follows the `s-odds-api-key` shape.
2. **Schema-map entry** in `_SETTINGS_SCHEMA_ID_MAP` (~line 3504) so
   `_applySettingsSchema` wires up min/max/help/invariant from the schema.
3. **`loadSettings` + `saveSettings` wiring**:
   - `loadSettings`: `set('s-...', s.your_key)` for numeric/text; for
     booleans, `.checked = s.your_key === 'true' || s.your_key === true`.
   - `saveSettings`: include `your_key: get('s-...')` for numeric/text or
     `your_key: (document.getElementById('s-...')||{}).checked ? 'true' : 'false'`
     for booleans.

If the setting is a feature toggle intended to ship OFF until validated by
backtest, that's fine — the UI control still ships in the same PR (default
unchecked). The rule is about *reachability*, not about the flip.

## Demotion-pre-flight rule (2026-07-11)

**A PR that removes or NULL-writes a data source in a betting-path column
MUST verify that the replacement path is LIVE in prod BEFORE landing.**
Replacement-live means: the feature flag that gates it is `true` in
`app_settings` on prod AND the flag has been enabled long enough that
recent cron logs show it writing the target column across the slate.

Reason: PR #169 (feat/demote-unabated-from-betting-path) NULLed the
Unabated writes to `market_total` under the correct ruling that Totals
must only price against Kalshi/Poly. The replacement writer
(Kalshi-direct totals override) was gated by
`kalshi_direct_totals_enabled=false` in prod — the setting had never been
enabled and had no UI control. Result: on the first post-merge cron,
market_total was NULL on all 16 games; the slate lost its Totals
signals entirely until the flag flip landed. Prod stayed up (no boot
crash) so the incident was silent-degradation, not an outage.

Pre-flight checklist for any demotion PR:

1. **Identify the replacement writer** by name (function + file + line).
2. **Trace the flag chain**: what setting gates it, and what is that
   setting's live value in `app_settings` on prod?
3. **If the flag is OFF**: (a) enable it FIRST as a separate PR + prod
   flip, (b) let a full odds-cron cycle populate the target column,
   (c) confirm coverage across the slate, THEN (d) ship the demotion.
   Order matters — do NOT bundle the flag flip with the demotion.
4. **If the setting has no UI control**: add it in the pre-flight PR
   (per the UI-parity rule above). No dark flips.
5. **Post-demotion first-run verification** on the first cron after
   deploy: target column populates across the slate, no unexpected
   NULLs, fees/rounding sane.

Where this applies today: `market_away_ml`/`market_home_ml`,
`market_total`/`over_price`/`under_price`, `market_*_spread`, and any
future column whose consumer treats NULL as "no bettable baseline".

## Post-lock immutability rule (2026-07-12)

**Any code path that writes to `bet_signals` MUST enforce post-lock
immutability on the baseline fields — `market_line`, `edge_pct`,
`price_venue`, `venue_stale` — once `game_log.odds_locked_at IS NOT NULL`,
AND post-bet immutability on the same fields once `bet_signals.bet_locked_at
IS NOT NULL`.** The owner's PR #164/#228 ruling ("one market number
pregame, frozen at T-10") applies to BOTH locks, not just the manual
bet-log lock.

Fields that DO flow post-lock (whitelist):

- `outcome`, `pnl` — game grading writes via the graded-game branch
- `closing_line`, `clv` — captured once by `cron_closing_lock` at
  odds_locked_at time; may be re-computed post-grade
- `companion_spread_outcome`, `companion_spread_pnl` — runline grading
- `is_active`, `notes` — soft-delete via `deactivateSignal`
  (leaves the baseline fields alone; only marks the row inactive)
- `bet_line`, `bet_locked_at` — the manual bet-log lock itself

Everything else on `bet_signals` MUST be immutable once either lock
is set. If a new writer needs to break this rule, it needs its own
audit + owner-approved carve-out.

Reason: PR #164/#228 established the ruling for `bet_locked_at`. The
guard was never wired to `odds_locked_at`, and for four months
(2026-04 → 2026-07) `processGameSignals` kept rewriting `market_line`
post-lock. 34 corrupted rows before the guard landed. `closing_line`
was clean throughout (captured once at lock from the frozen
`game_log.market_*_ml`), so the bettor's real reference was preserved
— but the tracked "current market" number was garbage on those 34 rows.

Pre-flight for any PR that adds a new `bet_signals` writer:

1. **List every field the writer sets.**
2. **Cross-check against the whitelist above.** Any non-whitelisted
   field needs an `odds_locked_at IS NULL AND bet_locked_at IS NULL`
   guard, or the write is a corruption vector.
3. **Add a test** that seeds a locked-but-unfinal row, calls the
   writer with values that WOULD move the baseline fields, and asserts
   they don't move. The `tmp/verify-post-lock-immutability.js`
   harness is the template.
4. **If the writer is a manual user-authorized override**
   (e.g. `POST /signals/manual`), that's fine — the ruling only
   binds automated writers. User writes are the source of truth.

## Skewed-residual analysis discipline (2026-08-06)

**Run-total residuals are right-skewed with a hard floor around 4-6
total runs and a long upper tail (20+ run blowouts happen).
MEAN-based residual analysis on this data systematically reads as
under-forecast bias even when the model is per-game centered. Always
report median AND sign-split alongside mean, and check whether the
finding survives removing blowouts, before proposing any level or
temp-curve correction.**

Reason: Phase C1 produced two confident wrong conclusions in a single
2026-08-06 session — a "global under-forecast of ~0.9 runs" reading
from mean residual = +0.815 (median was +0.190, sign-split 51/49,
non-blowout mean −0.309), and a "temp slope of 0.0197 runs/°F"
reading from OLS on individual rows (median-based bucket slope was
−0.00054, effectively zero). Both would have driven changes that
removed the working Under-lean (Unders emit 258:113 over Overs in
the same window and lose −4.6% ROI vs Overs' −9.5%). See
`docs/retraction-c1-mean-bias-findings-2026-08-06.md` for the full
retraction and `docs/shadow-mode-90f-ceiling-2026-08-06.md` for the
one open temp-curve question (90°F+ ceiling) that survived the
distributional cross-check.

Required for any run-total residual analysis:

1. **Mean AND median** side-by-side, overall and per bucket. A big
   mean-median gap indicates skew, not bias.
2. **Sign-split** (% with residual > 0 vs < 0). A calibrated model
   should be near 50/50 even if the mean is nonzero. Under 55% or
   over 45% is the informative range; near 50 is centered.
3. **Trimmed mean** (5%/5% and 10%/10%). If the untrimmed and
   trimmed means diverge by more than ~0.3 runs, the mean is
   tail-driven.
4. **Blowout-excluded mean.** Drop rows with `actual_total ≥ 15`
   (top-decile-of-outcomes for MLB) and re-report the mean. If the
   sign flips or the magnitude collapses, the "bias" was blowout
   attribution.
5. **For SLOPE fits**, cross-check OLS-on-individual-rows against
   weighted-OLS-on-bucket-medians. If slopes differ materially, the
   OLS slope is capturing intercept-shift-across-buckets from tail
   skew, not a genuine relationship.
6. **Signal-side check.** If a proposed change would flip signal
   distribution (e.g. more Overs by fixing a supposed under-forecast),
   verify the target side is currently outperforming the emitted side
   in the same window before recommending. A "fix" that removes a
   working feature is a net loss regardless of the residual math.

The reference analysis template is
`tmp/temp-attribution-c1-distributional-2026-08-06.js` — copy its
statistics block for any future residual-driven proposal.

## Subset sign-flip rule (2026-08-19)

**A finding from a conditional subset (typically n ≈ 25-30) can
invert the sign of the effect visible in the full sample. Any
subset-derived directional claim — "under-forecast at this park",
"sens too low", "Over side outperforms", "this cohort responds
more strongly" — must be cross-checked against the unconditioned
population before reading direction from it.**

Reason: the 2026-08-19 per-park sens-audit intercepts flagged five
parks as having positive residual at wind_vec=0 (was +3.11, pit
+3.06, nym +2.28, nyy +2.10, bal +1.93) on the wind ≥ 8 mph
subset (n ≈ 25-30 per park). Cross-checked on the ET open-air
population without the wind restriction (n ≈ 50 per park, blowouts
excluded), four collapsed to near-zero medians and one (nyy)
FLIPPED SIGN — no-blowout median −1.09, sign split 43% positive,
all four measures agreeing on a mild over-forecast. The subset
intercept was noise-inflated not just in magnitude but in direction.

The mechanism: small conditional subsets aren't just noisy versions
of the population. The conditioning variable can systematically
re-sort the tail — windy games happen to be the ones where the
model over-attributes something else (bullpen, temp, park drift),
and that over-attribution rides the subset. This is separate from
the mean-skew phenomenon (though they compound); a median-first
analysis on the SUBSET alone will not save you.

Required for any subset-derived directional finding:

1. **Re-measure on the unconditioned population** (same universe,
   drop the subset filter). Report central tendency and sign there.
2. **If sign flips** — stop. The subset finding is likely
   conditional-selection artifact. Do not propose a fix based on
   the subset's direction.
3. **If sign holds but magnitude collapses** — the subset was
   reading a real direction but overestimating. Adjust
   interpretation, don't ship the subset's numerical estimate.
4. **If sign holds and magnitude holds** — the finding is likely
   genuine. Even then, prefer the unconditioned estimate for any
   downstream calibration; the subset is at best a corroborator.

This compounds with the skewed-residual discipline above: run
median-first on the FULL sample first, then on the subset if you
must, and reconcile the two before acting.

## Read-only investigation proceeds without asking (2026-08-18)

**File reads, greps, globs, and read-only DB queries via the admin query
endpoint (`GET /api/admin/query/<name>`) should proceed without asking.**
Don't stop to ask "want me to check X?" before looking at something — just
look and report. This includes reading `PLAN.md`, tracing a symbol across
files, inspecting `services/*` to confirm current behavior, or pulling a
2KB JSON slice from the admin query endpoint to verify a claim.

Reserve confirmation requests for actions that change state:

- File edits, new files, deletions
- Git commits, pushes, branch operations
- Prod writes (settings flips, `POST /admin/*`, DB mutations)
- Anything touching the pricing hot path
- Settings changes (`app_settings`, schema keys)

Rationale: investigation is cheap and reversible; the confirmation-tax on
read-only lookups slows every task without protecting anything. The
existing standing rules ("verify what's in the merge diff", "grep for
duplicate implementations") assume active investigation as the default.

## Sweep ROI measures selection, not pricing (2026-08-21)

**Any sweep scored by re-emitting signals under new settings and grading
them measures WHICH BETS GET PLACED, not how well they are priced.** A
sweep of this design can never validate a pricing change. It can only
validate an emit-threshold change.

### Why this is structural, not a sampling problem

`services/model.js:calcPnl(signal, awayScore, homeScore, marketTotal)`
reads the side bet, the market line and the final score. It never sees
the model's numbers. `services/parameter-sweep.js:wageredFor` reads only
`signal.marketLine`. So a signal emitted **on the same side** at two
different parameter values has a **byte-identical pnl and stake at
both**. A swept parameter can therefore move ROI through exactly two
channels:

1. which signals clear `SIGNAL_EMIT_FLOOR_PP` — composition
2. which side gets bet — side flips

Both are selection. No amount of extra data fixes this; it is what the
harness computes.

Demonstrated on the 2026-08-21 W_PROJ/W_ACT sweep: of 742 baseline
signals, the **459 present at all 10 grid values had ROI identical to
the last decimal at every grid point** (−4.78 overall, −2.25 ML, −6.52
TOT; span **0.00pp**). The full-population ML span of 4.33pp and TOT
span of 2.62pp were therefore 100% composition. Side flips were 0 at
seven of nine grid points. See
`docs/sweep-selection-effect-2026-08-21.md`.

### Required output for any such sweep

`services/parameter-sweep.js` now emits these unconditionally
(`selection_effect` at run level, `vs_baseline_train` /
`vs_baseline_test` per combo). A hand-rolled harness in `scripts/` or
`tmp/` MUST report the same three things, or it is not reportable:

1. **Core-signal ROI** — bets present at *every* grid value — alongside
   the full-population number. **If `core_roi_span` is 0, the headline
   is composition and must be described as such.**
2. **enter / leave counts and ROI with CIs.** These marginal near-floor
   bets do all the work, and their CIs are invariably enormous — on the
   W_PROJ sweep every one spanned zero, typically by ±30pp at n≈30-80.
3. **`n_changed_bet`** (side flips). `d_stay` is exactly 0 unless a side
   flipped; a non-zero `d_stay` with zero flips means the flip detector
   is broken, not that pricing moved.

Detect a flip by comparing the **realised bet** (category + outcome +
pnl + stake), never `category` alone: in a tight game both sides can
carry negative American odds, so a genuine away→home switch keeps
`category='favs'` and looks like the same bet.

### To actually validate a pricing change

Use a calibration metric over **all games**, not ROI over emitted
signals: claimed edge vs realised frequency, Brier score, or log loss.
**`scripts/calibration-sweep.js` is the harness for this** — it takes the
parameter name as an argument, scores every game at every grid value,
asserts an identical game set throughout, and reports log loss / Brier /
ECE / claimed-vs-realised edge slope with the same folds, bootstrap and
Val:Fit discipline. First use:
`docs/wpit-wbat-calibration-sweep-2026-08-22.md`, which ruled out
`W_PIT >= 0.80` — a rejection no ROI sweep here could have supported.
`scripts/edge-calibration-curve.js` is the older read-only example. A
metric computed on model outputs rather than on the emitted subset is
immune to this whole problem — as is any target that is not
ROI at all (the 2026-07-07 bullpen blend sweep ranked on 30-team mean
wOBA spread, which is why it is unaffected).

### Prior work this reframes

Affected — swept a **pricing** parameter and read ROI on emitted
signals, so the reported deltas are composition:

- `docs/weight-sensitivity-sweep-2026-07.md` — "combo 7"
  (`W_PIT=0.35` + `SP_WEIGHT=0.75`), Val ROI −3.13% → +12.15%. That
  **+15.28pp is a selection effect**, and the candidate should not be
  piloted on the strength of it.
- `scripts/optimize-params.js` (April 2026, commit 3397c3b) — the
  top-20-by-ROI grid search that **selected production
  `W_PIT=0.40 / W_BAT=0.60`**. The current production value rests on
  this measurement.
- `docs/pyth-exp-holdout-v2-prod-faithful-2026-07-13.md` — pyth_exp.
- `services/temp-backtest.js` — the 5-config temp-formula sweep.
- `services/runmult-totals-backtest.js` — RUN_MULT (partially: it also
  carries a non-ROI target, which is unaffected).
- `services/frv-backtest.js`,
  `scripts/framing-frv-hindsight-backtest.js`,
  `scripts/backtest-park-neutral.js`,
  `scripts/backtest-sp-relief-split.js`,
  `scripts/backtest-run-environment.js`,
  `scripts/sweep-woba-blend.js`.
- `docs/wproj-wact-snapshot-sweep-2026-08-21.md` — where this was found.
  Its conclusion was already "no distinguishable effect", so the
  reframing only strengthens it.

**Not affected** — these sweep a selection knob, so selection is exactly
what they should be measuring and the design matches the question:

- `docs/ship-hard-cap-0.08-2026-07-13.md` (hard cap)
- `tmp/sweep-unders-emit-floor-rolling-cv.js` (emit floor)
- `scripts/backtest-edge-cap.js` (edge cap)
- `docs/bullpen-fix-steps-1-2-plus-blend-2026-07-07.md` (ranked on wOBA
  spread, not ROI)

Reframed does **not** mean wrong-and-discard. It means the ROI delta
measures which near-floor bets landed in the sample, so it cannot
support a claim that the model prices better. Any conclusion that
depended on such a delta needs re-deriving from a calibration metric
before it is acted on.

## Guard-removal rule: ask what failure mode it prevents (2026-08-22)

**Before removing, weakening, or relaxing any guard, state in writing
what failure mode it exists to prevent, and confirm whether that failure
mode is present in the data you are about to evaluate it on.**

If you cannot name the failure mode, you are not yet in a position to
remove the guard.

### The specific trap: backtest blindness

**An ROI or calibration analysis run over cleaned historical data cannot
evaluate a guard whose job is to catch dirty data.** The analysis corpus
is built from `game_log` via `preScreenGame`, which drops malformed rows.
A guard against malformed input is therefore measured on a population
from which its target has already been removed. It will look inert,
because within that corpus it *is* inert.

This is not a sampling weakness to caveat. It is a **structural
mismatch between instrument and question**, in the same family as
`## Sweep ROI measures selection, not pricing` above: the measurement
cannot see the thing being asked about, so a null result carries no
information either way.

### How it actually happened

`SIGNAL_EDGE_HARD_CAP_PP` was analysed across fourteen levels on the
backtest corpus. The 0.25 level suppressed **0 of 1026** signals, and was
written up as "inert -- a does-nothing pass." The recommendation was to
treat the cap as a behavioural filter with no support and remove it.

The production audit log said otherwise. Of 1283 signals the cap had
actually suppressed, **279 carried a market line of |ML| > 1000 -- up to
+94400** -- across 28 separate dates. Every one of those had edge >= 0.25,
and **no signal below 25pp carried a corrupt line at all**. The guard was
catching roughly ten corrupt lines a day, and nothing upstream blocked
them.

The reason the backtest could not see it: `game_log` held **2 corrupt
rows out of 1643**, and `preScreenGame` dropped them. The live path saw
what the backtest had already thrown away.

### Required practice

1. **Name the failure mode first.** Write it down before measuring.
2. **Check whether the analysis corpus contains that failure mode.**
   Count it. If the count is zero or near-zero, the corpus cannot answer
   the question -- say so and stop.
3. **Go to production evidence for guards.** `bet_signal_audit`,
   suppression logs, and `odds_flag_reason` record what a guard actually
   caught. That is the correct instrument for "is this guard needed",
   and the backtest is not.
4. **Separate the two questions.** "Is this guard needed?" and "is this
   threshold right?" have different answers and often different
   instruments. The cap analysis was correct that **0.08 has no
   behavioural support**, and wrong to conclude the guard could go. Both
   findings stand together.
5. **Flag thresholds and block thresholds are different numbers.** Do not
   promote one to the other. `checkOddsSanity` flags at implied p > 0.80,
   which is ML -400 -- inside the real range (observed p99.9 is 403).
   Blocking there would suppress legitimate heavy favourites; the block
   bound is |ML| > 1000, sited in the empty gap between 403 and 99900.

### Related failure: a guard that fails open is not a guard

Three separate hand-maintained key lists silently ignored anything they
did not recognise, each producing a confident and wrong null:

| site | unrecognised key caused |
|---|---|
| `getSettings()` whitelist | setting stored, UI-wired, **never read by the model** (twice: catcher framing, then the three hand-conditional keys) |
| `calibration-ab.js` `CALLER_POPULATED_INPUTS` | keyed by exact param name, so `CATCHER_FRAMING_MUTE` skipped the guard and the A/B reported "flag is inert" |
| `parameter-sweep.applySweepOverrides` | `{SP_WEIGHT: w}` matched no branch, silently discarded, so all nine grid points scored the identical production model |

**Any lookup keyed by a hand-maintained list must throw on an
unrecognised key rather than skip it.** All three now do, and the
`getSettings`/schema sync is asserted every morning by
`utils/settings-sync-check.js`.

**The tell in all three cases was identical digits.** Results that
reproduce a previous run to five decimal places are almost never a real
null -- they mean the thing you thought you changed did not change.
Check that before writing up any null result.

## Timestamp comparison discipline (2026-08-22)

**Three separate timestamp bugs in a single investigation, each producing
a confident wrong answer that survived until something else contradicted
it.** This section exists because the failure is silent by construction:
comparing timestamps almost never throws, it just returns the wrong
boolean.

### The three

| bug | what it did |
|---|---|
| **Comparing against a display string.** `game_log.game_time` is `"2:10 PM ET"` — no date, no offset. `slice(11,16)` on a 10-character string returns `""`, and `anything >= ""` is `true`. | Reported "761 of 761 events after first pitch" and a 15–20% exposure table. Both meaningless. |
| **Assuming one zone for the whole schema.** `bet_signal_audit.created_at` is **PT**; `game_log.odds_locked_at` is **UTC** (SQL `datetime('now')`). Identical-looking, seven hours apart. | Reported "0 signals locked before first pitch" — impossible — which would have inflated an exposure figure from 284 to 2453. |
| **Trusting a column name.** `empirical_market_captures.capture_track = 'gametime'` does not mean captured at game time; those rows are frequently captured the day before. | Nearly used it as a pre-first-pitch reference without checking. |

### The method that settled all three

**Validate a timestamp interpretation against an event whose ordering is
known a priori — then pick the reading that respects it.**

Find an event type whose position relative to your reference is fixed by
definition, independent of any data. Then test each candidate
interpretation and keep the one that produces the impossible-free answer.

Worked example. `set_closing_line` can *only* occur after a game ends:

```
created_at read as UTC : 369 after first pitch, 367 before   <- a coin flip. Wrong.
created_at read as PT  : 727 after first pitch,   9 before   <- correct.
```

A 50/50 split is the signature of comparing noise. A near-total split in
the direction logic demands is the signature of a correct reading.

Second worked example, same method, different fact. The `morning` capture
track stamps `07:30:39`. A cron named "morning" runs at 07:30 **local**;
read as UTC that is 00:30 PT, and nothing called morning runs at half past
midnight. That settled `generated_at` as PT without needing any join.

### Required practice

1. **Never compare a display string.** If a column renders in a UI, it is
   for rendering. Comparisons need a real timestamp column, and if one
   does not exist, that is the prerequisite — go build it before
   continuing the analysis, not after.
2. **State the zone of every timestamp in a comment at the comparison
   site.** This schema genuinely mixes PT and UTC in adjacent columns.
   `datetime('now')` in SQL is always UTC; anything routed through
   `nowPtIso` is PT. Both render as `YYYY-MM-DD HH:MM:SS`.
3. **Anchor on an a-priori-ordered event before trusting any
   before/after result.** Closing lines follow games. Locks precede
   starts. Morning crons run in the morning. Pick one, test the
   interpretations, discard the one that produces impossibilities.
4. **Treat impossible results as diagnostics, not edge cases.** "0 rows
   locked before first pitch" and "100% after" are not surprising
   findings — they are the shape of a broken comparison. The first
   instinct on seeing a clean 0% or 100% must be to check the comparison,
   not to write it up.
5. **A 50/50 split is the other tell.** Random-looking output from a
   comparison that should be strongly ordered means the two sides are not
   in the same units.

**Related:** the identical-digits tell under §"Guard-removal rule" is the
same family — results that reproduce a previous run to five decimals mean
nothing changed. Both are cases where the *shape* of a number, not its
value, is what reveals the bug.

## Never open a second write connection (2026-08-23)

**A script that reads and writes must take `db` from `db/schema`. It must
never call `new Database(...)` in write mode.**

```js
const { q, db } = require('../db/schema');   // correct
const db = new Database(path, { readonly: false });   // WRONG if you also write
```

`db/schema` opens a connection at require time, and every `q.*` prepared
statement writes through it. Open a second read-write handle and you have
two writers on one SQLite file. Read-only (`{ readonly: true }`) is fine
and is the right choice for pure analysis scripts.

### It has two symptoms, and the quiet one is worse

**Loud: the process hangs.** Your transaction takes the write lock, then a
`q.insertBetSignalAudit(...)` inside it blocks on that same lock forever.
Nothing commits, nothing errors, the script just sits there. This happened
on the first `--apply` of `rederive-ml-closing-lines.js`.

**Quiet: it reports zero and looks like a bug in your code.** A test that
opens its own connection, writes uncommitted setup data, then calls a
function that reads through `db/schema`'s connection will find *nothing* —
SQLite isolation means the other connection cannot see an uncommitted
write. `backfillMlClosingLines` was tested this way and reported
`0 rows backfilled`. The obvious reading is "the function is broken." The
function was fine.

**Both happened on 2026-08-23, hours apart.** The quiet one nearly went
into a write-up as a defect.

### Rules

1. **Analysis-only script** → `new Database(path, { readonly: true })`.
   A second *read* connection is harmless.
2. **Anything that writes, or that calls a `q.*` helper** → destructure
   `db` from `db/schema` and use only that.
3. **Setting up state for a test** → do it on the same connection the code
   under test uses, or commit it. Uncommitted setup on a different
   connection is invisible to the code you are testing.
4. **A hang on `--apply`, or a suspicious zero from a function that writes,
   should make you check the connection before you check the logic.**

Same family as the timestamp rule above: the failure is silent by
construction, and the wrong conclusion it produces is a plausible one.

## A comment claiming a fix carries the number it was verified against (2026-08-25)

**Three times now** a code comment has asserted a resolution the data
contradicts, and in each case the comment was the only evidence anyone
had:

```
services/scraper.js   "the read-time MIN_PITCHES floor already governs there"
                      -> the floor never bound; Savant's qualifier ran first
services/scraper.js   "every other team uses the straight FanGraphs R factor"
                      -> matched 4 of 30; the values came from no pullable source
services/jobs.js      the lazy-fetch fallback that fixed the price ping-pong
                      -> reversal rate 51% July, 48% August. Unchanged.
```

### The rule

**A comment that says something was fixed must state the measurement that
established it — the number, and how to re-run it.** Not "this was fixed",
not "this now works". A figure and a command.

```js
// FIXED 2026-08-25: venue tier now resolves on the upsert path.
// Reversal rate 49.7% -> 4.1%; both writers within 0.05pp of neutral.
// Re-run: node scripts/measure-price-oscillation.js
```

This is falsifiable in the way the comments were not: **either the number
is there or it is not**, and if it is there, anyone can re-run it and get
a different answer. A prose claim has neither property.

### Corollaries

- **A fix without a measurement is not finished.** If there is no number
  to quote, the thing to write is what was tried and what remains open —
  which is an honest comment, unlike an unverified claim of success.
- **Prefer a script to a figure alone.** All three failures above would
  have been caught the first time anyone re-ran the check. A number with
  no command behind it decays into the same prose.
- **When you find a comment asserting a fix with no number, verify before
  trusting it.** All three were load-bearing: each had been read and
  believed at least once before the contradiction surfaced.

## A pre-registration requires a power check, and it is one command (2026-08-26)

**Every pre-registration must run `scripts/resolution-floor.js` and paste
its output before the bar is set.** Not an estimate, not a recollection of
past interval widths — the command.

```
node scripts/resolution-floor.js --n <cohort n> --bar <proposed bar>
```

It prints RESOLVABLE or NOT RESOLVABLE. If NOT RESOLVABLE, the
pre-registration must do one of three things **before the run**:

- raise the bar above the floor it printed,
- grow the cohort to an n where the floor clears the bar, or
- declare the run **descriptive, not a test**, in writing.

Naming INCONCLUSIVE in advance as the likely outcome is necessary and does
not substitute for this. The rookie-ROI pre-registration did name it, and
the test was still undecidable: it estimated ±15–20pp intervals from
memory, set the bar at 15pp, and produced ±19.0pp. Run retrospectively at
`--n 128 --bar 15`, the checker returns **NOT RESOLVABLE, floor 20.2pp** —
it would have caught this before the run, in 40 seconds.

### The measured ROI floor on this corpus

963 graded, staked signals across 133 dates. **This is not a function of
cohort size alone — it bottoms out.**

```
    n     CI half-width    null gap 95% span     smallest resolvable
   50        ±27.0pp        [-26.6, +25.5]pp          27.0pp
  100        ±19.1pp        [-20.0, +18.5]pp          20.0pp
  128        ±17.5pp        [-17.1, +18.9]pp          18.9pp
  200        ±14.0pp        [-14.0, +14.2]pp          14.2pp
  300        ±13.1pp        [-13.4, +13.6]pp          13.6pp
  400        ±12.0pp        [-11.3, +11.8]pp          12.0pp
  600        ±12.3pp        [-14.3, +11.6]pp          14.3pp
```

Two things to take from this, both of which correct a looser claim I made
on 2026-08-26 before measuring it:

1. **The floor plateaus at ~12pp around n=300–400 and does not improve
   past it** — it even widens at n=600, because a gap is between two
   groups and the *complement* is what shrinks. So "bigger cohort" stops
   helping. **No ROI question below ~12pp is answerable on this corpus at
   any cohort size**, and the fix for those is more corpus, not more
   slicing.
2. My earlier phrasing — "ROI resolves at n≈400 and not at n≈130" — was
   inferred from three cohorts and is wrong in mechanism. **n≈200 already
   clears a 15pp bar.** Use the table, not the recollection; that is the
   whole point of having a command.

### The measured log-loss floor, which is the tighter constraint

`--calibration`. 564 scored games across 90 dates, and it plateaus too:

```
    n     CI half-width    null gap 95% span         smallest resolvable
   50       ±0.03510       [-0.03287, +0.03266]           0.03510
  100       ±0.02618       [-0.02730, +0.02891]           0.02891
  200       ±0.02228       [-0.01848, +0.02028]           0.02228
  300       ±0.02023       [-0.02048, +0.01948]           0.02048
```

**No Δ log loss below ~0.020 is detectable on this corpus at any cohort
size.** For scale, the rookie calibration leg observed **+0.00720** at
n=63, where the floor is ~0.032 — a quarter of the noise. "No tier change"
was the only answer that run could produce, and that is worth knowing
before quoting it as evidence of anything.

This is the harder ceiling of the two, because the calibration corpus is
smaller than the signal corpus (564 games vs 963 signals) and shrinks
further under any additional filter.

See `docs/rookie-roi-result-2026-08-26.md` §5 for what it cost.

## A schedule-share denominator is not a measurement n (2026-08-26)

Cohort sizes quoted from `build-rookie-cohorts.js` are **scheduled games**.
A calibration leg sees far fewer: contamination filtering took 1876 -> 897,
and `woba_data_snapshot` only starts 2026-05-20 (93 of 140 game dates),
leaving 558. A cohort with **260 scheduled games had 63 scorable ones**.

Quote the n the statistic was actually computed on, in the same table as
the statistic. A power claim carried over from a different test on the
same cohort is a 4x overstatement here.

## The window sign test is not precise at n~350 (2026-08-24)

**Stop quoting "N of 5 windows" to one-window precision on a corpus of a
few hundred games.** Measured directly: five random n-matched subsamples
of the SAME corpus, contamination retained, nothing excluded, produce

```
feature            full corpus   clean (n=349)   same-n resamples
DEFENSE_FRV            4/5            3/5         2, 3, 3, 4, 4
PARK_NEUTRAL           4/5            3/5         2, 2, 2, 2, 4
HAND_CONDITIONAL       2/5            2/5         1, 1, 2, 3, 3
```

A feature reads **2/5 or 4/5 on the same data** depending which 349 games
it sees. So "FRV is exactly one window short of Tier 2" — repeated across
four documents — was a precise sentence about an imprecise quantity.

**The rule.** The Tier 2 window criterion still stands as a bar to clear.
What must stop is treating a near-miss as informative:

- **4/5 vs 3/5 at this n is not a difference.** Do not report a feature as
  "one window away", do not report a re-run as having moved it closer or
  further, and do not let a window count be the reason a verdict changed.
- **If the window count is doing the deciding, say underpowered instead.**
  The honest states are "clears the bar" and "does not"; the ordering
  between two failing counts carries no information here.
- **Carry the control.** A window count without an n-matched resample
  spread beside it is a point estimate with no error bar. Every harness
  now takes `SAMPLE_N` + `SAMPLE_SEED` for exactly this.

### The same instability, one level down: the sweep grid minimum

```
W_PIT_W_BAT   lowest log loss:  0.40 clean | 0.30 full | 0.20 and 0.30 in controls
SP_WEIGHT     lowest log loss:  0.30 clean | 0.60 full | 0.80 and 0.90 in controls
```

**"The best value on the grid" moves by half the parameter range across
resamples of the same data.** That is why the three-gate rule (bootstrap
CI + folds + val-fit) exists, and why "production is not the grid minimum"
is never on its own a reason to move a parameter.

### What made this visible

Only the n-matched control. Without it, three separate movements in the
2026-08-24 re-run would each have been written up as a result: FRV 4/5 ->
3/5, `model - base` changing sign, and the W_PIT grid minimum landing on
production. All three are what dropping to n~350 does on its own.

## The park-factor regime boundary at 2026-08-25

**Any corpus-wide analysis crosses it.** `game_log.park_factor` is
persisted at scrape time and post-lock immutable, so the switch to Savant
`index_runs` did **not** reach existing rows. Games scored before the
cutover carry the old, unsourced factors; games after carry the new ones.

This is the same class of thing as the **v6/v7 cohort split**, not a
contamination tag — nothing is wrong with either side, they are two
regimes — and the discontinuity is larger than either contamination class:
**24 of 30 teams changed, by up to 0.17.**

### It is a column, not a convention

```sql
SELECT park_factor_source, COUNT(*) FROM game_log GROUP BY 1;

  legacy_unsourced           1436   <- the boundary matters here
  unchanged_either_regime     429   <- team's factor did not move; unaffected
  venue_override               10   <- an override supplied it; neither table
  savant_index_runs             1
```

A date would have been a proxy for *when the row was scraped*, which is
recorded nowhere — and rows for future games scraped before the cutover
carry legacy values despite a later `game_date`, so the date proxy
mislabels exactly the rows most likely to matter. **The tag is assigned by
comparing the stored value against both tables**, which is directly
observable. `scripts/tag-park-factor-regime.js` is re-runnable and holds
the frozen legacy table — the only remaining record of what those 1436
rows were scored under, since it is no longer in the source tree.

### What to do with it

- **Report it.** A calibration spanning the boundary should say so, the
  way the contamination exclusions are stated.
- **Prefer splitting to pooling** when the result is sensitive to the
  level of totals — the two regimes differ by a game-weighted 0.43 runs.
- **`unchanged_either_regime` is genuinely unaffected**, so the honest
  denominator for "how much of the corpus is split" is 1436 of 1876, not
  1876.
- The legacy side is **unsourced**, not merely old: those values matched
  no source that could be pulled (FanGraphs `3yr` 4/30, Savant R 6/30).
  That is a reason to prefer the post-cutover side where a choice exists,
  not a reason to discard the earlier games.

## Park factors are evaluated on TOTALS, never on the ML target (2026-08-25)

**The ML calibration A/B is structurally blind to park factor.** Measured:
a swap that moved **24 of 30 teams and 80% of games** produced a mean
|Δp(home)| of **0.00028**.

The reason is arithmetic, not sample size. A park factor multiplies
**both** teams' run estimates by the same number, so it moves the **total**
and leaves the win-probability **ratio** almost untouched. For scale, the
catcher-framing flag moves p(home) by 0.0024 and was already unresolvable
at n=349; this is an order of magnitude smaller again.

**So `calibration-ab.js` will report "not significant" for a park-factor
change however wrong the factors are.** A null from it is not evidence of
harmlessness — it is the instrument reporting that it cannot see.

### What to run instead

The totals target: **MAE, RMSE, and the level (mean model − actual)**,
scored under both factor tables on an identical game set. Report the level
separately from dispersion — they move independently, and the distinction
decided the 2026-08-25 source choice:

```
arm                MAE      RMSE     level     d MAE    d RMSE   d level
production        3.4477   4.4699   -0.5752
FanGraphs 3yr     3.4206   4.4281   -0.6402  -0.0270   -0.0419   -0.0650
Savant R 24-26    3.4089   4.4183   -0.5827  -0.0387   -0.0516   -0.0075
```

FanGraphs sharpened dispersion while pushing an already-negative bias
0.065 further; Savant R sharpened dispersion and moved the level 0.0075.
On MAE alone they look similar. **The level is what separated them.**

### The general form

Before running an A/B, ask **what the change can physically move**. A term
that scales both sides equally cannot move a ratio-based target. A term
that shifts one side can. Choosing the target after the fact — or reading
a null from a blind instrument as a pass — is how a change of this size
gets waved through.

## Know which database you are measuring (2026-08-24)

**`data/mlb.db` is not production.** It is a separately-evolved local
copy, and on 2026-08-24 the two disagreed on `temp_f` for **1586 of 1678
shared games** and on `model_total` for **1595** — median disagreement
**0.33 runs**, which is larger than most effects measured against it.
Production carried a weather-hour correction backfilled around 2026-07-30
that the local copy never received; the local copy carried a week of
remediation that production never received.

### The rule

**Run `node scripts/pipeline-freshness.js` before measuring anything.**
It takes under a second and prints the last-arrival date of every ingest
pipeline. Exit code 1 on anything CRITICAL, so it can gate a script.

To settle "is production broken or is my copy old", compare them:

```
node scripts/pipeline-freshness.js --compare data/mlb.db.prod-YYYYMMDD
```

The verdict line is the point. **Direction is what distinguishes the two
cases, not staleness.** If the reference is newer everywhere they differ,
it is a stale copy. If each is newer somewhere, they have **DIVERGED** and
neither is a superset — reconcile before overwriting either, or work
disappears silently in whichever direction you copy.

### What this cost

An entire day of 2026-08-23 was measured against a corpus that ended
2026-08-06 and nothing said so. The staleness was then **reported to the
owner as a production outage** — "scores, pitcher logs, wOBA snapshots and
market captures all stopped", "signals still emitting on 17-day-old batter
data". Production was healthy throughout: complete, fully-scored, current
to the hour. The exposure was zero.

Both halves of that failure were one query away. The evidence used to
raise the alarm — `MAX(game_date)` per table — was correct for the file
being read and said nothing at all about the system it was blamed on.

### Never conclude an outage from a local DB alone

A `MAX(date)` on a copy measures **the copy's vintage**, not the health of
the thing that produced it. Before reporting that a pipeline stopped:

1. run the freshness check against **production**, via
   `/health` (`pipeline_freshness`) or a dated download;
2. check whether the *process* is even running locally — no server, no
   `node-cron`, so no cron chain, and that is a property of the laptop;
3. distinguish **rows written by a scheduler** from **rows written by
   someone opening the app**. Two brief manual runs on 2026-08-11 and
   2026-08-22 left `game_log` rows dated 08-12 and 08-23 in the local
   copy, which is what made a dead local server look like a *partially*
   working pipeline. It was not partially working; it was off.

### Refreshing the copy

Use `scripts/refresh-analysis-db.sh` — it downloads to a dated file,
integrity-checks before promoting, backs up the current copy, and
**re-applies the local-only remediation**, which is the step that is easy
to forget. Everything the remediation scripts write is local-only:
production has the schema but not the data, so a naive refresh silently
reverts all of it.

## One PR, one push (2026-08-24)

**Seven times now**, work has been committed, pushed, and reported as
delivered while sitting on a branch `main` never absorbed. Four of those
were in a single afternoon.

### It is not a race with the reviewer

The timing settles it. Every stranded commit was pushed **after** its PR
had already merged:

```
commit 0d57066 pushed 22:19Z    PR #288 merged 21:27Z    +52 min
commit d5c0078 pushed 23:25Z    PR #291 merged 23:03Z    +22 min
commit 47a9329 pushed 00:19Z    PR #291 merged 23:03Z    +76 min
commit 5a91e04 pushed 00:37Z    PR #291 merged 23:03Z    +94 min
```

Nobody merged early. The cause is **treating an open PR's branch as a
scratch workspace** and appending to it without re-checking whether the PR
is still open. A merged PR does not notice later pushes; `git push`
succeeds; the branch still exists. **Every surface reports success.**

### The rule

**One PR, one push.** Once a PR is opened, that branch is finished. More
work means a new branch from `main`, even if it is one line and even if it
belongs to the same conversation.

If a follow-up genuinely must go on an open PR's branch, **check the PR is
still open first** (`gh pr view <n> --json state`), and re-check after
pushing.

### Before and after

**Before opening a PR:** list the commits it should contain, and put that
list in the PR body. A PR whose expected contents are written down cannot
quietly merge with a subset.

**After it merges:** verify. Not "the branch exists" — that was true every
time. Verify the SHAs are ancestors of `main`:

```
node scripts/verify-commits-landed.js            # every unmerged branch
node scripts/verify-commits-landed.js <branch>   # one branch
node scripts/verify-commits-landed.js --selftest # prove detection works
```

Exit 1 if anything is stranded, so it can gate a "done" claim.

### The checker had this same failure mode, twice

Worth recording because it is the point of the rule. The first version
built `git log --format=%h|%cI|%s` **unquoted**, so the shell read the
`|` as pipes, git got a truncated format, the error was swallowed, and the
tool **reported OK for every branch forever**. Two later edits to the fix
were converted into literal CR/LF bytes by the tooling in between.

Hence `--selftest`, which creates a throwaway unmerged commit and asserts
the checker sees it. **"It printed OK" is exactly what a broken checker
prints.** The file also carries no backslash escapes by design.


## Review checklist — re-run these, do not trust a past clean result (2026-08-23)

These are cheap, they are re-runnable, and every one of them exists
because something was found by running it that nobody had noticed by
reading. **A clean result from a previous run is not evidence about the
current tree.**

| check | command | catches |
|---|---|---|
| **Read endpoints that write** | `node scripts/audit-get-mutations.js` | a `GET` that mutates — invisible until someone notices data that changed with no edit |
| **Settings the model cannot see** | runs in the 6AM cron; `utils/settings-sync-check.js` | a schema key never mapped into `getSettings()`, i.e. a tunable with no effect |
| **Gate windows that elapsed silently** | runs in the 6AM cron; `services/feature-gate-registry.js` | a feature dark past its own evaluation window |
| **Park-factor regime split** | `SELECT park_factor_source, COUNT(*) FROM game_log GROUP BY 1` | a corpus-wide analysis silently pooling two park-factor regimes across the 2026-08-25 boundary |
| **Ingest pipelines that stopped arriving** | `node scripts/pipeline-freshness.js`; also runs in the 6AM cron and on `/health` | a job that stopped, or an analysis copy silently 18 days behind |
| **The delete-missing guard** | `node scripts/test-prune-missing.js` | a truncated fetch emptying a pricing-path table, with every consumer silently taking its fallback |
| **A "fixed" comment with no number** | grep for fix-claims in code touched by a PR | the third instance cost a month of trusting a ping-pong fix that never took |
| **Commits that never reached main** | `node scripts/verify-commits-landed.js` | work committed, pushed, reported as delivered, and sitting on a branch `main` never absorbed — seven times so far |
| **Forward lineup capture stopped** | `node scripts/pipeline-freshness.js` (row `lineup_captures`) | a missed day of same-day capture, which is **unrecoverable** — there is no backfill for what RotoWire said at 10AM on a date that has passed |
| **Capture horizon logic** | `node scripts/test-lineup-capture.js` | a horizon mislabelled across the ET/PT midnight gap or a DST boundary — an 11PM PT same-day pull is already the next ET day |
| **A bar inside the noise floor** | `node scripts/resolution-floor.js --n <n> --bar <bar>` | a pre-registered test that could not have resolved either way — run it **before** writing the bar, not after reading the result |

### When to re-run the freshness check

**Before any measurement, and it is the first thing to run when a number
looks wrong.** Anything CRITICAL means the corpus is not what you think it
is, and every result computed on it is about a different dataset than the
one you meant to study.

`catcher_framing` reports CRITICAL on production as of 2026-08-24 —
last refreshed **2026-06-03, 82 days**. No cron refreshes it; it is
fetched by hand. That is a real finding the check surfaced on its first
run, and it is unresolved.

### When to re-run the landed-commit verifier

**After every merge, before saying anything shipped.** It takes 6.5s.

```
node scripts/verify-commits-landed.js
```

Exit 1 if anything is stranded. Expected output today is 15 commits on 15
branches, all of them the April-to-August tail dispositioned in
`docs/stranded-branch-dispositions-2026-08-24.md`. **Anything with a
recent date is a regression** — that is the whole signal.

It uses `git cherry`, not `git log`, so a commit that was cherry-picked
onto a new branch and merged is correctly **not** reported: its original
sha lives on the original branch forever, and `git log` would flag it
until the end of time. Seven such entries dropped out when this changed
(22 → 15). An alarm that cries wolf on re-landed work trains you to skip
reading it, which is how a check dies.

### Run `--selftest` periodically, not once

```
node scripts/verify-commits-landed.js --selftest
```

Same reasoning as `KNOWN_MUTATORS` being hand-maintained: **a checker that
has never failed is one you are trusting on inspection.** This one is not
hypothetical about that — it shipped three separate silent-pass bugs
before it worked:

1. `--format=%h|%cI|%s` **unquoted**, so the shell ate the pipes, git got
   a truncated format, the error was swallowed, and it **reported OK for
   every branch**. It passed on first run.
2. Two edits to the fix became literal CR/LF bytes — once a parse error,
   once a file that ran and lied. The file carries **no backslash escapes
   at all**, by design; see the comment on the line that kept breaking.
3. `--selftest` itself ran `git checkout -b` through the error-swallowing
   helper, so on a dirty tree the checkout failed, execution continued,
   and the empty selftest commit landed **on the working branch**.

The selftest creates a throwaway unmerged commit **from `main`** (not from
HEAD — branching from HEAD inherits the current branch's unmerged work and
fails spuriously) and asserts exactly one is detected. It refuses to run
on a dirty tree.

**Re-run it whenever the script is touched, and whenever a clean sweep is
about to be used as evidence that nothing was lost.**

### When to re-run the GET-mutation scan

**Any PR that touches `routes/api.js`.** It takes under a second.

Expected output today is exactly one live hit:

```
handlers with LIVE mutations: 1
  GET /admin/odds-comparison
```

That one is **known and accepted** — it persists genuinely live-fetched
venue prices into a dedicated snapshot table, guarded so it never writes
a locked row, documented against the 07-10 incident. **Anything else
appearing is a regression.**

The distinction that matters, and the one that made the totals bug
invisible for months:

- A GET writing a **derived** value into an **analysis table** is
  invisible fabrication. `GET /backtest` assigned
  `closing_line = market_line` on every request, manufacturing 762 totals
  closing lines indistinguishable from real captures.
- A GET caching a **fetched** value into a **snapshot table** is a design
  choice with a stated reason.

### The scan's own blind spot, which is why it is a checklist item and not a gate

`KNOWN_MUTATORS` in the second pass is a **hand-maintained list** — the
same shape of thing that has failed open three times in this repo
(`getSettings`' whitelist, `CALLER_POPULATED_INPUTS`,
`applySweepOverrides`). A clean second pass means **"nothing found", not
"nothing there"**: a helper not on the list, or a write two hops away,
will not appear.

The first pass is deliberately biased the other way — a mutating keyword
inside a **comment** counts as a hit. For an audit that is the correct
direction: a false positive costs a glance, a false negative costs six
months.

## Other project notes

- **Node version:** better-sqlite3 native binding is compiled for Node 20.
  Local scripts must run via `<node20>/node` (nvm4w path
  `C:\Users\Mike Reagan\AppData\Local\nvm\v20.20.2\node.exe`). Node 24 fails
  with `NODE_MODULE_VERSION 115 vs 137`.
- **Branch discipline:** every non-trivial change lives on its own
  `feat/…`, `fix/…`, `docs/…`, `chore/…` branch. Confirm
  `git branch --show-current` matches the brief's named branch before
  staging.
- **Backtest harnesses:** live in `scripts/` when they're keepers; live in
  `tmp/` when they're one-shot verifications tied to a specific PR (the
  `tmp/` scripts can be gitignored or committed with the PR, whichever fits
  the PR's scope).
