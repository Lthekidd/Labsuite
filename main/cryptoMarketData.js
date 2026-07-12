const https = require('https');
const path = require('path');
let fs;
try {
  fs = require('original-fs');
} catch (_) {
  fs = require('fs');
}

const fastDriveSync = require('./fastDriveSync');

const CACHE_APP = 'CryptoCache';
const CACHE_VERSION = 1;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_CACHE_MS = {
  '1': 30 * 1000,
  '7': 30 * 60 * 1000,
  '30': 30 * 60 * 1000,
  '90': 30 * 60 * 1000,
  max: 12 * 60 * 60 * 1000
};
const MARKET_CACHE_MS = 45 * 1000;
const MARKET_STALE_CACHE_MS = 24 * 60 * 60 * 1000;
const SEARCH_CACHE_MS = 24 * 60 * 60 * 1000;

function getCacheDir() {
  let baseDir;
  try {
    const { app } = require('electron');
    baseDir = app.getPath('userData');
  } catch (_) {
    baseDir = path.join(__dirname, '../data');
  }
  const dir = path.join(baseDir, 'crypto-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(value) {
  return String(value || '').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 160);
}

function localCachePath(fileName) {
  return path.join(getCacheDir(), safeName(fileName));
}

function readLocalJson(fileName) {
  try {
    const filePath = localCachePath(fileName);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeLocalJson(fileName, payload) {
  try {
    fs.writeFileSync(localCachePath(fileName), JSON.stringify(payload), 'utf8');
  } catch (error) {
    console.warn('Crypto cache: local write failed:', error.message);
  }
}

async function readSharedJson(fileName) {
  try {
    const raw = await fastDriveSync.downloadData(CACHE_APP, fileName);
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function writeSharedJson(fileName, payload) {
  try {
    await fastDriveSync.uploadData(CACHE_APP, fileName, JSON.stringify(payload));
  } catch (error) {
    console.warn('Crypto cache: shared write failed:', error.message);
  }
}

function isFresh(cache, ttlMs) {
  return cache && Date.now() - Date.parse(cache.updatedAt || '') < ttlMs;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'LabSuite/2.0 crypto-cache'
      },
      timeout: 20000
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || parsed.status?.error_message || `CoinGecko request failed (${res.statusCode})`));
            return;
          }
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('CoinGecko request timed out.')));
    req.on('error', reject);
  });
}

function coinGecko(pathname, params = {}) {
  const url = new URL(`https://api.coingecko.com/api/v3${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return requestJson(url);
}

function normalizePrices(prices = []) {
  const byTime = new Map();
  for (const point of prices || []) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const time = Number(point[0]);
    const price = Number(point[1]);
    if (!Number.isFinite(time) || !Number.isFinite(price)) continue;
    byTime.set(time, [time, price]);
  }
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}

function sliceHistory(prices, days) {
  if (days === 'max') return prices;
  const daysNumber = Number(days);
  if (!Number.isFinite(daysNumber) || daysNumber <= 0) return prices;
  const cutoff = Date.now() - daysNumber * ONE_DAY_MS;
  return prices.filter(point => point[0] >= cutoff);
}

async function loadCache(fileName) {
  const local = readLocalJson(fileName);
  if (local) return local;
  const shared = await readSharedJson(fileName);
  if (shared) {
    writeLocalJson(fileName, shared);
  }
  return shared;
}

async function saveCache(fileName, payload, shared = true) {
  writeLocalJson(fileName, payload);
  if (shared) await writeSharedJson(fileName, payload);
}

function coinMarketCacheName(id) {
  return `market_coin_${safeName(id)}.json`;
}

function cacheCoinMarketRows(rows = []) {
  for (const row of rows) {
    if (!row || !row.id) continue;
    writeLocalJson(coinMarketCacheName(row.id), {
      version: CACHE_VERSION,
      updatedAt: new Date().toISOString(),
      data: row
    });
  }
}

function getCachedCoinMarketRows(ids = []) {
  const rows = [];
  for (const id of ids) {
    const cached = readLocalJson(coinMarketCacheName(id));
    if (!cached || !cached.data) continue;
    const age = Date.now() - Date.parse(cached.updatedAt || '');
    if (!Number.isFinite(age) || age > MARKET_STALE_CACHE_MS) continue;
    rows.push(cached.data);
  }
  return rows;
}

function mergeMissingMarketRows(requestedIds, freshRows = []) {
  const rows = Array.isArray(freshRows) ? [...freshRows] : [];
  const returnedIds = new Set(rows.map(row => row && row.id).filter(Boolean));
  const missingIds = requestedIds.filter(id => !returnedIds.has(id));
  if (missingIds.length === 0) return rows;

  const cachedRows = getCachedCoinMarketRows(missingIds);
  for (const row of cachedRows) {
    if (!row || !row.id || returnedIds.has(row.id)) continue;
    returnedIds.add(row.id);
    rows.push(row);
  }
  return rows;
}

async function getMarketData(ids = []) {
  const cleanIds = [...new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean))].sort();
  if (cleanIds.length === 0) return [];

  const fileName = `market_${safeName(cleanIds.join('_'))}.json`;
  const cached = await loadCache(fileName);
  if (isFresh(cached, MARKET_CACHE_MS)) return cached.data || [];

  try {
    const data = await coinGecko('/coins/markets', {
      vs_currency: 'usd',
      ids: cleanIds.join(','),
      order: 'market_cap_desc',
      per_page: Math.max(1, Math.min(cleanIds.length, 250)),
      page: 1,
      sparkline: true
    });
    const freshRows = Array.isArray(data) ? data : [];
    cacheCoinMarketRows(freshRows);
    const payload = {
      version: CACHE_VERSION,
      updatedAt: new Date().toISOString(),
      data: mergeMissingMarketRows(cleanIds, freshRows)
    };
    await saveCache(fileName, payload, false);
    return payload.data;
  } catch (error) {
    if (cached && Array.isArray(cached.data)) return cached.data;
    const coinCachedRows = getCachedCoinMarketRows(cleanIds);
    if (coinCachedRows.length > 0) return coinCachedRows;
    throw error;
  }
}

async function getHistory(coinId, days = '30') {
  const id = String(coinId || '').trim();
  const normalizedDays = days === 'max' || days === 'ALL' ? 'max' : String(days || '30');
  if (!id) throw new Error('Missing CoinGecko coin id.');

  const ttl = RANGE_CACHE_MS[normalizedDays] || 30 * 60 * 1000;
  const fileName = `history_${safeName(id)}_${safeName(normalizedDays)}.json`;
  const cached = await loadCache(fileName);
  if (isFresh(cached, ttl)) return { prices: sliceHistory(cached.prices || [], normalizedDays), cached: true };

  try {
    let prices = [];
    if (normalizedDays === 'max' && cached && Array.isArray(cached.prices) && cached.prices.length > 0) {
      const existing = normalizePrices(cached.prices);
      const lastTime = existing[existing.length - 1][0];
      const from = Math.max(0, Math.floor(lastTime / 1000) + 1);
      const to = Math.floor(Date.now() / 1000);
      let tail = [];
      if (to > from) {
        const range = await coinGecko(`/coins/${encodeURIComponent(id)}/market_chart/range`, {
          vs_currency: 'usd',
          from,
          to
        });
        tail = normalizePrices(range.prices || []);
      }
      prices = normalizePrices([...existing, ...tail]);
    } else {
      const data = await coinGecko(`/coins/${encodeURIComponent(id)}/market_chart`, {
        vs_currency: 'usd',
        days: normalizedDays
      });
      prices = normalizePrices(data.prices || []);
    }

    const payload = {
      version: CACHE_VERSION,
      coinId: id,
      days: normalizedDays,
      updatedAt: new Date().toISOString(),
      prices
    };
    await saveCache(fileName, payload, normalizedDays === 'max');
    return { prices: sliceHistory(prices, normalizedDays), cached: false };
  } catch (error) {
    if (cached && Array.isArray(cached.prices)) {
      return { prices: sliceHistory(cached.prices, normalizedDays), cached: true, stale: true, error: error.message };
    }
    throw error;
  }
}

async function search(query) {
  const clean = String(query || '').trim().toLowerCase();
  if (!clean) return { coins: [] };

  const fileName = `search_${safeName(clean)}.json`;
  const cached = await loadCache(fileName);
  if (isFresh(cached, SEARCH_CACHE_MS)) return cached.data || { coins: [] };

  try {
    const data = await coinGecko('/search', { query: clean });
    await saveCache(fileName, { version: CACHE_VERSION, updatedAt: new Date().toISOString(), data }, false);
    return data;
  } catch (error) {
    if (cached && cached.data) return cached.data;
    throw error;
  }
}

module.exports = {
  getMarketData,
  getHistory,
  search
};
