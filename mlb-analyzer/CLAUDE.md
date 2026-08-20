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
