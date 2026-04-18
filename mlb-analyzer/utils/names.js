'use strict';

// Shared name normalization + fuzzy lookup for woba_data and roster matching.
// Single source of truth — do not inline copies of this logic elsewhere.

function normName(n) {
  return (n || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSfx(n) {
  return n.replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();
}

// Fuzzy lookup against a normalized name→value map.
// Stages:
//   1. exact match on "<name> <team>"
//   2. exact match on "<name>"
//   3. stripSfx("<name>") with/without team
//   4. add each suffix (jr/sr/ii/iii/iv) with/without team
//   5. single-letter abbrev first name + team — scan entries ending in team,
//      match by initial + last name
//   6. single-letter abbrev first name — global scan, plus compound-surname
//      fallback (e.g. "s woods richardson" → try each token as last name)
//   7. stripSfx final scan, ignoring entries with a 2-3 letter team-like suffix
function fuzzyLookup(keyMap, name, teamHint) {
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
      if (/\s[a-z]{2,3}$/.test(n)) return false;
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
          if (/\s[a-z]{2,3}$/.test(n)) return false;
          const p = stripSfx(n).split(' ');
          return p[p.length - 1] === altLast && p[0] && p[0][0] === initial;
        });
        if (altMatches.length === 1) return altMatches[0][1];
      }
    }
  }

  const sk = stripSfx(k);
  if (teamHint) {
    const tk2 = sk + ' ' + teamHint.toLowerCase();
    if (keyMap[tk2]) return keyMap[tk2];
  }
  const e2 = Object.entries(keyMap).find(([n]) => !/\s[a-z]{2,3}$/.test(n) && stripSfx(n) === sk);
  return e2 ? e2[1] : null;
}

module.exports = { normName, stripSfx, fuzzyLookup };
