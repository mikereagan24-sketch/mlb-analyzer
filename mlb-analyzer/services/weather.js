'use strict';

// Ballpark data: lat, lng, outfield_dir (compass degrees FROM home plate TOWARD CF),
// sensitivity (0-2 scale; Wrigley=2 most wind-sensitive, typical=1)
const PARKS = {
  'chc': { lat:41.9484, lng:-87.6553, cfDir:60,  sens:2.0, name:'Wrigley Field' },
  'cws': { lat:41.8300, lng:-87.6339, cfDir:5,   sens:1.0, name:'Guaranteed Rate' },
  'nyy': { lat:40.8296, lng:-73.9262, cfDir:45,  sens:1.0, name:'Yankee Stadium' },
  'nym': { lat:40.7571, lng:-73.8458, cfDir:45,  sens:1.0, name:'Citi Field' },
  'bos': { lat:42.3467, lng:-71.0972, cfDir:75,  sens:1.5, name:'Fenway Park' },
  'det': { lat:42.3390, lng:-83.0485, cfDir:45,  sens:1.0, name:'Comerica Park' },
  'cle': { lat:41.4962, lng:-81.6852, cfDir:45,  sens:1.2, name:'Progressive Field' },
  'min': { lat:44.9817, lng:-93.2776, cfDir:45,  sens:0.8, name:'Target Field' },
  'tor': { lat:43.6414, lng:-79.3894, cfDir:45,  sens:0.7, name:'Rogers Centre' },
  'bal': { lat:39.2838, lng:-76.6218, cfDir:45,  sens:1.0, name:'Camden Yards' },
  'was': { lat:38.8730, lng:-77.0074, cfDir:45,  sens:1.0, name:'Nationals Park' },
  'atl': { lat:33.8908, lng:-84.4677, cfDir:45,  sens:0.8, name:'Truist Park' },
  'mia': { lat:25.7781, lng:-80.2197, cfDir:45,  sens:0.5, name:'LoanDepot Park' },
  'phi': { lat:39.9061, lng:-75.1665, cfDir:45,  sens:1.0, name:'Citizens Bank' },
  'pit': { lat:40.4469, lng:-80.0058, cfDir:30,  sens:1.2, name:'PNC Park' },
  'cin': { lat:39.0979, lng:-84.5082, cfDir:45,  sens:1.0, name:'Great American' },
  'mil': { lat:43.0280, lng:-87.9712, cfDir:45,  sens:0.8, name:'American Family' },
  'stl': { lat:38.6226, lng:-90.1930, cfDir:25,  sens:1.0, name:'Busch Stadium' },
  'chc': { lat:41.9484, lng:-87.6553, cfDir:60,  sens:2.0, name:'Wrigley Field' },
  'col': { lat:39.7559, lng:-104.9942,cfDir:45,  sens:0.5, name:'Coors Field' },
  'ari': { lat:33.4453, lng:-112.0667,cfDir:45,  sens:0.5, name:'Chase Field' },
  'lad': { lat:34.0739, lng:-118.2400,cfDir:45,  sens:0.8, name:'Dodger Stadium' },
  'sfg': { lat:37.7786, lng:-122.3893,cfDir:90,  sens:1.8, name:'Oracle Park' },
  'oak': { lat:37.7516, lng:-122.2005,cfDir:45,  sens:1.2, name:'RingCentral' },
  'ath': { lat:37.7516, lng:-122.2005,cfDir:45,  sens:1.2, name:'RingCentral' },
  'sea': { lat:47.5914, lng:-122.3325,cfDir:45,  sens:1.0, name:'T-Mobile Park' },
  'tex': { lat:32.7512, lng:-97.0832, cfDir:45,  sens:0.7, name:'Globe Life' },
  'hou': { lat:29.7573, lng:-95.3555, cfDir:45,  sens:0.6, name:'Minute Maid' },
  'laa': { lat:33.8003, lng:-117.8827,cfDir:45,  sens:0.8, name:'Angel Stadium' },
  'kan': { lat:39.0517, lng:-94.4803, cfDir:45,  sens:1.0, name:'Kauffman' },
  'kc':  { lat:39.0517, lng:-94.4803, cfDir:45,  sens:1.0, name:'Kauffman' },
  'sd':  { lat:32.7076, lng:-117.1570,cfDir:45,  sens:0.6, name:'Petco Park' },
  'tb':  { lat:27.7683, lng:-82.6534, cfDir:45,  sens:0.5, name:'Tropicana' },
  'nyy': { lat:40.8296, lng:-73.9262, cfDir:45,  sens:1.0, name:'Yankee Stadium' },
};

// Wind factor: positive = blowing out (more runs), negative = blowing in (fewer runs)
// Uses dot product of wind vector with outfield vector
// Returns factor in range roughly -1 to +1, scaled by sensitivity and speed
function calcWindFactor(windDir, windSpeed, park) {
  if (!park || !windSpeed) return 0;
  // Convert wind direction (where wind comes FROM) to where it goes TO
  const windTo = (windDir + 180) % 360;
  // Angle between wind direction and CF direction
  const diff = windTo - park.cfDir;
  const rad = diff * Math.PI / 180;
  const alignment = Math.cos(rad); // +1 = blowing straight out, -1 = blowing straight in
  // Scale: 10mph aligned = factor of ~0.5 at sens=1
  const factor = alignment * (windSpeed / 20) * park.sens;
  return parseFloat(factor.toFixed(3));
}

// Fetch wind at game time for a specific park
async function fetchParkWind(homeTeam, gameDate, gameTime) {
  // Find park
  const teamKey = (homeTeam || '').toLowerCase().replace(/[^a-z]/g,'');
  const park = PARKS[teamKey];
  if (!park) return null;

  // Parse game time to get UTC hour
  let gameHour = 18; // default 6pm local
  if (gameTime) {
    const m = gameTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (m) {
      let h = parseInt(m[1]), mn = parseInt(m[2]), ap = m[3].toUpperCase();
      if (ap==='PM' && h!==12) h+=12;
      if (ap==='AM' && h===12) h=0;
      gameHour = h;
    }
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${park.lat}&longitude=${park.lng}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=mph&timezone=auto&start_date=${gameDate}&end_date=${gameDate}`;
    const data = await fetch(url).then(r=>r.json());
    
    // Find the hour closest to game time
    const hours = data.hourly?.time || [];
    const idx = Math.min(gameHour, hours.length-1);
    const windSpeed = data.hourly.wind_speed_10m?.[idx] || 0;
    const windDir   = data.hourly.wind_direction_10m?.[idx] || 0;
    const factor    = calcWindFactor(windDir, windSpeed, park);

    return { windSpeed, windDir, factor, parkName: park.name, cfDir: park.cfDir };
  } catch(e) {
    console.error('[weather] fetch failed for '+homeTeam+':', e.message);
    return null;
  }
}

module.exports = { fetchParkWind, calcWindFactor, PARKS };
