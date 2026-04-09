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
  console.log('[scraper] Fetching Baseball Reference for ' + dateStr);
  const [year, month, day] = dateStr.split('-');
  const url = 'https://www.baseball-reference.com/boxes/index.fcgi?month=' + parseInt(month) + '&day=' + parseInt(day) + '&year=' + year;
  console.log('[scraper] BREF URL: ' + url);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
  });
  if (!resp.ok) throw new Error('Baseball Reference fetch failed: ' + resp.status);
  const html = await resp.text();
  const text = htmlToText(html);
  const scores = [];
  const teamNames = Object.keys(BREF_TEAM_MAP);
  teamNames.sort((a, b) => b.length - a.length);
  const escaped = teamNames.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // BREF format: "Away Team Score Final Home Team Score"
  const pat = new RegExp(
    '(' + escaped.join('|') + ')\\s+(\\d+)\\s+Final\\s+(' + escaped.join('|') + ')\\s+(\\d+)',
    'gi'  // case-insensitive flag added
  );
  let m;
  while ((m = pat.exec(text)) !== null) {
    const at = BREF_TEAM_MAP[m[1]];
    const ht = BREF_TEAM_MAP[m[3]];
    if (at && ht && at !== ht) {
      scores.push({ away_team: at, home_team: ht, away_score: parseInt(m[2]), home_score: parseInt(m[4]), final: true });
    }
  }
  console.log('[scraper] Parsed ' + scores.length + ' scores from Baseball Reference');
  return scores;
}

function makeGameId(awayTeam, homeTeam) {
  return (awayTeam + '-' + homeTeam).toLowerCase();
}

// Team name -> our abbreviation mapping for The Odds API
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

async function fetchOddsAPI(apiKey, dateStr) {
  if (!apiKey) throw new Error('No Odds API key configured');
  const url = 'https://api.the-odds-api.com/v4/sports/baseball_mlb/odds' +
    '?apiKey='+apiKey+'&regions=us&markets=h2h,totals&oddsFormat=american&bookmakers=draftkings,fanduel,betonlineag,bovada';
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error('Odds API error '+resp.status+': '+await resp.text());
  const games = await resp.json();
  console.log('[odds-api] Remaining requests: '+resp.headers.get('x-requests-remaining'));
  const BOOK_PRIORITY = ['draftkings','fanduel','betonlineag','bovada'];
  const results = [];
  for (const g of games) {
    const gameDate = new Date(g.commence_time).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
    if (gameDate !== dateStr) continue;
    // Skip games that have already started — Odds API returns live lines for in-progress games
    const commenceTime = new Date(g.commence_time);
    const nowUTC = new Date();
    if (commenceTime < nowUTC) {
      console.log('[odds-api] Skipping started game: '+g.away_team+' @ '+g.home_team+' (commenced '+Math.round((nowUTC-commenceTime)/60000)+'min ago)');
      continue;
    }
    const awayTeam = ODDS_TEAM_MAP[g.away_team];
    const homeTeam = ODDS_TEAM_MAP[g.home_team];
    if (!awayTeam || !homeTeam) continue;
    const book = BOOK_PRIORITY.map(k=>g.bookmakers?.find(b=>b.key===k)).find(Boolean);
    if (!book) continue;
    console.log('[odds-api] '+awayTeam+'@'+homeTeam+' using: '+book.key);
    const h2h    = book.markets?.find(m=>m.key==='h2h');
    const totals = book.markets?.find(m=>m.key==='totals');
    const awayOdds = h2h?.outcomes?.find(o=>ODDS_TEAM_MAP[o.name]===awayTeam||o.name===g.away_team);
    const homeOdds = h2h?.outcomes?.find(o=>ODDS_TEAM_MAP[o.name]===homeTeam||o.name===g.home_team);
    const overOdds  = totals?.outcomes?.find(o=>o.name==='Over');
    const underOdds = totals?.outcomes?.find(o=>o.name==='Under');
    results.push({
      game_id: makeGameId(awayTeam, homeTeam),
      away_team: awayTeam,
      home_team: homeTeam,
      market_away_ml: awayOdds?.price ?? null,
      market_home_ml: homeOdds?.price ?? null,
      market_total: overOdds?.point ?? null,
      over_price: overOdds?.price ?? -110,
      under_price: underOdds?.price ?? -110,
      commence_time: g.commence_time,
    });
  }
  console.log('[odds-api] Got '+results.length+' games for '+dateStr);
  return results;
}

module.exports = { fetchLineups, fetchScores, fetchOddsAPI, makeGameId };
