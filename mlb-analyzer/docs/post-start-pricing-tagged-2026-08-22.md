# Narrowing the exposure, and tagging it (2026-08-22)
> ---
> **TWO FIGURES ON THIS PAGE ARE WITHDRAWN (2026-08-25).**
>
> **1. The 15.6% / 284-signal exposure is not comparable to anything
> measured since.** It was computed on the pre-refresh corpus (1,678
> games) with a criterion that has since changed. On the corrected corpus
> the same script tags **219 games** and finds **226 signals with a real
> price move out of 252 exposed**. Do not carry 15.6% forward.
>
> **2. Any claim resting on April-June `created_at` is withdrawn.**
> `bet_signals.created_at` in those months is NOT an emit time: **433 of
> ~454 June signals carry `created_at` at hour 01 PT**, a single nightly
> batch window matching the `auto_delete` / `set_closing_line` crons of
> that era. Rows were REWRITTEN at 1AM, not emitted then. Read as emit
> times they produce "87%, 94%, 99.8% of signals priced after first
> pitch", which is an artifact, not a finding. July onward is
> interpretable because `updated_at` exists and the hour distribution
> spreads across the cron schedule.
>
> Full re-measurement:
> `docs/corrupt-feed-and-post-start-recheck-2026-08-25.md`.
> ---

> **141 of 158 exposed ML signals had a price that actually moved after
> first pitch. 17 were no-ops.**
>
> The distribution is **bimodal**: median 4 points, but a 12% tail at
> 100+ points topping out at **543**.
>
> **134 games tagged `priced_post_first_pitch`. Nothing invalidated,
> nothing re-priced, live path untouched.**

## 1. Upper bound → count

`scripts/post-start-exposure.js` gave an upper bound: signals with a
price-*affecting* audit event after first pitch. That counts opportunities
to be mispriced, not mispricings — `COALESCE` and the odds lock make many
refreshes no-ops.

Comparing each stored line against the **last capture taken before first
pitch**:

```
exposed ML signals (upper bound)                 : 158
  no pre-first-pitch capture available           :   0
  price IDENTICAL to last pre-start capture      :  17   (genuine no-ops)
  price CHANGED after first pitch                : 141
```

Every one was measurable — `empirical_market_captures` covered all of
them, so nothing is being assumed clean.

## 2. The distribution, because 2 points and 40 points are not the same finding

```
n=141   min 1   p25 2   median 4   p75 10   p90 147   max 543
```

**The gap between p75 (10) and p90 (147) is the whole story.** This is not
one population with a tail; it is two populations.

```
|change|      n    share   still_active
1-5          72    51.1%     60
5-10         32    22.7%     17
10-20        15    10.6%      4
20-40         3     2.1%      1
40-100        2     1.4%      0
100+         17    12.1%      2
```

Half are 1–5 points — ordinary drift, indistinguishable from vig
rounding. Then a distinct cluster of **17 moves at 100+ points**:

```
2026-07-11 mil-pit  away   -132 -> +411   d=+543
2026-07-12 nyy-was  away   -104 -> +283   d=+387
2026-07-12 nyy-was  home   -117 -> +243   d=+360
2026-07-08 mil-stl  away   -155 -> +175   d=+330
2026-07-12 bos-nym  home   -104 -> +220   d=+324
2026-07-22 min-cle  home   -143 -> +102   d=+245   [ACTIVE]
```

**Every large move flips sign** — a favourite becoming a heavy underdog.
That is not line movement. That is the price reacting to a team losing a
game already in progress.

Note also that the small moves are where the *active* signals concentrate
(60 of 84 active changed signals are in the 1–5 band), while only 2 of the
17 extreme moves are still active. The worst cases are mostly historical;
the live book is mostly the mild end.

## 3. Tagged, not invalidated

Same shape as `weather_contamination_reason`, deliberately — including its
governing sentence, which applies here word for word:

> *Historical values are NOT overwritten — contamination is tagged, not
> silently re-scored, so the persisted values still faithfully record what
> the model actually saw at signal-emit time.*

New column `game_log.market_contamination_reason`, single nullable text,
`NULL` = trusted. **Not** a multi-tag column and **not** a join table: if
a game is both weather- and market-contaminated, one reason wins in its
own column and each `IS NULL` filter still excludes correctly, which is
the only property the filters need.

```
rows tagged            : 134 games (141 signals span 134 games)
distinct reasons       : priced_post_first_pitch
game_log rows total    : 1678  ->  134 tagged, 1544 clean
```

**Verified unchanged after tagging:**

- `bet_signals`: 1815 rows, 1359 active — *identical* to before.
- `market_*_ml`: 1643 rows still carry their stored line — no price
  overwritten.
- Live path: untouched. This is an analysis filter only.

Your logged bets keep the price they were logged at, and the record of
what the model saw is intact. Invalidating would have destroyed exactly
the evidence that made this measurable.

## 4. Consumers

`parameter-sweep.loadGames()` now filters `market_contamination_reason IS
NULL` alongside the weather filter — so every calibration harness built on
it (`calibration-ab`, `calibration-sweep`, `edge-honesty-scope`,
`component-signal-diagnostic`) inherits the exclusion.

The reasoning is specific: a market line that moved after first pitch
embeds the in-progress score. Left in, it acts as the baseline the model
is scored against — **the market looks artificially sharp and the model
artificially bad, on exactly the games where the market "knew" the
result.**

### What this does to the corpus, stated plainly

```
loadGames(2026-06-01 .. 2026-08-07):  859 -> 728 games   (131 excluded, 15.3%)
```

**Every calibration number reported before today was computed on the
contaminated corpus.** That includes the FRV, park_neutral,
hand_conditional, edge-honesty and component-diagnostic figures, and the
W_PIT/SP_WEIGHT sweeps.

Whether any conclusion changes is unknown until re-run. The direction is
not obvious: removing games where the market was artificially sharp should
make the market baseline *worse* and the model's gap to it *smaller*, so
the "model is significantly worse than the market" finding may soften. It
would be wrong to guess.

Not re-run here — that is a large batch and it should be a deliberate pass
rather than an afterthought to a data change.

## 5. What was not done

- **The 178 still-active signals are untouched**, as instructed. 84 of
  them are in the changed set; 60 of those are in the 1–5 point band.
- **Nothing re-priced or deactivated.**
- **No threshold applied.** All 141 movers are tagged, including 1-point
  drifts. The tag records the fact ("this price moved after first pitch"),
  which is true of all of them; if you later decide only >20-point moves
  warrant exclusion, the distribution above and
  `scripts/post-start-price-change.js` reproduce the split, and the
  criterion lives in one script rather than being baked into the data.

## 6. The method note

`scripts/tag-post-start-pricing.js` is **derived from**
`scripts/post-start-price-change.js` rather than reimplementing its
criterion, so the thing that measures and the thing that tags cannot drift
apart. It defaults to a dry run and requires `--apply` to write.

Timezone reasoning for `generated_at` is recorded in the script header and
generalised into `CLAUDE.md` §"Timestamp comparison discipline": the
`morning` capture track stamps `07:30:39`, which is a morning cron in PT —
read as UTC it would be 00:30 PT, and nothing called "morning" runs at
half past midnight.

## Related

- `docs/first-pitch-timestamp-and-exposure-2026-08-22.md` — the upper bound this narrows.
- `docs/corrupt-line-source-trace-2026-08-22.md` — why post-start prices exist at all.
- `CLAUDE.md` §"Timestamp comparison discipline" — the three bugs and the method that settled them.
- `db/schema.js` — `market_contamination_reason`, mirroring `weather_contamination_reason`.
