# MLB Betting Analyzer

Full-stack MLB betting model with persistent storage, automated nightly lineup/score pulls, and backtest tracking.

## Architecture
- **Backend**: Node.js + Express
- **Database**: SQLite via better-sqlite3 (stored on Render's persistent disk at `/data/mlb.db`)
- **Automation**: node-cron schedules lineup pull at 5 PM ET and score pull at 7 AM ET daily
- **AI**: Uses Anthropic's API with web_search to fetch lineups and scores reliably

---

## Deployment to Render.com

### Step 1 — Push to GitHub
```bash
cd mlb-analyzer
git init
git add .
git commit -m "Initial commit"
# Create a new repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/mlb-analyzer.git
git push -u origin main
```

### Step 2 — Create Render account
Go to [render.com](https://render.com) and sign up (free).

### Step 3 — Create a new Web Service
1. Click **New +** → **Web Service**
2. Connect your GitHub account and select the `mlb-analyzer` repo
3. Render will auto-detect the `render.yaml` — confirm the settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

### Step 4 — Add environment variables
In Render dashboard → your service → **Environment**:
- `ANTHROPIC_API_KEY` = your Anthropic API key (get from console.anthropic.com)
- `RENDER` = `true` (already in render.yaml)

### Step 5 — Add persistent disk
In Render dashboard → your service → **Disks**:
- Click **Add Disk**
- Name: `mlb-data`
- Mount path: `/data`
- Size: `1 GB`

> **Important**: The free plan includes 1 GB of persistent disk. The SQLite database and all your FanGraphs CSV data will survive restarts here.

### Step 6 — Deploy
Click **Deploy** — Render will build and start the app. Takes ~2 minutes first time.
Your app will be live at `https://mlb-analyzer.onrender.com` (or similar).

---

## Using the App

### First time setup
1. Go to **Data Import** tab
2. Download your 8 FanGraphs CSVs (bat/pit × proj/actual × lhp/rhp)
3. Drop all 8 files at once — they're stored in the database permanently
4. You never need to re-upload unless you want fresher projection data

### Daily workflow (fully automated)
- **5:00 PM ET**: App automatically pulls confirmed lineups + SPs from RotoGrinders/MLB.com
- **7:00 AM ET next day**: App automatically pulls final scores and resolves all bet signals
- Check the **Backtest** tab anytime for running P&L by category

### Manual controls
- **Today's Games** → **⟳ Refresh lineups**: Pull lineups right now for any date
- **Today's Games** → **Pull scores**: Pull scores right now for the selected date
- **Backtest** → Job history shows all cron runs with status

---

## Data persistence
- FanGraphs CSV data: stored in SQLite, persists forever, only updates on new upload
- Game log, signals, scores: accumulate automatically
- All data lives at `/data/mlb.db` on Render's persistent disk

## Migrating away from Render
Your data is fully portable:
1. Download `/data/mlb.db` (SQLite file)
2. The code is standard Node.js — works on Railway, Fly.io, any VPS, or locally
3. On a new host: set `ANTHROPIC_API_KEY`, point to your `.db` file, `npm start`

## Local development
```bash
npm install
ANTHROPIC_API_KEY=your_key node server.js
# Open http://localhost:3000
```
Local DB stored at `./data/mlb.db`

---

## Model parameters (adjustable in Model tab)
| Setting | Default | Description |
|---------|---------|-------------|
| Run multiplier | 48 | (wOBA - 0.230) × N × parkFactor = runs |
| HFA boost | 0.02 | +2pp added to home win% |
| Pitcher weight | 0.50 | Share of expected wOBA from pitcher splits |
| Batter weight | 0.50 | Share from batter splits |
| Steamer weight | 0.65 | Blend: 65% Steamer projections |
| Actual weight | 0.35 | Blend: 35% 2-yr actual splits |
| Fav ML adj | -10 | Subtract 10 from favorite ML |
| Dog ML adj | +5 | Add 5 to underdog ML |
| ML value edge | 5% | Min implied prob edge for "Value" signal |
| ML lean edge | 2% | Min implied prob edge for "Lean" signal |
| Total value edge | 0.4 runs | Min run diff for "Value" total signal |
| Total lean edge | 0.2 runs | Min run diff for "Lean" total signal |
