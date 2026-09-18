#!/usr/bin/env node
/**
 * One name normalizer, one resolver. (2026-09-18)
 *
 * WHAT WAS DUPLICATED. Three files carried their own normName/stripSfx
 * and two carried their own catcher/fielder resolver:
 *
 *   scripts/backtest-run-environment.js    normName + stripSfx
 *   scripts/bullpen-report.js              normName + inline suffix strip
 *   routes/api.js  /debug/bullpen          norm + stripSfxA + a 26-line
 *                                          inline re-staging of fuzzyLookup,
 *                                          SHADOWING the module-level import
 *                                          on line 57 of the same file
 *   scripts/framing-frv-hindsight-backtest.js   resolveCatcherMlbId
 *   scripts/framing-frv-per-team-runs.js        resolveCatcherMlbId
 *
 * THE DIVERGENCE THAT MATTERED. Every normalizer copy omitted
 * utils/names' NORM_TRANSLIT fold. NFD does not decompose o-slash, ae,
 * oe, sharp-s, d-stroke, l-stroke or dotless-i, so those characters
 * survive the combining-mark strip and are then deleted outright by
 * [^a-z\s]:
 *
 *   utils/names  "Bjorn Larsen" (o-slash) -> "bjorn larsen"
 *   every copy   "Bjorn Larsen" (o-slash) -> "bjrn larsen"
 *
 * A lineup feed spelling the plain "Bjorn" against a roster spelling it
 * with the o-slash matches in production and misses in the copies. Not a
 * crash -- a silent null, which is the failure mode this repo keeps
 * finding one copy at a time.
 *
 * WHY THE CHARACTER IS BUILT FROM A CODE POINT BELOW. Writing the
 * literal into this file is precisely what went wrong while making this
 * change: the editing tool wrote a six-character escape sequence into
 * three source files instead of the character, and it looked correct in
 * every diff. A test for a character-encoding bug must not depend on the
 * encoding of its own source, so the fixture is assembled from
 * String.fromCharCode and its code point is asserted before use.
 *
 * Run: node scripts/test-normalizer-single-source.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const { normName, stripSfx, fuzzyLookup } = require(path.join(R, 'utils/names'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== normalizer + resolver: single source ===');

// ---- the fixture, assembled rather than typed -------------------------
const OSLASH = String.fromCharCode(0xF8);          // o with stroke
const BJORN = 'Bj' + OSLASH + 'rn Larsen';
ok('fixture carries a real o-slash, not an escape sequence',
   BJORN.codePointAt(2) === 0xF8 && BJORN.length === 12,
   'code point ' + BJORN.codePointAt(2).toString(16) + ', length ' + BJORN.length);

// The retired copy, frozen here as the historical reference.
const retiredNorm = (n) => (n || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, '')
  .replace(/\s+/g, ' ').trim();

ok('THE CASE: shared normName folds it to "bjorn larsen"',
   normName(BJORN) === 'bjorn larsen', JSON.stringify(normName(BJORN)));
ok('and the retired copy dropped the character entirely',
   retiredNorm(BJORN) === 'bjrn larsen', JSON.stringify(retiredNorm(BJORN)));
ok('so the two genuinely disagreed -- this test is not vacuous',
   normName(BJORN) !== retiredNorm(BJORN));
ok('the plain-ASCII spelling converges on the SAME key',
   normName('Bjorn Larsen') === normName(BJORN),
   'which is what makes a feed/roster spelling mismatch resolve');

// The rest of the translit table, same shape.
for (const [ch, want] of [[0xE6, 'ae'], [0x153, 'oe'], [0xDF, 'ss'],
                          [0x111, 'd'], [0x142, 'l'], [0x131, 'i']]) {
  const c = String.fromCharCode(ch);
  ok('translit ' + c + ' -> ' + want,
     normName('x' + c + 'x') === 'x' + want + 'x',
     JSON.stringify(normName('x' + c + 'x')));
}

// ---- stripSfx ---------------------------------------------------------
ok('stripSfx still removes generational suffixes',
   stripSfx(normName('Bob Smith Jr')) === 'bob smith'
   && stripSfx(normName('Ken Griffey III')) === 'ken griffey');

// ---- NO SECOND COPY ANYWHERE IN PROD OR SCRIPTS -----------------------
// The grep is the durable half. Comments are stripped first so this
// file's own frozen reference, and the explanatory comments in the
// delegating files, do not read as copies.
const SITES = ['routes', 'services', 'utils', 'scripts', 'db'];
const offenders = [];
const walk = (rel) => {
  for (const e of fs.readdirSync(path.join(R, rel), { withFileTypes: true })) {
    const p = rel + '/' + e.name;
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.js')) continue;
    if (p === 'utils/names.js') continue;                      // the source of truth
    if (p === 'scripts/test-normalizer-single-source.js') continue;  // this file
    const code = fs.readFileSync(path.join(R, p), 'utf8')
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // The NFD + combining-mark strip pair is the fingerprint of a copy.
    if (/normalize\(['"]NFD['"]\)[\s\S]{0,80}\\u0300-\\u036f/.test(code)
        || /normalize\(['"]NFD['"]\)[\s\S]{0,80}̀-ͯ/.test(code)) {
      offenders.push(p + '  (inline NFD normalizer)');
    }
    if (/\\b\(jr\|sr\|ii\|iii\|iv\)\\b/.test(code)) {
      offenders.push(p + '  (inline suffix strip)');
    }
  }
};
for (const d of SITES) walk(d);
// services/fangraphs.js strips marks for a DIFFERENT purpose -- it builds
// a NameASCII column for the FanGraphs CSV join, preserving case and
// punctuation, so it is not a name-normalizer copy and is named here
// rather than silently excluded by a broad pattern.
const EXPECTED = ['services/fangraphs.js  (inline NFD normalizer)'];
const unexpected = offenders.filter(o => !EXPECTED.includes(o));
ok('no file re-implements the normalizer or the suffix strip',
   unexpected.length === 0,
   unexpected.length ? unexpected.join('; ')
     : SITES.join(', ') + ' clean (fangraphs NameASCII excepted by name)');

// ---- each delegating site actually delegates --------------------------
const requiresNames = (rel, why) => {
  const src = fs.readFileSync(path.join(R, rel), 'utf8');
  ok(rel + ' requires utils/names', /require\(['"][^'"]*utils\/names['"]\)/.test(src), why);
};
requiresNames('scripts/backtest-run-environment.js', 'normName + stripSfx');
requiresNames('scripts/bullpen-report.js', 'normName + stripSfx');
requiresNames('routes/api.js', 'module-level, no longer shadowed');

const api = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
ok('/debug/bullpen aliases the shared normalizer rather than redefining it',
   api.indexOf('const norm = normName;') !== -1);
ok('/debug/bullpen delegates its act lookup to the shared fuzzyLookup',
   api.indexOf('const fuzzyLookupAct = (name, teamHint) => fuzzyLookup(actIdx, name, teamHint);') !== -1);
ok('and the inline re-staging is gone',
   api.indexOf('function stripSfxA(n)') === -1);

// ---- the two framing scripts use the shared resolver ------------------
for (const rel of ['scripts/framing-frv-hindsight-backtest.js',
                   'scripts/framing-frv-per-team-runs.js']) {
  const src = fs.readFileSync(path.join(R, rel), 'utf8');
  ok(rel + ' delegates to the shared resolver',
     src.indexOf('const resolveCatcherMlbId = jobs.resolveBacktestMlbId;') !== -1);
  ok(rel + ' no longer declares its own',
     src.indexOf('function resolveCatcherMlbId(') === -1);
}

// ---- the shared resolver is strictly stronger, on real rows -----------
// The claim in those two files' comments is "237 gained, 0 lost, 0
// different". Re-derive the direction of it here rather than trusting
// the number in a comment: the shared resolver must never resolve FEWER
// slots than the retired local rule, and must never disagree on one they
// both resolve.
const { q } = require(path.join(R, 'db/schema'));
const jobs = require(path.join(R, 'services/jobs'));
const retiredResolve = (team, lineupName) => {
  if (!team || !lineupName) return null;
  const parts = stripSfx(normName(lineupName)).split(' ');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1], firstInit = parts[0][0];
  const cands = [];
  try {
    for (const p of q.getPositionPlayers.all(team)) {
      const pp = stripSfx(normName(p.player_name)).split(' ');
      if (pp.length < 2) continue;
      if (pp[pp.length - 1] === last && pp[0][0] === firstInit) cands.push(p);
    }
  } catch (e) { return null; }
  return cands.length === 1 ? cands[0].mlb_id : null;
};

const FIELD = new Set(['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']);
const { db } = require(path.join(R, 'db/schema'));
let gained = 0, lost = 0, conflict = 0, same = 0;
const seen = new Set();
for (const r of db.prepare(
  'SELECT game_id, away_lineup_json a, home_lineup_json h FROM game_log '
  + 'WHERE away_lineup_json IS NOT NULL').iterate()) {
  const [aw, hm] = String(r.game_id).split('-');
  for (const [team, j] of [[aw, r.a], [hm, r.h]]) {
    let arr = null;
    try { arr = JSON.parse(j || 'null'); } catch (e) { /* skip */ }
    if (!Array.isArray(arr)) continue;
    const T = String(team).toUpperCase();
    for (const p of arr) {
      if (!p || !p.name) continue;
      const pos = String(p.pos || '').toUpperCase();
      if (pos !== 'C' && !FIELD.has(pos)) continue;
      const k = T + '|' + p.name;
      if (seen.has(k)) continue;
      seen.add(k);
      const L = retiredResolve(T, p.name);
      const S = jobs.resolveBacktestMlbId(T, p.name);
      if (L === S) { same++; } else if (L == null) { gained++; }
      else if (S == null) { lost++; } else { conflict++; }
    }
  }
}
console.log('  resolver delta over ' + seen.size + ' distinct (team,name) lineup slots:'
  + '  same ' + same + '  gained ' + gained + '  lost ' + lost + '  conflict ' + conflict);
ok('the shared resolver loses nothing the local rule found',
   lost === 0, lost + ' slots would have regressed');
ok('and never resolves a slot to a DIFFERENT player',
   conflict === 0, conflict + ' conflicting ids');
ok('the delegation is a real gain, not a no-op',
   gained > 0, gained + ' slots the local rule dropped silently');

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
