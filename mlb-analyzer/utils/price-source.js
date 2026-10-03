'use strict';

// MONEYLINE PRICE SOURCE, CROSS-CHECK AND BOOK DEPTH. (2026-10-02, #484)
//
// Visibility only. Nothing here decides whether a signal fires or what it is
// priced at: the odds job uses mlCrossCheck for the single-source FLAG (which
// blocks nothing), and signal creation stores the result for display.
//
// WHY A HELPER. From 2026-08-04 to 2026-09-16, 114 locked Polymarket-priced
// games were stored as cross-checked against... Polymarket. The rule compared
// the cross-check venue with THIS PASS's ml_source; on a locked pass the price
// overrides skip the row, so ml_source was null, and 'polymarket' !== null
// read as "two venues". (The Unabated feed that supplied that cross-check label
// was removed on 2026-09-17; services/jobs.js processOddsArray still compared
// against the pass's own, possibly null, source.) The rule now lives here: a
// cross-check needs two DISTINCT, KNOWN venues, both with prices this pass.

const VENUES = { kalshi: 'kalshi', polymarket: 'polymarket', poly: 'polymarket' };
const LABELS = { kalshi: 'Kalshi', polymarket: 'Polymarket' };

// 'poly' (venue comparison) and 'polymarket' (odds job) are the same venue.
function normVenue(v) {
  if (v == null || v === '') return null;
  const k = String(v).trim().toLowerCase();
  return VENUES[k] || k;
}
function venueLabel(v) {
  const n = normVenue(v);
  return n == null ? null : (LABELS[n] || n);
}
// Kalshi first wherever more than one venue is listed; the rest alphabetical.
function kalshiFirst(venues) {
  const uniq = [...new Set((venues || []).map(normVenue).filter(Boolean))];
  return uniq.sort((a, b) => (a === 'kalshi' ? -1 : b === 'kalshi' ? 1 : a.localeCompare(b)));
}

const num = (x) => x != null && x !== '' && Number.isFinite(Number(x));

// -> { status: 'cross-checked' | 'single-source' | 'no-market', source, xcheck_source }
//   haveMarket:    the game has a usable moneyline (fresh or stored)
//   primarySource: the moneyline's venue (this pass's, else the stored one)
//   primaryAway/Home: THIS PASS's primary prices (the comparison needs them)
//   xcheckSource, xcheckAway/Home: the second venue's quote this pass
function mlCrossCheck(o) {
  const source = normVenue(o.primarySource);
  const xcheck = normVenue(o.xcheckSource);
  if (!o.haveMarket) return { status: 'no-market', source, xcheck_source: xcheck };
  const both = source && xcheck && source !== xcheck
    && num(o.primaryAway) && num(o.primaryHome) && num(o.xcheckAway) && num(o.xcheckHome);
  return { status: both ? 'cross-checked' : 'single-source', source, xcheck_source: both ? xcheck : null };
}

// Dollars of asks at or better than the deepest price the stake's fill reached:
// the money available at the price the signal's net-at-size line reflects.
// asks: best-first [{price, size}] (shares at price in [0,1]). Pure.
function depthAtFillPrice(asks, levelsConsumed) {
  if (!Array.isArray(asks) || !asks.length || !Array.isArray(levelsConsumed) || !levelsConsumed.length) return null;
  const limit = Math.max(...levelsConsumed.map(l => Number(l.price)).filter(Number.isFinite));
  if (!Number.isFinite(limit)) return null;
  let usd = 0;
  for (const l of asks) {
    const p = Number(l.price), s = Number(l.size);
    if (!(p > 0) || !(p < 1) || !(s > 0)) continue;
    if (p <= limit + 1e-9) usd += p * s;
  }
  return Math.round(usd * 100) / 100;
}

// Depth recorded on a signal, from the venue comparison row its price came
// from. venue: 'poly' | 'kalshi' (bet_signals.price_venue). -> { usd, reason }
function depthForSignal(cmpRow, venue, side) {
  if (!cmpRow) return { usd: null, reason: 'no venue comparison for this game' };
  const key = venue === 'poly' || venue === 'polymarket' ? 'poly' : venue === 'kalshi' ? 'kalshi' : null;
  if (!key) return { usd: null, reason: 'price not from a venue order book' };
  const e = cmpRow[key] && cmpRow[key][side];
  if (!e) return { usd: null, reason: 'no ' + venueLabel(key) + ' quote for this side' };
  if (e.depth_usd == null) return { usd: null, reason: 'order-book depth not in the comparison data (captured before depth was recorded)' };
  return { usd: Number(e.depth_usd), reason: null };
}

module.exports = { normVenue, venueLabel, kalshiFirst, mlCrossCheck, depthAtFillPrice, depthForSignal };
