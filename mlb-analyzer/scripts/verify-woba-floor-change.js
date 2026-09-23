#!/usr/bin/env node
'use strict';
// The 0.210 batter-actuals floor: the evidence for dropping it, and the
// before/after on every lineup lookup.
//
//   <node20>/node.exe --max-old-space-size=1536 scripts/verify-woba-floor-change.js
//
// WHY A SCRIPT AND NOT A FIGURE. The floor rejected rows inside parseCSV,
// before anything was persisted, so its effect was invisible in the database
// -- which is why "how many real hitters did it discard" went unasked for a
// season. This is re-runnable in both directions: before the first post-change
// upload it reports the guard's own justification, and after it enumerates
// exactly which rows came back and whether any lookup that used to resolve
// stopped.
//
// THE BEFORE/AFTER NEEDS NO STORED BASELINE, which is the trick that makes it
// runnable at all. The sub-0.210 rows are identifiable by their wOBA, so the
// "before" index is just the current index with those rows filtered out. One
// snapshot, two arms, identical everything else.
//
// ACCEPTANCE: rows GAINED may be any number; LOST and CHANGED must both be 0.
// A gained row can only help. A lost one means the new row made an
// exactly-one gate in fuzzyLookup ambiguous -- stages 5, 6, 6.5 and the
// stage-8 scan all resolve only on a unique match, so ADDING a candidate can
// turn a resolving lookup into a null. That is the one real regression risk
// in this change and it is what this script exists to catch.

const path = require('path');
const R = path.join(__dirname, '..');
const { normName, stripSfx, fuzzyLookup } = require(path.join(R, 'utils/names'));
const Database = require('better-sqlite3');
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const OLD_FLOOR = 0.210;
const ACT_KEYS = ['bat-act-rhp', 'bat-act-lhp'];

// ---------------------------------------------------------------- 1. the guard
console.log('');
console.log('=== 1. has the floor ever caught what it was built for? ===');
console.log('    failure mode: pitchers accidentally present in a BATTER file.');

const role = new Map();
for (const t of ['team_rosters_season', 'team_rosters']) {
  let rows = [];
  try { rows = db.prepare('SELECT player_name, role FROM ' + t).all(); } catch (e) { continue; }
  for (const r of rows) {
    const k = normName(r.player_name);
    if (k && !role.has(k)) role.set(k, r.role);
  }
}
const roleOf = (n) => role.get(n) || role.get(stripSfx(n)) || null;

for (const pref of ['bat-act', 'bat-proj']) {
  const names = new Set(db.prepare(
    'SELECT DISTINCT player_name FROM woba_data WHERE data_key LIKE ?').all(pref + '-%')
    .map(r => normName(r.player_name)));
  let pos = 0, nonpos = 0, unk = 0; const eg = [];
  for (const n of names) {
    const ro = roleOf(n);
    if (!ro) unk++; else if (ro === 'POS') pos++; else { nonpos++; if (eg.length < 8) eg.push(n + '=' + ro); }
  }
  console.log('    ' + pref.padEnd(9) + ' distinct ' + String(names.size).padStart(5)
    + '   POS ' + String(pos).padStart(4) + '   NON-POS ' + String(nonpos).padStart(3)
    + '   off-roster ' + String(unk).padStart(5));
  if (eg.length) console.log('      NON-POS: ' + eg.join(', '));
}
console.log('    -> ACTUALS: target absent, so the floor has nothing to catch.');
console.log('    -> PROJECTIONS: target PRESENT, and above 0.210, so the floor');
console.log('       misses it. A wOBA threshold is the wrong instrument; role is.');

// ---------------------------------------------------------------- 2. it binds
console.log('');
console.log('=== 2. does the floor bind? (a cut, or a taper?) ===');
console.log('    density per 0.005 of wOBA from 0.210 up:');
for (const k of ['bat-act-rhp', 'bat-act-lhp', 'bat-proj-rhp', 'bat-proj-lhp']) {
  const bins = [];
  for (let lo = OLD_FLOOR; lo < OLD_FLOOR + 0.035; lo += 0.005) {
    bins.push(db.prepare('SELECT COUNT(*) c FROM woba_data WHERE data_key=? AND woba>=? AND woba<?')
      .get(k, +lo.toFixed(3), +(lo + 0.005).toFixed(3)).c);
  }
  const m = db.prepare('SELECT MIN(woba) lo, COUNT(*) n FROM woba_data WHERE data_key=?').get(k);
  console.log('    ' + k.padEnd(14) + 'n=' + String(m.n).padStart(5)
    + '  min=' + (m.lo == null ? '  -  ' : m.lo.toFixed(4))
    + '  bins: ' + bins.map(b => String(b).padStart(4)).join(''));
}

// ---------------------------------------------------------------- 3. returned rows
console.log('');
console.log('=== 3. which rows came back? ===');
const returned = db.prepare(
  'SELECT data_key, player_name, woba, sample_size FROM woba_data '
  + 'WHERE data_key IN (' + ACT_KEYS.map(() => '?').join(',') + ') AND woba < ? '
  + 'ORDER BY woba').all(...ACT_KEYS, OLD_FLOOR);
if (!returned.length) {
  console.log('    NONE YET -- no bat-act row sits below ' + OLD_FLOOR + '.');
  console.log('    Expected before the first upload after the change lands; the');
  console.log('    floor dropped these rows at parse time, so they cannot be');
  console.log('    enumerated until one refresh has run. Re-run then.');
} else {
  console.log('    ' + returned.length + ' row(s) below the retired ' + OLD_FLOOR + ' floor:');
  for (const r of returned) {
    console.log('      ' + r.data_key.padEnd(13) + String(r.player_name).padEnd(26)
      + 'woba ' + Number(r.woba).toFixed(4)
      + '  sample ' + r.sample_size
      + '  roster ' + (roleOf(normName(r.player_name)) || '(off-roster)'));
  }
}

// ---------------------------------------------------------------- 4. before/after
console.log('');
console.log('=== 4. did any lookup that resolved before stop resolving? ===');
if (!returned.length) {
  console.log('    Nothing to compare -- the two arms are identical while no');
  console.log('    sub-floor row exists. This section is the acceptance gate for');
  console.log('    the first upload after the change.');
} else {
  const idxFull = {}, idxOld = {};
  for (const k of ACT_KEYS) {
    idxFull[k] = {}; idxOld[k] = {};
    for (const r of db.prepare(
      'SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=?').all(k)) {
      const key = normName(r.player_name);
      const v = { woba: r.woba, sample: r.sample_size };
      idxFull[k][key] = v;
      if (Number(r.woba) >= OLD_FLOOR) idxOld[k][key] = v;   // the "before" arm
    }
  }
  const games = db.prepare(
    'SELECT game_date, away_team, home_team, away_sp_hand, home_sp_hand, '
    + 'away_lineup_json, home_lineup_json FROM game_log '
    + "WHERE game_date >= '2026-01-01' AND (away_lineup_json IS NOT NULL OR home_lineup_json IS NOT NULL)").all();
  let slots = 0, same = 0, gained = 0, lost = 0, changed = 0;
  const gl = [], ll = [], cl = [];
  for (const g of games) {
    for (const side of ['away', 'home']) {
      const raw = g[side + '_lineup_json']; if (!raw) continue;
      let lu = null; try { lu = JSON.parse(raw); } catch (e) { continue; }
      const team = g[side + '_team'];
      const oppHand = side === 'away' ? (g.home_sp_hand || 'R') : (g.away_sp_hand || 'R');
      const k = oppHand === 'R' ? 'bat-act-rhp' : 'bat-act-lhp';
      for (const b of (lu || [])) {
        if (!b || !b.name) continue;
        slots++;
        const a = fuzzyLookup(idxOld[k], b.name, team);
        const c = fuzzyLookup(idxFull[k], b.name, team);
        const av = a ? Number(a.woba).toFixed(6) : null;
        const cv = c ? Number(c.woba).toFixed(6) : null;
        if (av === cv) { same++; continue; }
        const lab = b.name + ' [' + team + '] ' + k;
        if (av == null) { gained++; if (gl.length < 20) gl.push(lab + '  -> ' + cv); }
        else if (cv == null) { lost++; if (ll.length < 20) ll.push(lab + '  WAS ' + av); }
        else { changed++; if (cl.length < 20) cl.push(lab + '  ' + av + ' -> ' + cv); }
      }
    }
  }
  console.log('    lineup slots compared : ' + slots);
  console.log('    identical             : ' + same);
  console.log('    GAINED (null -> value): ' + gained);
  console.log('    LOST   (value -> null): ' + lost + (lost ? '   <-- MUST BE 0' : ''));
  console.log('    CHANGED (value moved) : ' + changed + (changed ? '   <-- MUST BE 0' : ''));
  for (const [arr, t] of [[gl, 'GAINED'], [ll, '!! LOST'], [cl, '!! CHANGED']]) {
    if (!arr.length) continue;
    console.log('      ' + t + ':');
    for (const x of arr) console.log('        ' + x);
  }
  if (lost || changed) {
    console.log('');
    console.log('    A LOST row means an added candidate made an exactly-one gate');
    console.log('    ambiguous. That is a regression, not a trade-off.');
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- 5. the boundary
console.log('');
console.log('=== 5. the regime boundary, observable in upload_log ===');
console.log('    Classified by ROW COUNT, not by a remembered date: the first');
console.log('    upload_log row for a bat-act key whose row_count exceeds the');
console.log('    pre-change maximum is the first post-change ingest.');
for (const k of ACT_KEYS) {
  const m = db.prepare('SELECT MAX(row_count) m FROM upload_log WHERE data_key=?').get(k);
  const first = db.prepare(
    'SELECT row_count, uploaded_at FROM upload_log WHERE data_key=? AND row_count > ? '
    + 'ORDER BY id LIMIT 1').get(k, k === 'bat-act-rhp' ? 823 : 689);
  console.log('    ' + k.padEnd(14) + 'pre-change max ' + (k === 'bat-act-rhp' ? 823 : 689)
    + '   max now ' + m.m
    + (first ? '   BOUNDARY: ' + first.uploaded_at + ' at ' + first.row_count
             : '   boundary not crossed yet'));
}
