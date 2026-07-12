(() => {
  if (window.__LABSUITE_COINGECKO_EXPORTER__) return;
  window.__LABSUITE_COINGECKO_EXPORTER__ = true;

  const DATE_RE = /\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i;
  const TYPE_RE = /\b(buy|bought|sell|sold|deposit|withdraw|withdrawal|receive|received|send|sent|transfer)\b/i;
  const SYMBOL_RE = /\(([A-Z0-9]{2,12})\)|\b([A-Z0-9]{2,12})\b/;
  const MONEY_RE = /[-+]?[$€£]?\s*\d[\d,]*(?:\.\d+)?/;

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalize(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function pick(record, names) {
    const normalizedNames = names.map(normalize);
    for (const [key, value] of Object.entries(record)) {
      if (normalizedNames.includes(normalize(key)) && cleanText(value)) return cleanText(value);
    }
    return '';
  }

  function firstMatch(text, regex) {
    const match = cleanText(text).match(regex);
    return match ? cleanText(match[0]) : '';
  }

  function inferType(text) {
    const raw = cleanText(text).toLowerCase();
    if (/(sell|sold|withdraw|withdrawal|send|sent)/.test(raw)) return 'sell';
    if (/(buy|bought|deposit|receive|received)/.test(raw)) return 'buy';
    return '';
  }

  function inferSymbol(text) {
    const clean = cleanText(text);
    const paren = clean.match(/\(([A-Z0-9]{2,12})\)/);
    if (paren) return paren[1];
    const parts = clean.match(/\b[A-Z0-9]{2,12}\b/g) || [];
    return parts.find(part => !['USD', 'USDT', 'USDC', 'BUY', 'SELL'].includes(part)) || '';
  }

  function coinNameFromText(text, symbol) {
    const clean = cleanText(text);
    if (!clean) return '';
    if (symbol) {
      return clean
        .replace(new RegExp(`\\(${symbol}\\)`, 'i'), '')
        .replace(new RegExp(`\\b${symbol}\\b`, 'i'), '')
        .replace(TYPE_RE, '')
        .replace(DATE_RE, '')
        .replace(MONEY_RE, '')
        .trim();
    }
    return clean.replace(TYPE_RE, '').replace(DATE_RE, '').trim();
  }

  function isUsefulRow(row) {
    const text = cleanText(row.raw_text || Object.values(row).join(' '));
    const hasDate = Boolean(row.date || DATE_RE.test(text));
    const hasType = Boolean(row.type || TYPE_RE.test(text));
    const hasAmountOrTotal = Boolean(row.amount || row.total_value || MONEY_RE.test(text));
    return hasDate && hasType && hasAmountOrTotal;
  }

  function standardize(record, rawText = '') {
    const text = cleanText(rawText || Object.values(record).join(' '));
    const coinField = pick(record, ['coin', 'coin name', 'asset', 'name', 'cryptocurrency', 'token']);
    const symbolField = pick(record, ['symbol', 'ticker', 'coin symbol', 'asset symbol']);
    const symbol = inferSymbol(symbolField || coinField || text);
    const type = inferType(pick(record, ['type', 'transaction type', 'action', 'side', 'operation']) || text);

    return {
      date: pick(record, ['date', 'time', 'datetime', 'timestamp', 'transaction date', 'created at']) || firstMatch(text, DATE_RE),
      type,
      coin_name: coinNameFromText(coinField || text, symbol),
      symbol,
      amount: pick(record, ['amount', 'quantity', 'qty', 'units', 'coin amount', 'crypto amount', 'holdings']),
      price: pick(record, ['price', 'price per coin', 'price per unit', 'unit price', 'cost per coin', 'price usd']),
      total_value: pick(record, ['total', 'total value', 'value', 'cost', 'total cost', 'amount usd', 'usd value', 'fiat amount']),
      fee: pick(record, ['fee', 'fees', 'commission', 'network fee']),
      notes: pick(record, ['note', 'notes', 'memo', 'description']),
      source: 'CoinGecko local extension',
      raw_text: text
    };
  }

  function tableHeaders(table) {
    const explicit = Array.from(table.querySelectorAll('thead th, thead [role="columnheader"]')).map(cell => cleanText(cell.innerText));
    if (explicit.filter(Boolean).length > 0) return explicit;
    const firstRow = table.querySelector('tr, [role="row"]');
    return firstRow ? Array.from(firstRow.querySelectorAll('th, td, [role="cell"], [role="columnheader"]')).map(cell => cleanText(cell.innerText)) : [];
  }

  function scrapeTables() {
    const rows = [];
    document.querySelectorAll('table').forEach(table => {
      const headers = tableHeaders(table);
      const bodyRows = Array.from(table.querySelectorAll('tbody tr')).length
        ? Array.from(table.querySelectorAll('tbody tr'))
        : Array.from(table.querySelectorAll('tr')).slice(headers.length ? 1 : 0);

      bodyRows.forEach(rowEl => {
        const cells = Array.from(rowEl.querySelectorAll('td, th')).map(cell => cleanText(cell.innerText));
        if (cells.filter(Boolean).length < 2) return;
        const record = {};
        cells.forEach((cell, index) => {
          record[headers[index] || `column_${index + 1}`] = cell;
        });
        const standardized = standardize(record, cleanText(rowEl.innerText));
        if (isUsefulRow(standardized)) rows.push(standardized);
      });
    });
    return rows;
  }

  function scrapeRoleRows() {
    const rows = [];
    const candidates = Array.from(document.querySelectorAll('main [role="row"], main [data-testid*="row"], main [class*="transaction"], main [class*="Transaction"]'));

    candidates.forEach(rowEl => {
      if (rowEl.closest('table')) return;
      const text = cleanText(rowEl.innerText);
      if (text.length < 20 || text.length > 1200) return;
      const cells = Array.from(rowEl.querySelectorAll('[role="cell"], [class*="cell"], div, span'))
        .map(cell => cleanText(cell.innerText))
        .filter(Boolean);
      const record = {};
      cells.slice(0, 16).forEach((cell, index) => {
        record[`column_${index + 1}`] = cell;
      });
      const standardized = standardize(record, text);
      if (isUsefulRow(standardized)) rows.push(standardized);
    });

    return rows;
  }

  function dedupeRows(rows) {
    const seen = new Set();
    return rows.filter(row => {
      const key = [row.date, row.type, row.symbol, row.amount, row.price, row.total_value, row.raw_text].join('|').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function parseNumber(value) {
    const text = cleanText(value)
      .replace(/[−–—]/g, '-')
      .replace(/[^\d.+\-eE]/g, '');
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && element.getClientRects().length > 0;
  }

  function visibleTextElements(selector) {
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .filter(element => cleanText(element.innerText || element.textContent));
  }

  function tableRowsWithHeaders() {
    const result = [];
    document.querySelectorAll('table').forEach(table => {
      const headers = tableHeaders(table);
      const bodyRows = Array.from(table.querySelectorAll('tbody tr')).length
        ? Array.from(table.querySelectorAll('tbody tr'))
        : Array.from(table.querySelectorAll('tr')).slice(headers.length ? 1 : 0);

      bodyRows.forEach(rowEl => {
        const cellElements = Array.from(rowEl.querySelectorAll('td, th'));
        const cells = cellElements.map(cell => cleanText(cell.innerText));
        if (cells.filter(Boolean).length < 2) return;
        const record = {};
        cells.forEach((cell, index) => {
          record[headers[index] || `column_${index + 1}`] = cell;
        });
        result.push({ table, rowEl, headers, cells, cellElements, record, text: cleanText(rowEl.innerText) });
      });
    });
    return result;
  }

  function extractCoinNameAndSymbol(text) {
    const clean = cleanText(text);
    const symbol = inferSymbol(clean);
    let name = clean;
    if (symbol) {
      name = name
        .replace(new RegExp(`\\(${symbol}\\)`, 'i'), '')
        .replace(new RegExp(`\\b${symbol}\\b`, 'i'), '')
        .replace(/\bBuy\b/i, '')
        .trim();
    }
    name = name.split('$')[0].replace(/\s+/g, ' ').trim();
    return { coin_name: name, symbol };
  }

  function holdingsAreNonZero(holdingsText, rowText) {
    const combined = cleanText(holdingsText || '');
    if (!combined) return false;
    const amounts = combined.match(/[-+]?\$?\s*\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?/gi) || [];
    const meaningful = amounts
      .map(parseNumber)
      .filter(value => Math.abs(value) > 1e-18);
    if (meaningful.length === 0) return false;
    const explicitZeroHolding = /\$0(?:\.0+)?\s+0(?:\.0+)?\s+[A-Z0-9]{2,12}\b/i.test(cleanText(combined));
    return !explicitZeroHolding;
  }

  function findNonZeroPortfolioCoins() {
    const rows = tableRowsWithHeaders();
    const coins = [];

    rows.forEach(row => {
      const headerText = row.headers.map(normalize).join('|');
      const hasPortfolioHeaders = headerText.includes('coin')
        && (headerText.includes('holding') || headerText.includes('pnl') || headerText.includes('actions'));
      if (!hasPortfolioHeaders) return;

      const coinCellIndex = row.headers.findIndex(header => normalize(header) === 'coin' || normalize(header).includes('coin'));
      const holdingsCellIndex = row.headers.findIndex(header => normalize(header).includes('holding'));
      if (coinCellIndex < 0 || holdingsCellIndex < 0) return;

      const coinCellText = row.cells[coinCellIndex] || '';
      const holdingsText = row.cells[holdingsCellIndex] || '';
      if (!holdingsAreNonZero(holdingsText, row.text)) return;

      const identity = extractCoinNameAndSymbol(coinCellText);
      if (!identity.symbol && !identity.coin_name) return;

      coins.push({
        ...identity,
        holdings: holdingsText,
        rowText: row.text,
        rowIndex: coins.length + 1
      });
    });

    return coins;
  }

  function isPortfolioTableRow(row) {
    const headerText = row.headers.map(normalize).join('|');
    return headerText.includes('coin')
      && (headerText.includes('holding') || headerText.includes('pnl') || headerText.includes('actions'));
  }

  function headerIndex(row, pattern) {
    return row.headers.findIndex(header => pattern.test(normalize(header)));
  }

  function findCoinRowInfoByIdentity(coin) {
    const symbol = cleanText(coin.symbol).toUpperCase();
    const name = cleanText(coin.coin_name).toLowerCase();
    return tableRowsWithHeaders().find(row => {
      if (!isPortfolioTableRow(row)) return false;
      const text = row.text;
      return (symbol && new RegExp(`\\b${symbol}\\b`, 'i').test(text))
        || (name && text.toLowerCase().includes(name));
    }) || null;
  }

  function elementLabel(element) {
    if (!element) return '';
    return cleanText([
      element.innerText,
      element.getAttribute && element.getAttribute('aria-label'),
      element.getAttribute && element.getAttribute('data-testid'),
      element.title,
      element.textContent
    ].filter(Boolean).join(' '));
  }

  function interactiveControls(scope) {
    if (!scope) return [];
    return Array.from(scope.querySelectorAll('a, button, [role="button"], [role="menuitem"]'))
      .filter(isVisible);
  }

  function isAddTransactionControl(element) {
    const label = elementLabel(element);
    const visible = cleanText(element.innerText || element.textContent);
    return /add\s+transaction/i.test(label) || visible === '+' || /^\+$/.test(label);
  }

  function isMenuControl(element) {
    const label = elementLabel(element);
    return /more|menu|actions|kebab|dots|transaction|transactions|history|details|manage|edit|\u22ee|\u2026/i.test(label)
      || cleanText(element.innerText || element.textContent).includes('...')
      || cleanText(element.textContent || '').includes('\u22ee');
  }

  function isPublicCoinPage(originalUrl) {
    try {
      const current = new URL(location.href);
      return location.href !== originalUrl && /\/coins\//i.test(current.pathname);
    } catch (_) {
      return false;
    }
  }

  function domSignature() {
    return `${location.href}|${document.body.innerText.length}|${document.querySelectorAll('[role="dialog"], dialog, table, [role="row"]').length}`;
  }

  async function waitForDomChange(previousSignature, timeoutMs = 1800) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(120);
      if (domSignature() !== previousSignature) return true;
    }
    return false;
  }

  function findTransactionMenuItem() {
    const preferred = visibleTextElements('button, a, [role="menuitem"], [role="option"]')
      .filter(element => /transaction|transactions|history|details|manage|edit/i.test(elementLabel(element)))
      .filter(element => !isAddTransactionControl(element));
    return preferred[0] || null;
  }

  async function clickElement(element) {
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(120);
    const previous = domSignature();
    element.click();
    await waitForDomChange(previous, 2200);
    await sleep(250);
    return true;
  }

  async function closeOpenOverlay(originalUrl) {
    const closeButton = visibleTextElements('button, [role="button"], a')
      .find(element => /^(close|cancel|done|back|×|x)$/i.test(cleanText(element.innerText || element.getAttribute('aria-label') || element.textContent)));
    if (closeButton) {
      closeButton.click();
      await sleep(400);
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(250);

    if (location.href !== originalUrl) {
      history.back();
      await sleep(1200);
    }
  }

  function rowsForCoin(rows, coin) {
    const symbol = cleanText(coin.symbol).toUpperCase();
    const name = cleanText(coin.coin_name).toLowerCase();
    return rows.filter(row => {
      const text = cleanText(row.raw_text || Object.values(row).join(' '));
      if (symbol && (row.symbol === symbol || new RegExp(`\\b${symbol}\\b`, 'i').test(text))) return true;
      if (name && text.toLowerCase().includes(name)) return true;
      return false;
    }).map(row => ({
      ...row,
      symbol: row.symbol || symbol,
      coin_name: row.coin_name || coin.coin_name
    }));
  }

  async function tryOpenCoinTransactions(coin) {
    const row = findCoinRowInfoByIdentity(coin);
    if (!row) return { rows: [], opened: false, reason: 'row not found' };

    const rowEl = row.rowEl;
    const originalUrl = location.href;
    const beforeRows = dedupeRows([...scrapeTables(), ...scrapeRoleRows()]);
    let opened = false;
    let reason = '';

    const coinCellIndex = headerIndex(row, /coin/);
    const holdingsCellIndex = headerIndex(row, /holding/);
    const actionsCellIndex = headerIndex(row, /action/);
    const coinCell = row.cellElements[coinCellIndex] || null;
    const holdingsCell = row.cellElements[holdingsCellIndex] || null;
    const actionsCell = row.cellElements[actionsCellIndex] || null;

    const isUnsafeCoinTarget = element => {
      const anchor = element && element.closest ? element.closest('a') : null;
      if (anchor && /\/coins\//i.test(anchor.getAttribute('href') || '')) return true;
      return !!(coinCell && element && (element === coinCell || coinCell.contains(element)));
    };

    const collectNewRows = async () => {
      await autoLoadVisibleRows();
      const afterRows = dedupeRows([...scrapeTables(), ...scrapeRoleRows()]);
      return rowsForCoin(afterRows, coin).filter(row => {
        const key = [row.date, row.type, row.symbol, row.amount, row.price, row.total_value, row.raw_text].join('|').toLowerCase();
        return !beforeRows.some(existing => [existing.date, existing.type, existing.symbol, existing.amount, existing.price, existing.total_value, existing.raw_text].join('|').toLowerCase() === key);
      });
    };

    const legacyKebabButtons = Array.from(rowEl.querySelectorAll('button, [role="button"], a'))
      .filter(isVisible)
      .filter(element => {
        const label = cleanText(element.innerText || element.getAttribute('aria-label') || element.title || '');
        return /more|menu|actions|⋮|transaction|history|edit|details/i.test(label)
          || cleanText(element.innerText).includes('⋮')
          || cleanText(element.innerText).includes('...');
      });

    const actionControls = interactiveControls(actionsCell || rowEl)
      .filter(element => !isUnsafeCoinTarget(element));
    const explicitMenuControls = actionControls
      .filter(element => !isAddTransactionControl(element) && isMenuControl(element));
    const fallbackMenuControls = actionsCell && actionControls.length > 1
      ? [actionControls[actionControls.length - 1]].filter(element => !isAddTransactionControl(element))
      : [];
    const kebabButtons = Array.from(new Set([...explicitMenuControls, ...fallbackMenuControls]));

    for (const control of kebabButtons) {
      await clickElement(control);
      if (isPublicCoinPage(originalUrl)) {
        reason = 'CoinGecko opened the public coin chart instead of portfolio holdings.';
        await closeOpenOverlay(originalUrl);
        return { rows: [], opened: false, reason };
      }
      const menuItem = findTransactionMenuItem();
      if (menuItem) {
        await clickElement(menuItem);
        opened = true;
        break;
      }
      const openedRows = await collectNewRows();
      if (openedRows.length > 0) {
        await closeOpenOverlay(originalUrl);
        return { rows: openedRows, opened: true, reason: '' };
      }
    }

    if (!opened) {
      const rowControls = interactiveControls(rowEl)
        .filter(element => !isUnsafeCoinTarget(element))
        .filter(element => !isAddTransactionControl(element));
      const transactionTarget = rowControls.find(element => {
        const label = elementLabel(element);
        return /transaction|transactions|history|details|manage|edit/i.test(label);
      });
      const addTransactionTarget = rowControls.find(element => {
        const label = cleanText(element.innerText || element.getAttribute('aria-label') || element.title || element.textContent);
        return /add\s+transaction|transaction/i.test(label) || label === '+';
      });
      const coinLinkTarget = rowControls.find(element => {
          const text = cleanText(element.innerText || element.textContent);
          return text && !/^buy$/i.test(text) && !/^\+$/.test(text);
      });
      const holdingsControls = interactiveControls(holdingsCell)
        .filter(element => !isUnsafeCoinTarget(element))
        .filter(element => !isAddTransactionControl(element));
      const holdingsTarget = holdingsControls[0] || holdingsCell;
      const directTarget = transactionTarget || holdingsTarget;
      if (directTarget) {
        await clickElement(directTarget);
        if (isPublicCoinPage(originalUrl)) {
          reason = 'CoinGecko opened the public coin chart instead of portfolio holdings.';
          await closeOpenOverlay(originalUrl);
          return { rows: [], opened: false, reason };
        }
        opened = true;
      }
    }

    if (!opened) {
      reason = reason || 'could not find a holdings or actions control for this coin';
    }

    const newRows = opened ? await collectNewRows() : [];

    if (newRows.length === 0) {
      reason = opened ? 'opened holdings/actions, but no transaction table was found' : reason;
    }

    await closeOpenOverlay(originalUrl);
    return { rows: newRows, opened, reason };
  }

  async function exportPortfolioNonZeroTransactions() {
    await autoLoadVisibleRows();
    const coins = findNonZeroPortfolioCoins();
    const exported = [];
    const failures = [];
    let openedCount = 0;

    for (const coin of coins) {
      const result = await tryOpenCoinTransactions(coin);
      if (result.opened) openedCount += 1;
      if (result.rows.length > 0) {
        exported.push(...result.rows);
      } else {
        failures.push(`${coin.symbol || coin.coin_name}: ${result.reason || 'no rows'}`);
      }
      await sleep(350);
    }

    const rows = dedupeRows(exported);
    return {
      ok: true,
      rows,
      pageTitle: document.title,
      summary: {
        coinsChecked: coins.length,
        coinsOpened: openedCount,
        coinsFailed: failures.length
      },
      note: rows.length
        ? failures.slice(0, 6).join('\n')
        : `Found ${coins.length} non-zero coins, but could not find transaction rows. ${failures.slice(0, 6).join('\n')}`
    };
  }

  async function autoLoadVisibleRows() {
    let previousHeight = 0;
    for (let i = 0; i < 8; i += 1) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
      await new Promise(resolve => setTimeout(resolve, 650));
      const loadMore = Array.from(document.querySelectorAll('button, a'))
        .find(el => /load more|show more|more transactions/i.test(cleanText(el.innerText)) && !el.disabled);
      if (loadMore) {
        loadMore.click();
        await new Promise(resolve => setTimeout(resolve, 900));
      }
      const currentHeight = document.body.scrollHeight;
      if (currentHeight === previousHeight && !loadMore) break;
      previousHeight = currentHeight;
    }
  }

  async function exportRows(mode) {
    if (mode === 'portfolio-nonzero') {
      return exportPortfolioNonZeroTransactions();
    }
    if (mode === 'autoload') {
      await autoLoadVisibleRows();
    }
    const rows = dedupeRows([...scrapeTables(), ...scrapeRoleRows()]);
    return {
      ok: true,
      rows,
      pageTitle: document.title,
      note: rows.length ? '' : 'Scroll or open the CoinGecko transactions page, then try again.'
    };
  }

  window.__LABSUITE_COINGECKO_EXPORTER_API__ = {
    exportRows,
    findNonZeroPortfolioCoins
  };

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'LABSUITE_EXPORT_COINGECKO') return false;
      exportRows(message.mode)
        .then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: error.message || 'Export failed.' }));
      return true;
    });
  }
})();
