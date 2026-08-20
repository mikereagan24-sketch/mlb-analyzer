'use strict';

// Verify batch 3 cfDir bearings and home->CF distances independently.
// Great-circle initial bearing via atan2; distance via haversine.

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
  const a = Math.sin(dPhi/2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon/2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const PARKS = [
  ['nym', 40.75659049940357, -73.84602873744261, 40.757674380140244, -73.84566653528923, 14],
  ['min', 44.981717162370394, -93.27829383556069, 44.98172141808684, -93.27672458105152, 90],
  ['atl', 33.891126700858116, -84.4678868457582,  33.8901024321118,   -84.46742056344961, 159],
  ['col', 39.75570889434178, -104.99420013642896, 39.756844080456474, -104.99413616236451, 3],
  ['lad', 34.0734220619125,  -118.24022795237009, 34.07440214746978,  -118.23967148997004, 25],
  ['laa', 33.799920691495615,-117.88316982446123, 33.80071014464904,  -117.88226967929715, 44],
  ['sd',  32.70705001125514, -117.15706906729568, 32.70813377953736,  -117.15707576547341, 0],
];

const OLD = { nym:45, min:45, atl:45, col:45, lad:45, laa:45, sd:45 };

console.log('park  computed  claimed  match  dist_m  dist_ft  delta_from_45');
for (const [park, hLat, hLng, cLat, cLng, claimed] of PARKS) {
  const b = bearing(hLat, hLng, cLat, cLng);
  const d = distance(hLat, hLng, cLat, cLng);
  const bRound = Math.round(b);
  const match = bRound === claimed ? 'OK' : 'DIFF';
  // shortest-arc delta from 45
  let delta = bRound - 45;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  console.log(
    `${park.padEnd(4)}  ${bRound.toString().padStart(6)}°  ${claimed.toString().padStart(6)}°  ${match.padEnd(5)}  ${d.toFixed(1).padStart(6)}  ${(d*3.28084).toFixed(1).padStart(6)}  ${delta > 0 ? '+' : ''}${delta}°`
  );
}
