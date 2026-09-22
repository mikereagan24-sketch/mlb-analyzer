// The Matchups header shows the two inputs behind each blended rate,
// and changes nothing about pricing.
//
// WHY. A rate on its own cannot be checked. "vsRHB 0.329" is the same
// string whether it came from a blend, from a projection because the
// actual sat below MIN_BF, or from a projection because no actual
// existed. Blade Tidwell was the middle case -- 86 BF vsRHB against a
// gate of 100, so the actual (.212) was dropped and the projection
// (.329) shown, while vsLHB at 111 BF blended and the header reported
// one aggregate source for both. Finding that took a hand trace through
// woba_data.
//
// WHAT THIS PINS:
//   1. the per-split source is recomputed, not read off the aggregate
//      -- the aggregate reads 'blend' whenever the two hands DIFFER,
//      which is exactly the Tidwell shape;
//   2. a REJECTED actual is returned WITH its sample and a named
//      reason, never omitted;
//   3. an ABSENT actual is distinguishable from a rejected one;
//   4. the sample unit is labelled, because the gate is batters faced
//      and the number would otherwise read as PA or innings;
//   5. the inputs RECONSTRUCT the displayed rate -- act*W_ACT +
//      proj*W_PROJ when used, proj alone when rejected. This is what
//      stops the header drifting from what the model priced;
//   6. `source` keeps its old value and meaning, because
//      loadDataQuality tests it against ['default','fallback'];
//   7. NO PRICING FILE CHANGED. Content invariants plus a git diff.
//
// Synthetic date 2999-05-01; every write undone in the finally block.
// Takes `db` from db/schema -- never a second write connection.
//
// Run: node --max-old-space-size=1536 scripts/test-matchup-woba-inputs.js

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const R = path.join(__dirname, '..');
const { db, q } = require(path.join(R, 'db/schema'));

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const D = '2999-05-01';
const GA = 'zzp-zzq';
const GB = 'zzr-zzs';
// Deliberately unlike any real name, and team-tagged on the projection
// side only -- which is how the real rows look (actuals are bare names,
// Steamer rows carry the team).
const BLEND = 'Zzq Blendguy';
const REJECT = 'Zzq Rejectguy';
const NOACT = 'Zzq Noactuals';
const NOPROJ = 'Zzq Noprojection';

function seed() {
  cleanup();
  const g = db.prepare('INSERT INTO game_log (game_date, game_id, away_team, home_team, '
    + 'away_sp, away_sp_hand, home_sp, home_sp_hand, away_lineup_json, home_lineup_json, '
    + 'park_factor) VALUES (?,?,?,?,?,?,?,?,?,?,1.0)');
  g.run(D, GA, 'SEA', 'TOR', BLEND, 'R', REJECT, 'L', '[]', '[]');
  g.run(D, GB, 'ATH', 'LAA', NOACT, 'R', NOPROJ, 'R', '[]', '[]');
  const w = db.prepare('INSERT OR REPLACE INTO woba_data (data_key, player_name, woba, '
    + 'sample_size, uploaded_at) VALUES (?,?,?,?,?)');
  const T = '2999-05-01 00:00:00';
  for (const hand of ['rhb', 'lhb']) {
    // usable actual: 150 BF, above the 100 gate
    w.run('pit-proj-' + hand, BLEND + ' SEA', 0.320, 30, T);
    w.run('pit-act-' + hand,  BLEND,          0.290, 150, T);
    // rejected actual: 86 BF, Tidwell's number
    w.run('pit-proj-' + hand, REJECT + ' TOR', 0.329, 25, T);
    w.run('pit-act-' + hand,  REJECT,          0.212, 86, T);
    // projection only
    w.run('pit-proj-' + hand, NOACT + ' ATH', 0.340, 28, T);
    // actual only
    w.run('pit-act-' + hand,  NOPROJ,         0.295, 150, T);
  }
}
function cleanup() {
  try { db.prepare('DELETE FROM game_log WHERE game_date=?').run(D); } catch (e) {}
  try {
    const st = db.prepare('DELETE FROM woba_data WHERE player_name LIKE ?');
    st.run('Zzq %');
  } catch (e) {}
  try { db.prepare('DELETE FROM bet_signals WHERE game_date=?').run(D); } catch (e) {}
  try { db.prepare('DELETE FROM bet_signal_audit WHERE game_date=?').run(D); } catch (e) {}
}

async function main() {
  // ---- 7 first: the guard the brief asked for, before anything else --
  console.log('\n7. no pricing file changed');
  const PRICING = ['services/model.js', 'services/jobs.js', 'db/schema.js',
    'utils/names.js', 'services/settings-schema.js'];
  const modelSrc = fs.readFileSync(path.join(R, 'services/model.js'), 'utf8');
  // The gate itself, verbatim. A display PR must not move it.
  expect('blendWoba gate is untouched',
    modelSrc.indexOf('const ha = act && !isNaN(act.woba) && act.sample >= minSample;') !== -1);
  expect('getPitcherWoba still passes SIX args (no shrink floor snuck in)',
    /fuzzyLookup\(idx\['pit-act-rhb'\], name, teamHint\),\s*\n\s*minBF, wProj, wAct, pf\s*\n\s*\);/
      .test(modelSrc));
  expect('MIN_BF default in getPitcherWoba is still 100',
    modelSrc.indexOf('if (minBF == null) minBF = 100;') !== -1);
  let gitOk = false, changed = [];
  try {
    const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'],
      { cwd: R, encoding: 'utf8' }).trim();
    changed = execFileSync('git', ['diff', '--name-only', base, 'HEAD'],
      { cwd: R, encoding: 'utf8' }).split('\n').map(x => x.trim()).filter(Boolean)
      .map(x => x.replace(/^mlb-analyzer\//, ''));
    gitOk = true;
  } catch (e) { /* reported below */ }
  if (gitOk) {
    // A diff that sees NOTHING passes the pricing check vacuously -- run
    // before committing, `git diff base HEAD` is empty and the assertion
    // below is satisfied by an absence rather than by a fact. So assert
    // the diff is non-empty first. Same reasoning as the scanner floor in
    // test-game-log-sp-id.js.
    expect('the diff is non-empty, so the check below means something',
      changed.length > 0,
      changed.length + ' file(s) -- if 0, this branch has no commits yet '
      + 'and the pricing check verified nothing');
    const hits = changed.filter(f => PRICING.indexOf(f) !== -1);
    expect('git diff touches no pricing file', hits.length === 0,
      hits.length ? hits.join(', ') : changed.length + ' file(s): ' + changed.join(', '));
  } else {
    console.log('  SKIPPED  git diff check could not run (no git / no origin/main).');
    console.log('           The content assertions above still stand, but this one');
    console.log('           did NOT verify anything -- do not read it as a pass.');
  }

  seed();
  const express = require(path.join(R, 'node_modules/express'));
  const app = express();
  app.use(express.json());
  app.use('/api', require(path.join(R, 'routes/api')));
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const port = srv.address().port;
  const get = async (gid) => {
    const r = await fetch('http://127.0.0.1:' + port + '/api/woba/game/' + D + '/' + gid);
    return { status: r.status, body: await r.json() };
  };

  try {
    const A = await get(GA);
    const B = await get(GB);
    expect('both games resolve', A.status === 200 && B.status === 200 && !A.body.error,
      A.status + '/' + B.status + ' ' + (A.body.error || ''));
    const blend = A.body.away_sp_woba.vsRHB;
    const reject = A.body.home_sp_woba.vsRHB;
    const noact = B.body.away_sp_woba.vsRHB;
    const noproj = B.body.home_sp_woba.vsRHB;

    console.log('\n1. per-split source, recomputed not inherited');
    expect('the usable-actual split says blend', blend.splitSource === 'blend', blend.splitSource);
    expect('the rejected split says steamer, NOT blend',
      reject.splitSource === 'steamer', reject.splitSource);
    expect('projection-only says steamer', noact.splitSource === 'steamer', noact.splitSource);
    expect('actual-only says actual', noproj.splitSource === 'actual', noproj.splitSource);

    console.log('\n2. a rejected actual is RETURNED, not hidden');
    expect('the rejected actual is present', !!reject.act,
      reject.act ? JSON.stringify(reject.act) : 'MISSING -- the bug this PR exists to fix');
    expect('...with its wOBA', reject.act && Math.abs(reject.act.woba - 0.212) < 1e-9);
    expect('...with its sample', reject.act && reject.act.sample === 86,
      reject.act ? String(reject.act.sample) : 'n/a');
    expect('...and a NAMED reason, not a bare boolean',
      reject.actRejectReason === 'below_min_bf', String(reject.actRejectReason));
    expect('...and actUsed is false', reject.actUsed === false, String(reject.actUsed));
    expect('the threshold that rejected it is carried', reject.minBf === 100,
      String(reject.minBf));

    console.log('\n3. absent is distinguishable from rejected');
    expect('no actuals row -> act is null', noact.act === null, JSON.stringify(noact.act));
    expect('...with its own reason', noact.actRejectReason === 'no_actuals_row',
      String(noact.actRejectReason));
    expect('a rejected row and an absent row do NOT share a reason',
      reject.actRejectReason !== noact.actRejectReason);
    expect('no projection -> proj is null', noproj.proj === null, JSON.stringify(noproj.proj));

    console.log('\n4. the sample unit is labelled');
    for (const [n, v] of [['blend', blend], ['rejected', reject]]) {
      expect(n + ' carries sampleUnit=BF', v.sampleUnit === 'BF', String(v.sampleUnit));
    }

    console.log('\n5. the inputs reconstruct the displayed rate');
    const s = q.getAllSettings.all().reduce((a, r) => (a[r.key] = r.value, a), {});
    const wProj = Number(s.w_proj), wAct = Number(s.w_act);
    expect('settings weights read', Number.isFinite(wProj) && Number.isFinite(wAct),
      wProj + '/' + wAct);
    const recon = blend.proj.woba * wProj + blend.act.woba * wAct;
    expect('blend: act*W_ACT + proj*W_PROJ === the shown rate',
      Math.abs(recon - blend.woba) < 1e-9,
      recon.toFixed(6) + ' vs ' + blend.woba.toFixed(6));
    expect('rejected: the shown rate IS the projection alone',
      Math.abs(reject.woba - reject.proj.woba) < 1e-9,
      reject.woba.toFixed(6) + ' vs ' + reject.proj.woba.toFixed(6));
    expect('...and is NOT the blend it would have been',
      Math.abs(reject.woba - (reject.proj.woba * wProj + reject.act.woba * wAct)) > 1e-6);

    console.log('\n6. the aggregate `source` is unchanged for loadDataQuality');
    expect('source is still present on both splits',
      typeof blend.source === 'string' && typeof reject.source === 'string');
    // The Tidwell shape: two hands resolving differently makes the
    // AGGREGATE read 'blend' while one split is steamer. That is exactly
    // why splitSource exists, and the old field must keep its old value.
    const rejLhb = A.body.home_sp_woba.vsLHB;
    expect('aggregate source is identical across the two splits (it is per-pitcher)',
      reject.source === rejLhb.source, reject.source + ' / ' + rejLhb.source);
    expect('but splitSource can differ from the aggregate',
      reject.splitSource !== 'blend' || reject.source !== 'blend'
      || reject.actUsed === true);

    console.log('\n8. the renderer covers all three states');
    const html = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');
    const m = /function spIn\(p, split\)[\s\S]*?\n  \}/.exec(html);
    expect('spIn exists in the page', !!m);
    const spIn = new Function('return ' + m[0])();
    const strip = (x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const out = {
      used: strip(spIn({ v: blend }, 'v')),
      rejected: strip(spIn({ v: reject }, 'v')),
      absent: strip(spIn({ v: noact }, 'v')),
    };
    expect('used shows act with sample AND unit, plus proj',
      /act \.290 \(150 BF\)\s+proj \.320/.test(out.used), out.used);
    expect('rejected shows the value, the sample and the threshold',
      /act \.212 \(86 BF . below 100\)\s+proj \.329/.test(out.rejected), out.rejected);
    expect('absent says "no actuals" rather than blank',
      /no actuals\s+proj \.340/.test(out.absent), out.absent);
    expect('the rejected line is greyed', /text3/.test(spIn({ v: reject }, 'v')));
    expect('...and carries the long reason in a title',
      /title="Actual exists but was NOT used/.test(spIn({ v: reject }, 'v')));
    expect('an unknown split renders nothing rather than throwing',
      spIn({}, 'nope') === '');
  } finally {
    srv.close();
    cleanup();
  }
  return failed;
}

main().then(f => {
  console.log('\n' + (f === 0 ? 'ALL PASS' : f + ' FAILED'));
  process.exit(f === 0 ? 0 : 1);
}).catch(e => { cleanup(); console.error('ERROR: ' + (e && e.stack || e)); process.exit(1); });
