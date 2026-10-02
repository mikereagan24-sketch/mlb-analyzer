'use strict';

// Retry a network call on TRANSIENT failures only. (2026-10-02, #505)
//
// The 2026-07-23 score pull died on one `connect ETIMEDOUT` to statsapi and
// was never retried, which left five finished games unscored for ten weeks.
// This is the retry it did not have. Pure: no I/O of its own -- the caller
// passes the call, the sleep and the logging hook.
//
// TRANSIENT means "the same request might work in a minute":
//   - socket / DNS errors: ETIMEDOUT, ECONNRESET, ECONNREFUSED, EAI_AGAIN,
//     ENOTFOUND, EPIPE, socket hang up, node-fetch's own request timeout
//   - HTTP 5xx, and HTTP 429 (rate limited)
// NOT transient, never retried:
//   - any other HTTP 4xx (a bad URL or a refused request will not improve)
//   - anything else, e.g. a JSON parse error on a 200 body
// An HTTP failure is recognised by a numeric `err.status`, so the caller's
// fetch wrapper must set it (services/scraper.js fetchScoresRaw does).

const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
  'ESOCKETTIMEDOUT', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

function isTransient(err) {
  if (!err) return false;
  if (typeof err.status === 'number') return err.status === 429 || (err.status >= 500 && err.status <= 599);
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  if (err.type === 'request-timeout' || err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network timeout/i.test(err.message || '');
}

const defaultSleep = (ms) => new Promise(res => setTimeout(res, ms));

// fn: () => Promise. delaysMs: the wait before each RETRY, so attempts =
// delaysMs.length + 1. onRetry(attempt, attempts, err, delayMs) runs before
// each wait; onGiveUp(attempts, err) runs once when a transient failure
// survives the last attempt. A non-transient failure is rethrown at once,
// with neither hook called. The thrown error carries err.attempts.
async function retryTransient(fn, opts) {
  const o = opts || {};
  const delays = o.delaysMs || [];
  const attempts = delays.length + 1;
  const sleep = o.sleep || defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await fn();
      return { value, attempts: attempt };
    } catch (err) {
      if (err && typeof err === 'object') err.attempts = attempt;
      if (!isTransient(err)) throw err;
      if (attempt >= attempts) {
        if (o.onGiveUp) o.onGiveUp(attempts, err);
        throw err;
      }
      const delay = delays[attempt - 1];
      if (o.onRetry) o.onRetry(attempt, attempts, err, delay);
      await sleep(delay);
    }
  }
}

module.exports = { isTransient, retryTransient, TRANSIENT_CODES };
