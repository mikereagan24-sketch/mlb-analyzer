// WHAT WAS ACTUALLY BET. (2026-09-17)
//
// The replay harnesses have always reported two populations: every
// emitted signal (the emit floor, SIGNAL_EMIT_FLOOR_PP) and the subset
// clearing the UI highlight floor. Neither is the set of bets that were
// placed. The measurement that prompted this module:
//
//   logged bets (bet_line IS NOT NULL)        515
//     star-label era                          266
//     continuous-edge era                     249
//       above the UI floor                    173
//       BELOW it                               76
//   by category, continuous-edge, logged / above floor / median emit pp:
//       ML fav       107 / 102 / 3.33
//       ML dog       100 /  67 / 5.44
//       Total under   29 /   4 / 2.49
//       Total over    13 /   0 / 5.23   (overs can never highlight)
//
// So "above the UI floor" was standing in for "bet" and getting it wrong
// in both directions -- it admits signals nobody bet and excludes bets
// that were placed. bet_line IS NOT NULL is the operator's own record of
// a placed bet, which makes it the only population that needs no proxy.
//
// The join key is (game_date, game_id, signal_type, signal_side). Both
// sides were checked before this shipped: bet_signals stores exactly the
// values a harness signal carries -- signal_type 'ML' | 'Total',
// signal_side 'away' | 'home' | 'over' | 'under' (ML away 835 / home 683,
// Total over 487 / under 727) -- so the key matches with no mapping.
//
// NOT for parameter-sweep. A sweep scores counterfactual settings; the
// bets were placed under production settings, so intersecting a
// hypothetical config with the real bet log would attribute the
// operator's choices to a config that never produced them.

'use strict';

// One query per run, not one per game. Returns a Set of key strings.
// A harness window of a few hundred games costs a single scan.
function loadLoggedBetKeys(db, fromDate, toDate) {
  const keys = new Set();
  let rows = [];
  try {
    rows = db.prepare(
      'SELECT game_date, game_id, signal_type, signal_side FROM bet_signals '
      + 'WHERE bet_line IS NOT NULL AND game_date >= ? AND game_date <= ?'
    ).all(fromDate, toDate);
  } catch (e) { /* table missing -> empty set, buckets report n=0 */ }
  for (const r of rows) {
    keys.add(r.game_date + '|' + r.game_id + '|' + r.signal_type + '|' + r.signal_side);
  }
  return keys;
}

// Mirrors the harnesses' own sigKey(). Kept here so the key is defined
// once on both sides of the join.
function betKeyFor(gameRow, sig) {
  return gameRow.game_date + '|' + gameRow.game_id + '|' + sig.type + '|' + sig.side;
}

function wasBet(keys, gameRow, sig) {
  return keys.has(betKeyFor(gameRow, sig));
}

module.exports = { loadLoggedBetKeys, betKeyFor, wasBet };
