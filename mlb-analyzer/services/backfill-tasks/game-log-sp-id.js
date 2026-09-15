'use strict';

// Backfill task: game_log.away_sp_id / home_sp_id for games already played.
// (2026-09-14)
//
// Forward games get their ids from the statsapi schedule feed at the same
// write as the name. Games already in the table have names only, so the id
// has to come from somewhere that already pairs a starter with an MLBAM id
// for a past game: pitcher_game_log, which carries was_starter alongside
// pitcher_mlb_id.
//
// THE JOIN IS (game_date, team, was_starter), NOT game_id. pitcher_game_log
// has no game_id column -- it keys on game_date + team + game_number -- so
// the match is by side, with game_number carrying doubleheaders. game_log
// appends '-g2' to game_id for later legs and stores game_number too, so
// the two agree on which leg is which.
//
// UNFILLABLE IS COUNTED AND CLASSIFIED, not silently skipped. Four reasons
// a side can fail, and they mean different things:
//
//   no_starter_row     pitcher_game_log has no was_starter row for that
//                      (date, team, leg). The appearance ingest never saw
//                      the game, or the game was never played.
//   multiple_starters  more than one row flagged was_starter for one side.
//                      Cannot be resolved by this task and must not be
//                      guessed at -- an opener game where both the opener
//                      and the bulk arm got flagged looks like this.
//   no_name_to_check   game_log has no away_sp / home_sp text, so there is
//                      nothing to cross-check the id against.
//   name_mismatch      the starter found does not match the stored name
//                      under the shared normaliser. NOT written: it means
//                      the row and the appearance log disagree about who
//                      started, and writing an id that contradicts the
//                      visible name would be worse than leaving it null.
//
// The mismatch check is the point. A backfill that fills by (date, team)
// alone would happily write an id for a game whose stored name says someone
// else started -- exactly the stale-pairing failure the upsert's CASE guard
// exists to prevent going forward.

const { registerBackfillTask } = require('../backfill-jobs');
const { normName, stripSfx, fuzzyLookup } = require('../../utils/names');

// SAME PERSON? through the shared matcher, not string equality.
//
// Exact normName equality rejects "C. Mlodzinski" vs "Carmen Mlodzinski",
// which is the same pitcher written two ways -- measured, that was 31 of
// 832 sides and nearly all of them were this, not a real disagreement. The
// abbreviated-form stages already live in fuzzyLookup, so the check reuses
// them by building a ONE-ENTRY index from the appearance name and asking
// whether the stored name finds it. No second spelling of the rule.
//
// It still rejects a genuine change: 2026-08-18 ath-kc stored "Jack
// Perkins" while the appearance log says "Brady Basso". Different surname,
// no match, no id written.
function sameStarter(storedName, appearanceName) {
  if (!storedName || !appearanceName) return false;
  const a = stripSfx(normName(storedName));
  const b = stripSfx(normName(appearanceName));
  if (!a || !b) return false;
  if (a === b) return true;
  const km = Object.create(null);
  km[b] = 1;
  return fuzzyLookup(km, storedName, null) === 1;
}

const SIDES = [
  { side: 'away', teamCol: 'away_team', nameCol: 'away_sp', idCol: 'away_sp_id' },
  { side: 'home', teamCol: 'home_team', nameCol: 'home_sp', idCol: 'home_sp_id' },
];

registerBackfillTask({
  name: 'game_log_sp_id',
  run: async function ({ db, q, params, dryRun, onProgress }) {
    const from = (params && params.from) || '2026-01-01';
    const to = (params && params.to) || '2026-12-31';

    // Only rows that are missing an id AND have a name to check it against
    // or at least a team to look up. Graded is not required -- a completed
    // game with an appearance row is enough -- but the appearance log only
    // has rows for games that were played, so unplayed games fall out as
    // no_starter_row and are reported rather than treated as failures.
    const rows = db.prepare(
      'SELECT game_date, game_id, game_number, away_team, home_team, '
      + 'away_sp, home_sp, away_sp_id, home_sp_id, home_score '
      + 'FROM game_log WHERE game_date >= ? AND game_date <= ? '
      + '  AND (away_sp_id IS NULL OR home_sp_id IS NULL) '
      + 'ORDER BY game_date, game_id'
    ).all(from, to);

    const starters = db.prepare(
      'SELECT pitcher_mlb_id AS id, pitcher_name AS name FROM pitcher_game_log '
      + 'WHERE game_date = ? AND UPPER(team) = ? AND was_starter = 1 '
      + '  AND COALESCE(game_number, 1) = ? AND pitcher_mlb_id IS NOT NULL'
    );

    const upd = {};
    for (const s of SIDES) {
      upd[s.side] = db.prepare('UPDATE game_log SET ' + s.idCol + ' = ? '
        + 'WHERE game_date = ? AND game_id = ? AND ' + s.idCol + ' IS NULL');
    }

    const stats = {
      rows_examined: rows.length,
      sides_missing: 0, filled: 0,
      no_starter_row: 0, multiple_starters: 0, no_name_to_check: 0, name_mismatch: 0,
      unplayed_sides: 0,
    };
    const examples = { multiple_starters: [], name_mismatch: [], no_starter_row: [] };
    const writes = [];

    for (const r of rows) {
      const leg = r.game_number == null ? 1 : Number(r.game_number);
      for (const s of SIDES) {
        if (r[s.idCol] != null) continue;
        stats.sides_missing++;
        const team = String(r[s.teamCol] || '').toUpperCase();
        if (!team) { stats.no_starter_row++; continue; }
        const found = starters.all(r.game_date, team, leg);
        if (!found.length) {
          stats.no_starter_row++;
          if (r.home_score == null) stats.unplayed_sides++;
          if (examples.no_starter_row.length < 6) {
            examples.no_starter_row.push(r.game_date + ' ' + r.game_id + ' ' + s.side
              + (r.home_score == null ? ' (unplayed)' : ''));
          }
          continue;
        }
        if (found.length > 1) {
          stats.multiple_starters++;
          if (examples.multiple_starters.length < 6) {
            examples.multiple_starters.push(r.game_date + ' ' + r.game_id + ' ' + s.side
              + ' -> ' + found.map((f) => f.name).join(' / '));
          }
          continue;
        }
        const storedName = r[s.nameCol];
        if (!storedName) { stats.no_name_to_check++; continue; }
        if (!sameStarter(storedName, found[0].name)) {
          stats.name_mismatch++;
          if (examples.name_mismatch.length < 6) {
            examples.name_mismatch.push(r.game_date + ' ' + r.game_id + ' ' + s.side
              + ': stored "' + storedName + '" vs appearance "' + found[0].name + '"');
          }
          continue;
        }
        writes.push({ side: s.side, id: Number(found[0].id),
                      gd: r.game_date, gi: r.game_id });
        stats.filled++;
      }
    }

    onProgress({ phase: 'classified', ...stats });

    const summary = {
      task: 'game_log_sp_id',
      window: { from: from, to: to },
      stats: stats,
      fill_rate: stats.sides_missing
        ? Number((stats.filled / stats.sides_missing).toFixed(4)) : null,
      examples: examples,
    };

    if (dryRun) {
      summary.dry_run = true;
      summary.note = 'Live run writes away_sp_id / home_sp_id for the filled sides '
        + 'only, guarded by "IS NULL" so it cannot overwrite an id the feed '
        + 'supplied. name_mismatch sides are deliberately NOT written: the row and '
        + 'the appearance log disagree about who started, and an id contradicting '
        + 'the visible name is worse than a null. UNDO: UPDATE game_log SET '
        + 'away_sp_id = NULL, home_sp_id = NULL WHERE game_date >= <from>.';
      return summary;
    }

    let written = 0;
    const tx = db.transaction((ws) => {
      for (const w of ws) written += upd[w.side].run(w.id, w.gd, w.gi).changes;
    });
    tx(writes);

    const after = db.prepare(
      'SELECT COUNT(*) n, SUM(away_sp_id IS NOT NULL) a, SUM(home_sp_id IS NOT NULL) h '
      + 'FROM game_log WHERE game_date >= ? AND game_date <= ?'
    ).get(from, to);

    summary.dry_run = false;
    summary.written = written;
    summary.coverage_after = {
      games: after.n, away_sp_id_present: after.a, home_sp_id_present: after.h,
    };
    summary.verification = { writes_matched_plan: written === writes.length };
    return summary;
  },
});

module.exports = { SIDES, sameStarter };
