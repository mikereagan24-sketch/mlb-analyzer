#!/usr/bin/env node
/**
 * Which roster-match rule does the data support? (2026-08-30)
 *
 * The pool filter admits a projection row when any rostered RP's name ends in
 * a space plus the candidate's SURNAME -- the first name is never checked.
 * 22 non-roster pitchers get in that way; one reaches a priced pool.
 *
 * Three candidate rules, measured against the live tables:
 *
 *   EXACT     normalised full name must be on the roster. Safest, but drops
 *             any legitimate arm whose name is spelled differently between
 *             the projection source and the roster source.
 *   INITIAL   surname match AND first initial match. The idiom utils/names.js
 *             already uses for the wOBA lookup, so it is not a new concept.
 *   SURNAME   what we do today.
 *
 * The question that decides it: does the SURNAME fallback currently rescue
 * any LEGITIMATE arm that EXACT would lose? If it rescues nothing, its only
 * effect is the phantoms.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));
const { normName } = require(path.join(R, 'utils/names'));

const norm = s => normName(String(s || ''));
const teams = db.prepare("SELECT DISTINCT team t FROM team_rosters WHERE role='RP' ORDER BY t").all().map(r => r.t);
const apps = db.prepare('SELECT COUNT(*) n, MAX(game_date) last FROM pitcher_game_log WHERE team=? AND lower(pitcher_name)=?');

let nExact = 0, nInitial = 0, nSurname = 0;
const gainedByInitial = [];   // in INITIAL but not EXACT -- the rescues
const gainedBySurname = [];   // in SURNAME but not INITIAL -- the phantoms

for (const t of teams) {
  const roster = db.prepare("SELECT player_name FROM team_rosters WHERE team=? AND role='RP'").all(t)
    .map(r => norm(r.player_name));
  const rset = new Set(roster);
  if (!rset.size) continue;

  const projRows = db.prepare(
    "SELECT player_name FROM woba_data WHERE data_key='pit-proj-rhb' AND player_name LIKE ?"
  ).all('% ' + t);

  for (const row of projRows) {
    const pn = norm(String(row.player_name).replace(new RegExp(' ' + t + '$'), ''));
    if (!pn) continue;
    const parts = pn.split(' ');
    const last = parts[parts.length - 1];
    const init = parts[0] ? parts[0][0] : '';

    const exact = rset.has(pn);
    const initial = exact || roster.some(n => {
      const p = n.split(' ');
      return p[p.length - 1] === last && p[0] && p[0][0] === init;
    });
    const surname = exact || roster.some(n => n.endsWith(' ' + last));

    if (exact) nExact++;
    if (initial) nInitial++;
    if (surname) nSurname++;

    if (initial && !exact) {
      const a = apps.get(t, pn);
      gainedByInitial.push({ t, pn, apps: a.n, last: a.last });
    }
    if (surname && !initial) {
      const a = apps.get(t, pn);
      gainedBySurname.push({ t, pn, apps: a.n, last: a.last });
    }
  }
}

console.log('=== CANDIDATES ADMITTED, BY RULE (all 30 teams) ===');
console.log('  EXACT   (full normalised name on roster) : ' + nExact);
console.log('  INITIAL (surname + first initial)        : ' + nInitial + '   (+' + (nInitial - nExact) + ')');
console.log('  SURNAME (today)                          : ' + nSurname + '   (+' + (nSurname - nInitial) + ' over INITIAL)');
console.log('');

console.log('=== WHAT THE FIRST-INITIAL RULE RESCUES OVER EXACT ===');
console.log('  (these are the arms a strict EXACT rule would LOSE)');
if (!gainedByInitial.length) console.log('  none.');
for (const g of gainedByInitial) {
  console.log('  ' + g.t.padEnd(5) + g.pn.padEnd(24)
    + 'appearances for team: ' + String(g.apps).padStart(3)
    + '   last: ' + (g.last || '-'));
}
console.log('');

console.log('=== WHAT THE SURNAME RULE ADMITS OVER FIRST-INITIAL ===');
console.log('  (these are the phantoms the current rule lets in)');
if (!gainedBySurname.length) console.log('  none.');
let phantomReal = 0;
for (const g of gainedBySurname) {
  if (g.apps > 0) phantomReal++;
  console.log('  ' + g.t.padEnd(5) + g.pn.padEnd(24)
    + 'appearances for team: ' + String(g.apps).padStart(3)
    + '   last: ' + (g.last || '-')
    + (g.apps > 0 ? '   <-- has pitched for them' : ''));
}
console.log('');
console.log('=== VERDICT INPUTS ===');
console.log('  arms rescued by INITIAL over EXACT      : ' + gainedByInitial.length);
console.log('  phantoms admitted by SURNAME over INITIAL: ' + gainedBySurname.length);
console.log('  ...of those, with any appearance for the team: ' + phantomReal);
