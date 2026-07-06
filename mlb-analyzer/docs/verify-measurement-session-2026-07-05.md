# Verification + measurement session — 2026-07-05

Read-only. Prod live state:

```
park_neutral_inputs_enabled = true
signal_edge_cap_enabled     = true
signal_edge_soft_cap_pp     = .10
signal_edge_hard_cap_pp     = .25
```

All four keys confirmed present on prod via `GET /api/settings`.

---

## Part 1 — Newly-enabled settings are functioning

### Part 1a — Park neutralization: **PASS**

**COL hitter blended-input drop** (live prod W_PROJ=0.45 / W_ACT=0.55):

Expected drop = 4.76% × 0.55 = **2.62%** (COL wobaPF=1.10 → actuals-half
denominator 1.05 → 4.76% deflation on actuals only per PR #144 calibration).

Observed vsRHP drop across 10 COL hitters:

```
Braxton Fulford    R    0.2703 → 0.2638  -2.39%   blend
Edouard Julien     L    0.3043 → 0.2969  -2.43%   blend
Ezequiel Tovar     R    0.3026 → 0.2946  -2.62%   blend
Hunter Goodman     R    0.3330 → 0.3242  -2.65%   blend
Jake McCarthy      L    0.3241 → 0.3157  -2.59%   blend
Kyle Karros        R    0.3030 → 0.2953  -2.53%   blend
Mickey Moniak      L    0.3381 → 0.3292  -2.63%   blend
TJ Rumfield        L    0.3649 → 0.3547  -2.80%   blend
```

Mean vsRHP delta = **-2.06%** (n=10); typical blend case at **-2.62%**.
Owner target 2-3%. ✓

**Extreme-park line movement** (local OFF vs local ON on today's slate;
same wOBA index both runs isolates the flag's effect):

```
2026-07-05  sf-col        COL   1.10  | estTot 10.83 → 10.70  Δ -0.127  hML 129 → 138  Δ +9
2026-07-05  mia-ath       ATH   1.09  | estTot  8.91 →  8.78  Δ -0.130  hML -122 → -116  Δ +6
2026-07-05  bal-cin       CIN   1.05  | estTot  8.83 →  8.74  Δ -0.094  hML -121 → -117  Δ +4
2026-07-05  tor-sea       SEA   0.96  | estTot  7.34 →  7.41  Δ +0.079  hML  126 →  124  Δ -2
2026-07-04  mia-ath       ATH   1.09  | estTot  9.85 →  9.62  Δ -0.237  hML  105 →  106  Δ +1
2026-07-04  tor-sea       SEA   0.96  | estTot  6.68 →  6.78  Δ +0.099  hML  116 →  114  Δ -2
```

Direction correct on every game:
- COL/ATH/CIN (pf > 1.0): model total drops, home-team ML tightens.
- SEA (pf 0.96, pitcher's park): model total rises, home-team ML loosens.
- Magnitude scales with park factor extremity.

### Part 1b — Edge cap + audit-log write: **PASS**

Verified end-to-end pipeline against live prod SOFT=0.10 / HARD=0.25.

| Test | Result |
|---|---|
| 45pp Over signal → suppressed with `reason=edge_hard_cap`, absent from emitted array | PASS |
| 5.6pp normal Over signal → emitted, not `edge_suspect`-flagged, none suppressed | PASS |
| 12.5pp Over signal → emitted with `edge_suspect=true`, not suppressed | PASS |

Audit-log write path confirmed in `services/jobs.js:640`:

```js
q.insertBetSignalAudit({
  ...
  action: 'suppressed_edge_cap',
  ...
  detail: JSON.stringify({ reason: sup.reason, edge: sup.edge, ... }),
});
```

Caveat: I don't have read access to prod's `bet_signal_audit` table to
count rows. The logical pipeline is confirmed:
1. Live settings show `signal_edge_cap_enabled=true`, `HARD=0.25`.
2. `getSignals` with those settings correctly removes the 45pp signal
   from the emitted array and pushes it to `outSuppressed` with
   `reason=edge_hard_cap`.
3. `jobs.js` iterates `outSuppressed` and inserts to `bet_signal_audit`
   with `action='suppressed_edge_cap'`.

---

## Part 2 — 6-10pp bucket + edge distribution

**Data-quality note found and worked around:** the `bet_signals.edge_pct`
column stores fractional edges for cohort v6 (0.06 = 6pp) but
integer-percentage for older cohorts v1/v3 (6 = 6pp). Everything below is
**v6 cohort only**, edges converted to pp for reading.

### v6 edge distribution (n=95 resolved graded signals)

```
bucket    n     mean_claimed  W/L      win_rate  ROI       PnL       realized_edge  gap
1-2       14    1.47pp        10/4     71.4%     +42.81%   +610      +19.03pp       +17.55pp
2-3       21    2.44pp         9/12    42.9%     -17.41%   -409       -9.54pp       -11.98pp
3-4       14    3.56pp         6/8     42.9%     -13.13%   -183       -9.54pp       -13.11pp
4-5       16    4.46pp         8/8     50.0%      -0.80%    -13       -2.40pp        -6.86pp
5-6        7    5.55pp         3/4     42.9%     -16.37%   -131       -9.54pp       -15.10pp
6-7       10    6.50pp         5/5     50.0%      -2.77%    -28       -2.40pp        -8.90pp
7-8        5    7.32pp         1/4     20.0%     -62.34%   -328      -32.40pp       -39.72pp
8-9        3    8.42pp         2/1     66.7%     +30.11%    +88      +14.27pp        +5.85pp
9-10       2    9.39pp         1/1     50.0%     +41.14%    +52       -2.40pp       -11.79pp
10-12      1   10.95pp         0/1      0.0%     -79.75%    -88      -52.40pp       -63.35pp
12-15      2   12.34pp         0/2      0.0%     -98.43%   -188      -52.40pp       -64.73pp
15+        0
```

Realized_edge computed as `win_rate - 52.4` (break-even at -110). Gap =
realized_edge minus mean_claimed_edge.

### 6-10pp bucket (the PR #145 inflection candidate)

- **n = 20**
- **W/L = 9/11**
- **Win rate 45.00%**  (break-even ~52.4%)
- **Mean claimed edge = 7.28pp**
- **Realized edge = -7.40pp**
- **Gap (realized − claimed) = -14.68pp**  ← the PR #145 doc's -14.8pp
- **PnL -$216.20 / stake $1,969.31 → ROI -10.98%**

Split by type:
- ML: n=12, W/L 6/6, win 50.0%, ROI +6.04%
- Total: n=8, W/L 3/5, win 37.5%, ROI **-32.05%**

The miscalibration is Totals-heavy. The 7-8pp sub-bucket alone
(n=5, W/L 1/4, -62% ROI, gap -39.7pp) does most of the damage.

### Live edge distribution — where does v6 emission actually top out?

```
P50 =  3.88pp
P75 =  5.91pp
P90 =  7.39pp
P95 =  9.37pp
P99 = 12.47pp
P100 = 12.47pp
```

- **v6 signals ≥ 6pp: 23** of 95 (24%)
- **v6 signals ≥ 10pp: 3** — the SOFT cap territory
- **v6 signals ≥ 25pp: 0** — the HARD cap is dormant under v6 math

Owner's suspicion confirmed: the 20pp+ signals seen in historical rows
were legacy v1/v3 cohort artifacts. Under current v6 scoring, no signal
in the resolved window came within 12pp of the HARD cap and only 3 tripped
the SOFT cap.

### Recommendation — soft cap

**Move `signal_edge_soft_cap_pp` from 0.10 to 0.06.** Settings-only change,
no code, no PR.

Rationale:
- The 6-10pp bucket produces the largest single miscalibration gap in the
  v6 cohort (-14.68pp).
- The 7-8pp sub-bucket alone burns -62% ROI on the Totals side.
- Practical top of v6 emission is 12.5pp — SOFT=0.10 flags 3 signals
  ever, so it's effectively non-functional.
- SOFT=0.06 flags 23 v6 signals as `edge_suspect`, covering the entire
  miscalibrated band. Historical W/L on that set: 9/14, PnL -$492. Those
  bets were losing before flagging; downstream can now emphasize them
  differently in the UI.

Sensitivity check on the threshold:

```
SOFT = 0.06 → n=23  W/L=9/14  historical PnL=-$492
SOFT = 0.07 → n=13  W/L=4/9   historical PnL=-$464   ← nearly the same PnL captured with fewer flags
SOFT = 0.08 → n=8   W/L=3/5   historical PnL=-$136
```

SOFT=0.07 catches most of the pain with fewer false positives. Either
0.06 or 0.07 is defensible. I'd lean 0.06 for coverage since edge_suspect
is a display flag, not a suppression, and the marginal 6-7pp bucket is
losing (-2.77% ROI, gap -8.9pp).

**Leave HARD at 0.25** — nothing hits it under v6 today, but as a
future-input-breakage alarm it's fine dormant.

Tradeoff: this would flag ~24% of v6 signals as `edge_suspect`. If the
UI treats suspect signals as "still emit but downweight visually," that's
useful. If suspect implicitly kills conviction on the ticket, the flag
population may be too large. Owner's call.

---

## Part 3 — Totals gap re-measured with park-neutral ON

Re-ran `tmp/remeasure-totals-gap-ON.js` (patched to force
`PARK_NEUTRAL_INPUTS_ENABLED=true`) on the same 768-game window as the
prior OFF measurement.

### Comparison OFF vs ON

Mean (model − market) by market bucket:

| Bucket | OFF (07-04) | ON (07-05) | Δ |
|---|---:|---:|---:|
| LO  all      | +0.56 | +0.56 | 0 |
| MID all      | -0.33 | -0.33 | 0 |
| HI  all      | -0.83 | **-0.91** | **-0.08 worse** |
| LO  neutral  | +0.50 | +0.51 | ≈0 |
| MID neutral  | -0.36 | -0.36 | 0 |
| HI  neutral  | -1.20 | -1.21 | ≈0 |
| LO  extreme  | +0.63 | +0.62 | ≈0 |
| MID extreme  | -0.26 | -0.26 | 0 |
| **HI extreme**   | **-0.50** | **-0.66** | **-0.16 worse** |

Signal ROI on the HI-extreme Unders (the flagged pain point in the
07-04 doc):

| Class | OFF | ON |
|---|---|---|
| HI extreme Unders | n=32, -21.5% ROI | n=37, -11.2% ROI |
| HI extreme Overs | n=6, +69.3% ROI | n=3, +101.7% ROI |

Under ROI *improves* despite the wider projection gap because the ON
signal population shifted slightly (32 → 37 Unders, some marginal signals
now clear the emit floor with the slight PA-adjusted wOBA). The
underlying model bias didn't close.

### Slope shape — does it persist?

**Yes.** The LO → HI shape is essentially identical to the OFF run:

```
Gap shape (all parks):    OFF: LO +0.56  MID -0.33  HI -0.83   spread 1.39
                          ON:  LO +0.56  MID -0.33  HI -0.91   spread 1.48
```

Spread is even *slightly larger* with ON. Park neutralization did not
address the slope. As the 07-04 doc argued, this is a scoring-mechanics
issue in `estTot` assembly, not a park issue and not a TOT_SLOPE issue
(TOT_SLOPE only scales the run-differential-to-edge conversion, not the
projection).

### PR #148-150 SP-innings hypothesis

Local mirror ends before the cutoff, so tested against **fresh prod
data** for 2026-06-25 to 2026-07-05:

```
ALL GAMES:
  Pre-cutoff (< 2026-07-01)     n=81  meanMkt=8.67  meanMdl=8.13  meanAct=9.20  gap=-0.540
  Post-cutoff (>= 2026-07-04)   n=15  meanMkt=9.23  meanMdl=8.37  meanAct=9.13  gap=-0.868
```

**Gap widened from -0.54 → -0.87** post the PR merges. Small n=15 post,
but the direction matches the doc's hypothesis.

Opener-flagged share went 12.3% pre → 20.0% post; opener-flagged gap
went from -0.41 pre to -1.02 post. PR #148's RR-rotation gate produced
*more* opener classifications, and those games now under-project
significantly.

Mean SP forecast IP itself is essentially unchanged (5.18 pre → 5.22
post overall), so the doc's phrasing "reduced projected SP innings" is
inexact. What actually happened: PR #148-150 changed *which games use
which pitching-side blend*, not the underlying forecasts. Same forecasts,
different routing, lower projected runs on the affected sides — hence
lower model totals on games classified as opener or SP-SP tandem.

### Decision

**No tuning this pass. TOT_SLOPE remains the wrong knob.**

Concrete direction if someone wants to close the HI-bucket gap:

1. The bias is concentrated on opener-flagged and SP-SP tandem games in
   the HI market bucket. That's a subset small enough to isolate
   experimentally.
2. Candidate lever: PR #150's SP-SP flat matrix + `openerIP = SP_fc × QH`
   change may have over-weighted the SP side for tandems that were
   already legitimately opener-flagged. Compare model totals on
   `tandem_subtype='sp_sp'` games vs their non-tandem opener peers before
   and after the flat-matrix change to isolate.
3. `signal_edge_cap` at SOFT=0.06 (per Part 2) would flag the HI-extreme
   Under signals that are currently losing at ~-11%, giving the UI an
   opportunity to downweight them in the ticket assembly without a
   projection change.

---

## Summary

| Part | Result | Action |
|---|---|---|
| 1a park neutral | **PASS** | none |
| 1b edge cap | **PASS** | none |
| 2  6-10pp bucket | Confirms -14.68pp gap, Totals-heavy | **Recommend SOFT: 0.10 → 0.06** (settings-only) |
| 3  totals gap | Slope persists ON; gap widened by PR #148-150 | Isolate SP-SP tandem impact in a follow-up measurement PR; no TOT_SLOPE tuning |

Files:
- `tmp/remeasure-totals-gap.js` (OFF, 07-04), `tmp/remeasure-totals-gap-ON.js` (ON, 07-05)
- Local edge-distribution + 6-10pp queries: inline `node -e` this session
- Prod data fetch: `/api/games/YYYY-MM-DD` for 2026-06-25 through 2026-07-05
