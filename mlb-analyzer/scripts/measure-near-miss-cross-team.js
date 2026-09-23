#!/usr/bin/env node
'use strict';
// How much of the near-miss badge's signal was cross-team noise? (2026-09-23)
//
//   <node20>/node.exe --max-old-space-size=1536 scripts/measure-near-miss-cross-team.js
//
// WHY. The badge flags a batter whose actuals row did not resolve but whose
// SURNAME sits in the actuals index, on the theory that a surname present
// and unmatched is a resolver failure rather than absent data. The scan
// skipped a candidate only when the candidate's KEY CARRIED A DIFFERENT
// TEAM TAG -- and actuals keys are tagged only on collision since #438, so
// a bare key was never team-checked at all. Reported live:
//
//   E. Rodriguez [MIN] -> "NEAR MISS: Endy Rodriguez (same initial)"  (PIT)
//   Bo Davidson  [SF]  -> "NEAR MISS: Logan Davidson"                 (not him)
//
// This replays every 2026 lineup slot against ITS OWN DATE'S snapshot --
// the index the page would have scanned that day -- classifies each
// old-logic near miss by where the named candidate can actually be placed,
// and counts how many were another team's player.
//
// It also answers the design question the fix turns on: if bare candidates
// were dropped entirely, how much REAL signal goes with them? That is the
// `bare, this team` row.
//
// Read-only. No writes, no model runs, scalars only.

const path = require('path');
const R = path.join(__dirname, '..');
const ps = require(path.join(R, 'services/parameter-sweep'));
const { normName, stripSfx, hasTeamTag, fuzzyLookup } = require(path.join(R, 'utils/names'));
const Database = require('better-sqlite3');
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const MIN_PA = 60;
const FROM = process.argv[2] || '2026-01-01';
const TO = process.argv[3] || '2026-12-31';

// ---------------------------------------------------------------- rosters
// Where can a normalised name be placed? team_rosters_season keeps players
// who were later optioned, traded or shut down (#450), so it places more
// names than the daily 840-row team_rosters snapshot can.
const placeSeason = new Map();   // normName -> Set(team)
const placeDaily = new Map();
function addPlace(map, name, team) {
  for (const k of [normName(name), stripSfx(normName(name))]) {
    if (!k) continue;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(String(team).toLowerCase());
  }
}
for (const t of ['team_rosters_season', 'team_rosters']) {
  let rows = [];
  try { rows = db.prepare('SELECT team, player_name FROM ' + t + " WHERE role='POS'").all(); }
  catch (e) { console.log('  (no ' + t + ': ' + e.message + ')'); continue; }
  for (const r of rows) addPlace(t === 'team_rosters' ? placeDaily : placeSeason, r.player_name, r.team);
}
const placedOn = (base) => {
  const s = new Set();
  for (const m of [placeSeason, placeDaily]) {
    for (const k of [base, stripSfx(base)]) {
      const hit = m.get(k);
      if (hit) for (const t of hit) s.add(t);
    }
  }
  return s;
};

// ------------------------------------------------- the OLD classifier
// Reproduced deliberately: this measures what SHIPPED, so it must be the
// shipped rule and not the fixed one. The only difference from
// routes/api.js before 2026-09-23 is that it returns every candidate's
// provenance instead of just the winner.
function oldNearMiss(keyMap, name, teamHint) {
  if (!keyMap) return null;
  const p = stripSfx(normName(name)).split(' ');
  if (p.length < 2) return null;
  const last = p[p.length - 1], initial = p[0][0];
  const tl = teamHint ? String(teamHint).toLowerCase() : null;
  let best = null;
  for (const key of Object.keys(keyMap)) {
    const tagged = hasTeamTag(key);
    const cut = tagged ? key.lastIndexOf(' ') : -1;
    const base = tagged ? key.slice(0, cut) : key;
    const tag = tagged ? key.slice(cut + 1) : null;
    const bp = stripSfx(base).split(' ');
    if (bp.length < 1 || bp[bp.length - 1] !== last) continue;
    if (tag && tl && tag !== tl) continue;
    const sameInitial = !!(bp[0] && bp[0][0] === initial);
    const cand = { key, base, team: tag, sameInitial };
    if (!best) best = cand;
    else if (cand.sameInitial && !best.sameInitial) best = cand;
    else if (cand.sameInitial === best.sameInitial && cand.team && !best.team) best = cand;
  }
  return best;
}

// ---------------------------------------------------------------- replay
const games = db.prepare(
  'SELECT game_date, away_team, home_team, away_sp_hand, home_sp_hand, '
  + 'away_lineup_json, home_lineup_json FROM game_log '
  + 'WHERE game_date BETWEEN ? AND ? AND (away_lineup_json IS NOT NULL OR home_lineup_json IS NOT NULL) '
  + 'ORDER BY game_date').all(FROM, TO);

const K = {
  slots: 0, noActuals: 0, nearMiss: 0,
  tagged_this: 0, bare_this: 0, bare_other: 0, bare_unplaced: 0,
};
const examples = { bare_other: new Map(), bare_this: new Map(), bare_unplaced: new Map() };
let curDate = null, idx = null, dates = 0;

for (const g of games) {
  if (g.game_date !== curDate) {
    curDate = g.game_date;
    idx = ps.loadWobaSnapshot(db, curDate);
    dates++;
  }
  if (!idx) continue;
  for (const side of ['away', 'home']) {
    const raw = g[side + '_lineup_json'];
    if (!raw) continue;
    let lu = null;
    try { lu = JSON.parse(raw); } catch (e) { continue; }
    const team = g[side + '_team'];
    const oppHand = side === 'away' ? (g.home_sp_hand || 'R') : (g.away_sp_hand || 'R');
    const actKey = oppHand === 'R' ? 'bat-act-rhp' : 'bat-act-lhp';
    const keyMap = idx[actKey];
    if (!keyMap) continue;
    for (const b of (lu || [])) {
      if (!b || !b.name) continue;
      K.slots++;
      const hit = fuzzyLookup(keyMap, b.name, team);
      if (hit) continue;                       // resolved: no badge at all
      K.noActuals++;
      const nm = oldNearMiss(keyMap, b.name, team);
      if (!nm) continue;
      K.nearMiss++;
      const tl = String(team).toLowerCase();
      const label = b.name + ' [' + team + '] -> ' + nm.key;
      if (nm.team) { K.tagged_this++; continue; }   // tagged with this team
      const where = placedOn(nm.base);
      if (where.has(tl)) {
        K.bare_this++;
        examples.bare_this.set(label, (examples.bare_this.get(label) || 0) + 1);
      } else if (where.size) {
        K.bare_other++;
        const lab = label + '  (placed: ' + [...where].join('/') + ')';
        examples.bare_other.set(lab, (examples.bare_other.get(lab) || 0) + 1);
      } else {
        K.bare_unplaced++;
        examples.bare_unplaced.set(label, (examples.bare_unplaced.get(label) || 0) + 1);
      }
    }
  }
}

// ---------------------------------------------------------------- report
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';
console.log('');
console.log('=== near-miss flags, 2026, replayed on each date\'s own snapshot ===');
console.log('  window ' + FROM + '..' + TO + '   snapshot dates ' + dates
  + '   season rosters ' + placeSeason.size + ' names, daily ' + placeDaily.size);
console.log('');
console.log('  lineup slots                       ' + K.slots);
console.log('  actuals did NOT resolve            ' + K.noActuals + '  (' + pct(K.noActuals, K.slots) + ' of slots)');
console.log('  ...of which flagged NEAR MISS      ' + K.nearMiss + '  (' + pct(K.nearMiss, K.noActuals) + ' of those)');
console.log('');
console.log('  where the named candidate sits:');
console.log('    tagged with THIS team            ' + K.tagged_this + '  (' + pct(K.tagged_this, K.nearMiss) + ')  scoped correctly already');
console.log('    bare, roster places on THIS team ' + K.bare_this + '  (' + pct(K.bare_this, K.nearMiss) + ')  real signal, untagged');
console.log('    bare, roster places ELSEWHERE    ' + K.bare_other + '  (' + pct(K.bare_other, K.nearMiss) + ')  CROSS-TEAM -- noise');
console.log('    bare, placeable nowhere          ' + K.bare_unplaced + '  (' + pct(K.bare_unplaced, K.nearMiss) + ')  undecidable from rosters');
console.log('');
const show = (m, title, lim) => {
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, lim);
  if (!rows.length) return;
  console.log('  ' + title + ':');
  for (const [k, n] of rows) console.log('    ' + String(n).padStart(4) + '  ' + k);
  console.log('');
};
show(examples.bare_other, 'CROSS-TEAM, most frequent', 20);
show(examples.bare_this, 'same team but untagged -- the signal a tag-only rule would lose', 15);
show(examples.bare_unplaced, 'placeable on no roster', 15);
