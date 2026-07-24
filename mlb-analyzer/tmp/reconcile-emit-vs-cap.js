// Reconciliation: emit-floor sweep (-7.74% net) vs edge-cap retro (+4.14% clean slice).
// Same populations, four grade columns: gross_close, net_close, gross_morning, net_morning.
'use strict';
const { db } = require('../db/schema');

function impliedP(ml) {
  const n = parseFloat(ml);
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? Math.abs(n)/(Math.abs(n)+100) : 100/(n+100);
}
function kalshiFee(C, contracts) {
  if (!(C > 0) || !(C < 1) || !(contracts > 0)) return 0;
  return Math.ceil(0.068 * C * (1 - C) * contracts * 100 - 1e-9) / 100;
}
function stakeFor(sig) {
  if (sig.signal_type === 'ML') {
    const line = parseFloat(sig.bet_line) || parseFloat(sig.market_line);
    if (isNaN(line) || line === 0) return 0;
    return line > 0 ? 10000/line : Math.abs(line);
  }
  return 110;
}

const sigs = db.prepare(
  "SELECT b.*, g.away_score, g.home_score, g.market_total, g.proj_market_total, " +
  "  g.market_away_ml, g.market_home_ml, g.over_price, g.under_price " +
  "FROM bet_signals b " +
  "LEFT JOIN game_log g ON g.game_date = b.game_date AND g.game_id = b.game_id " +
  "WHERE b.cohort = 'v6' AND b.outcome IS NOT NULL AND b.outcome != 'pending' " +
  "AND b.pnl IS NOT NULL AND b.edge_pct IS NOT NULL " +
  "AND b.contaminated_reason IS NULL"
).all();
console.log('v6 resolved bet_signals: ' + sigs.length);

function gradeSig(s) {
  const stake = stakeFor(s);
  const won = s.outcome === 'win';
  const push = s.outcome === 'push';
  const gross_close = push ? 0 : (won ? 100 : -stake);

  let C = null;
  if (s.signal_type === 'ML') {
    const line = parseFloat(s.bet_line) || parseFloat(s.market_line);
    C = impliedP(line);
  } else {
    const price = s.signal_side === 'over' ? s.over_price : s.under_price;
    C = price != null ? impliedP(price) : impliedP(-110);
  }
  let net_close = gross_close;
  if (C != null && stake > 0) {
    const contracts = stake / C;
    const fee = kalshiFee(C, contracts);
    net_close = push ? 0 : (won ? contracts - stake - fee : -stake - fee);
  }

  // Morning-line re-grade (Totals only — no proj_market_ml stored)
  let gross_morning = gross_close;
  let net_morning = net_close;
  if (s.signal_type === 'Total' && s.proj_market_total != null && s.away_score != null && s.home_score != null) {
    const actualTotal = s.away_score + s.home_score;
    const morningLine = Number(s.proj_market_total);
    const isOver = s.signal_side === 'over';
    const won2 = isOver ? actualTotal > morningLine : actualTotal < morningLine;
    const push2 = actualTotal === morningLine;
    gross_morning = push2 ? 0 : (won2 ? 100 : -stake);
    if (C != null && stake > 0) {
      const contracts = stake / C;
      const fee = kalshiFee(C, contracts);
      net_morning = push2 ? 0 : (won2 ? contracts - stake - fee : -stake - fee);
    }
  }
  return { stake, gross_close, net_close, gross_morning, net_morning };
}

function bandOf(e) {
  if (e < 0.005) return '<0.5pp';
  if (e < 0.01) return '0.5-1pp';
  if (e < 0.03) return '1-3pp';
  if (e < 0.06) return '3-6pp';
  if (e < 0.10) return '6-10pp';
  return '10pp+';
}

const bands = ['<0.5pp','0.5-1pp','1-3pp','3-6pp','6-10pp','10pp+'];
const types = ['ML','Total'];
const agg = {};
for (const t of types) for (const b of bands) agg[t+'/'+b] = { n:0, stake:0, gross_close:0, net_close:0, gross_morning:0, net_morning:0 };

let totalWithMorning = 0;
for (const s of sigs) {
  const e = Number(s.edge_pct);
  const b = bandOf(e);
  const key = s.signal_type + '/' + b;
  if (!agg[key]) continue;
  const g = gradeSig(s);
  agg[key].n++;
  agg[key].stake += g.stake;
  agg[key].gross_close += g.gross_close;
  agg[key].net_close += g.net_close;
  agg[key].gross_morning += g.gross_morning;
  agg[key].net_morning += g.net_morning;
  if (s.signal_type === 'Total' && s.proj_market_total != null) totalWithMorning++;
}

const totalSigsTotal = sigs.filter(s => s.signal_type === 'Total').length;
console.log('Total signals with proj_market_total present: ' + totalWithMorning + '/' + totalSigsTotal);
console.log();

function roi(pnl, stake) { return stake > 0 ? (100 * pnl / stake) : 0; }
function s(v, d) { return (v >= 0 ? '+' : '') + v.toFixed(d); }

console.log('=== v6 signals per band × type — 4-column reconciliation ===');
console.log('band       n    stake   gross_close     net_close        gross_morning   net_morning');
for (const t of types) {
  console.log('--- ' + t + ' ---');
  for (const b of bands) {
    const a = agg[t+'/'+b];
    if (a.n === 0) continue;
    console.log('  ' + b.padEnd(9) + String(a.n).padStart(4) + '  ' + a.stake.toFixed(0).padStart(5) + '  ' +
      s(a.gross_close, 0).padStart(6) + '/' + s(roi(a.gross_close, a.stake), 1).padStart(6) + '%   ' +
      s(a.net_close, 0).padStart(6) + '/' + s(roi(a.net_close, a.stake), 1).padStart(6) + '%    ' +
      s(a.gross_morning, 0).padStart(6) + '/' + s(roi(a.gross_morning, a.stake), 1).padStart(6) + '%   ' +
      s(a.net_morning, 0).padStart(6) + '/' + s(roi(a.net_morning, a.stake), 1).padStart(6) + '%');
  }
  // Sum for the clean slice (edge < 0.10)
  const cleanBands = bands.filter(b => b !== '10pp+');
  const stake = cleanBands.reduce((x,b) => x + agg[t+'/'+b].stake, 0);
  const gc = cleanBands.reduce((x,b) => x + agg[t+'/'+b].gross_close, 0);
  const nc = cleanBands.reduce((x,b) => x + agg[t+'/'+b].net_close, 0);
  const gm = cleanBands.reduce((x,b) => x + agg[t+'/'+b].gross_morning, 0);
  const nm = cleanBands.reduce((x,b) => x + agg[t+'/'+b].net_morning, 0);
  const nAll = cleanBands.reduce((x,b) => x + agg[t+'/'+b].n, 0);
  console.log('  CLEAN(<10pp) n=' + nAll + '  stake=' + stake.toFixed(0)
    + '  gross_close=' + s(roi(gc, stake), 2) + '%  net_close=' + s(roi(nc, stake), 2)
    + '%  gross_morning=' + s(roi(gm, stake), 2) + '%  net_morning=' + s(roi(nm, stake), 2) + '%');
  console.log();
}

// Full rollup
console.log('=== FULL v6 rollup ===');
let stakeAll = 0, gcAll = 0, ncAll = 0, gmAll = 0, nmAll = 0, nA = 0;
for (const t of types) for (const b of bands) {
  const a = agg[t+'/'+b];
  stakeAll += a.stake; gcAll += a.gross_close; ncAll += a.net_close; gmAll += a.gross_morning; nmAll += a.net_morning; nA += a.n;
}
console.log('  n=' + nA + '  stake=' + stakeAll.toFixed(0));
console.log('  gross_close_ROI   = ' + s(roi(gcAll, stakeAll), 2) + '% (PnL ' + s(gcAll, 0) + ')');
console.log('  net_close_ROI     = ' + s(roi(ncAll, stakeAll), 2) + '% (PnL ' + s(ncAll, 0) + ')');
console.log('  gross_morning_ROI = ' + s(roi(gmAll, stakeAll), 2) + '% (PnL ' + s(gmAll, 0) + ')');
console.log('  net_morning_ROI   = ' + s(roi(nmAll, stakeAll), 2) + '% (PnL ' + s(nmAll, 0) + ')');
