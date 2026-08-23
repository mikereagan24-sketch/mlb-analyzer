# The edge cap is a corrupt-input trap, and the data proves it (2026-08-22)

> **You were right to ask before applying. The failure mode is real,
> it is active right now, and nothing else guards it.**
>
> **Applied: `signal_edge_hard_cap_pp` 0.08 → 0.25**, with its purpose
> written into the schema help. This restores the parameter's original
> design intent rather than picking a new number.

## The question

> *Confirm whether a genuinely bad line could produce a large edge that
> currently gets suppressed and would otherwise become a bet.*

**Yes. 279 times, on 28 separate dates, in the last seven weeks.**

## The evidence

`bet_signal_audit` records every suppression with the market line that
caused it. Over 2026-07-07 .. 2026-08-23 the cap suppressed **1,283
distinct signals** (5,422 raw events — each signal is re-evaluated on
every odds refresh).

Splitting them by whether the market line is physically plausible:

| edge band | n | with \|marketLine\| > 1000 |
|---|---|---|
| 8–10pp | 330 | **0** |
| 10–15pp | 306 | **0** |
| 15–20pp | 73 | **0** |
| 20–25pp | 61 | **0** |
| 25–35pp | 167 | 22 |
| 35pp+ | 346 | **257** |

**The separation is clean and it falls exactly at 25pp.**

- Below 25pp: **770 signals, not one** with an implausible line. This is
  ordinary model-market disagreement.
- At or above 25pp: 513 signals, **279 of them (54%) carrying a corrupt
  line**.
- **All 279 corrupt-line signals have edge ≥ 0.25. Zero fall below it.**

Actual corrupted moneylines seen, in descending order:

```
+94400, +89373, +88237, +88039, +80672, +80053, +79452, +76306,
+62105, +60579, +57628, +56895, ...
```

These are not prices. A real MLB moneyline lives roughly in −400..+400,
occasionally +600 on an extreme mismatch. `+94400` is a feed artifact —
almost certainly a no-liquidity or placeholder value passed through as a
number. The edges they generate run **25pp to 65.8pp**.

**This is not a historical one-off.** It occurred on 28 distinct dates
between 2026-07-07 and 2026-08-06 — very nearly daily. Whatever produces
these lines is still doing it.

## Nothing upstream stops them

There are two odds-sanity functions, and neither closes this:

| check | what it does | does it block? |
|---|---|---|
| `checkMarketMLPairSanity` | structural pair validation | **yes** — suppresses ML signals at `jobs.js:891` |
| `checkOddsSanity` | pair sanity **plus** an extreme-line test (implied p > 0.80) | **no** — at `jobs.js:3718` it only pushes a string into `reasons[]`, and only runs when `!singleSource`, i.e. when a cross-check book exists |

So the extreme-line test — the one that would catch `+94400` — **only
annotates, and only sometimes runs.** The 279 corrupt-line signals passed
the structural check, were at most flagged by the extreme-line check, and
arrived at `getSignals` intact.

**The edge cap was the only thing that stopped them from being emitted as
bets.** Removing it entirely would have left that unguarded, exactly as
you suspected.

## Why my earlier analysis missed this

`docs/harness-reruns-and-cap-sign-test-2026-08-22.md` §5 reported that a
0.25 cap "suppresses 0 of 1026 signals — on this corpus 0.25 is inert."

That was accurate about the corpus and **misleading about the system.**
The backtest corpus is built from `game_log`, which contains only **2
rows out of 1,643** with an implausible line, and `preScreenGame` drops
those before scoring. The corrupt lines that the live path sees at a rate
of ~10/day are almost entirely absent from the backtest.

**So the ROI analysis was structurally incapable of seeing the failure
mode the cap exists to prevent.** It measured the cap purely as a
behavioural filter — which is the only thing it *could* measure — and
concluded, correctly within that frame, that 8pp is unsupported. It could
not have told you whether the guard was needed. Only the production audit
log could, and I should have consulted it before recommending removal.

The two findings stand together without contradiction:

- **As a behavioural/ROI filter, 8pp is unsupported** — rank 13 of 14,
  bounded harm failing in the wrong direction, suppressing the only
  positive edge band. That analysis is unaffected.
- **As a data-integrity ceiling, the cap is necessary** — and 25pp is
  where the corrupt population empirically begins.

## This restores the original design, it does not invent a number

The schema already recorded the history, at `settings-schema.js:335`:

> *Hard-cap floor lowered 0.10 → 0.05 (2026-07-13). Original 0.10 floor
> was written when the cap was intended as a **data-integrity ceiling**
> (default 0.25).*

and in the help text:

> *Default 0.25 was designed as a **data-integrity ceiling**; PR #174
> validated 0.08 as a **behavioral filter**.*

So the parameter was **built** as a corrupt-input trap at 0.25 and later
**repurposed** to a behavioural filter at 0.08 on ROI evidence. This
change reverts the repurposing, which is the part the evidence does not
support, and keeps the original purpose, which the evidence confirms.

`model.js:1530` still calls it the "edge-sanity cap" and `jobs.js:1409`
still says a burst of them is "an input-breakage alarm." **The code never
stopped describing it as a trap.** Only the value drifted.

## What changed

| | before | after |
|---|---|---|
| `signal_edge_hard_cap_pp` (prod) | 0.08 | **0.25** |
| schema default | 0.25 | 0.25 (unchanged — prod now agrees) |
| `signal_edge_soft_cap_pp` | 0.06 | 0.06 (untouched) |
| `signal_edge_cap_enabled` | true | true (untouched) |

Verified after write: `getSettings()` returns 0.25, invariant
`hard > soft` holds, value inside schema bounds [0.05, 0.50], and prod
now matches the schema default.

The schema help was rewritten to state the purpose explicitly, including
the empirical basis for 25pp and a direct instruction not to lower it to
chase ROI — because that is precisely what happened last time, and the
help text is where the next person will look.

### Expected effect

- The **770** ordinary 8–25pp signals per ~7 weeks that were being
  suppressed will now emit. That includes the 8–10pp band, which carries
  the only positive realized ROI in the book (+15.1%, n=81) and is the
  only band whose claimed edge cannot be shown to be dishonest
  (CI does not exclude slope 1.0).
- The **279** corrupt-line signals remain suppressed, as do the 234
  non-corrupt signals above 25pp.
- Soft-cap flagging at 0.06 is unchanged, so everything ≥6pp still
  carries `edge_suspect=true` for UI de-emphasis. **More signals will now
  emit carrying that flag** — that is the intended behaviour, not a
  regression.

### What to watch

A burst of `suppressed_edge_cap` events is an input-breakage alarm, and
that alarm now has a much higher threshold. **The corrupt lines are still
arriving ~10/day** — they are simply being caught rather than fixed. The
real fix is upstream: make `checkOddsSanity`'s extreme-line test *block*
rather than annotate, and run it without requiring a cross-check source.
That is a separate change and is not made here.

## Related

- `docs/harness-reruns-and-cap-sign-test-2026-08-22.md` §5 — the ROI/Tier-2 analysis, and why it could not see this.
- `docs/three-targets-hfa-cap-framing-2026-08-22.md` §2 — the first pass on the level.
- `services/jobs.js:459` `checkOddsSanity` — the upstream check that only flags.
- `services/model.js:1530` — the cap itself, still described in code as the "edge-sanity cap".
