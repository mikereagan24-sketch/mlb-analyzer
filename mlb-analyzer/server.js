app.get('*', (req, res) => {
  const fs = require('fs');
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(htmlPath, 'utf8', (err, data) => {
    if (err) return res.status(500).send('Error loading page');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(data);
  });
});

const INDEX_HTML = require('fs').readFileSync(path.join(__dirname,'public','index.html'),'utf8');
app.listen(PORT, () => {
  console.log(`MLB Analyzer running on port ${PORT}`);
  startCronJobs();
});
