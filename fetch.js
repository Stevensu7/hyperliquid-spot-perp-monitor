/**
 * Hyperliquid Mainnet Spot-Perp Monitor
 * Fetches mainstream coin data: BTC ETH SOL + stock/ETF perps with spot on Hyperliquid
 * 
 * API: https://api.hyperliquid.xyz/info (mainnet)
 * 
 * Market categories:
 *   1. Mainstream perps (BTC, ETH, SOL) — perp-only on HL, no spot
 *   2. Stock/ETF perps — many have spot on HL (META, TSLA, NVDA, etc.)
 *      These are the candidates for spot-perp arbitrage
 *
 * Run from browser (CORS-enabled) or Node.js (build step)
 */

const API_MAINNET = 'https://api.hyperliquid.xyz/info';

// ─── Wrapped token mapping ─────────────────────────────────────────────────────
const WRAPPED_MAP = { UBTC: 'BTC', UETH: 'ETH', USOL: 'SOL' };
const CANONICAL_TO_WRAPPED = {};
Object.entries(WRAPPED_MAP).forEach(([w, c]) => { CANONICAL_TO_WRAPPED[c] = w; });

// ─── Stock/ETF tokens — have spot pairs on HL but not suitable for crypto arb ─
const STOCK_TOKENS = new Set([
  'META', 'TSLA', 'NVDA', 'COIN', 'AAPL', 'AMZN', 'GOOGL', 'HOOD',
  'MSFT', 'SPY', 'QQQ', 'AVGO', 'ORCL', 'MU',
]);

// ─── Mainstream coins ─────────────────────────────────────────────────────────
const MAINSTREAM_COINS = ['BTC', 'ETH', 'SOL', 'ARB', 'OP', 'APT', 'AVAX', 'LINK',
  'DOT', 'MATIC', 'ATOM', 'UNI', 'LDO', 'MKR', 'AAVE', 'SNX', 'NEAR', 'FIL',
  'TIA', 'SUI', 'INJ', 'FTM', 'ALGO', 'XLM', 'ETC', 'XMR', 'WIF', 'PEPE', 'DOGE',
  'SHIB', 'TRUMP', 'MELANIA', 'BONK', 'WLD', 'STRK', 'REZ', 'NOT', 'POPCAT',
  'TURBO', 'MEW', 'GRIFFAIN', 'ONDO', 'JTO', 'PENDLE', 'ENA',
  'WBTC', 'FBTC', 'LBTC', 'FDUSD', 'USDT', 'USDC'
];

// DEX list
const DEXES = ['xyz', 'flx', 'vntl', 'hyna', 'km', 'abcd', 'cash', 'para'];

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function fetchJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function annualizedFundingPct(funding8h) {
  return funding8h * 3 * 365 * 100;
}

function fmtPx(v) {
  if (!v) return null;
  return Number(v);
}

// ─── Core data fetcher ─────────────────────────────────────────────────────────
async function loadLiveRows() {
  const [spotMeta, perpDexs, allMids] = await Promise.all([
    fetchJson(API_MAINNET, { type: 'spotMeta' }),
    fetchJson(API_MAINNET, { type: 'perpDexs' }),
    fetchJson(API_MAINNET, { type: 'allMids' }),
  ]);

  // Build index->token map from spotMeta.tokens
  const idxToToken = {};
  spotMeta.tokens.forEach(t => { idxToToken[t.index] = t; });

  // Build set of token NAMES that have a spot trading pair in universe
  // (correct approach: use universe, not tokens list)
  const spotTokenNames = new Set();
  spotMeta.universe.forEach(entry => {
    if (entry.tokens && entry.tokens.length >= 2) {
      const baseIdx = entry.tokens[0];
      const baseToken = idxToToken[baseIdx];
      if (baseToken) spotTokenNames.add(baseToken.name);
    }
  });

  // Active DEX list
  const activeDexes = perpDexs.filter(Boolean).map(d => d.name);
  const dexFullNames = {};
  perpDexs.filter(Boolean).forEach(d => { dexFullNames[d.name] = d.fullName || d.name; });

  // Fetch metaAndAssetCtxs for each DEX
  const dexData = await Promise.all(
    activeDexes.map(async (dex) => {
      try {
        const result = await fetchJson(API_MAINNET, {
          type: 'metaAndAssetCtxs',
          dex,
        });
        return { dex, result };
      } catch (e) {
        return { dex, result: null, error: e.message };
      }
    })
  );

  const rows = [];
  const perpMids = {}; // coin -> {dex, markPx}

  for (const { dex, result, error } of dexData) {
    if (!result || !result[0]) continue;
    const [meta, ctxs] = result;

    for (let i = 0; i < meta.universe.length; i++) {
      const u = meta.universe[i];
      const ctx = ctxs[i];
      if (!ctx) continue;

      const fullName = u.name; // e.g. "xyz:BTC-USD" or "BTC-USD"
      let base, dexPrefix;
      if (u.name.includes(':')) {
        [dexPrefix, base] = u.name.split(':', 2);
      } else {
        base = u.name;
        dexPrefix = '';
      }

      const funding = Number(ctx.funding || 0);
      const markPx = Number(ctx.markPx || 0);
      const oraclePx = Number(ctx.oraclePx || 0);
      const openInterest = Number(ctx.openInterest || 0);
      const dayVolume = Number(ctx.dayNtlVlm || 0);
      const premiumPct = ctx.premium != null ? Number(ctx.premium) * 100 : null;
      const basisPct = (oraclePx && markPx) ? ((markPx / oraclePx) - 1) * 100 : null;

      // Determine hasSpot:
      // 1. For canonical crypto (BTC/ETH/SOL), check wrapped token (UBTC/UETH/USOL) in universe
      // 2. For everything else, check if base name itself has a spot pair in universe
      // 3. Stock/ETF tokens → always false even if they have spot (not suitable for crypto arb)
      let hasSpot = spotTokenNames.has(base);
      if (!hasSpot && CANONICAL_TO_WRAPPED[base]) {
        hasSpot = spotTokenNames.has(CANONICAL_TO_WRAPPED[base]);
      }
      if (hasSpot && STOCK_TOKENS.has(base)) {
        hasSpot = false;
      }

      const isMainstream = MAINSTREAM_COINS.includes(base);

      rows.push({
        dex,
        dexLabel: dexFullNames[dex] || dex,
        symbol: base,
        perpSymbol: fullName,
        hasSpot,
        isMainstream,
        maxLeverage: u.maxLeverage,
        openInterest,
        dayVolume,
        fundingPer8hPct: funding * 100,
        annualizedFundingPct: annualizedFundingPct(funding),
        markPx,
        oraclePx,
        basisPct,
        premiumPct,
      });

      // Track perp mid for this coin (take first dex if multiple)
      if (markPx > 0 && !perpMids[base]) {
        perpMids[base] = { dex, markPx };
      }
    }
  }

  // Get spot mids for coins that have spot (not stocks)
  const spotMidMap = {};
  for (const coin of Object.keys(perpMids)) {
    if (spotTokenNames.has(coin) && !STOCK_TOKENS.has(coin) && allMids[coin] != null) {
      spotMidMap[coin] = {
        coin,
        spotMid: Number(allMids[coin]),
        perpMid: perpMids[coin]?.markPx,
        perpDex: perpMids[coin]?.dex,
      };
    }
  }

  // Sort: mainstream first, then by |ann funding| desc
  rows.sort((a, b) => {
    if (a.isMainstream !== b.isMainstream) return b.isMainstream - a.isMainstream;
    return Math.abs(b.annualizedFundingPct) - Math.abs(a.annualizedFundingPct);
  });

  return {
    generatedAt: new Date().toISOString(),
    dexes: activeDexes,
    rows,
    spotMids: spotMidMap,
  };
}

// Node.js export (for GitHub Actions build step)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { loadLiveRows, API_MAINNET, MAINSTREAM_COINS };
}

// Browser global
window.loadLiveRows = loadLiveRows;
