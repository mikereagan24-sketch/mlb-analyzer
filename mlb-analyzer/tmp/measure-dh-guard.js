'use strict';
// Simulate the DH-assignment guard against a live slate. Reports for
// each game_id:
//   - statsapi game_time (ground truth)
//   - Kalshi ticker start_et + delta + verdict
//   - Poly event start + delta + verdict
//   - net effect: which source wins market_*_ml after both guards fire
// Also flags what the OLD (pre-fix) pipeline would have written vs
// what the NEW pipeline writes.
//
// Usage: node tmp/measure-dh-guard.js [YYYY-MM-DD]

const kalshi = require('../services/kalshi');
const poly = require('../services/polymarket');
const {
  parseEtWallClockStringMin,
  parseKalshiHhmmMin,
  parseIsoToEtMin,
  checkSourceStartMatchesSchedule,
  START_MISMATCH_TOL_MIN,
} = require('../utils/dh-assignment-guard');

function todayPT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
function fmtHhmm(min) {
  if (min == null) return '  ? ';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function favOf(a, h) {
  const aa = Number(a), hh = Number(h);
  if (!Number.isFinite(aa) || !Number.isFinite(hh)) return '?';
  return aa < hh ? 'away' : 'home';
}
function fmtAm(n) { return n == null ? 'null' : (n > 0 ? '+' + n : String(n)); }

const ABBR_NORM = { WSH: 'WAS', OAK: 'ATH', AZ: 'ARI' };
const norm = a => (ABBR_NORM[a] || a || '').toLowerCase();

(async function main() {
  const date = process.argv[2] || todayPT();
  console.log('DH-guard simulation for slate ' + date + ' (tolerance ±' + START_MISMATCH_TOL_MIN + ' min)');
  console.log('');

  // Ground truth
  const url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + date
    + '&hydrate=' + encodeURIComponent('probablePitcher(note),team');
  const sresp = await fetch(url);
  const sjson = await sresp.json();
  const sgames = (sjson.dates && sjson.dates[0] && sjson.dates[0].games) || [];
  const schedByGid = {};
  for (const g of sgames) {
    if (g.status && g.status.detailedState === 'Final') continue;
    const away = norm(g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.abbreviation);
    const home = norm(g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.abbreviation);
    if (!away || !home) continue;
    const gn = g.gameNumber || 1;
    const gid = gn > 1 ? away + '-' + home + '-g' + gn : away + '-' + home;
    // fmtET-equivalent string (matches services/scraper.js fmtET output shape)
    const gameTime = new Date(g.gameDate).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    }) + ' ET';
    schedByGid[gid] = { game_pk: g.gamePk, game_time: gameTime, game_number: gn };
  }

  // Sources
  const [kalsRows, polyRows] = await Promise.all([
    kalshi.getKalshiMlbLines(date, { includeLive: true }),
    poly.getPolymarketMlbLines(date, { includeUnmatched: true }),
  ]);
  const kalsByGid = {}; for (const k of kalsRows) kalsByGid[k.game_id] = k;
  const polyByGid = {}; for (const p of polyRows) if (p.game_id) polyByGid[p.game_id] = p;

  const allGids = [...new Set([...Object.keys(schedByGid), ...Object.keys(kalsByGid), ...Object.keys(polyByGid)])].sort();
  let kAccept = 0, kReject = 0, pAccept = 0, pReject = 0;
  let oldWrote = 0, newWrote = 0;
  const failures = [];

  console.log('per-game verdict:');
  console.log('  game_id        sched_et  kalshi_et  Δk  verdict_k    poly_et   Δp  verdict_p    OLD writer→OLD fav  |  NEW writer→NEW fav');
  for (const gid of allGids) {
    const s = schedByGid[gid];
    const k = kalsByGid[gid];
    const p = polyByGid[gid];
    const schedMin = s ? parseEtWallClockStringMin(s.game_time) : null;
    const kMin = k ? parseKalshiHhmmMin(k.start_et) : null;
    const pMin = p ? parseIsoToEtMin(p.game_start_time_iso) : null;
    const kDelta = (kMin != null && schedMin != null) ? kMin - schedMin : null;
    const pDelta = (pMin != null && schedMin != null) ? pMin - schedMin : null;
    const kFail = k ? checkSourceStartMatchesSchedule(kMin, schedMin, 'kalshi', gid) : null;
    const pFail = p ? checkSourceStartMatchesSchedule(pMin, schedMin, 'polymarket', gid) : null;

    // OLD pipeline: Kalshi wins if it wrote; else Poly.
    let oldWriter = null, oldAway = null, oldHome = null;
    if (k) { oldWriter = 'kalshi'; oldAway = k.away && k.away.ask_ml; oldHome = k.home && k.home.ask_ml; }
    else if (p) { oldWriter = 'poly'; oldAway = p.away && p.away.ask_ml; oldHome = p.home && p.home.ask_ml; }

    // NEW pipeline: same order, but reject source when start-time mismatches.
    let newWriter = null, newAway = null, newHome = null;
    if (k && !kFail) { newWriter = 'kalshi'; newAway = k.away && k.away.ask_ml; newHome = k.home && k.home.ask_ml; }
    else if (p && !pFail) { newWriter = 'poly'; newAway = p.away && p.away.ask_ml; newHome = p.home && p.home.ask_ml; }

    if (k) { if (kFail) kReject++; else kAccept++; }
    if (p) { if (pFail) pReject++; else pAccept++; }
    if (oldWriter) oldWrote++;
    if (newWriter) newWrote++;

    const oldFav = favOf(oldAway, oldHome);
    const newFav = favOf(newAway, newHome);
    const flip = oldFav !== newFav && oldFav !== '?' && newFav !== '?' ? '  <-- FAV FLIP' : '';
    const rejectMark = (oldFav !== '?' && !newWriter) ? '  <-- BOTH REJECTED' : '';

    console.log('  ' + gid.padEnd(14)
      + '  ' + (s ? fmtHhmm(schedMin) : ' n/a ')
      + '    ' + (k ? fmtHhmm(kMin) : ' n/a ')
      + '   ' + (kDelta != null ? (kDelta >= 0 ? '+' : '') + kDelta : ' -')
      + '   ' + (k ? (kFail ? 'REJECT' : ' OK  ') : ' n/a ')
      + '     ' + (p ? fmtHhmm(pMin) : ' n/a ')
      + '   ' + (pDelta != null ? (pDelta >= 0 ? '+' : '') + pDelta : ' -')
      + '   ' + (p ? (pFail ? 'REJECT' : ' OK  ') : ' n/a ')
      + '     ' + (oldWriter || '  --  ').padEnd(6) + '→ ' + (oldFav === 'away' ? 'AWAY' : oldFav === 'home' ? 'HOME' : ' ?  ')
      + '   |  ' + (newWriter || '  --  ').padEnd(6) + '→ ' + (newFav === 'away' ? 'AWAY' : newFav === 'home' ? 'HOME' : ' ?  ')
      + flip + rejectMark);

    if (flip || rejectMark) {
      failures.push({
        game_id: gid,
        old: { writer: oldWriter, away: oldAway, home: oldHome, fav: oldFav },
        new: { writer: newWriter, away: newAway, home: newHome, fav: newFav },
        kalshi_delta_min: kDelta, poly_delta_min: pDelta,
      });
    }
  }

  console.log('');
  console.log('summary:');
  console.log('  games (schedule ∪ sources): ' + allGids.length);
  console.log('  Kalshi rows:                ' + kalsRows.length + '  (accepted ' + kAccept + ' / rejected ' + kReject + ')');
  console.log('  Poly rows:                  ' + polyRows.length + '  (accepted ' + pAccept + ' / rejected ' + pReject + ')');
  console.log('  OLD pipeline wrote market:  ' + oldWrote);
  console.log('  NEW pipeline wrote market:  ' + newWrote + '  (delta ' + (newWrote - oldWrote) + ')');
  console.log('  fav-flip or dropped rows:   ' + failures.length);
  if (failures.length) {
    console.log('');
    console.log('  affected game_ids:');
    for (const f of failures) {
      console.log('    ' + f.game_id + '  OLD ' + f.old.writer + ' (' + fmtAm(f.old.away) + '/' + fmtAm(f.old.home) + ')'
        + ' → NEW ' + (f.new.writer || 'SUPPRESSED')
        + (f.new.writer ? ' (' + fmtAm(f.new.away) + '/' + fmtAm(f.new.home) + ')' : ''));
    }
  }
})().catch(e => {
  console.error('measurement failed: ' + (e && e.stack || e));
  process.exit(1);
});
