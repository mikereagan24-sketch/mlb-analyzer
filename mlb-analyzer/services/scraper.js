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

async function callClaude(prompt, maxTokens, attempt = 0) {
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
  // Retry on 529 (overloaded) or 529 with exponential backoff — up to 4 attempts
  if (resp.status === 529 || resp.status === 529) {
    if (attempt < 4) {
      const wait = Math.pow(2, attempt) * 3000; // 3s, 6s, 12s, 24s
      console.log('[scraper] Anthropic overloaded (529), retrying in ' + (wait/1000) + 's (attempt ' + (attempt+1) + '/4)');
      await new Promise(r => setTimeout(r, wait));
      return callClaude(prompt, maxTokens, attempt + 1);
    }
    throw new Error('Anthropic API overloaded after 4 retries');
  }
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
Park factors: LAD:1.00 WAS:1.02 STL:0.99 DET:0.96 MIA:1.01 NYY:1.04 SD:0.94 BOS:1.03 TOR:1.01 CWS:1.01 CIN:1.06 TEX:1.02 PHI:1.03 COL:1.16 TB:0.97 MIN:0.97 CHC:1.04 CLE:0.95 BAL:1.02 PIT:0.97 MIL:0.97 KC:1.00 SEA:0.95 LAA:0.97 HOU:1.00 ATH:1.12 ATL:1.03 ARI:1.06 NYM:1.01 SF:0.93
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
  const resp = await fetch(url+'&_t='+Date.now(), {headers:{'Accept':'application/json','Cache-Control':'no-cache'}});
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

// Odds via The Odds API — Kalshi (primary, us_ex region) + DraftKings (fallback, us region)
// Bookmaker keys: 'kalshi' | 'draftkings'
// Regions: 'us_ex' for exchanges (Kalshi) | 'us' for sportsbooks (DK)


const TEAM_NAME_MAP = {
  'Arizona Diamondbacks':'ari','Atlanta Braves':'atl','Baltimore Orioles':'bal',
  'Boston Red Sox':'bos','Chicago Cubs':'chc','Chicago White Sox':'cws',
  'Cincinnati Reds':'cin','Cleveland Guardians':'cle','Colorado Rockies':'col',
  'Detroit Tigers':'det','Houston Astros':'hou','Kansas City Royals':'kc',
  'Los Angeles Angels':'laa','Los Angeles Dodgers':'lad','Miami Marlins':'mia',
  'Milwaukee Brewers':'mil','Minnesota Twins':'min','New York Mets':'nym',
  'New York Yankees':'nyy','Oakland Athletics':'ath','Philadelphia Phillies':'phi',
  'Pittsburgh Pirates':'pit','San Diego Padres':'sd','San Francisco Giants':'sf',
  'Seattle Mariners':'sea','St. Louis Cardinals':'stl','Tampa Bay Rays':'tb',
  'Texas Rangers':'tex','Toronto Blue Jays':'tor','Washington Nationals':'was',
  'Athletics':'ath',
};
function teamToAbbr(name) {
  if (!name) return null;
  return TEAM_NAME_MAP[name] || null;
}

function parseOddsAPIResponse(games, bookmakerKey, totalBookmakerKey) {
  const results = [];
  for (const g of games) {
    const bk = g.bookmakers?.find(b => b.key === bookmakerKey);
    if (!bk) continue;
    const h2h = bk.markets?.find(m => m.key === 'h2h');
    // For totals, prefer totalBookmakerKey (e.g. polymarket) if provided and available
    const totBk = totalBookmakerKey
      ? (g.bookmakers?.find(b => b.key === totalBookmakerKey) || bk)
      : bk;
    const tot = totBk.markets?.find(m => m.key === 'totals');
    const awayOut = h2h?.outcomes?.find(o => o.name === g.away_team);
    const homeOut = h2h?.outcomes?.find(o => o.name === g.home_team);
    const overOut = tot?.outcomes?.find(o => o.name === 'Over');
    const underOut = tot?.outcomes?.find(o => o.name === 'Under');
    const awayAbbr = teamToAbbr(g.away_team);
    const homeAbbr = teamToAbbr(g.home_team);
    if (!awayAbbr || !homeAbbr) { console.log('[odds] no abbr for '+g.away_team+' / '+g.home_team); continue; }
    results.push({
      game_id: (awayAbbr + '-' + homeAbbr).toLowerCase(),
      awayTeam: awayAbbr, homeTeam: homeAbbr,
      market_away_ml: awayOut?.price || null,
      market_home_ml: homeOut?.price || null,
      market_total: overOut?.point || null,
      over_price: overOut?.price || -110,
      under_price: underOut?.price || -110,
      source: bookmakerKey,
    });
  }
  return results;
}

async function fetchOddsForBookmaker(apiKey, region, bookmaker) {
  const bkParam = bookmaker ? '&bookmakers='+bookmaker : '';
  const url = 'https://api.the-odds-api.com/v4/sports/baseball_mlb/odds' +
    '?apiKey='+apiKey+'&regions='+region+'&markets=h2h,totals&oddsFormat=american'+bkParam;
  const resp = await fetch(url, {headers:{'Accept':'application/json'}});
  if (!resp.ok) throw new Error('Odds API '+bookmaker+' error '+resp.status+': '+await resp.text());
  const remaining = resp.headers.get('x-requests-remaining');
  console.log('[odds] '+bookmaker+' remaining requests: '+remaining);
  return await resp.json();
}

async function fetchOddsAPI(apiKey, dateStr) {
  // If no key, go direct immediately
  if (!apiKey) {
    console.log('[odds] No API key — using direct Kalshi');
    return await fetchKalshiDirect(dateStr);
  }

  // Filter games commencing on dateStr (as ET date).
  // ET dates don't align with UTC: a 10 PM ET game on Apr 14 = 2 AM UTC Apr 15.
  // Strategy: include all games within a 30-hour window centered on dateStr,
  // then deduplicate same team-pair matchups keeping LATEST commence_time
  // (latest = the upcoming game, earlier = yesterday's already-played game)
  const filterByDate = (games) => {
    // Window: dateStr 10:00 UTC through dateStr+2 10:00 UTC (covers all ET games for that date)
    const windowStart = dateStr + 'T10:00:00Z'; // ~6 AM ET = after overnight games
    const nextNext = new Date(dateStr + 'T10:00:00Z');
    nextNext.setDate(nextNext.getDate() + 2);
    const windowEnd = nextNext.toISOString();
    const filtered = games.filter(g => {
      if (!dateStr || !g.commence_time) return true;
      return g.commence_time >= windowStart && g.commence_time < windowEnd;
    });
    // Deduplicate by team pair — keep LATEST commence_time (upcoming game, not completed one)
    const byPair = {};
    filtered.forEach(g => {
      const key = g.away_team + '|' + g.home_team;
      if (!byPair[key] || g.commence_time > byPair[key].commence_time) {
        byPair[key] = g;
      }
    });
    return Object.values(byPair);
  };

  // 1. Try Kalshi first (us_ex region)
  try {
    const allUsExGames = filterByDate(await fetchOddsForBookmaker(apiKey, 'us_ex', ''));
    const kalshiResults = parseOddsAPIResponse(allUsExGames, 'kalshi', 'polymarket');
    if (kalshiResults.length > 0) {
      console.log('[odds] Kalshi: '+kalshiResults.length+' games — '+kalshiResults.map(g=>g.game_id+'('+g.market_away_ml+'/'+g.market_home_ml+')').join(', '));

      // 2. Also fetch DK to fill in any games Kalshi is missing
      let dkResults = [];
      try {
        const dkGames = filterByDate(await fetchOddsForBookmaker(apiKey, 'us', 'draftkings'));
        dkResults = parseOddsAPIResponse(dkGames, 'draftkings');
        console.log('[odds] DraftKings: '+dkResults.length+' games (for gap-fill)');
      } catch(e) { console.log('[odds] DK gap-fill failed: '+e.message); }

      // Merge: use Kalshi ML lines, DK totals (Kalshi often lacks totals or has worse lines)
      const dkByGameId = {};
      dkResults.forEach(g => { dkByGameId[g.game_id] = g; });
      const merged = kalshiResults.map(k => {
        const dk = dkByGameId[k.game_id];
        return {
          ...k,
          // Kalshi total is primary (matches Robinhood), DK only fills if Kalshi has none
          market_total:  (k.market_total   != null ? k.market_total   : dk?.market_total),
          over_price:    (k.over_price      != null ? k.over_price     : dk?.over_price),
          under_price:   (k.under_price     != null ? k.under_price    : dk?.under_price),
        };
      });
      // Add any DK games not on Kalshi
      const kalshiIds = new Set(kalshiResults.map(g=>g.game_id));
      const dkOnly = dkResults.filter(g => !kalshiIds.has(g.game_id));
      if (dkOnly.length) console.log('[odds] DK filling '+dkOnly.length+' games not on Kalshi');
      return [...merged, ...dkOnly];
    }
    console.log('[odds] Kalshi returned 0 games — falling back to DraftKings');
  } catch(e) { console.log('[odds] Kalshi failed: '+e.message+' — trying DraftKings'); }

  // 3. Full DK fallback (also catches 401 → direct Kalshi)
  try {
    const dkGames = filterByDate(await fetchOddsForBookmaker(apiKey, 'us', 'draftkings'));
    const dkResults = parseOddsAPIResponse(dkGames, 'draftkings');
    console.log('[odds] DraftKings fallback: '+dkResults.length+' games');
    return dkResults;
  } catch(e) {
    if (e.message && (e.message.includes('OUT_OF_USAGE_CREDITS') || e.message.includes('401'))) {
      console.log('[odds] Odds API credits exhausted — switching to direct Kalshi');
      return await fetchKalshiDirect(dateStr);
    }
    throw e;
  }
}


function makeGameId(away, home) {
  const a = (away||'').toLowerCase().replace(/[^a-z]/g,'');
  const h = (home||'').toLowerCase().replace(/[^a-z]/g,'');
  return a+'-'+h;
}

// ── Direct Kalshi scraper (no Odds API credits needed) ───────────────────────
// Hits api.elections.kalshi.com directly. No auth required for market data.
// MLB series tickers: KXMLB (moneyline), KXMLBT (totals)
const KALSHI_TEAM_MAP = {
  'Arizona Diamondbacks':'ari','Atlanta Braves':'atl','Baltimore Orioles':'bal',
  'Boston Red Sox':'bos','Chicago Cubs':'chc','Chicago White Sox':'cws',
  'Cincinnati Reds':'cin','Cleveland Guardians':'cle','Colorado Rockies':'col',
  'Detroit Tigers':'det','Houston Astros':'hou','Kansas City Royals':'kc',
  'Los Angeles Angels':'laa','Los Angeles Dodgers':'lad','Miami Marlins':'mia',
  'Milwaukee Brewers':'mil','Minnesota Twins':'min','New York Mets':'nym',
  'New York Yankees':'nyy','Oakland Athletics':'ath','Athletics':'ath',
  'Philadelphia Phillies':'phi','Pittsburgh Pirates':'pit','San Diego Padres':'sd',
  'San Francisco Giants':'sf','Seattle Mariners':'sea','St. Louis Cardinals':'stl',
  'Tampa Bay Rays':'tb','Texas Rangers':'tex','Toronto Blue Jays':'tor',
  'Washington Nationals':'was',
};

async function fetchKalshiDirect(dateStr) {
  const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  const results = {};

  // Fetch ML markets for the date
  // Kalshi uses event tickers like KXMLB-26APR14-CHCPHI
  // We can search by series and status=open
  async function fetchMarkets(seriesTicker) {
    const url = BASE+'/markets?series_ticker='+seriesTicker+'&status=open&limit=100';
    const r = await fetch(url, {headers:{'Accept':'application/json'}});
    if (!r.ok) throw new Error('Kalshi '+seriesTicker+' HTTP '+r.status);
    const d = await r.json();
    return d.markets || [];
  }

  // Fetch orderbook/price for a market ticker
  async function fetchPrice(ticker) {
    const url = BASE+'/markets/'+ticker;
    const r = await fetch(url, {headers:{'Accept':'application/json'}});
    if (!r.ok) return null;
    const d = await r.json();
    return d.market;
  }

  // Parse date string into Kalshi date format (26APR14)
  const [year, month, day] = dateStr.split('-');
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const kalshiDate = (parseInt(year)-2000).toString().padStart(2,'0') + MONTHS[parseInt(month)-1] + day;

  // Fetch ML markets
  try {
    const mlMarkets = await fetchMarkets('KXMLB');
    const dateMarkets = mlMarkets.filter(m => m.event_ticker?.includes(kalshiDate));
    console.log('[kalshi-direct] ML markets for '+kalshiDate+': '+dateMarkets.length);

    for (const m of dateMarkets) {
      // Event ticker format: KXMLB-26APR14-CHCPHI
      // Market ticker: KXMLB-26APR14-CHCPHI-CHC (home) or -PHI (away)
      const ticker = m.ticker || '';
      // Extract teams from event ticker
      const eventTicker = m.event_ticker || '';
      const teamsPart = eventTicker.split('-').slice(2).join('-'); // e.g. CHCPHI or NYM-LAD
      
      if (!results[eventTicker]) results[eventTicker] = { eventTicker, ml: {}, total: null };
      
      // yes_bid = probability market thinks this team wins
      // Convert to American odds: if p > 0.5: -(p/(1-p)*100), else: (1-p)/p*100
      const yesAsk = m.yes_ask; // cents (0-100)
      const noAsk  = m.no_ask;
      if (yesAsk != null) {
        const p = yesAsk / 100;
        const ml = p >= 0.5 ? -Math.round(p/(1-p)*100) : Math.round((1-p)/p*100);
        results[eventTicker].ml[ticker] = { p, ml, subtitle: m.subtitle };
      }
    }
  } catch(e) { console.log('[kalshi-direct] ML fetch failed: '+e.message); }

  // Fetch Totals markets
  try {
    const totMarkets = await fetchMarkets('KXMLBT');
    const dateMarkets = totMarkets.filter(m => m.event_ticker?.includes(kalshiDate));
    console.log('[kalshi-direct] Total markets for '+kalshiDate+': '+dateMarkets.length);

    for (const m of dateMarkets) {
      const eventTicker = m.event_ticker || '';
      if (!results[eventTicker]) results[eventTicker] = { eventTicker, ml: {}, total: null };
      // Subtitle contains the line e.g. "Over 8.5" or "Under 8.5"
      const sub = m.subtitle || '';
      const match = sub.match(/(Over|Under)\s+([\d.]+)/i);
      if (match && match[1].toLowerCase() === 'over') {
        const line = parseFloat(match[2]);
        const p = (m.yes_ask||50) / 100;
        const ml = p >= 0.5 ? -Math.round(p/(1-p)*100) : Math.round((1-p)/p*100);
        results[eventTicker].total = { line, overML: ml, underML: -ml };
      }
    }
  } catch(e) { console.log('[kalshi-direct] Totals fetch failed: '+e.message); }

  return results;
}


module.exports = { fetchOddsAPI, fetchKalshiDirect, fetchLineups, fetchScores, makeGameId };
