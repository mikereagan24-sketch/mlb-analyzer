'use strict';
// The near-miss classifier behind the batter wOBA-source badge.
// DISPLAY ONLY -- nothing here is read by the pricing path.
//
// WHY IT LIVES IN ITS OWN FILE. It was inlined in routes/api.js, and
// scripts/test-batter-woba-source-flags.js carried a SECOND copy, "lifted
// by BEHAVIOUR", plus an assertion that the route still contained the
// name. So the test exercised its own copy and then checked that a string
// appeared in the file it was meant to be testing. Both copies shipped the
// same bug and the test was green throughout. One definition, required by
// both, is the fix for that -- see CLAUDE.md on duplicate implementations.
//
// WHAT THE BADGE IS FOR. When a batter's actuals row does not resolve, the
// question is whether the DATA is absent (a debut, a callup -- ordinary) or
// the RESOLVER failed (a bug). The signature of a resolver failure is that
// the actuals index holds this batter's surname ON THIS TEAM, or one
// abbreviation away from his name. That state is styled to stand out; the
// ordinary one is not.
//
// THE BUG THIS FILE EXISTS TO FIX (2026-09-23). The scan was not
// team-scoped in the case that matters. It skipped a candidate whose key
// carried a DIFFERENT team tag:
//
//     if (tag && tl && tag !== tl) continue;
//
// but since #438 actuals rows are tagged only on COLLISION, so a
// non-colliding actuals row is BARE -- `tag` is null, the guard does not
// fire, and every bare same-surname row in the league passed as a near
// miss. Observed:
//
//     E. Rodriguez  [MIN]  ->  "NEAR MISS: Endy Rodriguez (same initial)"
//                              Endy Rodriguez is on PIT.
//     Bo Davidson   [SF]   ->  "NEAR MISS: Logan Davidson"
//                              not the player either.
//
// In both cases the resolver was RIGHT to find nothing. The badge then
// named a different human and pointed the reader at a resolver repair that
// was not needed. A badge whose job is to say "this looks like a bug"
// must not manufacture the appearance of one.
//
// This is the same defect class as #443 itself: a check that depends on a
// team tag being PRESENT, in a schema where tags are collision-only. The
// fix cannot be another tag test. Team membership has to come from the
// roster, which is the only thing that actually knows it.
//
// MEASURED, on every 2026 lineup slot replayed against its own date's
// snapshot -- re-run: node scripts/measure-near-miss-cross-team.js
//
//   lineup slots                        25938
//   actuals did not resolve              4026  (15.5%)
//   ...flagged NEAR MISS                  927  (23.0% of those)
//
//   tagged with THIS team                   0  ( 0.0%)
//   bare, roster places on THIS team      166  (17.9%)   real
//   bare, roster places ELSEWHERE         670  (72.3%)   cross-team
//   bare, placeable on no roster           91  ( 9.8%)
//
// SO 72.3% OF THE FLAG WAS ANOTHER TEAM'S PLAYER, and the tagged count of
// ZERO is what rules out the obvious alternative fix: requiring a matching
// team TAG would have retired the feature entirely rather than scoped it.
// Roster confirmation is the only rule that keeps the 166 and drops the 670.
//
// WHAT THE STRICT RULE COSTS, stated because it is not nothing. Dropping
// candidates placeable on NO roster removes 91 flags, and 90 of them are
// other teams' players who are simply off every 2026 roster (R. Flores ->
// wilmer flores 29x, S. Jones -> nolan jones 28x, Samad Taylor ->
// michael a taylor 15x). The 91st is real:
//
//   Bo Davidson [SF] -> chanteyon davidson    1 slot
//
// FanGraphs carries him as Chanteyon, the roster carries him as Bo, so no
// roster can confirm the actuals name-form -- the name disagreement IS the
// bug, which makes it undecidable by the only authority available. He is
// already recorded as a known unresolved with his mlb_id in
// docs/name-resolution-failures-2026-09-23.md, so the badge was not what
// was carrying him. One true positive for 670 false ones is the trade.
//
// WHAT THE 166 TURN OUT TO BE, worth knowing because they are a live
// resolver gap and not noise: four rostered players whose bare actuals key
// an abbreviated lineup name cannot reach -- W. Contreras [BOS] 73,
// B. Montgomery [CWS] 31, J. Crawford [SEA] 29, J. Rodriguez [SEA] 23.
// fuzzyLookup's abbrev+team stage matches TAGGED keys and its global
// abbrev stage needs uniqueness, so an abbreviated name plus a bare key
// plus a common surname resolves to nothing. That is a resolver question,
// not a display one, and nothing here touches it.

const { normName, stripSfx, hasTeamTag } = require('./names');

// keyMap  the actuals index fuzzyLookup just failed on
// name    the lineup's name for this batter
// team    the team the resolver searched (required -- see below)
// opts.onTeam(baseKey) -> true | false
//         membership predicate for an UNTAGGED candidate. Omit it and
//         untagged candidates are skipped, because without a roster there
//         is nothing that can confirm the team.
//
// Returns the best candidate, or null. Null means "nothing on this team
// nearly matches", which the caller renders as the ordinary no-row state
// rather than as a suspected bug.
function nearMissFor(keyMap, name, team, opts) {
  if (!keyMap) return null;
  // NO TEAM, NO SCAN. The resolver searches with a team in hand; a scan
  // that cannot be scoped the same way cannot produce a comparable
  // answer, and an unscoped surname match over the whole league is
  // precisely the false positive above. Silence beats naming a stranger.
  if (!team) return null;
  const tl = String(team).toLowerCase();
  const onTeam = opts && typeof opts.onTeam === 'function' ? opts.onTeam : null;

  const p = stripSfx(normName(name)).split(' ');
  if (p.length < 2) return null;
  const last = p[p.length - 1];
  const initial = p[0][0];

  let best = null;
  for (const key of Object.keys(keyMap)) {
    const tagged = hasTeamTag(key);
    const cut = tagged ? key.lastIndexOf(' ') : -1;
    const base = tagged ? key.slice(0, cut) : key;
    const tag = tagged ? key.slice(cut + 1) : null;
    const bp = stripSfx(base).split(' ');
    if (bp.length < 1 || bp[bp.length - 1] !== last) continue;

    // SCOPE, both branches. A tagged row has to carry THIS team's tag; an
    // untagged row has to be confirmed on this team by the roster. Anything
    // else is a different player who happens to share a surname, and there
    // are a lot of those -- Rodriguez, Garcia, Hernandez, Smith.
    let kind;
    if (tag) {
      if (tag !== tl) continue;
      kind = 'same_surname_same_team';
    } else {
      if (!onTeam || onTeam(base) !== true) continue;
      kind = 'same_surname_roster_confirmed';
    }

    const sameInitial = !!(bp[0] && bp[0][0] === initial);
    const cand = {
      key,
      team: tag || tl,
      sameInitial,
      kind,
      sample: keyMap[key] && keyMap[key].sample != null ? Number(keyMap[key].sample) : null,
    };
    // Prefer a same-initial hit, then a team-tagged one: the closer it is
    // to matching, the more it looks like a resolver failure than a
    // coincidence. Both candidates are already on this team by here, so
    // this only orders WITHIN the team.
    if (!best) best = cand;
    else if (cand.sameInitial && !best.sameInitial) best = cand;
    else if (cand.sameInitial === best.sameInitial && tag && best.kind !== 'same_surname_same_team') best = cand;
  }
  return best;
}

// Build the onTeam predicate from roster rows. Union of the DAILY active
// roster and the SEASON roster, because #450 established that the daily
// 840-row snapshot drops anyone optioned, traded or shut down -- and a
// batter's own actuals row outliving his active-roster entry is exactly
// the case the badge is asked about. A union can only widen membership,
// and the direction of that error is a missed near miss rather than a
// stranger named as one.
function rosterPredicate(rowSets) {
  const set = new Set();
  for (const rows of (rowSets || [])) {
    for (const r of (rows || [])) {
      const n = r && r.player_name != null ? normName(r.player_name) : null;
      if (n) { set.add(n); set.add(stripSfx(n)); }
    }
  }
  if (!set.size) return null;      // no roster -> caller passes no predicate
  return (base) => set.has(base) || set.has(stripSfx(base));
}

module.exports = { nearMissFor, rosterPredicate };
