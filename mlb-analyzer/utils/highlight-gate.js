// THE HIGHLIGHT GATE. One implementation, shared by the server harnesses
// and the browser. (2026-09-17)
//
// WHAT IT IS NOT: this is not on the pricing path and never was. Emission is
// governed by SIGNAL_EMIT_FLOOR_PP in services/model.js getSignals; nothing
// server-side gates a price, a signal write, or a bet on "highlighted". This
// gate decides (a) what the card colours green and (b) which rows land in a
// harness's above-UI-floor reporting bucket. scripts/rank-parallel-
// implementations.js used to classify it as PRICING because its regex treats
// all of utils/ that way; that classification is corrected there.
//
// WHY ONE FILE: there were EIGHT call sites with four threshold loaders --
// four backtest harnesses (settings-driven, decimal thresholds) and four in
// public/index.html (one HARDCODED 2.0/4.5/7.0, three settings-driven x100).
// They agreed only because prod app_settings happened to equal the
// hardcoded numbers; an operator changing a setting would have moved the
// harnesses and three of the four client sites, and left the game card
// behind. Measured before the change: prod fav 0.02 / dog 0.045 /
// under 0.07 / overs false, identical to the client literals.
//
// TWO LAYERS, and the split is the point:
//
//   highlightsOnFrozenEdge  the CORE. Thresholds, 0.5pp rounding, direction
//                           from the frozen emit-time market line, overs
//                           gated. This is what the harnesses can replay,
//                           because it needs nothing but the stored signal.
//
//   highlightsForDisplay    the core plus two things only a live card has:
//                           the legacy star-label bypass (2*/3* highlight,
//                           1* never) and, for ML, the CURRENT edge compared
//                           RAW. The card prints that live figure, so
//                           rounding it would light a box that reads 1.8pp.
//
// A harness CANNOT evaluate the display layer: there is no history of the
// market as it stood when the operator looked. That asymmetry is why the
// bucket these harnesses report is named above_ui_floor and not "bet" --
// and why by_category_bet (keyed on bet_line IS NOT NULL) exists beside it.
//
// Loadable both ways: require() on the server, <script src="/highlight-gate.js">
// in the browser (served by server.js from this exact file -- no copy).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HighlightGate = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Defaults match services/settings-schema.js. Also the client fallback
  // before /api/settings has loaded, so a cold card behaves like prod.
  var DEFAULTS = { fav_min_pp: 0.02, dog_min_pp: 0.045, under_min_pp: 0.07, overs_enabled: false };

  var KEYS = {
    fav_min_pp: 'ui_highlight_ml_fav_min_pp',
    dog_min_pp: 'ui_highlight_ml_dog_min_pp',
    under_min_pp: 'ui_highlight_tot_under_min_pp',
    overs_enabled: 'ui_highlight_tot_overs_enabled',
  };

  function truthy(v) { return v === true || v === 'true' || v === '1' || v === 1; }

  // Accepts anything shaped like app_settings: the object /api/settings
  // returns, or a { key: value } map built from rows. Missing or
  // unparseable values fall back to the schema default rather than to 0 --
  // a 0 threshold would highlight everything.
  function thresholdsFrom(settings) {
    var s = settings || {};
    var out = {};
    ['fav_min_pp', 'dog_min_pp', 'under_min_pp'].forEach(function (k) {
      var raw = s[KEYS[k]];
      var n = raw == null || raw === '' ? NaN : Number(raw);
      out[k] = isFinite(n) && n > 0 ? n : DEFAULTS[k];
    });
    out.overs_enabled = s[KEYS.overs_enabled] == null
      ? DEFAULTS.overs_enabled : truthy(s[KEYS.overs_enabled]);
    return out;
  }

  // Server-side load straight from app_settings. Kept here so the four
  // harnesses stop carrying a loader each.
  function loadThresholds(db) {
    var map = {};
    try {
      var rows = db.prepare(
        'SELECT key, value FROM app_settings WHERE key IN ('
        + "'" + KEYS.fav_min_pp + "','" + KEYS.dog_min_pp + "',"
        + "'" + KEYS.under_min_pp + "','" + KEYS.overs_enabled + "')"
      ).all();
      for (var i = 0; i < rows.length; i++) map[rows[i].key] = rows[i].value;
    } catch (e) { /* table missing -> defaults */ }
    return thresholdsFrom(map);
  }

  // edge*200 -> round -> /200 rounds to the nearest 0.005 (0.5pp). The
  // settings-schema note is the reason: "comparison is against the ROUNDED
  // 0.5pp score, not the raw edge, so the UI display and highlight
  // condition stay consistent."
  function roundedEdge(edge) { return Math.round(Number(edge) * 200) / 200; }
  function roundedScorePp(edge) { return Math.round(Number(edge) * 100 / 0.5) * 0.5; }

  // TWO NAMING SHAPES, ONE READER. Harness signals are
  // { type, side, edge, marketLine }; stored rows are
  // { signal_type, signal_side, edge_pct, market_line, signal_label }.
  function normalize(sig) {
    if (!sig) return null;
    var type = sig.type != null ? sig.type : sig.signal_type;
    var side = sig.side != null ? sig.side : sig.signal_side;
    var edge = sig.edge != null ? sig.edge : sig.edge_pct;
    var line = sig.marketLine != null ? sig.marketLine : sig.market_line;
    return {
      isMl: String(type).toUpperCase() === 'ML',
      side: side == null ? null : String(side).toLowerCase(),
      edge: Number(edge),
      line: line == null ? null : Number(line),
      label: sig.signal_label,
    };
  }

  // THE CORE. Frozen emit-time edge, rounded; direction from the frozen
  // line. marketLine === 0 is not a direction, so it does not highlight --
  // the client already behaved this way, the harnesses sent it down the dog
  // branch. 0 rows in production carry it; this picks the safer reading.
  function highlightsOnFrozenEdge(sig, t) {
    var n = normalize(sig);
    if (!n || !isFinite(n.edge)) return false;
    var thr = t || DEFAULTS;
    var rounded = roundedEdge(n.edge);
    if (n.isMl) {
      if (n.line == null || !isFinite(n.line) || n.line === 0) return false;
      return n.line < 0 ? rounded >= thr.fav_min_pp : rounded >= thr.dog_min_pp;
    }
    if (n.side === 'over') return !!thr.overs_enabled;
    if (n.side === 'under') return rounded >= thr.under_min_pp;
    return false;
  }

  // THE DISPLAY LAYER. opts.rawLivePp: the current ML edge in PERCENTAGE
  // POINTS, compared unrounded against the same floors. Direction still
  // comes from the frozen line, so a bet placed as a favourite keeps the
  // favourite floor even if the market later flips it.
  function highlightsForDisplay(sig, t, opts) {
    var n = normalize(sig);
    if (!n) return false;
    if (n.label !== null && n.label !== undefined) {
      // Legacy star rows: 2* and 3* highlighted pre-cutover, 1* never.
      // Encoding-damaged labels ('2â') fall through to false, as they did
      // before -- see docs/mojibake-star-labels-open-question-2026-09-17.md.
      return n.label === '2★' || n.label === '3★';
    }
    var thr = t || DEFAULTS;
    var live = opts && opts.rawLivePp;
    if (typeof live === 'number' && isFinite(live) && n.isMl) {
      if (n.line == null || !isFinite(n.line) || n.line === 0) return false;
      var floorPp = (n.line < 0 ? thr.fav_min_pp : thr.dog_min_pp) * 100;
      return live >= floorPp;
    }
    return highlightsOnFrozenEdge(sig, thr);
  }

  return {
    DEFAULTS: DEFAULTS,
    KEYS: KEYS,
    thresholdsFrom: thresholdsFrom,
    loadThresholds: loadThresholds,
    roundedEdge: roundedEdge,
    roundedScorePp: roundedScorePp,
    highlightsOnFrozenEdge: highlightsOnFrozenEdge,
    highlightsForDisplay: highlightsForDisplay,
  };
}));
