// Does team-tagging the actuals change what resolves?
//
// Blanket tagging breaks 31-38% of lookups because FanGraphs reports a
// multi-team marker ("6 Tms") over a two-year window. Collision-only
// tagging -- the shipped behaviour -- loses nothing. This proves both.
//
// What does team-tagging the actuals change, and does anything stop
// resolving?
//
// Pulls the four actuals splits live (they carry TeamNameAbb), builds the
// index BOTH ways -- today's bare keys and the team-tagged keys the fix
// produces -- and runs the REAL fuzzyLookup against the REAL (name, team)
// pairs the model queries with, taken from game_log.
//
// Read-only. Cookie from app_settings, never printed.

const path = require('path');
const R = path.join(__dirname, '..');
const D = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new D(path.join(R, 'data', 'mlb.db'), { readonly: true });
const { fuzzyLookup, normName } = require(path.join(R, 'utils/names'));
const { FG_TEAM_MAP } = require(path.join(R, 'utils/fg-pitcher-id'));
const cookie = (db.prepare("SELECT value v FROM app_settings WHERE key='fangraphs_session_cookie'")
  .get() || {}).v;

const end = new Date(); const st = new Date(end); st.setFullYear(end.getFullYear() - 2);
const iso = d => d.toISOString().slice(0, 10);
const SPLITS = [
  { key: 'pit-act-lhb', code: 5, pos: 'P' },
  { key: 'pit-act-rhb', code: 6, pos: 'P' },
  { key: 'bat-act-lhp', code: 1, pos: 'B' },
  { key: 'bat-act-rhp', code: 2, pos: 'B' },
];

async function pull(code, pos) {
  const r = await fetch('https://www.fangraphs.com/api/leaders/splits/splits-leaders', {
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
      strSplitArr: [String(code)], strGroup: 'career', strPosition: pos,
      strType: pos === 'P' ? '1' : '2', strStartDate: iso(st), strEndDate: iso(end),
      strSplitTeams: false, dctFilters: [], strStatType: 'player', strAutoPt: 'false',
      arrPlayerId: [], strPlayerId: 'all', strSplitArrPitch: [],
      arrWxTemperature: null, arrWxPressure: null, arrWxAirDensity: null,
      arrWxElevation: null, arrWxWindSpeed: null,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : (j.data || j.rows || []);
}

// Expansion, exactly as ingestWobaCSV does it.
const SUF = /\s+(jr\.?|sr\.?|ii|iii|iv)$/i;
function expand(name, team) {
  if (!team) return [name];                         // rule 1: bare only
  const out = [name + ' ' + team];                  // rule 2: name+team only
  if (SUF.test(name)) out.push(name.replace(SUF, '') + ' ' + team);  // rule 3
  return out;
}
// Mode 'collide': keep bare keys, and tag ONLY the names that appear
// more than once -- the minimum change that removes the ambiguity.
const buildIdx = (rows, tagged, collidedSet) => {
  const m = {};
  for (const r of rows) {
    const n = String(r.playerName || '').replace(/<[^>]+>/g, '').trim();
    if (!n) continue;
    let t = String(r.TeamNameAbb || '').trim().toUpperCase();
    t = FG_TEAM_MAP[t] || t;
    const woba = Number(r.wOBA);
    const useTeam = collidedSet ? (collidedSet.has(normName(n)) ? t : null) : (tagged ? t : null);
    for (const form of expand(n, useTeam)) m[normName(form)] = { woba, sample: 1 };
  }
  return m;
};

(async () => {
  console.log('window ' + iso(st) + ' .. ' + iso(end) + '\n');
  for (const sp of SPLITS) {
    let rows;
    try { rows = await pull(sp.code, sp.pos); }
    catch (e) { console.log(sp.key + ': pull FAILED ' + e.message); continue; }

    const bare = buildIdx(rows, false);
    const tagged = buildIdx(rows, true);
    const bareKeys = Object.keys(bare), tagKeys = Object.keys(tagged);

    // how many source players lack a team -> would still be bare
    const noTeam = rows.filter(r => !String(r.TeamNameAbb || '').trim()).length;
    // collisions that team-tagging resolves
    const bareCount = new Map();
    for (const r of rows) {
      const n = normName(String(r.playerName || '').replace(/<[^>]+>/g, '').trim());
      if (n) bareCount.set(n, (bareCount.get(n) || 0) + 1);
    }
    const collided = [...bareCount.entries()].filter(([, c]) => c > 1);

    console.log('=== ' + sp.key + ' ===');
    console.log('  source rows                 : ' + rows.length);
    console.log('  rows with no team (stay bare): ' + noTeam);
    console.log('  keys BEFORE (bare)          : ' + bareKeys.length);
    console.log('  keys AFTER  (team-tagged)   : ' + tagKeys.length);
    console.log('  rows whose KEY CHANGES      : ' + (rows.length - noTeam));
    console.log('  bare-name collisions killed : ' + collided.length
      + (collided.length ? '  (' + collided.map(c => c[0]).join(', ') + ')' : ''));
    const tms = rows.filter(r => /^(TMS|TM|- - -)$/i.test(String(r.TeamNameAbb || '').trim())).length;
    console.log('  rows whose TeamNameAbb is a MULTI-TEAM marker: ' + tms
      + '  (' + (100 * tms / rows.length).toFixed(1) + '%)');
    for (const [cn] of collided) {
      const both = rows.filter(r => normName(String(r.playerName||'').replace(/<[^>]+>/g,'').trim()) === cn)
        .map(r => String(r.TeamNameAbb || '?').trim());
      console.log('    collided "' + cn + '" teams: ' + both.join(' / '));
    }

    // ---- the real question: does anything stop resolving? ----------
    const collideIdx = buildIdx(rows, false, new Set(collided.map(c => c[0])));
    const isPit = sp.pos === 'P';
    const queries = [];
    if (isPit) {
      for (const g of db.prepare('SELECT away_sp, away_team, home_sp, home_team FROM game_log '
        + 'WHERE away_sp IS NOT NULL AND game_date >= ?').all('2026-08-01')) {
        if (g.away_sp) queries.push([g.away_sp, g.away_team]);
        if (g.home_sp) queries.push([g.home_sp, g.home_team]);
      }
    } else {
      for (const g of db.prepare('SELECT away_lineup_json, away_team, home_lineup_json, home_team '
        + 'FROM game_log WHERE away_lineup_json IS NOT NULL AND game_date >= ?').all('2026-08-01')) {
        for (const [js, tm] of [[g.away_lineup_json, g.away_team], [g.home_lineup_json, g.home_team]]) {
          try { for (const b of JSON.parse(js || '[]')) if (b && b.name) queries.push([b.name, tm]); }
          catch (e) {}
        }
      }
    }
    const seen = new Set();
    let n = 0, both = 0, lost = 0, gained = 0, neither = 0;
    const lostEx = [];
    for (const [nm, tm] of queries) {
      const k = nm + '|' + tm;
      if (seen.has(k)) continue;
      seen.add(k); n++;
      const b = !!fuzzyLookup(bare, nm, tm);
      const t = !!fuzzyLookup(collideIdx, nm, tm);
      if (b && t) both++;
      else if (b && !t) { lost++; if (lostEx.length < 8) lostEx.push(nm + ' (' + tm + ')'); }
      else if (!b && t) gained++;
      else neither++;
    }
    console.log('  --- COLLISION-ONLY tagging: resolution over ' + n + ' queries since 2026-08-01');
    console.log('      resolve BOTH ways : ' + both);
    console.log('      STOPS resolving   : ' + lost + (lostEx.length ? '   ' + lostEx.join('; ') : ''));
    console.log('      starts resolving  : ' + gained);
    console.log('      resolves neither  : ' + neither);
    console.log('');
    await new Promise(z => setTimeout(z, 4000));
  }
})().catch(e => { console.error('ERROR: ' + (e.message || e)); process.exit(1); });
