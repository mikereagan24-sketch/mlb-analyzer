// Sweep BULLPEN_W_PROJ / BULLPEN_W_ACT across plausible defaults and report
// the 30-team mean, P10/P90, and per-team movement. Goal: identify the pair
// (with sum=1.0) whose 30-team mean lands in the 0.298-0.303 target range
// while Step 2 (bullpen_downweight_starters=true) is on.
//
// Legacy row (byte-identical guard) uses the prod-verified GLOBAL blend
// w_proj=0.45, w_act=0.55 (SELECT value FROM app_settings on 2026-07-07).

const path = require('path');
const dbPath = path.join(__dirname, '..', 'data', 'mlb.db');
const dbModule = require('../db/schema');
const q = dbModule.q || dbModule;

const rosterRPs = require('better-sqlite3')(dbPath, { readonly: true })
  .prepare("SELECT team, player_name FROM team_rosters WHERE role='RP'").all();
const byTeam = {};
for (const r of rosterRPs) { const t = (r.team||'').toUpperCase(); (byTeam[t] = byTeam[t] || []).push(r); }
const teams = Object.keys(byTeam).sort();

const GAMEDATE = '2026-07-07';
const bpSR = 0.55, bpWR = 0.45, bpSL = 0.35, bpWL = 0.65;
const unk = 0.335;
const MIN_BF_LEGACY = 100;
const MIN_BF_NEW    = 50;

function fmt(n, d) { return n == null ? 'null' : Number(n).toFixed(d); }

function computeAllTeams(wProj, wAct, minBF, downweight) {
  const out = [];
  for (const t of teams) {
    const bp = q.getBullpenWobaBlended(t, '', [], bpSR, bpWR, bpSL, bpWL, wProj, wAct, GAMEDATE, unk, minBF, downweight);
    if (bp && bp.woba != null) out.push({ team: t, woba: bp.woba });
    else out.push({ team: t, woba: null });
  }
  return out;
}

function stats(rows) {
  const xs = rows.map(r => r.woba).filter(x => x != null);
  if (!xs.length) return { n: 0 };
  const mean = xs.reduce((s,x)=>s+x,0) / xs.length;
  const sorted = xs.slice().sort((a,b)=>a-b);
  return {
    n: xs.length,
    mean,
    p10: sorted[Math.floor(xs.length*0.10)],
    p90: sorted[Math.floor(xs.length*0.90)],
    min: sorted[0],
    max: sorted[xs.length-1],
  };
}

// (1) Legacy at true prod values (byte-identical anchor)
const legacyProd = computeAllTeams(0.45, 0.55, MIN_BF_LEGACY, false);
const sLp = stats(legacyProd);
console.log('=== legacy (prod values: w_proj=0.45, w_act=0.55, min_bf=100, no downweight) ===');
console.log('mean =', fmt(sLp.mean, 4), 'p10/p90 =', fmt(sLp.p10,4) + '/' + fmt(sLp.p90,4), 'spread =', fmt((sLp.p90-sLp.p10)*1000,1)+'pt');
console.log();

// (2) Sweep bullpen-specific w_proj/w_act with Step 2 ON, min_bf=50
console.log('=== sweep w_proj (with w_act=1-w_proj), min_bf=50, downweight=true ===');
console.log('w_proj  w_act   mean     p10      p90      spread(pt)   Δmean vs legacy');
for (const wp of [0.45, 0.40, 0.35, 0.30, 0.25, 0.20, 0.15, 0.10, 0.05, 0.00]) {
  const wa = 1 - wp;
  const rows = computeAllTeams(wp, wa, MIN_BF_NEW, true);
  const s = stats(rows);
  const inTarget = (s.mean >= 0.298 && s.mean <= 0.303) ? '  <-- in target' : '';
  console.log(`${fmt(wp,2)}    ${fmt(wa,2)}    ${fmt(s.mean,4)}   ${fmt(s.p10,4)}   ${fmt(s.p90,4)}   ${fmt((s.p90-s.p10)*1000,1).padStart(4)}         ${fmt((s.mean-sLp.mean)*1000,1)}${inTarget}`);
}
console.log();

// (3) Same sweep with Step 2 OFF (isolate the blend contribution)
console.log('=== sweep w_proj, min_bf=50, downweight=false (isolate blend effect) ===');
console.log('w_proj  w_act   mean     p10      p90      spread(pt)   Δmean vs legacy');
for (const wp of [0.45, 0.35, 0.25, 0.15, 0.05]) {
  const wa = 1 - wp;
  const rows = computeAllTeams(wp, wa, MIN_BF_NEW, false);
  const s = stats(rows);
  console.log(`${fmt(wp,2)}    ${fmt(wa,2)}    ${fmt(s.mean,4)}   ${fmt(s.p10,4)}   ${fmt(s.p90,4)}   ${fmt((s.p90-s.p10)*1000,1).padStart(4)}         ${fmt((s.mean-sLp.mean)*1000,1)}`);
}
console.log();

// (4) Detailed per-team table at the recommended winner (once identified)
// Find the first w_proj that lands mean <= 0.303 under Step 2 ON
let recWP = null;
for (const wp of [0.45, 0.40, 0.35, 0.30, 0.25, 0.20, 0.15, 0.10, 0.05, 0.00]) {
  const wa = 1 - wp;
  const rows = computeAllTeams(wp, wa, MIN_BF_NEW, true);
  const s = stats(rows);
  if (s.mean <= 0.303) { recWP = wp; break; }
}
if (recWP == null) {
  console.log('WARNING: no w_proj in the swept range lands <=0.303. Even pure actuals (w_proj=0) undershoots?');
} else {
  const wa = 1 - recWP;
  const rows = computeAllTeams(recWP, wa, MIN_BF_NEW, true);
  const legacy = computeAllTeams(0.45, 0.55, MIN_BF_LEGACY, false);
  console.log('=== per-team at proposed defaults w_proj=' + recWP + ', w_act=' + wa + ', min_bf=50, downweight=true ===');
  const table = teams.map(t => {
    const L = legacy.find(r=>r.team===t);
    const N = rows.find(r=>r.team===t);
    return { team: t, legacy: L?.woba, newv: N?.woba, delta: (L?.woba && N?.woba) ? (N.woba - L.woba) : null };
  }).sort((a,b) => (a.legacy ?? 1) - (b.legacy ?? 1));
  for (const r of table) {
    const d = r.delta == null ? '' : fmt(r.delta*1000, 1);
    console.log(` ${r.team.padEnd(4)}  legacy ${fmt(r.legacy,4)}  new ${fmt(r.newv,4)}   Δ ${d.padStart(6)}pt`);
  }
  const s = stats(rows);
  console.log('\nnew mean :', fmt(s.mean, 4), '  (target 0.298-0.303)');
  console.log('legacy   :', fmt(sLp.mean, 4));
  console.log('Δ mean   :', fmt((s.mean - sLp.mean)*1000, 1) + 'pt');
}
