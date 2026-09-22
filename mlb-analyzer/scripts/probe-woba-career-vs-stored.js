// Stored (strGroup:'season' collapse) vs expected (strGroup:'career').
//
// The verification the brief asked for: pull what the FIXED request
// returns and compare it against what is in woba_data today. Real FG
// response, not a simulation.
//
// Read-only. Cookie read from app_settings, never printed.
// Run: node --max-old-space-size=1536 scripts/probe-woba-career-vs-stored.js

const D = require('better-sqlite3');
const db = new D('data/mlb.db', { readonly: true });
const cookie = (db.prepare("SELECT value v FROM app_settings WHERE key='fangraphs_session_cookie'").get() || {}).v;
if (!cookie) { console.log('No stored cookie.'); process.exit(0); }

const end = new Date(); const st = new Date(end); st.setFullYear(end.getFullYear() - 2);
const iso = d => d.toISOString().slice(0, 10);

async function pull(splitCode, strGroup) {
  const res = await fetch('https://www.fangraphs.com/api/leaders/splits/splits-leaders', {
    method: 'POST',
    headers: {
      'Cookie': 'fangraphs.com=' + cookie, 'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*', 'Referer': 'https://www.fangraphs.com/leaders/splits-leaderboards',
      'Origin': 'https://www.fangraphs.com', 'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      strSplitArr: [splitCode], strGroup, strPosition: 'P', strType: '1',
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
    const nm = String(r.Name || '').replace(/<[^>]+>/g, '').trim();
    if (nm) m.set(nm.toLowerCase(), { tbf: Number(r.TBF), woba: Number(r.wOBA) });
  }
  return m;
}

(async () => {
  console.log('window ' + iso(st) + ' .. ' + iso(end) + '\n');
  const SPLIT = { lhb: 5, rhb: 6 };
  const out = {};
  for (const [hand, code] of Object.entries(SPLIT)) {
    out[hand] = { career: await pull(code, 'career') };
    await new Promise(r => setTimeout(r, 1500));
  }
  const storedOf = (hand, name) => {
    const r = db.prepare('SELECT woba, sample_size FROM woba_data WHERE data_key=? AND lower(player_name)=?')
      .get('pit-act-' + hand, name.toLowerCase());
    return r ? { tbf: Number(r.sample_size), woba: Number(r.woba) } : null;
  };

  // Tidwell first, then the five largest shortfalls among pitchers we
  // actually store -- those are the ones a two-year aggregate changes most.
  const names = ['Blade Tidwell'];
  const cand = [];
  for (const [lname, c] of out.rhb.career) {
    const s = storedOf('rhb', lname);
    if (!s || !Number.isFinite(c.tbf) || c.tbf < 100) continue;
    const gap = c.tbf - s.tbf;
    if (gap > 0) cand.push({ lname, gap });
  }
  cand.sort((a, b) => b.gap - a.gap);
  for (const c of cand) {
    if (names.length >= 6) break;
    const proper = c.lname.replace(/\b\w/g, m => m.toUpperCase());
    if (!/tidwell/i.test(c.lname)) names.push(proper);
  }

  console.log('name'.padEnd(22) + 'hand  stored        expected(career)   delta');
  console.log('-'.repeat(74));
  for (const n of names) {
    for (const hand of ['rhb', 'lhb']) {
      const s = storedOf(hand, n), c = out[hand].career.get(n.toLowerCase());
      if (!s && !c) continue;
      const sTxt = s ? (String(s.tbf).padStart(4) + ' / .' + (s.woba * 1000).toFixed(0)) : '   — / —  ';
      const cTxt = c ? (String(c.tbf).padStart(4) + ' / .' + (c.woba * 1000).toFixed(0)) : '   — / —  ';
      const d = (s && c) ? ('+' + (c.tbf - s.tbf) + ' BF') : '';
      console.log(n.padEnd(22) + hand.padEnd(6) + sTxt.padEnd(14) + cTxt.padEnd(19) + d);
    }
  }
  console.log('\n  stored = today\'s woba_data (built with strGroup:\'season\')');
  console.log('  expected = the same window with strGroup:\'career\'');
})().catch(e => { console.error('ERROR: ' + (e.message || e)); process.exit(1); });
