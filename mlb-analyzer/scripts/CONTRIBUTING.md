# Contributing notes

## Field semantics

See header comments in:
- `routes/api.js` — game_log response shape
- `services/jobs.js` — bet_signals shape (above `processGameSignals`)
- `services/model.js` — model output shape (JSDoc on `runModel` + `getSignals`)

## Settings

All settings keys + ranges + defaults defined in `services/settings-schema.js`.
Adding a new setting: add to schema, default flows through `getDefaults()` at startup.
Reading a setting: existing pattern `num('key', schema_default)`.

## Common pitfalls

- `market_*` vs `xcheck_*` — primary is bettable price, xcheck is divergence
  calibration only (PR #25).
- Never COALESCE on price columns (PR #10) but DO COALESCE on locked-row source
  labels (PR #23).
- `game_id` includes `-g2` suffix on doubleheader Game 2 (PR #36).
- Cohort `v3` starts 2026-04-24 — anything earlier is `v3-pretuning` (PR #33).
