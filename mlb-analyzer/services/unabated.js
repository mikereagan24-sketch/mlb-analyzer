'use strict';

const UB_URL = 'https://content.unabated.com/markets/game-odds/b_gameodds.json';
const MLB_KEY = 'lg5:pt1:pregame';
const ML_SOURCES    = ['9','59','35','105','17','19'];
const TOTAL_SOURCES = ['9','3','59','35','102','17','19'];
const SOURCE_NAMES  = {'9':'kalshi','3':'polymarket','59':'pinnacle','35':'pinnacle-d','105':'circa','102':'unabated','17':'novig','19':'dk'};
const ABBR_MAP = {ARI:'ari',ATL:'atl',BAL:'bal',BOS:'bos',CHC:'chc',CWS:'cws',CIN:'cin',CLE:'cle',COL:'col',DET:'det',HOU:'hou',KC:'kc',LAA:'laa',LAD:'lad',MIA:'mia',MIL:'mil',MIN:'min',NYM:'nym',NYY:'nyy',OAK:'ath',ATH:'ath',PHI:'phi',PIT:'pit',SD:'sd',SF:'sf',SEA:'sea',STL:'stl',TB:'tb',TEX:'tex',TOR:'tor',WSH:'was',WAS:'was'};

async function fetchUnabatedOdds(dateStr) {
  const resp = await fetch(UB_URL, {headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'}});
  if (!resp.ok) throw new Error('Unabated HTTP '+resp.status);
  const data = await resp.json();

  const teamMap = {};
  Object.entries(data.teams||{}).forEach(([id,t])=>{ if(t.abbreviation) teamMap[id]=t.abbreviation; });

  const allGames = data.gameOddsEvents?.[MLB_KEY] || [];

  const nextDay = new Date(dateStr+'T00:00:00');
  nextDay.setDate(nextDay.getDate()+1);
  const nextDayStr = nextDay.toISOString().slice(0,10);
  const windowEnd = new Date(dateStr+'T00:00:00');
  windowEnd.setDate(windowEnd.getDate()+2);
  const windowEndStr = windowEnd.toISOString().slice(0,10)+'T10:00:00';

  const dateGames = allGames.filter(g=>{
    if (!g.eventStart) return false;
    if (g.eventStart.startsWith(dateStr)) return true;
    if (g.eventStart.startsWith(nextDayStr) && g.eventStart < windowEndStr) return true;
    return false;
  });

  // Dedup by matchup — keep game with most lines (most data)
  const byMatchup = {};
  dateGames.forEach(g=>{
    const awayUb = teamMap[g.eventTeams['0']?.id];
    const homeUb = teamMap[g.eventTeams['1']?.id];
    const away = ABBR_MAP[awayUb] || awayUb?.toLowerCase();
    const home = ABBR_MAP[homeUb] || homeUb?.toLowerCase();
    if (!away || !home) return;
    const key = away+'-'+home;
    const n = Object.keys(g.gameOddsMarketSourcesLines||{}).length;
    if (!byMatchup[key] || n > byMatchup[key].n) byMatchup[key] = {g,away,home,n};
  });

  console.log('[unabated] '+Object.keys(byMatchup).length+' games for '+dateStr);
  const results = [];

  for (const {g,away,home} of Object.values(byMatchup)) {
    const lines = g.gameOddsMarketSourcesLines||{};
    const bySource = {};
    Object.entries(lines).forEach(([key,val])=>{
      const [si,ms,an]=key.split(':');
      if(an!=='an0') return;
      const msId=ms.replace('ms','');
      if(!bySource[msId]) bySource[msId]={};
      bySource[msId][si==='si0'?'away':'home']=val;
    });

    let awayML=null,homeML=null,mlSrc=null;
    for(const msId of ML_SOURCES){
      const s=bySource[msId];
      if(s?.away?.bt1?.americanPrice && s?.home?.bt1?.americanPrice){
        awayML=s.away.bt1.americanPrice; homeML=s.home.bt1.americanPrice;
        mlSrc=SOURCE_NAMES[msId]||msId; break;
      }
    }

    let total=null,overPrice=null,underPrice=null,totalSrc=null;
    for(const msId of TOTAL_SOURCES){
      const s=bySource[msId];
      if(s?.home?.bt3?.points!=null){
        total=s.home.bt3.points; overPrice=s.home.bt3.americanPrice;
        underPrice=s?.away?.bt3?.americanPrice??null;
        totalSrc=SOURCE_NAMES[msId]||msId; break;
      }
    }

    console.log('[unabated] '+away+'-'+home+': ml='+awayML+'/'+homeML+'('+mlSrc+') tot='+total+'('+totalSrc+')');
    results.push({game_id:away+'-'+home,market_away_ml:awayML,market_home_ml:homeML,market_total:total,over_price:overPrice,under_price:underPrice,source:'unabated'});
  }
  return results;
}

module.exports = { fetchUnabatedOdds };
