#!/usr/bin/env node
/**
 * The api() 401 handler in public/index.html. (2026-08-27)
 *
 * WHY THIS EXISTS. The old handler prompted "Enter app password:", stored
 * the answer as x-app-password -- a header no server code has ever read --
 * and recursed without a bound. A rotated DB_DOWNLOAD_TOKEN therefore
 * produced an endless prompt for a credential that had never existed, and
 * the operator spent an afternoon hunting a password they had never set.
 *
 * A misattributed auth failure is worse than a bare one, because it sends
 * the reader after the wrong credential. So the naming is the behaviour
 * under test, not just the retry bound.
 *
 * HOW. The function is extracted from index.html by brace-matching and run
 * in a sandbox with stubbed fetch / prompt / localStorage / sessionStorage.
 * That keeps the test honest -- it exercises the shipped source rather than
 * a copy that can drift -- and it fails loudly if the function is renamed
 * or restructured, which is the point.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log('  FAIL: ' + label); } };
const eq = (a, b, label) => ok(a === b, label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

// ---- extract `async function api(...)` by brace matching ---------------
function extract(src, needle) {
  const start = src.indexOf(needle);
  if (start < 0) return null;
  // Match the PARAMETER LIST first. The naive version took the first `{`
  // after the name, which is the default value in `opts={}` -- it returned
  // a two-character body and the test reported the function had lost its
  // retry guard. A wrong test that fails is lucky; a wrong test that
  // passes is the real hazard.
  let i = src.indexOf("(", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  const open = src.indexOf("{", i);
  if (open < 0) return null;
  depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
}

const apiSrc = extract(html, 'async function api(');
if (!apiSrc) {
  console.log('  FAIL: could not find `async function api(` in public/index.html.');
  console.log('  If it was renamed, update this test -- do not delete it.');
  process.exit(1);
}
eq(/_retry/.test(apiSrc), true, 'api() still takes the retry guard');

// ---- sandbox ----------------------------------------------------------
function makeSandbox(responses) {
  const store = {};
  const prompts = [];
  let calls = 0;
  const mkStorage = () => {
    const m = {};
    return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); },
             removeItem: k => { delete m[k]; }, _raw: m };
  };
  const sandbox = {
    _appPassword: '',
    localStorage: mkStorage(),
    sessionStorage: mkStorage(),
    console,
    fetch: async (url, init) => {
      const r = responses[Math.min(calls, responses.length - 1)];
      calls++;
      store.lastHeaders = (init && init.headers) || {};
      return {
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        json: async () => { if (r.body === undefined) throw new Error('no body'); return r.body; },
      };
    },
    __api: null,
    window: { prompt: (msg, seed) => { prompts.push({ msg, seed }); return responses.promptAnswer; } },
  };
  sandbox.prompt = sandbox.window.prompt;
  vm.createContext(sandbox);
  vm.runInContext(apiSrc + '\nthis.__api = api;', sandbox);
  return { api: sandbox.__api, prompts, store, sandbox, calls: () => calls };
}

const ADMIN_401 = { status: 401, body: { error: 'unauthorized' } };
const OK_200 = { status: 200, body: { fine: true } };

// ---- 1. the regression: an admin-token 401 must NOT say "app password"
{
  const rs = [ADMIN_401, OK_200]; rs.promptAnswer = 'NEW-TOKEN-VALUE';
  const t = makeSandbox(rs);
  let threw = null;
  t.api('/games/2026-08-27/rerun', { method: 'POST' }).catch(e => { threw = e; });
  setTimeout(() => {
    eq(t.prompts.length, 1, 'admin 401 prompts exactly once');
    const msg = t.prompts[0] ? t.prompts[0].msg : '';
    ok(!/app password/i.test(msg) || /NOT an app password|no app password/i.test(msg),
       'the prompt does not ask for an app password');
    ok(/X-Admin-Token/i.test(msg), 'the prompt names the header actually being checked');
    ok(/DB_DOWNLOAD_TOKEN/.test(msg), 'the prompt names the env var it is compared against');
    ok(/admin token/i.test(msg), 'the prompt points at the "admin token" button');
    eq(t.sandbox.localStorage.getItem('mlb_admin_token'), 'NEW-TOKEN-VALUE',
       'the answer is stored as the ADMIN TOKEN, not as mlb_pwd');
    eq(t.sandbox.sessionStorage.getItem('mlb_pwd'), null,
       'nothing is written to the dead app-password store');
    finish();
  }, 30);
}

function finish() {
  // ---- 2. bounded retry: a second rejection stops, it does not re-prompt
  {
    const rs = [ADMIN_401, ADMIN_401]; rs.promptAnswer = 'STILL-WRONG';
    const t = makeSandbox(rs);
    t.api('/x', {}).then(
      () => { ok(false, 'a persistent 401 must reject, not resolve'); step3(t); },
      e => {
        eq(t.prompts.length, 1, 'a persistent 401 prompts ONCE, then gives up');
        ok(/still rejected/i.test(e.message), 'the final error says the token was still rejected');
        eq(e.status, 401, 'the final error carries the status');
        step3();
      });
  }
}

function step3() {
  // ---- 3. the bookmarklet gate is a different credential -- no prompt
  {
    const rs = [{ status: 401, body: { error: 'EXPIRED', code: 'EXPIRED' } }];
    rs.promptAnswer = 'should-not-be-asked';
    const t = makeSandbox(rs);
    t.api('/upload/bat-proj-lhp', {}).then(
      () => { ok(false, 'bookmarklet 401 must reject'); step4(); },
      e => {
        eq(t.prompts.length, 0, 'a bookmarklet 401 does NOT prompt for the admin token');
        ok(/bookmarklet/i.test(e.message), 'the error names the bookmarklet token');
        ok(/EXPIRED/.test(e.message), 'the error carries the server code');
        step4();
      });
  }
}

function step4() {
  // ---- 4. 503 is misconfiguration -- prompting would be the same bug
  {
    const rs = [{ status: 503, body: { error: 'Admin endpoint not configured (set DB_DOWNLOAD_TOKEN env var)' } }];
    rs.promptAnswer = 'should-not-be-asked';
    const t = makeSandbox(rs);
    t.api('/settings', { method: 'POST' }).then(
      () => { ok(false, '503 must reject'); step5(); },
      e => {
        eq(t.prompts.length, 0, 'a 503 does NOT prompt -- no typed value can fix an unset env var');
        ok(/not configured/i.test(e.message), 'the 503 surfaces the server message verbatim');
        eq(e.status, 503, '503 status is preserved');
        step5();
      });
  }
}

function step5() {
  // ---- 5. the happy path is untouched
  {
    const rs = [OK_200]; rs.promptAnswer = null;
    const t = makeSandbox(rs);
    t.api('/games/2026-08-27', {}).then(
      v => {
        eq(t.prompts.length, 0, 'a 200 never prompts');
        eq(v.fine, true, 'a 200 returns the parsed body');
        done();
      },
      e => { ok(false, 'a 200 must not reject: ' + e.message); done(); });
  }
}

function done() {
  // ---- 6. the stale-secret cleanup exists at module scope
  ok(/sessionStorage\.removeItem\('mlb_pwd'\)/.test(html),
     "the one-time 'mlb_pwd' cleanup is still present");
  ok(!/prompt\('Enter app password/.test(html),
     'the "Enter app password" prompt is gone from the file entirely');

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
