const fetch = require('node-fetch');
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const API_KEY = process.env.ANTHROPIC_API_KEY;

async function fetchRotoWireHTML() {
  const resp = await fetch('https://www.rotowire.com/baseball/daily-lineups.php', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
  });
  if (!resp.ok) throw new Error('RotoWire fetch failed: ' + resp.status);
  return resp.text();
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, 'and').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[''`]/g, '').replace(/[""]/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeForJSON(s) {
  return s
    .replace(/[''`]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/}\s*{/g, '},{');
}

function parseJSONRobust(text) {
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found');

  const jsonStr = sanitizeForJSON(text.substring(start, end + 1));

  // Try full parse first
  try {
    return JSON.parse(jsonStr);
  } catch(e) {
    console.error('[scraper] Full parse failed at pos ' + (e.message.match(/\d+/) || ['?'])[0] + ', trying object extraction');
  }

  // Fall back: extract individual game objects
  const games = [];
  const objPattern = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
  let match;
  while ((match = objPattern.exec(jsonStr)) !== null) {
    try {
      const obj = JSON.parse(sanitizeForJSON(match[0]));
      if (obj.away_team && obj.home_team) games.push(obj);
    } catch(e2) {
      // skip malformed object
    }
  }
  if (games.length > 0) {
    console.log('[scraper] Extracted ' + games.length + ' games via fallback parser');
    return games;
  }
  throw new Error('Could not parse any games from response');
}

async function callClaude(prompt, maxTokens, useSearch) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const body = { model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('Anthropic API error ' + resp.status + ': ' + await resp.text());
  const data = await resp.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

async function fetchLineups(dateStr) {
  console.log('[scraper] Fetching RotoWire for ' + dateStr);
  const html = await fetchRotoWireHTML();
  const fullText = htmlToText(html);
  console.log('[scraper] Text length: ' + fullText.length);

  const idx = fullText.indexOf('Confirmed Lineup');
  const start = idx > 0 ? Math.max(0, idx - 500) : 0;
  const chunk = fullText.substring(start, start + 35000);

  const prompt = 'Extract ALL MLB games from this RotoWire lineup page for ' + dateStr + '. Include Confirmed AND Expected lineups.\n\nCRITICAL pitcher rules:\n- awaySP pitches AGAINST home batters\n- homeSP pitches AGAINST away batters\n\nVERY IMPORTANT for valid JSON: Do NOT use apostrophes in any name values. Write OHearn not O\'Hearn, DArnaud not D\'Arnaud, etc.\n\nReturn ONLY a raw JSON array, no markdown:\n[{"game_id":"stl-det","away_team":"STL","home_team":"DET","time":"1:10 PM ET","lineup_status":"confirmed","away_sp":{"name":"Dustin May","hand":"R"},"home_sp":{"name":"Jack Flaherty","hand":"R"},"market_away_ml":144,"market_home_ml":-171,"market_total":7.5,"park_factor":0.96,"away_lineup":[{"slot":1,"name":"JJ Wetherholt","hand":"L"},{"slot":2,"name":"Ivan Herrera","hand":"R"}],"home_lineup":[{"slot":1,"name":"Colt Keith","hand":"L"},{"slot":2,"name":"Kevin McGonigle","hand":"L"}]}]\n\nTeams: LAD WAS STL DET MIA NYY SD BOS TOR CWS CIN TEX PHI COL TB MIN CHC CLE BAL PIT MIL KC SEA LAA HOU ATH ATL ARI NYM SF (Athletics=ATH)\nPark factors: LAD:1.00 WAS:1.02 STL:0.99 DET:0.96 MIA:1.01 NYY:1.04 SD:0.94 BOS:1.03 TOR:1.01 CWS:1.01 CIN:1.06 TEX:1.02 PHI:1.03 COL:1.16 TB:0.97 MIN:0.97 CHC:1.04 CLE:0.95 BAL:1.02 PIT:0.97 MIL:0.97 KC:0.97 SEA:0.95 LAA:0.97 HOU:1.00 ATH:0.96 ATL:1.03 ARI:1.06 NYM:1.01 SF:0.93\nHands: R=right L=left S=switch\nRaw JSON array only, no explanation.\n\nPAGE TEXT:\n' + chunk;

const text = await callClaude(prompt, 4000, false);
console.log('[scraper] Got response length: ' + text.length);
console.log('[scraper] Response preview: ' + text.substring(0, 500));
console.log('[scraper] Response at 9600-9800: ' + text.substring(9600, 9800));
  return parseJSONRobust(text);
}

async function fetchScores(dateStr) {
  const prompt = 'Get final MLB scores for ' + dateStr + '. Search MLB scores ' + dateStr + ' final results and check https://www.rotowire.com/baseball/scoreboard.php?date=' + dateStr + '\nReturn only completed games: [{"away_team":"LAD","home_team":"WAS","away_score":5,"home_score":3,"final":true}]\nTeams: LAD WAS STL DET MIA NYY SD BOS TOR CWS CIN TEX PHI COL TB MIN CHC CLE BAL PIT MIL KC SEA LAA HOU ATH ATL ARI NYM SF (Athletics=ATH)\nRaw JSON only.';
  const text = await callClaude(prompt, 1500, true);
  const scores = parseJSONRobust(text);
  return scores.filter(function(s) { return s.final; });
}

function makeGameId(awayTeam, homeTeam) {
  return (awayTeam + '-' + homeTeam).toLowerCase();
}

module.exports = { fetchLineups, fetchScores, makeGameId };
