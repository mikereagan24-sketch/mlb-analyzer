// v2 2026-04-09T20:19:46.283Z
const fetch = require('node-fetch');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const API_KEY = process.env.ANTHROPIC_API_KEY;

const BREF_TEAM_MAP = {
  'Los Angeles Dodgers':'LAD','Washington Nationals':'WAS','St. Louis Cardinals':'STL',
  'Detroit Tigers':'DET','Miami Marlins':'MIA','New York Yankees':'NYY',
  'San Diego Padres':'SD','Boston Red Sox':'BOS','Toronto Blue Jays':'TOR',
  'Chicago White Sox':'CWS','Cincinnati Reds':'CIN','Texas Rangers':'TEX',
  'Philadelphia Phillies':'PHI','Colorado Rockies':'COL','Tampa Bay Rays':'TB',
  'Minnesota Twins':'MIN','Chicago Cubs':'CHC','Cleveland Guardians':'CLE',
  'Baltimore Orioles':'BAL','Pittsburgh Pirates':'PIT','Milwaukee Brewers':'MIL',
  'Kansas City Royals':'KC','Seattle Mariners':'SEA','Los Angeles Angels':'LAA',
  'Houston Astros':'HOU','Athletics':'ATH','Oakland Athletics':'ATH',
  'Atlanta Braves':'ATL','Arizona Diamondbacks':'ARI','New York Mets':'NYM',
  'San Francisco Giants':'SF',
};

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, 'and').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .replace(/['\u2018\u2019`]/g, '').replace(/[\u201C\u201D]/g, '"')
    .replace(/\s{2,}/g, ' ').trim();
}

function sanitizeJSON(s) {
  return s
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/}\s*{/g, '},{');
}

function parseJSONRobust(text) {
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found');
  const jsonStr = sanitizeJSON(text.substring(start, end + 1));
  try { return JSON.parse(jsonStr); } catch(e) {
    console.log('[scraper] Full parse failed, using extractor');
  }
  const games = [];
  const pat = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
  let m;
  while ((m = pat.exec(jsonStr)) !== null) {
    try {
      const obj = JSON.parse(sanitizeJSON(m[0]));
      if (obj.away_team && obj.home_team) games.push(obj);
    } catch(e) {}
  }
  if (games.length > 0) {
    console.log('[scraper] Extracted ' + games.length + ' games via fallback');
    return games;
  }
  throw new Error('Could not parse any games from response');
}

async function callClaude(prompt, maxTokens) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error('Anthropic API error ' + resp.status + ': ' + await resp.text());
  const data = await resp.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// Classify dateStr relative to today/tomorrow in ET — handles DST correctly
function classifyDate(dateStr) {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const tomorrowET = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (dateStr === todayET) return 'today';
  if (dateStr === tomorrowET) return 'tomorrow';
  if (dateStr > tomorrowET) return 'future';
  return 'past';
}

// Extract date RotoWire is actually showing to verify we got the right page
function extractRotoWireDate(text) {
  const months = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  const abbrs = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (let i = 0; i < months.length; i++) {
    const pat = new RegExp('(?:' + abbrs[i] + '\\.?|' + months[i] + ')\\s+(\\d{1,2})[,\\s]+(202\\d)', 'i');
    const m = text.match(pat);
    if (m) {
      return m[2] + '-' + String(i + 1).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
    }
  }
  return null;
}

async function fetchLineups(dateStr) {
  console.log('[scraper] fetchLineups requested for ' + dateStr);

  const dayType = classifyDate(dateStr);
  console.log('[scraper] Date classification: ' + dayType + ' (today=' +
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) + ')');

  // Block past dates and far-future dates immediately — no external call needed
  if (dayType === 'past') {
    const msg = 'RotoWire only shows today and tomorrow. Use manual injection for past dates.';
    console.log('[scraper] Blocked: ' + msg);
    return { skipped: true, reason: 'past_date', message: msg };
  }
  if (dayType === 'future') {
    const msg = 'RotoWire only shows today and tomorrow. Check back closer to ' + dateStr + '.';
    console.log('[scraper] Blocked: ' + msg);
    return { skipped: true, reason: 'future_date', message: msg };
  }

  // Choose correct URL — today uses base URL, tomorrow uses ?date=tomorrow
  const url = dayType === 'tomorrow'
    ? 'https://www.rotowire.com/baseball/daily-lineups.php?date=tomorrow'
    : 'https://www.rotowire.com/baseball/daily-lineups.php';

  console.log('[scraper] Fetching: ' + url);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
  });
  if (!resp.ok) throw new Error('RotoWire fetch failed: ' + resp.status);
  const html = await resp.text();
  const fullText = htmlToText(html);
  console.log('[scraper] RotoWire text length: ' + fullText.length);

  // Verify the date RotoWire is actually showing
  const detectedDate = extractRotoWireDate(fullText.substring(0, 4000));
  console.log('[scraper] RotoWire detected date: ' + (detectedDate || 'UNKNOWN') + ' | requested: ' + dateStr);

  if (detectedDate && detectedDate !== dateStr) {
    const msg = 'RotoWire is showing ' + detectedDate + ' but you requested ' + dateStr + '. Page may not be available yet.';
    console.log('[scraper] DATE MISMATCH — aborting to prevent bad data');
    return { skipped: true, reason: 'date_mismatch', message: msg, rotowireDate: detectedDate };
  }

  // Find the lineup section start
  const markers = ['Confirmed Lineup', 'Expected Lineup', 'PM ET', 'AM ET'];
  let sectionStart = fullText.length;
  for (const mk of markers) {
    const idx = fullText.indexOf(mk);
    if (idx > 0 && idx < sectionStart) sectionStart = idx;
  }
  const start = Math.max(0, sectionStart - 200);
  const chunk = fullText.substring(start, start + 50000)
    .replace(/'/g, '').replace(/\u2019/g, '').replace(/`/g, '');

  const prompt = `Extract ALL MLB games from this RotoWire lineup page for ${dateStr}. Include Confirmed AND Expected lineups. Never skip a game.

CRITICAL rules:
- awaySP = pitcher for AWAY team (pitches against HOME batters)
- homeSP = pitcher for HOME team (pitches against AWAY batters)
- market_away_ml: negative for favorites (e.g. -154), POSITIVE for underdogs (e.g. +130). Include the sign.
- market_home_ml: same rule — negative favorite, positive underdog.
- Both teams in a game must have opposite signs (one negative, one positive) UNLESS they are near even.
- Do NOT use apostrophes anywhere in JSON output.

Return ONLY a raw JSON array with this exact structure:
[{"game_id":"chc-cle","away_team":"CHC","home_team":"CLE","time":"1:10 PM ET","lineup_status":"confirmed","away_sp":{"name":"Edward Cabrera","hand":"R"},"home_sp":{"name":"Slade Cecconi","hand":"R"},"market_away_ml":-134,"market_home_ml":114,"market_total":7.5,"park_factor":0.95,"away_lineup":[{"slot":1,"name":"Nico Hoerner","hand":"R"},{"slot":2,"name":"Alex Bregman","hand":"R"}],"home_lineup":[{"slot":1,"name":"Steven Kwan","hand":"L"},{"slot":2,"name":"Chase DeLauter","hand":"L"}]}]

Teams: LAD WAS STL DET MIA NYY SD BOS TOR CWS CIN TEX PHI COL TB MIN CHC CLE BAL PIT MIL KC SEA LAA HOU ATH ATL ARI NYM SF (Athletics=ATH not OAK)
Park factors: LAD:1.00 WAS:1.02 STL:0.99 DET:0.96 MIA:1.01 NYY:1.04 SD:0.94 BOS:1.03 TOR:1.01 CWS:1.01 CIN:1.06 TEX:1.02 PHI:1.03 COL:1.16 TB:0.97 MIN:0.97 CHC:1.04 CLE:0.95 BAL:1.02 PIT:0.97 MIL:0.97 KC:0.97 SEA:0.95 LAA:0.97 HOU:1.00 ATH:0.96 ATL:1.03 ARI:1.06 NYM:1.01 SF:0.93
Hands: R=right L=left S=switch
Raw JSON array only — no markdown, no explanation.

PAGE TEXT:
${chunk}`;

  const text = await callClaude(prompt, 8000);
  const games = parseJSONRobust(text);

  // Post-process: fix underdog moneylines that came back negative when they should be positive
  // If both teams have negative ML something is wrong — flip the smaller absolute value to positive
  for (const g of games) {
    const aml = g.market_away_ml;
    const hml = g.market_home_ml;
    if (aml && hml && aml < 0 && hml < 0) {
      // Both negative — the lesser absolute value should be positive (underdog)
      if (Math.abs(aml) < Math.abs(hml)) {
        g.market_away_ml = Math.abs(aml);
        console.log('[scraper] Fixed underdog ML: ' + g.game_id + ' away ' + aml + ' -> +' + Math.abs(aml));
      } else {
        g.market_home_ml = Math.abs(hml);
        console.log('[scraper] Fixed underdog ML: ' + g.game_id + ' home ' + hml + ' -> +' + Math.abs(hml));
      }
    }
  }

  console.log('[scraper] Returning ' + games.length + ' games for ' + dateStr);
  return games;
}

async function fetchScores(dateStr) {
  // Uses MLB Stats API — free, no auth, returns final scores as JSON
  const TEAM_MAP = {
    'San Diego Padres':'SD','Boston Red Sox':'BOS','Pittsburgh Pirates':'PIT',
    'Kansas City Royals':'KC','Cleveland Guardians':'CLE','Milwaukee Brewers':'MIL',
    'Baltimore Orioles':'BAL','Chicago White Sox':'CWS','Seattle Mariners':'SEA',
    'Texas Rangers':'TEX','Los Angeles Dodgers':'LAD','Toronto Blue Jays':'TOR',
    'Houston Astros':'HOU','Colorado Rockies':'COL','Philadelphia Phillies':'PHI',
    'San Francisco Giants':'SF','St. Louis Cardinals':'STL','Washington Nationals':'WAS',
    'Atlanta Braves':'ATL','Los Angeles Angels':'LAA','Arizona Diamondbacks':'ARI',
    'New York Mets':'NYM','Cincinnati Reds':'CIN','Miami Marlins':'MIA',
    'Chicago Cubs':'CHC','Tampa Bay Rays':'TB','Athletics':'ATH',
    'New York Yankees':'NYY','Detroit Tigers':'DET','Minnesota Twins':'MIN',
  };
  const [year, month, day] = dateStr.split('-');
  const mmdd = month.padStart(2,'0')+'/'+day.padStart(2,'0')+'/'+year;
  const url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date='+mmdd+'&hydrate=linescore';
  const resp = await fetch(url, {headers:{'Accept':'application/json'}});
  if (!resp.ok) throw new Error('MLB API error: '+resp.status);
  const data = await resp.json();
  const games = (data.dates||[])[0]?.games || [];
  const results = [];
  for (const g of games) {
    if (g.status?.detailedState !== 'Final') continue;
    const awayName = g.teams?.away?.team?.name;
    const homeName = g.teams?.home?.team?.name;
    const awayScore = g.teams?.away?.score;
    const homeScore = g.teams?.home?.score;
    const away = TEAM_MAP[awayName];
    const home = TEAM_MAP[homeName];
    if (!away || !home || awayScore == null || homeScore == null) {
      console.log('[scores] Skipping unmapped: '+awayName+' @ '+homeName);
      continue;
    }
    results.push({away, home, awayScore, homeScore, gameId: (away+'-'+home).toLowerCase()});
  }
  return results;
}



const ODDS_TEAM_MAP = {
  'Arizona Diamondbacks':'ARI','Atlanta Braves':'ATL','Baltimore Orioles':'BAL',
  'Boston Red Sox':'BOS','Chicago Cubs':'CHC','Chicago White Sox':'CWS',
  'Cincinnati Reds':'CIN','Cleveland Guardians':'CLE','Colorado Rockies':'COL',
  'Detroit Tigers':'DET','Houston Astros':'HOU','Kansas City Royals':'KC',
  'Los Angeles Angels':'LAA','Los Angeles Dodgers':'LAD','Miami Marlins':'MIA',
  'Milwaukee Brewers':'MIL','Minnesota Twins':'MIN','New York Mets':'NYM',
  'New York Yankees':'NYY','Athletics':'ATH','Oakland Athletics':'ATH',
  'Philadelphia Phillies':'PHI','Pittsburgh Pirates':'PIT','San Diego Padres':'SD',
  'San Francisco Giants':'SF','Seattle Mariners':'SEA','St. Louis Cardinals':'STL',
  'Tampa Bay Rays':'TB','Texas Rangers':'TEX','Toronto Blue Jays':'TOR',
  'Washington Nationals':'WAS',
};

// Kalshi prediction market odds
// No API key needed - public market data
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// Convert Kalshi decimal probability to American odds
function kalshiToAmerican(prob) {
  if (!prob || prob <= 0 || prob >= 1) return null;
  if (prob >= 0.5) return Math.round(-(prob / (1 - prob)) * 100);
  return Math.round(((1 - prob) / prob) * 100);
}

// Map Kalshi team names to our abbreviations
const KALSHI_TEAM_MAP = {
  'Arizona Diamondbacks': 'ari', 'Atlanta Braves': 'atl', 'Baltimore Orioles': 'bal',
  'Boston Red Sox': 'bos', 'Chicago Cubs': 'chc', 'Chicago White Sox': 'cws',
  'Cincinnati Reds': 'cin', 'Cleveland Guardians': 'cle', 'Colorado Rockies': 'col',
  'Detroit Tigers': 'det', 'Houston Astros': 'hou', 'Kansas City Royals': 'kc',
  'Los Angeles Angels': 'laa', 'Los Angeles Dodgers': 'lad', 'Miami Marlins': 'mia',
  'Milwaukee Brewers': 'mil', 'Minnesota Twins': 'min', 'New York Mets': 'nym',
  'New York Yankees': 'nyy', 'Oakland Athletics': 'ath', 'Philadelphia Phillies': 'phi',
  'Pittsburgh Pirates': 'pit', 'San Diego Padres': 'sd', 'San Francisco Giants': 'sfg',
  'Seattle Mariners': 'sea', 'St. Louis Cardinals': 'stl', 'Tampa Bay Rays': 'tb',
  'Texas Rangers': 'tex', 'Toronto Blue Jays': 'tor', 'Washington Nationals': 'was',
  'Athletics': 'ath', 'Angels': 'laa', 'Astros': 'hou', 'Blue Jays': 'tor',
  'Braves': 'atl', 'Brewers': 'mil', 'Cardinals': 'stl', 'Cubs': 'chc',
  'Diamondbacks': 'ari', 'Dodgers': 'lad', 'Giants': 'sfg', 'Guardians': 'cle',
  'Mariners': 'sea', 'Marlins': 'mia', 'Mets': 'nym', 'Nationals': 'was',
  'Orioles': 'bal', 'Padres': 'sd', 'Phillies': 'phi', 'Pirates': 'pit',
  'Rangers': 'tex', 'Rays': 'tb', 'Red Sox': 'bos', 'Reds': 'cin',
  'Rockies': 'col', 'Royals': 'kc', 'Tigers': 'det', 'Twins': 'min',
  'White Sox': 'cws', 'Yankees': 'nyy',
};

function teamToAbbr(name) {
  if (!name) return null;
  // Try full name first, then last word
  if (KALSHI_TEAM_MAP[name]) return KALSHI_TEAM_MAP[name];
  const parts = name.split(' ');
  const last = parts[parts.length - 1];
  return KALSHI_TEAM_MAP[last] || null;
}

async function fetchKalshiOdds(dateStr) {
  // Fetch all open KXMLBGAME markets (moneyline - game winner)
  const mlUrl = KALSHI_BASE + '/events?series_ticker=KXMLBGAME&with_nested_markets=true&status=open&limit=50';
  const mlResp = await fetch(mlUrl, { headers: { 'Accept': 'application/json' } });
  if (!mlResp.ok) throw new Error('Kalshi ML fetch error ' + mlResp.status);
  const mlData = await mlResp.json();
  const events = mlData.events || [];
  console.log('[kalshi] fetched ' + events.length + ' game events');

  // Also fetch total runs markets
  const totUrl = KALSHI_BASE + '/events?series_ticker=KXMLBGAMETOTAL&with_nested_markets=true&status=open&limit=50';
  let totEvents = [];
  try {
    const totResp = await fetch(totUrl, { headers: { 'Accept': 'application/json' } });
    if (totResp.ok) {
      const totData = await totResp.json();
      totEvents = totData.events || [];
      console.log('[kalshi] fetched ' + totEvents.length + ' total events');
    }
  } catch(e) { console.log('[kalshi] no total markets: ' + e.message); }

  // Build totals lookup: event_ticker → {line, overProb, underProb}
  const totalsMap = {};
  for (const ev of totEvents) {
    const mkts = ev.markets || [];
    // Markets are like "Over 7.5" - find the one with highest volume
    for (const m of mkts) {
      const lineMatch = (m.yes_sub_title || m.title || '').match(/([\d.]+)/);
      if (!lineMatch) continue;
      const line = parseFloat(lineMatch[1]);
      const yesBid = parseFloat(m.yes_bid_dollars || 0);
      const noBid = parseFloat(m.no_bid_dollars || 0);
      // Store by event ticker + line
      const key = (ev.sub_title || ev.title || '').toLowerCase();
      if (!totalsMap[key]) totalsMap[key] = {};
      totalsMap[key][line] = { overProb: yesBid, underProb: noBid, line };
    }
  }

  // Parse ML events into our game format
  const results = [];
  for (const ev of events) {
    const mkts = ev.markets || [];
    if (!mkts.length) continue;

    // Each event has exactly 2 markets: away team wins, home team wins
    // sub_title format: "Team A" or we need to parse from yes_sub_title
    // title format typically: "Team A vs Team B" or "Team A @ Team B"
    const title = ev.title || ev.sub_title || '';
    const awayMkt = mkts.find(m => (m.yes_sub_title||'').toLowerCase().includes('away') ||
                                    mkts.indexOf(m) === 0);
    const homeMkt = mkts.find(m => (m.yes_sub_title||'').toLowerCase().includes('home') ||
                                    mkts.indexOf(m) === 1);
    if (!awayMkt || !homeMkt) continue;

    const awayProb = parseFloat(awayMkt.yes_bid_dollars || 0);
    const homeProb = parseFloat(homeMkt.yes_bid_dollars || 0);
    if (!awayProb || !homeProb) continue;

    // Parse team names from yes_sub_title
    const awayName = awayMkt.yes_sub_title || '';
    const homeName = homeMkt.yes_sub_title || '';
    const awayAbbr = teamToAbbr(awayName.replace(/\s+wins?$/i,'').trim());
    const homeAbbr = teamToAbbr(homeName.replace(/\s+wins?$/i,'').trim());
    if (!awayAbbr || !homeAbbr) {
      console.log('[kalshi] could not map teams: ' + awayName + ' / ' + homeName);
      continue;
    }

    const awayML = kalshiToAmerican(awayProb);
    const homeML = kalshiToAmerican(homeProb);

    // Look up totals
    const evKey = (ev.sub_title || title).toLowerCase();
    const totData = totalsMap[evKey] || {};
    const totLines = Object.keys(totData).map(Number).sort((a,b)=>a-b);
    // Use the most liquid line (closest to 0.5 prob)
    let marketTotal = null, overPrice = -110, underPrice = -110;
    if (totLines.length) {
      const bestLine = totLines.reduce((best, l) => {
        const t = totData[l];
        const dist = Math.abs(t.overProb - 0.5);
        return dist < Math.abs((totData[best]?.overProb||0) - 0.5) ? l : best;
      }, totLines[0]);
      marketTotal = bestLine;
      overPrice = kalshiToAmerican(totData[bestLine].overProb);
      underPrice = kalshiToAmerican(totData[bestLine].underProb);
    }

    results.push({
      awayTeam: awayAbbr, homeTeam: homeAbbr,
      awayML, homeML,
      marketTotal, overPrice: overPrice || -110, underPrice: underPrice || -110,
      source: 'kalshi',
      volume: parseFloat(awayMkt.volume_fp || 0) + parseFloat(homeMkt.volume_fp || 0),
    });
  }

  console.log('[kalshi] parsed ' + results.length + ' games with odds');
  return results;
}


module.exports = { fetchLineups, fetchScores, fetchKalshiOdds, makeGameId };
