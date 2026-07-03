// backtest-park-neutral.js
// A/B backtest for feat/park-neutral-inputs.
//
// Compares model performance with the PARK_NEUTRAL_INPUTS_ENABLED
// setting OFF vs ON across the resolved season-to-date. Report-only.
// Slices results by AFFECTED population (games involving extreme-park
// teams — |wOBA park factor - 1| > 3%) so the aggregate doesn't wash
// out the signal from the neutralization.
//
// Reuses the app's runModel / getSignals / calcPnl — no grading
// reimpl. Mirrors scripts/backtest-run-environment.js patterns so the
// OFF baseline is byte-identical to the production model path.
//
// SHOW PROGRESS — no silent background. Logs per-game as it goes.
//
// Run with the Node 20 path:
//   "<node20>" scripts/backtest-park-neutral.js

var _schema = require('../db/schema');
var db    = _schema.db;
var q     = _schema.q;
var model = require('../services/model');
var jobs  = require('../services/jobs');
var { WOBA_PARK_FACTORS } = require('../services/park-factors-woba');

// Extreme-park set: teams whose wOBA factor deviates >3% from 1.00.
// Signals for games involving these teams are the ones neutralization
// meaningfully touches; league-average parks wash out. Kept explicit so
// the population is transparent in the report.
var EXTREME_TEAMS = Object.keys(WOBA_PARK_FACTORS).filter(function(t){
  return Math.abs(WOBA_PARK_FACTORS[t] - 1.00) > 0.03;
});
console.log('Extreme-park teams (|wOBA factor - 1| > 3%):', EXTREME_TEAMS.join(', '));

function tryParse(s){ try { return s ? JSON.parse(s) : null; } catch(e){ return null; } }

var S = jobs.getSettings();
var SOff = Object.assign({}, S, { PARK_NEUTRAL_INPUTS_ENABLED: false });
var SOn  = Object.assign({}, S, { PARK_NEUTRAL_INPUTS_ENABLED: true  });

// Minimal buildGame — copy of the same-shape function from
// backtest-run-environment.js WITHOUT the framing/defense attach.
// PARK_NEUTRAL_INPUTS is orthogonal to those features so we can hold
// them at their live settings values and only vary the neutralization
// toggle.
function buildGame(g, settings){
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
  return Object.assign({}, g, {
    awayLineup:aLU, homeLineup:hLU,
    awayBullpenWoba:aBpW, homeBullpenWoba:hBpW,
    awayBullpenVsR:aVsR, awayBullpenVsL:aVsL, homeBullpenVsR:hVsR, homeBullpenVsL:hVsL,
  });
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
  var r=model.calcPnl(
    { type:sig.type, side:sig.side, marketLine:sig.marketLine, bet_line:null,
      overPrice:sig.overPrice, underPrice:sig.underPrice },
    g.away_score, g.home_score, g.market_total
  );
  return { pnl:r.pnl, stake:stake(sig) };
}
function firedSignals(game, mr, settings){
  var sigs = model.getSignals(game, mr, settings) || [];
  return sigs.filter(function(s){
    if(s.type==='ML') return s.side && s.marketLine!=null;
    if(s.type==='Total') return s.side && s.marketLine!=null;
    return false;
  });
}
function Agg(){ return { Total:{n:0,stake:0,pnl:0,w:0,l:0,p:0}, ML:{n:0,stake:0,pnl:0,w:0,l:0,p:0} }; }
function addSig(agg, sig, g){
  var key = sig.type==='ML'?'ML':(sig.type==='Total'?'Total':null);
  if(!key) return;
  var gr=grade(sig,g); if(!gr||gr.stake<=0) return;
  agg[key].n++; agg[key].stake+=gr.stake; agg[key].pnl+=gr.pnl;
  if(gr.pnl>0.001) agg[key].w++;
  else if(gr.pnl<-0.001) agg[key].l++;
  else agg[key].p++;
}
function roi(a){ return a.stake>0 ? (100*a.pnl/a.stake) : 0; }

// Unique key per signal so we can diff OFF-set vs ON-set — a signal
// that fires OFF but not ON is a SUPPRESSED play; suppression's W/L is
// how we tell whether the toggle helped the losers or killed the
// winners.
function sigKey(gameId, sig){
  return gameId + '|' + sig.type + '|' + (sig.side||'') + '|' + (sig.marketLine||'');
}

var MIN_DATE = process.argv[2] || '2026-05-21';
console.log('\nBacktest window start: ' + MIN_DATE);
console.log('Toggle-off baseline vs Toggle-on comparison; report-only, no writes.\n');

var games = db.prepare(
  "SELECT * FROM game_log WHERE away_score IS NOT NULL AND home_score IS NOT NULL "
  + "AND (market_away_ml IS NOT NULL OR market_total IS NOT NULL) "
  + "AND game_date >= ? ORDER BY game_date, game_id"
).all(MIN_DATE);
if(!games.length){ console.log('No resolved games in window.'); process.exit(0); }
console.log('Resolved games in window: ' + games.length);

var wobaIdx = jobs.getWobaIndex();

// Per-team signal-volume shift tracker: for each team, how many
// signals for/against that team fired OFF vs ON, plus W/L.
var teamStats = {};
function bumpTeam(team, delta){
  if(!teamStats[team]) teamStats[team] = { offN:0, onN:0, offPnl:0, onPnl:0, offW:0, offL:0, onW:0, onL:0 };
  Object.assign(teamStats[team], {
    offN: teamStats[team].offN + (delta.offN||0),
    onN: teamStats[team].onN + (delta.onN||0),
    offPnl: teamStats[team].offPnl + (delta.offPnl||0),
    onPnl: teamStats[team].onPnl + (delta.onPnl||0),
    offW: teamStats[team].offW + (delta.offW||0),
    offL: teamStats[team].offL + (delta.offL||0),
    onW: teamStats[team].onW + (delta.onW||0),
    onL: teamStats[team].onL + (delta.onL||0),
  });
}

var allOff = Agg(), allOn = Agg();       // aggregate
var affOff = Agg(), affOn = Agg();       // affected teams only
var affGames = 0;
var suppressed = { n:0, w:0, l:0, p:0, pnl:0, stake:0 };  // fired OFF, not ON
var appeared   = { n:0, w:0, l:0, p:0, pnl:0, stake:0 };  // fired ON, not OFF

var t0 = Date.now();
for(var i=0;i<games.length;i++){
  var g = games[i];
  var affected = EXTREME_TEAMS.indexOf(g.away_team) >= 0 || EXTREME_TEAMS.indexOf(g.home_team) >= 0;
  if(affected) affGames++;

  var gb = buildGame(g, S);
  var mrOff = model.runModel(gb, wobaIdx, SOff);
  var mrOn  = model.runModel(gb, wobaIdx, SOn);
  var sOff = firedSignals(gb, mrOff, SOff);
  var sOn  = firedSignals(gb, mrOn,  SOn);

  // Aggregate + affected roll-ups
  sOff.forEach(function(s){
    addSig(allOff, s, g);
    if(affected) addSig(affOff, s, g);
  });
  sOn.forEach(function(s){
    addSig(allOn, s, g);
    if(affected) addSig(affOn, s, g);
  });

  // Suppressed = fired OFF but not ON; Appeared = fired ON but not OFF.
  var offKeys = new Set(sOff.map(function(s){ return sigKey(g.game_id, s); }));
  var onKeys  = new Set(sOn.map(function(s){ return sigKey(g.game_id, s); }));
  sOff.forEach(function(s){
    if(!onKeys.has(sigKey(g.game_id, s))){
      var gr = grade(s, g); if(gr && gr.stake > 0) {
        suppressed.n++; suppressed.pnl += gr.pnl; suppressed.stake += gr.stake;
        if(gr.pnl>0.001) suppressed.w++; else if(gr.pnl<-0.001) suppressed.l++; else suppressed.p++;
      }
    }
  });
  sOn.forEach(function(s){
    if(!offKeys.has(sigKey(g.game_id, s))){
      var gr = grade(s, g); if(gr && gr.stake > 0) {
        appeared.n++; appeared.pnl += gr.pnl; appeared.stake += gr.stake;
        if(gr.pnl>0.001) appeared.w++; else if(gr.pnl<-0.001) appeared.l++; else appeared.p++;
      }
    }
  });

  // Per-team volume — count each side signal's TEAM (the team the
  // signal is picking). For ML signals side is 'away'|'home'; map to
  // the actual team abbr. For Total signals attribute to the HOME team
  // (park is the home team's).
  function attrTeam(sig, game){
    if(sig.type === 'ML') return sig.side === 'away' ? game.away_team : game.home_team;
    return game.home_team;
  }
  var offGraded = sOff.map(function(s){ return { s: s, team: attrTeam(s, g), gr: grade(s, g) }; });
  var onGraded  = sOn.map(function(s){ return { s: s, team: attrTeam(s, g), gr: grade(s, g) }; });
  offGraded.forEach(function(x){
    if(!x.gr) return;
    bumpTeam(x.team, { offN: 1, offPnl: x.gr.pnl, offW: x.gr.pnl>0.001?1:0, offL: x.gr.pnl<-0.001?1:0 });
  });
  onGraded.forEach(function(x){
    if(!x.gr) return;
    bumpTeam(x.team, { onN: 1, onPnl: x.gr.pnl, onW: x.gr.pnl>0.001?1:0, onL: x.gr.pnl<-0.001?1:0 });
  });

  if((i+1) % 100 === 0) {
    var elapsed = ((Date.now()-t0)/1000).toFixed(1);
    console.log('  ['+elapsed+'s] scored ' + (i+1) + '/' + games.length + ' games');
  }
}
var totalElapsed = ((Date.now()-t0)/1000).toFixed(1);
console.log('  ['+totalElapsed+'s] scored ' + games.length + '/' + games.length + ' games (done)');
console.log('Affected-team games: ' + affGames);

function printAgg(label, off, on){
  console.log('\n=== ' + label + ' ===');
  ['Total','ML'].forEach(function(k){
    var o=off[k], n=on[k];
    console.log('  ' + k + ':');
    console.log('    OFF: ' + o.n + ' bets · W/L/P ' + o.w + '/' + o.l + '/' + o.p
      + ' · ROI ' + roi(o).toFixed(2) + '% (pnl ' + o.pnl.toFixed(0) + '/stake ' + o.stake.toFixed(0) + ')');
    console.log('    ON : ' + n.n + ' bets · W/L/P ' + n.w + '/' + n.l + '/' + n.p
      + ' · ROI ' + roi(n).toFixed(2) + '% (pnl ' + n.pnl.toFixed(0) + '/stake ' + n.stake.toFixed(0) + ')');
    console.log('    Δ ROI: ' + (roi(n)-roi(o)>=0?'+':'') + (roi(n)-roi(o)).toFixed(2) + ' pts, Δ n: '
      + (n.n-o.n>=0?'+':'') + (n.n-o.n));
  });
}
printAgg('AGGREGATE (all games)', allOff, allOn);
printAgg('AFFECTED (extreme-park teams involved: ' + EXTREME_TEAMS.join(',') + ')', affOff, affOn);

// Suppression / appearance breakdown — the crux of the report.
console.log('\n=== SIGNAL DELTA (the plays neutralization CHANGED) ===');
function fmtDelta(x){
  var r = x.stake > 0 ? (100*x.pnl/x.stake) : 0;
  return x.n + ' bets · W/L/P ' + x.w + '/' + x.l + '/' + x.p
    + ' · ROI ' + r.toFixed(2) + '% (pnl ' + x.pnl.toFixed(0) + '/stake ' + x.stake.toFixed(0) + ')';
}
console.log('  SUPPRESSED by ON (fired OFF, not ON):  ' + fmtDelta(suppressed));
console.log('  APPEARED with ON (fired ON, not OFF): ' + fmtDelta(appeared));
console.log('  Bar: suppressed should be NET LOSERS (helping to kill them) and');
console.log('        appeared should be NEUTRAL-TO-POSITIVE (not obviously bad).');

// Per-team signal-volume shift — highlights whose signals dropped.
console.log('\n=== PER-TEAM SIGNAL VOLUME SHIFT (top movers) ===');
var teams = Object.keys(teamStats).map(function(t){
  var s = teamStats[t]; return { team: t, offN: s.offN, onN: s.onN, delta: s.onN - s.offN,
    offRoi: s.offPnl / Math.max(1, s.offN) * 100 / 100,
    onRoi:  s.onPnl  / Math.max(1, s.onN)  * 100 / 100,
    parkFactor: WOBA_PARK_FACTORS[t] || null };
});
teams.sort(function(a,b){ return Math.abs(b.delta) - Math.abs(a.delta); });
console.log('  team  wobaPF  offN  onN  Δn  offROI  onROI');
teams.slice(0, 20).forEach(function(t){
  console.log('  '
    + t.team.padEnd(4) + '  '
    + (t.parkFactor!=null?t.parkFactor.toFixed(2):'?').padStart(5) + '  '
    + String(t.offN).padStart(4) + '  '
    + String(t.onN).padStart(3) + '  '
    + (t.delta>=0?'+':'') + String(t.delta).padStart(3));
});

console.log('\nDone. Bar to enable (from brief): neutralized helps or is neutral on');
console.log('affected games AND suppressed signals were net losers. If hurts, toggle stays off.');
