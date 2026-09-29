'use strict';

// The 31 trend scenarios, as PURE predicates. Every id, name and condition is
// docs/trends-preregistration-2026-09-29.md §4, verbatim in meaning; that file
// was committed (8865cba) before this code existed. A change to what a
// scenario MEANS is a new pre-registration file, not an edit here (§9).
//
// Team scenarios (kind 'ml') receive a team-game context `c` built by
// services/trends-backtest.js:
//   c.home          T is the home team in G
//   c.fav / c.dog   no-vig nv(T) > 0.5 / < 0.5 in G (locked price)
//   c.ml            T's locked American price in G
//   c.P             T's previous completed game, or null:
//                     { won, margin (T runs - O runs), runsFor, runsAgainst,
//                       home, priced, fav, dog, opp, sameSeries,
//                       night (local start >= 17:00), localDate }
//   c.lossStreak / c.winStreak   consecutive L / W entering G
//   c.seriesFirst / c.seriesLast G's position in its series
//   c.g2           G's game_id ends in -g2
//   c.sameDivision / c.interleague
//   c.ownOpener    T's own pitching side is flagged opener/bullpen in G
//   c.moveCents    open->lock move toward T in cents (null if no open)
//   c.dayAfterNight  G local start < 17:00 AND P night on the previous local day
// Game scenarios (kind 'total') receive a game context `x`:
//   x.prevTotalGe15   either team's P had a combined final >= 15
//   x.dayAfterNight   S20 holds for either team

const ML = (id, name, test) => ({ id, name, kind: 'ml', test });
const TOT = (id, name, bet, test) => ({ id, name, kind: 'total', bet, test });
const Pp = (c) => c.P && c.P.priced;

const SCENARIOS = [
  ML('S01', 'Home dog again', c => c.home && c.dog && Pp(c) && c.P.home && c.P.dog),
  ML('S02', 'Favorite again after losing as favorite', c => c.fav && Pp(c) && c.P.fav && !c.P.won),
  ML('S03', 'Road dog again', c => !c.home && c.dog && Pp(c) && !c.P.home && c.P.dog),
  ML('S04', 'Favorite again after winning as favorite', c => c.fav && Pp(c) && c.P.fav && c.P.won),
  ML('S05', 'Dog again after winning as dog', c => c.dog && Pp(c) && c.P.dog && c.P.won),
  ML('S06', 'Favorite after winning as dog', c => c.fav && Pp(c) && c.P.dog && c.P.won),
  ML('S07', 'Dog after losing as favorite', c => c.dog && Pp(c) && c.P.fav && !c.P.won),
  ML('S08', 'Home favorite after home loss', c => c.home && c.fav && c.P && c.P.home && !c.P.won),
  ML('S09', 'Big favorite after a loss', c => c.ml <= -200 && c.P && !c.P.won),
  ML('S10', 'Big dog', c => c.ml >= 175),
  ML('S11', 'After a blowout loss', c => c.P && c.P.margin <= -5),
  ML('S12', 'Favorite after a blowout win', c => c.fav && c.P && c.P.margin >= 5),
  ML('S13', 'After being shut out', c => c.P && c.P.runsFor === 0),
  ML('S14', 'After scoring 10+', c => c.P && c.P.runsFor >= 10),
  ML('S15', 'After allowing 10+', c => c.P && c.P.runsAgainst >= 10),
  ML('S16', 'After a one-run loss', c => c.P && c.P.margin === -1),
  ML('S17', 'Losing streak 3+', c => c.lossStreak >= 3),
  ML('S18', 'Winning streak 3+', c => c.winStreak >= 3),
  ML('S19', 'Dog on a 5+ losing streak', c => c.dog && c.lossStreak >= 5),
  ML('S20', 'Day game after a night game', c => c.dayAfterNight === true),
  ML('S21', 'Doubleheader game 2, dog', c => c.g2 && c.dog),
  ML('S22', 'Series opener, road dog', c => c.seriesFirst && !c.home && c.dog),
  ML('S23', 'Series finale, home favorite', c => c.seriesLast && c.home && c.fav),
  ML('S24', 'Favorite after losing to same opponent this series',
    c => !c.seriesFirst && c.P && c.P.sameSeries && !c.P.won && c.fav),
  ML('S25', 'Line moved toward T', c => c.moveCents != null && c.moveCents >= 15),
  ML('S26', 'Line moved against T', c => c.moveCents != null && c.moveCents <= -15),
  ML('S27', 'Home dog vs division rival', c => c.home && c.dog && c.sameDivision),
  ML('S28', 'Interleague road dog', c => !c.home && c.dog && c.interleague),
  ML('S29', 'Opener / bullpen game, dog', c => c.ownOpener && c.dog),
  TOT('S30', 'Over after a 15+ run game', 'over', x => x.prevTotalGe15),
  TOT('S31', 'Under in a day game after a night game', 'under', x => x.dayAfterNight),
];

// Price helpers (§2).
const imp = (m) => (m < 0 ? -m / (-m + 100) : 100 / (m + 100));
const noVig = (mT, mO) => imp(mT) / (imp(mT) + imp(mO));
const cents = (m) => (m < 0 ? m + 100 : m - 100);
const profit = (m) => (m > 0 ? m : 100 * 100 / -m);   // on a $100 stake, win

module.exports = { SCENARIOS, imp, noVig, cents, profit };
