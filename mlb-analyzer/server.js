// deployed 2026-04-11T00:51:13.228Z
const express = require('express');
const cors = require('cors');
const path = require('path');
const { startCronJobs } = require('./services/jobs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {etag:false, lastModified:false, setHeaders:(res,filePath)=>{ if(filePath.endsWith('index.html')){res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');} }}));

// API routes
app.get('/api/version', (req, res) => res.json({build:'2026-04-11T14:20:01.140Z',routes:['weather','scores','lineups','odds','signals']}));
app.use('/api', require('./routes/api'));

// Health check for Render
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// SPA fallback
app.get('*', (req, res) => { res.setHeader('Cache-Control','no-store, no-cache, must-revalidate'); res.setHeader('Cache-Control','no-store'); res.setHeader('Content-Type','text/html'); res.send(INDEX_HTML); });

const INDEX_HTML = require('fs').readFileSync(path.join(__dirname,'public','index.html'),'utf8');
app.listen(PORT, () => {
  console.log(`MLB Analyzer running on port ${PORT}`);
  startCronJobs();
});
