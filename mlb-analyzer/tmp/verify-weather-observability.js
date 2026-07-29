'use strict';
// End-to-end verify: run fetchParkWind for today's ATH game and a
// sanity-check ET game, then a couple deliberately-broken inputs, and
// capture the log lines so mode 1/2/3 WARNs + success INFO are visible.

const { fetchParkWind } = require('../services/weather');

const cases = [
  { desc: 'ATH today, correct format', home: 'ath', date: '2026-07-29', time: '9:40 PM ET' },
  { desc: 'CIN today, sanity',        home: 'cin', date: '2026-07-29', time: '7:10 PM ET' },
  { desc: 'ATH today, ISO input',     home: 'ath', date: '2026-07-29', time: '2026-07-30T01:40:00Z' },
  { desc: 'ATH today, 24-hour input', home: 'ath', date: '2026-07-29', time: '21:40 ET' },
  { desc: 'ATH today, unparseable',   home: 'ath', date: '2026-07-29', time: 'TBD ET' },
  { desc: 'ATH today, null gameTime', home: 'ath', date: '2026-07-29', time: null },
  { desc: 'unknown teamKey',          home: 'zzz', date: '2026-07-29', time: '7:00 PM ET' },
];

(async () => {
  for (const c of cases) {
    console.log('\n=== ' + c.desc + ' ===');
    const r = await fetchParkWind(c.home, c.date, c.time);
    console.log('  RESULT: ' + (r ? 'temp=' + r.tempF + '°F wind=' + r.windSpeed + 'mph' : 'null'));
  }
})();
