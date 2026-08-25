'use strict';
/**
 * Park factors: sourced, dated, and stored in a table. (2026-08-25)
 *
 * WHY THIS EXISTS. `PARK_FACTORS` was a 30-team object literal in
 * services/scraper.js, last touched 2026-04-19, carrying a comment that
 * named FanGraphs as its source. It was not FanGraphs — the FG `3yr`
 * column matches 4 of 30 today. It was not Baseball Savant R either: 6 of
 * 30 on the best of twelve windows swept. **The live values matched no
 * source that could be pulled.** Recovering even the pull DATE took a
 * `git log -S`.
 *
 * So the values are replaced not as a restoration but as a DELIBERATE
 * CHOICE, on the merits: the term multiplies a RUN estimate, and Savant's
 * `index_runs` is a runs factor, while Savant's headline "Park Factor"
 * column and FanGraphs' `3yr` are wOBA-style composite offensive indices.
 * They differ substantially — COL 112 composite vs 125 runs, TEX 93 vs 86,
 * SEA 92 vs 85 — so the column choice is not cosmetic.
 *
 * THE MEASUREMENT THAT BACKED THE CHOICE (totals target, n=352):
 *
 *   arm              MAE      RMSE     level     d MAE    d RMSE   d level
 *   production      3.4477   4.4699   -0.5752
 *   FanGraphs 3yr   3.4206   4.4281   -0.6402  -0.0270   -0.0419   -0.0650
 *   Savant R 24-26  3.4089   4.4183   -0.5827  -0.0387   -0.0516   -0.0075
 *
 * Savant R beats FanGraphs on dispersion AND barely touches the level,
 * where FanGraphs worsens an already-negative bias.
 *
 * DO NOT EVALUATE A PARK-FACTOR CHANGE ON THE ML TARGET. A park factor
 * multiplies BOTH teams' run estimates by the same number, so it moves the
 * total and leaves the win-probability ratio almost untouched: the
 * measured mean |dp(home)| for the FanGraphs swap was 0.00028, an order of
 * magnitude below a flag that was already unresolvable at n=349. The ML
 * A/B is STRUCTURALLY BLIND here and will report "not significant" no
 * matter how wrong the factors are. Totals only.
 */
const fetch = require('node-fetch');

// The exact query, recorded because a comment that named a source without
// its parameters is what put us here. Changing any of these changes the
// numbers, so they are constants rather than call-site arguments.
const SOURCE_NAME = 'baseball_savant_index_runs';
const SOURCE_BASE = 'https://baseballsavant.mlb.com/leaderboard/statcast-park-factors';
const SOURCE_PARAMS = {
  type: 'year',
  year: '2026',        // season anchoring the rolling window
  batSide: '',         // empty = BOTH
  stat: 'index_R',     // selects the runs column; NOT the composite
  condition: 'All',
  rolling: '3',        // 3-year window -> year_range 2024-2026
};
function sourceUrl(params) {
  const p = Object.assign({}, SOURCE_PARAMS, params || {});
  return SOURCE_BASE + '?' + Object.keys(p).map(k => k + '=' + p[k]).join('&');
}
function paramString(params) {
  const p = Object.assign({}, SOURCE_PARAMS, params || {});
  return Object.keys(p).map(k => k + '=' + (p[k] === '' ? '(both)' : p[k])).join(', ');
}

// Savant labels clubs by display name; the rest of the codebase keys on
// the uppercase abbreviations the scraper produces.
const CLUB_TO_ABBR = {
  'Angels': 'LAA', 'Orioles': 'BAL', 'Red Sox': 'BOS', 'White Sox': 'CWS',
  'Guardians': 'CLE', 'Tigers': 'DET', 'Royals': 'KC', 'Twins': 'MIN',
  'Yankees': 'NYY', 'Athletics': 'ATH', 'Mariners': 'SEA', 'Rays': 'TB',
  'Rangers': 'TEX', 'Blue Jays': 'TOR', 'D-backs': 'ARI', 'Diamondbacks': 'ARI',
  'Braves': 'ATL', 'Cubs': 'CHC', 'Reds': 'CIN', 'Rockies': 'COL',
  'Marlins': 'MIA', 'Astros': 'HOU', 'Dodgers': 'LAD', 'Brewers': 'MIL',
  'Nationals': 'WAS', 'Mets': 'NYM', 'Phillies': 'PHI', 'Pirates': 'PIT',
  'Cardinals': 'STL', 'Padres': 'SD', 'Giants': 'SF',
};

// Every team that must resolve. A missing entry silently becoming 1.0 is
// the failure mode this table is most prone to, so this list is the
// assertion's reference and not merely documentation.
const REQUIRED_TEAMS = [
  'ARI', 'ATH', 'ATL', 'BAL', 'BOS', 'CHC', 'CIN', 'CLE', 'COL', 'CWS',
  'DET', 'HOU', 'KC', 'LAA', 'LAD', 'MIA', 'MIL', 'MIN', 'NYM', 'NYY',
  'PHI', 'PIT', 'SD', 'SEA', 'SF', 'STL', 'TB', 'TEX', 'TOR', 'WAS',
];

/**
 * Manual overrides, each with the reason recorded. An override with no
 * reason is how the last set became unsourced.
 *
 * ONLY ONE SURVIVES the move to Savant, and the other three were dropped
 * for stated reasons rather than carried forward:
 *
 *   KC 1.02  — dropped. It existed because FanGraphs had not absorbed the
 *              2024 fence move-in. Savant R gives 1.02 directly.
 *   TB 0.95  — dropped. It existed because a 3-year window averaged in the
 *              2025 Steinbrenner season. SAVANT KEYS BY VENUE: the Rays row
 *              is venue 12 "Tropicana Field" with n_pa 33,312 against a
 *              52,362 median, i.e. two Tropicana seasons and zero
 *              Steinbrenner. The contamination the override existed to fix
 *              is already absent, so the override is now a hand-tuned
 *              number with no rationale. Savant R gives 0.94.
 *   Mexico City 1.20 — untouched. It lives in model.js VENUE_ID_OVERRIDES
 *              keyed on venue 5340, bypasses this table entirely, and fired
 *              on 2 games this season.
 */
const MANUAL = {
  ATH: {
    factor: 1.19,
    reason: 'Savant has NO ATHLETICS ROW on any window (checked 2023-2026 x '
          + 'rolling 1/2/3). Savant keys park factors by VENUE, and the club '
          + 'left Oakland Coliseum for Sutter Health Park, which has no '
          + 'qualifying multi-season sample. So this is not a preference over '
          + 'Savant — there is nothing to prefer. 1.19 is carried from the '
          + 'prior table, corroborated by FanGraphs whose 3yr (112) still '
          + 'averages in Coliseum years while its 1yr (121) is Sutter Health '
          + 'alone; 1.19 sits between. REVISIT when Savant lists the venue.',
  },
};

/**
 * Fetch and parse. Savant serves the leaderboard as HTML with the rows in
 * a `var data = [...]` blob; the documented `csv=true` is not honoured on
 * this endpoint (returns the HTML page).
 */
async function fetchSavantParkFactors(params) {
  const url = sourceUrl(params);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,*/*',
    },
  });
  if (!resp.ok) throw new Error('savant park-factors fetch ' + resp.status);
  const text = await resp.text();
  const m = text.match(/var\s+data\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error('savant park-factors: no `var data` blob (page shape changed?)');

  let arr;
  try { arr = JSON.parse(m[1]); }
  catch (e) { throw new Error('savant park-factors: data blob is not JSON — ' + e.message); }

  const out = [];
  const unmapped = [];
  for (const r of arr) {
    const abbr = CLUB_TO_ABBR[r.name_display_club];
    if (!abbr) { unmapped.push(r.name_display_club); continue; }
    const idx = Number(r.index_runs);
    if (!isFinite(idx) || idx <= 0) continue;
    out.push({
      team: abbr,
      factor: idx / 100,
      venue_id: r.venue_id != null ? Number(r.venue_id) : null,
      venue_name: r.venue_name || null,
      n_pa: r.n_pa != null ? Number(r.n_pa) : null,
      year_range: r.year_range || null,
    });
  }
  // An unmapped club is a silent drop, and a silent drop becomes a 1.0.
  if (unmapped.length) {
    throw new Error('savant park-factors: unmapped club name(s) ' + JSON.stringify(unmapped)
      + ' — add them to CLUB_TO_ABBR rather than letting the team fall through to 1.0');
  }
  return { rows: out, url, params: paramString(params) };
}

/**
 * THE ASSERTION. Every required team must resolve to a real number. A
 * missing row silently becoming 1.0 is the failure this table is most
 * prone to: 1.0 is a plausible-looking value, it is the neutral park, and
 * nothing downstream can distinguish "neutral park" from "no data".
 *
 * Returns {ok, missing, suspicious}. Never throws — callers decide.
 */
function assertAllTeamsResolve(byTeam) {
  const missing = REQUIRED_TEAMS.filter(t => {
    const v = byTeam[t];
    return v == null || !isFinite(Number(v.factor)) || Number(v.factor) <= 0;
  });
  // A factor of exactly 1.0 is legitimate but is also what the old
  // `|| 1.0` fallback produced, so it is worth naming rather than trusting.
  const suspicious = REQUIRED_TEAMS.filter(t => byTeam[t] && Number(byTeam[t].factor) === 1
    && byTeam[t].source !== 'manual');
  return { ok: missing.length === 0, missing, suspicious, checked: REQUIRED_TEAMS.length };
}

// Cached table read, shared by the SCRAPER (write path) and the MODEL
// (read path). One home, because two cached copies would drift and this
// is the value that decides whether a game prices on a real park.
// Per-process; a restart or an explicit force picks up the monthly refresh.
let _cache = null;
function loadParkFactors(force) {
  if (_cache && !force) return _cache;
  const out = {};
  try {
    const { q } = require('../db/schema');
    for (const r of q.listParkFactors.all()) {
      if (r && r.team && isFinite(r.factor) && r.factor > 0) out[r.team] = r.factor;
    }
  } catch (e) {
    console.error('[park-factor] could not read park_factors: ' + (e && e.message));
  }
  _cache = out;
  return out;
}

module.exports = {
  fetchSavantParkFactors, assertAllTeamsResolve, loadParkFactors,
  SOURCE_NAME, SOURCE_BASE, SOURCE_PARAMS, sourceUrl, paramString,
  CLUB_TO_ABBR, REQUIRED_TEAMS, MANUAL,
};
