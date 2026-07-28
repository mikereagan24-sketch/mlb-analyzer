'use strict';
// DH-assignment diagnostic (2026-07-28 CLE-CIN incident).
//
// The question the plausibility guard cannot answer: for a doubleheader,
// is leg 1's market on leg 1's row? Pulls the raw signals from each
// source and cross-checks against the statsapi schedule's authoritative
// gamePk + gameDate per leg.
//
// Usage: node tmp/diag-dh-assignment.js [YYYY-MM-DD] [away-home base]
//   (default date = today PT; default filter = cle-cin)
//
// For each source (Poly, Kalshi) and each event that resolves to the
// target base team-pair:
//   - source's implied start time (Poly game_start_time_iso; Kalshi
//     ticker HHMM ET)
//   - assigned game_number (1 or 2) after that source's own leg-splitting
//   - which side each source calls the favorite
//
// Then joins to statsapi by nearest-start-time match to answer:
//   - Does Poly's "leg 1" actually align with statsapi's gameNumber=1?
//   - Does Kalshi's ticker for game 1 encode a start time that matches
//     statsapi game 1?
//   - Do both sources agree on which team is favored for statsapi
//     game 1 (and separately for game 2)?

const poly = require('../services/polymarket');
const kalshi = require('../services/kalshi');
const { fetchSchedule } = require('../services/scraper');
const { checkMarketMLPairSanity } = require('../utils/market-sanity');

function todayPT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
function fmtEt(iso) {
  if (!iso) return '(no start)';
  const d = new Date(iso);
  if (isNaN(d)) return '(bad iso)';
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' ET';
}
function fmtAm(n) { return n == null ? 'null' : (n > 0 ? '+' + n : String(n)); }
function priceToAmerican(p) {
  const x = Number(p);
  if (!(x > 0) || !(x < 1)) return null;
  return x >= 0.5 ? -Math.round(100 * x / (1 - x)) : Math.round(100 * (1 - x) / x);
}
function favSide(awayMl, homeMl) {
  const a = Number(awayMl), h = Number(homeMl);
  if (!Number.isFinite(a) || !Number.isFinite(h)) return '?';
  return a < h ? 'away' : 'home';
}
// Etwall-clock HH:MM difference in minutes. Both inputs must be
// "same-day ET" for this to be meaningful.
function etHhmmToMinutes(hhmm) {
  if (!hhmm || hhmm.length !== 4) return null;
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2, 4), 10);
}
function isoToEtMinutes(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = parts.find(p => p.type === 'hour').value;
  const m = parts.find(p => p.type === 'minute').value;
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

(async function main() {
  const date = process.argv[2] || todayPT();
  const base = (process.argv[3] || 'cle-cin').toLowerCase();
  const [awayAbbr, homeAbbr] = base.split('-');
  console.log('DH-assignment diagnostic for ' + date + '  base=' + base);
  console.log('');

  // ── statsapi (authoritative) — raw fetch so gameDate is preserved ─
  const schedUrl = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + date
    + '&hydrate=' + encodeURIComponent('probablePitcher(note),team');
  const schedResp = await fetch(schedUrl);
  const schedJson = await schedResp.json();
  const schedRaw = (schedJson.dates && schedJson.dates[0] && schedJson.dates[0].games) || [];
  const ABBR_NORM = { WSH: 'WAS', OAK: 'ATH', AZ: 'ARI' };
  const norm = a => (ABBR_NORM[a] || a || '').toLowerCase();
  const legs = schedRaw
    .filter(g => norm(g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.abbreviation) === awayAbbr
              && norm(g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.abbreviation) === homeAbbr)
    .map(g => ({
      game_number: g.gameNumber || 1,
      game_pk: g.gamePk,
      game_id: (g.gameNumber || 1) > 1
        ? awayAbbr + '-' + homeAbbr + '-g' + g.gameNumber
        : awayAbbr + '-' + homeAbbr,
      gameDate: g.gameDate,
      status: g.status && g.status.detailedState,
    }))
    .sort((a, b) => a.game_number - b.game_number);
  console.log('statsapi legs for ' + base + ':');
  if (!legs.length) {
    console.log('  (none — pair not on schedule)');
    process.exit(0);
  }
  const schedByG = {};
  for (const g of legs) {
    schedByG[g.game_number] = g;
    console.log('  game_number=' + g.game_number
      + '  game_pk=' + g.game_pk
      + '  game_id=' + g.game_id
      + '  start=' + fmtEt(g.gameDate)
      + '  status=' + g.status);
  }
  console.log('');

  // ── Kalshi raw ──────────────────────────────────────────────
  const kalsRows = await kalshi.getKalshiMlbLines(date, { includeLive: true });
  const kalsForBase = kalsRows.filter(k =>
    (k.away_team || '').toLowerCase() === awayAbbr
    && (k.home_team || '').toLowerCase() === homeAbbr);
  console.log('Kalshi events for ' + base + ':');
  console.log('  event_ticker                        game_id        assigned_g  start_et  away/home_ml   fav');
  for (const k of kalsForBase.sort((a, b) => (a.start_et || '').localeCompare(b.start_et || ''))) {
    const aMl = k.away && k.away.ask_ml;
    const hMl = k.home && k.home.ask_ml;
    console.log('  ' + (k.event_ticker || '').padEnd(37, ' ')
      + '  ' + (k.game_id || '').padEnd(13, ' ')
      + '  g' + (k.game_number || 1)
      + '        ' + (k.start_et || '?').padStart(4, ' ')
      + '     ' + fmtAm(aMl).padStart(5, ' ') + ' / ' + fmtAm(hMl).padStart(5, ' ')
      + '   ' + favSide(aMl, hMl));
  }
  console.log('');

  // ── Poly raw (pre-cluster) ──────────────────────────────────
  const events = await poly._internal.gammaListMlbEvents(date);
  const perGameEvents = events
    .filter(e => poly._internal.isPerGameEvent(e))
    .map(e => ({ evt: e, sides: poly._internal.extractSidesFromEvent(e) }))
    .filter(x => x.sides
      && (x.sides.away_abbr || '').toLowerCase() === awayAbbr
      && (x.sides.home_abbr || '').toLowerCase() === homeAbbr);
  console.log('Poly PRE-CLUSTER events for ' + base + ':');
  console.log('  event_id                              start (ET)       away_price/home_price  fav');
  for (const { sides } of perGameEvents.sort((a, b) =>
      String(a.sides.game_start_time_iso || '').localeCompare(String(b.sides.game_start_time_iso || '')))) {
    const aMl = priceToAmerican(parseFloat(sides.away_price_str));
    const hMl = priceToAmerican(parseFloat(sides.home_price_str));
    console.log('  ' + String(sides.event_id || '').padEnd(38, ' ')
      + '  ' + fmtEt(sides.game_start_time_iso).padEnd(15, ' ')
      + '  ' + (sides.away_price_str || '?').padStart(5) + ' / ' + (sides.home_price_str || '?').padStart(5)
      + '  ' + '(' + fmtAm(aMl) + ' / ' + fmtAm(hMl) + ')'
      + '  ' + favSide(aMl, hMl));
  }
  console.log('');

  // ── Poly POST-cluster (what the app actually sees) ──────────
  const polyRows = await poly.getPolymarketMlbLines(date, { includeUnmatched: true });
  const polyForBase = polyRows.filter(r =>
    (r.away_team || '').toLowerCase() === awayAbbr
    && (r.home_team || '').toLowerCase() === homeAbbr);
  console.log('Poly POST-CLUSTER (what the pipeline sees):');
  console.log('  game_id        game_number  start (ET)        away_ml / home_ml    fav');
  for (const r of polyForBase) {
    const aMl = r.away && r.away.ask_ml;
    const hMl = r.home && r.home.ask_ml;
    console.log('  ' + (r.game_id || '').padEnd(13, ' ')
      + '  g' + r.game_number
      + '           ' + fmtEt(r.game_start_time_iso).padEnd(15, ' ')
      + '  ' + fmtAm(aMl).padStart(5) + ' / ' + fmtAm(hMl).padStart(5)
      + '     ' + favSide(aMl, hMl));
  }
  console.log('');

  // ── Cross-check: each source's assignment vs statsapi ───────
  console.log('CROSS-CHECK per statsapi leg:');
  const findings = [];
  for (const gn of Object.keys(schedByG).sort()) {
    const g = schedByG[gn];
    const gEt = isoToEtMinutes(g.gameDate);
    console.log('');
    console.log('  statsapi ' + g.game_id + '  (game_pk=' + g.game_pk
      + ', start=' + fmtEt(g.gameDate) + ')');

    // Kalshi assignment (by game_number match)
    const kal = kalsForBase.find(k => String(k.game_number || 1) === String(gn));
    let kFav = '?', kEtDelta = null;
    if (kal) {
      const aMl = kal.away && kal.away.ask_ml;
      const hMl = kal.home && kal.home.ask_ml;
      kFav = favSide(aMl, hMl);
      const kalEtMin = etHhmmToMinutes(kal.start_et);
      if (kalEtMin != null && gEt != null) kEtDelta = kalEtMin - gEt;
      console.log('    Kalshi:  ticker=' + kal.event_ticker
        + '  start_et=' + kal.start_et + ' (Δ vs statsapi = ' + (kEtDelta == null ? '?' : (kEtDelta + 'min')) + ')'
        + '  fav=' + kFav
        + '  (' + fmtAm(aMl) + '/' + fmtAm(hMl) + ')');
    } else {
      console.log('    Kalshi:  NO row for game_number=' + gn);
    }

    // Poly assignment (by game_number match)
    const pol = polyForBase.find(r => String(r.game_number) === String(gn));
    let pFav = '?', pEtDelta = null;
    if (pol) {
      const aMl = pol.away && pol.away.ask_ml;
      const hMl = pol.home && pol.home.ask_ml;
      pFav = favSide(aMl, hMl);
      const polEtMin = isoToEtMinutes(pol.game_start_time_iso);
      if (polEtMin != null && gEt != null) pEtDelta = polEtMin - gEt;
      console.log('    Poly:    game_id=' + pol.game_id
        + '  start=' + fmtEt(pol.game_start_time_iso)
        + ' (Δ vs statsapi = ' + (pEtDelta == null ? '?' : (pEtDelta + 'min')) + ')'
        + '  fav=' + pFav
        + '  (' + fmtAm(aMl) + '/' + fmtAm(hMl) + ')');
    } else {
      console.log('    Poly:    NO row for game_number=' + gn);
    }

    // Findings
    if (kal && pol && kFav !== '?' && pFav !== '?' && kFav !== pFav) {
      findings.push('HARD FLAG: game_pk=' + g.game_pk + ' (' + g.game_id
        + ') — Kalshi favors ' + kFav + ' but Poly favors ' + pFav
        + ' → sources disagree on favorite for the SAME statsapi leg');
    }
    if (kal && kEtDelta != null && Math.abs(kEtDelta) > 30) {
      findings.push('HARD FLAG: game_pk=' + g.game_pk + ' — Kalshi ticker start_et differs from statsapi by '
        + kEtDelta + 'min (>30 min) → ticker likely encodes the WRONG leg');
    }
    if (pol && pEtDelta != null && Math.abs(pEtDelta) > 30) {
      findings.push('HARD FLAG: game_pk=' + g.game_pk + ' — Poly assigned event start differs from statsapi by '
        + pEtDelta + 'min (>30 min) → clustering may have crossed legs');
    }
  }

  console.log('');
  console.log('FINDINGS:');
  if (!findings.length) console.log('  (none)');
  for (const f of findings) console.log('  * ' + f);
})().catch(e => {
  console.error('diag failed: ' + (e && e.stack || e));
  process.exit(1);
});
