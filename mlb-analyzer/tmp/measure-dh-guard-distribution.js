'use strict';
// Distribution of |source_time − schedule_time| across a full slate (or
// multiple slates). Answers: how much headroom does the 30-min guard
// have? A cluster near 0 means 30 is generous. A cluster at 20-25 means
// 30 is thin and would false-positive on any postponement drift.
//
// Usage: node tmp/measure-dh-guard-distribution.js YYYY-MM-DD [YYYY-MM-DD ...]

const kalshi = require('../services/kalshi');
const poly = require('../services/polymarket');
const {
  parseEtWallClockStringMin,
  parseKalshiHhmmMin,
  parseIsoToEtMin,
} = require('../utils/dh-assignment-guard');

const ABBR_NORM = { WSH: 'WAS', OAK: 'ATH', AZ: 'ARI' };
const norm = a => (ABBR_NORM[a] || a || '').toLowerCase();

async function scheduleByGid(date) {
  const url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + date
    + '&hydrate=' + encodeURIComponent('probablePitcher(note),team');
  const r = await fetch(url);
  const j = await r.json();
  const games = (j.dates && j.dates[0] && j.dates[0].games) || [];
  const out = {};
  for (const g of games) {
    const away = norm(g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.abbreviation);
    const home = norm(g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.abbreviation);
    if (!away || !home) continue;
    const gn = g.gameNumber || 1;
    const gid = gn > 1 ? away + '-' + home + '-g' + gn : away + '-' + home;
    const gt = new Date(g.gameDate).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    }) + ' ET';
    out[gid] = { game_pk: g.gamePk, game_time: gt, status: g.status && g.status.detailedState };
  }
  return out;
}

(async function main() {
  const dates = process.argv.slice(2);
  if (!dates.length) { console.error('usage: node measure-dh-guard-distribution.js YYYY-MM-DD [...]'); process.exit(1); }

  const allDeltas = []; // { date, gid, source, delta_min, is_dh, status }
  for (const date of dates) {
    console.log('\n=== ' + date + ' ===');
    const [sched, kals, polys] = await Promise.all([
      scheduleByGid(date),
      kalshi.getKalshiMlbLines(date, { includeLive: true }).catch(e => { console.warn('kalshi err: ' + e.message); return []; }),
      poly.getPolymarketMlbLines(date, { includeUnmatched: true }).catch(e => { console.warn('poly err: ' + e.message); return []; }),
    ]);
    const kByGid = {}; for (const k of kals) kByGid[k.game_id] = k;
    const pByGid = {}; for (const p of polys) if (p.game_id) pByGid[p.game_id] = p;
    // DH pairs on this slate
    const bases = {};
    for (const gid of Object.keys(sched)) {
      const b = gid.replace(/-g\d+$/, '');
      (bases[b] = bases[b] || []).push(gid);
    }
    const dhBases = new Set(Object.keys(bases).filter(b => bases[b].length > 1));

    let n = 0, exact = 0;
    const bucket = { '0': 0, '1-5': 0, '6-10': 0, '11-15': 0, '16-30': 0, '31+': 0 };
    for (const gid of Object.keys(sched)) {
      const s = sched[gid];
      const schedMin = parseEtWallClockStringMin(s.game_time);
      if (schedMin == null) continue;
      const isDh = dhBases.has(gid.replace(/-g\d+$/, ''));
      const k = kByGid[gid];
      const p = pByGid[gid];
      if (k) {
        const kMin = parseKalshiHhmmMin(k.start_et);
        if (kMin != null) {
          const d = kMin - schedMin;
          const ad = Math.abs(d);
          allDeltas.push({ date, gid, source: 'kalshi', delta_min: d, is_dh: isDh, status: s.status });
          n++;
          if (ad === 0) exact++;
          if (ad === 0) bucket['0']++;
          else if (ad <= 5) bucket['1-5']++;
          else if (ad <= 10) bucket['6-10']++;
          else if (ad <= 15) bucket['11-15']++;
          else if (ad <= 30) bucket['16-30']++;
          else bucket['31+']++;
        }
      }
      if (p) {
        const pMin = parseIsoToEtMin(p.game_start_time_iso);
        if (pMin != null) {
          const d = pMin - schedMin;
          const ad = Math.abs(d);
          allDeltas.push({ date, gid, source: 'poly', delta_min: d, is_dh: isDh, status: s.status });
          n++;
          if (ad === 0) exact++;
          if (ad === 0) bucket['0']++;
          else if (ad <= 5) bucket['1-5']++;
          else if (ad <= 10) bucket['6-10']++;
          else if (ad <= 15) bucket['11-15']++;
          else if (ad <= 30) bucket['16-30']++;
          else bucket['31+']++;
        }
      }
    }
    console.log('  samples: ' + n + '   exact match: ' + exact + ' (' + (100 * exact / (n || 1)).toFixed(1) + '%)');
    console.log('  bucket:  0=' + bucket['0'] + '  1-5=' + bucket['1-5']
      + '  6-10=' + bucket['6-10'] + '  11-15=' + bucket['11-15']
      + '  16-30=' + bucket['16-30'] + '  31+=' + bucket['31+']);
  }

  // Global summary
  console.log('\n\n== GLOBAL DISTRIBUTION (all sources, all slates) ==');
  const nAll = allDeltas.length;
  const nonDh = allDeltas.filter(x => !x.is_dh);
  const dh = allDeltas.filter(x => x.is_dh);
  const nonZero = nonDh.filter(x => Math.abs(x.delta_min) > 0);
  const overFive = nonDh.filter(x => Math.abs(x.delta_min) > 5);
  const overFifteen = nonDh.filter(x => Math.abs(x.delta_min) > 15);
  const overThirty = nonDh.filter(x => Math.abs(x.delta_min) > 30);
  console.log('  total samples:              ' + nAll);
  console.log('  non-DH samples:             ' + nonDh.length);
  console.log('  DH samples:                 ' + dh.length);
  console.log('  non-DH with non-zero drift: ' + nonZero.length + ' (' + (100 * nonZero.length / (nonDh.length || 1)).toFixed(1) + '%)');
  console.log('  non-DH with |Δ| > 5 min:    ' + overFive.length);
  console.log('  non-DH with |Δ| > 15 min:   ' + overFifteen.length);
  console.log('  non-DH with |Δ| > 30 min:   ' + overThirty.length + '   ← these would be false-rejected by the guard');
  if (overFive.length) {
    console.log('\n  non-DH samples with |Δ| > 5 min:');
    for (const x of overFive.sort((a, b) => Math.abs(b.delta_min) - Math.abs(a.delta_min))) {
      console.log('    ' + x.date + '  ' + x.gid.padEnd(14) + '  ' + x.source.padEnd(6)
        + '  Δ=' + (x.delta_min > 0 ? '+' : '') + x.delta_min + ' min'
        + '  status=' + (x.status || 'n/a'));
    }
  }
  if (dh.length) {
    console.log('\n  DH samples (context — expected to have large deltas when the source dropped a leg):');
    for (const x of dh.sort((a, b) => Math.abs(b.delta_min) - Math.abs(a.delta_min))) {
      const bar = Math.abs(x.delta_min) > 30 ? '   <-- would be REJECTED' : '';
      console.log('    ' + x.date + '  ' + x.gid.padEnd(14) + '  ' + x.source.padEnd(6)
        + '  Δ=' + (x.delta_min > 0 ? '+' : '') + x.delta_min + ' min' + bar);
    }
  }
  const observed = nonDh.map(x => Math.abs(x.delta_min)).sort((a, b) => a - b);
  if (observed.length) {
    const q = f => observed[Math.min(observed.length - 1, Math.max(0, Math.floor(f * (observed.length - 1))))];
    console.log('\n  non-DH |Δ| percentiles (min): p50=' + q(0.50) + '  p75=' + q(0.75)
      + '  p90=' + q(0.90) + '  p95=' + q(0.95) + '  p99=' + q(0.99) + '  max=' + observed[observed.length - 1]);
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
