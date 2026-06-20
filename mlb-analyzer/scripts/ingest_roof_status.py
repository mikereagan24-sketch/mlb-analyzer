#!/usr/bin/env python3
"""
ingest_roof_status.py — join scraped D-backs roof status into game_log.

Reads rows from scrape-ari-roof.sh (game_date, opponent, Open|Closed, time),
matches each to a game_log row by venue_id=15 (Chase Field) + game_date, and
sets roof_status ('open'/'closed') + roof_confidence='announced'.

SAFE BY DEFAULT: dry-run prints the planned changes and writes nothing.
Pass --commit to actually update the DB.

Year handling: the scraper labels dates with the current calendar year. We do
NOT trust that blindly — we only match a scraped date to a game_log row that
actually exists for that exact date at venue 15. Off-season/no-game dates are
reported as unmatched rather than written, so a wrong-year label can't corrupt
anything.

Usage:
  bash scripts/scrape-ari-roof.sh | python scripts/ingest_roof_status.py
  bash scripts/scrape-ari-roof.sh | python scripts/ingest_roof_status.py --commit
"""
import sys, sqlite3, argparse

DB_PATH = "data/mlb.db"
CHASE_VENUE_ID = 15

def parse_rows(stream):
    rows = []
    for line in stream:
        line = line.rstrip("\n")
        if not line or line.startswith("game_date"):
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        gdate, opp, roof = parts[0], parts[1], parts[2]
        roof = roof.strip().lower()
        if roof not in ("open", "closed"):
            continue
        rows.append((gdate, opp, roof))
    return rows

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true",
                    help="Write changes. Without this, dry-run only.")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()

    scraped = parse_rows(sys.stdin)
    if not scraped:
        print("No valid scraped rows on stdin. Did you pipe scrape-ari-roof.sh?")
        sys.exit(1)

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row

    planned, unmatched, nochange = [], [], []
    for gdate, opp, roof in scraped:
        # Match by venue (Chase) + exact date. A game must already exist.
        grows = db.execute(
            "SELECT game_date, game_id, home_team, away_team, venue_id, "
            "roof_status, roof_confidence FROM game_log "
            "WHERE venue_id=? AND game_date=?",
            (CHASE_VENUE_ID, gdate),
        ).fetchall()
        if not grows:
            unmatched.append((gdate, opp, roof))
            continue
        for g in grows:
            cur_status = (g["roof_status"] or "").lower()
            cur_conf = (g["roof_confidence"] or "")
            if cur_status == roof and cur_conf == "announced":
                nochange.append((gdate, g["game_id"], roof))
            else:
                planned.append((gdate, g["game_id"],
                                f"{g['roof_status']}/{g['roof_confidence']}",
                                f"{roof}/announced"))

    print(f"Scraped rows: {len(scraped)}   matched-to-change: {len(planned)}   "
          f"already-correct: {len(nochange)}   unmatched(no game at date): {len(unmatched)}")
    print()
    if planned:
        print("PLANNED CHANGES (before -> after):")
        for gdate, gid, before, after in planned:
            print(f"  {gdate}  {gid:<14}  {before:<18} -> {after}")
        print()
    if unmatched:
        print("UNMATCHED (scraped date has no Chase game in game_log — skipped, not written):")
        for gdate, opp, roof in unmatched:
            print(f"  {gdate}  vs {opp}  ({roof})")
        print()

    if not args.commit:
        print(">>> DRY RUN. Nothing written. Re-run with --commit to apply.")
        db.close()
        return

    if not planned:
        print("Nothing to change. DB already matches scraped status.")
        db.close()
        return

    cur = db.cursor()
    n = 0
    for gdate, gid, _before, after in planned:
        roof = after.split("/")[0]
        cur.execute(
            "UPDATE game_log SET roof_status=?, roof_confidence='announced' "
            "WHERE venue_id=? AND game_date=? AND game_id=?",
            (roof, CHASE_VENUE_ID, gdate, gid),
        )
        n += cur.rowcount
    db.commit()
    print(f">>> COMMITTED. {n} row(s) updated.")
    db.close()

if __name__ == "__main__":
    main()
