# The bulk pitcher's hand is measured-inert at its only call site (2026-09-19)

**Status: closed, no code change.** `game_log.bulk_guy_{side}_hand` is
**captured for future use and read by nothing**. Wiring it into
`services/model.js` as it stands would move **0 of 222** opener sides.

This doc exists because #424's write-up asserted the opposite — that
"the bulk slot has been priced against a hardcoded right hand on every
opener game" — and that claim was used to schedule a follow-up
measurement. The claim was wrong. The literal is real; its effect is
not.

Re-run everything below with:

```
node --max-old-space-size=1536 scripts/probe-bulk-hand-channel.js
```

## 1. Which of the two possible reasons it is

There were two candidate explanations, and they have very different
consequences. Measured on the analysis copy (`data/mlb.db`, rosters
refreshed 2026-09-14):

| candidate reason | verdict |
|---|---|
| (a) every bulk pitcher is RHP, so the hardcoded `'R'` was accidentally right | **FALSE** |
| (b) the hand never reaches a price on that path, so the column is decorative | **TRUE** |

**(a) is false, and not marginally.** Of 222 opener sides carrying a
named bulk pitcher, the bulk's real handedness is:

```
R = 172    L = 49    S = 0    unresolved = 1
```

So `'R'` is **factually wrong on 49 sides — 22.1%**. Anyone checking
only the premise would conclude there is a real defect here. There
isn't, for reason (b).

## 2. Why the hand cannot reach a price

Two independent blocks, either of which alone would be enough.

**Block 1 — at the call site, `hand` selects a default that is never
consulted.** `services/model.js:1029` is the only pricing call that
passes a hardcoded hand:

```js
const bulkW = getPitcherWoba(wobaIdx, bulkSp, 'R', team, W_PROJ, W_ACT, MIN_BF, settings);
```

Inside `getPitcherWoba` (`:532`) the `hand` argument does exactly one
thing — pick `d`, the per-hand default — and `d` is applied only
through `?? d.vsLHB` / `?? d.vsRHB`, i.e. **only when that split is
missing from the wOBA index**. Real bulk pitchers are in the index, so
the default is dead. Every left-handed bulk, scored both ways:

```
Jacob Lopez (ATH)     asR vsL=0.2780 vsR=0.3407 | asL vsL=0.2780 vsR=0.3407  identical  src=blend
Cade Gibson (MIA)     asR vsL=0.3106 vsR=0.3404 | asL vsL=0.3106 vsR=0.3404  identical  src=blend
Sean Manaea (NYM)     asR vsL=0.3056 vsR=0.3526 | asL vsL=0.3056 vsR=0.3526  identical  src=blend
Ian Seymour (TB)      asR vsL=0.3196 vsR=0.3100 | asL vsL=0.3196 vsR=0.3100  identical  src=blend
Andrew Alvarez (WAS)  asR vsL=0.2975 vsR=0.3030 | asL vsL=0.2975 vsR=0.3030  identical  src=blend
Ryan Yarbrough (NYY)  asR vsL=0.3132 vsR=0.3113 | asL vsL=0.3132 vsR=0.3113  identical  src=blend
```

And on the one branch where `d` *would* be consulted — `source ===
'fallback'`, the index miss — `buildOpenerOpts` immediately overwrites
**both** splits with `UNKNOWN_PITCHER_WOBA` (0.335), discarding `d`:

```js
if (bulkW.source === 'fallback') { bulkVsL = UNK_PIT_WOBA; bulkVsR = UNK_PIT_WOBA; }
```

So the hand is unused when the pitcher is found and overwritten when he
is not. There is no third case.

**Block 2 — no bulk hand reaches the platoon split at all.**
`perBatterEW` (`:597`) takes a **single** `pitcherHand` for the whole
game, which `runModel` fills with the opposing SP's hand (the
*opener's*, on an opener game). It drives `effHand()` for switch
hitters and the `vsStart`/`vsOpp` selection. The bulk contributes only
via `bulkVsL`/`bulkVsR`, which are indexed by the **batter's**
effective hand. No per-slot hand is passed in, so even a correct
`bulk_guy_{side}_hand` has nowhere to go.

Block 2 is a genuine modelling gap and is filed separately as
`docs/per-slot-pitcher-hand-open-question-2026-09-19.md`. It is a
different and much larger change than reading this column.

## 3. The whole-population result

Treatment = replace `'R'` with the real hand wherever the real hand is
not `'R'` (i.e. the 49 lefty sides), then compare the wOBA pair the
model actually consumes, `UNKNOWN_PITCHER_WOBA` overwrite included:

```
opener sides with a named bulk                        : 222
  of which real hand is LEFT                          :  49  (22.1%)
distinct (team, bulk) pitchers                        : 118
  index MISS (source = fallback)                      :   1
GAME-SIDES where the consumed bulk wOBA changes       :   0
```

**Zero.** A calibration A/B on this change returns ΔlogLoss `0.00000`
by construction. Per CLAUDE.md §"Guard-removal rule", results that
reproduce to five decimals mean the thing you thought you changed did
not change — here that is the correct answer rather than a broken
harness, and it is cheaper to establish with the probe above than with
a five-window run.

One caveat on a number that looks like a counter-example: the probe's
raw pass reports **2 of 118** pitchers whose `getPitcherWoba` output
differs between `'R'` and `'L'`, and **1** surviving the overwrite
(Matt Waldron, SD — his `vsRHB` lookup misses and falls to the
default). Neither is in the treatment group: both are **right-handed**,
so the real-hand arm passes `'R'` for them and nothing moves. The
probe compares `'R'` vs `'L'` for every pitcher deliberately, to show
the mechanism is live in principle; the population result is the `0`.

## 4. Column status, and what would make this stale

`game_log.bulk_guy_away_hand` / `bulk_guy_home_hand` (added #424):

- **Written** by `services/jobs.js` `writeDetection`, and only when an
  `opener_override` supplies a hand — i.e. when the operator picks the
  bulk from the roster dropdown. On the auto-detection path it is
  written `NULL` by design (`resolveMlbId` yields an id, not a hand).
- **Read** by nothing. A grep across `services/ routes/ utils/ db/`
  returns the schema migration, the writer, and the test — no consumer.
- Currently **NULL on all 2157 rows** of the analysis copy, since the
  column postdates it.

Keep it. The capture is correct and costs nothing, and the per-slot
work in §2/Block 2 would need exactly this value. It is captured for
future use, not read.

**This finding goes stale if `getPitcherWoba` changes** so that `hand`
affects the found-in-index path, or if `buildOpenerOpts` stops
overwriting on the fallback branch. Deliberately NOT wired into
`npm test`: the inert property is *expected* to end when per-slot hand
is built, and a check that fails the moment someone does the right
thing is the "check nobody reads" failure in CLAUDE.md §"Scope a check
to what it can act on". Re-run the probe instead — it is one command
and it prints its own inputs.
