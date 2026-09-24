'use strict';

// Shared name normalization + fuzzy lookup for woba_data and roster matching.
// Single source of truth — do not inline copies of this logic elsewhere.

// Characters that NFD does NOT decompose to a base + combining mark.
// Without explicit handling they survive the combining-mark strip and
// then get stripped to nothing by the [^a-z\s] filter — silently
// breaking comparisons when one side has the precomposed char and the
// other has it manually transliterated (common in scraped sources,
// e.g. lineup feed has "Bjorn" but roster has "Bjørn"). Mapping these
// before NFD lets both sides converge on the same a-z output.
//
// Coverage: Scandinavian (ø, æ), Polish (ł), German (ß), Vietnamese
// consonants (đ), Turkish (ı), French (œ). Add new entries as new
// failure modes surface; the transliteration is a one-way fold so
// over-broad entries can't break exact-match lookups that are
// already correct.
const NORM_TRANSLIT = {
  'ø': 'o',  'Ø': 'o',   // ø Ø
  'æ': 'ae', 'Æ': 'ae',  // æ Æ
  'œ': 'oe', 'Œ': 'oe',  // œ Œ
  'ß': 'ss',                  // ß
  'đ': 'd',  'Đ': 'd',   // đ Đ
  'ł': 'l',  'Ł': 'l',   // ł Ł
  'ı': 'i',  'İ': 'i',   // ı İ
};
const NORM_TRANSLIT_RE = new RegExp('[' + Object.keys(NORM_TRANSLIT).join('') + ']', 'g');

function normName(n) {
  return (n || '')
    // Translit BEFORE NFD so we hit the precomposed forms; NFD on
    // these is a no-op since they have no decomposition.
    .replace(NORM_TRANSLIT_RE, (c) => NORM_TRANSLIT[c])
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSfx(n) {
  return n.replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();
}

// A 2-3 LETTER TRAILING TOKEN IS A TEAM TAG ONLY IF IT IS ONE. (2026-09-23)
//
// Three of the stages below skip index entries that carry a team tag,
// because those are reached by the team-scoped stages instead. The test
// used to be a SHAPE -- /\s[a-z]{2,3}$/ -- which is true of any short
// trailing token, and a great many of those are not teams:
//
//   suffixes      jr (40 entries), iii (7), ii (3), iv (2)
//   surnames      lee (13), kim (12), paz (4), gil (4), oca (3), fry,
//                 cox, son, ha, woo, may, ray, ryu, oh, bae, lux, puk,
//                 baz, fox, orr, seo ... 64 distinct non-team tokens
//   FG's marker   tms, from its "6 Tms" multi-team spelling
//
// So every one of those entries was invisible to stages 6, 6.5-global
// and 7. Measured cost of the suffix half alone: "L. Gurriel" + ARI
// could not reach "Lourdes Gurriel Jr." -- 558 PA of real actuals -- and
// 48 ARI lineup slots between 2026-04-18 and 2026-09-11 priced an
// everyday hitter at the league-average default. A team-tagged entry
// survives because stage 5 matches on the tag itself; the ones that
// broke are the UNTAGGED entries, where the scans were the only route.
//
// Membership, not shape. The list is the 30 current abbreviations as
// game_log and team_rosters spell them, plus AL/NL (All-Star rows in
// game_log) and the legacy/FanGraphs spellings that older woba_data rows
// can still carry. scripts/test-team-tag-membership.js asserts it covers
// every trailing team token actually present in woba_data, so a rebrand
// or expansion team fails the test rather than silently re-opening this.
//
// UNDER-LISTING IS THE SAFE DIRECTION, and worth stating because it is
// not obvious. If a real team tag were missing from this set, the entry
// stops being excluded from the scans -- but the scans compare the
// lookup's LAST NAME against the entry's last token, and for a tagged
// entry that token is the team ("aaron judge nyy" -> "nyy"), which no
// surname matches. It becomes unreachable, exactly as it was when
// excluded. Over-listing is the harmful direction: putting a surname in
// here would re-create the bug for that surname.
const TEAM_TOKENS = new Set([
  'ari', 'ath', 'atl', 'bal', 'bos', 'chc', 'cin', 'cle', 'col', 'cws',
  'det', 'hou', 'kc', 'laa', 'lad', 'mia', 'mil', 'min', 'nym', 'nyy',
  'phi', 'pit', 'sd', 'sea', 'sf', 'stl', 'tb', 'tex', 'tor', 'was',
  // All-Star rows in game_log carry these as the "team".
  'al', 'nl',
  // Legacy + FanGraphs spellings that predate normaliseFgTeam, or that a
  // hand-built index can still hold: Oakland before ATH, Kansas City and
  // San Francisco's FG forms, and the five FG_TEAM_MAP sources.
  'oak', 'kan', 'sfg', 'kcr', 'sdp', 'tbr', 'wsn', 'chw',
]);

// Does this normalised index key end in a team tag?
function hasTeamTag(n) {
  const i = n.lastIndexOf(' ');
  if (i < 0) return false;               // single token: nothing to tag
  return TEAM_TOKENS.has(n.slice(i + 1));
}

// Fuzzy lookup against a normalized name→value map.
// Stages:
//   1. exact match on "<name> <team>"
//   2. exact match on "<name>"
//   3. stripSfx("<name>") with/without team
//   4. add each suffix (jr/sr/ii/iii/iv) with/without team
//   5. single-letter abbrev first name + team — scan entries ending in team,
//      match by initial + last name (LOOKUP-abbrev vs IDX-full)
//   6. single-letter abbrev first name — global scan, plus compound-surname
//      fallback (e.g. "s woods richardson" → try each token as last name)
//   6.5. FULL-name lookup vs ABBREV-form idx (LOOKUP-full vs IDX-abbrev,
//      symmetric to stage 5). Only fires when lookup first token is
//      multi-char (stages 5/6 handle the abbrev-first-token side). Ex:
//      "Steven Antonacci" + teamHint 'nyy' hits "s antonacci nyy" idx
//      entry. Introduced 2026-07-24 for feat/lineup-override-ui — roster
//      full-name picks were systematically defaulting when Steamer only
//      emitted the abbrev form.
//   7. stripSfx final scan, ignoring entries that end in a team tag
//   8. de-spaced FIRST name -- "Ke Bryan Hayes" vs "kebryan hayes",
//      "Ji Hwan Bae" vs "jihwan bae". Last token kept intact, so
//      compound surnames are unaffected; runs last, so it cannot
//      preempt stage 6's compound-surname fallback.
// opts (2026-09-24, stage 9 only -- every earlier stage ignores it):
//   minSample  a row below this sample cannot be a CANDIDATE in the abbrev
//              ambiguity scan. Units are the index's own `sample`, so pass it
//              only for an index where that means PA of actuals. NEVER a
//              literal at the call site -- pass MIN_PA.
//   onTeam(k)  predicate: is this normalised key a player on teamHint's
//              roster? INJECTED. This module does not and must not query a
//              database; the caller owns that.
// Omit opts and behaviour is byte-identical to before -- stage 9 does not run.
function fuzzyLookup(keyMap, name, teamHint, opts) {
  if (!keyMap) return null;
  const k = normName(name);
  const parts = k.split(' ');
  const isAbbrev = parts.length >= 2 && parts[0].length === 1;

  if (teamHint) {
    const tk = k + ' ' + teamHint.toLowerCase();
    if (keyMap[tk]) return keyMap[tk];
  }
  if (keyMap[k]) return keyMap[k];

  const kStripped = stripSfx(k);
  if (kStripped !== k) {
    if (teamHint && keyMap[kStripped + ' ' + teamHint.toLowerCase()]) return keyMap[kStripped + ' ' + teamHint.toLowerCase()];
    if (keyMap[kStripped]) return keyMap[kStripped];
  }

  for (const sfx of ['jr', 'sr', 'ii', 'iii', 'iv']) {
    if (teamHint && keyMap[k + ' ' + sfx + ' ' + teamHint.toLowerCase()]) return keyMap[k + ' ' + sfx + ' ' + teamHint.toLowerCase()];
    if (keyMap[k + ' ' + sfx]) return keyMap[k + ' ' + sfx];
  }

  if (isAbbrev && teamHint) {
    const initial = parts[0], last = parts[parts.length - 1], tl = teamHint.toLowerCase();
    const e = Object.entries(keyMap).find(([n]) => {
      if (!n.endsWith(' ' + tl)) return false;
      const base = n.slice(0, n.length - tl.length - 1).trim();
      const p = stripSfx(base).split(' ');
      return p[p.length - 1] === last && p[0] && p[0][0] === initial;
    });
    if (e) return e[1];
  }

  if (isAbbrev) {
    const initial = parts[0], last = parts[parts.length - 1];
    const matches = Object.entries(keyMap).filter(([n]) => {
      if (hasTeamTag(n)) return false;
      const p = stripSfx(n).split(' ');
      return p[p.length - 1] === last && p[0] && p[0][0] === initial;
    });
    if (matches.length === 1) return matches[0][1];

    // Compound surname fallback: for lookups like "s woods richardson", try
    // each token as last name against entries whose first initial matches.
    if (matches.length === 0 && parts.length > 2) {
      for (let wi = 1; wi < parts.length; wi++) {
        const altLast = parts[wi];
        const altMatches = Object.entries(keyMap).filter(([n]) => {
          if (hasTeamTag(n)) return false;
          const p = stripSfx(n).split(' ');
          return p[p.length - 1] === altLast && p[0] && p[0][0] === initial;
        });
        if (altMatches.length === 1) return altMatches[0][1];
      }
    }
  }

  // Stage 6.5 — symmetric to Stage 5. Lookup carries a FULL first name
  // ("Steven Antonacci") but the idx has only the abbrev form
  // ("s antonacci nyy"). Stage 5 handles the reverse direction; this
  // fills the previously-uncovered symmetric case. Mutually exclusive
  // with Stage 5/6 (this fires when NOT abbrev; they fire when isAbbrev),
  // so placement between them is inert.
  //
  // Team-scoped first (higher precision), then global with the
  // exactly-one-match guard Stage 6 uses. stripSfx on the idx-side base
  // so "s antonacci jr nyy" still matches "Steven Antonacci" + nyy
  // (base first_char='s' + last (post-stripSfx) ='antonacci').
  //
  // Additive-only: this stage runs only when every earlier stage
  // returned null, and the return value is the discovered match.
  // Every lookup that used to return a value still returns the same
  // value (earlier stages hit first, never reach here); every lookup
  // that used to return null now MIGHT return a value. No previously-
  // hitting lookup can shift to a different value.
  if (!isAbbrev && parts.length >= 2) {
    const initial = parts[0][0], last = parts[parts.length - 1];
    if (teamHint) {
      const tl = teamHint.toLowerCase();
      const e = Object.entries(keyMap).find(([n]) => {
        if (!n.endsWith(' ' + tl)) return false;
        const base = n.slice(0, n.length - tl.length - 1).trim();
        const p = stripSfx(base).split(' ');
        return p.length >= 2 && p[0].length === 1 && p[0] === initial && p[p.length - 1] === last;
      });
      if (e) return e[1];
    }
    // Global scan — require exactly-one match to avoid promoting an
    // ambiguous cross-team collision (mirrors Stage 6's exactly-one gate).
    const globalMatches = Object.entries(keyMap).filter(([n]) => {
      if (hasTeamTag(n)) return false;  // team-tagged: already tried above
      const p = stripSfx(n).split(' ');
      return p.length >= 2 && p[0].length === 1 && p[0] === initial && p[p.length - 1] === last;
    });
    if (globalMatches.length === 1) return globalMatches[0][1];
  }

  const sk = stripSfx(k);
  if (teamHint) {
    const tk2 = sk + ' ' + teamHint.toLowerCase();
    if (keyMap[tk2]) return keyMap[tk2];
  }
  const e2 = Object.entries(keyMap).find(([n]) => !hasTeamTag(n) && stripSfx(n) === sk);
  if (e2) return e2[1];

  // Stage 8 -- DE-SPACED FIRST NAME. (2026-09-23)
  //
  // A first name split differently on the two sides:
  //   "Ke Bryan Hayes"  vs  "Ke'Bryan Hayes" / "KeBryan Hayes"
  //   "Ji Hwan Bae"     vs  "Jihwan Bae"
  // normName drops the apostrophe but keeps the space, so these differ by
  // whitespace alone and no earlier stage compares them: 1-3 need equality,
  // 5/6/6.5 need one side abbreviated to a single character, and 7 needs
  // exact equality after suffix-stripping.
  //
  // Canonical form joins every token except the last with no spaces, then
  // the last token: "kebryan hayes". This is a NORMALIZATION question, not
  // an aliasing one -- the two strings are the same name -- which is why it
  // is a stage rather than a lookup table.
  //
  // WHY IT IS SAFE TO DE-SPACE THE FIRST NAME BUT NOT THE SURNAME. The
  // canonical form keeps the LAST token intact, so compound surnames never
  // converge: "simeon woods richardson" -> "simeonwoods richardson" and
  // "s woods richardson" -> "swoods richardson", which do not match. Stage
  // 6's compound-surname fallback is therefore untouched, and this stage
  // runs only after every earlier stage returned null, so it cannot
  // preempt it. Both properties are pinned by
  // scripts/test-resolver-despaced-first-name.js.
  //
  // MEASURED over every 2026 lineup lookup (160,200 across 40,050 slots),
  // shipped resolver against this one:
  //
  //   identical 151789   GAINED 11   LOST 0   CHANGED 0
  //
  // The 11 are the two cases above and nothing else. The real index holds
  // 89 canonical-form collisions, and every one is the expansion's own
  // suffixed/stripped pair for the SAME player -- identical wOBA on both
  // rows -- so zero genuinely different players collide. Re-run:
  //   node --max-old-space-size=1536 scripts/test-resolver-despaced-first-name.js
  const canonFirst = (n) => {
    const p = stripSfx(n).split(' ');
    if (p.length < 2) return null;
    return p.slice(0, -1).join('') + ' ' + p[p.length - 1];
  };
  const ck = canonFirst(k);
  if (ck) {
    if (teamHint) {
      const tl2 = teamHint.toLowerCase();
      const hit = Object.entries(keyMap).find(([n]) => {
        if (!n.endsWith(' ' + tl2)) return false;
        return canonFirst(n.slice(0, n.length - tl2.length - 1).trim()) === ck;
      });
      if (hit) return hit[1];
    }
    // Global scan takes the exactly-one gate stages 6 and 6.5 use, so an
    // ambiguous canonical form is refused rather than guessed.
    const g = Object.entries(keyMap).filter(([n]) => !hasTeamTag(n) && canonFirst(n) === ck);
    if (g.length === 1) return g[0][1];
  }

  // Stage 9 -- ABBREVIATION AMBIGUITY, broken by SAMPLE then by ROSTER.
  // (2026-09-24)
  //
  // WHAT IT IS FOR. Stage 6 scans globally for an abbreviated first name and
  // returns a hit only on an EXACTLY-ONE match, so two candidates sharing a
  // surname and an initial produce null and the batter falls to the
  // projection alone. Measured over every 2026 lineup slot: 752 slots hit
  // that, 3.6% of all abbreviated names, and the causes are not equal:
  //
  //   194  one real player + a SUB-THRESHOLD row
  //          88  J. Rodriguez [SEA]  jesus(41PA) + julio(977PA, own team)
  //          30  E. Rodriguez [PIT]  emmanuel(27PA) + endy(176PA, own team)
  //          18  A. Garcia [PHI]     adolis(219PA, own team) + aramis(5PA)
  //   551  two REAL players, on DIFFERENT teams
  //          96  J. Crawford [PHI]   jp(767PA) + justin(387PA, own team)
  //          87  W. Contreras [MIL]  william(933PA, own) + willson(807PA)
  //     0  two real players on the SAME team -- this does not occur
  //     7  no candidate clears the threshold at all
  //
  // ADDITIVE-ONLY, AND STRUCTURALLY SO. This runs only after every earlier
  // stage has returned null, and its only possible outcome is null -> a
  // value. No lookup that already resolved can reach it, so it cannot change
  // a value or lose one: LOST = 0 and CHANGED = 0 are properties of the
  // placement, not merely measured. Same argument stage 6.5 and stage 8 make
  // for themselves.
  //
  // RULE 1, minSample: a row below the CONSUMER's own gate cannot contribute
  // a term -- blendWoba requires act.sample >= minPA -- so it must not be
  // able to break a match for a player who can. It is excluded from
  // candidacy, not from the index: the row still exists and the card can
  // still say "act gated, N PA". What changes is what COMPETES, not what
  // exists. The filter never empties the set; if every candidate is
  // sub-threshold the scan is left ambiguous rather than guessing.
  //
  // RULE 2, onTeam: where the scan is still ambiguous, take the lone
  // candidate the caller's roster places on this team. W. Contreras is the
  // case that proves only the team can do it -- MIL needs Willson excluded
  // and BOS needs William excluded, so the SAME pair resolves opposite ways
  // and no uniqueness rule could ever decide it. The predicate only ever
  // breaks a tie among keys that already matched; it never rejects a match
  // that would otherwise have succeeded, which is what separates it from the
  // 2026-07-23 roster gate that had to be disabled after two incidents.
  if (isAbbrev && opts && (opts.minSample != null || typeof opts.onTeam === 'function')) {
    const initial9 = parts[0], last9 = parts[parts.length - 1];
    let c9 = Object.entries(keyMap).filter(([n]) => {
      if (hasTeamTag(n)) return false;
      const p = stripSfx(n).split(' ');
      return p[p.length - 1] === last9 && p[0] && p[0][0] === initial9;
    });
    // Reaching here means stage 6 found 0 or >1; a single match would have
    // returned there. So the length-1 check below is rule 1 doing its work.
    if (c9.length > 1 && opts.minSample != null) {
      const ms = Number(opts.minSample);
      if (isFinite(ms)) {
        const usable = c9.filter(([, v]) => v && Number(v.sample) >= ms);
        if (usable.length) c9 = usable;
      }
    }
    if (c9.length === 1) return c9[0][1];
    if (c9.length > 1 && typeof opts.onTeam === 'function') {
      const own = c9.filter(([n]) => {
        try { return opts.onTeam(n) === true || opts.onTeam(stripSfx(n)) === true; }
        catch (e) { return false; }
      });
      if (own.length === 1) return own[0][1];
    }
  }
  return null;
}

module.exports = { normName, stripSfx, fuzzyLookup, TEAM_TOKENS, hasTeamTag };
