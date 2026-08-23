#!/usr/bin/env node
/**
 * Build the rookie / low-sample SP cohorts with as-of-date discipline.
 * (2026-08-23)
 *
 * STAGE 1 ONLY: schedule share. This deliberately does NOT look at
 * emitted signals -- the signal share is the answer to the
 * over-representation question, and the prediction has to be written
 * before it is seen. Run with --signals only AFTER the prediction is
 * committed.
 *
 * AS-OF-DATE, the whole point. A pitcher who finished the season at 400
 * BF was below the gate for his first four starts, and those starts
 * belong in the cohort. Season totals are look-ahead. Every quantity here
 * is accumulated STRICTLY BEFORE the game being classified.
 *
 * SPRING TRAINING EXCLUDED. pitcher_game_log carries 3863 rows (20.8%)
 * before 2026-03-26, and March has more starts (806) than any
 * regular-season month, while game_log -- the model corpus -- begins
 * 2026-04-04. Counting those would credit a pitcher with a month of
 * batters faced the model's actuals never saw (woba_data is FanGraphs
 * regular-season), reading a genuinely below-gate April starter as
 * established and removing him from the very cohort under test.
 * Accumulation is therefore restricted to dates present in game_log.
 *
 * CAREER FIGURES ARE AS-OF-FETCH. pitcher_debut.career_ip includes 2026,
 * so the as-of-date value is career_today minus the 2026 contribution on
 * or after the game date.
 *
 * COHORTS
 *   low_bf        (1a) as-of season BF < MIN_BF          -- "no usable actuals"
 *   rookie        (1b) as-of career IP < 50              -- "genuinely unestablished"
 *   vet_callup    as-of BF < MIN_BF AND career IP >= 50  -- THE SECOND CONTROL:
 *                 no actuals but experienced. This is what separates
 *                 "no actuals" from "unestablished" -- Steamer treats a
 *                 34-year-old off the IL very differently from a debutant.
 *   established   as-of BF >= MIN_BF AND career IP >= 50 -- the first control
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));

const ROOKIE_IP = 50;          // MLB rookie eligibility for pitchers
const WITH_SIGNALS = process.argv.includes('--signals');

function minBf() {
  try { return Number(require(path.join(R, 'services/jobs')).getSettings().MIN_BF) || 100; }
  catch (e) { return 100; }
}

function build() {
  const MIN_BF = minBf();

  // Dates the model actually scored. Spring training is absent by
  // construction, so no opening-day constant is needed.
  const modelDates = new Set(
    db.prepare('SELECT DISTINCT game_date d FROM game_log').all().map(r => r.d));

  // pitcher_game_log has no game_id -- it keys on (game_date, team). Two
  // abbreviations differ from game_log and must be remapped, the same pair
  // services/kalshi.js documents. Every OTHER unmatched code (BRA, CAN,
  // CUB, DOM, GBR, ISR, ITA, MEX, MTY, NCA, NED, PAN, PUR, SAC, SPR, SUG,
  // USA, VEN) is a WBC or exhibition side with ZERO starts on model dates
  // -- further confirmation that the unmatched rows are spring training.
  const TEAM_REMAP = { AZ: 'ARI', WSH: 'WAS' };
  const norm = t => TEAM_REMAP[String(t || '').toUpperCase()] || String(t || '').toUpperCase();

  // Map (date, team) -> game_id from the model corpus.
  const gameByDateTeam = new Map();
  for (const g of db.prepare('SELECT game_date, game_id, away_team, home_team FROM game_log').all()) {
    gameByDateTeam.set(g.game_date + '|' + norm(g.away_team), g.game_id);
    gameByDateTeam.set(g.game_date + '|' + norm(g.home_team), g.game_id);
  }

  // Every regular-season start, in order, with its BF.
  const starts = db.prepare(
    'SELECT game_date, team, pitcher_mlb_id, pitcher_name, batters_faced, innings_pitched '
    + 'FROM pitcher_game_log WHERE was_starter=1 AND pitcher_mlb_id IS NOT NULL '
    + 'ORDER BY pitcher_mlb_id, game_date').all()
    .filter(r => modelDates.has(r.game_date))
    .map(r => Object.assign(r, { game_id: gameByDateTeam.get(r.game_date + '|' + norm(r.team)) || null }))
    .filter(r => r.game_id);

  const debut = new Map(db.prepare(
    'SELECT pitcher_mlb_id id, mlb_debut_date, career_ip, career_bf FROM pitcher_debut').all()
    .map(r => [r.id, r]));

  // Total 2026 regular-season IP per pitcher, to back out career-as-of-date.
  const ip2026 = new Map();
  for (const s of starts) {
    ip2026.set(s.pitcher_mlb_id, (ip2026.get(s.pitcher_mlb_id) || 0) + (Number(s.innings_pitched) || 0));
  }

  const out = [];
  const accBf = new Map(), accIp = new Map();
  for (const s of starts) {
    const id = s.pitcher_mlb_id;
    const bfBefore = accBf.get(id) || 0;
    const ipBefore = accIp.get(id) || 0;
    const d = debut.get(id) || {};
    // career IP BEFORE this start = career today - all 2026 IP + 2026 IP before this start
    const careerBefore = (d.career_ip != null)
      ? Number(d.career_ip) - (ip2026.get(id) || 0) + ipBefore
      : null;

    out.push({
      game_date: s.game_date, game_id: s.game_id, pitcher_mlb_id: id,
      pitcher_name: s.pitcher_name,
      bf_before: bfBefore,
      career_ip_before: careerBefore,
      debut: d.mlb_debut_date || null,
      low_bf: bfBefore < MIN_BF,
      rookie: careerBefore != null ? careerBefore < ROOKIE_IP : null,
    });

    accBf.set(id, bfBefore + (Number(s.batters_faced) || 0));
    accIp.set(id, ipBefore + (Number(s.innings_pitched) || 0));
  }
  return { MIN_BF, rows: out, modelDates };
}

(function main() {
  const { MIN_BF, rows } = build();
  console.log('=== rookie / low-sample SP cohorts, as-of-date ===');
  console.log('  MIN_BF = ' + MIN_BF + '   rookie threshold = career IP < ' + ROOKIE_IP);
  console.log('  regular-season starts (dates present in game_log): ' + rows.length);
  const noCareer = rows.filter(r => r.career_ip_before == null).length;
  console.log('  starts with no career line (excluded from 1b): ' + noCareer);
  console.log('');

  // A start is classified once; a GAME counts if either starter qualifies.
  const games = new Map();
  for (const r of rows) {
    const k = r.game_date + '|' + r.game_id;
    const g = games.get(k) || { low_bf: false, rookie: false, vet_callup: false, established: false };
    const isRookie = r.rookie === true;
    const isLow = r.low_bf;
    if (isLow) g.low_bf = true;
    if (isRookie) g.rookie = true;
    if (isLow && r.career_ip_before != null && r.career_ip_before >= ROOKIE_IP) g.vet_callup = true;
    if (!isLow && r.career_ip_before != null && r.career_ip_before >= ROOKIE_IP) g.established = true;
    games.set(k, g);
  }

  const totalGames = db.prepare('SELECT COUNT(*) n FROM game_log').get().n;
  const coveredGames = games.size;
  console.log('=== SCHEDULE SHARE (the denominator) ===');
  console.log('  game_log games: ' + totalGames + '   with a matched regular-season start: ' + coveredGames);
  console.log('');
  const pct = n => (100 * n / coveredGames).toFixed(1) + '%';
  const cnt = k => [...games.values()].filter(g => g[k]).length;
  console.log('  cohort         games   share of scheduled games');
  for (const [k, label] of [['low_bf', 'low_bf (1a)'], ['rookie', 'rookie (1b)'],
                            ['vet_callup', 'vet_callup'], ['established', 'established']]) {
    console.log('  ' + label.padEnd(15) + String(cnt(k)).padStart(5) + '   ' + pct(cnt(k)));
  }
  console.log('');
  console.log('  per-START classification (not per game):');
  const n = rows.length;
  console.log('    low_bf     : ' + rows.filter(r => r.low_bf).length + '  (' + (100 * rows.filter(r => r.low_bf).length / n).toFixed(1) + '%)');
  const rk = rows.filter(r => r.rookie === true).length;
  console.log('    rookie     : ' + rk + '  (' + (100 * rk / n).toFixed(1) + '%)');
  const vc = rows.filter(r => r.low_bf && r.career_ip_before != null && r.career_ip_before >= ROOKIE_IP).length;
  console.log('    vet_callup : ' + vc + '  (' + (100 * vc / n).toFixed(1) + '%)');

  if (!WITH_SIGNALS) {
    console.log('');
    console.log('  STAGE 1 ONLY. Signal share is deliberately NOT computed here --');
    console.log('  it is the answer to the over-representation question and the');
    console.log('  prediction must be committed before it is seen. Re-run with');
    console.log('  --signals once the prediction is on record.');
    return;
  }

  // ---- STAGE 2: signal share. Prediction committed 47dc062 (2026-08-23).
  // Unit is the GAME, per the pre-registered method -- a game counts once
  // regardless of how many signals it produced. Contaminated games are
  // excluded, matching every other consumer.
  const sigGames = new Set(db.prepare(
    "SELECT DISTINCT bs.game_date || '|' || bs.game_id k FROM bet_signals bs "
    + "JOIN game_log g ON g.game_date=bs.game_date AND g.game_id=bs.game_id "
    + "WHERE g.market_contamination_reason IS NULL "
    + "  AND g.weather_contamination_reason IS NULL").all().map(r => r.k));

  const eligible = [...games.keys()].filter(k => {
    const d = k.split('|')[0];
    return true;
  });
  const withSig = eligible.filter(k => sigGames.has(k));

  console.log('');
  console.log('=== STAGE 2: SIGNAL SHARE ===');
  console.log('  cohort-eligible games : ' + eligible.length);
  console.log('  ... that emitted >=1 signal : ' + withSig.length
    + '  (' + (100 * withSig.length / eligible.length).toFixed(1) + '%)');
  console.log('');

  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // Date-clustered bootstrap on the RATIO (signal share / schedule share).
  function ratioCI(key, seed) {
    const byDate = new Map();
    for (const k of eligible) {
      const d = k.split('|')[0];
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push({ inCohort: !!games.get(k)[key], hasSig: sigGames.has(k) });
    }
    const dates = [...byDate.keys()], nD = dates.length, rnd = mulberry(seed);
    const out = [];
    for (let b = 0; b < 6000; b++) {
      let cohortSig = 0, sig = 0, cohort = 0, all = 0;
      for (let i = 0; i < nD; i++) {
        for (const g of byDate.get(dates[Math.floor(rnd() * nD)])) {
          all++;
          if (g.inCohort) cohort++;
          if (g.hasSig) { sig++; if (g.inCohort) cohortSig++; }
        }
      }
      if (sig > 0 && all > 0 && cohort > 0) {
        const sigShare = cohortSig / sig, schedShare = cohort / all;
        if (schedShare > 0) out.push(sigShare / schedShare);
      }
    }
    if (out.length < 50) return [null, null];
    out.sort((a, b) => a - b);
    return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
  }

  console.log('  cohort         sched%   signal%   ratio    95% CI            verdict');
  const seeds = { low_bf: 11, rookie: 22, vet_callup: 33, established: 44 };
  for (const key of ['rookie', 'low_bf', 'vet_callup', 'established']) {
    const sched = eligible.filter(k => games.get(k)[key]).length / eligible.length;
    const cohortSig = withSig.filter(k => games.get(k)[key]).length;
    const sigShare = cohortSig / withSig.length;
    const ratio = sched > 0 ? sigShare / sched : null;
    const ci = ratioCI(key, seeds[key]);
    const excl = ci[0] != null && (ci[0] > 1 || ci[1] < 1);
    console.log('  ' + key.padEnd(14)
      + (100 * sched).toFixed(1).padStart(6) + '%'
      + (100 * sigShare).toFixed(1).padStart(9) + '%'
      + (ratio == null ? '   n/a' : ratio.toFixed(3).padStart(9))
      + '   [' + (ci[0] == null ? 'n/a' : ci[0].toFixed(3)) + ', '
      + (ci[1] == null ? 'n/a' : ci[1].toFixed(3)) + ']'
      + (excl ? '   excludes 1.0' : '   spans 1.0'));
  }
})();
