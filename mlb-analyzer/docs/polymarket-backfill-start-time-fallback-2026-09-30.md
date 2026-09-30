# Polymarket backfill: the game_time start-time fallback (2026-09-30)

Local-only, display-only feature (`services/polymarket-backfill.js`). This note
records why the backfill may use `game_log.game_time` as a pre-game cutoff, and
the evidence behind it.

## The problem

Decision 4 sets each game's pre-game cutoff to `game_log.scheduled_start_utc`.
278 non-removed games from 2026-04-04 to 2026-04-26 never had that column
written, so without a fallback they drop out: 277 Polymarket markets and about
359k pre-game fills, roughly 12% of the season.

## The rule

`game_time` is a display string, `"h:mm AM|PM ET"`: the scheduled start on
`game_date` as read on a New York clock (the writer says so in
`services/jobs.js`, "game_time is stored in ET").

To get UTC, read that wall-clock time on `game_date` in America/New_York and
convert. Daylight saving comes from the platform's timezone rules, not a
hand-coded offset. In 2026, daylight time runs from March 8 to November 1.
Anything not in exactly that shape returns null: a missing "ET", a null, or an
impossible hour. We never guess a zone.

Code: `etGameTimeToUtc` in `services/polymarket-backfill.js`.

## The proof

`node scripts/polymarket-backfill.js --audit-game-time` runs
`auditGameTimeRule`. It opens `data/mlb.db` read-only and checks every
`game_log` row that has both fields.

Result on 2026-09-30:

| Outcome | Games |
|---|---|
| Exact to the minute | 2,020 / 2,049 (98.58%) |
| Moved: `scheduled_start_utc` holds a make-up or resumption date; `game_time` kept the original slot | 28 |
| No "ET" in the string (`col-nym-g2` 2026-04-26, "10:45 AM", which equals 17:45Z, i.e. Pacific) | 1 |
| Unexplained | 0 |

There were no near misses: every row is either exact or at least 16 hours
apart. The smallest gap is lad-nyy on 2026-07-18, played the next day. Examples:

- pit-nyy 7/21: moved exactly one day.
- tb-bos 5/09: moved to 7/17, and Polymarket's start moved with it.
- tb-nyy 5/23: moved to 9/22.
- sf-atl 6/16: the first pitch matches `game_time`, but the scheduled start
  shows 6/17, most likely a suspended game resumed the next day.

All 2,049 rows fall under daylight time, so no real game crosses a daylight-saving
change. Synthetic tests cover both 2026 boundaries.

Mike accepted the result on 2026-09-30 with every mismatch explained, despite
the sub-99% raw rate.

## How the fallback is used

The normal cutoff is the earlier of `scheduled_start_utc` and `first_pitch_utc`,
whichever exist. The earlier one matters for a suspended game (sf-atl
2026-06-16): it started on its original date, while `scheduled_start_utc` holds
the resumption date.

The fallback applies only when neither field exists (`resolveCutoff`):

1. `game_time` is converted by the rule above.
2. The converted time must agree with Polymarket's own `gameStartTime` for that
   market within 15 minutes (inclusive). If it does, the cutoff is accepted
   with `markets.cutoff_source = 'fallback_confirmed'`.
3. If they disagree, or Polymarket has no start time, the game is excluded as
   `start_time_unconfirmed`.

This check is what catches a postponed game. Such a game keeps its original
`game_time` slot while Polymarket moves to the make-up date.

A game with neither field is excluded as `no_start_time`. A `game_time` the
rule cannot read is excluded as `game_time_unparseable`; Polymarket's time is
never substituted. When either start field exists, the fallback is not
consulted (`cutoff_source = 'scheduled_start_utc'` or `'first_pitch_utc'`).

## Offline effect over the 2,503 season markets

This count used the earlier discovery's market list and made no network calls:

- **Recovered, `fallback_confirmed`:** 260 markets, about 340k pre-game fills.
  Polymarket agreed to the minute on 259 and was 5 minutes off on 1.
- **`start_time_unconfirmed`:** 10 markets. Six are on 2026-04-04 and 04-05, a
  day with postponements that includes the chc-cle 4/04 → 4/05 make-up, where
  game 1 is 30 minutes off. The other four are on 04-16 and 04-18.
- **`no_start_time`:** 6 markets, all on 2026-04-04.
- **`game_time_unparseable`:** 1 market (mia-sf 2026-04-24, "7:15 PM").

Tests: section g of `scripts/test-polymarket-backfill.js`.

## Scope: regular season only (2026-09-30)

The backfill covers MLB's regular season only. The dates come from statsapi's
`/api/v1/seasons/2026`: 2026-03-25 (the opener, NYY @ SF) to 2026-09-27. They
are held in `REGULAR_SEASON`, not taken from game_log, because game_log's first
date (2026-04-04) is nine days late (#486).

| Markets | Reason | Count |
|---|---|---|
| Slug date before 03-25 | `spring_training` | 258 |
| Slug date after 09-27 (the Wild Card Series, 09-29 and 09-30) | `postseason_out_of_scope` | 8 |
| 03-25 to 04-03 | `missing_game_log_date` | 110 |

The 110 were first mislabeled `spring_training` because the rule used game_log's
first date. The same reason, `missing_game_log_date`, also covers 04-07 and 04-08
(30 markets), which game_log has no rows for either (#486).

**Postseason handling is deferred to the card stage.**

Tests: section i.
