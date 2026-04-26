'use strict';
// Raw upstream-feed snapshot capture + replay support.
//
// Every successful fetch in runOddsJob / runLineupJob / runScoreJob writes
// the raw response to disk via writeSnapshot before any parsing. The
// /api/replay/* endpoints read these back and re-run the parse + DB logic
// against the captured payload — letting us reproduce production-data bugs
// locally without re-fetching (and without depending on whether the
// upstream feed still serves the same data).
//
// Snapshots live under data/snapshots/{YYYY-MM-DD}/{jobtype}-{HHMMSS}.json.gz.
//
// CAVEAT (Render deploys): Render's filesystem is ephemeral on the free
// tier — snapshots written during one uptime window are LOST on next deploy
// or restart. For longer retention, mount a persistent disk or push to S3
// in a follow-up. Today's tier is fine for the "I noticed a bug 30 minutes
// ago, replay the last hour" use case.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SNAPSHOT_ROOT = path.join(process.cwd(), 'data', 'snapshots');
const MAX_SNAPSHOTS_PER_DATE = 50;

function tsForFilename() {
  // YYYYMMDD-HHMMSS in UTC, matching the filename pattern in the spec.
  return new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-');
}

function writeSnapshot(jobType, date, rawResponse) {
  try {
    const dir = path.join(SNAPSHOT_ROOT, date);
    fs.mkdirSync(dir, { recursive: true });
    const filename = jobType + '-' + tsForFilename() + '.json.gz';
    const fullPath = path.join(dir, filename);
    const compressed = zlib.gzipSync(JSON.stringify(rawResponse));
    fs.writeFileSync(fullPath, compressed);
    console.log('[snapshot] wrote ' + fullPath + ' (' + compressed.length + ' bytes)');
    pruneOldSnapshots(dir);
    return filename;
  } catch (e) {
    // Snapshot failure must NEVER break a real ingest. Log and return null.
    console.warn('[snapshot] failed: ' + e.message);
    return null;
  }
}

function pruneOldSnapshots(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json.gz'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > MAX_SNAPSHOTS_PER_DATE) {
      const toDelete = files.slice(MAX_SNAPSHOTS_PER_DATE);
      for (const f of toDelete) {
        try { fs.unlinkSync(path.join(dir, f.name)); } catch (e) {}
      }
      console.log('[snapshot] pruned ' + toDelete.length + ' old snapshots in ' + dir);
    }
  } catch (e) {
    console.warn('[snapshot] prune failed: ' + e.message);
  }
}

function listSnapshots(date) {
  const dir = path.join(SNAPSHOT_ROOT, date);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json.gz'))
    .map(f => {
      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      const m = f.match(/^([a-z]+)-(\d{8})-(\d{6})\.json\.gz$/);
      const captured_at = m
        ? m[2].slice(0,4) + '-' + m[2].slice(4,6) + '-' + m[2].slice(6,8) + 'T' + m[3].slice(0,2) + ':' + m[3].slice(2,4) + ':' + m[3].slice(4,6) + 'Z'
        : null;
      return {
        jobtype: m ? m[1] : null,
        filename: f,
        size_bytes: stat.size,
        captured_at,
      };
    })
    .sort((a, b) => (b.captured_at || '').localeCompare(a.captured_at || ''));
}

function readSnapshot(date, filename) {
  // Sanity-check filename to prevent path traversal.
  if (!/^[a-z]+-\d{8}-\d{6}\.json\.gz$/.test(filename)) {
    throw new Error('invalid snapshot filename: ' + filename);
  }
  const fullPath = path.join(SNAPSHOT_ROOT, date, filename);
  if (!fs.existsSync(fullPath)) throw new Error('snapshot not found: ' + date + '/' + filename);
  const compressed = fs.readFileSync(fullPath);
  const json = zlib.gunzipSync(compressed).toString('utf8');
  return JSON.parse(json);
}

function findLatestSnapshot(date, jobType) {
  return listSnapshots(date).find(s => s.jobtype === jobType) || null;
}

module.exports = { writeSnapshot, listSnapshots, readSnapshot, findLatestSnapshot };
