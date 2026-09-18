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
 *
 * ---------------------------------------------------------------------
 * REPAIRED 2026-09-17, after 13 days red. Two separate causes, and the
 * split between them is the whole point of this note.
 *
 * CAUSE 1 -- MECHANISM. The test located the page helpers by slicing
 * between two hardcoded, INDENTATION-SENSITIVE anchors:
 *
 *     src.indexOf('  function _impliedP(ml) {')      // two leading spaces
 *     src.indexOf('  function sigPillHtml(s, g) {')
 *
 * 9496b98 (2026-09-04) hoisted _impliedP to top level so the bet boxes
 * could share it instead of growing a second copy -- a good change, and
 * the reason the page has one implied-probability helper rather than two.
 * It de-indented the function, the anchor stopped matching, the slice
 * went empty, and every assertion below it stopped running. The test
 * exited 1 the whole time; nobody was running it (see CAUSE 3).
 *
 * Fixed by extracting the helpers BY NAME with brace matching, at any
 * indentation. A refactor that MOVES a function no longer breaks this
 * test; one that DELETES it still does, which is the property worth
 * having.
 *
 * CAUSE 2 -- TWO ASSERTIONS DESCRIBED A DESIGN THAT WAS DELIBERATELY
 * REPLACED. The same commit moved the live edge out of the chip and into
 * the ML bet box, where the live model and live market it derives from
 * are printed. The chip became one coherent statement about emit. These
 * two are DELETED rather than weakened, because they no longer describe
 * a property the card has:
 *
 *     ok(/now 0\.8pp/.test(chip), 'the chip carries the LIVE edge')
 *     ok(!/3\.5|3\.3/.test(chip), 'and does not restate the emit figure')
 *
 * The first is now false by design; the live-edge behaviour it cared
 * about is covered, on real rows, by scripts/test-live-edge-highlight.js.
 * The second is INVERTED by design -- the chip now restates the emit
 * figure on purpose ("was 3.3pp @09-02 14:03 at -124"), because the
 * missing piece in BOS@BAL was the frozen PRICE, and a chip that named
 * the pp without the line it was struck against could not be reconciled
 * by eye. That property is asserted positively below.
 *
 * Wording-only regexes ('Live now', 'cannot recompute it the way') are
 * updated to the current strings. That is not weakening: the property --
 * the tooltip explains both moments, and says why a Total has no live
 * figure -- is unchanged, only its phrasing moved.
 *
 * CAUSE 3 -- NOTHING RAN IT. No npm script, no CI, no cron, and no row
 * in CLAUDE.md's review checklist. A test that fails loudly and is never
 * invoked is indistinguishable from one that passes. Checklist row added
 * in the same commit.
 *
 * Run: node scripts/test-emit-time-provenance.js
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const src = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');

// ---- load the helpers out of the page ---------------------------------
// By NAME, brace-matched, at any indentation. index.html is not
// requireable, so the functions have to come out of the text one way or
// another; what must not happen again is a locator that encodes the
// page's FORMATTING and silently matches nothing when that changes.
function extractFn(text, name) {
  const re = new RegExp('(?:^|\\n)\\s*function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(text);
  if (!m) return null;
  const open = text.indexOf('{', m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(text.indexOf('function', m.index), i + 1);
    }
  }
  return null;
}

// sigProvenanceHtml -> _emitStamp, liveEdgePpML -> effAwayML/effHomeML,
// _impliedP. Pulled explicitly so a missing dependency names itself
// instead of surfacing as a ReferenceError inside an assertion.
const NEEDED = ['_impliedP', 'effAwayML', 'effHomeML', 'liveEdgePpML',
                '_emitStamp', 'sigProvenanceHtml'];
const bodies = {};
const missing = [];
for (const n of NEEDED) {
  const body = extractFn(src, n);
  if (body) bodies[n] = body; else missing.push(n);
}
ok(missing.length === 0,
   'every provenance helper is present in the page'
   + (missing.length ? ' -- MISSING: ' + missing.join(', ') : ''));
if (missing.length) {
  // Fail legibly rather than crashing on a bad slice: a stack trace tells
  // the reader the test broke, not that the feature is missing.
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed  (helpers absent -- nothing further could run)');
  process.exit(1);
}
eval(NEEDED.map(n => bodies[n]).join('\n'));

const g = { model_away_ml: -130, model_home_ml: 126, market_away_ml: -126, market_home_ml: 105 };
const locked = { signal_type: 'ML', signal_side: 'away', edge_pct: 0.0332,
                 model_line: -142, market_line: -124,
                 bet_locked_at: '2026-09-02 17:26:13', created_at: '2026-09-02 14:03:33' };

// ---- 1. the badge itself still shows the emit figure -------------------
ok(src.includes("Math.round((s.edge_pct || 0) * 100 / 0.5) * 0.5"),
   'the badge still renders stored edge_pct -- it was never wrong, only unlabelled');

// ---- 2. the chip is a COHERENT STATEMENT ABOUT EMIT --------------------
// Rewritten 2026-09-04 (asserted here 2026-09-17). Everything in the chip
// belongs to one moment: the emit-time edge, when it was struck, and the
// price it was struck against. The frozen market_line is the piece whose
// absence made BOS@BAL irreconcilable by eye.
const chip = sigProvenanceHtml(locked, g);
ok(chip !== '', 'a locked, diverged signal gets a provenance chip');
const chipText = chip.replace(/title="[^"]*"/, '').replace(/<[^>]+>/g, '');
ok(/was 3\.3pp/.test(chipText),
   'the chip states the EMIT-time edge (got: ' + chipText.trim() + ')');
ok(/at -124/.test(chipText),
   'and the frozen PRICE it was struck at -- the number missing from BOS@BAL');
ok(!/now /.test(chipText),
   'and carries no live figure: that moved to the ML bet box, beside the '
   + 'live model and market it is computed from');

// ---- 3. the timestamp is VISIBLE, not tooltip-only ---------------------
ok(/@\d\d-\d\d \d\d:\d\d/.test(chipText),
   'the emit timestamp renders as visible text (got: ' + chipText.trim() + ')');
ok(/frozen/.test(chip) && /CURRENT edge/.test(chip),
   'and the tooltip explains both moments -- what is frozen, and where the '
   + 'current number lives');

// ---- 4. no invented number for markets the client cannot recompute -----
const tot = { signal_type: 'Total', signal_side: 'under', edge_pct: 0.0456,
              model_line: 7.67, market_line: 9.5, bet_locked_at: '2026-09-02 15:00:00' };
eq(liveEdgePpML(tot, g), null, 'a Total gets NO live edge -- TOT_SLOPE lives server-side');
const totChip = sigProvenanceHtml(tot, g);
ok(totChip !== '' && !/now /.test(totChip.replace(/title="[^"]*"/, '')),
   'the Total still gets a timestamp, but no fabricated "now" figure');
ok(/cannot\s+recompute a totals edge the way the engine does/.test(totChip),
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
// Tightened 2026-09-17: the old form fell back to a bare '" as of "'
// search anywhere in a 5,700-line file, which would pass on an unrelated
// match. Assert the render sits with the read.
const genIdx = src.indexOf('es.generated_at');
ok(/" as of "/.test(src.slice(genIdx, genIdx + 800)),
   'and renders it beside that read, so its pp figures carry a time too');

// ---- 7. the venue flag was already correct ----------------------------
ok(src.includes('frozen ') && src.includes('as of '),
   'the venue flag already self-timestamps when frozen/stale -- unchanged');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
