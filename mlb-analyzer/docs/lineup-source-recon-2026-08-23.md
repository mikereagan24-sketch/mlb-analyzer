# Lineup-source recon: both new sources are off-limits (2026-08-23)

> **No scrapers built. Reporting first, as scoped.**
>
> **RotoGrinders is technically easy and contractually prohibited** — its
> Terms of Service name scraping explicitly.
>
> **Lineups.com returns HTTP 403 behind Cloudflare bot protection** — it is
> actively refusing automated access.
>
> **The three-way comparison as specified cannot proceed.** The underlying
> question can, on a narrower footing — §5.

## RotoGrinders — extraction: trivial. Terms: prohibited.

**Extraction path: server-rendered HTML.** No `__NEXT_DATA__`, no
`__NUXT__`, no client-side state blob, only 4 `<script src>` tags. The
lineup DOM is in the initial response:

```
441 × "lineup-card"
class="game-card-lineups" / "lineup-card-pitcher" / "player-nameplate"

<div class="player-nameplate " data-position="SP" data-salary="8000">
  <a class="player-nameplate-name" href="/players/kyle-leahy-4933940">Kyle Leahy</a>
  <span class="player-nameplate-stats"><span class="small">(R)</span> …
```

Everything wanted is present: player name, a **stable slug id**
(`kyle-leahy-4933940`) that would make a durable join key, `data-position`,
handedness in the `(R)`/`(L)` span, and confirmed-vs-projected markers.
Batting order would come from DOM sequence within a card. This is the
easiest scrape target the project has encountered — easier than the ARI
roof page, which needed `__NEXT_DATA__`.

**And it is explicitly disallowed.** `rotogrinders.com/terms-of-service`:

> *"Users of the Service may not engage in unauthorized spidering,
> 'scraping,' data mining or harvesting of Content, or use any other
> unauthorized automated means to gather data from or about the Service."*

The same clause describes the Content as *"proprietary information,
statistics, and projections, both original and from other third-party
sources"* — i.e. the lineups specifically.

`robots.txt` permits `/lineups/mlb` and disallows `/api/`, but robots.txt
is not the governing document here; the ToS is, and it is unambiguous.

**Recommendation: do not scrape it.** Not a technical judgement — the
technical answer is that it would take an afternoon.

## Lineups.com — blocked before terms even matter

```
GET https://www.lineups.com/mlb/lineups/  ->  403
"Attention Required! | Cloudflare … You are unable to access lineups.com"
```

`robots.txt` has no rule against `/mlb/lineups/`, so the block is not a
crawl-policy statement — it is **active bot protection**. Getting past it
would mean defeating a measure whose purpose is to stop exactly this, and
that is not something to build.

I did not attempt any workaround, and would not.

## What this does to the plan

| piece | status |
|---|---|
| Same-day 3-way (RotoWire / RotoGrinders / Lineups) | **not possible** |
| Next-day 2-way (RotoWire / Lineups) | **not possible** |
| **Pre-registered prediction** (RotoGrinders > RotoWire same-day) | **cannot be tested** |

On the prediction: you asked for one, and the discipline was right — but
pre-registering a claim that cannot be measured would be theatre. It is
recorded here as **untested and untestable on current access**, not as
open. If access changes, it can be written then, before any measurement,
exactly as with the rookie ticket.

## §5 — what is still worth doing, and it is not nothing

The stated goal was choosing which lineup source to trust. Two-thirds of
the comparison is unavailable, but the **decision-relevant half survives**,
because the most conclusive metric never needed a competitor.

**Model impact does not require two sources.** Re-scoring a game with the
projected lineup and again with the confirmed lineup gives the run and
win-probability delta directly. That answers *"how much does lineup error
cost me"* — which is the question behind the question, and it is visible
without needing power, exactly as you argued.

So the buildable version:

1. **Storage as specified**, source-agnostic:
   `(date, game_id, source, horizon, capture_time)` plus slot, player,
   handedness, and a flag for whether handedness came from the source or
   from our roster data. Built for N sources, populated with one.
2. **Forward capture from RotoWire only**, at both horizons. This is the
   piece where every day not running is unrecoverable, and it is
   unblocked.
3. **Confirmed lineups from statsapi** as ground truth — already ingested,
   already trusted, no new access question.
4. **Metrics 1, 2, 3 and 5** (exact-slot, roster, handedness, coverage)
   computed for RotoWire against confirmed. These become a *quality
   baseline* rather than a ranking — still actionable: if RotoWire's
   next-day roster accuracy is 70%, that is worth knowing whether or not a
   rival is better.
5. **Metric 4 (model impact)** as the headline, for the reason above.

That yields "how good is the input I actually use, and how much does its
error move the model" — without answering "is RotoGrinders better", which
is the part access forecloses.

## If you want the comparison anyway

Legitimate routes, in rough order of effort:

- **Ask.** RotoGrinders sells data products; a licensed feed would make
  this a non-issue and is the only route that makes the ToS clause moot.
- **Check for an official API** at either, with terms that permit
  programmatic use.
- **Look for a source that permits it.** Some lineup providers publish
  feeds explicitly for this purpose; that is a survey worth an hour before
  assuming these two are the only options.

I have not contacted anyone or signed anything — that is yours to decide.

## Trigger

**None set**, deliberately. A trigger implies the work is queued, and the
three-way comparison is not queued — it is blocked on access that may
never come. The RotoWire-only build in §5 has no dependency and can start
whenever you want it.

If access is obtained, the trigger for revisiting is the same shape as the
rookie one: **enough captures for the model-impact metric to separate
sources.** With a typical run-delta of ~0.1–0.3 runs between a projected
and confirmed lineup, and day-to-day variance of similar size,
distinguishing two sources needs roughly **150–200 games per source per
horizon** — about six weeks of full-slate capture. That number should be
re-derived from observed variance once §5 has produced any, rather than
taken from this estimate.

## Related

- `docs/rookie-overrep-prediction-2026-08-23.md` — the pre-registration pattern this would have followed.
- `services/scraper.js` — where RotoWire lineup ingest already lives.
