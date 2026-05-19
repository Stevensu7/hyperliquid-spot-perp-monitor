/**
 * fetch-data.js — Node.js version for GitHub Actions
 * Fetches Hyperliquid mainnet data and writes:
 *   - data.js   (JSONP global for browser to load directly)
 *   - data.json (raw JSON snapshot)
 * 
 * Run: node scripts/fetch-data.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'https://api.hyperliquid.xyz/info';

// ─── HTTP helper (no external deps) ──────────────────────────────────────────
function post(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE);
    const data = JSON.stringify(body);
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`JSON parse error: ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching Hyperliquid mainnet data...');
  const start = Date.now();

  // 1. Fetch all data in parallel
  const [spotMeta, perpDexs, allMids] = await Promise.all([
    post({ type: 'spotMeta' }),
    post({ type: 'perpDexs' }),
    post({ type: 'allMids' }),
  ]);

  // allMids: keys like "BTC", "ETH", "SOL", "META" etc — unified mid prices
  const allMidNames = new Set(Object.keys(allMids));

  // Build index->token map from spotMeta.tokens
  const idxToToken = {};
  spotMeta.tokens.forEach(t => { idxToToken[t.index] = t; });

  // Build set of token names (not indices!) that HAVE A SPOT TRADING PAIR in universe
  // These are the SPOT TOKEN names, e.g. "UBTC", "UETH", "TSLA", "META"
  // We get them by looking at the base token name (index 0 in universe tokens array)
  const spotTokenNames = new Set();
  spotMeta.universe.forEach(entry => {
    if (entry.tokens && entry.tokens.length >= 2) {
      const baseIdx = entry.tokens[0];
      const baseToken = idxToToken[baseIdx];
      if (baseToken) spotTokenNames.add(baseToken.name);
    }
  });

  // Build wrapped->canonical mapping for main crypto pairs
  // e.g. { UBTC: "BTC", UETH: "ETH", USOL: "SOL" }
  // These are the wrapped tokens that have corresponding perpetuals on Hyperliquid
  const WRAPPED_MAP = {
    UBTC: 'BTC',
    UETH: 'ETH',
    USOL: 'SOL',
    // Add other known wrapped tokens as needed
  };
  // Reverse: canonical -> wrapped
  const CANONICAL_TO_WRAPPED = {};
  Object.entries(WRAPPED_MAP).forEach(([wrapped, canonical]) => {
    CANONICAL_TO_WRAPPED[canonical] = wrapped;
  });

  const activeDexes = perpDexs.filter(Boolean).map(d => d.name);
  const dexFullNames = {};
  perpDexs.filter(Boolean).forEach(d => { dexFullNames[d.name] = d.fullName || d.name; });

  // 2. Fetch metaAndAssetCtxs per DEX
  const dexResults = {};
  await Promise.all(activeDexes.map(async (dex) => {
    try {
      const result = await post({ type: 'metaAndAssetCtxs', dex });
      dexResults[dex] = result;
      console.log(`  [${dex}] ok — universe size: ${result[0].universe.length}`);
    } catch (e) {
      console.warn(`  [${dex}] FAILED: ${e.message}`);
      dexResults[dex] = null;
    }
  }));

  // 3. Build rows
  const rows = [];
  const perpMids = {};

  for (const dex of activeDexes) {
    const result = dexResults[dex];
    if (!result || !result[0]) continue;
    const [meta, ctxs] = result;

    for (let i = 0; i < meta.universe.length; i++) {
      const u = meta.universe[i];
      const ctx = ctxs[i];
      if (!ctx) continue;

      const fullName = u.name;
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
      // 1. For canonical crypto names (BTC/ETH/SOL), check if wrapped version (UBTC/UETH/USOL) has a spot pair
      // 2. For all other assets (META, TSLA, COIN, etc.), check if the base name itself has a spot pair
      let hasSpot = spotTokenNames.has(base);
      if (!hasSpot && CANONICAL_TO_WRAPPED[base]) {
        // Canonical crypto: check wrapped token spot
        hasSpot = spotTokenNames.has(CANONICAL_TO_WRAPPED[base]);
      }

      rows.push({
        dex,
        dexLabel: dexFullNames[dex] || dex,
        symbol: base,
        perpSymbol: fullName,
        hasSpot,
        maxLeverage: u.maxLeverage,
        openInterest,
        dayVolume,
        fundingPer8hPct: funding * 100,
        annualizedFundingPct: funding * 3 * 365 * 100,
        markPx,
        oraclePx,
        basisPct,
        premiumPct,
      });

      if (markPx > 0 && !perpMids[base]) {
        perpMids[base] = { dex, markPx };
      }
    }
  }

  // Sort: hasSpot first, then by |ann funding| desc
  rows.sort((a, b) => {
    if (a.hasSpot !== b.hasSpot) return b.hasSpot - a.hasSpot;
    return Math.abs(b.annualizedFundingPct) - Math.abs(a.annualizedFundingPct);
  });

  const data = {
    generatedAt: new Date().toISOString(),
    dexes: activeDexes,
    rows,
    perpMids,
  };

  // ─── Write output files ───────────────────────────────────────────────────
  const outDir = __dirname; // root of repo
  const dataJson = JSON.stringify(data, null, 2);
  const dataJs = `// Generated ${new Date().toISOString()}\nwindow.__HL_DATA__ = ${dataJson};`;

  fs.writeFileSync(path.join(outDir, 'data.json'), dataJson, 'utf8');
  fs.writeFileSync(path.join(outDir, 'data.js'), dataJs, 'utf8');

  const elapsed = Date.now() - start;
  const spotRows = rows.filter(r => r.hasSpot).length;
  const perpRows = rows.filter(r => !r.hasSpot).length;
  console.log(`\nDone in ${elapsed}ms`);
  console.log(`  Total rows: ${rows.length} (${spotRows} spot-pairable, ${perpRows} perp-only)`);
  console.log(`  DEXes: ${activeDexes.join(', ')}`);
  console.log(`  Files: data.json (${fs.statSync(path.join(outDir, 'data.json')).size} bytes), data.js`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
