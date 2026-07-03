// Retro-application backtest for feat/edge-sanity-cap.
//
// Rescores every resolved game with the cap OFF and ON, then compares:
//   - What gets SUPPRESSED (hard cap) — should be net losers per the brief
//   - What gets FLAGGED soft-suspect — reported separately
//   - What was UNCHANGED (edge < SOFT) — must be byte-identical for regression
//   - KC Apr-May cluster — is the ~40pp+ malfunction signature caught?
//
// Reuses the same buildGame / runModel / getSignals / calcPnl loop as
// scripts/backtest-park-neutral.js so the OFF baseline is byte-identical
// to production emission.
//
// Run: node scripts/backtest-edge-cap.js

const _schema = require('../db/schema');
const db = _schema.db;
const q  = _schema.q;
const model = require('../services/model');
const jobs  = require('../services/jobs');

function tryParse(s){ try { return s ? JSON.parse(s) : null; } catch(e){ return null; } }

const S = jobs.getSettings();
const SOff = Object.assign({}, S, {
  SIGNAL_EDGE_CAP_ENABLED: false,
});
const SOn = Object.assign({}, S, {
  SIGNAL_EDGE_CAP_ENABLED: true,
  SIGNAL_EDGE_SOFT_CAP_PP: 0.10,
  SIGNAL_EDGE_HARD_CAP_PP: 0.25,
});

function buildGame(g) {
  const parts=(g.game_id||'').split('-');
  const aw=(g.away_team||parts[0]||'').toUpperCase(), hm=(g.home_team||parts[1]||'').toUpperCase();
  const awaySp=g.away_sp||'', homeSp=g.home_sp||'';
  const wProj=S.W_PROJ!=null?S.W_PROJ:0.65, wAct=S.W_ACT!=null?S.W_ACT:0.35;
  const bpSR=S.BP_STRONG_WEIGHT_R!=null?S.BP_STRONG_WEIGHT_R:0.55, bpWR=S.BP_WEAK_WEIGHT_R!=null?S.BP_WEAK_WEIGHT_R:0.45;
  const bpSL=S.BP_STRONG_WEIGHT_L!=null?S.BP_STRONG_WEIGHT_L:0.35, bpWL=S.BP_WEAK_WEIGHT_L!=null?S.BP_WEAK_WEIGHT_L:0.65;
  const L=0.318;
  let aVsR=L, aVsL=L, hVsR=L, hVsL=L, aBpW=L, hBpW=L;
  const aLU=tryParse(g.away_lineup_json)||[], hLU=tryParse(g.home_lineup_json)||[];
  try {
    if(q.getBullpenWobaBlended){
      const aBp=q.getBullpenWobaBlended(aw,awaySp,hLU,bpSR,bpWR,bpSL,bpWL,wProj,wAct,g.game_date);
      const hBp=q.getBullpenWobaBlended(hm,homeSp,aLU,bpSR,bpWR,bpSL,bpWL,wProj,wAct,g.game_date);
      if(aBp){ if(aBp.vsRHB)aVsR=aBp.vsRHB; if(aBp.vsLHB)aVsL=aBp.vsLHB; aBpW=aBp.woba||L; }
      if(hBp){ if(hBp.vsRHB)hVsR=hBp.vsRHB; if(hBp.vsLHB)hVsL=hBp.vsLHB; hBpW=hBp.woba||L; }
    }
  } catch(e){}
  return Object.assign({}, g, {
    awayLineup:aLU, homeLineup:hLU,
    awayBullpenWoba:aBpW, homeBullpenWoba:hBpW,
    awayBullpenVsR:aVsR, awayBullpenVsL:aVsL, homeBullpenVsR:hVsR, homeBullpenVsL:hVsL,
  });
}

function stake(sig){
  let raw;
  if(sig.type==='ML') raw=parseFloat(sig.marketLine);
  else { raw=parseFloat(sig.side==='over'?sig.overPrice:sig.underPrice); if(isNaN(raw)||raw===0) raw=-110; }
  if(isNaN(raw)||raw===0) return 0;
  return raw>0 ? (10000/raw) : Math.abs(raw);
}
function grade(sig, g){
  if(g.away_score==null||g.home_score==null) return null;
  const r=model.calcPnl(
    { type:sig.type, side:sig.side, marketLine:sig.marketLine,
      bet_line:null, overPrice:sig.overPrice, underPrice:sig.underPrice },
    g.away_score, g.home_score, g.market_total
  );
  return { pnl:r.pnl, stake:stake(sig) };
}

function Agg(){ return { n:0, stake:0, pnl:0, w:0, l:0, p:0 }; }
function addOne(agg, sig, g){
  const gr = grade(sig, g); if (!gr || gr.stake <= 0) return;
  agg.n++; agg.stake += gr.stake; agg.pnl += gr.pnl;
  if (gr.pnl > 0.001) agg.w++;
  else if (gr.pnl < -0.001) agg.l++;
  else agg.p++;
}
function roi(a){ return a.stake>0 ? (100*a.pnl/a.stake) : 0; }
function fmt(a) {
  return a.n + ' bets · W/L/P ' + a.w + '/' + a.l + '/' + a.p
    + ' · ROI ' + roi(a).toFixed(2) + '% (pnl ' + a.pnl.toFixed(0) + '/stake ' + a.stake.toFixed(0) + ')';
}

const MIN_DATE = process.argv[2] || '2026-04-09';
console.log('Retro backtest of edge-sanity cap.');
console.log('SOFT=', SOn.SIGNAL_EDGE_SOFT_CAP_PP, 'HARD=', SOn.SIGNAL_EDGE_HARD_CAP_PP);
console.log('Window from:', MIN_DATE, '\n');

const games = db.prepare(
  "SELECT * FROM game_log WHERE away_score IS NOT NULL AND home_score IS NOT NULL "
  + "AND (market_away_ml IS NOT NULL OR market_total IS NOT NULL) "
  + "AND game_date >= ? ORDER BY game_date, game_id"
).all(MIN_DATE);
console.log('Resolved games:', games.length);

const wobaIdx = jobs.getWobaIndex();

// Buckets
const suppressed = Agg();     // signals HARD-suppressed by ON path
const flagged    = Agg();     // signals SOFT-flagged (edge_suspect) by ON path
const emittedClean = Agg();   // signals ON emitted with edge_suspect=false
const emittedOff   = Agg();   // sanity: all signals OFF path
const suppressedKC = Agg();
const suppressedByType = { ML: Agg(), Total: Agg() };

const t0 = Date.now();
let regressionOk = true;

for (let i=0; i<games.length; i++) {
  const g = games[i];
  const gb = buildGame(g);
  const mr = model.runModel(gb, wobaIdx, SOff);
  const suppList = [];
  const sigsOff = model.getSignals(gb, mr, SOff);
  const sigsOn  = model.getSignals(gb, mr, SOn, suppList);

  // Regression check: signals with edge < SOFT should be byte-identical
  // between OFF and ON (same edge, same order, same type/side). Compare
  // only the "clean" subset (edge < SOFT on both paths).
  const cleanOff = sigsOff.filter(s => s.edge < SOn.SIGNAL_EDGE_SOFT_CAP_PP);
  const cleanOn  = sigsOn.filter(s => s.edge < SOn.SIGNAL_EDGE_SOFT_CAP_PP);
  if (cleanOff.length !== cleanOn.length) regressionOk = false;
  for (let j=0; j<Math.min(cleanOff.length, cleanOn.length); j++) {
    const a = cleanOff[j], b = cleanOn[j];
    if (a.type !== b.type || a.side !== b.side || Math.abs(a.edge - b.edge) > 1e-9) regressionOk = false;
  }

  // Aggregate outcomes
  for (const s of sigsOff) addOne(emittedOff, s, g);
  for (const s of sigsOn) {
    if (s.edge_suspect) addOne(flagged, s, g);
    else addOne(emittedClean, s, g);
  }
  // Suppressed = signals in Off that are NOT in On (matching by type+side+edge signature)
  for (const s of sigsOff) {
    if (s.edge < SOn.SIGNAL_EDGE_HARD_CAP_PP) continue;  // wouldn't be suppressed
    // was it removed?
    const stillThere = sigsOn.some(t => t.type === s.type && t.side === s.side && Math.abs(t.edge - s.edge) < 1e-9);
    if (!stillThere) {
      addOne(suppressed, s, g);
      addOne(suppressedByType[s.type] || Agg(), s, g);
      const parts = (g.game_id || '').split('-');
      if (parts.includes('kc')) addOne(suppressedKC, s, g);
    }
  }

  if ((i+1) % 100 === 0) {
    const el = ((Date.now()-t0)/1000).toFixed(1);
    console.log('  [' + el + 's] scored ' + (i+1) + '/' + games.length);
  }
}
console.log('  [' + ((Date.now()-t0)/1000).toFixed(1) + 's] done');
console.log();

console.log('=== REGRESSION ===');
console.log('  Below-SOFT signals byte-identical (OFF vs ON): ' + (regressionOk ? 'PASS' : 'FAIL'));

console.log('\n=== SUPPRESSED (hard cap, edge >= ' + SOn.SIGNAL_EDGE_HARD_CAP_PP + ') ===');
console.log('  All: ' + fmt(suppressed));
console.log('  ML : ' + fmt(suppressedByType.ML));
console.log('  Tot: ' + fmt(suppressedByType.Total));
console.log('  KC (motivating cluster): ' + fmt(suppressedKC));
console.log('  Bar per brief: suppressed set should be NET LOSERS.');
console.log('  Verdict: ' + (suppressed.pnl <= 0 ? 'PASS (net loser)' : 'REPORT — retro cluster was PROFITABLE by luck. See doc.'));

console.log('\n=== FLAGGED soft-suspect (edge in [SOFT, HARD)) ===');
console.log('  ' + fmt(flagged));
console.log('  These signals still emit but must not drive "best plays" emphasis.');

console.log('\n=== EMITTED clean (edge < SOFT) — regression population ===');
console.log('  ' + fmt(emittedClean));

console.log('\n=== EMITTED all (OFF baseline for reference) ===');
console.log('  ' + fmt(emittedOff));

// Sanity: sum of ON emitted (clean + flagged) + suppressed should equal OFF emitted
const combined = emittedClean.n + flagged.n + suppressed.n;
console.log('\n  clean(' + emittedClean.n + ') + flagged(' + flagged.n + ') + suppressed(' + suppressed.n + ') = ' + combined
  + '   OFF total: ' + emittedOff.n + '   ' + (combined === emittedOff.n ? 'CONSISTENT' : 'MISMATCH (n=' + Math.abs(combined-emittedOff.n) + ')'));
