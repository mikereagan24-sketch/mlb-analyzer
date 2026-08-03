# FG Splits Leaderboards — legacy sunset migration

**Deadline: ~2026-11-05** (end of World Series, per FanGraphs' own note
on the legacy page). Miss it and the FG Daily Sync actuals path breaks
with the same ASP.NET generic errors we hit 2026-07-31 through
2026-08-02.

## Context

**2026-07-31 → 2026-08-02**: FanGraphs rewrote `/leaders/splits-leaderboards`
and its underlying API. New endpoint returns unhandled ASP.NET
exceptions (`{"Message":"An error has occurred."}`) on our request
shape — both the bookmarklet iframe path AND the server-side POST to
`/api/leaders/splits/splits-leaders`. All four `-act-` woba_data keys
went stale for 3 days. See the 500-body captured by PR #212's error
handling for the exact response.

**2026-08-03 (this PR, #216)**: Pointed both paths at the preserved
legacy endpoint:
- `services/fangraphs.js` — `ACTUAL_URL_DEFAULT` swapped from
  `.../splits/splits-leaders` to `.../splits/splits-leaders-legacy`
  (best guess — pattern-matches FG's page URL suffixing)
- `public/bookmarklet.html` — iframe URL swapped from
  `.../leaders/splits-leaderboards` to
  `.../leaders/splits-leaderboards-legacy`

## Migration checklist (execute before 2026-11-05)

Suggest starting **2026-10-15** so there's a 3-week buffer for
diagnosis and re-drag rollout. Owner triggers.

### Step 1 — capture the NEW API contract

Follow the recipe in `docs/fg-api-contract-capture.md`, but on the
CURRENT (non-legacy) page: `https://www.fangraphs.com/leaders/splits-leaderboards`.
DevTools Network → capture the JSON POST that loads the leaderboard →
paste the cURL back into the migration task.

### Step 2 — diff against current request

The current request body shape (`services/fangraphs.js:164-192`):

```
{
  strSplitArr: [splitCode],
  strGroup: 'season',
  strPosition: position,           // 'B' or 'P'
  strType: position === 'P' ? '2' : 1,
  strStartDate: start, strEndDate: end,
  strSplitTeams: false,
  dctFilters: [],
  strStatType: 'player',
  strAutoPt: 'true',
  arrPlayerId: [],
  strPlayerId: 'all',
  strSplitArrPitch: [],
  arrWxTemperature: [], arrWxPressure: [], arrWxAirDensity: [],
  arrWxElevation: [], arrWxWindSpeed: [],
}
```

Compare axis-by-axis against the captured browser request per the
table in `docs/fg-api-contract-capture.md`. Most likely delta types:
- Field renames (`strSplitArr` → `splitArr`, etc.)
- Added required field (session/CSRF token)
- Changed method (POST → GET with query params)
- Response shape change (`{data: [...]}` → different top-level key)

### Step 3 — update fetchActualSplit

Change:
- `ACTUAL_URL_DEFAULT` to new API endpoint
- Body shape per the diff
- `jsonToCsv(json.data)` if response shape moved (may become
  `json.rows`, `json.results`, etc.)

**Test with dry_run against ONE split first** (pit-act-rhb is smallest).
Confirm row count is within the historical 322-449 band (from
`tmp/audit-woba-uploaded-history.js`). Only then run all four.

### Step 4 — update bookmarklet iframe URL

Remove the `-legacy` suffix from `buildActualsIframeUrl` in
`public/bookmarklet.html`. Then check the FG page's own client-side
JS: it may have moved the `<a download>` CSV export button, or
changed the button's DOM path so the bookmarklet's poller
(`doc.querySelectorAll('a[download][href^="data:"]')`) misses. If
the export button UI changed, update the poller selector.

### Step 5 — verify

- `/health.woba_freshness` all 8 keys age < 30h post-first-cron
- `tmp/audit-woba-uploaded-history.js` row counts within historical
  bands for all four `-act-` keys
- Manual click of the bookmarklet returns `4/4 uploaded` for actuals

### Step 6 — remove escape hatch

Delete `FG_ACTUALS_URL_OVERRIDE` env var handling if not needed.
Delete this doc (migration complete).

## If you miss the deadline

Same failure signature as 2026-07-31: all four `-act-` keys 500 for
days, `/health.woba_freshness` escalates to `critical` at 72h. The
retry cron (`runFangraphsWobaSyncJob`) short-circuits after attempt 1
so quota doesn't burn. Bookmarklet iframe times out. Manual owner
workaround: run the migration steps above under time pressure. Same
outcome, more stress.

## Related — bug report to FanGraphs

Owner mentioned filing the 500 on the new API via FG's bug link. Do
that before end of August so their fix might land before we need to
migrate. If FG fixes the new API to accept our request shape, this
migration collapses to just flipping the URL (Steps 1-3 become
"confirm no change needed"). Don't count on it.

## Related — bookmarklet token TTL

Both the legacy migration deadline (2026-11-05) and the bookmarklet
token's 30-day TTL coincidentally land in early November for tokens
minted late September / early October. Owner should re-rotate the
bookmark AFTER the migration lands so the fresh bookmark contains
the migrated URL AND a fresh token in one step.
