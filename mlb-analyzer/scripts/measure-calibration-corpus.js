#!/usr/bin/env node
/**
 * What a calibration run ACTUALLY scores, counted at every stage of the
 * real filter chain. (2026-09-13)
 *
 *   node scripts/measure-calibration-corpus.js                # gate window + season
 *   node scripts/measure-calibration-corpus.js 2026-06-16 2026-09-10
 *
 * WHY THIS EXISTS. The defense_frv_split registry row recorded
 * `corpus_size: 1078` and asserted that was "what a calibration run
 * actually scores". It was not. A run on that window scores 797. The 1078
 * counted graded games with both lineups and a weather predicate, and
 * stopped there -- it omitted the market-contamination filter that
 * loadGames applies unconditionally, plus three later requirements. The
 * gap was 281 games, and it was pointed the flattering way: the row also
 * claimed the >= 1200 bar was "reachable without waiting" off a
 * season-wide 1976 computed the same partial way. The real season-wide
 * number under the full chain is 1158.
 *
 * This is the CLAUDE.md rule "a schedule-share denominator is not a
 * measurement n" applied one level up: the denominator was not scheduled
 * games, it was games-surviving-SOME-of-the-filters, which is the same
 * error with a smaller multiplier. And it is the reason the registry
 * standard (scripts/test-registry-corpus-size.js) exists at all -- that
 * check makes sure a row HAS an n; it cannot tell whether the n describes
 * the corpus the numbers came from.
 *
 * THE CHAIN IS NOT RESPELLED HERE. Every count below either calls
 * ps.loadGames / ps.loadWobaSnapshot / ps.preScreenGame directly or is
 * labelled as the partial count it is. A second copy of the filter SQL is
 * how this class of mistake regenerates itself -- if loadGames gains a
 * filter tomorrow, this script reports the new number with no edit.
 *
 * The two PARTIAL counts at the top are printed deliberately, not as
 * candidates: they are what a registry row looks like when someone counts
 * with SQL instead of running the chain, and seeing them next to USABLE is
 * the point.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const ps = require(path.join(R, 'services/parameter-sweep'));
const jobs = require(path.join(R, 'services/jobs'));
const { impliedP } = require(path.join(R, 'services/model'));

// The bar the calibration rows are written against. Not a constant of
// nature -- it is the >= 1200 in the defense_frv_split criterion.
const BAR = Number(process.env.CORPUS_BAR || 1200);

const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });
const baseSettings = jobs.getSettings();

function chain(from, to) {
  const out = { from: from, to: to };

  // --- the two PARTIAL counts, for comparison only ---------------------
  out.graded_with_lineups = db.prepare(
    'SELECT COUNT(*) n FROM game_log WHERE game_date >= ? AND game_date <= ? '
    + 'AND home_score IS NOT NULL AND away_score IS NOT NULL '
    + 'AND home_lineup_json IS NOT NULL AND away_lineup_json IS NOT NULL').get(from, to).n;
  out.weather_valid_only = db.prepare(
    'SELECT COUNT(*) n FROM game_log WHERE game_date >= ? AND game_date <= ? '
    + 'AND home_score IS NOT NULL AND away_score IS NOT NULL '
    + 'AND home_lineup_json IS NOT NULL AND away_lineup_json IS NOT NULL '
    + "AND temp_f IS NOT NULL AND weather_quality_at >= '2026-08-05 23:00:00'").get(from, to).n;

  // --- the real chain, as calibration-ab.js walks it -------------------
  const opts = { includeMarketContaminated: false, includeWeatherContaminated: false,
                 weatherFilter: 'valid' };
  const games = ps.loadGames(db, from, to, opts);
  out.loadGames = games.length;
  out.loadGames_market_kept = ps.loadGames(db, from, to,
    { includeMarketContaminated: true, includeWeatherContaminated: false,
      weatherFilter: 'valid' }).length;

  const cache = new Map();
  for (const g of games) {
    if (!cache.has(g.game_date)) cache.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));
  }
  let noSnap = 0, noScore = 0, noMkt = 0, noPre = 0, noImp = 0, usable = 0;
  const snapMissing = new Set();
  for (const g of games) {
    const idx = cache.get(g.game_date);
    if (!idx) { noSnap++; snapMissing.add(g.game_date); continue; }
    if (g.home_score == null || g.away_score == null) { noScore++; continue; }
    if (g.market_home_ml == null || g.market_away_ml == null) { noMkt++; continue; }
    const w = ps.preScreenGame(g, idx, baseSettings);
    if (!w) { noPre++; continue; }
    const ph = impliedP(g.market_home_ml), pa = impliedP(g.market_away_ml);
    if (ph == null || pa == null || (ph + pa) <= 0) { noImp++; continue; }
    usable++;
  }
  out.drop_no_woba_snapshot = noSnap;
  out.drop_no_score = noScore;
  out.drop_no_market = noMkt;
  out.drop_prescreen = noPre;
  out.drop_bad_implied = noImp;
  out.USABLE = usable;
  out.snapshot_missing_dates = [...snapMissing].sort();
  return out;
}

function show(t) {
  const pad = (n) => String(n).padStart(5);
  console.log('');
  console.log('=== ' + t.from + ' .. ' + t.to + ' ===');
  console.log('  PARTIAL  graded, both lineups posted     ' + pad(t.graded_with_lineups));
  console.log('  PARTIAL  + weather predicate             ' + pad(t.weather_valid_only)
    + '   <- a registry row counted this way');
  console.log('  chain    loadGames, market tag KEPT      ' + pad(t.loadGames_market_kept));
  console.log('  chain    loadGames (market EXCLUDED)     ' + pad(t.loadGames)
    + '   (-' + (t.loadGames_market_kept - t.loadGames) + ' market_contamination_reason NOT NULL)');
  console.log('             - no woba_data_snapshot       ' + pad(t.drop_no_woba_snapshot)
    + (t.snapshot_missing_dates.length
      ? '   over ' + t.snapshot_missing_dates.length + ' dates, '
        + t.snapshot_missing_dates[0] + ' .. '
        + t.snapshot_missing_dates[t.snapshot_missing_dates.length - 1]
        + ' (UNBACKFILLABLE)'
      : ''));
  console.log('             - not scored                  ' + pad(t.drop_no_score));
  console.log('             - no market ML                ' + pad(t.drop_no_market));
  console.log('             - preScreenGame null          ' + pad(t.drop_prescreen));
  console.log('             - implied prob unusable       ' + pad(t.drop_bad_implied));
  console.log('  USABLE   what a calibration run scores   ' + pad(t.USABLE));
  console.log('  overstatement if the partial is quoted: +'
    + (t.weather_valid_only - t.USABLE) + ' games');
  console.log('  vs the >= ' + BAR + ' bar: '
    + (t.USABLE >= BAR ? 'CLEARS' : 'SHORT by ' + (BAR - t.USABLE)));
}

const args = process.argv.slice(2);
if (args.length >= 2) {
  show(chain(args[0], args[1]));
} else {
  // The defense_frv_split window, then the season, because the row quotes
  // both and both were wrong.
  const gate = chain('2026-06-16', '2026-09-10');
  const season = chain('2026-04-01', '2026-09-12');
  show(gate);
  show(season);
  console.log('');
  console.log('paste-able: gate_window=' + gate.USABLE + '  season=' + season.USABLE
    + '  bar=' + BAR + '  season_short_by=' + Math.max(0, BAR - season.USABLE));
}
