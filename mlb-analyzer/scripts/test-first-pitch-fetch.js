#!/usr/bin/env node
/**
 * feed/live is fetched small, and the fallback actually works. (2026-09-03)
 *
 * We JSON.parsed 780 KB -- every play of a game -- to read three fields,
 * on a 512MB instance. Measured against gamePk 824636:
 *
 *   feed/live FULL       780.1 KB
 *   feed/live ?fields=     0.1 KB   (149 bytes)
 *
 * and no lighter endpoint carries firstPitch at all (v1 boxscore 167 KB no,
 * linescore 3.1 KB no, feed/live/timestamps 8.6 KB no, schedule+hydrate
 * 1.6 KB has status but NOT firstPitch).
 *
 * THE FALLBACK IS THE POINT OF THIS TEST. If statsapi stops honouring
 * ?fields= the response silently becomes the full document again, so the
 * parse is size-gated and falls back to a raw-text extract. That path runs
 * only when something upstream changes, which makes it the code most
 * likely to be broken when it is finally needed -- and its first version
 * WAS broken (returned "2026-08-30", "F", null from bad slice arithmetic),
 * caught only by diffing against a real parse.
 */
const path = require('path');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const fp = require(path.join(R, 'services/first-pitch'));

// ---- 1. the URL asks for three fields, not the whole game --------------
const url = fp.FEED_URL(824636);
ok(url.includes('?fields='), 'FEED_URL requests a field filter');
for (const f of ['gameData', 'dateTime', 'firstPitch', 'detailedState']) {
  ok(url.includes(f), 'the filter names ' + f);
}
ok(!fp.FEED_URL_FULL(824636).includes('?fields='),
   'FEED_URL_FULL is kept unfiltered, for the fallback comparison');

// ---- 2. the size gate exists and is sane -------------------------------
ok(typeof fp.FEED_MAX_PARSE_BYTES === 'number', 'a parse size gate is defined');
ok(fp.FEED_MAX_PARSE_BYTES >= 4096 && fp.FEED_MAX_PARSE_BYTES <= 256 * 1024,
   'the gate is between 4KB and 256KB (got ' + fp.FEED_MAX_PARSE_BYTES + ')');
ok(fp.FEED_MAX_PARSE_BYTES < 780 * 1024,
   'and is well below a full feed/live body, so an unfiltered response trips it');

// ---- 3. the raw extractor agrees with a real parse ---------------------
// Shaped like the real document: the three keys buried in a large body,
// with decoy values before and after so a sloppy matcher is caught.
const decoy = '"someOtherKey":"2020-01-01T00:00:00Z",'.repeat(200);
const body = '{"gameData":{' + decoy
  + '"datetime":{"dateTime":"2026-08-30T23:20:00Z","originalDate":"2026-08-30"},'
  + '"status":{"abstractGameState":"Final","detailedState":"Final"},'
  + '"gameInfo":{"attendance":30000,"firstPitch":"2026-08-30T23:45:00.000Z"}}}';
const raw = fp._extractFromRaw(body);
const parsed = JSON.parse(body);
eq(raw.dateTime, parsed.gameData.datetime.dateTime, 'raw dateTime matches the parse');
eq(raw.firstPitch, parsed.gameData.gameInfo.firstPitch, 'raw firstPitch matches the parse');
eq(raw.detailedState, parsed.gameData.status.detailedState, 'raw detailedState matches the parse');

// The specific bug the first version had: truncation.
ok(String(raw.dateTime).length > 10, 'dateTime is NOT truncated to the date part');
ok(String(raw.detailedState).length > 1, 'detailedState is NOT truncated to one character');
ok(raw.firstPitch !== null, 'firstPitch is found rather than missed');

// ---- 4. missing fields degrade to null, never to a wrong value ---------
const noFp = fp._extractFromRaw('{"gameData":{"status":{"detailedState":"Scheduled"}}}');
eq(noFp.firstPitch, null, 'an absent firstPitch reads null (a game that has not started has none)');
eq(noFp.detailedState, 'Scheduled', 'while the fields that ARE present still resolve');
eq(fp._extractFromRaw('').firstPitch, null, 'an empty body is null, not a throw');
eq(fp._extractFromRaw('not json at all').detailedState, null, 'garbage is null, not a throw');

// ---- 5. hasStarted is untouched ---------------------------------------
const now = '2026-09-02T20:00:00Z';
eq(fp.hasStarted({ first_pitch_utc: '2026-09-02T19:00:00Z' }, now, 0), true, 'first_pitch branch still wins');
eq(fp.hasStarted({ game_status: 'In Progress' }, now, 0), true, 'status branch still fires');
eq(fp.hasStarted({ scheduled_start_utc: '2026-09-02T21:00:00Z' }, now, 0), false, 'scheduled branch still fires');
eq(fp.hasStarted({}, now, 0), null, 'nothing usable still returns null, not false');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
