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

// Spread (runline) priority — same Kalshi-first ordering as ML. The user
// bets exclusively via Robinhood/Kalshi for prediction-market lines, so
// Kalshi is the primary spread source when available. Prediction markets
// generally post fewer alt spreads than retail books, so the standard
// runline (-1.5/+1.5) is more likely to appear cleanly here than on
// retail; retail still serves as fallback. Mirror of ML_SOURCES — keep
// these two arrays in sync if either expands.
const SPREAD_SOURCES = [
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

// MLB runline is fixed at ±1.5 — this PR only ingests the standard line.
// Alt spreads (±2.5, ±3.5, etc.) are non-standard handicaps and would
// poison the snapshot if mixed in; reject anything outside the set.
// A future PR may add alt-spread support if Mike starts capturing them.
const MLB_RUNLINE_POINTS = new Set([-1.5, 1.5]);

// Sanity bound for runline prices. Real MLB runline juice rarely exceeds
// ±300 (e.g. heavy favorite -1.5 at -180 / underdog +1.5 at +150 is the
// outer band). Reject |price| > 400 to drop the 99900-class sentinel
// without policing legitimate prices. Same null/non-numeric/zero
// handling as isSaneML. Tighter than isSaneML since the ML bound (1000)
// has to accommodate pre-game heavy favorites at -350+.
const SPREAD_MAX_ABS_PRICE = 400;
function isSaneSpreadPrice(price) {
  if (price == null) return false;
  const n = Number(price);
  if (!Number.isFinite(n)) return false;
  if (n === 0) return false;
  return Math.abs(n) <= SPREAD_MAX_ABS_PRICE;
}

const ABBR_MAP = {ARI:'ari',ATL:'atl',BAL:'bal',BOS:'bos',CHC:'chc',CWS:'cws',CIN:'cin',CLE:'cle',COL:'col',DET:'det',HOU:'hou',KC:'kc',LAA:'laa',LAD:'lad',MIA:'mia',MIL:'mil',MIN:'min',NYM:'nym',NYY:'nyy',OAK:'ath',ATH:'ath',PHI:'phi',PIT:'pit',SD:'sd',SF:'sf',SEA:'sea',STL:'stl',TB:'tb',TEX:'tex',TOR:'tor',WSH:'was',WAS:'was'};

// Split into a raw-fetch step and a pure-parse step so the snapshot/replay
// system (services/snapshot.js, /api/replay/odds) can save the raw upstream
// JSON and re-run the parse against it without re-hitting Unabated. Original
// fetchUnabatedOdds(dateStr) preserved as a thin wrapper for back-compat.
async function fetchUnabatedRaw() {
  const cacheBust = '?v='+Date.now();
  const resp = await fetch(UB_URL+cacheBust, {headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0','Cache-Control':'no-cache','Pragma':'no-cache'}});
  if (!resp.ok) throw new Error('Unabated HTTP '+resp.status);
  return await resp.json();
}

async function fetchUnabatedOdds(dateStr) {
  return parseUnabatedOdds(await fetchUnabatedRaw(), dateStr);
}

function parseUnabatedOdds(data, dateStr) {
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

  // Step 1: gather every event by team-pair (don't dedup yet — doubleheader
  // legs share the team-pair). Step 2: within each team-pair, cluster events
  // by eventStart proximity (>2h gap = different leg). Step 3: within each
  // cluster, pick the event with the MOST market sources to filter out the
  // future-day placeholder events Unabated also serves (~60+ books on the
  // real listing vs ~4-8 on a placeholder). Step 4: sort clusters by start;
  // first leg keeps the bare team-pair game_id, subsequent legs append
  // '-g{N}' to match the suffix convention from statsapi/fetchSchedule.
  const byTeamPair = {};
  dateGames.forEach(g=>{
    const awayUb = teamMap[g.eventTeams['0']?.id];
    const homeUb = teamMap[g.eventTeams['1']?.id];
    const away = ABBR_MAP[awayUb] || awayUb?.toLowerCase();
    const home = ABBR_MAP[homeUb] || homeUb?.toLowerCase();
    if (!away || !home) return;
    const key = away+'-'+home;
    const n = Object.keys(g.gameOddsMarketSourcesLines||{}).length;
    const start = g.eventStart || '';
    if (!byTeamPair[key]) byTeamPair[key] = [];
    byTeamPair[key].push({g, away, home, n, start});
  });
  const byMatchup = {};
  // Doubleheader legs are never scheduled <90min apart at first pitch.
  // A tighter gap means something else is going on (suspended-game resumption,
  // split admission, schedule glitch) and we'd rather fail loud than silently
  // merge two listings into one.
  const LEG_GAP_MS = 90*60*1000;
  for (const [teamKey, events] of Object.entries(byTeamPair)) {
    // Sort by start time (lex sort works on ISO-8601 strings).
    events.sort((a,b) => (a.start||'').localeCompare(b.start||''));
    // Cluster events whose starts are within LEG_GAP_MS of each other.
    // Anything past that threshold is treated as a separate leg.
    const clusters = [];
    for (const ev of events) {
      const evMs = Date.parse(ev.start);
      const last = clusters[clusters.length-1];
      const lastMs = last ? Date.parse(last[last.length-1].start) : NaN;
      if (last && !isNaN(evMs) && !isNaN(lastMs) && Math.abs(evMs - lastMs) < LEG_GAP_MS) {
        last.push(ev);
      } else {
        clusters.push([ev]);
      }
    }
    clusters.forEach((cluster, idx) => {
      // Within this leg, pick the event with the most market sources — same
      // placeholder-filter the original single-game dedup applied.
      cluster.sort((a,b) => b.n - a.n);
      const best = cluster[0];
      const gameNumber = idx + 1;
      const finalKey = gameNumber > 1 ? teamKey + '-g' + gameNumber : teamKey;
      byMatchup[finalKey] = { ...best, gameNumber, finalKey };
    });
  }

  console.log('[unabated] '+Object.keys(byMatchup).length+' games for '+dateStr);

  const results = [];
  for (const {g, away, home, gameNumber, finalKey} of Object.values(byMatchup)) {
    const lines = g.gameOddsMarketSourcesLines||{};

    // Build bySource for ML (an0 only), totals (all an values), and
    // spread (bt2 — runline). ML only honors an0 because alt MLs aren't
    // a thing on MLB; totals/spreads scan all an values and pick the
    // entry that carries real `points`. Spread prefers the entry whose
    // points value is in MLB_RUNLINE_POINSet so alt spreads (±2.5+)
    // don't displace the standard ±1.5 — defer the final sanity check
    // to isSaneSpreadPrice / runline-set membership in the waterfall.
    const bySource = {};      // for ML — an0 only
    const bySourceTot = {};   // for totals — keep entry with real points
    const bySourceSpread = {}; // for spread — keep entry whose bt2.points is ±1.5
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
      // Spread (bt2): keep the entry whose points value is the standard
      // ±1.5 runline. Books often emit multiple bt2 entries per side
      // (the standard line plus one or two alts); selecting on the set
      // means we never accidentally store a -2.5 contract as the runline.
      if(val.bt2?.points!=null && MLB_RUNLINE_POINTS.has(val.bt2.points)){
        if(!bySourceSpread[msId]) bySourceSpread[msId]={};
        // Only overwrite a previous entry when the new one is on the
        // standard runline — already gated above, but the explicit
        // guard makes intent obvious if MLB_RUNLINE_POINTS ever expands.
        if(!bySourceSpread[msId][side] || !MLB_RUNLINE_POINTS.has(bySourceSpread[msId][side].bt2?.points)){
          bySourceSpread[msId][side]=val;
        }
      }
    });

    // ML: walk priority list; require both sides to pass isSaneML before
    // accepting a source. Rejects one-sided quotes (market maker pulled
    // quotes mid-fetch) AND the 99900 sentinel that silently poisoned
    // market_home_ml before this guard was added. Falls through to the
    // next source if current one's quote is partial or out-of-range.
    let awayML=null,homeML=null,mlSrc=null,mlMsId=null;
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
        mlMsId=msId;
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
          mlMsId=msId;
          break;
        }
      }
    }

    // Book-vs-book cross-check source — excludes Kalshi (the market source)
    // so the divergence check has something to compare against. Same
    // isSaneML filter as the primary waterfall.
    //
    // Skip msId === mlMsId so the xcheck never lands on the same source the
    // primary already used. Without this skip, when Kalshi is absent or
    // one-sided, the primary ML waterfall falls through to Polymarket (107)
    // and the xcheck waterfall — whose first entry is also Polymarket —
    // re-picks Polymarket, making xcheckSrc === mlSrc and tripping the
    // downstream "single-source, no cross-check available" flag despite
    // 5+ other exchanges in XCHECK_SOURCES having sane two-sided quotes.
    let xcheckAwayML=null, xcheckHomeML=null, xcheckSrc=null;
    for(const msId of XCHECK_SOURCES){
      if (msId === mlMsId) continue;
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
    let total=null,overPrice=null,underPrice=null,totalSrc=null,totalMsId=null;
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
      totalMsId = msId;
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
        totalMsId = msId;
        break;
      }
    }

    // Second (xcheck) totals waterfall — independent of Kalshi. Same
    // matching-line + juice rules as the primary. Line + over + under
    // travel as a group; they may differ from the primary's line so
    // downstream never mixes xcheck's line with primary's juice. Log
    // split-line rejections for greppability (primary logs them too).
    //
    // Skip msId === totalMsId so xcheck never lands on the same source the
    // primary used. TOTAL_SOURCES and XCHECK_TOTAL_SOURCES are already
    // disjoint by design (Kalshi excluded from xcheck totals), but the
    // primary's fallback sweep iterates Object.entries(bySourceTot) and can
    // pick a source that ALSO appears in XCHECK_TOTAL_SOURCES — defensive
    // skip catches that collision parallel to the ML xcheck fix.
    let xcheckTotal=null, xcheckOverPrice=null, xcheckUnderPrice=null, xcheckTotalSrc=null;
    for (const msId of XCHECK_TOTAL_SOURCES) {
      if (msId === totalMsId) continue;
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

    // SPREAD (runline ±1.5): walk SPREAD_SOURCES priority list. Rules
    // for accepting a source (all must pass, else fall through):
    //   - Both sides have bt2 entries (skip one-sided)
    //   - Both bt2 entries pass isLiveContract (overrideType / peg flags)
    //   - Both points values are in MLB_RUNLINE_POINTS (±1.5 only —
    //     reject alts here even though bySourceSpread already filtered;
    //     defensive)
    //   - Sides mirror: away.points === -home.points (catches feed bugs
    //     where two sources of one side somehow wrote both as +1.5)
    //   - Both prices pass isSaneSpreadPrice (|price| ≤ 400, no zero,
    //     no 99900-class sentinel)
    let awaySpread=null, homeSpread=null,
        awaySpreadPrice=null, homeSpreadPrice=null,
        spreadSrc=null, spreadMsId=null;
    for (const msId of SPREAD_SOURCES) {
      const s = bySourceSpread[msId];
      if (!s) continue;
      const aBt2 = s?.away?.bt2, hBt2 = s?.home?.bt2;
      if (!aBt2 || !hBt2) continue;
      if (!isLiveContract(aBt2) || !isLiveContract(hBt2)) {
        if (aBt2.overrideType === 'disabled' || hBt2.overrideType === 'disabled' ||
            aBt2.includePeg === false || hBt2.includePeg === false) {
          console.log('[unabated] '+away+'-'+home+': rejected disabled spread from src '+(SOURCE_NAMES[msId]||msId)+' (away.overrideType='+aBt2?.overrideType+'/peg='+aBt2?.includePeg+', home.overrideType='+hBt2?.overrideType+'/peg='+hBt2?.includePeg+')');
        }
        continue;
      }
      if (!MLB_RUNLINE_POINTS.has(aBt2.points) || !MLB_RUNLINE_POINTS.has(hBt2.points)) continue;
      if (aBt2.points !== -hBt2.points) {
        console.log('[unabated] '+away+'-'+home+': rejected non-mirror spread from src '+(SOURCE_NAMES[msId]||msId)+' (away-pts='+aBt2.points+', home-pts='+hBt2.points+')');
        continue;
      }
      const aP = aBt2.americanPrice ?? null;
      const hP = hBt2.americanPrice ?? null;
      if (!isSaneSpreadPrice(aP) || !isSaneSpreadPrice(hP)) {
        if (aP != null || hP != null) {
          console.log('[unabated] '+away+'-'+home+': rejected insane spread juice from src '+(SOURCE_NAMES[msId]||msId)+' (away='+aP+', home='+hP+')');
        }
        continue;
      }
      awaySpread = aBt2.points;
      homeSpread = hBt2.points;
      awaySpreadPrice = aP;
      homeSpreadPrice = hP;
      spreadSrc = SOURCE_NAMES[msId] || msId;
      spreadMsId = msId;
      break;
    }
    // Fallback sweep — any source in bySourceSpread (not just the
    // priority list) with a coherent mirror pair on the standard
    // runline. Same strict guard.
    if (awaySpread == null) {
      for (const [msId, s] of Object.entries(bySourceSpread)) {
        if (!s) continue;
        const aBt2 = s?.away?.bt2, hBt2 = s?.home?.bt2;
        if (!aBt2 || !hBt2) continue;
        if (!isLiveContract(aBt2) || !isLiveContract(hBt2)) continue;
        if (!MLB_RUNLINE_POINTS.has(aBt2.points) || !MLB_RUNLINE_POINTS.has(hBt2.points)) continue;
        if (aBt2.points !== -hBt2.points) continue;
        const aP = aBt2.americanPrice ?? null;
        const hP = hBt2.americanPrice ?? null;
        if (!isSaneSpreadPrice(aP) || !isSaneSpreadPrice(hP)) continue;
        awaySpread = aBt2.points;
        homeSpread = hBt2.points;
        awaySpreadPrice = aP;
        homeSpreadPrice = hP;
        spreadSrc = 'src'+msId+'(fb)';
        spreadMsId = msId;
        break;
      }
    }

    console.log('[unabated] '+away+'-'+home
      +': ml='+awayML+'/'+homeML+'('+mlSrc+')'
      +' ml-xcheck='+xcheckAwayML+'/'+xcheckHomeML+'('+xcheckSrc+')'
      +' tot='+total+'@'+overPrice+'/'+underPrice+'('+totalSrc+')'
      +' tot-xcheck='+xcheckTotal+'@'+xcheckOverPrice+'/'+xcheckUnderPrice+'('+xcheckTotalSrc+')'
      +' spread='+awaySpread+'@'+awaySpreadPrice+'/'+homeSpread+'@'+homeSpreadPrice+'('+spreadSrc+')');
    results.push({
      game_id: finalKey,
      game_number: gameNumber,
      event_start: g.eventStart || null,
      market_away_ml:awayML, market_home_ml:homeML,
      market_total:total, over_price:overPrice, under_price:underPrice,
      xcheck_away_ml:xcheckAwayML, xcheck_home_ml:xcheckHomeML,
      xcheck_total:xcheckTotal, xcheck_over_price:xcheckOverPrice, xcheck_under_price:xcheckUnderPrice,
      ml_source:mlSrc||null, xcheck_ml_source:xcheckSrc||null,
      total_source:totalSrc||null, xcheck_total_source:xcheckTotalSrc||null,
      // Step 1 of runline ingest (PR #spread-ingest). Step 2 will copy
      // these onto bet_signals at fire time; Step 3 surfaces ROI.
      market_away_spread: awaySpread,
      market_home_spread: homeSpread,
      market_away_spread_price: awaySpreadPrice,
      market_home_spread_price: homeSpreadPrice,
      market_spread_src: spreadSrc || null,
      source:'unabated',
    });
  }
  return results;
}

module.exports = { fetchUnabatedOdds, fetchUnabatedRaw, parseUnabatedOdds };
