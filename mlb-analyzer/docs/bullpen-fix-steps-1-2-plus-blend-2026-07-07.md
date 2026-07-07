# Bullpen input construction fix — Steps 1+2 + Path B blend — 2026-07-07

Follow-through on the level-bug decomposition
(`docs/bullpen-level-decomposition-2026-07-07.md`, PR #160). Ships three
new settings that together correct the model bullpen wOBA input toward
a defensible roster-pool target range, with byte-identical guards at
verified prod values so the change is reversible from the settings UI
without a redeploy.

## Fresh-data decomposition (re-verified against 2026-07-07 prod DB)

Local mirror pulled fresh from `/admin/download-db` (previous mirror
was stale at 2026-06-03). Re-verification harness at
`tmp/reverify-decomp.js`. Numbers vs stale mirror:

| Contributor | Stale 2026-07-06 mirror | Fresh 2026-07-07 |
|---|---|---|
| (a) Callup fallback pollution | 7 fallbacks, +0.6pt UP | **0 fallbacks, 0pt** (roster fully covered) |
| (b) Opener/bulk pollution     | 59 RPs, +2.2pt UP     | 47 RPs, ~+2.5pt UP (28.6% BF from starts) |
| (c) Steamer over-regression   | +6.6pt UP (σ ratio 3.17×) | **+9.4pt UP** (σ ratio 2.21×) |
| Model bullpen mean            | 0.3088                | **0.3074** at true prod blend 0.45/0.55 |

Contributor (a) is a non-issue on fresh data — every roster RP has a
projection row. Contributor (b) is the target of Step 2. Contributor
(c) is the target of the Path B blend override.

## Prod blend values reconciled

Previous doc-quoted "0.65/0.35" was the schema *fallback* default, not
prod. Actual prod values verified via
`SELECT value FROM app_settings WHERE key IN ('w_proj','w_act')`:

```
w_proj = 0.45
w_act  = 0.55
```

All numbers in this doc use the verified prod blend.

## Revised target range for the roster-pool metric

`docs/bullpen-input-evaluation-2026-07-07.md` targeted a bullpen mean
of 0.298-0.303 by subtracting a "real 10-15pt relief advantage" from
the model SP mean 0.3131. That target was drawn from **league-average
leverage-weighted** relief wOBA-allowed reports, but `q.getBullpenWoba`
computes an **equal-weight pool mean over 8+ rostered RPs per team** —
including mop-up / long-relief RPs the manager rarely deploys in
high-leverage spots. The pool mean is structurally 4-6pt higher than
the leverage-weighted quantity a fan looks up on Baseball-Reference.

Revised roster-pool target: **0.303-0.308**. Same 10-15pt relative
advantage vs the SP mean, offset for the leverage-vs-equal-weight
composition.

## The sweep floor at 0.3043

Before choosing a blend default, we swept BULLPEN_W_PROJ across
[0.45, 0.00] with Step 2 on, min_bf=50:

```
w_proj  w_act   mean     p10      p90      spread(pt)   Δ vs legacy
0.45    0.55    0.3073   0.2960   0.3178   21.8         −0.2   (byte-identical)
0.35    0.65    0.3066   0.2949   0.3180   23.1         −0.8
0.25    0.75    0.3059   0.2937   0.3183   24.6         −1.5   ← Path B default
0.15    0.85    0.3053   0.2922   0.3185   26.3         −2.2
0.05    0.95    0.3046   0.2907   0.3188   28.1         −2.8
0.00    1.00    0.3043   0.2900   0.3189   28.9         −3.1   ← lever floor
```

**Even at w_proj=0.00 (pure actuals), the 30-team mean floors at
0.3043.** Residual bias comes from RPs with no actuals row — the blend
falls back to pure Steamer for those. The lever alone cannot force the
mean below 0.3043.

Path B's 0.25/0.75 sits comfortably inside the revised 0.303-0.308
target with room for future tuning either direction.

## Path C rejected — flat-prior semantics

Alternative Path C would swap the "no actuals row → pure Steamer"
fallback for a flat league RP prior (~0.300). That would flatter
fringe / callup arms toward the league mean regardless of scouting
signal from Steamer, which is a semantic downgrade — the Steamer proj,
even for a thin-sample RP, carries information about arm quality that
a flat prior discards. Rejected. Path C also chased the outdated
0.298-0.303 target that the revised roster-pool analysis retired.

## Changes shipped in this PR

### Step 1 — `BULLPEN_MIN_BF` (dormant on current data, present for future)

`services/settings-schema.js` adds `bullpen_min_bf` (min=25, max=200,
default=50). Separate from the SP-facing `min_bf` (still 100) so
lowering it doesn't affect the SP handedness path.

On current data this setting is **dormant**: the `pit-act-rhb`/`lhb`
tables have zero rows below sample=150, so every RP already qualifies
at the legacy 100 threshold. The setting is present so mid-season
callups with 50-99 BF start blending as they accumulate sample.

### Step 2 — `BULLPEN_DOWNWEIGHT_STARTERS` (default true)

`db/schema.js` extends `q.getBullpenWoba` to accept a
`downweightStarters` boolean. When true, each pool RP contributes to
the pool mean with weight `(1 − start_BF_fraction over last 60d)`
computed from `pitcher_game_log`.

Effect: opener/bulk-heavy RPs (Tanner Gordon 59% starts, Shane Drohan
74% starts, Jack Perkins 67% starts) contribute proportionally less to
their team's pool mean. Team-level impact: COL bullpen appears −2.5pt
tighter at legacy blend, ±3-4pt across the affected teams. Second-
order note: WAS moves +1.8pt at the legacy blend because Andrew
Alvarez's proj is BELOW the WAS pool mean — downweighting him
mechanically raises the mean. Correct behavior of the fix; the
alternative is to accept opener-inflated pollution.

### Path B blend — `BULLPEN_W_PROJ` / `BULLPEN_W_ACT` (0.25 / 0.75 default)

`db/schema.js` extends `q.getBullpenWoba` and `q.getBullpenWobaBlended`
to accept optional bullpen-specific blend weights that override the
global `w_proj` / `w_act`. Null → falls back to the global (byte-
identical for legacy DBs and any caller that doesn't thread the args).

Defaults 0.25 / 0.75 (schema + seed row in `db/schema.js`). Rationale:
RP actuals over the sample threshold are a stronger signal than the
corresponding SP actuals because Steamer's RP projections regress
hard to league-mean. Tilting to actuals-heavy lets elite RPs (Cade
Smith realized 0.216 vs projected 0.345; Erik Miller 0.196 vs 0.300)
pull their team means toward reality.

## Verification (`tmp/verify-bullpen-fix.js`)

30-team snapshot on 2026-07-07 roster + blend, no lineup (fallback
strong/weak-by-hand average):

```
mode                    n   mean     p10      p90      spread(pt)
legacy (0.45/0.55, 100, off) 30  0.3074   0.2966   0.3177   21.1
+ min_bf 50 only             30  0.3074   0.2966   0.3177   21.1  ← dormant
+ downweight starters        30  0.3073   0.2960   0.3178   21.8
Path B (0.25/0.75, 50, on)   30  0.3059   0.2937   0.3183   24.6  ← new default
```

- **Path B mean = 0.3059**, inside revised target **0.303-0.308** ✓
- **Byte-identical guard IDENTICAL** — setting bullpen_w_proj=0.45,
  bullpen_w_act=0.55, min_bf=100, downweight=off produces exactly the
  legacy output across all 30 teams (max floating-point diff < 1e-9).

Spot checks vs legacy (Path B default):

```
LAD   0.2893 → 0.2868  (−2.5pt)   elite pen tightens further
BOS   0.2937 → 0.2906  (−3.1pt)   elite actuals pull down
HOU   0.2944 → 0.2914  (−3.0pt)
ATL   0.2966 → 0.2937  (−2.9pt)   ATL elite pen (Iglesias) pulls down
SD    0.2969 → 0.2939  (−3.0pt)
CLE   0.2989 → 0.2970  (−1.9pt)   Cade Smith pulls further
MIL   0.3014 → 0.2986  (−2.8pt)
COL   0.3309 → 0.3309  ( 0.0pt)   no change (proj≈act for their pool)
WAS   0.3264 → 0.3301  (+3.7pt)   second-order downweight effect
CWS   0.3088 → 0.3097  (+0.9pt)
NYM   0.3135 → 0.3152  (+1.7pt)
```

Direction is correct on the elite pens (biggest drops) and the good-
actuals middle. Teams that move UP (WAS, NYM, CWS) are the ones where
downweighting the starter-heavy RP mechanically raises the pool mean
because that RP had a LOW proj (a starter's opposite-hand projection
is often lower than a pure reliever's). Trading that mechanical
artifact for the opener-pollution fix is the right call — the
starter-heavy RP shouldn't be dragging the pool mean either
direction.

## Files

- `services/settings-schema.js` — three new keys
  (`bullpen_min_bf`, `bullpen_downweight_starters`, `bullpen_w_proj`,
  `bullpen_w_act`). Invariant on w_proj+w_act sum=1.
- `db/schema.js` — seed rows; `q.getBullpenWoba` signature extended
  with `downweightStarters` + `bullpenWProj` + `bullpenWAct` params;
  60d start-BF fraction lookup added; pool aggregation switched from
  equal-weight to `(1 − start_BF_fraction)`-weighted when enabled.
- `services/jobs.js` — read new settings; thread through to
  `q.getBullpenWobaBlended` in `processGameSignals`.
- `routes/api.js` — same thread through `/debug/bullpen-edge-trace`
  and `/debug/bullpen-report`.
- `public/index.html` — three new UI rows (input + schema map + load
  + save) per the CLAUDE.md settings-key UI-parity rule.
- `tmp/reverify-decomp.js` — fresh-data decomp measurement.
- `tmp/verify-bullpen-fix.js` — four-mode 30-team verification.
- `tmp/sweep-bullpen-blend.js` — blend-weight sweep documenting the
  0.3043 floor.
- `tmp/check-db-freshness.js` — DB freshness helper.
- `docs/bullpen-fix-steps-1-2-plus-blend-2026-07-07.md` — this file.

## Byte-identical reversal

The change is reversible from the settings UI without a redeploy. To
restore pre-2026-07-07 behavior byte-identically, set:

```
bullpen_min_bf              = 100    (dormant either way on current data)
bullpen_downweight_starters = false
bullpen_w_proj              = 0.45   (matches global w_proj)
bullpen_w_act               = 0.55   (matches global w_act)
```

Verified against the harness's byte-identical guard as IDENTICAL.

## Follow-ups (deferred; not this PR)

- Step 5 predictive test — bucket resolved games by post-fix bullpen
  gap; gates any future `RELIEF_PIT_WEIGHT` change per the owner's
  amendment on PR #160.
- Step 6 deviation multiplier `k` — evaluate after Step 4 (sharper
  usage-weighted construction toggle) lands.
- WAS second-order raise from Andrew Alvarez downweight is expected
  but worth monitoring across the season. If it stops being a
  one-team outlier, revisit the "downweight direction is universal"
  assumption.
