'use strict';
// Verify /health.woba_freshness against the real local mlb.db.
// Reproduces the same computation the /health handler does, but
// standalone so we can inspect it without booting the server.

const path = require('path');
const Database = require(path.join('C:', 'Users', 'Mike Reagan', 'mlb-analyzer', 'mlb-analyzer', 'node_modules', 'better-sqlite3'));
const db = new Database(path.join('C:', 'Users', 'Mike Reagan', 'mlb-analyzer', 'mlb-analyzer', 'data', 'mlb.db'), { readonly: true });

const EXPECTED_KEYS = [
  'bat-proj-lhp', 'bat-proj-rhp', 'pit-proj-lhb', 'pit-proj-rhb',
  'bat-act-lhp',  'bat-act-rhp',  'pit-act-lhb',  'pit-act-rhb',
];
const STALE_HOURS = 30;
const wobaKeySummary = db.prepare('SELECT data_key, COUNT(*) as row_count, MAX(uploaded_at) as uploaded_at FROM woba_data GROUP BY data_key');
const summary = wobaKeySummary.all();
console.log('== raw wobaKeySummary rows ==');
for (const r of summary) console.log('  ' + r.data_key.padEnd(15) + '  rows=' + String(r.row_count).padStart(5) + '  uploaded_at=' + r.uploaded_at);

const byKey = {};
for (const r of summary) byKey[r.data_key] = r;
const now = Date.now();
const per_key = {};
const missing_keys = [];
const stale_keys = [];
for (const k of EXPECTED_KEYS) {
  const r = byKey[k];
  if (!r) { missing_keys.push(k); per_key[k] = { present: false }; continue; }
  const uploadedMs = r.uploaded_at ? (Date.parse(r.uploaded_at + 'Z') || Date.parse(r.uploaded_at)) : null;
  const age_hours = uploadedMs ? Math.round((now - uploadedMs) / 3600000 * 10) / 10 : null;
  per_key[k] = { present: true, rows: r.row_count, uploaded_at: r.uploaded_at, age_hours };
  if (age_hours != null && age_hours > STALE_HOURS) stale_keys.push({ key: k, age_hours });
}
console.log('\n== simulated /health.woba_freshness ==');
console.log(JSON.stringify({
  expected: EXPECTED_KEYS.length,
  present: EXPECTED_KEYS.length - missing_keys.length,
  stale_threshold_hours: STALE_HOURS,
  missing_keys,
  stale_keys,
  per_key,
}, null, 2));

const wouldDegrade = missing_keys.length || stale_keys.length;
console.log('\nstatus would be: ' + (wouldDegrade ? 'DEGRADED' : 'ok'));
if (wouldDegrade) {
  console.log('reason: ' + (missing_keys.length ? missing_keys.length + ' missing key(s)' : '')
    + (missing_keys.length && stale_keys.length ? ', ' : '')
    + (stale_keys.length ? stale_keys.length + ' stale key(s) (>' + STALE_HOURS + 'h)' : ''));
}
