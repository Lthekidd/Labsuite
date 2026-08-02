const { app, BrowserWindow, Tray, Menu, desktopCapturer, screen, globalShortcut, clipboard, nativeImage, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const db = require('./database');

let labShotTray = null;
let activeOverlayWindows = [];
const pinnedWindows = new Set();
let capturedDataUrlCache = null;

function resolveAssetPath(fileName) {
  const candidates = [
    app.isPackaged && process.resourcesPath ? path.join(process.resourcesPath, 'assets', fileName) : null,
    path.join(__dirname, '../assets', fileName),
    path.join(process.cwd(), 'assets', fileName)
  ].filter(Boolean);

  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function getLabShotTrayImage() {
  const iconPath = resolveAssetPath(path.join('brand', 'labshot-mark-ui.png'));
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    const trayImage = image.resize({ width: 32, height: 32, quality: 'best' });
    if (typeof trayImage.setTemplateImage === 'function') trayImage.setTemplateImage(false);
    return trayImage;
  }
  const size = 16;
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size * 4; i += 4) {
    data[i] = 168;
    data[i + 1] = 85;
    data[i + 2] = 247;
    data[i + 3] = 255;
  }
  return nativeImage.createFromBuffer(data, { width: size, height: size });
}

function getMainWindow() {
  const windows = BrowserWindow.getAllWindows();
  return windows.find(w => !w.isDestroyed() && !w.isLabShotOverlay && !w.isLabShotPin);
}

function focusLabShotApp() {
  const win = getMainWindow();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('app:navigate', { tab: 'labshot' });
  }
}

function getVirtualDesktopBounds(displays) {
  if (!Array.isArray(displays) || displays.length === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }

  const left = Math.min(...displays.map(display => display.bounds.x));
  const top = Math.min(...displays.map(display => display.bounds.y));
  const right = Math.max(...displays.map(display => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map(display => display.bounds.y + display.bounds.height));

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

function findSourceForDisplay(display, sources, displays, primaryDisplay) {
  if (!sources || sources.length === 0) return null;
  const displayIdStr = String(display.id);

  // 1. Direct display_id match
  let match = sources.find(s => s.display_id && String(s.display_id) === displayIdStr);
  if (match) return match;

  // 2. source.id contains display.id
  match = sources.find(s => s.id && String(s.id).includes(displayIdStr));
  if (match) return match;

  // 3. source.name contains display.id
  match = sources.find(s => s.name && String(s.name).includes(displayIdStr));
  if (match) return match;

  // 4. Match primary display
  if (primaryDisplay && display.id === primaryDisplay.id) {
    match = sources.find(s => s.name && (s.name.includes('1') || s.name.toLowerCase().includes('primary')));
    if (match) return match;
  }

  // 5. Match by aspect ratio & resolution
  const targetW = Math.round(display.bounds.width * (display.scaleFactor || 1));
  const targetH = Math.round(display.bounds.height * (display.scaleFactor || 1));
  const targetAspect = targetW / targetH;

  let bestAspectMatch = null;
  let minAspectDiff = Infinity;

  for (const s of sources) {
    if (!s.thumbnail || s.thumbnail.isEmpty()) continue;
    const size = s.thumbnail.getSize();
    if (size.width === 0 || size.height === 0) continue;
    const aspect = size.width / size.height;
    const diff = Math.abs(aspect - targetAspect);
    if (diff < minAspectDiff) {
      minAspectDiff = diff;
      bestAspectMatch = s;
    }
  }
  if (bestAspectMatch && minAspectDiff < 0.1) {
    return bestAspectMatch;
  }

  // 6. Positional index fallback: sort displays left-to-right
  const sortedDisplays = [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const displayIndex = sortedDisplays.findIndex(d => d.id === display.id);
  if (displayIndex >= 0 && displayIndex < sources.length) {
    return sources[displayIndex];
  }

  return sources[0];
}

/**
 * Open native per-monitor overlay windows across all connected displays.
 * Creating one overlay window per display ensures Windows OS applies per-monitor DPI scaling,
 * preventing 25% zoomed-in/clipped screen captures on High-DPI displays.
 */
async function startCapture({ delayMs = 0 } = {}) {
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  try {
    // Close existing overlay windows
    activeOverlayWindows.forEach(win => {
      if (win && !win.isDestroyed()) win.close();
    });
    activeOverlayWindows = [];

    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    const virtualBounds = getVirtualDesktopBounds(displays);
    const maxScale = Math.max(1, ...displays.map(d => d.scaleFactor || 1));
    const maxCaptureWidth = Math.ceil(virtualBounds.width * maxScale);
    const maxCaptureHeight = Math.ceil(virtualBounds.height * maxScale);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxCaptureWidth, height: maxCaptureHeight },
      fetchWindowIcons: false
    });

    const isDev = !app.isPackaged && process.env.VITE_DEV_SERVER_URL;

    for (const display of displays) {
      const source = findSourceForDisplay(display, sources, displays, primaryDisplay);
      const dataUrl = source && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null;

      if (dataUrl && !capturedDataUrlCache) {
        capturedDataUrlCache = dataUrl;
      }

      const overlayWin = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        fullscreen: false,
        fullscreenable: false,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        enableLargerThanScreen: true,
        icon: resolveAssetPath('labshot-icon.png'),
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false
        }
      });

      overlayWin.overlayDataUrl = dataUrl;
      overlayWin.overlayScreenData = {
        dataUrl,
        displayId: String(display.id),
        width: display.bounds.width,
        height: display.bounds.height,
        scaleFactor: display.scaleFactor || 1
      };
      overlayWin.isLabShotOverlay = true;
      overlayWin.setAlwaysOnTop(true, 'screen-saver');
      overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

      if (isDev) {
        overlayWin.loadURL(`${process.env.VITE_DEV_SERVER_URL}?app=labshot-overlay`);
      } else {
        overlayWin.loadFile(path.join(__dirname, '../dist/index.html'), { query: { app: 'labshot-overlay' } });
      }

      activeOverlayWindows.push(overlayWin);
    }

    return { success: true, displayCount: displays.length };
  } catch (error) {
    console.error('LabShot: failed to capture screen:', error.message);
    throw error;
  }
}

/**
 * Pin screenshot selection as a floating borderless widget
 */
function pinToScreen({ dataUrl, width = 320, height = 240, x, y }) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const defaultX = x !== undefined
    ? x
    : primaryDisplay.bounds.x + Math.round(primaryDisplay.bounds.width / 2 - width / 2);
  const defaultY = y !== undefined
    ? y
    : primaryDisplay.bounds.y + Math.round(primaryDisplay.bounds.height / 2 - height / 2);

  const pinWin = new BrowserWindow({
    x: defaultX,
    y: defaultY,
    width: Math.max(100, Math.round(width)),
    height: Math.max(100, Math.round(height)),
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    transparent: true,
    resizable: true,
    hasShadow: true,
    icon: resolveAssetPath('labshot-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  pinWin.isLabShotPin = true;
  pinWin.pinDataUrl = dataUrl;

  const isDev = !app.isPackaged && process.env.VITE_DEV_SERVER_URL;
  if (isDev) {
    pinWin.loadURL(`${process.env.VITE_DEV_SERVER_URL}?app=labshot-pin`);
  } else {
    pinWin.loadFile(path.join(__dirname, '../dist/index.html'), { query: { app: 'labshot-pin' } });
  }

  pinnedWindows.add(pinWin);

  pinWin.on('closed', () => {
    pinnedWindows.delete(pinWin);
  });

  return { success: true };
}

/**
 * Save screenshot to local LabShot history and encrypted DB
 */
function getLabShotHistoryDir() {
  return path.join(app.getPath('userData'), 'LabShot', 'History');
}

async function writeHistoryImage(dataUrl, recordId) {
  if (!dataUrl) return null;
  const historyDir = getLabShotHistoryDir();
  await fs.promises.mkdir(historyDir, { recursive: true });
  const targetPath = path.join(historyDir, `${recordId}.png`);
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error('Screenshot history image is invalid.');
  await fs.promises.writeFile(targetPath, image.toPNG());
  return targetPath;
}

async function recordScreenshotHistory(entry) {
  const history = db.getLabShotHistory();
  const id = `shot-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const savedToDisk = entry.savedToDisk || await writeHistoryImage(entry.dataUrl, id);
  const record = {
    id,
    timestamp: new Date().toISOString(),
    title: entry.title || `LabShot ${new Date().toLocaleString()}`,
    width: entry.width || 0,
    height: entry.height || 0,
    savedToVault: !!entry.savedToVault,
    savedToDisk
  };

  history.unshift(record);
  // Keep last 50 screenshots in memory database
  if (history.length > 50) history.length = 50;
  db.setLabShotHistory(history);

  return record;
}

function initLabShotTray() {
  try {
    labShotTray = new Tray(getLabShotTrayImage());
    labShotTray.setToolTip('LabShot - Instant Screen Capture & Vault Encryption');

    const contextMenu = Menu.buildFromTemplate([
      { label: 'LabShot Screenshot', enabled: false },
      { type: 'separator' },
      {
        label: '📸 Take Screenshot (Click Tray)',
        click: () => startCapture()
      },
      {
        label: '⏱️ 3-Second Delayed Capture',
        click: () => startCapture({ delayMs: 3000 })
      },
      {
        label: '⏱️ 5-Second Delayed Capture',
        click: () => startCapture({ delayMs: 5000 })
      },
      { type: 'separator' },
      {
        label: '🖼️ Open Screenshot Gallery',
        click: () => focusLabShotApp()
      },
      { type: 'separator' },
      {
        label: 'Close LabShot Tray',
        click: () => {
          if (labShotTray) {
            labShotTray.destroy();
            labShotTray = null;
          }
        }
      }
    ]);

    labShotTray.setContextMenu(contextMenu);

    labShotTray.on('click', () => {
      startCapture();
    });

    console.log('LabShot tray initialized.');
  } catch (error) {
    console.error('LabShot: failed to initialize tray:', error.message);
  }
}

function registerHotkeys() {
  try {
    globalShortcut.unregister('Alt+Shift+S');
    globalShortcut.register('Alt+Shift+S', () => {
      startCapture();
    });
  } catch (err) {
    console.warn('LabShot: failed to register hotkey:', err.message);
  }
}

function initIpc() {
  ipcMain.handle('labshot:startCapture', async (event, args = {}) => {
    return startCapture(args);
  });

  ipcMain.handle('labshot:getCapturedScreen', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && win.overlayScreenData) {
      return win.overlayScreenData;
    }
    if (win && win.overlayDataUrl) {
      return { dataUrl: win.overlayDataUrl };
    }
    return { dataUrl: capturedDataUrlCache };
  });

  ipcMain.handle('labshot:openScreenshotsFolder', async () => {
    const labshotDir = path.join(app.getPath('documents'), 'LabSuite', 'Screenshots');
    await fs.promises.mkdir(labshotDir, { recursive: true });
    require('electron').shell.openPath(labshotDir);
    return { success: true };
  });

  ipcMain.handle('labshot:getPinnedSnippet', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && win.pinDataUrl) {
      return { dataUrl: win.pinDataUrl };
    }
    return { dataUrl: null };
  });

  ipcMain.handle('labshot:closeOverlay', async () => {
    activeOverlayWindows.forEach(win => {
      if (win && !win.isDestroyed()) win.close();
    });
    activeOverlayWindows = [];
    return { success: true };
  });

  ipcMain.handle('labshot:copyToClipboard', async (event, { dataUrl, text }) => {
    if (text) {
      clipboard.writeText(text);
      return { success: true };
    }
    if (!dataUrl) throw new Error('No image data provided for clipboard.');
    const image = nativeImage.createFromDataURL(dataUrl);
    clipboard.writeImage(image);
    await recordScreenshotHistory({ dataUrl, title: 'Copied Screenshot' });
    return { success: true };
  });

  ipcMain.handle('labshot:saveToFile', async (event, { dataUrl, filePath }) => {
    if (!dataUrl) throw new Error('No image data provided.');
    const image = nativeImage.createFromDataURL(dataUrl);
    const pngBuffer = image.toPNG();

    let targetPath = filePath;
    if (!targetPath) {
      const { dialog } = require('electron');
      const win = getMainWindow();
      const result = await dialog.showSaveDialog(win, {
        title: 'Save Screenshot',
        defaultPath: path.join(app.getPath('pictures'), `LabShot_${Date.now()}.png`),
        filters: [{ name: 'PNG Images', extensions: ['png'] }]
      });
      if (result.canceled || !result.filePath) return { cancelled: true };
      targetPath = result.filePath;
    }

    await fs.promises.writeFile(targetPath, pngBuffer);
    await recordScreenshotHistory({ dataUrl, title: path.basename(targetPath), savedToDisk: targetPath });
    return { success: true, filePath: targetPath };
  });

  ipcMain.handle('labshot:saveToVault', async (event, { dataUrl, title }) => {
    if (!dataUrl) throw new Error('No image data provided.');

    const image = nativeImage.createFromDataURL(dataUrl);
    const pngBuffer = image.toPNG();

    // Save to user documents / LabSuite screenshots folder
    const labshotDir = path.join(app.getPath('documents'), 'LabSuite', 'Screenshots');
    await fs.promises.mkdir(labshotDir, { recursive: true });

    const fileName = `LabShot_${Date.now()}.png`;
    const targetPath = path.join(labshotDir, fileName);
    await fs.promises.writeFile(targetPath, pngBuffer);

    const record = await recordScreenshotHistory({
      dataUrl,
      title: title || fileName,
      savedToVault: true,
      savedToDisk: targetPath
    });

    return { success: true, record };
  });

  ipcMain.handle('labshot:pinToScreen', async (event, { dataUrl, width, height, x, y }) => {
    const sourceWin = BrowserWindow.fromWebContents(event.sender);
    const sourceBounds = sourceWin?.isLabShotOverlay ? sourceWin.getBounds() : null;
    return pinToScreen({
      dataUrl,
      width,
      height,
      x: x !== undefined && sourceBounds ? sourceBounds.x + x : x,
      y: y !== undefined && sourceBounds ? sourceBounds.y + y : y
    });
  });

  ipcMain.handle('labshot:getGallery', async () => {
    const storedHistory = db.getLabShotHistory();
    const memoryHistory = [];
    const compactedHistory = [];
    let historyChanged = false;

    // Older builds embedded full base64 screenshots in labsuite_db.json. Move
    // them to files lazily so the main database remains small and cheap to save.
    for (const stored of storedHistory) {
      const compacted = { ...stored };
      let dataUrl = stored.dataUrl || null;
      let savedToDisk = stored.savedToDisk || null;

      if (dataUrl) {
        try {
          if (savedToDisk) {
            await fs.promises.access(savedToDisk, fs.constants.F_OK);
          } else {
            savedToDisk = await writeHistoryImage(dataUrl, stored.id || `legacy-${Date.now()}`);
            compacted.savedToDisk = savedToDisk;
          }
          delete compacted.dataUrl;
          historyChanged = true;
        } catch (error) {
          try {
            savedToDisk = await writeHistoryImage(dataUrl, stored.id || `legacy-${Date.now()}`);
            compacted.savedToDisk = savedToDisk;
            delete compacted.dataUrl;
            historyChanged = true;
          } catch (fallbackError) {
            console.warn('LabShot: Could not externalize legacy screenshot history:', fallbackError.message || error.message);
          }
        }
      }

      if (!dataUrl && savedToDisk) {
        try {
          const imageBuf = await fs.promises.readFile(savedToDisk);
          dataUrl = `data:image/png;base64,${imageBuf.toString('base64')}`;
        } catch (_) {}
      }

      compactedHistory.push(compacted);
      memoryHistory.push({ ...compacted, dataUrl });
    }

    if (historyChanged) db.setLabShotHistory(compactedHistory);
    const memoryPaths = new Set(memoryHistory.map(item => item.savedToDisk).filter(Boolean));

    // Also scan LabSuite Screenshots directory for vault / decrypted files
    try {
      const labshotDir = path.join(app.getPath('documents'), 'LabSuite', 'Screenshots');
      if (fs.existsSync(labshotDir)) {
        const files = await fs.promises.readdir(labshotDir);
        for (const file of files) {
          if (!/\.(png|jpg|jpeg|webp)$/i.test(file)) continue;
          const fullPath = path.join(labshotDir, file);
          if (memoryPaths.has(fullPath)) continue;

          try {
            const stat = await fs.promises.stat(fullPath);
            const imageBuf = await fs.promises.readFile(fullPath);
            const dataUrl = `data:image/png;base64,${imageBuf.toString('base64')}`;

            memoryHistory.push({
              id: `vault-${file}`,
              timestamp: stat.mtime.toISOString(),
              title: file,
              dataUrl,
              savedToVault: true,
              savedToDisk: fullPath
            });
            memoryPaths.add(fullPath);
          } catch (_) {}
        }
      }
    } catch (_) {}

    // Sort by newest timestamp first
    memoryHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return memoryHistory;
  });

  ipcMain.handle('labshot:deleteScreenshot', async (event, { id }) => {
    let history = db.getLabShotHistory();
    const itemToDelete = history.find(item => item.id === id);

    // If file exists on disk, remove it
    if (itemToDelete && itemToDelete.savedToDisk && fs.existsSync(itemToDelete.savedToDisk)) {
      try {
        await fs.promises.unlink(itemToDelete.savedToDisk);
      } catch (_) {}
    } else if (typeof id === 'string' && id.startsWith('vault-')) {
      const fileName = id.replace('vault-', '');
      const fullPath = path.join(app.getPath('documents'), 'LabSuite', 'Screenshots', fileName);
      if (fs.existsSync(fullPath)) {
        try {
          await fs.promises.unlink(fullPath);
        } catch (_) {}
      }
    }

    history = history.filter(item => item.id !== id);
    db.setLabShotHistory(history);
    return { success: true };
  });
}

function init() {
  initIpc();
  initLabShotTray();
  registerHotkeys();
  console.log('LabShot initialized successfully.');
}

module.exports = {
  init,
  startCapture,
  pinToScreen,
  getVirtualDesktopBounds
};
