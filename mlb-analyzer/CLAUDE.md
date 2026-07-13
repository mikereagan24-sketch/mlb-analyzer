# mlb-analyzer — Claude Code project rules

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
