#!/usr/bin/env node
'use strict';
/**
 * #473 (2026-10-02): wOBA rows identified by MLBAM id, then FanGraphs id, and
 * only then by normalized name. Throwaway database; no network.
 *
 *   a. the same MLBAM id under an accented and an unaccented name counts once
 *      in the bullpen pool.
 *   b. different ids under one name (the Luis Garcia case) stay separate: both
 *      stored, both reachable by id, the pool admits only the rostered one and
 *      reads ITS actuals, not the namesake's.
 *   c. no ids: the name fallback merges only a true formatting copy (same
 *      normalized name AND the same numbers -- "Julio  Marte" / "Julio Marte");
 *      the same name with a different stat line stays two pitchers.
 *   d. upload keeps both ids, through the real routes (bookmarklet JSON for
 *      projections, CSV for actuals); rows without ids still load and price.
 *   e. the proof on fixtures: on rows without ids the index and the pool equal
 *      the old name-keyed rule exactly, except the formatting-copy collapse.
 *      (The main-vs-branch run on real data is scripts/replay-player-identity.js.)
 *
 *   node scripts/test-player-identity.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const Module = require('module');
const R = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), '__player_identity_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                                // NEVER data/mlb.db: set before db/schema can load
const HMAC = 'test-hmac-' + crypto.randomBytes(24).toString('hex');
process.env.BOOKMARKLET_HMAC_KEY = HMAC;

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}
const deny = async (u) => { throw new Error('test: network is forbidden: ' + u); };
const nfPath = require.resolve('node-fetch', { paths: [R] });
const fm = new Module(nfPath); fm.filename = nfPath; fm.loaded = true; fm.exports = deny; deny.default = deny;
require.cache[nfPath] = fm;

const { db, q } = require(path.join(R, 'db/schema'));
const { buildWobaIndex } = require(path.join(R, 'services/model'));
const pid = require(path.join(R, 'utils/player-identity'));
const { normName } = require(path.join(R, 'utils/names'));

const clear = () => { db.prepare('DELETE FROM woba_data').run(); db.prepare('DELETE FROM team_rosters').run(); };
const addWoba = (key, name, woba, sample, mlbam, fg) => db.prepare(
  'INSERT INTO woba_data (data_key, player_name, woba, sample_size, mlbam_id, fg_player_id) VALUES (?,?,?,?,?,?)').run(key, name, woba, sample, mlbam || null, fg || null);
const addRP = (team, name, mlbId) => db.prepare("INSERT INTO team_rosters (team, player_name, role, mlb_id) VALUES (?,?,'RP',?)").run(team, name, mlbId || null);
const pool = (team, hand) => q.getBullpenWoba(team, '', hand || 'lhb', null, null, '2026-09-30', null, null, false, null, null, 1, null);
const inPool = (r) => (r.members || []).filter(m => m.in_pool).map(m => m.name + ':' + Number(m.woba).toFixed(3)).sort();
// six ordinary rostered arms so every pool below takes the same 8-slot path
function baseTeam(team, start) {
  for (let i = 0; i < 6; i++) { const n = 'Arm' + 'abcdef'[i] + ' Pitcher'; addWoba('pit-proj-lhb', n + ' ' + team, 0.30 + i * 0.001, 2.0, start + i); addRP(team, n, start + i); }
}

(async () => {
  // ---------------------------------------------------------------- a
  console.log('a. one MLBAM id, two spellings: counted once');
  {
    clear(); baseTeam('SEA', 1000);
    addRP('SEA', 'José Cruz', 678804);
    addWoba('pit-proj-lhb', 'José Cruz SEA', 0.320, 2.1, 678804, 'sa1');
    addWoba('pit-proj-lhb', 'Jose Cruz SEA', 0.325, 2.0, 678804, 'sa1');      // same player, a second spelling
    const r = pool('SEA');
    const cruz = inPool(r).filter(n => n.startsWith('jose cruz'));
    ok('pool: 7 pitchers, Jose Cruz once (whichever spelling the table returns first)', r.pitchers === 7 && cruz.length === 1
      && ['jose cruz:0.320', 'jose cruz:0.325'].includes(cruz[0]), JSON.stringify(inPool(r)));
    const idx = buildWobaIndex(db.prepare("SELECT data_key, player_name, woba, sample_size, fg_player_id, mlbam_id FROM woba_data").all());
    ok('index: one id slot for both spellings', Object.keys(idx['pit-proj-lhb']._byId).filter(k => k === 'm678804').length === 1
      && idx['pit-proj-lhb']._byId.m678804.woba === 0.320);
    ok('index: the id slots are not enumerable (name-key scans and counts unchanged)', !Object.keys(idx['pit-proj-lhb']).some(k => k.startsWith('#') || k === '_byId'));
  }

  // ---------------------------------------------------------------- b
  console.log('\nb. two players, one name: never merged');
  {
    clear(); baseTeam('NYY', 2000);
    addRP('NYY', 'Luis Garcia', 677651);                                       // the rostered one
    // the upload path: two different ids under one stored name
    const info = q.upsertWobaBatch('pit-proj-lhb', [
      { name: 'Luis Garcia NYY', team: 'NYY', woba: 0.302, sample: 2.9, mlbam_id: 472610, fg_player_id: '3943' },
      { name: 'Luis Garcia NYY', team: 'NYY', woba: 0.330, sample: 2.1, mlbam_id: 677651, fg_player_id: 'sa828' },
    ].concat([0, 1, 2, 3, 4, 5].map(i => ({ name: 'Arm' + 'abcdef'[i] + ' Pitcher NYY', team: 'NYY', woba: 0.30 + i * 0.001, sample: 2.0, mlbam_id: 2000 + i }))));
    const stored = db.prepare("SELECT player_name, woba, mlbam_id FROM woba_data WHERE player_name LIKE 'Luis Garcia%' ORDER BY player_name").all();
    ok('both stored: the larger sample under the plain name, the other as "Luis Garcia #m677651 NYY"',
      stored.length === 2 && stored.some(s => s.player_name === 'Luis Garcia NYY' && s.mlbam_id === 472610)
      && stored.some(s => s.player_name === 'Luis Garcia #m677651 NYY' && s.mlbam_id === 677651), JSON.stringify(stored));
    ok('the batch reports the separation, not a collision', (info.separated || []).length === 1 && !(info.collisions || []).includes('Luis Garcia NYY'));
    // actuals: two different pitchers, same name, same team tag
    addWoba('pit-act-lhb', 'Luis Garcia NYY', 0.302, 147, 472610);
    addWoba('pit-act-lhb', 'Luis García NYY', 0.103, 120, 677651);
    const r = pool('NYY');
    const lg = (r.members || []).filter(m => m.in_pool && m.name.startsWith('luis garcia'));
    ok('pool admits only the rostered Luis Garcia (677651), not the namesake (472610)', lg.length === 1 && Math.abs(lg[0].proj_woba - 0.330) < 1e-9,
      JSON.stringify(lg.map(m => [m.name, m.proj_woba, m.act_woba])));
    ok('...and reads HIS actuals by id (.103, 120 BF), not the namesake\'s (.302, 147 BF)', lg.length === 1 && lg[0].act_woba === 0.103 && lg[0].act_sample === 120);
    const idx = buildWobaIndex(db.prepare("SELECT data_key, player_name, woba, sample_size, fg_player_id, mlbam_id FROM woba_data").all());
    ok('index: both players by id; the shared name slot holds the larger sample (147 BF), the other is never merged into it',
      idx['pit-act-lhb']._byId.m472610.woba === 0.302 && idx['pit-act-lhb']._byId.m677651.woba === 0.103 && idx['pit-act-lhb']['luis garcia nyy'].woba === 0.302);
    ok('samePlayer: different ids are different players even with identical names',
      !pid.samePlayer({ mlbam_id: 1, woba: 0.3 }, 'Luis Garcia', { mlbam_id: 2, woba: 0.3 }, 'Luis Garcia'));
  }

  // ---------------------------------------------------------------- c
  console.log('\nc. no ids: the name fallback merges only true formatting copies');
  {
    clear(); baseTeam('HOU', 3000); baseTeam('TB', 4000);
    addRP('HOU', 'Julio Marte'); addRP('TB', 'Manuel Rodríguez');
    // one FanGraphs row stored twice (double space and collapsed): identical numbers
    addWoba('pit-proj-lhb', 'Julio  Marte HOU', 0.3789460592766311, 2.3367536067962646);
    addWoba('pit-proj-lhb', 'Julio Marte HOU', 0.3789460592766311, 2.3367536067962646);
    // two FanGraphs rows: accent vs no accent, different numbers
    addWoba('pit-proj-lhb', 'Manuel Rodríguez TB', 0.314, 1.744);
    addWoba('pit-proj-lhb', 'Manuel Rodriguez TB', 0.3545, 2.227);
    const h = pool('HOU'), t = pool('TB');
    ok('HOU: Julio Marte counted once (7 in pool, was 8)', h.pitchers === 7 && inPool(h).filter(n => n.startsWith('julio marte')).length === 1, JSON.stringify(inPool(h)));
    ok('TB: the two Manuel Rodriguez stat lines stay two pitchers (8 in pool), as before', t.pitchers === 8
      && (t.members || []).filter(m => m.name === 'manuel rodriguez').length === 2, String(t.pitchers));
    ok('identityKey: same normalized name + same numbers -> same; same name + different numbers -> different',
      pid.identityKey({ woba: 0.3, sample_size: 2 }, 'Julio  Marte') === pid.identityKey({ woba: 0.3, sample_size: 2 }, 'Julio Marte')
      && pid.identityKey({ woba: 0.314, sample_size: 1.7 }, 'Manuel Rodríguez') !== pid.identityKey({ woba: 0.3545, sample_size: 2.2 }, 'Manuel Rodriguez'));
  }

  // ---------------------------------------------------------------- d
  console.log('\nd. upload keeps both ids; rows without ids still work');
  {
    clear();
    q.setSetting.run('bookmarklet_active_kid', '1');
    const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, kid: 1, purpose: 'fg-upload' })).toString('base64url');
    const token = payload + '.' + crypto.createHmac('sha256', HMAC).update(payload).digest('base64url');
    const express = require(path.join(R, 'node_modules/express'));
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api', require(path.join(R, 'routes/api')));
    const srv = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const port = srv.address().port;
    const post = (p, body, headers) => new Promise((res, rej) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: Object.assign({ 'X-Bookmarklet-Token': token, Origin: 'http://127.0.0.1:' + port }, headers) }, (r) => {
        let s = ''; r.on('data', c => s += c); r.on('end', () => res({ status: r.statusCode, body: s }));
      });
      req.on('error', rej); req.end(body);
    });
    try {
      // bookmarklet JSON, projections: FanGraphs' own field names (PlayerName / playerid / xMLBAMID)
      const proj = [
        { PlayerName: 'Manuel Rodríguez', Team: 'TB', wOBA: 0.314, TBF: 1.744, playerid: '20107', xMLBAMID: 655889 },
        { PlayerName: 'Cam Booser', Team: 'TB', wOBA: 0.2646, TBF: 2.2, playerid: '19935', xMLBAMID: 670174 },
        { PlayerName: 'No Id Guy', Team: 'TB', wOBA: 0.33, TBF: 2.0 },
      ];
      const r1 = await post('/api/upload/fg-json/pit-proj-lhb', JSON.stringify({ rows: proj }), { 'Content-Type': 'application/json' });
      const rows1 = db.prepare("SELECT player_name, fg_player_id, mlbam_id FROM woba_data WHERE data_key = 'pit-proj-lhb' ORDER BY player_name").all();
      ok('bookmarklet projections: both ids stored on the row', r1.status === 200
        && rows1.some(x => x.player_name === 'Manuel Rodríguez TB' && x.fg_player_id === '20107' && x.mlbam_id === 655889)
        && rows1.some(x => x.player_name === 'Cam Booser TB' && x.mlbam_id === 670174), r1.status + ' ' + JSON.stringify(rows1));
      ok('a row the source sent without ids is stored with null ids', rows1.some(x => x.player_name === 'No Id Guy TB' && x.fg_player_id == null && x.mlbam_id == null));
      // CSV, actuals: the splits API's spellings (playerId / xMLBAMID / TeamNameAbb)
      const csv = 'playerName,TeamNameAbb,TBF,wOBA,playerId,xMLBAMID\n"Manuel Rodríguez",TB,26,0.290,20107,655889\n"Old Style",TB,90,0.310,,\n';
      const boundary = '----x' + crypto.randomBytes(6).toString('hex');
      const body = '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="pit-act-lhb.csv"\r\nContent-Type: text/csv\r\n\r\n' + csv + '\r\n--' + boundary + '--\r\n';
      const r2 = await post('/api/upload/pit-act-lhb', body, { 'Content-Type': 'multipart/form-data; boundary=' + boundary });
      const rows2 = db.prepare("SELECT player_name, fg_player_id, mlbam_id FROM woba_data WHERE data_key = 'pit-act-lhb' ORDER BY player_name").all();
      ok('CSV actuals: both ids stored', r2.status === 200 && rows2.some(x => x.player_name === 'Manuel Rodríguez' && x.fg_player_id === '20107' && x.mlbam_id === 655889),
        r2.status + ' ' + r2.body.slice(0, 160) + ' ' + JSON.stringify(rows2));
      const snap = db.prepare("SELECT COUNT(*) n FROM woba_data_snapshot WHERE data_key = 'pit-proj-lhb' AND mlbam_id = 655889").get().n;
      ok('the daily snapshot keeps the ids too', snap === 1, String(snap));
      // an old row (no ids) next to new ones: still loads, still priced
      addRP('TB', 'Manuel Rodríguez', 655889); addRP('TB', 'Cam Booser', 670174); addRP('TB', 'No Id Guy');
      const t = pool('TB');
      ok('the pool mixes id rows and id-less rows: Rodríguez by id with his own actuals, Booser by id, No Id Guy by name',
        t.pitchers === 3 && (t.members || []).some(m => m.name === 'manuel rodriguez' && m.act_sample === 26) && (t.members || []).some(m => m.name === 'no id guy'),
        JSON.stringify((t.members || []).map(m => [m.name, m.act_sample])));
      const jobs = require(path.join(R, 'services/jobs'));
      const idx = jobs.getWobaIndex();
      ok('getWobaIndex (live index) loads both kinds: name slots for all, id slots for id rows',
        idx['pit-proj-lhb']['no id guy tb'] && idx['pit-proj-lhb']['manuel rodriguez tb'] && idx['pit-proj-lhb']._byId.m655889 && !idx['pit-proj-lhb']._byId.mnull);
    } finally { await new Promise(res => srv.close(res)); }
  }

  // ---------------------------------------------------------------- e
  console.log('\ne. without ids, the index and the pool equal the old name rule');
  {
    // the old rule, verbatim from services/model.js at 597cc98
    const oldBuild = (rows) => { const idx = {}; for (const r of rows) { if (!idx[r.data_key]) idx[r.data_key] = {}; idx[r.data_key][normName(r.player_name)] = { woba: r.woba, sample: r.sample_size }; } return idx; };
    const rows = [];
    const names = ['Julio  Marte HOU', 'Julio Marte HOU', 'Manuel Rodríguez TB', 'Manuel Rodriguez TB', 'Raúl Alcantara', 'Raúl Alcántara', 'Bobby Witt Jr. KC', 'Bobby Witt KC', 'Luis Garcia NYY', 'Luis García NYY'];
    names.forEach((n, i) => rows.push({ data_key: 'pit-proj-lhb', player_name: n, woba: 0.3 + i / 1000, sample_size: 2 + i }));
    rows.push({ data_key: 'pit-act-rhb', player_name: 'Luis Garcia NYY', woba: 0.27, sample_size: 21 });
    rows.push({ data_key: 'pit-act-rhb', player_name: 'Luis García NYY', woba: 0.38, sample_size: 166 });
    ok('buildWobaIndex on id-less rows is byte-identical to the old builder', JSON.stringify(buildWobaIndex(rows)) === JSON.stringify(oldBuild(rows)));
    // the pool: the only id-less change is the formatting-copy collapse (c above); everything else is the old count
    clear(); baseTeam('CIN', 5000); addRP('CIN', 'Luis Avila');
    addWoba('pit-proj-lhb', 'Luis  Avila CIN', 0.412, 2.18); addWoba('pit-proj-lhb', 'Luis Avila CIN', 0.412, 2.18);
    const c1 = pool('CIN');
    db.prepare("DELETE FROM woba_data WHERE player_name = 'Luis  Avila CIN'").run();
    const c2 = pool('CIN');
    ok('a pool with a formatting copy now equals the same pool with the copy deleted (the old rule counted it twice)',
      c1.woba === c2.woba && c1.pitchers === c2.pitchers && c1.pitchers === 7, JSON.stringify([c1.woba, c1.pitchers, c2.woba, c2.pitchers]));
  }

  // ---------------------------------------------------------------- f
  console.log('\nf. lookups find the renamed twin ("Name #m<id> TEAM") by id');
  {
    const { getPitcherWoba } = require(path.join(R, 'services/model'));
    const rows = [];
    for (const k of ['pit-proj-lhb', 'pit-proj-rhb']) {
      rows.push({ data_key: k, player_name: 'Luis Garcia NYY', woba: 0.302, sample_size: 2.9, mlbam_id: 472610 });
      rows.push({ data_key: k, player_name: 'Luis Garcia #m677651 NYY', woba: 0.330, sample_size: 2.1, mlbam_id: 677651 });
    }
    const idx = buildWobaIndex(rows);
    const S = { PIT_DFLT_R_VS_LHB: 0.399, PIT_DFLT_R_VS_RHB: 0.399, PIT_DFLT_L_VS_LHB: 0.399, PIT_DFLT_L_VS_RHB: 0.399 };
    const pw = (id) => getPitcherWoba(idx, 'Luis Garcia', 'R', 'NYY', 1, 0, 100, S, id);
    ok('starter = the renamed twin (sp id 677651): his own row (.330), not his namesake\'s', pw(677651).vsLHB === 0.33 && pw(677651).vsRHB === 0.33, JSON.stringify(pw(677651)));
    ok('starter = the plain-name pitcher (sp id 472610): his row (.302)', pw(472610).vsLHB === 0.302);
    ok('no sp id: the name slot, exactly as before (.302)', pw(null).vsLHB === 0.302 && pw(undefined).vsRHB === 0.302);
    ok('an sp id with no row of its own never borrows a namesake that carries a DIFFERENT id (falls to the default)',
      pw(999999).vsLHB === 0.399 && pw(999999).source === 'fallback', JSON.stringify(pw(999999)));
    const oldIdx = buildWobaIndex(rows.map(r => Object.assign({}, r, { mlbam_id: null })).filter(r => !/#m/.test(r.player_name)));
    ok('old rows without ids: an sp id changes nothing (the name lookup, as before)',
      getPitcherWoba(oldIdx, 'Luis Garcia', 'R', 'NYY', 1, 0, 100, S, 677651).vsLHB === 0.302);
    // the pricing callers pass the ids game_log carries
    const msrc = fs.readFileSync(path.join(R, 'services/model.js'), 'utf8'), asrc = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
    ok('runModel passes away_sp_id / home_sp_id and the bulk guy\'s id; the model-trace route mirrors it',
      /getPitcherWoba\(wobaIdx, game\.away_sp, [^)]*settings, game\.away_sp_id\)/.test(msrc) && /getPitcherWoba\(wobaIdx, game\.home_sp, [^)]*settings, game\.home_sp_id\)/.test(msrc)
      && /game\.bulk_guy_away_id : game\.bulk_guy_home_id/.test(msrc)
      && /getPitcherWoba\(wobaIdx, game\.away_sp, [^)]*settings, game\.away_sp_id\)/.test(asrc));
    // the debug bullpen route: the twin shows under his plain name with his own actuals
    clear();
    addWoba('pit-proj-lhb', 'Luis Garcia NYY', 0.302, 2.9, 472610);
    addWoba('pit-proj-lhb', 'Luis Garcia #m677651 NYY', 0.330, 2.1, 677651);
    addWoba('pit-act-lhb', 'Luis Garcia NYY', 0.290, 147, 472610);
    addWoba('pit-act-lhb', 'Luis García NYY', 0.103, 120, 677651);
    const express = require(path.join(R, 'node_modules/express'));
    const app = express(); app.use('/api', require(path.join(R, 'routes/api')));
    const srv = await new Promise(res => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    try {
      const body = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: srv.address().port, path: '/api/debug/bullpen?team=NYY&hand=lhb' }, (r) => {
        let t = ''; r.on('data', c => t += c); r.on('end', () => { try { res(JSON.parse(t)); } catch (e) { rej(new Error(t.slice(0, 200))); } });
      }).on('error', rej));
      const list = JSON.stringify(body);
      ok('/debug/bullpen: no "#m" marker shown, and each Luis Garcia carries his OWN actuals (.290 / .103)',
        !/#m/.test(list) && /"act_woba":0\.29\b/.test(list) && /"act_woba":0\.103/.test(list), list.slice(0, 300));
    } finally { await new Promise(res => srv.close(res)); }
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all passed'));
  cleanup();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });

function cleanup() {
  try { db.close(); } catch (e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
}
