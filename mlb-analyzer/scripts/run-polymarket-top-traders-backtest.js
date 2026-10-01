#!/usr/bin/env node
'use strict';
// Run the Polymarket top-traders backtest under
// docs/polymarket-top-traders-prereg-2026-09-30.md. DISPLAY ONLY, LOCAL ONLY.
//
//   <node> --max-old-space-size=1536 scripts/run-polymarket-top-traders-backtest.js [--json FILE]
//     --pm-db PATH    default data/polymarket.db   (opened READ-ONLY)
//     --mlb-db PATH   default data/mlb.db          (opened READ-ONLY)
//
// Order is enforced here, not trusted to the reader:
//   1. the pre-registration's hash must equal the pinned one, or nothing runs;
//   2. Gate 1: every outcome-blind count must equal the pre-registration's §10
//      (and §2 / §5 tables) -- if any differs, it stops BEFORE a single
//      resolution is read;
//   3. only then are outcomes attached and the statistics computed.
//
//   --corrected   the prereg §9 correction run (2026-10-01, #496: identical repeat
//                 trades restored). Gate 1 is the same 27 fields, with two sources:
//                 the game_log-only fields (CORRECTED_GAME_LOG_ONLY, and the price
//                 skips of each counts row) must still equal §10; the
//                 trade-dependent fields must equal the values recorded in
//                 docs/polymarket-top-traders-results-2026-09-30-corrected.json
//                 (or --corrected-artifact PATH). Any mismatch stops before
//                 outcomes, as in the default mode. --json then writes that
//                 artifact's shape (correction record, Gate 1 a/b). Without the
//                 flag nothing below runs differently: the default mode checks
//                 all 27 fields against §10, as it always has.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const bt = require(path.join(R, 'services/polymarket-top-traders-backtest'));

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i === -1 ? null : argv[i + 1]; };
const PM = path.resolve(arg('--pm-db') || path.join(R, 'data/polymarket.db'));
const MLB = path.resolve(arg('--mlb-db') || path.join(R, 'data/mlb.db'));
const JSON_OUT = arg('--json');
const CORRECTED = argv.includes('--corrected');
const CORRECTED_ARTIFACT = path.resolve(arg('--corrected-artifact') || path.join(R, 'docs/polymarket-top-traders-results-2026-09-30-corrected.json'));

let peak = 0;
const tick = () => { const r = process.memoryUsage().rss; if (r > peak) peak = r; };
const t0 = Date.now();

// The pre-registration's own numbers (§2, §5 measurement table, §10), pinned.
const EXPECTED = {
  'done_markets': 2247, 'excluded_dates_markets': 19, 'lock_vs_cutoff.in_scope_games': 2228,
  'first_eligible.date': '2026-04-13', 'first_eligible.qualified': 32,
  'not_eligible.in': 64, 'not_eligible.hold': 0,
  'qualified_by_month.2026-04': ['2026-04-04', 0, '2026-04-30', 196],
  'qualified_by_month.2026-05': ['2026-05-01', 196, '2026-05-31', 450],
  'qualified_by_month.2026-06': ['2026-06-01', 453, '2026-06-30', 622],
  'qualified_by_month.2026-07': ['2026-07-01', 627, '2026-07-31', 821],
  'qualified_by_month.2026-08': ['2026-08-01', 829, '2026-08-31', 964],
  'qualified_by_month.2026-09': ['2026-09-01', 956, '2026-09-27', 1050],
  // [eligible, no lock, contaminated, ML missing, no money, tie, tested, both<=0]
  'counts.primary.in': [1814, 288, 166, 0, 0, 0, 1360, 0],
  'counts.primary.hold': [350, 57, 28, 0, 0, 0, 265, 0],
  'counts.secondary.in': [1814, 288, 166, 0, 82, 0, 1278, 1],
  'counts.secondary.hold': [350, 57, 28, 0, 66, 0, 199, 0],
  // confirmed set [lock<fp, equals capture, confirmed, no capture, no first pitch, differs]
  'confirmed.primary.in': [711, 235, 946, 277, 130, 7],
  'confirmed.primary.hold': [162, 95, 257, 0, 0, 8],
  'confirmed.secondary.in': [652, 214, 866, 276, 130, 6],
  'confirmed.secondary.hold': [119, 75, 194, 0, 0, 5],
  'lock_vs_cutoff': [980, 20, 50, 351, 21],             // at/after, median, p90, max (rounded min), >60 before
  'source_mix.in': { kalshi: 613, polymarket: 540, unrecorded: 200, 'prophet-exchange': 6, novig: 1 },
  'source_mix.hold': { kalshi: 207, polymarket: 58 },
  // §5 table [total, exact, differ, no capture, before 06-11, inside, median, p90, max, under 1pp]
  'lock_after_first_pitch': [622, 330, 15, 277, 273, 4, 0.43, 0.92, 1.89, 13],
  'lock_after_first_pitch.first_capture_date': '2026-06-11',
  'lock_after_first_pitch.by_month': { '2026-04': [22, 0, 0, 22], '2026-05': [187, 0, 0, 187], '2026-06': [159, 88, 3, 68],
    '2026-07': [67, 67, 0, 0], '2026-08': [84, 80, 4, 0], '2026-09': [103, 95, 8, 0] },
};

function actualFor(f) {
  const c = (v, s) => { const x = f.counts[v][s]; return [x.eligible, x.price_skip.no_odds_locked_at, x.price_skip.contaminated,
    x.price_skip.moneyline_missing, x.lean_skip.no_qualified_money, x.lean_skip.tie, x.tested, x.neg_lean]; };
  const cf = (v, s) => { const x = f.counts[v][s].confirmed; const conf = x.confirmed_lock_before_first_pitch + x.confirmed_equals_capture;
    return [x.confirmed_lock_before_first_pitch, x.confirmed_equals_capture, conf, x.outside_no_capture, x.outside_no_first_pitch, x.outside_differs]; };
  const qm = (m) => { const x = f.qualified_by_month[m]; return x ? [x.first_date, x.first_qualified, x.last_date, x.last_qualified] : null; };
  const L = f.lock_at_or_after_first_pitch, r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  const bm = {}; for (const [k, v] of Object.entries(L.by_month)) bm[k] = [v.total, v.exact, v.differ, v.no_capture];
  return {
    'done_markets': f.done_markets, 'excluded_dates_markets': f.excluded_dates_markets, 'lock_vs_cutoff.in_scope_games': f.lock_vs_cutoff.in_scope_games,
    'first_eligible.date': f.first_eligible && f.first_eligible.date, 'first_eligible.qualified': f.first_eligible && f.first_eligible.qualified,
    'not_eligible.in': f.not_eligible.in, 'not_eligible.hold': f.not_eligible.hold,
    ...Object.fromEntries(['04', '05', '06', '07', '08', '09'].map(mm => ['qualified_by_month.2026-' + mm, qm('2026-' + mm)])),
    'counts.primary.in': c('primary', 'in'), 'counts.primary.hold': c('primary', 'hold'),
    'counts.secondary.in': c('secondary', 'in'), 'counts.secondary.hold': c('secondary', 'hold'),
    'confirmed.primary.in': cf('primary', 'in'), 'confirmed.primary.hold': cf('primary', 'hold'),
    'confirmed.secondary.in': cf('secondary', 'in'), 'confirmed.secondary.hold': cf('secondary', 'hold'),
    'lock_vs_cutoff': [f.lock_vs_cutoff.at_or_after_cutoff, Math.round(f.lock_vs_cutoff.minutes_after_median),
      Math.round(f.lock_vs_cutoff.minutes_after_p90), Math.round(f.lock_vs_cutoff.minutes_after_max), f.lock_vs_cutoff.more_than_60_before],
    'source_mix.in': f.source_mix_tested_primary.in, 'source_mix.hold': f.source_mix_tested_primary.hold,
    'lock_after_first_pitch': [L.total, L.exact, L.differ, L.no_capture, L.no_capture_before_first_capture_date, L.no_capture_inside_capture_window,
      r2(L.diff_pp_median), r2(L.diff_pp_p90), r2(L.diff_pp_max), L.diff_pp_under_1],
    'lock_after_first_pitch.first_capture_date': L.first_capture_date,
    'lock_after_first_pitch.by_month': bm,
  };
}
const canon = (v) => JSON.stringify(v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v);

// ---------------------------------------------------------------- --corrected (prereg §9 correction run)
// Fields that depend only on game_log and the market cutoffs: unchanged by #496, so still §10's.
const CORRECTED_GAME_LOG_ONLY = ['done_markets', 'excluded_dates_markets', 'lock_vs_cutoff.in_scope_games', 'lock_vs_cutoff',
  'lock_after_first_pitch', 'lock_after_first_pitch.first_capture_date', 'lock_after_first_pitch.by_month'];
const PRICE_SKIP_IDX = [1, 2, 3];                     // counts rows: [eligible, no lock, contaminated, ML missing, ...]
const PREREG_EXPECTED = JSON.parse(JSON.stringify(EXPECTED));
// -> { field: 'game_log' | 'trades' | 'mixed' }
const correctedSourceOf = (k) => (CORRECTED_GAME_LOG_ONLY.includes(k) ? 'game_log' : k.startsWith('counts.') ? 'mixed' : 'trades');
let correctedRecord = null;
if (CORRECTED) {
  const recorded = actualFor(JSON.parse(fs.readFileSync(CORRECTED_ARTIFACT, 'utf8')).feasibility);
  for (const k of Object.keys(EXPECTED)) {
    const src = correctedSourceOf(k);
    if (src === 'trades') EXPECTED[k] = recorded[k];
    else if (src === 'mixed') EXPECTED[k] = recorded[k].map((v, i) => (PRICE_SKIP_IDX.includes(i) ? PREREG_EXPECTED[k][i] : v));
  }
}
// Gate 1 a/b record and the correction block for the --corrected artifact. pm: READ-ONLY.
function correctedArtifact(artifact, act, pm) {
  const pick = (v, idx) => idx.map(i => v[i]);
  const OTHER_IDX = [0, 4, 5, 6, 7];
  const a = [], b = [];
  for (const k of Object.keys(PREREG_EXPECTED)) {
    const src = correctedSourceOf(k);
    if (src === 'game_log') a.push({ field: k, prereg: PREREG_EXPECTED[k], actual: act[k], match: canon(PREREG_EXPECTED[k]) === canon(act[k]) });
    if (src === 'mixed') {
      a.push({ field: k + ' price skips [no lock, contaminated, ML missing]', prereg: pick(PREREG_EXPECTED[k], PRICE_SKIP_IDX), actual: pick(act[k], PRICE_SKIP_IDX),
        match: canon(pick(PREREG_EXPECTED[k], PRICE_SKIP_IDX)) === canon(pick(act[k], PRICE_SKIP_IDX)) });
      b.push({ field: k + ' [eligible, no money, tie, tested, both<=0]', prereg: pick(PREREG_EXPECTED[k], OTHER_IDX), corrected: pick(act[k], OTHER_IDX),
        changed: canon(pick(PREREG_EXPECTED[k], OTHER_IDX)) !== canon(pick(act[k], OTHER_IDX)) });
    }
    if (src === 'trades') b.push({ field: k, prereg: PREREG_EXPECTED[k], corrected: act[k], changed: canon(PREREG_EXPECTED[k]) !== canon(act[k]) });
  }
  const q = (s) => pm.prepare(s).get();
  const r2 = (v) => Math.round(v * 100) / 100;
  const run = q("SELECT started_at, finished_at, args, requests, retries, http429, peak_rss_mb, markets_done FROM runs WHERE args LIKE '--refetch-dropped-repeats%' ORDER BY id DESC LIMIT 1");
  const season = "FROM wallet_game wg JOIN markets m ON m.id = wg.market_id WHERE m.status = 'done' AND m.game_date <= '2026-09-27'";
  const correction = {
    of: 'docs/polymarket-top-traders-results-2026-09-30.json (unchanged; the original stands beside this one)',
    under: 'pre-registration §9: an implementation bug fixed in code, the run repeated with a note. No rule or definition changed.',
    cause: 'Polymarket /trades has no trade id, and identical rows are separate real fills (one taker order matched against several identical maker orders). '
      + 'The backfill de-duplicated within each time window and dropped 18,671 real trades in 1,846 of the 2,247 done markets.',
    data_fix: { pr: 496, commit: '1e3330d6e5a26d684fd6f66a9958e05119b7cc2d', merged_in: 'c8dd5079a7b867d298315d6ee6f6191c7ba5437c', refetch_run: run },
    store: {                                          // the corrected data/polymarket.db, as read by this run
      markets_refetched: q("SELECT COUNT(*) c FROM markets WHERE repeats_refetch = 'done'").c,
      markets_refetch_pending: q("SELECT COUNT(*) c FROM markets WHERE repeats_refetch IS NOT NULL AND repeats_refetch <> 'done'").c,
      trades_dropped_by_the_old_run: q('SELECT SUM(repeats_dropped_v1) s FROM markets').s,
      done_markets: q("SELECT COUNT(*) c FROM markets WHERE status = 'done'").c,
      pending_windows: q("SELECT COUNT(*) c FROM windows WHERE status = 'pending'").c,
      fills: q('SELECT COUNT(*) c FROM fills').c,
      fills_at_or_after_cutoff: q('SELECT COUNT(*) c FROM fills f JOIN markets m ON m.id = f.market_id WHERE f.ts >= m.cutoff_utc').c,
      distinct_wallets_with_fills: q('SELECT COUNT(DISTINCT wallet_id) c FROM fills').c,
      wallet_game_rows: q('SELECT COUNT(*) c FROM wallet_game').c,
      net_short_positions: q('SELECT COUNT(*) c FROM net_short').c,
      season_wallet_profit_usd: r2(q('SELECT SUM(wg.profit) s ' + season).s),
      season_wallet_volume_usd: r2(q('SELECT SUM(wg.volume) s ' + season).s),
    },
    verification_against_the_pre_fix_backup: 'docs/polymarket-top-traders-results-2026-09-30.md, section Correction',
    reproduce: { runner: 'scripts/run-polymarket-top-traders-backtest.js', committed_with: 'this artifact (same commit)',
      command: 'node --max-old-space-size=1536 scripts/run-polymarket-top-traders-backtest.js --corrected --mlb-db <scratch copy of data/mlb.db> --json <file>',
      checked_by: 'scripts/test-top-traders-card-a.js check a' },
  };
  const gate1 = { mode: 'corrected', fields: Object.keys(PREREG_EXPECTED).length, matched: artifact.gate1.matched,
    a: { rule: 'game_log / cutoff only: must equal §10', fields: a.length, matched: a.filter(x => x.match).length, rows: a },
    b: { rule: 'depend on trades: must equal the values recorded in this artifact; shown against §10', fields: b.length,
      changed_from_prereg: b.filter(x => x.changed).length, rows: b } };
  const ordered = Object.assign({}, artifact, { correction, gate1 });
  const keys = ['artifact', 'version', 'display_only', 'local_only', 'correction'];
  for (const k of Object.keys(artifact)) delete artifact[k];
  for (const k of keys) artifact[k] = ordered[k];
  for (const k of Object.keys(ordered)) if (!keys.includes(k)) artifact[k] = ordered[k];
  return artifact;
}

// ---------------------------------------------------------------- 1. pin
let hash;
try { hash = bt.assertPrereg(R); } catch (e) { console.error(e.message); process.exit(2); }
const pm = new Database(PM, { readonly: true, fileMustExist: true });
const mlb = new Database(MLB, { readonly: true, fileMustExist: true });

// ---------------------------------------------------------------- 2. Gate 1 (outcome-blind)
const blind = bt.buildOutcomeBlind(pm, mlb, { onTick: tick });
const act = actualFor(blind.feasibility);
const diffs = Object.keys(EXPECTED).filter(k => canon(EXPECTED[k]) !== canon(act[k]));
console.log('POLYMARKET TOP-TRADERS BACKTEST   pre-registration ' + bt.PREREG_PATH + ' @ ' + bt.PREREG_COMMIT.slice(0, 7)
  + '   sha256 ' + hash.slice(0, 12) + ' (pinned, matches)');
if (CORRECTED) console.log('--corrected: game_log-only fields and price skips checked against §10; trade-dependent fields against '
  + path.relative(R, CORRECTED_ARTIFACT).replace(/\\/g, '/'));
console.log('\nGATE 1 -- outcome-blind reproduction of §2 / §5 / §10: ' + (Object.keys(EXPECTED).length - diffs.length)
  + ' of ' + Object.keys(EXPECTED).length + ' fields match');
for (const k of Object.keys(EXPECTED)) console.log('  ' + (diffs.includes(k) ? 'DIFF ' : 'ok   ') + k.padEnd(44) + canon(act[k])
  + (diffs.includes(k) ? '   expected ' + canon(EXPECTED[k]) : ''));
if (diffs.length) {
  console.log('\nGATE 1 FAILED: ' + diffs.length + ' field(s) differ. STOPPING before any resolution is read.');
  console.log('runtime ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s, peak RSS ' + Math.round(peak / 1e6) + ' MB');
  process.exit(3);
}
if (argv.includes('--gate1-only')) {
  console.log('\n--gate1-only: stopping before outcomes. runtime ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s, peak RSS ' + Math.round(peak / 1e6) + ' MB');
  process.exit(0);
}

// ---------------------------------------------------------------- 3. outcomes and statistics
bt.attachOutcomes(pm, blind.rows);
tick();
const results = bt.computeResults(blind.rows);
tick();
const pct = (v, d = 1) => (v == null ? '-' : (100 * v).toFixed(d) + '%');
const sgn = (v, d = 1) => (v == null ? '-' : (v >= 0 ? '+' : '') + (100 * v).toFixed(d));
const p3 = (v) => (v == null ? '-' : v < 0.001 ? '<0.001' : v.toFixed(3));
console.log('\nRESULTS (flat $100 on the lean at the locked price; edge = win% - implied%, points)');
for (const set of ['main', 'confirmed']) {
  console.log('\n' + (set === 'main' ? 'MAIN TESTS (BH across the 2 in-sample p-values)' : 'SENSITIVITY: confirmed set (outside BH; q for display only)'));
  for (const r of results.filter(x => x.set === set && x.sourceFilter === 'all')) {
    console.log('  ' + (r.variant + ' ' + (r.split === 'in' ? 'in-sample' : 'holdout')).padEnd(20)
      + ' n ' + String(r.n).padStart(4) + '  ' + (r.W + '-' + r.L).padEnd(9)
      + ' win ' + pct(r.winPct) + ' [' + pct(r.winLo) + ', ' + pct(r.winHi) + ']  implied ' + pct(r.implied) + '  edge ' + sgn(r.edge)
      + '  p ' + p3(r.pValue) + (r.qValue !== undefined ? '  q ' + p3(r.qValue) : '')
      + '  ROI ' + sgn(r.roi) + '% [' + sgn(r.roiLo) + ', ' + sgn(r.roiHi) + ']  $ ' + Math.round(r.dollars)
      + (r.holdout !== undefined ? '  holdout ' + (r.holdout || '-') : ''));
  }
}
console.log('\nunrecorded-source excluded:');
for (const r of results.filter(x => x.sourceFilter === 'recorded_only')) {
  console.log('  ' + (r.set + ' ' + r.variant + ' ' + r.split).padEnd(26) + ' n ' + String(r.n).padStart(4) + ' win ' + pct(r.winPct)
    + ' implied ' + pct(r.implied) + ' edge ' + sgn(r.edge) + ' p ' + p3(r.pValue) + ' ROI ' + sgn(r.roi) + '% [' + sgn(r.roiLo) + ', ' + sgn(r.roiHi) + ']');
}
const secs = (Date.now() - t0) / 1000;
console.log('\nruntime ' + secs.toFixed(1) + ' s, peak RSS ' + Math.round(peak / 1e6) + ' MB');

if (JSON_OUT) {
  const git = (c) => execSync(c, { cwd: R }).toString().trim();
  const mainIn = results.filter(r => r.set === 'main' && r.split === 'in' && r.sourceFilter === 'all');
  const artifact = {
    artifact: 'polymarket-top-traders-results', version: 1, display_only: true, local_only: true,
    generated_at: new Date().toISOString(),
    generated_from_commit: git('git rev-parse HEAD'),
    generated_with_uncommitted_tracked_changes: git('git status --porcelain --untracked-files=no').split('\n').filter(Boolean),
    prereg_path: bt.PREREG_PATH, prereg_commit: bt.PREREG_COMMIT, prereg_sha256: hash,
    window: { in_sample: '2026-04-06..2026-08-31 (eligible from 2026-04-13)', holdout: '2026-09-01..2026-09-27' },
    bootstrap: { resamples: 10000, seed: bt.BOOT_SEED, rng: 'mulberry32 (services/trends-backtest.js)' },
    gate1: { fields: Object.keys(EXPECTED).length, matched: Object.keys(EXPECTED).length - diffs.length },
    feasibility: blind.feasibility,
    multiple_comparisons: { method: 'Benjamini-Hochberg across the 2 main in-sample p-values', significant_if: 'q < 0.10',
      significant: mainIn.filter(r => r.significant).map(r => r.variant) },
    results,
    runtime_seconds: +secs.toFixed(1), peak_rss_mb: Math.round(peak / 1e6),
  };
  if (CORRECTED) correctedArtifact(artifact, act, pm);
  fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(artifact, null, 1) + '\n');
  console.log('wrote ' + JSON_OUT);
}
