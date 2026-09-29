'use strict';

// Fixed 2026 team maps for the trends backtest -- docs/trends-preregistration-
// 2026-09-29.md §5 says they are "committed with the backtest", and these are
// those maps. Abbreviations are game_log's own. AL / NL (the All-Star Game) are
// deliberately absent: that game is not a team's game, and the backtest drops
// it (an implementation note in the run report, per §9).

// One IANA zone per team: the home ballpark's local time, for day/night (S20,
// S31). ATH plays in Sacramento -> America/Los_Angeles, as the doc states.
const TEAM_TZ = {
  ARI: 'America/Phoenix',
  ATH: 'America/Los_Angeles', LAA: 'America/Los_Angeles', LAD: 'America/Los_Angeles',
  SD: 'America/Los_Angeles', SF: 'America/Los_Angeles', SEA: 'America/Los_Angeles',
  COL: 'America/Denver',
  CHC: 'America/Chicago', CWS: 'America/Chicago', HOU: 'America/Chicago', KC: 'America/Chicago',
  MIL: 'America/Chicago', MIN: 'America/Chicago', STL: 'America/Chicago', TEX: 'America/Chicago',
  ATL: 'America/New_York', BAL: 'America/New_York', BOS: 'America/New_York', CIN: 'America/New_York',
  CLE: 'America/New_York', DET: 'America/Detroit', MIA: 'America/New_York', NYM: 'America/New_York',
  NYY: 'America/New_York', PHI: 'America/New_York', PIT: 'America/New_York', TB: 'America/New_York',
  WAS: 'America/New_York',
  TOR: 'America/Toronto',
};

// 2026 alignment.
const DIVISION = {
  BAL: 'AL East', BOS: 'AL East', NYY: 'AL East', TB: 'AL East', TOR: 'AL East',
  CLE: 'AL Central', CWS: 'AL Central', DET: 'AL Central', KC: 'AL Central', MIN: 'AL Central',
  ATH: 'AL West', HOU: 'AL West', LAA: 'AL West', SEA: 'AL West', TEX: 'AL West',
  ATL: 'NL East', MIA: 'NL East', NYM: 'NL East', PHI: 'NL East', WAS: 'NL East',
  CHC: 'NL Central', CIN: 'NL Central', MIL: 'NL Central', PIT: 'NL Central', STL: 'NL Central',
  ARI: 'NL West', COL: 'NL West', LAD: 'NL West', SD: 'NL West', SF: 'NL West',
};
const leagueOf = (t) => (DIVISION[t] || '').slice(0, 2) || null;
const isTeam = (t) => Object.prototype.hasOwnProperty.call(DIVISION, t);

// Local wall-clock of a UTC instant in a zone: { date: 'YYYY-MM-DD', hour, minute }.
const _fmtCache = {};
function localParts(utcIso, tz) {
  if (!utcIso || !tz) return null;
  const d = new Date(utcIso);
  if (isNaN(d.getTime())) return null;
  const f = _fmtCache[tz] || (_fmtCache[tz] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const p = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { date: p.year + '-' + p.month + '-' + p.day, hour: Number(p.hour), minute: Number(p.minute) };
}

module.exports = { TEAM_TZ, DIVISION, leagueOf, isTeam, localParts };
