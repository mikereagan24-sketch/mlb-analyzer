#!/usr/bin/env node
/**
 * Sweep for the six recurring defect classes. (2026-09-03)
 *
 * ACCEPTANCE CRITERION, applied to all six: a detector's output means
 * nothing until it flags a known instance of its own class. The previous
 * scanner reported 0 for two classes whose founding instances it
 * structurally could not see -- a reassuring number is the worst possible
 * output of an audit.
 *
 * MOST FOUNDING INSTANCES ARE NOW FIXED ('Lineup incomplete' became a
 * REASON_TEXT lookup; the badge got a provenance chip). So the self-test
 * runs each detector against a FIXTURE reproducing the pre-fix shape.
 * That tests the detector rather than the current tree, which is what the
 * criterion actually needs -- and it keeps working after the next fix.
 *
 * A class whose self-test FAILS is reported as UNTRUSTWORTHY and its
 * findings are withheld, because a count from a blind detector is worse
 * than no count.
 *
 * OVER-REPORTING is handled by labelling, not by better regex. Classes
 * that cannot measure what they would need to (Class 1 cannot count
 * branch arity; Class 3 cannot tell N callers from N copies) emit
 * CANDIDATES FOR REVIEW, and say so.
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

const walk = (d, out) => {
  out = out || [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(path.relative(R, p).replace(/\\/g, '/'));
  }
  return out;
};
function stripComments(t) {
  const out = []; let inBlock = false;
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (inBlock) { out.push(''); if (s.includes('*/')) inBlock = false; continue; }
    if (s.startsWith('/*')) { out.push(''); if (!s.includes('*/')) inBlock = true; continue; }
    if (s.startsWith('//') || s.startsWith('*')) { out.push(''); continue; }
    out.push(line);
  }
  return out.join('\n');
}

const ALL = walk(R);
const src = {}; for (const f of ALL) { try { src[f] = fs.readFileSync(path.join(R, f), 'utf8'); } catch (e) {} }
const code = {}; for (const f of ALL) code[f] = stripComments(src[f] || '');
const isProd = f => !f.startsWith('scripts/') && !f.startsWith('tmp/');
const tierOf = f =>
  /^(services\/(model|jobs)\.js|db\/schema\.js|utils\/)/.test(f) ? 'PRICING'
  : /^(routes\/|public\/|server\.js)/.test(f) ? 'OPERATOR'
  : isProd(f) ? 'PRICING' : 'ANALYSIS';

// ── the six detectors ───────────────────────────────────────────────────
// Each takes {src, code, files} so the self-test can hand it a fixture.

const D = {};

// 1. a reason-bearing string assigned with no branch. CANDIDATES ONLY:
//    branch arity is not measurable here, and a single-cause branch with a
//    fixed message is correct.
D[1] = ({ src, code, files }) => {
  const out = [];
  for (const f of files) {
    if (!/reason|suppress|_suppressed|note|detail/i.test(src[f] || '')) continue;
    (code[f] || '').split(/\r?\n/).forEach((l, i) => {
      // NOT anchored to start/end of line. The founding instance was
      // `const note = suppressed ? 'Lineup incomplete' : ...` on a line
      // with other code; anchoring missed it, which the self-test caught.
      const m = l.match(/\b(note|reason|message|detail|msg|label)\s*=\s*(['"])((?:(?!\2).){12,})\2/);
      if (!m) return;
      if (/REASON_TEXT|\?\s*\(|\|\|/.test(l)) return;
      out.push({ where: f + ':' + (i + 1), what: m[1] + " = fixed string: '" + m[3].slice(0, 52) + "'" });
    });
  }
  return out;
};

// 2. a column written by production with no production reader.
D[2] = ({ src, code, files }) => {
  const schema = src['db/schema.js'] || Object.values(src).join('\n');
  const cols = new Set();
  for (const m of schema.matchAll(/ADD COLUMN (\w+)/g)) cols.add(m[1]);
  for (const m of schema.matchAll(/^\s{2,}(\w+)\s+(TEXT|REAL|INTEGER|BOOLEAN)/gm)) cols.add(m[1]);
  const written = new Set(), readProd = new Set(), readAny = new Set();
  for (const f of files) {
    const t = code[f] || '';
    for (const c of cols) {
      if (!t.includes(c)) continue;
      if (new RegExp(c + '\\s*=\\s*\\?').test(t) || new RegExp('INSERT[\\s\\S]{0,700}\\b' + c + '\\b').test(t)) {
        if (isProd(f)) written.add(c);
      }
      if (new RegExp('SELECT[\\s\\S]{0,700}\\b' + c + '\\b|\\.' + c + '\\b|\\b' + c + ':').test(t)) {
        readAny.add(c); if (isProd(f)) readProd.add(c);
      }
    }
  }
  return [...written].filter(c => !readProd.has(c)).sort().map(c => ({
    where: 'db/schema.js:' + c,
    what: 'written by production, no production reader'
      + (readAny.has(c) ? ' (read only in scripts/ or tmp/)' : ' (no reader anywhere)'),
  }));
};

// 3. self-declared duplicates, and the same helper defined in 2+ prod files.
//    CANDIDATES: cannot distinguish N callers of one util from N copies.
D[3] = ({ src, code, files }) => {
  const out = [];
  for (const f of files) {
    (src[f] || '').split(/\r?\n/).forEach((l, i) => {
      if (!/^\s*(\/\/|\*)/.test(l)) return;
      if (/\b(mirrors|copy of|duplicate of|second copy|same logic as)\b/i.test(l))
        out.push({ where: f + ':' + (i + 1), what: 'self-declared: ' + l.trim().slice(0, 72) });
    });
  }
  const defs = {};
  for (const f of files) {
    for (const m of (code[f] || '').matchAll(/(?:^|\n)\s*(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/g))
      (defs[m[1]] = defs[m[1]] || new Set()).add(f);
  }
  for (const [n, s] of Object.entries(defs)) {
    const prod = [...s].filter(isProd);
    if (n.length < 8 || prod.length < 2) continue;
    out.push({ where: n + '()', what: 'defined in ' + prod.length + ' production files: ' + prod.slice(0, 5).join(', ') });
  }
  return out;
};

// 4. same table, a numeric filter on the write side absent on the read side.
D[4] = ({ src, code, files }) => {
  const out = [];
  const CMP = /(\w+)\s*(>=|>)\s*(\d+)/g;
  for (const f of files) {
    const t = code[f] || '';
    for (const m of t.matchAll(/FROM\s+(\w+)/g)) {
      const table = m[1];
      const near = t.slice(m.index, m.index + 400);
      if (!/WHERE/i.test(near)) continue;
      const readGuards = [...near.matchAll(CMP)].map(x => ({ col: x[1], op: x[2], val: Number(x[3]) }));
      // find a write-side guard on the same table anywhere in production
      for (const g of files) {
        if (!isProd(g)) continue;
        const gt = code[g] || '';
        const ins = gt.indexOf('INTO ' + table);
        if (ins < 0) continue;
        const wnear = gt.slice(Math.max(0, ins - 600), ins + 200);
        for (const w of [...wnear.matchAll(CMP)]) {
          const col = w[1], wVal = Number(w[3]);
          // THE COMPARISON IS THE VALUES, not the presence of a guard.
          // The founding instance (FRV) had a guard on BOTH sides -- writer
          // outs >= 600, reader outs > 0 -- so "reader also guards this
          // column" skipped it. That is precisely the defect: same column,
          // looser bound.
          const rg = readGuards.find(x => x.col === col);
          if (!rg) continue;                       // different column, not comparable
          if (rg.val >= wVal) continue;            // reader at least as strict: fine
          out.push({ where: f + ' reads ' + table,
            what: 'writer ' + g + ' guards ' + col + w[2] + w[3]
              + '; reader guards ' + col + rg.op + rg.val + ' -- LOOSER' });
        }
      }
    }
  }
  const seen = new Set();
  return out.filter(x => { const k = x.where + x.what; if (seen.has(k)) return false; seen.add(k); return true; });
};

// 5. settings keys never read, and functions never referenced.
D[5] = ({ src, code, files }) => {
  const out = [];
  const sf = 'services/settings-schema.js';
  if (src[sf]) {
    for (const m of src[sf].matchAll(/^\s*([a-z][a-z0-9_]{4,})\s*:\s*\{/gm)) {
      const k = m[1], UP = k.toUpperCase();
      const read = files.some(f => f !== sf && isProd(f)
        && ((code[f] || '').includes(UP) || new RegExp("['\"]" + k + "['\"]").test(code[f] || '')));
      if (!read) out.push({ where: sf + ':' + k, what: 'settings key never read outside the schema' });
    }
  }
  for (const f of files.filter(x => isProd(x) && /\.js$/.test(x))) {
    for (const m of (code[f] || '').matchAll(/(?:^|\n)(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/g)) {
      const n = m[1]; if (n.length < 5) continue;
      let refs = 0;
      for (const g of files) refs += ((code[g] || '').match(new RegExp('\\b' + n + '\\b', 'g')) || []).length;
      if (refs <= 1) out.push({ where: f, what: 'function ' + n + '() defined, referenced nowhere' });
    }
  }
  // JS marooned inside <style>
  for (const f of files.filter(x => /\.html$/.test(x))) {
    let inStyle = false;
    (src[f] || '').split(/\r?\n/).forEach((l, i) => {
      if (/<style[ >]/i.test(l)) inStyle = true;
      if (/<\/style>/i.test(l)) inStyle = false;
      if (inStyle && /^[A-Za-z_$][\w$.]*\s*\([^)]*\)\s*[+;,]?\s*$/.test(l.trim()))
        out.push({ where: f + ':' + (i + 1), what: 'JS statement inside <style>: ' + l.trim().slice(0, 44) });
    });
  }
  return out;
};

// 6. a frozen/emit-time value rendered with no time label nearby.
D[6] = ({ src, code, files }) => {
  const FROZEN = ['_at_emit', 'bet_locked_at', 'closing_line', 'generated_at', 'snapshot_at', 'captured_at', 'edge_pct'];
  const out = [];
  for (const f of files.filter(x => /^(public\/|routes\/)/.test(x))) {
    // CODE, not raw text. Reading src flagged a comment line that merely
    // mentions edge_pct, plus a guard and a source label -- 4 candidates,
    // 0 real. The label check still reads src, since the label may be in
    // an adjacent comment explaining the freeze.
    const t = code[f] || '';
    for (const col of FROZEN) {
      let i = -1;
      while ((i = t.indexOf(col, i + 1)) >= 0) {
        const near = t.slice(Math.max(0, i - 350), i + 350);
        if (!/render|innerHTML|\.textContent|<span|<div|badge|pill/i.test(near)) continue;
        if (/as of|frozen|at emit|emitStamp|sigProvenance|locked_at \?/i.test(near)) break;
        out.push({ where: f + ':' + t.slice(0, i).split('\n').length,
                   what: 'renders ' + col + ' with no time label within 350 chars' });
        break;
      }
    }
  }
  return out;
};

// ── self-tests: each detector against a fixture of its own class ────────
const FIX = {
  1: { 'f.js': "function x(){ const note = 'Lineup incomplete for this game'; return note; }\nlet reason = 'x';\n" },
  2: { 'db/schema.js': 'ADD COLUMN away_bullpen_woba REAL',
       'services/jobs.js': 'db.prepare("UPDATE game_log SET away_bullpen_woba=?").run(1);' },
  3: { 'a.js': '// mirrors q.getBullpenWoba primary branch\nfunction computeFramingRvPerGame(){}\n',
       'b.js': 'function computeFramingRvPerGame(){}\n' },
  4: { 'w.js': 'const ok = outs >= 600; db.prepare("INSERT INTO fielding_frv (x) VALUES (?)")',
       'r.js': 'db.prepare("SELECT x FROM fielding_frv WHERE outs > 0")' },
  5: { 'services/settings-schema.js': '  use_hand_conditional_sp_weight: {\n    label: "x" },\n' },
  6: { 'public/index.html': '<div>' + 'x'.repeat(50) + "innerHTML = '<span>' + s.edge_pct + '</span>'" + '</div>' },
};
const selfTest = cls => {
  const files = Object.keys(FIX[cls]);
  const s = FIX[cls];
  const c = {}; for (const f of files) c[f] = stripComments(s[f]);
  try { return D[cls]({ src: s, code: c, files }).length > 0; }
  catch (e) { return false; }
};

// ── run ─────────────────────────────────────────────────────────────────
const NAME = { 1: 'WRONG-CAUSE STRING', 2: 'WRITTEN NEVER READ', 3: 'PARALLEL IMPLEMENTATION',
               4: 'CONSUMER LOOSER THAN PRODUCER', 5: 'CANNOT EXECUTE OR FIRE', 6: 'MIXED MOMENTS' };
const EXEMPLAR = { 1: "'Lineup incomplete' for every suppression", 2: 'away_bullpen_woba written, no reader',
                   3: 'computeFramingRvPerGame in N files', 4: 'FRV 600-out writer vs >0 reader',
                   5: 'unreachable settings key', 6: 'emit-time badge beside live numbers' };
// Classes whose detector cannot measure the deciding property.
const CANDIDATES_ONLY = { 1: 'cannot measure branch arity', 3: 'cannot tell N callers from N copies',
                          4: 'proximity heuristic, not dataflow' };

const pass = {}, results = {};
for (const c of [1, 2, 3, 4, 5, 6]) {
  pass[c] = selfTest(c);
  results[c] = pass[c] ? D[c]({ src, code, files: ALL }) : [];
}

console.log('=== RECURRING-CLASS SWEEP ===');
console.log('  files ' + ALL.length + '   production ' + ALL.filter(isProd).length);
console.log('');
console.log('=== SELF-TEST: does each detector flag its own founding instance? ===');
for (const c of [1, 2, 3, 4, 5, 6])
  console.log('  class ' + c + '  ' + (pass[c] ? 'PASS' : 'FAIL') + '   ' + EXEMPLAR[c]
    + (pass[c] ? '' : '   <-- findings WITHHELD, detector is blind'));
console.log('');
console.log('  class                            PRICING  OPERATOR  ANALYSIS  total');
for (const c of [1, 2, 3, 4, 5, 6]) {
  if (!pass[c]) { console.log('  ' + (c + ' ' + NAME[c]).padEnd(34) + '  -- WITHHELD (self-test failed) --'); continue; }
  const r = results[c].map(x => ({ ...x, tier: tierOf((x.where || '').split(':')[0].split(' ')[0]) }));
  console.log('  ' + (c + ' ' + NAME[c]).padEnd(34)
    + String(r.filter(x => x.tier === 'PRICING').length).padStart(7)
    + String(r.filter(x => x.tier === 'OPERATOR').length).padStart(10)
    + String(r.filter(x => x.tier === 'ANALYSIS').length).padStart(10)
    + String(r.length).padStart(7)
    + (CANDIDATES_ONLY[c] ? '   CANDIDATES' : ''));
}
console.log('');
console.log('  CANDIDATES = needs human triage, not a defect count:');
for (const [c, why] of Object.entries(CANDIDATES_ONLY)) console.log('    class ' + c + ': ' + why);
console.log('');

for (const c of [2, 5, 6, 4, 1, 3]) {
  if (!pass[c]) continue;
  const r = results[c].map(x => ({ ...x, tier: tierOf((x.where || '').split(':')[0].split(' ')[0]) }))
    .sort((a, b) => ({ PRICING: 0, OPERATOR: 1, ANALYSIS: 2 })[a.tier] - ({ PRICING: 0, OPERATOR: 1, ANALYSIS: 2 })[b.tier]);
  if (!r.length) continue;
  console.log('--- CLASS ' + c + ': ' + NAME[c] + ' (' + r.length + ')'
    + (CANDIDATES_ONLY[c] ? '  [CANDIDATES -- triage required]' : '') + ' ---');
  for (const x of r.slice(0, 25)) console.log('  [' + x.tier.padEnd(8) + '] ' + x.where + '  ' + x.what);
  if (r.length > 25) console.log('  ... +' + (r.length - 25) + ' more');
  console.log('');
}
