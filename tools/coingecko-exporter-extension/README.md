# LabSuite CoinGecko Exporter

Local-only Chrome extension for exporting CoinGecko portfolio transaction rows into a CSV that LabSuite can import.

## Install

1. Open Chrome and go to `chrome://extensions`.
2. Turn on Developer Mode.
3. Click Load unpacked.
4. Select this folder: `E:\LabSuite\tools\coingecko-exporter-extension`.

## Export

1. Log in to CoinGecko.
2. Open your CoinGecko portfolio page in Chrome.
3. Click the LabSuite CoinGecko Exporter extension.
4. Use Scan Non-Zero Holdings from the portfolio holdings page to collect transaction rows for coins with balances.
5. Use Export Current Rows from a transaction page/modal when transactions are already visible.
6. Use Auto-Load Current Page if CoinGecko lazy-loads rows on the current page.
7. Download the CSV and import it in LabSuite Crypto Tracker.

If you already loaded this extension in Chrome, open `chrome://extensions` and click Reload after updating these files.

## Privacy

This extension has no server code and makes no external requests. It reads the currently loaded CoinGecko page and downloads a local CSV from your browser.

## CSV Columns

`date,type,coin_name,symbol,amount,price,total_value,fee,notes,source,raw_text`

LabSuite does not need exported holdings, PNL, 1h/24h/7d changes, market cap, or volume. It rebuilds holdings and PNL from dated buy/sell transaction rows.
