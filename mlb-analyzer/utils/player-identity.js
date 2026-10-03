'use strict';

// WHO A wOBA ROW IS, BY ID BEFORE NAME. (2026-10-02, #473)
//
// woba_data was keyed by name alone, so two spellings of one pitcher counted
// twice in a bullpen pool and two pitchers with one spelling collapsed into
// one. The #473 measurement, all 20 duplicate-name groups:
//   6 SAME player: "Julio  Marte" / "Luis  Avila" / "Luis  Fonseca" --
//     statsapi itself stores these names with a double space, and the upload
//     stored each FanGraphs row twice (as-is, and space-collapsed by the
//     suffix stripper in routes/api.js ingestWobaCSV). Identical values.
//   14 DIFFERENT players: accent vs no accent (Rodríguez/Rodriguez TB,
//     García/Garcia NYY, Alcántara/Alcantara, ...). Two FanGraphs rows, two
//     different stat lines.
// FanGraphs sends PlayerId and MLBAMID with every row; the upload threw them
// away (routes/api.js parseCSV). It now keeps them, and this module decides
// identity: MLBAM id, then FanGraphs id, and only when a row has neither, a
// normalized name TOGETHER WITH its values -- a formatting copy of one source
// row carries identical numbers, two players do not.

const { normName } = require('./names');

// A row stored under a disambiguated name (two different ids, one name):
// "Luis Garcia #m677651 NYY". The marker sits before the team tag so the
// bullpen pool's team suffix still matches.
const ID_MARK_RE = /\s#[mf]\S+/;

function cleanMlbam(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}
function cleanFgId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '0' || /^(null|undefined|nan)$/i.test(s)) return null;
  return s;
}
// 'm<mlbam>' | 'f<fangraphs id>' | null
function idOf(r) {
  if (!r) return null;
  const m = cleanMlbam(r.mlbam_id);
  if (m) return 'm' + m;
  const f = cleanFgId(r.fg_player_id);
  return f ? 'f' + f : null;
}
function hasIdMark(name) { return ID_MARK_RE.test(String(name || '')); }
function stripIdMark(name) { return String(name || '').replace(ID_MARK_RE, ''); }
// Insert the id marker before the trailing team tag (when there is one).
function markName(name, id, team) {
  const n = String(name || '');
  const t = team ? ' ' + String(team) : '';
  if (t && n.endsWith(t)) return n.slice(0, n.length - t.length) + ' #' + id + t;
  return n + ' #' + id;
}
// The identity two rows must share to be the same player. sample is
// sample_size (stored rows) or sample (parsed upload rows).
function identityKey(r, name) {
  const id = idOf(r);
  if (id) return id;
  const sample = r.sample_size != null ? r.sample_size : (r.sample != null ? r.sample : 0);
  return 'n:' + normName(stripIdMark(name != null ? name : r.player_name)) + '|' + Number(r.woba) + '|' + Number(sample);
}
// Same player? Ids decide whenever BOTH rows have one; a row without an id is
// matched by name and values. Different ids are never the same player.
function samePlayer(a, nameA, b, nameB) {
  const ia = idOf(a), ib = idOf(b);
  if (ia && ib) return ia === ib;
  return identityKey(Object.assign({}, a, { mlbam_id: null, fg_player_id: null }), nameA)
    === identityKey(Object.assign({}, b, { mlbam_id: null, fg_player_id: null }), nameB);
}

module.exports = { cleanMlbam, cleanFgId, idOf, identityKey, samePlayer, hasIdMark, stripIdMark, markName };
