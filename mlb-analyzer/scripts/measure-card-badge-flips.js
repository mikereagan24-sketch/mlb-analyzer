#!/usr/bin/env node
'use strict';
// Before/after on the matchup card's near-miss badges. Read-only.
//   <node20>/node.exe --max-old-space-size=1536 scripts/measure-card-badge-flips.js [YYYY-MM-DD]
//
// BEFORE  the card's resolver with no stage-9 opts, and the badge predicate
//         built from utils/near-miss.js rosterPredicate over daily UNION season
// AFTER   both from services/season-roster.js -- the source pricing uses
//
// AND THE CASE WORTH A SECOND LOOK. Moving from daily-UNION-season to
// season-only NARROWS the predicate. A player in the DAILY table but not yet
// in the season one -- a call-up, a trade or a DFA landing between the last
// season-roster write and now -- loses roster confirmation. For those the
// badge stays on the ordinary no-row line rather than resolving, which is the
// safe direction, but it is a real loss and it is listed rather than counted
// as a pass.

const path = require('path');
const R = path.join(__dirname, '..');
const { normName, stripSfx, hasTeamTag, fuzzyLookup } = require(path.join(R, 'utils/names'));
const sr = require(path.join(R, 'services/season-roster'));
const nmu = require(path.join(R, 'utils/near-miss'));
const jobs = require(path.join(R, 'services/jobs'));
const Database = require('better-sqlite3');
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const quiet = (fn) => { const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; } };
const settings = quiet(() => jobs.getSettings());
const MIN_PA = Number(settings.MIN_PA) || 60;

// the index the card uses
const idx = {};
for (const k of ['bat-act-rhp', 'bat-act-lhp', 'bat-proj-rhp', 'bat-proj-lhp']) {
  idx[k] = {};
  for (const r of db.prepare('SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=?').all(k))
    idx[k][normName(r.player_name)] = { woba: Number(r.woba), sample: Number(r.sample_size) };
}

const rowsFor = (t, table) => {
  try { return db.prepare('SELECT player_name FROM ' + table + " WHERE team=? AND role='POS'")
    .all(String(t).toUpperCase()) || []; } catch (e) { return []; }
};
const memoOld = new Map(), memoNew = new Map(), memoDaily = new Map();
function oldPred(team) {                       // daily UNION season, via near-miss.js
  const k = String(team).toUpperCase();
  if (!memoOld.has(k)) memoOld.set(k,
    nmu.rosterPredicate([rowsFor(k, 'team_rosters'), rowsFor(k, 'team_rosters_season')]));
  return memoOld.get(k);
}
function newPred(team) {                       // season only, via season-roster.js
  const k = String(team).toUpperCase();
  if (!memoNew.has(k)) memoNew.set(k, sr.onTeamPredicate(sr.seasonRosterSet(k)));
  return memoNew.get(k);
}
function dailyOnly(team) {                     // in daily, NOT in season
  const k = String(team).toUpperCase();
  if (!memoDaily.has(k)) {
    const season = new Set(rowsFor(k, 'team_rosters_season').map(r => normName(r.player_name)));
    memoDaily.set(k, new Set(rowsFor(k, 'team_rosters')
      .map(r => normName(r.player_name))
      .filter(n => n && !season.has(n) && !season.has(stripSfx(n)))));
  }
  return memoDaily.get(k);
}

// the card's classifier, both arms
function classify(actKey, name, team, useOpts) {
  const km = idx[actKey] || {};
  const onTeam = useOpts ? newPred(team) : oldPred(team);
  const hit = useOpts
    ? fuzzyLookup(km, name, team, { minSample: MIN_PA, onTeam })
    : fuzzyLookup(km, name, team);
  const sample = hit && Number.isFinite(Number(hit.sample)) ? Number(hit.sample) : null;
  const actUsed = !!(hit && !isNaN(hit.woba) && sample != null && sample >= MIN_PA);
  if (actUsed) return { flag: 'resolved', woba: hit.woba, sample };
  if (hit) return { flag: 'act_gated', sample };
  const miss = nmu.nearMissFor(km, name, team, { onTeam });
  return { flag: miss ? 'near_miss' : 'no_row', miss: miss ? miss.key : null };
}

const DATE = process.argv[2]
  || db.prepare('SELECT MAX(game_date) d FROM game_log WHERE away_lineup_json IS NOT NULL').get().d;
const games = db.prepare(
  'SELECT game_date, game_id, away_team, home_team, away_sp_hand, home_sp_hand, '
  + 'away_lineup_json, home_lineup_json FROM game_log WHERE game_date=?').all(DATE);

const B = { near_miss: 0, resolved: 0, act_gated: 0, no_row: 0 };
const A = { near_miss: 0, resolved: 0, act_gated: 0, no_row: 0 };
const flips = [], lostToNarrowing = [], other = [], valueMoved = [];
let slots = 0;

for (const g of games) for (const side of ['away', 'home']) {
  const raw = g[side + '_lineup_json']; if (!raw) continue;
  let lu = null; try { lu = JSON.parse(raw); } catch (e) { continue; }
  const team = g[side + '_team'];
  const oppHand = side === 'away' ? (g.home_sp_hand || 'R') : (g.away_sp_hand || 'R');
  const actKey = oppHand === 'R' ? 'bat-act-rhp' : 'bat-act-lhp';
  for (const b of (lu || [])) {
    if (!b || !b.name) continue;
    slots++;
    const before = classify(actKey, b.name, team, false);
    const after = classify(actKey, b.name, team, true);
    B[before.flag]++; A[after.flag]++;
    // A slot already resolved must resolve to the SAME row. Stage 9 runs only
    // after every earlier stage returned null, so this is structural -- but it
    // is the property the whole change rests on, so it gets counted.
    if (before.flag === 'resolved' && after.flag === 'resolved'
        && Number(before.woba).toFixed(6) !== Number(after.woba).toFixed(6)) {
      valueMoved.push(b.name + ' [' + team + '] ' + Number(before.woba).toFixed(4)
        + ' -> ' + Number(after.woba).toFixed(4));
    }
    if (before.flag === after.flag) continue;
    const lab = b.name + ' [' + team + '] ' + g.game_id + '  ' + before.flag + ' -> ' + after.flag;
    if (before.flag === 'near_miss' && after.flag === 'resolved') {
      flips.push(lab + '   -> ' + Number(after.woba).toFixed(4) + ' (' + after.sample + ' PA)'
        + '   was flagging: ' + before.miss);
    } else if (after.flag === 'no_row' || after.flag === 'near_miss') {
      // did narrowing cost this one? only if a candidate sits in daily-not-season
      const parts = normName(b.name).split(' ');
      const dOnly = dailyOnly(team);
      const suspect = parts.length >= 2 && [...dOnly].some(n => {
        const p = stripSfx(n).split(' ');
        return p[p.length - 1] === parts[parts.length - 1];
      });
      (suspect ? lostToNarrowing : other).push(lab + (suspect ? '   <-- daily-only surname on this team' : ''));
    } else other.push(lab);
  }
}

const line = (t, o) => '  ' + t.padEnd(8)
  + ['near_miss', 'resolved', 'act_gated', 'no_row'].map(k => k + ' ' + String(o[k]).padStart(4)).join('   ');
console.log('');
console.log('=== card badge counts, slate ' + DATE + '  (' + games.length + ' games, ' + slots + ' slots) ===');
console.log(line('BEFORE', B));
console.log(line('AFTER', A));
console.log('');
console.log('  NEAR MISS -> RESOLVED: ' + flips.length);
for (const f of flips) console.log('    ' + f);
console.log('');
console.log('  WORTH A SECOND LOOK (narrowing may have cost these): ' + lostToNarrowing.length);
for (const f of lostToNarrowing) console.log('    ' + f);
if (other.length) {
  console.log('');
  console.log('  other transitions: ' + other.length);
  for (const f of other.slice(0, 15)) console.log('    ' + f);
}

console.log('');
console.log('  already-resolved slots whose VALUE moved: ' + valueMoved.length
  + (valueMoved.length ? '   <-- MUST BE 0' : '   (stage 9 cannot reach a resolved lookup)'));
for (const v of valueMoved.slice(0, 10)) console.log('    ' + v);

// ---------------------------------------------------------------- task 5
console.log('');
console.log('=== the two named cases, on the CARD path ===');
for (const [name, team] of [['W. Contreras', 'MIL'], ['J. Crawford', 'PHI']]) {
  for (const key of ['bat-act-rhp', 'bat-act-lhp']) {
    const bf = classify(key, name, team, false), af = classify(key, name, team, true);
    console.log('  ' + (name + ' [' + team + ']').padEnd(22) + key.padEnd(13)
      + 'before=' + bf.flag.padEnd(10)
      + 'after=' + af.flag.padEnd(10)
      + (af.flag === 'resolved' ? Number(af.woba).toFixed(4) + ' (' + af.sample + ' PA)' : ''));
  }
}
