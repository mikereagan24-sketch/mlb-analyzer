# Blocking implausible lines, and the fail-open sweep (2026-08-22)

> Three follow-ups. **The cap is no longer the only backstop, the
> guard-removal lesson is in CLAUDE.md, and the fail-open sweep found no
> fourth instance.**

## 1. CLAUDE.md — the guard-removal rule

New section: **"Guard-removal rule: ask what failure mode it prevents"**.

The core statement:

> Before removing, weakening, or relaxing any guard, state in writing
> what failure mode it exists to prevent, and confirm whether that
> failure mode is present in the data you are about to evaluate it on.
> **An ROI or calibration analysis run over cleaned historical data
> cannot evaluate a guard whose job is to catch dirty data.**

It records the specific mechanism — `preScreenGame` drops malformed rows
from `game_log`, so a guard against malformed input is measured on a
population its target has already been removed from — and files it as the
same *class* as the existing "Sweep ROI measures selection, not pricing"
rule: a structural mismatch between instrument and question, where a null
carries no information in either direction.

Also recorded there, because both came out of the same incident:

- **Flag thresholds and block thresholds are different numbers**, with
  the p>0.80 / |ML|>1000 case as the worked example.
- **A guard that fails open is not a guard**, with the three-site table.
- **The tell is identical digits.** Results reproducing a previous run to
  five decimals are almost never a real null — they mean the thing you
  thought you changed did not change. Check that before writing up a null.

## 2. Blocking implausible lines

### Where the hole actually was

The fix does *not* belong in `checkOddsSanity`. Tracing the call graph:

| function | catches | blocks? |
|---|---|---|
| `checkMarketMLPairSanity` (`utils/market-sanity.js`) | both-positive pair; implied-sum outside [0.95, 1.20] | **yes** — `jobs.js:891` nulls the runtime market, `model.js` re-checks |
| `checkOddsSanity` (`jobs.js:459`) | delegates to the above, **plus** implied p > 0.80 | **no** — pushes a string into `reasons[]`, and only runs when a cross-check book exists |

A corrupt line of `+94400` paired with a matching deep favourite
(`-99900`) **passes both existing structural checks**:

- signs are opposite → the both-positive test does not fire;
- implied p sum = 0.00106 + 0.99900 = **1.000**, comfortably inside the
  vig band.

Verified directly against the live code before patching — the observed
corrupt pair returned `pass`. That is precisely why 279 corrupt-line
signals reached `getSignals` with only the edge cap behind them.

So the gap was never that `checkOddsSanity` merely annotates. It is that
**no structural check tested line magnitude at all.**

### The threshold is measured, not chosen

Across 1,643 `game_log` rows carrying both moneylines, the per-game
`max |ML|` distribution is:

```
p50   p90   p99   p99.5   p99.9    max
137   186   279     299     403   99900
```

**The distribution is bimodal with an empty gap.** Real MLB lines top out
near 400; there is nothing at all between 403 and 99900. `MAX_ABS_ML =
1000` sits inside that gap at ~2.5× the observed real maximum.

Rejection counts confirm it is not a knife-edge:

```
|ML| >  400 : 3 games   |ML| > 1000 : 2 games   |ML| > 5000 : 2 games
```

Every threshold from 600 upward rejects the same 2 rows — the corrupt
ones. There is no tuning sensitivity to worry about.

**Why not simply promote the existing p > 0.80 flag to a block:**
implied p > 0.80 is ML −400, which is *inside* the real range (p99.9 =
403). Blocking there would suppress legitimate heavy favourites. The
existing threshold is a good flag threshold and would be a bad block
threshold.

### The change

`MAX_ABS_ML = 1000` added to `checkMarketMLPairSanity`, checked **before**
the implied-sum band (a corrupt line paired with a matching favourite
sums to ~1.0 and would otherwise pass).

Placed there deliberately: that function is already on the blocking path
and already runs **unconditionally**, with no cross-check-book
requirement. `checkOddsSanity` delegates to it first, so the annotation
path inherits the check for free. This satisfies both halves of the ask —
block rather than annotate, and run without requiring a cross-check book —
without restructuring the flag path.

Behaviour verified case-by-case:

```
  94400 /  -99900   BLOCK   observed corrupt pair
 -99900 /   94400   BLOCK   same, reversed
  -1200 /     900   BLOCK   just over the bound
   -999 /     850   pass    just under the bound
   -400 /     320   pass    legitimate heavy favourite
    403 /    -480   pass    real p99.9 line
   -110 /    -110   pass    pick'em juice
    136 /     105   BLOCK   the CLE-CIN both-positive case (unchanged)
```

**Blast radius: 2 of 1,643 historical rows**, both corrupt. On the live
path the ~279 signals per seven weeks that the cap was catching will now
be stopped upstream, at the point where the market is nulled, rather than
at emission.

The edge cap stays at 0.25 as the second layer. Two independent guards
against the same failure is the correct arrangement for input corruption
that arrives ~10/day.

## 3. Fail-open sweep — no fourth instance

Searched for the shape: a hand-maintained key list where an unrecognised
key is skipped rather than raised.

| pattern searched | result |
|---|---|
| `if ('KEY' in obj)` dispatch chains | only `parameter-sweep.js` — **already fixed** |
| `switch` with no `default:` | one apparent hit in `baserunning-backtest.js`, a **false positive** — the word "switch" in comments describing option flags, not a `switch` statement |
| hand-maintained whitelists / allowlists | `CALLER_POPULATED_FIELDS` (fixed), `SWEEP_PARAMS`, `roof-prior`'s allowlist (deliberate and documented as such) |
| `SWEEP_PARAMS` vs `applySweepOverrides` KNOWN list | **consistent** — no key advertised as sweepable that the applier cannot handle |
| schema keys not surfaced by `getSettings()` | **4, all deliberate** `ui_highlight_*` |

**No fourth site found.** The three known instances are all closed:

1. `applySweepOverrides` — throws on an unrecognised key, and names
   `BAT_HAND_SP_PAIRED` when the key is `SP_WEIGHT`.
2. `CALLER_POPULATED_INPUTS` — keyed by parameter *family* via regex.
3. `getSettings()` ↔ schema — **now asserted every morning**, below.

### The assertion that was flagged twice and never built

`utils/settings-sync-check.js` (new), wired into the 6AM cron beside the
gate-health check, non-fatal by construction.

It compares every schema key carrying a `default` against
`getSettings()`'s output, minus a **named allowlist** of the four
`ui_highlight_*` keys — each with a written reason.

An allowlist rather than a count, deliberately: a count assertion breaks
on every legitimate schema addition and gets relaxed until it means
nothing. Against a named list, **a new absence is always a real finding**,
and adding a key to the allowlist is a deliberate, reviewable act.

Verified both ways:

```
[settings-sync] OK  56 schema keys, all model-consumed keys surfaced

# and with two keys deliberately unmapped:
  ok=false  missing=sp_weight_l, hfa_boost
```

That second line is the exact defect that went unnoticed from whenever
`sp_weight_l` was added until 2026-08-22. It would now be reported the
following morning.

The check also reports **stale allowlist entries** — a `ui_highlight_*`
key that later becomes model-consumed should not sit in the exemption
list forever.

## What is still open

The corrupt lines **are still arriving ~10/day**. Both guards catch them;
neither fixes the source. Whatever upstream stage passes a
no-liquidity placeholder through as a numeric moneyline is unidentified,
and finding it is a separate piece of work — worth doing, because a feed
that emits `+94400` may be emitting other things that happen to look
plausible.

## Related

- `docs/cap-as-sanity-bound-2026-08-22.md` — the audit-log evidence behind all of this.
- `docs/harness-reruns-and-cap-sign-test-2026-08-22.md` §5 — the ROI analysis that could not see the failure mode.
- `CLAUDE.md` §"Guard-removal rule" — the generalised lesson.
- `utils/market-sanity.js` — the magnitude ceiling.
- `utils/settings-sync-check.js` — the sync assertion.
