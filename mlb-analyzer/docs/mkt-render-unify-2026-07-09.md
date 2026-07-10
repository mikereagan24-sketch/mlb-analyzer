# Slate + matchup mkt cells unified on s.market_line — 2026-07-09

## Bug

Owner reported on the deployed post-PR-#164 build: **the card's mkt cell
never shows Poly winners.** CLE-MIN 2026-07-08:
- Venue flag: **Poly -124 net (winner)**, Kalshi -126 net
- Card mkt cell: **-126** (Kalshi runner-up)

Also occasional "penny-off from Kalshi" mkt values — suggests two Kalshi
numbers from different sources (raw ask_ml vs fee-adjusted net_american).

## Root cause

The write layer (PR #164 refreshSignalBaselines) is correct — it writes
the venue winner's net-at-size to `bet_signals.market_line`. The bug is
purely in the **render layer**: multiple UI sites read
`g.market_away_ml` / `g.market_home_ml` from game_log (Kalshi ask_ml,
top-of-book, no fees) instead of `s.market_line` from the emitted
signal. Same class of bug as the venue-comparison freeze — the write
path was correct; a display path pulled from the wrong field.

The sig-row `mkt: XXX` was ALREADY reading `s.market_line` correctly
(via my PR #163/#164 fixes at `public/index.html:3119` and `:3151`).
The bug is in every OTHER "mkt" cell:

- **Slate list summary** (godds div, `public/index.html:1312`) — reads
  `g.market_away_ml` / `g.market_home_ml`.
- **Slate card rboxes** (`renderGameResult`, `:1596-1599`) — reads
  `g.market_away_ml` / `g.market_home_ml` / `g.market_total`.
- **Matchup runs header** (`:1661`) — "Market: X / Y · O/U Z" —
  reads `g.market_away_ml` / `g.market_home_ml`.
- **Matchup setComp** (`:1721-1723`) — ML + Total mkt columns.
- **Matchup AI-analyze prompt** (`:1748`) — feeds the AI a stale mkt
  string.
- **Confirmed-lineup model card** (`renderModelOutput`, `:1848-1850`)
  — reads `g.market_away_ml` / `g.market_home_ml`.
- **Matchup game_header** (`:1930`) — the "X / Y O/U Z" tag below the
  team names.

Every one of these ends up showing the Kalshi capture instead of the
venue winner net when they differ, which happens whenever Poly is the
winner OR Kalshi's captured ask_ml differs from Kalshi's net_american
(the "penny-off" case).

## Fix

Added three resolver helpers in `public/index.html` next to `fmtML`:

```js
function _resolveMkt(g, sigs, side, type) {
  if (sigs && sigs.length) {
    var sig = sigs.find(function(s){
      return s.signal_type === type && s.signal_side === side;
    });
    if (sig && sig.market_line != null) return sig.market_line;
  }
  if (type === 'ML') return side === 'away' ? g.market_away_ml : g.market_home_ml;
  return g.market_total;
}
function _resolveAwayML(g, sigs)   { return _resolveMkt(g, sigs, 'away',  'ML'); }
function _resolveHomeML(g, sigs)   { return _resolveMkt(g, sigs, 'home',  'ML'); }
function _resolveTotalMkt(g, sigs) {
  if (sigs && sigs.length) {
    var s = sigs.find(x => x.signal_type === 'Total' && x.signal_side === 'under')
         || sigs.find(x => x.signal_type === 'Total' && x.signal_side === 'over');
    if (s && s.market_line != null) return s.market_line;
  }
  return g.market_total;
}
```

Rule: **when a signal exists for that (side, type), the mkt cell
renders `s.market_line` — the same value the venue flag renders.
Otherwise fall back to `g.market_*_ml` (raw Kalshi capture) so games
without signals still show a market number.**

The fallback preserves g.market_*_ml **only where a signal doesn't
exist** — the semantic "raw-capture" case the owner reserved. Every
signal-adjacent display now unifies on `s.market_line`.

## Sites patched

| line | context | before | after |
|---|---|---|---|
| 1312 | slate list summary godds div | `fmtML(g.market_away_ml)` | `fmtML(_resolveAwayML(g, sigs))` |
| 1597 | slate card rbox away ML | `fmtML(g.market_away_ml)` | `fmtML(_resolveAwayML(g, sigs))` |
| 1598 | slate card rbox total | `g.market_total` | `_resolveTotalMkt(g, sigs)` |
| 1599 | slate card rbox home ML | `fmtML(g.market_home_ml)` | `fmtML(_resolveHomeML(g, sigs))` |
| 1661 | matchup runs header | `fmtML(g.market_*_ml)` | `fmtML(_resolveAwayML/_resolveHomeML(g, sigs))` |
| 1721-1723 | matchup setComp ML+Total | `g.market_*_ml` | resolver |
| 1748 | matchup AI prompt | `fmtML(g.market_*_ml)` | resolver |
| 1848-1850 | confirmed-lineup model card | `fmtML(g.market_*_ml)` | resolver (with `_confSigs`) |
| 1930 | matchup game header | `fmtML(g.market_*_ml)` | resolver (with `_muSigs`) |

## Sites deliberately NOT patched (semantic raw-capture)

- `renderModelOutput` **projected row** (lines 1837-1842) — uses
  `g.proj_market_*_ml || g.market_*_ml`. The projected snapshot is
  frozen-at-emit by design; showing the current venue winner would
  break "what did the market look like when the projected model ran".
- Line 1442-1449 (totals engine `total_lines` request builder) — reads
  `g.market_total` when no total sig exists to pass as the requested
  strike for the venue comparison fetch. Semantic use: the request
  line is the game_log capture value, not the venue winner.
- Line 1485-1486 (sig-row side header text "Over 8.5 / Under 8.5") —
  the header label uses `g.market_total`. It's a label, not a mkt
  cell. Signal's own `market_line` drives the emit surface.
- Line 1945, 2099 (odds-comparison stake/total data attrs).
- Line 745-746 (`havePrimary` totals gate in the emit-floor engine).

## Explaining the penny-off Kalshi cases

Two Kalshi numbers exist in the system, both correctly derived but
semantically distinct:

1. **`game_log.market_away_ml` / `market_home_ml`** — captured by
   `runOddsJob` from Kalshi via `getKalshiMlbLines`. This is Kalshi's
   raw **ask_ml** (top-of-book best-case price with **no fees** and
   **no depth walk**). Great for glancing at "what does Kalshi say the
   top is" but NOT the price the bettor would actually get filled at.
2. **`bet_signals.market_line`** (venue-aware refresh path) —
   `services/odds-comparison.js` `net_american` = fee-adjusted
   depth-walked price for the configured $100 stake. This is what the
   model uses as the edge baseline and what the venue flag renders.

Same Kalshi book, different derivations. On a $100 fill with slight
slippage + Kalshi taker fee, ask_ml -122 typically becomes
net_american -125 to -128. That "3-6 point" gap looked "penny-off"
because the sig-row rendered net (-126) but the slate card rendered
ask (-122). Under the fix, both sites read s.market_line → both show
the SAME net value → drift disappears.

## Acceptance table

Requires a fresh DB pull (my local mirror is from before this fix
would deploy). Once deployed and refreshed against today's slate,
`tmp/verify-mkt-render-unify.js` prints the per-game table
requested — one row per (game_id, side) with signal + venue flag,
comparing `s.market_line` (what the card renders under this fix)
against the flag winner net. Columns:

```
game     side  flag_winner (net/venue)  row.market_line  price_venue  updated_at  card_renders  matches_flag?  notes
```

Every unlocked pre-T-10 row where `price_venue IS NOT NULL` (i.e.
refresh has fired) should show `matches_flag? YES` because both the
flag and the card mkt read the same source. Rows where
`price_venue IS NULL` (refresh has not yet fired since the row was
emitted) will show `matches_flag? NO` with `card_renders` = the stale
Kalshi capture from before the refresh caught up. Those rows resolve
to matching the moment the next odds cron pass runs
`refreshSignalBaselines`.

## Files

- `public/index.html` — added `_resolveMkt` / `_resolveAwayML` /
  `_resolveHomeML` / `_resolveTotalMkt`. Swapped 9 render sites.
- `tmp/verify-mkt-render-unify.js` — slate-wide per-game per-side
  table. Pastes flag winner vs card mkt vs signal row state so the
  match/mismatch is auditable.
- `docs/mkt-render-unify-2026-07-09.md` — this file.

## Post-deploy verification

1. Reload games tab for today's date. On any game with a Poly-winning
   ML side, confirm the slate card's `mkt XXX` matches the venue
   flag's bold Poly value (they should be identical).
2. Compare rbox mkt on a Kalshi-winning side — should match the
   flag's bold Kalshi net (fee-adjusted), not the ask_ml raw
   capture.
3. `curl "http://localhost:3000/api/games?date=YYYY-MM-DD"` — inspect
   any signal's `market_line`. Refresh the games tab; the sig-row
   mkt AND slate card mkt AND matchup mkt AND the AI-prompt "Market:"
   line should all render this exact number.
4. Run `tmp/verify-mkt-render-unify.js YYYY-MM-DD` against fresh DB
   — table should show `matches_flag? YES` on every unlocked row
   with a populated `price_venue`.
