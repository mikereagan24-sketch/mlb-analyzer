// Can the bulk pitcher's handedness move the price at all?
//
// Asked BEFORE running the ML calibration A/B, per CLAUDE.md
// "Before running an A/B, ask what the change can physically move."
// The park-factor entry is the precedent: a term that scales both sides
// equally cannot move a ratio target, so the A/B reports "not
// significant" however wrong the input is.
//
// The three places a bulk hand could enter, and what this probes:
//
//   1. services/model.js buildOpenerOpts ~1028:
//        getPitcherWoba(wobaIdx, bulkSp, 'R', team, ...)
//      The literal 'R' this task is about. Inside getPitcherWoba (~532)
//      `hand` is used for ONE thing: selecting the default `d` that is
//      applied only via `?? d.vsLHB` / `?? d.vsRHB` -- i.e. only when
//      the pitcher is ABSENT from the wOBA index.
//
//   2. The same call site's fallback branch: when source === 'fallback',
//      buildOpenerOpts OVERWRITES both splits with UNKNOWN_PITCHER_WOBA,
//      discarding `d` entirely.
//
//   3. perBatterEW (~597): takes a SINGLE pitcherHand for the whole
//      game and uses it for effHand (switch hitters) and for
//      vsStart/vsOpp (the SP_WEIGHT platoon channel). It is the
//      OPPOSING SP's hand -- the opener's, on an opener game. No bulk
//      hand is passed in at all.
//
// Run: node --max-old-space-size=1536 scripts/probe-bulk-hand-channel.js
//
// Cited as the re-run command by docs/bulk-hand-measured-inert-2026-09-19.md,
// docs/per-slot-pitcher-hand-open-question-2026-09-19.md, and the call-site
// notes in services/model.js and db/schema.js. Deliberately NOT named
// test-*, so scripts/run-tests.js does not glob it: the inert property is
// expected to end the day per-slot hand is built, and a check that fails
// when someone does the right thing is the check nobody reads.

const { db, q } = require('../db/schema');
const { getWobaIndex, getSettings } = require('../services/jobs');
const model = require('../services/model');
const { normName, stripSfx } = require('../utils/names');

const K = (n) => stripSfx(normName(n || ''));

function main() {
  const settings = getSettings();
  const idx = getWobaIndex();

  // ---- the real bulk pitchers, and their real hands -----------------
  const sides = [];
  const rows = db.prepare(
    'SELECT game_date, game_id, away_team, home_team, away_sp, home_sp, '
    + 'is_opener_game_away, is_opener_game_home, bulk_guy_away, bulk_guy_home, '
    + 'away_sp_hand, home_sp_hand, game_type_away, game_type_home '
    + 'FROM game_log WHERE is_opener_game_away=1 OR is_opener_game_home=1'
  ).all();
  for (const r of rows) {
    for (const side of ['away', 'home']) {
      if (r['is_opener_game_' + side] !== 1) continue;
      const bulk = r['bulk_guy_' + side];
      if (!bulk) continue;
      sides.push({
        date: r.game_date, gid: r.game_id,
        team: side === 'away' ? r.away_team : r.home_team,
        bulk,
        openerHand: side === 'away' ? r.away_sp_hand : r.home_sp_hand,
        gameType: r['game_type_' + side],
      });
    }
  }

  // Hand lookup: active roster, then season roster, then the appearance
  // log -- the same tiers the id resolver uses.
  const handOf = (() => {
    const m = new Map();
    const add = (t, n, h) => { if (t && n && h) m.set(t + '|' + K(n), h); };
    for (const x of db.prepare('SELECT team, player_name, hand FROM team_rosters_season').all()) add(x.team, x.player_name, x.hand);
    for (const x of db.prepare('SELECT team, player_name, hand FROM team_rosters').all()) add(x.team, x.player_name, x.hand);
    return (team, name) => {
      if (m.has(team + '|' + K(name))) return m.get(team + '|' + K(name));
      const a = K(name).split(' ');
      if (a.length >= 2) {
        const ab = a[0][0] + ' ' + a[a.length - 1];
        for (const [k, v] of m) {
          if (!k.startsWith(team + '|')) continue;
          const kk = k.slice(team.length + 1).split(' ');
          if (kk.length >= 2 && kk[kk.length - 1] === a[a.length - 1] && kk[0][0] === a[0][0]) return v;
        }
      }
      return null;
    };
  })();

  let L = 0, R = 0, S = 0, unresolved = 0;
  for (const s of sides) {
    s.realHand = handOf(s.team, s.bulk);
    if (s.realHand === 'L') L++;
    else if (s.realHand === 'R') R++;
    else if (s.realHand === 'S') S++;
    else unresolved++;
  }

  console.log('=== 1. THE POPULATION ===');
  console.log('  opener sides with a named bulk : ' + sides.length);
  console.log('  bulk pitcher REAL hand: R=' + R + '  L=' + L + '  S=' + S
    + '  unresolved=' + unresolved);
  console.log('  sides where the hardcoded R is WRONG : ' + L
    + '  (' + (100 * L / sides.length).toFixed(1) + '%)');

  // ---- 2. does the hand argument change getPitcherWoba's output? ----
  const W_PROJ = parseFloat(settings.W_PROJ ?? 0.65);
  const W_ACT = parseFloat(settings.W_ACT ?? 0.35);
  const MIN_BF = parseFloat(settings.MIN_BF ?? 100);
  const UNK = parseFloat(settings.UNKNOWN_PITCHER_WOBA ?? 0.335);

  let differ = 0, same = 0, fallback = 0, differAfterOverwrite = 0;
  const examples = [];
  const seen = new Set();
  for (const s of sides) {
    const key = s.team + '|' + K(s.bulk);
    if (seen.has(key)) continue;
    seen.add(key);
    const asR = model.getPitcherWoba(idx, s.bulk, 'R', s.team, W_PROJ, W_ACT, MIN_BF, settings);
    const asL = model.getPitcherWoba(idx, s.bulk, 'L', s.team, W_PROJ, W_ACT, MIN_BF, settings);
    const rawDiff = (asR.vsLHB !== asL.vsLHB) || (asR.vsRHB !== asL.vsRHB);
    if (asR.source === 'fallback') fallback++;
    if (rawDiff) { differ++; if (examples.length < 5) examples.push(s.bulk + ' (' + s.team + ') R->' + asR.vsLHB.toFixed(4) + '/' + asR.vsRHB.toFixed(4) + '  L->' + asL.vsLHB.toFixed(4) + '/' + asL.vsRHB.toFixed(4) + '  source=' + asR.source); }
    else same++;
    // buildOpenerOpts overwrites BOTH splits with UNK on the fallback
    // branch, so replay that and re-compare -- this is what the model
    // actually consumes.
    const effR = asR.source === 'fallback' ? { vsLHB: UNK, vsRHB: UNK } : { vsLHB: asR.vsLHB, vsRHB: asR.vsRHB };
    const effL = asL.source === 'fallback' ? { vsLHB: UNK, vsRHB: UNK } : { vsLHB: asL.vsLHB, vsRHB: asL.vsRHB };
    if (effR.vsLHB !== effL.vsLHB || effR.vsRHB !== effL.vsRHB) differAfterOverwrite++;
  }

  console.log('\n=== 2. DOES THE HAND ARG CHANGE getPitcherWoba OUTPUT? ===');
  console.log('  distinct (team, bulk) pitchers tested : ' + seen.size);
  console.log('  index MISS (source=fallback)          : ' + fallback);
  console.log('  raw getPitcherWoba output differs     : ' + differ);
  console.log('  ...AFTER buildOpenerOpts overwrites   : ' + differAfterOverwrite);
  if (examples.length) { console.log('  raw-differing examples:'); examples.forEach(e => console.log('    ' + e)); }

  // ---- 3. THE ACTUAL TREATMENT, over game-sides ---------------------
  // Section 2 compares 'R' vs 'L' for EVERY pitcher, which shows the
  // mechanism is live in principle. It is NOT the treatment: the real
  // arm only changes sides whose bulk is genuinely not right-handed, so
  // a right-handed pitcher who happens to be sensitive to the hand
  // argument (Matt Waldron) never enters it. Counting sections 2 and 3
  // as the same number is how "1 pitcher moves" turns into a five-window
  // A/B that could only ever have returned zero.
  let treated = 0, treatedMoved = 0;
  const movedDetail = [];
  for (const s2 of sides) {
    const h = s2.realHand;
    if (!h || h === 'R') continue;          // treatment = real hand != 'R'
    treated++;
    const asR = model.getPitcherWoba(idx, s2.bulk, 'R', s2.team, W_PROJ, W_ACT, MIN_BF, settings);
    const asH = model.getPitcherWoba(idx, s2.bulk, h, s2.team, W_PROJ, W_ACT, MIN_BF, settings);
    const eR = asR.source === 'fallback' ? { l: UNK, r: UNK } : { l: asR.vsLHB, r: asR.vsRHB };
    const eH = asH.source === 'fallback' ? { l: UNK, r: UNK } : { l: asH.vsLHB, r: asH.vsRHB };
    if (eR.l !== eH.l || eR.r !== eH.r) {
      treatedMoved++;
      if (movedDetail.length < 10) movedDetail.push(s2.date + ' ' + s2.gid + ' ' + s2.bulk + ' (' + s2.team + ',' + h + ')');
    }
  }
  console.log('\n=== 3. THE ACTUAL TREATMENT (real hand, only where != R) ===');
  console.log('  opener GAME-SIDES in the treatment group : ' + treated);
  console.log('  ...whose consumed bulk wOBA CHANGES      : ' + treatedMoved);
  movedDetail.forEach(d => console.log('    ' + d));

  // ---- 4. is a bulk hand even reachable from perBatterEW? ----------
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'model.js'), 'utf8');
  const sig = (src.match(/function perBatterEW\([^)]*\)/) || [''])[0];
  console.log('\n=== 4. IS A BULK HAND REACHABLE FROM perBatterEW? ===');
  console.log('  signature carries a per-slot hand? '
    + (/bulkHand|bulk_hand/i.test(sig) ? 'YES' : 'NO'));
  console.log('  openerOpts keys consumed in perBatterEW: '
    + [...new Set((src.slice(src.indexOf('function perBatterEW'), src.indexOf('function perBatterEW') + 1400)
        .match(/openerOpts\.\w+/g) || []))].join(', '));
  console.log('  -> effHand() and vsStart/vsOpp both read the single');
  console.log('     `pitcherHand` argument, which runModel fills with the');
  console.log('     OPPOSING SP hand (the opener on an opener game).');

  console.log('\n=== VERDICT ===');
  if (treatedMoved === 0) {
    console.log('  The `R` literal at buildOpenerOpts is MEASURED-INERT.');
    console.log('  Passing the real hand changes the consumed bulk wOBA on');
    console.log('  0 of ' + sides.length + ' opener sides -- including all ' + treated + ' where the');
    console.log('  hardcoded R is genuinely WRONG. An ML calibration A/B on');
    console.log('  this change returns exactly 0: a no-op, not a null result.');
    console.log('  See docs/bulk-hand-measured-inert-2026-09-19.md');
    if (differAfterOverwrite > 0) {
      console.log('');
      console.log('  (Section 2 reports ' + differAfterOverwrite + ' pitcher(s) sensitive to the hand');
      console.log('   argument. They are RIGHT-handed, so the real-hand arm passes');
      console.log("   'R' for them and nothing moves. Section 3 is the population");
      console.log('   result; section 2 is the mechanism check.)');
    }
  } else {
    console.log('  ' + treatedMoved + ' of ' + treated + ' treated side(s) move. The inert finding in');
    console.log('  docs/bulk-hand-measured-inert-2026-09-19.md is STALE --');
    console.log('  getPitcherWoba or buildOpenerOpts has changed. Re-measure');
    console.log('  before citing that doc.');
  }
}

main();
