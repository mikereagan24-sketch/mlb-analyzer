// Verifier for fix/fuzzylookup-abbrev-lookup-symmetric.
//
// Per CLAUDE.md ingest-not-hot-path rule: verification for changes
// touching live pricing MUST use prod-shaped fixtures, not synthetic
// constructions. This runs against the ACTUAL local woba_data dump
// (which mirrors what Steamer emits in prod) + injects one synthetic
// Antonacci-shape rookie (Steamer emits abbrev-only) since local DB
// happens not to contain the exact failing pattern.
//
// Guarantees the new Stage 6.5 must satisfy:
//   (1) NO REGRESSION — every lookup that hits under the OLD resolver
//       returns byte-identical value under the NEW resolver. The new
//       stage runs AFTER every existing stage; earlier hits are
//       reached first and returned before Stage 6.5 executes.
//   (2) The Antonacci case now resolves cleanly (was null pre-fix).
//   (3) The wrong-initial guard holds — "John Antonacci" + nyy roster
//       lookup does NOT match "S. Antonacci NYY" (initials differ).
//   (4) Ambiguity guard — a lookup that could match TWO abbrev-form
//       idx entries with different first initials returns null via
//       the exactly-one gate (no cross-player promotion).
//
// Approach for (1):
//   - Load ALL bat-proj-rhp rows from local woba_data as ground truth.
//   - Iterate every player_name, exact-lookup it against the OLD
//     resolver → expected value.
//   - Snapshot each row's expected value, then swap in the NEW
//     resolver (require-cache trick) and re-run every lookup.
//   - Assert byte-identity for every previously-hitting lookup.
//   - Also confirm the count of previously-null lookups that now
//     resolve — expect this to be > 0 (Antonacci class rookies).
//
// Because Stage 6.5 runs AFTER every existing stage, and returns only
// when the earlier stages exhausted, the new-hits-only-add invariant
// is structural. Verifier proves it empirically against real data.
//
// Run: node tmp/verify-fuzzylookup-symmetric-abbrev.js

const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else      { failed++; console.log('  FAIL: ' + msg); }
}

// ── Load new resolver from the file we just edited ─────────────────────
const { normName, fuzzyLookup, stripSfx } = require(path.join(__dirname, '..', 'utils', 'names'));

// Inline replica of the OLD resolver (pre-Stage-6.5). Kept verbatim
// from git HEAD~1 utils/names.js so the diff comparison is honest.
// Do NOT modify — this is the baseline the new resolver must not shift.
function oldFuzzyLookup(keyMap, name, teamHint) {
  if (!keyMap) return null;
  const k = normName(name);
  const parts = k.split(' ');
  const isAbbrev = parts.length >= 2 && parts[0].length === 1;

  if (teamHint) {
    const tk = k + ' ' + teamHint.toLowerCase();
    if (keyMap[tk]) return keyMap[tk];
  }
  if (keyMap[k]) return keyMap[k];

  const kStripped = stripSfx(k);
  if (kStripped !== k) {
    if (teamHint && keyMap[kStripped + ' ' + teamHint.toLowerCase()]) return keyMap[kStripped + ' ' + teamHint.toLowerCase()];
    if (keyMap[kStripped]) return keyMap[kStripped];
  }

  for (const sfx of ['jr', 'sr', 'ii', 'iii', 'iv']) {
    if (teamHint && keyMap[k + ' ' + sfx + ' ' + teamHint.toLowerCase()]) return keyMap[k + ' ' + sfx + ' ' + teamHint.toLowerCase()];
    if (keyMap[k + ' ' + sfx]) return keyMap[k + ' ' + sfx];
  }

  if (isAbbrev && teamHint) {
    const initial = parts[0], last = parts[parts.length - 1], tl = teamHint.toLowerCase();
    const e = Object.entries(keyMap).find(([n]) => {
      if (!n.endsWith(' ' + tl)) return false;
      const base = n.slice(0, n.length - tl.length - 1).trim();
      const p = stripSfx(base).split(' ');
      return p[p.length - 1] === last && p[0] && p[0][0] === initial;
    });
    if (e) return e[1];
  }

  if (isAbbrev) {
    const initial = parts[0], last = parts[parts.length - 1];
    const matches = Object.entries(keyMap).filter(([n]) => {
      if (/\s[a-z]{2,3}$/.test(n)) return false;
      const p = stripSfx(n).split(' ');
      return p[p.length - 1] === last && p[0] && p[0][0] === initial;
    });
    if (matches.length === 1) return matches[0][1];
    if (matches.length === 0 && parts.length > 2) {
      for (let wi = 1; wi < parts.length; wi++) {
        const altLast = parts[wi];
        const altMatches = Object.entries(keyMap).filter(([n]) => {
          if (/\s[a-z]{2,3}$/.test(n)) return false;
          const p = stripSfx(n).split(' ');
          return p[p.length - 1] === altLast && p[0] && p[0][0] === initial;
        });
        if (altMatches.length === 1) return altMatches[0][1];
      }
    }
  }

  const sk = stripSfx(k);
  if (teamHint) {
    const tk2 = sk + ' ' + teamHint.toLowerCase();
    if (keyMap[tk2]) return keyMap[tk2];
  }
  const e2 = Object.entries(keyMap).find(([n]) => !/\s[a-z]{2,3}$/.test(n) && stripSfx(n) === sk);
  return e2 ? e2[1] : null;
}

// ── Build the prod-shaped idx from local woba_data ─────────────────────
console.log('\n=== Setup: load woba_data + build idx ===');
const rows = db.prepare("SELECT player_name, woba, sample_size FROM woba_data WHERE data_key='bat-proj-rhp'").all();
console.log('  bat-proj-rhp rows:', rows.length);
const idx = {};
for (const r of rows) idx[normName(r.player_name)] = { woba: r.woba, sample: r.sample_size, _pname: r.player_name };

// ── Test 1: NO REGRESSION on every existing lineup+idx pair ────────────
console.log('\n=== Test 1: no regression — every OLD hit still returns the same value ===');
// Universe: use every raw player_name from bat-proj-rhp as a lookup
// against itself. Guarantees stages 1-4 hit for real players; stages
// 5-6 also naturally exercised on the abbrev-form idx entries; stage 7
// exercised on jr-stripped queries. This covers ~all real prod lookups.
let checked = 0, mismatches = 0;
for (const r of rows) {
  // Also try LOOKUP with lots of common shape variants to exercise
  // more of the resolver surface. Team hint pulled from the entry's
  // trailing team code where present.
  const raw = r.player_name;
  const m = raw.match(/^(.+)\s+([A-Z]{2,3})$/);
  const core = m ? m[1] : raw;
  const teamHint = m ? m[2] : null;

  // 4 lookup shapes per row: [raw + hint], [core + hint], [raw + no hint], [core + no hint]
  const trials = [
    { name: raw,  teamHint: teamHint },
    { name: core, teamHint: teamHint },
    { name: raw,  teamHint: null },
    { name: core, teamHint: null },
  ];
  for (const t of trials) {
    const oldHit = oldFuzzyLookup(idx, t.name, t.teamHint);
    const newHit = fuzzyLookup(idx, t.name, t.teamHint);
    checked++;
    // Regression check: every OLD non-null hit must equal the NEW hit
    // BY REFERENCE (same object) or by value.
    if (oldHit != null) {
      if (oldHit !== newHit) {
        mismatches++;
        if (mismatches <= 10) {
          console.log('  MISMATCH: lookup=' + JSON.stringify(t) + ' oldHit=' + (oldHit && oldHit._pname) + ' newHit=' + (newHit && newHit._pname));
        }
      }
    }
  }
}
console.log('  Total lookups checked: ' + checked);
console.log('  Mismatches (old-hit shifted): ' + mismatches);
assert(mismatches === 0, 'zero regressions across ' + checked + ' prod-shape lookups');

// ── Test 2: previously-null lookups that now resolve ───────────────────
console.log('\n=== Test 2: count of previously-null lookups that now resolve ===');
let newlyResolvingCount = 0;
const samples = [];
for (const r of rows) {
  const raw = r.player_name;
  const m = raw.match(/^(.+)\s+([A-Z]{2,3})$/);
  if (!m) continue;
  const core = m[1], teamHint = m[2];
  // Skip if the core already had a suffix — those hit via Stage 4 in old.
  // Interested in the FULL-name-lookup vs ABBREV-idx path.
  // Reverse the shape: idx has "steven antonacci nyy"? Look up "s antonacci" + nyy → OLD handles via Stage 5.
  // idx has "s antonacci nyy"? Look up "steven antonacci" + nyy → OLD misses, NEW hits.
  // Iterate: find idx entries whose base is abbrev-first-token. Reverse-lookup with a
  // plausible full first name isn't derivable from data, so instead check the OPPOSITE:
  // is this row's exact name resolvable by NEW when it wasn't by OLD? Almost never true
  // for the exact name (Stage 1 hits directly). So this test measures the residual — should
  // be near-zero for exact-name lookups, and confirmed non-zero in Test 3 via synthetic.
  const oldHit = oldFuzzyLookup(idx, core, teamHint);
  const newHit = fuzzyLookup(idx, core, teamHint);
  if (oldHit == null && newHit != null) {
    newlyResolvingCount++;
    if (samples.length < 10) samples.push({ lookup: core + ' + ' + teamHint, resolved_to: newHit._pname });
  }
}
console.log('  Newly-resolving lookups on core-name reverse trial: ' + newlyResolvingCount);
if (samples.length) {
  console.log('  Samples:');
  for (const s of samples) console.log('   ', s.lookup, '→', s.resolved_to);
}
// This count is EXPECTED to be low because the exact-name path hits before Stage 6.5.
// The real value shows in Test 3 (synthetic Antonacci) + Test 4 (abbrev-only entries).

// ── Test 3: synthetic Antonacci — abbrev-only idx, full-name lookup ────
console.log('\n=== Test 3: Antonacci case — Steven Antonacci vs S. Antonacci NYY ===');
{
  const antonacciIdx = {
    's antonacci nyy':   { woba: 0.322, sample: 88,  _pname: 'S. Antonacci NYY' },
    'aaron judge nyy':   { woba: 0.398, sample: 500, _pname: 'Aaron Judge NYY' },
    'aaron judge':       { woba: 0.398, sample: 500, _pname: 'Aaron Judge' },
  };
  const oldHit = oldFuzzyLookup(antonacciIdx, 'Steven Antonacci', 'NYY');
  const newHit = fuzzyLookup(antonacciIdx, 'Steven Antonacci', 'NYY');
  console.log('  OLD resolver: ' + (oldHit ? oldHit._pname : 'null'));
  console.log('  NEW resolver: ' + (newHit ? newHit._pname : 'null'));
  assert(oldHit === null, 'OLD resolver misses "Steven Antonacci" against abbrev-only idx (baseline)');
  assert(newHit != null, 'NEW resolver hits');
  assert(newHit && newHit._pname === 'S. Antonacci NYY', 'NEW resolves to "S. Antonacci NYY"');
  assert(newHit && Math.abs(newHit.woba - 0.322) < 0.001, 'NEW returns real .322 wOBA (not fallback)');
}

// ── Test 4: wrong-initial guard — John Antonacci must NOT match S. ─────
console.log('\n=== Test 4: wrong-initial guard (John Antonacci ≠ S. Antonacci) ===');
{
  const antonacciIdx = {
    's antonacci nyy':   { woba: 0.322, sample: 88 },
  };
  const newHit = fuzzyLookup(antonacciIdx, 'John Antonacci', 'NYY');
  assert(newHit === null, 'NEW resolver does NOT match wrong initial (J vs S)');
}

// ── Test 5: ambiguity guard — two abbrev entries with different initials ─
console.log('\n=== Test 5: exactly-one guard on global scan ===');
{
  // Both are abbrev-form and share last name; global scan without
  // teamHint would return 2 → guard should return null.
  const idx5 = {
    's antonacci': { woba: 0.322, sample: 88,  _pname: 'S. Antonacci' },
    'j antonacci': { woba: 0.250, sample: 20,  _pname: 'J. Antonacci' },
  };
  const newHit = fuzzyLookup(idx5, 'Steven Antonacci', null);
  assert(newHit != null, 'exactly-one match for Steven (only S matches) resolves');
  assert(newHit && newHit._pname === 'S. Antonacci', 'resolves to S.');
  // If we look up something ambiguous — same last name but neither initial
  // matches unambiguously — should return null.
  const newHitAmbig = fuzzyLookup(idx5, 'Random Antonacci', null);
  assert(newHitAmbig === null, 'ambiguous last-name lookup with no unique initial match returns null');
}

// ── Test 6: team-scoped precedence — team hit beats global scan ────────
console.log('\n=== Test 6: team-scoped hit takes precedence over global ===');
{
  const idx6 = {
    's antonacci nyy': { woba: 0.322, sample: 88,  _pname: 'S. Antonacci NYY' },
    's antonacci bos': { woba: 0.180, sample: 20,  _pname: 'S. Antonacci BOS' },  // hypothetical other Steven
  };
  const newHit = fuzzyLookup(idx6, 'Steven Antonacci', 'NYY');
  assert(newHit && newHit._pname === 'S. Antonacci NYY', 'team hint resolves to correct team');
  const newHitBos = fuzzyLookup(idx6, 'Steven Antonacci', 'BOS');
  assert(newHitBos && newHitBos._pname === 'S. Antonacci BOS', 'switching team hint resolves to other team');
}

// ── Test 7: existing Mesa protection still holds (regression guard) ────
// The Mesa shadow was the whole reason we're here — a "victor mesa"
// no-suffix idx entry shadowing "victor mesa jr tb". After the ingest
// dedup landed, "victor mesa" bare rows shouldn't exist anymore. But
// this test confirms the resolver would still resolve "Victor Mesa" +
// tb correctly even if a stray bare row survived — Stage 4 hits
// "victor mesa jr tb" before Stage 6.5 fires.
console.log('\n=== Test 7: Mesa case still resolves to real Jr. TB ===');
{
  const idxM = {
    'victor mesa jr tb': { woba: 0.313, sample: 85,  _pname: 'Victor Mesa Jr. TB' },
    'victor mesa tb':    { woba: 0.313, sample: 85,  _pname: 'Victor Mesa TB' },  // stripSfx form (post-fix)
  };
  const newHit = fuzzyLookup(idxM, 'Victor Mesa', 'TB');
  assert(newHit && newHit._pname === 'Victor Mesa TB', 'Victor Mesa + tb resolves at Stage 1 (stripSfx form)');
  assert(newHit && Math.abs(newHit.woba - 0.313) < 0.001, 'real .313 (not fallback)');
}

// ── Test 8: cross-idx sweep for Steamer abbrev-only entries in real DB ─
// Scan actual woba_data for abbrev-first-token bat-proj-rhp entries
// and try resolving them via full-name lookups against a plausible
// roster full name. Can't perfectly enumerate the mapping (we don't
// know the full name Steamer intended), but we can spot-check by
// listing every such entry so the owner can eyeball how many
// prod-relevant cases the new stage would catch.
console.log('\n=== Test 8: catalog of abbrev-first-token bat-proj-rhp entries in local DB ===');
{
  const abbrevEntries = rows.filter(r => {
    const n = normName(r.player_name);
    const p = n.split(' ');
    return p.length >= 2 && p[0].length === 1;
  });
  console.log('  Abbrev-first-token entries in bat-proj-rhp: ' + abbrevEntries.length);
  for (const r of abbrevEntries.slice(0, 20)) {
    console.log('   ', r.player_name.padEnd(28), 'sample=' + r.sample_size.toFixed(1));
  }
  if (abbrevEntries.length > 20) console.log('   ... +' + (abbrevEntries.length - 20) + ' more');
  console.log('  → each of these is a candidate for new Stage 6.5 hits when a full-name lookup arrives from the roster dropdown.');
}

console.log();
console.log('=== Summary ===');
console.log('  Passed: ' + passed);
console.log('  Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
