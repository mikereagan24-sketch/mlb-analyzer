'use strict';
// Probe FG's splits-leaders API with all four combinations of
// (date range) × (autoPt flag) for one split, to establish whether
// the 2-year date window is actually affecting FG's response OR
// whether autoPt='true' is doing the filtering and the date range
// is decorative.
//
// USAGE
//   FG_COOKIE='<paste value of wordpress_logged_in_0cae6f5cb929d209043cb97f8c2eee44>' \
//     node tmp/probe-fg-actuals-4combos.js
//
// Runs against FG DIRECTLY (not through the app). Requires a live
// FG Member session cookie. Sandbox can't reach FG; must run from
// owner's machine.
//
// Output: 4 rows per split × 4 splits = 16 combinations. Reports
// row count + sample of top-3 player names + wOBA range so a
// quick visual scan confirms the shape.
//
// Interpretation guide:
//   - If row counts are IDENTICAL across all 4 combinations for a
//     split, the 2-year window is decorative AND autoPt is (or isn't)
//     the whole story. Look at whether autoPt='true' vs 'false'
//     changes counts specifically.
//   - If autoPt='true' returns strictly fewer rows than autoPt='false'
//     regardless of date, autoPt IS the qualifier gate. 2-year window
//     is likely irrelevant for what we get.
//   - If date range DOES change counts (2y > 1season), the window IS
//     doing work — narrowing it is a real character shift.
//   - If date changes counts only when autoPt='false', autoPt='true'
//     is providing a season-based qualifier so date becomes redundant
//     for the qualified subset.

const cookie = process.env.FG_COOKIE;
if (!cookie) {
  console.error('Set FG_COOKIE env var to the value of the wordpress_logged_in_... cookie.');
  process.exit(1);
}
const COOKIE_NAME = 'wordpress_logged_in_0cae6f5cb929d209043cb97f8c2eee44';
const URL = 'https://www.fangraphs.com/api/leaders/splits/splits-leaders';

const SPLITS = [
  { key: 'bat-act-lhp', split: 1, pos: 'B' },
  { key: 'bat-act-rhp', split: 2, pos: 'B' },
  { key: 'pit-act-lhb', split: 5, pos: 'P' },
  { key: 'pit-act-rhb', split: 6, pos: 'P' },
];

function seasonRange() {
  const now = new Date();
  const y = now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return { start: y + '-03-01', end: y + '-11-01', label: 'season' };
}
function twoYearRange() {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(end.getFullYear() - 2);
  const iso = d => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end), label: '2year' };
}

async function fetchOne(splitSpec, dateRange, autoPt) {
  const body = {
    strSplitArr: [splitSpec.split],
    strGroup: 'season',
    strPosition: splitSpec.pos,
    strType: '2',
    strStartDate: dateRange.start,
    strEndDate: dateRange.end,
    strSplitTeams: false,
    dctFilters: [],
    strStatType: 'player',
    strAutoPt: autoPt,  // 'true' or 'false'
    arrPlayerId: [],
    strPlayerId: 'all',
    strSplitArrPitch: [],
    arrWxTemperature: null, arrWxPressure: null, arrWxAirDensity: null,
    arrWxElevation: null, arrWxWindSpeed: null,
  };
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'Cookie': COOKIE_NAME + '=' + cookie,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': 'https://www.fangraphs.com/leaders/splits-leaderboards',
      'Origin': 'https://www.fangraphs.com',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let bodyText = '';
    try { bodyText = (await res.text()).slice(0, 200); } catch(_){}
    return { error: 'HTTP ' + res.status + ' — ' + bodyText };
  }
  let json;
  try { json = await res.json(); } catch(e) { return { error: 'JSON parse: ' + e.message }; }
  if (!json || !Array.isArray(json.data)) {
    return { error: 'no data array; keys: ' + Object.keys(json||{}).join(',') };
  }
  return { rows: json.data };
}

function playerName(row) {
  return row.PlayerName || row.Name || row.playerName || row.name || '?';
}
function wobaOf(row) {
  return row.wOBA != null ? row.wOBA : row.woba != null ? row.woba : null;
}
function pa(row) {
  return row.PA != null ? row.PA : row.pa != null ? row.pa : (row.TBF != null ? row.TBF : null);
}

(async function main() {
  const dateOpts = [twoYearRange(), seasonRange()];
  const autoPtOpts = ['true', 'false'];

  console.log('FG splits API probe — 4 combinations per split');
  console.log('Ran at: ' + new Date().toISOString());
  console.log('URL: ' + URL + '\n');

  const results = [];
  for (const sp of SPLITS) {
    console.log('== ' + sp.key + ' (split=' + sp.split + ', pos=' + sp.pos + ') ==');
    for (const dr of dateOpts) {
      for (const ap of autoPtOpts) {
        const r = await fetchOne(sp, dr, ap);
        if (r.error) {
          console.log('  ' + dr.label.padEnd(6) + ' × autoPt=' + ap.padEnd(5) + '  → ERROR: ' + r.error);
          results.push({ split: sp.key, date: dr.label, autoPt: ap, count: null, error: r.error });
          continue;
        }
        // Sort by PA/TBF desc so top-3 are meaningful volume-wise
        const rows = r.rows.slice().sort((a, b) => (pa(b)||0) - (pa(a)||0));
        const top3 = rows.slice(0, 3).map(x => playerName(x) + '(PA=' + pa(x) + ',w=' + wobaOf(x) + ')').join(', ');
        // Min-sample player (near the gate)
        const minSample = rows.reduce((m, x) => Math.min(m, pa(x)||Infinity), Infinity);
        const maxSample = rows[0] ? pa(rows[0]) : null;
        console.log('  ' + dr.label.padEnd(6) + ' × autoPt=' + ap.padEnd(5)
          + '  → n=' + String(rows.length).padStart(4)
          + '  PA range [' + (isFinite(minSample) ? minSample : 'n/a') + ' … ' + maxSample + ']'
          + '  top3: ' + top3);
        results.push({ split: sp.key, date: dr.label, autoPt: ap, count: rows.length, minSample, maxSample });
      }
    }
    console.log('');
    await new Promise(r => setTimeout(r, 500)); // gentle to FG
  }

  // Summary grid
  console.log('\n== SUMMARY (row counts) ==');
  console.log('  split          2y+autoPt=T  2y+autoPt=F  season+autoPt=T  season+autoPt=F');
  for (const sp of SPLITS) {
    const cells = ['2year|true', '2year|false', 'season|true', 'season|false'].map(k => {
      const [d, ap] = k.split('|');
      const r = results.find(x => x.split === sp.key && x.date === d && x.autoPt === ap);
      return r && r.count != null ? String(r.count).padStart(4) : ' err';
    });
    console.log('  ' + sp.key.padEnd(14) + '  ' + cells[0].padStart(10) + '   ' + cells[1].padStart(10)
      + '     ' + cells[2].padStart(11) + '        ' + cells[3].padStart(11));
  }

  // Interpretation cues
  console.log('\n== INTERPRETATION ==');
  for (const sp of SPLITS) {
    const cell = (d, ap) => (results.find(x => x.split === sp.key && x.date === d && x.autoPt === ap) || {}).count;
    const cells = {
      'true2y': cell('2year','true'), 'false2y': cell('2year','false'),
      'true1s': cell('season','true'), 'false1s': cell('season','false'),
    };
    const dateAffectsAtTrue = cells.true2y !== cells.true1s;
    const dateAffectsAtFalse = cells.false2y !== cells.false1s;
    const autoPtAffectsAt2y = cells.true2y !== cells.false2y;
    const autoPtAffectsAt1s = cells.true1s !== cells.false1s;
    console.log('  ' + sp.key + ':');
    console.log('    date range affects count when autoPt=true?  ' + (dateAffectsAtTrue ? 'YES' : 'no') + '  (' + cells.true2y + ' vs ' + cells.true1s + ')');
    console.log('    date range affects count when autoPt=false? ' + (dateAffectsAtFalse ? 'YES' : 'no') + '  (' + cells.false2y + ' vs ' + cells.false1s + ')');
    console.log('    autoPt affects count at 2year range?         ' + (autoPtAffectsAt2y ? 'YES' : 'no') + '  (' + cells.true2y + ' vs ' + cells.false2y + ')');
    console.log('    autoPt affects count at season range?        ' + (autoPtAffectsAt1s ? 'YES' : 'no') + '  (' + cells.true1s + ' vs ' + cells.false1s + ')');
  }

  console.log('\nDone. Paste the SUMMARY grid + INTERPRETATION block back for the fix decision.');
})().catch(e => {
  console.error('probe failed:', e.stack || e.message);
  process.exit(1);
});
