#!/usr/bin/env node
/**
 * Validate the re-derivation method against rows where the answer is
 * already known. (2026-08-23)
 *
 * THE POINT. 601 ML rows carry a closing_line indistinguishable from
 * backfill. Before re-deriving those from empirical_market_captures, the
 * method has to be shown to work on the 304 rows where the real capture
 * DID run and the true closing line is recorded. If re-derivation
 * reproduces the captured value there, the method is sound. If it does
 * not, nothing should be written anywhere.
 *
 * This also CHOOSES the acceptance window rather than asserting one: the
 * same validation runs at several windows, and the window is picked from
 * where fidelity stops improving, not from a round number.
 *
 * TIMEZONES (per the CLAUDE.md rule):
 *   empirical_market_captures.generated_at -- PT
 *   game_log.first_pitch_utc               -- ISO UTC
 * PDT all season, so PT + 7h = UTC. Converted explicitly, never compared
 * as strings.
 *
 * WRITES NOTHING.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const WINDOWS_MIN = [15, 30, 60, 90, 120, 180, 360];

function ptToUtcMs(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 7, +m[5], +m[6]) : null;
}

// Last ML capture strictly before first pitch and within `windowMin` of it.
function lastCaptureBefore(gameDate, gameId, firstPitchUtc, windowMin) {
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
    if ((fp - t) > windowMin * 60000) continue;
    if (!best || t > best.t) best = { t, a: c.away_price_ml, h: c.home_price_ml, at: c.generated_at };
  }
  return best;
}

(function main() {
  console.log('=== validating re-derivation against KNOWN-CAPTURED rows ===');
  console.log('  If the method reproduces a value we already captured, it works.');
  console.log('');

  // The 304: a set_closing_line audit row exists AND the line moved, so the
  // stored closing_line is unambiguously a real observation.
  const known = db.prepare(
    "SELECT b.id, b.game_date, b.game_id, b.signal_side, b.closing_line, b.market_line, "
    + "       b.bet_line, g.first_pitch_utc "
    + "FROM bet_signals b JOIN game_log g "
    + "  ON g.game_date=b.game_date AND g.game_id=b.game_id "
    + "WHERE b.signal_type='ML' AND b.closing_line IS NOT NULL "
    + "  AND g.first_pitch_utc IS NOT NULL "
    + "  AND b.closing_line != b.market_line "
    + "  AND EXISTS (SELECT 1 FROM bet_signal_audit a "
    + "              WHERE a.signal_id=b.id AND a.action='set_closing_line')"
  ).all();
  console.log('  known-captured rows (audit row + line moved): ' + known.length);

  const inCaptureEra = known.filter(r => r.game_date >= '2026-06-11');
  console.log('  ... within the empirical_market_captures era (>= 2026-06-11): ' + inCaptureEra.length);
  console.log('');

  console.log('  window   resolved   exact    within1   within5   median|err|   verdict');
  const results = [];
  for (const w of WINDOWS_MIN) {
    let resolved = 0, exact = 0, w1 = 0, w5 = 0;
    const errs = [];
    for (const r of inCaptureEra) {
      const cap = lastCaptureBefore(r.game_date, r.game_id, r.first_pitch_utc, w);
      if (!cap) continue;
      resolved++;
      const derived = r.signal_side === 'away' ? cap.a : cap.h;
      if (derived == null) { resolved--; continue; }
      const err = Math.abs(Number(derived) - Number(r.closing_line));
      errs.push(err);
      if (err === 0) exact++;
      if (err <= 1) w1++;
      if (err <= 5) w5++;
    }
    errs.sort((a, b) => a - b);
    const med = errs.length ? errs[Math.floor(errs.length / 2)] : null;
    const pctExact = resolved ? (100 * exact / resolved) : 0;
    results.push({ w, resolved, exact, pctExact, med });
    console.log('  ' + String(w).padStart(4) + 'm   ' + String(resolved).padStart(6)
      + '   ' + String(exact).padStart(5) + '   ' + String(w1).padStart(6)
      + '   ' + String(w5).padStart(6) + '   ' + String(med == null ? 'n/a' : med).padStart(9)
      + '     ' + pctExact.toFixed(1) + '% exact');
  }

  console.log('');
  console.log('  READING THIS: "exact" means the re-derived price equals the price the');
  console.log('  real capture stored. High exact-match = the method reconstructs what');
  console.log('  the capture saw. If exact-match is low at every window, the capture and');
  console.log('  empirical_market_captures are reading different sources and');
  console.log('  re-derivation must NOT be applied to the 601.');
  console.log('');

  // WINDOW SELECTION. Fidelity falls monotonically as the window widens --
  // an older capture has had more time for the line to move after it. So
  // maximising exact-match picks the narrowest window and resolves almost
  // nothing (15m: 96.6% but only 59 rows). That is a degenerate choice.
  //
  // The criterion is instead: the WIDEST window that still holds >= 90%
  // fidelity against known captures. That fixes the error rate we are
  // willing to accept and then takes as much coverage as it allows,
  // rather than picking a round number and reporting whatever fidelity
  // falls out.
  const PASS_BAR = 90;
  const eligible = results.filter(r => r.resolved > 0 && r.pctExact >= PASS_BAR);
  const best = eligible.length
    ? eligible.sort((a, b) => b.w - a.w)[0]
    : results.filter(r => r.resolved > 0).sort((a, b) => b.pctExact - a.pctExact)[0];
  if (!best) { console.log('  NO WINDOW RESOLVED ANYTHING -- method unusable.'); process.exit(1); }
  console.log('  SELECTED WINDOW: ' + best.w + 'm -- the widest holding >= ' + PASS_BAR + '% fidelity');
  console.log('    ' + best.pctExact.toFixed(1) + '% exact on ' + best.resolved
    + ' known-captured rows, median |err| ' + best.med);
  const wider = results.filter(r => r.w > best.w && r.resolved > 0);
  if (wider.length) {
    console.log('    (next wider, ' + wider[0].w + 'm, would add '
      + (wider[0].resolved - best.resolved) + ' rows at ' + wider[0].pctExact.toFixed(1) + '% -- rejected)');
  }

  if (best.pctExact < PASS_BAR) {
    console.log('');
    console.log('  *** BELOW THE ' + PASS_BAR + '% BAR -- DO NOT APPLY TO THE 601. ***');
    console.log('  The two sources disagree often enough that a re-derived value would');
    console.log('  be a third kind of number, neither captured nor backfilled.');
    process.exit(1);
  }
  console.log('  PASS -- method reproduces known captures. Safe to apply.');
})();
