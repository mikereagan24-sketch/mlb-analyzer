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
