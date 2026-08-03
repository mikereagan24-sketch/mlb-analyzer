# FanGraphs API contract capture recipe

Purpose: diff what our `services/fangraphs.fetchActualSplit` sends against
what FG's own frontend sends. Prompted by 2026-08-02: actuals HTTP 500
for 3+ consecutive days on both channels (bookmarklet iframe + server-side
POST), while projections still work. Sandbox can't reach FG; need a
browser capture.

## Step 1 — capture the browser's request

1. Open Chrome or Firefox while logged into your FanGraphs Member account.
2. DevTools → Network tab → filter by `XHR` or `Fetch`.
3. Navigate to `https://www.fangraphs.com/leaders/splits-leaderboards` and:
   - Set **Split** to `vs LHP` (that's the same split as our
     `bat-act-lhp` — split code 1).
   - Set **Position** to Batter.
   - Set **Auto-PT** to whatever the default is (leave as-is; do NOT change).
   - Set **Date Range** to a 2-year window ending yesterday.
   - Click **Update** or wait for the leaderboard to render.
4. In the Network tab, find the request to `/api/leaders/splits/splits-leaders`
   (or whatever the current path is — the endpoint URL is what we want to
   diff first).
5. Right-click that request → **Copy** → **Copy as cURL (bash)**. Paste it
   into the ticket.

## Step 2 — what to look for in the diff

Compare the captured request against `services/fangraphs.js:159-192` on
these axes:

| Axis | Ours (2026-08-02) | Browser | Notes |
|---|---|---|---|
| URL | `https://www.fangraphs.com/api/leaders/splits/splits-leaders` | ? | Path may have moved |
| Method | `POST` | ? | May have flipped to `GET` with query params |
| Content-Type | `application/json` | ? | May be `application/x-www-form-urlencoded` |
| Body: `strSplitArr` | `[1]` | ? | Field may have renamed to `splitArr` |
| Body: `strGroup` | `'season'` | ? | |
| Body: `strPosition` | `'B'` | ? | |
| Body: `strType` | `'2'` (string, both B and P) | ? | Was `1`/`'2'` split pre-2026-08-03; new handler wants `'2'` for both |
| Body: `strStartDate` / `strEndDate` | ISO YYYY-MM-DD | ? | Format may have changed |
| Body: `strSplitTeams` | `false` (boolean) | ? | May now expect string `'false'` |
| Body: `dctFilters` | `[]` | ? | May have a required shape |
| Body: `strStatType` | `'player'` | ? | |
| Body: `strAutoPt` | `'true'` (string) | ? | |
| Body: `arrPlayerId` / `strPlayerId` | `[]` / `'all'` | ? | |
| Body: `arrWx*` weather filters | `null` (all five) | ? | Was `[]` pre-2026-08-03; new handler crashes on `[]` |
| Headers: Cookie | wordpress_logged_in_...| Same | Our cookie name is stable |
| Headers: Referer | leaders/splits-leaderboards | ? | |
| Headers: Origin | www.fangraphs.com | ? | |
| Headers: X-Requested-With | XMLHttpRequest | ? | |
| Headers: Any new (CSRF, x-fg-*, etc.) | none | ? | **Most likely change** — a session/CSRF token that a server can't emit is what would push us to owner-only |

## Step 3 — decide fix path

**Common failure signature — type-strictness after FG rewrites**: On
2026-08-03, FG rewrote splits-leaderboards and the new handler was
STRICT on:
- `arrWx*` fields must be `null`, not `[]` (old handler coerced)
- `strType` must be `'2'` string for BOTH B and P (old handler
  accepted number `1` for batters)
- `strSplitTeams` must be boolean `false`, not the string `'false'`

Every FG rewrite may repeat this. When actuals 500 and the URL is
unchanged, **check types first**: JSON.stringify our body, then the
browser's, then diff character-by-character.

**If the change is a field/URL/method/format change**: update
`fetchActualSplit` to match. Test with a fresh cookie + one split first
(pit-act-rhb is smallest so cheapest to test).

**If the change is a CSRF/anti-bot token that browser gets from a prior
page load and server can't reproduce**: server-side path is dead. Owner
options:
- Bookmarklet iframe path only (currently also broken — separate cause)
- Alternative data source (Statcast splits, Sports Reference, custom
  Steamer-side query)
- Accept projection-only inputs until FG restores the endpoint

**If the 500 body carries a specific FG error message**: paste it. As
of 2026-08-02 PR #212 `fetchActualSplit` and `fetchProjection` both
capture the response body on non-ok (first 400 chars) — check Render
logs for `[fg-woba] attempt 1 done: X/8 ingested` followed by the
per-key `err_keys` entries with body text.

## Not covered here — bookmarklet iframe

The iframe path in `public/bookmarklet.html` fails via a different
route: FG's own JS on `/leaders/splits-leaderboards` renders (or
doesn't render) an `<a download>` element with a `data:` URL CSV. If
that page has changed its JS or moved the export link, the iframe
poller times out. Separate capture recipe: inspect the page in DevTools
after clicking the CSV button, find the anchor element that gets
appended, note its selector.
