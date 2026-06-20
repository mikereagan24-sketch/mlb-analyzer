#!/usr/bin/env bash
# scrape-ari-roof.sh
# Scrapes the official D-backs roof-status page and emits one row per game:
#   game_date(YYYY-MM-DD)  TAB  opponent  TAB  Open|Closed  TAB  game_time
# Server-rendered HTML, so plain curl + a browser UA is enough (no headless,
# no jq). Table covers current + next homestand, posted ahead of games.
# STANDALONE: prints only, does not touch DB or model.
#   bash scripts/scrape-ari-roof.sh          normal
#   bash scripts/scrape-ari-roof.sh --raw    also dump raw <td> cells
set -u

URL="https://www.mlb.com/dbacks/ballpark/information/roof"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
YEAR="$(date +%Y)"
raw=0; [ "${1:-}" = "--raw" ] && raw=1

html="$(curl -s -A "$UA" "$URL")"
if [ -z "$html" ]; then echo "ERROR: empty response from $URL" >&2; exit 1; fi

unesc="$(printf '%s' "$html" \
  | sed 's/\\u003c/</g; s/\\u003e/>/g; s/\\n/ /g; s/\\t/ /g; s/\\u0026/\&/g')"

cells="$(printf '%s' "$unesc" | grep -o '<td>[^<]*</td>' | sed 's/<td>//; s/<\/td>//')"

if [ "$raw" = "1" ]; then
  echo "=== RAW <td> CELLS ==="; printf '%s\n' "$cells"; echo "======================"; echo
fi

if [ -z "$cells" ]; then
  echo "ERROR: no <td> cells found. Page structure may have changed." >&2
  echo "Re-run with --raw to inspect." >&2
  exit 2
fi

# Parse, then dedupe in-order. The roof table is embedded twice in the page
# (visible HTML + hydration JSON), so every row appears twice; the final awk
# stage keeps the first occurrence of each line and preserves order.
{
  printf 'game_date\topponent\troof\tgame_time\n'
  printf '%s\n' "$cells" | awk -v year="$YEAR" '
  function mnum(m){
    if(m ~ /^Jan/)return "01"; if(m ~ /^Feb/)return "02"; if(m ~ /^Mar/)return "03";
    if(m ~ /^Apr/)return "04"; if(m ~ /^May/)return "05"; if(m ~ /^Jun/)return "06";
    if(m ~ /^Jul/)return "07"; if(m ~ /^Aug/)return "08"; if(m ~ /^Sep/)return "09";
    if(m ~ /^Oct/)return "10"; if(m ~ /^Nov/)return "11"; if(m ~ /^Dec/)return "12";
    return "";
  }
  { cell[NR] = $0; n = NR }
  END {
    for (i = 1; i <= n; i++) {
      line = cell[i]
      if (line ~ /^[A-Za-z]+,[ ]+[A-Z][a-z]+[ ]+[0-9]+$/) {
        mday = line; sub(/^[A-Za-z]+,[ ]+/, "", mday)
        split(mday, a, " "); mm = mnum(a[1]); dd = a[2]
        if (length(dd) == 1) dd = "0" dd
        gdate = (mm != "") ? (year "-" mm "-" dd) : line
        gtime = cell[i+1]; opp = cell[i+2]; status = cell[i+3]
        if (status != "Open" && status != "Closed") {
          for (j = i+1; j <= i+5 && j <= n; j++) {
            if (cell[j] == "Open" || cell[j] == "Closed") { status = cell[j]; break }
          }
        }
        if (status == "Open" || status == "Closed")
          printf "%s\t%s\t%s\t%s\n", gdate, opp, status, gtime
      }
    }
  }
  ' | awk "{ if (seen[\$0]++ == 0) print }"
}
