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
// The shipping rule: batter actuals admit on SAMPLE, at MIN_PA. Read the same
// way the ingest reads it so this cannot drift from what actually runs.
let MIN_PA = 60;
try {
  const v = Number((require(path.join(R, 'services/jobs')).getSettings() || {}).MIN_PA);
  if (isFinite(v) && v > 0) MIN_PA = v;
} catch (e) { /* schema default */ }

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
console.log('');
console.log('    READ THIS COUNT WITH THE GUARD-REMOVAL RULE IN HAND. While a floor');
console.log('    is in force, its target has already been removed from the corpus it');
console.log('    produced, so a count of ZERO here is NOT evidence of absence -- it');
console.log('    is the instrument being blind, the same way SIGNAL_EDGE_HARD_CAP_PP');
console.log('    "suppressed 0 of 1026". That is exactly how #461 was argued, and the');
console.log('    first post-change upload admitted five real pitchers (Trevor Rogers,');
console.log('    Tyler Alexander, Colin Rea, Jack Leiter, Miles Mikolas, Randy');
console.log('    Vasquez) at wOBA 0.0000 on 1-2 PA. A non-zero count here is');
console.log('    informative; a zero one is not.');
console.log('    -> PROJECTIONS: target PRESENT, and above 0.210, so a wOBA floor');
console.log('       misses it either way. The right instrument is role, not a number.');

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
  const admits = returned.filter(r => Number(r.sample_size) >= MIN_PA);
  const excludes = returned.length - admits.length;
  console.log('    ' + returned.length + ' row(s) below the retired ' + OLD_FLOOR + ' value floor.');
  console.log('    Under the SHIPPING rule (sample >= MIN_PA = ' + MIN_PA + '):');
  console.log('      ADMITTED  ' + admits.length + '   real weak splits with a usable sample');
  console.log('      EXCLUDED  ' + excludes + '   below MIN_PA, so they could never have');
  console.log('                    reached a price -- blendWoba gates the actuals');
  console.log('                    term on the same threshold. Their only possible');
  console.log('                    effect was to make the resolver ambiguous.');
  console.log('');
  console.log('    the rows the shipping rule ADMITS:');
  for (const r of admits) {
    console.log('      ' + r.data_key.padEnd(13) + String(r.player_name).padEnd(26)
      + 'woba ' + Number(r.woba).toFixed(4) + '  sample ' + r.sample_size
      + '  roster ' + (roleOf(normName(r.player_name)) || '(off-roster)'));
  }
  console.log('');
  console.log('    and the full sub-floor population, for reference:');
  for (const r of returned) {
    console.log('      ' + r.data_key.padEnd(13) + String(r.player_name).padEnd(26)
      + 'woba ' + Number(r.woba).toFixed(4)
      + '  sample ' + r.sample_size
      + '  roster ' + (roleOf(normName(r.player_name)) || '(off-roster)'));
  }
}

// ---------------------------------------------------------------- 4. before/after
console.log('');
console.log('=== 4. THE GATE: does the shipping rule lose any lookup? ===');
console.log('    BASELINE  value floor only (woba >= ' + OLD_FLOOR + ') -- what production');
console.log('              does with the floor in force');
console.log('    CANDIDATE value floor OR sample >= MIN_PA (' + MIN_PA + ') -- the');
console.log('              shipping rule');
console.log('    Both arms are built from the SAME index by filtering, so this runs');
console.log('    on any DB vintage and needs no stored baseline.');
console.log('');
if (!returned.length) {
  console.log('    Nothing to compare -- no sub-floor row exists in this copy, so the');
  console.log('    two arms are identical. Re-run after an upload under the new rule.');
} else {
  const idxFull = {}, idxOld = {};
  for (const k of ACT_KEYS) {
    idxFull[k] = {}; idxOld[k] = {};
    for (const r of db.prepare(
      'SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=?').all(k)) {
      const key = normName(r.player_name);
      const v = { woba: r.woba, sample: r.sample_size };
      // CANDIDATE: admitted by value OR by sample
      if (Number(r.woba) >= OLD_FLOOR || Number(r.sample_size) >= MIN_PA) idxFull[k][key] = v;
      // BASELINE: value only
      if (Number(r.woba) >= OLD_FLOOR) idxOld[k][key] = v;
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
console.log('=== 5. the regime boundary, classified by CONTENT ===');
console.log('    NOT by row_count. That rule was tried and it failed on the very');
console.log('    first post-change upload, in opposite directions on the two keys:');
console.log('      bat-act-rhp  pre-change max 823, post-change 818  -> "not crossed"');
console.log('      bat-act-lhp  pre-change max 689, post-change 811  -> "crossed"');
console.log('    823 belonged to an EARLIER regime and 740-745 was routine in June,');
console.log('    so a count threshold cannot discriminate -- and upload_log stores');
console.log('    only a count, so it can never carry this boundary by itself.');
console.log('');
console.log('    A bat-act row below ' + OLD_FLOOR + ' cannot exist pre-change, so the');
console.log('    content IS the marker:');
const bnd = db.prepare(
  'SELECT MIN(snapshot_date) d FROM woba_data_snapshot '
  + "WHERE data_key LIKE 'bat-act-%' AND woba < ?").get(OLD_FLOOR);
if (!bnd || !bnd.d) {
  console.log('      no snapshot_date carries a sub-floor bat-act row yet.');
} else {
  console.log('      BOUNDARY snapshot_date: ' + bnd.d);
  for (const r of db.prepare(
    'SELECT data_key, COUNT(*) n, MIN(woba) lo FROM woba_data_snapshot '
    + "WHERE snapshot_date=? AND data_key LIKE 'bat-act-%' AND woba < ? GROUP BY 1").all(bnd.d, OLD_FLOOR)) {
    console.log('        ' + r.data_key.padEnd(13) + 'n=' + String(r.n).padStart(4)
      + '  min ' + Number(r.lo).toFixed(4));
  }
  console.log('      upload_log rows on that date (a POINTER, not the classifier):');
  for (const r of db.prepare(
    "SELECT data_key, row_count, uploaded_at FROM upload_log WHERE data_key LIKE 'bat-act-%' "
    + 'AND uploaded_at >= ? AND uploaded_at < date(?, \'+1 day\') ORDER BY id').all(bnd.d, bnd.d)) {
    console.log('        ' + r.data_key.padEnd(13) + String(r.row_count).padStart(5) + '   ' + r.uploaded_at);
  }
}
