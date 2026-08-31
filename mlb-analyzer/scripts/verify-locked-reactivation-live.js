#!/usr/bin/env node
/**
 * Post-deploy observable for the locked-signal reactivation. (2026-08-31)
 *
 * WHY cin-chc AND kc-cle CANNOT BE THE OBSERVABLE.
 *
 * Both were 2026-08-30 games. processGameSignals only runs against the
 * CURRENT slate -- the cron reruns today's games, never a finished date. So
 * those two rows will stay inactive with their original notes forever, no
 * matter what ships. The fix is forward-looking by construction; it was
 * never going to reach back and flip them.
 *
 * That is worth stating rather than leaving someone to watch a card that
 * will never change.
 *
 * THE EQUIVALENT OBSERVABLE is any locked bet on TODAY's slate that is
 * currently dark while its edge qualifies. Those are the rows the next
 * signal pass should reactivate. This script finds them and tells you what
 * to expect, so the check is a comparison rather than a vibe.
 *
 * Usage:
 *   node scripts/verify-locked-reactivation-live.js
 *   node scripts/verify-locked-reactivation-live.js --date 2026-08-31
 *   node scripts/verify-locked-reactivation-live.js --local
 */
const path = require('path');
const R = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const LOCAL = argv.includes('--local');
const BASE = argOf('--url') || 'https://mlb-analyzer.onrender.com';
const DATE = argOf('--date')
  || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const { getSettings } = require(path.join(R, 'services/jobs'));
const s = getSettings();
const N = (v, d) => (v != null ? Number(v) : d);
const FLOOR = N(s.SIGNAL_EMIT_FLOOR_PP, 0.01);
const HARD = N(s.SIGNAL_EDGE_HARD_CAP_PP, 0.08);
const CAP_ON = !!s.SIGNAL_EDGE_CAP_ENABLED;
const ip = m => (m < 0 ? Math.abs(m) / (Math.abs(m) + 100) : 100 / (m + 100));

function get(url, depth) {
  depth = depth || 0;
  return new Promise(res => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    lib.get(url, { headers: { Accept: 'application/json' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 4)
        return res(get(new URL(r.headers.location, url).toString(), depth + 1));
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => res({ s: r.statusCode, ct: r.headers['content-type'] || '', b }));
    }).on('error', e => res({ s: 0, ct: '', b: e.message }));
  });
}

async function loadGames() {
  if (LOCAL) {
    const { q } = require(path.join(R, 'db/schema'));
    const games = q.getGamesByDate.all(DATE);
    const logged = q.getLoggedInactiveByDate.all(DATE);
    const active = q.getSignalsByDate.all(DATE);
    const byId = {};
    for (const g of games) byId[g.game_id] = Object.assign({}, g, { logged_bets: [], signals: [] });
    for (const l of logged) if (byId[l.game_id]) byId[l.game_id].logged_bets.push(l);
    for (const a of active) if (byId[a.game_id]) byId[a.game_id].signals.push(a);
    return Object.values(byId);
  }
  const r = await get(BASE.replace(/\/$/, '') + '/api/games/' + DATE);
  if (!(r.s === 200 && /json/i.test(r.ct))) throw new Error('API unavailable (status ' + r.s + ')');
  return JSON.parse(r.b);
}

(async () => {
  console.log('=== LOCKED-REACTIVATION OBSERVABLE ===');
  console.log('  source : ' + (LOCAL ? 'local DB' : BASE));
  console.log('  date   : ' + DATE);
  console.log('  gates  : floor ' + (FLOOR * 100) + 'pp, hard ' + (HARD * 100)
    + 'pp, cap ' + (CAP_ON ? 'ON' : 'OFF'));
  console.log('');

  const games = await loadGames();
  const rows = [];
  for (const g of games) {
    for (const b of (g.logged_bets || [])) {
      if (b.signal_type !== 'ML') continue;
      const mdl = b.signal_side === 'away' ? g.model_away_ml : g.model_home_ml;
      const mkt = b.signal_side === 'away' ? g.market_away_ml : g.market_home_ml;
      if (mdl == null || mkt == null) continue;
      const e = Math.max(0, ip(mdl) - ip(mkt));
      const qualifies = e >= FLOOR && !(CAP_ON && e >= HARD);
      rows.push({ gid: g.game_id, side: b.signal_side, bet: b.bet_line, e, qualifies,
                  note: String(b.notes || '') });
    }
  }
  const cands = rows.filter(r => r.qualifies);

  console.log('  logged ML bets with no live signal : ' + rows.length);
  console.log('  ...of those, currently QUALIFYING  : ' + cands.length);
  console.log('');
  if (rows.length) {
    console.log('  game        side   bet@    edgeNow   verdict');
    for (const r of rows) {
      console.log('  ' + String(r.gid).padEnd(12) + r.side.padEnd(7) + String(r.bet).padEnd(8)
        + (r.e * 100).toFixed(2).padStart(6) + 'pp   '
        + (r.qualifies ? 'SHOULD REACTIVATE on the next pass' : 'correctly dark'));
      if (r.qualifies) console.log('       current note: ' + r.note.slice(0, 88));
    }
    console.log('');
  }

  if (!cands.length) {
    console.log('  Nothing to observe right now: no locked bet on this slate is dark');
    console.log('  while qualifying. That is a PASS-shaped result only if the fix has');
    console.log('  already run -- an empty list also happens when no bet has moved.');
    console.log('  Re-run later in the day, or on a date with candidates.');
  } else {
    console.log('  WHAT TO EXPECT after the next signal pass:');
    for (const c of cands) {
      console.log('    ' + c.gid + ' ' + c.side + ' moves OUT of "Logged bets (no live');
      console.log('      signal)" and into the active pills, at roughly '
        + (c.e * 100).toFixed(1) + 'pp,');
      console.log('      with bet_line ' + c.bet + ' UNCHANGED and the stale note cleared.');
    }
    console.log('');
    console.log('  If they stay dark after a pass has run, the reactivation is not');
    console.log('  firing -- check for [signal-reactivate] in the server log and for');
    console.log('  bet_signal_audit rows with action=\'reactivated\'.');
  }
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
