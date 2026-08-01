# Signed short-lived bookmarklet token — design (option 2 follow-up)

**Status**: design only, not built. Owner requested (2026-08-02) the design
before implementation, specifically wanting: how the token refreshes, and
what happens when it expires mid-sync.

**Motivation**: PR #214 ships an Origin allowlist on `/upload/*` as a
bar-raiser. The allowlist rejects random cross-origin browser POSTs but
does NOT prevent a determined attacker with a Node/curl client sending
a forged `Origin: https://www.fangraphs.com` header. This design
replaces the allowlist with a real cryptographic gate.

## Threat model

Assets protected:
- `woba_data` table (batter/pitcher wOBA — the model's core input)
- `pitcher_role_override` (roles derived from RosterResource)
- `pit_proj_ip` (starter IP projections)

Attacker capability assumed:
- Can send arbitrary HTTP requests to `mlb-analyzer.onrender.com/api/upload/*`
- Can forge any HTTP header including Origin
- Cannot compromise the owner's browser session
- Cannot access `DB_DOWNLOAD_TOKEN` on the Render environment

Attack scenarios blocked:
- Adversarial CSV upload overwrites wOBA with attacker-controlled values,
  moving downstream signals in attacker's preferred direction
- Bulk data enumeration via crafted keys

## Design

### Token issuance

New endpoint (gated by `requireAdminToken` — owner-only):

```
POST /admin/bookmarklet/mint
→ { token, expires_at, bookmarklet_source }
```

- `token`: HMAC-SHA256 over `(iat, exp, purpose='fg-upload', kid)` using
  `BOOKMARKLET_HMAC_KEY` env var. Encoded as `<b64_payload>.<b64_sig>`.
- `exp`: `iat + 12 hours` (design choice — see "TTL rationale" below).
- `kid`: token generation id, incremented on each mint so old tokens
  can be revoked by simply minting a new one.
- `bookmarklet_source`: the full bookmarklet JS with the token baked
  in as `const TOKEN = "..."`. Owner drags this to their bookmarks
  bar, replacing the previous bookmarklet.

The current active `kid` is stored in `app_settings`
(`bookmarklet_active_kid`). Any token with `kid !== active_kid` is
rejected, giving instant revocation without a token blocklist.

### Token verification

New middleware on `/upload/*`:

```
function requireBookmarkletToken(req, res, next) {
  const token = req.get('X-Bookmarklet-Token') || '';
  const parsed = parseJWT(token);
  if (!parsed) return res.status(401).json({error: 'missing/malformed token'});
  if (parsed.exp < Date.now()/1000) return res.status(401).json({error: 'expired', code: 'TOKEN_EXPIRED'});
  if (parsed.kid !== currentActiveKid()) return res.status(401).json({error: 'revoked', code: 'TOKEN_REVOKED'});
  const expectedSig = hmac(parsed.header + '.' + parsed.payload, HMAC_KEY);
  if (!timingSafeEqual(parsed.sig, expectedSig)) return res.status(401).json({error: 'bad signature'});
  return next();
}
```

Replaces `requireOriginAllowlist` on `/upload/fg-json/:key`,
`/upload/rr-roles`, `/upload/:key`. NOT on `/upload/pit-proj-ip` —
that's a UI drop-zone from the owner's authenticated app session, so
it can stay on the admin-token path (needs a UI wiring change but not
in scope of this design).

### TTL — 12 hours

Rationale:
- 12h covers a full FG Daily Sync cycle including retries + owner
  vacation-day buffer. The bookmarklet's sync takes ~2 minutes; even
  a very unlucky operator-morning takes ≤1 hour.
- Long enough that daily re-minting isn't required (the owner mints
  once a day at most, usually less).
- Short enough that a leaked token can't be exploited for weeks. If
  the bookmark is stolen from the owner's browser export, the attacker
  has 12h max, and any refresh mints a new `kid` that invalidates the
  stolen one.

Alternative considered — 24h TTL: doubles the exploit window without
appreciable ergonomic benefit given daily rotation is trivial.

Alternative considered — 7-day TTL: too long. If the bookmark is
extracted from a browser backup or `chrome://bookmarks`, a week of
exploitability.

### Mid-sync expiration handling

**The scenario**: token expires at 12:00 PM; owner clicks the
bookmarklet at 11:58 AM; the sync takes 4 minutes; the 5th /upload
POST fires at 12:02 PM with an expired token. What happens?

**Option A (chosen): individual POSTs each check TTL, fail their own
uploads with a distinguishable error code, and the bookmarklet's
finalize step calls a re-mint endpoint that returns a fresh token —
BUT the bookmarklet can't call the re-mint endpoint without owner
auth (which it doesn't have). So the sync fails partially, the
overlay shows the specific failure, and owner re-mints.**

Concrete flow:
- Uploads 1-4 succeed with tokens dated 12:00
- Upload 5 gets `{code: 'TOKEN_EXPIRED', error: 'expired'}` on POST
- Bookmarklet overlay: `actuals: 2/4 uploaded (2 err: token expired)`
- Owner sees, clicks "Refresh bookmarklet" button in app UI (which
  hits `POST /admin/bookmarklet/mint` with admin token), gets fresh
  bookmarklet, re-drags to bookmarks bar, re-clicks — remaining 2
  succeed.

Option B (rejected): auto-refresh. The bookmarklet detects
`TOKEN_EXPIRED` and tries to POST to `/admin/bookmarklet/mint` from
fangraphs.com. Rejected because that endpoint requires
`requireAdminToken` from mlb-analyzer's localStorage, which
fangraphs.com origin cannot access. Auto-refresh would require
loosening admin-token semantics — worse than the problem it solves.

Option C (rejected): sliding window. Extend TTL if the token is used.
Rejected — makes the token effectively long-lived after any recent
use, defeating the point of a short TTL.

**Implication for the retry pattern in `runFangraphsWobaSyncJob`**:
retries with 15/30 min backoffs can span the token boundary. The
job's ok/err summary already handles per-upload failure states cleanly
(each POST failure is per-key; partial success lands what did
succeed). The `TOKEN_EXPIRED` error propagates the same as any other
per-upload failure — no special handling needed at the cron level.
The freshness escalation in /health still surfaces staleness if
enough uploads fail.

### Revocation

Owner clicks "Rotate bookmarklet token" in app UI:
- App calls `POST /admin/bookmarklet/rotate` (admin-token-gated)
- New `kid` written to `app_settings`, mint returns new bookmarklet
- All prior-kid tokens now rejected

Use cases:
- Bookmark accidentally leaked (browser sync to another device,
  screenshot, etc.)
- Regular hygiene rotation

Cost: owner has to re-drag the bookmark to the bookmarks bar after
every rotation. Documented ergonomic tradeoff.

### What NOT in scope

- CSRF protection: token IS the CSRF check for this endpoint.
- Per-key permissions: current design lets any valid token upload to
  any key. If we later want per-key rate limits or content-signature
  validation, that's additive.
- Deleting `requireOriginAllowlist`: keep both middlewares. Origin
  allowlist rejects clearly-wrong origins BEFORE token verification
  even runs, saving HMAC compute on obviously-bad requests. Two-layer
  defense.

## Implementation checklist (when built)

- [ ] Env var `BOOKMARKLET_HMAC_KEY` — 32-byte random, stored in Render env
- [ ] `POST /admin/bookmarklet/mint` — returns bookmarklet source
- [ ] `POST /admin/bookmarklet/rotate` — bumps `bookmarklet_active_kid`
- [ ] `requireBookmarkletToken` middleware in routes/api.js
- [ ] Migrate `/upload/fg-json/:key`, `/upload/rr-roles`, `/upload/:key?`
      from `requireOriginAllowlist` to `[requireOriginAllowlist,
      requireBookmarkletToken]` — keep Origin as fast-reject
- [ ] `/upload/pit-proj-ip` stays on Origin-only OR switches to admin
      token (UI-only path — owner picks)
- [ ] UI: "Rotate bookmarklet token" button on model tab, next to
      the existing fangraphs_session_cookie field
- [ ] UI: "Copy bookmarklet" button that hits `/admin/bookmarklet/mint`
      and gives owner a fresh javascript: URL to drag
- [ ] Bookmarklet source template: token baked in via string
      substitution before serving from `/admin/bookmarklet/mint`
- [ ] Overlay: on `TOKEN_EXPIRED` code, show "token expired — click
      Refresh Bookmarklet in the app then retry" so the owner
      doesn't have to guess

## Open questions for owner

1. **12h TTL OK?** If you'd prefer 6h (tighter security) or 24h (less
   friction), it's a one-line change.
2. **Rotate cadence**: manual only, or add a monthly auto-rotate cron?
   Auto-rotate means one morning per month you'd need to re-drag the
   bookmark.
3. **Also gate `/upload/pit-proj-ip`?** It's UI-only, so it can use
   the admin token like other UI writes. Or leave it Origin-only if
   you prefer symmetry with the other uploads.
4. **UI location for the "Rotate bookmarklet" button?** Model tab
   next to the FG cookie field is my default; anywhere else feels
   natural?
