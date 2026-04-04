const fetch = require('node-fetch');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const API_KEY = process.env.ANTHROPIC_API_KEY;

// ── DIRECT ROTOWIRE FETCH (zero tokens) ───────────────────────────────────
async function fetchRotoWire(dateStr) {
  const url = `https://www.rotowire.com/baseball/daily-lineups.php`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    timeout: 15000,
  });
  if (!resp.ok) throw new Error(`RotoWire returned ${resp.status}`);
  return resp.text();
}

// ── PARSE ROTOWIRE HTML ───────────────────────────────────────────────────
const PARK_FACTORS = {
  LAD:1.00,WAS:1.02,STL:0.99,DET:0.96,MIA:1.01,NYY:1.04,SD:0.94,BOS:1.03,
  TOR:1.01,CWS:1.01,CIN:1.06,TEX:1.02,PHI:1.03,COL:1.16,TB:0.97,MIN:0.97,
  CHC:1.04,CLE:0.95,BAL:1.02,PIT:0.97,MIL:0.97,KC:0.97,SEA:0.95,LAA:0.97,
  HOU:1.00,ATH:0.96,ATL:1.03,ARI:1.06,NYM:1.01,SF:0.93,
};

// Map common RotoWire abbreviations to our standard ones
const TEAM_MAP = {
  'WSH':'WAS','OAK':'ATH','CWS':'CWS','TBR':'TB','KCR':'KC',
  'SDP':'SD','SFG':'SF','NYM':'NYM','NYY':'NYY','LAD':'LAD',
  'LAA':'LAA','CHC':'CHC','CHW':'CWS','ATH':'ATH',
};
function normTeam(t) { return TEAM_MAP[t] || t; }

function parseHand(cls) {
  if (!cls) return 'R';
  if (cls.includes('-left') || cls === 'L') return 'L';
  if (cls.includes('-switch') || cls === 'S') return 'S';
  return 'R';
}

function parseRotoWireHTML(html, dateStr) {
  // Extract game blocks — each game is wrapped in a lineup__main div
  const games = [];
  
  // Match game containers
  const gamePattern = /class="[^"]*lineup__main[^"]*"[^>]*>([\s\S]*?)(?=class="[^"]*lineup__main[^"]*"|$)/g;
  
  // Simpler approach: extract team abbreviations from image URLs or team classes
  // RotoWire uses patterns like: lineup__team --away, lineup__team --home
  
  // Extract all player names and positions using text patterns
  const awayTeamPattern = /lineup__team[^>]*--away[^>]*>[\s\S]*?<div[^>]*>([A-Z]{2,3})<\/div>/g;
  const homeTeamPattern = /lineup__team[^>]*--home[^>]*>[\s\S]*?<div[^>]*>([A-Z]{2,3})<\/div>/g;
  
  // Extract game time patterns  
  const timePattern = /(\d{1,2}:\d{2}\s*[AP]M\s*ET)/g;
  
  // Since RotoWire's HTML is complex, use Claude as fallback for parsing
  // but fetch the page ourselves to avoid the web_search token overhead
  return null; // Signal to use Claude parsing on the raw HTML
}

// ── CLAUDE PARSER (uses raw HTML, much cheaper than web_search) ───────────
async function callClaudeWithHTML(html, dateStr) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  
  // Extract just the lineup section to minimize tokens
  // RotoWire lineup data is in a specific section
  let relevantHTML = html;
  const startIdx = html.indexOf('lineup__main');
  const endIdx = html.lastIndexOf('lineup__main');
  if (startIdx > 0 && endIdx > startIdx) {
    // Get a chunk around the lineup data, not the whole page
    relevantHTML = html.substring(Math.max(0, startIdx - 500), Math.min(html.length, endIdx + 50000));
  }
  
  // Truncate to ~60k chars to stay within token limits
  if (relevantHTML.length > 60000) relevantHTML = relevantHTML.substring(0, 60000);

  const prompt = `Parse this RotoWire HTML for ${dateStr} MLB lineups. Extract ALL games including Expected lineups.

CRITICAL pitcher rules:
- awaySP = pitcher belonging to AWAY team, pitches AGAINST home batters
- homeSP = pitcher belonging to HOME team, pitches AGAINST away batters

Return ONLY a raw JSON array:
[{"game_id":"stl-det","away_team":"STL","home_team":"DET","time":"1:10 PM ET","lineup_status":"confirmed","away_sp":{"name":"Dustin May","hand":"R"},"home_sp":{"name":"Jack Flaherty","hand":"R"},"market_away_ml":144,"market_home_ml":-171,"market_total":7.5,"park_factor":0.96,"away_lineup":[{"slot":1,"name":"JJ Wetherholt","hand":"L"}],"home_lineup":[{"slot":1,"name":"Colt Keith","hand":"L"}]}]

Teams: LAD WAS STL DET MIA NYY SD BOS TOR CWS CIN TEX PHI COL TB MIN CHC CLE BAL PIT MIL KC SEA LAA HOU ATH ATL ARI NYM SF (Athletics=ATH)
Park factors: LAD:1.00 WAS:1.02 STL:0.99 DET:0.96 MIA:1.01 NYY:1.04 SD:0.94 BOS:1.03 TOR:1.01 CWS:1.01 CIN:1
