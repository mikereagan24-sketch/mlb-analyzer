// Stored actuals (built with strGroup:'season') vs what a true trailing
// two-year aggregate returns (strGroup:'career').
//
// This is the verification for the actuals-collapse fix. It makes FOUR
// real FanGraphs calls -- pit vs L, pit vs R, bat vs L, bat vs R -- with
// a pause between each, and compares every row against woba_data.
//
// Split codes come from services/fangraphs.js refreshAllFanGraphs:
//   1 = bat-act-lhp   2 = bat-act-rhp   5 = pit-act-lhb   6 = pit-act-rhb
// Sample column is TBF for pitchers and PA for batters, matching
// parseCSV's own sampleCols.
//
// Read-only. Cookie read from app_settings; never printed.
// Run: node --max-old-space-size=1536 scripts/probe-woba-career-vs-stored.js

const D = require('better-sqlite3');
const db = new D('data/mlb.db', { readonly: true });
const cookie = (db.prepare("SELECT value v FROM app_settings WHERE key='fangraphs_session_cookie'")
  .get() || {}).v;
if (!cookie) { console.log('No stored FanGraphs cookie.'); process.exit(0); }

const end = new Date(); const st = new Date(end); st.setFullYear(end.getFullYear() - 2);
const iso = d => d.toISOString().slice(0, 10);

const GROUPS = [
  { key: 'pit-act-lhb', code: 5, pos: 'P', label: 'pitchers vs LHB' },
  { key: 'pit-act-rhb', code: 6, pos: 'P', label: 'pitchers vs RHB' },
  { key: 'bat-act-lhp', code: 1, pos: 'B', label: 'batters vs LHP' },
  { key: 'bat-act-rhp', code: 2, pos: 'B', label: 'batters vs RHP' },
];

async function pull(code, pos, strGroup) {
  const res = await fetch('https://www.fangraphs.com/api/leaders/splits/splits-leaders', {
    method: 'POST',
    headers: {
      'Cookie': 'wordpress_logged_in_0cae6f5cb929d209043cb97f8c2eee44=' + cookie,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*', 'Referer': 'https://www.fangraphs.com/leaders/splits-leaderboards',
      'Origin': 'https://www.fangraphs.com', 'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      strSplitArr: [String(code)], strGroup, strPosition: pos,
      strType: pos === 'P' ? '1' : '2',
      strStartDate: iso(st), strEndDate: iso(end), strSplitTeams: false,
      dctFilters: [], strStatType: 'player', strAutoPt: 'true',
      arrPlayerId: [], strPlayerId: 'all', strSplitArrPitch: [],
      arrWxTemperature: null, arrWxPressure: null, arrWxAirDensity: null,
      arrWxElevation: null, arrWxWindSpeed: null,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const rows = Array.isArray(j) ? j : (j.data || j.rows || []);
  const m = new Map();
  for (const r of rows) {
    // FG's splits API returns `playerName`, not `Name`. Using Name gave
    // 0 rows with a 200 status -- a silent empty result, which is why
    // the row count is printed below rather than assumed.
    const nm = String(r.playerName || r.Name || '').replace(/<[^>]+>/g, '').trim();
    if (!nm) continue;
    const s = Number(pos === 'P' ? r.TBF : r.PA);
    m.set(nm.toLowerCase(), { s, woba: Number(r.wOBA) });
  }
  return m;
}

const stored = (key, lname) => {
  const r = db.prepare('SELECT woba, sample_size FROM woba_data WHERE data_key=? '
    + 'AND lower(player_name)=?').get(key, lname);
  return r ? { s: Number(r.sample_size), woba: Number(r.woba) } : null;
};
const fmt = (o, unit) => o ? (String(Math.round(o.s)).padStart(4) + ' / .'
  + String(Math.round(o.woba * 1000)).padStart(3, '0')) : '   - / -   ';

(async () => {
  console.log('window ' + iso(st) + ' .. ' + iso(end)
    + '   (strGroup career vs what is stored from season)\n');
  const all = {};
  for (const g of GROUPS) {
    try { all[g.key] = await pull(g.code, g.pos, 'career'); }
    catch (e) { console.log(g.label + ': FAILED ' + e.message); all[g.key] = null; }
    await new Promise(r => setTimeout(r, 4000));
  }

  // ---- 1. the distribution, per key ---------------------------------
  console.log('=== rows and sample ratio, per data_key ===');
  console.log('key           career_rows  stored_rows   median stored/career sample');
  for (const g of GROUPS) {
    const c = all[g.key];
    if (!c) { console.log('  ' + g.key + '  (pull failed)'); continue; }
    const sRows = db.prepare('SELECT COUNT(*) n FROM woba_data WHERE data_key=?').get(g.key).n;
    const ratios = [];
    for (const [ln, cv] of c) {
      const sv = stored(g.key, ln);
      if (sv && cv.s >= 40) ratios.push(sv.s / cv.s);
    }
    ratios.sort((a, b) => a - b);
    const med = ratios.length ? ratios[Math.floor(ratios.length / 2)] : NaN;
    console.log('  ' + g.key.padEnd(13) + String(c.size).padStart(6)
      + String(sRows).padStart(13) + '        '
      + (ratios.length ? med.toFixed(2) + '  (n=' + ratios.length + ')' : 'n/a'));
  }

  // ---- 2. named players --------------------------------------------
  const show = (title, key, names, unit) => {
    const c = all[key];
    if (!c) return;
    console.log('\n' + title);
    console.log('  ' + 'player'.padEnd(24) + 'stored'.padEnd(14) + 'career(expected)'.padEnd(16) + 'delta');
    for (const n of names) {
      const ln = n.toLowerCase();
      const sv = stored(key, ln), cv = c.get(ln);
      if (!sv && !cv) continue;
      const d = (sv && cv) ? ('+' + Math.round(cv.s - sv.s) + ' ' + unit) : '';
      console.log('  ' + n.padEnd(24) + fmt(sv, unit).padEnd(14) + fmt(cv, unit).padEnd(16) + d);
    }
  };

  // biggest shortfalls = where the two-year aggregate changes most
  const worst = (key, n, exclude) => {
    const c = all[key]; if (!c) return [];
    const out = [];
    for (const [ln, cv] of c) {
      const sv = stored(key, ln);
      if (!sv || !(cv.s > 0)) continue;
      if (exclude && exclude.some(x => ln === x.toLowerCase())) continue;
      out.push({ ln, gap: cv.s - sv.s });
    }
    out.sort((a, b) => b.gap - a.gap);
    return out.slice(0, n).map(o => o.ln.replace(/\b\w/g, m => m.toUpperCase()));
  };

  show('=== Blade Tidwell (the reported case) ===', 'pit-act-rhb', ['Blade Tidwell'], 'BF');
  show('   ...vs LHB', 'pit-act-lhb', ['Blade Tidwell'], 'BF');
  show('=== five more pitchers, largest shortfall vs RHB ===', 'pit-act-rhb',
    worst('pit-act-rhb', 5, ['Blade Tidwell']), 'BF');
  show('=== five batters, largest shortfall vs RHP ===', 'bat-act-rhp',
    worst('bat-act-rhp', 5), 'PA');

  console.log('\n  stored   = woba_data today, built with strGroup:\'season\'');
  console.log('  expected = same window, strGroup:\'career\' (the fix in #435)');
})().catch(e => { console.error('ERROR: ' + (e.message || e)); process.exit(1); });
