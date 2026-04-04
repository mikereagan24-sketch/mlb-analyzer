/**
 * scraper.js
 * Uses the Anthropic API with web_search to reliably fetch:
 *   - Daily MLB lineups + starting pitchers
 *   - Final game scores
 *
 * RotoGrinders renders via JS so direct fetch is unreliable.
 * Routing through Claude's web_search gives us clean structured data.
 */

const fetch = require('node-fetch');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const API_KEY = process.env.ANTHROPIC_API_KEY;

// ── CORE API CALLER ───────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 2000) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set in environment');

  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const text = data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  return text;
}

function parseJSON(text) {
  const match = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');
  return JSON.parse(match[0]);
}

// ── LINEUP FETCHER ────────────────────────────────────────────────────────
/**
 * Fetches confirmed lineups and starting pitchers for a given date.
 * Returns array of game objects ready to store in game_log.
 */
async function fetchLineups(dateStr) {
  // dateStr: 'YYYY-MM-DD'
  const [year, month, day] = dateStr.split('-');
  const displayDate = `${month}/${day}/${year}`;

  const prompt = `Search for MLB confirmed starting lineups and starting pitchers for ${dateStr}.

Check these sources in order:
1. https://www.rotowire.com/baseball/daily-lineups.php
2. Search "MLB lineups ${dateStr} confirmed starting pitchers"
3. https://www.mlb.com/starting-lineups

CRITICAL rules:
- awaySP = the pitcher who belongs to the AWAY team (they pitch AGAINST the home batters)
- homeSP = the pitcher who belongs to the HOME team (they pitch AGAINST the away batters)
- Away batters face the HOME team's starting pitcher
- Home batters face the AWAY team's starting pitcher
- Do NOT swap pitchers — verify each pitcher belongs to the correct team

Return ONLY a JSON array. No other text. Format:
[
  {
    "game_id": "away-home" (e.g. "lad-was" lowercase),
    "away_team": "LAD",
    "home_team": "WAS",
    "time": "1:05 PM ET",
    "away_sp": { "name": "Emmet Sheehan", "hand": "R" },
    "home_sp": { "name": "Miles Mikolas", "hand": "R" },
    "market_away_ml": -160,
    "market_home_ml": 135,
    "market_total": 8.5,
    "park_factor": 1.02,
    "away_lineup": [
      {"slot": 1, "name": "Shohei Ohtani", "hand": "L"},
      {"slot": 2, "name": "Mookie Betts", "hand": "R"}
    ],
    "home_lineup": [
      {"slot": 1, "name": "James Wood", "hand": "L"}
    ]
  }
]

Use these team abbreviations: LAD WAS STL DET MIA NYY SD BOS TOR CWS CIN TEX PHI COL TB MIN CHC CLE BAL PIT MIL KC SEA LAA HOU ATH ATL ARI NYM SF

Park factors (use these exactly):
LAD:1.00 WAS:1.02 STL:0.99 DET:0.96 MIA:1.01 NYY:1.04 SD:0.94 BOS:1.03
TOR:1.01 CWS:1.01 CIN:1.06 TEX:1.02 PHI:1.03 COL:1.16 TB:0.97 MIN:0.97
CHC:1.04 CLE:0.95 BAL:1.02 PIT:0.97 MIL:0.97 KC:0.97 SEA:0.95 LAA:0.97
HOU:1.00 ATH:0.96 ATL:1.03 ARI:1.06 NYM:1.01 SF:0.93

Batting order hand codes: R=right, L=left, S=switch
Pitcher hand codes: R=right-handed pitcher, L=left-handed pitcher
If a lineup is not yet confirmed, still include the game with whatever info is available but set lineup arrays to [].
Return raw JSON only — no markdown, no explanation.`;

  const text = await callClaude(prompt, 4000);
  const games = parseJSON(text);
  return games;
}

// ── SCORE FETCHER ─────────────────────────────────────────────────────────
/**
 * Fetches final scores for a given date.
 * Returns array of {game_id, away_team, home_team, away_score, home_score, final}
 */
async function fetchScores(dateStr) {
  const prompt = `Fetch the final MLB scores for ${dateStr}.

Search: "MLB scores ${dateStr} final results"
Also check: https://www.rotowire.com/baseball/scoreboard.php?date=${dateStr}

Return ONLY a JSON array of completed games. Omit games still in progress.
Format:
[
  {"away_team": "LAD", "home_team": "WAS", "away_score": 5, "home_score": 3, "final": true},
  {"away_team": "STL", "home_team": "DET", "away_score": 2, "home_score": 7, "final": true}
]

Use standard abbreviations: LAD WAS STL DET MIA NYY SD BOS TOR CWS CIN TEX PHI COL TB MIN CHC CLE BAL PIT MIL KC SEA LAA HOU ATH ATL ARI NYM SF
Note: Athletics = ATH (not OAK)
Return raw JSON array only.`;

  const text = await callClaude(prompt, 1500);
  const scores = parseJSON(text);
  return scores.filter(s => s.final);
}

// ── GAME ID HELPER ────────────────────────────────────────────────────────
function makeGameId(awayTeam, homeTeam) {
  return `${awayTeam}-${homeTeam}`.toLowerCase();
}

module.exports = { fetchLineups, fetchScores, makeGameId };
