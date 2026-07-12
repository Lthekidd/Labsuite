import React, { useState, useEffect, useMemo, useRef } from 'react';

const ipcRenderer = window.electron?.ipcRenderer;

// Default popular coins list
const POPULAR_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'DOT', 'LINK', 'AVAX', 'LTC'];
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PRICE_CACHE_KEY = 'labsuite_crypto_market_prices_v1';
const PORTFOLIO_CACHE_KEY = 'labsuite_crypto_portfolio_v3';
const DEFAULT_WATCHLIST = ['BTC', 'ETH', 'SOL', 'BNB', 'LINK'];

async function forEachWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(Math.max(1, limit), queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

// Hardcoded correct mappings for CoinGecko IDs to avoid lowercase fallback bugs
const DEFAULT_GECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  DOT: 'polkadot',
  LINK: 'chainlink',
  AVAX: 'avalanche-2',
  LTC: 'litecoin',
  XMR: 'monero',
  JUP: 'jupiter-exchange-solana',
  TRON: 'tron',
  WLFI: 'world-liberty-financial',
  SHIB: 'shiba-inu',
  YZY: 'yzy',
  SLP: 'smooth-love-potion',
  XLM: 'stellar',
  FET: 'fetch-ai',
  LUNC: 'terra-luna',
  LUNA: 'terra-luna-2',
  GRT: 'the-graph',
  DGB: 'digibyte',
  OCEAN: 'ocean-protocol',
  RON: 'ronin',
  HNT: 'helium',
  AGIX: 'singularitynet'
};

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeGeckoId(value) {
  return String(value || '').trim().toLowerCase();
}

function isTickerFallbackId(symbol, geckoId) {
  const sym = normalizeSymbol(symbol);
  const id = normalizeGeckoId(geckoId);
  return !!sym && id === sym.toLowerCase();
}

function mergeGeckoMappings(loadedMappings) {
  const merged = { ...DEFAULT_GECKO_IDS };
  if (!loadedMappings || typeof loadedMappings !== 'object') return merged;

  Object.entries(loadedMappings).forEach(([rawSymbol, rawId]) => {
    const symbol = normalizeSymbol(rawSymbol);
    const id = normalizeGeckoId(rawId);
    if (!symbol || !id) return;

    const knownDefault = DEFAULT_GECKO_IDS[symbol];
    if (knownDefault && knownDefault !== id && isTickerFallbackId(symbol, id)) {
      return;
    }

    merged[symbol] = id;
  });

  return merged;
}

function uniqueSymbols(values) {
  return Array.from(new Set((values || []).map(normalizeSymbol).filter(Boolean)));
}

function formatUsdPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return 'N/A';
  const abs = Math.abs(price);
  const maximumFractionDigits = abs > 1 ? 4 : abs > 0.01 ? 6 : 8;
  return `$${price.toLocaleString(undefined, {
    minimumFractionDigits: abs >= 1 ? 2 : 0,
    maximumFractionDigits
  })}`;
}

// Helper to parse line accounting for double quotes
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(field);
      if (row.some(cell => cell.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some(cell => cell.trim() !== '')) rows.push(row);
  return rows;
}

function normalizeCsvHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function readCsvValue(row, normalizedHeaders, names) {
  const normalizedNames = names.map(normalizeCsvHeader);
  for (const name of normalizedNames) {
    const index = normalizedHeaders.indexOf(name);
    if (index >= 0) return row[index] || '';
  }
  return '';
}

function parseNumericValue(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;
  let text = String(value).trim();
  if (!text) return NaN;
  let sign = 1;
  if (/^\(.*\)$/.test(text)) {
    sign = -1;
    text = text.slice(1, -1);
  }
  text = text
    .replace(/[−–—]/g, '-')
    .replace(/[$$€£¥₿,%]/g, '')
    .replace(/\b(usd|eur|gbp|cad|aud)\b/gi, '')
    .replace(/\s+/g, '')
    .replace(/,/g, '');
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed * sign : NaN;
}

function parseDateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  let raw = String(value).trim();
  if (!raw) return null;

  // Normalize AM/PM spacing (e.g. 8:10PM -> 8:10 PM)
  raw = raw.replace(/(\d+:\d+)\s*(am|pm)/i, '$1 $2');

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;

  const slashMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+(.+))?$/);
  if (slashMatch) {
    const first = Number(slashMatch[1]);
    const second = Number(slashMatch[2]);
    const year = Number(slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3]);
    const dayFirst = first > 12;
    const month = dayFirst ? second - 1 : first - 1;
    const day = dayFirst ? first : second;
    const parsed = new Date(year, month, day);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function formatDateInputValue(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function loadCachedMarketPrices() {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.warn('Failed to load cached crypto prices:', error);
    return {};
  }
}

function saveCachedMarketPrices(prices) {
  try {
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(prices || {}));
  } catch (error) {
    console.warn('Failed to cache crypto prices:', error);
  }
}

function loadCachedPortfolioPayload() {
  try {
    const raw = localStorage.getItem(PORTFOLIO_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('Failed to load cached crypto portfolio:', error);
    return null;
  }
}

function getPayloadTime(payload) {
  const time = Date.parse(payload?.updatedAt || payload?.cachedAt || '');
  return Number.isFinite(time) ? time : 0;
}

function getProfitPeriodRange(period, customStart, customEnd) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  if (period === 'thisYear') {
    return {
      label: `This Year (${currentYear})`,
      startMs: new Date(currentYear, 0, 1).getTime(),
      endMs: todayEnd.getTime(),
      isAllTime: false
    };
  }
  if (period === 'lastYear') {
    return {
      label: `Last Year (${currentYear - 1})`,
      startMs: new Date(currentYear - 1, 0, 1).getTime(),
      endMs: new Date(currentYear - 1, 11, 31, 23, 59, 59, 999).getTime(),
      isAllTime: false
    };
  }
  if (period === 'last12m') {
    const start = new Date(now);
    start.setFullYear(start.getFullYear() - 1);
    start.setHours(0, 0, 0, 0);
    return {
      label: 'Last 12 Months',
      startMs: start.getTime(),
      endMs: todayEnd.getTime(),
      isAllTime: false
    };
  }
  if (period === 'custom') {
    const start = parseDateValue(customStart) || new Date(currentYear, 0, 1);
    const end = parseDateValue(customEnd) || now;
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return {
      label: 'Custom Range',
      startMs: start.getTime(),
      endMs: end.getTime(),
      isAllTime: false
    };
  }
  return {
    label: 'All Time',
    startMs: null,
    endMs: todayEnd.getTime(),
    isAllTime: true
  };
}

function buildPositionStats(transactions) {
  const map = {};
  const sortedTransactions = [...transactions].sort((a, b) => new Date(a.date) - new Date(b.date));

  sortedTransactions.forEach(tx => {
    const symbol = normalizeSymbol(tx.symbol);
    const amount = Number(tx.amount);
    const price = Number(tx.price);
    const fee = Math.max(0, Number(tx.fee || 0));
    const dateMs = new Date(tx.date).getTime();
    
    // We allow price >= 0 so that free airdrops or zero-price entries are parsed correctly.
    if (!symbol || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price) || price < 0) return;

    if (!map[symbol]) {
      map[symbol] = {
        symbol,
        amount: 0,
        totalCost: 0,
        realizedProfitLoss: 0,
        buyCount: 0,
        sellCount: 0,
        totalBought: 0,
        totalSold: 0
      };
    }

    const position = map[symbol];
    if (tx.type === 'sell') {
      const heldBeforeSale = Math.max(position.amount, 0);
      const amountSoldFromHoldings = Math.min(amount, heldBeforeSale);
      const averageCost = heldBeforeSale > 0 ? position.totalCost / heldBeforeSale : 0;
      const proceeds = Math.max(0, (amountSoldFromHoldings * price) - fee);
      const costBasis = averageCost * amountSoldFromHoldings;
      const realizedProfitLoss = proceeds - costBasis;

      position.realizedProfitLoss += realizedProfitLoss;
      position.totalCost = Math.max(0, position.totalCost - costBasis);
      position.amount = Math.max(0, heldBeforeSale - amountSoldFromHoldings);
      position.sellCount += 1;
      position.totalSold += proceeds;
    } else {
      position.amount += amount;
      position.totalCost += (amount * price) + fee;
      position.buyCount += 1;
      position.totalBought += (amount * price) + fee;
    }
  });

  return map;
}

function computeHoldingsAtTime(transactions, targetMs) {
  const map = {};
  transactions.forEach(tx => {
    const dateMs = new Date(tx.date).getTime();
    if (!Number.isFinite(dateMs) || dateMs > targetMs) return;
    const symbol = normalizeSymbol(tx.symbol);
    const amount = Number(tx.amount);
    if (!symbol || !Number.isFinite(amount)) return;
    map[symbol] = (map[symbol] || 0) + (tx.type === 'sell' ? -amount : amount);
  });

  Object.keys(map).forEach(symbol => {
    if (Math.abs(map[symbol]) < 1e-12) delete map[symbol];
  });
  return map;
}

// Mini SVG Sparkline Component
function Sparkline({ data = [], change24h }) {
  if (!data || data.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>N/A</div>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const width = 70;
  const height = 20;

  const points = data.map((val, idx) => {
    const x = (idx / (data.length - 1)) * width;
    const y = height - ((val - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');

  const stroke = change24h >= 0 ? '#10b981' : '#ef4444';

  return (
    <svg width={width} height={height} style={{ overflow: 'visible', verticalAlign: 'middle' }}>
      <polyline fill="none" stroke={stroke} strokeWidth="1.5" points={points} />
    </svg>
  );
}

export default function CryptoPortfolioTracker() {
  const [activeSubTab, setActiveSubTab] = useState('portfolio'); // portfolio, market, transactions, settings
  const [transactions, setTransactions] = useState([]);
  const [watchlist, setWatchlist] = useState(DEFAULT_WATCHLIST);
  const [symbolGeckoIds, setSymbolGeckoIds] = useState({ ...DEFAULT_GECKO_IDS });
  const [marketPrices, setMarketPrices] = useState(() => loadCachedMarketPrices());
  const [historyData, setHistoryData] = useState({});
  const [timeframe, setTimeframe] = useState('30d'); // 24h, 7d, 30d, 90d, ALL
  const [syncStatus, setSyncStatus] = useState('Local Only');
  const [importMessage, setImportMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshingPrices, setIsRefreshingPrices] = useState(false);

  // Ref to prevent saving before initial load completes
  const hasLoadedRef = useRef(false);
  const portfolioUpdatedAtRef = useRef(0);
  const lastLocalMutationAtRef = useRef(0);
  const cloudLoadRequestRef = useRef(0);
  const priceRefreshInFlightRef = useRef(false);

  // Form states for adding/editing transaction manually
  const [showTxModal, setShowTxModal] = useState(false);
  const [editingTxId, setEditingTxId] = useState(null);
  const [txSymbol, setTxSymbol] = useState('BTC');
  const [txType, setTxType] = useState('buy'); // buy, sell
  const [txAmount, setTxAmount] = useState('');
  const [txPrice, setTxPrice] = useState('');
  const [txTotalSpent, setTxTotalSpent] = useState('');
  const [txFee, setTxFee] = useState('');
  const [txDate, setTxDate] = useState(() => new Date().toISOString().substring(0, 16));

  // Search WATCHLIST state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchedCoinResult, setSearchedCoinResult] = useState(null);
  const [searchError, setSearchError] = useState('');

  // Performance range P&L
  const [profitPeriod, setProfitPeriod] = useState('all');
  const [customPeriodStart, setCustomPeriodStart] = useState(() => formatDateInputValue(new Date(new Date().getFullYear(), 0, 1)));
  const [customPeriodEnd, setCustomPeriodEnd] = useState(() => formatDateInputValue(new Date()));

  // Sorting state for holdings table
  const [sortConfig, setSortConfig] = useState({ key: 'currentValue', direction: 'desc' });
  // View mode state for holdings P/L
  const [plViewMode, setPlViewMode] = useState('unrealized'); // 'unrealized' or 'total'

  // Detailed Coin Modal state
  const [selectedCoinDetails, setSelectedCoinDetails] = useState(null);

  // Tooltip state for SVG Line Chart
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const [hoverCoords, setHoverCoords] = useState({ x: 0, y: 0 });
  const chartRef = useRef(null);
  const importFileInputRef = useRef(null);

  // Transaction tab filter state
  const [txFilterSymbol, setTxFilterSymbol] = useState('');

  // Load portfolio on mount
  useEffect(() => {
    loadPortfolioData();
  }, []);

  // Save portfolio when transactions, watchlist or mappings change (ONLY after initial load completes)
  useEffect(() => {
    if (hasLoadedRef.current) {
      const timer = window.setTimeout(() => {
        savePortfolioData();
      }, 750);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [transactions, watchlist, symbolGeckoIds]);

  // Pause polling while the app is hidden so tray operation does not keep
  // waking the renderer and network.
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (!document.hidden) fetchAllPrices();
    };
    refreshWhenVisible();
    const interval = setInterval(refreshWhenVisible, 60000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [transactions, watchlist, symbolGeckoIds]);

  // Fetch historical data for charts
  useEffect(() => {
    fetchHistoricalData();
  }, [transactions, timeframe, symbolGeckoIds]);

  // Compute reverse mapping for lookup, always keeping defaults as fallback
  const geckoIdToSymbol = useMemo(() => {
    const rev = {};
    // Map defaults first
    Object.entries(DEFAULT_GECKO_IDS).forEach(([sym, id]) => {
      rev[id] = sym;
    });
    // Map custom overrides
    Object.entries(symbolGeckoIds).forEach(([sym, id]) => {
      if (id) rev[id] = sym;
    });
    return rev;
  }, [symbolGeckoIds]);

  // Helper to safely merge loaded mappings with defaults
  const getMergedMappings = (loadedMappings) => {
    return mergeGeckoMappings(loadedMappings);
  };

  const applyPortfolioPayload = (parsed, source = 'local') => {
    if (!parsed || typeof parsed !== 'object') return false;

    const normalizedTransactions = Array.isArray(parsed.transactions)
      ? parsed.transactions.map(tx => ({ ...tx, symbol: normalizeSymbol(tx.symbol) })).filter(tx => tx.symbol)
      : [];
    const normalizedWatchlist = Array.isArray(parsed.watchlist) && parsed.watchlist.length > 0
      ? uniqueSymbols(parsed.watchlist)
      : DEFAULT_WATCHLIST;

    setTransactions(normalizedTransactions);
    setWatchlist(normalizedWatchlist.length > 0 ? normalizedWatchlist : DEFAULT_WATCHLIST);

    const loaded = parsed.symbolGeckoIds || parsed.coinGeckoIds;
    setSymbolGeckoIds(getMergedMappings(loaded));

    portfolioUpdatedAtRef.current = getPayloadTime(parsed) || Date.now();
    if (source === 'cloud') {
      localStorage.setItem(PORTFOLIO_CACHE_KEY, JSON.stringify({
        ...parsed,
        updatedAt: parsed.updatedAt || new Date(portfolioUpdatedAtRef.current).toISOString(),
        cachedAt: new Date().toISOString()
      }));
    }
    return true;
  };

  const finishInitialPortfolioLoad = () => {
    setTimeout(() => {
      hasLoadedRef.current = true;
      setIsLoading(false);
    }, 50);
  };

  const loadCloudPortfolioSnapshot = async ({ requestId, startedAt, allowApply = true } = {}) => {
    if (!ipcRenderer) return false;

    try {
      setSyncStatus(prev => (prev === 'Cached' || prev === 'Local Only') ? `${prev} - syncing...` : 'Syncing...');
      const encData = await ipcRenderer.invoke('fastSync:download', { appName: 'Crypto', fileName: 'portfolio.vscrypto' });
      if (!encData) {
        setSyncStatus('Local Only');
        return false;
      }

      const rawJson = await ipcRenderer.invoke('crypt:decrypt', { base64Data: encData });
      const parsed = JSON.parse(rawJson);
      const cloudTime = getPayloadTime(parsed);
      const localChangedAfterStart = lastLocalMutationAtRef.current > (startedAt || 0);
      const cloudIsNewer = cloudTime >= portfolioUpdatedAtRef.current;

      if (
        allowApply &&
        requestId === cloudLoadRequestRef.current &&
        (!localChangedAfterStart || cloudIsNewer)
      ) {
        hasLoadedRef.current = false;
        applyPortfolioPayload(parsed, 'cloud');
        finishInitialPortfolioLoad();
      }

      setSyncStatus('Synced');
      return true;
    } catch (err) {
      console.warn('Crypto cloud sync failed; keeping local cached portfolio:', err);
      setSyncStatus(portfolioUpdatedAtRef.current ? 'Cached' : 'Local Only');
      return false;
    }
  };

  // ----------------------------------------------------
  // Data Loading & Syncing
  // ----------------------------------------------------
  const loadPortfolioData = async ({ forceCloud = false } = {}) => {
    const requestId = cloudLoadRequestRef.current + 1;
    cloudLoadRequestRef.current = requestId;
    const startedAt = Date.now();
    hasLoadedRef.current = false;

    const localPayload = loadCachedPortfolioPayload();
    const hasLocalPayload = !!localPayload && applyPortfolioPayload(localPayload, 'local');

    if (hasLocalPayload && !forceCloud) {
      setSyncStatus('Cached');
      finishInitialPortfolioLoad();
      loadCloudPortfolioSnapshot({ requestId, startedAt }).catch(() => {});
      return;
    }

    setIsLoading(!hasLocalPayload);
    if (hasLocalPayload) {
      setSyncStatus('Cached - syncing...');
      finishInitialPortfolioLoad();
    } else {
      setSyncStatus('Syncing...');
    }

    const cloudLoaded = await loadCloudPortfolioSnapshot({ requestId, startedAt });
    if (!cloudLoaded && !hasLocalPayload) {
      setTransactions([]);
      setWatchlist(DEFAULT_WATCHLIST);
      setSymbolGeckoIds(getMergedMappings({}));
      setSyncStatus('Local Only');
      finishInitialPortfolioLoad();
    }
  };

  const savePortfolioData = async (overrides = {}) => {
    const updatedAt = new Date().toISOString();
    lastLocalMutationAtRef.current = Date.now();
    portfolioUpdatedAtRef.current = lastLocalMutationAtRef.current;
    const nextTransactions = Array.isArray(overrides.transactions) ? overrides.transactions : transactions;
    const nextWatchlist = Array.isArray(overrides.watchlist) ? overrides.watchlist : watchlist;
    const nextSymbolGeckoIds = overrides.symbolGeckoIds && typeof overrides.symbolGeckoIds === 'object'
      ? overrides.symbolGeckoIds
      : symbolGeckoIds;
    const payload = {
      transactions: nextTransactions.map(tx => ({ ...tx, symbol: normalizeSymbol(tx.symbol) })).filter(tx => tx.symbol),
      watchlist: uniqueSymbols(nextWatchlist.length > 0 ? nextWatchlist : DEFAULT_WATCHLIST),
      symbolGeckoIds: getMergedMappings(nextSymbolGeckoIds),
      updatedAt
    };

    localStorage.setItem(PORTFOLIO_CACHE_KEY, JSON.stringify(payload));

    if (ipcRenderer) {
      try {
        const rawJson = JSON.stringify(payload);
        const encData = await ipcRenderer.invoke('crypt:encrypt', { text: rawJson });
        await ipcRenderer.invoke('fastSync:upload', { 
          appName: 'Crypto', 
          fileName: 'portfolio.vscrypto', 
          data: encData 
        });
        setSyncStatus('Synced');
      } catch (err) {
        console.warn('Failed to encrypt/sync portfolio to cloud:', err);
        setSyncStatus('Error');
      }
    } else {
      setSyncStatus('Local Only');
    }
  };

  // ----------------------------------------------------
  // CoinGecko API fetching (Via main process IPC handlers to bypass CSP)
  // ----------------------------------------------------
  const fetchAllPrices = async () => {
    if (priceRefreshInFlightRef.current) return;
    priceRefreshInFlightRef.current = true;
    setIsRefreshingPrices(true);

    const activeSymbols = uniqueSymbols([
      ...POPULAR_COINS,
      ...watchlist,
      ...transactions.map(t => t.symbol)
    ]);

    if (activeSymbols.length === 0) {
      priceRefreshInFlightRef.current = false;
      setIsRefreshingPrices(false);
      return;
    }

    const symbolToGeckoId = activeSymbols.reduce((map, symbol) => {
      map[symbol] = normalizeGeckoId(symbolGeckoIds[symbol] || DEFAULT_GECKO_IDS[symbol] || symbol.toLowerCase());
      return map;
    }, {});
    const geckoIds = Array.from(new Set(Object.values(symbolToGeckoId).filter(Boolean)));

    const requestMarketData = async (ids) => {
      const cleanIds = Array.from(new Set((ids || []).map(normalizeGeckoId).filter(Boolean)));
      if (cleanIds.length === 0) return [];
      if (ipcRenderer) {
        return ipcRenderer.invoke('crypto:marketData', { ids: cleanIds });
      }
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${cleanIds.join(',')}&order=market_cap_desc&per_page=${Math.min(cleanIds.length, 250)}&page=1&sparkline=true`;
      const res = await fetch(url);
      return res.json();
    };

    try {
      let json = await requestMarketData(geckoIds);

      if (Array.isArray(json) && json.length > 0) {
        const newPrices = {};
        const returnedIds = new Set();
        json.forEach(coin => {
          returnedIds.add(coin.id);
          const symbol = geckoIdToSymbol[coin.id] || normalizeSymbol(coin.symbol);
          if (!symbol) return;
          newPrices[symbol] = {
            price: Number.isFinite(Number(coin.current_price)) ? Number(coin.current_price) : 0,
            change24h: Number.isFinite(Number(coin.price_change_percentage_24h)) ? Number(coin.price_change_percentage_24h) : 0,
            mcap: Number.isFinite(Number(coin.market_cap)) ? Number(coin.market_cap) : 0,
            volume: Number.isFinite(Number(coin.total_volume)) ? Number(coin.total_volume) : 0,
            imageUrl: coin.image || '',
            sparkline: coin.sparkline_in_7d?.price || []
          };
        });

        const missingKnownSymbols = activeSymbols.filter(symbol => {
          const defaultId = DEFAULT_GECKO_IDS[symbol];
          return defaultId && !newPrices[symbol] && symbolToGeckoId[symbol] !== defaultId && !returnedIds.has(defaultId);
        });

        if (missingKnownSymbols.length > 0) {
          const fallbackIds = missingKnownSymbols.map(symbol => DEFAULT_GECKO_IDS[symbol]);
          const fallbackJson = await requestMarketData(fallbackIds);
          if (Array.isArray(fallbackJson)) {
            fallbackJson.forEach(coin => {
              const symbol = Object.entries(DEFAULT_GECKO_IDS).find(([, id]) => id === coin.id)?.[0];
              if (!symbol) return;
              newPrices[symbol] = {
                price: Number.isFinite(Number(coin.current_price)) ? Number(coin.current_price) : 0,
                change24h: Number.isFinite(Number(coin.price_change_percentage_24h)) ? Number(coin.price_change_percentage_24h) : 0,
                mcap: Number.isFinite(Number(coin.market_cap)) ? Number(coin.market_cap) : 0,
                volume: Number.isFinite(Number(coin.total_volume)) ? Number(coin.total_volume) : 0,
                imageUrl: coin.image || '',
                sparkline: coin.sparkline_in_7d?.price || []
              };
            });
          }
        }

        setMarketPrices(prev => {
          const merged = { ...prev, ...newPrices };
          saveCachedMarketPrices(merged);
          return merged;
        });
      } else {
        console.warn('CoinGecko returned no market prices; keeping existing cached quotes.');
      }
    } catch (e) {
      console.error('Failed to fetch CoinGecko market prices:', e);
    } finally {
      priceRefreshInFlightRef.current = false;
      setIsRefreshingPrices(false);
    }
  };

  const fetchHistoricalData = async () => {
    const portfolioSymbols = uniqueSymbols(transactions.map(t => t.symbol));
    if (portfolioSymbols.length === 0) return;

    let days = '30';
    if (timeframe === '24h') days = '1';
    else if (timeframe === '7d') days = '7';
    else if (timeframe === '90d') days = '90';
    else if (timeframe === 'ALL') days = 'max';

    const loadedHistory = {};

    try {
      await forEachWithConcurrency(portfolioSymbols, 4, async (sym) => {
        const savedId = normalizeGeckoId(symbolGeckoIds[sym] || DEFAULT_GECKO_IDS[sym]);
        const id = DEFAULT_GECKO_IDS[sym] && isTickerFallbackId(sym, savedId)
          ? DEFAULT_GECKO_IDS[sym]
          : savedId;
        if (!id) return;

        let json = null;
        try {
          if (ipcRenderer) {
            json = await ipcRenderer.invoke('crypto:history', { coinId: id, days });
          } else {
            const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`;
            const res = await fetch(url);
            json = await res.json();
          }
        } catch (e) {
          console.warn(`History fetch failed for ${sym} (${id}):`, e);
        }
        
        if (json && json.prices && Array.isArray(json.prices)) {
          loadedHistory[sym] = json.prices.map(([time, price]) => ({
            time,
            close: price
          }));
        }
      });
      setHistoryData(loadedHistory);
    } catch (e) {
      console.error('Failed to fetch historical data from CoinGecko:', e);
    }
  };

  const searchCoin = async () => {
    if (!searchQuery) return;
    setSearchError('');
    setSearchedCoinResult(null);
    try {
      const querySymbol = normalizeSymbol(searchQuery);
      const symbol = searchQuery.trim().toLowerCase();
      let searchJson = null;
      let match = DEFAULT_GECKO_IDS[querySymbol]
        ? { id: DEFAULT_GECKO_IDS[querySymbol], symbol: querySymbol, name: querySymbol }
        : null;

      if (!match) {
        if (ipcRenderer) {
          searchJson = await ipcRenderer.invoke('crypto:search', { query: symbol });
        } else {
          const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${symbol}`);
          searchJson = await res.json();
        }
      }

      if (match || (searchJson && searchJson.coins && searchJson.coins.length > 0)) {
        if (!match) {
          match = searchJson.coins.find(c => normalizeSymbol(c.symbol) === querySymbol) || searchJson.coins[0];
        }
        
        let detailJson = null;
        if (ipcRenderer) {
          detailJson = await ipcRenderer.invoke('crypto:marketData', { ids: [match.id] });
        } else {
          const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${match.id}&order=market_cap_desc&per_page=1&page=1&sparkline=false`);
          detailJson = await res.json();
        }

        if (Array.isArray(detailJson) && detailJson.length > 0) {
          const coinData = detailJson[0];
          setSearchedCoinResult({
            symbol: normalizeSymbol(coinData.symbol),
            geckoId: coinData.id,
            price: Number.isFinite(Number(coinData.current_price)) ? Number(coinData.current_price) : 0,
            change24h: Number.isFinite(Number(coinData.price_change_percentage_24h)) ? Number(coinData.price_change_percentage_24h) : 0,
            mcap: Number.isFinite(Number(coinData.market_cap)) ? Number(coinData.market_cap) : 0,
            volume: Number.isFinite(Number(coinData.total_volume)) ? Number(coinData.total_volume) : 0,
            imageUrl: coinData.image || ''
          });
        } else {
          setSearchError(`Coin details for "${match.name}" could not be retrieved.`);
        }
      } else {
        setSearchError(`Symbol or name "${searchQuery}" not found on CoinGecko.`);
      }
    } catch (e) {
      setSearchError('Search failed. Check your internet connection.');
    }
  };

  // Helper to open and filter transactions for a coin
  const viewTransactionsForCoin = (symbol) => {
    setTxFilterSymbol(normalizeSymbol(symbol));
    setActiveSubTab('transactions');
  };

  // Trigger sorting
  const requestSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  // ----------------------------------------------------
  // Portfolio Calculations
  // ----------------------------------------------------
  const positionStats = useMemo(() => buildPositionStats(transactions), [transactions]);

  const holdings = useMemo(() => {
    const result = [];
    Object.keys(positionStats).forEach(sym => {
      const holding = positionStats[sym];
      if (holding.amount <= 0) return; // Hide if fully sold out

      const rawCurrentPrice = Number(marketPrices[sym]?.price);
      const hasLivePrice = Number.isFinite(rawCurrentPrice) && rawCurrentPrice > 0;
      const currentPrice = hasLivePrice ? rawCurrentPrice : 0;
      const currentValue = holding.amount * currentPrice;
      const averageBuyPrice = holding.amount > 0 ? (holding.totalCost / holding.amount) : 0;
      
      // Unrealized metrics
      const unrealizedProfitLoss = currentValue - holding.totalCost;
      const unrealizedProfitLossPct = holding.totalCost > 0 ? (unrealizedProfitLoss / holding.totalCost) * 100 : 0;

      // Realized and Lifetime metrics
      const realizedProfitLoss = holding.realizedProfitLoss || 0;
      const totalProfitLoss = unrealizedProfitLoss + realizedProfitLoss;
      const totalProfitLossPct = holding.totalBought > 0 ? (totalProfitLoss / holding.totalBought) * 100 : 0;
      const totalBought = holding.totalBought || 0;
      const totalSold = holding.totalSold || 0;
      const lifetimeNetResult = totalSold + currentValue - totalBought;
      const lifetimeReturnPct = totalBought > 0 ? (lifetimeNetResult / totalBought) * 100 : 0;

      result.push({
        symbol: sym,
        amount: holding.amount,
        averageBuyPrice,
        totalCost: holding.totalCost,
        totalBought,
        totalSold,
        currentPrice,
        hasLivePrice,
        currentValue,
        profitLoss: plViewMode === 'unrealized' ? unrealizedProfitLoss : totalProfitLoss,
        profitLossPct: plViewMode === 'unrealized' ? unrealizedProfitLossPct : totalProfitLossPct,
        unrealizedProfitLoss,
        unrealizedProfitLossPct,
        realizedProfitLoss,
        totalProfitLoss,
        totalProfitLossPct,
        lifetimeNetResult,
        lifetimeReturnPct,
        change24h: marketPrices[sym]?.change24h || 0,
        imageUrl: marketPrices[sym]?.imageUrl || '',
        sparkline: marketPrices[sym]?.sparkline || [],
        buyCount: holding.buyCount,
        sellCount: holding.sellCount
      });
    });

    return result;
  }, [positionStats, marketPrices, plViewMode]);

  // Sorted holdings
  const sortedHoldings = useMemo(() => {
    const sortable = [...holdings];
    if (sortConfig.key) {
      sortable.sort((a, b) => {
        let aVal = a[sortConfig.key];
        let bVal = b[sortConfig.key];

        if (typeof aVal === 'string') {
          return sortConfig.direction === 'asc'
            ? aVal.localeCompare(bVal)
            : bVal.localeCompare(aVal);
        }

        return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal;
      });
    }
    return sortable;
  }, [holdings, sortConfig]);

  const portfolioTotals = useMemo(() => {
    let totalValue = 0;
    let totalCost = 0;
    let bestAsset = null;
    let worstAsset = null;

    holdings.forEach(h => {
      totalValue += h.currentValue;
      totalCost += h.totalCost;

      if (!bestAsset || h.profitLossPct > bestAsset.profitLossPct) {
        bestAsset = h;
      }
      if (!worstAsset || h.profitLossPct < worstAsset.profitLossPct) {
        worstAsset = h;
      }
    });

    const totalProfitLoss = totalValue - totalCost;
    const totalProfitLossPct = totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0;

    return {
      totalValue,
      totalCost,
      totalProfitLoss,
      totalProfitLossPct,
      bestAsset,
      worstAsset
    };
  }, [holdings]);

  // Compute period boundaries P&L
  const periodPerformance = useMemo(() => {
    const range = getProfitPeriodRange(profitPeriod, customPeriodStart, customPeriodEnd);
    
    let startingValue = 0;
    let endingValue = 0;

    if (range.isAllTime) {
      startingValue = 0;
      endingValue = portfolioTotals.totalValue;
    } else {
      // Reconstruct holdings at start and end timestamps of range
      const startHoldings = computeHoldingsAtTime(transactions, range.startMs - 1);
      const endHoldings = computeHoldingsAtTime(transactions, range.endMs);
      const allSyms = Array.from(new Set([...Object.keys(startHoldings), ...Object.keys(endHoldings)]));

      allSyms.forEach(sym => {
        const startAmt = startHoldings[sym] || 0;
        const endAmt = endHoldings[sym] || 0;
        const curPrice = marketPrices[sym]?.price || 0; 
        
        startingValue += startAmt * curPrice;
        endingValue += endAmt * curPrice;
      });
    }

    // Cash flow details inside period
    let cashIn = 0;
    let cashOut = 0;
    let fees = 0;

    transactions.forEach(tx => {
      const dateMs = new Date(tx.date).getTime();
      if (!range.isAllTime && (dateMs < range.startMs || dateMs > range.endMs)) return;

      const amt = Number(tx.amount);
      const price = Number(tx.price);
      const fee = Number(tx.fee || 0);

      fees += fee;
      if (tx.type === 'sell') {
        cashOut += (amt * price) - fee;
      } else {
        cashIn += (amt * price) + fee;
      }
    });

    const netCashFlow = cashIn - cashOut;
    const totalProfitLoss = endingValue - startingValue - netCashFlow;

    // Calculate realized and unrealized parts
    const realized = Object.values(positionStats).reduce((sum, item) => sum + item.realizedProfitLoss, 0);
    const unrealized = totalProfitLoss - realized;

    return {
      label: range.label,
      startingValue,
      endingValue,
      cashIn,
      cashOut,
      netCashFlow,
      fees,
      totalProfitLoss,
      realizedProfitLoss: realized,
      unrealizedProfitLoss: unrealized
    };
  }, [transactions, holdings, profitPeriod, customPeriodStart, customPeriodEnd, marketPrices, positionStats, portfolioTotals]);

  // Compute historical values of the portfolio for charting
  const portfolioHistory = useMemo(() => {
    const portfolioSymbols = uniqueSymbols(transactions.map(t => t.symbol));
    if (portfolioSymbols.length === 0) return [];

    // Filter to only consider symbols that actually have historyData available (fixes stuck charts)
    const validHistorySymbols = portfolioSymbols.filter(coin => historyData[coin] && historyData[coin].length > 0);
    if (validHistorySymbols.length === 0) return [];

    const firstCoin = validHistorySymbols[0];
    const timestamps = historyData[firstCoin].map(d => d.time);

    const historyPoints = timestamps.map(timestamp => {
      let dailyValue = 0;

      portfolioSymbols.forEach(coin => {
        let dayPrice = 0;
        const coinHistory = historyData[coin];
        
        if (coinHistory && coinHistory.length > 0) {
          const dayPricePoint = coinHistory.find(d => Math.abs(d.time - timestamp) < 3600000 * 2) || coinHistory[0];
          dayPrice = dayPricePoint ? dayPricePoint.close : 0;
        } else {
          // Fallback to current live price if no chart history is returned for this specific coin
          dayPrice = marketPrices[coin]?.price || 0;
        }

        let balanceAtTime = 0;
        transactions.forEach(tx => {
          if (normalizeSymbol(tx.symbol) === coin && new Date(tx.date).getTime() <= timestamp) {
            if (tx.type === 'buy') {
              balanceAtTime += Number(tx.amount);
            } else {
              balanceAtTime -= Number(tx.amount);
            }
          }
        });

        dailyValue += balanceAtTime * dayPrice;
      });

      return {
        timestamp,
        dateStr: new Date(timestamp).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: timeframe === '24h' || timeframe === '7d' ? '2-digit' : undefined
        }),
        value: dailyValue
      };
    });

    return historyPoints;
  }, [transactions, historyData, timeframe, marketPrices]);

  // Top Holdings for the Cost vs. Value Bar Chart
  const topHoldingsForBarChart = useMemo(() => {
    return [...holdings]
      .sort((a, b) => b.currentValue - a.currentValue)
      .slice(0, 6);
  }, [holdings]);

  // Filtered transactions for the transactions tab
  const filteredTransactions = useMemo(() => {
    if (!txFilterSymbol) return transactions;
    const filter = normalizeSymbol(txFilterSymbol);
    return transactions.filter(tx => normalizeSymbol(tx.symbol).includes(filter));
  }, [transactions, txFilterSymbol]);

  // ----------------------------------------------------
  // Action Handlers
  // ----------------------------------------------------
  const handleAddTransaction = (e) => {
    e.preventDefault();
    if (!txSymbol || !txAmount || !txPrice || !txDate) return;

    const symbol = normalizeSymbol(txSymbol);
    const amount = Number(txAmount);
    const price = Number(txPrice);
    const fee = Number(txFee || 0);

    if (txType === 'sell') {
      const currentHolding = holdings.find(h => h.symbol === symbol);
      let currentAmount = currentHolding ? currentHolding.amount : 0;
      
      // If we are editing, temporarily add back the transaction amount to bypass check
      if (editingTxId) {
        const originalTx = transactions.find(t => t.id === editingTxId);
        if (originalTx && originalTx.symbol === symbol && originalTx.type === 'sell') {
          currentAmount += originalTx.amount;
        }
      }
      
      if (amount > currentAmount) {
        alert(`Insufficient balance! You only hold ${currentAmount} ${symbol}.`);
        return;
      }
    }

    // We allow price >= 0 so that free airdrops or zero-price entries are parsed correctly.
    if (!symbol || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price) || price < 0) return;

    if (editingTxId) {
      // Update transaction
      setTransactions(prev => prev.map(t => 
        t.id === editingTxId 
          ? { ...t, symbol, type: txType, amount, price, fee, date: new Date(txDate).toISOString() }
          : t
      ));
    } else {
      // Create new transaction
      const newTx = {
        id: Date.now().toString(),
        symbol,
        type: txType,
        amount,
        price,
        fee,
        date: new Date(txDate).toISOString()
      };
      setTransactions(prev => [...prev, newTx]);
    }

    setShowTxModal(false);
    setEditingTxId(null);
    setTxAmount('');
    setTxPrice('');
    setTxTotalSpent('');
    setTxFee('');
  };

  const handleDeleteTransaction = (id) => {
    if (confirm('Are you sure you want to delete this transaction?')) {
      setTransactions(prev => prev.filter(tx => tx.id !== id));
    }
  };

  const handleRepairMarketData = () => {
    try {
      localStorage.removeItem(PRICE_CACHE_KEY);
    } catch (error) {
      console.warn('Failed to clear cached crypto prices:', error);
    }
    setMarketPrices({});
    setWatchlist(prev => uniqueSymbols(prev.length > 0 ? prev : DEFAULT_WATCHLIST));
    setSymbolGeckoIds(prev => getMergedMappings({ ...prev, ...DEFAULT_GECKO_IDS }));
    setImportMessage('Coin mappings repaired and cached prices cleared. Refreshing prices...');
  };

  const handleWatchlistAdd = (symbol, geckoId) => {
    const sym = normalizeSymbol(symbol);
    if (geckoId) {
      setSymbolGeckoIds(prev => getMergedMappings({ ...prev, [sym]: geckoId }));
    }
    setWatchlist(prev => prev.includes(sym) ? prev : [...prev, sym]);
    setSearchedCoinResult(null);
    setSearchQuery('');
  };

  const handleWatchlistRemove = (symbol) => {
    const sym = normalizeSymbol(symbol);
    setWatchlist(prev => prev.filter(s => normalizeSymbol(s) !== sym));
  };

  const openAddTransactionModal = (symbol = 'BTC', prefilledPrice = '') => {
    const sym = normalizeSymbol(symbol) || 'BTC';
    setTxSymbol(sym);
    const price = prefilledPrice || marketPrices[sym]?.price || '';
    setTxPrice(price.toString());
    setTxType('buy');
    setTxAmount('');
    setTxTotalSpent('');
    setTxFee('');
    setTxDate(new Date().toISOString().substring(0, 16));
    setEditingTxId(null);
    setShowTxModal(true);
  };

  const openEditTransactionModal = (tx) => {
    setTxSymbol(tx.symbol);
    setTxPrice(tx.price.toString());
    setTxType(tx.type);
    setTxAmount(tx.amount.toString());
    setTxTotalSpent((tx.amount * tx.price).toString());
    setTxFee(tx.fee ? tx.fee.toString() : '');
    
    // Format timezone offsets properly for datetime-local (YYYY-MM-DDTHH:MM)
    const localDate = new Date(tx.date);
    const offset = localDate.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(localDate - offset)).toISOString().slice(0, 16);
    
    setTxDate(localISOTime);
    setEditingTxId(tx.id);
    setShowTxModal(true);
  };

  // Pre-fill price when symbol changes
  useEffect(() => {
    if (marketPrices[txSymbol] && !editingTxId) {
      const price = marketPrices[txSymbol].price;
      setTxPrice(price.toString());
      const amt = Number(txAmount);
      if (Number.isFinite(amt) && amt > 0) {
        setTxTotalSpent((amt * price).toString());
      }
    }
  }, [txSymbol]);

  // Form input linkages for Total Spent / Quantity / Price per Coin
  const handleAmountChange = (val) => {
    setTxAmount(val);
    const amt = Number(val);
    const price = Number(txPrice);
    const spent = Number(txTotalSpent);
    if (Number.isFinite(amt) && amt > 0) {
      if (Number.isFinite(price) && price >= 0) {
        setTxTotalSpent((amt * price).toString());
      } else if (Number.isFinite(spent) && spent >= 0) {
        setTxPrice((spent / amt).toString());
      }
    }
  };

  const handlePriceChange = (val) => {
    setTxPrice(val);
    const price = Number(val);
    const amt = Number(txAmount);
    if (Number.isFinite(price) && price >= 0) {
      if (Number.isFinite(amt) && amt > 0) {
        setTxTotalSpent((amt * price).toString());
      }
    }
  };

  const handleTotalSpentChange = (val) => {
    setTxTotalSpent(val);
    const spent = Number(val);
    const amt = Number(txAmount);
    const price = Number(txPrice);
    if (Number.isFinite(spent) && spent >= 0) {
      if (Number.isFinite(amt) && amt > 0) {
        setTxPrice((spent / amt).toString());
      } else if (Number.isFinite(price) && price > 0) {
        setTxAmount((spent / price).toString());
      }
    }
  };

  // ----------------------------------------------------
  // CSV Importer Parsing logic
  // ----------------------------------------------------
  const handleImportTransactionsCsv = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const rows = parseCsv(String(reader.result || ''));
        if (rows.length < 2) {
          setImportMessage('CSV import did not find any transaction rows.');
          return;
        }

        const headers = rows[0].map(header => header.trim());
        const normalizedHeaders = headers.map(normalizeCsvHeader);

        const importedTransactions = [];
        const importedWatchlist = new Set();
        const resolvedMappings = {};
        let skippedCount = 0;
        let feeCount = 0;

        rows.slice(1).forEach((row, index) => {
          const rawSymbol = readCsvValue(row, normalizedHeaders, ['symbol', 'ticker', 'asset', 'currency', 'coin_symbol', 'coin ticker']);
          const rawType = readCsvValue(row, normalizedHeaders, ['type', 'transaction_type', 'transaction type', 'side', 'action', 'operation']).toLowerCase().trim();
          
          let type = rawType;
          if (/(sell|sold|withdraw|withdrawal|out|send|sent)/.test(type)) type = 'sell';
          if (/(buy|bought|deposit|receive|received|in)/.test(type)) type = 'buy';

          let amount = parseNumericValue(readCsvValue(row, normalizedHeaders, ['amount', 'quantity', 'qty', 'units', 'coin_amount', 'coin amount', 'crypto_amount', 'crypto amount']));
          const price = parseNumericValue(readCsvValue(row, normalizedHeaders, ['price', 'price_per_coin', 'price per coin', 'price_per_unit', 'price per unit', 'unit_price', 'unit price']));
          const fee = Math.max(0, parseNumericValue(readCsvValue(row, normalizedHeaders, ['fee', 'fees', 'fee_amount', 'fee amount', 'commission', 'network_fee', 'network fee'])) || 0);
          const rawDate = readCsvValue(row, normalizedHeaders, ['date', 'datetime', 'date_time', 'date time', 'time', 'timestamp', 'transaction_date', 'transaction date', 'created_at', 'created at']).trim();
          const parsedDate = parseDateValue(rawDate);
          const notes = readCsvValue(row, normalizedHeaders, ['note', 'notes', 'memo', 'description']).trim();

          const symbol = normalizeSymbol(rawSymbol);

          if (!['buy', 'sell'].includes(type) && Number.isFinite(amount) && amount < 0) {
            type = 'sell';
          }
          if (Number.isFinite(amount)) {
            amount = Math.abs(amount);
          }

          // Allow price to be 0 (for free claims, swaps, promotions, or airdrops)
          if (
            !symbol
            || !['buy', 'sell'].includes(type)
            || !Number.isFinite(amount)
            || amount <= 0
            || !Number.isFinite(price)
            || price < 0
            || !parsedDate
          ) {
            skippedCount += 1;
            return;
          }

          const id = `import_${Date.now()}_${index}`;
          importedTransactions.push({
            id,
            symbol,
            type,
            amount,
            price,
            fee,
            date: parsedDate.toISOString(),
            source: 'CSV Import',
            notes
          });

          if (fee > 0) feeCount += 1;
          importedWatchlist.add(symbol);
        });

        if (importedTransactions.length > 0) {
          // Resolve missing coin IDs locally or online (using IPC resolver fallback to bypass CSP)
          const finalMappings = { ...resolvedMappings };
          const unmappedSymbols = Array.from(new Set(
            importedTransactions.map(tx => tx.symbol)
          )).filter(sym => !symbolGeckoIds[sym] && !finalMappings[sym]);

          if (unmappedSymbols.length > 0) {
            setImportMessage(`Imported ${importedTransactions.length} transactions. Resolving coin identities...`);
            
            let coinsList = null;
            try {
              const cached = localStorage.getItem('labsuite_coingecko_coins_list');
              if (cached) {
                coinsList = JSON.parse(cached);
              } else if (!ipcRenderer) {
                // Browser-only fallback. Electron resolves identities through
                // the main-process search API below, which is not CSP-limited.
                const res = await fetch('https://api.coingecko.com/api/v3/coins/list');
                if (res.ok) {
                  const list = await res.json();
                  if (Array.isArray(list) && list.length > 0) {
                    localStorage.setItem('labsuite_coingecko_coins_list', JSON.stringify(list));
                    coinsList = list;
                  }
                }
              }
            } catch (err) {
              console.warn('Failed to load CoinGecko coins list:', err);
            }

            for (const symbol of unmappedSymbols) {
              let matchedId = null;
              if (DEFAULT_GECKO_IDS[symbol]) {
                matchedId = DEFAULT_GECKO_IDS[symbol];
              }
              if (coinsList) {
                const symbolLower = symbol.toLowerCase();
                const match = coinsList.find(c => c.symbol.toLowerCase() === symbolLower);
                if (match && !matchedId) matchedId = match.id;
              }

              if (!matchedId) {
                try {
                  const query = symbol.toLowerCase();
                  let json = null;
                  if (ipcRenderer) {
                    json = await ipcRenderer.invoke('crypto:search', { query });
                  } else {
                    const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${query}`);
                    json = await res.json();
                  }
                  if (json && json.coins && json.coins.length > 0) {
                    const match = json.coins.find(c => normalizeSymbol(c.symbol) === symbol) || json.coins[0];
                    matchedId = match.id;
                  }
                } catch (e) {
                  console.warn(`Failed to resolve online CoinGecko ID for ${symbol}:`, e);
                }
              }

              if (matchedId) {
                finalMappings[symbol] = matchedId;
              }
            }
          }

          // Avoid duplicates both against saved transactions and within this
          // CSV file itself.
          const transactionKey = tx => [
            tx.symbol,
            tx.type,
            Number(tx.amount).toFixed(8),
            Number(tx.price).toFixed(6),
            Math.round(new Date(tx.date).getTime() / 5000)
          ].join('|');
          const seenTransactionKeys = new Set(transactions.map(transactionKey));
          const deduplicated = importedTransactions.filter(newTx => {
            const key = transactionKey(newTx);
            if (seenTransactionKeys.has(key)) return false;
            seenTransactionKeys.add(key);
            return true;
          });

          if (deduplicated.length > 0) {
            setTransactions(prev => [...prev, ...deduplicated]);
            if (Object.keys(finalMappings).length > 0) {
              setSymbolGeckoIds(prev => getMergedMappings({ ...prev, ...finalMappings }));
            }
            setWatchlist(prev => uniqueSymbols([...prev, ...Array.from(importedWatchlist)]));
            setImportMessage(`Imported ${deduplicated.length} transactions${skippedCount ? `, skipped ${skippedCount} rows` : ''}${feeCount ? `, included fees on ${feeCount} rows` : ''}.`);
          } else {
            setImportMessage(`All transactions skipped (already imported).`);
          }
        } else {
          setImportMessage('No valid transaction records found.');
        }

      } catch (error) {
        setImportMessage(`CSV import failed: ${error.message || 'invalid file'}`);
      } finally {
        event.target.value = '';
      }
    };
    reader.readAsText(file);
  };

  // ----------------------------------------------------
  // SVG Chart Computations (Line Chart)
  // ----------------------------------------------------
  const chartProps = useMemo(() => {
    if (portfolioHistory.length === 0) return null;

    const values = portfolioHistory.map(d => d.value);
    const minVal = Math.min(...values) * 0.95;
    const maxVal = Math.max(...values) * 1.05;
    const diff = maxVal - minVal || 1;

    const width = 600;
    const height = 240;
    const padding = { top: 20, right: 20, bottom: 30, left: 60 };

    const points = portfolioHistory.map((d, i) => {
      const x = portfolioHistory.length === 1
        ? (padding.left + width - padding.right) / 2
        : padding.left + (i / (portfolioHistory.length - 1)) * (width - padding.left - padding.right);
      const y = height - padding.bottom - ((d.value - minVal) / diff) * (height - padding.top - padding.bottom);
      return { x, y, data: d };
    });

    let linePath = '';
    let areaPath = '';

    if (points.length > 0) {
      linePath = `M ${points[0].x} ${points[0].y} ` + points.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ');
      areaPath = `${linePath} L ${points[points.length - 1].x} ${height - padding.bottom} L ${points[0].x} ${height - padding.bottom} Z`;
    }

    return {
      width,
      height,
      padding,
      points,
      linePath,
      areaPath,
      minVal,
      maxVal
    };
  }, [portfolioHistory]);

  const handleChartMouseMove = (e) => {
    if (!chartProps || !chartRef.current) return;
    const rect = chartRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const svgMouseX = (mouseX / rect.width) * chartProps.width;

    let nearest = null;
    let minDist = Infinity;

    chartProps.points.forEach(p => {
      const dist = Math.abs(p.x - svgMouseX);
      if (dist < minDist) {
        minDist = dist;
        nearest = p;
      }
    });

    if (nearest && minDist < 40) {
      setHoveredPoint(nearest.data);
      setHoverCoords({ x: nearest.x, y: nearest.y - 65 });
    } else {
      setHoveredPoint(null);
    }
  };

  const handleChartMouseLeave = () => {
    setHoveredPoint(null);
  };

  // ----------------------------------------------------
  // Donut Chart Computations (Asset Allocation)
  // ----------------------------------------------------
  const donutSlices = useMemo(() => {
    const total = portfolioTotals.totalValue;
    if (total === 0) return [];

    let accumulatedAngle = 0;
    const palette = [
      '#408A71', '#B0E4CC', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'
    ];

    return holdings.map((h, index) => {
      const pct = h.currentValue / total;
      const angle = pct * 360;
      const color = palette[index % palette.length];
      const slice = {
        symbol: h.symbol,
        pct,
        color,
        angle,
        startAngle: accumulatedAngle
      };
      accumulatedAngle += angle;
      return slice;
    });
  }, [holdings, portfolioTotals]);

  // Sort Indicator helper
  const getSortIndicator = (key) => {
    if (sortConfig.key !== key) return ' ↕';
    return sortConfig.direction === 'asc' ? ' ▲' : ' ▼';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', padding: '24px' }}>
      
      {/* Styles Injection */}
      <style>{`
        .crypto-tab-btn {
          padding: 8px 16px;
          background: transparent;
          border: none;
          color: var(--text-secondary);
          cursor: pointer;
          font-weight: 500;
          font-size: 14px;
          border-bottom: 2px solid transparent;
          transition: all 0.2s;
        }
        .crypto-tab-btn:hover {
          color: #fff;
        }
        .crypto-tab-btn.active {
          color: var(--accent-primary);
          border-bottom-color: var(--accent-primary);
          font-weight: 600;
        }
        .stat-card {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid var(--border-color);
          border-radius: 12px;
          padding: 20px;
          flex: 1;
          min-width: 200px;
          transition: transform 0.2s, border-color 0.2s;
        }
        .stat-card:hover {
          transform: translateY(-2px);
          border-color: rgba(255, 255, 255, 0.15);
        }
        .crypto-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
        }
        .crypto-table th {
          padding: 12px 16px;
          color: var(--text-muted);
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
          border-bottom: 1px solid var(--border-color);
        }
        .crypto-table th.sortable {
          cursor: pointer;
          user-select: none;
          transition: color 0.2s;
        }
        .crypto-table th.sortable:hover {
          color: #fff;
        }
        .crypto-table td {
          padding: 14px 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.03);
          font-size: 14px;
        }
        .crypto-table tr:hover td {
          background: rgba(255, 255, 255, 0.01);
        }
        .text-up {
          color: #10b981;
        }
        .text-down {
          color: #ef4444;
        }
        .pill-sync {
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .pill-sync.synced {
          background: rgba(16, 185, 129, 0.1);
          color: #10b981;
        }
        .pill-sync.syncing {
          background: rgba(245, 158, 11, 0.1);
          color: #f59e0b;
        }
        .pill-sync.local {
          background: rgba(255, 255, 255, 0.05);
          color: var(--text-secondary);
        }
        .pill-sync.error {
          background: rgba(239, 68, 68, 0.1);
          color: #ef4444;
        }
        .btn-action {
          background: transparent;
          border: 1px solid var(--border-color);
          color: var(--text-primary);
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .btn-action:hover {
          background: rgba(255, 255, 255, 0.05);
          border-color: var(--text-secondary);
        }
        .btn-action-primary {
          background: var(--accent-primary);
          border: 1px solid var(--accent-primary);
          color: #fff;
        }
        .btn-action-primary:hover {
          background: #4a9e82;
          border-color: #4a9e82;
        }
        .timeframe-btn {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--border-color);
          color: var(--text-secondary);
          padding: 4px 10px;
          border-radius: 6px;
          font-size: 11px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .timeframe-btn.active {
          background: var(--accent-primary);
          color: #fff;
          border-color: var(--accent-primary);
        }
        .clickable-coin-name {
          text-decoration: underline;
          text-decoration-color: transparent;
          transition: all 0.2s;
        }
        .crypto-table tr:hover .clickable-coin-name {
          text-decoration-color: var(--accent-primary);
          color: var(--accent-primary) !important;
        }
      `}</style>

      {/* Header section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexShrink: 0 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h2 style={{ fontSize: '24px', fontWeight: 700, background: 'linear-gradient(90deg, #B0E4CC, #408A71)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              Crypto Portfolio Tracker
            </h2>
            <span className={`pill-sync ${syncStatus === 'Synced' ? 'synced' : syncStatus === 'Syncing...' ? 'syncing' : syncStatus === 'Error' ? 'error' : 'local'}`}>
              ● {syncStatus}
            </span>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            Securely encrypted and tracked in real-time.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn-action" onClick={fetchAllPrices} disabled={isRefreshingPrices}>
            🔄 {isRefreshingPrices ? 'Updating...' : 'Refresh Prices'}
          </button>
          <button className="btn-action btn-action-primary" onClick={() => openAddTransactionModal()}>
            ➕ Add Transaction
          </button>
        </div>
      </div>

      {/* Navigation tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', marginBottom: '20px', flexShrink: 0 }}>
        <button 
          className={`crypto-tab-btn ${activeSubTab === 'portfolio' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('portfolio')}
        >
          💼 Portfolio
        </button>
        <button 
          className={`crypto-tab-btn ${activeSubTab === 'market' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('market')}
        >
          📈 Market Watchlist
        </button>
        <button 
          className={`crypto-tab-btn ${activeSubTab === 'transactions' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('transactions')}
        >
          📜 Transaction History
        </button>
        <button 
          className={`crypto-tab-btn ${activeSubTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('settings')}
        >
          ⚙️ Settings
        </button>
      </div>

      {/* Main Content Areas */}
      <div style={{ flex: 1, overflowY: 'auto', paddingRight: '4px' }}>
        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '200px' }}>
            <div style={{ width: '40px', height: '40px', border: '4px solid rgba(255, 255, 255, 0.1)', borderTopColor: 'var(--accent-primary)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
            <p style={{ color: 'var(--text-muted)', marginTop: '12px' }}>Loading encrypted vault...</p>
          </div>
        ) : (
          <>
            {/* PORTFOLIO TAB */}
            {activeSubTab === 'portfolio' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                {transactions.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '60px 20px', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px' }}>
                    <span style={{ fontSize: '48px', display: 'block', marginBottom: '16px' }}>🪙</span>
                    <h3>Your Portfolio is Empty</h3>
                    <p style={{ color: 'var(--text-muted)', margin: '8px 0 20px 0', fontSize: '14px' }}>
                      Add your transactions or import your spreadsheet to begin tracking your assets.
                    </p>
                    <button className="btn-action btn-action-primary" onClick={() => openAddTransactionModal()}>
                      Create First Transaction
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Stat Cards */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px' }}>
                      <div className="stat-card">
                        <div style={{ color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase', fontWeight: 600 }}>Total Balance</div>
                        <div style={{ fontSize: '28px', fontWeight: 700, margin: '8px 0', color: 'var(--text-primary)' }}>
                          ${portfolioTotals.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <div style={{ fontSize: '13px', fontWeight: 500 }} className={portfolioTotals.totalProfitLoss >= 0 ? 'text-up' : 'text-down'}>
                          {portfolioTotals.totalProfitLoss >= 0 ? '▲' : '▼'} ${Math.abs(portfolioTotals.totalProfitLoss).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({portfolioTotals.totalProfitLossPct.toFixed(2)}% all-time)
                        </div>
                      </div>

                      <div className="stat-card">
                        <div style={{ color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase', fontWeight: 600 }}>Net Investment</div>
                        <div style={{ fontSize: '28px', fontWeight: 700, margin: '8px 0', color: 'var(--text-primary)' }}>
                          ${portfolioTotals.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                          Cost basis of current holdings
                        </div>
                      </div>

                      <div className="stat-card">
                        <div style={{ color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase', fontWeight: 600 }}>Best Performer</div>
                        {portfolioTotals.bestAsset ? (
                          <>
                            <div 
                              onClick={() => setSelectedCoinDetails(portfolioTotals.bestAsset)}
                              style={{ fontSize: '20px', fontWeight: 700, margin: '14px 0 8px 0', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
                              title="Click for coin analysis"
                            >
                              {portfolioTotals.bestAsset.imageUrl && <img src={portfolioTotals.bestAsset.imageUrl} style={{ width: '22px', height: '22px', borderRadius: '50%' }} />}
                              <span className="clickable-coin-name">{portfolioTotals.bestAsset.symbol}</span>
                            </div>
                            <div style={{ fontSize: '13px', fontWeight: 500 }} className="text-up">
                              ▲ {portfolioTotals.bestAsset.profitLossPct.toFixed(2)}% profit
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: '14px', color: 'var(--text-muted)', marginTop: '20px' }}>N/A</div>
                        )}
                      </div>

                      <div className="stat-card">
                        <div style={{ color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase', fontWeight: 600 }}>Worst Performer</div>
                        {portfolioTotals.worstAsset ? (
                          <>
                            <div 
                              onClick={() => setSelectedCoinDetails(portfolioTotals.worstAsset)}
                              style={{ fontSize: '20px', fontWeight: 700, margin: '14px 0 8px 0', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
                              title="Click for coin analysis"
                            >
                              {portfolioTotals.worstAsset.imageUrl && <img src={portfolioTotals.worstAsset.imageUrl} style={{ width: '22px', height: '22px', borderRadius: '50%' }} />}
                              <span className="clickable-coin-name">{portfolioTotals.worstAsset.symbol}</span>
                            </div>
                            <div style={{ fontSize: '13px', fontWeight: 500 }} className={portfolioTotals.worstAsset.profitLossPct >= 0 ? 'text-up' : 'text-down'}>
                              {portfolioTotals.worstAsset.profitLossPct >= 0 ? '▲' : '▼'} {Math.abs(portfolioTotals.worstAsset.profitLossPct).toFixed(2)}%
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: '14px', color: 'var(--text-muted)', marginTop: '20px' }}>N/A</div>
                        )}
                      </div>
                    </div>

                    {/* Charting & Distribution Row */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px' }}>
                      {/* Portfolio history chart */}
                      <div style={{ flex: '2 1 500px', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '20px', position: 'relative' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                          <h4 style={{ margin: 0, fontSize: '15px' }}>Performance History</h4>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            {['24h', '7d', '30d', '90d', 'ALL'].map(tf => (
                              <button 
                                key={tf}
                                className={`timeframe-btn ${timeframe === tf ? 'active' : ''}`}
                                onClick={() => setTimeframe(tf)}
                              >
                                {tf.toUpperCase()}
                              </button>
                            ))}
                          </div>
                        </div>

                        {portfolioHistory.length === 0 ? (
                          <div style={{ height: '240px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                            Fetching historical charts...
                          </div>
                        ) : (
                          chartProps && (
                            <div style={{ position: 'relative' }}>
                              <svg 
                                ref={chartRef}
                                width="100%" 
                                height={chartProps.height}
                                viewBox={`0 0 ${chartProps.width} ${chartProps.height}`}
                                style={{ overflow: 'visible', cursor: 'crosshair' }}
                                onMouseMove={handleChartMouseMove}
                                onMouseLeave={handleChartMouseLeave}
                              >
                                <defs>
                                  <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity="0.4" />
                                    <stop offset="100%" stopColor="var(--accent-primary)" stopOpacity="0.0" />
                                  </linearGradient>
                                </defs>

                                {/* Gridlines */}
                                <line x1={chartProps.padding.left} y1={chartProps.padding.top} x2={chartProps.width - chartProps.padding.right} y2={chartProps.padding.top} stroke="rgba(255,255,255,0.03)" />
                                <line x1={chartProps.padding.left} y1={(chartProps.height - chartProps.padding.bottom + chartProps.padding.top) / 2} x2={chartProps.width - chartProps.padding.right} y2={(chartProps.height - chartProps.padding.bottom + chartProps.padding.top) / 2} stroke="rgba(255,255,255,0.03)" />
                                <line x1={chartProps.padding.left} y1={chartProps.height - chartProps.padding.bottom} x2={chartProps.width - chartProps.padding.right} y2={chartProps.height - chartProps.padding.bottom} stroke="rgba(255,255,255,0.05)" />

                                {/* Axes Labels */}
                                <text x={chartProps.padding.left - 8} y={chartProps.padding.top + 4} fill="var(--text-muted)" fontSize="9" textAnchor="end">
                                  ${chartProps.maxVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                </text>
                                <text x={chartProps.padding.left - 8} y={(chartProps.height - chartProps.padding.bottom + chartProps.padding.top) / 2 + 3} fill="var(--text-muted)" fontSize="9" textAnchor="end">
                                  ${((chartProps.maxVal + chartProps.minVal) / 2).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                </text>
                                <text x={chartProps.padding.left - 8} y={chartProps.height - chartProps.padding.bottom + 2} fill="var(--text-muted)" fontSize="9" textAnchor="end">
                                  ${chartProps.minVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                </text>

                                {/* X Labels */}
                                {chartProps.points.length > 1 && (
                                  <>
                                    <text x={chartProps.points[0].x} y={chartProps.height - 8} fill="var(--text-muted)" fontSize="9" textAnchor="start">
                                      {chartProps.points[0].data.dateStr}
                                    </text>
                                    <text x={chartProps.points[Math.floor(chartProps.points.length / 2)].x} y={chartProps.height - 8} fill="var(--text-muted)" fontSize="9" textAnchor="middle">
                                      {chartProps.points[Math.floor(chartProps.points.length / 2)].data.dateStr}
                                    </text>
                                    <text x={chartProps.points[chartProps.points.length - 1].x} y={chartProps.height - 8} fill="var(--text-muted)" fontSize="9" textAnchor="end">
                                      {chartProps.points[chartProps.points.length - 1].data.dateStr}
                                    </text>
                                  </>
                                )}

                                {/* Area */}
                                <path d={chartProps.areaPath} fill="url(#chartGradient)" />

                                {/* Line */}
                                <path d={chartProps.linePath} fill="none" stroke="var(--accent-primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

                                {/* Hover elements */}
                                {hoveredPoint && (
                                  <>
                                    <line 
                                      x1={chartProps.points.find(p => p.data.timestamp === hoveredPoint.timestamp)?.x} 
                                      y1={chartProps.padding.top} 
                                      x2={chartProps.points.find(p => p.data.timestamp === hoveredPoint.timestamp)?.x} 
                                      y2={chartProps.height - chartProps.padding.bottom} 
                                      stroke="rgba(176, 228, 204, 0.3)" 
                                      strokeDasharray="4 4"
                                    />
                                    <circle 
                                      cx={chartProps.points.find(p => p.data.timestamp === hoveredPoint.timestamp)?.x} 
                                      cy={chartProps.points.find(p => p.data.timestamp === hoveredPoint.timestamp)?.y} 
                                      r="5" 
                                      fill="var(--text-secondary)" 
                                      stroke="var(--accent-primary)" 
                                      strokeWidth="2.5" 
                                    />
                                  </>
                                )}
                              </svg>

                              {/* Hover Tooltip Overlay */}
                              {hoveredPoint && (
                                <div style={{
                                  position: 'absolute',
                                  left: `${hoverCoords.x}px`,
                                  top: `${hoverCoords.y}px`,
                                  transform: 'translateX(-50%)',
                                  background: 'var(--bg-main)',
                                  border: '1px solid var(--accent-primary)',
                                  borderRadius: '6px',
                                  padding: '8px 12px',
                                  pointerEvents: 'none',
                                  zIndex: 10,
                                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                                  whiteSpace: 'nowrap',
                                  fontSize: '12px'
                                }}>
                                  <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{hoveredPoint.dateStr}</div>
                                  <div style={{ color: 'var(--text-secondary)', fontWeight: 600, marginTop: '2px' }}>
                                    Portfolio: ${hoveredPoint.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        )}
                      </div>

                      {/* Donut allocation chart */}
                      <div style={{ flex: '1 1 250px', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                        <h4 style={{ margin: '0 0 16px 0', fontSize: '15px', width: '100%', textAlign: 'left' }}>Asset Allocation</h4>
                        {donutSlices.length === 0 ? (
                          <div style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                            No assets held
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                            <div style={{ position: 'relative', width: '140px', height: '140px' }}>
                              <svg width="140" height="140" viewBox="0 0 40 40" style={{ transform: 'rotate(-90deg)', overflow: 'visible' }}>
                                {donutSlices.map((slice, idx) => {
                                  const radius = 15;
                                  const circ = 2 * Math.PI * radius;
                                  const strokeDash = slice.pct * circ;
                                  const strokeOffset = circ - strokeDash;
                                  const rot = (slice.startAngle);
                                  return (
                                    <circle
                                      key={slice.symbol}
                                      cx="20"
                                      cy="20"
                                      r={radius}
                                      fill="transparent"
                                      stroke={slice.color}
                                      strokeWidth="5"
                                      strokeDasharray={`${strokeDash} ${strokeOffset}`}
                                      style={{
                                        transform: `rotate(${rot}deg)`,
                                        transformOrigin: '20px 20px',
                                        transition: 'stroke-width 0.2s'
                                      }}
                                      onMouseEnter={(e) => e.currentTarget.setAttribute('stroke-width', '6')}
                                      onMouseLeave={(e) => e.currentTarget.setAttribute('stroke-width', '5')}
                                      onClick={() => {
                                        const holding = holdings.find(h => h.symbol === slice.symbol);
                                        if (holding) setSelectedCoinDetails(holding);
                                      }}
                                      title={`Click to inspect ${slice.symbol}`}
                                      style={{ cursor: 'pointer' }}
                                    />
                                  );
                                })}
                              </svg>
                              <div style={{
                                position: 'absolute',
                                top: '50%', left: '50%',
                                transform: 'translate(-50%, -50%)',
                                textAlign: 'center'
                              }}>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Assets</div>
                                <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>{holdings.length}</div>
                              </div>
                            </div>

                            {/* Legend */}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 12px', justifyContent: 'center', marginTop: '16px', width: '100%', maxHeight: '80px', overflowY: 'auto' }}>
                              {donutSlices.map(slice => (
                                <div 
                                  key={slice.symbol} 
                                  style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}
                                  onClick={() => {
                                    const holding = holdings.find(h => h.symbol === slice.symbol);
                                    if (holding) setSelectedCoinDetails(holding);
                                  }}
                                  title={`Click to inspect ${slice.symbol}`}
                                >
                                  <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: slice.color, display: 'inline-block' }}></span>
                                  <span className="clickable-coin-name" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{slice.symbol}</span>
                                  <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>({(slice.pct * 100).toFixed(1)}%)</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Top asset results */}
                    {topHoldingsForBarChart.length > 0 && (
                      <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '20px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '14px' }}>
                          <h4 style={{ margin: 0, fontSize: '15px' }}>Top Asset Results</h4>
                          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Sold + left - bought</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 1.2fr) repeat(5, minmax(105px, 1fr))', gap: '0', overflowX: 'auto' }}>
                          {['Asset', 'Bought', 'Sold', 'Left', 'Net Result', 'Return'].map(label => (
                            <div key={label} style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', padding: '8px 10px', borderBottom: '1px solid var(--border-color)' }}>
                              {label}
                            </div>
                          ))}
                          {topHoldingsForBarChart.map(h => (
                            <React.Fragment key={h.symbol}>
                              <button
                                type="button"
                                onClick={() => setSelectedCoinDetails(h)}
                                style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', padding: '12px 10px', textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 700 }}
                                title={`Inspect ${h.symbol}`}
                              >
                                {h.imageUrl ? (
                                  <img src={h.imageUrl} alt="" style={{ width: '18px', height: '18px', borderRadius: '50%' }} />
                                ) : (
                                  <span style={{ width: '18px', height: '18px', borderRadius: '50%', background: 'rgba(255,255,255,0.08)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px' }}>{h.symbol[0]}</span>
                                )}
                                <span>{h.symbol}</span>
                              </button>
                              <div style={{ padding: '12px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)', fontWeight: 600 }}>
                                ${h.totalBought.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </div>
                              <div style={{ padding: '12px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)', fontWeight: 600 }}>
                                ${h.totalSold.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </div>
                              <div style={{ padding: '12px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)', fontWeight: 600 }}>
                                ${h.currentValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </div>
                              <div style={{ padding: '12px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)', fontWeight: 700 }} className={h.lifetimeNetResult >= 0 ? 'text-up' : 'text-down'}>
                                {h.lifetimeNetResult >= 0 ? '+' : '-'}${Math.abs(h.lifetimeNetResult).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </div>
                              <div style={{ padding: '12px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)', fontWeight: 700 }} className={h.lifetimeReturnPct >= 0 ? 'text-up' : 'text-down'}>
                                {h.lifetimeReturnPct >= 0 ? '+' : ''}{h.lifetimeReturnPct.toFixed(2)}%
                              </div>
                            </React.Fragment>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Bought / sold summary */}
                    <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '24px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '20px' }}>
                        <div>
                          <h4 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Bought / Sold / Left</h4>
                          <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
                            {periodPerformance.label} summary. Net result = sold + left - bought.
                          </p>
                        </div>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          {['all', 'thisYear', 'lastYear', 'last12m', 'custom'].map(p => (
                            <button 
                              key={p} 
                              className={`timeframe-btn ${profitPeriod === p ? 'active' : ''}`}
                              onClick={() => setProfitPeriod(p)}
                            >
                              {p === 'all' ? 'All Time' : p === 'thisYear' ? 'This Year' : p === 'lastYear' ? 'Last Year' : p === 'last12m' ? 'Last 12M' : 'Custom'}
                            </button>
                          ))}
                        </div>
                      </div>

                      {profitPeriod === 'custom' && (
                        <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', alignItems: 'center' }}>
                          <input type="date" value={customPeriodStart} onChange={e => setCustomPeriodStart(e.target.value)} style={{ padding: '6px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: '6px', colorScheme: 'dark' }} />
                          <span style={{ color: 'var(--text-muted)' }}>to</span>
                          <input type="date" value={customPeriodEnd} onChange={e => setCustomPeriodEnd(e.target.value)} style={{ padding: '6px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: '6px', colorScheme: 'dark' }} />
                        </div>
                      )}

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
                        <div style={{ borderLeft: '3px solid var(--accent-primary)', paddingLeft: '12px' }}>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total Bought</div>
                          <div style={{ fontSize: '20px', fontWeight: 700, marginTop: '6px' }}>
                            ${periodPerformance.cashIn.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            Money put into buys
                          </div>
                        </div>

                        <div style={{ borderLeft: '3px solid #10b981', paddingLeft: '12px' }}>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total Sold</div>
                          <div style={{ fontSize: '20px', fontWeight: 700, marginTop: '6px' }}>
                            ${periodPerformance.cashOut.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            Money received from sells
                          </div>
                        </div>

                        <div style={{ borderLeft: '3px solid #3b82f6', paddingLeft: '12px' }}>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Value Left</div>
                          <div style={{ fontSize: '20px', fontWeight: 700, marginTop: '6px' }}>
                            ${periodPerformance.endingValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            Current value still held
                          </div>
                        </div>

                        <div style={{ borderLeft: '3px solid #f59e0b', paddingLeft: '12px' }}>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Net Result</div>
                          <div style={{ fontSize: '20px', fontWeight: 700, marginTop: '6px' }} className={periodPerformance.totalProfitLoss >= 0 ? 'text-up' : 'text-down'}>
                            {periodPerformance.totalProfitLoss >= 0 ? '+' : '-'}${Math.abs(periodPerformance.totalProfitLoss).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            Sold + left - bought
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Holdings Table */}
                    <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden' }}>
                      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                        <h4 style={{ margin: 0, fontSize: '15px' }}>Holdings</h4>
                        
                        {/* Interactive PL View Mode Switcher */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>P/L Scope:</span>
                          <div style={{ display: 'inline-flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                            <button 
                              onClick={() => setPlViewMode('unrealized')}
                              style={{ border: 'none', background: plViewMode === 'unrealized' ? 'var(--accent-primary)' : 'transparent', color: plViewMode === 'unrealized' ? '#fff' : 'var(--text-secondary)', padding: '4px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                            >
                              Unrealized (Paper)
                            </button>
                            <button 
                              onClick={() => setPlViewMode('total')}
                              style={{ border: 'none', background: plViewMode === 'total' ? 'var(--accent-primary)' : 'transparent', color: plViewMode === 'total' ? '#fff' : 'var(--text-secondary)', padding: '4px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                            >
                              Lifetime (Total)
                            </button>
                          </div>
                        </div>
                      </div>

                      <div style={{ overflowX: 'auto' }}>
                        <table className="crypto-table">
                          <thead>
                            <tr>
                              <th className="sortable" onClick={() => requestSort('symbol')}>Asset{getSortIndicator('symbol')}</th>
                              <th className="sortable" onClick={() => requestSort('currentPrice')}>Price (24h){getSortIndicator('currentPrice')}</th>
                              <th>Last 7 Days</th>
                              <th className="sortable" onClick={() => requestSort('amount')}>Balance{getSortIndicator('amount')}</th>
                              <th className="sortable" onClick={() => requestSort('currentValue')}>Holdings Value{getSortIndicator('currentValue')}</th>
                              <th className="sortable" onClick={() => requestSort('averageBuyPrice')}>Avg. Buy Price{getSortIndicator('averageBuyPrice')}</th>
                              <th className="sortable" onClick={() => requestSort('profitLoss')}>
                                {plViewMode === 'unrealized' ? 'Unrealized P/L' : 'Lifetime Total P/L'}
                                {getSortIndicator('profitLoss')}
                              </th>
                              <th style={{ textAlign: 'right' }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedHoldings.map(h => (
                              <tr key={h.symbol}>
                                <td 
                                  onClick={() => setSelectedCoinDetails(h)}
                                  style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
                                  title="Click to view full coin stats"
                                >
                                  {h.imageUrl && <img src={h.imageUrl} style={{ width: '24px', height: '24px', borderRadius: '50%' }} />}
                                  <div>
                                    <div style={{ color: '#fff' }} className="clickable-coin-name">{h.symbol}</div>
                                  </div>
                                </td>
                                <td>
                                  <div>{h.hasLivePrice ? formatUsdPrice(h.currentPrice) : <span style={{ color: 'var(--text-muted)' }}>No live price</span>}</div>
                                  {h.hasLivePrice && (
                                    <div className={h.change24h >= 0 ? 'text-up' : 'text-down'} style={{ fontSize: '11px', fontWeight: 500 }}>
                                      {h.change24h >= 0 ? '▲' : '▼'} {Math.abs(h.change24h).toFixed(2)}%
                                    </div>
                                  )}
                                </td>
                                <td>
                                  <Sparkline data={h.sparkline} change24h={h.change24h} />
                                </td>
                                <td>
                                  <div>{h.amount.toLocaleString(undefined, { maximumFractionDigits: 8 })}</div>
                                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{h.symbol}</div>
                                </td>
                                <td style={{ fontWeight: 600 }}>
                                  ${h.currentValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                                <td>
                                  ${h.averageBuyPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                                <td className={h.profitLoss >= 0 ? 'text-up' : 'text-down'} style={{ fontWeight: 500 }}>
                                  <div>{h.profitLoss >= 0 ? '+' : ''}${h.profitLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                  <div style={{ fontSize: '11px' }}>{h.profitLoss >= 0 ? '+' : ''}{h.profitLossPct.toFixed(2)}%</div>
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  <button className="btn-action" onClick={() => openAddTransactionModal(h.symbol)} style={{ marginRight: '8px' }}>
                                    Trade
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* WATCHLIST TAB */}
            {activeSubTab === 'market' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '16px 20px' }}>
                  <h4 style={{ margin: '0 0 12px 0', fontSize: '14px' }}>Add Custom Coin by Symbol / Name</h4>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <input 
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && searchCoin()}
                      placeholder="e.g. BTC, LTC, Monero, WLFI, JUP"
                      style={{
                        flex: 1,
                        padding: '10px 14px',
                        background: 'rgba(0,0,0,0.2)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        color: '#fff',
                        fontSize: '14px'
                      }}
                    />
                    <button className="btn-action btn-action-primary" onClick={searchCoin}>
                      Search
                    </button>
                  </div>

                  {searchError && (
                    <div style={{ color: '#ef4444', fontSize: '13px', marginTop: '10px' }}>⚠️ {searchError}</div>
                  )}

                  {searchedCoinResult && (
                    <div style={{
                      marginTop: '16px',
                      padding: '14px',
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.05)',
                      borderRadius: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {searchedCoinResult.imageUrl && <img src={searchedCoinResult.imageUrl} style={{ width: '28px', height: '28px', borderRadius: '50%' }} />}
                        <div>
                          <strong style={{ color: '#fff' }}>{searchedCoinResult.symbol}</strong>
                          <span style={{ color: 'var(--text-muted)', marginLeft: '8px', fontSize: '12px' }}>
                            {formatUsdPrice(searchedCoinResult.price)}
                          </span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button className="btn-action btn-action-primary" onClick={() => handleWatchlistAdd(searchedCoinResult.symbol, searchedCoinResult.geckoId)}>
                          Add to Watchlist
                        </button>
                        <button className="btn-action" onClick={() => openAddTransactionModal(searchedCoinResult.symbol, searchedCoinResult.price)}>
                          Log Transaction
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Market Watchlist Grid */}
                <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden' }}>
                  <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
                    <h4 style={{ margin: 0, fontSize: '15px' }}>My Watchlist</h4>
                  </div>

                  <div style={{ overflowX: 'auto' }}>
                    <table className="crypto-table">
                      <thead>
                        <tr>
                          <th>Coin</th>
                          <th>Price</th>
                          <th>24h Change</th>
                          <th>Last 7 Days</th>
                          <th>Market Cap</th>
                          <th>24h Volume</th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {watchlist.map(sym => {
                          const quote = marketPrices[sym];
                          return (
                            <tr key={sym}>
                              <td 
                                onClick={() => {
                                  const holding = holdings.find(h => h.symbol === sym) || {
                                    symbol: sym,
                                    currentPrice: quote?.price || 0,
                                    hasLivePrice: !!quote && Number(quote.price) > 0,
                                    change24h: quote?.change24h || 0,
                                    imageUrl: quote?.imageUrl || '',
                                    sparkline: quote?.sparkline || [],
                                    amount: 0,
                                    currentValue: 0,
                                    totalCost: 0,
                                    averageBuyPrice: 0,
                                    profitLoss: 0,
                                    profitLossPct: 0
                                  };
                                  setSelectedCoinDetails(holding);
                                }}
                                style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
                                title="Click for coin analysis"
                              >
                                {quote?.imageUrl && <img src={quote.imageUrl} style={{ width: '24px', height: '24px', borderRadius: '50%' }} />}
                                <span style={{ color: '#fff' }} className="clickable-coin-name">{sym}</span>
                              </td>
                              <td>
                                {quote ? formatUsdPrice(quote.price) : 'Loading...'}
                              </td>
                              <td className={quote ? (quote.change24h >= 0 ? 'text-up' : 'text-down') : ''}>
                                {quote ? `${quote.change24h >= 0 ? '▲' : '▼'} ${Math.abs(quote.change24h).toFixed(2)}%` : '-'}
                              </td>
                              <td>
                                <Sparkline data={quote?.sparkline} change24h={quote?.change24h || 0} />
                              </td>
                              <td>
                                {quote ? `$${quote.mcap.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '-'}
                              </td>
                              <td>
                                {quote ? `$${quote.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '-'}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <button className="btn-action" onClick={() => openAddTransactionModal(sym, quote?.price)} style={{ marginRight: '8px' }}>
                                  Buy / Sell
                                </button>
                                <button className="btn-action" onClick={() => handleWatchlistRemove(sym)} style={{ color: '#ef4444' }}>
                                  Remove
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Popular Cryptocurrencies */}
                <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden' }}>
                  <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
                    <h4 style={{ margin: 0, fontSize: '15px' }}>Popular Cryptocurrencies</h4>
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="crypto-table">
                      <thead>
                        <tr>
                          <th>Coin</th>
                          <th>Price</th>
                          <th>24h Change</th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {POPULAR_COINS.filter(c => !watchlist.includes(c)).map(sym => {
                          const quote = marketPrices[sym];
                          return (
                            <tr key={sym}>
                              <td style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '10px' }}>
                                {quote?.imageUrl && <img src={quote.imageUrl} style={{ width: '24px', height: '24px', borderRadius: '50%' }} />}
                                <span style={{ color: '#fff' }}>{sym}</span>
                              </td>
                              <td>
                                {quote ? formatUsdPrice(quote.price) : 'Loading...'}
                              </td>
                              <td className={quote ? (quote.change24h >= 0 ? 'text-up' : 'text-down') : ''}>
                                {quote ? `${quote.change24h >= 0 ? '▲' : '▼'} ${Math.abs(quote.change24h).toFixed(2)}%` : '-'}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <button className="btn-action btn-action-primary" onClick={() => handleWatchlistAdd(sym, symbolGeckoIds[sym])} style={{ marginRight: '8px' }}>
                                  Watch
                                </button>
                                <button className="btn-action" onClick={() => openAddTransactionModal(sym, quote?.price)}>
                                  Log Trade
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* TRANSACTION HISTORY TAB */}
            {activeSubTab === 'transactions' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {/* CSV Import card */}
                <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '18px 20px', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
                  <div style={{ minWidth: '240px', flex: '1 1 420px' }}>
                    <h4 style={{ margin: 0, fontSize: '15px' }}>CSV Data Import</h4>
                    <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '6px', lineHeight: 1.5 }}>
                      Import your bulk transaction history with Date, Type, Symbol, Amount, Price and optional fees. Supported column formats include headers exported from CoinGecko, MetaMask, Binance or custom tables.
                    </div>
                    <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
                      <input 
                        type="file"
                        accept=".csv"
                        ref={importFileInputRef}
                        onChange={handleImportTransactionsCsv}
                        style={{ display: 'none' }}
                      />
                      <button className="btn-action btn-action-primary" onClick={() => importFileInputRef.current?.click()} style={{ height: '34px' }}>
                        📥 Select and Import CSV
                      </button>
                    </div>
                  </div>
                </div>

                {/* Transaction list */}
                <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden' }}>
                  <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <h4 style={{ margin: 0, fontSize: '15px' }}>Transaction Log</h4>
                      {txFilterSymbol && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(64, 138, 113, 0.15)', border: '1px solid var(--accent-primary)', padding: '3px 10px', borderRadius: '14px', fontSize: '12px', color: 'var(--accent-primary)', fontWeight: 500 }}>
                          Filtering: {txFilterSymbol}
                          <button 
                            onClick={() => setTxFilterSymbol('')}
                            style={{ background: 'transparent', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontWeight: 'bold', padding: 0, marginLeft: '4px', fontSize: '14px' }}
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </div>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input 
                        type="text" 
                        placeholder="Filter by Symbol..." 
                        value={txFilterSymbol} 
                        onChange={(e) => setTxFilterSymbol(e.target.value.toUpperCase())}
                        style={{ padding: '6px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', fontSize: '13px', width: '160px' }}
                      />
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        Showing {filteredTransactions.length} of {transactions.length} items
                      </span>
                    </div>
                  </div>

                  {importMessage && (
                    <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontSize: '12px', background: 'var(--accent-primary-alpha)' }}>
                      {importMessage}
                    </div>
                  )}

                  {filteredTransactions.length === 0 ? (
                    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                      {txFilterSymbol ? `No transaction records found for "${txFilterSymbol}".` : 'No transaction records found.'}
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table className="crypto-table">
                        <thead>
                          <tr>
                            <th>Date / Time</th>
                            <th>Asset</th>
                            <th>Type</th>
                            <th>Amount</th>
                            <th>Price Per Unit</th>
                            <th>Total Value</th>
                            <th style={{ textAlign: 'right' }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...filteredTransactions].sort((a,b) => new Date(b.date) - new Date(a.date)).map(tx => (
                            <tr key={tx.id}>
                              <td style={{ color: 'var(--text-secondary)' }}>
                                {new Date(tx.date).toLocaleString()}
                              </td>
                              <td style={{ fontWeight: 600 }}>{tx.symbol}</td>
                              <td>
                                <span style={{
                                  padding: '2px 8px',
                                  borderRadius: '4px',
                                  fontSize: '11px',
                                  fontWeight: 600,
                                  background: tx.type === 'buy' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                                  color: tx.type === 'buy' ? '#10b981' : '#ef4444',
                                  textTransform: 'uppercase'
                                }}>
                                  {tx.type}
                                </span>
                              </td>
                              <td>{Number(tx.amount).toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
                              <td>{formatUsdPrice(tx.price)}</td>
                              <td style={{ fontWeight: 600 }}>
                                ${(Number(tx.amount) * Number(tx.price)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <button className="btn-action" style={{ marginRight: '8px' }} onClick={() => openEditTransactionModal(tx)}>
                                  Edit
                                </button>
                                <button className="btn-action" style={{ color: '#ef4444' }} onClick={() => handleDeleteTransaction(tx.id)}>
                                  Delete
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* SETTINGS TAB */}
            {activeSubTab === 'settings' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '24px' }}>
                  <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: '#fff' }}>CoinGecko Public API Settings</h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: 1.5 }}>
                    LabSuite uses CoinGecko's free public API to query live token exchange rates and history. This requires **no API keys** and has no registration. The app uses smart batch requests and client-side memory caching to remain completely free of rate-limit blocks.
                  </p>
                </div>

                <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '24px' }}>
                  <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: '#fff' }}>Data Sync Controls</h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: 1.5, marginBottom: '20px' }}>
                    Manage file states, cloud upload syncing, or restore from local storage backups.
                  </p>
                  {importMessage && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '14px', padding: '10px 12px', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'rgba(255,255,255,0.02)' }}>
                      {importMessage}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                    <button className="btn-action" onClick={() => loadPortfolioData({ forceCloud: true })}>
                      📥 Force Pull Cloud Sync
                    </button>
                    <button className="btn-action" onClick={() => savePortfolioData()}>
                      📤 Force Push Cloud Sync
                    </button>
                    <button className="btn-action" onClick={handleRepairMarketData}>
                      Repair Coin Prices
                    </button>
                    <button className="btn-action" style={{ color: '#ef4444' }} onClick={() => {
                      if (confirm('DANGER! This will delete all transactions and watchlist data. Are you sure?')) {
                        const resetMappings = getMergedMappings({});
                        setTransactions([]);
                        setWatchlist(DEFAULT_WATCHLIST);
                        setSymbolGeckoIds(resetMappings);
                        localStorage.removeItem(PORTFOLIO_CACHE_KEY);
                        localStorage.removeItem(PRICE_CACHE_KEY);
                        savePortfolioData({
                          transactions: [],
                          watchlist: DEFAULT_WATCHLIST,
                          symbolGeckoIds: resetMappings
                        });
                      }
                    }}>
                      ⚠️ Clear Portfolio Data
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* DETAILED COIN ANALYSIS MODAL */}
      {selectedCoinDetails && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, backdropFilter: 'blur(4px)' }}>
          <div style={{ background: 'var(--bg-panel)', padding: '28px', borderRadius: '14px', width: '460px', border: '1px solid var(--border-color)', backdropFilter: 'blur(15px)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', position: 'relative' }}>
            
            {/* Close button */}
            <button 
              onClick={() => setSelectedCoinDetails(null)}
              style={{ position: 'absolute', top: '16px', right: '16px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '20px', padding: '4px' }}
            >
              ×
            </button>

            {/* Coin Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '20px' }}>
              {selectedCoinDetails.imageUrl && <img src={selectedCoinDetails.imageUrl} style={{ width: '40px', height: '40px', borderRadius: '50%' }} />}
              <div>
                <h3 style={{ margin: 0, fontSize: '22px', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {selectedCoinDetails.symbol}
                </h3>
                <div style={{ fontSize: '14px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  Live Price: <strong style={{ color: '#fff' }}>{selectedCoinDetails.hasLivePrice === false ? 'No live price' : formatUsdPrice(selectedCoinDetails.currentPrice)}</strong>
                  {selectedCoinDetails.hasLivePrice !== false && (
                    <span className={selectedCoinDetails.change24h >= 0 ? 'text-up' : 'text-down'} style={{ marginLeft: '8px', fontWeight: 600 }}>
                      {selectedCoinDetails.change24h >= 0 ? '▲' : '▼'} {Math.abs(selectedCoinDetails.change24h).toFixed(2)}%
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Quick 7d Sparkline Chart */}
            {selectedCoinDetails.sparkline && selectedCoinDetails.sparkline.length > 0 && (
              <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)', marginBottom: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px', width: '100%' }}>7-Day Price Trend</div>
                <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
                  <svg width="380" height="60" style={{ overflow: 'visible' }}>
                    {(() => {
                      const data = selectedCoinDetails.sparkline;
                      const min = Math.min(...data);
                      const max = Math.max(...data);
                      const range = max - min || 1;
                      const points = data.map((val, idx) => {
                        const x = (idx / (data.length - 1)) * 380;
                        const y = 60 - ((val - min) / range) * 55;
                        return `${x},${y}`;
                      }).join(' ');
                      const stroke = selectedCoinDetails.change24h >= 0 ? '#10b981' : '#ef4444';
                      return <polyline fill="none" stroke={stroke} strokeWidth="2.5" points={points} />;
                    })()}
                  </svg>
                </div>
              </div>
            )}

            {/* Holdings Stats Table */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '8px' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Your Holdings</span>
                <strong style={{ color: '#fff', fontSize: '13px' }}>{selectedCoinDetails.amount.toLocaleString(undefined, { maximumFractionDigits: 8 })} {selectedCoinDetails.symbol}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '8px' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Current Value</span>
                <strong style={{ color: '#fff', fontSize: '13px' }}>${selectedCoinDetails.currentValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '8px' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Average Cost Basis</span>
                <strong style={{ color: '#fff', fontSize: '13px' }}>${selectedCoinDetails.averageBuyPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '8px' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Total Cost Basis</span>
                <strong style={{ color: '#fff', fontSize: '13px' }}>${selectedCoinDetails.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '8px' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Unrealized Profit/Loss</span>
                <strong className={selectedCoinDetails.unrealizedProfitLoss >= 0 ? 'text-up' : 'text-down'} style={{ fontSize: '13px' }}>
                  {selectedCoinDetails.unrealizedProfitLoss >= 0 ? '+' : ''}${selectedCoinDetails.unrealizedProfitLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({selectedCoinDetails.unrealizedProfitLossPct.toFixed(2)}%)
                </strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '8px' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Realized Profit/Loss</span>
                <strong className={selectedCoinDetails.realizedProfitLoss >= 0 ? 'text-up' : 'text-down'} style={{ fontSize: '13px' }}>
                  {selectedCoinDetails.realizedProfitLoss >= 0 ? '+' : ''}${selectedCoinDetails.realizedProfitLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '8px' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Lifetime Total P/L</span>
                <strong className={selectedCoinDetails.totalProfitLoss >= 0 ? 'text-up' : 'text-down'} style={{ fontSize: '13px' }}>
                  {selectedCoinDetails.totalProfitLoss >= 0 ? '+' : ''}${selectedCoinDetails.totalProfitLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({selectedCoinDetails.totalProfitLossPct.toFixed(2)}%)
                </strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Transaction Count</span>
                <strong style={{ color: '#fff', fontSize: '13px' }}>
                  {selectedCoinDetails.buyCount || 0} Buys / {selectedCoinDetails.sellCount || 0} Sells
                </strong>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button 
                className="btn-action" 
                onClick={() => {
                  viewTransactionsForCoin(selectedCoinDetails.symbol);
                  setSelectedCoinDetails(null);
                }}
              >
                📜 View Transaction History
              </button>
              <button 
                className="btn-action btn-action-primary" 
                onClick={() => {
                  openAddTransactionModal(selectedCoinDetails.symbol);
                  setSelectedCoinDetails(null);
                }}
              >
                ➕ Log New Trade
              </button>
            </div>

          </div>
        </div>
      )}

      {/* TRANSACTION MODAL */}
      {showTxModal && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, backdropFilter: 'blur(4px)' }}>
          <div style={{ background: 'var(--bg-panel)', padding: '28px', borderRadius: '14px', width: '380px', border: '1px solid var(--border-color)', backdropFilter: 'blur(15px)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
            <h3 style={{ margin: '0 0 18px 0', color: 'var(--text-secondary)' }}>
              {editingTxId ? 'Edit Crypto Transaction' : 'Log Crypto Transaction'}
            </h3>
            
            <form onSubmit={handleAddTransaction} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button 
                  type="button" 
                  onClick={() => setTxType('buy')}
                  style={{ flex: 1, padding: '8px', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', background: txType === 'buy' ? 'rgba(16, 185, 129, 0.2)' : 'transparent', color: txType === 'buy' ? '#10b981' : 'var(--text-secondary)', fontWeight: 600 }}
                >
                  Buy
                </button>
                <button 
                  type="button" 
                  onClick={() => setTxType('sell')}
                  style={{ flex: 1, padding: '8px', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', background: txType === 'sell' ? 'rgba(239, 68, 68, 0.2)' : 'transparent', color: txType === 'sell' ? '#ef4444' : 'var(--text-secondary)', fontWeight: 600 }}
                >
                  Sell
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Coin Symbol</label>
                <input 
                  type="text" 
                  value={txSymbol}
                  onChange={e => setTxSymbol(e.target.value.toUpperCase())}
                  required
                  placeholder="e.g. BTC"
                  style={{ padding: '8px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: '6px' }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {txType === 'buy' ? 'Total Spent (USD)' : 'Total Proceeds (USD)'}
                </label>
                <input 
                  type="number" 
                  step="any"
                  value={txTotalSpent}
                  onChange={e => handleTotalSpentChange(e.target.value)}
                  placeholder="e.g. 500"
                  style={{ padding: '8px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: '6px', width: '100%' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Quantity</label>
                  <input 
                    type="number" 
                    step="any"
                    value={txAmount}
                    onChange={e => handleAmountChange(e.target.value)}
                    required
                    placeholder="e.g. 0.05"
                    style={{ padding: '8px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: '6px', width: '100%' }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Price per Coin (USD)</label>
                  <input 
                    type="number" 
                    step="any"
                    value={txPrice}
                    onChange={e => handlePriceChange(e.target.value)}
                    required
                    placeholder="e.g. 62000"
                    style={{ padding: '8px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: '6px', width: '100%' }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Transaction Fee (USD)</label>
                <input 
                  type="number" 
                  step="any"
                  value={txFee}
                  onChange={e => setTxFee(e.target.value)}
                  placeholder="e.g. 1.50"
                  style={{ padding: '8px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: '6px', width: '100%' }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Transaction Date / Time</label>
                <input 
                  type="datetime-local" 
                  value={txDate}
                  onChange={e => setTxDate(e.target.value)}
                  required
                  style={{ padding: '8px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: '6px', colorScheme: 'dark' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
                <button type="button" className="btn-action" onClick={() => { setShowTxModal(false); setEditingTxId(null); }}>Cancel</button>
                <button type="submit" className="btn-action btn-action-primary">
                  {editingTxId ? 'Save Changes' : 'Add Trade'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
