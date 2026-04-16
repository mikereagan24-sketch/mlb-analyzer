// @deployed 2026-04-16T20:52:12.160Z
'use strict';
// BUILD_TS: 2026-04-11T17:15:25.624Z
const express = require('express');
const cors = require('cors');
const path = require('path');
const { startCronJobs } = require('./services/jobs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// Version endpoint
app.get('/api/version', (req, res) => res.json({
  build: '2026-04-11T14:20:01.140Z',
  routes: ['weather','scores','lineups','odds','signals']
}));

// API routes
app.use('/api', require('./routes/api'));

// Health check for Render
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// SPA fallback — serve index.html with no-cache headers
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`MLB Analyzer running on port ${PORT}`);
  startCronJobs();
});
