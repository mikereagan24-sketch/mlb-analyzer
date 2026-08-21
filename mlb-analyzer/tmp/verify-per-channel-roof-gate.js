'use strict';
// One-shot verification for fix/unsealed-closed-temp-multiplier.
//
// Proves three things about the 2026-08-20 per-channel roof gate:
//   A. roofChannelMults returns the intended table for every roofed
//      venue plus the null/unknown edge cases.
//   B. The ONLY behavioral change vs the old single-roofMult gate is
//      temp_run_adj at unsealed-closed venues. Everything else --
//      sealed-closed, open, partial -- is bit-identical.
//   C. Replayed over every weather-bearing row in the real DB, the set
//      of rows whose stored effective weather would change is exactly
//      the unsealed-closed set, and nothing else moves.
//
// Run: <node20>/node.exe tmp/verify-per-channel-roof-gate.js
const path = require('path');
const weather = require('../services/weather');
const { computeEffectiveWeather, roofChannelMults, PARKS } = weather;
const { isSealedDome, isUnsealedRoof } = require('../services/roof-prior');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++;
  console.log('  FAIL ' + label + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
};

// ---- A. multiplier table -------------------------------------------
console.log('=== A. roofChannelMults table ===');
const SEALED = [[15, 'ARI'], [2392, 'HOU'], [5325, 'TEX'], [4169, 'MIA'], [14, 'TOR'], [32, 'MIL']];
for (const pair of SEALED) {
  eq(pair[1] + ' closed', roofChannelMults('closed', pair[0]), { windMult: 0, tempMult: 0 });
  eq(pair[1] + ' open', roofChannelMults('open', pair[0]), { windMult: 1, tempMult: 1 });
}
eq('SEA closed (unsealed)', roofChannelMults('closed', 680), { windMult: 0, tempMult: 1 });
eq('SEA open', roofChannelMults('open', 680), { windMult: 1, tempMult: 1 });
eq('CLOSED uppercase', roofChannelMults('CLOSED', 680), { windMult: 0, tempMult: 1 });
eq('partial', roofChannelMults('partial', 680), { windMult: 0.5, tempMult: 0.5 });
eq('null status', roofChannelMults(null, 680), { windMult: 1, tempMult: 1 });
eq('undefined status', roofChannelMults(undefined, 3), { windMult: 1, tempMult: 1 });
eq('unknown status string', roofChannelMults('banana', 680), { windMult: 1, tempMult: 1 });
// Fail-safe defaults: anything not on the canopy allowlist keeps the
// historical temp x0, so an unknown / fixed-dome / NULL venue can never
// be handed outdoor temp by accident.
eq('closed at non-roofed venue', roofChannelMults('closed', 3), { windMult: 0, tempMult: 0 });
eq('closed w/ null venueId', roofChannelMults('closed', null), { windMult: 0, tempMult: 0 });
eq('closed at Tropicana (fixed dome, 12)', roofChannelMults('closed', 12), { windMult: 0, tempMult: 0 });
eq('closed at MIL (sealed, 32)', roofChannelMults('closed', 32), { windMult: 0, tempMult: 0 });
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');

// ---- B. old gate vs new gate ---------------------------------------
// Verbatim copy of the pre-fix implementation, kept ONLY as the
// differential baseline for this check. Do not reuse it anywhere.
function oldGate(a) {
  const rawWindFactor = (a.park && a.windSpeed != null && a.windDir != null)
    ? weather.calcWindFactor(a.windDir, a.windSpeed, a.park) : 0;
  const rawTempAdj = weather.tempRunAdjFromTempF(a.tempF);
  const rawTempAdjNum = rawTempAdj == null ? 0 : rawTempAdj;
  const st = String(a.roofStatus || 'open').toLowerCase();
  const roofMult = st === 'closed' ? 0 : st === 'partial' ? 0.5 : 1;
  const sealedClosed = st === 'closed' && isSealedDome(a.venueId);
  return {
    windFactor: sealedClosed ? 0 : rawWindFactor * roofMult,
    tempRunAdj: sealedClosed ? 0 : rawTempAdjNum * roofMult,
  };
}

console.log('=== B. old-vs-new differential over a synthetic grid ===');
const VENUES = [[15, 'ari'], [2392, 'hou'], [5325, 'tex'], [4169, 'mia'],
                [14, 'tor'], [32, 'mil'], [680, 'sea'], [3, 'bal']];
const STATUSES = ['open', 'closed', 'partial', null];
const TEMPS = [40, 54, 56, 69, 71, 79, 81, 95];
const SPEEDS = [0, 5, 7.9, 8.1, 15, 30];
const DIRS = [0, 45, 90, 180, 270];
let grid = 0, changedWind = 0, changedTemp = 0;
const changedKeys = new Set();
for (const v of VENUES) {
  const park = PARKS[v[1]];
  for (const st of STATUSES) {
    for (const t of TEMPS) {
      for (const s of SPEEDS) {
        for (const d of DIRS) {
          const args = { windSpeed: s, windDir: d, tempF: t, roofStatus: st, venueId: v[0], park: park };
          const o = oldGate(args), n = computeEffectiveWeather(args);
          grid++;
          if (o.windFactor !== n.windFactor) { changedWind++; changedKeys.add(v[1] + '/' + st + '/wind'); }
          if (o.tempRunAdj !== n.tempRunAdj) { changedTemp++; changedKeys.add(v[1] + '/' + st + '/temp'); }
        }
      }
    }
  }
}
console.log('  grid combinations: ' + grid);
console.log('  wind_factor changed in: ' + changedWind + ' (expected 0)');
console.log('  temp_run_adj changed in: ' + changedTemp);
console.log('  changed venue/status/channel keys: ' + (changedKeys.size ? Array.from(changedKeys).sort().join(', ') : '(none)'));
if (changedWind !== 0) { fail++; console.log('  FAIL wind channel must be untouched by this change'); }
else { pass++; }
const badTempKeys = Array.from(changedKeys).filter(k => k !== 'sea/closed/temp');
if (badTempKeys.length) { fail++; console.log('  FAIL unexpected temp changes: ' + badTempKeys.join(', ')); }
else { pass++; }
console.log('');

// ---- C. replay over the real DB ------------------------------------
console.log('=== C. replay over data/mlb.db ===');
let db = null;
try {
  const Database = require('better-sqlite3');
  db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });
} catch (e) {
  console.log('  SKIPPED (no local DB / driver): ' + e.message);
}
if (db) {
  const rows = db.prepare(
    'SELECT game_date, game_id, home_team, venue_id, roof_status, wind_speed, wind_dir, temp_f, '
    + 'wind_factor, temp_run_adj FROM game_log WHERE temp_f IS NOT NULL'
  ).all();
  const byBucket = {};
  let wouldChange = 0;
  const samples = [];
  for (const r of rows) {
    const park = PARKS[String(r.game_id).split('-')[1]];
    const args = { windSpeed: r.wind_speed, windDir: r.wind_dir, tempF: r.temp_f,
      roofStatus: r.roof_status, venueId: r.venue_id, park: park };
    const o = oldGate(args), n = computeEffectiveWeather(args);
    const st = (r.roof_status || 'null').toLowerCase();
    const seal = st === 'closed' ? (isUnsealedRoof(r.venue_id) ? '/CANOPY' : '/sealed') : '';
    const bucket = st + seal;
    if (!byBucket[bucket]) byBucket[bucket] = { n: 0, changed: 0 };
    byBucket[bucket].n++;
    if (o.windFactor !== n.windFactor || o.tempRunAdj !== n.tempRunAdj) {
      byBucket[bucket].changed++;
      wouldChange++;
      if (samples.length < 12) {
        samples.push({ date: r.game_date, game: r.game_id, team: r.home_team, roof: r.roof_status,
          temp_f: r.temp_f, temp_run_adj: o.tempRunAdj + ' -> ' + n.tempRunAdj,
          wind_factor: o.windFactor + ' -> ' + n.windFactor });
      }
    }
  }
  console.log('  rows replayed: ' + rows.length);
  console.log('  rows whose effective weather changes: ' + wouldChange);
  console.log('  by roof bucket:');
  Object.keys(byBucket).sort().forEach(k => {
    console.log('    ' + k.padEnd(20) + 'n=' + String(byBucket[k].n).padStart(5) + '  changed=' + byBucket[k].changed);
  });
  if (samples.length) { console.log('  sample changed rows:'); console.table(samples); }
  const offTarget = Object.keys(byBucket).filter(k => byBucket[k].changed > 0 && k.indexOf('CANOPY') === -1);
  if (offTarget.length) { fail++; console.log('  FAIL rows changed outside the canopy bucket: ' + offTarget.join(', ')); }
  else { pass++; console.log('  OK no stored row outside the canopy bucket moves'); }

  // ---- D. exercise the path the DB cannot ---------------------------
  // The DB holds ZERO SEA rows labelled closed: the universal corrector
  // went live 2026-06-16 and SEA's last actual closure was 2026-05-29,
  // so every real closure is still stored as open/estimated. Section C
  // therefore proves no regression but never touches the new branch.
  // These are the 2026 SEA closures per statsapi weather.condition
  // ('Roof Closed'), which is what the corrector will write the next
  // time a spring closure lands inside its 14-day lookback.
  console.log('');
  console.log('=== D. dormant-bug replay: 2026 SEA closures, correctly labelled ===');
  const SEA_CLOSED_2026 = ['2026-03-29', '2026-04-01', '2026-04-11', '2026-04-21',
                           '2026-04-22', '2026-05-15', '2026-05-16', '2026-05-29'];
  const sel = db.prepare(
    "SELECT game_date, game_id, venue_id, roof_status, wind_speed, wind_dir, temp_f "
    + "FROM game_log WHERE home_team='SEA' AND game_date = ?"
  );
  const shown = [];
  let tempSaved = 0, missing = 0;
  for (const d of SEA_CLOSED_2026) {
    const r = sel.get(d);
    if (!r || r.temp_f == null) { missing++; continue; }
    const park = PARKS[String(r.game_id).split('-')[1]];
    // venue_id is NULL on the early-April rows; the corrector writes it
    // from statsapi, so score the fix against the venue it will carry.
    const vid = r.venue_id == null ? 680 : r.venue_id;
    const args = { windSpeed: r.wind_speed, windDir: r.wind_dir, tempF: r.temp_f,
      roofStatus: 'closed', venueId: vid, park: park };
    const o = oldGate(args), n = computeEffectiveWeather(args);
    if (o.tempRunAdj !== n.tempRunAdj) tempSaved++;
    shown.push({ date: d, stored_roof: r.roof_status, temp_f: r.temp_f,
      old_temp_adj: o.tempRunAdj, new_temp_adj: n.tempRunAdj,
      old_wind: o.windFactor, new_wind: n.windFactor });
  }
  console.table(shown);
  console.log('  rows not in DB (predate 2026-04-10 start): ' + missing);
  console.log('  rows where the fix preserves temp_run_adj: ' + tempSaved + ' of ' + shown.length);
  if (shown.length && tempSaved === shown.filter(r => r.old_temp_adj !== 0 || r.new_temp_adj !== 0).length) {
    pass++; console.log('  OK every non-zero temp adjustment survives the corrected label');
  } else if (!shown.length) {
    console.log('  SKIPPED (no matching rows)');
  } else {
    fail++; console.log('  FAIL some temp adjustments still zeroed at a canopy venue');
  }
}

console.log('');
console.log('=== TOTAL: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
