'use strict';
const UB_URL = 'https://content.unabated.com/markets/game-odds/b_gameodds.json';
const MLB_KEY = 'lg5:pt1:pregame';
const ML_SOURCES = ['107','9','8','2','36','60','3','59','35','17','91','19'];
const TOTAL_SOURCES = ['91','105','59','35','17','102','19','3'];
const SOURCE_NAMES = {'9':'kalshi','3':'polymarket','59':'pinnacle','35':'pinnacle-d','105':'circa','102':'unabated','17':'novig','19':'dk','107':'fanduel','8':'betonline','36':'bookmaker','60':'sportsbetting'};
const ABBR_MAP = {ARI:'ari',ATL:'atl',BAL:'bal',BOS:'bos',CHC:'chc',CWS:'cws',CIN:'cin',CLE:'cle',COL:'col',DET:'det',HOU:'hou',KC:'kc',LAA:'laa',LAD:'lad',MIA:'mia',MIL:'mil',MIN:'min',NYM:'nym',NYY:'nyy',OAK:'ath',ATH:'ath',PHI:'phi',PIT:'pit',SD:'sd',SF:'sf',SEA:'sea',STL:'stl',TB:'tb',TEX:'tex',TOR:'tor',WSH:'was',WAS:'was'};

async function fetchUnabatedOdds(dateStr) {
  const cacheBust = '?v='+Date.now();
  const resp = await fetch(UB_URL+cacheBust, {headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0','Cache-Control':'no-cache','Pragma':'no-cache'}});
  if (!resp.ok) throw new Error('Unabated HTTP '+resp.status);
  const data = await resp.json();
  const teamMap = {};
  Object.entries(data.teams||{}).forEach(([id,t])=>{ if(t.abbreviation) teamMap[id]=t.abbreviation; });
  const allGames = data.gameOddsEvents?.[MLB_KEY] || [];

  const nextDayStr = new Date(dateStr+'T00:00:00');
  nextDayStr.setDate(nextDayStr.getDate()+1);
  const nextDayS = nextDayStr.toISOString().slice(0,10);
  const windowEnd = nextDayS + 'T04:00:00';

  const dateGames = allGames.filter(g=>{
    if (!g.eventStart) return false;
    if (g.eventStart.startsWith(dateStr)) return true;
    if (g.eventStart.startsWith(nextDayS) && g.eventStart < windowEnd) return true;
    return false;
  });

  const byMatchup = {};
  dateGames.forEach(g=>{
    const awayUb = teamMap[g.eventTeams['0']?.id];
    const homeUb = teamMap[g.eventTeams['1']?.id];
    const away = ABBR_MAP[awayUb] || awayUb?.toLowerCase();
    const home = ABBR_MAP[homeUb] || homeUb?.toLowerCase();
    if (!away || !home) return;
    const key = away+'-'+home;
    const n = Object.keys(g.gameOddsMarketSourcesLines||{}).length;
    const start = g.eventStart || '';
    // Keep the LATEST start time — the upcoming game, not the already-played one
    if (!byMatchup[key] || start > byMatchup[key].start) byMatchup[key] = {g,away,home,n,start};
  });

  console.log('[unabated] '+Object.keys(byMatchup).length+' games for '+dateStr);

  const results = [];
  for (const {g,away,home} of Object.values(byMatchup)) {
    const lines = g.gameOddsMarketSourcesLines||{};
    

    

    // Build bySource for ML (an0 only) and totals (all an values)
    const bySource = {};      // for ML ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ an0 only
    const bySourceTot = {};   // for totals ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ all an values, prefer bt3 with real points
    Object.entries(lines).forEach(([key,val])=>{
      const [si,ms,an]=key.split(':');
      const msId=ms.replace('ms','');
      const side=si==='si0'?'away':'home';
      // ML: an0 only
      if(an==='an0'){
        if(!bySource[msId]) bySource[msId]={};
        bySource[msId][side]=val;
      }
      // Totals: all an values ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ keep entry with real points (non-null, non-negative)
      if(val.bt3?.points!=null && val.bt3.points > 0){
        if(!bySourceTot[msId]) bySourceTot[msId]={};
        // Only overwrite if this an has a better (non-null) price
        if(!bySourceTot[msId][side] || bySourceTot[msId][side].bt3?.points==null){
          bySourceTot[msId][side]=val;
        }
      }
    });

    // ML
    let awayML=null,homeML=null,mlSrc=null;
    for(const msId of ML_SOURCES){
      const s=bySource[msId];
      if(s?.away?.bt1?.americanPrice && s?.home?.bt1?.americanPrice){
        awayML=s.away.bt1.americanPrice; homeML=s.home.bt1.americanPrice;
        mlSrc=SOURCE_NAMES[msId]||msId; break;
      }
    }
    if(!awayML||!homeML){
      for(const [msId,sides] of Object.entries(bySource)){
        if(sides.away?.bt1?.americanPrice && sides.home?.bt1?.americanPrice){
          awayML=sides.away.bt1.americanPrice; homeML=sides.home.bt1.americanPrice;
          mlSrc='src'+msId; break;
        }
      }
    }

    // TOTAL: bt3 can be on si0 (over/away) OR si1 (under/home) depending on book
    let total=null,overPrice=null,underPrice=null,totalSrc=null;
    for(const msId of TOTAL_SOURCES){
      const s=bySourceTot[msId];
      if(s?.away?.bt3?.points!=null){
        total=s.away.bt3.points; overPrice=s.away.bt3.americanPrice??null;
        underPrice=s?.home?.bt3?.americanPrice??null;
        totalSrc=SOURCE_NAMES[msId]||msId; break;
      } else if(s?.home?.bt3?.points!=null){
        total=s.home.bt3.points; overPrice=s?.away?.bt3?.americanPrice??null;
        underPrice=s.home.bt3.americanPrice??null;
        totalSrc=SOURCE_NAMES[msId]||msId; break;
      }
    }
    if(total==null){
      const SHARP=['60','36','89','98','95','52','66','104','49','27','25','24','8','10','4'];
      for(const msId of SHARP){
        const s=bySourceTot[msId];
        if(s?.away?.bt3?.points!=null){
          total=s.away.bt3.points; overPrice=s.away.bt3.americanPrice??null;
          underPrice=s?.home?.bt3?.americanPrice??null; totalSrc='src'+msId+'(fb)'; break;
        } else if(s?.home?.bt3?.points!=null){
          total=s.home.bt3.points; overPrice=s?.away?.bt3?.americanPrice??null;
          underPrice=s.home.bt3.americanPrice??null; totalSrc='src'+msId+'(fb)'; break;
        }
      }
    }

    console.log('[unabated] '+away+'-'+home+': ml='+awayML+'/'+homeML+'('+mlSrc+') tot='+total+'('+totalSrc+')');
    results.push({game_id:away+'-'+home,market_away_ml:awayML,market_home_ml:homeML,market_total:total,over_price:overPrice,under_price:underPrice,source:'unabated'});
  }
  return results;
}

module.exports = { fetchUnabatedOdds };