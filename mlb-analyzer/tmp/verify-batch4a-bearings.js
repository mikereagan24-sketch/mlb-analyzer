'use strict';

// Verify batch 4a cfDir bearings and home->CF distances independently.
// Great-circle initial bearing via atan2; distance via haversine.
// Same shape as tmp/verify-batch3-bearings.js — the reproducibility
// artifact the audit asks each batch to leave behind.
//
// Batch 4a measured the two retractables that play OPEN most of the time.
// The first attempt FAILED this check and was not shipped: using the
// coarse PARKS lat/lng as the origin (sea 4dp, mil 3dp latitude — the
// original ~1km weather-grid coords, never re-measured) gave 259 ft and
// 219 ft. Batches 2 and 3 re-measured home plate as well as CF, which is
// why their pairs carry ~14 decimal places on both ends. Re-read with a
// precise home plate, both land in the window.

const R = 6371000; // meters

function bearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => d * Math.PI / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const brng = Math.atan2(y, x) * 180 / Math.PI;
  return (brng + 360) % 360;
}

function distance(lat1, lon1, lat2, lon2) {
  const toRad = (d) => d * Math.PI / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// park, home-plate lat/lng, CF-fence lat/lng, claimed cfDir
const PARKS = [
  ['sea', 47.59111919797947, -122.33291007789138, 47.59185601920702, -122.33169277289737, 48],
  ['mil', 43.02843261143977, -87.97165845928563, 43.027750757236504, -87.97045244844031, 128],
];

const OLD = { sea: 45, mil: 45 };
let bad = 0;

console.log('park  computed  claimed  match  dist_m  dist_ft  in_window  delta_from_45');
for (const [park, hLat, hLng, cLat, cLng, claimed] of PARKS) {
  const b = bearing(hLat, hLng, cLat, cLng);
  const d = distance(hLat, hLng, cLat, cLng);
  const ft = d * 3.28084;
  const bRound = Math.round(b);
  const match = bRound === claimed ? 'OK' : 'DIFF';
  const inWindow = ft >= 395 && ft <= 415;
  if (match !== 'OK' || !inWindow) bad++;
  let delta = bRound - OLD[park];
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  console.log(
    `${park.padEnd(4)}  ${bRound.toString().padStart(6)}°  ${claimed.toString().padStart(6)}°  ${match.padEnd(5)}  `
    + `${d.toFixed(1).padStart(6)}  ${ft.toFixed(1).padStart(6)}  ${(inWindow ? 'YES' : 'NO').padStart(9)}  `
    + `${delta > 0 ? '+' : ''}${delta}°`
  );
}

// Cross-check against what the code actually ships, so this file cannot
// drift from PARKS the way a written-down number would.
const { PARKS: LIVE } = require('../services/weather');
for (const [park, , , , , claimed] of PARKS) {
  if (LIVE[park].cfDir !== claimed) {
    bad++;
    console.log(`MISMATCH: PARKS.${park}.cfDir is ${LIVE[park].cfDir}, this file claims ${claimed}`);
  }
}

console.log(bad ? `\n${bad} PROBLEM(S)` : '\nall bearings verified and in the 395-415 ft window');
process.exit(bad ? 1 : 0);
