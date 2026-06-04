#!/usr/bin/env node
'use strict';

// Empirical spread-line edge analyzer.
//
// For each game on the target date that has Kalshi spread markets:
//   1. Compute the model's no-vig home win probability from
//      model_home_ml + model_away_ml.
//   2. Bucket the game into one of 6 cells (3 win-prob buckets × 2
//      total buckets).
//   3. Pull every historical graded game from game_log that falls in
//      the SAME cell, and use the empirical distribution of margins
//      (home_score - away_score) as the reference distribution.
//   4. For each Kalshi spread market (1.5 / 2.5 / 3.5 lines per side):
//      compute P(actual margin clears the line) from history,
//      compare to Kalshi's implied probability (yes_ask_dollars),
//      report edge = empirical_p - implied_p.
//   5. Flag cells with sample below --min-sample threshold.
//
// ⚠ DIRECTIONAL ONLY ⚠
//   The empirical sample is the in-season game_log corpus. With 6 cells
//   splitting a few hundred graded games, individual cells will be
//   sparse (~50-150 each). Treat results as a hypothesis-generator,
//   not a betting trigger.
//
// USAGE
//   node scripts/empirical-spread-edge.js
//   node scripts/empirical-spread-edge.js --date 2026-06-04
//   node scripts/empirical-spread-edge.js --json out.json --min-sample 80
//
// CONSTRAINTS
//   READ-ONLY against the DB. No new tables, no writes. Safe to run
//   against prod.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ------------------------------------------------------------ tunables
// Win-probability bucket boundaries (home win prob, no-vig). Cells:
//   < WP_BALANCED_LOW           = Underdog home
//   [WP_BALANCED_LOW, WP_HIGH)  = Balanced / slight favorite home
//   >= WP_HIGH                  = Strong favorite home
const WP_BALANCED_LOW = 0.500;
const WP_HIGH         = 0.575;

// Total-bucket boundary (model_total). Below = low, at/above = high.
const TOTAL_THRESHOLD = 8.5;

// Spread lines to surface per side. Kalshi publishes 1.5..9.5 in 1-run
// steps; the brief focuses on the three near-the-money rungs.
const SHOW_LINES = [1.5, 2.5, 3.5];

// Top-N actionable opportunities to print across all games.
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

// Default date = tomorrow's date anchored to America/Los_Angeles, to
// match the wOBA / framing / FRV / Kalshi-snapshot timezone convention
// the rest of the project uses. en-CA gives YYYY-MM-DD.
function tomorrowPtIso() {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// ------------------------------------------------------------ math
// American odds → implied probability. Mirrors the standard formula
// used elsewhere in this project (services/kalshi.js probToAmerican
// is the inverse). Returns null for non-finite input so callers can
// short-circuit on bad rows.
function americanToProb(ml) {
  if (typeof ml !== 'number' || !Number.isFinite(ml) || ml === 0) return null;
  return ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);
}

// No-vig home win probability from a moneyline pair. Strip the
// overround by normalizing the two raw implied probs. Returns null
// if either side is missing.
function noVigHomeProb(homeMl, awayMl) {
  const pH = americanToProb(homeMl);
  const pA = americanToProb(awayMl);
  if (pH == null || pA == null) return null;
  const sum = pH + pA;
  if (!(sum > 0)) return null;
  return pH / sum;
}

// Format a signed American odds value with explicit + on positives.
function fmtMl(ml) {
  if (ml == null || !Number.isFinite(ml)) return ' n/a';
  return (ml > 0 ? '+' : '') + ml;
}

function fmtPct(p, digits) {
  if (p == null || !Number.isFinite(p)) return '  n/a';
  return (p * 100).toFixed(digits == null ? 1 : digits) + '%';
}

function fmtEdge(e) {
  if (e == null || !Number.isFinite(e)) return '  n/a';
  const v = e * 100;
  return (v >= 0 ? '+' : '') + v.toFixed(1) + 'pp';
}

// ------------------------------------------------------------ cells
// Cell key shape: "wp/total" so the index is human-readable in logs.
function cellKey(homeWinProb, modelTotal) {
  let wp;
  if (homeWinProb < WP_BALANCED_LOW) wp = 'Underdog home';
  else if (homeWinProb < WP_HIGH)    wp = 'Balanced';
  else                                wp = 'Strong fav';
  const tot = modelTotal < TOTAL_THRESHOLD ? 'Low total' : 'High total';
  return wp + ' / ' + tot;
}

// Full ordered cell list, for predictable summary output.
const ALL_CELLS = [
  'Underdog home / Low total',
  'Underdog home / High total',
  'Balanced / Low total',
  'Balanced / High total',
  'Strong fav / Low total',
  'Strong fav / High total',
];

// ------------------------------------------------------------ DB open
const DB_PATH = process.env.DB_PATH
  || (fs.existsSync('/data/mlb.db') ? '/data/mlb.db' : path.join(__dirname, '..', 'data', 'mlb.db'));

if (!fs.existsSync(DB_PATH)) {
  console.error('DB not found at ' + DB_PATH);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

// ------------------------------------------------------------ build cell index from history
// One pass over every graded game with a valid model line. Bucket each
// and stash the actual margin so we can compute tail probabilities
// without re-querying per spread.
function buildCellIndex() {
  const rows = db.prepare(
      "SELECT game_date, game_id, model_home_ml, model_away_ml, model_total, home_score, away_score "
    + "FROM game_log "
    + "WHERE home_score IS NOT NULL AND away_score IS NOT NULL "
    + "  AND model_home_ml IS NOT NULL AND model_away_ml IS NOT NULL "
    + "  AND model_total IS NOT NULL"
  ).all();
  const cells = new Map();
  for (const c of ALL_CELLS) cells.set(c, []);
  let skipped = 0;
  for (const r of rows) {
    const wp = noVigHomeProb(r.model_home_ml, r.model_away_ml);
    if (wp == null) { skipped++; continue; }
    if (!Number.isFinite(r.model_total)) { skipped++; continue; }
    const margin = r.home_score - r.away_score;
    const key = cellKey(wp, r.model_total);
    cells.get(key).push(margin);
  }
  return { cells, totalGraded: rows.length, skipped };
}

// Tail probability helpers — operate on the cell's margin array.
// strict > L (not >=) because Kalshi spread lines are half-runs;
// integer margins clear or miss cleanly. Returns null on empty cell.
function pMarginGreater(margins, L) {
  if (!margins || !margins.length) return null;
  let hit = 0;
  for (let i = 0; i < margins.length; i++) if (margins[i] > L) hit++;
  return hit / margins.length;
}
function pMarginLess(margins, L) {
  if (!margins || !margins.length) return null;
  let hit = 0;
  for (let i = 0; i < margins.length; i++) if (margins[i] < -L) hit++;
  return hit / margins.length;
}

// ------------------------------------------------------------ main
function main() {
  const args = parseArgs(process.argv.slice(2));
  const date = args.date || tomorrowPtIso();

  const index = buildCellIndex();

  // Tonight's slate — only games that have Kalshi spread coverage.
  // (Games without spread markets are out of scope for this report.)
  const games = db.prepare(
      "SELECT g.game_date, g.game_id, g.away_team, g.home_team, "
    + "       g.model_home_ml, g.model_away_ml, g.model_total "
    + "FROM game_log g "
    + "WHERE g.game_date = ? "
    + "  AND g.model_home_ml IS NOT NULL AND g.model_away_ml IS NOT NULL "
    + "  AND g.model_total IS NOT NULL "
    + "  AND EXISTS (SELECT 1 FROM kalshi_spread_markets k "
    + "              WHERE k.game_date = g.game_date AND k.game_id = g.game_id) "
    + "ORDER BY g.game_id"
  ).all(date);

  const getSpreads = db.prepare(
      "SELECT spread_team, spread_line, yes_ask_dollars, yes_ask_ml, no_ask_ml "
    + "FROM kalshi_spread_markets "
    + "WHERE game_date = ? AND game_id = ? "
    + "  AND spread_line IN (1.5, 2.5, 3.5) "
    + "ORDER BY spread_team, spread_line"
  );

  console.log('EMPIRICAL SPREAD EDGE ANALYSIS — ' + date);
  console.log('⚠ DIRECTIONAL ONLY — empirical sample is '
    + index.totalGraded + ' graded games across 6 cells ⚠');
  console.log('Min sample threshold: ' + args.minSample + ' (cells below are marked [LOW SAMPLE])');
  console.log('');

  const allOpps = []; // for the cross-game Top Opportunities section
  const perGame = []; // for the JSON dump

  if (!games.length) {
    console.log('No games with Kalshi spread coverage found for ' + date + '.');
  }

  for (const g of games) {
    const wp = noVigHomeProb(g.model_home_ml, g.model_away_ml);
    if (wp == null) continue;
    const key = cellKey(wp, g.model_total);
    const margins = index.cells.get(key) || [];
    const n = margins.length;
    const lowSample = n < args.minSample;

    console.log(g.game_id
      + ' | home win prob ' + fmtPct(wp)
      + ' | total ' + g.model_total.toFixed(2)
      + ' | cell: ' + key + ' (n=' + n + ')'
      + (lowSample ? ' [LOW SAMPLE]' : ''));

    const spreads = getSpreads.all(g.game_date, g.game_id);
    const rows = [];
    for (const s of spreads) {
      // Implied probability comes from yes_ask_dollars (Kalshi's raw
      // 0..1 price). yes_ask_ml is the same number expressed as
      // American — kept for the display line per the brief format.
      const implied = (typeof s.yes_ask_dollars === 'number' && Number.isFinite(s.yes_ask_dollars))
        ? s.yes_ask_dollars : americanToProb(s.yes_ask_ml);
      // Direction: spread_team is the team this YES side is FOR.
      // If they're the home team tonight, "they win by > L" means
      // historical margin > L. If they're the away team, it means
      // historical margin < -L (away side dominating).
      let empirical = null;
      if (s.spread_team === g.home_team) {
        empirical = pMarginGreater(margins, s.spread_line);
      } else if (s.spread_team === g.away_team) {
        empirical = pMarginLess(margins, s.spread_line);
      } else {
        // Spread_team doesn't match either side — silently skip
        // (defensive; getKalshiMlbSpreads already filters these out
        // before insert, but belt-and-suspenders here).
        continue;
      }
      const edge = (empirical != null && implied != null) ? empirical - implied : null;
      rows.push({
        game_id: g.game_id,
        spread_team: s.spread_team,
        spread_line: s.spread_line,
        yes_ask_ml: s.yes_ask_ml,
        implied_prob: implied,
        empirical_prob: empirical,
        edge,
        cell: key,
        cell_n: n,
        low_sample: lowSample,
      });
    }

    rows.sort((a, b) => {
      if (a.edge == null && b.edge == null) return 0;
      if (a.edge == null) return 1;
      if (b.edge == null) return -1;
      return b.edge - a.edge;
    });

    for (const r of rows) {
      console.log('  ' + r.spread_team + ' -' + r.spread_line.toFixed(1)
        + ' yes_ask ' + fmtMl(r.yes_ask_ml)
        + ' (implied ' + fmtPct(r.implied_prob) + ')'
        + ' | empirical ' + fmtPct(r.empirical_prob)
        + ' | edge ' + fmtEdge(r.edge)
        + (r.low_sample ? ' [LOW SAMPLE]' : ''));
      if (!r.low_sample && r.edge != null) allOpps.push(r);
    }

    perGame.push({
      game_id: g.game_id,
      game_date: g.game_date,
      away_team: g.away_team,
      home_team: g.home_team,
      home_win_prob: wp,
      model_total: g.model_total,
      cell: key,
      cell_n: n,
      low_sample: lowSample,
      lines: rows,
    });

    console.log('');
  }

  // ---- TOP OPPORTUNITIES
  allOpps.sort((a, b) => b.edge - a.edge);
  const top = allOpps.slice(0, TOP_N);
  console.log('TOP OPPORTUNITIES (cell n >= ' + args.minSample + ', sorted by edge desc):');
  if (!top.length) {
    console.log('  (none — no spreads cleared the sample-size filter)');
  } else {
    let i = 1;
    for (const r of top) {
      console.log('  ' + i + '. ' + r.game_id
        + ' ' + r.spread_team + ' -' + r.spread_line.toFixed(1)
        + ' ' + fmtMl(r.yes_ask_ml)
        + ' | edge ' + fmtEdge(r.edge)
        + ' | empirical ' + fmtPct(r.empirical_prob)
        + ' vs implied ' + fmtPct(r.implied_prob));
      i++;
    }
  }
  console.log('');

  // ---- CELL SAMPLE SIZES
  console.log('CELL SAMPLE SIZES:');
  for (const k of ALL_CELLS) {
    const n = (index.cells.get(k) || []).length;
    console.log('  ' + k + ': n=' + n);
  }
  console.log('');
  if (index.skipped) {
    console.log('(' + index.skipped + ' graded games skipped — missing model fields)');
  }

  // ---- JSON dump
  if (args.json) {
    const cellSummary = {};
    for (const k of ALL_CELLS) {
      const m = index.cells.get(k) || [];
      cellSummary[k] = { n: m.length };
    }
    const payload = {
      date,
      min_sample: args.minSample,
      total_graded: index.totalGraded,
      skipped_graded: index.skipped,
      cells: cellSummary,
      games: perGame,
      top_opportunities: top,
    };
    fs.writeFileSync(args.json, JSON.stringify(payload, null, 2));
    console.log('Wrote ' + args.json);
  }
}

main();
