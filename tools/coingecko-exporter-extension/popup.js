let lastCsv = '';
let lastRows = [];

const statusText = document.getElementById('statusText');
const preview = document.getElementById('preview');
const downloadButton = document.getElementById('downloadCsv');

function setStatus(message, detail = '') {
  statusText.textContent = message;
  preview.textContent = detail;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  const headers = ['date', 'type', 'coin_name', 'symbol', 'amount', 'price', 'total_value', 'fee', 'notes', 'source', 'raw_text'];
  return [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header] || '')).join(','))
  ].join('\r\n');
}

async function getActiveCoinGeckoTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https:\/\/www\.coingecko\.com\//i.test(tab.url || '')) {
    throw new Error('Open CoinGecko in this tab first.');
  }
  return tab;
}

async function sendExportMessage(mode) {
  const tab = await getActiveCoinGeckoTab();
  const message = { type: 'LABSUITE_EXPORT_COINGECKO', mode };

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (firstError) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

function updateResult(result) {
  if (!result || result.ok === false) {
    throw new Error(result?.error || 'No response from CoinGecko page.');
  }

  lastRows = result.rows || [];
  lastCsv = toCsv(lastRows);
  downloadButton.disabled = lastRows.length === 0;

  const source = result.pageTitle ? `\nPage: ${result.pageTitle}` : '';
  const sample = lastRows.slice(0, 3)
    .map(row => `${row.date || '-'} | ${row.type || '-'} | ${row.coin_name || row.symbol || '-'} | ${row.amount || '-'} @ ${row.price || '-'}`)
    .join('\n');
  const summary = result.summary
    ? `\nCoins checked: ${result.summary.coinsChecked || 0}; opened: ${result.summary.coinsOpened || 0}; failed: ${result.summary.coinsFailed || 0}`
    : '';

  setStatus(
    lastRows.length ? `Found ${lastRows.length} loaded transaction rows.` : 'No transaction rows found on this loaded page.',
    `${sample}${source}${summary}${result.note ? `\n${result.note}` : ''}`
  );
}

async function runExport(mode) {
  downloadButton.disabled = true;
  lastCsv = '';
  lastRows = [];
  const message = mode === 'portfolio-nonzero'
    ? 'Scanning non-zero holdings... keep this popup open.'
    : mode === 'autoload'
      ? 'Loading the current CoinGecko page...'
      : 'Reading current CoinGecko rows...';
  setStatus(message);

  try {
    const result = await sendExportMessage(mode);
    updateResult(result);
  } catch (error) {
    setStatus(error.message || 'Export failed.');
  }
}

document.getElementById('exportVisible').addEventListener('click', () => runExport('visible'));
document.getElementById('exportPortfolioCoins').addEventListener('click', () => runExport('portfolio-nonzero'));
document.getElementById('autoLoadExport').addEventListener('click', () => runExport('autoload'));

downloadButton.addEventListener('click', () => {
  if (!lastCsv) return;
  const blob = new Blob([lastCsv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  link.href = url;
  link.download = `labsuite-coingecko-transactions-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});
