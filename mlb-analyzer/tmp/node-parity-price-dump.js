#!/usr/bin/env node
'use strict';
// Priced-output dump for the Node 20 -> 22 move (chore/node-22). (2026-09-28)
//
// Writes every priced game in the CURRENT SLATE and the FORWARD CORPUS as one
// canonical line per game per mode, so the same file produced under Node 20
// and Node 22 can be compared byte for byte. "Priced output" here is the full
// runModel() result (win probabilities, model moneylines, estTot, weights)
// plus getSignals() (the bet signals and their edges, and the ones the
// edge-sanity cap suppressed), for both the 'standard' and 'opener_aware'
// paths.
//
// Numbers are written with String(), which is the shortest round-trip form of
// the double: two runs print the same text if and only if the doubles are
// identical. -0, NaN and +/-Infinity are spelled out, since JSON would
// silently fold them.
//
// Window definitions are the ones scripts/test-pythag-consolidation.js uses:
//   current slate  = newest game_date with a model_total AND a wOBA snapshot
//   forward corpus = MIN(team_baserunning_snapshot.snapshot_date) ..
//                    MAX(game_date with a final score), every game
//
// Run (heap capped per CLAUDE.md):
//   <node> --max-old-space-size=1536 tmp/node-parity-price-dump.js OUT.txt
// then compare the two OUT files (sha256 is printed at the end).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const ps = require('../services/parameter-sweep');
const hi = require('../services/harness-inputs');
const jobs = require('../services/jobs');
const model = require('../services/model');

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node tmp/node-parity-price-dump.js OUT.txt'); process.exit(2); }
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mlb.db');
const db = new Database(DB_PATH, { readonly: true });

const quiet = (fn) => {
  const l = console.log, w = console.warn, e = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; console.error = e; }
};

// Canonical text: sorted keys, exact numbers, undefined/functions dropped.
function canon(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (Object.is(v, -0)) return '"-0"';
    if (Number.isNaN(v)) return '"NaN"';
    if (!Number.isFinite(v)) return v > 0 ? '"Infinity"' : '"-Infinity"';
    return String(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return '"<' + typeof v + '>"';
}

const settings = jobs.getSettings();

const cand = db.prepare("SELECT DISTINCT game_date FROM game_log "
  + "WHERE model_total IS NOT NULL ORDER BY game_date DESC LIMIT 6").all().map((r) => r.game_date);
let slateDate = null;
for (const d of cand) { if (quiet(() => ps.loadWobaSnapshot(db, d))) { slateDate = d; break; } }
const FROM = db.prepare('SELECT MIN(snapshot_date) v FROM team_baserunning_snapshot').get().v;
const TO = db.prepare('SELECT MAX(game_date) v FROM game_log WHERE home_score IS NOT NULL').get().v;

const fd = fs.openSync(OUT, 'w');
const hash = crypto.createHash('sha256');
function emit(line) { fs.writeSync(fd, line + '\n'); hash.update(line + '\n'); }
emit('# node-parity price dump; slate ' + slateDate + '; forward corpus ' + FROM + '..' + TO);

function sweep(label, from, to) {
  // One date at a time: bounded memory, per CLAUDE.md's windowed-query rule.
  const dates = db.prepare('SELECT DISTINCT game_date FROM game_log WHERE game_date BETWEEN ? AND ? ORDER BY game_date')
    .all(from, to).map((r) => r.game_date);
  let priced = 0, skipped = 0, lines = 0;
  for (const d of dates) {
    const idx = quiet(() => ps.loadWobaSnapshot(db, d));
    const games = quiet(() => ps.loadGames(db, d, d, {}));
    for (const g of games) {
      if (!idx) { skipped++; continue; }
      const wrapped = quiet(() => hi.populateCallerInputs(ps.preScreenGame(g, idx, settings), g, settings));
      if (!wrapped) { skipped++; continue; }
      let any = false;
      for (const mode of ['standard', 'opener_aware']) {
        const mr = quiet(() => model.runModel(wrapped, idx, settings, mode, true));
        let sig = null, sup = [];
        if (mr && !mr._suppressed) sig = quiet(() => model.getSignals(g, mr, settings, sup));
        emit(label + ' ' + g.game_date + ' ' + g.game_id + ' ' + mode + ' '
          + canon({ model: mr, signals: sig, suppressed: sup }));
        lines++;
        if (mr && !mr._suppressed) any = true;
      }
      if (any) priced++;
    }
  }
  console.log('  ' + label + ' ' + from + '..' + to + ': ' + priced + ' games priced, '
    + skipped + ' skipped, ' + lines + ' lines');
}

console.log('node ' + process.version + ' (ABI ' + process.versions.modules + ')  db ' + DB_PATH);
if (slateDate) sweep('slate', slateDate, slateDate);
else console.log('  NO priceable slate in the last 6 dates');
sweep('forward', FROM, TO);
fs.closeSync(fd);
console.log('sha256 ' + hash.digest('hex') + '  ' + OUT);
