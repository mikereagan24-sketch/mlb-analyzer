#!/usr/bin/env node
/**
 * Does any table hold rows its own producer could not have made? (2026-08-27)
 *
 *   node scripts/audit-producer-floors.js
 *
 * WHY. Twice in four days a consumer applied a looser qualifier than the
 * ingest that fills its table:
 *
 *   catcher_framing  producer: pitch volume   consumer: volume, NO AGE
 *   fielding_frv     producer: 600 outs       consumer: outs_total > 0
 *
 * The FRV one let a 6-out sample price a game at -2.213 runs. The general
 * shape is worth stating: a looser consumer does not admit more GOOD data,
 * it admits exactly the data the producer rejected. So the useful question
 * is not "is the consumer loose" -- that is a code read -- but "has
 * anything actually got through", which is a query.
 *
 * This is the sweep from docs/consumer-producer-floor-sweep-2026-08-27.md
 * turned into something runnable, so the LATENT case announces itself
 * instead of waiting to be rediscovered. utils/framing-rate.js still
 * checks `pitches > 0` on its historical fallback; that is inert only
 * because the table's minimum happens to sit above the main floor, and
 * this is what notices if that stops being true.
 *
 * Exit 1 if anything is below a floor, so it can gate a review.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { FRV_MIN_INNINGS, FRV_MIN_OUTS } = require(path.join(R, 'services/scraper'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

// The consumer floor is what matters, because that is the value a row has
// to clear to reach the model. Where the consumer is STRICTER than the
// producer that is fine and expected -- rows between the two floors exist
// and are correctly ignored -- so the check reports both and only fails on
// rows below the CONSUMER floor, which are rows nothing should ever use.
const FLOORS = [
  {
    table: 'fielding_frv', column: 'outs_total',
    producer: FRV_MIN_OUTS,
    consumer: FRV_MIN_OUTS,
    note: 'minInnings=' + FRV_MIN_INNINGS + ' x 3 outs; consumer matches producer since 2026-08-27',
  },
  {
    table: 'catcher_framing', column: 'pitches',
    producer: 100,
    // utils/framing-rate.js: CATCHER_FRAMING_MIN_PITCHES_2026, default 750.
    // Deliberately stricter than the producer -- sub-750 rows exist in the
    // table and are correctly refused by the current-season path.
    consumer: 100,
    note: 'producer minPitches=100; the current-season consumer floor is 750 (stricter, fine)',
  },
  {
    table: 'catcher_framing_historical', column: 'pitches',
    producer: 100,
    // THE LATENT ONE. The historical fallback accepts `pitches > 0`, so a
    // row below 750 would be used at a x0.80 haircut with no floor at all.
    // Inert today only because MIN(pitches) is 776.
    consumer: 100,
    watch: 750,
    note: 'historical fallback checks `pitches > 0` -- watch line is the 750 the main path demands',
  },
];

let failures = 0;
console.log('=== producer/consumer floor audit ===');
console.log('');

for (const f of FLOORS) {
  let row;
  try {
    row = db.prepare('SELECT COUNT(*) n, MIN(' + f.column + ') mn FROM ' + f.table).get();
  } catch (e) {
    console.log('  ' + f.table.padEnd(28) + 'SKIP — ' + e.message);
    continue;
  }
  if (!row || !row.n) { console.log('  ' + f.table.padEnd(28) + 'empty'); continue; }

  const below = db.prepare('SELECT COUNT(*) c FROM ' + f.table + ' WHERE ' + f.column + ' < ?')
    .pluck().get(f.consumer);
  const bad = below > 0;
  if (bad) failures++;
  console.log('  ' + (bad ? 'FAIL  ' : 'ok    ') + f.table.padEnd(28)
    + 'n=' + String(row.n).padStart(4)
    + '  min(' + f.column + ')=' + String(row.mn).padStart(6)
    + '  floor=' + String(f.consumer).padStart(5)
    + '  below=' + below);
  console.log('        ' + f.note);

  // The watch line is not a failure -- it is the value that would make a
  // known-loose consumer branch live. Reported so the transition is
  // noticed on the run it happens, not months later.
  if (f.watch != null) {
    const underWatch = db.prepare('SELECT COUNT(*) c FROM ' + f.table + ' WHERE ' + f.column + ' < ?')
      .pluck().get(f.watch);
    if (underWatch > 0) {
      console.log('        *** WATCH TRIPPED: ' + underWatch + ' row(s) below ' + f.watch
        + '. The `pitches > 0` fallback in utils/framing-rate.js is now LIVE');
      console.log('        and should be given a real floor. See the sweep doc §4.');
      failures++;
    } else {
      console.log('        watch: 0 rows below ' + f.watch + ' — the loose fallback stays inert');
    }
  }
  console.log('');
}

if (failures) {
  console.log(failures + ' issue(s). A row below a consumer floor is a row nothing should use.');
  process.exit(1);
}
console.log('All tables clear their own consumer floors.');
