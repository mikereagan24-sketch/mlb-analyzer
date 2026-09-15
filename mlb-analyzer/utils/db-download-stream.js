'use strict';
// GZIP FOR THE DB DOWNLOAD. (2026-09-15)
//
// WHY. Render outbound bandwidth for the month stood at 5.06GB, and 4.96GB
// of it was GET /api/admin/download-db -- one spike per analysis-copy
// refresh. Nothing else registered. A SQLite file is mostly page slack and
// repeated text, so it compresses hard:
//
//     data/mlb.db.prod-20260914   834,355,200 bytes
//     gzip level 1                218,462,444 bytes  26.2%   7.8s
//     gzip level 6                196,623,797 bytes  23.6%  14.5s   <- used
//
// Measured locally, streaming, rss ~50MB throughout. zlib runs on the libuv
// threadpool, so the extra seconds at level 6 do not block the event loop.
// Re-run: node --max-old-space-size=1536 scripts/test-download-db-gzip.js --file data/mlb.db.prod-YYYYMMDD
//
// NEGOTIATED, NOT UNCONDITIONAL. Only a client that sends
// Accept-Encoding: gzip gets a compressed body. Anything else -- including
// the owner's untracked refresh-db.sh, whose curl sends no Accept-Encoding --
// gets the same raw bytes and Content-Length it always did, so no existing
// caller can end up writing gzip bytes into a .db file.
//
// WAL SAFETY IS UNCHANGED. This only ever reads the finished db.backup()
// side file the route produced. It never touches the live database.
//
// X-Uncompressed-Length carries the snapshot size, because Content-Length
// cannot once the body is compressed on the fly. The refresh script checks
// the decompressed file against it.

const fs = require('fs');
const zlib = require('zlib');
const { pipeline, Transform } = require('stream');

const GZIP_LEVEL = 6;

// True when the Accept-Encoding header lists gzip with a non-zero q.
function acceptsGzip(header) {
  for (const part of String(header || '').split(',')) {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding.trim() !== 'gzip') continue;
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

// Stream filePath to res, gzipped when the request accepts it. done(result)
// is called exactly once -- on completion, on a read/zlib error, or when the
// client disconnects -- with { ok, error, gzip, bytesIn, bytesOut }, so the
// caller owns cleanup of the file. pipeline() destroys every stage on
// failure, which is what used to need a separate res.on('close') handler.
function streamDbFile(req, res, filePath, opts, done) {
  const o = opts || {};
  const size = fs.statSync(filePath).size;
  const gzip = acceptsGzip(req.headers['accept-encoding']);

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + (o.filename || 'mlb.db') + '"');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('X-Uncompressed-Length', String(size));

  let bytesOut = 0;
  const count = new Transform({
    transform(chunk, enc, cb) { bytesOut += chunk.length; cb(null, chunk); },
  });
  const finish = (err) => done({ ok: !err, error: err || null, gzip, bytesIn: size, bytesOut });

  if (gzip) {
    res.setHeader('Content-Encoding', 'gzip');
    pipeline(fs.createReadStream(filePath), zlib.createGzip({ level: o.level || GZIP_LEVEL }),
      count, res, finish);
  } else {
    res.setHeader('Content-Length', String(size));
    pipeline(fs.createReadStream(filePath), count, res, finish);
  }
}

module.exports = { streamDbFile, acceptsGzip, GZIP_LEVEL };
