#!/usr/bin/env node
/**
 * Rank Class-3 duplicate candidates by risk, not by count. (2026-09-03)
 *
 * 141 candidates is too many to triage by hand, and a flat list buries the
 * two that matter. Both known instances -- nine copies of
 * computeFramingRvPerGame, six behaviours mirrored in the bullpen report
 * with four already drifted -- were found by SYMPTOM, not by search. So
 * the ranking is the product, not the inventory.
 *
 * RISK = DRIFT x BLAST RADIUS.
 *
 *   DRIFT   how far the copies have ALREADY diverged. Identical copies are
 *           a maintenance smell; diverged copies are a live bug, because
 *           one of them is already wrong. Measured as token-set distance
 *           between the largest and smallest copy, so a copy that gained
 *           or lost a rule scores high.
 *
 *   RADIUS  whether any copy sits on the pricing path. A helper duplicated
 *           across three one-shot scripts cannot misprice anything.
 *
 * A pair that is byte-identical scores 0 drift and sinks, which is correct:
 * the bullpen report was dangerous because its copy had lost four
 * behaviours, not because a copy existed.
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
    else if (/\.js$/.test(e.name)) out.push(path.relative(R, p).replace(/\\/g, '/'));
  }
  return out;
};
const ALL = walk(R);
const src = {};
for (const f of ALL) { try { src[f] = fs.readFileSync(path.join(R, f), 'utf8'); } catch (e) {} }

const isProd = f => !f.startsWith('scripts/') && !f.startsWith('tmp/');
const PRICING = f => /^(services\/(model|jobs)\.js|db\/schema\.js|utils\/)/.test(f)
  || (isProd(f) && /^services\//.test(f));

// Extract a function body by brace matching from its declaration.
function bodyOf(text, startIdx) {
  const open = text.indexOf('{', startIdx);
  if (open < 0) return '';
  let d = 0;
  for (let i = open; i < text.length && i < open + 20000; i++) {
    if (text[i] === '{') d++;
    else if (text[i] === '}') { d--; if (d === 0) return text.slice(open, i + 1); }
  }
  return '';
}
// Normalise: drop comments, whitespace, string contents -- so cosmetic
// differences do not read as drift, but a missing rule does.
function tokens(body) {
  const t = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/(['"`])(?:(?!\1)[\s\S])*\1/g, '"S"')
    .replace(/\s+/g, ' ');
  return new Set(t.match(/[A-Za-z_$][\w$]*|[<>=!+\-*/%?:]+/g) || []);
}
const jaccard = (a, b) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 1 : inter / uni;
};

// Collect same-named function definitions.
const defs = {};
for (const f of ALL) {
  const t = src[f];
  for (const m of t.matchAll(/(?:^|\n)\s*(?:async\s+)?function ([A-Za-z_$][\w$]*)\s*\(/g)) {
    const body = bodyOf(t, m.index);
    if (body.length < 60) continue;
    (defs[m[1]] = defs[m[1]] || []).push({ file: f, body, len: body.length });
  }
}

const rows = [];
for (const [name, copies] of Object.entries(defs)) {
  if (copies.length < 2 || name.length < 6) continue;
  const toks = copies.map(c => tokens(c.body));
  let minSim = 1;
  for (let i = 0; i < toks.length; i++)
    for (let j = i + 1; j < toks.length; j++)
      minSim = Math.min(minSim, jaccard(toks[i], toks[j]));
  const drift = 1 - minSim;
  const prodCopies = copies.filter(c => isProd(c.file));
  const pricingCopies = copies.filter(c => PRICING(c.file));
  // Risk: drift matters most, doubled when a copy can misprice.
  const radius = pricingCopies.length ? 2 : (prodCopies.length > 1 ? 1 : 0.3);
  // THE INTERESTING BAND IS THE MIDDLE, and the first version got this
  // backwards by ranking raw drift.
  //
  //   ~0%    identical copies -- a maintenance smell, not a live bug
  //   20-60% THE DANGER ZONE: one rule, copied, and already diverged.
  //          isHighlightedSignal sits here: four copies across four
  //          backtest harnesses, 32% apart, so the four are measuring
  //          different populations.
  //          COUNT REVISED 2026-09-04: six, not four. The scanner only
  //          sees services/*.js, so it missed two in public/index.html --
  //          signalMeetsHighlightThreshold, plus an inline copy inside
  //          renderGameResult's vd(). The vd() copy has since been folded
  //          into signalMeetsHighlightThreshold, leaving FIVE: the four
  //          harnesses (settings-driven, ui_highlight_* from app_settings)
  //          and the client (hardcoded 2.0/4.5/7.0). Those two families
  //          agree today -- 0.02/0.045/0.07/overs-false -- so nothing is
  //          drifting yet, but an operator changing a setting would move
  //          the backtests and not the UI. Unifying them is the remaining
  //          consolidation and is NOT done: it changes the published
  //          population of every result the harnesses have produced.
  //   >75%   almost certainly UNRELATED functions sharing a common name.
  //          projectAgg scored 93% and is two different functions -- one
  //          projects CLV stats, the other projects buckets.
  //
  // So score peaks at ~40% drift and falls off both ways.
  const band = drift <= 0.4 ? (drift / 0.4) : Math.max(0, (0.9 - drift) / 0.5);
  rows.push({
    name, n: copies.length, drift, radius, band, risk: band * radius,
    prod: prodCopies.length, pricing: pricingCopies.length,
    files: copies.map(c => c.file),
    sizes: copies.map(c => c.len),
  });
}
rows.sort((a, b) => b.risk - a.risk);

console.log('=== CLASS 3 RANKED BY RISK (drift x blast radius) ===');
console.log('  duplicate-name groups: ' + rows.length);
console.log('');
console.log('  risk  drift  copies  pricing  name');
for (const r of rows.slice(0, 20)) {
  console.log('  ' + r.risk.toFixed(2).padStart(4)
    + '  ' + (r.drift * 100).toFixed(0).padStart(4) + '%'
    + String(r.n).padStart(8)
    + String(r.pricing).padStart(9)
    + '  ' + r.name);
}
console.log('');
console.log('=== TOP 8, WITH LOCATIONS ===');
for (const r of rows.slice(0, 8)) {
  console.log('');
  console.log('  ' + r.name + '()   risk ' + r.risk.toFixed(2)
    + '   drift ' + (r.drift * 100).toFixed(0) + '%'
    + '   ' + r.n + ' copies (' + r.pricing + ' on the pricing path)');
  r.files.forEach((f, i) => {
    console.log('      ' + (PRICING(f) ? 'PRICING ' : isProd(f) ? 'prod    ' : 'analysis')
      + '  ' + f + '  (' + r.sizes[i] + ' chars)');
  });
  if (r.drift > 0.25) {
    console.log('      -> bodies differ by ' + (r.drift * 100).toFixed(0)
      + '% of tokens. One of these has gained or lost a rule.');
  } else if (r.drift < 0.02) {
    console.log('      -> effectively identical: a maintenance smell, not a live bug.');
  }
}
console.log('');
console.log('  Identical copies score 0 and sink, deliberately. The bullpen report');
console.log('  was dangerous because its copy had LOST four behaviours -- drift is');
console.log('  the signal, duplication alone is not.');
