'use strict';

// FanGraphs RosterResource depth-chart scraper for SP/RP role classification.
// The GS/G heuristic in scraper.fetchActiveRosters misclassifies pitchers who
// follow openers (gs=1, g=many → ratio<<0.5 → tagged RP even though they're
// the de-facto starter, e.g. Chase Dollander). RosterResource is editorially
// curated and tags every pitcher SP1-SP5, CL, SU#, MID, LR explicitly.
//
// One fetch per team. Fangraphs has Cloudflare protection that 403s on the
// default node-fetch User-Agent — we send browser-like headers. If that
// fails on Render the fallback path (direct upload from a known-good IP)
// is documented in the PR but not implemented here yet; we'll only build
// it if production logs show repeated 403s.

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { normName } = require('../utils/names');

// FanGraphs RosterResource uses hyphenated slugs for multi-word team
// nicknames — TOR=blue-jays, BOS=red-sox, CWS=white-sox. Single-word
// nicknames stay un-hyphenated. Any future expansion team or rebrand
// (e.g. CLE Guardians ←→ Indians historical lookups) needs to follow
// the same convention; verify by hitting the live URL before adding.
const TEAM_SLUGS = {
  LAA: 'angels',  HOU: 'astros',     ATH: 'athletics', TOR: 'blue-jays', ATL: 'braves',
  MIL: 'brewers', STL: 'cardinals',  CHC: 'cubs',      ARI: 'diamondbacks', LAD: 'dodgers',
  SF:  'giants',  CLE: 'guardians',  SEA: 'mariners',  MIA: 'marlins',   NYM: 'mets',
  WAS: 'nationals', BAL: 'orioles',  SD:  'padres',    PHI: 'phillies',  PIT: 'pirates',
  TEX: 'rangers', TB:  'rays',       BOS: 'red-sox',   CIN: 'reds',      COL: 'rockies',
  KC:  'royals',  DET: 'tigers',     MIN: 'twins',     CWS: 'white-sox', NYY: 'yankees',
};

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

// Stagger between teams so we don't hammer fangraphs.com 30x in a tight
// loop — same etiquette as the per-team statsapi roster fetch.
const PER_TEAM_DELAY_MS = 1500;

function teamSlugFor(teamAbbr) {
  return TEAM_SLUGS[teamAbbr] || null;
}

async function fetchTeamRolesRaw(teamAbbr) {
  const slug = teamSlugFor(teamAbbr);
  if (!slug) throw new Error('no FG slug for team ' + teamAbbr);
  const url = 'https://www.fangraphs.com/roster-resource/depth-charts/' + slug;
  const resp = await fetch(url, { headers: BROWSER_HEADERS });
  if (resp.status === 403) {
    throw new Error('FG 403 (Cloudflare) for ' + teamAbbr);
  }
  if (!resp.ok) {
    throw new Error('FG HTTP ' + resp.status + ' for ' + teamAbbr);
  }
  return await resp.text();
}

// Parse out (starters, relievers) for a single team's depth-chart page.
// Walks every <tr>; a row is a pitcher row when col-2 text is exactly "SP"
// or "RP" (col 1 carries the specific role detail, col 4+ has the linked
// player name). Defensive: skips rows with too few cells, rows with no
// <a> link (header/empty rows), and trims trailing FG decoration like the
// "▼" expand glyph on section headers.
function parseDepthChartHtml(html, teamAbbr) {
  const $ = cheerio.load(html);
  const starters = [];
  const relievers = [];
  $('tr').each((i, el) => {
    const cells = $(el).find('td');
    if (cells.length < 4) return;
    const roleDetail = $(cells[0]).text().trim();
    const roleFamily = $(cells[1]).text().trim();
    if (roleFamily !== 'SP' && roleFamily !== 'RP') return;
    const link = $(el).find('a').first();
    const name = link.text().trim();
    if (!name) return;
    // CL is its own role detail under the RP family; we surface 'CL' so
    // downstream callers can keep that distinction if they need to (the
    // role we write to team_rosters collapses CL → RP).
    const tag = roleDetail === 'CL' ? 'CL' : roleFamily;
    if (roleFamily === 'SP') {
      starters.push({ name, role: tag, role_detail: roleDetail, name_norm: normName(name) });
    } else {
      relievers.push({ name, role: tag, role_detail: roleDetail, name_norm: normName(name) });
    }
  });
  return { team: teamAbbr, fetched_at: new Date().toISOString(), starters, relievers };
}

async function fetchTeamRoles(teamAbbr) {
  const html = await fetchTeamRolesRaw(teamAbbr);
  return parseDepthChartHtml(html, teamAbbr);
}

// Loop every team with a small inter-fetch delay. Returns Map<teamAbbr, data>;
// teams where the fetch or parse failed map to null (caller treats null as
// "skip; preserve last-good fg_role"). Errors are logged per-team and
// don't abort the loop — one team's 403 shouldn't lose the other 29.
async function fetchAllTeamRoles() {
  const out = new Map();
  const teamAbbrs = Object.keys(TEAM_SLUGS);
  for (let i = 0; i < teamAbbrs.length; i++) {
    const t = teamAbbrs[i];
    try {
      const data = await fetchTeamRoles(t);
      out.set(t, data);
      console.log('[fg-roles] ' + t + ': fetched ' + data.starters.length + ' SP, ' + data.relievers.length + ' RP');
    } catch (e) {
      console.warn('[fg-roles] ' + t + ' fetch failed: ' + e.message);
      out.set(t, null);
    }
    if (i < teamAbbrs.length - 1) {
      await new Promise(r => setTimeout(r, PER_TEAM_DELAY_MS));
    }
  }
  return out;
}

module.exports = {
  TEAM_SLUGS,
  teamSlugFor,
  fetchTeamRoles,
  fetchTeamRolesRaw,
  parseDepthChartHtml,
  fetchAllTeamRoles,
};
