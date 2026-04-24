'use strict';
const UB_URL = 'https://content.unabated.com/markets/game-odds/b_gameodds.json';
const MLB_KEY = 'lg5:pt1:pregame';

// ---------------------------------------------------------------------------
// Market source IDs — verified against Unabated's live feed on 2026-04-21.
// Run scripts/verify-unabated-sources.js after any change to confirm IDs
// still resolve to the expected books. The previous mapping in this file
// was near-universally wrong (e.g. "91 = kalshi" but Kalshi is 105, Fliff
// is 91); all bet_signals written before the fix commit should be treated
// as tainted.
//
// The user bets exclusively on prediction markets via Robinhood (which
// surfaces Kalshi contracts), so Kalshi is the primary ML source and the
// other prediction markets / exchanges are natural fallbacks. Retail books
// are included as last-resort coverage only — they are NOT the market the
// user is actually betting into.
// ---------------------------------------------------------------------------

// Primary ML priority: Kalshi first (what the user actually bets), then
// sibling prediction markets, then sharp exchanges, then retail as fallback.
const ML_SOURCES = [
  '105', // Kalshi  ← primary
  '107', // Polymarket
  '89',  // Novig
  '66',  // Prophet Exchange
  '67',  // Sporttrade
  '104', // SxBet
  '52',  // Matchbook
  // --- below this line is retail fallback only; user does NOT bet these ---
  '2',   // FanDuel
  '1',   // DraftKings
  '86',  // Fanatics
  '78',  // Bet365
  '4',   // BetMGM
];

// Total priority: same logic. Prediction markets / exchanges are thinner on
// totals than on ML, so retail fallback is more likely to be used here.
const TOTAL_SOURCES = [
  '105', // Kalshi
  '107', // Polymarket
  '89',  // Novig
  '66',  // Prophet Exchange
  '67',  // Sporttrade
  '104', // SxBet
  '52',  // Matchbook
  '2',   // FanDuel
  '1',   // DraftKings
  '78',  // Bet365
  '86',  // Fanatics
  '4',   // BetMGM
];

// Consensus lookup — independent sharp cross-check used to flag Kalshi-vs-
// sharp divergence. Pure prediction-market / exchange list: these are the
// markets that most directly compete with Kalshi's pricing, so disagreement
// is informative. Kalshi (105) is deliberately excluded so the consensus
// can serve as a real second opinion.
//
// NOTE: Pinnacle is NOT available via the Unabated feed. IDs 58 and 70 are
// "Pinnacle - Delayed" and "Pinnacle - 3838" respectively but both are
// gated / inactive for game odds. The exchanges below are the closest
// available sharp proxies.
const XCHECK_SOURCES = [
  '107', // Polymarket  ← most directly comparable to Kalshi (prediction market)
  '89',  // Novig       ← sharp exchange
  '104', // SxBet
  '66',  // Prophet Exchange
  '52',  // Matchbook
  '67',  // Sporttrade
];

// Friendly name map — every ID that appears in the priority lists above,
// plus common active MLB sources. Verified 2026-04-21 against the live
// feed's marketSources table.
const SOURCE_NAMES = {
  '1':   'draftkings',
  '2':   'fanduel',
  '4':   'betmgm',
  '6':   'circa',
  '8':   'bookmaker',
  '9':   'betonline',
  '10':  'bovada',
  '17':  'betrivers',
  '20':  'caesars',
  '22':  'fourwinds',
  '24':  'hardrock',
  '25':  'parx',
  '27':  'sugarhouse',
  '36':  'thescore-us',
  '49':  'unabated-internal',
  '52':  'matchbook',
  '59':  'buckeye',
  '60':  'thescore-ca',
  '66':  'prophet-exchange',
  '67':  'sporttrade',
  '69':  'sports-interaction',
  '78':  'bet365',
  '86':  'fanatics',
  '89':  'novig',
  '91':  'fliff',
  '95':  'bet105',
  '99':  'southpoint',
  '104': 'sxbet',
  '105': 'kalshi',
  '107': 'polymarket',
};

// Sanity bounds for totals. MLB game totals essentially never sit below 5
// or above 13.5 runs. More critically, a prediction market can have an
// "Over 2.5 runs" contract priced at -4900 (near-deterministic); that is
// a valid Kalshi product but a garbage signal for our model, so we also
// require the americanPrice to look like a real market — reject anything
// with |price| > 400. Together these guards force fall-through to the
// next source when Unabated-Kalshi's "primary" total pick is an outlier
// contract rather than the market's actual O/U line.
const MLB_TOTAL_MIN_POINTS = 5.0;
const MLB_TOTAL_MAX_POINTS = 13.5;
const MLB_TOTAL_MAX_ABS_PRICE = 400;

function isSaneTotal(bt3) {
  if (!bt3 || bt3.points == null) return false;
  if (bt3.points < MLB_TOTAL_MIN_POINTS || bt3.points > MLB_TOTAL_MAX_POINTS) return false;
  if (bt3.americanPrice != null && Math.abs(bt3.americanPrice) > MLB_TOTAL_MAX_ABS_PRICE) return false;
  return true;
}

// Sanity bound for moneyline prices. Real MLB MLs essentially never exceed
// +/-400 but we leave headroom to 1000 because the purpose of this check is
// to reject the 99900 "no active contract" sentinel that Unabated sometimes
// returns when a book's side is delisted — not to police legitimate market
// prices. Null / non-numeric / zero also fail (0 is nonsense as a price).
const ML_MAX_ABS_PRICE = 1000;

function isSaneML(price) {
  if (price == null) return false;
  const n = Number(price);
  if (!Number.isFinite(n)) return false;
  if (n === 0) return false;
  return Math.abs(n) <= ML_MAX_ABS_PRICE;
}

const ABBR_MAP = {ARI:'ari',ATL:'atl',BAL:'bal',BOS:'bos',CHC:'chc',CWS:'cws',CIN:'cin',CLE:'cle',COL:'col',DET:'det',HOU:'hou',KC:'kc',LAA:'laa',LAD:'lad',MIA:'mia',MIL:'mil',MIN:'min',NYM:'nym',NYY:'nyy',OAK:'ath',ATH:'ath',PHI:'phi',PIT:'pit',SD:'sd',SF:'sf',SEA:'sea',STL:'stl',TB:'tb',TEX:'tex',TOR:'tor',WSH:'was',WAS:'was'};

async function fetchUnabatedOdds(dateStr) {
  const cacheBust = '?v='+Date.now();
  const resp = await fetch(UB_URL+cacheBust, {headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0','Cache-Control':'no-cache','Pragma':'no-cache'}});
  if (!resp.ok) throw new Error('Unabated HTTP '+resp.status);
  const data = await resp.json();
  const teamMap = {};
  Object.entries(data.teams||{}).forEach(([id,t])=>{ if(t.abbreviation) teamMap[id]=t.abbreviation; });
  const allGames = data.gameOddsEvents?.[MLB_KEY] || [];

  const nextDayStr = new Date(dateStr+'T00:00:00');
  nextDayStr.setDate(nextDayStr.getDate()+1);
  const nextDayS = nextDayStr.toISOString().slice(0,10);
  const windowEnd = nextDayS + 'T04:00:00';

  const dateGames = allGames.filter(g=>{
    if (!g.eventStart) return false;
    if (g.eventStart.startsWith(dateStr)) return true;
    if (g.eventStart.startsWith(nextDayS) && g.eventStart < windowEnd) return true;
    return false;
  });

  const byMatchup = {};
  dateGames.forEach(g=>{
    const awayUb = teamMap[g.eventTeams['0']?.id];
    const homeUb = teamMap[g.eventTeams['1']?.id];
    const away = ABBR_MAP[awayUb] || awayUb?.toLowerCase();
    const home = ABBR_MAP[homeUb] || homeUb?.toLowerCase();
    if (!away || !home) return;
    const key = away+'-'+home;
    const n = Object.keys(g.gameOddsMarketSourcesLines||{}).length;
    const start = g.eventStart || '';
    // Pick the event with the MOST market sources. The actively-traded
    // game for this date has ~60+ book listings; placeholder listings for
    // future days have only 4-8. Previously used "latest start" as the
    // dedup heuristic, but Unabated serves future-day placeholder events
    // that pass our date filter (e.g. on 4/22 query, both 4/22 00:05 UTC
    // and 4/23 00:05 UTC PIT@TEX events match; the 4/23 one is tomorrow's
    // placeholder with no totals). Source count is a robust signal for
    // identifying the real traded listing.
    if (!byMatchup[key] || n > byMatchup[key].n) byMatchup[key] = {g,away,home,n,start};
  });

  console.log('[unabated] '+Object.keys(byMatchup).length+' games for '+dateStr);

  const results = [];
  for (const {g,away,home} of Object.values(byMatchup)) {
    const lines = g.gameOddsMarketSourcesLines||{};

    // Build bySource for ML (an0 only) and totals (all an values)
    const bySource = {};      // for ML — an0 only
    const bySourceTot = {};   // for totals — keep entry with real points
    Object.entries(lines).forEach(([key,val])=>{
      const [si,ms,an]=key.split(':');
      const msId=ms.replace('ms','');
      const side=si==='si0'?'away':'home';
      // ML: an0 only
      if(an==='an0'){
        if(!bySource[msId]) bySource[msId]={};
        bySource[msId][side]=val;
      }
      // Totals: keep entry with real points (defer sanity check to isSaneTotal)
      if(val.bt3?.points!=null && val.bt3.points > 0){
        if(!bySourceTot[msId]) bySourceTot[msId]={};
        if(!bySourceTot[msId][side] || bySourceTot[msId][side].bt3?.points==null){
          bySourceTot[msId][side]=val;
        }
      }
    });

    // ML: walk priority list; require both sides to pass isSaneML before
    // accepting a source. Rejects one-sided quotes (market maker pulled
    // quotes mid-fetch) AND the 99900 sentinel that silently poisoned
    // market_home_ml before this guard was added. Falls through to the
    // next source if current one's quote is partial or out-of-range.
    let awayML=null,homeML=null,mlSrc=null;
    for(const msId of ML_SOURCES){
      const s=bySource[msId];
      const aPrice = s?.away?.bt1?.americanPrice;
      const hPrice = s?.home?.bt1?.americanPrice;
      const aOk = isSaneML(aPrice);
      const hOk = isSaneML(hPrice);
      if(aOk && hOk){
        awayML=aPrice; homeML=hPrice;
        mlSrc=SOURCE_NAMES[msId]||msId;
        break;
      }
      if(aOk || hOk || aPrice != null || hPrice != null){
        console.log('[unabated] '+away+'-'+home+': skipping partial/insane ML from src '+(SOURCE_NAMES[msId]||msId)+' (away='+aPrice+', home='+hPrice+')');
      }
    }

    // Last-ditch ML: ANY source with both sides passing isSaneML.
    if(!awayML||!homeML){
      for(const [msId,sides] of Object.entries(bySource)){
        const aPrice = sides.away?.bt1?.americanPrice;
        const hPrice = sides.home?.bt1?.americanPrice;
        if(isSaneML(aPrice) && isSaneML(hPrice)){
          awayML=aPrice; homeML=hPrice;
          mlSrc='src'+msId;
          break;
        }
      }
    }

    // Book-vs-book cross-check source — excludes Kalshi (the market source)
    // so the divergence check has something to compare against. Same
    // isSaneML filter as the primary waterfall. Note: if Kalshi is absent
    // and Polymarket wins both waterfalls, mlSrc === xcheckSrc and the
    // downstream flag logic treats the game as single-source.
    let xcheckAwayML=null, xcheckHomeML=null, xcheckSrc=null;
    for(const msId of XCHECK_SOURCES){
      const s=bySource[msId];
      const aPrice = s?.away?.bt1?.americanPrice;
      const hPrice = s?.home?.bt1?.americanPrice;
      if(isSaneML(aPrice) && isSaneML(hPrice)){
        xcheckAwayML=aPrice; xcheckHomeML=hPrice;
        xcheckSrc=SOURCE_NAMES[msId]||('src'+msId);
        break;
      }
    }

    // TOTAL: walk priority list. bt3 can be on si0 (over/away) OR si1
    // (under/home) depending on book. Apply isSaneTotal to reject outlier
    // contracts (e.g. Kalshi's "Over 2.5 @ -4900" primary pick for
    // PHI@CHC on 2026-04-21, which is a valid contract but a garbage
    // signal). Failing the sanity check, fall through to next source.
    let total=null,overPrice=null,underPrice=null,totalSrc=null;
    for(const msId of TOTAL_SOURCES){
      const s=bySourceTot[msId];
      if (!s) continue;
      const awayBt3 = s?.away?.bt3;
      const homeBt3 = s?.home?.bt3;
      const awayOk = isSaneTotal(awayBt3);
      const homeOk = isSaneTotal(homeBt3);
      if (!awayOk && !homeOk) {
        if (awayBt3?.points != null || homeBt3?.points != null) {
          console.log('[unabated] '+away+'-'+home+': rejected outlier total from src '+(SOURCE_NAMES[msId]||msId)+' (pts='+(awayBt3?.points ?? homeBt3?.points)+', price='+(awayBt3?.americanPrice ?? homeBt3?.americanPrice)+')');
        }
        continue;
      }
      if (awayOk) {
        total = awayBt3.points; overPrice = awayBt3.americanPrice ?? null;
        underPrice = homeBt3?.americanPrice ?? null;
      } else {
        total = homeBt3.points; overPrice = awayBt3?.americanPrice ?? null;
        underPrice = homeBt3.americanPrice ?? null;
      }
      totalSrc = SOURCE_NAMES[msId] || msId;
      break;
    }
    if(total==null){
      // Fallback total sweep — broader set of retail + sharp books in case
      // none of the priority TOTAL_SOURCES had a sane line. Same isSaneTotal
      // guard applies.
      const SHARP=[
        '36',  // TheScore US
        '89',  // Novig
        '98',  // Wagershack
        '95',  // Bet105
        '52',  // Matchbook
        '66',  // Prophet Exchange
        '104', // SxBet
        '27',  // Sugarhouse
        '25',  // Parx
        '24',  // Hard Rock
        '9',   // BetOnline
        '10',  // Bovada
        '4',   // BetMGM
      ];
      for(const msId of SHARP){
        const s=bySourceTot[msId];
        if (!s) continue;
        const awayBt3 = s?.away?.bt3;
        const homeBt3 = s?.home?.bt3;
        const awayOk = isSaneTotal(awayBt3);
        const homeOk = isSaneTotal(homeBt3);
        if (!awayOk && !homeOk) continue;
        if (awayOk) {
          total=awayBt3.points; overPrice=awayBt3.americanPrice??null;
          underPrice=homeBt3?.americanPrice??null;
        } else {
          total=homeBt3.points; overPrice=awayBt3?.americanPrice??null;
          underPrice=homeBt3.americanPrice??null;
        }
        totalSrc='src'+msId+'(fb)';
        break;
      }
    }

    console.log('[unabated] '+away+'-'+home+': ml='+awayML+'/'+homeML+'('+mlSrc+') xcheck='+xcheckAwayML+'/'+xcheckHomeML+'('+xcheckSrc+') tot='+total+'('+totalSrc+')');
    results.push({
      game_id:away+'-'+home,
      market_away_ml:awayML, market_home_ml:homeML,
      market_total:total, over_price:overPrice, under_price:underPrice,
      xcheck_away_ml:xcheckAwayML, xcheck_home_ml:xcheckHomeML,
      ml_source:mlSrc||null, xcheck_source:xcheckSrc||null,
      total_source:totalSrc||null,
      source:'unabated',
    });
  }
  return results;
}

module.exports = { fetchUnabatedOdds };
