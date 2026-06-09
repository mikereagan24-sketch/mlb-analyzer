#!/usr/bin/env node
'use strict';

// Total-vs-line backtest. READ-ONLY.
//
// For each graded game with a stored market_total, derives the model's
// pick (OVER if model_total > market_total, UNDER if model_total <
// market_total, no pick if equal) and grades it against actual_total.
//
// Reports WIN RATE and units, OVERALL plus BUCKETED:
//   - by edge size:   |model_total - market_total|
//   - by side:        model-OVER picks vs model-UNDER picks
//
// Two price regimes side by side:
//   - "actual" — uses game_log.over_price / under_price (real Vegas
//     prices captured at odds-job time). Authoritative.
//   - "@-110" — assumes -110 both ways. Useful as a comparable
//     baseline since some books skew over-juiced.
//
// Push rule: actual_total === market_total → no win, no loss; treated
// as 0 units and excluded from win% denominator.
//
// Buckets with n < --min-bucket (default 30) get [LOW SAMPLE].
//
// USAGE
//   node scripts/total-vs-line-backtest.js
//   node scripts/total-vs-line-backtest.js --from 2026-05-30   # v6 only
//   node scripts/total-vs-line-backtest.js --json out.json

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ------------------------------------------------------------ tunables
// Edge-magnitude bucket edges (inclusive low, exclusive high). The
// top bucket is open-ended.
const EDGE_BUCKETS = [
  { label: '< 0.5',    lo: 0,    hi: 0.5 },
  { label: '0.5–1.0',  lo: 0.5,  hi: 1.0 },
  { label: '1.0–1.5',  lo: 1.0,  hi: 1.5 },
  { label: '1.5–2.5',  lo: 1.5,  hi: 2.5 },
  { label: '> 2.5',    lo: 2.5,  hi: +Infinity },
];

// Cohort epochs (services/jobs.js:822-841). Printed in the header.
const COHORT_EDGES = [
  { name: 'v6',           from: '2026-05-30' },
  { name: 'v5',           from: '2026-05-20' },
  { name: 'v4',           from: '2026-05-12' },
  { name: 'v3',           from: '2026-04-24' },
  { name: 'v3-pretuning', from: '0000-00-00' },
];

// ------------------------------------------------------------ CLI
function parseArgs(argv) {
  const out = { from: null, to: null, minBucket: 30, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from' && argv[i+1]) { out.from = argv[++i]; continue; }
    if (a === '--to'   && argv[i+1]) { out.to   = argv[++i]; continue; }
    if (a === '--min-bucket' && argv[i+1]) { out.minBucket = parseInt(argv[++i], 10); continue; }
    if (a === '--json' && argv[i+1]) { out.json = argv[++i]; continue; }
    if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/total-vs-line-backtest.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--min-bucket N] [--json out.json]');
      console.log('  --from        Restrict to game_date >= this (e.g. 2026-05-30 for v6 only).');
      console.log('  --to          Restrict to game_date <= this.');
      console.log('  --min-bucket  Flag buckets below this n as [LOW SAMPLE]. Default 30.');
      console.log('  --json        Write the full report as JSON.');
      process.exit(0);
    }
  }
  for (const k of ['from','to']) {
    if (out[k] && !/^\d{4}-\d{2}-\d{2}$/.test(out[k])) {
      console.error('error: --' + k + ' must be YYYY-MM-DD, got "' + out[k] + '"');
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.minBucket) || out.minBucket < 0) {
    console.error('error: --min-bucket must be a non-negative integer');
    process.exit(2);
  }
  return out;
}

// ------------------------------------------------------------ math
// American odds → $ profit on a $100 stake when this side wins.
// +X: stake $100, win X dollars. -Y: stake $100, win 100/Y * 100 = 10000/Y dollars.
// Returns null for nonsense input so callers can short-circuit.
function americanProfit(ml) {
  if (typeof ml !== 'number' || !Number.isFinite(ml) || ml === 0) return null;
  return ml > 0 ? ml : (100 * 100) / Math.abs(ml);
}
function pickBucket(buckets, value) {
  if (value == null || !Number.isFinite(value)) return null;
  for (const b of buckets) {
    if (value >= b.lo && value < b.hi) return b.label;
  }
  return null;
}
function cohortOf(gameDate) {
  for (const c of COHORT_EDGES) {
    if (gameDate >= c.from) return c.name;
  }
  return 'unknown';
}

// ------------------------------------------------------------ formatters
function pad(s, w)  { s = String(s); return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padL(s, w) { s = String(s); return s.length >= w ? s : ' '.repeat(w - s.length) + s; }
function fmtPct(p, digits) {
  if (p == null || !Number.isFinite(p)) return '  n/a';
  return (p * 100).toFixed(digits == null ? 1 : digits) + '%';
}
function fmtRoi(roi) {
  if (roi == null || !Number.isFinite(roi)) return '   n/a';
  const v = (roi * 100).toFixed(2);
  return (roi >= 0 ? '+' : '') + v + '%';
}
function fmtUnits(u) {
  if (u == null || !Number.isFinite(u)) return '   n/a';
  return (u >= 0 ? '+' : '') + u.toFixed(2);
}

// ------------------------------------------------------------ summarize
// Given a set of picks ({side: 'over'|'under', actual, market, edge,
// over_price, under_price}), produce {n, wins, losses, pushes, win%,
// units_actual, roi_actual, units_110, roi_110}.
function summarize(picks) {
  let wins = 0, losses = 0, pushes = 0;
  let unitsActual = 0, unitsAt110 = 0;
  // Counting only $100-stake equivalents — staking per pick assumed
  // flat at $100 to make the units number comparable across buckets.
  for (const p of picks) {
    const a = p.actual, m = p.market;
    if (a === m) { pushes++; continue; }
    const winSide = a > m ? 'over' : 'under';
    const won = winSide === p.side;
    if (won) {
      wins++;
      const ml = p.side === 'over' ? p.over_price : p.under_price;
      const prof = (typeof ml === 'number' && Number.isFinite(ml)) ? americanProfit(ml) : null;
      unitsActual += (prof == null ? 0 : prof);
      unitsAt110  += americanProfit(-110);
    } else {
      losses++;
      unitsActual += -100;
      unitsAt110  += -100;
    }
  }
  const decided = wins + losses;
  const stakedActual = decided * 100;        // pushes don't risk anything
  const stakedAt110  = decided * 100;
  return {
    n: picks.length,
    decided,
    wins, losses, pushes,
    win_pct:    decided > 0 ? wins / decided : null,
    units_actual: unitsActual,
    roi_actual: stakedActual > 0 ? unitsActual / stakedActual : null,
    units_at_110: unitsAt110,
    roi_at_110: stakedAt110 > 0 ? unitsAt110 / stakedAt110 : null,
  };
}

function printRow(label, s, lowSample) {
  console.log('  ' + pad(label, 14)
    + padL(s.n, 6)
    + padL(s.wins + '-' + s.losses + (s.pushes ? '-' + s.pushes : ''), 12)
    + padL(fmtPct(s.win_pct), 9)
    + padL(fmtRoi(s.roi_actual), 12)
    + padL(fmtUnits(s.units_actual), 14)
    + padL(fmtRoi(s.roi_at_110), 12)
    + '  ' + (lowSample ? '[LOW SAMPLE]' : ''));
}
function printTable(title, header, rows) {
  console.log(title);
  console.log('  ' + pad('bucket', 14) + padL('n', 6) + padL('W-L(-P)', 12)
    + padL('win%', 9) + padL('ROI@real', 12) + padL('units@$100', 14) + padL('ROI@-110', 12) + '  flag');
  console.log('  ' + '-'.repeat(82));
  for (const [label, s, low] of rows) printRow(label, s, low);
  console.log('');
}

// ------------------------------------------------------------ DB open
const DB_PATH = process.env.DB_PATH
  || (fs.existsSync('/data/mlb.db') ? '/data/mlb.db' : path.join(__dirname, '..', 'data', 'mlb.db'));
if (!fs.existsSync(DB_PATH)) {
  console.error('DB not found at ' + DB_PATH);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

// ------------------------------------------------------------ main
function main() {
  const args = parseArgs(process.argv.slice(2));

  const where = [
    "home_score IS NOT NULL", "away_score IS NOT NULL",
    "model_total IS NOT NULL", "market_total IS NOT NULL",
  ];
  const bindings = [];
  if (args.from) { where.push('game_date >= ?'); bindings.push(args.from); }
  if (args.to)   { where.push('game_date <= ?'); bindings.push(args.to); }
  const rows = db.prepare(
      "SELECT game_date, game_id, home_team, away_team, "
    + "       model_total, market_total, over_price, under_price, "
    + "       (away_score + home_score) AS actual_total "
    + "FROM game_log WHERE " + where.join(' AND ') + " ORDER BY game_date, game_id"
  ).all(...bindings);

  // Build pick list. Drop ties (model_total === market_total) — no
  // disagreement, no pick. That preserves the comparability of the
  // "edge >= 0" buckets without inserting a 0-edge non-pick.
  const picks = [];
  for (const r of rows) {
    if (r.model_total === r.market_total) continue;
    const side = r.model_total > r.market_total ? 'over' : 'under';
    const edge = Math.abs(r.model_total - r.market_total);
    picks.push({
      game_date: r.game_date, game_id: r.game_id,
      home_team: r.home_team, away_team: r.away_team,
      model_total: r.model_total, market_total: r.market_total,
      actual: r.actual_total,
      market: r.market_total,
      over_price: r.over_price, under_price: r.under_price,
      side, edge,
    });
  }

  // ---- Header
  console.log('TOTAL-vs-LINE BACKTEST');
  console.log('Pick: OVER if model_total > market_total, UNDER if <. Push on equal');
  console.log('(not picked). ROI@real uses stored game_log.over_price / under_price;');
  console.log('ROI@-110 is the same picks priced flat at -110 both ways for comparability.');
  console.log('');
  console.log('Corpus:');
  console.log('  graded games with market_total: ' + rows.length
    + (args.from || args.to ? ' (filtered to ' + (args.from || '…') + ' .. ' + (args.to || '…') + ')' : ''));
  console.log('  ties (model = market, no pick): ' + (rows.length - picks.length));
  console.log('  decided picks (after ties):     ' + picks.length);
  if (picks.length) {
    const dMin = picks[0].game_date, dMax = picks[picks.length - 1].game_date;
    console.log('  date range:                     ' + dMin + ' .. ' + dMax);
    const cohorts = {};
    for (const p of picks) {
      const c = cohortOf(p.game_date);
      cohorts[c] = (cohorts[c] || 0) + 1;
    }
    const parts = [];
    for (const k of ['v6','v5','v4','v3','v3-pretuning','unknown']) {
      if (cohorts[k]) parts.push(k + '=' + cohorts[k]);
    }
    console.log('  cohorts:                        ' + parts.join(', '));
    console.log('  NOTE: older-cohort games ran under different model constants.');
    console.log('         Use --from 2026-05-30 to restrict to v6 only.');
  }
  console.log('  min bucket sample for high-confidence: ' + args.minBucket);
  console.log('');

  // ---- OVERALL
  console.log('OVERALL');
  printTable('', null, [['ALL', summarize(picks), false]]);

  // ---- BY SIDE (over vs under) — the model's +0.81 absolute residual
  // bias means it leans slightly under reality, so model-OVER and
  // model-UNDER picks may not have the same hit rate against the line.
  const overs  = picks.filter(p => p.side === 'over');
  const unders = picks.filter(p => p.side === 'under');
  printTable('BY SIDE (model-over vs model-under):', null, [
    ['Model OVER',  summarize(overs),  overs.length  < args.minBucket],
    ['Model UNDER', summarize(unders), unders.length < args.minBucket],
  ]);

  // ---- BY EDGE
  const byEdge = new Map();
  for (const b of EDGE_BUCKETS) byEdge.set(b.label, []);
  for (const p of picks) {
    const k = pickBucket(EDGE_BUCKETS, p.edge);
    if (k) byEdge.get(k).push(p);
  }
  const edgeRows = EDGE_BUCKETS.map(b => {
    const set = byEdge.get(b.label) || [];
    return [b.label, summarize(set), set.length < args.minBucket];
  });
  printTable('BY EDGE SIZE (|model_total - market_total|):', null, edgeRows);

  // ---- BY EDGE × SIDE (per-bucket over vs under) — answers whether
  // a big-edge model-OVER pick has historically won, separate from
  // a big-edge model-UNDER pick. Most actionable cross-tab.
  console.log('BY EDGE × SIDE (each bucket split into Over picks and Under picks):');
  console.log('  ' + pad('edge', 10) + pad('side', 8) + padL('n', 6) + padL('W-L(-P)', 12)
    + padL('win%', 9) + padL('ROI@real', 12) + padL('units@$100', 14) + padL('ROI@-110', 12) + '  flag');
  console.log('  ' + '-'.repeat(86));
  for (const b of EDGE_BUCKETS) {
    const set = byEdge.get(b.label) || [];
    const o = set.filter(p => p.side === 'over');
    const u = set.filter(p => p.side === 'under');
    for (const [label, side, picksSet] of [['', 'OVER', o], ['', 'UNDER', u]]) {
      const s = summarize(picksSet);
      const isFirst = side === 'OVER';
      const low = picksSet.length < args.minBucket;
      console.log('  ' + pad(isFirst ? b.label : '', 10)
        + pad(side, 8)
        + padL(s.n, 6)
        + padL(s.wins + '-' + s.losses + (s.pushes ? '-' + s.pushes : ''), 12)
        + padL(fmtPct(s.win_pct), 9)
        + padL(fmtRoi(s.roi_actual), 12)
        + padL(fmtUnits(s.units_actual), 14)
        + padL(fmtRoi(s.roi_at_110), 12)
        + '  ' + (low ? '[LOW SAMPLE]' : ''));
    }
  }
  console.log('');

  // ---- Interpretation hints
  console.log('READING THIS REPORT:');
  console.log('  - The break-even win% at -110 is 52.38%. Anything above is profitable');
  console.log('    at -110; ROI@real shows what the actual stored prices produced.');
  console.log('  - The big-edge cell (> 2.5) is the most decision-relevant — those are');
  console.log('    the picks where the model disagrees most loudly with Vegas. If win% there');
  console.log('    sits below 52.38%, the model is most wrong exactly where it commits most.');
  console.log('  - The BY SIDE table answers whether the model picks better as an OVER');
  console.log('    voice or an UNDER voice (or symmetric).');
  console.log('  - Buckets flagged [LOW SAMPLE] are noise; treat single-cell extremes');
  console.log('    in those rows with skepticism.');

  // ---- JSON dump
  if (args.json) {
    const dump = {
      args,
      corpus: {
        graded_with_market: rows.length,
        ties: rows.length - picks.length,
        decided_picks: picks.length,
        date_range: picks.length ? [picks[0].game_date, picks[picks.length-1].game_date] : null,
        cohorts: (() => {
          const o = {}; for (const p of picks) { const c = cohortOf(p.game_date); o[c] = (o[c] || 0) + 1; } return o;
        })(),
      },
      overall: summarize(picks),
      by_side: { over: summarize(overs), under: summarize(unders) },
      by_edge: EDGE_BUCKETS.map(b => ({
        bucket: b.label, ...summarize(byEdge.get(b.label) || []),
      })),
      by_edge_side: EDGE_BUCKETS.map(b => {
        const set = byEdge.get(b.label) || [];
        return {
          bucket: b.label,
          over:  summarize(set.filter(p => p.side === 'over')),
          under: summarize(set.filter(p => p.side === 'under')),
        };
      }),
    };
    fs.writeFileSync(args.json, JSON.stringify(dump, null, 2));
    console.log('');
    console.log('Wrote ' + args.json);
  }
}

main();
