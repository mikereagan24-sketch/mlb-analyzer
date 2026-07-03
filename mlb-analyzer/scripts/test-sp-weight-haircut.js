'use strict';
// Local test harness for the SP-weight confidence haircut + pattern-
// aware anomaly filter. Verifies all three fixes from the brief:
//
//   Fix 1 — Low-information fallback target = ~0.62 (was 0.80).
//   Fix 2 — Graduated haircut on 0/1/2/3+ priors.
//   Fix 3 — Short-leash pattern keeps short starts un-filtered when
//           ≥40% of recent starts are short; isolated fluke still filtered.
//
// Test pitchers (real prod IDs, local DB has their game logs):
//   453286  Max Scherzer       — currently short-leash (4.0/4.7/5.0/6.0/2.0/2.3/6.0/2.3)
//   643377  Griffin Jax        — bullpen converted, short starts only
//   571945  Miles Mikolas      — short-leash starter (3.0/4.7/5.0/4.3/3.0…)
//   623474  Jimmy Herget       — OPENER (1.0 IP every start — verifies pattern detection
//                                 doesn't normalize them into the SP path)
//   663558  Jovani Morán       — OPENER
//   682254  Mason Montgomery   — OPENER
//
// Also: a synthetic ACE-with-one-fluke regression case to make sure
// Fix 3 doesn't over-trigger on isolated short outings.
//
// Usage:  node scripts/test-sp-weight-haircut.js

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { db } = require('../db/schema');
const {
  buildSpStartIndex,
  forecastSpIP,
  computeSpPitWeightFromForecast,
} = require('../services/model');

const SETTINGS = {};   // defaults
const GAMEDATE_TODAY = '2026-06-29';

const PITCHERS = [
  // Scherzer's 2.0 IP / 36p start is a textbook anomaly-base — the
  // pattern rescue should un-flip it so it contributes to the forecast.
  { id: 453286, name: 'Max Scherzer',     expect: 'short-leash, pattern rescues 2.0 IP / 36p',
    wantPattern: true,  wantHigh: false, wantWeightCeiling: 0.74 },
  // Jax has mixed relief + ~7 starts. Two of his starts are <4 IP AND
  // <50p (anomaly-base) so the base filter still tags them; pattern
  // detection needs ≥40% short among non-first-of-season starts, which
  // Jax doesn't quite cross — that's correct behavior. The EWMA over
  // the un-filtered priors already produces ~4.3 IP / 0.63 weight,
  // well under the 0.80 default that pre-fix would have given a
  // no-clean-priors starter.
  { id: 643377, name: 'Griffin Jax',      expect: 'bullpen-converted; EWMA pulls weight down',
    wantPattern: false, wantHigh: false, wantWeightCeiling: 0.75 },
  // Mikolas's short starts (3.0, 3.3) all had ≥50p, so the existing
  // anomaly_base filter NEVER tagged them — they always made it into
  // the forecast. Pattern detection has nothing to un-flip. The EWMA
  // already produces ~5.0 IP / 0.70 weight, correctly low.
  { id: 571945, name: 'Miles Mikolas',    expect: 'short-but-high-pitch — EWMA captures it natively',
    wantPattern: false, wantHigh: false, wantWeightCeiling: 0.75 },
  // Openers — mis-routed into SP path per brief; not fixed here, but
  // verify they at least don't get the full known-starter premium.
  { id: 623474, name: 'Jimmy Herget',     expect: 'opener mis-routed; should NOT be near 0.80',
    wantPattern: false, wantHigh: false, wantWeightCeiling: 0.70 },
  { id: 663558, name: 'Jovani Morán',     expect: 'opener mis-routed; should NOT be near 0.80',
    wantPattern: false, wantHigh: false, wantWeightCeiling: 0.70 },
  { id: 682254, name: 'Mason Montgomery', expect: 'opener mis-routed; should NOT be near 0.80',
    wantPattern: false, wantHigh: false, wantWeightCeiling: 0.70 },
];

let failed = 0;
function expect(name, cond) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failed++;
}

function fmt(n, d) { return n == null ? 'null' : Number(n).toFixed(d == null ? 3 : d); }

function inspectPitcher(p) {
  console.log('\n--- ' + p.name + ' (pid=' + p.id + ') — expect: ' + p.expect + ' ---');
  // Build index w/ current settings, look at this pitcher's tagged starts.
  const idx = buildSpStartIndex(db, SETTINGS);
  const starts = (idx.byPitcher || {})[p.id] || [];
  // Only show the most recent ~12 to keep output readable.
  const tail = starts.slice(-12);
  console.log('  recent starts (date  ip  pitches  start?  anom_base  first_of_season  anom_final  short_leash):');
  for (const s of tail) {
    console.log(`    ${s.game_date}  ${fmt(s.ip,2)}  ${String(s.pitches).padStart(3)}  ` +
      `${String(s.is_start).padStart(5)}  ${String(s.is_anomaly_base).padStart(9)}  ` +
      `${String(s.is_first_of_season).padStart(15)}  ${String(s.is_anomaly).padStart(10)}  ${String(s.short_leash_pattern).padStart(11)}`);
  }
  const fc = forecastSpIP({
    index: idx,
    pitcherMlbId: p.id,
    gameDate: GAMEDATE_TODAY,
    settings: SETTINGS,
    role: 'start',
  });
  const nPriors = (fc.components && fc.components.total_clean_priors) || 0;
  const weightOld = computeSpPitWeightFromForecast(fc.forecast, SETTINGS);
  const weightNew = computeSpPitWeightFromForecast(fc.forecast, SETTINGS, nPriors);
  console.log('  forecast: source=' + fc.source + '  ip=' + fmt(fc.forecast,3) + '  n_priors=' + nPriors);
  console.log('  weight (no haircut): ' + fmt(weightOld,4) + '   weight (with haircut): ' + fmt(weightNew,4));
  // Assertions
  if (p.wantPattern === true) {
    const anyPattern = tail.some(s => s.short_leash_pattern);
    expect(p.name + ': short_leash_pattern flagged on some recent start', anyPattern);
  }
  if (p.wantWeightCeiling != null && weightNew != null) {
    expect(p.name + ': SP weight under ceiling ' + p.wantWeightCeiling,
      weightNew < p.wantWeightCeiling);
  }
  // Sanity: never giving these pitchers full premium
  if (p.wantHigh === false && weightNew != null) {
    expect(p.name + ': SP weight under 0.80 cap', weightNew < 0.80);
  }
  return { fc, nPriors, weightNew };
}

(async () => {
  console.log('=========================================================');
  console.log('  A. computeSpPitWeightFromForecast — graduated haircut');
  console.log('=========================================================');
  const settings = {};
  const cases = [
    { ip: 5.5, n: null, want: 0.75, name: 'no-haircut path (n=null)' },
    { ip: 5.5, n: 0,    want: 0.62, name: '0 priors → full haircut to target 0.62' },
    { ip: 5.5, n: 3,    want: 0.75, name: '3 priors → full forecast weight restored' },
    { ip: 5.5, n: 1,    want: 0.62 + (0.75 - 0.62) * 1/3, name: '1 prior → 1/3 confidence' },
    { ip: 5.5, n: 2,    want: 0.62 + (0.75 - 0.62) * 2/3, name: '2 priors → 2/3 confidence' },
    { ip: 5.5, n: 5,    want: 0.75, name: '5 priors → still full (clamped at N=3)' },
    { ip: 4.0, n: 0,    want: null,  name: 'low IP (4.0) + 0 priors → low weight, but verify clamp behavior' },
    { ip: 7.0, n: 8,    want: 0.90, name: 'high IP (7.0) + many priors → full forecast weight (0.75 + 1.5*0.10)' },
    // Audit finding 2 (2026-07-03): forecastIp==null used to return null,
    // which fell through the caller's `?? SP_PIT_WEIGHT` to 0.80 (max).
    // Fixed to return the low-conf target (0.62), same weight a pitcher
    // WITH a forecast but ZERO priors receives. Both null-forecast and
    // n=any-value hit this path.
    { ip: null, n: null, want: 0.62, name: 'AUDIT FIX 2: null forecast + null priors → low-conf target 0.62 (was null → 0.80)' },
    { ip: null, n: 0,    want: 0.62, name: 'AUDIT FIX 2: null forecast + 0 priors → 0.62' },
    { ip: null, n: 10,   want: 0.62, name: 'AUDIT FIX 2: null forecast overrides priors → still 0.62' },
  ];
  for (const c of cases) {
    const got = computeSpPitWeightFromForecast(c.ip, settings, c.n);
    if (c.want != null) {
      const ok = Math.abs(got - c.want) < 0.005;
      console.log('  ' + (ok ? 'PASS' : 'FAIL') + `  ${c.name}: got=${fmt(got,4)}  want=${fmt(c.want,4)}`);
      if (!ok) failed++;
    } else {
      console.log('  INFO  ' + c.name + ': got=' + fmt(got, 4));
    }
  }

  console.log('\n=========================================================');
  console.log('  B. Per-pitcher inspection — Fixes 2 + 3 in concert');
  console.log('=========================================================');
  const results = {};
  for (const p of PITCHERS) results[p.id] = inspectPitcher(p);

  console.log('\n=========================================================');
  console.log('  C. Regression — ACE with ONE fluke short start');
  console.log('=========================================================');
  // Construct a synthetic ace: 10 normal 6.0 IP starts + 1 fluke 2.0 IP / 30p.
  // Verify pattern detection does NOT fire (1/11 = 9% well under 40%).
  const fakeId = 99999999;
  const fakeRows = [];
  let d = new Date('2026-04-01T00:00:00Z');
  for (let i = 0; i < 11; i++) {
    const isFluke = i === 5;
    fakeRows.push({
      game_date: d.toISOString().slice(0, 10),
      pitcher_mlb_id: fakeId,
      pitcher_name: 'Synth Ace',
      pitches_thrown: isFluke ? 30 : 95,
      innings_pitched: isFluke ? 2.0 : 6.0,
      outing_type: 'start',
      was_starter: 1,
    });
    d = new Date(d.getTime() + 6 * 86400000);
  }
  // Bolt the synthetic rows onto a real index. Easiest: run the same
  // index-build logic by injecting rows via a one-off in-memory stub.
  // Simpler still: directly invoke buildSpStartIndex against a stub db
  // whose prepare().all() returns concatenated rows.
  const realRows = db.prepare(
    "SELECT game_date, pitcher_mlb_id, pitcher_name, pitches_thrown, "
    + "innings_pitched, outing_type, was_starter FROM pitcher_game_log "
    + "WHERE innings_pitched IS NOT NULL AND innings_pitched > 0 "
    + "AND pitcher_mlb_id IS NOT NULL "
    + "ORDER BY pitcher_mlb_id ASC, game_date ASC"
  ).all();
  const allRows = realRows.concat(fakeRows).sort((a, b) =>
    (a.pitcher_mlb_id - b.pitcher_mlb_id) || (a.game_date < b.game_date ? -1 : a.game_date > b.game_date ? 1 : 0)
  );
  const stubDb = { prepare: () => ({ all: () => allRows }) };
  const idx = buildSpStartIndex(stubDb, SETTINGS);
  const fakeStarts = (idx.byPitcher || {})[fakeId] || [];
  const flukeStart = fakeStarts.find(s => s.ip === 2.0);
  const normalStart = fakeStarts.find(s => s.ip === 6.0 && !s.is_first_of_season);
  console.log('  fluke (ip=2.0): is_anomaly_base=' + flukeStart.is_anomaly_base
    + '  short_leash_pattern=' + flukeStart.short_leash_pattern
    + '  is_anomaly_final=' + flukeStart.is_anomaly);
  console.log('  normal (ip=6.0): is_anomaly_base=' + normalStart.is_anomaly_base
    + '  short_leash_pattern=' + normalStart.short_leash_pattern);
  expect('ACE regression: fluke still tagged anomaly (no pattern rescue)', flukeStart.is_anomaly === true);
  expect('ACE regression: fluke is NOT short_leash_pattern', flukeStart.short_leash_pattern === false);
  const fc = forecastSpIP({ index: idx, pitcherMlbId: fakeId, gameDate: '2026-06-29',
    settings: SETTINGS, role: 'start' });
  const w = computeSpPitWeightFromForecast(fc.forecast, SETTINGS,
    (fc.components && fc.components.total_clean_priors) || 0);
  console.log('  ACE forecast: ip=' + fmt(fc.forecast,3) + '  n_priors=' + ((fc.components && fc.components.total_clean_priors) || 0));
  console.log('  ACE weight: ' + fmt(w, 4));
  expect('ACE regression: forecast IP stays high (>= 5.5)', fc.forecast >= 5.5);
  expect('ACE regression: weight stays at/near anchor (>= 0.74)', w != null && w >= 0.74);

  console.log('\n=========================================================');
  console.log('  SUMMARY: ' + (failed === 0 ? 'ALL PASS' : (failed + ' FAILURES')));
  console.log('=========================================================');
  if (failed) process.exit(1);
})().catch(e => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
