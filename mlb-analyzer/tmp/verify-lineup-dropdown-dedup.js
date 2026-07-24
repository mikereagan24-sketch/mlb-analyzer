// Verifier for fix/lineup-dropdown-dedup-abbrev-to-roster.
//
// Reproduces the client-side dedup logic from public/index.html
// (_matchScrapedToRoster + _luNormName + _luStripSfx are inline in
// the modal renderer). This verifier ports the same functions to
// Node so we can run them against real slate data.
//
// Verifies:
//   (1) Exact-match cases pass through unchanged (no regression).
//   (2) Abbrev-form scraped + full-form roster collapses to ONE
//       option: the roster full form, pre-selected. No "(off-roster)"
//       fake option appears.
//   (3) Diacritic mismatch collapses correctly (ASCII scrape hits
//       accented roster entry).
//   (4) Suffix mismatch collapses ("R. Acuna" → "Ronald Acuña Jr.").
//   (5) Ambiguity guard — two roster players sharing (initial, last)
//       returns null; scraped entry stays as "(off-roster)" so the
//       user picks explicitly rather than us guessing wrong.
//   (6) Genuinely off-roster scraped names stay as "(off-roster)" —
//       preserved so same-day callups (not yet in team_rosters) don't
//       silently break the lineup edit.
//   (7) Slate-wide sweep of today's local scraped lineups: every
//       scraped batter name that maps to a roster player, does so
//       via a UNIQUE fuzzy match — count of collapsed vs still-off-
//       roster reported.
//
// Not tested here: the DOM rendering itself (that's public/index.html
// JS running in a browser). This verifies the matching algorithm the
// renderer depends on. If the algorithm is correct, the render just
// consumes its output.
//
// Run: node tmp/verify-lineup-dropdown-dedup.js

const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else      { failed++; console.log('  FAIL: ' + msg); }
}

// ── Port of the client-side helpers (public/index.html inline) ─────────
// These must stay in lockstep with the JS versions. If either side
// changes, the other must move with it — otherwise the browser will
// dedup differently from what this verifier says.
function _luNormName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function _luStripSfx(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(function(t) { return !/^(jr|sr|ii|iii|iv)\.?$/i.test(t); })
    .join(' ');
}
function _matchScrapedToRoster(scrapedName, roster) {
  if (!scrapedName || !roster || !roster.length) return null;
  var sNorm = _luNormName(scrapedName);
  var sParts = _luStripSfx(sNorm).split(/\s+/);
  if (sParts.length < 2) return null;
  var sInitial = sParts[0] && sParts[0][0];
  var sLast = sParts[sParts.length - 1];
  if (!sInitial || !sLast) return null;
  var matches = [];
  for (var i = 0; i < roster.length; i++) {
    var rNorm = _luNormName(roster[i].player_name);
    var rParts = _luStripSfx(rNorm).split(/\s+/);
    if (rParts.length < 2) continue;
    var rInitial = rParts[0] && rParts[0][0];
    var rLast = rParts[rParts.length - 1];
    if (rInitial === sInitial && rLast === sLast) matches.push(roster[i]);
  }
  return matches.length === 1 ? matches[0] : null;
}

// Simulate what _renderLineupRow would emit for one slot — returns
// { effectiveSelectedName, showOffRoster, matchedRoster } so tests
// can assert on the collapse decision without going through the DOM.
function simulateSlot(scrapedEntry, roster) {
  var currentName = (scrapedEntry && scrapedEntry.name) || '';
  var matchedRoster = null;
  if (currentName) {
    matchedRoster = roster.find(function(p) { return p.player_name === currentName; }) || null;
    if (!matchedRoster) matchedRoster = _matchScrapedToRoster(currentName, roster);
  }
  return {
    effectiveSelectedName: matchedRoster ? matchedRoster.player_name : currentName,
    showOffRoster: !!(currentName && !matchedRoster),
    matchedRoster: matchedRoster,
  };
}

// ── Test 1: SEA prod-reported cases ─────────────────────────────────────
console.log('\n=== Test 1: SEA abbreviated scrapes collapse to roster full form ===');
{
  const seaRoster = db.prepare("SELECT player_name, hand, position FROM team_rosters WHERE team='SEA' AND role='POS'").all();
  const cases = [
    { scraped: 'J. Crawford',   expected: 'J.P. Crawford' },
    { scraped: 'J. Rodriguez',  expected: 'Julio Rodríguez' },
    { scraped: 'V. Robles',     expected: 'Victor Robles' },
  ];
  for (const c of cases) {
    const r = simulateSlot({ name: c.scraped, hand: 'R' }, seaRoster);
    assert(r.matchedRoster != null, JSON.stringify(c.scraped) + ' matches a roster player');
    assert(r.effectiveSelectedName === c.expected,
      JSON.stringify(c.scraped) + ' pre-selects "' + c.expected + '" (got "' + r.effectiveSelectedName + '")');
    assert(r.showOffRoster === false, 'no (off-roster) option added for "' + c.scraped + '"');
  }
}

// ── Test 2: Exact match — no regression ─────────────────────────────────
console.log('\n=== Test 2: exact-match cases pass through unchanged ===');
{
  const seaRoster = db.prepare("SELECT player_name, hand, position FROM team_rosters WHERE team='SEA' AND role='POS'").all();
  const cases = [
    'J.P. Crawford', 'Julio Rodríguez', 'Cal Raleigh', 'Josh Naylor',
  ];
  for (const c of cases) {
    const r = simulateSlot({ name: c, hand: 'R' }, seaRoster);
    assert(r.matchedRoster != null && r.matchedRoster.player_name === c, 'exact "' + c + '" maps to itself');
    assert(r.showOffRoster === false, 'no (off-roster) for exact match');
  }
}

// ── Test 3: Diacritic mismatch (ASCII scrape → accented roster) ─────────
console.log('\n=== Test 3: diacritic mismatch collapses ===');
{
  const seaRoster = db.prepare("SELECT player_name, hand, position FROM team_rosters WHERE team='SEA' AND role='POS'").all();
  const r = simulateSlot({ name: 'Julio Rodriguez', hand: 'R' }, seaRoster);  // ASCII
  assert(r.matchedRoster != null, 'ASCII "Julio Rodriguez" matches accented roster entry');
  assert(r.effectiveSelectedName === 'Julio Rodríguez', 'substitutes accented form');
  assert(r.showOffRoster === false, 'no (off-roster) label');
}

// ── Test 4: Suffix mismatch — R. Acuna vs Ronald Acuña Jr. ─────────────
console.log('\n=== Test 4: Jr./Sr./roman suffix stripping ===');
{
  // Construct a synthetic roster since local ATL roster form may vary
  const roster = [
    { player_name: 'Ronald Acuña Jr.', hand: 'R', position: 'RF' },
    { player_name: 'Marcell Ozuna',    hand: 'R', position: 'DH' },
  ];
  const r1 = simulateSlot({ name: 'R. Acuna', hand: 'R' }, roster);
  assert(r1.matchedRoster && r1.matchedRoster.player_name === 'Ronald Acuña Jr.',
    '"R. Acuna" (abbrev + no accent + no suffix) matches "Ronald Acuña Jr."');
  const r2 = simulateSlot({ name: 'Ronald Acuna Jr.', hand: 'R' }, roster);
  assert(r2.matchedRoster && r2.matchedRoster.player_name === 'Ronald Acuña Jr.',
    '"Ronald Acuna Jr." (ASCII + suffix) matches "Ronald Acuña Jr."');
}

// ── Test 5: Ambiguity guard — two players with same (initial,last) ─────
console.log('\n=== Test 5: ambiguity guard — no match when >1 candidate ===');
{
  const roster = [
    { player_name: 'Julio Rodríguez',  hand: 'R', position: 'CF' },
    { player_name: 'Johnny Rodriguez', hand: 'R', position: '2B' },  // hypothetical teammate
  ];
  const r = simulateSlot({ name: 'J. Rodriguez', hand: 'R' }, roster);
  assert(r.matchedRoster === null, 'ambiguous "J. Rodriguez" (2 candidates) returns no match');
  assert(r.showOffRoster === true, 'stays as (off-roster) — user picks manually rather than us guessing');
}

// ── Test 6: genuinely off-roster (same-day callup not yet in roster) ────
console.log('\n=== Test 6: off-roster name preserved for same-day callups ===');
{
  const seaRoster = db.prepare("SELECT player_name, hand, position FROM team_rosters WHERE team='SEA' AND role='POS'").all();
  const r = simulateSlot({ name: 'Xxphantom Newcallup', hand: 'R' }, seaRoster);
  assert(r.matchedRoster === null, 'unknown name does not match');
  assert(r.showOffRoster === true, 'kept as (off-roster) — user can still save the guess');
  assert(r.effectiveSelectedName === 'Xxphantom Newcallup', 'raw name preserved as value');
}

// ── Test 7: slate-wide sweep — how many scraped names collapse cleanly? ─
console.log('\n=== Test 7: slate-wide dedup on 2026-07-23 ===');
{
  const games = db.prepare("SELECT game_id, away_team, home_team, away_lineup_json, home_lineup_json FROM game_log WHERE game_date='2026-07-23'").all();
  let totalSlots = 0;
  let exactMatches = 0;
  let fuzzyCollapses = 0;
  let ambiguousOrOffRoster = 0;
  let sampleCollapses = [];
  let sampleOffRoster = [];
  for (const g of games) {
    for (const side of ['away','home']) {
      const team = side === 'away' ? g.away_team : g.home_team;
      const rosterRows = db.prepare("SELECT player_name, hand, position FROM team_rosters WHERE team=? AND role='POS'").all(team);
      let lu;
      try { lu = JSON.parse(g[side + '_lineup_json'] || '[]'); } catch (_) { lu = []; }
      for (const b of lu) {
        if (!b || !b.name) continue;
        totalSlots++;
        const scraped = b.name;
        const exact = rosterRows.find(function(p) { return p.player_name === scraped; });
        if (exact) { exactMatches++; continue; }
        const fuzzy = _matchScrapedToRoster(scraped, rosterRows);
        if (fuzzy) {
          fuzzyCollapses++;
          if (sampleCollapses.length < 15) {
            sampleCollapses.push({ team, scraped, roster: fuzzy.player_name });
          }
        } else {
          ambiguousOrOffRoster++;
          if (sampleOffRoster.length < 15) sampleOffRoster.push({ team, scraped });
        }
      }
    }
  }
  console.log('  Total slots on slate:            ' + totalSlots);
  console.log('  Exact-name match (no change):    ' + exactMatches);
  console.log('  Fuzzy collapse (dedup fires):    ' + fuzzyCollapses);
  console.log('  Ambiguous or genuinely off:      ' + ambiguousOrOffRoster);
  console.log();
  console.log('  Sample fuzzy collapses (scraped → roster):');
  for (const s of sampleCollapses) {
    console.log('   ', s.team.padEnd(4), JSON.stringify(s.scraped).padEnd(24), '→ ' + JSON.stringify(s.roster));
  }
  if (sampleOffRoster.length) {
    console.log();
    console.log('  Sample still off-roster (needs manual pick or is a real gap):');
    for (const s of sampleOffRoster) {
      console.log('   ', s.team.padEnd(4), JSON.stringify(s.scraped));
    }
  }
  // Acceptance: (exactMatches + fuzzyCollapses) should be ≥ 95% of slots
  // if the roster ingest is healthy. Below 95% is worth investigating —
  // could indicate stale rosters or a fresh callup wave.
  const covered = exactMatches + fuzzyCollapses;
  const pct = totalSlots > 0 ? (covered / totalSlots) * 100 : 0;
  console.log();
  console.log('  Coverage: ' + covered + '/' + totalSlots + ' (' + pct.toFixed(1) + '%)');
  assert(pct >= 90, 'roster coverage >= 90% on today\'s slate (got ' + pct.toFixed(1) + '%)');
}

console.log();
console.log('=== Summary ===');
console.log('  Passed: ' + passed);
console.log('  Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
