#!/usr/bin/env node
'use strict';
// Stage 9's two rules, measured SEPARATELY so neither is credited with the
// other's fixes.
//   <node20>/node.exe --max-old-space-size=1536 scripts/measure-resolver-stage9.js
// Exit 1 if LOST or CHANGED is non-zero in any arm.
//
// ARMS, each built by adding one opt to the same fuzzyLookup call:
//   BASE    fuzzyLookup(idx, name, team)                       -- today
//   R1      + { minSample: MIN_PA }                            -- rule 1
//   R1R2    + { minSample: MIN_PA, onTeam }                    -- rules 1+2
//
// TWO INDEX POPULATIONS, because rule 1 only has work to do where
// sub-threshold rows exist:
//   FULL          every bat-act row. This is what woba_data_snapshot holds
//                 for historical dates, so it is the population every
//                 snapshot-bound replay actually resolves against.
//   POST_463      sample >= MIN_PA only. This is what woba_data will hold
//                 after the next upload, since #463 filters at ingest.
//
// LOST = 0 and CHANGED = 0 are structural here, not merely observed: stage 9
// runs only after every earlier stage returned null, so it can only turn null
// into a value. The arms are measured anyway, because "structurally
// impossible" has been wrong twice in this area already.

const path = require('path');
const R = path.join(__dirname, '..');
const { normName, stripSfx, hasTeamTag, fuzzyLookup } = require(path.join(R, 'utils/names'));
const Database = require('better-sqlite3');
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

let MIN_PA = 60;
try {
  const v = Number((require(path.join(R, 'services/jobs')).getSettings() || {}).MIN_PA);
  if (isFinite(v) && v > 0) MIN_PA = v;
} catch (e) { /* schema default */ }
const KEYS = ['bat-act-rhp', 'bat-act-lhp'];

// ---------------------------------------------------------------- roster
// team_rosters_season UNIONed with the daily table, per #450: the daily
// 840-row snapshot drops anyone optioned, traded or shut down, and a replay
// over April needs the season view.
const byTeam = new Map();
for (const t of ['team_rosters_season', 'team_rosters']) {
  let rows = [];
  try { rows = db.prepare('SELECT team, player_name FROM ' + t + " WHERE role='POS'").all(); }
  catch (e) { continue; }
  for (const r of rows) {
    const tl = String(r.team).toLowerCase();
    if (!byTeam.has(tl)) byTeam.set(tl, new Set());
    const s = byTeam.get(tl);
    const n = normName(r.player_name);
    if (n) { s.add(n); s.add(stripSfx(n)); }
  }
}
const onTeamFor = (team) => {
  const s = byTeam.get(String(team).toLowerCase());
  if (!s || !s.size) return null;
  return (k) => s.has(k) || s.has(stripSfx(k));
};

// ---------------------------------------------------------------- indexes
const FULL = {}, POST = {};
for (const k of KEYS) {
  FULL[k] = {}; POST[k] = {};
  for (const r of db.prepare('SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=?').all(k)) {
    const n = normName(r.player_name);
    const v = { woba: Number(r.woba), sample: Number(r.sample_size) };
    FULL[k][n] = v;
    if (v.sample >= MIN_PA) POST[k][n] = v;
  }
}

// stage-6's candidate set, for attributing a fix to a cause
function causeOf(keyMap, name, team) {
  const parts = normName(name).split(' ');
  if (!(parts.length >= 2 && parts[0].length === 1)) return null;
  const initial = parts[0], last = parts[parts.length - 1];
  const c = Object.keys(keyMap).filter(n => {
    if (hasTeamTag(n)) return false;
    const p = stripSfx(n).split(' ');
    return p[p.length - 1] === last && p[0] && p[0][0] === initial;
  });
  if (c.length < 2) return null;
  const usable = c.filter(n => keyMap[n].sample >= MIN_PA);
  if (usable.length === 1) return 'subthreshold';   // the 194 class
  if (usable.length === 0) return 'none';           // the 7 class
  const ot = onTeamFor(team);
  const own = ot ? usable.filter(n => ot(n)) : [];
  if (own.length >= 2) return 'genuine_same_team';  // the 0 class
  return 'genuine_cross_team';                      // the 551 class
}

const games = db.prepare(
  'SELECT away_team, home_team, away_sp_hand, home_sp_hand, away_lineup_json, home_lineup_json '
  + "FROM game_log WHERE game_date >= '2026-01-01' "
  + 'AND (away_lineup_json IS NOT NULL OR home_lineup_json IS NOT NULL)').all();

function run(idx, label) {
  const D = {
    slots: 0,
    r1: { gained: 0, lost: 0, changed: 0 },
    r2: { gained: 0, lost: 0, changed: 0 },
    both: { gained: 0, lost: 0, changed: 0 },
    byCause: { subthreshold: 0, genuine_cross_team: 0, genuine_same_team: 0, none: 0 },
    r1Cause: {}, r2Cause: {},
    ex1: new Map(), ex2: new Map(),
  };
  const cmp = (a, b, into) => {
    const av = a ? Number(a.woba).toFixed(6) : null, bv = b ? Number(b.woba).toFixed(6) : null;
    if (av === bv) return null;
    if (av == null) { into.gained++; return 'gained'; }
    if (bv == null) { into.lost++; return 'lost'; }
    into.changed++; return 'changed';
  };
  for (const g of games) for (const side of ['away', 'home']) {
    const raw = g[side + '_lineup_json']; if (!raw) continue;
    let lu = null; try { lu = JSON.parse(raw); } catch (e) { continue; }
    const team = g[side + '_team'];
    const ot = onTeamFor(team);
    const k = (side === 'away' ? (g.home_sp_hand || 'R') : (g.away_sp_hand || 'R')) === 'R'
      ? 'bat-act-rhp' : 'bat-act-lhp';
    for (const b of (lu || [])) {
      if (!b || !b.name) continue;
      D.slots++;
      const base = fuzzyLookup(idx[k], b.name, team);
      const a1 = fuzzyLookup(idx[k], b.name, team, { minSample: MIN_PA });
      const a2 = fuzzyLookup(idx[k], b.name, team, { minSample: MIN_PA, onTeam: ot });
      if (!base) {
        const cause = causeOf(idx[k], b.name, team);
        if (cause) D.byCause[cause]++;
        const w1 = cmp(base, a1, D.r1);
        if (w1 === 'gained') {
          D.r1Cause[cause || '?'] = (D.r1Cause[cause || '?'] || 0) + 1;
          const lab = b.name + ' [' + team + '] -> ' + Number(a1.woba).toFixed(4);
          D.ex1.set(lab, (D.ex1.get(lab) || 0) + 1);
        }
        const w2 = cmp(a1, a2, D.r2);
        if (w2 === 'gained') {
          D.r2Cause[cause || '?'] = (D.r2Cause[cause || '?'] || 0) + 1;
          const lab = b.name + ' [' + team + '] -> ' + Number(a2.woba).toFixed(4);
          D.ex2.set(lab, (D.ex2.get(lab) || 0) + 1);
        }
        cmp(base, a2, D.both);
      } else {
        cmp(base, a1, D.r1); cmp(a1, a2, D.r2); cmp(base, a2, D.both);
      }
    }
  }
  return D;
}

const show = (m, t, lim) => {
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
  if (!rows.length) return;
  console.log('    ' + t + ':');
  for (const [k2, n] of rows.slice(0, lim)) console.log('      ' + String(n).padStart(4) + '  ' + k2);
  if (rows.length > lim) console.log('      ... and ' + (rows.length - lim) + ' more distinct');
};

let bad = 0;
for (const [idx, label, note] of [
  [FULL, 'FULL INDEX', 'every bat-act row -- what woba_data_snapshot holds for historical dates'],
  [POST, 'POST-#463', 'sample >= ' + MIN_PA + ' only -- what woba_data holds after the next upload'],
]) {
  const D = run(idx, label);
  console.log('');
  console.log('=== ' + label + ' (' + note + ') ===');
  console.log('  lineup slots ' + D.slots + '   MIN_PA ' + MIN_PA);
  console.log('  unresolved ambiguity by cause, in THIS population:');
  console.log('    one real + sub-threshold row   ' + D.byCause.subthreshold);
  console.log('    two real, different teams      ' + D.byCause.genuine_cross_team);
  console.log('    two real, SAME team            ' + D.byCause.genuine_same_team);
  console.log('    none clears the threshold      ' + D.byCause.none);
  console.log('');
  console.log('  RULE 1 alone (minSample)   GAINED ' + D.r1.gained
    + '   LOST ' + D.r1.lost + '   CHANGED ' + D.r1.changed);
  console.log('      by cause: ' + (Object.keys(D.r1Cause).length
    ? Object.entries(D.r1Cause).map(([c, n]) => c + '=' + n).join('  ') : '(none)'));
  show(D.ex1, 'rule 1 fixes', 8);
  console.log('  RULE 2 on top (onTeam)     GAINED ' + D.r2.gained
    + '   LOST ' + D.r2.lost + '   CHANGED ' + D.r2.changed);
  console.log('      by cause: ' + (Object.keys(D.r2Cause).length
    ? Object.entries(D.r2Cause).map(([c, n]) => c + '=' + n).join('  ') : '(none)'));
  show(D.ex2, 'rule 2 fixes', 8);
  console.log('  BOTH vs BASE               GAINED ' + D.both.gained
    + '   LOST ' + D.both.lost + '   CHANGED ' + D.both.changed);
  if (D.r1.lost || D.r1.changed || D.r2.lost || D.r2.changed || D.both.lost || D.both.changed) bad++;
}
console.log('');
console.log(bad ? 'GATE FAILED -- LOST or CHANGED is non-zero' : 'GATE PASS -- LOST = 0 and CHANGED = 0 in every arm');
process.exit(bad ? 1 : 0);
