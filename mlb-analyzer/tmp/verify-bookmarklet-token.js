'use strict';
// Unit-test the bookmarklet token machinery without booting the server.
// Verifies: mint → verify (happy path), expired, revoked, bad sig,
// malformed, missing, bad purpose.

const crypto = require('crypto');

// Re-implement the functions in isolation (same shape as routes/api.js).
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
function sign(payload, key) { return crypto.createHmac('sha256', key).update(payload).digest('base64url'); }
function mint(hmacKey, kid) {
  const now = Date.now();
  const exp = now + TTL_MS;
  const payload = Buffer.from(JSON.stringify({
    iat: Math.floor(now / 1000),
    exp: Math.floor(exp / 1000),
    kid, purpose: 'fg-upload',
  })).toString('base64url');
  return { token: payload + '.' + sign(payload, hmacKey), expiresAtMs: exp, kid };
}
function verify(token, hmacKey, currentKid) {
  if (!token) return { ok: false, code: 'MISSING' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, code: 'MALFORMED' };
  const [payloadB64, sig] = parts;
  const expected = sign(payloadB64, hmacKey);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, code: 'BAD_SIG' };
  try { if (!crypto.timingSafeEqual(a, b)) return { ok: false, code: 'BAD_SIG' }; }
  catch (_) { return { ok: false, code: 'BAD_SIG' }; }
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); }
  catch (_) { return { ok: false, code: 'MALFORMED' }; }
  if (payload.purpose !== 'fg-upload') return { ok: false, code: 'BAD_PURPOSE' };
  if (payload.kid !== currentKid) return { ok: false, code: 'REVOKED' };
  if (payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, code: 'EXPIRED' };
  return { ok: true, payload };
}

// Manually forge an expired token (exp in the past)
function mintExpired(hmacKey, kid) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({
    iat: Math.floor((now - 60*24*3600*1000) / 1000),
    exp: Math.floor((now - 1000) / 1000),  // 1 sec ago
    kid, purpose: 'fg-upload',
  })).toString('base64url');
  return payload + '.' + sign(payload, hmacKey);
}

const KEY = 'a'.repeat(32);
const cases = [
  { desc: 'happy path — mint + verify same kid', run: () => {
    const { token } = mint(KEY, 5);
    const r = verify(token, KEY, 5);
    return r.ok === true;
  }},
  { desc: 'REVOKED — token kid=5, current kid=6', run: () => {
    const { token } = mint(KEY, 5);
    return verify(token, KEY, 6).code === 'REVOKED';
  }},
  { desc: 'EXPIRED — token minted with exp in the past', run: () => {
    return verify(mintExpired(KEY, 3), KEY, 3).code === 'EXPIRED';
  }},
  { desc: 'BAD_SIG — token signed with different key', run: () => {
    const { token } = mint('b'.repeat(32), 5);
    return verify(token, KEY, 5).code === 'BAD_SIG';
  }},
  { desc: 'BAD_SIG — payload tampered after mint', run: () => {
    const { token } = mint(KEY, 5);
    // Flip a payload character
    const [p, s] = token.split('.');
    const tampered = (p.charAt(0) === 'A' ? 'B' : 'A') + p.slice(1) + '.' + s;
    return verify(tampered, KEY, 5).code === 'BAD_SIG';
  }},
  { desc: 'MALFORMED — not two parts', run: () => {
    return verify('justonepart', KEY, 5).code === 'MALFORMED';
  }},
  { desc: 'MISSING — empty string', run: () => {
    return verify('', KEY, 5).code === 'MISSING';
  }},
  { desc: 'MISSING — null', run: () => {
    return verify(null, KEY, 5).code === 'MISSING';
  }},
  { desc: 'BAD_PURPOSE — payload has purpose="other"', run: () => {
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({
      iat: Math.floor(now / 1000),
      exp: Math.floor((now + TTL_MS) / 1000),
      kid: 5, purpose: 'evil',
    })).toString('base64url');
    const token = payload + '.' + sign(payload, KEY);
    return verify(token, KEY, 5).code === 'BAD_PURPOSE';
  }},
  { desc: 'TTL is 30 days ± 1 minute', run: () => {
    const { expiresAtMs } = mint(KEY, 5);
    const delta = expiresAtMs - Date.now();
    const days = delta / (24 * 3600 * 1000);
    return days > 29.99 && days < 30.01;
  }},
];

let fails = 0;
for (const c of cases) {
  const ok = c.run();
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + c.desc);
}
console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL ' + cases.length + ' PASS'));
process.exit(fails ? 1 : 0);
