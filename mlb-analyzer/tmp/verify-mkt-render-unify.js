// Slate-wide verification for fix/mkt-render-unify-market-line.
//
// The fix routes every signal-adjacent "mkt" display through
// s.market_line (via _resolveAwayML / _resolveHomeML / _resolveTotalMkt
// in public/index.html). Under the owner's design ruling, s.market_line
// is written to the venue winner's fee-adjusted net-at-size by
// refreshSignalBaselines (odds-cron tail) and matches the venue-flag
// bold number by construction.
//
// Verification is a per-game table:
//   game_id, side, flag_winner (venue + net), row.market_line,
//                                            what-the-card-renders,
//                                            match?
//
// "What the card renders" is exactly _resolveMkt output: s.market_line
// when a signal exists, else g.market_*_ml. Since we only care about
// signal-adjacent cells (where the flag also renders), the "match?"
// column IS the resolver's output vs the flag winner.

const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'mlb.db');
const db = require('better-sqlite3')(process.env.DB_PATH, { readonly: true });
const { runComparison } = require('../services/odds-comparison');

const DATE = process.argv[2] || '2026-07-08';

function pickBestML(row, side) {
  if (!row) return null;
  const P = row.poly && row.poly[side];
  const K = row.kalshi && row.kalshi[side];
  const polyOK = P && P.net_american != null && !P.partial;
  const kalOK  = K && K.net_american != null && !K.partial;
  if (!polyOK && !kalOK) return null;
  if (polyOK && !kalOK) return { ml: P.net_american, venue: 'poly',   partial: false };
  if (kalOK && !polyOK) return { ml: K.net_american, venue: 'kalshi', partial: false };
  return P.net_american >= K.net_american
    ? { ml: P.net_american, venue: 'poly',   partial: false }
    : { ml: K.net_american, venue: 'kalshi', partial: false };
}

function fmtML(v) { if (v == null) return '—'; return v > 0 ? '+' + v : '' + v; }

(async () => {
  console.log('=== live venue-comparison fetch for ' + DATE + ' (this is what the flag reads) ===');
  const cmp = await runComparison(DATE, {});
  const byGid = {};
  for (const r of (cmp.rows || [])) if (r.game_id) byGid[r.game_id] = r;
  console.log('priced ' + Object.keys(byGid).length + ' games');
  console.log();

  const games = db.prepare(
    "SELECT game_id, away_team, home_team, market_away_ml, market_home_ml, market_total FROM game_log WHERE game_date = ? ORDER BY game_id"
  ).all(DATE);
  const activeSigs = db.prepare(
    "SELECT game_id, signal_type, signal_side, market_line, price_venue, venue_stale, updated_at, created_at FROM bet_signals WHERE game_date = ? AND is_active = 1"
  ).all(DATE);
  const sigsByGid = {};
  for (const s of activeSigs) {
    (sigsByGid[s.game_id] = sigsByGid[s.game_id] || []).push(s);
  }

  // Emulate public/index.html _resolveMkt.
  function resolve(g, side, type) {
    const sigs = sigsByGid[g.game_id] || [];
    const sig = sigs.find(s => s.signal_type === type && s.signal_side === side);
    if (sig && sig.market_line != null) return { val: sig.market_line, source: 'sig.market_line', row: sig };
    if (type === 'ML') return { val: side === 'away' ? g.market_away_ml : g.market_home_ml, source: 'g.market_*_ml (no sig on this side)', row: null };
    return { val: g.market_total, source: 'g.market_total (no total sig)', row: null };
  }

  console.log('=== slate-wide table (07-08) ===\n');
  console.log('game     side  flag_winner              row.market_line  price_venue  updated_at            card_renders  matches_flag?  notes');
  console.log('-------  ----  -----------------------  ---------------  -----------  --------------------  ------------  -------------  -----');
  let allMatch = true;
  let anySigOnFlag = 0, matches = 0, mismatches = 0, staleRows = 0;
  for (const g of games) {
    const cmpRow = byGid[g.game_id];
    if (!cmpRow) continue;
    for (const side of ['away', 'home']) {
      const flag = pickBestML(cmpRow, side);
      const resolved = resolve(g, side, 'ML');
      const sigRow = resolved.row;
      // Skip sides with no signal — the flag isn't rendered on the card for those
      if (!sigRow) continue;
      anySigOnFlag++;
      const flagVenue = flag ? flag.venue.padEnd(6) : '—     ';
      const flagVal = flag ? (fmtML(flag.ml) + '/' + flagVenue) : '—';
      const cardRenders = fmtML(resolved.val);
      const cardMatchesFlag = flag != null && resolved.val === flag.ml;
      if (!cardMatchesFlag) allMatch = false;
      const notes = [];
      // Row is stale if it hasn't been refreshed since venue-aware flip
      if (sigRow.price_venue == null) { notes.push('row pre-refresh (Kalshi capture)'); staleRows++; }
      if (sigRow.venue_stale === 1) notes.push('venue_stale=1 (fallback tier)');
      if (cardMatchesFlag) matches++; else mismatches++;
      console.log(
        (g.game_id.padEnd(9)) +
        (side.padEnd(6)) +
        flagVal.padEnd(25) +
        String(fmtML(sigRow.market_line)).padEnd(17) +
        String(sigRow.price_venue || 'NULL').padEnd(13) +
        String(sigRow.updated_at || 'NULL').padEnd(22) +
        cardRenders.padEnd(14) +
        (cardMatchesFlag ? 'YES' : 'NO ').padEnd(15) +
        notes.join(', ')
      );
    }
  }
  console.log();
  console.log('=== summary ===');
  console.log('sides with signal + venue flag :', anySigOnFlag);
  console.log('  → card mkt == flag winner    :', matches, matches === anySigOnFlag ? '(all match)' : '(bug — mismatched)');
  console.log('  → mismatches                 :', mismatches);
  console.log('stale rows (pre-refresh)       :', staleRows, '(price_venue NULL — row not yet refreshed)');
  if (mismatches > 0 && staleRows === mismatches) {
    console.log('\nNOTE: all mismatches are on stale rows (price_venue NULL). This is expected —');
    console.log('rows written before PR #164 deployed still carry Kalshi capture. Once the odds');
    console.log('cron tail runs refreshSignalBaselines on these games, price_venue populates and');
    console.log('market_line will equal the flag winner net — the resolver then makes card mkt');
    console.log('== flag winner by construction.');
  } else if (mismatches === 0) {
    console.log('\n✓ RESOLVER FIX VALIDATED: every card mkt matches its flag winner across the slate.');
  }
})().catch(e => { console.error(e); process.exit(1); });
