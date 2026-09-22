# Lineup names that don't reach a woba_data row (2026-09-23)

Found while chasing a single reported case: RotoWire lists an SF player as
**Bo Davidson**, FanGraphs has him as **Chanteyon Davidson**. The scan that
followed found the nickname class is the smallest of four, and that the
largest one was not a name problem at all.

## The measurement

2026 season, local copy through 2026-09-23. Every lineup slot resolved
through the real `fuzzyLookup` against all four batter maps; a slot
"resolves" if any map hits, because that is what keeps it off `BAT_DFLT`.

```
games with lineups           2225
lineup slots                40050
resolved                    39931   (99.70%)
failed                        119   (0.30%)  across 39 distinct (name, team)
```

| players | slots | class | mechanism |
|---|---|---|---|
| 1 | 48 | suffix read as a team tag | resolver — **fixed**, see below |
| 9 | 36 | woba row carries a different team tag | stale tag after a trade/callup — **open** |
| 25 | 31 | same team, different first name | 22 feed errors, 2 spacing, **1 real** |
| 3 | 3 | several same-surname candidates | ambiguity, correctly refused |
| 1 | 1 | surname exists, initial matches, other team | stale tag |

**The 0.30% figure understates the damage**, because a slot counted as
resolved if *any* of the four maps hit. See the actuals-only finding below.

## Fixed: a 2-3 letter trailing token is a team tag only if it IS one

`fuzzyLookup` skipped index entries carrying a team tag in stages 6,
6.5-global and 7, using the shape `/\s[a-z]{2,3}$/`. That is true of any
short trailing token, and 64 distinct non-team tokens in `woba_data` match
it: suffixes (`jr` 40 entries, `iii` 7, `ii` 3, `iv` 2), short surnames
(`lee` 13, `kim` 12, `paz` 4, `gil` 4, `oca` 3, `fry`, `cox`, `son`, `ha`,
`woo`, `may`, `ray`, `ryu`, `oh`, `bae`, `lux`, `puk`, `baz`, `fox`, `orr`,
`seo`…), and FanGraphs' `tms` multi-team marker.

Replaced with membership in `TEAM_TOKENS` (`utils/names.js`), asserted
against every team the database spells by
`scripts/test-team-tag-membership.js`.

**Measured before/after over all 160,200 lookups (40,050 slots x 4 maps):**

```
identical value    150373
NEWLY resolving      1416
LOST                    0
CHANGED                 0
```

Eight players, and seven of them were resolving their **projection** but
not their **actuals** — projections are team-tagged so stage 5 reached
them, while actuals are collision-only tagged and therefore bare, and the
bare suffixed key was the excluded one:

```
lookup          team   proj-lhp  proj-rhp  act-lhp  act-rhp
F. Tatis        SD     was ok    was ok    GAINED   GAINED
M. Harris       ATL    was ok    was ok    GAINED   GAINED
V. Guerrero     TOR    was ok    was ok    GAINED   GAINED
J. Chisholm     NYY    was ok    was ok    GAINED   GAINED
L. Gurriel      ARI    GAINED    GAINED    GAINED   GAINED
G. Lombard      NYY    was ok    was ok    GAINED   GAINED
R. Flores       PIT    was ok    was ok    GAINED   GAINED
G. Rincones     PHI    was ok    was ok    still-   GAINED
```

So Tatis, Harris, Guerrero and Chisholm were **priced on projection alone
all season** — the actuals term silently absent from the blend, which is
the same defect class as #435-#439 one layer down: in the resolver rather
than the ingest. Gurriel lost both halves because his projection row also
carries no team tag, and defaulted to league average across 48 slots
between 2026-04-18 and 2026-09-11.

Three suffixed names and nine short-surname entries are still unreachable
in abbreviated form, and correctly so: `r martin` matches both Richie
Martin Jr. and Robby Martin Jr., `h kim` matches four Kims. The
exactly-one gate refuses to guess. That is ambiguity, not this bug.

## Open: the stale team tag, 36 slots across 9 players

A `woba_data` row tagged with the team the player was on when the file was
built, looked up under the team he is on now:

```
 8  B. Kennedy [SF]      -> "buddy kennedy was"       2026-06-02..2026-08-26
 7  Greg Jones [MIL]     -> "greg jones chc"          2026-04-16..2026-07-08
 6  C. Robinson [LAD]    -> "chuckie robinson atl"    2026-06-12..2026-07-01
 4  J. Rodriguez [BAL]   -> "jesus rodriguez sf"      2026-04-15..2026-07-22
 4  Kyler Fedko [MIN]    -> "kyler fedko pit"         2026-06-15..2026-07-07
 3  B. Kennedy [SEA]     -> "buddy kennedy was"       2026-07-10..2026-07-20
 2  S. Whitcomb [HOU]    -> "shay whitcomb sf"        2026-04-19..2026-06-10
 1  Jared Oliva [SF]     -> "jared oliva tb"          2026-04-14..2026-04-14
 1  Brice Perkins [MIL]  -> "blake perkins cle"       2026-04-05..2026-04-05
```

Not yet dispositioned. The two candidate shapes are a resolver fallback
(try the untagged/any-team key when the team-scoped lookup misses) and an
ingest fix (the tag should follow the current roster). They are not
equivalent: the resolver version will match a genuinely different player
who shares a surname, which is the failure mode collision-only tagging
exists to avoid.

## Held: the alias table

**Not built, deliberately.** The genuine alternate-name class is one
player and three slots — 0.007% of the season's slots — and an alias table
populated from this scan would have encoded 22 opening-weekend feed errors
as real names. Every one of those 22 appears correctly on an adjacent
date: `Jeremiah Merrill` -> `J. Merrill` (2026-04-04), `Wilyer Contreras`
-> `W. Contreras`, `Jackson Crawford` -> `J. Crawford` (2026-04-10).

### Known unresolved, recorded so a growing class has a starting point

| player | mlb_id | team | woba_data name | slots | dates |
|---|---|---|---|---|---|
| Bo Davidson | **815589** | SF | `Chanteyon Davidson SF` | 3 | 2026-09-21 .. 2026-09-23 |

The lookup misses every stage and falls to `BAT_DFLT`. It fails **safe** —
`logan davidson tb` and `matt davidson` are both in the index and neither
is wrongly matched.

If this is ever built, the key is the **MLBAM id**, not a second name
string. Three facts constrain the design, all verified 2026-09-23:

1. A lineup slot carries **no id**: `{"name":"J. Crawford","hand":"L","pos":"SS"}`.
2. `woba_data` has **no id column** either — it is `(data_key,
   player_name)`. Its `team_abbr` column exists and is populated on
   **0 of 3260** rows; it is dead.
3. `team_rosters` is the only id source, and it agrees with the lineup
   feed: `Bo Davidson`, `mlb_id 815589`, SF. **MLB's own roster uses the
   nickname**; FanGraphs is the outlier carrying the legal name.

So the shape would be `mlb_id -> canonical woba_data name`, reached by
joining lineup name + team through `team_rosters`. Two limits: the join
still starts from a name, and `team_rosters` is a live snapshot (840 rows,
refreshed daily), so historical cases cannot be keyed from it — of the 25
first-name mismatches, only Davidson has a resolvable `mlb_id` today.

## Also open: two spacing variants

`Ke Bryan Hayes` / `kebryan hayes` and `Ji Hwan Bae` / `jihwan bae`. Both
are the same name with the first name split differently, so they are a
**normalization** question, not an alias one. 3 slots, all pre-September.
Not yet dispositioned.

## Re-run

```
node --max-old-space-size=1536 scripts/test-team-tag-membership.js
```
