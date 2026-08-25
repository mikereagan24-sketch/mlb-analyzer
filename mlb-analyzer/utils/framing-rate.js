'use strict';
/**
 * Catcher-framing rate lookup and precedence. (2026-08-24)
 *
 * ONE implementation. There were NINE copies of this precedence:
 *
 *   services/frv-backtest.js            services/temp-backtest.js
 *   services/baserunning-backtest.js    services/under-selection-diagnostic.js
 *   services/runmult-totals-backtest.js scripts/framing-frv-per-team-runs.js
 *   scripts/framing-frv-hindsight-backtest.js
 *   scripts/backtest-run-environment.js  (renamed vars, missed on pass one)
 *   services/jobs.js                     (inline, inside `findCatcher`)
 *
 * An earlier note in this repo said "five times verbatim". That was an
 * undercount, and the first sweep here reproduced it — grepping for
 * `min2026` found seven and missed the two that had renamed the constant.
 * A second sweep on THREE different keys (`getCatcherFramingById`, the
 * rate expression, `CATCHER_FRAMING_ABS_FACTOR`) found the rest. When a
 * duplicate can rename its locals, one grep is a sample, not a census.
 *
 * Every one of the nine carried the same bug described below, and fixing
 * any one of them would have left eight.
 *
 * THE BUG THIS FIXES. The precedence was:
 *
 *     current-season row with pitches >= floor  ->  use it
 *     else historical 2023-25 row               ->  use it x absFactor
 *     else                                      ->  null
 *
 * The floor checks VOLUME and nothing else. A row that stopped updating
 * keeps its pitch count, so it keeps clearing the floor forever — and
 * therefore keeps OUTRANKING a perfectly valid three-year baseline.
 *
 * On 2026-08-24 that was live: T. d'Arnaud started for LAA priced on a
 * rate last written 2026-05-21, from 946 pitches, because 946 >= 750 and
 * nothing asked how old the 946 was. A three-month-old partial-season
 * rate beat a three-season aggregate. That is the worst ordering
 * available, and it is silent.
 *
 * WHY THE DELETE-GUARD IS NOT SUFFICIENT ON ITS OWN. utils/prune-missing.js
 * removes rows absent from a fetch — but it only runs WHEN A FETCH
 * SUCCEEDS. The 82 days this table sat frozen were 82 days with no fetch
 * at all, so no prune, so nothing to remove the stale rows. The guard
 * protects against a catcher leaving the leaderboard; it does nothing
 * about the ingest itself stopping. The age check covers the second case,
 * and it covers it at READ time, which is the only place that can be
 * correct regardless of what the writer did.
 *
 * FRESHNESS APPLIES TO THE CURRENT-SEASON ROW ONLY. The historical
 * baseline is a 2023-25 aggregate; it is *supposed* to be old, and its
 * age carries no information about whether it is right. Age-gating it
 * would delete the fallback for everyone.
 */

// Days after which a current-season row stops outranking the historical
// baseline.
//
// DELIBERATELY A CONSTANT, NOT A SETTING, even though every sibling knob
// (MIN_PITCHES, TAKES_PER_GAME, ABS_FACTOR) is one. This is a CORRECTNESS
// GUARD, not a tuning parameter: its only job is to stop a stale row
// winning silently, and there is no legitimate operating regime in which
// raising it helps. Making it settable would put "reinstate the
// 2026-08-24 defect" one text box away, and the settings page has no
// framing controls at all today, so exposing it would mean shipping the
// first one for a value nobody should turn.
//
// 30 days, and the reasoning is measurable rather than
// aesthetic: on the 2026-08-24 refresh the median catcher's rate moved
// 0.0185 runs/game over ~11 weeks against a mean |value| of 0.0480, and
// 10 of 53 changed SIGN. Scaled down, a month of drift is small relative
// to the x0.80 haircut the historical fallback already takes, while three
// months is not. Below the threshold, prefer the season; above it, prefer
// the stable aggregate.
const DEFAULT_MAX_AGE_DAYS = 30;

function ageInDays(updatedAt, nowMs) {
  if (!updatedAt) return null;
  // catcher_framing.updated_at is written by SQL datetime('now') => UTC.
  // Parse explicitly as UTC rather than letting the runtime guess, per the
  // timestamp discipline in CLAUDE.md — a local-time reading would shift
  // the age by the offset and, near the threshold, flip the decision.
  const s = String(updatedAt).trim().replace(' ', 'T');
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
  if (!isFinite(ms)) return null;
  return (nowMs - ms) / 86400000;
}

/**
 * @param q         the shared db/schema query object (never opens its own handle)
 * @param mlbId     resolved catcher mlb_id
 * @param settings  getSettings() output
 * @param opts      {nowMs, maxAgeDays} for tests only
 * @returns {{rv:number|null, source:string, detail:string}}
 *          source: 'current' | 'historical' | 'none'
 */
function framingRateForCatcher(q, mlbId, settings, opts) {
  const o = opts || {};
  const nowMs = o.nowMs != null ? o.nowMs : Date.now();
  const s = settings || {};
  const num = (v, d) => {
    if (v == null || v === '') return d;
    const n = Number(v);
    return isNaN(n) ? d : n;
  };
  const minPitches = num(s.CATCHER_FRAMING_MIN_PITCHES_2026, 750);
  const takesPerGame = num(s.CATCHER_FRAMING_TAKES_PER_GAME, 58);
  const absFactor = num(s.CATCHER_FRAMING_ABS_FACTOR, 0.80);
  // opts.maxAgeDays exists for tests only; production always uses the constant.
  const maxAgeDays = o.maxAgeDays != null ? Number(o.maxAgeDays) : DEFAULT_MAX_AGE_DAYS;

  const rate = (rvTot, pitches) => {
    if (!pitches || pitches <= 0) return null;
    return (rvTot / pitches) * takesPerGame;
  };

  if (!q || !q.getCatcherFramingById || !mlbId) {
    return { rv: null, source: 'none', detail: 'no lookup available' };
  }

  const row = q.getCatcherFramingById.get(mlbId);
  if (row && row.pitches >= minPitches) {
    const age = ageInDays(row.updated_at, nowMs);
    // A row with no timestamp is treated as STALE, not as fresh. Failing
    // open here would reproduce the exact defect for any row predating
    // the column, and the fallback is a real value rather than nothing.
    if (age == null) {
      // fall through, detail recorded below
    } else if (age <= maxAgeDays) {
      const r = rate(row.rv_tot, row.pitches);
      if (r != null) {
        return { rv: r, source: 'current',
                 detail: row.pitches + 'p, ' + age.toFixed(1) + 'd old' };
      }
    } else {
      // Recorded as its own outcome so a caller can log it. This is the
      // case that used to win silently.
      const h0 = q.getCatcherFramingHistById && q.getCatcherFramingHistById.get(mlbId);
      if (h0 && h0.pitches > 0) {
        const r0 = rate(h0.rv_tot, h0.pitches);
        if (r0 != null) {
          return { rv: r0 * absFactor, source: 'historical',
                   detail: 'current row is ' + age.toFixed(0) + 'd old (> '
                     + maxAgeDays + 'd) — using the 2023-25 baseline x' + absFactor };
        }
      }
      return { rv: null, source: 'none',
               detail: 'current row is ' + age.toFixed(0) + 'd old (> ' + maxAgeDays
                 + 'd) and there is no historical baseline' };
    }
  }

  if (q.getCatcherFramingHistById) {
    const h = q.getCatcherFramingHistById.get(mlbId);
    if (h && h.pitches > 0) {
      const r = rate(h.rv_tot, h.pitches);
      if (r != null) {
        return { rv: r * absFactor, source: 'historical',
                 detail: row
                   ? (row.updated_at ? 'current row below the ' + minPitches + '-pitch floor'
                                     : 'current row has no updated_at — treated as stale')
                   : 'no current-season row' };
      }
    }
  }
  return { rv: null, source: 'none', detail: 'no current-season or historical row' };
}

module.exports = { framingRateForCatcher, ageInDays, DEFAULT_MAX_AGE_DAYS };
