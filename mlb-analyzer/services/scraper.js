const fetch = require('node-fetch');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const API_KEY = process.env.ANTHROPIC_API_KEY;

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

async function fetchLineups(dateStr) {
  const prompt = `Fetch ALL MLB lineups and starting pitchers for ${dateStr} from RotoWire.

Go to this URL and extract every game on the page:
https://www.rotowire.com/baseball/daily-lineups.php

Include ALL games — both "Confirmed Lineup" AND "Expected Lineup" from RotoWire. Never skip a game because its lineup is not yet confirmed. Use projected/expected lineups when confirmed ones are not available.

CRITICAL pitcher assignment rules:
- awaySP = pitcher who belongs to the AWAY team. They pitch AGAINST home batters.
- homeSP = pitcher who belongs to the HOME team. They pitch AGAINST away batters.
- Away batters face the HOME SP. Home batters face the AWAY SP.
- Double-check each pitcher is assigned to the correct team.

Also include moneyline odds and totals shown on the page for each game.

Return ONLY a raw JSON array, no markdown, no explanation:
[
  {
    "game_id": "stl-det",
    "away_team": "STL",
    "home_team": "DET",
    "time": "1:10 PM ET",
    "lineup_status": "confirmed",
    "away_sp": { "name": "Dustin May", "hand": "R" },
    "home_sp": { "name": "Jack Flaherty", "hand": "R" },
    "market_away_ml": 144,
    "market_home_ml": -171,
    "market_total": 7.5,
    "park_factor": 0.96,
    "away_lineup": [
      {"slot": 1, "name": "JJ Wetherholt", "hand": "L"},
      {"slot": 2, "name": "Ivan Herrera", "hand": "R"}
    ],
    "home_lineup": [
      {"slot": 1, "name": "Colt Keith", "hand": "L"},
      {"slot": 2, "name": "Kevin McGonigle", "hand": "L"}
    ]
  }
]

Team abbreviations: LAD WAS STL DET MIA NYY SD BOS TOR CWS CIN TEX PHI COL TB MIN CHC CLE BAL PIT MIL KC SEA LAA HOU ATH ATL ARI NYM SF
Athletics = ATH (not OAK)

Park factors:
LAD:1.00 WAS:1.02 STL:0.99 DET:0.96 MIA:1.01 NYY:1.04 SD:0.94 BOS:1.03
TOR:1.01 CWS:1.01 CIN:1.06 TEX:1.02 PHI:1.03 COL:1.16 TB:0.97 MIN:0.97
CHC:1.04 CLE:0.95 BAL:1.02 PIT:0.97 MIL:0.97 KC:0.97 SEA:0.95 LAA:0.97
HOU:1.00 ATH:0.96 ATL:1.03 ARI:1.06 NYM:1.01 SF:0.93

Hand codes: R=right L=left S=switch
Return raw JSON only.`;

  const text = await callClaude(prompt, 4000);
  const games = parseJSON(text);
  return games;
}

async function fetchScores(dateStr) {
  const prompt = `Fetch final MLB scores for ${dateStr}.

Check: https://www.rotowire.com/baseball/scoreboard.php?date=${dateStr}
Also search: "MLB scores ${dateStr} final results"

Return ONLY a JSON array of completed games. Omit games still in progress.
[
  {"away_team": "LAD", "home_team": "WAS", "away_score": 5, "home_score": 3, "final": true}
]

Abbreviations: LAD WAS STL DET MIA NYY SD BOS TOR CWS CIN TEX PHI COL TB MIN CHC CLE BAL PIT MIL KC SEA LAA HOU ATH ATL ARI NYM SF
Athletics = ATH not OAK
Return raw JSON only.`;

  const text = await callClaude(prompt, 1500);
  const scores = parseJSON(text);
  return scores.filter(s => s.final);
}

function makeGameId(awayTeam, homeTeam) {
  return `${awayTeam}-${homeTeam}`.toLowerCase();
}

module.exports = { fetchLineups, fetchScores, makeGameId };
