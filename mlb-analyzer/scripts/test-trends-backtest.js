#!/usr/bin/env node
'use strict';
// Trends backtest: the definitions and the statistics, on SYNTHETIC data with
// hand-checked answers. No real game_log is read -- the point is that each
// pre-registered rule (docs/trends-preregistration-2026-09-29.md) does what
// the doc says on cases where the right answer is known.
//   node scripts/test-trends-backtest.js

const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const { SCENARIOS, noVig, cents, profit } = require(path.join(R, 'utils/trends/scenarios'));
const { localParts } = require(path.join(R, 'utils/trends/teams'));
const tb = require(path.join(R, 'services/trends-backtest'));
const I = tb._internals;

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (cond || detail == null ? '' : '   ' + detail));
}
const near = (a, b, e) => a != null && Math.abs(a - b) <= (e || 1e-6);

console.log('1. price helpers (§2)');
ok('no-vig of -150 / +130 = 0.5798', near(noVig(-150, 130), 0.6 / (0.6 + 100 / 230), 1e-9));
ok('cents: -110 -> -10, +105 -> +5, -100 and +100 both 0',
  cents(-110) === -10 && cents(105) === 5 && cents(-100) === 0 && cents(100) === 0);
ok('+130 open -> +115 lock is 15 cents TOWARD the team', cents(130) - cents(115) === 15);
ok('-110 open -> -125 lock is 15 cents toward', cents(-110) - cents(-125) === 15);
ok('+105 open -> -110 lock crosses even: 15 cents toward', cents(105) - cents(-110) === 15);
ok('profit on $100: +150 wins 150, -150 wins 66.67', profit(150) === 150 && near(profit(-150), 66.6667, 1e-4));

console.log('\n2. statistics (§6-§7)');
const [lo, hi] = I.wilson(50, 100);
ok('Wilson 50/100 = [0.4038, 0.5962]', near(lo, 0.4038, 1e-4) && near(hi, 0.5962, 1e-4), lo + ' ' + hi);
ok('two-sided p at z=1.96 is 0.0500', near(I.normTwoSided(1.959964), 0.05, 1e-6));
ok('two-sided p at z=0 is 1', near(I.normTwoSided(0), 1, 1e-6));
const q = I.bhQ([0.01, 0.04, 0.03, 0.2]);
ok('BH q for [0.01,0.04,0.03,0.2] = [0.04,0.0533,0.0533,0.2]',
  near(q[0], 0.04) && near(q[1], 0.0533, 1e-4) && near(q[2], 0.0533, 1e-4) && near(q[3], 0.2), q.join(','));
ok('P(>=2 of 31 at 0.05) = 0.4634', near(I.binomTailGe(2, 31, 0.05), 0.4634, 1e-4), I.binomTailGe(2, 31, 0.05));
const r1 = I.mulberry32(20260929)(), r2 = I.mulberry32(20260929)();
ok('bootstrap stream is reproducible from the seed', r1 === r2);
const s = I.summarize([
  { result: 'W', price: 150, p: 0.4, source: 'kalshi' },
  { result: 'L', price: -120, p: 0.55, source: 'kalshi' },
  { result: 'P', price: -110, p: 0.5, source: 'unrecorded' }]);
ok('summarize: 1-1-1, $ +50, ROI over all 3 rows', s.W === 1 && s.L === 1 && s.P === 1 && s.dollars === 50 && near(s.roi, 50 / 300));
ok('summarize: win % and implied % over decided rows only', near(s.winPct, 0.5) && near(s.implied, 0.475));

console.log('\n3. calendar (§5)');
const lp = localParts('2026-07-15T23:10:00Z', 'America/New_York');
ok('23:10Z is 19:10 in New York in July (EDT)', lp.hour === 19 && lp.date === '2026-07-15');
const lp2 = localParts('2026-04-02T02:10:00Z', 'America/Los_Angeles');
ok('02:10Z on 04-02 is 19:10 on 04-01 in Los Angeles', lp2.hour === 19 && lp2.date === '2026-04-01');
ok('prevDay across a month boundary', I.prevDay('2026-07-01') === '2026-06-30');

console.log('\n4. rows from a synthetic schedule');
const db = new Database(':memory:');
db.exec(`CREATE TABLE game_log (game_date TEXT, game_id TEXT, away_team TEXT, home_team TEXT,
  away_score INTEGER, home_score INTEGER, market_away_ml INTEGER, market_home_ml INTEGER, ml_source TEXT,
  odds_locked_at TEXT, market_contamination_reason TEXT, market_total REAL, over_price INTEGER,
  under_price INTEGER, total_source TEXT, first_pitch_utc TEXT, scheduled_start_utc TEXT,
  is_opener_game_away INTEGER, is_opener_game_home INTEGER, is_removed INTEGER)`);
const G = (d, id, a, h, as, hs, ma, mh, fp, extra) => Object.assign({ game_date: d, game_id: id,
  away_team: a, home_team: h, away_score: as, home_score: hs, market_away_ml: ma, market_home_ml: mh,
  ml_source: 'kalshi', odds_locked_at: d + ' 22:50:00', market_contamination_reason: null,
  market_total: 8.5, over_price: -110, under_price: -110, total_source: 'kalshi',
  first_pitch_utc: fp, scheduled_start_utc: null, is_opener_game_away: 0, is_opener_game_home: 0,
  is_removed: 0 }, extra || {});
const rows = [
  // BOS at NYY, 3-game series, NYY home. Night, night, then a DAY game after.
  G('2026-07-10', 'bos-nyy', 'BOS', 'NYY', 2, 12, 130, -150, '2026-07-10T23:05:00Z'),   // NYY W by 10, fav
  G('2026-07-11', 'bos-nyy', 'BOS', 'NYY', 5, 4, -105, -115, '2026-07-11T23:05:00Z'),   // NYY L by 1, fav
  G('2026-07-12', 'bos-nyy', 'BOS', 'NYY', 0, 3, 140, -160, '2026-07-12T17:35:00Z'),    // day after night
  // NYY then at TB: doubleheader. g1 and g2 on the same date.
  G('2026-07-13', 'nyy-tb', 'NYY', 'TB', 1, 2, 120, -140, '2026-07-13T17:10:00Z'),
  G('2026-07-13', 'nyy-tb-g2', 'NYY', 'TB', 3, 4, 110, -130, '2026-07-13T21:40:00Z'),
  // Excluded: priced after first pitch, and a removed game.
  G('2026-07-14', 'nyy-tb', 'NYY', 'TB', 6, 1, 105, -125, '2026-07-14T23:10:00Z', { market_contamination_reason: 'priced_post_first_pitch' }),
  G('2026-07-15', 'nyy-tb', 'NYY', 'TB', 9, 1, 105, -125, '2026-07-15T23:10:00Z', { is_removed: 1 }),
  // All-Star Game: dropped.
  G('2026-07-14', 'al-nl', 'AL', 'NL', 3, 2, -110, -110, '2026-07-15T00:00:00Z'),
];
const ins = db.prepare('INSERT INTO game_log VALUES (' + Object.keys(rows[0]).map(() => '?').join(',') + ')');
for (const r of rows) ins.run(...Object.values(r));
db.exec("CREATE TABLE empirical_market_captures (game_date TEXT, game_id TEXT, market_type TEXT, capture_track TEXT, away_price_ml INTEGER, home_price_ml INTEGER, generated_at TEXT)");
db.prepare("INSERT INTO empirical_market_captures VALUES ('2026-07-12','bos-nyy','ml','morning',125,-145,'2026-07-12 07:00:00')").run();
const built = tb.buildRows(db);
const row = (d, id, team) => built.mlRows.find(r => r.game_date === d && r.game_id === id && r.team === team);
ok('population: 5 games (contaminated, removed and All-Star dropped)', built.populationGames === 5, built.populationGames);
const a = row('2026-07-11', 'bos-nyy', 'NYY');
ok('NYY 07-11: P is 07-10, won by 10, priced fav, same series',
  a.c.P && a.c.P.margin === 10 && a.c.P.fav && a.c.P.priced && a.c.P.sameSeries);
const b = row('2026-07-12', 'bos-nyy', 'NYY');
ok('NYY 07-12: P lost by 1 as fav -> S02 and S16 qualify',
  SCENARIOS.find(x => x.id === 'S02').test(b.c) && SCENARIOS.find(x => x.id === 'S16').test(b.c));
ok('NYY 07-12: day game after a night game on the previous local day (S20)', b.c.dayAfterNight === true);
ok('NYY 07-12: series finale, home favorite (S23)', b.c.seriesLast && SCENARIOS.find(x => x.id === 'S23').test(b.c));
ok('NYY 07-12: not the series opener', b.c.seriesFirst === false);
ok('NYY 07-12: open +125/-145 -> lock -160 is 15 cents toward NYY', b.c.moveCents === 15, b.c.moveCents);
const g1 = row('2026-07-13', 'nyy-tb', 'NYY'), g2 = row('2026-07-13', 'nyy-tb-g2', 'NYY');
ok('NYY DH g1: series opener, road dog (S22), P is the 07-12 win', g1.c.seriesFirst && g1.c.P.margin === 3
  && SCENARIOS.find(x => x.id === 'S22').test(g1.c));
ok('NYY DH g2: P is g1 (same date, earlier first pitch), not 07-12', g2.c.P.margin === -1 && g2.c.P.sameSeries);
ok('NYY DH g2: S21 (game 2, dog)', SCENARIOS.find(x => x.id === 'S21').test(g2.c));
ok('NYY DH g2: loss streak 1, win streak 0', g2.c.lossStreak === 1 && g2.c.winStreak === 0);
ok('interleague false for NYY-TB, same division true', g2.c.interleague === false && g2.c.sameDivision === true);
ok('BOS 07-11: after allowing 10+ (S15)', SCENARIOS.find(x => x.id === 'S15').test(row('2026-07-11', 'bos-nyy', 'BOS').c));
const tot = built.totRows.filter(r => r.game_id === 'bos-nyy' && r.game_date === '2026-07-11');
ok('S30 does not fire on 07-11: the 07-10 game totalled 14, under 15', !tot[0].x.prevTotalGe15);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
