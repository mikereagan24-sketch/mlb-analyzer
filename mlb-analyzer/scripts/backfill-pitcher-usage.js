#!/usr/bin/env node
'use strict';

// Self-contained backfill for pitcher_game_log.
// Walks the last 7 days ending yesterday ET (going backwards), calls the
// MLB Stats API for each date, and upserts each pitcher's appearance +
// pitch count so the fatigue filter has history to work against.
//
// Deps: better-sqlite3, node-fetch (both already in package.json).
// DB:   /data/mlb.db, or set DB_PATH env var to override.
//
// Usage: node scripts/backfill-pitcher-usage.js

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');

const DB_PATH = process.env.DB_PATH
  || (fs.existsSync('/data/mlb.db') ? '/data/mlb.db' : path.join(__dirname, '..', 'data', 'mlb.db'));

if (!fs.existsSync(DB_PATH)) {
  console.error('DB not found at ' + DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH);

// Ensure the table exists — safe on fresh DBs or DBs that pre-date the
// fatigue feature. Matches schema.js definition exactly.
db.exec(`
  CREATE TABLE IF NOT EXISTS pitcher_game_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL,
    team TEXT NOT NULL,
    pitcher_name TEXT NOT NULL,
    pitcher_mlb_id INTEGER,
    pitches_thrown INTEGER DEFAULT 0,
    appeared INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pgl_date_team_pitcher ON pitcher_game_log(game_date, team, pitcher_name);
  CREATE INDEX IF NOT EXISTS idx_pgl_team_date ON pitcher_game_log(team, game_date);
`);

const upsert = db.prepare(
  `INSERT OR REPLACE INTO pitcher_game_log
   (game_date, team, pitcher_name, pitcher_mlb_id, pitches_thrown, appeared, created_at)
   VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
);

function etDate(offsetDays) {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setDate(et.getDate() + offsetDays);
  return et.toISOString().slice(0, 10);
}

async function fetchPitcherUsage(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const mmddyyyy = m + '/' + d + '/' + y;
  const schedUrl = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + mmddyyyy + '&hydrate=linescore,pitchers';
  const sResp = await fetch(schedUrl);
  if (!sResp.ok) throw new Error('MLB schedule HTTP ' + sResp.status);
  const sched = await sResp.json();
  const games = (sched.dates && sched.dates[0] && sched.dates[0].games) || [];
  const out = [];
  for (const g of games) {
    const status = g.status && g.status.abstractGameState;
    if (status !== 'Final') continue;
    try {
      const bResp = await fetch('https://statsapi.mlb.com/api/v1/game/' + g.gamePk + '/boxscore');
      if (!bResp.ok) continue;
      const box = await bResp.json();
      for (const side of ['home', 'away']) {
        const teamObj = box.teams && box.teams[side];
        if (!teamObj) continue;
        const teamAbbr = (teamObj.team && teamObj.team.abbreviation || '').toUpperCase();
        const pitcherIds = teamObj.pitchers || [];
        for (const pid of pitcherIds) {
          const player = teamObj.players && teamObj.players['ID' + pid];
          if (!player) continue;
          const name = player.person && player.person.fullName;
          if (!name) continue;
          const pitching = (player.stats && player.stats.pitching) || {};
          const pitches = pitching.numberOfPitches != null ? pitching.numberOfPitches
                        : (pitching.pitchesThrown != null ? pitching.pitchesThrown : 0);
          out.push({ team: teamAbbr, pitcher_name: name, pitcher_mlb_id: pid, pitches_thrown: Number(pitches) || 0 });
        }
      }
    } catch (e) {
      console.log('  [gamePk=' + g.gamePk + '] boxscore failed: ' + e.message);
    }
  }
  return out;
}

async function main() {
  // Last 7 days ending yesterday ET, walking backwards.
  const dates = [];
  for (let i = 1; i <= 7; i++) dates.push(etDate(-i));

  console.log('DB: ' + DB_PATH);
  console.log('Backfilling pitcher usage for 7 date(s): ' + dates[0] + ' → ' + dates[dates.length - 1]);

  let totalRecords = 0;
  for (const date of dates) {
    process.stdout.write('  ' + date + ' … ');
    try {
      const usage = await fetchPitcherUsage(date);
      const tx = db.transaction((records) => {
        for (const u of records) {
          upsert.run(date, u.team, u.pitcher_name, u.pitcher_mlb_id, u.pitches_thrown, 1);
        }
      });
      tx(usage);
      totalRecords += usage.length;
      console.log(usage.length + ' appearances');
    } catch (e) {
      console.log('FAILED: ' + e.message);
    }
  }
  console.log('Done. Total appearances recorded: ' + totalRecords);
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
