// Verifier for fix/woba-ingest-dedup.
//
// Replays the ingest expansion logic against constructed input rows and
// asserts the emitted expandedRows array matches expectations:
//   * Team-tagged Steamer row → ONLY the team-tagged form (no bare
//     shadow row). Fixes the Mesa-class own-ingest fabrication.
//   * Steamer row with trailing Jr./Sr./II/III/IV → ALSO writes the
//     stripped+team form. Fixes the pre-existing regex bug where
//     "Bobby Witt Jr." was skipping the stripped-form branch.
//   * Untagged Steamer row (no team) → bare form only (unchanged).
//   * SHADOW_EXCLUSIONS entries → dropped entirely.
//
// The ingest function itself lives in routes/api.js and pulls in the
// full Express app on require, so we don't require it — we replicate
// the pure expansion logic inline here (kept in lockstep by owner
// review: any change to the ingest expansion in routes/api.js needs
// to be mirrored here or this verifier goes stale).
//
// Run: node tmp/verify-woba-ingest-dedup.js

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else      { failed++; console.log('  FAIL: ' + msg); }
}

// ── Inline replica of the ingest expansion logic (routes/api.js ~205) ──
const SHADOW_EXCLUSIONS = new Set([
  'bat-proj-lhp|Victor Mesa',
  'bat-proj-lhp|Victor Mesa MIA',
  'bat-proj-rhp|Victor Mesa',
  'bat-proj-rhp|Victor Mesa MIA',
  'bat-act-lhp|Victor Mesa',
  'bat-act-lhp|Victor Mesa MIA',
  'bat-act-rhp|Victor Mesa',
  'bat-act-rhp|Victor Mesa MIA',
]);
const SUFFIX_TOKENS = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv']);
function stripSuffixToken(name) {
  const parts = String(name).trim().split(/\s+/);
  while (parts.length > 1 && SUFFIX_TOKENS.has(parts[parts.length - 1].toLowerCase())) {
    parts.pop();
  }
  return parts.join(' ');
}
function expand(key, rows) {
  const expandedRows = [];
  let excluded = 0;
  for (const r of rows) {
    if (SHADOW_EXCLUSIONS.has(key + '|' + r.name)) { excluded++; continue; }
    if (!r.team) { expandedRows.push(r); continue; }
    expandedRows.push({...r, name: r.name+' '+r.team});
    const stripped = stripSuffixToken(r.name);
    if (stripped !== r.name && stripped.length > 0) {
      expandedRows.push({...r, name: stripped+' '+r.team});
    }
  }
  return { rows: expandedRows, excluded };
}

// ── Case 1: Team-tagged player → team-tagged form only, no bare ─────────
console.log('\n=== Case 1: team-tagged player, no bare row ===');
{
  const out = expand('bat-proj-rhp', [{ name: 'Aaron Judge', team: 'NYY', woba: 0.400, sample: 500 }]);
  const names = out.rows.map(r => r.name);
  assert(names.length === 1, 'exactly 1 row emitted, got ' + names.length);
  assert(names[0] === 'Aaron Judge NYY', 'row is name+team, got ' + names[0]);
  assert(!names.includes('Aaron Judge'), 'NO bare "Aaron Judge" row (that was the shadow mechanism)');
}

// ── Case 2: Jr. player → team-tagged AND stripped-team form ─────────────
console.log('\n=== Case 2: Jr. player writes stripped+team row (fixed regex) ===');
{
  const out = expand('bat-proj-rhp', [{ name: 'Bobby Witt Jr.', team: 'KC', woba: 0.360, sample: 500 }]);
  const names = out.rows.map(r => r.name);
  assert(names.length === 2, '2 rows for Jr. player, got ' + names.length);
  assert(names.includes('Bobby Witt Jr. KC'), 'has full name+team "Bobby Witt Jr. KC"');
  assert(names.includes('Bobby Witt KC'), 'has stripped+team "Bobby Witt KC" — pre-fix regex silently dropped this');
  assert(!names.includes('Bobby Witt Jr.'), 'NO bare "Bobby Witt Jr." row');
  assert(!names.includes('Bobby Witt'), 'NO bare "Bobby Witt" row');
}

// ── Case 3: SHADOW_EXCLUSIONS drops the row entirely ────────────────────
console.log('\n=== Case 3: SHADOW_EXCLUSIONS drops both variants ===');
{
  const out = expand('bat-proj-rhp', [
    { name: 'Victor Mesa',     team: 'MIA', woba: 0.238, sample: 0.7 },
    { name: 'Victor Mesa Jr.', team: 'TB',  woba: 0.313, sample: 85  },
  ]);
  const names = out.rows.map(r => r.name);
  assert(out.excluded === 1, 'one row excluded by SHADOW_EXCLUSIONS, got ' + out.excluded);
  assert(!names.includes('Victor Mesa'), 'no bare "Victor Mesa"');
  assert(!names.includes('Victor Mesa MIA'), 'no "Victor Mesa MIA" — SHADOW_EXCLUSIONS dropped it');
  assert(names.includes('Victor Mesa Jr. TB'), 'real "Victor Mesa Jr. TB" present');
  assert(names.includes('Victor Mesa TB'), 'stripped "Victor Mesa TB" present — Stage 1 will hit on lookup "Victor Mesa" + tb');
}

// ── Case 4: Untagged Steamer row (no team) → bare form preserved ────────
console.log('\n=== Case 4: untagged player keeps bare row (free agent) ===');
{
  const out = expand('bat-proj-rhp', [{ name: 'J.D. Martinez', team: null, woba: 0.335, sample: 500 }]);
  const names = out.rows.map(r => r.name);
  assert(names.length === 1, 'exactly 1 row for untagged player');
  assert(names[0] === 'J.D. Martinez', 'bare form preserved for untagged, got ' + names[0]);
}

// ── Case 5: Roman-numeral suffix (II/III/IV) also gets stripped ─────────
console.log('\n=== Case 5: Roman-numeral suffix strips correctly ===');
{
  const out = expand('bat-proj-rhp', [{ name: 'Cedric Mullins II', team: 'BAL', woba: 0.320, sample: 500 }]);
  const names = out.rows.map(r => r.name);
  assert(names.includes('Cedric Mullins II BAL'), 'full name+team "Cedric Mullins II BAL"');
  assert(names.includes('Cedric Mullins BAL'), 'stripped+team "Cedric Mullins BAL"');
}

// ── Case 6: Sr. suffix (mirror of Jr. regex bug) ────────────────────────
console.log('\n=== Case 6: Sr. suffix strips correctly (same class as Jr.) ===');
{
  const out = expand('bat-proj-rhp', [{ name: 'Ken Griffey Sr.', team: 'CIN', woba: 0.310, sample: 500 }]);
  const names = out.rows.map(r => r.name);
  assert(names.includes('Ken Griffey Sr. CIN'), 'full "Ken Griffey Sr. CIN"');
  assert(names.includes('Ken Griffey CIN'), 'stripped "Ken Griffey CIN"');
}

// ── Case 7: Mesa lookup verifies end-to-end via buildWobaIndex ──────────
// Confirms the ingest change resolves the shadow bug via fuzzyLookup
// walking to Stage 1 on "Victor Mesa TB" (from the fixed Jr.-stripped
// path). No roster gate involved — pure ingest fix.
console.log('\n=== Case 7: end-to-end Mesa lookup via buildWobaIndex + fuzzyLookup ===');
{
  const path = require('path');
  const model = require(path.join(__dirname, '..', 'services', 'model'));
  const { normName, fuzzyLookup } = require(path.join(__dirname, '..', 'utils', 'names'));
  // Simulate post-ingest DB rows using the same expansion the ingest does
  const out = expand('bat-proj-rhp', [
    { name: 'Victor Mesa',     team: 'MIA', woba: 0.238, sample: 0.7 },   // shadow — DROPPED by SHADOW_EXCLUSIONS
    { name: 'Victor Mesa Jr.', team: 'TB',  woba: 0.313, sample: 85  },   // real
  ]);
  // Build wobaIdx from the expanded rows the way buildWobaIndex would
  const rows = out.rows.map(r => ({ data_key: 'bat-proj-rhp', player_name: r.name, woba: r.woba, sample_size: r.sample }));
  const idx = model.buildWobaIndex(rows);
  const hit = fuzzyLookup(idx['bat-proj-rhp'], 'Victor Mesa', 'TB');
  assert(hit != null, 'fuzzyLookup finds a hit for "Victor Mesa" + TB');
  assert(hit.woba === 0.313, 'resolves to real Jr. TB .313, got ' + hit.woba);
  assert(hit.sample === 85, 'sample is real 85, got ' + hit.sample);
}

console.log();
console.log('=== Summary ===');
console.log('  Passed: ' + passed);
console.log('  Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
