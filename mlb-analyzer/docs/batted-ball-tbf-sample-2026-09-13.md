# Batted-ball sample size is TBF, and the column says so (2026-09-13)

Dry run `2f88b687` failed with *"no BIP column and no GB/FB/LD counts to
reconstruct it from"*. It was right to fail — the panel has neither.

## The panel, finally captured

```
Season, playerName, playerId, TeamNameAbb, IP, TBF, GB/FB, LD%, GB%, FB%,
IFFB%, HR/FB, IFH%, BUH%, Pull%, Cent%, Oppo%, Soft%, Med%, Hard%
```

Percentages and two volume fields (`IP`, `TBF`). No `BIP`, and no GB/FB/LD
counts to build one from. The parser now uses **`TBF`** and does not attempt
any reconstruction: the panel has no counts, and deriving a batted-ball
total from a rate would be inventing a quantity rather than reading one.

## TBF is not balls in play, and the column is named for what it is

`TBF` **overcounts** the batted-ball sample by the strikeout-plus-walk
share — a batter faced who strikes out or walks never puts a ball in play.
For *weighting* one pitcher's rates against another's that is adequate: the
overcount is roughly proportional across pitchers, and the weight only has
to rank sample reliability. It is **not** adequate for anything needing a
batted-ball count as a quantity.

So the column is **`sample_tbf`**, not `bip`. A column called `bip` holding
batters faced is the `capture_track='gametime'` trap from CLAUDE.md — a name
that reads as a fact and isn't one, which stays wrong long after the comment
explaining it is forgotten. Renaming was free here: **both tables were
empty**, because every write attempt had failed on the missing BIP column.
The migration is a guarded, idempotent `ALTER TABLE … RENAME COLUMN`.

## Two other things the captured keys exposed

**`TeamNameAbb`, not `Team`.** My team-key candidates were
`['Team','team','TeamName']`, so every row resolved **team-less** and the
name+team disambiguation in `utils/fg-pitcher-id.js` could never fire. Name
resolution still worked for unambiguous names — which is why #393 looked
like it was working — but any pitcher whose normalised name collides with
another's was resolving to null for want of a team qualifier that was
present in the payload all along. Added.

**`playerId` is FanGraphs' id, not MLBAM.** It sits right there in the key
set, and the tempting "fix" is to use it. The payload-id picker accepts only
the `xMLBAMID` spellings, everything else goes through the name resolver,
and there is now a comment at that line plus a test asserting an
unresolvable row does **not** fall back to `playerId`. Writing FG ids into
an `mlb_id` column would corrupt the join silently.

## Verification against the exact captured keys

```
node scripts/test-batted-ball-id-resolution.js     # 54 checks, exit 0
```

Section 3b builds rows whose key set is asserted **equal to the captured
list**, and runs them through the real parser via a stubbed `fetch` — no
network, no credential. It covers:

- the panel parsing without throwing, in **both** unit conventions
  (`0.485` and `48.5`), since which one FG serves is still unverified and
  the GB+FB+LD identity is what decides it
- shares normalised to fractions either way
- `TBF` carried as `sample_tbf`, and **no `bip` field on the row**
- `TeamNameAbb` reaching the resolver
- an unresolvable row **not** falling back to FG's `playerId`
- a panel with `TBF` deleted failing with *"no TBF column to weight by"* —
  and no longer claiming to look for counts to reconstruct

## What to expect on the retry

The dry run should now parse. **The number to read is `resolution`:**
`fetched` / `resolved` / `unresolved` per split, with `unresolved_sample`
naming examples. A 2025 pull contains pitchers who never appeared in 2026
and have no id in either source, so some unresolved rows are expected and
correct. If `resolved` is a small fraction rather than most of ~362 per
split, that is a third finding and it will be visible before anything is
written.

Still unverified, and deliberately so: which unit convention FG actually
serves. The identity check handles both, and the stored value is a fraction
either way, so this is not a thing to guess at — the dry run's output will
show it.
