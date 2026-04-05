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

// Full month names for date verification
const MONTH_NAMES = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

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
      'Content-Type':'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error('Anthropic API error ' + resp.status + ': ' + await resp.text());
  const data = await resp.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// Returns 'today', 'tomorrow', or 'past' relative to the server's current ET date
function classifyDate(dateStr) {
  // Server time in ET
  const now = new Date();
  const etOffset = -5; // ET (EST). Will be -4 during EDT but close enough for day comparison
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const etNow = new Date(utc + etOffset * 3600000);

  const todayET = etNow.toISOString().slice(0, 10);
  const tomorrowDate = new Date(etNow);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowET = tomorrowDate.toISOString().slice(0, 10);

  if (dateStr === todayET) return 'today';
  if (dateStr === tomorrowET) return 'tomorrow';
  if (dateStr > tomorrowET) return 'future';
  return 'past';
}

// Extract the date RotoWire is showing from page HTML
// RotoWire shows something like "Apr 5, 2026" or "April 5, 2026" in the page
function extractRotoWireDate(text) {
  // Look for patterns like "Apr 5 2026", "April 5, 2026", "Apr 5, 2026"
  const monthAbbrevs = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (let i = 0; i < monthAbbrevs.length; i++) {
    const abbr = monthAbbrevs[i];
    const full = MONTH_NAMES[i];
    // Try abbreviated and full month names
    const pat = new RegExp('(?:' + abbr + '|' + full + ')\\s+(\\d{1,2})[,\\s]+(2026|2027)', 'i');
    const m = text.match(pat);
    if (m) {
      const month = String(i + 1).padStart(2, '0');
      const day = String(m[1]).padStart(2, '0');
      const year = m[2];
      return year + '-' + month + '-' + day;
    }
  }
  return null;
}

async function fetchLineups(dateStr) {
  console.log('[scraper] fetchLineups requested for ' + dateStr);

  const dayType = classifyDate(dateStr);
  console.log('[scraper] Date classification: ' + dayType);

  // Determine which RotoWire URL to fetch
  let url;
  let expectedDate = dateStr;

  if (dayType === 'past') {
    console.log('[scraper] Past date — RotoWire does not support past dates. Skipping scrape.');
    return { skipped: true, reason: 'past_date', message: 'RotoWire only shows today and tomorrow. Use manual injection for past dates.' };
  } else if (dayType === 'today') {
    url = 'https://www.rotowire.com/baseball/daily-lineups.php';
  } else if (dayType === 'tomorrow') {
    url = 'https://www.rotowire.com/baseball/daily-lineups.php?date=tomorrow';
  } else {
    // future dates beyond tomorrow
    console.log('[scraper] Future date beyond tomorrow — RotoWire does not have this yet.');
    return { skipped: true, reason: 'future_date', message: 'RotoWire only shows today and tomorrow. Check back closer to the date.' };
  }

  console.log('[scraper] Fetching RotoWire: ' + url);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
  });
  if (!resp.ok) throw new Error('RotoWire fetch failed: ' + resp.status);
  const html = await resp.text();
  const fullText = htmlToText(html);

  // ── DATE VERIFICATION ──────────────────────────────────────────────────
  // Extract the date RotoWire is actually showing
  const detectedDate = extractRotoWireDate(fullText.substring(0, 3000));
  console.log('[scraper] RotoWire detected date: ' + (detectedDate || 'UNKNOWN'));
  console.log('[scraper] Requested date: ' + dateStr);

  if (detectedDate && detectedDate !== dateStr) {
    console.log('[scraper] DATE MISMATCH — RotoWire shows ' + detectedDate + ' but requested ' + dateStr + '. Aborting.');
    return {
      skipped: true,
      reason: 'date_mismatch',
      message: 'RotoWire is showing ' + detectedDate + ' but you requested ' + dateStr + '. RotoWire may not have this date available yet.',
      rotowireDate: detectedDate,
      requestedDate: dateStr,
    };
  }

  if (!detectedDate) {
    console.log('[scraper] Could not verify RotoWire date — proceeding with caution');
  }

  console.log('[scraper] Date verified — proceeding with parse. Text length: ' + fullText.length);

  // Find the lineup section
  const markers = ['Confirmed Lineup', 'Expected Lineup', 'PM ET', 'AM ET'];
  let sectionStart = fullText.length;
  for (const mk of markers) {
    const idx = fullText.indexOf(mk);
    if (idx > 0 && idx < sectionStart) sectionStart = idx;
  }
  const start = Math.max(0, sectionStart - 200);
  const chunk = fullText.substring(start, start + 35000)
    .replace(/'/g, '').replace(/\u2019/g, '').replace(/`/g, '');

  const prompt = `Extract ALL MLB games from this RotoWire lineup page text for ${dateStr}. Include Confirmed AND Expected lineups. Never skip a game.

CRITICAL pitcher rules:
- awaySP = pitcher for AWAY team, pitches AGAINST home batters
- homeSP = pitcher for HOME team, pitches AGAINST away batters

Do NOT use apostrophes anywhere in the JSON output.

Return ONLY a raw JSON array:
[{"game_id":"chc-cle","away_team":"CHC","home_team":"CLE","time":"1:10 PM ET","lineup_status":"confirmed","away_sp":{"name":"Edward Cabrera","hand":"R"},"home_sp":{"name":"Slade Cecconi","hand":"R"},"market_away_ml":-134,"market_home_ml":114,"market_total":7.5,"park_factor":0.95,"away_lineup":[{"slot":1,"name":"Nico Hoerner","hand":"R"},{"slot":2,"name":"Alex Bregman","hand":"R"}],"home_lineup":[{"slot":1,"name":"Steven Kwan","hand":"L"},{"slot":2,"name":"Chase DeLauter","hand":"L"}]}]

Teams: LAD WAS STL DET MIA NYY SD BOS TOR CWS CIN TEX PHI COL TB MIN CHC CLE BAL PIT MIL KC SEA LAA HOU ATH ATL ARI NYM SF (Athletics=ATH not OAK)
Park factors: LAD:1.00 WAS:1.02 STL:0.99 DET:0.96 MIA:1.01 NYY:1.04 SD:0.94 BOS:1.03 TOR:1.01 CWS:1.01 CIN:1.06 TEX:1.02 PHI:1.03 COL:1.16 TB:0.97 MIN:0.97 CHC:1.04 CLE:0.95 BAL:1.02 PIT:0.97 MIL:0.97 KC:0.97 SEA:0.95 LAA:0.97 HOU:1.00 ATH:0.96 ATL:1.03 ARI:1.06 NYM:1.01 SF:0.93
Hands: R=right L=left S=switch
Raw JSON array only.

PAGE TEXT:
${chunk}`;

  const text = await callClaude(prompt, 4000);
  return parseJSONRobust(text);
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
  const pat = new RegExp(
    '(' + escaped.join('|') + ')\\s+(\\d+)\\s+Final\\s+(' + escaped.join('|') + ')\\s+(\\d+)',
    'g'
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

module.exports = { fetchLineups, fetchScores, makeGameId };
