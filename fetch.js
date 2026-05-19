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

// ─── Mainstream coins: track separately ───────────────────────────────────────
const MAINSTREAM_COINS = ['BTC', 'ETH', 'SOL', 'ARB', 'OP', 'APT', 'AVAX', 'LINK',
  'DOT', 'MATIC', 'ATOM', 'UNI', 'LDO', 'MKR', 'AAVE', 'SNX', 'NEAR', 'FIL',
  'TIA', 'SUI', 'INJ', 'FTM', 'ALGO', 'XLM', 'ETC', 'XMR', 'WIF', 'PEPE', 'DOGE',
  'SHIB', 'TRUMP', 'MELANIA', 'BONK', 'WLD', 'STRK', 'REZ', 'NOT', 'POPCAT',
  'TURBO', 'MEW', 'GRIFFAIN', 'ONDO', 'TIA', 'JTO', 'PENDLE', 'WLD', 'ENA',
  'WBTC', 'FBTC', 'LBTC', 'FDUSD', 'USDT', 'USDC'
];

// Stock/ETF tokens that exist as spot on Hyperliquid (from spotMeta)
const SPOT_TOKENS = new Set();

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

  // Build spot token set
  const spotNames = new Set(spotMeta.tokens.map(t => t.name));
  const spotCoins = [...spotNames];

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

      const hasSpot = spotNames.has(base);
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

  // Get spot mids for coins that have spot
  const spotMidMap = {};
  for (const coin of Object.keys(perpMids)) {
    if (spotNames.has(coin) && allMids[coin] != null) {
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
    spotCoins,
  };
}

// Node.js export (for GitHub Actions build step)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { loadLiveRows, API_MAINNET, MAINSTREAM_COINS };
}

// Browser global
window.loadLiveRows = loadLiveRows;
