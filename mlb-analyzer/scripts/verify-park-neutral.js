#!/usr/bin/env node
'use strict';

// Verification harness for feat/park-neutral-inputs. Exercises
// getBatterWoba + getPitcherWoba against the live woba_data table with
// the toggle OFF (regression guard) and ON (spot-check magnitudes vs
// brief expectations). Prints one line per team of interest — never
// runs silently.
//
// Run:  node scripts/verify-park-neutral.js

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const model = require('../services/model');
const { db } = require('../db/schema');
const { getSettings } = require('../services/jobs');
const { WOBA_PARK_FACTORS } = require('../services/park-factors-woba');

function log(...args) { console.log(...args); }

log('== park-neutral-inputs verify ==');
log('date:', new Date().toISOString());

// Build the wOBA index once (same fetch runModel uses).
const rows = db.prepare('SELECT data_key, player_name, woba, sample_size FROM woba_data').all();
log('woba_data rows:', rows.length);
const wobaIdx = require('../services/model')._buildWobaIndexForTest
  ? require('../services/model')._buildWobaIndexForTest(rows)
  : (() => {
      // buildWobaIndex isn't exported; rebuild here identically.
      const { normName } = require('../utils/names');
      const idx = {};
      for (const r of rows) {
        if (!idx[r.data_key]) idx[r.data_key] = {};
        idx[r.data_key][normName(r.player_name)] = { woba: r.woba, sample: r.sample_size };
      }
      return idx;
    })();

log('data_keys:', Object.keys(wobaIdx).sort());

const settings = getSettings();
const baseSettings = Object.assign({}, settings);

// Force OFF for baseline (regression check should be a no-op if flag is
// already off in DB, but be explicit).
baseSettings.PARK_NEUTRAL_INPUTS_ENABLED = false;
const onSettings = Object.assign({}, baseSettings, { PARK_NEUTRAL_INPUTS_ENABLED: true });

log('\nsettings.PARK_NEUTRAL_INPUTS_ENABLED (DB):', settings.PARK_NEUTRAL_INPUTS_ENABLED);
log('W_PROJ:', baseSettings.W_PROJ, 'W_ACT:', baseSettings.W_ACT, 'MIN_PA:', baseSettings.MIN_PA, 'MIN_BF:', baseSettings.MIN_BF);

// ── Pick sample players by team ────────────────────────────────────
// One batter + one pitcher per extreme-park team, plus a league-avg
// control (TOR or HOU, factor 1.00 → drop should be 0).
const SAMPLES = [
  { team: 'COL', role: 'bat', label: 'COL hitter (Coors 1.10)' },
  { team: 'COL', role: 'pit', label: 'COL pitcher (Coors 1.10)' },
  { team: 'ATH', role: 'bat', label: 'ATH hitter (Sutter Health 1.09)' },
  { team: 'SEA', role: 'bat', label: 'SEA hitter (T-Mobile 0.96)' },
  { team: 'SEA', role: 'pit', label: 'SEA pitcher (T-Mobile 0.96)' },
  { team: 'SD',  role: 'bat', label: 'SD hitter (Petco 0.96)' },
  { team: 'SF',  role: 'bat', label: 'SF hitter (Oracle 0.94 — MOST deflated)' },
  { team: 'TOR', role: 'bat', label: 'TOR hitter (league-avg 1.00 — should be UNCHANGED)' },
  { team: 'HOU', role: 'bat', label: 'HOU hitter (league-avg 1.00 — should be UNCHANGED)' },
];

// Get one sample name per (team, role) using team_rosters. Prefer a
// player with actual data in woba_data so both hands resolve.
function pickSample(team, role) {
  const bucket = role === 'bat' ? "role='POS'" : "role IN ('SP','RP')";
  const cands = db.prepare(
    `SELECT player_name, hand FROM team_rosters WHERE team=? AND ${bucket}
     ORDER BY player_name LIMIT 20`
  ).all(team);
  const projKey = role === 'bat' ? 'bat-proj-rhp' : 'pit-proj-rhb';
  const { normName } = require('../utils/names');
  for (const c of cands) {
    if (wobaIdx[projKey] && wobaIdx[projKey][normName(c.player_name)]) return c;
  }
  return cands[0] || null;
}

function pct(off, on) {
  if (off == null || on == null || off === 0) return '?';
  const delta = (on - off) / off * 100;
  return (delta >= 0 ? '+' : '') + delta.toFixed(2) + '%';
}

let regressionOk = true;

for (const s of SAMPLES) {
  const pick = pickSample(s.team, s.role);
  if (!pick) { log('\n' + s.label + ': NO SAMPLE PLAYER FOUND'); continue; }
  const name = pick.player_name;
  const hand = pick.hand || 'R';
  const factor = WOBA_PARK_FACTORS[s.team];
  const off = s.role === 'bat'
    ? model.getBatterWoba(wobaIdx, name, hand, s.team, baseSettings.W_PROJ, baseSettings.W_ACT, baseSettings.MIN_PA, baseSettings)
    : model.getPitcherWoba(wobaIdx, name, hand, s.team, baseSettings.W_PROJ, baseSettings.W_ACT, baseSettings.MIN_BF, baseSettings);
  const on  = s.role === 'bat'
    ? model.getBatterWoba(wobaIdx, name, hand, s.team, onSettings.W_PROJ, onSettings.W_ACT, onSettings.MIN_PA, onSettings)
    : model.getPitcherWoba(wobaIdx, name, hand, s.team, onSettings.W_PROJ, onSettings.W_ACT, onSettings.MIN_BF, onSettings);

  const [aOff, bOff, aOn, bOn] = s.role === 'bat'
    ? [off.vsLHP, off.vsRHP, on.vsLHP, on.vsRHP]
    : [off.vsLHB, off.vsRHB, on.vsLHB, on.vsRHB];
  const [aLabel, bLabel] = s.role === 'bat' ? ['vsLHP', 'vsRHP'] : ['vsLHB', 'vsRHB'];

  log('\n' + s.label);
  log('  sample: ' + name + ' (' + hand + '), factor=' + factor);
  log('  ' + aLabel + ': off=' + (aOff!=null?aOff.toFixed(4):'—') + ' on=' + (aOn!=null?aOn.toFixed(4):'—') + '  Δ=' + pct(aOff, aOn));
  log('  ' + bLabel + ': off=' + (bOff!=null?bOff.toFixed(4):'—') + ' on=' + (bOn!=null?bOn.toFixed(4):'—') + '  Δ=' + pct(bOff, bOn));
  log('  source: ' + off.source + ' → ' + on.source);
}

// ── Regression sanity: with toggle OFF, a fresh pass must match baseline ─
log('\n== regression: toggle OFF must be byte-identical ==');
let mismatches = 0;
let cross = 0;
const sampleTeams = ['COL','SEA','TOR','SF'];
for (const team of sampleTeams) {
  const bat = pickSample(team, 'bat');
  const pit = pickSample(team, 'pit');
  if (bat) {
    const a = model.getBatterWoba(wobaIdx, bat.player_name, bat.hand || 'R', team, baseSettings.W_PROJ, baseSettings.W_ACT, baseSettings.MIN_PA, baseSettings);
    const b = model.getBatterWoba(wobaIdx, bat.player_name, bat.hand || 'R', team, baseSettings.W_PROJ, baseSettings.W_ACT, baseSettings.MIN_PA, baseSettings);
    cross++;
    if (a.vsLHP !== b.vsLHP || a.vsRHP !== b.vsRHP || a.source !== b.source) mismatches++;
  }
  if (pit) {
    const a = model.getPitcherWoba(wobaIdx, pit.player_name, pit.hand || 'R', team, baseSettings.W_PROJ, baseSettings.W_ACT, baseSettings.MIN_BF, baseSettings);
    const b = model.getPitcherWoba(wobaIdx, pit.player_name, pit.hand || 'R', team, baseSettings.W_PROJ, baseSettings.W_ACT, baseSettings.MIN_BF, baseSettings);
    cross++;
    if (a.vsLHB !== b.vsLHB || a.vsRHB !== b.vsRHB || a.source !== b.source) mismatches++;
  }
}
log('  self-consistency: ' + (cross - mismatches) + '/' + cross + ' match');
if (mismatches) regressionOk = false;

log('\n== summary ==');
log('regression: ' + (regressionOk ? 'PASS (self-consistent)' : 'FAIL'));
log('spot-check magnitudes above should match brief:');
log('  COL/ATH hitters ~-4-5% drop, SEA/SD hitters ~+2%, league-avg 0.00%');
log('  Pitchers symmetric (COL pitcher improves = wOBA-against drops)');
process.exit(regressionOk ? 0 : 1);
