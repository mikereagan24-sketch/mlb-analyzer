// @deployed 2026-04-16T21:24:52.577Z
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
app.get('/api/debug/bullpen', (req, res) => {
  try {
    const team = req.query.team; const sp = req.query.sp||''; const hand = req.query.hand||'rhb';
    if (!team) return res.json({ error: 'team required' });
    const normName = n => (n||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim();
    const projKey = 'pit-proj-'+hand; const actKey = 'pit-act-'+hand;
    const projRows = q.db.prepare("SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=? AND player_name LIKE ?").all(projKey, '% '+team.toUpperCase());
    const actRows = q.db.prepare("SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=?").all(actKey);
    const actIdx = {}; for (const r of actRows) actIdx[normName(r.player_name)] = r;
    const sets = getSettings(); const WP = sets.W_PROJ||0.65; const WA = sets.W_ACT||0.35;
    const starterLast = sp ? normName(sp).split(' ').pop() : '';
    const pitchers = projRows.map(proj => {
      const nameClean = proj.player_name.replace(/ [A-Z]{2,3}$/, '');
      const pNorm = normName(nameClean); const lastName = pNorm.split(' ').pop();
      const isStarter = starterLast && pNorm.includes(starterLast);
      const actExact = actIdx[pNorm];
      const actFuzzy = actExact || Object.entries(actIdx).find(([k])=>k.endsWith(' '+lastName))?.[1]||null;
      const blended = actFuzzy ? WP*proj.woba + WA*actFuzzy.woba : proj.woba;
      return { name: nameClean, role: isStarter?'SP':'RP', proj_woba: +proj.woba.toFixed(4), proj_sample: +proj.sample_size.toFixed(1), act_woba: actFuzzy?+actFuzzy.woba.toFixed(4):null, act_sample: actFuzzy?actFuzzy.sample_size:null, blended_woba: +blended.toFixed(4), calc: actFuzzy?WP+'*'+proj.woba.toFixed(4)+' + '+WA+'*'+actFuzzy.woba.toFixed(4):'proj only: '+proj.woba.toFixed(4) };
    });
    const pool = pitchers.filter(p=>p.role==='RP'&&p.proj_sample>=5);
    const use = pool.length>=3?pool:pitchers.filter(p=>p.role==='RP').slice(0,8);
    const tw = use.reduce((s,p)=>s+p.proj_sample,0);
    const bpWoba = tw>0 ? +(use.reduce((s,p)=>s+p.blended_woba*p.proj_sample,0)/tw).toFixed(4) : null;
    res.json({ team, hand, sp, W_PROJ:WP, W_ACT:WA, pitchers, bullpen_woba:bpWoba, pool_size:use.length });
  } catch(e) { res.json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`MLB Analyzer running on port ${PORT}`);
  startCronJobs();
});
