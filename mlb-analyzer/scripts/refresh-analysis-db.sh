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
#   export DB_DOWNLOAD_TOKEN=...      # or MLB_ADMIN_TOKEN (older name)
#   bash scripts/refresh-analysis-db.sh              # download + compare only
#   bash scripts/refresh-analysis-db.sh --promote    # ...and promote + re-apply

set -euo pipefail
cd "$(dirname "$0")/.."

# ── PICK THE NODE THAT CAN ACTUALLY OPEN THE DATABASE ────────────────
#
# This was NODE="${NODE_BIN:-node}", i.e. whatever PATH resolved to. On
# 2026-09-13 PATH resolved to Node 24 (v24.18.0, outside nvm), the step-2
# integrity check died on better-sqlite3 NODE_MODULE_VERSION 115 vs 137,
# and `set -euo pipefail` aborted the whole script -- AFTER the 560MB
# download and BEFORE the step-4 backup and step-5 promote. The refresh
# looked like it had run; the working copy was untouched, and a day of
# measurement nearly went out against stale data.
#
# THE GATE IS "CAN IT OPEN A DATABASE", NOT A VERSION STRING. A pin can
# be stale, a major can be right and the build still wrong (a rebuilt
# native module, a different arch). The only thing this script needs is a
# node that can require better-sqlite3, so that is what is checked -- and
# it is checked BEFORE the download, so a version problem costs seconds
# instead of aborting mid-refresh.
#
# AND THE PROBE CONSTRUCTS A DATABASE, because require() ALONE IS NOT
# ENOUGH. Measured 2026-09-14: `node -e "require('better-sqlite3')"`
# exits 0 on Node v24.18.0 -- the package loads its JS wrapper and only
# binds the native .node file when a Database is constructed. A require
# probe would therefore have selected the exact Node that broke the
# 09-13 refresh. new Database(":memory:") forces the binding, needs no
# file, and costs milliseconds: it FAILS on v24.18.0 and PASSES on
# v20.20.2, which is the discrimination this resolver exists for.
#
# Resolution order:
#   1. $NODE_BIN if set -- the explicit escape hatch, still honoured
#   2. the exact version in .node-version, under the nvm layout
#   3. the newest installed node with the SAME MAJOR as .node-version
#      (warned, because the pin is then not what is running)
#   4. PATH node -- last, not first, and only if it passes the gate
ABI_PROBE='new (require("better-sqlite3"))(":memory:").close()'
NODE_VERSION_FILE="$(dirname "$0")/../.node-version"
PINNED=""
[ -f "$NODE_VERSION_FILE" ] && PINNED="$(tr -d " \t\r\n" < "$NODE_VERSION_FILE")"
PINNED_MAJOR="${PINNED%%.*}"

# nvm-for-windows keeps versions at <root>/v<x.y.z>/node.exe; nvm on
# POSIX uses ~/.nvm/versions/node/v<x.y.z>/bin/node. Both are tried so
# this is not a Windows-only script.
nvm_roots() {
  [ -n "${NVM_HOME:-}" ] && printf "%s\n" "$NVM_HOME"
  [ -n "${LOCALAPPDATA:-}" ] && printf "%s\n" "$LOCALAPPDATA/nvm"
  printf "%s\n" "$HOME/AppData/Local/nvm"
  printf "%s\n" "$HOME/.nvm/versions/node"
}

# Windows env vars arrive with backslashes; Git Bash needs forward.
winpath() { printf "%s" "$1" | tr "\\\\" "/"; }

candidates() {
  [ -n "${NODE_BIN:-}" ] && printf "%s\n" "$NODE_BIN"
  local root v
  # exact pin first
  if [ -n "$PINNED" ]; then
    while read -r root; do
      root="$(winpath "$root")"
      printf "%s\n" "$root/v$PINNED/node.exe" "$root/v$PINNED/bin/node"
    done < <(nvm_roots)
  fi
  # then the newest installed same-major
  if [ -n "$PINNED_MAJOR" ]; then
    while read -r root; do
      root="$(winpath "$root")"
      # READ, DO NOT SPLIT. `for v in $(ls ...)` word-splits on the space
      # in "C:/Users/Mike Reagan/..." and emits two broken half-paths, so
      # the same-major candidate never existed and the resolver fell through
      # to PATH node -- the exact thing it is here to avoid.
      while IFS= read -r v; do
        [ -n "$v" ] || continue
        printf "%s\n" "$v/node.exe" "$v/bin/node"
      done < <(ls -1d "$root"/v"$PINNED_MAJOR".* 2>/dev/null | sort -V -r)
    done < <(nvm_roots)
  fi
  printf "%s\n" "node"
}

NODE=""
while read -r cand; do
  [ -z "$cand" ] && continue
  # "node" is a PATH lookup, not a file; everything else must exist.
  if [ "$cand" != "node" ] && [ ! -x "$cand" ]; then continue; fi
  command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ] || continue
  if "$cand" -e "$ABI_PROBE" >/dev/null 2>&1; then
    NODE="$cand"
    break
  fi
done < <(candidates)

if [ -z "$NODE" ]; then
  echo "NO USABLE NODE. No candidate could open a better-sqlite3 database." >&2
  echo "  .node-version pins: ${PINNED:-<absent>}" >&2
  echo "  PATH node:          $(node --version 2>/dev/null || echo none)" >&2
  echo "  tried: $(candidates | tr '\n' ' ')" >&2
  echo "" >&2
  echo "  better-sqlite3 here is built for NODE_MODULE_VERSION 115 (Node 20)." >&2
  echo "  Fix one of:" >&2
  echo "    nvm install ${PINNED:-20.20.2} && nvm use ${PINNED:-20.20.2}" >&2
  echo "    NODE_BIN=/path/to/node20 bash scripts/refresh-analysis-db.sh --promote" >&2
  echo "    npm rebuild better-sqlite3   # if you MEANT to move to a new major" >&2
  exit 4
fi

NODE_ACTUAL="$("$NODE" --version 2>/dev/null)"
echo "=== node: ${NODE_ACTUAL} (${NODE}) ==="
if [ -n "$PINNED" ] && [ "$NODE_ACTUAL" != "v$PINNED" ]; then
  echo "    NOTE .node-version pins v${PINNED}, which is not what is running." >&2
  echo "    Same major, better-sqlite3 loads, so this run is fine -- but the pin" >&2
  echo "    is stale. Either install v${PINNED} or update .node-version." >&2
fi
HOST="${MLB_HOST:-https://mlb-analyzer.onrender.com}"
STAMP="$(date +%Y%m%d)"
SNAP="data/mlb.db.prod-${STAMP}"
PROMOTE=0
[ "${1:-}" = "--promote" ] && PROMOTE=1

# TWO ACCEPTED VARIABLE NAMES, and the script says which one it used.
# (2026-09-13)
#
# The server compares against DB_DOWNLOAD_TOKEN (routes/api.js
# requireAdminToken). This script only ever read MLB_ADMIN_TOKEN, so
# exporting the name the server documents did nothing -- and if a ROTATED
# MLB_ADMIN_TOKEN was still sitting in the shell it won silently and the
# download came back 401. That is what happened on 2026-09-13, and the
# rotation is recorded in docs/the-outage-that-was-not-2026-08-24.md
# ("the value read this morning now returns 401 on every admin endpoint").
#
# The deliberate decision being preserved is "READ FROM THE ENVIRONMENT,
# NEVER HARDCODE" -- the owner's untracked refresh-db.sh carries a literal
# token, which is the pattern this script exists not to copy. Accepting a
# second variable name does not weaken that at all.
#
# DB_DOWNLOAD_TOKEN wins when both are set, because it is the name the
# server and the API docs use; MLB_ADMIN_TOKEN stays supported so existing
# shells keep working. Either way the name is echoed, so a stale value can
# no longer be used without the operator seeing which variable supplied it.
TOKEN=""
TOKEN_VAR=""
if [ -n "${DB_DOWNLOAD_TOKEN:-}" ]; then
  TOKEN="${DB_DOWNLOAD_TOKEN}"; TOKEN_VAR="DB_DOWNLOAD_TOKEN"
elif [ -n "${MLB_ADMIN_TOKEN:-}" ]; then
  TOKEN="${MLB_ADMIN_TOKEN}"; TOKEN_VAR="MLB_ADMIN_TOKEN"
fi
if [ -z "${TOKEN}" ]; then
  echo "No admin token in the environment. Export ONE of these first; neither is stored here:" >&2
  echo "  export DB_DOWNLOAD_TOKEN=...   # the name the server uses (preferred)" >&2
  echo "  export MLB_ADMIN_TOKEN=...     # older name, still accepted" >&2
  exit 2
fi
if [ -n "${DB_DOWNLOAD_TOKEN:-}" ] && [ -n "${MLB_ADMIN_TOKEN:-}" ] \
   && [ "${DB_DOWNLOAD_TOKEN}" != "${MLB_ADMIN_TOKEN}" ]; then
  echo "NOTE both DB_DOWNLOAD_TOKEN and MLB_ADMIN_TOKEN are set and they DIFFER;" >&2
  echo "     using DB_DOWNLOAD_TOKEN. If the download 401s, the other one is stale." >&2
fi

echo "=== 1/5 downloading production -> ${SNAP} ==="
echo "    host=${HOST}  header=X-Admin-Token  token from \$${TOKEN_VAR}"
# GZIP ON THE WIRE, DECODED HERE. (2026-09-15)
#
# This endpoint was 4.96 of the month's 5.06GB of Render outbound. The
# server now gzips when asked: the 834,355,200-byte 2026-09-14 snapshot
# crosses the wire as 196,623,797 (23.6%). Re-run the measurement with
#   node --max-old-space-size=1536 scripts/test-download-db-gzip.js --file data/mlb.db.prod-YYYYMMDD
#
# curl is deliberately NOT given --compressed. The compressed body is kept
# as-is so `gzip -t` can check its CRC, which catches a truncated transfer
# before anything is decompressed. The decompressed size is then compared
# with the server's X-Uncompressed-Length. Both checks run before the
# step-2 integrity check, and on any failure every partial file is removed.
# A server that has not deployed this yet answers without Content-Encoding,
# and that body is used as-is.
DL="${SNAP}.download"
HDRS="${SNAP}.headers"
rm -f "${DL}" "${HDRS}"
set +e
CURL_OUT="$(curl -sS --max-time 1800 -H "X-Admin-Token: ${TOKEN}" -H "Accept-Encoding: gzip" \
  -D "${HDRS}" -o "${DL}" -w '%{http_code} %{size_download}' \
  "${HOST}/api/admin/download-db")"
CURL_RC=$?
set -e
HTTP_CODE="${CURL_OUT%% *}"
WIRE_BYTES="${CURL_OUT##* }"
[ -n "${HTTP_CODE}" ] || HTTP_CODE="000"
echo "    http=${HTTP_CODE} curl_exit=${CURL_RC} wire_bytes=${WIRE_BYTES:-0}"
if [ "${HTTP_CODE}" = "200" ] && [ "${CURL_RC}" -ne 0 ]; then
  rm -f "${DL}" "${HDRS}" "${SNAP}"
  echo "DOWNLOAD FAILED MID-TRANSFER (curl exit ${CURL_RC}): nothing kept." >&2
  exit 3
fi
# A 401 used to arrive as a bare curl failure under -f, which said nothing
# about WHICH credential was rejected. Name it, and remove the partial file
# so a rejected download can never be mistaken for a snapshot.
if [ "${HTTP_CODE}" != "200" ]; then
  rm -f "${DL}" "${HDRS}" "${SNAP}"
  case "${HTTP_CODE}" in
    401) echo "DOWNLOAD REJECTED (401): the token in \$${TOKEN_VAR} is not what the server expects." >&2
         echo "  The server compares against its own DB_DOWNLOAD_TOKEN env var (Render dashboard)." >&2
         echo "  If \$${TOKEN_VAR} was exported a while ago it may be a rotated value." >&2 ;;
    503) echo "DOWNLOAD UNAVAILABLE (503): the server has no DB_DOWNLOAD_TOKEN configured." >&2 ;;
    000) echo "DOWNLOAD FAILED: could not reach ${HOST}." >&2 ;;
    *)   echo "DOWNLOAD FAILED (http ${HTTP_CODE})." >&2 ;;
  esac
  exit 3
fi

# Header value from the LAST response block, CR stripped; empty when absent.
# The `|| true` is load-bearing: an absent header makes grep exit 1, and under
# `set -euo pipefail` that silently killed the script on an identity response
# -- i.e. against any server that has not deployed the gzip change yet.
# scripts/test-download-db-gzip.js case 6 "identity" is the regression test.
header_value() {
  { grep -i "^$1:" "${HDRS}" || true; } | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//; s/ *$//'
}
ENCODING="$(header_value content-encoding | tr '[:upper:]' '[:lower:]')"
EXPECT_BYTES="$(header_value x-uncompressed-length)"
if [ "${ENCODING}" = "gzip" ]; then
  if ! gzip -t < "${DL}" 2>/dev/null; then
    rm -f "${DL}" "${HDRS}" "${SNAP}"
    echo "DOWNLOAD TRUNCATED: the gzip body failed its CRC/length integrity check. Nothing kept." >&2
    exit 3
  fi
  if ! gunzip -c < "${DL}" > "${SNAP}"; then
    rm -f "${DL}" "${HDRS}" "${SNAP}"
    echo "DECOMPRESSION FAILED writing ${SNAP}. Nothing kept." >&2
    exit 3
  fi
  rm -f "${DL}"
elif [ -z "${ENCODING}" ] || [ "${ENCODING}" = "identity" ]; then
  mv "${DL}" "${SNAP}"
else
  rm -f "${DL}" "${HDRS}" "${SNAP}"
  echo "UNEXPECTED Content-Encoding '${ENCODING}': refusing to guess how to decode it." >&2
  exit 3
fi
rm -f "${HDRS}"
SNAP_BYTES="$(wc -c < "${SNAP}" | tr -d ' ')"
echo "    encoding=${ENCODING:-identity} wire_bytes=${WIRE_BYTES} snapshot_bytes=${SNAP_BYTES}"
if [ -n "${EXPECT_BYTES}" ] && [ "${EXPECT_BYTES}" != "${SNAP_BYTES}" ]; then
  rm -f "${SNAP}"
  echo "SIZE MISMATCH: server sent X-Uncompressed-Length ${EXPECT_BYTES}, got ${SNAP_BYTES}. Nothing kept." >&2
  exit 3
fi

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
#   first-pitch timestamps  ->  (formerly tag-post-start-pricing)
#       the tagging criterion IS the first-pitch comparison; with no
#       timestamps it tagged nothing and reported success. The tagger no
#       longer runs here (see step 5), but backfill-first-pitch stays:
#       first_pitch_utc is read by the post-start reporting scripts and by
#       lineup-timing analysis, and a NULL there is still a silent zero.
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
# tag-post-start-pricing.js --apply WAS HERE, and is deliberately gone.
# (2026-09-14) The tag is now written on PRODUCTION by the registered
# backfill task market_contamination_post_first_pitch, so a refresh brings
# it down with the rest of the data. Re-deriving it here would be a second
# source of truth for one column -- the exact split that let the copy carry
# 273 tagged games while prod carried 0, on byte-identical inputs, for
# months. ONE SOURCE OF TRUTH: production computes it, the refresh copies
# it. scripts/tag-post-start-pricing.js still reports, and still takes
# --apply by hand for a copy that predates the prod backfill.
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
