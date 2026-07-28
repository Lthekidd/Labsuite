const { app, BrowserWindow, Tray, Menu, desktopCapturer, screen, globalShortcut, clipboard, nativeImage, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const db = require('./database');

let labShotTray = null;
let activeOverlayWindow = null;
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
  const iconPath = resolveAssetPath('tray-labshot.png');
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    if (typeof image.setTemplateImage === 'function') image.setTemplateImage(false);
    return image;
  }
  // Fallback 16x16 purple native image
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

/**
 * Capture full screen data URL from the primary display
 */
async function capturePrimaryScreen() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.bounds;
  const scale = primaryDisplay.scaleFactor || 1;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * scale),
      height: Math.round(height * scale)
    }
  });

  const primarySource = sources[0] || sources.find(s => s.id.includes('screen:0'));
  if (!primarySource) throw new Error('No screen capture source available.');

  return primarySource.thumbnail.toDataURL();
}

/**
 * Open fullscreen Flameshot-style overlay for area selection & editing
 */
async function startCapture({ delayMs = 0 } = {}) {
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  try {
    const dataUrl = await capturePrimaryScreen();
    capturedDataUrlCache = dataUrl;

    if (activeOverlayWindow && !activeOverlayWindow.isDestroyed()) {
      activeOverlayWindow.close();
    }

    const primaryDisplay = screen.getPrimaryDisplay();
    const { x, y, width, height } = primaryDisplay.bounds;

    const overlayWin = new BrowserWindow({
      x,
      y,
      width,
      height,
      fullscreen: true,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    overlayWin.isLabShotOverlay = true;

    const isDev = !app.isPackaged && process.env.VITE_DEV_SERVER_URL;
    if (isDev) {
      overlayWin.loadURL(`${process.env.VITE_DEV_SERVER_URL}?app=labshot-overlay`);
    } else {
      overlayWin.loadFile(path.join(__dirname, '../dist/index.html'), { query: { app: 'labshot-overlay' } });
    }

    activeOverlayWindow = overlayWin;

    overlayWin.on('closed', () => {
      if (activeOverlayWindow === overlayWin) activeOverlayWindow = null;
    });

    return { success: true };
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
  const defaultX = x !== undefined ? x : Math.round(primaryDisplay.bounds.width / 2 - width / 2);
  const defaultY = y !== undefined ? y : Math.round(primaryDisplay.bounds.height / 2 - height / 2);

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
function recordScreenshotHistory(entry) {
  const history = db.getDb().labshot_history || [];
  const record = {
    id: `shot-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    title: entry.title || `LabShot ${new Date().toLocaleString()}`,
    dataUrl: entry.dataUrl,
    width: entry.width || 0,
    height: entry.height || 0,
    savedToVault: !!entry.savedToVault,
    savedToDisk: entry.savedToDisk || null
  };

  history.unshift(record);
  // Keep last 50 screenshots in memory database
  if (history.length > 50) history.length = 50;
  db.getDb().labshot_history = history;
  db.saveDatabase();

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

  ipcMain.handle('labshot:getCapturedScreen', async () => {
    return { dataUrl: capturedDataUrlCache };
  });

  ipcMain.handle('labshot:closeOverlay', async () => {
    if (activeOverlayWindow && !activeOverlayWindow.isDestroyed()) {
      activeOverlayWindow.close();
      activeOverlayWindow = null;
    }
    return { success: true };
  });

  ipcMain.handle('labshot:copyToClipboard', async (event, { dataUrl }) => {
    if (!dataUrl) throw new Error('No image data provided for clipboard.');
    const image = nativeImage.createFromDataURL(dataUrl);
    clipboard.writeImage(image);
    recordScreenshotHistory({ dataUrl, title: 'Copied Screenshot' });
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
    recordScreenshotHistory({ dataUrl, title: path.basename(targetPath), savedToDisk: targetPath });
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

    const record = recordScreenshotHistory({
      dataUrl,
      title: title || fileName,
      savedToVault: true,
      savedToDisk: targetPath
    });

    return { success: true, record };
  });

  ipcMain.handle('labshot:pinToScreen', async (event, { dataUrl, width, height, x, y }) => {
    return pinToScreen({ dataUrl, width, height, x, y });
  });

  ipcMain.handle('labshot:getGallery', async () => {
    const memoryHistory = [...(db.getDb().labshot_history || [])];
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
    let history = db.getDb().labshot_history || [];
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
    db.getDb().labshot_history = history;
    db.saveDatabase();
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
  pinToScreen
};
