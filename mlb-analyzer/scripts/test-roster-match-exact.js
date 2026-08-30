#!/usr/bin/env node
/**
 * The bullpen pool admits by exact name, not by surname. (2026-08-30)
 *
 * THE BUG. q.getBullpenWoba admitted a projection row when any rostered RP's
 * name ended in a space plus the candidate's surname -- the first name was
 * never checked. 22 non-roster players were admitted that way across 14
 * teams, and CWS/Shane Smith reached a PRICED pool (admitted via Hagen
 * Smith), carrying an actuals sample 7.33x his logged BF.
 *
 * WHY EXACT AND NOT FIRST-INITIAL. Measured over all 30 teams:
 *   EXACT   admits 249 -- all 249 rostered RPs, 1:1. Nothing relies on a
 *           fallback.
 *   INITIAL admits 250 -- the one extra is SF/Darien Smith off the roster's
 *           Dylan Smith, i.e. still a phantom.
 *   SURNAME admits 271 -- 22 phantoms.
 * mlb_id matching is not available: projection rows carry only a
 * 'Name TEAM' string with no id, and at 249/249 it buys nothing.
 *
 * THREE COPIES existed. db/schema.js had two (the pool filter and the
 * fallback-injection surname skip) and routes/api.js had one
 * (/debug/bullpen role tagging). All three are asserted here, because
 * fixing one copy of a duplicated rule is how the previous three rounds of
 * this went.
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const { q, db } = require(path.join(R, 'db/schema'));
const { normName } = require(path.join(R, 'utils/names'));
const norm = s => normName(String(s || ''));

// ---- 1. no surname-only identity match survives in code -----------------
// Assert on the CODE form, not the bare phrase: both files now carry
// comments quoting the old expression, and a test that cannot tell the
// defect from the note explaining it has bitten this repo three times.
const schemaSrc = fs.readFileSync(path.join(R, 'db/schema.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
const codeOnly = src => src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

ok(!codeOnly(schemaSrc).includes("some(n => n.endsWith(' '+last))"),
   'db/schema.js: pool filter has no surname fallback');
ok(!codeOnly(schemaSrc).includes('representedLast'),
   'db/schema.js: fallback injection has no surname-collision skip');
ok(!codeOnly(apiSrc).includes("some(n=>n.endsWith(' '+last))"),
   'routes/api.js: /debug/bullpen role tagging has no surname fallback');
ok(codeOnly(schemaSrc).includes('return activeRPSet.has(pn);'),
   'db/schema.js admits on exact normalised name');

// ---- 2. the invariant that justified EXACT ------------------------------
// Every rostered RP has an exactly-matching projection row. If this ever
// stops being true, EXACT starts dropping arms and the fallback question
// reopens -- so assert it rather than trusting the one-time measurement.
{
  const teams = db.prepare("SELECT DISTINCT team t FROM team_rosters WHERE role='RP'").all().map(r => r.t);
  let total = 0, matched = 0;
  const unmatched = [];
  for (const t of teams) {
    const roster = db.prepare("SELECT player_name FROM team_rosters WHERE team=? AND role='RP'").all(t)
      .map(r => norm(r.player_name));
    const proj = new Set(db.prepare(
      "SELECT player_name FROM woba_data WHERE data_key='pit-proj-rhb' AND player_name LIKE ?"
    ).all('% ' + t).map(r => norm(String(r.player_name).replace(new RegExp(' ' + t + '$'), ''))));
    for (const rn of roster) { total++; if (proj.has(rn)) matched++; else unmatched.push(t + '/' + rn); }
  }
  ok(total > 200, 'the roster has a realistic number of RPs (' + total + ')');
  // Not asserted as 100%: an arm without a projection is legitimately
  // possible (a callup). What matters is that he is not silently dropped --
  // he lands in the fallback list. So assert the coverage is high AND that
  // the un-matched ones are reported, not that the count is exactly zero.
  ok(matched / total > 0.95,
     'nearly every rostered RP has an exact projection match ('
     + matched + '/' + total + (unmatched.length ? '; unmatched: ' + unmatched.slice(0, 5).join(', ') : '') + ')');
}

// ---- 3. behavioural: a same-surname stranger is NOT admitted ------------
const T = 'ZZQ';                 // not an MLB abbreviation
const D = '2026-06-03';
const insR = db.prepare('INSERT OR REPLACE INTO team_rosters (player_name, team, role) VALUES (?,?,?)');
const insW = db.prepare('INSERT OR REPLACE INTO woba_data (data_key, player_name, woba, sample_size) VALUES (?,?,?,?)');

try {
  // One genuinely rostered reliever...
  insR.run('Hagen Zzqsmith', T, 'RP');
  // ...and a stranger who shares only the surname, on no roster.
  for (const hand of ['lhb', 'rhb']) {
    insW.run('pit-proj-' + hand, 'Hagen Zzqsmith ' + T, 0.300, 40);
    insW.run('pit-proj-' + hand, 'Shane Zzqsmith ' + T, 0.250, 40);   // better wOBA, so
    insW.run('pit-proj-' + hand, 'Hagen Zzqother ' + T, 0.310, 40);   // he would be picked
  }
  const res = q.getBullpenWobaBlended(T, '', [], 0.55, 0.45, 0.35, 0.65,
    0.45, 0.55, D, 0.335, 50, true, 0.25, 0.75, 1, null);
  ok(res != null, 'the seeded ZZQ pool resolves');
  if (res) {
    const names = (res.members || []).map(m => m.name);
    ok(names.includes('hagen zzqsmith'), 'the rostered reliever IS admitted');
    ok(!names.includes('shane zzqsmith'),
       'the same-surname stranger is NOT admitted (got: ' + names.join(', ') + ')');
    ok(!names.includes('hagen zzqother'),
       'a same-FIRST-name stranger is not admitted either');
    eq(res.pitchers, 1, 'the pool contains exactly the one rostered arm');
    // The stranger has the better projection, so had he been admitted the
    // pool wOBA would be pulled down. This is the assertion that would have
    // caught the original bug at the NUMBER, not just at the roster list.
    ok(Math.abs(res.woba - 0.300) < 0.02,
       'the pool wOBA reflects the rostered arm only (got ' + res.woba + ')');
  }

  // ---- 4. a rostered arm with NO projection is a visible fallback -------
  // This is what makes EXACT safe against name-format drift: he is not
  // silently dropped, he shows up in `fallbacks`.
  insR.run('Ghost Zzqarm', T, 'RP');
  const res2 = q.getBullpenWobaBlended(T, '', [], 0.55, 0.45, 0.35, 0.65,
    0.45, 0.55, D, 0.335, 50, true, 0.25, 0.75, 1, null);
  ok(res2 && res2.fallbacks >= 1,
     'a rostered RP with no projection row surfaces as a FALLBACK, not a silent drop'
     + ' (fallbacks=' + (res2 ? res2.fallbacks : 'n/a') + ')');
  ok(res2 && (res2.members || []).some(m => m.name === 'ghost zzqarm'),
     'and he is listed as a member');
} finally {
  db.prepare('DELETE FROM team_rosters WHERE team=?').run(T);
  db.prepare("DELETE FROM woba_data WHERE player_name LIKE '%' || ?").run(T);
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
