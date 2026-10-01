'use strict';

// The X-Admin-Token gate, ONE implementation (moved verbatim from routes/api.js
// on 2026-10-01 so a router outside routes/api.js -- the top-traders seed
// upload, routes/top-traders-upload.js -- can use the same gate without
// importing routes/api.js, which sits in the pricing path's require graph).
// routes/api.js imports it from here; nothing else defines it.
//
// Shared admin-token middleware. Originally extracted from the
// /admin/download-db handler (which had the only auth in the file);
// any write endpoint that needs the same gate uses this — single
// implementation, no risk of two copies drifting apart.
//
// Behavior is verbatim from the original handler:
//   - Reads expected token from process.env.DB_DOWNLOAD_TOKEN. If the
//     env var is unset, returns 503 — a forgotten config can never
//     leave a write endpoint silently open. (We reuse the existing
//     env var rather than introducing a new one; same secret gates
//     the DB pull and any admin writes.)
//   - Reads the candidate token from the X-Admin-Token header.
//   - Length-checks first, then constant-time compares via
//     crypto.timingSafeEqual. The length check is observable but only
//     leaks the LENGTH of a randomly-generated token, which is fine.
//   - Logs every attempt with timestamp + ip + request path + result,
//     so production logs show successful, failed, and misconfigured
//     attempts (greppable: '[admin-auth]').
//   - Returns 401 on token mismatch, calls next() on success.

const crypto = require('crypto');

function requireAdminToken(req, res, next) {
  const stamp = new Date().toISOString();
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const expected = process.env.DB_DOWNLOAD_TOKEN;
  if (!expected) {
    console.log('[admin-auth] ' + stamp + ' ip=' + ip + ' path=' + req.path
      + ' result=missing-token-config');
    return res.status(503).json({
      error: 'Admin endpoint not configured (set DB_DOWNLOAD_TOKEN env var)',
    });
  }
  const provided = req.get('X-Admin-Token') || '';
  // Constant-time comparison so a length-mismatch or first-byte diff
  // doesn't leak via response timing. timingSafeEqual requires equal
  // lengths, so we length-check first; the length-check itself is
  // observable but only leaks the *length* of the expected token, which
  // is randomly generated and not sensitive.
  let ok = false;
  if (provided.length === expected.length) {
    try {
      ok = crypto.timingSafeEqual(
        Buffer.from(provided, 'utf8'),
        Buffer.from(expected, 'utf8')
      );
    } catch (e) { ok = false; }
  }
  if (!ok) {
    console.log('[admin-auth] ' + stamp + ' ip=' + ip + ' path=' + req.path
      + ' result=auth-fail');
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

module.exports = { requireAdminToken };
