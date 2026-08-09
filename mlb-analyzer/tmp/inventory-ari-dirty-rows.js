'use strict';
// Inventory of ARI home games to size the "27 dirty rows" and understand
// what fix is needed row-by-row. Groups by contamination state + existing
// tag + roof-vs-weather consistency.

const { db } = require('../db/schema');

const rows = db.prepare(
  "SELECT game_date, game_id, venue_id, game_pk, "
  + "  roof_status, roof_confidence, "
  + "  wind_speed, wind_dir, wind_factor, temp_f, temp_run_adj, "
  + "  weather_contamination_reason, weather_quality "
  + "FROM game_log "
  + "WHERE venue_id = 15 AND game_pk IS NOT NULL "
  + "  AND game_date >= '2026-03-01' AND game_date <= date('now') "
  + "ORDER BY game_date"
).all();

console.log('ARI (venue 15) rows since 2026-03-01 through today: ' + rows.length);

// Bucket by state.
const buckets = {
  closed_actual_zero:        [],  // roof=closed/actual AND wf=0 AND tra=0 — clean
  closed_actual_dirty:       [],  // roof=closed/actual AND (wf!=0 OR tra!=0) — the 7-of-23
  closed_announced:          [],  // roof=closed/announced — scraper-flipped, may have any weather
  open_estimated:            [],  // roof=open/estimated (default) with any weather signal — bug case
  other_roof_state:          [],  // partial or unusual
  no_raw_weather:            [],  // wind_speed / wind_dir / temp_f NULL — can't recompute
  already_tagged:            [],  // weather_contamination_reason IS NOT NULL
};

function isDirty(r) {
  // A "dirty" row = weather signals non-zero AND roof state suggests they should be 0.
  // For sealed ARI (venue 15): closed roof → wf/tra should be 0.
  const wfNonZero = r.wind_factor != null && r.wind_factor !== 0;
  const traNonZero = r.temp_run_adj != null && r.temp_run_adj !== 0;
  return (wfNonZero || traNonZero);
}

for (const r of rows) {
  if (r.weather_contamination_reason) { buckets.already_tagged.push(r); continue; }
  const hasRaw = r.wind_speed != null && r.wind_dir != null && r.temp_f != null;
  if (!hasRaw) { buckets.no_raw_weather.push(r); continue; }
  const roof = (r.roof_status || '').toLowerCase();
  const conf = r.roof_confidence || '';
  if (roof === 'closed' && conf === 'actual') {
    if (isDirty(r)) buckets.closed_actual_dirty.push(r);
    else buckets.closed_actual_zero.push(r);
  } else if (roof === 'closed' && conf === 'announced') {
    buckets.closed_announced.push(r);
  } else if (roof === 'open' && (conf === 'estimated' || conf === '' || conf === null)) {
    // Any weather signal at all on an open/estimated completed game
    // means the fallback default-open path applied — the scraper
    // failed and never announced, corrector never flipped it.
    if (isDirty(r)) buckets.open_estimated.push(r);
  } else {
    buckets.other_roof_state.push(r);
  }
}

console.log('\n--- Buckets ---');
for (const [k, v] of Object.entries(buckets)) {
  console.log(k.padEnd(24) + ' ' + String(v.length).padStart(4));
}

console.log('\n--- closed/actual DIRTY (roof correct, weather NOT gated) ---');
buckets.closed_actual_dirty.forEach(r => {
  console.log('  ' + r.game_date + ' ' + r.game_id
    + ' wf=' + r.wind_factor + ' tra=' + r.temp_run_adj
    + ' temp=' + r.temp_f);
});

console.log('\n--- open/estimated DIRTY (scraper failed, never corrected) ---');
buckets.open_estimated.forEach(r => {
  console.log('  ' + r.game_date + ' ' + r.game_id
    + ' wf=' + r.wind_factor + ' tra=' + r.temp_run_adj
    + ' temp=' + r.temp_f);
});

console.log('\n--- closed/announced (scraper flipped roof; weather might still be stale) ---');
buckets.closed_announced.forEach(r => {
  console.log('  ' + r.game_date + ' ' + r.game_id
    + ' wf=' + r.wind_factor + ' tra=' + r.temp_run_adj
    + ' temp=' + r.temp_f);
});

console.log('\n--- already_tagged (existing weather_contamination_reason) ---');
const tagCounts = {};
buckets.already_tagged.forEach(r => {
  tagCounts[r.weather_contamination_reason] = (tagCounts[r.weather_contamination_reason] || 0) + 1;
});
for (const [reason, n] of Object.entries(tagCounts)) {
  console.log('  ' + reason + ': ' + n);
}

// Also: cumulative misapplied temp adjustment (proxy for user's "+15.0 runs")
let sumTra = 0, sumWf = 0;
for (const r of [...buckets.closed_actual_dirty, ...buckets.open_estimated, ...buckets.closed_announced]) {
  if (r.temp_run_adj) sumTra += Math.abs(Number(r.temp_run_adj));
  if (r.wind_factor)  sumWf  += Math.abs(Number(r.wind_factor));
}
console.log('\nsum |temp_run_adj| across dirty candidates: ' + sumTra.toFixed(2));
console.log('sum |wind_factor|  across dirty candidates: ' + sumWf.toFixed(4));
