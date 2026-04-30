// v2 2026-04-09T20:19:46.283Z
const fetch = require('node-fetch');
const { db } = require('../db/schema');

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
  // Retry on 529 (overloaded) or 529 with exponential backoff â up to 4 attempts
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

// Classify dateStr relative to today/tomorrow in ET â handles DST correctly
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

// Split into raw-fetch and pure-parse so the snapshot system (services/
// snapshot.js) can capture the upstream HTML before any Cheerio parsing,
// and /api/replay/lineups can re-run parseLineupsHtml on the captured
// payload without re-fetching RotoWire.
async function fetchLineupsRaw(dateStr) {
  console.log('[scraper] fetchLineupsRaw requested for ' + dateStr);
  const dayType = classifyDate(dateStr);
  console.log('[scraper] Date classification: ' + dayType);

  if (dayType === 'past') {
    return { skipped: true, reason: 'past_date', message: 'RotoWire only shows today and tomorrow. Use manual injection for past dates.' };
  }
  if (dayType === 'future') {
    return { skipped: true, reason: 'future_date', message: 'RotoWire only shows today and tomorrow. Check back closer to ' + dateStr + '.' };
  }

  const url = dayType === 'tomorrow'
    ? 'https://www.rotowire.com/baseball/daily-lineups.php?date=tomorrow'
    : 'https://www.rotowire.com/baseball/daily-lineups.php';

  console.log('[scraper] Fetching: ' + url);

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    }
  });

  if (!resp.ok) throw new Error('RotoWire fetch failed: ' + resp.status);
  const html = await resp.text();
  console.log('[scraper] RotoWire HTML length: ' + html.length);
  return { html, fetched_at: new Date().toISOString(), dateStr };
}

// Wrapper: preserves original fetchLineups signature for in-process callers.
async function fetchLineups(dateStr) {
  const raw = await fetchLineupsRaw(dateStr);
  if (raw.skipped) return raw;
  return parseLineupsHtml(raw.html, dateStr);
}

function parseLineupsHtml(html, dateStr) {
  // Check we got actual lineup data
  if (!html.includes('lineup__player') && !html.includes('lineup is-mlb')) {
    throw new Error('Could not parse any games from response');
  }

  // Verify date
  // Strip first, then window. Scanning the raw first 5000 bytes skipped the
  // actual date text (which lives past 50KB of <head> scripts/styles); after
  // stripping those to whitespace, position 3491 of the remainder contains
  // "Starting MLB lineups for April 20, 2026" — well inside the 5000 window.
  const detectedDate = extractRotoWireDate(htmlToText(html).substring(0, 5000));
  console.log('[scraper] RotoWire detected date: ' + (detectedDate || 'UNKNOWN') + ' | requested: ' + dateStr);
  // Fail-closed: reject when either (a) RotoWire is showing the wrong date,
  // or (b) we couldn't detect a date at all. The old `detectedDate && ...`
  // silently passed when the regex missed, causing yesterday's HTML to get
  // upserted under today's dateStr — root cause of the "yesterday's games
  // showing with today's date" bug.
  if (!detectedDate || detectedDate !== dateStr) {
    return { skipped: true, reason: 'date_mismatch', message: 'RotoWire is showing ' + (detectedDate || 'UNKNOWN') + ' but you requested ' + dateStr + '. Page may not be available yet.' };
  }

  // Parse with cheerio
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);

  // FanGraphs 3-year R factor (runs-specific) with manual adjustments for
  // clubs whose venue or configuration changed recently:
  //   ATH  1.19 — Sutter Health Park (minor-league, hitter-friendly) from 2025;
  //               the 3-year FG R factor still averages in Oakland Coliseum
  //               years and understates the current environment.
  //   TB   0.95 — excludes the 2025 temporary Steinbrenner Field season;
  //               value is the pre-2025 Tropicana Field R-factor trend
  //               since that's what the club returns to.
  //   KC   1.02 — bumped up from pure FG R to reflect the 2024 outfield
  //               fence move-in which hasn't propagated through three
  //               full seasons of data yet.
  // Every other team uses the straight FanGraphs R factor. Keys are the
  // uppercase abbreviations FanGraphs / scraper produce.
  const PARK_FACTORS = {
    COL:1.25, ARI:1.10, CIN:1.10, CHC:1.08, NYY:1.07, BOS:1.06,
    PHI:1.05, ATL:1.04, CWS:1.03, TEX:1.03, WAS:1.02, TOR:1.02,
    KC:1.02,  MIA:1.01, LAD:1.00, HOU:1.00, STL:0.99, DET:0.98,
    TB:0.95,  MIN:0.97, PIT:0.97, LAA:0.97, MIL:0.96, BAL:0.96,
    CLE:0.95, SEA:0.95, NYM:0.94, SD:0.94,  SF:0.92,  ATH:1.19
  };

  const games = [];
  // Track how many sections we've already seen for each team-pair on this
  // page. RotoWire's lineup HTML shows each leg of a doubleheader as a
  // separate .lineup.is-mlb block but with no DOM marker tying it to a
  // statsapi gameNumber. Standard ordering on the page is G1 first, G2
  // second; we ride that convention to assign the same -g{N} suffix the
  // statsapi bootstrap uses, so per-leg upserts target the right row.
  const pairOccurrences = {};

  $('.lineup.is-mlb').each((i, el) => {
    const away = $(el).find('.lineup__team.is-visit .lineup__abbr').text().trim();
    const home = $(el).find('.lineup__team.is-home .lineup__abbr').text().trim();
    if (!away || !home) return;

    // Parse pitcher: "Kodai Senga R" -> name + hand
    const parseP = raw => {
      raw = (raw || '').replace(/\s+/g, ' ').trim();
      const parts = raw.split(' ');
      const hand = ['R','L','S'].includes(parts[parts.length-1]) ? parts[parts.length-1] : 'R';
      const name = ['R','L','S'].includes(parts[parts.length-1]) ? parts.slice(0,-1).join(' ') : raw;
      return { name: name.trim(), hand };
    };

    const awayPit = parseP($(el).find('.lineup__list.is-visit .lineup__player-highlight-name').text());
    const homePit = parseP($(el).find('.lineup__list.is-home .lineup__player-highlight-name').text());
    const time = $(el).find('.lineup__time').first().text().trim();
    // Use RotoWire's DOM class rather than free-text substring — projected
    // blurbs like "not yet confirmed" / "confirmed closer to game time" were
    // matching .includes('confirm') and flipping tomorrow's rows to
    // 'confirmed' even when the lineup was clearly projected.
    const lineup_status = $(el).find('.lineup__status.is-confirmed').length > 0 ? 'confirmed' : 'projected';

    const parsePlayers = (side) => {
      const players = [];
      $(el).find('.lineup__list.' + side + ' .lineup__player').each((j, p) => {
        const txt = $(p).text().replace(/\s+/g, ' ').trim();
        // Format: "RF Carson Benge L"
        const parts = txt.split(' ');
        if (parts.length < 3) return;
        const bats = ['R','L','S'].includes(parts[parts.length-1]) ? parts[parts.length-1] : 'R';
        const pos = parts[0];
        const name = parts.slice(1, ['R','L','S'].includes(parts[parts.length-1]) ? -1 : undefined).join(' ');
        if (name) players.push({ name, hand: bats, pos });
      });
      return players;
    };

    // Normalize team abbrs
    const NORM = { WSH:'WAS', OAK:'ATH' };
    const awayTeam = NORM[away] || away;
    const homeTeam = NORM[home] || home;
    const baseGameId = (awayTeam + '-' + homeTeam).toLowerCase();
    // Doubleheader handling: every additional section for the same
    // team-pair gets a '-g{N}' suffix matching the convention statsapi's
    // fetchSchedule uses. Without this, two sections share the same
    // game_id and the runLineupJob dedup keeps only the last (G2's
    // pitchers leak into G1's row — the original bug, see commit log).
    const occ = (pairOccurrences[baseGameId] || 0) + 1;
    pairOccurrences[baseGameId] = occ;
    const gameId = occ > 1 ? baseGameId + '-g' + occ : baseGameId;
    if (occ > 1) {
      console.log('[scraper] RotoWire doubleheader leg ' + occ + ' for ' + baseGameId + ' → ' + gameId);
    }

    games.push({
      game_id: gameId,
      away_team: awayTeam,
      home_team: homeTeam,
      time,
      lineup_status,
      away_lineup_status: lineup_status,
      home_lineup_status: lineup_status,
      away_sp: awayPit.name ? { name: awayPit.name, hand: awayPit.hand } : null,
      home_sp: homePit.name ? { name: homePit.name, hand: homePit.hand } : null,
      market_total: null,
      park_factor: PARK_FACTORS[homeTeam] || 1.0,
      away_lineup: parsePlayers('is-visit'),
      home_lineup: parsePlayers('is-home'),
    });
  });

  console.log('[scraper] Cheerio parsed ' + games.length + ' games for ' + dateStr);
  if (!games.length) throw new Error('Could not parse any games from response');
  return games;
}

async function fetchScoresRaw(dateStr) {
  const [year, month, day] = dateStr.split('-');
  const mmdd = month.padStart(2,'0')+'/'+day.padStart(2,'0')+'/'+year;
  const url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date='+mmdd+'&hydrate=linescore';
  const resp = await fetch(url+'&_t='+Date.now(), {headers:{'Accept':'application/json','Cache-Control':'no-cache'}});
  if (!resp.ok) throw new Error('MLB API error: '+resp.status);
  return await resp.json();
}

async function fetchScores(dateStr) {
  return parseScoresJson(await fetchScoresRaw(dateStr));
}

function parseScoresJson(data) {
  // Uses MLB Stats API â free, no auth, returns final scores as JSON
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
    // Same -g{N} suffix convention as fetchSchedule so doubleheader legs
    // grade against the right game_log row.
    const gameNumber = g.gameNumber || 1;
    const baseId = (away+'-'+home).toLowerCase();
    const gameId = gameNumber > 1 ? baseId + '-g' + gameNumber : baseId;
    results.push({away, home, awayScore, homeScore, gameId, game_number: gameNumber, game_pk: g.gamePk || null});
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

// Odds via The Odds API â Kalshi (primary, us_ex region) + DraftKings (fallback, us region)
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
    console.log('[odds] No API key â using direct Kalshi');
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
    // Deduplicate by team pair â keep LATEST commence_time (upcoming game, not completed one)
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
      console.log('[odds] Kalshi: '+kalshiResults.length+' games â '+kalshiResults.map(g=>g.game_id+'('+g.market_away_ml+'/'+g.market_home_ml+')').join(', '));

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
    console.log('[odds] Kalshi returned 0 games â falling back to DraftKings');
  } catch(e) { console.log('[odds] Kalshi failed: '+e.message+' â trying DraftKings'); }

  // 3. Full DK fallback (also catches 401 â direct Kalshi)
  try {
    const dkGames = filterByDate(await fetchOddsForBookmaker(apiKey, 'us', 'draftkings'));
    const dkResults = parseOddsAPIResponse(dkGames, 'draftkings');
    console.log('[odds] DraftKings fallback: '+dkResults.length+' games');
    return dkResults;
  } catch(e) {
    if (e.message && (e.message.includes('OUT_OF_USAGE_CREDITS') || e.message.includes('401'))) {
      console.log('[odds] Odds API credits exhausted â switching to direct Kalshi');
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

// ââ Direct Kalshi scraper (no Odds API credits needed) âââââââââââââââââââââââ
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



// MLB Stats API team IDs
const MLB_TEAM_IDS = {
  ARI:109,ATL:144,BAL:110,BOS:111,CHC:112,CWS:145,CIN:113,CLE:114,COL:115,
  DET:116,HOU:117,KC:118,LAA:108,LAD:119,MIA:146,MIL:158,MIN:142,NYM:121,
  NYY:147,ATH:133,PHI:143,PIT:134,SD:135,SF:137,SEA:136,STL:138,TB:139,
  TEX:140,TOR:141,WAS:120
};

async function fetchActiveRosters() {
  const results = {};
  const teams = Object.keys(MLB_TEAM_IDS);

  // rosterType=active should already exclude 7/10/15/60-day IL, restricted,
  // paternity, bereavement. Defense in depth: explicitly drop anything whose
  // per-entry status code isn't 'A' (Active). One statsapi contract change
  // shouldn't be enough to silently re-introduce injured pitchers into the
  // model.
  const ACTIVE_STATUS_CODE = 'A';
  for (const team of teams) {
    try {
      const teamId = MLB_TEAM_IDS[team];
      // Get active 26-man roster with season stats hydrated.
      const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active&season=2026&hydrate=person(stats(type=season,sportId=1))`;
      const data = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } }).then(r => r.json());
      const pitchersAll = (data.roster || []).filter(p => p.position?.type === 'Pitcher');
      // Diagnostic: surface any pitcher whose entry status isn't Active. With
      // rosterType=active these should be zero; if any appear, the filter
      // below catches them and the warning flags a contract drift.
      const nonActive = pitchersAll.filter(p => p.status && p.status.code && p.status.code !== ACTIVE_STATUS_CODE);
      for (const p of nonActive) {
        console.warn(`[roster] ${team}: filtered non-active ${p.person?.fullName} (status=${p.status?.code}/${p.status?.description})`);
      }
      const pitchers = pitchersAll.filter(p => !p.status || !p.status.code || p.status.code === ACTIVE_STATUS_CODE);

      results[team] = pitchers.map(p => {
        const stats = p.person?.stats?.[0]?.splits?.[0]?.stat || {};
        const gs = parseInt(stats.gamesStarted) || 0;
        const g  = parseInt(stats.gamesPitched) || 0;
        // SP = started at least 1 game AND starts â¥ 50% of appearances
        const role = (gs > 0 && gs / Math.max(g, 1) >= 0.5) ? 'SP' : 'RP';
        return {
          name: p.person?.fullName || '',
          mlb_id: p.person?.id || null,
          role,
          hand: p.person?.pitchHand?.code || 'R'
        };
      });
      console.log(`[roster] ${team}: ${results[team].length} pitchers (${results[team].filter(p=>p.role==='SP').length} SP, ${results[team].filter(p=>p.role==='RP').length} RP)`);
    } catch (e) {
      console.error(`[roster] ${team} error: ${e.message}`);
      results[team] = [];
    }
  }
  return results;
}

// Statsapi schedule bootstrap. RotoWire only publishes today + tomorrow, and
// only after their page rolls over (often late in the day). Statsapi has the
// canonical schedule available a week+ ahead, so we use it to pre-create
// game_log skeleton rows (matchup + scheduled time + probable SPs) that
// RotoWire then enriches with confirmed lineups when available.
//
// Returns array shaped like fetchLineups so runLineupJob can consume both
// with the same upsert loop. Probable SP hand isn't surfaced inline by the
// schedule endpoint even with deep hydrate — we batch /api/v1/people for
// every probable pitcher in a single follow-up call (vs N round-trips).
async function fetchSchedule(dateStr) {
  console.log('[scraper] fetchSchedule requested for ' + dateStr);
  const url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' +
    encodeURIComponent(dateStr) + '&hydrate=' + encodeURIComponent('probablePitcher(note),team');
  const resp = await fetch(url + '&_t=' + Date.now(), {
    headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
  });
  if (!resp.ok) throw new Error('statsapi schedule HTTP ' + resp.status);
  const data = await resp.json();
  const games = data.dates?.[0]?.games || [];
  if (!games.length) {
    console.log('[scraper] statsapi returned 0 games for ' + dateStr);
    return [];
  }

  // statsapi → app abbr normalization. Mirrors the TEAM_NORM map in
  // services/jobs.js so bootstrap rows produce the SAME game_id RotoWire
  // and the Unabated odds path would compute for the same matchup.
  // Known divergences:
  //   WSH (statsapi)  → WAS (us)
  //   OAK (statsapi)  → ATH (us, post-2025 venue change)
  //   AZ  (statsapi)  → ARI (us — sportsbook + FanGraphs convention)
  // Verified 2026-04-25 by spot-checking a slate where SD@AZ surfaced as
  // sd-az under statsapi's raw abbr but the Unabated odds path keyed on
  // sd-ari, breaking the join.
  const ABBR_NORM = { 'WSH': 'WAS', 'OAK': 'ATH', 'AZ': 'ARI' };
  const norm = a => (ABBR_NORM[a] || a || '').toUpperCase();

  // Format gameDate ISO → "h:MM AM/PM ET", matching RotoWire's convention
  // (the "ET" suffix is what RotoWire's .lineup__time element emits, so
  // both bootstrap sources write the same shape now).
  //
  // Why ET and not PT: the UI's etToPT() in public/index.html assumes the
  // stored value is ET and subtracts 3 hours before rendering. The old
  // fmtPT path stored PT, so etToPT was producing "PT minus 3" — that's
  // the "6:40 AM PT first pitch" the user originally reported (a 9:40 AM
  // PT value rendered as 6:40 AM PT after the conversion). Storing ET
  // makes etToPT correct without touching the UI. Lock-time and
  // gameHasStarted in services/jobs.js subtract 3 hours when comparing
  // against PT wall-clock to match this convention.
  const fmtET = iso => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    }) + ' ET';
  };

  // Per-park timezone, used to evaluate whether a statsapi-emitted
  // gameDate sits inside an obviously-implausible first-pitch window
  // (no MLB game starts at park-local 4–9 AM). Keys are the same
  // post-norm abbreviations fetchSchedule emits. ATH plays at Sutter
  // Health Park (Sacramento) — Pacific Time, NOT Coliseum-era Pacific.
  const PARK_TZ = {
    LAD:'America/Los_Angeles', LAA:'America/Los_Angeles',
    SD:'America/Los_Angeles',  SF:'America/Los_Angeles',
    SEA:'America/Los_Angeles', ATH:'America/Los_Angeles',
    ARI:'America/Phoenix',
    COL:'America/Denver',
    TEX:'America/Chicago', HOU:'America/Chicago',
    MIN:'America/Chicago', MIL:'America/Chicago',
    KC:'America/Chicago',  STL:'America/Chicago',
    CHC:'America/Chicago', CWS:'America/Chicago',
    ATL:'America/New_York', CIN:'America/New_York', CLE:'America/New_York',
    DET:'America/New_York', MIA:'America/New_York', BAL:'America/New_York',
    BOS:'America/New_York', NYY:'America/New_York', NYM:'America/New_York',
    PHI:'America/New_York', PIT:'America/New_York', TB:'America/New_York',
    TOR:'America/New_York',  WAS:'America/New_York',
  };

  // Bulk-fetch pitcher hand info. /api/v1/people?personIds=A,B,C in one call
  // beats N round-trips against the schedule's per-pitcher endpoints.
  const pitcherIds = new Set();
  for (const g of games) {
    const a = g.teams?.away?.probablePitcher?.id;
    const h = g.teams?.home?.probablePitcher?.id;
    if (a) pitcherIds.add(a);
    if (h) pitcherIds.add(h);
  }
  const handById = {};
  if (pitcherIds.size > 0) {
    const ids = [...pitcherIds].join(',');
    try {
      const pr = await fetch('https://statsapi.mlb.com/api/v1/people?personIds=' + ids);
      if (pr.ok) {
        const pj = await pr.json();
        for (const p of (pj.people || [])) {
          handById[p.id] = p.pitchHand?.code || null;  // 'R' | 'L' | null
        }
      } else {
        console.log('[scraper] statsapi people lookup failed: HTTP ' + pr.status + ' (proceeding without SP hand)');
      }
    } catch (e) {
      console.log('[scraper] statsapi people lookup error: ' + e.message + ' (proceeding without SP hand)');
    }
  }

  const results = [];
  for (const g of games) {
    const awayAbbr = norm(g.teams?.away?.team?.abbreviation);
    const homeAbbr = norm(g.teams?.home?.team?.abbreviation);
    if (!awayAbbr || !homeAbbr) {
      console.log('[scraper] schedule: skipping unmapped teams (away=' + g.teams?.away?.team?.abbreviation + ', home=' + g.teams?.home?.team?.abbreviation + ')');
      continue;
    }
    // Bootstrap path is for upcoming/in-progress games — finals are handled
    // by fetchScores via the same statsapi endpoint.
    if (g.status?.detailedState === 'Final') continue;
    const aPP = g.teams?.away?.probablePitcher;
    const hPP = g.teams?.home?.probablePitcher;
    // Doubleheaders: statsapi gives gameNumber 1/2/3 per leg. Single games
    // are gameNumber 1 implicitly. game_id appends '-g{N}' when N > 1 so the
    // UNIQUE(game_date, game_id) constraint holds across legs.
    const gameNumber = g.gameNumber || 1;
    const baseGameId = (awayAbbr + '-' + homeAbbr).toLowerCase();
    const finalGameId = gameNumber > 1 ? baseGameId + '-g' + gameNumber : baseGameId;

    // Sanity-warn (do NOT reject) when park-local first-pitch falls before
    // 8 AM. Real makeup-doubleheader Game 2 legs sometimes carry a
    // placeholder gameDate near Game 1's (e.g. 2026-04-30 HOU@BAL G2 ran
    // 5 min after G1), and the previous reject filter blocked those rows
    // entirely — losing the leg until statsapi finalized the makeup time.
    // Better to bootstrap with whatever statsapi gives us; the upsert's
    // COALESCE on game_time means the next refresh overwrites a placeholder
    // time with the real one.
    const parkTz = PARK_TZ[homeAbbr];
    if (parkTz && g.gameDate) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: parkTz, hour: 'numeric', hour12: false,
      }).formatToParts(new Date(g.gameDate));
      const hp = parts.find(p => p.type === 'hour');
      const hr = hp ? parseInt(hp.value, 10) : null;
      if (hr != null && hr < 8) {
        console.warn('[scraper] schedule: suspicious early start ' + finalGameId
          + ' (gameDate ' + g.gameDate + ' = hour ' + hr + ' ' + parkTz
          + ', below 8 AM local park time — likely a placeholder gameDate)');
      }
    }

    results.push({
      game_id: finalGameId,
      game_number: gameNumber,
      game_pk: g.gamePk || null,
      away_team: awayAbbr,
      home_team: homeAbbr,
      time: fmtET(g.gameDate),
      away_sp: aPP ? { name: aPP.fullName || null, hand: handById[aPP.id] || null } : null,
      home_sp: hPP ? { name: hPP.fullName || null, hand: handById[hPP.id] || null } : null,
      away_lineup: [],
      home_lineup: [],
      lineup_status: 'projected',
      venue_id: g.venue?.id ?? null,
      venue_name: g.venue?.name ?? null,
    });
  }
  console.log('[scraper] statsapi: ' + results.length + ' games for ' + dateStr);

  // Upstream-duplicate-SP warning. MLB always uses different starters
  // per leg in a real doubleheader; if statsapi emits the same
  // probablePitcher.fullName for the same side across legs of a
  // team-pair, that's almost certainly a placeholder that hasn't been
  // updated to the actual G2 starter yet. We still emit both rows
  // (suppressing them would mask a transient feed state); the warning
  // lets a human spot the mismatch when triaging.
  const spByPair = {};
  for (const r of results) {
    const baseKey = (r.away_team + '-' + r.home_team).toLowerCase();
    if (!spByPair[baseKey]) spByPair[baseKey] = [];
    spByPair[baseKey].push({
      leg: r.game_number,
      gameId: r.game_id,
      awaySp: r.away_sp ? r.away_sp.name : null,
      homeSp: r.home_sp ? r.home_sp.name : null,
    });
  }
  for (const [pair, legs] of Object.entries(spByPair)) {
    if (legs.length < 2) continue;
    for (const side of ['awaySp', 'homeSp']) {
      const named = legs.filter(l => l[side]);
      if (named.length < 2) continue;
      const unique = new Set(named.map(l => l[side]));
      if (unique.size === 1) {
        console.warn('[scraper] schedule: same ' + (side === 'awaySp' ? 'away' : 'home')
          + ' SP "' + named[0][side] + '" listed across DH legs for ' + pair
          + ' (' + named.map(l => 'G' + l.leg).join(', ') + ') — likely a statsapi placeholder');
      }
    }
  }

  // Auto-prune: any game_log row for dateStr whose game_pk is no longer in
  // the current statsapi response is a candidate for soft-deletion. This
  // catches schedule changes (cancellations, postponements to other dates,
  // doubleheader consolidations) that previously left phantom rows in the
  // DB receiving odds/weather/lineup updates from secondary sources.
  //
  // Guards:
  //   - games.length === 0 → don't prune. statsapi may be having a bad
  //     moment; we'd rather leave stale rows than wipe the whole slate.
  //   - row.game_pk IS NULL → don't prune. Rows ingested from RotoWire/
  //     Unabated without a statsapi backfill have no pk to match against;
  //     pruning by name alone risks false positives across timezones.
  //   - bet_signals with non-NULL bet_line → don't soft-delete. The user
  //     has money exposure on the row; we instead set removed_reason to
  //     a distinct flag so the health check can surface it.
  if (games.length > 0) {
    try {
      const validPks = new Set();
      for (const g of games) if (g.gamePk) validPks.add(g.gamePk);
      const existing = db.prepare(
        "SELECT id, game_id, game_pk, away_team, home_team " +
        "FROM game_log " +
        "WHERE game_date = ? AND game_pk IS NOT NULL AND COALESCE(is_removed, 0) = 0"
      ).all(dateStr);
      const lockedBetCount = db.prepare(
        "SELECT COUNT(*) AS c FROM bet_signals WHERE game_date = ? AND game_id = ? AND bet_line IS NOT NULL"
      );
      const flagOnly = db.prepare(
        "UPDATE game_log SET removed_reason = ? WHERE id = ?"
      );
      const softDelete = db.prepare(
        "UPDATE game_log SET is_removed = 1, removed_at = datetime('now'), removed_reason = ? WHERE id = ?"
      );
      const deactivateSignals = db.prepare(
        "UPDATE bet_signals SET is_active = 0, notes = ? " +
        "WHERE game_date = ? AND game_id = ? AND bet_line IS NULL"
      );
      const insertAudit = db.prepare(
        "INSERT INTO bet_signal_audit (signal_id, game_date, game_id, action, source, detail, created_at) " +
        "VALUES (NULL, ?, ?, ?, ?, ?, datetime('now'))"
      );
      let pruned = 0, flagged = 0;
      for (const row of existing) {
        if (validPks.has(row.game_pk)) continue;
        console.warn('[schedule] game removed from statsapi: ' + row.game_id + ' (gamePk=' + row.game_pk + ')');
        const locked = lockedBetCount.get(dateStr, row.game_id).c;
        if (locked > 0) {
          console.warn('[schedule] WOULD remove ' + row.game_id + ' but ' + locked + ' locked bet(s) exist — preserving row, marking flag');
          flagOnly.run('removed_from_schedule_but_has_locked_bets', row.id);
          flagged++;
          continue;
        }
        softDelete.run('not_in_statsapi_schedule', row.id);
        deactivateSignals.run('game_removed_from_schedule', dateStr, row.game_id);
        insertAudit.run(dateStr, row.game_id, 'game_removed', 'fetchSchedule', 'Game no longer in statsapi schedule (gamePk=' + row.game_pk + ')');
        pruned++;
      }
      if (pruned > 0 || flagged > 0) {
        console.log('[schedule] prune: soft-deleted ' + pruned + ' row(s), flagged ' + flagged + ' locked-bet row(s) for ' + dateStr);
      }
    } catch (e) {
      console.warn('[schedule] prune step failed (non-fatal): ' + e.message);
    }
  } else {
    console.log('[schedule] prune skipped: statsapi returned 0 games (avoid wiping slate on transient outage)');
  }

  return results;
}

module.exports = { fetchActiveRosters, fetchOddsAPI, fetchKalshiDirect, fetchLineups, fetchLineupsRaw, parseLineupsHtml, fetchScores, fetchScoresRaw, parseScoresJson, fetchSchedule, makeGameId };
