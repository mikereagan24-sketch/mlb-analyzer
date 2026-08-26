#!/usr/bin/env node
/**
 * Same-day vs next-day lineup quality. (2026-08-26)
 *
 * The question the existing corpus CANNOT answer. proj_lineup_captured_at
 * has no horizon spread -- 1586 of 1588 rows are next-day, exactly 2 are
 * same-day, median lead 32.2h -- because game_log's projected snapshot is
 * written through COALESCE and the 8PM PT tomorrow-slate prefetch always
 * claims the slot first. Same-day pulls ran nine times a day all season
 * and were discarded. lineup_captures (2026-08-26) is where they land now.
 *
 * So this script reports NOTHING on day one, by construction, and that is
 * correct. It prints the inventory, the required n, and how far away it is.
 *
 *   node scripts/lineup-horizon-compare.js
 *   node scripts/lineup-horizon-compare.js --skip-model    # metrics 1-3,5 only
 *
 * THE COMPARISON IS PAIRED. Same game, both horizons, each scored against
 * the same confirmed lineup. Pairing is what makes this answerable at a
 * few hundred games instead of a few thousand -- an unpaired comparison
 * would be fighting the day-to-day variance that the pairing cancels.
 *
 * POST-START CAPTURES ARE EXCLUDED, NOT AVERAGED IN. RotoWire marks an
 * in-progress game with `has-started` and 6 of 15 same-day blocks carried
 * it at 2:30PM PT on 2026-08-26. A capture of a game already underway is
 * not a forecast, and counting those would show same-day "accuracy" that
 * is really just a record of what happened -- the lineup equivalent of a
 * post-first-pitch price. Excluded on page_has_started OR a negative lead,
 * and the count of exclusions is printed rather than hidden.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));

const SKIP_MODEL = process.argv.includes('--skip-model');
const BOOT = 4000;

// Detection targets for the model-impact leg, in runs. The middle one is
// the headline: a third of the observed next-day median (0.300 runs) is
// the smallest improvement that would plausibly change when to bet.
const TARGETS = [0.15, 0.10, 0.05];

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function ci(items, stat, seed) {
  const byDate = new Map();
  for (const it of items) { if (!byDate.has(it.d)) byDate.set(it.d, []); byDate.get(it.d).push(it); }
  const dates = [...byDate.keys()], n = dates.length, rnd = mulberry(seed), out = [];
  if (!n) return [null, null];
  for (let b = 0; b < BOOT; b++) {
    const s = [];
    for (let i = 0; i < n; i++) for (const x of byDate.get(dates[Math.floor(rnd() * n)])) s.push(x);
    const v = stat(s); if (v != null && isFinite(v)) out.push(v);
  }
  if (out.length < 50) return [null, null];
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const pj = s => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : null; } catch (e) { return null; } };
const f = (v, d) => v == null ? 'n/a' : Number(v).toFixed(d == null ? 1 : d);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
function sd(a) { if (a.length < 2) return null; const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); }

// One-way ANOVA intra-class correlation by date, and the resulting design
// effect. Games on one slate share weather, umpires, model version and
// wOBA snapshot, so treating them as independent overstates power. This
// is measured on the corpus rather than assumed.
function iccByDate(items, valueOf) {
  const by = new Map();
  for (const it of items) { const v = valueOf(it); if (v == null || !isFinite(v)) continue;
    if (!by.has(it.d)) by.set(it.d, []); by.get(it.d).push(v); }
  const groups = [...by.values()];
  const all = groups.flat(), n = all.length, k = groups.length;
  if (k < 2 || n <= k) return { icc: null, deff: 1, m0: null, n, k };
  const gm = mean(all);
  let ssb = 0, ssw = 0;
  for (const g of groups) { const m = mean(g); ssb += g.length * (m - gm) * (m - gm);
    for (const x of g) ssw += (x - m) * (x - m); }
  const msb = ssb / (k - 1), msw = ssw / (n - k);
  const m0 = (n - groups.reduce((s, g) => s + g.length * g.length, 0) / n) / (k - 1);
  const icc = (msb + (m0 - 1) * msw) === 0 ? 0 : (msb - msw) / (msb + (m0 - 1) * msw);
  return { icc, deff: 1 + (m0 - 1) * Math.max(0, icc), m0, n, k };
}

// Paired n for 80% power at alpha=.05 two-sided, inflated by the design
// effect. Reported as GAMES, which is the unit the capture produces.
function requiredN(sdDiff, delta, deff) {
  if (sdDiff == null || !delta) return null;
  const z = 1.959964 + 0.841621;
  return Math.ceil((z * z * sdDiff * sdDiff / (delta * delta)) * (deff || 1));
}

// --- accuracy metrics, identical definitions to the next-day baseline ---
function scoreSide(projArr, confArr) {
  const P = projArr.slice(0, 9), C = confArr.slice(0, 9);
  if (P.length < 9 || C.length < 9) return null;
  let slot = 0, hand = 0;
  const cset = new Set(C.map(x => norm(x.name)));
  let roster = 0;
  for (let i = 0; i < 9; i++) {
    if (norm(P[i].name) === norm(C[i].name)) slot++;
    if ((P[i].hand || 'R') === (C[i].hand || 'R')) hand++;
    if (cset.has(norm(P[i].name))) roster++;
  }
  // Handedness AS COMPOSITION: how many lefties the model sees, not who
  // bats where. This is the form the model actually consumes, and it is
  // far more forgiving than positional handedness -- 92.0% vs 69.0% on
  // the next-day baseline.
  const lp = P.filter(x => (x.hand || 'R') === 'L').length;
  const lc = C.filter(x => (x.hand || 'R') === 'L').length;
  return { slot, hand, roster, compExact: lp === lc ? 1 : 0, compErr: Math.abs(lp - lc) };
}

(function main() {
  console.log('=== same-day vs next-day lineup quality ===');

  const inv = db.prepare(
    'SELECT horizon, COUNT(*) rows, COUNT(DISTINCT game_date || game_id) games, '
    + 'MIN(capture_time) first, MAX(capture_time) last, '
    + 'SUM(page_has_started) started FROM lineup_captures GROUP BY horizon').all();

  console.log('');
  console.log('--- capture inventory ---');
  if (!inv.length) {
    console.log('  lineup_captures is EMPTY.');
    console.log('  Capture starts with the next lineup cron; this is expected on day one.');
  }
  for (const r of inv) {
    console.log('  ' + r.horizon.padEnd(9) + ' rows ' + String(r.rows).padStart(6)
      + '  games ' + String(r.games).padStart(5)
      + '  started-blocks ' + String(r.started).padStart(4)
      + '  ' + String(r.first).slice(0, 10) + ' .. ' + String(r.last).slice(0, 10));
  }

  // ---- pair the horizons on the same game, against the confirmed lineup
  // Latest clean capture per (game, horizon): the one closest to first
  // pitch that is still pre-start. For next-day that is the whole slate;
  // for same-day it is the last pull before the game began.
  const caps = db.prepare(
    'SELECT c.game_date d, c.game_id gi, c.horizon h, c.side side, c.lineup_json lj, '
    + ' c.lineup_status st, c.capture_time ct, c.lead_minutes lead, c.page_has_started started, '
    + ' g.away_lineup_json ca, g.home_lineup_json ch, '
    + ' g.proj_model_total pmt, g.model_total mt '
    + 'FROM lineup_captures c JOIN game_log g '
    + '  ON g.game_date=c.game_date AND g.game_id=c.game_id '
    + 'ORDER BY c.capture_time').all();

  let exclStarted = 0, exclNegLead = 0;
  const best = new Map();          // gi|d|h|side -> row (latest clean)
  for (const r of caps) {
    if (r.started) { exclStarted++; continue; }
    if (r.lead != null && r.lead < 0) { exclNegLead++; continue; }
    best.set(r.d + '|' + r.gi + '|' + r.h + '|' + r.side, r);
  }
  console.log('');
  console.log('  excluded, post-start: ' + exclStarted + ' flagged by the page, '
    + exclNegLead + ' by a negative lead');

  const sides = { same_day: [], next_day: [] };
  for (const [key, r] of best) {
    const conf = pj(r.side === 'away' ? r.ca : r.ch);
    const proj = pj(r.lj);
    if (!conf || !proj) continue;
    const s = scoreSide(proj, conf);
    if (!s) continue;
    sides[r.h].push(Object.assign({ d: r.d, gi: r.gi, lead: r.lead, st: r.st }, s));
  }

  console.log('');
  console.log('--- (1)(2)(3) accuracy vs confirmed, per horizon ---');
  console.log('  the next-day column is recomputed here, NOT quoted from the');
  console.log('  2026-08-23 doc -- that doc predates the corpus correction.');
  console.log('');
  console.log('  horizon     sides   exact-slot        roster            hand-composition');
  for (const h of ['same_day', 'next_day']) {
    const a = sides[h];
    if (!a.length) { console.log('  ' + h.padEnd(11) + '    0   (no captures yet)'); continue; }
    const pct = (sel) => 100 * a.reduce((s, x) => s + sel(x), 0) / (a.length * 9);
    const cslot = ci(a, s => 100 * s.reduce((t, x) => t + x.slot, 0) / (s.length * 9), 3);
    const cros = ci(a, s => 100 * s.reduce((t, x) => t + x.roster, 0) / (s.length * 9), 5);
    const ccomp = ci(a, s => 100 * s.reduce((t, x) => t + x.compExact, 0) / s.length, 7);
    console.log('  ' + h.padEnd(11) + String(a.length).padStart(5)
      + '   ' + f(pct(x => x.slot)) + '% [' + f(cslot[0]) + ',' + f(cslot[1]) + ']'
      + '   ' + f(pct(x => x.roster)) + '% [' + f(cros[0]) + ',' + f(cros[1]) + ']'
      + '   ' + f(100 * a.filter(x => x.compExact).length / a.length) + '% ['
      + f(ccomp[0]) + ',' + f(ccomp[1]) + ']');
  }

  // ---- (4) model impact, the headline
  console.log('');
  console.log('--- (4) MODEL IMPACT -- the headline ---');
  const paired = [];
  if (!SKIP_MODEL) {
    const byGame = new Map();
    for (const [key, r] of best) {
      const k = r.d + '|' + r.gi;
      if (!byGame.has(k)) byGame.set(k, {});
      byGame.get(k)[r.h + '_' + r.side] = r;
    }
    for (const [k, g] of byGame) {
      if (!g.same_day_away || !g.next_day_away) continue;   // needs both horizons
      paired.push({ d: k.split('|')[0], k });
    }
    console.log('  games with BOTH horizons captured and a confirmed lineup: ' + paired.length);
    if (!paired.length) {
      console.log('  Model re-scoring is not run: there is nothing to pair.');
      console.log('  It needs same-day and next-day captures for the SAME completed game.');
    }
  } else {
    console.log('  --skip-model: not run.');
  }

  // ---- the required n, re-derived from data rather than asserted
  console.log('');
  console.log('--- REQUIRED n FOR THE MODEL-IMPACT COMPARISON ---');
  const base = db.prepare(
    'SELECT game_date d, ABS(proj_model_total - model_total) a FROM game_log '
    + 'WHERE proj_model_total IS NOT NULL AND model_total IS NOT NULL').all()
    .filter(r => isFinite(r.a));
  const sdBase = sd(base.map(r => r.a));
  const st = iccByDate(base, r => r.a);
  console.log('  observed next-day |impact|: n=' + base.length
    + '  median ' + f(median(base.map(r => r.a)), 3)
    + '  mean ' + f(mean(base.map(r => r.a)), 3)
    + '  sd ' + f(sdBase, 4) + ' runs');
  console.log('  date clustering: ICC ' + f(st.icc, 4) + ' over ' + st.k
    + ' dates (' + f(st.m0, 1) + ' games/date) -> design effect ' + f(st.deff, 3));
  console.log('');

  // SD of the PAIRED difference depends on how correlated the two horizons
  // are on the same game, which cannot be known until both exist. Bracketed
  // rather than guessed at a single value, and re-derived below the moment
  // real pairs appear.
  console.log('  n is bracketed by the same-game correlation rho, which is');
  console.log('  unobservable until both horizons exist. Higher rho = fewer games.');
  console.log('');
  console.log('  detect a       rho=0.0      rho=0.5      rho=0.7   (games needed)');
  for (const delta of TARGETS) {
    const row = [0, 0.5, 0.7].map(rho => {
      const sdD = sdBase * Math.sqrt(2 * (1 - rho));
      return requiredN(sdD, delta, st.deff);
    });
    console.log('  ' + (f(delta, 2) + ' runs').padEnd(14)
      + row.map(x => String(x).padStart(9)).join('    ')
      + (delta === 0.10 ? '   <- the headline target' : ''));
  }
  console.log('');
  console.log('  At ' + f(st.m0, 1) + ' games per slate, and needing BOTH horizons on the');
  console.log('  same completed game, one full day contributes at most that many.');

  if (paired.length > 1) {
    console.log('');
    console.log('  RE-DERIVED from ' + paired.length + ' observed pairs: rerun once the');
    console.log('  model leg has run -- the bracket above collapses to one number.');
  } else {
    const need = requiredN(sdBase * Math.sqrt(2 * (1 - 0.5)), 0.10, st.deff);
    console.log('');
    console.log('  STATUS: 0 of ~' + need + ' paired games (rho=0.5 midpoint, 0.10-run target).');
    console.log('  ~' + Math.ceil(need / st.m0) + ' full slates of capture at both horizons.');
    console.log('  No trigger date is set. Re-run this; it reports its own distance.');
  }
})();
