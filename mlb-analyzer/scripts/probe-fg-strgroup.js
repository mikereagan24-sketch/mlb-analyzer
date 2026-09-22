// Does FanGraphs aggregate the date range if strGroup is set differently?
//
// The brief says PREFER letting FG aggregate, but verify against a real
// response rather than assuming. So this asks FG directly, with the
// current body and one field changed at a time, and reports:
//   - HTTP status (an unknown strGroup may 500, which is itself an answer)
//   - row count
//   - how many rows come back for ONE pitcher (Blade Tidwell)
//   - that pitcher's TBF and wOBA per row
//
// Baseline is strGroup:'season', which is what production sends today and
// which returns one row per player per SEASON -- 804 rows storing as 539.
//
// Read-only against our DB. Makes real outbound requests to FanGraphs
// using the operator's stored session cookie. The cookie is never printed.
//
// Run: node --max-old-space-size=1536 scripts/probe-fg-strgroup.js

const D = require('better-sqlite3');
const db = new D('data/mlb.db', { readonly: true });

const COOKIE_NAME = (() => {
  const m = /const COOKIE_NAME = '([^']+)'/.exec(
    require('fs').readFileSync(require('path').join(__dirname, '..', 'services/fangraphs.js'), 'utf8'));
  return m ? m[1] : 'fangraphs.com';
})();
const cookie = (db.prepare("SELECT value v FROM app_settings WHERE key='fangraphs_session_cookie'")
  .get() || {}).v;
if (!cookie) { console.log('No stored FanGraphs cookie. Cannot verify.'); process.exit(0); }

function twoYearDateRange() {
  const end = new Date(); const start = new Date(end);
  start.setFullYear(end.getFullYear() - 2);
  const iso = d => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}
const { start, end } = twoYearDateRange();

function bodyFor(strGroup) {
  return {
    strSplitArr: ['5'],          // vs RHB (the split Tidwell's 86 came from)
    strGroup,
    strPosition: 'P',
    strType: '1',
    strStartDate: start,
    strEndDate: end,
    strSplitTeams: false,
    dctFilters: [],
    strStatType: 'player',
    strAutoPt: 'true',
    arrPlayerId: [],
    strPlayerId: 'all',
    strSplitArrPitch: [],
    arrWxTemperature: null, arrWxPressure: null, arrWxAirDensity: null,
    arrWxElevation: null, arrWxWindSpeed: null,
  };
}

async function try1(strGroup) {
  const res = await fetch('https://www.fangraphs.com/api/leaders/splits/splits-leaders', {
    method: 'POST',
    headers: {
      'Cookie': COOKIE_NAME + '=' + cookie,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.fangraphs.com/leaders/splits-leaderboards',
      'Origin': 'https://www.fangraphs.com', 'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify(bodyFor(strGroup)),
    signal: AbortSignal.timeout(60000),
  });
  const txt = await res.text();
  if (!res.ok) return { strGroup, status: res.status, note: txt.slice(0, 120) };
  let j; try { j = JSON.parse(txt); } catch (e) { return { strGroup, status: res.status, note: 'unparseable' }; }
  const rows = Array.isArray(j) ? j : (j.data || j.rows || []);
  const mine = rows.filter(r => /tidwell/i.test(JSON.stringify(r.Name || r.playerName || r.PlayerName || '')));
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const seasonish = cols.filter(c => /season|year|date/i.test(c));
  const tbfish = cols.filter(c => /^(tbf|bf|pa)$/i.test(c));
  const wobaish = cols.filter(c => /^woba$/i.test(c));
  return {
    strGroup, status: res.status, rows: rows.length,
    seasonCols: seasonish, tbfCols: tbfish, wobaCols: wobaish,
    tidwellRows: mine.length,
    tidwell: mine.map(r => {
      const o = {};
      for (const c of [...seasonish, ...tbfish, ...wobaish, 'Name', 'Team']) if (r[c] !== undefined) o[c] = r[c];
      return o;
    }),
  };
}

(async () => {
  console.log('window: ' + start + ' .. ' + end + '   split=vs RHB (strSplitArr ["5"])\n');
  for (const g of ['season', 'career', 'total', 'all', '']) {
    try {
      const r = await try1(g);
      console.log('strGroup=' + JSON.stringify(g).padEnd(10)
        + ' HTTP ' + r.status
        + (r.rows != null ? '  rows=' + String(r.rows).padStart(5) : '')
        + (r.tidwellRows != null ? '  tidwell_rows=' + r.tidwellRows : '')
        + (r.note ? '  ' + r.note.replace(/\s+/g, ' ') : ''));
      if (r.seasonCols && r.rows) {
        console.log('     season-ish cols: ' + (r.seasonCols.join(',') || '(none)')
          + '   tbf: ' + (r.tbfCols.join(',') || '(none)')
          + '   woba: ' + (r.wobaCols.join(',') || '(none)'));
      }
      if (r.tidwell && r.tidwell.length) r.tidwell.forEach(t => console.log('     ' + JSON.stringify(t)));
    } catch (e) {
      console.log('strGroup=' + JSON.stringify(g).padEnd(10) + ' THREW  ' + (e.message || e).slice(0, 90));
    }
    await new Promise(r => setTimeout(r, 1500));
  }
})();
