#!/usr/bin/env node
/**
 * Emit-time numbers are labelled as such. (2026-09-03)
 *
 * BOS@BAL 2026-09-03: the badge read 3.5PP while the model and market
 * printed directly beneath it were -130 and -124, which reconcile to
 * 1.16pp. No market price makes those agree -- working backwards gave
 * -113, which appeared nowhere on the card.
 *
 * The stored row was consistent the whole time:
 *   market_line -124  model_line -142  edge_pct 0.0332  ->  3.5PP
 * -124 was exactly the Poly net on the flag, so nothing was wrong with
 * fee adjustment. The variable that moved was the MODEL: -142 at emit on
 * 09-02, -130 a day later. The badge is frozen (correctly -- the row is
 * locked and that freeze is what protects CLV); the numbers beside it are
 * live; and nothing said so.
 *
 * BOTH numbers, not a replacement: 3.3 -> 0.8 is a decaying signal, which
 * is a different situation from one that was always marginal. Showing
 * only the current edge would erase that.
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const src = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');

// ---- load the helpers out of the page ---------------------------------
const a = src.indexOf('  function _impliedP(ml) {');
const b = src.indexOf('  function sigPillHtml(s, g) {');
ok(a > 0 && b > a, 'provenance helpers are present, above sigPillHtml');
if (!(a > 0 && b > a)) {
  // Fail legibly rather than crashing on a bad slice: a stack trace tells
  // the reader the test broke, not that the feature is missing.
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed  (helpers absent -- nothing further could run)');
  process.exit(1);
}
eval(src.slice(a, b));

const g = { model_away_ml: -130, model_home_ml: 126, market_away_ml: -126, market_home_ml: 105 };
const locked = { signal_type: 'ML', signal_side: 'away', edge_pct: 0.0332,
                 model_line: -142, market_line: -124,
                 bet_locked_at: '2026-09-02 17:26:13', created_at: '2026-09-02 14:03:33' };

// ---- 1. the badge itself still shows the emit figure -------------------
ok(src.includes("Math.round((s.edge_pct || 0) * 100 / 0.5) * 0.5"),
   'the badge still renders stored edge_pct -- it was never wrong, only unlabelled');

// ---- 2. BOTH numbers appear -------------------------------------------
const chip = sigProvenanceHtml(locked, g);
ok(chip !== '', 'a locked, diverged signal gets a provenance chip');
ok(/now 0\.8pp/.test(chip),
   'the chip carries the LIVE edge (0.8pp) alongside the badge (3.5PP)');
ok(!/3\.5|3\.3/.test(chip.replace(/title="[^"]*"/, '')),
   'and does not restate the emit figure in the chip -- the badge already is it');

// ---- 3. the timestamp is VISIBLE, not tooltip-only ---------------------
const visible = chip.replace(/<[^>]+>/g, '');
ok(/@\d\d-\d\d \d\d:\d\d/.test(visible),
   'the emit timestamp renders as visible text (got: ' + visible.trim() + ')');
ok(/frozen/.test(chip) && /Live now/.test(chip),
   'and the tooltip explains both sides');

// ---- 4. no invented number for markets the client cannot recompute -----
const tot = { signal_type: 'Total', signal_side: 'under', edge_pct: 0.0456,
              model_line: 7.67, market_line: 9.5, bet_locked_at: '2026-09-02 15:00:00' };
eq(_liveEdgePp(tot, g), null, 'a Total gets NO live edge -- TOT_SLOPE lives server-side');
const totChip = sigProvenanceHtml(tot, g);
ok(totChip !== '' && !/now /.test(totChip.replace(/title="[^"]*"/, '')),
   'the Total still gets a timestamp, but no fabricated "now" figure');
ok(/cannot recompute it the way the engine does/.test(totChip),
   'and the tooltip says why rather than leaving a silent gap');

// ---- 5. restraint: no chip when there is nothing to explain ------------
const fresh = { signal_type: 'ML', signal_side: 'away', edge_pct: 0.0077,
                model_line: -130, market_line: -126, created_at: '2026-09-03 20:00:00' };
eq(sigProvenanceHtml(fresh, g), '',
   'a fresh unlocked signal still matching the live edge gets NO chip '
   + '(a marker on every pill trains the eye to skip it)');

// ---- 6. the spread block shows its own generated_at --------------------
ok(src.includes('es.generated_at'),
   'the empirical-spread block reads generated_at (the API always sent it)');
ok(/as of/.test(src.slice(src.indexOf('emp-spread-title'), src.indexOf('emp-spread-title') + 3000))
   || src.includes('" as of "'),
   'and renders it, so its pp figures carry a time too');

// ---- 7. the venue flag was already correct ----------------------------
ok(src.includes('frozen ') && src.includes('as of '),
   'the venue flag already self-timestamps when frozen/stale -- unchanged');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
