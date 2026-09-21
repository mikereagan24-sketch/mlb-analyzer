# Closed: liquidity fallbacks precede Kalshi's first listing, so no earlier odds pass (2026-09-21)

**Status: CLOSED on mechanism and observation. No new cron pass.**

The open question from #413/#414 was whether a ~9:30 AM PT odds pass was
worth adding, on the theory that day games were falling to
`liquidity_fallback` because the 8 AM PT pass runs before Kalshi has
posted. Seventy instrumented passes over 2026-09-18..09-22 answer it the
other way.

## The mechanism, which is the finding

Every observed `liquidity_fallback` occurred on the **first pass to touch
a date, before Kalshi had listed it**. Every one of those dates then
shows `rung_persisted` of 12–15 on later passes.

That is not a coincidence of the sample; it is forced by how the anchor
is stored. `kalshi_anchor_total` is written on every Kalshi-priced pass
and `COALESCE`d in the UPDATE, so it is never cleared
(`services/jobs.js:5220`):

```sql
kalshi_anchor_total = COALESCE(?, kalshi_anchor_total)
```

And `liquidity_fallback` is by definition the *no anchor at all* case —
the emitter labels it `*** N PRICED WITH NO KALSHI ANCHOR ***`
(`jobs.js:6411`). So a fallback can only happen on a pass that runs
**before the first Kalshi-priced pass for that game**. Once any pass
prices it, the anchor exists forever and every later pass reads
`persisted`.

**Therefore an earlier cron pass finds fewer anchors, not more.** A 9:30
AM PT pass sits further from Kalshi's listing time than the 11 AM one, so
it would convert nothing; it would add a pricing cycle that arrives
before the data it needs. On a 512MB instance that is cost without
cover — the same shape as the observability entry in CLAUDE.md, where a
capability nothing read was OOM-killing the service.

## The observation

Fallbacks clustered on four or six passes (see the count note below), all
of them first-touch:

| pass (PT) | fallbacks | slate priced |
|---|---|---|
| 2026-09-17 20:00 | 2 | 2026-09-18 |
| 2026-09-19 07:00 | 1 | 2026-09-19 |
| 2026-09-19 12:29 | 3 | 2026-09-20 |
| 2026-09-21 07:30 | 1 | 2026-09-22 |
| 2026-09-21 09:42 | 1 | 2026-09-22 |
| 2026-09-21 09:43 | 1 | 2026-09-22 |

Every one of those dates later reports `rung_persisted` 12–15.

**Count note, so this is not quoted as settled.** The reported total is
11; the per-pass breakdown above sums to **9** across **6** passes, and
an earlier reading of the same grouped output gave 10 (6 at 12 PT, 2 at
09, 2 at 20). The *mechanism* does not depend on which is right — all
three readings are first-touch-only — but the count does, so pin it with
the command rather than citing a figure from this table:

```
curl -s -H "X-Admin-Token: $DB_DOWNLOAD_TOKEN" \
  "https://mlb-analyzer.onrender.com/api/admin/query/odds-anchor-passes?from=2026-09-17&to=2026-09-25"
```

## What `anchor_kalshi_pass = 0` does and does not mean

`anchor_kalshi_pass` was 0 across all 70 passes. That reads like "Kalshi
supplied no live totals line all week" and **it does not mean that.**

The `polyAnchor.*` counters increment only on the **Poly path**, and that
path runs only where Kalshi left `market_total` NULL
(`jobs.js:6300`):

```js
// Kalshi wrote first — only fill market_total when it left it NULL.
if (o.market_total != null) { skippedHaveKalshi++; continue; }
```

So games Kalshi priced never enter those counters at all. The counter
that reports Kalshi pricing is `kalshiRung`, and it is not zero — a
2026-09-21 pass for the 09-22 slate logged `persisted=0 auto=14`, i.e.
Kalshi's own rung on 14 games. Per game over 09-18..09-22, **49 of 64
games ended `total_source='kalshi'` and every game carried
`kalshi_anchor_total`**.

The correct, narrower statement:

> On the Poly path only — the games where Kalshi left the total NULL at
> pass time — the same-pass Kalshi anchor was never the source. Those
> games were anchored on the persisted anchor or fell to liquidity.
> #414's persisted anchor carries **the Poly path**. It is not carrying
> the whole totals path, because Kalshi prices most games directly.

The extraction was cleared of a parse bug before any of this was
believed: the shipped registry SQL was replayed against real production
messages and compared field-by-field against an independent regex, 0
mismatches, and the emitter concatenates `kalshi pass=` unconditionally
so the token cannot be absent. The one failure mode that could fake a
zero — token missing, `instr()` returns 0, `substr(a, 12)` reads a fixed
offset — is reachable in principle and unreachable here for that reason.

## The slate-level day/evening cut is dead

`odds-anchor-split` classifies a slate as `day` when **any** game starts
before the cutoff. In late September that is every slate: **70 of 70
rows came back `slate_type='day'`**, so there is no evening bucket and no
comparison. The label is not wrong, it is useless at this granularity —
one 1 PM game speaks for fourteen 7 PM ones.

This is recorded in the query's own description so the next reader does
not re-run it expecting a split. The replacement is
**`odds-poly-by-first-pitch`**, which cuts **per game** rather than per
slate: for each total, was its first pitch before or after the `hour`
param (default 11, the 11 AM PT pass). That is the granularity the
original 44% / 9.7% finding was measured at.

First run of it, over 09-18..09-22: Poly-priced games starting before
11:00 PT were **4, all on 2026-09-20** (`kc-pit`, `ath-cle`, `bos-tb`,
`chc-cin`, all 10:xx PT). On the one date in the window with a genuine
early slate, 4 of 5 early games went Poly against 9 of 59 elsewhere —
the shape of the original finding, on one date, which is where it stays
until there is more of it.

## Related

- `docs/kalshi-totals-snapshot-per-pass-open-question-2026-09-17.md` —
  the per-pass keying that made any of this readable.
- `services/admin-queries.js` — `odds-anchor-split`,
  `odds-anchor-passes`, `odds-poly-by-first-pitch`.
- CLAUDE.md §"an observability mechanism must not be able to take down
  the thing it observes" — why an extra pricing cycle on a 512MB
  instance needs a reason, and 9 or 11 fallbacks a week is not one.
