# Stranded branches: dispositions (2026-08-24)

> **18 commits sat on branches that were never merged.** Two were this
> week's and are now PR'd (#289, #290, #292). The other 16 are an
> April-to-August tail.
>
> **Nothing here is a silent data defect.** Two are live pricing-path
> items worth a decision; the rest are superseded, obsolete, or docs that
> were written and never published.
>
> Every SHA is recorded below, so deleting a branch is reversible —
> `git checkout -b recover <sha>` brings it back.

## How each was checked

For each commit: do its files exist in `main`, and do its **added lines**
appear in `main`'s version of those files. That distinguishes *superseded*
(content landed via another branch) from *stranded* (content exists
nowhere). Where the answer was ambiguous, the specific behaviour was
probed directly against `origin/main`.

## Already actioned

| sha | disposition |
|---|---|
| `b6b2263` | **PR #290** — Lineups.com correction. `main` still said "both sources off-limits"; the correction says one is *unknown*. Merged. |
| `0d57066` | **PR #289** — catcher-framing coverage doc, stranded when #288 merged without it. Merged. |
| `69cb25d` | **PR #292** — hand-conditional A/B vs the 0.649 benchmark. **0 of 50 added lines were in main**, and main still carried a caveat saying the re-run was outstanding. |

## Needs a decision — pricing path

| sha | branch | one-line disposition |
|---|---|---|
| `2f29110` | `fix/park-factors` | **Live constants, and both versions are stale.** `main` still has COL 1.25 / SEA 0.95 / MIN 0.97; this April commit has COL 1.28 / SEA 0.88 / MIN 1.06. Four months on, neither is current — **pull fresh from FanGraphs rather than landing this.** |
| `cb92b6e` | `docs/ingest-not-hot-path-rule` | **Absent from main.** A CLAUDE.md rule with no behaviour change — cheap to land, but it is a standing instruction, so it is your call whether the rule is still one you want. |

## Superseded — content is in main via another branch

| sha | branch | one-line disposition |
|---|---|---|
| `ad0c8e2` | `fix/weather-observability-and-silent-fallback` | **Duplicate.** `b71109e` in main has the identical subject and main's `jobs.js` references `fetchWindAtCoords` 6×. Delete. |
| `4b14cfa` | `fix/debug-model-trace-team-hint` | `ownTeam` hint is present in main's `routes/api.js`. Delete. |
| `29f9973` | `feat/matchup-lineup-bsr-display` | Name-based resolver is present in main. Delete. |
| `6927914` | `feat/baserunning-trailing-stint-tracking` | Pre-restack version; `fix/baserunning-stint-tracking-restack` merged instead. Delete. |
| `a21f3f1` | `chore/flag-mesa-contaminated-signals` | 14 files, 11 of them legacy `scripts/` and `tmp/` sweep tooling since replaced by `services/parameter-sweep.js`. Its purpose — excluding contaminated rows from calibration — is now served by `weather_contamination_reason` / `market_contamination_reason`, which did land. Superseded in substance. Delete. |

## Likely obsolete — verify, then delete

| sha | branch | one-line disposition |
|---|---|---|
| `e54b0c6` | `fix/fg-splits-body-shape-not-legacy` | Content absent from main, **but production `/health` reports wOBA 8/8 keys uploaded 0.9h ago** — the fg-sync path works. Whatever this fixed is fixed or moot; do not re-land a change to a healthy data path without reproducing the failure first. |
| `88206dd` | `feat/woba-blend-breakdown` | April UI feature (Steamer/Actual/Blend in the matchup view), 106 lines across 3 files that have all changed since. Won't apply cleanly; re-implement if still wanted. |

## Docs written and never published

All four are standalone files absent from `main` — landing any of them is
additive and risk-free, but each records a conclusion that later work may
have moved past.

| sha | branch | one-line disposition |
|---|---|---|
| `44dd2ce` | `feat/sweep-pyth-exp` | "Real-model Pythag holdout — DEFER (proxy story was misleading)". A **negative** result and a retraction of a proxy analysis — the kind worth keeping. Land. |
| `37014c0` | `docs/runs-term-recalibration` | Totals backtest at RUN_MULT=50, the ROI validation. **ROI-as-pricing-evidence**, which the 2026-08-21 rule now says is invalid. Land only with a banner, or drop. |
| `b2afab5` | `docs/sea-tandem-analysis` | SEA piggyback rotation analysis + PR #150 fix direction. Superseded by the opener/bulk redesign. Drop. |
| `a8e54a2` | `docs/weight-sensitivity-2026-07` | "Reframe infra-wall scope: 4 weights runnable on #179 pattern". Scope note about work that has since been done differently. Drop. |
| `c161de4` | `fix/complete-demote-seed-oddsraw-from-schedule` | "queue Poly totals write follow-up" — a queued item. `fix/poly-totals-write-path` is **already merged** in main, so the follow-up was done. Drop. |

## Standalone diagnostics, never landed

| sha | branch | one-line disposition |
|---|---|---|
| `9649e92` | `feat/total-residual-diagnostic` | New file, 286 lines, measures model bias by park/temp/wind. Additive and harmless, but overlaps the skewed-residual work of 2026-08-06. Land only if you want the tool. |
| `ce751ef` | `feat/total-vs-line-backtest` | New file, 248 lines, model picks vs Vegas with win% and ROI buckets. **ROI-based**, so it cannot establish pricing quality under the 2026-08-21 rule. Drop. |

## Recommended action

**Delete 11, land 1, decide 4.**

- Delete outright: `ad0c8e2`, `4b14cfa`, `29f9973`, `6927914`, `a21f3f1`,
  `b2afab5`, `a8e54a2`, `c161de4`, `ce751ef`, `88206dd`, `e54b0c6`
- Land: `44dd2ce` (a recorded negative result)
- Decide: `2f29110` (refresh instead), `cb92b6e` (a standing rule),
  `37014c0` (ROI caveat), `9649e92` (want the tool?)

I have not deleted anything. Every SHA above is recoverable from this
page for as long as the objects survive gc.


---

## ACTIONED 2026-09-18

The sentence above — "I have not deleted anything" — was true when
written and is no longer. Thirteen branches were deleted, local and
remote, after re-verifying every one against `main` rather than trusting
this page: a month had passed, and two of its claims had drifted.

**Archived first.** The seven whose work is genuinely absent from `main`
were tagged and the tags pushed BEFORE any deletion:

| tag | sha |
|---|---|
| `archive/feat-baserunning-trailing-stint-tracking` | `6927914` |
| `archive/chore-flag-mesa-contaminated-signals` | `a21f3f1` |
| `archive/docs-sea-tandem-analysis` | `b2afab5` |
| `archive/docs-weight-sensitivity-2026-07` | `a8e54a2` |
| `archive/fix-complete-demote-seed-oddsraw-from-schedule` | `c161de4` |
| `archive/feat-total-vs-line-backtest` | `ce751ef` |
| `archive/feat-woba-blend-breakdown` | `88206dd` |

This page said every sha was "recoverable ... for as long as the objects
survive gc". Deleting the branch ref is precisely what ends that: nothing
would have anchored the objects, and a sha with no object behind it is a
dead reference. The tags are what make the recovery claim true.
Recover with `git show archive/<name>` or
`git checkout -b restored archive/<name>`.

**Six needed no archive** — their work is in `main`:
`ad0c8e2`, `4b14cfa`, `29f9973` (superseded, `git cherry` shows 0 ahead),
plus three re-landed under a different sha: `85d011a` → `63472d4`
(**297 of 297 diff lines identical**), `e54b0c6` → `0e6cf3f` (297 of 332;
the remaining 35 are the 2-year-window rationale comment, present in main
at `services/fangraphs.js:194`), and `0cccab4`, superseded by the v2
criterion merged as PR #376.

**Two cases this page got wrong**, both because it reasoned about remote
branches while the verifier reads local ones (505 local refs vs 480
remote at the time):

- `feat/total-vs-line-backtest` had **no remote ref at all**. A remote-only
  delete would have been a no-op and it would still be in the count.
- `fix/complete-demote-seed-oddsraw-from-schedule` had a **merged remote
  tip** (`5546ffe`) and a **stranded local tip** (`c161de4`). The commit
  this page names lived only on the local ref, so the archive tag was cut
  from the local tip. Deleting only the remote would have discarded
  nothing and preserved nothing.

**Still outstanding: 7 commits on 7 branches**, listed by name with their
current state in CLAUDE.md under "When to re-run the landed-commit
verifier". Four remain undecided (`2f29110`, `cb92b6e`, `37014c0`,
`9649e92`), one is dispositioned to land (`44dd2ce`), and two were never
dispositioned by this page at all (`ada0bd8`, `32e43f1`).
