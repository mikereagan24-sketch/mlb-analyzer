#!/usr/bin/env node
/**
 * Roster freshness for the last-name-fallback candidates. (2026-08-30)
 *
 * THE QUESTION. q.getBullpenWoba admits a projection row when any rostered
 * RP's name ends in a space plus the candidate's surname -- the first name is
 * never checked. 22 non-roster pitchers were admitted that way, one into a
 * priced pool (CWS/Shane Smith).
 *
 * Two very different causes, and they need different fixes:
 *
 *   MATCH IS WRONG   team_rosters is current and these players genuinely are
 *                    not on the team. Fix the surname filter.
 *   ROSTER IS STALE  they ARE on the team and the roster missed them. Fix the
 *                    ingest, and treat it as a freshness gap we were not
 *                    watching. Tightening the filter here would drop a
 *                    legitimate arm.
 *
 * The discriminator is APPEARANCES: pitcher_game_log records who actually
 * threw for whom. A candidate with recent outings for the team is on the team
 * whatever the roster says. One with none is not.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { q, db } = require(path.join(R, 'db/schema'));
const mdl = require(path.join(R, 'services/model'));
const pfw = require(path.join(R, 'services/park-factors-woba'));
const jobs = require(path.join(R, 'services/jobs'));
const s = jobs.getSettings();

const DATE = process.argv[2] || '2026-08-30';
const norm = x => String(x || '').toLowerCase().normalize('NFD')
  .replace(/[^a-z ]/g, '').replace(/ +/g, ' ').trim();
const N = (v, d) => (v != null ? Number(v) : d);
const mk = t => (n, raw) => { try {
  const f = mdl.resolveNeutralizationFactor(t, s, { playerName: n, isPitcher: true });
  return f == null ? null : pfw.neutralizeWoba(raw, f);
} catch (e) { return null; } };

// ---- roster freshness --------------------------------------------------
const fr = db.prepare('SELECT MIN(updated_at) a, MAX(updated_at) b, COUNT(*) n FROM team_rosters').get();
console.log('=== ROSTER FRESHNESS ===');
console.log('  rows            : ' + fr.n);
console.log('  updated_at range: ' + fr.a + '  ->  ' + fr.b);
const ageH = (Date.now() - Date.parse(String(fr.b).replace(' ', 'T') + 'Z')) / 3600000;
console.log('  age of newest   : ' + ageH.toFixed(1) + ' h   (refresh job skips under 24h)');
console.log('  single timestamp: ' + (fr.a === fr.b ? 'YES -- full-table rewrite, not incremental' : 'no'));
console.log('');

// ---- collect the fallback-admitted candidates ---------------------------
const teams = db.prepare("SELECT DISTINCT team t FROM team_rosters WHERE role='RP' ORDER BY t").all().map(r => r.t);
const susp = [];
for (const t of teams) {
  const roster = new Set(db.prepare("SELECT player_name FROM team_rosters WHERE team=? AND role='RP'").all(t).map(r => norm(r.player_name)));
  if (!roster.size) continue;
  const res = q.getBullpenWobaBlended(t, '', [],
    N(s.BP_STRONG_WEIGHT_R, 0.55), N(s.BP_WEAK_WEIGHT_R, 0.45),
    N(s.BP_STRONG_WEIGHT_L, 0.35), N(s.BP_WEAK_WEIGHT_L, 0.65),
    N(s.W_PROJ, 0.65), N(s.W_ACT, 0.35), DATE, N(s.UNKNOWN_PITCHER_WOBA, 0.335),
    N(s.BULLPEN_MIN_BF, N(s.MIN_BF, 100)),
    !!(s.BULLPEN_DOWNWEIGHT_STARTERS === true || s.BULLPEN_DOWNWEIGHT_STARTERS === 'true'),
    N(s.BULLPEN_W_PROJ, N(s.W_PROJ, 0.65)), N(s.BULLPEN_W_ACT, N(s.W_ACT, 0.35)), 1, mk(t));
  if (!res || !res.members) continue;
  for (const m of res.members) if (!roster.has(m.name)) susp.push({ team: t, name: m.name, in_pool: m.in_pool });
}

// ---- the discriminator: did they ever pitch for that team? --------------
const apps = db.prepare(
  'SELECT COUNT(*) n, MAX(game_date) last, MIN(game_date) first FROM pitcher_game_log '
  + 'WHERE team=? AND lower(pitcher_name)=?');
const appsAny = db.prepare(
  'SELECT team, COUNT(*) n, MAX(game_date) last FROM pitcher_game_log '
  + 'WHERE lower(pitcher_name)=? GROUP BY team ORDER BY n DESC');
const rosterAny = db.prepare('SELECT team, role FROM team_rosters WHERE lower(player_name)=?');

console.log('=== THE ' + susp.length + ' FALLBACK-ADMITTED CANDIDATES ===');
console.log('');
console.log('  team  name                  priced  appsForTeam  lastApp     onAnyRoster  alsoPitchedFor');
let onTeam = 0, neverPitched = 0, elsewhere = 0;
for (const c of susp) {
  const a = apps.get(c.team, c.name);
  const anyR = rosterAny.all(c.name);
  const other = appsAny.all(c.name).filter(r => r.team !== c.team);
  if (a.n > 0) onTeam++; else neverPitched++;
  if (other.length) elsewhere++;
  console.log('  ' + c.team.padEnd(5)
    + c.name.padEnd(22)
    + (c.in_pool ? 'YES   ' : '-     ').padEnd(8)
    + String(a.n).padStart(10) + '  '
    + String(a.last || '-').padEnd(12)
    + (anyR.length ? anyR.map(r => r.team + '/' + r.role).join(',') : 'NO').padEnd(13)
    + (other.length ? other.map(r => r.team + '(' + r.n + ')').join(',') : '-'));
}

console.log('');
console.log('=== VERDICT INPUTS ===');
console.log('  candidates admitted by surname only : ' + susp.length);
console.log('  HAVE pitched for that team          : ' + onTeam + '   <- roster would be STALE/incomplete');
console.log('  have NEVER pitched for that team    : ' + neverPitched + '   <- match is WRONG');
console.log('  appear in another team log          : ' + elsewhere);
