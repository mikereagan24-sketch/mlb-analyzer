'use strict';
// Verify the escalating freshness tiers by simulating the /health block
// against the current mlb.db AND against synthetic ages that force each
// tier to fire. Standalone repro of the exact server.js logic.

const path = require('path');
const Database = require(path.join('C:', 'Users', 'Mike Reagan', 'mlb-analyzer', 'mlb-analyzer', 'node_modules', 'better-sqlite3'));
const db = new Database(path.join('C:', 'Users', 'Mike Reagan', 'mlb-analyzer', 'mlb-analyzer', 'data', 'mlb.db'), { readonly: true });

const EXPECTED_KEYS = [
  'bat-proj-lhp', 'bat-proj-rhp', 'pit-proj-lhb', 'pit-proj-rhb',
  'bat-act-lhp',  'bat-act-rhp',  'pit-act-lhb',  'pit-act-rhb',
];
const WARN_HOURS = 30;
const CRITICAL_HOURS = 72;

function classify(rows) {
  const byKey = {};
  for (const r of rows) byKey[r.data_key] = r;
  const now = Date.now();
  const per_key = {};
  const missing_keys = [];
  const stale_keys = [];
  const critical_keys = [];
  for (const k of EXPECTED_KEYS) {
    const r = byKey[k];
    if (!r) { missing_keys.push(k); per_key[k] = { present: false }; continue; }
    const uploadedMs = r.uploaded_at ? (Date.parse(r.uploaded_at + 'Z') || Date.parse(r.uploaded_at)) : null;
    const age_hours = uploadedMs ? Math.round((now - uploadedMs) / 3600000 * 10) / 10 : null;
    per_key[k] = { present: true, rows: r.row_count, uploaded_at: r.uploaded_at, age_hours };
    if (age_hours == null) continue;
    if (age_hours > CRITICAL_HOURS)      critical_keys.push({ key: k, age_hours });
    else if (age_hours > WARN_HOURS)     stale_keys.push({ key: k, age_hours });
  }
  const isCritical = missing_keys.length > 0 || critical_keys.length > 0;
  const isDegraded = stale_keys.length > 0;
  let status = 'ok';
  if (isCritical) status = 'critical';
  else if (isDegraded) status = 'degraded';
  return { status, missing_keys, stale_keys, critical_keys, per_key };
}

console.log('== TIER 1: live mlb.db state ==');
const live = db.prepare('SELECT data_key, MAX(uploaded_at) as uploaded_at, COUNT(*) as row_count FROM woba_data GROUP BY data_key').all();
const result = classify(live);
console.log('  status: ' + result.status);
for (const k of EXPECTED_KEYS) {
  const p = result.per_key[k];
  console.log('  ' + k.padEnd(15) + '  age=' + (p.age_hours != null ? String(p.age_hours).padStart(5) + 'h' : ' n/a') + '  present=' + p.present);
}
console.log('  stale (>30h):    ' + JSON.stringify(result.stale_keys));
console.log('  critical (>72h): ' + JSON.stringify(result.critical_keys));

console.log('\n== TIER 2: synthetic — all 4 actuals at 48h (WARN band) ==');
const now = new Date();
const stale48h = new Date(now.getTime() - 48 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
const proj0h  = new Date(now.getTime() - 1 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
const synth1 = EXPECTED_KEYS.map(k => ({
  data_key: k,
  row_count: 100,
  uploaded_at: k.includes('-act-') ? stale48h : proj0h,
}));
const r1 = classify(synth1);
console.log('  status: ' + r1.status);
console.log('  stale: ' + r1.stale_keys.map(s => s.key + '=' + s.age_hours + 'h').join(', '));
console.log('  critical: ' + (r1.critical_keys.length ? r1.critical_keys.map(s => s.key + '=' + s.age_hours + 'h').join(', ') : 'none'));

console.log('\n== TIER 3: synthetic — all 4 actuals at 96h (CRITICAL band) ==');
const stale96h = new Date(now.getTime() - 96 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
const synth2 = EXPECTED_KEYS.map(k => ({
  data_key: k,
  row_count: 100,
  uploaded_at: k.includes('-act-') ? stale96h : proj0h,
}));
const r2 = classify(synth2);
console.log('  status: ' + r2.status);
console.log('  stale: ' + (r2.stale_keys.length ? r2.stale_keys.map(s => s.key + '=' + s.age_hours + 'h').join(', ') : 'none'));
console.log('  critical: ' + r2.critical_keys.map(s => s.key + '=' + s.age_hours + 'h').join(', '));

console.log('\n== TIER 4: synthetic — 2 actuals MISSING entirely ==');
const synth3 = EXPECTED_KEYS.filter(k => k !== 'bat-act-lhp' && k !== 'pit-act-lhb').map(k => ({
  data_key: k, row_count: 100, uploaded_at: proj0h,
}));
const r3 = classify(synth3);
console.log('  status: ' + r3.status);
console.log('  missing: ' + JSON.stringify(r3.missing_keys));

console.log('\n== TIER 5: synthetic — mixed (2 warn, 2 critical) ==');
const synth4 = EXPECTED_KEYS.map(k => {
  const t = k === 'bat-act-lhp' || k === 'bat-act-rhp' ? stale48h
    : k === 'pit-act-lhb' || k === 'pit-act-rhb' ? stale96h
    : proj0h;
  return { data_key: k, row_count: 100, uploaded_at: t };
});
const r4 = classify(synth4);
console.log('  status: ' + r4.status + '  (should be critical — highest tier wins)');
console.log('  stale (warn): ' + r4.stale_keys.map(s => s.key + '=' + s.age_hours + 'h').join(', '));
console.log('  critical:     ' + r4.critical_keys.map(s => s.key + '=' + s.age_hours + 'h').join(', '));
