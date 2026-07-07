// Re-verify the bullpen level-bug decomposition on the freshest local DB.
// Mirrors the queries described in docs/bullpen-level-decomposition-2026-07-07.md
// so the pre-implementation numbers can be compared directly against the
// stale-mirror numbers the doc was built on.

const path = require('path');
const db = require('better-sqlite3')(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });

function fmt(n, d) { return n == null ? 'null' : Number(n).toFixed(d); }

console.log('=== db freshness ===');
try { console.log('bet_signals max game_date  :', db.prepare('SELECT MAX(game_date) d FROM bet_signals').get().d); } catch (e) {}
try { console.log('pitcher_game_log max date  :', db.prepare('SELECT MAX(game_date) d FROM pitcher_game_log').get().d); } catch (e) {}
try { console.log('team_rosters max snapshot  :', db.prepare('SELECT MAX(snapshot_date) d FROM team_rosters').get().d); } catch (e) { console.log('rosters date col missing:', e.message); }
try {
  const cols = db.prepare("PRAGMA table_info(team_rosters)").all().map(c=>c.name).join(',');
  console.log('team_rosters cols          :', cols);
} catch (e) {}
try {
  const cols = db.prepare("PRAGMA table_info(pitcher_game_log)").all().map(c=>c.name).join(',');
  console.log('pitcher_game_log cols      :', cols);
} catch (e) {}
try {
  const cols = db.prepare("PRAGMA table_info(woba_data)").all().map(c=>c.name).join(',');
  console.log('woba_data cols             :', cols);
} catch (e) {}
console.log();

// Roster snapshot: current active RPs
const rosterRPs = db.prepare("SELECT team, player_name FROM team_rosters WHERE role='RP'").all();
const rosterByTeam = {};
for (const r of rosterRPs) {
  const t = (r.team || '').toUpperCase();
  if (!rosterByTeam[t]) rosterByTeam[t] = [];
  rosterByTeam[t].push(r.player_name);
}
const teams = Object.keys(rosterByTeam).sort();
console.log('=== roster context ===');
console.log('teams with RP roster :', teams.length);
console.log('total roster RPs     :', rosterRPs.length);
console.log('per-team avg         :', (rosterRPs.length / (teams.length || 1)).toFixed(1));
console.log();

// Normalize name for fuzzy join against woba_data (which stores 'Full Name TEAM')
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Load Steamer projections by handedness. data_key='pit-proj-rhb' / 'pit-proj-lhb'
const projR = db.prepare("SELECT player_name, woba, sample_size FROM woba_data WHERE data_key='pit-proj-rhb'").all();
const projL = db.prepare("SELECT player_name, woba, sample_size FROM woba_data WHERE data_key='pit-proj-lhb'").all();
const actR = db.prepare("SELECT player_name, woba, sample_size FROM woba_data WHERE data_key='pit-act-rhb'").all();
const actL = db.prepare("SELECT player_name, woba, sample_size FROM woba_data WHERE data_key='pit-act-lhb'").all();

function indexByLastAndTeam(rows) {
  const idx = {};
  for (const r of rows) {
    const raw = r.player_name || '';
    const m = raw.match(/^(.+?)\s+([A-Z]{2,3})$/);
    const nameOnly = m ? m[1] : raw;
    const team = m ? m[2] : '';
    const norm = normName(nameOnly);
    const last = norm.split(' ').pop();
    const key = last + '|' + team;
    idx[key] = { name: nameOnly, team, norm, last, woba: r.woba, sample: r.sample_size };
  }
  return idx;
}
const projRIdx = indexByLastAndTeam(projR);
const projLIdx = indexByLastAndTeam(projL);
const actRIdx  = indexByLastAndTeam(actR);
const actLIdx  = indexByLastAndTeam(actL);

// Lookup helper — try (last,TEAM), then any actuals row matching last-name alone (no team, sample largest)
function lookupProj(idx, playerNorm, team) {
  const last = playerNorm.split(' ').pop();
  const k = last + '|' + team;
  return idx[k] || null;
}
function lookupActFuzzy(idx, playerNorm, team) {
  const last = playerNorm.split(' ').pop();
  const k = last + '|' + team;
  if (idx[k]) return idx[k];
  // no team-tag actuals rows exist (data_key='pit-act-*' is per-pitcher, name-only in these tables).
  // Try last-name only, largest sample.
  let best = null;
  for (const key of Object.keys(idx)) {
    if (!key.startsWith(last + '|')) continue;
    if (!best || (idx[key].sample || 0) > (best.sample || 0)) best = idx[key];
  }
  return best;
}

// (a) FALLBACK COUNT — roster RPs missing a proj row (either hand OK: has-projR OR has-projL)
let fallbackCount = 0;
const fallbackTeams = new Set();
const perTeamFallback = {};
for (const t of teams) {
  perTeamFallback[t] = 0;
  for (const name of rosterByTeam[t]) {
    const n = normName(name);
    const hasR = !!lookupProj(projRIdx, n, t);
    const hasL = !!lookupProj(projLIdx, n, t);
    if (!hasR && !hasL) {
      fallbackCount++;
      fallbackTeams.add(t);
      perTeamFallback[t]++;
    }
  }
}
console.log('=== (a) fallback pollution ===');
console.log('roster RPs missing proj row :', fallbackCount, '/', rosterRPs.length, '(', (fallbackCount/rosterRPs.length*100).toFixed(1), '%)');
console.log('teams with any fallback     :', fallbackTeams.size);
console.log('teams with 0 fallbacks      :', teams.length - fallbackTeams.size);
const maxFb = Math.max(...Object.values(perTeamFallback));
const teamsAtMax = Object.entries(perTeamFallback).filter(([_,c])=>c===maxFb).map(([t])=>t);
console.log('max fallbacks per team      :', maxFb, '(', teamsAtMax.join(', '), ')');
console.log();

// (b) OPENER/BULK POLLUTION — roster RPs with ≥1 start in the last 60d window
// pitcher_game_log has columns for started (is_start / gs / bf, tbd) — inspect
try {
  const sampleGL = db.prepare("SELECT * FROM pitcher_game_log LIMIT 1").get();
  console.log('=== (b) opener/bulk pollution — pitcher_game_log sample row ===');
  console.log(JSON.stringify(sampleGL, null, 2).slice(0, 600));
} catch (e) { console.log('pgl sample err:', e.message); }
console.log();

// Try to identify start-flag column name
const glCols = db.prepare("PRAGMA table_info(pitcher_game_log)").all().map(c=>c.name);
const hasIsStart = glCols.includes('is_start');
const hasGs     = glCols.includes('gs');
const hasStart  = glCols.includes('start');
const hasWasStarter = glCols.includes('was_starter');
const startCol = hasIsStart ? 'is_start' : (hasGs ? 'gs' : (hasStart ? 'start' : (hasWasStarter ? 'was_starter' : null)));
const bfCol = glCols.includes('bf') ? 'bf' : (glCols.includes('batters_faced') ? 'batters_faced' : null);
console.log('start col detected :', startCol, '| bf col detected :', bfCol);

if (startCol && bfCol) {
  // last 60d relative to the freshest game_date
  const maxDate = db.prepare('SELECT MAX(game_date) d FROM pitcher_game_log').get().d;
  const cutoff = maxDate ? new Date(new Date(maxDate).getTime() - 60*86400000).toISOString().slice(0,10) : '2020-01-01';
  const perPitcher = db.prepare(`
    SELECT pitcher_name AS player_name,
           SUM(CASE WHEN ${startCol}=1 THEN ${bfCol} ELSE 0 END) as start_bf,
           SUM(CASE WHEN ${startCol}=0 THEN ${bfCol} ELSE 0 END) as relief_bf,
           SUM(CASE WHEN ${startCol}=1 THEN 1 ELSE 0 END) as starts,
           SUM(CASE WHEN ${startCol}=0 THEN 1 ELSE 0 END) as reliefs
    FROM pitcher_game_log
    WHERE game_date >= ?
    GROUP BY pitcher_name
  `).all(cutoff);
  console.log('window cutoff       :', cutoff, '(60d back from', maxDate + ')');
  // Match against roster RPs
  const rpNames = new Set();
  const rpByNorm = {};
  for (const t of teams) for (const n of rosterByTeam[t]) { const nn = normName(n); rpNames.add(nn); rpByNorm[nn] = t; }
  const rpUsage = [];
  for (const row of perPitcher) {
    const nn = normName(row.player_name);
    if (rpNames.has(nn)) rpUsage.push({ ...row, norm: nn, team: rpByNorm[nn] });
  }
  const rpWithStarts = rpUsage.filter(r => r.starts > 0);
  const totBF = rpUsage.reduce((s,r)=>s + r.start_bf + r.relief_bf, 0);
  const startBFsum = rpWithStarts.reduce((s,r)=>s+r.start_bf, 0);
  const reliefBFsum = rpWithStarts.reduce((s,r)=>s+r.relief_bf, 0);
  console.log('roster RPs with ≥1 start :', rpWithStarts.length);
  console.log('roster RPs with any GL   :', rpUsage.length);
  console.log('total BF from ≥1-start RPs:', startBFsum + reliefBFsum, '(starts', startBFsum, '/ relief', reliefBFsum, '=', (startBFsum/(startBFsum+reliefBFsum)*100).toFixed(1) + '% from starts)');

  // Top polluted (>25% from starts)
  const heavy = rpWithStarts
    .filter(r => (r.start_bf + r.relief_bf) >= 20)
    .map(r => ({ ...r, frac: r.start_bf / (r.start_bf + r.relief_bf) }))
    .filter(r => r.frac > 0.25)
    .sort((a,b) => b.frac - a.frac);
  console.log('heavy-polluted list (>25% BF from starts):', heavy.length);
  for (const r of heavy.slice(0, 12)) {
    console.log(`  ${r.team.padEnd(4)} ${r.player_name.padEnd(24)} starts ${String(r.starts).padStart(2)} reliefs ${String(r.reliefs).padStart(3)}   ${r.start_bf}/${r.relief_bf} BF   ${(r.frac*100).toFixed(0)}% from starts`);
  }

  // Steamer proj wOBA comparison: RPs WITH start outings vs pure-relief RPs
  const withStartWobas = [];
  const pureReliefWobas = [];
  for (const t of teams) {
    for (const name of rosterByTeam[t]) {
      const nn = normName(name);
      const usage = rpUsage.find(u => u.norm === nn);
      const projRow = lookupProj(projRIdx, nn, t) || lookupProj(projLIdx, nn, t);
      if (!projRow || projRow.woba == null) continue;
      if (usage && usage.starts > 0) withStartWobas.push(projRow.woba);
      else if (usage) pureReliefWobas.push(projRow.woba);
    }
  }
  const mean = arr => arr.reduce((s,x)=>s+x,0) / (arr.length || 1);
  console.log();
  console.log('Steamer proj wOBA compare (both-hand-first-hit):');
  console.log('  roster RPs WITH ≥1 start :', withStartWobas.length, 'mean =', fmt(mean(withStartWobas), 4));
  console.log('  pure-relief roster RPs   :', pureReliefWobas.length, 'mean =', fmt(mean(pureReliefWobas), 4));
  console.log('  Δ (polluted − pure)      :', fmt((mean(withStartWobas)-mean(pureReliefWobas))*1000, 1) + 'pt');
}
console.log();

// (c) STEAMER OVER-REGRESSION — proj vs act mean/spread among roster RPs with actuals ≥100 BF (both hands)
console.log('=== (c) Steamer over-regression ===');
const compareRows = [];
for (const t of teams) {
  for (const name of rosterByTeam[t]) {
    const nn = normName(name);
    const pR = lookupProj(projRIdx, nn, t);
    const pL = lookupProj(projLIdx, nn, t);
    const aR = lookupActFuzzy(actRIdx, nn, t);
    const aL = lookupActFuzzy(actLIdx, nn, t);
    if (!pR || !aR) continue;
    if ((aR.sample || 0) < 100 || (aL?.sample || 0) < 100) continue;
    const projMean = (pR.woba + (pL ? pL.woba : pR.woba)) / (pL ? 2 : 1);
    const actMean = (aR.woba + (aL ? aL.woba : aR.woba)) / (aL ? 2 : 1);
    compareRows.push({ team: t, name, projMean, actMean, delta: projMean - actMean, aR_sample: aR.sample, aL_sample: aL?.sample });
  }
}
console.log('n roster RPs with ≥100BF vs both hands :', compareRows.length);
const meanProj = compareRows.reduce((s,r)=>s+r.projMean,0) / (compareRows.length || 1);
const meanAct  = compareRows.reduce((s,r)=>s+r.actMean, 0) / (compareRows.length || 1);
function stdev(arr, m) { return Math.sqrt(arr.reduce((s,x)=>s+(x-m)*(x-m),0) / (arr.length || 1)); }
const sdProj = stdev(compareRows.map(r=>r.projMean), meanProj);
const sdAct  = stdev(compareRows.map(r=>r.actMean),  meanAct);
console.log('mean proj  :', fmt(meanProj, 4));
console.log('mean act   :', fmt(meanAct,  4));
console.log('Δ (p − a)  :', fmt((meanProj - meanAct)*1000, 1) + 'pt');
console.log('σ proj     :', fmt(sdProj, 4));
console.log('σ act      :', fmt(sdAct,  4));
console.log('σ ratio    :', fmt(sdAct / (sdProj || 1), 2));

// Top elite underestimates (proj − act > 0.06)
const top = compareRows.filter(r => r.delta > 0.06).sort((a,b)=>b.delta - a.delta).slice(0, 8);
console.log();
console.log('Top elite underestimates (proj − act > 60pt):');
for (const r of top) {
  console.log('  ' + r.team.padEnd(4) + ' ' + r.name.padEnd(28) + ' act ' + fmt(r.actMean,3) + '  proj ' + fmt(r.projMean,3) + '  +' + fmt(r.delta*1000, 1) + 'pt');
}
console.log();

// Team-level bullpen mean vs SP mean — the headline gap
console.log('=== headline: model bullpen mean vs SP mean ===');
// approximate: for each team compute pool of roster-RP projections (equal-weight, both hands avg)
const teamMeans = [];
for (const t of teams) {
  const projs = [];
  for (const name of rosterByTeam[t]) {
    const nn = normName(name);
    const pR = lookupProj(projRIdx, nn, t);
    const pL = lookupProj(projLIdx, nn, t);
    if (pR && pL) projs.push((pR.woba + pL.woba) / 2);
    else if (pR) projs.push(pR.woba);
    else if (pL) projs.push(pL.woba);
    else projs.push(0.335); // fallback
  }
  if (projs.length) teamMeans.push({ team: t, mean: projs.reduce((s,x)=>s+x,0) / projs.length });
}
teamMeans.sort((a,b)=>a.mean - b.mean);
const bpMean = teamMeans.reduce((s,r)=>s+r.mean,0) / (teamMeans.length || 1);
const p10 = teamMeans[Math.floor(teamMeans.length * 0.10)]?.mean;
const p90 = teamMeans[Math.floor(teamMeans.length * 0.90)]?.mean;
console.log('bullpen mean across teams :', fmt(bpMean, 4));
console.log('P10 / P90                :', fmt(p10, 4), '/', fmt(p90, 4), 'spread =', fmt((p90-p10)*1000, 1) + 'pt');
console.log('teams (bottom 5) :');
for (const r of teamMeans.slice(0, 5)) console.log('  ' + r.team + ' ' + fmt(r.mean, 4));
console.log('teams (top 5)    :');
for (const r of teamMeans.slice(-5)) console.log('  ' + r.team + ' ' + fmt(r.mean, 4));

// SP mean via team_rosters role='SP' proj (both hands avg)
try {
  const spRoster = db.prepare("SELECT team, player_name FROM team_rosters WHERE role='SP'").all();
  const spWobas = [];
  for (const r of spRoster) {
    const nn = normName(r.player_name);
    const t = (r.team || '').toUpperCase();
    const pR = lookupProj(projRIdx, nn, t);
    const pL = lookupProj(projLIdx, nn, t);
    if (pR && pL) spWobas.push((pR.woba + pL.woba) / 2);
    else if (pR)  spWobas.push(pR.woba);
    else if (pL)  spWobas.push(pL.woba);
  }
  const spMean = spWobas.reduce((s,x)=>s+x,0) / (spWobas.length || 1);
  console.log('\nSP mean (role=SP)         :', fmt(spMean, 4), 'n=', spWobas.length, '/', spRoster.length);
  console.log('BP-SP delta               :', fmt((bpMean - spMean)*1000, 1) + 'pt (real target: -10 to -15pt)');
} catch (e) { console.log('SP mean err:', e.message); }
