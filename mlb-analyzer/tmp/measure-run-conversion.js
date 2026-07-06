// Run-conversion audit: how park factor, wind, and temperature adjustments
// contribute to LO→HI model total spread. Also checks market_total vintage.
//
// Formula (services/model.js:841-886):
//
//   base_runs_side  = max(0, (teamWoba - WOBA_BASELINE) × RUN_MULT × pf)
//   aRuns           = base_runs_a - aFramingAdj - aDefenseAdj
//   hRuns           = base_runs_h - hFramingAdj - hDefenseAdj
//   windRunAdj      = wind_factor × WIND_SCALE
//   tempRunAdj      = game.temp_run_adj (per-game)
//   estTot          = aRuns + hRuns + windRunAdj + tempRunAdj
//
// pf is multiplicative on wOBA→runs; wind/temp are additive on the sum.
// Framing/defense are per-side additive subtractions.
//
// Decomposition per game:
//   base = RUN_MULT × ((aWoba - baseline) + (hWoba - baseline))     (no pf)
//   pf_delta = base × (pf - 1)                                        (multiplicative contribution)
//   total pipeline = base + pf_delta - framing - defense + wind + temp
//
// Read-only. Output: tmp/run-conversion-decomp.tsv + printed bucket summary.
// Run: <node20>/node tmp/measure-run-conversion.js

'use strict';

const fs = require('fs');
const model = require('../services/model');
const jobs = require('../services/jobs');
const { db, q } = require('../db/schema');

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch(e) { return null; } }
function bucket(mkt) { if (mkt < 7) return 'LO'; if (mkt > 9) return 'HI'; return 'MID'; }

const S = jobs.getSettings();
const wobaIdx = jobs.getWobaIndex();

function buildGame(g, settings) {
  const aw = (g.away_team||'').toUpperCase(), hm = (g.home_team||'').toUpperCase();
  const L=0.318; let aVsR=L,aVsL=L,hVsR=L,hVsL=L,aBpW=L,hBpW=L;
  const aLU = tryParse(g.away_lineup_json) || [], hLU = tryParse(g.home_lineup_json) || [];
  try {
    if (q.getBullpenWobaBlended) {
      const aBp = q.getBullpenWobaBlended(aw, g.away_sp, hLU, settings.BP_STRONG_WEIGHT_R, settings.BP_WEAK_WEIGHT_R, settings.BP_STRONG_WEIGHT_L, settings.BP_WEAK_WEIGHT_L, settings.W_PROJ, settings.W_ACT, g.game_date);
      const hBp = q.getBullpenWobaBlended(hm, g.home_sp, aLU, settings.BP_STRONG_WEIGHT_R, settings.BP_WEAK_WEIGHT_R, settings.BP_STRONG_WEIGHT_L, settings.BP_WEAK_WEIGHT_L, settings.W_PROJ, settings.W_ACT, g.game_date);
      if (aBp) { if (aBp.vsRHB) aVsR=aBp.vsRHB; if (aBp.vsLHB) aVsL=aBp.vsLHB; aBpW=aBp.woba||L; }
      if (hBp) { if (hBp.vsRHB) hVsR=hBp.vsRHB; if (hBp.vsLHB) hVsL=hBp.vsLHB; hBpW=hBp.woba||L; }
    }
  } catch(e){}
  // Framing/defense fields come out of SQL in snake_case; runModel reads
  // camelCase (see services/jobs.js processGameSignals:576-582). Alias here
  // so applyCatcherFramingDelta sees the actual rvPerGame values instead
  // of undefined (which returns 0 at model.js:1655 — this was the bug that
  // made the run-conversion audit report framing contribution = 0.000
  // even on the ~28 July games where the DB HAD framing data populated).
  return Object.assign({}, g, {
    awayLineup: aLU, homeLineup: hLU,
    awayBullpenWoba: aBpW, homeBullpenWoba: hBpW,
    awayBullpenVsR: aVsR, awayBullpenVsL: aVsL,
    homeBullpenVsR: hVsR, homeBullpenVsL: hVsL,
    homeCatcherFramingRvPerGame: g.home_catcher_framing_rv_per_game,
    awayCatcherFramingRvPerGame: g.away_catcher_framing_rv_per_game,
    homeFieldingRunsPerGame:     g.home_fielding_runs_per_game,
    awayFieldingRunsPerGame:     g.away_fielding_runs_per_game,
  });
}

// Load resolved games with lineups + market + score. Include proj_market_total for vintage check.
const games = db.prepare(
  "SELECT *, proj_market_total FROM game_log " +
  "WHERE away_score IS NOT NULL AND home_score IS NOT NULL " +
  "AND market_total IS NOT NULL " +
  "AND away_lineup_json IS NOT NULL AND home_lineup_json IS NOT NULL " +
  "AND game_date >= '2026-04-01'"
).all();
console.log('Resolved games: ' + games.length);

const RUN_MULT = S.RUN_MULT;
const WOBA_BASELINE = S.WOBA_BASELINE;
const WIND_SCALE = S.WIND_SCALE || 2.0;
console.log('Settings: RUN_MULT=' + RUN_MULT + '  WOBA_BASELINE=' + WOBA_BASELINE + '  WIND_SCALE=' + WIND_SCALE);
console.log();

const rows = [];
const t0 = Date.now();
let processed = 0;

for (const g of games) {
  processed++;
  try {
    const gb = buildGame(g, S);
    const mr = model.runModel(gb, wobaIdx, S, 'opener_aware', true);
    if (mr.estTot == null || !isFinite(mr.estTot)) continue;

    const aTeamWoba = mr.aTeamWoba, hTeamWoba = mr.hTeamWoba;
    // Decompose: base_runs (no pf, no adj) — the "pure wOBA" contribution.
    const aBase = Math.max(0, (aTeamWoba - WOBA_BASELINE) * RUN_MULT);   // pf=1
    const hBase = Math.max(0, (hTeamWoba - WOBA_BASELINE) * RUN_MULT);
    const base_runs = aBase + hBase;

    // pf: derive from the stored game.park_factor + overrides
    // (the model does its own lookup; approximate by comparing aRunsRaw vs aBase)
    // aRunsRaw = base × pf (pre-framing/defense). Recover pf from ratio.
    // Actually simpler: use game.park_factor as ground truth for the base pf.
    const pf = g.park_factor || 1.0;
    const pfDelta = base_runs * (pf - 1);  // ≈ actual pf contribution before framing/defense

    // Framing + defense: aRuns/hRuns from model are AFTER those adjustments.
    const framingDefense = (mr.aRuns + mr.hRuns) - (aBase * pf + hBase * pf);
    // Wind + temp: from mr fields
    const windAdj = mr.windRunAdj || 0;
    const tempAdj = g.temp_run_adj || 0;

    rows.push({
      date: g.game_date, gid: g.game_id, mkt: g.market_total,
      projMkt: g.proj_market_total,
      act: g.away_score + g.home_score,
      buc: bucket(g.market_total),
      home: g.home_team, homeExt: ['COL','ATH','CIN','ARI','CHC','BOS','TB','NYM','SEA','SD','SF'].includes(g.home_team),
      pf, aTeamWoba, hTeamWoba, base_runs, pfDelta, framingDefense, windAdj, tempAdj,
      aRuns: mr.aRuns, hRuns: mr.hRuns, estTot: mr.estTot,
    });
  } catch(e) { /* skip */ }
  if (processed % 200 === 0) console.log('  [' + ((Date.now()-t0)/1000).toFixed(1) + 's] ' + processed + '/' + games.length);
}
console.log('  done. n=' + rows.length);
console.log();

// Persist per-game detail
const tsvHead = 'date\tgame_id\tmkt\tprojMkt\tact\tbucket\thome\thome_ext\tpf\taTeamWoba\thTeamWoba\tbase_runs\tpfDelta\tframingDefense\twindAdj\ttempAdj\tsum\testTot';
const tsvBody = rows.map(r => [
  r.date, r.gid, r.mkt, r.projMkt||'', r.act, r.buc, r.home, r.homeExt?'1':'0',
  r.pf.toFixed(3), r.aTeamWoba.toFixed(4), r.hTeamWoba.toFixed(4),
  r.base_runs.toFixed(3), r.pfDelta.toFixed(3), r.framingDefense.toFixed(3),
  r.windAdj.toFixed(3), r.tempAdj.toFixed(3),
  (r.base_runs + r.pfDelta + r.framingDefense + r.windAdj + r.tempAdj).toFixed(3),
  r.estTot.toFixed(3)
].join('\t')).join('\n');
fs.writeFileSync('tmp/run-conversion-decomp.tsv', tsvHead + '\n' + tsvBody);
console.log('Per-game detail: tmp/run-conversion-decomp.tsv (' + rows.length + ' rows)');
console.log();

function summarize(subset) {
  if (subset.length === 0) return null;
  const n = subset.length;
  const s = { n, mkt: 0, projMkt: 0, projMktN: 0, act: 0,
    base: 0, pfDelta: 0, framingDef: 0, wind: 0, temp: 0, estTot: 0, pf: 0 };
  for (const r of subset) {
    s.mkt += r.mkt; s.act += r.act; s.pf += r.pf;
    s.base += r.base_runs; s.pfDelta += r.pfDelta; s.framingDef += r.framingDefense;
    s.wind += r.windAdj; s.temp += r.tempAdj; s.estTot += r.estTot;
    if (r.projMkt != null && !isNaN(r.projMkt)) { s.projMkt += r.projMkt; s.projMktN++; }
  }
  return {
    n, meanMkt: s.mkt/n, meanProjMkt: s.projMktN ? s.projMkt/s.projMktN : null,
    projMktN: s.projMktN, meanAct: s.act/n, meanPf: s.pf/n,
    meanBase: s.base/n, meanPfDelta: s.pfDelta/n,
    meanFramingDef: s.framingDef/n, meanWind: s.wind/n, meanTemp: s.temp/n,
    meanEstTot: s.estTot/n,
    meanSum: (s.base + s.pfDelta + s.framingDef + s.wind + s.temp)/n,
  };
}

function print(label, r) {
  if (!r) { console.log('  ' + label + ': (no data)'); return; }
  console.log('  ' + label);
  console.log('    n=' + r.n + '  meanMkt=' + r.meanMkt.toFixed(2) + '  meanAct=' + r.meanAct.toFixed(2)
    + '  meanEst=' + r.meanEstTot.toFixed(2) + '  meanPf=' + r.meanPf.toFixed(3));
  console.log('    Decomposition (mean per game):');
  console.log('      base_runs (wOBA×RUN_MULT, no pf)  = ' + r.meanBase.toFixed(3));
  console.log('      pf contribution (base × (pf-1))    = ' + (r.meanPfDelta>=0?'+':'') + r.meanPfDelta.toFixed(3));
  console.log('      framing/defense (subtracted)       = ' + r.meanFramingDef.toFixed(3));
  console.log('      wind adj (factor × WIND_SCALE)     = ' + (r.meanWind>=0?'+':'') + r.meanWind.toFixed(3));
  console.log('      temp adj (per-game)                 = ' + (r.meanTemp>=0?'+':'') + r.meanTemp.toFixed(3));
  console.log('      sum                                 = ' + r.meanSum.toFixed(3));
  console.log('      (model estTot)                      = ' + r.meanEstTot.toFixed(3));
  console.log('    market_total vintage:');
  console.log('      close: ' + r.meanMkt.toFixed(2) + '  proj (morning): '
    + (r.meanProjMkt != null ? r.meanProjMkt.toFixed(2) + ' (n=' + r.projMktN + ')' : 'n/a')
    + '  Δ close-morning: '
    + (r.meanProjMkt != null ? (r.meanMkt - r.meanProjMkt >= 0 ? '+' : '') + (r.meanMkt - r.meanProjMkt).toFixed(3) : 'n/a'));
}

const buckets = { LO: rows.filter(r => r.buc==='LO'), MID: rows.filter(r => r.buc==='MID'), HI: rows.filter(r => r.buc==='HI') };
console.log('=== ALL PARKS ===');
print('LO',  summarize(buckets.LO));
print('MID', summarize(buckets.MID));
print('HI',  summarize(buckets.HI));

console.log();
console.log('=== EXTREME-PARK subset ===');
['LO','MID','HI'].forEach(b => print('EXT ' + b, summarize(rows.filter(r => r.buc===b && r.homeExt))));
console.log();
console.log('=== NEUTRAL-PARK subset ===');
['LO','MID','HI'].forEach(b => print('NEU ' + b, summarize(rows.filter(r => r.buc===b && !r.homeExt))));

// ─── Between-bucket range (does pf+wind+temp explain the missing 1.3 runs?) ─────
console.log();
console.log('=== BETWEEN-BUCKET SPREADS (LO → HI) ===');
const lo = summarize(buckets.LO), hi = summarize(buckets.HI);
if (lo && hi) {
  console.log('  Component            LO_mean     HI_mean     Δ(HI-LO)     % of model spread');
  const modelSpread = hi.meanEstTot - lo.meanEstTot;
  const rows2 = [
    ['base_runs (wOBA)', lo.meanBase, hi.meanBase],
    ['pf contribution', lo.meanPfDelta, hi.meanPfDelta],
    ['framing/defense', lo.meanFramingDef, hi.meanFramingDef],
    ['wind adj', lo.meanWind, hi.meanWind],
    ['temp adj', lo.meanTemp, hi.meanTemp],
    ['MODEL estTot', lo.meanEstTot, hi.meanEstTot],
    ['MARKET (close)', lo.meanMkt, hi.meanMkt],
    ['MARKET (morning)', lo.meanProjMkt, hi.meanProjMkt],
    ['ACTUAL', lo.meanAct, hi.meanAct],
  ];
  for (const [label, loV, hiV] of rows2) {
    if (loV == null || hiV == null) { console.log('  ' + label.padEnd(22) + ' (missing)'); continue; }
    const d = hiV - loV;
    const pct = (d / modelSpread * 100);
    console.log('  ' + label.padEnd(22) + loV.toFixed(3).padStart(7) + '   ' + hiV.toFixed(3).padStart(7)
      + '     ' + (d >= 0 ? '+' : '') + d.toFixed(3).padStart(6)
      + '    ' + (label.startsWith('MODEL') || label.startsWith('MARKET') || label.startsWith('ACTUAL') ? '—' : (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%'));
  }
}

// Wind/temp magnitudes
console.log();
console.log('=== WIND & TEMP magnitude sanity ===');
const wSamples = rows.filter(r => r.windAdj !== 0 && !isNaN(r.windAdj)).map(r => r.windAdj);
const tSamples = rows.filter(r => r.tempAdj !== 0 && !isNaN(r.tempAdj)).map(r => r.tempAdj);
function stats(arr) { if (!arr.length) return null; const m = arr.reduce((s,x)=>s+x,0)/arr.length; const mn = Math.min(...arr); const mx = Math.max(...arr); const sorted = arr.slice().sort((a,b)=>a-b); const p90 = sorted[Math.floor(0.9*sorted.length)]; const pn10 = sorted[Math.floor(0.1*sorted.length)]; return { n: arr.length, mean: m, min: mn, max: mx, p10: pn10, p90 }; }
const ws = stats(wSamples);
const ts = stats(tSamples);
console.log('  Wind adj (non-zero): n=' + (ws ? ws.n + ', mean=' + ws.mean.toFixed(3) + ', min=' + ws.min.toFixed(3) + ', P10=' + ws.p10.toFixed(3) + ', P90=' + ws.p90.toFixed(3) + ', max=' + ws.max.toFixed(3) : '(no non-zero rows)'));
console.log('  Temp adj (non-zero): n=' + (ts ? ts.n + ', mean=' + ts.mean.toFixed(3) + ', min=' + ts.min.toFixed(3) + ', P10=' + ts.p10.toFixed(3) + ', P90=' + ts.p90.toFixed(3) + ', max=' + ts.max.toFixed(3) : '(no non-zero rows)'));
console.log('  (Zero-adjustment rows: wind=' + (rows.length - (ws?ws.n:0)) + ', temp=' + (rows.length - (ts?ts.n:0)) + ')');
