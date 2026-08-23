#!/usr/bin/env node
/**
 * Re-derive ML closing lines from empirical_market_captures. (2026-08-23)
 * Dry run by default; --apply to write.
 *
 * TARGET. The 601 ML rows whose closing_line is indistinguishable from
 * backfill: no set_closing_line audit row, and closing_line == market_line.
 * Those were written by GET /backtest as an ASSUMPTION that the line did
 * not move, not an observation.
 *
 * METHOD VALIDATED FIRST. scripts/validate-rederived-closing.js runs the
 * identical derivation against the 304 rows where the real capture DID
 * run, and reproduces the captured price 91.5% exactly (median |err| 0)
 * at the 60-minute window. The method is not applied anywhere until it is
 * shown to work where the answer is already known.
 *
 * ACCEPTANCE WINDOW: 60 minutes before first pitch.
 * Chosen, not asserted. Fidelity against known captures falls monotonically
 * as the window widens (15m 96.6%, 60m 91.5%, 90m 89.5%, 180m 87.5%),
 * because an older capture has had more time for the line to move after
 * it. Maximising fidelity would pick 15m and resolve almost nothing. So
 * the rule is: the WIDEST window still holding >= 90% fidelity. 60m is
 * that window; 90m was rejected -- it would add 54 rows at 89.5%.
 *
 * A capture older than 60 minutes is a mid-day price, not a close, and is
 * refused rather than substituted.
 *
 * TIMEZONES: generated_at is PT, first_pitch_utc is UTC, PDT all season.
 */
const path = require('path');
const R = path.join(__dirname, '..');
require(path.join(R, 'db/schema'));
const { calcCLV } = require(path.join(R, 'services/clv'));

const APPLY = process.argv.includes('--apply');
const WINDOW_MIN = 60;
const MATERIAL_CLV_PP = 0.5;   // what counts as "moved the CLV materially"

// Use db/schema's connection, NOT a second one. Opening our own read-write
// handle while q.insertBetSignalAudit writes through schema's handle means
// two writers on one SQLite file: our transaction takes the write lock, the
// audit insert blocks on it, and the process hangs forever with nothing
// committed. That happened on the first --apply run of this script. The
// same connection-splitting mistake also made an earlier backfill test
// report "0 rows" and look like a broken function.
const { q, db } = require(path.join(R, 'db/schema'));

const ptToUtcMs = s => {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 7, +m[5], +m[6]) : null;
};

function lastCaptureBefore(gameDate, gameId, firstPitchUtc) {
  const fp = Date.parse(firstPitchUtc);
  if (!Number.isFinite(fp)) return null;
  const caps = db.prepare(
    "SELECT generated_at, away_price_ml, home_price_ml FROM empirical_market_captures "
    + "WHERE market_type='ml' AND game_date=? AND game_id=? "
    + "AND away_price_ml IS NOT NULL AND home_price_ml IS NOT NULL"
  ).all(gameDate, gameId);
  let best = null;
  for (const c of caps) {
    const t = ptToUtcMs(c.generated_at);
    if (t == null || t >= fp) continue;
    if ((fp - t) > WINDOW_MIN * 60000) continue;
    if (!best || t > best.t) best = { t, a: c.away_price_ml, h: c.home_price_ml, at: c.generated_at };
  }
  return best;
}

const roi = a => { let p = 0, w = 0; for (const s of a) { p += s.pnl; w += s.wagered; } return w > 0 ? 100 * p / w : null; };

(function main() {
  console.log('=== re-derive ML closing lines ' + (APPLY ? '' : '[DRY RUN]') + ' ===');
  console.log('  window: last capture within ' + WINDOW_MIN + ' min before first pitch');
  console.log('');

  const targets = db.prepare(
    "SELECT b.id, b.game_date, b.game_id, b.signal_side, b.bet_line, b.market_line, "
    + "       b.closing_line, b.clv, b.signal_type, g.first_pitch_utc "
    + "FROM bet_signals b JOIN game_log g "
    + "  ON g.game_date=b.game_date AND g.game_id=b.game_id "
    + "WHERE b.signal_type='ML' AND b.closing_line IS NOT NULL "
    + "  AND b.closing_line = b.market_line "
    + "  AND NOT EXISTS (SELECT 1 FROM bet_signal_audit a "
    + "                  WHERE a.signal_id=b.id AND a.action='set_closing_line') "
    + "ORDER BY b.game_date"
  ).all();

  console.log('  target rows (indistinguishable-from-backfill) : ' + targets.length);
  const era = targets.filter(r => r.game_date >= '2026-06-11');
  console.log('  ... in the capture era (>= 2026-06-11)        : ' + era.length);
  console.log('  ... before it, unreachable by any method      : ' + (targets.length - era.length));
  console.log('');

  const resolved = [], unresolved = [];
  for (const r of targets) {
    if (!r.first_pitch_utc) { unresolved.push({ r, why: 'no first_pitch_utc' }); continue; }
    const cap = lastCaptureBefore(r.game_date, r.game_id, r.first_pitch_utc);
    if (!cap) { unresolved.push({ r, why: 'no capture within ' + WINDOW_MIN + 'm' }); continue; }
    const derived = r.signal_side === 'away' ? cap.a : cap.h;
    if (derived == null) { unresolved.push({ r, why: 'capture lacks this side' }); continue; }
    const newClv = calcCLV(r.bet_line, derived);
    resolved.push({ r, derived: Number(derived), capAt: cap.at, newClv, oldClv: r.clv });
  }

  console.log('=== (3) before / after ===');
  console.log('  resolved from a real capture : ' + resolved.length
    + '  (' + (100 * resolved.length / targets.length).toFixed(1) + '% of ' + targets.length + ')');
  console.log('  unresolved, keep backfill tag : ' + unresolved.length);
  const whys = {};
  unresolved.forEach(u => { whys[u.why] = (whys[u.why] || 0) + 1; });
  Object.entries(whys).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('     ' + k + ': ' + v));
  console.log('');

  const moved = resolved.filter(x => Number(x.derived) !== Number(x.r.market_line));
  console.log('  of the resolved, closing line actually MOVED : ' + moved.length
    + '  (' + (resolved.length ? (100 * moved.length / resolved.length).toFixed(1) : '0') + '%)');
  console.log('     -> the backfill assumption was WRONG on these');
  const withClv = resolved.filter(x => x.oldClv != null && x.newClv != null);
  const material = withClv.filter(x => Math.abs(x.newClv - x.oldClv) >= MATERIAL_CLV_PP);
  console.log('  resolved rows carrying a CLV                 : ' + withClv.length);
  console.log('  ... CLV moved >= ' + MATERIAL_CLV_PP + 'pp                       : ' + material.length);
  if (withClv.length) {
    const deltas = withClv.map(x => x.newClv - x.oldClv).sort((a, b) => a - b);
    const med = deltas[Math.floor(deltas.length / 2)];
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    console.log('  CLV delta (new - old): median ' + med.toFixed(2)
      + 'pp   mean ' + mean.toFixed(2) + 'pp   min ' + deltas[0].toFixed(1)
      + '   max ' + deltas[deltas.length - 1].toFixed(1));
  }
  console.log('');

  if (moved.length) {
    console.log('  largest corrections:');
    moved.slice().sort((a, b) => Math.abs(b.derived - b.r.market_line) - Math.abs(a.derived - a.r.market_line))
      .slice(0, 8).forEach(x => console.log('    ' + x.r.game_date + ' ' + String(x.r.game_id).padEnd(10)
        + String(x.r.signal_side).padEnd(6) + ' assumed ' + String(x.r.market_line).padStart(5)
        + ' -> real ' + String(x.derived).padStart(5)
        + '   clv ' + (x.oldClv == null ? 'n/a' : x.oldClv) + ' -> ' + (x.newClv == null ? 'n/a' : x.newClv)
        + '   cap@' + x.capAt));
    console.log('');
  }

  // ---- ML CLV aggregate, resolved-only vs all
  console.log('=== ML CLV aggregate ===');
  const allClv = db.prepare("SELECT clv FROM bet_signals WHERE signal_type='ML' AND clv IS NOT NULL").all().map(r => r.clv);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  console.log('  ALL ML rows with CLV today   : n=' + allClv.length + '  mean ' + mean(allClv).toFixed(2) + 'pp');
  const trustedIds = db.prepare(
    "SELECT b.id FROM bet_signals b WHERE b.signal_type='ML' AND b.clv IS NOT NULL "
    + "AND (b.closing_line != b.market_line OR EXISTS (SELECT 1 FROM bet_signal_audit a "
    + "     WHERE a.signal_id=b.id AND a.action='set_closing_line'))"
  ).all().map(r => r.id);
  const trusted = db.prepare(
    "SELECT clv FROM bet_signals WHERE signal_type='ML' AND clv IS NOT NULL "
    + "AND (closing_line != market_line OR EXISTS (SELECT 1 FROM bet_signal_audit a "
    + "     WHERE a.signal_id=bet_signals.id AND a.action='set_closing_line'))"
  ).all().map(r => r.clv);
  console.log('  OBSERVED-only (captured or moved) : n=' + trusted.length + '  mean ' + mean(trusted).toFixed(2) + 'pp');
  const after = allClv.length - withClv.length + withClv.length;  // count unchanged; values change
  const projected = trusted.concat(resolved.filter(x => x.newClv != null && x.oldClv != null).map(x => x.newClv));
  console.log('  OBSERVED + re-derived (projected) : n=' + projected.length + '  mean ' + mean(projected).toFixed(2) + 'pp');
  console.log('');
  console.log('  The gap between rows 1 and 2 is the distortion the assumed closes');
  console.log('  introduce. Row 3 is what the aggregate becomes once re-derivation lands.');
  console.log('');

  if (!APPLY) { console.log('  DRY RUN -- pass --apply to write.'); return; }

  const upd = db.prepare('UPDATE bet_signals SET closing_line=?, clv=? WHERE id=?');
  let wrote = 0, tagged = 0;
  db.transaction(() => {
    for (const x of resolved) {
      upd.run(x.derived, x.newClv, x.r.id);
      wrote++;
      try {
        q.insertBetSignalAudit({
          signal_id: x.r.id, game_date: x.r.game_date, game_id: x.r.game_id,
          signal_type: x.r.signal_type, signal_side: x.r.signal_side,
          action: 'rederived_closing_line',
          bet_line: x.r.bet_line, closing_line: x.derived, clv: x.newClv,
          source: 'rederive-ml-closing-lines',
          detail: 'closing_line re-derived from empirical_market_captures at ' + x.capAt
            + ' (PT), within ' + WINDOW_MIN + 'min of first pitch. Replaces the assumed '
            + x.r.market_line + '. Method validated at 91.5% exact against known captures.',
        });
      } catch (e) { /* audit failure must not abort */ }
    }
    // Unresolved keep -- and now explicitly carry -- the backfill provenance.
    for (const u of unresolved) {
      try {
        q.insertBetSignalAudit({
          signal_id: u.r.id, game_date: u.r.game_date, game_id: u.r.game_id,
          signal_type: u.r.signal_type, signal_side: u.r.signal_side,
          action: 'backfilled_closing_line',
          bet_line: u.r.bet_line, closing_line: u.r.closing_line, clv: u.r.clv,
          source: 'rederive-ml-closing-lines',
          detail: 'NOT re-derivable (' + u.why + '). closing_line remains an ASSUMPTION '
            + 'that the line did not move, not an observed close.',
        });
        tagged++;
      } catch (e) { /* ditto */ }
    }
  })();
  console.log('  rows re-derived        : ' + wrote);
  console.log('  rows tagged as assumed : ' + tagged);
  console.log('');
  console.log('=== verification ===');
  const rd = db.prepare("SELECT COUNT(DISTINCT signal_id) n FROM bet_signal_audit WHERE action='rederived_closing_line'").get().n;
  const bf = db.prepare("SELECT COUNT(DISTINCT signal_id) n FROM bet_signal_audit WHERE action='backfilled_closing_line'").get().n;
  console.log('  signals tagged rederived_closing_line  : ' + rd);
  console.log('  signals tagged backfilled_closing_line : ' + bf);
  const untagged = db.prepare(
    "SELECT COUNT(*) n FROM bet_signals b WHERE b.signal_type='ML' AND b.closing_line IS NOT NULL "
    + "AND NOT EXISTS (SELECT 1 FROM bet_signal_audit a WHERE a.signal_id=b.id "
    + "  AND a.action IN ('set_closing_line','rederived_closing_line','backfilled_closing_line'))"
  ).get().n;
  console.log('  ML closing lines with NO provenance tag (target 0): ' + untagged);
})();
