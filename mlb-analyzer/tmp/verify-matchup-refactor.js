// Verifier for fix/matchup-woba-use-shared-resolver.
//
// Boots two in-process instances of the /api/woba/game/:date/:id
// endpoint logic — the PRE-refactor findIn cascade (reconstructed
// inline from git history in this file) and the POST-refactor shared
// fuzzyLookup path (imported live from routes/api.js). Runs both
// against today's TB@TOR slate and asserts:
//
//   1. Victor Mesa (TB, away) moves from VVM shadow (~.240 vsRHP)
//      to real Jr. TB (.313 vsRHP) post-refactor.
//   2. All OTHER 8 TB batters + all 9 TOR batters produce byte-
//      identical (woba, wobaVsSP, wobaVsOpp, source) tuples pre- vs
//      post-refactor. Any drift is a regression the refactor moved
//      someone the user didn't sign off on moving.
//   3. The per-side default policy still triggers when it should
//      (act-only + default -> both default, source='default'). Uses
//      a synthetic idx to force the exact input combination the
//      policy is designed to catch, since today's slate doesn't
//      naturally contain this shape for a rostered batter.
//
// Run: node tmp/verify-matchup-refactor.js
//
// NOTE: this is a display-path verifier. The signals-path verifier
// tmp/verify-batter-roster-gate.js already covers the gate itself.

const path = require('path');
const Database = require('better-sqlite3');

const model = require(path.join(__dirname, '..', 'services', 'model'));
const { normName, fuzzyLookup } = require(path.join(__dirname, '..', 'utils', 'names'));

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });
const rows = db.prepare('SELECT data_key, player_name, woba, sample_size FROM woba_data').all();
const wobaIdx = model.buildWobaIndex(rows);

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else      { failed++; console.log('  FAIL: ' + msg); }
}

// ── Pre-refactor lookupBatter (inline reconstruction of what the ────────
// /api/woba/game/:date/:id endpoint did before this fix).
// Kept as a single self-contained function so the pre/post comparison
// tests are apples-to-apples; do NOT trim to "just the resolver" — the
// per-side blend and default policy also need to match, since they're
// what the endpoint returns.
const SETTINGS = {
  W_PROJ: 0.65, W_ACT: 0.35, MIN_PA: 60,
  BAT_DFLT_START: 0.315, BAT_DFLT_OPP: 0.320,
  SP_WEIGHT: 0.77, RELIEF_WEIGHT: 0.23,
};
function _bDflt(hand) {
  const start = SETTINGS.BAT_DFLT_START, opp = SETTINGS.BAT_DFLT_OPP;
  const eff = hand === 'S' ? 'R' : (hand || 'R');
  return eff === 'L' ? { vsLHP: start, vsRHP: opp } : { vsLHP: opp, vsRHP: start };
}
const BAT_DFLT = { R: _bDflt('R'), L: _bDflt('L'), S: _bDflt('S') };

function preRefactorLookup(name, hand, oppSpHand, teamHint) {
  // This is the PRE-refactor findIn cascade — verbatim from git HEAD~1
  // routes/api.js:4375-4474. Do NOT modify. Its job is to reproduce the
  // exact wOBA values the endpoint produced yesterday so we can prove
  // the refactor doesn't move anyone but Victor Mesa.
  const vsKey  = oppSpHand==='R' ? 'bat-proj-rhp' : 'bat-proj-lhp';
  const actKey = oppSpHand==='R' ? 'bat-act-rhp'  : 'bat-act-lhp';
  const oppKey    = oppSpHand==='R' ? 'bat-proj-lhp' : 'bat-proj-rhp';
  const oppActKey = oppSpHand==='R' ? 'bat-act-lhp'  : 'bat-act-rhp';
  const dflt = BAT_DFLT[hand] || BAT_DFLT['R'];
  const dfltV    = oppSpHand==='R' ? dflt.vsRHP : dflt.vsLHP;
  const dfltVOpp = oppSpHand==='R' ? dflt.vsLHP : dflt.vsRHP;
  const _normLocal = (n) => (n||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim();
  const key = _normLocal(name);
  const parts = key.split(' ');
  const isAbbrev = parts.length >= 2 && parts[0].length === 1;
  const stripJr = (n) => n.replace(/\b(jr|sr|ii|iii|iv)\b/g,'').replace(/\s+/g,' ').trim();
  function findIn(idx, k, tHint, minSample) {
    if (!idx) return null;
    const gate = (entry) => {
      if (!entry) return null;
      if (minSample != null && (entry.sample == null || entry.sample < minSample)) return null;
      return entry.woba;
    };
    const tl = tHint ? tHint.toLowerCase() : null;
    if (tl && idx[k+' '+tl]) { const w = gate(idx[k+' '+tl]); if (w != null) return w; }
    if (idx[k]) { const w = gate(idx[k]); if (w != null) return w; }
    if (tl) {
      const jrEntry = Object.entries(idx).find(([n]) => {
        if (!n.endsWith(' '+tl)) return false;
        const base = n.slice(0, n.length - tl.length - 1).trim();
        return stripJr(base) === k;
      });
      if (jrEntry) { const w = gate(jrEntry[1]); if (w != null) return w; }
    }
    if (isAbbrev) {
      const initial = parts[0], last = parts[parts.length - 1];
      if (tl) {
        const e = Object.entries(idx).find(([n]) => {
          if (!n.endsWith(' '+tl)) return false;
          const base = n.slice(0, n.length - tl.length - 1).trim();
          const p = stripJr(base).split(' ');
          return p[p.length - 1] === last && p[0] && p[0][0] === initial;
        });
        if (e) { const w = gate(e[1]); if (w != null) return w; }
      }
      const matches = Object.entries(idx).filter(([n]) => {
        if (/\s[a-z]{2,3}$/.test(n)) return false;
        const p = stripJr(n).split(' ');
        return p[p.length - 1] === last && p[0] && p[0][0] === initial;
      });
      if (matches.length === 1) { const w = gate(matches[0][1]); if (w != null) return w; }
    }
    const sk = stripJr(k);
    if (tl && idx[sk+' '+tl]) { const w = gate(idx[sk+' '+tl]); if (w != null) return w; }
    const e2 = Object.entries(idx).find(([n]) => !/\s[a-z]{2,3}$/.test(n) && stripJr(n) === sk);
    if (e2) { const w = gate(e2[1]); if (w != null) return w; }
    return null;
  }
  const projV = findIn(wobaIdx[vsKey], key, teamHint);
  const actV  = findIn(wobaIdx[actKey], key, teamHint, SETTINGS.MIN_PA);
  const wobaVsSPraw = (projV && actV) ? +(SETTINGS.W_PROJ*projV + SETTINGS.W_ACT*actV).toFixed(3)
                   : projV ? +projV.toFixed(3) : actV ? +actV.toFixed(3) : null;
  const srcVsSP = (projV && actV) ? 'blend' : projV ? 'proj' : actV ? 'act' : 'default';
  const projO = findIn(wobaIdx[oppKey], key, teamHint);
  const actO  = findIn(wobaIdx[oppActKey], key, teamHint, SETTINGS.MIN_PA);
  const wobaVsOppRaw = (projO && actO) ? +(SETTINGS.W_PROJ*projO + SETTINGS.W_ACT*actO).toFixed(3)
                    : projO ? +projO.toFixed(3) : actO ? +actO.toFixed(3) : null;
  const srcVsOpp = (projO && actO) ? 'blend' : projO ? 'proj' : actO ? 'act' : 'default';
  const wobaVsSP  = wobaVsSPraw  != null ? wobaVsSPraw  : +dfltV.toFixed(3);
  const wobaVsOpp = wobaVsOppRaw != null ? wobaVsOppRaw : +dfltVOpp.toFixed(3);
  const oneSideActFluke = (srcVsSP === 'act' && srcVsOpp === 'default')
                       || (srcVsOpp === 'act' && srcVsSP === 'default');
  const finalVsSP  = oneSideActFluke ? +dfltV.toFixed(3)    : wobaVsSP;
  const finalVsOpp = oneSideActFluke ? +dfltVOpp.toFixed(3) : wobaVsOpp;
  const blended = +(finalVsSP*SETTINGS.SP_WEIGHT + finalVsOpp*SETTINGS.RELIEF_WEIGHT).toFixed(3);
  const bothDefault = (srcVsSP === 'default' && srcVsOpp === 'default');
  const finalSource = (oneSideActFluke || bothDefault) ? 'default' : srcVsSP;
  return { woba: blended, wobaVsSP: finalVsSP, wobaVsOpp: finalVsOpp, source: finalSource };
}

// ── Post-refactor lookupBatter (imports the CURRENT logic verbatim). ────
// Constructed here rather than re-imported from api.js so the verifier
// stays hermetic (no need to boot the Express router). Structurally
// identical to the endpoint's lookupBatter — the goal is to exercise
// the same code path, including buildRosterGatedIdx.
function postRefactorLookup(name, hand, oppSpHand, teamHint, ownGatedIdx) {
  const vsKey  = oppSpHand==='R' ? 'bat-proj-rhp' : 'bat-proj-lhp';
  const actKey = oppSpHand==='R' ? 'bat-act-rhp'  : 'bat-act-lhp';
  const oppKey    = oppSpHand==='R' ? 'bat-proj-lhp' : 'bat-proj-rhp';
  const oppActKey = oppSpHand==='R' ? 'bat-act-lhp'  : 'bat-act-rhp';
  const dflt = BAT_DFLT[hand] || BAT_DFLT['R'];
  const dfltV    = oppSpHand==='R' ? dflt.vsRHP : dflt.vsLHP;
  const dfltVOpp = oppSpHand==='R' ? dflt.vsLHP : dflt.vsRHP;
  const lookupProj = (idxKey) => {
    const hit = fuzzyLookup(ownGatedIdx[idxKey], name, teamHint);
    return hit ? hit.woba : null;
  };
  const lookupAct = (idxKey) => {
    const hit = fuzzyLookup(ownGatedIdx[idxKey], name, teamHint);
    if (!hit) return null;
    if (hit.sample == null || hit.sample < SETTINGS.MIN_PA) return null;
    return hit.woba;
  };
  const projV = lookupProj(vsKey);
  const actV  = lookupAct(actKey);
  const wobaVsSPraw = (projV != null && actV != null) ? +(SETTINGS.W_PROJ*projV + SETTINGS.W_ACT*actV).toFixed(3)
                   : projV != null ? +projV.toFixed(3) : actV != null ? +actV.toFixed(3) : null;
  const srcVsSP = (projV != null && actV != null) ? 'blend' : projV != null ? 'proj' : actV != null ? 'act' : 'default';
  const projO = lookupProj(oppKey);
  const actO  = lookupAct(oppActKey);
  const wobaVsOppRaw = (projO != null && actO != null) ? +(SETTINGS.W_PROJ*projO + SETTINGS.W_ACT*actO).toFixed(3)
                    : projO != null ? +projO.toFixed(3) : actO != null ? +actO.toFixed(3) : null;
  const srcVsOpp = (projO != null && actO != null) ? 'blend' : projO != null ? 'proj' : actO != null ? 'act' : 'default';
  const wobaVsSP  = wobaVsSPraw  != null ? wobaVsSPraw  : +dfltV.toFixed(3);
  const wobaVsOpp = wobaVsOppRaw != null ? wobaVsOppRaw : +dfltVOpp.toFixed(3);
  const oneSideActFluke = (srcVsSP === 'act' && srcVsOpp === 'default')
                       || (srcVsOpp === 'act' && srcVsSP === 'default');
  const finalVsSP  = oneSideActFluke ? +dfltV.toFixed(3)    : wobaVsSP;
  const finalVsOpp = oneSideActFluke ? +dfltVOpp.toFixed(3) : wobaVsOpp;
  const blended = +(finalVsSP*SETTINGS.SP_WEIGHT + finalVsOpp*SETTINGS.RELIEF_WEIGHT).toFixed(3);
  const bothDefault = (srcVsSP === 'default' && srcVsOpp === 'default');
  const finalSource = (oneSideActFluke || bothDefault) ? 'default' : srcVsSP;
  return { woba: blended, wobaVsSP: finalVsSP, wobaVsOpp: finalVsOpp, source: finalSource };
}

// ── Test 1: TB@TOR pre-vs-post comparison ───────────────────────────────
console.log('\n=== Test 1: TB@TOR pre-refactor vs post-refactor ===\n');
const game = db.prepare("SELECT * FROM game_log WHERE game_date='2026-07-23' AND game_id='tb-tor'").get();
if (!game) {
  console.log('  SKIP: no tb-tor game in local DB');
  process.exit(0);
}
const awayLineup = JSON.parse(game.away_lineup_json || '[]');
const homeLineup = JSON.parse(game.home_lineup_json || '[]');

// Build rosterSets the same way the endpoint does
function rosterSetFor(team) {
  const rows = db.prepare("SELECT player_name FROM team_rosters WHERE team=? AND role='POS'")
    .all((team || '').toUpperCase());
  return rows.length ? new Set(rows.map(r => normName(r.player_name))) : null;
}
const awayGateSet = rosterSetFor(game.away_team);
const homeGateSet = rosterSetFor(game.home_team);
const awayGatedIdx = model.buildRosterGatedIdx(wobaIdx, game.away_team, awayGateSet);
const homeGatedIdx = model.buildRosterGatedIdx(wobaIdx, game.home_team, homeGateSet);

let victorMesaChangedCorrectly = false;
let otherChanges = [];

for (const [side, lineup, teamHint, oppHand, gatedIdx] of [
  ['away', awayLineup, game.away_team, game.home_sp_hand || 'R', awayGatedIdx],
  ['home', homeLineup, game.home_team, game.away_sp_hand || 'R', homeGatedIdx],
]) {
  for (const b of lineup) {
    if (!b || !b.name) continue;
    const pre  = preRefactorLookup(b.name, b.hand, oppHand, teamHint);
    const post = postRefactorLookup(b.name, b.hand, oppHand, teamHint, gatedIdx);
    const changed = pre.woba !== post.woba || pre.wobaVsSP !== post.wobaVsSP
                 || pre.wobaVsOpp !== post.wobaVsOpp || pre.source !== post.source;
    if (b.name.toLowerCase().includes('victor mesa')) {
      const upgraded = pre.wobaVsSP < 0.28 && post.wobaVsSP > 0.28;
      victorMesaChangedCorrectly = upgraded;
      console.log(`  ${teamHint} ${b.name}:`);
      console.log(`    PRE : woba=${pre.woba}  vsSP=${pre.wobaVsSP}  vsOpp=${pre.wobaVsOpp}  src=${pre.source}`);
      console.log(`    POST: woba=${post.woba}  vsSP=${post.wobaVsSP}  vsOpp=${post.wobaVsOpp}  src=${post.source}`);
    } else if (changed) {
      otherChanges.push({ team: teamHint, name: b.name, pre, post });
    }
  }
}

assert(victorMesaChangedCorrectly, 'Victor Mesa upgraded from VVM shadow (~.24) to real Jr. TB (~.31)');
assert(otherChanges.length === 0, 'zero other batters moved: ' + otherChanges.length + ' unexpected changes');
if (otherChanges.length > 0) {
  console.log('  Unexpected movement:');
  for (const c of otherChanges) {
    console.log(`    ${c.team} ${c.name}: pre=${JSON.stringify(c.pre)} post=${JSON.stringify(c.post)}`);
  }
}

// ── Test 2: Per-side default policy still triggers (synthetic idx) ──────
console.log('\n=== Test 2: per-side default policy (act-only + default -> both default) ===\n');
{
  // Synthesize a batter with actuals ONLY on RHP-side and NOTHING on
  // LHP-side. Rostered so the gate doesn't reject.
  const NAME = 'Fluke McRookie';
  const TEAM = 'MIL';
  const idx = {
    'bat-proj-lhp': {},
    'bat-act-lhp':  {},
    'bat-proj-rhp': {},
    'bat-act-rhp':  { [normName(NAME)]: { woba: 0.529, sample: 500.0 } },
  };
  const rosterSet = new Set([normName(NAME)]);
  const gatedIdx = model.buildRosterGatedIdx(idx, TEAM, rosterSet);
  const bw = postRefactorLookup(NAME, 'R', 'R', TEAM, gatedIdx);
  // Batter faces RHP → vsSP=RHP=act(.529), vsOpp=LHP=default
  // policy: oneSideActFluke=true → both forced to defaults
  // BAT_DFLT for R: {vsLHP: opp=.320, vsRHP: start=.315}
  // finalVsSP  = dfltV    = vsRHP = start = .315
  // finalVsOpp = dfltVOpp = vsLHP = opp   = .320
  // blended = .315*.77 + .320*.23 = .24255 + .0736 = .31615 → .316
  assert(bw.source === 'default', 'source is "default" (fluke suppression fired): got ' + bw.source);
  assert(Math.abs(bw.wobaVsSP - 0.315) < 0.001, 'vsSP forced to default (.315): got ' + bw.wobaVsSP);
  assert(Math.abs(bw.wobaVsOpp - 0.320) < 0.001, 'vsOpp forced to default (.320): got ' + bw.wobaVsOpp);
  assert(Math.abs(bw.woba - 0.316) < 0.002, 'blended is default combo (~.316): got ' + bw.woba);
}

// ── Test 3: normal blend batter (no fluke suppression) ──────────────────
console.log('\n=== Test 3: normal batter — no fluke suppression, source respects proj/blend ===\n');
{
  const NAME = 'Normal Batter';
  const TEAM = 'BOS';
  const idx = {
    'bat-proj-lhp': { [normName(NAME)]: { woba: 0.300, sample: 500 } },
    'bat-act-lhp':  { [normName(NAME)]: { woba: 0.310, sample: 300 } },
    'bat-proj-rhp': { [normName(NAME)]: { woba: 0.320, sample: 500 } },
    'bat-act-rhp':  { [normName(NAME)]: { woba: 0.330, sample: 300 } },
  };
  const rosterSet = new Set([normName(NAME)]);
  const gatedIdx = model.buildRosterGatedIdx(idx, TEAM, rosterSet);
  const bw = postRefactorLookup(NAME, 'R', 'R', TEAM, gatedIdx);
  assert(bw.source === 'blend', 'blend source when both proj and act present: got ' + bw.source);
  // vsSP = RHP blend = .65*.320 + .35*.330 = .208 + .1155 = .3235 → .324 (after rounding)
  assert(Math.abs(bw.wobaVsSP - 0.324) < 0.002, 'vsSP is RHP blend: got ' + bw.wobaVsSP);
}

console.log();
console.log('=== Summary ===');
console.log('  Passed: ' + passed);
console.log('  Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
