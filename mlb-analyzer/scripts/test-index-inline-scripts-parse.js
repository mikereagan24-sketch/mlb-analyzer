#!/usr/bin/env node
'use strict';
/**
 * Every inline <script> in public/index.html COMPILES. (2026-09-29)
 *
 * WHAT HAPPENED. #477 added a card tooltip,
 *   title="today's inputs give a different value than the one priced"
 * inside a single-quoted JavaScript string in the page's main script. The
 * apostrophe ended the string, the main script failed to parse, and the whole
 * front end -- tabs, game cards, buttons -- was dead in production from that
 * deploy on. The API was unaffected, so every API check stayed green, and
 * every UI test in the suite reads index.html as TEXT, so none of them ever
 * asked whether the script parses.
 *
 * This compiles each inline script with vm.Script -- a parse, never an
 * execution -- and fails with the script's number, its line in index.html and
 * the parser's message. `src=` scripts are skipped (not inline), as are
 * non-JavaScript types (JSON, templates). A type="module" script is reported
 * as a failure rather than skipped, so a module added later cannot pass
 * unchecked: vm.Script cannot compile import/export.
 *
 *   node scripts/test-index-inline-scripts-parse.js [path/to/index.html]
 *
 * The optional path is how the fix was proven both ways: the check FAILS on
 * the pre-fix index.html and PASSES on the fixed one.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || path.join(__dirname, '..', 'public', 'index.html');

const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']);

// -> [{ n, line, status: 'ok' | 'skipped' | 'error', why }]
function checkInlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m, n = 0;
  while ((m = re.exec(html))) {
    n++;
    const attrs = m[1] || '';
    const line = html.slice(0, m.index).split('\n').length;
    if (/\bsrc\s*=/i.test(attrs)) { out.push({ n, line, status: 'skipped', why: 'src= (not inline)' }); continue; }
    const tm = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    const type = tm ? tm[1].toLowerCase() : '';
    if (type === 'module') { out.push({ n, line, status: 'error', why: 'type="module" cannot be compiled by this check -- extend it' }); continue; }
    if (!JS_TYPES.has(type)) { out.push({ n, line, status: 'skipped', why: 'type="' + type + '" is not JavaScript' }); continue; }
    try {
      new vm.Script(m[2], { filename: 'index.html#script' + n });
      out.push({ n, line, status: 'ok', why: m[2].length + ' chars' });
    } catch (e) {
      // e.stack names the offending line WITHIN the script; turn that into an
      // index.html line so the failure points at the source.
      const at = (String(e.stack || '').match(/#script\d+:(\d+)/) || [])[1];
      const htmlLine = at ? line + Number(at) - 1 : null;
      out.push({ n, line, status: 'error', why: e.name + ': ' + e.message + (htmlLine ? ' (index.html line ' + htmlLine + ')' : '') });
    }
  }
  return out;
}

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}

console.log('inline <script> blocks in ' + target);
const res = checkInlineScripts(fs.readFileSync(target, 'utf8'));
const inline = res.filter(r => r.status !== 'skipped');
for (const r of res) {
  if (r.status === 'skipped') console.log('  ----  script ' + r.n + ' (line ' + r.line + ') skipped: ' + r.why);
  else ok('script ' + r.n + ' (line ' + r.line + ') compiles', r.status === 'ok', r.why);
}
ok('at least one inline script was checked (sanity: the extractor found the page)', inline.length > 0, inline.length + ' checked');

console.log('\nSELF-TESTS');
const planted = checkInlineScripts([
  '<script src="/x.js"></script>',
  '<script>var ok = 1;</script>',
  "<script>var t = '<span title=\"today's\">';</script>",
  '<script type="application/json">{"not": "js"</script>',
  '<script>// a comment mentioning <script> is not a tag\nvar z = 2;</script>',
].join('\n'));
ok('a planted broken string is caught, with its script number',
  planted.filter(r => r.status === 'error').length === 1 && planted[2].status === 'error' && planted[2].n === 3,
  planted.map(r => r.n + ':' + r.status).join(' '));
ok('valid scripts pass; src= and non-JS types are skipped',
  planted[0].status === 'skipped' && planted[1].status === 'ok' && planted[3].status === 'skipped' && planted[4].status === 'ok');
ok('a type="module" script fails loudly instead of being skipped',
  checkInlineScripts('<script type="module">import x from "y";</script>')[0].status === 'error');

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
