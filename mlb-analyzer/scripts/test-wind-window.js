#!/usr/bin/env node
// Windowed hourly read for fetchWindAtCoords. (2026-09-14)
//   node scripts/test-wind-window.js
// Exit 1 on any failure. No network: fetch is stubbed.
//
// THE LOAD-BEARING ASSERTION IS THE FIRST ONE. wind_factor and
// temp_run_adj are computed by callers from the single-point return, and
// this change must not move either. So the no-argument call is asserted
// BYTE-IDENTICAL -- same keys, same values, same JSON, and specifically no
// `window` key -- against the same stubbed payload the windowed call sees.
//
// The rest covers what a windowed read can get wrong:
//   - scalar direction averaging across north (350/010 -> 180, a reversal
//     that never happened) -- the reason this is a vector mean
//   - a resultant speed presented without its scalar mean, hiding the
//     cancellation that a veering window produces
//   - a heading read off a near-zero resultant, which is atan2 noise
//   - a window running off the end of the hourly array, averaging fewer
//     hours than it claims while still reading as an n-hour mean
const path = require('path');
const R = path.join(__dirname, '..');
const wx = require(path.join(R, 'services/weather'));

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got)
                 + '\n        want ' + JSON.stringify(want)));
}
function near(label, got, want, tol) {
  const ok = Number.isFinite(got) && Math.abs(got - want) <= (tol == null ? 1e-6 : tol);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + got + '\n        want ~' + want));
}

// ---- stub the hourly payload -----------------------------------------
// Park-local ISO hours. First pitch 19:00 -> idx at 19:00, window covers
// 19,20,21,22. Directions VEER across north so the vector mean is the only
// average that gets the heading right.
const HOURS = [];
const SPEED = {}, DIR = {}, TEMP = {};
for (let d = 13; d <= 15; d++) {
  for (let h = 0; h < 24; h++) {
    const iso = '2026-09-' + String(d).padStart(2, '0') + 'T' + String(h).padStart(2, '0') + ':00';
    HOURS.push(iso);
  }
}
const series = HOURS.map((iso, i) => {
  // default filler; the four window hours are overwritten below
  return { speed: 5, dir: 90, temp: 60 + (i % 5) };
});
const fpIdx = HOURS.indexOf('2026-09-14T19:00');
series[fpIdx]     = { speed: 12, dir: 350, temp: 70 };
series[fpIdx + 1] = { speed: 12, dir: 10,  temp: 72 };
series[fpIdx + 2] = { speed: 12, dir: 350, temp: 74 };
series[fpIdx + 3] = { speed: 12, dir: 10,  temp: 76 };

const payload = {
  timezone: 'America/New_York',
  hourly: {
    time: HOURS,
    wind_speed_10m: series.map((s) => s.speed),
    wind_direction_10m: series.map((s) => s.dir),
    temperature_2m: series.map((s) => s.temp),
    precipitation_probability: series.map(() => 11),
  },
};
let fetchCalls = 0;
global.fetch = function () {
  fetchCalls++;
  return Promise.resolve({ json: () => Promise.resolve(payload) });
};

const ARGS = {
  lat: 40.8296, lng: -73.9262, tz: 'America/New_York',
  gameDate: '2026-09-14', gameTime: '7:05 PM ET', sourceLabel: 'test',
};

(async function main() {
  const realLog = console.log;
  console.log = () => {};
  const plain = await wx.fetchWindAtCoords(Object.assign({}, ARGS));
  const windowed = await wx.fetchWindAtCoords(Object.assign({}, ARGS, { windowHours: 4 }));
  const one = await wx.fetchWindAtCoords(Object.assign({}, ARGS, { windowHours: 1 }));
  console.log = realLog;

  console.log('1. THE DEFAULT RETURN IS BYTE-IDENTICAL');
  check('exactly the four original keys, in order',
    Object.keys(plain), ['windSpeed', 'windDir', 'tempF', 'precipProb']);
  check('the single-point values are the first-pitch hour',
    plain, { windSpeed: 12, windDir: 350, tempF: 70, precipProb: 11 });
  check('no window key on a default call', 'window' in plain, false);
  // windowHours=1 is not a window; a one-hour "mean" is the point read, and
  // returning a window object for it would invite a caller to treat the two
  // as different things.
  check('windowHours=1 is also byte-identical to the default',
    JSON.stringify(one), JSON.stringify(plain));
  // The windowed call must not disturb the point values it sits beside.
  check('the windowed call returns the SAME point values',
    [windowed.windSpeed, windowed.windDir, windowed.tempF, windowed.precipProb],
    [plain.windSpeed, plain.windDir, plain.tempF, plain.precipProb]);
  check('and needs no extra request (same fetch count per call)', fetchCalls, 3);

  console.log('');
  console.log('2. the window is FP .. FP+(n-1), in order');
  check('four readings', windowed.window.readings.length, 4);
  check('starting at the first-pitch hour',
    windowed.window.readings.map((r) => r.iso),
    ['2026-09-14T19:00', '2026-09-14T20:00', '2026-09-14T21:00', '2026-09-14T22:00']);
  check('complete, and every hour usable',
    [windowed.window.complete, windowed.window.usable, windowed.window.requested], [true, 4, 4]);

  console.log('');
  console.log('3. direction is VECTOR averaged, not scalar averaged');
  // 350, 010, 350, 010 -> scalar mean 180 (a due-south reversal that never
  // happened); vector mean ~360/000, which is what actually blew.
  const scalarMeanDir = (350 + 10 + 350 + 10) / 4;
  check('the scalar average would be the wrong 180', scalarMeanDir, 180);
  const dir = windowed.window.resultant.windDir;
  const offNorth = Math.min(Math.abs(dir - 360), Math.abs(dir - 0));
  near('the vector mean is ~000, not 180', offNorth, 0, 0.001);
  near('temperature IS scalar-averaged (70,72,74,76)',
    windowed.window.resultant.tempF, 73, 1e-9);

  console.log('');
  console.log('4. the resultant speed carries its control');
  // Veering +/-10 degrees off north at a steady 12mph: the resultant is
  // slightly below 12, and the scalar mean is exactly 12.
  near('scalar mean speed is the steady 12', windowed.window.scalarMeanSpeed, 12, 1e-9);
  check('resultant speed is <= scalar mean',
    windowed.window.resultant.windSpeed <= windowed.window.scalarMeanSpeed + 1e-12, true);
  near('and close to it when the window is steady',
    windowed.window.resultant.windSpeed, 11.82, 0.02);
  near('constancy is near 1 for a steady window', windowed.window.constancy, 0.985, 0.01);

  console.log('');
  console.log('5. THE CANCELLATION IS REAL AND MUST BE VISIBLE');
  // Opposing hours: the resultant is ~0 while no hour was calm. This is the
  // documented consequence of taking speed from the resultant, and the
  // reason constancy is returned -- the heading here is atan2 noise.
  const opp = wx.vectorMeanWind([
    { windSpeed: 10, windDir: 0 }, { windSpeed: 10, windDir: 180 }]);
  near('resultant collapses to ~0', opp.windSpeed, 0, 1e-9);
  near('while the scalar mean is 10', opp.scalarMeanSpeed, 10, 1e-9);
  near('constancy ~0 flags the heading as meaningless', opp.constancy, 0, 1e-9);
  // 8mph is calcWindFactor's hard deadband, so this is not academic: a
  // veering-but-windy window can price as calm under a vector mean.
  check('a 10mph opposing window reads BELOW the 8mph deadband',
    opp.windSpeed < 8 && opp.scalarMeanSpeed >= 8, true);
  check('and calcWindFactor duly returns 0 for it',
    wx.calcWindFactor(opp.windDir, opp.windSpeed, wx.PARKS.chc), 0);

  console.log('');
  console.log('6. a window that runs off the end of the array says so');
  const lateArgs = Object.assign({}, ARGS,
    { gameDate: '2026-09-15', gameTime: '11:05 PM ET', windowHours: 4 });
  console.log = () => {};
  const late = await wx.fetchWindAtCoords(lateArgs);
  console.log = realLog;
  // 23:00 on the last day of the array leaves one hour, not four.
  check('truncated to what exists', late.window.readings.length, 1);
  check('and complete is FALSE with the counts shown',
    [late.window.complete, late.window.requested, late.window.usable], [false, 4, 1]);

  console.log('');
  console.log('7. the pricing path is untouched');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(R, 'services/weather.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // calcWindFactor must not have learned about windows.
  const cwf = code.slice(code.indexOf('function calcWindFactor'),
    code.indexOf('function calcWindFactor') + 1400);
  check('calcWindFactor does not mention the window', /window/i.test(cwf), false);
  check('tempRunAdjFromTempF does not either',
    /window/i.test(code.slice(code.indexOf('function tempRunAdjFromTempF'),
      code.indexOf('function tempRunAdjFromTempF') + 800)), false);
  // fetchParkWind is the production caller; it must still take the point read.
  const fpw = code.slice(code.indexOf('async function fetchParkWind'),
    code.indexOf('async function fetchParkWind') + 1200);
  check('fetchParkWind passes no windowHours', /windowHours/.test(fpw), false);

  console.log('');
  console.log(failures ? failures + ' FAILURE(S)' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
