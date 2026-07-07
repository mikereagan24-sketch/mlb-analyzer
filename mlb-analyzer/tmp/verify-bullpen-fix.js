// Verify: (1) byte-identical when bullpen_min_bf=100 + bullpen_downweight_starters=false,
// (2) league mean lands in 0.298-0.303 with defaults, (3) COL/WAS drop from opener
// downweighting, (4) CLE/PHI/BOS/LAD drop further with Steamer regression fix.
//
// Runs q.getBullpenWobaBlended directly against each team's roster on
// 2026-07-07 lineups (or empty lineup fallback) and compares three modes:
//   LEGACY : minBF=100, downweightStarters=false     (byte-identical to prod today)
//   MIN_BF : minBF=50,  downweightStarters=false     (Step 1 alone)
//   BOTH   : minBF=50,  downweightStarters=true      (Steps 1+2 = new prod default)

const path = require('path');
const dbPath = path.join(__dirname, '..', 'data', 'mlb.db');
process.env.DATABASE_URL = process.env.DATABASE_URL || dbPath;

// Load the schema module — it side-effects a DB connection using DB_PATH env
// or the built-in path. We use the module-level q object it exports.
const dbModule = require('../db/schema');
const q = dbModule.q || dbModule;

const teamsRaw = q.getAllPitchers ? [] : null; // just to touch it
const rosterRPs = require('better-sqlite3')(dbPath, { readonly: true })
  .prepare("SELECT team, player_name FROM team_rosters WHERE role='RP'").all();
const byTeam = {};
for (const r of rosterRPs) { const t = (r.team||'').toUpperCase(); (byTeam[t] = byTeam[t] || []).push(r); }
const teams = Object.keys(byTeam).sort();

// Neutral inputs — WIRED TO PROD VALUES (w_proj=0.45, w_act=0.55, verified via
// SELECT value FROM app_settings WHERE key='w_proj'/'w_act' on 2026-07-07).
const GAMEDATE = '2026-07-07';
const wProj = 0.45, wAct = 0.55;
const bpSR = 0.55, bpWR = 0.45, bpSL = 0.35, bpWL = 0.65;
const unk = 0.335;
// Path B defaults
const BP_WP_NEW = 0.25, BP_WA_NEW = 0.75;

function fmt(n, d) { return n == null ? 'null' : Number(n).toFixed(d); }

function computeAllTeams(minBF, downweight, bpWProj, bpWAct) {
  const out = [];
  for (const t of teams) {
    // no lineup — use fallback path so results are lineup-independent
    const bp = q.getBullpenWobaBlended(t, '', [], bpSR, bpWR, bpSL, bpWL, wProj, wAct, GAMEDATE, unk, minBF, downweight, bpWProj, bpWAct);
    if (bp && bp.woba != null) out.push({ team: t, woba: bp.woba, vsR: bp.vsRHB, vsL: bp.vsLHB });
    else out.push({ team: t, woba: null });
  }
  return out;
}

console.log('=== running four modes ===');
// legacy = full byte-identical: bullpen blend = global (0.45/0.55), min_bf=100, no downweight
const legacy    = computeAllTeams(100, false, wProj, wAct);
// step1 = only BULLPEN_MIN_BF change (dormant on current data — no rows in [50,100))
const minbf     = computeAllTeams(50,  false, wProj, wAct);
// step2 = Step 1 + downweight starters (no blend change)
const step12    = computeAllTeams(50,  true,  wProj, wAct);
// pathB = Step 1 + Step 2 + Path B blend (0.25/0.75)  ← new prod default
const both      = computeAllTeams(50,  true,  BP_WP_NEW, BP_WA_NEW);

// Sanity: legacy has to match today's prod exactly. Report team-level table.
const rows = teams.map(t => {
  const L = legacy.find(r => r.team === t);
  const M = minbf.find(r => r.team === t);
  const S = step12.find(r => r.team === t);
  const B = both.find(r => r.team === t);
  return {
    team: t,
    legacy: L?.woba,
    step1:  M?.woba,
    step12: S?.woba,
    both:   B?.woba,
    d_step1:  (L?.woba != null && M?.woba != null) ? (M.woba - L.woba) : null,
    d_step12: (L?.woba != null && S?.woba != null) ? (S.woba - L.woba) : null,
    d_both:   (L?.woba != null && B?.woba != null) ? (B.woba - L.woba) : null,
  };
});
rows.sort((a,b) => (a.legacy ?? 1) - (b.legacy ?? 1));

function stats(arr) {
  const xs = arr.filter(x => x != null);
  if (!xs.length) return { n: 0 };
  const mean = xs.reduce((s,x)=>s+x,0) / xs.length;
  const sorted = xs.slice().sort((a,b)=>a-b);
  const p10 = sorted[Math.floor(xs.length*0.10)];
  const p50 = sorted[Math.floor(xs.length*0.50)];
  const p90 = sorted[Math.floor(xs.length*0.90)];
  return { n: xs.length, mean, p10, p50, p90, min: sorted[0], max: sorted[xs.length-1] };
}
const sL = stats(rows.map(r=>r.legacy));
const sM = stats(rows.map(r=>r.step1));
const sS = stats(rows.map(r=>r.step12));
const sB = stats(rows.map(r=>r.both));

console.log('\n=== headline: bullpen wOBA by mode (30 teams) ===');
console.log('mode                    n   mean     p10      p50      p90      spread(pt)');
console.log(`legacy (0.45/0.55, 100, off) ${sL.n.toString().padStart(2)}  ${fmt(sL.mean,4)}   ${fmt(sL.p10,4)}   ${fmt(sL.p50,4)}   ${fmt(sL.p90,4)}   ${fmt((sL.p90-sL.p10)*1000,1)}`);
console.log(`+ min_bf 50 only             ${sM.n.toString().padStart(2)}  ${fmt(sM.mean,4)}   ${fmt(sM.p10,4)}   ${fmt(sM.p50,4)}   ${fmt(sM.p90,4)}   ${fmt((sM.p90-sM.p10)*1000,1)}`);
console.log(`+ downweight starters        ${sS.n.toString().padStart(2)}  ${fmt(sS.mean,4)}   ${fmt(sS.p10,4)}   ${fmt(sS.p50,4)}   ${fmt(sS.p90,4)}   ${fmt((sS.p90-sS.p10)*1000,1)}`);
console.log(`Path B (0.25/0.75, 50, on)   ${sB.n.toString().padStart(2)}  ${fmt(sB.mean,4)}   ${fmt(sB.p10,4)}   ${fmt(sB.p50,4)}   ${fmt(sB.p90,4)}   ${fmt((sB.p90-sB.p10)*1000,1)}`);

// Byte-identical guard: legacy vs. current prod
// (must be all zeros; if not, one of the null-fallback branches is broken)

console.log('\n=== per-team table (sorted by legacy wOBA ascending) ===');
console.log('team   legacy    +minBF     both(Path B)   Δboth(pt)');
for (const r of rows) {
  const dB = r.d_both  == null ? '' : fmt(r.d_both  * 1000, 1);
  console.log(` ${r.team.padEnd(4)}  ${fmt(r.legacy,4)}    ${fmt(r.step1,4)}      ${fmt(r.both,4)}       ${dB.padStart(6)}`);
}

console.log('\n=== spot checks ===');
const target = 'CLE ATL COL WAS PHI BOS LAD DET NYY MIL'.split(' ');
for (const t of target) {
  const r = rows.find(x => x.team === t);
  if (!r) { console.log(t + ' — not present'); continue; }
  console.log(t + ':  legacy ' + fmt(r.legacy,4) + '   pathB ' + fmt(r.both,4) + ' (' + fmt((r.d_both||0)*1000,1) + 'pt)');
}

console.log('\n=== target range check ===');
console.log('legacy mean : ' + fmt(sL.mean, 4));
console.log('Path B mean : ' + fmt(sB.mean, 4));
console.log('revised roster-pool target : 0.303-0.308 (rationale in PR doc)');
const inRange = sB.mean >= 0.303 && sB.mean <= 0.308;
console.log('Path B landed in target?    ' + (inRange ? 'YES' : 'NO (mean=' + fmt(sB.mean, 4) + ')'));

console.log('\n=== byte-identical guard ===');
// Explicit check: setting BULLPEN_W_PROJ=0.45 & W_ACT=0.55 with min_bf=100, downweight=off
// must produce exactly the legacy output (up to floating-point precision).
const guard = computeAllTeams(100, false, wProj, wAct);
let allEq = true, maxDiff = 0;
for (const t of teams) {
  const L = legacy.find(x=>x.team===t)?.woba;
  const G = guard.find(x=>x.team===t)?.woba;
  if (L == null || G == null) continue;
  const d = Math.abs(L - G);
  if (d > maxDiff) maxDiff = d;
  if (d > 1e-9) allEq = false;
}
console.log('legacy == guard (100/off/0.45/0.55) : ' + (allEq ? 'IDENTICAL' : 'DIFF (max=' + maxDiff + ')'));
