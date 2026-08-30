# Pre-registration: is park-neutral resolvable at all? (2026-08-30)

> **Written and committed BEFORE the effect was computed.** The floor
> measurement below deliberately suppresses the signed mean — dispersion
> only — so the bar is set without having seen what it will be compared
> against.
>
> **The headline is not a verdict on the feature. It is a verdict on
> whether the question is answerable**, which is what the registry entry
> has been quietly missing for a week.

## 1. A correction to the framing that prompted this

The proposal was: *"if the log-loss floor on this corpus is ~0.020 and the
last result was −0.00055, the effect is an order of magnitude below what's
resolvable and the A/B cannot answer the question."*

**The 0.020 figure is from the wrong design and would overstate the
difficulty by 28x.**

`resolution-floor.js --calibration` measures a **between-cohort** gap —
split the corpus into two disjoint groups, ask whether their log losses
differ. The park-neutral A/B is **paired**: the same games scored twice,
differing in one flag. Per-game predictions under the two configurations
are almost perfectly correlated, so the paired difference carries far less
variance.

Both designs measured on the SAME 801-game corpus:

```
between-cohort (resolution-floor.js --calibration), n=400 : +/-0.01714
paired        (park-neutral-paired-floor.js),      n=801 : +/-0.000608
                                                    ratio :  28x
```

The registry's own CI was already the paired figure — [−0.00117, +0.00012],
half-width **0.00065**, which independently reproduces the paired
measurement. Applying the cohort floor here would be the same class of
error as quoting a schedule share as a measurement n.

## 2. The paired floor, measured

`scripts/park-neutral-paired-floor.js`, dispersion only:

```
games scored both ways : 801
games the flag MOVED   : 706  (88.1%)

sd(per-game paired d log loss) : 0.008779
date clustering: ICC -0.0069 over 96 dates -> design effect 1.000

RESOLVABLE at n=801 : +/-0.000608   (95% CI half-width)
```

Two things worth noting. The measured half-width **0.000608** independently
reproduces the registry's 0.00065, confirming that figure was paired. And
the **date ICC is ~zero** — unlike every other measurement on this corpus.
That makes sense: the flag's effect is per-park and per-player, not
per-slate, so it does not inherit the shared-slate correlation that
inflates other intervals here. Design effect 1.000, no clustering penalty.

## 3. What n each effect size needs

```
effect      n needed    beyond the current 801
0.00100          297    already resolvable
0.00055          979    +178
0.00030        3,290    +2,489
0.00010       29,607    +28,806
```

**So resolvability depends entirely on how big the effect actually is**,
and the answer is neither "now" nor "never":

- If the true effect is near the current point estimate (**0.00055**), it
  becomes resolvable at **~979 clean games — 178 more**, which is weeks of
  season, not years.
- If it is roughly half that (0.00030), the trigger moves to **~3,290
  games**: two more seasons. Reachable in principle, not on any useful
  timescale.
- At 0.00010 it is **29,607 games** — effectively never.

## 4. The pre-registered position

**This run is DESCRIPTIVE, not a test.** Stated in advance, per the rule
that a bar inside the noise floor is not a bar: the prior point estimate
(0.00055) sits at **0.90×** the resolvable threshold (0.000608), i.e.
just inside the noise. No outcome available today can confirm or refute
at that size.

**No confirmation bar is set, because none would be honest.** What the run
produces is a point estimate and a CI, recorded so the trend toward the
trigger is trackable — not a verdict.

**The trigger is n ≈ 979 clean, scorable games** on the current design. At
801 today, that is +178. When the corpus reaches it, the A/B becomes a
test and can be re-run with a real bar.

## 5. The resting state, which is the actual deliverable

**"Directionally validated, awaiting significance" is the wrong resting
state** and should be retired. It implies a pending verdict, and it has sat
in the registry implying one since 2026-08-23.

The honest replacement, on the evidence above:

> **ON, for the mechanism.** Neutralizing park out of the actuals before
> re-applying a park factor at game time is more correct than not doing so,
> independent of whether calibration can detect it — otherwise the same
> park effect is counted twice, once in the input and once in the
> multiplier. **Calibration cannot currently adjudicate it (paired floor
> ±0.000608 vs an effect near 0.00055), and becomes able to at n≈979.**

That is different from "awaiting significance" in a way that matters: it
names *why* the feature is on (mechanism), *what* the evidence can and
cannot say (not yet), and *when* that changes (n≈979). None of those three
was recorded before.

**And it is different from "never".** The proposal that prompted this
assumed the evidence would never arrive. On the paired design it arrives at
+178 games, if the effect is the size the current estimate suggests. Only
if the true effect is half that does "never" become the right word.

## 6. Scope

- **Calibration only, no ROI.** Per the 2026-08-21 finding, ROI over
  emitted signals measures selection, not pricing. The existing A/B in the
  registry is ROI-based (+3.32pp totals) and therefore
  selection-contaminated; it is not evidence about calibration and is not
  treated as such here.
- **Run against the settled park source.** Sequenced after the
  `index_woba` switch (PR #325) so it measures the configuration that will
  actually be live, rather than one about to change.
- Contamination filters as standard: both reasons NULL.

## Related

- `scripts/park-neutral-paired-floor.js` — the floor, re-runnable.
- `services/feature-gate-registry.js` — the entry this replaces.
- `docs/woba-park-source-2026-08-30.md` — the source change this waited on.
- `CLAUDE.md` — "A pre-registration requires a power check, and it is one command".
