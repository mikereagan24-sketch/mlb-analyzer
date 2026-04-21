#!/usr/bin/env node
'use strict';

// Parameter sensitivity analysis: replay resolved bet_signals through a
// set of filter scenarios and report plays / wins / losses / ROI / P&L.
// Pulls signals from 2026-04-09 through today (inclusive) where outcome
// is 'win' or 'loss' and market_line is present. P&L is computed from
// market_line at $100/play — pushes are excluded from ROI denominators.
//
// USAGE:  node scripts/param-sensitivity.js
//         node scripts/param-sensitivity.js 2026-04-09 2026-04-30   # custom range

const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.RENDER && require('fs').existsSync('/data')
  ? '/data'
  : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'mlb.db');
const db = new Database(DB_PATH, { readonly: true });

const START = process.argv[2] || '2026-04-09';
const END   = process.argv[3] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const STAKE = 100;

// P&L at $100 stake for a single signal given its market_line and outcome.
// Pushes return 0. Null market_line callers are filtered out upstream.
function pnl(ml, outcome) {
  if (outcome === 'push') return 0;
  if (outcome === 'loss') return -STAKE;
  if (outcome === 'win') {
    if (ml == null) return 0;
    return ml > 0 ? STAKE * (ml / 100) : STAKE * (100 / Math.abs(ml));
  }
  return 0;
}

const rows = db.prepare(
  "SELECT game_date, game_id, signal_type, signal_side, signal_label, " +
  "       market_line, edge_pct, outcome " +
  "FROM bet_signals " +
  "WHERE game_date BETWEEN ? AND ? " +
  "  AND outcome IN ('win','loss') " +
  "  AND market_line IS NOT NULL"
).all(START, END);

if (!rows.length) {
  console.log('No resolved signals in [' + START + ' .. ' + END + ']');
  process.exit(0);
}

// Each scenario: { name, filter: (row) => bool }
const scenarios = [
  { name: 'Baseline (all resolved)',   filter: () => true },
  { name: 'Stars 2+',                  filter: r => r.signal_label !== '1★' },
  { name: 'Stars 3 only',              filter: r => r.signal_label === '3★' },
  { name: 'Edge > 20',                 filter: r => r.edge_pct != null && r.edge_pct > 20 },
  { name: 'Underdogs only (ml > 0)',   filter: r => r.market_line > 0 },
  { name: 'Favorites only (ml < 0)',   filter: r => r.market_line < 0 },
  { name: 'Unders only',               filter: r => r.signal_type === 'Total' && r.signal_side === 'under' },
  { name: 'Overs only',                filter: r => r.signal_type === 'Total' && r.signal_side === 'over' },
  { name: 'ML only',                   filter: r => r.signal_type === 'ML' },
  { name: 'Totals only',               filter: r => r.signal_type === 'Total' },
];

const results = scenarios.map(sc => {
  let plays = 0, wins = 0, losses = 0, totalPnl = 0;
  for (const r of rows) {
    if (!sc.filter(r)) continue;
    plays++;
    if (r.outcome === 'win') wins++;
    else if (r.outcome === 'loss') losses++;
    totalPnl += pnl(r.market_line, r.outcome);
  }
  const staked = (wins + losses) * STAKE;
  const roi = staked > 0 ? (totalPnl / staked) * 100 : 0;
  const winRate = plays > 0 ? (wins / plays) * 100 : 0;
  return { name: sc.name, plays, wins, losses, winRate, roi, pnl: totalPnl };
});

results.sort((a, b) => b.roi - a.roi);

const pad = (s, n, align) => {
  s = String(s);
  if (s.length >= n) return s.slice(0, n);
  return align === 'left' ? s + ' '.repeat(n - s.length) : ' '.repeat(n - s.length) + s;
};

console.log('\nParameter sensitivity: ' + START + ' .. ' + END);
console.log('Total resolved signals with market_line: ' + rows.length + '\n');
console.log(pad('Scenario', 32, 'left') + ' ' +
            pad('Plays', 7) + ' ' +
            pad('W',  5) + ' ' +
            pad('L',  5) + ' ' +
            pad('Win%', 7) + ' ' +
            pad('ROI%', 8) + ' ' +
            pad('P&L', 10));
console.log('-'.repeat(32 + 1 + 7 + 1 + 5 + 1 + 5 + 1 + 7 + 1 + 8 + 1 + 10));
for (const r of results) {
  console.log(
    pad(r.name, 32, 'left') + ' ' +
    pad(r.plays, 7) + ' ' +
    pad(r.wins, 5) + ' ' +
    pad(r.losses, 5) + ' ' +
    pad(r.winRate.toFixed(1), 7) + ' ' +
    pad(r.roi.toFixed(2), 8) + ' ' +
    pad('$' + r.pnl.toFixed(2), 10)
  );
}
console.log('');
