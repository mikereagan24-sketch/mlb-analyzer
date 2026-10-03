#!/usr/bin/env node
'use strict';
/**
 * #504 (which statsapi games count as completed) and #495 (/upload/pit-proj-ip
 * shadowed by the /upload/:key? catch-all), 2026-10-03. Throwaway database;
 * no network.
 *
 *   a. Final, Game Over and Completed Early are scored; Postponed, Cancelled
 *      and Suspended are never scored, even with abstractGameState "Final" --
 *      through the helper and through the real score parser.
 *   b. the score fetch, the game_log repair (and so the #508 catch-up, which
 *      reuses its compareDate) and the roof correction use the one helper,
 *      and no other copy of the rule is left.
 *   c. POST /upload/pit-proj-ip takes the admin token, rejects a missing or
 *      wrong one, and is no longer captured by the catch-all; the catch-all
 *      and every other upload route answer exactly as before.
 *
 *   node scripts/test-score-status-upload-route.js
 *   node scripts/test-score-status-upload-route.js --probe-only <out.json>   (route probes only; for a main-vs-branch run)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const Module = require('module');
const R = process.env.ROUTE_PROBE_ROOT ? path.resolve(process.env.ROUTE_PROBE_ROOT) : path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), '__score_status_upload_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                                // NEVER data/mlb.db: set before db/schema can load
const ADMIN = 'admin-' + crypto.randomBytes(12).toString('hex');
const HMAC = 'hmac-' + crypto.randomBytes(24).toString('hex');
process.env.DB_DOWNLOAD_TOKEN = ADMIN;
process.env.BOOKMARKLET_HMAC_KEY = HMAC;
const PROBE_ONLY = process.argv[2] === '--probe-only';
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}
const deny = async (u) => { throw new Error('test: network is forbidden: ' + u); };
const nfPath = require.resolve('node-fetch', { paths: [R] });
const fm = new Module(nfPath); fm.filename = nfPath; fm.loaded = true; fm.exports = deny; deny.default = deny;
require.cache[nfPath] = fm;
globalThis.fetch = deny;

const st = (abstract, detailed, coded) => ({ abstractGameState: abstract, detailedState: detailed, codedGameState: coded });
// every (abstract, detailed, coded) seen in 2026 so far, plus statsapi's documented Game Over / Suspended
const CASES = [
  [st('Final', 'Final', 'F'), 3, 1, true, 'Final'],
  [st('Final', 'Completed Early', 'F'), 8, 0, true, 'Completed Early'],
  [st('Final', 'Completed Early: Rain', 'F'), 6, 2, true, 'Completed Early: Rain'],
  [st('Final', 'Game Over', 'O'), 4, 5, true, 'Game Over'],
  [st('Final', 'Final: Tied', 'F'), 2, 2, true, 'Final: Tied'],
  [st('Final', 'Postponed', 'D'), null, null, false, 'Postponed (abstract Final, no score)'],
  [st('Final', 'Postponed', 'D'), 0, 0, false, 'Postponed carrying a 0-0'],
  [st('Final', 'Cancelled', 'C'), null, null, false, 'Cancelled (abstract Final)'],
  [st('Final', 'Suspended: Rain', 'T'), 3, 3, false, 'Suspended with a partial score (abstract Final)'],
  [st('Live', 'Suspended: Rain', 'U'), 1, 0, false, 'Suspended (Live)'],
  [st('Live', 'In Progress', 'I'), 2, 1, false, 'In Progress'],
  [st('Preview', 'Pre-Game', 'P'), 0, 0, false, 'Pre-Game (postseason shows 0-0)'],
  [st('Preview', 'Scheduled', 'S'), null, null, false, 'Scheduled'],
  [st('Final', 'Final', 'F'), 3, null, false, 'Final with a missing score'],
  [{ abstractGameState: 'Final', detailedState: 'Completed Early: Rain' }, 6, 2, true, 'Completed Early with no coded state (repair fixtures)'],
];

function multipart(name, filename, body) {
  const b = '----x' + crypto.randomBytes(6).toString('hex');
  return { type: 'multipart/form-data; boundary=' + b,
    body: '--' + b + '\r\nContent-Disposition: form-data; name="' + name + '"; filename="' + filename + '"\r\nContent-Type: text/csv\r\n\r\n' + body + '\r\n--' + b + '--\r\n' };
}

(async () => {
  const { db, q } = require(path.join(R, 'db/schema'));

  if (!PROBE_ONLY) {
    // ---------------------------------------------------------------- a
    console.log('a. completed games are scored; postponed / cancelled / suspended never are');
    const ids = require(path.join(R, 'utils/statsapi-ids'));
    for (const [s, a, h, want, label] of CASES) {
      ok((want ? 'scored:     ' : 'not scored: ') + label, ids.isScoredFinal(s, a, h) === want);
    }
    const { parseScoresJson } = require(path.join(R, 'services/scraper'));
    const team = (n) => ({ team: { name: n } });
    const names = [['New York Yankees', 'Boston Red Sox'], ['Philadelphia Phillies', 'Baltimore Orioles'], ['Seattle Mariners', 'Texas Rangers'],
      ['Toronto Blue Jays', 'Baltimore Orioles'], ['Baltimore Orioles', 'New York Yankees'], ['San Francisco Giants', 'Atlanta Braves'],
      ['Chicago Cubs', 'Milwaukee Brewers']];
    const games = [
      [st('Final', 'Final', 'F'), 3, 1], [st('Final', 'Completed Early', 'F'), 8, 0], [st('Final', 'Game Over', 'O'), 4, 5],
      [st('Final', 'Postponed', 'D'), null, null], [st('Final', 'Cancelled', 'C'), null, null], [st('Final', 'Suspended: Rain', 'T'), 3, 3],
      [st('Preview', 'Pre-Game', 'P'), 0, 0],
    ].map(([s, a, h], i) => ({ gamePk: 9000 + i, gameNumber: 1, status: s, teams: { away: Object.assign(team(names[i][0]), { score: a }), home: Object.assign(team(names[i][1]), { score: h }) } }));
    games.push({ gamePk: 9100, gameNumber: 1, status: st('Final', 'Final', 'F'), teams: { away: Object.assign(team('American League All-Stars'), { score: 4 }), home: Object.assign(team('National League All-Stars'), { score: 0 }) } });
    const parsed = parseScoresJson({ dates: [{ games }] }).map(x => x.gameId).sort().join(',');
    ok('the score fetch keeps Final, Completed Early and Game Over -- and nothing else', parsed === 'nyy-bos,phi-bal,sea-tex', parsed);
    ok('the All-Star game stays out (its team names do not map), as before', parsed.split(',').length === 3 && !parsed.split(',').some(id => /all-stars|^al-nl$/.test(id)));

    // ---------------------------------------------------------------- b
    console.log('\nb. one rule, shared');
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // scraper.js and roof-correct.js hold URLs ('https://...') that the comment stripper would cut short, so their checks read the raw source.
    const scr = read('services/scraper.js'), rep = strip(read('services/game-log-repair.js')), roof = read('services/roof-correct.js'), cu = strip(read('services/score-catchup.js'));
    ok('the score fetch uses isScoredFinal from utils/statsapi-ids', /require\('\.\.\/utils\/statsapi-ids'\)/.test(scr) && /isScoredFinal\(g\.status, g\.teams\?\.away\?\.score, g\.teams\?\.home\?\.score\)/.test(scr));
    ok('the game_log repair decides "final" with the same helper', /final: isScoredFinal\(g\.status, g\.teams\.away\.score, g\.teams\.home\.score\)/.test(rep));
    ok('...and still requires only utils/statsapi-ids (its purity guard holds)', JSON.stringify([...rep.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(m => m[1])) === '["../utils/statsapi-ids"]');
    ok('the #508 catch-up has no rule of its own: it reuses the repair\'s compareDate', /require\('\.\/game-log-repair'\)/.test(cu) && !/detailedState|abstractGameState|codedGameState/.test(cu));
    ok('the roof correction uses the same helper (its exact-string set is gone)', /isCompletedStatus\(gd\.status\)/.test(roof) && !/COMPLETED_STATES/.test(roof));
    const services = fs.readdirSync(path.join(R, 'services')).filter(f => f.endsWith('.js'));
    const code = (s) => s.replace(/^\s*\/\/.*$/gm, '');          // whole-line comments only (URLs stay intact)
    const copies = services.filter(f => /detailedState\s*!==\s*'Final'|COMPLETED_STATES/.test(code(read('services/' + f))));
    ok('the roof correction module loads (it no longer exports the removed set)', (() => { try { require(path.join(R, 'services/roof-correct')); return true; } catch (e) { return false; } })());
    ok('no other copy of the completed-game rule is left in services/', copies.length === 0, copies.join(', '));
    // behaviour, through the repair's compareDate: a Completed Early game is a missing score; a postponed one is not
    const repair = require(path.join(R, 'services/game-log-repair'));
    const D = '2026-08-02';
    for (const [id, a, h] of [['phi-bal', 'PHI', 'BAL'], ['tor-nyy', 'TOR', 'NYY']]) {
      db.prepare('INSERT INTO game_log (game_date, game_id, away_team, home_team, game_number, is_removed) VALUES (?,?,?,?,1,0)').run(D, id, a, h);
    }
    const sched = { dates: [{ date: D, games: [
      { gamePk: 824807, gameType: 'R', officialDate: D, gameDate: D + 'T23:05:00Z', gameNumber: 1, status: st('Final', 'Completed Early', 'F'),
        teams: { away: { team: { abbreviation: 'PHI' }, score: 8 }, home: { team: { abbreviation: 'BAL' }, score: 0 } } },
      { gamePk: 824999, gameType: 'R', officialDate: D, gameDate: D + 'T23:05:00Z', gameNumber: 1, status: st('Final', 'Suspended: Rain', 'T'),
        teams: { away: { team: { abbreviation: 'TOR' }, score: 2 }, home: { team: { abbreviation: 'NYY' }, score: 2 } } }] }] };
    const f = await repair.compareDate(db, D, { fetchJson: async (u) => (/gamePk=/.test(u) ? { dates: [] } : sched) }, { requests: 0 });
    const ms = f.items.filter(i => i.cat === 'missing_score').map(i => i.game_id).join(',');
    ok('repair / catch-up: Completed Early is a missing score to fill; a suspended game with a partial score is not', ms === 'phi-bal', ms);
  }

  // ---------------------------------------------------------------- c
  console.log('\nc. the upload routes, over HTTP');
  q.setSetting.run('bookmarklet_active_kid', '1');
  const pl = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, kid: 1, purpose: 'fg-upload' })).toString('base64url');
  const BM = pl + '.' + crypto.createHmac('sha256', HMAC).update(pl).digest('base64url');
  const express = require(path.join(R, 'node_modules/express'));
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(path.join(R, 'routes/top-traders-upload')));
  app.use('/api', require(path.join(R, 'routes/api')));
  const srv = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = srv.address().port;
  const origin = 'http://127.0.0.1:' + port;
  const post = (p, body, headers) => new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (r) => {
      let s = ''; r.on('data', c => s += c); r.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} res({ status: r.statusCode, json: j }); });
    });
    req.on('error', rej); req.end(body || '');
  });
  const ipCsv = multipart('file', 'steamer-ip.csv', 'Name,Team,IP,GS\nTest Pitcher,TBR,150,28\nOther Arm,NYY,60,0\n');
  const wobaCsv = multipart('file', 'pit-act-lhb.csv', 'Name,Team,TBF,wOBA\nTest Pitcher,TB,120,0.300\n');
  const probes = {};
  const probe = async (name, p, body, headers) => { const r = await post(p, body, headers); probes[name] = r.status; return r; };
  try {
    const a1 = await probe('pit-proj-ip admin token', '/api/upload/pit-proj-ip', ipCsv.body, { 'Content-Type': ipCsv.type, 'X-Admin-Token': ADMIN, Origin: origin });
    await probe('pit-proj-ip no token', '/api/upload/pit-proj-ip', ipCsv.body, { 'Content-Type': ipCsv.type, Origin: origin });
    await probe('pit-proj-ip wrong token', '/api/upload/pit-proj-ip', ipCsv.body, { 'Content-Type': ipCsv.type, 'X-Admin-Token': 'nope', Origin: origin });
    await probe('pit-proj-ip bookmarklet token only', '/api/upload/pit-proj-ip', ipCsv.body, { 'Content-Type': ipCsv.type, 'X-Bookmarklet-Token': BM, Origin: origin });
    await probe('catch-all pit-act-lhb bookmarklet token', '/api/upload/pit-act-lhb', wobaCsv.body, { 'Content-Type': wobaCsv.type, 'X-Bookmarklet-Token': BM, Origin: origin });
    await probe('catch-all pit-act-lhb no token', '/api/upload/pit-act-lhb', wobaCsv.body, { 'Content-Type': wobaCsv.type, Origin: origin });
    await probe('catch-all pit-act-lhb admin token only', '/api/upload/pit-act-lhb', wobaCsv.body, { 'Content-Type': wobaCsv.type, 'X-Admin-Token': ADMIN, Origin: origin });
    const bare = multipart('file', 'pitchers_actual_lhb.csv', 'Name,Team,TBF,wOBA\nX Y,TB,120,0.300\n');
    await probe('catch-all bare /upload, filename-detected key', '/api/upload', bare.body, { 'Content-Type': bare.type, 'X-Bookmarklet-Token': BM, Origin: origin });
    await probe('catch-all foreign origin', '/api/upload/pit-act-lhb', wobaCsv.body, { 'Content-Type': wobaCsv.type, 'X-Bookmarklet-Token': BM, Origin: 'https://evil.example' });
    await probe('fg-json no token', '/api/upload/fg-json/pit-act-lhb', JSON.stringify({ rows: [] }), { 'Content-Type': 'application/json', Origin: origin });
    await probe('fg-json bookmarklet token, empty rows', '/api/upload/fg-json/pit-act-lhb', JSON.stringify({ rows: [] }), { 'Content-Type': 'application/json', 'X-Bookmarklet-Token': BM, Origin: origin });
    await probe('rr-roles no token', '/api/upload/rr-roles', JSON.stringify({}), { 'Content-Type': 'application/json', Origin: origin });
    await probe('rr-roles bookmarklet token, empty body', '/api/upload/rr-roles', JSON.stringify({}), { 'Content-Type': 'application/json', 'X-Bookmarklet-Token': BM, Origin: origin });
    await probe('top-trader-seed no token', '/api/upload/top-trader-seed', JSON.stringify({}), { 'Content-Type': 'application/json' });
    await probe('top-trader-seed wrong token', '/api/upload/top-trader-seed', JSON.stringify({}), { 'Content-Type': 'application/json', 'X-Admin-Token': 'nope' });
    if (PROBE_ONLY) {
      fs.writeFileSync(process.argv[3], JSON.stringify(probes, null, 1));
      console.log('probes written: ' + Object.keys(probes).length);
    } else {
      const ipRows = db.prepare('SELECT player_name, team, ip_per_start FROM pit_proj_ip ORDER BY player_name').all();
      ok('pit-proj-ip with the admin token: 200, rows written to pit_proj_ip', probes['pit-proj-ip admin token'] === 200 && a1.json && a1.json.rows_parsed === 2 && ipRows.length === 2,
        probes['pit-proj-ip admin token'] + ' ' + JSON.stringify(a1.json) + ' ' + JSON.stringify(ipRows));
      ok('pit-proj-ip with no token, or a wrong one: 401', probes['pit-proj-ip no token'] === 401 && probes['pit-proj-ip wrong token'] === 401,
        probes['pit-proj-ip no token'] + '/' + probes['pit-proj-ip wrong token']);
      ok('pit-proj-ip with only a bookmarklet token: 401 -- the catch-all no longer captures it', probes['pit-proj-ip bookmarklet token only'] === 401, String(probes['pit-proj-ip bookmarklet token only']));
      ok('nothing ever lands in woba_data under the key pit-proj-ip', db.prepare("SELECT COUNT(*) n FROM woba_data WHERE data_key = 'pit-proj-ip'").get().n === 0);
      ok('the catch-all still ingests its own keys with a bookmarklet token (200), and still refuses no token / admin-only / a foreign origin',
        probes['catch-all pit-act-lhb bookmarklet token'] === 200 && probes['catch-all pit-act-lhb no token'] === 401
        && probes['catch-all pit-act-lhb admin token only'] === 401 && probes['catch-all foreign origin'] === 403, JSON.stringify(probes));
      // every other route: what main answers (recorded by running this file's probes on 4508401: see the PR)
      const MAIN = { 'fg-json no token': 401, 'fg-json bookmarklet token, empty rows': 400, 'rr-roles no token': 401, 'rr-roles bookmarklet token, empty body': 400,
        'top-trader-seed no token': 401, 'top-trader-seed wrong token': 401 };
      const diff = Object.entries(MAIN).filter(([k, v]) => probes[k] !== v);
      ok('fg-json, rr-roles and top-trader-seed answer exactly as on main', diff.length === 0, JSON.stringify(Object.fromEntries(Object.keys(MAIN).map(k => [k, probes[k]]))));
    }
  } finally { await new Promise(res => srv.close(res)); }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all passed'));
  try { db.close(); } catch (e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
