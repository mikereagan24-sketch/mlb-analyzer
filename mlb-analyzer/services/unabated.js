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

// Independent cross-check source for totals. Excludes Kalshi because Kalshi's
// thin MLB O/U order book routinely prices out of line with sportsbook
// consensus — that outlier juice is what pollutes the edge calc when used as
// the model's only input. The xcheck waterfall picks the first source with a
// sane two-sided total quote so the edge calc has a second opinion.
// Ordered: sharp sportsbooks (deep books, tight spreads) first, then liquid
// retail, then exchanges, with Polymarket last as a prediction-market
// fallback carrying the same thin-book risk as Kalshi but in the opposite
// direction. Pinnacle / Circa / Caesars were considered — Pinnacle and Circa
// are not in the Unabated feed's active set for game odds, and Caesars is
// under an ambiguous source ID (our existing SOURCE_NAMES['24']='hardrock'
// but marketSources[24] currently labels it "Caesars"; untangling that is
// out of scope for this branch).
const XCHECK_TOTAL_SOURCES = [
  '67',  // sporttrade       — sharp exchange, deep on MLB
  '4',   // betmgm           — retail, very liquid
  '2',   // fanduel          — retail, very liquid
  '1',   // draftkings       — retail, very liquid
  '78',  // bet365           — retail, liquid internationally
  '52',  // matchbook        — exchange
  '66',  // prophetexchange  — exchange
  '104', // sxbet            — exchange
  '89',  // novig            — exchange
  '107', // polymarket       — prediction market, last-resort (thin-book risk)
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

// Reject contracts the feed has flagged as not live. Kalshi (and likely
// other books) leaves the last numeric price in the feed even after pulling
// the contract from active trading — these flags are the feed's explicit
// "don't use this" signal:
//   - overrideType === 'disabled': the contract has been suspended.
//     Observed 2026-04-24 on DET@CIN where Kalshi's bt3 8.5 contract was
//     marked disabled but still emitting +127/-156, ~25 cents off market
//     consensus on a 9.0 line.
//   - includePeg === false: the price isn't tied to the live order book
//     (off-peg). Empirically pairs with overrideType=disabled on Kalshi
//     but checked separately so either flag triggers rejection.
// Applied at every bt1 (ML) and bt3 (totals) selection site so primary,
// fallback, and xcheck waterfalls all skip non-live contracts uniformly.
function isLiveContract(bt) {
  if (!bt) return false;
  if (bt.overrideType === 'disabled') return false;
  if (bt.includePeg === false) return false;
  return true;
}

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

// Tighter juice bound for totals prices (vs isSaneTotal's line-focused check).
// Real sportsbook juice on MLB O/U essentially never exceeds ±200 — every book
// in the feed today sits in [−127, +117] on 8.5 lines. Anything outside ±200
// is either the 99900-class sentinel or a corrupt contract. Reject null,
// non-numeric, zero, and |price| > 200. A candidate source must have BOTH
// sides passing this guard to be selected (no mixing one sane side with one
// sentinel side — see primary/xcheck totals waterfalls below).
const MLB_TOTAL_MAX_JUICE_ABS = 200;
function isSaneTotalJuice(price) {
  if (price == null) return false;
  const n = Number(price);
  if (!Number.isFinite(n)) return false;
  if (n === 0) return false;
  return Math.abs(n) <= MLB_TOTAL_MAX_JUICE_ABS;
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
      const aBt1 = s?.away?.bt1, hBt1 = s?.home?.bt1;
      const aPrice = aBt1?.americanPrice;
      const hPrice = hBt1?.americanPrice;
      if (!isLiveContract(aBt1) || !isLiveContract(hBt1)) {
        // Distinguish missing-side vs disabled flags in the log so log
        // readers can tell whether the source pulled a contract or just
        // didn't post both sides.
        const aMissing = !aBt1, hMissing = !hBt1;
        const aDisabled = aBt1 && (aBt1.overrideType === 'disabled' || aBt1.includePeg === false);
        const hDisabled = hBt1 && (hBt1.overrideType === 'disabled' || hBt1.includePeg === false);
        if (aDisabled || hDisabled) {
          console.log('[unabated] '+away+'-'+home+': rejected disabled ML from src '+(SOURCE_NAMES[msId]||msId)+' (away.overrideType='+aBt1?.overrideType+'/peg='+aBt1?.includePeg+', home.overrideType='+hBt1?.overrideType+'/peg='+hBt1?.includePeg+')');
        } else if ((aMissing || hMissing) && (aPrice != null || hPrice != null)) {
          console.log('[unabated] '+away+'-'+home+': skipping one-sided ML from src '+(SOURCE_NAMES[msId]||msId)+' (away='+(aMissing?'(missing)':aPrice)+', home='+(hMissing?'(missing)':hPrice)+')');
        }
        continue;
      }
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

    // Last-ditch ML: ANY source with both sides passing isSaneML AND live.
    if(!awayML||!homeML){
      for(const [msId,sides] of Object.entries(bySource)){
        const aBt1 = sides.away?.bt1, hBt1 = sides.home?.bt1;
        if (!isLiveContract(aBt1) || !isLiveContract(hBt1)) continue;
        const aPrice = aBt1?.americanPrice;
        const hPrice = hBt1?.americanPrice;
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
      const aBt1 = s?.away?.bt1, hBt1 = s?.home?.bt1;
      if (!isLiveContract(aBt1) || !isLiveContract(hBt1)) continue;
      const aPrice = aBt1?.americanPrice;
      const hPrice = hBt1?.americanPrice;
      if(isSaneML(aPrice) && isSaneML(hPrice)){
        xcheckAwayML=aPrice; xcheckHomeML=hPrice;
        xcheckSrc=SOURCE_NAMES[msId]||('src'+msId);
        break;
      }
    }

    // TOTAL: walk priority list. bt3 on si0 carries the Over contract,
    // bt3 on si1 carries the Under — both MUST reference the same line
    // via points. Rules for accepting a source (all must pass, else
    // fall through):
    //   - Both sides pass isSaneTotal (line in [5, 13.5], |price| ≤ 400).
    //   - awayBt3.points === homeBt3.points — strict equality, no float
    //     tolerance, no numeric coercion. Feed returns numeric
    //     half-integers; anything else we want to fall through. Rejects
    //     Polymarket-style contracts where Over and Under sit on
    //     different lines (e.g. Over 8.5 @ -117 / Under 9.5 @ -124).
    //   - Both juices pass isSaneTotalJuice (|price| ≤ 200, no 99900
    //     sentinel).
    let total=null,overPrice=null,underPrice=null,totalSrc=null;
    for(const msId of TOTAL_SOURCES){
      const s=bySourceTot[msId];
      if (!s) continue;
      const awayBt3 = s?.away?.bt3;
      const homeBt3 = s?.home?.bt3;
      if (!isLiveContract(awayBt3) || !isLiveContract(homeBt3)) {
        if (awayBt3?.points != null || homeBt3?.points != null) {
          console.log('[unabated] '+away+'-'+home+': rejected disabled total contract from src '+(SOURCE_NAMES[msId]||msId)+' (over.overrideType='+awayBt3?.overrideType+'/peg='+awayBt3?.includePeg+', under.overrideType='+homeBt3?.overrideType+'/peg='+homeBt3?.includePeg+')');
        }
        continue;
      }
      if (!isSaneTotal(awayBt3) || !isSaneTotal(homeBt3)) {
        if (awayBt3?.points != null || homeBt3?.points != null) {
          console.log('[unabated] '+away+'-'+home+': rejected outlier total line from src '+(SOURCE_NAMES[msId]||msId)+' (over-pts='+awayBt3?.points+', under-pts='+homeBt3?.points+')');
        }
        continue;
      }
      if (awayBt3.points !== homeBt3.points) {
        console.log('[unabated] '+away+'-'+home+': rejected split-line from src '+(SOURCE_NAMES[msId]||msId)+' (over-line='+awayBt3.points+', under-line='+homeBt3.points+')');
        continue;
      }
      const oP = awayBt3.americanPrice ?? null;
      const uP = homeBt3.americanPrice ?? null;
      if (!isSaneTotalJuice(oP) || !isSaneTotalJuice(uP)) {
        console.log('[unabated] '+away+'-'+home+': rejected insane juice from src '+(SOURCE_NAMES[msId]||msId)+' (over='+oP+', under='+uP+')');
        continue;
      }
      total = awayBt3.points;  // safe — both sides agree
      overPrice = oP;
      underPrice = uP;
      totalSrc = SOURCE_NAMES[msId] || msId;
      break;
    }
    if(total==null){
      // Fallback sweep — any source in bySourceTot (not just the priority
      // list) with a coherent matching-line pair. Same strict guard.
      // Silent on rejection since this is last-ditch and noise isn't
      // useful when 29 sources may all be malformed.
      for(const [msId,s] of Object.entries(bySourceTot)){
        if (!s) continue;
        const awayBt3 = s?.away?.bt3;
        const homeBt3 = s?.home?.bt3;
        if (!isLiveContract(awayBt3) || !isLiveContract(homeBt3)) continue;
        if (!isSaneTotal(awayBt3) || !isSaneTotal(homeBt3)) continue;
        if (awayBt3.points !== homeBt3.points) continue;
        const oP = awayBt3.americanPrice ?? null;
        const uP = homeBt3.americanPrice ?? null;
        if (!isSaneTotalJuice(oP) || !isSaneTotalJuice(uP)) continue;
        total = awayBt3.points;
        overPrice = oP;
        underPrice = uP;
        totalSrc = 'src'+msId+'(fb)';
        break;
      }
    }

    // Second (xcheck) totals waterfall — independent of Kalshi. Same
    // matching-line + juice rules as the primary. Line + over + under
    // travel as a group; they may differ from the primary's line so
    // downstream never mixes xcheck's line with primary's juice. Log
    // split-line rejections for greppability (primary logs them too).
    let xcheckTotal=null, xcheckOverPrice=null, xcheckUnderPrice=null, xcheckTotalSrc=null;
    for (const msId of XCHECK_TOTAL_SOURCES) {
      const s = bySourceTot[msId];
      if (!s) continue;
      const awayBt3 = s?.away?.bt3;
      const homeBt3 = s?.home?.bt3;
      if (!isLiveContract(awayBt3) || !isLiveContract(homeBt3)) continue;
      if (!isSaneTotal(awayBt3) || !isSaneTotal(homeBt3)) continue;
      if (awayBt3.points !== homeBt3.points) {
        console.log('[unabated] '+away+'-'+home+': xcheck rejected split-line from src '+(SOURCE_NAMES[msId]||msId)+' (over-line='+awayBt3.points+', under-line='+homeBt3.points+')');
        continue;
      }
      const oP = awayBt3.americanPrice ?? null;
      const uP = homeBt3.americanPrice ?? null;
      if (!isSaneTotalJuice(oP) || !isSaneTotalJuice(uP)) continue;
      xcheckTotal = awayBt3.points;
      xcheckOverPrice = oP;
      xcheckUnderPrice = uP;
      xcheckTotalSrc = SOURCE_NAMES[msId] || ('src'+msId);
      break;
    }

    console.log('[unabated] '+away+'-'+home
      +': ml='+awayML+'/'+homeML+'('+mlSrc+')'
      +' ml-xcheck='+xcheckAwayML+'/'+xcheckHomeML+'('+xcheckSrc+')'
      +' tot='+total+'@'+overPrice+'/'+underPrice+'('+totalSrc+')'
      +' tot-xcheck='+xcheckTotal+'@'+xcheckOverPrice+'/'+xcheckUnderPrice+'('+xcheckTotalSrc+')');
    results.push({
      game_id:away+'-'+home,
      market_away_ml:awayML, market_home_ml:homeML,
      market_total:total, over_price:overPrice, under_price:underPrice,
      xcheck_away_ml:xcheckAwayML, xcheck_home_ml:xcheckHomeML,
      xcheck_total:xcheckTotal, xcheck_over_price:xcheckOverPrice, xcheck_under_price:xcheckUnderPrice,
      ml_source:mlSrc||null, xcheck_source:xcheckSrc||null,
      total_source:totalSrc||null, xcheck_total_source:xcheckTotalSrc||null,
      source:'unabated',
    });
  }
  return results;
}

module.exports = { fetchUnabatedOdds };
