// file_crc: 0x4c6162
const { app, BrowserWindow, shell: electronShell } = require('electron');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { initLogger, getLogPath, write: writeLog } = require('./logger');
const crashMonitor = require('./crashMonitor');

const isDev = (process.env.NODE_ENV === 'development' || !app.isPackaged) && process.env.LABSUITE_LOAD_DIST !== '1';
app.setName('LabSuite');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.labsuite.app');
}

// ── Logger ──────────────────────────────────────────────────────────────────
// Init first so all subsequent require()'s are covered by the patched console.
initLogger(isDev);

// ── Late requires (after logger is live) ────────────────────────────────────
// Lazy-load backend modules using wrappers to avoid synchronous require at startup
const db = {
  initDatabase: (...args) => require('./database').initDatabase(...args),
  getDb: (...args) => require('./database').getDb(...args),
  getFolders: (...args) => require('./database').getFolders(...args),
  getEnabledFolders: (...args) => require('./database').getEnabledFolders(...args),
  addFolder: (...args) => require('./database').addFolder(...args),
  removeFolder: (...args) => require('./database').removeFolder(...args),
  updateFolderEnabled: (...args) => require('./database').updateFolderEnabled(...args),
  updateFolderEncryption: (...args) => require('./database').updateFolderEncryption(...args),
  addFolderExclusion: (...args) => require('./database').addFolderExclusion(...args),
  removeFolderExclusion: (...args) => require('./database').removeFolderExclusion(...args),
  updateFolderSyncStatus: (...args) => require('./database').updateFolderSyncStatus(...args),
  updateFolderSyncProgress: (...args) => require('./database').updateFolderSyncProgress(...args),
  updateFolderRemoteIntegrityScan: (...args) => require('./database').updateFolderRemoteIntegrityScan(...args),
  getSyncLogs: (...args) => require('./database').getSyncLogs(...args),
  addSyncLog: (...args) => require('./database').addSyncLog(...args),
  clearSyncLogs: (...args) => require('./database').clearSyncLogs(...args),
  getManifestEntries: (...args) => require('./database').getManifestEntries(...args),
  getManifestEntry: (...args) => require('./database').getManifestEntry(...args),
  upsertManifestEntry: (...args) => require('./database').upsertManifestEntry(...args),
  markManifestDirty: (...args) => require('./database').markManifestDirty(...args),
  markManifestDeleted: (...args) => require('./database').markManifestDeleted(...args),
  removeManifestFolder: (...args) => require('./database').removeManifestFolder(...args),
  removeManifestEntry: (...args) => require('./database').removeManifestEntry(...args),
  addRestorePoint: (...args) => require('./database').addRestorePoint(...args),
  getRestorePoints: (...args) => require('./database').getRestorePoints(...args),
  getAnalyticsSummary: (...args) => require('./database').getAnalyticsSummary(...args),
  getSetting: (...args) => require('./database').getSetting(...args),
  setSetting: (...args) => require('./database').setSetting(...args),
  getAllSettings: (...args) => require('./database').getAllSettings(...args),
  setCache: (...args) => require('./database').setCache(...args),
  getCache: (...args) => require('./database').getCache(...args),
  deleteCache: (...args) => require('./database').deleteCache(...args),
  withWriteBatch: (...args) => require('./database').withWriteBatch(...args),
  flushWrites: (...args) => require('./database').flushWrites(...args),
  flushWritesAsync: (...args) => require('./database').flushWritesAsync(...args)
};
crashMonitor.configure({ db });

const watcher = {
  initWatcher: (...args) => require('./watcher').initWatcher(...args),
  stopWatcher: (...args) => require('./watcher').stopWatcher(...args)
};

const scheduler = {
  startScheduler: (...args) => require('./scheduler').startScheduler(...args),
  runFullSync: (...args) => require('./scheduler').runFullSync(...args),
  stopScheduler: (...args) => require('./scheduler').stopScheduler(...args)
};

const autostart = {
  reconcileAutostart: (...args) => require('./autostart').reconcileAutostart(...args)
};

const initTray = (...args) => require('./tray').initTray(...args);
const updateTrayStatus = (...args) => require('./tray').updateTrayStatus(...args);
const setupIpc = (...args) => require('./ipc').setupIpc(...args);

const WINDOW_TITLEBAR_HEIGHT = 36;
const WINDOW_TITLEBAR_COLOR = '#273338';
const WINDOW_TITLEBAR_SYMBOL_COLOR = '#f1f5f3';

let mainWindow = null;
let isQuitting = false; // module-level flag, avoids mutating the Electron app object
let mainWindowShown = false;
let quitCleanupStarted = false;
let quitDatabaseFlushComplete = false;
let quitDatabaseFlushPromise = null;
const recentRendererMessages = new Map();
let autoUpdater = null;
let updaterInitialized = false;
let updateCheckPromise = null;
let updateStatus = {
  supported: false,
  status: 'unavailable',
  currentVersion: app.getVersion(),
  availableVersion: null,
  progress: null,
  lastCheckedAt: null,
  message: 'Update checks are available in the installed version of LabSuite.'
};

function getUpdateStatus() {
  return { ...updateStatus };
}

function publishUpdateStatus(changes = {}) {
  updateStatus = { ...updateStatus, ...changes, currentVersion: app.getVersion() };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updates:status', getUpdateStatus());
  }
  return getUpdateStatus();
}

function isTrustedRendererUrl(rawUrl) {
  try {
    const target = new URL(rawUrl);
    if (isDev) {
      return target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname);
    }
    if (target.protocol !== 'file:') return false;
    const expected = path.resolve(__dirname, '../dist/index.html');
    return path.resolve(fileURLToPath(target)) === expected;
  } catch (_) {
    return false;
  }
}

function captureRendererConsole(level, message, line, sourceId) {
  // Renderer consoles can be extremely noisy (for example one warning per
  // transfer chunk). Keep useful warnings/errors without blocking Electron's
  // main thread on a synchronous append for every message.
  if (Number(level) < 2) return;
  const text = String(message || '').slice(0, 4000);
  const key = `${level}:${text}`;
  const now = Date.now();
  const previous = recentRendererMessages.get(key) || 0;
  if (now - previous < 5000) return;
  recentRendererMessages.set(key, now);
  if (recentRendererMessages.size > 200) {
    for (const [entryKey, timestamp] of recentRendererMessages) {
      if (now - timestamp > 60000) recentRendererMessages.delete(entryKey);
    }
  }
  writeLog('RENDERER', [`[${level}] ${text}${sourceId ? ` (${sourceId}:${line || 0})` : ''}`]);
}

// ── Single instance lock ─────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();

      // Check for text file arguments (launched via File Association)
      const filePath = commandLine.find(arg => arg.endsWith('.txt') && fs.existsSync(arg));
      if (filePath) {
        mainWindow.webContents.send('notepad:open-file', filePath);
      }
    }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindowShown = true;
}

function canCheckForUpdates() {
  if (isDev) return false;

  const updateConfigPath = path.join(process.resourcesPath, 'app-update.yml');
  if (!fs.existsSync(updateConfigPath)) {
    console.warn('LabSuite: Auto-updater disabled for this build.');
    return false;
  }

  return true;
}

function initializeAutoUpdater() {
  if (updaterInitialized) return getUpdateStatus();
  updaterInitialized = true;

  if (!canCheckForUpdates()) {
    return publishUpdateStatus({
      supported: false,
      status: 'unavailable',
      message: 'Update checks are available in the installed version of LabSuite.'
    });
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      publishUpdateStatus({
        supported: true,
        status: 'checking',
        progress: null,
        message: 'Checking GitHub for a newer LabSuite release...'
      });
    });
    autoUpdater.on('update-not-available', () => {
      publishUpdateStatus({
        supported: true,
        status: 'up-to-date',
        availableVersion: null,
        progress: null,
        lastCheckedAt: new Date().toISOString(),
        message: `LabSuite v${app.getVersion()} is up to date.`
      });
    });
    autoUpdater.on('update-available', (info) => {
      console.log(`LabSuite: Update ${info.version} is available and will download in the background.`);
      publishUpdateStatus({
        supported: true,
        status: 'available',
        availableVersion: info.version,
        progress: 0,
        lastCheckedAt: new Date().toISOString(),
        message: `LabSuite v${info.version} is available. Starting the download...`
      });
    });
    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
      const versionLabel = updateStatus.availableVersion ? ` v${updateStatus.availableVersion}` : '';
      publishUpdateStatus({
        supported: true,
        status: 'downloading',
        progress: percent,
        message: `Downloading LabSuite${versionLabel} (${Math.round(percent)}%)...`
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log(`LabSuite: Update ${info.version} downloaded; it will install when LabSuite exits.`);
      publishUpdateStatus({
        supported: true,
        status: 'downloaded',
        availableVersion: info.version,
        progress: 100,
        lastCheckedAt: new Date().toISOString(),
        message: `LabSuite v${info.version} is ready. Quit LabSuite from the system tray, then reopen it to finish installing.`
      });
    });
    autoUpdater.on('error', (err) => {
      console.warn('LabSuite: Auto-updater check skipped:', err.message);
      publishUpdateStatus({
        supported: true,
        status: 'error',
        progress: null,
        lastCheckedAt: new Date().toISOString(),
        message: `Update check failed: ${err.message}`
      });
    });

    publishUpdateStatus({
      supported: true,
      status: 'idle',
      message: 'LabSuite checks for updates automatically. You can also check now.'
    });
    console.log('LabSuite: Auto-updater is ready.');
  } catch (err) {
    console.error('LabSuite: Failed to initialize auto-updater:', err.message);
    publishUpdateStatus({
      supported: false,
      status: 'error',
      message: `The updater could not start: ${err.message}`
    });
  }

  return getUpdateStatus();
}

async function checkForLabSuiteUpdates({ notify = false } = {}) {
  initializeAutoUpdater();
  if (!autoUpdater || !updateStatus.supported) return getUpdateStatus();
  if (updateStatus.status === 'downloaded') return getUpdateStatus();
  if (updateCheckPromise) {
    await updateCheckPromise;
    return getUpdateStatus();
  }

  publishUpdateStatus({
    status: 'checking',
    progress: null,
    message: 'Checking GitHub for a newer LabSuite release...'
  });

  updateCheckPromise = (notify
    ? autoUpdater.checkForUpdatesAndNotify()
    : autoUpdater.checkForUpdates()
  ).catch((err) => {
    console.warn('LabSuite: Update check failed:', err.message);
    publishUpdateStatus({
      supported: true,
      status: 'error',
      progress: null,
      lastCheckedAt: new Date().toISOString(),
      message: `Update check failed: ${err.message}`
    });
  }).finally(() => {
    updateCheckPromise = null;
  });

  await updateCheckPromise;
  return getUpdateStatus();
}

// ── Window factory ───────────────────────────────────────────────────────────
function resolveAppIconPath() {
  const candidates = [
    app.isPackaged && process.resourcesPath ? path.join(process.resourcesPath, 'assets', 'icon.ico') : null,
    path.join(__dirname, '../assets/icon.ico'),
    path.join(__dirname, '../assets/icon.png'),
    path.join(process.cwd(), 'assets/icon.ico'),
    path.join(process.cwd(), 'assets/icon.png')
  ].filter(Boolean);

  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function createWindow() {
  mainWindowShown = false;
  const startHidden = process.argv.includes('--hidden');
  const appIconPath = resolveAppIconPath();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: !startHidden,
    icon: appIconPath,
    backgroundColor: '#1b2326',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      nodeIntegration: false,       // ✅ Secure
      contextIsolation: true,        // ✅ Secure
      sandbox: false,                // Needed: preload uses require()
      preload: path.join(__dirname, 'preload.js'),
    }
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    captureRendererConsole(level, message, line, sourceId);
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    try {
      const target = new URL(url);
      if (['http:', 'https:'].includes(target.protocol)) {
        electronShell.openExternal(target.toString()).catch(error => {
          console.warn('LabSuite: Failed to open external navigation:', error.message);
        });
      }
    } catch (_) {}
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (['http:', 'https:'].includes(target.protocol)) {
        electronShell.openExternal(target.toString()).catch(error => {
          console.warn('LabSuite: Failed to open external window target:', error.message);
        });
      }
    } catch (_) {}
    return { action: 'deny' };
  });
  mainWindowShown = !startHidden;

  mainWindow.removeMenu();
  mainWindow.setMenuBarVisibility(false);

  // Load dev server URL or built index.html
  if (isDev) {
    // Vite picks a free port — read it from the env or fall back to 5173
    const port = process.env.VITE_PORT || 5173;
    const win = mainWindow;
    win.loadURL(`http://127.0.0.1:${port}`).catch((primaryError) => {
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.loadURL('http://127.0.0.1:5174').catch((fallbackError) => {
          if (win && !win.isDestroyed()) {
            console.error('LabSuite: Failed to load dev server URLs:', primaryError.message, fallbackError.message);
          }
        });
      }
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html')).catch((error) => {
      console.error('LabSuite: Failed to load packaged UI:', error.message);
      showMainWindow();
    });
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('LabSuite: Renderer failed to load:', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('LabSuite: Renderer process gone:', details && JSON.stringify(details));
    crashMonitor.report('renderProcessGone', new Error('Renderer process gone'), details || {});
  });

  mainWindow.on('ready-to-show', () => {
    if (!startHidden) {
      showMainWindow();
    } else {
      console.log('LabSuite: Started hidden in system tray.');
    }

    // Check for text file arguments on initial launch
    const filePath = process.argv.find(arg => arg.endsWith('.txt') && fs.existsSync(arg));
    if (filePath) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('notepad:open-file', filePath);
        }
      }, 800); // Give React time to mount and listen
    }
  });

  setTimeout(() => {
    if (!startHidden && mainWindow && !mainWindow.isDestroyed() && !mainWindowShown) {
      console.warn('LabSuite: Main window ready-to-show timed out; showing fallback window.');
      showMainWindow();
    }
  }, 3000);

  // Close hides to tray; only actually quits when isQuitting is set
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ── IPC layer needs mainWindow reference ──────────────────────────────────
  setupIpc(mainWindow, () => mainWindow); // pass getter so IPC always has fresh ref
  initTray(mainWindow, () => mainWindow);

  // ── Expose log file path to renderer ─────────────────────────────────────
  const { ipcMain, shell } = require('electron');
  ipcMain.handle('app:getLogPath', () => getLogPath());
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('updates:getStatus', () => getUpdateStatus());
  ipcMain.handle('updates:check', () => checkForLabSuiteUpdates({ notify: false }));
  ipcMain.handle('app:openExternal', async (_event, { url } = {}) => {
    const target = new URL(String(url || '').trim());
    if (!['http:', 'https:'].includes(target.protocol)) {
      throw new Error('Only http and https links can be opened externally.');
    }
    await shell.openExternal(target.toString());
    return true;
  });

  // ── Window Controls ──────────────────────────────────────────────────────────
  ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => { if (mainWindow) mainWindow.close(); });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.on('ready', () => {
  try {
    db.initDatabase();
  } catch (err) {
    console.error('LabSuite: Fatal — database init failed:', err);
    app.quit();
    return;
  }

  if (app.isPackaged) {
    try {
      const desiredAutostart = db.getSetting('start_on_login') === '1';
      const actualAutostart = autostart.reconcileAutostart(desiredAutostart);
      db.setSetting('start_on_login', actualAutostart ? '1' : '0');
    } catch (err) {
      console.warn('LabSuite: Failed to reconcile launch-on-login setting:', err.message);
    }
  }

  createWindow();

  let hasVmProtectGuests = false;
  try {
    const storedGuests = JSON.parse(db.getSetting('vm_protect_guests') || '[]');
    hasVmProtectGuests = Array.isArray(storedGuests) && storedGuests.length > 0;
  } catch (_) {}
  if (db.getSetting('vm_protect_enabled') === '1' || hasVmProtectGuests) {
    setTimeout(() => {
      require('./vmProtect').start().then((status) => {
        db.setSetting('vm_protect_enabled', '1');
        return require('./windowsFirewall').ensureVmProtectFirewallRuleAsync(status.port || status.defaultPort);
      }).then((firewall) => {
        if (firewall && !firewall.ok) console.warn(`LabSuite: ${firewall.message}`);
      }).catch((error) => {
        console.warn('LabSuite: VM Protect receiver could not start:', error.message);
      });
    }, 1200);
  }

  if (db.getSetting('lan_auto_start') === '1') {
    setTimeout(() => {
      require('./lanRuntime').startNetworkDrive().then((status) => {
        console.log(`LabSuite: Network Drive auto-started on port ${status.port}.`);
      }).catch((err) => {
        console.warn('LabSuite: Network Drive auto-start failed:', err.message);
      });
    }, 1000);
  }

  // Initialize auto-updates in production.
  const updaterState = initializeAutoUpdater();
  if (updaterState.supported) {
    try {
      const checkForUpdates = () => checkForLabSuiteUpdates({ notify: true });
      const firstUpdateCheck = setTimeout(checkForUpdates, 30 * 1000);
      const periodicUpdateCheck = setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
      firstUpdateCheck.unref?.();
      periodicUpdateCheck.unref?.();
      console.log('LabSuite: Initialized startup and six-hour auto-update checks.');
    } catch (err) {
      console.error('LabSuite: Failed to initialize auto-updater:', err.message);
    }
  }

  const setupComplete = db.getSetting('setup_complete') === '1';
  const isPaused = db.getSetting('sync_paused') === '1';

  if (setupComplete) {
    if (!isPaused) {
      watcher.initWatcher();
      scheduler.startScheduler();
      updateTrayStatus('idle', '', mainWindow);

      // Trigger immediate sync on startup if any folder has never synced
      const folders = db.getEnabledFolders();
      const hasUnsynced = folders.some(f => !f.last_success_at);
      if (hasUnsynced) {
        console.log('LabSuite: Unsynced folders found on startup. Triggering initial backup...');
        scheduler.runFullSync().catch(err => {
          console.error('LabSuite: Startup backup failed:', err.message);
        });
      }
    } else {
      updateTrayStatus('paused', '', mainWindow);
    }
  } else {
    updateTrayStatus('idle', 'Onboarding required', mainWindow);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', (event) => {
  isQuitting = true;
  if (!quitCleanupStarted) {
    quitCleanupStarted = true;
    watcher.stopWatcher();
    scheduler.stopScheduler();
    try {
      require('./lanRuntime').stopNetworkDrive();
    } catch (err) {
      console.error('LabSuite: Failed to stop Network Drive before quit:', err.message);
    }
    try {
      require('./vmProtect').stop().catch(err => {
        console.error('LabSuite: Failed to stop VM Protect before quit:', err.message);
      });
    } catch (err) {
      console.error('LabSuite: Failed to stop VM Protect before quit:', err.message);
    }
  }

  if (!quitDatabaseFlushComplete) {
    event.preventDefault();
    if (!quitDatabaseFlushPromise) {
      const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), 5000));
      quitDatabaseFlushPromise = Promise.race([
        db.flushWritesAsync().then(() => 'flushed').catch(err => {
          console.error('LabSuite: Failed to flush database before quit:', err.message);
          return 'failed';
        }),
        timeout
      ]).finally(() => {
        quitDatabaseFlushComplete = true;
        app.quit();
      });
    }
  }
});
