/**
 * Which leg of a doubleheader is this game_id? (2026-08-30)
 *
 * ONE COPY, because this regex has already shipped broken once. On
 * 2026-08-29 it went out as /-g(d+)$/ -- the backslash eaten in transit --
 * which matches a literal "d", never fires, and makes the whole same-day
 * availability rule silently inert. That failure looks exactly like a
 * feature that does nothing, which is the hardest kind to notice.
 *
 * It is now needed in three places (the model's bullpen lookup, the
 * lineup-job capture, and the bullpen report), and three hand-written
 * copies of a regex that has been wrong once is not a risk worth taking.
 *
 * The lineup job assigns the suffix: `bos-nyy` is leg 1, `bos-nyy-g2` is
 * leg 2. A game with no suffix is leg 1, not "unknown" -- an ordinary game
 * is the first and only game of its matchup that day.
 */
function legOf(gameId) {
  const m = String(gameId || '').match(/-g(\d+)$/);
  if (!m) return 1;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// True when this game is a nightcap, i.e. something was played earlier
// today by the same clubs. The availability rule is gated on this so it
// stays inert for the ~99% of games that are not doubleheaders.
const isNightcap = gameId => legOf(gameId) > 1;

module.exports = { legOf, isNightcap };
