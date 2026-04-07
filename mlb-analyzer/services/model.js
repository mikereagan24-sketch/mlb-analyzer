/** Model service — all settings from DB, no hardcoded constants */
const PA_WEIGHTS = [4.60,4.60,4.60,4.60,4.30,4.13,4.01,3.90,3.77];
const BAT_DFLT = { R:{vsRHP:0.305,vsLHP:0.325}, L:{vsRHP:0.330,vsLHP:0.290}, S:{vsRHP:0.322,vsLHP:0.308} };
const PIT_DFLT = { R:{vsLHB:0.320,vsRHB:0.295}, L:{vsLHB:0.285,vsRHB:0.330} };
const MIN_PA = 60;
const MIN_BF = 100;

function normName(n) {
  return (n||'').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim();
}

function buildWobaIndex(rows) {
  const idx = {};
  for (const r of rows) {
    if (!idx[r.data_key]) idx[r.data_key] = {};
    idx[r.data_key][normName(r.player_name)] = { woba: r.woba, sample: r.sample_size };
  }
  return idx;
}

function fuzzyLookup(keyMap, name, teamHint) {
  if (!keyMap) return null;
  const k = normName(name);
  const parts = k.split(' ');
  const isAbbrev = parts.length >= 2 && parts[0].length === 1;
  function stripSfx(n){return n.replace(/\b(jr|sr|ii|iii|iv)\b/g,'').replace(/\s+/g,' ').trim();}
  if (teamHint) {
    const tk = k + ' ' + teamHint.toLowerCase();
    if (keyMap[tk]) return keyMap[tk];
  }
  if (keyMap[k]) return keyMap[k];
  if (isAbbrev && teamHint) {
    const initial=parts[0], last=parts[parts.length-1], tl=teamHint.toLowerCase();
    const e = Object.entries(keyMap).find(([n]) => {
      if (!n.endsWith(' '+tl)) return false;
      const base = n.slice(0, n.length-tl.length-1).trim();
      const p = stripSfx(base).split(' ');
      return p[p.length-1]===last && p[0] && p[0][0]===initial;
    });
    if (e) return e[1];
  }
  if (isAbbrev) {
    const initial=parts[0], last=parts[parts.length-1];
    const matches = Object.entries(keyMap).filter(([n]) => {
      if (/\s[a-z]{2,3}$/.test(n)) return false;
      const p = stripSfx(n).split(' ');
      return p[p.length-1]===last && p[0] && p[0][0]===initial;
    });
    if (matches.length===1) return matches[0][1];
  }
  const sk = stripSfx(k);
  if (teamHint) {
    const tk2 = sk+' '+teamHint.toLowerCase();
    if (keyMap[tk2]) return keyMap[tk2];
  }
  const e2 = Object.entries(keyMap).find(([n]) => !/\s[a-z]{2,3}$/.test(n) && stripSfx(n)===sk);
  return e2 ? e2[1] : null;
}

function blendWoba(proj, act, minSample, wProj, wAct) {
  const hp = proj && !isNaN(proj.woba);
  const ha = act && !isNaN(act.woba) && act.sample >= minSample;
  const wp = wProj || 0.65;
  const wa = wAct  || 0.35;
  if (hp && ha) return { woba: proj.woba*wp + act.woba*wa, source:'blend' };
  if (hp) return { woba: proj.woba, source:'steamer' };
  if (ha) return { woba: act.woba, source:'actual' };
  return null;
}

function getBatterWoba(idx, name, hand, teamHint, wProj, wAct) {
  const bL = blendWoba(
    fuzzyLookup(idx['bat-proj-lhp'], name, teamHint),
    fuzzyLookup(idx['bat-act-lhp'], name, teamHint),
    MIN_PA, wProj, wAct
  );
  const bR = blendWoba(
    fuzzyLookup(idx['bat-proj-rhp'], name, teamHint),
    fuzzyLookup(idx['bat-act-rhp'], name, teamHint),
    MIN_PA, wProj, wAct
  );
  const eff = hand==='S' ? 'R' : (hand||'R');
  const d = BAT_DFLT[eff] || BAT_DFLT['R'];
  if (bL || bR) {
    const src = bL&&bR ? (bL.source===bR.source?bL.source:'blend') : (bL?.source||bR?.source);
    return { vsLHP: bL?.woba??d.vsLHP, vsRHP: bR?.woba??d.vsRHP, source: src };
  }
  return { vsLHP: d.vsLHP, vsRHP: d.vsRHP, source:'fallback' };
}

function getPitcherWoba(idx, name, hand, teamHint, wProj, wAct) {
  const bL = blendWoba(
    fuzzyLookup(idx['pit-proj-lhb'], name, teamHint),
    fuzzyLookup(idx['pit-act-lhb'], name, teamHint),
    MIN_BF, wProj, wAct
  );
  const bR = blendWoba(
    fuzzyLookup(idx['pit-proj-rhb'], name, teamHint),
    fuzzyLookup(idx['pit-act-rhb'], name, teamHint),
    MIN_BF, wProj, wAct
  );
  const d = PIT_DFLT[hand] || PIT_DFLT['R'];
  const src = bL||bR ? (bL?.source===bR?.source?bL?.source||'steamer':'blend') : 'fallback';
  return { vsLHB: bL?.woba??d.vsLHB, vsRHB: bR?.woba??d.vsRHB, source: src };
}

function effHand(bh, ph) { return bh==='S' ? (ph==='R'?'L':'R') : bh; }

function perBatterEW(batter, pitcherHand, pitWvsL, pitWvsR, W_PIT, W_BAT) {
  const eff = effHand(batter.hand, pitcherHand);
  const pitW = eff==='L' ? pitWvsL : pitWvsR;
  const batW = pitcherHand==='R' ? (batter.vsRHP??0.315) : (batter.vsLHP??0.315);
  return pitW*W_PIT + batW*W_BAT;
}

function rawToML(wp) {
  const c = Math.min(Math.max(wp, 0.25), 0.75);
  return c>=0.5 ? -Math.round(c/(1-c)*100) : Math.round((1-c)/c*100);
}

function applySpread(aML, hML, FAV_ADJ, DOG_ADJ) {
  const favIsAway = aML <= hML;
  const rawFav = favIsAway ? aML : hML;
  const rawDog = favIsAway ? hML : aML;
  const adjFav = rawFav - FAV_ADJ; // subtract makes fav more negative
  const adjDog = rawDog + DOG_ADJ; // add makes dog more positive
  return {
    adjA: favIsAway ? adjFav : adjDog,
    adjH: favIsAway ? adjDog : adjFav,
  };
}

function impliedP(ml) {
  ml = parseFloat(ml);
  if (!ml || isNaN(ml)) return 0.5;
  return ml<0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100);
}

function runModel(game, wobaIdx, settings) {
    const num = (v, def) => { const n = Number(v); return isNaN(n) ? def : n; };
  const RUN_MULT  = num(settings.RUN_MULT,  48);
  const HFA_BOOST = num(settings.HFA_BOOST, 0.02);
  const FAV_ADJ   = num(settings.FAV_ADJ,   0);
  const DOG_ADJ   = num(settings.DOG_ADJ,   0);
  const W_PIT     = num(settings.W_PIT,     0.5);
  const W_BAT     = num(settings.W_BAT,     0.5);
  const W_PROJ    = num(settings.W_PROJ,    0.65);
  const W_ACT     = num(settings.W_ACT,     0.35);
  const SP_WEIGHT     = num(settings.SP_WEIGHT,     0.77);
  const RELIEF_WEIGHT = num(settings.RELIEF_WEIGHT, 0.23);

  const pwA = getPitcherWoba(wobaIdx, game.away_sp, game.away_sp_hand, game.away_team, W_PROJ, W_ACT);
  const pwH = getPitcherWoba(wobaIdx, game.home_sp, game.home_sp_hand, game.home_team, W_PROJ, W_ACT);

  const awayLU = (game.awayLineup||[]).map(b=>({...b,...getBatterWoba(wobaIdx,b.name,b.hand,game.away_team,W_PROJ,W_ACT)}));
  const homeLU = (game.homeLineup||[]).map(b=>({...b,...getBatterWoba(wobaIdx,b.name,b.hand,game.home_team,W_PROJ,W_ACT)}));

  let aWs=0,aWp=0;
  awayLU.forEach((b,i)=>{ const pa=PA_WEIGHTS[i]??3.77; aWs+=perBatterEW(b,game.home_sp_hand,pwH.vsLHB,pwH.vsRHB,W_PIT,W_BAT)*pa; aWp+=pa; });
  let hWs=0,hWp=0;
  homeLU.forEach((b,i)=>{ const pa=PA_WEIGHTS[i]??3.77; hWs+=perBatterEW(b,game.away_sp_hand,pwA.vsLHB,pwA.vsRHB,W_PIT,W_BAT)*pa; hWp+=pa; });

  const aTeamWoba = aWp>0 ? aWs/aWp : 0.315;
  const hTeamWoba = hWp>0 ? hWs/hWp : 0.315;
  const pf = game.park_factor||1.0;
  const aRuns = Math.max(0,(aTeamWoba-0.230)*RUN_MULT*pf);
  const hRuns = Math.max(0,(hTeamWoba-0.230)*RUN_MULT*pf);

  const rawHW = (aRuns<=0&&hRuns<=0)?0.5 : hRuns<=0?0.25 : aRuns<=0?0.75 :
    hRuns**1.83/(hRuns**1.83+aRuns**1.83);
  const adjHW = Math.min(Math.max(rawHW+HFA_BOOST,0.25),0.75);
  const adjAW = 1-adjHW;

  const rawAML = rawToML(adjAW);
  const rawHML = rawToML(adjHW);
  const { adjA:aML, adjH:hML } = applySpread(rawAML, rawHML, FAV_ADJ, DOG_ADJ);

  return { aTeamWoba,hTeamWoba,aRuns,hRuns,rawHW,adjHW,adjAW,aML,hML,estTot:aRuns+hRuns };
}

function catKey(signalType, signalSide, signalLabel, marketLine) {
  if (signalType==='ML') { const isFav=parseInt(marketLine)<0; return signalLabel.toLowerCase()+'-'+(isFav?'fav':'dog'); }
  return signalLabel.toLowerCase()+'-'+signalSide;
}

function getSignals(game, modelResult, settings) {
  const ML_LEAN_EDGE  = typeof settings.ML_LEAN_EDGE  !== 'undefined' ? Number(settings.ML_LEAN_EDGE)  : 20;
  const ML_VALUE_EDGE = typeof settings.ML_VALUE_EDGE !== 'undefined' ? Number(settings.ML_VALUE_EDGE) : 40;
  const TOT_LEAN_EDGE  = typeof settings.TOT_LEAN_EDGE  !== 'undefined' ? Number(settings.TOT_LEAN_EDGE)  : 0.5;
  const TOT_VALUE_EDGE = typeof settings.TOT_VALUE_EDGE !== 'undefined' ? Number(settings.TOT_VALUE_EDGE) : 1.0;

  const signals = [];

  // ML signals: point difference between model ML and market ML for the same side
  // Rule: only fire a signal if model and market agree on who the favorite is
  // (avoids false signals when the model barely flips the fav due to HFA noise)
  const aModel = modelResult.aML;
  const hModel = modelResult.hML;
  const aMarket = game.market_away_ml;
  const hMarket = game.market_home_ml;

  const modelFavIsAway = aModel <= hModel;   // model thinks away is fav
  const marketFavIsAway = aMarket <= hMarket; // market thinks away is fav

  // Only compute signal if model and market agree on which team is the favorite
  if (modelFavIsAway === marketFavIsAway) {
    // Away side: positive diff means model prices away better than market (model likes away more)
    const aDiff = aMarket - aModel; // e.g. model=-150, market=-130 -> diff=20 (away value)
    const hDiff = hMarket - hModel; // e.g. model=-150, market=-130 -> diff=20 (home value)

    if (aDiff >= ML_VALUE_EDGE) {
      signals.push({type:'ML',side:'away',label:'Value',marketLine:aMarket,modelLine:aModel,edge:Math.round(aDiff)});
    } else if (aDiff >= ML_LEAN_EDGE) {
      signals.push({type:'ML',side:'away',label:'Lean',marketLine:aMarket,modelLine:aModel,edge:Math.round(aDiff)});
    }

    if (hDiff >= ML_VALUE_EDGE) {
      signals.push({type:'ML',side:'home',label:'Value',marketLine:hMarket,modelLine:hModel,edge:Math.round(hDiff)});
    } else if (hDiff >= ML_LEAN_EDGE) {
      signals.push({type:'ML',side:'home',label:'Lean',marketLine:hMarket,modelLine:hModel,edge:Math.round(hDiff)});
    }
  }

  // Total signals: run difference
  const tEdge = modelResult.estTot - (game.market_total || 8.5);
  if (tEdge >= TOT_VALUE_EDGE) signals.push({type:'Total',side:'over',label:'Value',marketLine:game.market_total,edge:parseFloat(tEdge.toFixed(2))});
  else if (tEdge >= TOT_LEAN_EDGE) signals.push({type:'Total',side:'over',label:'Lean',marketLine:game.market_total,edge:parseFloat(tEdge.toFixed(2))});
  if (tEdge <= -TOT_VALUE_EDGE) signals.push({type:'Total',side:'under',label:'Value',marketLine:game.market_total,edge:parseFloat(tEdge.toFixed(2))});
  else if (tEdge <= -TOT_LEAN_EDGE) signals.push({type:'Total',side:'under',label:'Lean',marketLine:game.market_total,edge:parseFloat(tEdge.toFixed(2))});

  return signals.map(s=>({...s,category:catKey(s.type,s.side,s.label,s.marketLine)}));
}

function calcPnl(signal, awayScore, homeScore, marketTotal) {
  if(awayScore==null||homeScore==null) return {outcome:'pending',pnl:0};
  const actualTotal=awayScore+homeScore;
  if(signal.type==='ML'){
    if(awayScore===homeScore) return {outcome:'push',pnl:0};
    const betTeamWon=signal.side==='away'?awayScore>homeScore:homeScore>awayScore;
    const ml=parseInt(signal.marketLine);
    const pnl=betTeamWon?(ml>0?ml:100/Math.abs(ml)*100):-100;
    return {outcome:betTeamWon?'win':'loss',pnl:parseFloat(pnl.toFixed(2))};
  } else {
    const line=parseFloat(marketTotal);
    if(actualTotal===line) return {outcome:'push',pnl:0};
    const hitOver=actualTotal>line;
    const betWon=signal.side==='over'?hitOver:!hitOver;
    return {outcome:betWon?'win':'loss',pnl:betWon?90.91:-100};
  }
}

module.exports = { normName,buildWobaIndex,getBatterWoba,getPitcherWoba,runModel,getSignals,calcPnl,impliedP };
