'use strict';

const UB_URL = 'https://content.unabated.com/markets/game-odds/b_gameodds.json';
const MLB_KEY = 'lg5:pt1:pregame';
const ML_SOURCES    = ['9','3','59','35','105','17','91','19','107'];
const TOTAL_SOURCES = ['9','3','59','35','105','91','102','17','19'];
const SOURCE_NAMES  = {'9':'kalshi','3':'polymarket','59':'pinnacle','35':'pinnacle-d','105':'circa','102':'unabated','17':'novig','19':'dk'};
const ABBR_MAP = {ARI:'ari',ATL:'atl',BAL:'bal',BOS:'bos',CHC:'chc',CWS:'cws',CIN:'cin',CLE:'cle',COL:'col',DET:'det',HOU:'hou',KC:'kc',LAA:'laa',LAD:'lad',MIA:'mia',MIL:'mil',MIN:'min',NYM:'nym',NYY:'nyy',OAK:'ath',ATH:'ath',PHI:'phi',PIT:'pit',SD:'sd',SF:'sf',SEA:'sea',STL:'stl',TB:'tb',TEX:'tex',TOR:'tor',WSH:'was',WAS:'was'};

async function fetchUnabatedOdds(dateStr) {
  const cacheBust = '?v='+Date.now();
  const resp = await fetch(UB_URL+cacheBust, {headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0','Cache-Control':'no-cache','Pragma':'no-cache'}});
  if (!resp.ok) throw new Error('Unabated HTTP '+resp.status);
  const data = await resp.json();

  const teamMap = {};
  Object.entries(data.teams||{}).forEach(([id,t])=>{ if(t.abbreviation) teamMap[id]=t.abbreviation; });

  const allGames = data.gameOddsEvents?.[MLB_KEY] || [];

  // Window: games starting on dateStr (ET) through 04:00 ET next morning
  // Unabated timestamps are ET (no UTC suffix), so late games like 10pm = same date
  // Early morning games (1-3am ET) appear on dateStr+1
  const nextDayStr = new Date(dateStr+'T00:00:00');
  nextDayStr.setDate(nextDayStr.getDate()+1);
  const nextDayS = nextDayStr.toISOString().slice(0,10);
  const windowEnd = nextDayS + 'T04:00:00'; // covers up to 4am ET next day

  const dateGames = allGames.filter(g=>{
    if (!g.eventStart) return false;
    if (g.eventStart.startsWith(dateStr)) return true;
    // Cover early morning ET games (e.g. 1am ET = technically next calendar day)
    if (g.eventStart.startsWith(nextDayS) && g.eventStart < windowEnd) return true;
    return false;
  });

  // Dedup by matchup â for same teams on same date, keep the one with most lines (most data)
  // This handles doubleheaders correctly (different start times, same teams)
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
  // Log totals for each game so we can debug
  for(const {g,away,home} of Object.values(byMatchup)){
    let kalTot=null;
    Object.entries(g.gameOddsMarketSourcesLines||{}).forEach(([k,v])=>{
      const [si,ms,an]=k.split(':');
      if(an==='an0'&&ms==='ms9'&&si==='si1') kalTot=v.bt3?.points;
    });
    if(!kalTot) console.log('[unabated] NO TOTAL: '+away+'-'+home+' start='+g.eventStart);
  }
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
  // Fallback: take any source with both ML sides populated
  if(!awayML || !homeML) {
    for(const [msId, sides] of Object.entries(bySource)) {
      if(sides.away && sides.home && Math.abs(sides.away) > 100 && Math.abs(sides.home) > 100) {
        if(!awayML) awayML = sides.away;
        if(!homeML) homeML = sides.home;
        mlSrc = 'src'+msId;
        break;
      }
    }
  }
    for(const msId of TOTAL_SOURCES){const s=bySource[msId];const si0bt3=s?.away?.bt3;const si1bt3=s?.home?.bt3;if(si0bt3?.points!=null){total=si0bt3.points;overPrice=si0bt3.americanPrice??null;underPrice=si1bt3?.americanPrice??null;totalSrc=SOURCE_NAMES[msId]||msId;break;}else if(si1bt3?.points!=null){total=si1bt3.points;overPrice=si0bt3?.americanPrice??null;underPrice=si1bt3.americanPrice??null;totalSrc=SOURCE_NAMES[msId]||msId;break;}}
    // Sharp-only fallback: if no priority source posted, try known sharp/low-vig books only
    // Excludes soft books (1,2,20,67,78,86 etc) that often post stale or incorrect lines
    if(total==null){
      const SHARP_FALLBACK=['60','36','89','98','95','52','66','104','49','27','25','24','8','10','4'];
      for(const msId of SHARP_FALLBACK){
        const s=bySource[msId];
        const fb0=s?.away?.bt3;const fb1=s?.home?.bt3;if(fb0?.points!=null){total=fb0.points;overPrice=fb0.americanPrice??null;underPrice=fb1?.americanPrice??null;totalSrc='src'+msId+'(fallback)';break;}else if(fb1?.points!=null){total=fb1.points;overPrice=fb0?.americanPrice??null;underPrice=fb1.americanPrice??null;totalSrc='src'+msId+'(fallback)';break;}
      }
    }

    console.log('[unabated] '+away+'-'+home+': ml='+awayML+'/'+homeML+'('+mlSrc+') tot='+total+'('+totalSrc+')');
    results.push({game_id:away+'-'+home,market_away_ml:awayML,market_home_ml:homeML,market_total:total,over_price:overPrice,under_price:underPrice,source:'unabated'});
  }
  return results;
}

module.exports = { fetchUnabatedOdds };
