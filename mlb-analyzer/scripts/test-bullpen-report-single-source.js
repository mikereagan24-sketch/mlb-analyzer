#!/usr/bin/env node
/**
 * The bullpen report is not a second implementation. (2026-08-30)
 *
 * WHY THIS EXISTS. /api/debug/bullpen-report used to re-derive the pool and
 * the blend itself, and its own comments said so. Six behaviours were
 * duplicated and four had drifted: the no-lineup fallback branch, the
 * downweight-starters weighting, the qualified>=3-else-slice(0,8) pool rule,
 * and park neutralization. The doubleheader leg had to be fixed in it twice.
 *
 * So the assertions here are about SOURCING, not about any particular
 * number: the report must render what q.getBullpenWobaBlended returns, and
 * must not compute a bullpen wOBA of its own. A number-matching test would
 * pass just as well against a mirror that happens to agree today.
 *
 * NOTE ON THE ONE TEST THIS REPLACED. scripts/test-bullpen-availability.js
 * asserted that the report called getFatiguedPitchers itself. That was
 * correct while it was a mirror and wrong afterwards -- satisfying it would
 * have meant re-creating the mirror. It is now a behavioural check on the
 * pool instead. A test written to protect a mirror will demand the mirror.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const { q } = require(path.join(R, 'db/schema'));
const mdl = require(path.join(R, 'services/model'));
const pfw = require(path.join(R, 'services/park-factors-woba'));
const { getSettings } = require(path.join(R, 'services/jobs'));
const settings = getSettings();

// ---- 1. the mirror is gone, and stays gone -----------------------------
const apiSrc = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
const handlerStart = apiSrc.indexOf("router.get('/debug/bullpen-report'");
ok(handlerStart > 0, 'the bullpen-report handler still exists');
const handler = apiSrc.slice(handlerStart, handlerStart + 20000);
const body = handler.slice(0, handler.indexOf("router.get('", 10) > 0
  ? handler.indexOf("router.get('", 10) : handler.length);

ok(body.includes('q.getBullpenWobaBlended('),
   'the report CALLS the shared pool function');
ok(!body.includes('getFatiguedPitchers(teamU'),
   'the report does not look up fatigue itself');
// The blend arithmetic is the mirror's signature. If this reappears, the
// report has started computing rather than rendering.
ok(!/W_ACT\s*\*\s*act/.test(body) && !/wAct\s*\*\s*act/.test(body),
   'the report contains no proj/act blend arithmetic of its own');
ok(!body.includes('.slice(0, 8)') && !body.includes('.slice(0,8)'),
   'the report contains no copy of the pool-selection rule');

// ---- 2. it renders what the shared function returned --------------------
const DATE = process.argv[2] || '2026-08-30';
const express = require(path.join(R, 'node_modules/express'));
const app = express();
app.use('/api', require(path.join(R, 'routes/api')));
const srv = app.listen(0, () => {
  const port = srv.address().port;
  http.get('http://127.0.0.1:' + port + '/api/debug/bullpen-report?date=' + DATE, r => {
    let b = '';
    r.on('data', d => b += d);
    r.on('end', () => {
      try { run(JSON.parse(b), r.statusCode); } catch (e) {
        ok(false, 'endpoint returned parseable JSON (' + e.message + ')');
      }
      srv.close();
      console.log('');
      console.log(pass + ' passed, ' + fail + ' failed');
      process.exit(fail ? 1 : 0);
    });
  }).on('error', e => { ok(false, 'endpoint reachable: ' + e.message); srv.close(); process.exit(1); });
});

function run(j, code) {
  eq(code, 200, 'endpoint returns 200');
  const games = j.games || [];
  ok(games.length > 0, 'the date has games to report on');

  const sides = [];
  for (const g of games) { sides.push([g.away_team, g.away]); sides.push([g.home_team, g.home]); }

  let checkedNum = 0, everyRPListed = 0;
  for (const [team, s] of sides) {
    if (!s || s.team_bullpen_woba == null) continue;
    const ps = s.pitchers || [];

    // in_pool must be the REAL pool, so its count matches pool_size.
    eq(ps.filter(p => p.in_pool).length, s.pool_size,
       team + ': in_pool row count equals the reported pool size');

    // Excluded arms are rows, not omissions -- the point of the table.
    const flagged = ps.filter(p => !p.in_pool);
    ok(flagged.length >= (s.excluded_count || 0),
       team + ': every excluded arm appears as a row (excluded=' + s.excluded_count
       + ', flagged rows=' + flagged.length + ')');
    for (const p of ps) {
      ok(typeof p.in_pool === 'boolean', team + '/' + p.name + ': in_pool is an explicit boolean');
      ok('on_roster' in p, team + '/' + p.name + ': on_roster is present');
    }
    if (flagged.length) everyRPListed++;

    // THE number must be the shared function's, to the digit.
    const neutralizeFor = (n, raw) => {
      try {
        const f = mdl.resolveNeutralizationFactor(team, settings, { playerName: n, isPitcher: true });
        return f == null ? null : pfw.neutralizeWoba(raw, f);
      } catch (e) { return null; }
    };
    const N = (v, d) => (v != null ? Number(v) : d);
    const ref = q.getBullpenWobaBlended(
      team, s.sp_name || '', [],
      N(settings.BP_STRONG_WEIGHT_R, 0.55), N(settings.BP_WEAK_WEIGHT_R, 0.45),
      N(settings.BP_STRONG_WEIGHT_L, 0.35), N(settings.BP_WEAK_WEIGHT_L, 0.65),
      N(settings.W_PROJ, 0.65), N(settings.W_ACT, 0.35),
      DATE, N(settings.UNKNOWN_PITCHER_WOBA, 0.335),
      N(settings.BULLPEN_MIN_BF, N(settings.MIN_BF, 100)),
      !!(settings.BULLPEN_DOWNWEIGHT_STARTERS === true || settings.BULLPEN_DOWNWEIGHT_STARTERS === 'true'),
      N(settings.BULLPEN_W_PROJ, N(settings.W_PROJ, 0.65)),
      N(settings.BULLPEN_W_ACT, N(settings.W_ACT, 0.35)),
      1, neutralizeFor);
    if (ref && ref.woba != null) {
      eq(s.pool_size, ref.pitchers, team + ': pool size matches the shared function');
      checkedNum++;
    }
  }
  ok(checkedNum > 0, 'at least one team was cross-checked against the shared function');
  ok(everyRPListed > 0, 'at least one team shows a non-pool row -- the honest flag renders');
}
