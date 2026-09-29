#!/usr/bin/env node
'use strict';
// The matchup card's lineup-BsR number against the number the price uses.
// Read-only.
//   <node>/node.exe --max-old-space-size=1536 scripts/measure-card-bsr-vs-price.js [YYYY-MM-DD ...]
//
// WHY. Until 2026-09-28 the card computed BsR from its own inputs -- the
// LIVE trailing table and a denominator of games through the date
// INCLUSIVE -- and was labelled display-only. With the term in the
// moneyline price, a card number that differs from the priced one explains
// a price nobody computed. This checks, per game and side:
//
//   CARD   out.lineup_bsr.{away,home}.per_game from the real GET /games/:date
//          handler, invoked in-process (no server)
//   PRICE  what runModel adds to that side's runs with bsr_enabled ON, on the
//          game the harness builds (harness-inputs.populateCallerInputs --
//          the persisted emit-time value, or utils/bsr-term.js as of the date)
//
// A side with no number must read null on the card and 0 in the price; that
// is the fallback, and it is counted separately rather than as a match.
// Exit 1 on any disagreement.

const path = require('path');
const R = path.join(__dirname, '..');
const router = require(path.join(R, 'routes/api'));
const jobs = require(path.join(R, 'services/jobs'));
const hi = require(path.join(R, 'services/harness-inputs'));
const ps = require(path.join(R, 'services/parameter-sweep'));
const model = require(path.join(R, 'services/model'));
const { db } = require(path.join(R, 'db/schema'));

const quiet = (fn) => {
  const l = console.log, w = console.warn, e = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; console.error = e; }
};

// The handler, found on the router rather than copied: a copy is the thing
// this script exists to rule out.
const layer = router.stack.find(l => l.route && l.route.path === '/games/:date' && l.route.methods.get);
if (!layer) { console.error('GET /games/:date not found on the router'); process.exit(2); }
const handler = layer.route.stack[0].handle;
function cardFor(date) {
  let payload = null, status = 200;
  const res = { json: (b) => { payload = b; return res; }, status: (c) => { status = c; return res; },
    set: () => res, setHeader: () => {} };
  quiet(() => handler({ params: { date }, query: {} }, res, () => {}));
  if (status !== 200 || !Array.isArray(payload)) throw new Error('card route returned ' + status);
  return payload;
}

let dates = process.argv.slice(2);
if (!dates.length) {
  const r = db.prepare("SELECT MAX(game_date) d FROM game_log WHERE away_lineup_json IS NOT NULL").get();
  dates = [r.d];
}
const settingsOn = Object.assign({}, quiet(() => jobs.getSettings()), { BSR_ENABLED: true });

let sides = 0, match = 0, fallbackBoth = 0, disagree = 0;
const bad = [];
for (const date of dates) {
  const card = cardFor(date);
  const idx = quiet(() => ps.loadWobaSnapshot(db, date)) || quiet(() => jobs.getWobaIndex());
  const rows = db.prepare('SELECT * FROM game_log WHERE game_date=?').all(date);
  const byId = new Map(rows.map(r => [r.game_id, r]));
  for (const c of card) {
    const g = byId.get(c.game_id);
    if (!g || !c.lineup_bsr) continue;
    const w = quiet(() => hi.populateCallerInputs(ps.preScreenGame(g, idx, settingsOn), g, settingsOn));
    if (!w) continue;
    const mr = quiet(() => model.runModel(w, idx, settingsOn, 'standard', true));
    if (!mr || mr._suppressed) continue;
    for (const side of ['away', 'home']) {
      const cs = c.lineup_bsr[side];
      if (!cs) continue;                      // lineup pending on the card
      sides++;
      const cardV = cs.per_game;
      const priceV = side === 'away' ? mr.awayBsrUsed : mr.homeBsrUsed;
      const f = (v) => Number(v).toFixed(4); // the card rounds to 4 places
      if (cardV == null && priceV === 0) { fallbackBoth++; continue; }
      if (cardV != null && f(cardV) === f(priceV)) { match++; continue; }
      disagree++;
      bad.push(date + ' ' + c.game_id + ' ' + side + '  card=' + cardV + ' (' + cs.status + ', ' + cs.source
        + ')  price=' + priceV);
    }
  }
}
console.log('dates ' + dates.join(', ') + '   sides ' + sides);
console.log('  card === price                  ' + match);
console.log('  no number: card null, price 0  ' + fallbackBoth);
console.log('  DISAGREE                        ' + disagree);
for (const b of bad.slice(0, 20)) console.log('    ' + b);
console.log(disagree ? 'FAIL' : 'OK');
process.exit(disagree ? 1 : 0);
