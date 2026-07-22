// Audit tool for services/weather.js PARKS.cfDir — enumerates every
// park's current home-plate-to-CF bearing and flags entries that look
// like unverified placeholders (the default 45° that shipped for parks
// where no bearing survey was done).
//
// Output columns:
//   team key, park name, current cfDir, sensitivity, flag
//
// Flags:
//   [PLACEHOLDER 45°] — cfDir == 45 exactly. Likely unverified default.
//   [SUSPICIOUS]      — cfDir differs materially from a well-documented
//                       public value (currently just Wrigley 60° vs
//                       ~33° documented; extendable as we verify others).
//   [OK]              — matches a documented public value at time of
//                       last audit (currently just Fenway 75° and
//                       Oracle 90°, which agree with public survey data).
//   [UNAUDITED]       — non-45° but not on our known-good list either;
//                       needs verification.
//
// Run: node tmp/audit-park-cf-bearings.js

const path = require('path');
const { PARKS } = require(path.join(__dirname, '..', 'services', 'weather.js'));

// Parks whose current cfDir has been cross-checked against a public
// authoritative source (Wikipedia infobox "orientation" field, or
// ballparks.com survey diagrams). Update this as we verify more.
const KNOWN_GOOD = {
  bos: { cfDir: 75, source: 'Wikipedia infobox — Fenway Park orientation' },
  sfg: { cfDir: 90, source: 'Wikipedia infobox — Oracle Park (east-facing toward SF Bay)' },
  chc: { cfDir: 33, source: 'Wikipedia infobox — Wrigley Field (NNE-facing; corrected 2026-07-22)' },
};

// Known-off values still to correct. Empty after Wrigley fix; new
// entries land here when future audits catch discrepancies.
const KNOWN_WRONG = {};

const rows = [];
for (const [key, p] of Object.entries(PARKS)) {
  let flag;
  if (KNOWN_WRONG[key] && p.cfDir === KNOWN_WRONG[key].current) {
    flag = '[SUSPICIOUS] want ' + KNOWN_WRONG[key].proposed + '° — ' + KNOWN_WRONG[key].source;
  } else if (KNOWN_GOOD[key] && p.cfDir === KNOWN_GOOD[key].cfDir) {
    flag = '[OK] verified — ' + KNOWN_GOOD[key].source;
  } else if (p.cfDir === 45) {
    flag = '[PLACEHOLDER 45°] — default value from initial scaffold; needs verification';
  } else {
    flag = '[UNAUDITED] — non-default value but not on known-good list';
  }
  rows.push({ key, name: p.name, cfDir: p.cfDir, sens: p.sens, flag });
}

// Sort: placeholders first, then suspicious, then unaudited, then OK.
const order = { '[SUSPICIOUS]': 0, '[PLACEHOLDER 45°]': 1, '[UNAUDITED]': 2, '[OK]': 3 };
rows.sort((a, b) => {
  const ka = order[a.flag.split(' ')[0]] ?? 9;
  const kb = order[b.flag.split(' ')[0]] ?? 9;
  if (ka !== kb) return ka - kb;
  // Within a group, sort by sensitivity descending — audit the
  // wind-sensitive parks first (Wrigley sens=2.0 is the highest-leverage
  // fix; sens=0.1 domes are the lowest).
  return b.sens - a.sens;
});

const sumByFlag = {};
for (const r of rows) {
  const k = r.flag.split(' ')[0];
  sumByFlag[k] = (sumByFlag[k] || 0) + 1;
}

console.log('\n=== PARKS.cfDir audit ===');
console.log('Total parks: ' + rows.length);
for (const [k, n] of Object.entries(sumByFlag)) console.log('  ' + k.padEnd(20) + ' ' + n);
console.log();

console.log('key   park                       cfDir  sens   flag');
console.log('---   ------------------------   -----  ----   ' + '-'.repeat(60));
for (const r of rows) {
  console.log(
    r.key.padEnd(6)
    + r.name.padEnd(27)
    + String(r.cfDir).padStart(5) + '°'
    + '   ' + r.sens.toFixed(1).padStart(4)
    + '   ' + r.flag
  );
}
console.log();
console.log('Next steps:');
console.log('  1. [SUSPICIOUS] entries are actionable now with high confidence — see docs/park-bearings-audit.md.');
console.log('  2. [PLACEHOLDER 45°] entries need per-park verification against Wikipedia infobox / ballparks.com / OSM.');
console.log('     Prioritize by sens (higher = more wind-leverage). Wrigley sens=2.0 was #1 (fixed here);');
console.log('     the next tier is Fenway (1.5, already verified), Citizens Bank (1.5), Comerica/Progressive/');
console.log('     Kauffman/PNC/OAK (1.0-1.3).');
console.log('  3. [UNAUDITED] entries are non-45° but not verified — spot-check.');
console.log();
