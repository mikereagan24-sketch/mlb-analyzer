#!/bin/bash
# Refresh the local analysis copy of the database from production. (2026-08-24)
#
# WHY THIS EXISTS. On 2026-08-23 a full day of measurement ran against
# data/mlb.db without anyone noticing it had not been refreshed since
# 2026-08-06. The staleness was then reported as a production outage.
# Production was healthy the entire time. Two mistakes, one cause: there
# was no procedure for refreshing the copy and no check that said it was
# stale.
#
# THE COPY IS NOT A SUBSET OF PRODUCTION. Measured on 2026-08-24, the two
# databases disagreed on temp_f for 1586 of 1678 shared games and on
# model_total for 1595, because a weather-hour correction backfilled on
# production around 2026-07-30 never reached the copy, and because local
# re-runs re-scored games with different inputs. Median model_total
# disagreement was 0.33 runs. Overwriting in EITHER direction destroys
# real work, so this script never overwrites in place:
#
#   1. download production to a DATED file, never straight onto mlb.db
#   2. integrity-check it before it is allowed near the working copy
#   3. compare freshness both ways and refuse on a MIXED verdict
#   4. back up the current copy under a dated name
#   5. promote, then RE-APPLY the local-only remediation
#
# Step 5 is the part that is easy to forget. Everything the remediation
# scripts write is local-only -- production has the schema but not the
# data -- so a refresh silently reverts all of it unless they are re-run.
# They are all dry-run-by-default and idempotent, which is what makes
# this safe to repeat.
#
# THE ADMIN TOKEN IS READ FROM THE ENVIRONMENT, deliberately. The older
# scripts/../refresh-db.sh has it hardcoded and committed; that is a live
# credential in version control and should be rotated in the Render
# dashboard. Do not copy the pattern here.
#
#   export MLB_ADMIN_TOKEN=...
#   bash scripts/refresh-analysis-db.sh              # download + compare only
#   bash scripts/refresh-analysis-db.sh --promote    # ...and promote + re-apply

set -euo pipefail
cd "$(dirname "$0")/.."

NODE="${NODE_BIN:-node}"
HOST="${MLB_HOST:-https://mlb-analyzer.onrender.com}"
STAMP="$(date +%Y%m%d)"
SNAP="data/mlb.db.prod-${STAMP}"
PROMOTE=0
[ "${1:-}" = "--promote" ] && PROMOTE=1

if [ -z "${MLB_ADMIN_TOKEN:-}" ]; then
  echo "MLB_ADMIN_TOKEN is not set. export it first; it is not stored here." >&2
  exit 2
fi

echo "=== 1/5 downloading production -> ${SNAP} ==="
curl -sS -f --max-time 1800 -H "X-Admin-Token: ${MLB_ADMIN_TOKEN}" \
  -o "${SNAP}" -w 'http=%{http_code} bytes=%{size_download} time=%{time_total}s\n' \
  "${HOST}/api/admin/download-db"

echo "=== 2/5 integrity check (a truncated download must never reach mlb.db) ==="
"$NODE" -e '
const Database = require("better-sqlite3");
const d = new Database(process.argv[1], { readonly: true });
const qc = d.prepare("PRAGMA quick_check").get();
if (!qc || qc.quick_check !== "ok") { console.error("quick_check FAILED:", qc); process.exit(1); }
const g = d.prepare("SELECT COUNT(*) c FROM game_log").get().c;
const b = d.prepare("SELECT COUNT(*) c FROM bet_signals WHERE bet_locked_at IS NOT NULL").get().c;
if (g < 1000) { console.error("game_log only " + g + " rows -- refusing"); process.exit(1); }
console.log("  quick_check ok   game_log=" + g + "   logged bets=" + b);
' "${SNAP}"

echo "=== 3/5 freshness comparison ==="
set +e
"$NODE" scripts/pipeline-freshness.js --compare "${SNAP}"
set -e

if [ "${PROMOTE}" -ne 1 ]; then
  echo ""
  echo "Download and comparison only. Re-run with --promote to replace the working copy."
  echo "Read the verdict above first: on MIXED, the copies have diverged and promoting"
  echo "will lose whatever is newer here."
  exit 0
fi

echo "=== 4/5 backing up the current copy (this is the undo) ==="
cp data/mlb.db "data/mlb.db.local-pre-refresh-${STAMP}"
ls -l "data/mlb.db.local-pre-refresh-${STAMP}"
cp "${SNAP}" data/mlb.db

echo "=== 5/5 re-applying local-only remediation ==="
# ORDER IS LOAD-BEARING, and getting it wrong fails quietly rather than
# loudly. Two dependencies:
#
#   first-pitch timestamps  ->  tag-post-start-pricing
#       the tagging criterion IS the first-pitch comparison; with no
#       timestamps it tags nothing and reports success.
#
#   bet-price migration     ->  regrade-stale-totals-pnl
#       the re-grade prices each bet at what was struck, which lives in
#       bet_price. Run before the migration it finds 0 stale rows and
#       reports "23 rows still disagreeing" -- which is what happened on
#       the first run of this sequence on 2026-08-24. Run after, it
#       re-grades 11 rows for a net +56.78 and verification reaches 0.
#
# fix-corrupt-totals-rows handles the 2 rows the migration REFUSES
# (price-shaped bet_line with no usable market_line), so it follows it.
"$NODE" scripts/backfill-first-pitch.js
"$NODE" scripts/tag-post-start-pricing.js --apply
"$NODE" scripts/backfill-pitcher-debut.js --apply
"$NODE" scripts/backfill-totals-bet-price.js --apply
"$NODE" scripts/fix-corrupt-totals-rows.js --apply
"$NODE" scripts/null-fabricated-totals-closing.js --apply
"$NODE" scripts/rederive-ml-closing-lines.js --apply
"$NODE" scripts/regrade-stale-totals-pnl.js --apply

echo ""
echo "=== final freshness ==="
"$NODE" scripts/pipeline-freshness.js || true
echo ""
echo "Undo: cp data/mlb.db.local-pre-refresh-${STAMP} data/mlb.db"
