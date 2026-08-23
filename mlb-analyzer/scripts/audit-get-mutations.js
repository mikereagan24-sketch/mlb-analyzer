#!/usr/bin/env node
/**
 * Find read endpoints that write. (2026-08-23)
 *
 * WHY. GET /backtest ran UPDATE bet_signals SET closing_line = market_line
 * on every request, fabricating 762 totals closing lines that were
 * indistinguishable from observations. Nobody noticed for months because a
 * GET is assumed safe -- the failure is invisible until someone asks why
 * data changed that nobody edited.
 *
 * This scans every router.get / router.head handler in the API for
 * mutating SQL, so the class is enumerated rather than rediscovered.
 *
 * METHOD, and its limits. Brace-matches each handler body from the
 * router.get( line and looks for UPDATE / INSERT / DELETE / REPLACE /
 * CREATE / DROP / ALTER inside it. It is textual, so:
 *   - a mutation inside a helper the handler CALLS is not seen (reported
 *     as a known blind spot rather than silently missed);
 *   - a mutating string in a comment counts as a hit, which is the safe
 *     direction for an audit -- a false positive costs a glance, a false
 *     negative costs another six months.
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

const FILES = ['routes/api.js'];
const MUTATORS = /\b(UPDATE|INSERT\s+INTO|INSERT\s+OR|DELETE\s+FROM|REPLACE\s+INTO|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b/i;

function handlerBodies(src, verb) {
  const out = [];
  const re = new RegExp("router\\." + verb + "\\s*\\(", 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    // route path is the first quoted arg
    const after = src.slice(m.index, m.index + 200);
    const pm = after.match(/router\.\w+\s*\(\s*['"`]([^'"`]+)['"`]/);
    const route = pm ? pm[1] : '(dynamic)';
    // brace-match the whole router.get(...) call
    let i = src.indexOf('(', m.index), depth = 0, j = i;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(i, j + 1);
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ route, line, body, verb });
  }
  return out;
}

(function main() {
  console.log('=== GET/HEAD endpoints that mutate ===');
  let total = 0, flagged = 0;
  const hits = [];

  for (const f of FILES) {
    const src = fs.readFileSync(path.join(R, f), 'utf8');
    for (const verb of ['get', 'head']) {
      for (const h of handlerBodies(src, verb)) {
        total++;
        const found = [];
        // report every distinct mutating statement, with its own line number
        const lines = h.body.split('\n');
        lines.forEach((ln, k) => {
          if (MUTATORS.test(ln)) {
            const isComment = /^\s*(\/\/|\*)/.test(ln);
            found.push({
              line: h.line + k,
              text: ln.trim().slice(0, 100),
              commented: isComment,
            });
          }
        });
        if (found.length) {
          flagged++;
          hits.push({ file: f, ...h, found });
        }
      }
    }
  }

  console.log('  GET/HEAD handlers scanned : ' + total);
  console.log('  handlers containing mutating SQL : ' + flagged);
  console.log('');

  for (const h of hits) {
    const live = h.found.filter(x => !x.commented);
    const dead = h.found.filter(x => x.commented);
    console.log('  ' + h.verb.toUpperCase() + ' ' + h.route + '   (' + h.file + ':' + h.line + ')');
    live.forEach(x => console.log('     LIVE      :' + x.line + '  ' + x.text));
    dead.forEach(x => console.log('     commented :' + x.line + '  ' + x.text));
    console.log('');
  }

  const liveHits = hits.filter(h => h.found.some(x => !x.commented));
  console.log('=== summary ===');
  console.log('  handlers with LIVE mutations: ' + liveHits.length);
  liveHits.forEach(h => console.log('    ' + h.verb.toUpperCase() + ' ' + h.route));
  console.log('');
  // ---- second pass: close the call-graph blind spot for KNOWN mutators.
  // Textual scanning misses a handler that delegates its write. These are
  // the functions in this codebase that are known to persist, so a GET that
  // calls one is mutating even though no SQL appears in its body.
  const KNOWN_MUTATORS = [
    'runOddsJob', 'processOddsArray', 'processGameSignals', 'refreshSignalBaselines',
    'runScoreJob', 'runLineupJob', 'runRosterJob', 'runWeatherJob', 'writeClosing',
    'refreshFirstPitch', 'insertSignal', 'insertBetSignalAudit', 'runMorningCaptureJob',
    'detectOpeners', 'runFangraphsWobaSyncJob', 'runCatcherFramingJob',
  ];
  console.log('=== second pass: GET handlers calling a known-mutating helper ===');
  let delegated = 0;
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(R, f), 'utf8');
    for (const verb of ['get', 'head']) {
      for (const h of handlerBodies(src, verb)) {
        // Plain substring match on `fn(` -- no regex, because escaping a
        // backslash through three layers of quoting has silently failed
        // twice while writing these scripts.
        const called = KNOWN_MUTATORS.filter(fn => h.body.indexOf(fn + '(') !== -1
                                              || h.body.indexOf(fn + ' (') !== -1);
        if (called.length) {
          delegated++;
          console.log('  ' + verb.toUpperCase() + ' ' + h.route + '  (' + f + ':' + h.line + ')');
          console.log('     calls: ' + called.join(', '));
        }
      }
    }
  }
  if (!delegated) console.log('  none.');
  console.log('');
  console.log('  REMAINING BLIND SPOT: a helper not on the KNOWN_MUTATORS list, or a');
  console.log('  write reached through two hops. The list is hand-maintained, which is');
  console.log('  the same shape of thing that has failed open three times in this repo --');
  console.log('  so treat a clean result as "nothing found", not "nothing there".');
})();
