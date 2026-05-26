// backtest-run-environment.js
// Compares model performance with catcher framing + team defense (FRV)
// OFF vs ON, for Totals and ML signals separately, across two windows:
//   Option 1 — full resolved window (UPPER BOUND; uses current-season
//              framing/FRV data on past games = lookahead bias, best case).
//   Option 2 — last 14 days (HONEST-BUT-NOISY; over a short window the
//              current data ≈ what was known then, so minimal lookahead).
// Reuses the app's runModel / getSignals / calcPnl — no grading reimpl.
// Replicates jobs.js buildGame's framing+defense resolution (the
// optimize-params harness's local buildGame omits it).
//
// Run with the Node 20 path against a fresh local data/mlb.db:
//   "<node20>" scripts/backtest-run-environment.js

var _schema = require('../db/schema');
var db    = _schema.db;
var q     = _schema.q;
var model = require('../services/model');
var jobs  = require('../services/jobs');

function tryParse(s){ try { return s ? JSON.parse(s) : null; } catch(e){ return null; } }
function normName(n){ return (n||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim(); }
function stripSfx(n){ return n.replace(/\b(jr|sr|ii|iii|iv)\b/g,'').replace(/\s+/g,' ').trim(); }

// name → mlb_id via team POS roster (accent+suffix folded, initial+last)
var _rosterCache = {};
function rosterFor(team){
  if(!_rosterCache[team]) _rosterCache[team] = q.getPositionPlayers.all(team).map(function(p){
    return { mlb_id:p.mlb_id, _parts: stripSfx(normName(p.player_name)).split(' ') };
  });
  return _rosterCache[team];
}
function resolveId(team, name){
  if(!team||!name) return null;
  var norm = stripSfx(normName(name)); var parts = norm.split(' ');
  if(parts.length<2) return null;
  var last = parts[parts.length-1], fi = parts[0][0];
  var players = rosterFor(team);
  var c = players.filter(function(p){ var pp=p._parts; return pp.length>=2 && pp[pp.length-1]===last && pp[0][0]===fi; });
  return c.length===1 ? c[0].mlb_id : null;
}

// Settings (match live)
var S = jobs.getSettings();
var FR_TAKES = S.CATCHER_FRAMING_TAKES_PER_GAME!=null?S.CATCHER_FRAMING_TAKES_PER_GAME:58;
var FR_ABS   = S.CATCHER_FRAMING_ABS_FACTOR!=null?S.CATCHER_FRAMING_ABS_FACTOR:0.80;
var FR_MIN   = S.CATCHER_FRAMING_MIN_PITCHES_2026!=null?S.CATCHER_FRAMING_MIN_PITCHES_2026:750;
var DEF_OPP  = S.DEFENSE_FRV_OPPS_PER_GAME!=null?S.DEFENSE_FRV_OPPS_PER_GAME:25;
var FIELD = { '1B':1,'2B':1,'3B':1,'SS':1,'LF':1,'CF':1,'RF':1 };

function framingPerGame(team, arr){
  var c=null; for(var i=0;i<arr.length;i++){ if((arr[i].pos||'').toUpperCase()==='C'){c=arr[i];break;} }
  if(!c) return null;
  var id=resolveId(team,c.name); if(!id) return null;
  var row=q.getCatcherFramingById.get(id);
  if(row && row.pitches>=FR_MIN) return (row.rv_tot/row.pitches)*FR_TAKES;
  if(q.getCatcherFramingHistById){ var h=q.getCatcherFramingHistById.get(id); if(h&&h.pitches>0) return (h.rv_tot/h.pitches)*FR_TAKES*FR_ABS; }
  return null;
}
function defensePerGame(team, arr){
  var sum=0, res=0;
  for(var i=0;i<arr.length;i++){
    var p=arr[i]; if(!FIELD[(p.pos||'').toUpperCase()]) continue;
    var id=resolveId(team,p.name); if(!id) continue;
    var row=q.getFieldingFrvById.get(id);
    if(row && row.outs_total>0){ sum += (row.total_runs/row.outs_total)*DEF_OPP; res++; }
  }
  return res>0?sum:null;
}

// Mirror the optimize-params local buildGame (bullpen wOBA) so OFF matches
// the production baseline, then optionally attach framing/defense.
function buildGame(g, settings, attachRunEnv){
  var parts=(g.game_id||'').split('-'); var aw=(g.away_team||parts[0]||'').toUpperCase(), hm=(g.home_team||parts[1]||'').toUpperCase();
  var awaySp=g.away_sp||'', homeSp=g.home_sp||'';
  var wProj=settings.W_PROJ!=null?settings.W_PROJ:0.65, wAct=settings.W_ACT!=null?settings.W_ACT:0.35;
  var bpSR=settings.BP_STRONG_WEIGHT_R!=null?settings.BP_STRONG_WEIGHT_R:0.55, bpWR=settings.BP_WEAK_WEIGHT_R!=null?settings.BP_WEAK_WEIGHT_R:0.45;
  var bpSL=settings.BP_STRONG_WEIGHT_L!=null?settings.BP_STRONG_WEIGHT_L:0.35, bpWL=settings.BP_WEAK_WEIGHT_L!=null?settings.BP_WEAK_WEIGHT_L:0.65;
  var L=0.318, aVsR=L,aVsL=L,hVsR=L,hVsL=L,aBpW=L,hBpW=L;
  var aLU=tryParse(g.away_lineup_json)||[], hLU=tryParse(g.home_lineup_json)||[];
  try {
    if(q.getBullpenWobaBlended){
      var aBp=q.getBullpenWobaBlended(aw,awaySp,hLU,bpSR,bpWR,bpSL,bpWL,wProj,wAct,g.game_date);
      var hBp=q.getBullpenWobaBlended(hm,homeSp,aLU,bpSR,bpWR,bpSL,bpWL,wProj,wAct,g.game_date);
      if(aBp){ if(aBp.vsRHB)aVsR=aBp.vsRHB; if(aBp.vsLHB)aVsL=aBp.vsLHB; aBpW=aBp.woba||L; }
      if(hBp){ if(hBp.vsRHB)hVsR=hBp.vsRHB; if(hBp.vsLHB)hVsL=hBp.vsLHB; hBpW=hBp.woba||L; }
    }
  } catch(e){}
  var game = Object.assign({}, g, {
    awayLineup:aLU, homeLineup:hLU,
    awayBullpenWoba:aBpW, homeBullpenWoba:hBpW,
    awayBullpenVsR:aVsR, awayBullpenVsL:aVsL, homeBullpenVsR:hVsR, homeBullpenVsL:hVsL,
  });
  if(attachRunEnv){
    game.awayCatcherFramingRvPerGame = framingPerGame(aw,aLU);
    game.homeCatcherFramingRvPerGame = framingPerGame(hm,hLU);
    game.awayFieldingRunsPerGame = defensePerGame(aw,aLU);
    game.homeFieldingRunsPerGame = defensePerGame(hm,hLU);
  }
  return game;
}

function stake(sig){
  var raw;
  if(sig.type==='ML') raw=parseFloat(sig.marketLine);
  else { raw=parseFloat(sig.side==='over'?sig.overPrice:sig.underPrice); if(isNaN(raw)||raw===0) raw=-110; }
  if(isNaN(raw)||raw===0) return 0;
  return raw>0 ? (10000/raw) : Math.abs(raw);
}
function grade(sig, g){
  if(g.away_score==null||g.home_score==null) return null;
  var r=model.calcPnl({type:sig.type,side:sig.side,marketLine:sig.marketLine,bet_line:null,overPrice:sig.overPrice,underPrice:sig.underPrice}, g.away_score, g.home_score, g.market_total);
  return { pnl:r.pnl, stake:stake(sig) };
}

// Aggregate P&L / ROI for a set of graded signals, split by type.
function Agg(){ return { Total:{n:0,stake:0,pnl:0}, ML:{n:0,stake:0,pnl:0} }; }
function addSig(agg, sig, g){
  var key = sig.type==='ML'?'ML':(sig.type==='Total'?'Total':null);
  if(!key) return;
  var gr=grade(sig,g); if(!gr||gr.stake<=0) return;
  agg[key].n++; agg[key].stake+=gr.stake; agg[key].pnl+=gr.pnl;
}
function roi(a){ return a.stake>0 ? (100*a.pnl/a.stake) : 0; }

// Only score signals the model would actually fire (edge-positive, starred).
// We approximate "fired" by taking signals getSignals emits with a star/edge.
function firedSignals(game, mr, settings){
  var sigs = model.getSignals(game, mr, settings) || [];
  // keep Total + ML signals that have a side and a market line
  return sigs.filter(function(s){
    if(s.type==='ML') return s.side && s.marketLine!=null;
    if(s.type==='Total') return s.side && s.marketLine!=null;
    return false;
  });
}

var wobaIdx = jobs.getWobaIndex();
var MIN_DATE='2026-05-21';

// Load resolved games
var games = db.prepare(
  "SELECT * FROM game_log WHERE away_score IS NOT NULL AND home_score IS NOT NULL "
  + "AND (market_away_ml IS NOT NULL OR market_total IS NOT NULL) "
  + "AND game_date >= ? ORDER BY game_date, game_id"
).all(MIN_DATE);

if(!games.length){ console.log('No resolved games.'); process.exit(0); }

// 14-day cutoff (relative to the latest resolved game date)
var maxDate = games[games.length-1].game_date;
var d = new Date(maxDate+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-14);
var cut14 = d.toISOString().slice(0,10);

function runWindow(label, filterFn){
  var subset = games.filter(filterFn);
  var off=Agg(), on=Agg();
  var changed=0, resolvedRE=0;
  for(var i=0;i<subset.length;i++){
    var g=subset[i];
    // OFF
    var gOff=buildGame(g, S, false);
    var mrOff=model.runModel(gOff, wobaIdx, Object.assign({},S,{CATCHER_FRAMING_ENABLED:false,DEFENSE_FRV_ENABLED:false}));
    var sOff=firedSignals(gOff, mrOff, S);
    for(var a=0;a<sOff.length;a++) addSig(off, sOff[a], g);
    // ON
    var gOn=buildGame(g, S, true);
    var hasRE = (gOn.awayCatcherFramingRvPerGame!=null||gOn.homeCatcherFramingRvPerGame!=null||gOn.awayFieldingRunsPerGame!=null||gOn.homeFieldingRunsPerGame!=null);
    if(hasRE) resolvedRE++;
    var mrOn=model.runModel(gOn, wobaIdx, Object.assign({},S,{CATCHER_FRAMING_ENABLED:true,DEFENSE_FRV_ENABLED:true}));
    if(Math.abs((mrOn.estTot||0)-(mrOff.estTot||0))>0.001) changed++;
    var sOn=firedSignals(gOn, mrOn, S);
    for(var b=0;b<sOn.length;b++) addSig(on, sOn[b], g);
  }
  console.log('\n=== '+label+' ('+subset.length+' games, '+resolvedRE+' with run-env data, '+changed+' est-tot changed) ===');
  ['Total','ML'].forEach(function(k){
    var o=off[k], n=on[k];
    console.log('  '+k+':');
    console.log('    OFF: '+o.n+' bets, ROI '+roi(o).toFixed(2)+'%  (pnl '+o.pnl.toFixed(0)+'/stake '+o.stake.toFixed(0)+')');
    console.log('    ON : '+n.n+' bets, ROI '+roi(n).toFixed(2)+'%  (pnl '+n.pnl.toFixed(0)+'/stake '+n.stake.toFixed(0)+')');
    console.log('    Δ ROI: '+(roi(n)-roi(o)>=0?'+':'')+(roi(n)-roi(o)).toFixed(2)+' pts');
  });
}

console.log('Run-environment backtest (framing + defense OFF vs ON)');
console.log('CAVEAT: framing/FRV data is current season-to-date. Option 1 uses it on');
console.log('all past games = LOOKAHEAD BIAS, so it is an UPPER BOUND, not a true');
console.log('out-of-sample result. Option 2 (last 14d) minimizes this but is noisier.');

runWindow('OPTION 1 — full window (UPPER BOUND, lookahead bias)', function(){return true;});
runWindow('OPTION 2 — last 14 days from '+cut14+' (honest, noisier)', function(g){return g.game_date>=cut14;});

console.log('\nReminder: ON ROI > OFF ROI in Option 1 is necessary but NOT sufficient to');
console.log('enable — it is the best case. Trust Option 2 more, and weigh sample size.');
