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
  // Strip generational suffixes from lookup key (e.g. "lance mccullers jr" → "lance mccullers")
  const kStripped = stripSfx(k);
  if (kStripped !== k) {
    if (teamHint && keyMap[kStripped + ' ' + teamHint.toLowerCase()]) return keyMap[kStripped + ' ' + teamHint.toLowerCase()];
    if (keyMap[kStripped]) return keyMap[kStripped];
  }
  // Add common suffixes in case index has them but name lookup doesn't (e.g. lookup "lance mccullers" → index has "lance mccullers jr")
  for (const sfx of ['jr','sr','ii','iii','iv']) {
    if (teamHint && keyMap[k+' '+sfx+' '+teamHint.toLowerCase()]) return keyMap[k+' '+sfx+' '+teamHint.toLowerCase()];
    if (keyMap[k+' '+sfx]) return keyMap[k+' '+sfx];
  }
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
    // Compound surname fallback: try each word in lookup key as last name
    // e.g. "s woods richardson" — try last="woods" matching "simeon woods"
    if (matches.length===0 && parts.length>2) {
      for (let wi=1;wi<parts.length;wi++) {
        const altLast=parts[wi];
        const altMatches=Object.entries(keyMap).filter(([n])=>{
          if(/\s[a-z]{2,3}$/.test(n)) return false;
          const p=stripSfx(n).split(' ');
          return p[p.length-1]===altLast && p[0] && p[0][0]===initial;
        });
        if(altMatches.length===1) return altMatches[0][1];
      }
    }
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

function perBatterEW(batter, pitcherHand, pitWvsL, pitWvsR, W_PIT, W_BAT, SP_WEIGHT, RELIEF_WEIGHT, SP_PIT_WEIGHT, RELIEF_PIT_WEIGHT) {
  const eff = effHand(batter.hand, pitcherHand);
  // Pitcher wOBA: SP_PIT_WEIGHT% from SP split vs batter's hand,
  // RELIEF_PIT_WEIGHT% from league-avg bullpen (0.318) — placeholder until real bullpen data
  const BULLPEN_AVG = 0.318;
  const spPitW  = (SP_PIT_WEIGHT     != null) ? SP_PIT_WEIGHT     : 0.80;
  const relPitW = (RELIEF_PIT_WEIGHT != null) ? RELIEF_PIT_WEIGHT : 0.20;
  const pitWvsBatter = eff === 'L' ? pitWvsL : pitWvsR;
  const pitW = pitWvsBatter * spPitW + BULLPEN_AVG * relPitW;
  // Batter wOBA: SP_WEIGHT% vs SP hand, RELIEF_WEIGHT% vs opposite hand (bullpen blend)
  const spW  = (SP_WEIGHT  != null) ? SP_WEIGHT  : 0.77;
  const relW = (RELIEF_WEIGHT != null) ? RELIEF_WEIGHT : 0.23;
  const vsStart = pitcherHand === 'R' ? (batter.vsRHP ?? 0.315) : (batter.vsLHP ?? 0.315);
  const vsOpp   = pitcherHand === 'R' ? (batter.vsLHP ?? 0.325) : (batter.vsRHP ?? 0.305);
  const batW = vsStart * spW + vsOpp * relW;
  return pitW * W_PIT + batW * W_BAT;
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
  const SP_PIT_WEIGHT     = num(settings.SP_PIT_WEIGHT,     0.80);
  const RELIEF_PIT_WEIGHT = num(settings.RELIEF_PIT_WEIGHT, 0.20);

  const pwA = getPitcherWoba(wobaIdx, game.away_sp, game.away_sp_hand, game.away_team, W_PROJ, W_ACT);
  const pwH = getPitcherWoba(wobaIdx, game.home_sp, game.home_sp_hand, game.home_team, W_PROJ, W_ACT);

  const awayLU = (game.awayLineup||[]).map(b=>({...b,...getBatterWoba(wobaIdx,b.name,b.hand,game.away_team,W_PROJ,W_ACT)}));
  const homeLU = (game.homeLineup||[]).map(b=>({...b,...getBatterWoba(wobaIdx,b.name,b.hand,game.home_team,W_PROJ,W_ACT)}));

  let aWs=0,aWp=0;
  awayLU.forEach((b,i)=>{ const pa=PA_WEIGHTS[i]??3.77; aWs+=perBatterEW(b,game.home_sp_hand,pwH.vsLHB,pwH.vsRHB,W_PIT,W_BAT,SP_PIT_WEIGHT,RELIEF_PIT_WEIGHT)*pa; aWp+=pa; });
  let hWs=0,hWp=0;
  homeLU.forEach((b,i)=>{ const pa=PA_WEIGHTS[i]??3.77; hWs+=perBatterEW(b,game.away_sp_hand,pwA.vsLHB,pwA.vsRHB,W_PIT,W_BAT,SP_PIT_WEIGHT,RELIEF_PIT_WEIGHT)*pa; hWp+=pa; });

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
  const lbl = (signalLabel||'').replace('★','star').replace('*','star').toLowerCase();
  if (signalType==='ML') { const isFav=parseInt(marketLine)<0; return lbl+'-'+(isFav?'fav':'dog'); }
  return lbl+'-'+signalSide;
}

function getSignals(game, modelResult, settings) {
  const ML_1STAR = typeof settings.ML_LEAN_EDGE    !== 'undefined' ? Number(settings.ML_LEAN_EDGE)    : 15;
  const ML_2STAR = typeof settings.ML_VALUE_EDGE   !== 'undefined' ? Number(settings.ML_VALUE_EDGE)   : 30;
  const ML_3STAR = typeof settings.ML_3STAR_EDGE   !== 'undefined' ? Number(settings.ML_3STAR_EDGE)   : 60;
  const TOT_1STAR = typeof settings.TOT_LEAN_EDGE  !== 'undefined' ? Number(settings.TOT_LEAN_EDGE)  : 0.04;
  const TOT_2STAR = typeof settings.TOT_VALUE_EDGE !== 'undefined' ? Number(settings.TOT_VALUE_EDGE) : 0.08;
  const TOT_3STAR = typeof settings.TOT_3STAR_EDGE !== 'undefined' ? Number(settings.TOT_3STAR_EDGE) : 0.12;

  const signals = [];
  const aModel  = modelResult.aML;
  const hModel  = modelResult.hML;
  const aMarket = game.market_away_ml;
  const hMarket = game.market_home_ml;

  function mlEdge(market, model) {
    const mktDist = market > 0 ? market - 100 : -market - 100;
    const mdlDist = model  > 0 ? model  - 100 : -model  - 100;
    return (market > 0) !== (model > 0) ? mktDist + mdlDist : Math.abs(market - model);
  }

  const awayEdge = (aMarket > 0 && aModel < 0) || (aMarket > aModel) ? mlEdge(aMarket, aModel) : 0;
  const homeEdge = (hMarket > 0 && hModel < 0) || (hMarket > hModel) ? mlEdge(hMarket, hModel) : 0;

  function mlLabel(edge) {
    if (edge >= ML_3STAR) return '3★';
    if (edge >= ML_2STAR) return '2★';
    if (edge >= ML_1STAR) return '1★';
    return null;
  }

  const aLabel = mlLabel(awayEdge);
  const hLabel = mlLabel(homeEdge);
  if (aLabel) signals.push({type:'ML',side:'away',label:aLabel,marketLine:aMarket,modelLine:aModel,edge:Math.round(awayEdge)});
  if (hLabel) signals.push({type:'ML',side:'home',label:hLabel,marketLine:hMarket,modelLine:hModel,edge:Math.round(homeEdge)});

  const mktTotal   = game.market_total || 8.5;
  const overPrice  = game.over_price   || -110;
  const underPrice = game.under_price  || -110;
  const estTot     = modelResult.estTot;

  const overImplied  = overPrice  < 0 ? Math.abs(overPrice) /(Math.abs(overPrice) +100) : 100/(overPrice +100);
  const underImplied = underPrice < 0 ? Math.abs(underPrice)/(Math.abs(underPrice)+100) : 100/(underPrice+100);

  const runDiff    = estTot - mktTotal;
  const modelOverP = Math.min(Math.max(0.5 + runDiff * 0.08, 0.20), 0.80);
  const modelUnderP = 1 - modelOverP;

  const overEdge  = modelOverP  - overImplied;
  const underEdge = modelUnderP - underImplied;

  function totLabel(edge) {
    if (edge >= TOT_3STAR) return '3★';
    if (edge >= TOT_2STAR) return '2★';
    if (edge >= TOT_1STAR) return '1★';
    return null;
  }

  const oLabel = totLabel(overEdge);
  const uLabel = totLabel(underEdge);
  if (oLabel) signals.push({type:'Total',side:'over', label:oLabel,marketLine:mktTotal,modelLine:parseFloat(estTot.toFixed(1)),overPrice,underPrice,edge:parseFloat(overEdge.toFixed(4))});
  if (uLabel) signals.push({type:'Total',side:'under',label:uLabel,marketLine:mktTotal,modelLine:parseFloat(estTot.toFixed(1)),overPrice,underPrice,edge:parseFloat(underEdge.toFixed(4))});

  return signals.map(s=>({...s,category:catKey(s.type,s.side,s.label,s.marketLine)}));
}

function calcPnl(signal, awayScore, homeScore, marketTotal) {
  if(awayScore==null||homeScore==null) return {outcome:'pending',pnl:0};
  const actualTotal=awayScore+homeScore;
  if(signal.type==='ML'){
    if(awayScore===homeScore) return {outcome:'push',pnl:0};
    const betTeamWon=signal.side==='away'?awayScore>homeScore:homeScore>awayScore;
    const ml=parseInt(signal.marketLine);
    // If marketLine is missing/null, still record outcome but pnl is null
    if(isNaN(ml)||ml===0) return {outcome:betTeamWon?'win':'loss',pnl:null};
    const pnl=betTeamWon?(ml>0?ml:parseFloat((100/Math.abs(ml)*100).toFixed(2))):-100;
    return {outcome:betTeamWon?'win':'loss',pnl:parseFloat(pnl.toFixed(2))};
  } else {
    // marketTotal param comes from game_log.market_total; fall back to signal.marketLine
    const line = parseFloat(marketTotal ?? signal.marketLine);
    if(isNaN(line) || line === 0) return {outcome:'pending',pnl:null}; // no total — can't score
    if(actualTotal===line) return {outcome:'push',pnl:0};
    const hitOver=actualTotal>line;
    const betWon=signal.side==='over'?hitOver:!hitOver;
    // Use over/under price if available, else default -110
    const price = signal.side==='over' ? (signal.overPrice||-110) : (signal.underPrice||-110);
    const payout = price>0 ? price : parseFloat((10000/Math.abs(price)).toFixed(2));
    return {outcome:betWon?'win':'loss',pnl:betWon?parseFloat(payout.toFixed(2)):-100};
  }
}

module.exports = { normName,buildWobaIndex,getBatterWoba,getPitcherWoba,runModel,getSignals,calcPnl,impliedP };