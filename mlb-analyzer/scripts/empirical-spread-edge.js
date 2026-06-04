#!/usr/bin/env node
'use strict';

// Empirical spread-line edge analyzer (CLI).
//
// Thin shell around services/empirical-spread-edge.js — same module
// jobs.js uses to generate production empirical_spread_signals rows.
// Running this script prints the same analysis to stdout for ad-hoc
// inspection.
//
// ⚠ DIRECTIONAL ONLY ⚠
//   See module-level comment in services/empirical-spread-edge.js.
//
// USAGE
//   node scripts/empirical-spread-edge.js
//   node scripts/empirical-spread-edge.js --date 2026-06-04
//   node scripts/empirical-spread-edge.js --json out.json --min-sample 80
//
// CONSTRAINTS
//   READ-ONLY against the DB. Safe to run against prod.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const eng = require('../services/empirical-spread-edge');

// Number of top opportunities to print across all games.
const TOP_N = 5;

// ------------------------------------------------------------ CLI args
function parseArgs(argv) {
  const out = { date: null, json: null, minSample: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date' && argv[i+1]) { out.date = argv[++i]; continue; }
    if (a === '--json' && argv[i+1]) { out.json = argv[++i]; continue; }
    if (a === '--min-sample' && argv[i+1]) { out.minSample = parseInt(argv[++i], 10); continue; }
    if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/empirical-spread-edge.js [--date YYYY-MM-DD] [--json out.json] [--min-sample N]');
      console.log('  --date        Target slate date. Defaults to tomorrow in America/Los_Angeles.');
      console.log('  --json        Optional path; writes full report as JSON.');
      console.log('  --min-sample  Cell size threshold for [LOW SAMPLE] flag and Top Opportunities filter. Default 50.');
      process.exit(0);
    }
  }
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) {
    console.error('error: --date must be YYYY-MM-DD, got "' + out.date + '"');
    process.exit(2);
  }
  if (!Number.isFinite(out.minSample) || out.minSample < 0) {
    console.error('error: --min-sample must be a non-negative integer');
    process.exit(2);
  }
  return out;
}

// Default date = tomorrow in PT, matching the wOBA / framing / FRV /
// Kalshi-snapshot timezone convention.
function tomorrowPtIso() {
  const t = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return t.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// ------------------------------------------------------------ formatters
function fmtMl(ml) {
  if (ml == null || !Number.isFinite(ml)) return ' n/a';
  return (ml > 0 ? '+' : '') + ml;
}
function fmtPct(p, digits) {
  // p is in 0..1 OR a percentage-point value depending on caller. The
  // module emits *_pct in percentage points; the CLI also has the raw
  // 0..1 home_win_prob from the module. Detect by magnitude: anything
  // <= 1 is treated as a 0..1 prob, otherwise as a pp value.
  if (p == null || !Number.isFinite(p)) return '  n/a';
  const v = Math.abs(p) <= 1 ? p * 100 : p;
  return v.toFixed(digits == null ? 1 : digits) + '%';
}
function fmtEdge(pp) {
  if (pp == null || !Number.isFinite(pp)) return '  n/a';
  return (pp >= 0 ? '+' : '') + pp.toFixed(1) + 'pp';
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
  const date = args.date || tomorrowPtIso();

  const { signals, cellIndex } = eng.generateEmpiricalSpreadSignals(db, date);

  console.log('EMPIRICAL SPREAD EDGE ANALYSIS — ' + date);
  console.log('⚠ DIRECTIONAL ONLY — empirical sample is '
    + cellIndex.totalGraded + ' graded games across 6 cells ⚠');
  console.log('Min sample threshold: ' + args.minSample + ' (cells below are marked [LOW SAMPLE])');
  console.log('');

  const allOpps = [];
  const perGame = [];

  if (!signals.length) {
    console.log('No games with Kalshi spread coverage found for ' + date + '.');
  }

  for (const sig of signals) {
    const lowSample = sig.cell_sample_size < args.minSample;
    console.log(sig.game_id
      + ' | home win prob ' + fmtPct(sig.home_win_prob)
      + ' | total ' + sig.model_total.toFixed(2)
      + ' | cell: ' + sig.cell_label + ' (n=' + sig.cell_sample_size + ')'
      + (lowSample ? ' [LOW SAMPLE]' : ''));

    for (const p of sig.predictions) {
      console.log('  ' + p.spread_team + ' -' + p.spread_line.toFixed(1)
        + ' yes_ask ' + fmtMl(p.kalshi_yes_ask_ml)
        + ' (implied ' + fmtPct(p.implied_pct) + ')'
        + ' | empirical ' + fmtPct(p.empirical_pct)
        + ' | edge ' + fmtEdge(p.edge_pp)
        + (lowSample ? ' [LOW SAMPLE]' : ''));
      if (!lowSample) {
        allOpps.push({ ...p, game_id: sig.game_id });
      }
    }
    perGame.push({
      game_id: sig.game_id,
      game_date: sig.game_date,
      away_team: sig.away_team,
      home_team: sig.home_team,
      home_win_prob: sig.home_win_prob,
      model_total: sig.model_total,
      cell: sig.cell_label,
      cell_n: sig.cell_sample_size,
      low_sample: lowSample,
      lines: sig.predictions,
    });
    console.log('');
  }

  allOpps.sort((a, b) => b.edge_pp - a.edge_pp);
  const top = allOpps.slice(0, TOP_N);
  console.log('TOP OPPORTUNITIES (cell n >= ' + args.minSample + ', sorted by edge desc):');
  if (!top.length) {
    console.log('  (none — no spreads cleared the sample-size filter)');
  } else {
    let i = 1;
    for (const r of top) {
      console.log('  ' + i + '. ' + r.game_id
        + ' ' + r.spread_team + ' -' + r.spread_line.toFixed(1)
        + ' ' + fmtMl(r.kalshi_yes_ask_ml)
        + ' | edge ' + fmtEdge(r.edge_pp)
        + ' | empirical ' + fmtPct(r.empirical_pct)
        + ' vs implied ' + fmtPct(r.implied_pct));
      i++;
    }
  }
  console.log('');

  console.log('CELL SAMPLE SIZES:');
  for (const k of eng.ALL_CELLS) {
    const n = (cellIndex.cells.get(k) || []).length;
    console.log('  ' + k + ': n=' + n);
  }
  console.log('');
  if (cellIndex.skipped) {
    console.log('(' + cellIndex.skipped + ' graded games skipped — missing model fields)');
  }

  if (args.json) {
    const cellSummary = {};
    for (const k of eng.ALL_CELLS) {
      const m = cellIndex.cells.get(k) || [];
      cellSummary[k] = { n: m.length };
    }
    const payload = {
      date,
      min_sample: args.minSample,
      total_graded: cellIndex.totalGraded,
      skipped_graded: cellIndex.skipped,
      cells: cellSummary,
      games: perGame,
      top_opportunities: top,
    };
    fs.writeFileSync(args.json, JSON.stringify(payload, null, 2));
    console.log('Wrote ' + args.json);
  }
}

main();
