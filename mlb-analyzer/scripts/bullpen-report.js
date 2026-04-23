#!/usr/bin/env node
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH
  || (fs.existsSync('/data/mlb.db') ? '/data/mlb.db' : path.join(__dirname, '..', 'data', 'mlb.db'));

const DATE = process.argv[2] || '2026-04-18';
const W_PROJ = 0.65;
const W_ACT = 0.35;

if (!fs.existsSync(DB_PATH)) {
  console.error('DB not found at '+DB_PATH);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

function normName(n) {
  return (n||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim();
}

const games = db.prepare(
  'SELECT game_id, away_team, home_team, away_sp, home_sp FROM game_log WHERE game_date=? ORDER BY game_id'
).all(DATE);

if (!games.length) {
  console.log('No games found for '+DATE);
  process.exit(0);
}

// Build wOBA lookup indexes for each of the 4 keys.
// proj rows have team-suffixed names like "John Doe NYY"; act rows usually don't.
const KEYS = ['pit-proj-lhb','pit-proj-rhb','pit-act-lhb','pit-act-rhb'];
const idx = {};
for (const k of KEYS) {
  idx[k] = {};
  const rows = db.prepare('SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=?').all(k);
  for (const r of rows) {
    idx[k][normName(r.player_name)] = { woba: r.woba, sample: r.sample_size, raw: r.player_name };
  }
}

function lookupWoba(key, name, teamAbbr) {
  const nm = normName(name);
  const tl = (teamAbbr||'').toLowerCase();
  // Try team-suffixed match first (proj keys), then bare name (act keys)
  if (tl && idx[key][nm+' '+tl]) return idx[key][nm+' '+tl];
  if (idx[key][nm]) return idx[key][nm];
  // Try without suffix stripping generational markers
  const stripped = nm.replace(/\b(jr|sr|ii|iii|iv)\b/g,'').replace(/\s+/g,' ').trim();
  if (stripped !== nm) {
    if (tl && idx[key][stripped+' '+tl]) return idx[key][stripped+' '+tl];
    if (idx[key][stripped]) return idx[key][stripped];
  }
  return null;
}

function blend(proj, act) {
  if (proj != null && act != null) return W_PROJ*proj + W_ACT*act;
  if (proj != null) return proj;
  if (act != null) return act;
  return null;
}

function fmt(v) { return v == null ? '   -  ' : v.toFixed(4); }
function pad(s, n, right=false) {
  s = String(s==null?'':s);
  if (s.length >= n) return s.slice(0,n);
  return right ? s+' '.repeat(n-s.length) : ' '.repeat(n-s.length)+s;
}

const header = [
  pad('Game',14,true), pad('Team',5,true), pad('Pitcher',22,true),
  pad('Role',5,true), pad('Hand',5,true),
  pad('ProjL',7), pad('ProjR',7), pad('ActL',7), pad('ActR',7),
  pad('BlendL',7), pad('BlendR',7), pad('InPool',7,true)
].join(' | ');

const teamTotals = {}; // { 'GAME|TEAM': { vsL:[{woba,sample}], vsR:[...] } }

// Pull the 4 per-handedness bullpen blend weights from app_settings so the
// report header documents the state the model is actually running under.
const bpParam = (key, def) => {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  const v = r && r.value !== '' ? parseFloat(r.value) : null;
  return (v != null && !isNaN(v)) ? v : def;
};
const BP_SR = bpParam('bp_strong_weight_r', 0.55);
const BP_WR = bpParam('bp_weak_weight_r',   0.45);
const BP_SL = bpParam('bp_strong_weight_l', 0.35);
const BP_WL = bpParam('bp_weak_weight_l',   0.65);

console.log('\nBullpen wOBA Report — '+DATE);
console.log('DB: '+DB_PATH);
console.log('Games: '+games.length);
console.log('Parameters:');
console.log('  vs RHB   strong=' + BP_SR.toFixed(2) + '   weak=' + BP_WR.toFixed(2));
console.log('  vs LHB   strong=' + BP_SL.toFixed(2) + '   weak=' + BP_WL.toFixed(2));
console.log('  blend    wProj=' + W_PROJ.toFixed(2) + '   wAct=' + W_ACT.toFixed(2));
console.log('');
console.log(header);
console.log('-'.repeat(header.length));

for (const g of games) {
  const teams = [
    { team: g.away_team, sp: g.away_sp },
    { team: g.home_team, sp: g.home_sp },
  ];
  for (const { team, sp } of teams) {
    const teamU = (team||'').toUpperCase();
    const spNorm = normName(sp);
    const spLast = spNorm.split(' ').pop();
    const roster = db.prepare(
      'SELECT player_name, role, hand FROM team_rosters WHERE team=? ORDER BY role, player_name'
    ).all(teamU);

    const rowsOut = [];
    const poolKey = g.game_id+'|'+teamU;
    teamTotals[poolKey] = { vsL: [], vsR: [] };

    for (const p of roster) {
      const pNorm = normName(p.player_name);
      const pLast = pNorm.split(' ').pop();
      const projL = lookupWoba('pit-proj-lhb', p.player_name, teamU);
      const projR = lookupWoba('pit-proj-rhb', p.player_name, teamU);
      const actL  = lookupWoba('pit-act-lhb',  p.player_name, teamU);
      const actR  = lookupWoba('pit-act-rhb',  p.player_name, teamU);
      const blendL = blend(projL?.woba, actL?.woba);
      const blendR = blend(projR?.woba, actR?.woba);
      const isSP = spLast && (pNorm === spNorm || pLast === spLast);
      const hasRP = p.role === 'RP';
      // Pool criteria: not the SP, role is RP, and at least one wOBA data point exists
      const hasData = projL || projR || actL || actR;
      const inPool = hasRP && !isSP && !!hasData;
      if (inPool) {
        const sampleFallback = 20;
        if (blendL != null) teamTotals[poolKey].vsL.push({ woba: blendL, sample: projL?.sample || actL?.sample || sampleFallback });
        if (blendR != null) teamTotals[poolKey].vsR.push({ woba: blendR, sample: projR?.sample || actR?.sample || sampleFallback });
      }
      rowsOut.push([
        pad(g.game_id,14,true),
        pad(teamU,5,true),
        pad(p.player_name,22,true),
        pad(p.role||'?',5,true),
        pad(p.hand||'?',5,true),
        pad(fmt(projL?.woba),7),
        pad(fmt(projR?.woba),7),
        pad(fmt(actL?.woba),7),
        pad(fmt(actR?.woba),7),
        pad(fmt(blendL),7),
        pad(fmt(blendR),7),
        pad(inPool?'YES':(isSP?'SP':(hasRP?'no-data':'not-RP')),7,true),
      ].join(' | '));
    }
    rowsOut.forEach(r=>console.log(r));
  }
  console.log('-'.repeat(header.length));
}

console.log('\nTeam Bullpen Aggregates (sample-weighted average over pool)');
console.log(pad('Game',14,true)+' | '+pad('Team',5,true)+' | '+pad('PoolN',6)+' | '+pad('vsLHB',8)+' | '+pad('vsRHB',8));
console.log('-'.repeat(50));
for (const [k, v] of Object.entries(teamTotals)) {
  const [gameId, team] = k.split('|');
  const sumW = (arr) => {
    const totalW = arr.reduce((s,x)=>s+(x.sample||20),0);
    return totalW>0 ? arr.reduce((s,x)=>s+x.woba*(x.sample||20),0)/totalW : null;
  };
  const vsL = sumW(v.vsL);
  const vsR = sumW(v.vsR);
  const n = Math.max(v.vsL.length, v.vsR.length);
  console.log(pad(gameId,14,true)+' | '+pad(team,5,true)+' | '+pad(n,6)+' | '+pad(fmt(vsL),8)+' | '+pad(fmt(vsR),8));
}
