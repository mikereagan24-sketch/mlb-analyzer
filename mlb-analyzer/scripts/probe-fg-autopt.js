// Which FanGraphs parameter was dropping the samples: the grouping, or
// the automatic qualifier? Answer: the qualifier. Verified 2026-09-22 --
// career+autoPt-true returns 421 players and no Tidwell vs RHB;
// career+autoPt-false returns 1158 and Tidwell at 146 BF / .2824, which
// is exactly FanGraphs' career splits page.
//
// Real outbound calls, cookie from app_settings, never printed.
// Run: node --max-old-space-size=1536 scripts/probe-fg-autopt.js
const D=require('better-sqlite3');const db=new D('data/mlb.db',{readonly:true});
const ck=(db.prepare("SELECT value v FROM app_settings WHERE key='fangraphs_session_cookie'").get()||{}).v;
const end=new Date();const st=new Date(end);st.setFullYear(end.getFullYear()-2);
const iso=d=>d.toISOString().slice(0,10);
async function pull(g,autoPt){
  const r=await fetch('https://www.fangraphs.com/api/leaders/splits/splits-leaders',{method:'POST',
    headers:{'Cookie':'wordpress_logged_in_0cae6f5cb929d209043cb97f8c2eee44='+ck,'Content-Type':'application/json',
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept':'*/*','Referer':'https://www.fangraphs.com/leaders/splits-leaderboards',
      'Origin':'https://www.fangraphs.com','X-Requested-With':'XMLHttpRequest'},
    body:JSON.stringify({strSplitArr:['6'],strGroup:g,strPosition:'P',strType:'1',
      strStartDate:iso(st),strEndDate:iso(end),strSplitTeams:false,dctFilters:[],strStatType:'player',
      strAutoPt:autoPt,arrPlayerId:[],strPlayerId:'all',strSplitArrPitch:[],arrWxTemperature:null,
      arrWxPressure:null,arrWxAirDensity:null,arrWxElevation:null,arrWxWindSpeed:null}),
    signal:AbortSignal.timeout(90000)});
  if(!r.ok)return {err:'HTTP '+r.status};
  const j=await r.json();const rows=Array.isArray(j)?j:(j.data||j.rows||[]);
  const t=rows.filter(x=>/tidwell/i.test(String(x.playerName||'')));
  const ids=new Set(rows.map(x=>x.playerId));
  return {rows:rows.length, players:ids.size,
    tid:t.map(x=>({Season:x.Season,TBF:x.TBF,wOBA:Number(x.wOBA).toFixed(4)}))};
}
(async()=>{
  for(const [g,a] of [['career','true'],['career','false'],['season','false']]){
    const r=await pull(g,a);
    console.log('strGroup='+g.padEnd(7)+' strAutoPt='+a.padEnd(6)+
      (r.err?('  '+r.err):('  rows='+String(r.rows).padStart(5)+'  players='+String(r.players).padStart(5)+
      '  tidwell='+JSON.stringify(r.tid))));
    await new Promise(x=>setTimeout(x,4500));
  }
  console.log('\ntarget from FG career page: vsRHB 146 BF / ~.282');
})().catch(e=>console.error('ERROR '+e.message));
