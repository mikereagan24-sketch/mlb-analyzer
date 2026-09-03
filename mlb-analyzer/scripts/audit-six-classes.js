#!/usr/bin/env node
/**
 * Six-class defect audit across the codebase. (2026-09-03)
 *
 * The classes are the ones this codebase has actually produced, each named
 * from a real incident rather than from a taxonomy:
 *
 *   1 WRONG-CAUSE STRING   a message naming one cause unconditionally,
 *                          written when that was the only cause, left alone
 *                          as causes were added. (401 -> app password;
 *                          'Lineup incomplete'; 'edge no longer meets
 *                          threshold'; 'corrupt feed data' on a live game)
 *   2 COMPUTED-AND-DISCARDED  a value computed, thrown away, then
 *                          re-derived by a consumer -- which is what forces
 *                          a parallel implementation into existence.
 *                          (getBullpenWoba's pre-blend components)
 *   3 PARALLEL IMPLEMENTATION  a second copy of a rule that drifts.
 *                          (bullpen report mirror; /debug/bullpen;
 *                          the surname match in three places)
 *   4 CONSUMER LOOSER THAN PRODUCER  a reader admitting data its writer
 *                          rejects. (bullpen minBF; FRV floor)
 *   5 CANNOT EXECUTE OR FIRE  dead call sites, unreachable guards,
 *                          patterns that cannot match. (renderLoggedBets
 *                          inside <style>; a trigger behind an earlier
 *                          return; a gate arm whose flag stopped being
 *                          written)
 *   6 MIXED MOMENTS        a frozen number rendered beside live ones with
 *                          nothing marking the difference. (the signal
 *                          badge; the spread pp figure)
 *
 * DETECTION HONESTY. These have very different tractability. 3, 5 and 6
 * have mechanical signatures. 1 and 4 are semi-mechanical: the scan finds
 * candidates and a human decides. 2 is largely a judgement call and the
 * scan only narrows where to look. Every finding below carries a
 * confidence, and the summary never presents a candidate count as a defect
 * count.
 *
 * RANKING is by blast radius, because that is what decides whether a hit
 * is worth touching:
 *   PRICING   feeds the model or the emitted signal
 *   OPERATOR  reaches a human via UI, log, or note
 *   ANALYSIS  backtests, sweeps, one-shot scripts
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

const PRICING = ['services/model.js', 'services/jobs.js', 'db/schema.js', 'utils/'];
const OPERATOR = ['routes/api.js', 'public/index.html', 'server.js'];
const walk = (dir, out) => {
  out = out || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(path.relative(R, p).replace(/\\/g, '/'));
  }
  return out;
};
const files = walk(R).filter(f => !f.startsWith('tmp/'));
const src = {};
for (const f of files) { try { src[f] = fs.readFileSync(path.join(R, f), 'utf8'); } catch (e) {} }

// STRIP COMMENTS BEFORE ANY CODE-SHAPE SCAN.
//
// The first run of this scanner reported three HIGH-confidence /-g(d+)$/
// hits. All three were COMMENTS describing that bug being fixed -- the
// exact false positive this codebase has hit repeatedly (a check that
// cannot tell the defect from the note explaining it). A scan that reads
// prose as code manufactures findings, which is worse than missing them.
// LINE-BASED, deliberately. The first attempt used regexes over the whole
// file and blanked 82% of routes/api.js -- a `/*` inside a string or regex
// literal opens a match that runs to the next real `*/` and eats hundreds
// of lines. Every reference then read as zero and the scan reported 23
// live functions as dead.
//
// So: whole-line comments only, with a simple block-comment state machine.
// It will miss a trailing `// ...` after code, which is the right direction
// to be wrong -- it keeps real code rather than inventing dead code.
function stripComments(t) {
  const out = [];
  let inBlock = false;
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (inBlock) {
      out.push('');
      if (s.includes('*/')) inBlock = false;
      continue;
    }
    if (s.startsWith('/*')) {
      out.push('');
      if (!s.includes('*/')) inBlock = true;
      continue;
    }
    if (s.startsWith('//') || s.startsWith('*')) { out.push(''); continue; }
    out.push(line);
  }
  return out.join('\n');
}
const code = {};

const tier = f =>
  PRICING.some(p => f.startsWith(p)) ? 'PRICING'
  : OPERATOR.some(p => f.startsWith(p)) ? 'OPERATOR'
  : 'ANALYSIS';

for (const f of files) code[f] = stripComments(src[f] || '');

const findings = [];
const add = (cls, file, line, what, conf) =>
  findings.push({ cls, file, line, what, conf, tier: tier(file) });

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

// ── CLASS 5: cannot execute or fire ─────────────────────────────────────
// (a) functions defined once and referenced nowhere else.
for (const f of files) {
  if (!/\.js$/.test(f) || f.startsWith('scripts/')) continue;
  const t = src[f];
  const defs = [...t.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)];
  for (const m of defs) {
    const name = m[1];
    if (name.length < 4) continue;
    let refs = 0;
    for (const g of files) {
      // Reference count over CODE, so a function named only in prose still
      // reads as dead.
      const hits = (code[g].match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
      refs += hits;
    }
    if (refs <= 1) add(5, f, lineOf(t, m.index), 'function ' + name + '() defined, referenced nowhere', 'high');
  }
}
// (b) JS statements marooned inside <style> (the renderLoggedBets shape).
for (const f of files.filter(x => /\.html$/.test(x))) {
  const t = src[f];
  const lines = t.split(/\r?\n/);
  let inStyle = false;
  lines.forEach((l, i) => {
    if (/<style[ >]/i.test(l)) inStyle = true;
    if (/<\/style>/i.test(l)) inStyle = false;
    if (!inStyle) return;
    const s = l.trim();
    if (/^[A-Za-z_$][\w$.]*\s*\([^)]*\)\s*[+;,]?\s*$/.test(s))
      add(5, f, i + 1, 'JS-looking statement inside <style>: ' + s.slice(0, 46), 'high');
  });
}
// (c) regex literals containing a lone 'd'/'w'/'s' class letter with no
//     backslash -- the shape the eaten-backslash bugs took.
for (const f of files) {
  const t = src[f];
  // CODE only. The first run flagged three of these HIGH confidence and all
  // three were comments describing the bug being fixed.
  for (const m of code[f].matchAll(/\/[^\/\n]*\(d\+\)[^\/\n]*\//g))
    add(5, f, lineOf(t, m.index), 'regex contains (d+) -- likely an eaten backslash: ' + m[0].slice(0, 40), 'high');
}

// ── CLASS 3: parallel implementations ───────────────────────────────────
// Distinctive multi-token expressions appearing in more than one file.
const SIGNATURES = [
  ["endsWith(' '+last)", 'surname-only identity match'],
  ['qualified.length >= 3', 'bullpen pool-selection rule'],
  ['BP_W_PROJ * proj.woba', 'bullpen proj/act blend arithmetic'],
  ['checkMarketMLPairSanity(', 'market pair sanity gate'],
  ['getFatiguedPitchers(', 'fatigue exclusion lookup'],
  ['_pickBestML(', 'venue best-price selection'],
  ['1 + (', 'park neutralisation transform (weak signature)'],
];
for (const [sig, label] of SIGNATURES) {
  const where = [];
  for (const f of files) {
    const n = code[f].split(sig).length - 1;
    if (n > 0) where.push({ f, n });
  }
  const nonTest = where.filter(w => !/scripts\/test-|scripts\/audit-|scripts\/measure-/.test(w.f));
  if (nonTest.length > 1) {
    add(3, nonTest[0].f, 0,
      label + ' appears in ' + nonTest.length + ' non-test files: '
        + nonTest.map(w => w.f + '(' + w.n + ')').join(', '),
      sig === '1 + (' ? 'low' : 'medium');
  }
}

// ── CLASS 1: wrong-cause strings ────────────────────────────────────────
// An operator-facing string assigned WITHOUT a conditional, in a file that
// also carries a multi-valued reason vocabulary.
for (const f of files) {
  if (f.startsWith('scripts/')) continue;
  const t = src[f];
  const hasReasonVocab = /REASON_TEXT|_suppressed|reason:|reasons\.push|suppressed_reason/.test(t);
  if (!hasReasonVocab) continue;
  const lines = t.split(/\r?\n/);
  lines.forEach((l, i) => {
    const m = l.match(/^\s*(?:const |let |)(note|reason|message|detail|msg)\s*=\s*'([^']{18,})';\s*$/);
    if (!m) return;
    if (/\?|REASON_TEXT|\+\s*\(/.test(l)) return;   // has a branch or a lookup
    add(1, f, i + 1, m[1] + " = a fixed string, no branch: '" + m[2].slice(0, 44) + "'", 'medium');
  });
}

// ── CLASS 4: consumer looser than producer ──────────────────────────────
// Same threshold concept defined more than once with different literals.
const THRESH = {};
for (const f of files) {
  if (f.startsWith('scripts/')) continue;
  const t = src[f];
  for (const m of t.matchAll(/\b([A-Z][A-Z0-9_]*(?:MIN|MAX|FLOOR|CAP|THRESHOLD)[A-Z0-9_]*)\s*=\s*([\d.]+)/g)) {
    const k = m[1];
    (THRESH[k] = THRESH[k] || []).push({ f, v: m[2], line: lineOf(t, m.index) });
  }
}
for (const [k, uses] of Object.entries(THRESH)) {
  const vals = [...new Set(uses.map(u => u.v))];
  if (vals.length > 1)
    add(4, uses[0].f, uses[0].line,
      k + ' defined with DIFFERENT values: ' + uses.map(u => u.f + '=' + u.v).join(', '), 'medium');
}

// ── CLASS 6: mixed moments ──────────────────────────────────────────────
// Emit-time / frozen columns, and whether the rendering surface labels them.
const FROZEN = ['_at_emit', 'bet_locked_at', 'closing_line', 'generated_at', 'snapshot_at', 'captured_at'];
for (const f of files.filter(x => OPERATOR.some(p => x.startsWith(p)))) {
  const t = src[f];
  for (const col of FROZEN) {
    if (!t.includes(col)) continue;
    // PROXIMITY, not file-level. index.html now labels one surface (the
    // signal badge), and a file-level test would mark every other frozen
    // field in that file as handled on the strength of it.
    const at = t.indexOf(col);
    const near = t.slice(Math.max(0, at - 400), at + 400);
    const labelled = /as of|frozen|at emit|emitStamp|sigProvenance/i.test(near);
    add(6, f, lineOf(t, at),
      'renders frozen field ' + col + (labelled ? ' -- labelled nearby' : ' -- NO time label within 400 chars'),
      labelled ? 'low' : 'medium');
  }
}

// ── CLASS 2: computed-and-discarded ─────────────────────────────────────
// Weakest heuristic, and reported as such: a function building a rich local
// object that returns only a scalar or a narrow subset.
for (const f of files) {
  if (f.startsWith('scripts/')) continue;
  const t = src[f];
  for (const m of t.matchAll(/return\s+\{\s*woba:\s*[^,}]+,\s*\}/g))
    add(2, f, lineOf(t, m.index), 'returns only {woba} from a block that computed more', 'low');
}

// ── REPORT ──────────────────────────────────────────────────────────────
const CLASS_NAME = {
  1: 'WRONG-CAUSE STRING', 2: 'COMPUTED-AND-DISCARDED', 3: 'PARALLEL IMPLEMENTATION',
  4: 'CONSUMER LOOSER THAN PRODUCER', 5: 'CANNOT EXECUTE OR FIRE', 6: 'MIXED MOMENTS',
};
const TIER_ORDER = { PRICING: 0, OPERATOR: 1, ANALYSIS: 2 };

console.log('=== SIX-CLASS AUDIT ===');
console.log('  files scanned: ' + files.length + '   (excludes node_modules, tmp/)');
console.log('');
console.log('  CANDIDATES BY CLASS AND BLAST RADIUS');
console.log('  class                            PRICING  OPERATOR  ANALYSIS   total');
for (const c of [1, 2, 3, 4, 5, 6]) {
  const f = findings.filter(x => x.cls === c);
  const p = f.filter(x => x.tier === 'PRICING').length;
  const o = f.filter(x => x.tier === 'OPERATOR').length;
  const a = f.filter(x => x.tier === 'ANALYSIS').length;
  console.log('  ' + (c + ' ' + CLASS_NAME[c]).padEnd(34)
    + String(p).padStart(7) + String(o).padStart(10) + String(a).padStart(10)
    + String(f.length).padStart(8));
}
console.log('  ' + 'TOTAL'.padEnd(34)
  + String(findings.filter(x => x.tier === 'PRICING').length).padStart(7)
  + String(findings.filter(x => x.tier === 'OPERATOR').length).padStart(10)
  + String(findings.filter(x => x.tier === 'ANALYSIS').length).padStart(10)
  + String(findings.length).padStart(8));
console.log('');
console.log('  confidence: '
  + ['high', 'medium', 'low'].map(c => c + ' ' + findings.filter(x => x.conf === c).length).join('   '));
console.log('');

for (const c of [1, 2, 3, 4, 5, 6]) {
  const f = findings.filter(x => x.cls === c)
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.file.localeCompare(b.file));
  if (!f.length) continue;
  console.log('--- CLASS ' + c + ': ' + CLASS_NAME[c] + '  (' + f.length + ') ---');
  for (const x of f) {
    console.log('  [' + x.tier.padEnd(8) + '][' + x.conf.padEnd(6) + '] '
      + x.file + (x.line ? ':' + x.line : '') + '  ' + x.what);
  }
  console.log('');
}
