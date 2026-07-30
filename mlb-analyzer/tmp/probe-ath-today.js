'use strict';
// Directly probe: for today's bos-ath game, what does the merged code
// path produce? Also check for anything unusual (DH, weird game_time,
// override triggering).

const w = require('../services/weather');
const { PARKS, fetchWindAtCoords } = w;
const { PARK_TZ, parseGameTimeToEtHm, parkLocalHourIso } = w._internal;
const { pickVenueOverride } = require('../services/scraper');
const { VENUE_ID_OVERRIDES } = require('../services/model');

const ABBR_NORM = { WSH: 'WAS', OAK: 'ATH', AZ: 'ARI' };
const norm = a => (ABBR_NORM[a] || a || '').toLowerCase();

(async function main() {
  const date = '2026-07-30';
  console.log('Probing bos-ath on ' + date + '\n');

  // statsapi
  const sresp = await fetch('https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + date
    + '&hydrate=' + encodeURIComponent('probablePitcher,team,venue'));
  const sjson = await sresp.json();
  const games = (sjson.dates?.[0]?.games || []).filter(g =>
    norm(g.teams?.away?.team?.abbreviation) === 'bos'
    && norm(g.teams?.home?.team?.abbreviation) === 'ath');
  if (!games.length) { console.log('No bos-ath on statsapi for ' + date); return; }
  const g = games[0];
  const gameDateIso = g.gameDate;
  const gameTimeET = new Date(gameDateIso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' ET';
  const venueId = g.venue?.id;
  const venueName = g.venue?.name;
  const status = g.status?.detailedState;
  console.log('statsapi:');
  console.log('  gamePk:      ' + g.gamePk);
  console.log('  gameNumber:  ' + (g.gameNumber || 1));
  console.log('  gameDate:    ' + gameDateIso);
  console.log('  game_time:   "' + gameTimeET + '"  (this is what scraper.fmtET would write)');
  console.log('  venue.id:    ' + venueId + '  (' + venueName + ')');
  console.log('  status:      ' + status);
  console.log('');

  // Parse
  const parsed = parseGameTimeToEtHm(gameTimeET);
  console.log('parseGameTimeToEtHm result: ' + JSON.stringify(parsed));

  // Override chain
  const venueIdOv = venueId != null ? VENUE_ID_OVERRIDES[venueId] : null;
  const teamDateOv = pickVenueOverride('ATH', date);
  const park = PARKS['ath'];
  let tz = PARK_TZ['ath'];
  let parkSource = 'home';
  let effectivePark = park;
  if (venueIdOv?.lat != null) {
    effectivePark = Object.assign({}, park, { lat: venueIdOv.lat, lng: venueIdOv.lng });
    if (venueIdOv.tz) tz = venueIdOv.tz;
    parkSource = 'venue_id_override:' + venueId;
  } else if (teamDateOv?.lat != null) {
    effectivePark = Object.assign({}, park, { lat: teamDateOv.lat, lng: teamDateOv.lng });
    if (teamDateOv.tz) tz = teamDateOv.tz;
    parkSource = 'team_date_override:' + teamDateOv.venue;
  }
  console.log('\noverride resolution:');
  console.log('  venueIdOv:   ' + JSON.stringify(venueIdOv));
  console.log('  teamDateOv:  ' + JSON.stringify(teamDateOv));
  console.log('  parkSource:  ' + parkSource);
  console.log('  final coords: ' + effectivePark.lat + ',' + effectivePark.lng);
  console.log('  final tz:     ' + tz);
  console.log('');

  // What target ISO does the code compute?
  const targetIso = parkLocalHourIso(date, gameTimeET, tz);
  console.log('parkLocalHourIso → ' + targetIso);
  console.log('');

  // Call the actual fetchWindAtCoords
  console.log('=== calling fetchWindAtCoords ===');
  const wx = await fetchWindAtCoords({
    lat: effectivePark.lat, lng: effectivePark.lng, tz,
    gameDate: date, gameTime: gameTimeET,
    sourceLabel: 'bos-ath probe',
    cacheBust: true,
  });
  console.log('\nresult: ' + JSON.stringify(wx, null, 2));

  if (wx && wx.tempF != null) {
    console.log('\ntempF=' + wx.tempF + '°F  windSpeed=' + wx.windSpeed + 'mph');
    console.log('If prod is showing ~78°F, that\'s hour-21 naive; correct is ~92°F (hour 18 PT).');
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
