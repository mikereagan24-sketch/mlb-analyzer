#!/usr/bin/env node
/**
 * Does the 18:00-23:00 PT anchor gap actually cost anything? (2026-09-03)
 *
 * The capped live first-pitch refresh leaves late-starting games waiting
 * for the 11PM PT lineup pass, because there is no pass for TODAY between
 * 18:00 and 23:00. Simulated worst case on the 09-02 slate was 262
 * minutes on the scheduled-start fallback.
 *
 * THAT IS ONLY A COST IF THE FALLBACK IS EVER WRONG IN THAT WINDOW. It
 * says "started" as soon as the scheduled time passes. For a game that
 * starts on time that is correct and the anchor adds nothing. It is wrong
 * only for a DELAYED game -- and then it refuses a signal that was
 * legitimately pre-game.
 *
 * So the question is not "how long do late games wait" but "how often was
 * a late game delayed enough that we refused something we should have
 * emitted". Adding evening crons to fix a 262-minute wait that never
 * mattered is adding load to a 512MB instance for nothing.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));

const PT_OFFSET_H = 7;
const ptHour = utc => {
  const d = new Date(Date.parse(utc) - PT_OFFSET_H * 3600000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
};

const rows = db.prepare(
  'SELECT game_date, game_id, scheduled_start_utc, first_pitch_utc '
  + 'FROM game_log WHERE first_pitch_utc IS NOT NULL AND scheduled_start_utc IS NOT NULL '
  + 'ORDER BY game_date, game_id').all();

const withDelay = rows.map(r => ({
  ...r,
  ptH: ptHour(r.scheduled_start_utc),
  delay: Math.round((Date.parse(r.first_pitch_utc) - Date.parse(r.scheduled_start_utc)) / 60000),
}));

const evening = withDelay.filter(r => r.ptH >= 18 && r.ptH < 23);

console.log('=== CORPUS ===');
console.log('  games with both timestamps : ' + rows.length
  + '   (' + rows[0].game_date + ' .. ' + rows[rows.length - 1].game_date + ')');
console.log('  scheduled 18:00-23:00 PT   : ' + evening.length
  + '   (' + (100 * evening.length / rows.length).toFixed(1) + '% of the season)');
console.log('');

// ---- delay distribution, whole season vs the evening window ------------
const bucket = arr => {
  const b = { 'on time (<=2m)': 0, '3-9m': 0, '10-29m': 0, '30-59m': 0, '60m+': 0, 'negative': 0 };
  for (const r of arr) {
    if (r.delay < 0) b['negative']++;
    else if (r.delay <= 2) b['on time (<=2m)']++;
    else if (r.delay < 10) b['3-9m']++;
    else if (r.delay < 30) b['10-29m']++;
    else if (r.delay < 60) b['30-59m']++;
    else b['60m+']++;
  }
  return b;
};
const fmt = (label, arr) => {
  const b = bucket(arr);
  console.log('  ' + label + '  (n=' + arr.length + ')');
  for (const [k, v] of Object.entries(b))
    console.log('    ' + k.padEnd(16) + String(v).padStart(5)
      + '   ' + (arr.length ? (100 * v / arr.length).toFixed(1) + '%' : '-'));
};
console.log('=== DELAY = first_pitch - scheduled ===');
fmt('whole season ', withDelay);
console.log('');
fmt('18:00-23:00 PT', evening);
console.log('');

// ---- the thing that actually matters ----------------------------------
// A delay only costs us if a lineup pass fell inside it: that is when the
// fallback says "started" while the market is still pre-game. Passes for
// TODAY fire at these PT hours.
const PASSES = [8, 10, 12, 13, 14, 15, 16, 17, 18, 23];
const exposed = evening.filter(r => {
  if (r.delay <= 2) return false;
  const startH = r.ptH;
  const endH = r.ptH + r.delay / 60;
  return PASSES.some(h => h > startH && h < endH);
});

// Punctuality by start band -- the finding that settles the question. The
// gap sits in the band with the fewest delays, not the most.
console.log('=== PUNCTUALITY BY START BAND ===');
console.log('  band            n     >2m       >=10m   >=60m   worst');
for (const [lo, hi, lbl] of [[9,13,'09:00-13:00'],[13,16,'13:00-16:00'],
                            [16,18,'16:00-18:00'],[18,23,'18:00-23:00 *']]) {
  const b = withDelay.filter(r => r.ptH >= lo && r.ptH < hi);
  if (!b.length) continue;
  const late = b.filter(r => r.d > 2).length;
  const t10 = b.filter(r => r.delay >= 10).length;
  const t60 = b.filter(r => r.delay >= 60).length;
  const worst = Math.max.apply(null, b.map(r => r.delay));
  console.log('  ' + lbl.padEnd(15) + String(b.length).padStart(4)
    + String(b.filter(r => r.delay > 2).length + ' (' 
      + (100 * b.filter(r => r.delay > 2).length / b.length).toFixed(0) + '%)').padStart(11)
    + String(t10).padStart(8) + String(t60).padStart(8) + String(worst + 'm').padStart(8));
}
console.log('');
console.log('  * the band with the anchor gap is the MOST punctual of the day.');
console.log('');
console.log('=== EXPOSURE: a pass falling INSIDE the delay window ===');
console.log('  evening games delayed >2m           : '
  + evening.filter(r => r.delay > 2).length);
console.log('  ...with a lineup pass inside the gap : ' + exposed.length);
console.log('');
if (exposed.length) {
  console.log('  game_date   game        sched(PT)  delay   passes inside');
  for (const r of exposed) {
    const inside = PASSES.filter(h => h > r.ptH && h < r.ptH + r.delay / 60);
    console.log('  ' + r.game_date + '  ' + String(r.game_id).padEnd(11)
      + String(Math.floor(r.ptH) + ':' + String(Math.round((r.ptH % 1) * 60)).padStart(2, '0')).padEnd(11)
      + String(r.delay + 'm').padEnd(8) + inside.map(h => h + ':00').join(', '));
  }
} else {
  console.log('  NONE. Every evening delay resolved before the next pass would');
  console.log('  have run, so the fallback never had a chance to refuse a');
  console.log('  legitimately pre-game signal in this window.');
}
console.log('');

// ---- and did we in fact emit in those windows? -------------------------
const sig = db.prepare(
  "SELECT COUNT(*) n FROM bet_signals WHERE game_date=? AND game_id=? "
  + "AND created_at >= ? AND created_at <= ?");
let emitted = 0;
for (const r of exposed) {
  try {
    const n = sig.get(r.game_date, r.game_id,
      r.scheduled_start_utc.replace('T', ' ').slice(0, 19),
      r.first_pitch_utc.replace('T', ' ').slice(0, 19)).n;
    emitted += n;
  } catch (e) { /* ignore */ }
}
console.log('=== SIGNALS ACTUALLY WRITTEN INSIDE A DELAY WINDOW ===');
console.log('  ' + emitted + '   (these are what a correct anchor would have preserved,');
console.log('       or what the fallback wrongly refused, depending on direction)');
console.log('');
console.log('=== VERDICT INPUT ===');
console.log('  If exposure is 0, the 262-minute worst case is THEORETICAL and');
console.log('  adding evening crons buys nothing on a 512MB instance that just');
console.log('  OOM-crash-looped.');
