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
app.use('/api', require('./routes/api'));

// Health check for Render
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// SPA fallback
app.get('*', (req, res) => { res.setHeader('Cache-Control','no-store, no-cache, must-revalidate'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, () => {
  console.log(`MLB Analyzer running on port ${PORT}`);
  startCronJobs();
});
