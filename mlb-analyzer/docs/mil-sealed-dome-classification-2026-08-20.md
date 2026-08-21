# MIL sealed-dome classification — verified correct, no change (2026-08-20)

**Status:** closed. Investigated and **resolved as a false alarm.**
American Family Field (venue_id 32) belongs in
`SEALED_DOME_VENUE_IDS`. No code change.

Filed because a 2026-only glance during the SEA canopy scoping flagged
MIL as "in `SEALED_DOME_VENUE_IDS` but behaving unsealed." **That flag
was wrong**, and this doc records the disconfirming evidence so the
question isn't reopened on the same weak signal.

## The original (bad) signal

Looking only at 2026 statsapi readings for closed games:

| park | statsapi temp on closed games | % zero wind |
|---|---|---|
| HOU | 73 constant | 100% |
| TEX | 74 constant | 100% |
| MIA | 72 constant | 100% |
| TOR | 68–72 | 100% |
| ARI | 72–78 | 100% |
| **MIL** | **57–81, 16 distinct values** | **87%** |
| SEA (known canopy) | 43–58 | 63% |

MIL's wide reported range and its 13% non-zero wind made it look like
it sat between the sealed group and SEA.

**The error:** that table has no outdoor baseline. A range of reported
temperatures is only evidence of an open park if it *tracks* the
outdoors. Milwaukee's outdoor temperature also ranges widely across a
season, so a wide indoor range is equally consistent with loose climate
control. The comparison was uncontrolled.

## The controlled test

Same method that established SEA is a canopy: pair each closed game
with ERA5 outdoor reanalysis at the same park-local hour via the
production fetcher (`fetchWindAtCoords`, `archive: true`), then take
the median of `statsapi game-time temp − ERA5 outdoor temp`. A park
open to the air reads ≈0. A sealed building reads well above it.

2025 + 2026 regular-season home games:

| park | closed games scored | median(statsapi − ERA5) | % zero wind |
|---|---|---|---|
| **MIL** | 67 | **+10.0°F** | 94% |
| TOR | 76 | +14.2°F | 100% |
| **SEA** (canopy reference) | 50 | **+0.2°F** | 63% |
| SEA open (control) | 255 | +0.3°F | — |

MIL sits with the sealed parks by a wide margin. It is 50× further from
outdoor than SEA is.

Individual games make it obvious — MIL reports a comfortable indoor
temperature while it is near freezing outside:

| date | statsapi | ERA5 outdoor | wind |
|---|---|---|---|
| 2025-03-31 | 65°F | 42.4°F | `0 mph, None` |
| 2025-04-01 | 63°F | 35.2°F | `0 mph, None` |
| 2025-04-02 | 64°F | 41.3°F | `0 mph, None` |
| 2025-04-04 | 66°F | 38.8°F | `0 mph, None` |
| 2025-04-16 | 66°F | 43.1°F | `0 mph, None` |

Only 17 of 67 closed MIL games land within 5°F of ERA5 outdoor, and
those cluster in summer — when a climate-controlled 70°F and a Milwaukee
afternoon coincide naturally. That is agreement by coincidence, not
airflow.

## Conclusion

The 57–86°F reported range reflects **imperfect climate control in a
very large building**, not an open park. `isSealedDome(32) === true` is
correct; `temp_run_adj` and `wind_factor` should both stay zeroed at
closed MIL games, which is current behavior and is unchanged by the
2026-08-20 per-channel gate.

The `roof-prior.js` comment on venue 32 has been updated to record this
verification inline, so the next reader sees the resolved answer rather
than re-deriving the same false alarm.

## Method note worth keeping

**A distribution of readings is not evidence of a mechanism without a
matched baseline.** The uncontrolled 2026 table ranked MIL as the
anomaly; the controlled test ranked it firmly with the sealed group.
Both tables are "real data about MIL closed games" — only one of them
answers the question asked.

This is the same shape as the subset sign-flip rule: a plausible
directional read off an unconditioned slice reversed once the right
comparison was in place.

## Related

- `docs/sea-canopy-roof-scope-2026-08-20.md` — parent scoping doc; §5
  is the same test applied to SEA, where it came back positive.
- `docs/roof-gate-inert-sealed-set-2026-08-20.md` — the companion
  ticket; `SEALED_DOME_VENUE_IDS` is incomplete in the other direction
  (Tropicana absent).
- `services/roof-prior.js` — the set and the inline verification note.
