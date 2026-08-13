const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');
const db = require('./database');
const queueProvider = require('./labmediaQueue');
const { YouTubeLibraryProvider } = require('./youtubeLibrary');

const DEFAULT_LABMEDIA_SETTINGS = Object.freeze({
  schemaVersion: 2,
  enabled: true,
  size: 'normal',
  theme: 'spotify',
  opacity: 1.0,
  autoHideWhenIdle: false,
  autoHideGraceSec: 0,
  showToastNotifications: false,
  scrobbleLastFm: false,
  lastFmApiKey: '',
  lastFmSessionKey: '',
  showAlbumArt: true,
  showProgress: true,
  hideWhenFullscreen: true,
  primaryClickAction: 'panel',
  taskbarControlMode: 'adaptive',
  youtubePlaybackApp: 'auto',
  controls: {
    previous: true,
    playPause: true,
    next: true
  }
});

const VALID_SIZES = new Set(['micro', 'compact', 'normal', 'large']);
const VALID_THEMES = new Set(['spotify', 'oled', 'neon', 'glass', 'minimal', 'transparent']);
const VALID_PRIMARY_CLICK_ACTIONS = new Set(['panel', 'openSource']);
const VALID_TASKBAR_CONTROL_MODES = new Set(['adaptive', 'always', 'minimal']);
const VALID_YOUTUBE_PLAYBACK_APPS = new Set(['auto', 'edge', 'chrome']);
const CRASH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CRASHES_PER_WINDOW = 3;
const BACKOFF_DELAYS_MS = [1000, 5000, 30000];

let childProcess = null;
let currentState = 'stopped'; // 'unsupported' | 'stopped' | 'starting' | 'running' | 'no_session' | 'error'
let currentError = null;
let lastSessionInfo = { hasSession: false, title: '', artist: '', sourceApp: '', isPlaying: false };
let currentQueueState = queueProvider.unavailableQueue();
let historyLog = [];
let crashHistory = [];
let restartTimer = null;
let restartPromise = null;
let initialized = false;
let mainWindowGetter = null;
const intentionalStops = new WeakSet();
const youtubeLibraryProvider = new YouTubeLibraryProvider({
  onChange: state => {
    sendRuntimeMessage({ type: 'library:update', library: state });
    notifyStatusChanged();
  }
});

function isWindows11() {
  if (process.platform !== 'win32') return false;
  try {
    const release = os.release(); // e.g. "10.0.22000"
    const parts = release.split('.').map(Number);
    const build = parts[2] || 0;
    return build >= 22000;
  } catch (_) {
    return false;
  }
}

function isSupported() {
  return process.platform === 'win32';
}

function validateSettings(raw = {}) {
  const result = {
    ...DEFAULT_LABMEDIA_SETTINGS,
    controls: { ...DEFAULT_LABMEDIA_SETTINGS.controls }
  };
  if (!raw || typeof raw !== 'object') return result;

  result.schemaVersion = 2;
  result.enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_LABMEDIA_SETTINGS.enabled;

  if (typeof raw.size === 'string' && VALID_SIZES.has(raw.size.toLowerCase())) {
    result.size = raw.size.toLowerCase();
  } else {
    result.size = DEFAULT_LABMEDIA_SETTINGS.size;
  }

  if (typeof raw.theme === 'string' && VALID_THEMES.has(raw.theme.toLowerCase())) {
    result.theme = raw.theme.toLowerCase();
  } else {
    result.theme = DEFAULT_LABMEDIA_SETTINGS.theme;
  }

  if (typeof raw.opacity === 'number' && Number.isFinite(raw.opacity)) {
    result.opacity = Math.max(0.4, Math.min(1.0, raw.opacity));
  } else {
    result.opacity = DEFAULT_LABMEDIA_SETTINGS.opacity;
  }

  result.autoHideWhenIdle = typeof raw.autoHideWhenIdle === 'boolean' ? raw.autoHideWhenIdle : DEFAULT_LABMEDIA_SETTINGS.autoHideWhenIdle;

  if (typeof raw.autoHideGraceSec === 'number' && Number.isFinite(raw.autoHideGraceSec)) {
    result.autoHideGraceSec = Math.max(0, Math.min(60, Math.round(raw.autoHideGraceSec)));
  } else {
    result.autoHideGraceSec = DEFAULT_LABMEDIA_SETTINGS.autoHideGraceSec;
  }

  result.showToastNotifications = typeof raw.showToastNotifications === 'boolean' ? raw.showToastNotifications : DEFAULT_LABMEDIA_SETTINGS.showToastNotifications;
  result.scrobbleLastFm = typeof raw.scrobbleLastFm === 'boolean' ? raw.scrobbleLastFm : DEFAULT_LABMEDIA_SETTINGS.scrobbleLastFm;
  result.lastFmApiKey = typeof raw.lastFmApiKey === 'string' ? raw.lastFmApiKey : DEFAULT_LABMEDIA_SETTINGS.lastFmApiKey;
  result.lastFmSessionKey = typeof raw.lastFmSessionKey === 'string' ? raw.lastFmSessionKey : DEFAULT_LABMEDIA_SETTINGS.lastFmSessionKey;

  result.showAlbumArt = typeof raw.showAlbumArt === 'boolean' ? raw.showAlbumArt : DEFAULT_LABMEDIA_SETTINGS.showAlbumArt;
  result.showProgress = typeof raw.showProgress === 'boolean' ? raw.showProgress : DEFAULT_LABMEDIA_SETTINGS.showProgress;
  result.hideWhenFullscreen = typeof raw.hideWhenFullscreen === 'boolean' ? raw.hideWhenFullscreen : DEFAULT_LABMEDIA_SETTINGS.hideWhenFullscreen;
  result.primaryClickAction = typeof raw.primaryClickAction === 'string'
    && VALID_PRIMARY_CLICK_ACTIONS.has(raw.primaryClickAction)
    ? raw.primaryClickAction
    : DEFAULT_LABMEDIA_SETTINGS.primaryClickAction;
  result.taskbarControlMode = typeof raw.taskbarControlMode === 'string'
    && VALID_TASKBAR_CONTROL_MODES.has(raw.taskbarControlMode)
    ? raw.taskbarControlMode
    : DEFAULT_LABMEDIA_SETTINGS.taskbarControlMode;
  result.youtubePlaybackApp = typeof raw.youtubePlaybackApp === 'string'
    && VALID_YOUTUBE_PLAYBACK_APPS.has(raw.youtubePlaybackApp)
    ? raw.youtubePlaybackApp
    : DEFAULT_LABMEDIA_SETTINGS.youtubePlaybackApp;

  const rawControls = raw.controls && typeof raw.controls === 'object' ? raw.controls : {};
  result.controls = {
    previous: typeof rawControls.previous === 'boolean' ? rawControls.previous : DEFAULT_LABMEDIA_SETTINGS.controls.previous,
    playPause: typeof rawControls.playPause === 'boolean' ? rawControls.playPause : DEFAULT_LABMEDIA_SETTINGS.controls.playPause,
    next: typeof rawControls.next === 'boolean' ? rawControls.next : DEFAULT_LABMEDIA_SETTINGS.controls.next
  };

  return result;
}

function getSettings() {
  const storedStr = db.getSetting('labmedia_settings');
  if (!storedStr) return validateSettings(DEFAULT_LABMEDIA_SETTINGS);
  try {
    const parsed = JSON.parse(storedStr);
    const validated = validateSettings(parsed);
    if (parsed?.schemaVersion !== 2
      || !VALID_PRIMARY_CLICK_ACTIONS.has(parsed?.primaryClickAction)
      || !VALID_TASKBAR_CONTROL_MODES.has(parsed?.taskbarControlMode)) {
      db.setSetting('labmedia_settings', JSON.stringify(validated));
    }
    return validated;
  } catch (_) {
    return validateSettings(DEFAULT_LABMEDIA_SETTINGS);
  }
}

function parseInstalledApps(value = db.getSetting('installed_apps')) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(item => String(item)) : [];
  } catch (_) {
    return [];
  }
}

function isInstalled(value) {
  return parseInstalledApps(value).includes('labmedia');
}

function saveSettings(settings) {
  const validated = validateSettings(settings);
  db.setSetting('labmedia_settings', JSON.stringify(validated));
  writeConfigFile(validated);
  return validated;
}

function getConfigFilePath() {
  let userDataDir;
  try {
    userDataDir = app.getPath('userData');
  } catch (_) {
    userDataDir = path.join(__dirname, '../data');
  }
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }
  return path.join(userDataDir, 'labmedia_config.json');
}

function writeConfigFile(settings) {
  const filePath = getConfigFilePath();
  const validated = validateSettings(settings);
  try {
    fs.writeFileSync(filePath, JSON.stringify(validated, null, 2), 'utf8');
    return filePath;
  } catch (err) {
    console.error('mediaWidget: failed to write config file:', err.message);
    return null;
  }
}

function resolveExecutablePath() {
  const candidates = [
    app.isPackaged && process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'LabMediaWidget.exe') : null,
    path.join(__dirname, '../bin', 'LabMediaWidget.exe')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] || path.join(__dirname, '../bin', 'LabMediaWidget.exe');
}

function getMainWindow() {
  const configuredWindow = typeof mainWindowGetter === 'function' ? mainWindowGetter() : null;
  if (configuredWindow && !configuredWindow.isDestroyed()) return configuredWindow;
  const windows = BrowserWindow.getAllWindows();
  return windows.find(w => !w.isDestroyed());
}

function navigateMainWindow(appId) {
  const win = getMainWindow();
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('app:navigate', appId);
  return true;
}

function notifyStatusChanged() {
  const status = getStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('labmedia:statusChanged', status);
    }
  }
}

function getStatus() {
  const supported = isSupported();
  const settings = getSettings();
  const installed = isInstalled();

  if (!supported) {
    return {
      supported: false,
      installed,
      enabled: settings.enabled,
      state: 'unsupported',
      settings,
      error: 'LabMedia is supported only on Windows 11.',
      session: lastSessionInfo,
      queue: currentQueueState,
      youtubeLibrary: getYouTubeSettingsStatus()
    };
  }

  return {
    supported: true,
    installed,
    enabled: settings.enabled,
    state: currentState,
    settings,
    error: currentError,
    session: lastSessionInfo,
    queue: currentQueueState,
    youtubeLibrary: getYouTubeSettingsStatus()
  };
}

function getYouTubeSettingsStatus() {
  const state = youtubeLibraryProvider.getState();
  return {
    connection: state.connection,
    library: {
      status: state.library.status,
      message: state.library.message,
      playlistCount: state.library.playlists.length
    }
  };
}

function sendRuntimeMessage(message, target = childProcess) {
  if (!target || !target.stdin || target.stdin.destroyed || !target.stdin.writable) return false;
  try {
    target.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

function updateQueueForSession(session = lastSessionInfo, target = childProcess) {
  currentQueueState = queueProvider.getQueueStateForSession(session);
  sendRuntimeMessage({ type: 'queue:update', queue: currentQueueState }, target);
  return currentQueueState;
}

function updateLibraryRuntime(target = childProcess) {
  const library = youtubeLibraryProvider.getState();
  sendRuntimeMessage({ type: 'library:update', library }, target);
  return library;
}

function handleStdoutLine(line) {
  if (!line || !line.trim()) return;
  try {
    const data = JSON.parse(line.trim());
    if (!data || typeof data !== 'object') return;

    if (data.event === 'ready') {
      updateQueueForSession(lastSessionInfo);
      updateLibraryRuntime();
      if (currentState === 'starting') {
        currentState = currentError ? 'error' : 'no_session';
        notifyStatusChanged();
      }
    } else if (data.event === 'session') {
      const previousSession = lastSessionInfo;
      const prevTitle = lastSessionInfo.title;
      const prevArtist = lastSessionInfo.artist;
      const newTitle = String(data.title || '');
      const newArtist = String(data.artist || '');
      const sourceApp = String(data.sourceApp || 'SMTC');

      lastSessionInfo = {
        hasSession: !!data.hasSession,
        sessionId: String(data.sessionId || ''),
        title: newTitle,
        artist: newArtist,
        album: String(data.album || ''),
        sourceApp,
        isPlaying: !!data.isPlaying,
        position: Number(data.position || 0),
        duration: Number(data.duration || 0),
        sessionCount: Number(data.sessionCount || 0),
        canSeek: !!data.canSeek,
        canShuffle: !!data.canShuffle,
        canRepeat: !!data.canRepeat,
        shuffleActive: !!data.shuffleActive,
        repeatMode: String(data.repeatMode || 'none')
      };
      currentState = data.hasSession ? 'running' : 'no_session';
      if (previousSession.hasSession !== lastSessionInfo.hasSession
        || previousSession.sessionId !== lastSessionInfo.sessionId
        || previousSession.sourceApp !== lastSessionInfo.sourceApp
        || previousSession.title !== lastSessionInfo.title
        || previousSession.artist !== lastSessionInfo.artist) {
        updateQueueForSession(lastSessionInfo);
      }

      // Log to rolling history if track changed
      if (data.hasSession && newTitle && (newTitle !== prevTitle || newArtist !== prevArtist)) {
        historyLog.unshift({
          id: Date.now(),
          title: newTitle,
          artist: newArtist || 'Unknown Artist',
          sourceApp,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          date: new Date().toLocaleDateString()
        });
        if (historyLog.length > 50) historyLog.pop();

        // Toast notification if enabled
        const settings = getSettings();
        if (settings.showToastNotifications && data.isPlaying) {
          try {
            const { Notification } = require('electron');
            if (Notification.isSupported()) {
              new Notification({
                title: `🎵 Now Playing: ${newTitle}`,
                body: newArtist ? `${newArtist} (${sourceApp})` : sourceApp,
                silent: true
              }).show();
            }
          } catch (_) {}
        }
      }
      notifyStatusChanged();
    } else if (data.event === 'action') {
      if (data.type === 'openSettings') {
        navigateMainWindow('labmedia');
      } else if (data.type === 'hide') {
        setEnabled(false).catch(error => {
          console.error('mediaWidget: failed to process native hide action:', error.message);
        });
      }
    } else if (data.event === 'providerAction') {
      queueProvider.handleProviderAction(String(data.action || ''), lastSessionInfo)
        .then(queue => {
          currentQueueState = queueProvider.normalizeQueueState(queue);
          sendRuntimeMessage({ type: 'queue:update', queue: currentQueueState });
          notifyStatusChanged();
        })
        .catch(error => {
          currentQueueState = queueProvider.normalizeQueueState({
            status: 'error',
            provider: 'spotify',
            message: error?.message || 'Queue provider action failed.'
          });
          sendRuntimeMessage({ type: 'queue:update', queue: currentQueueState });
        });
    } else if (data.event === 'libraryAction') {
      if (String(data.action || '') === 'openOAuthSettings') {
        navigateMainWindow('settings');
        return;
      }
      const settings = getSettings();
      youtubeLibraryProvider.handleAction(String(data.action || ''), {
        playlistId: String(data.playlistId || ''),
        videoId: String(data.videoId || ''),
        preferredApp: settings.youtubePlaybackApp || 'auto'
      }).then(() => {
        updateLibraryRuntime();
      }).catch(() => {
        updateLibraryRuntime();
        notifyStatusChanged();
      });
    } else if (data.event === 'error') {
      console.error('mediaWidget native helper error:', data.message);
      currentError = String(data.message || 'Unknown native helper error');
      currentState = 'error';
      notifyStatusChanged();
    }
  } catch (_) {
    // Ignore non-JSON stdout lines
  }
}

function startWidget() {
  if (!isSupported()) {
    currentState = 'unsupported';
    currentError = 'LabMedia is supported only on Windows 11.';
    notifyStatusChanged();
    return false;
  }

  const settings = getSettings();
  if (!isInstalled() || !settings.enabled) {
    currentState = 'stopped';
    currentError = null;
    notifyStatusChanged();
    return false;
  }

  const configPath = writeConfigFile(settings);
  if (!configPath) {
    currentState = 'error';
    currentError = 'Failed to write LabMedia configuration file.';
    notifyStatusChanged();
    return false;
  }

  let exePath = resolveExecutablePath();
  let spawnCmd = exePath;
  let args = ['--config', configPath, '--parent-pid', String(process.pid)];

  if (!fs.existsSync(exePath)) {
    const psWorkerPath = path.join(__dirname, 'smtcWorker.ps1');
    if (fs.existsSync(psWorkerPath)) {
      spawnCmd = 'powershell.exe';
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psWorkerPath, '--config', configPath, '--parent-pid', String(process.pid)];
    } else {
      console.warn(`mediaWidget: helper executable not found at ${exePath}`);
      currentState = 'error';
      currentError = `LabMedia helper executable not found at ${exePath}`;
      notifyStatusChanged();
      return false;
    }
  }

  currentState = 'starting';
  currentError = null;
  notifyStatusChanged();

  try {
    const spawnedProcess = spawn(spawnCmd, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    childProcess = spawnedProcess;

    const rl = readline.createInterface({ input: spawnedProcess.stdout });
    rl.on('line', handleStdoutLine);

    spawnedProcess.stderr.on('data', (data) => {
      console.error(`mediaWidget stderr: ${data.toString()}`);
    });

    let terminationHandled = false;
    const handleTermination = ({ code = null, signal = null, error = null } = {}) => {
      if (terminationHandled) return;
      terminationHandled = true;
      rl.close();

      const wasCurrentProcess = childProcess === spawnedProcess;
      if (wasCurrentProcess) childProcess = null;

      if (intentionalStops.has(spawnedProcess)) {
        intentionalStops.delete(spawnedProcess);
        if (!childProcess) {
          currentState = isSupported() ? 'stopped' : 'unsupported';
          currentError = null;
          notifyStatusChanged();
        }
        return;
      }

      // An obsolete process must never clear or restart a newer helper.
      if (!wasCurrentProcess) return;

      if (!isInstalled() || !getSettings().enabled) {
        currentState = 'stopped';
        currentError = null;
        notifyStatusChanged();
        return;
      }

      // Unexpected crash
      const now = Date.now();
      crashHistory.push(now);
      crashHistory = crashHistory.filter(t => now - t <= CRASH_WINDOW_MS);

      if (crashHistory.length > MAX_CRASHES_PER_WINDOW) {
        currentState = 'error';
        currentError = `LabMedia helper failed ${crashHistory.length} times within 5 minutes and has been stopped for this session.`;
        notifyStatusChanged();
        return;
      }

      // Schedule crash restart with backoff delay
      const crashCount = crashHistory.length;
      const delayMs = BACKOFF_DELAYS_MS[crashCount - 1];
      currentState = 'starting';
      const reason = error ? error.message : `code ${code}${signal ? `, signal ${signal}` : ''}`;
      currentError = `Helper process ended unexpectedly (${reason}). Restarting in ${delayMs / 1000}s...`;
      notifyStatusChanged();

      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startWidget();
      }, delayMs);
    };

    // Spawn failures such as antivirus quarantine or EACCES arrive here rather
    // than being thrown by spawn(). Always attach this listener in main process.
    spawnedProcess.once('error', error => handleTermination({ error }));
    spawnedProcess.once('exit', (code, signal) => handleTermination({ code, signal }));

    return true;
  } catch (err) {
    childProcess = null;
    currentState = 'error';
    currentError = `Failed to launch LabMedia helper: ${err.message}`;
    notifyStatusChanged();
    return false;
  }
}

async function stopWidget() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const processToStop = childProcess;
  if (processToStop) {
    intentionalStops.add(processToStop);
    childProcess = null;
    const exited = new Promise(resolve => {
      if (processToStop.exitCode !== null || processToStop.signalCode !== null) {
        resolve();
        return;
      }
      processToStop.once('exit', resolve);
      processToStop.once('error', resolve);
      setTimeout(resolve, 3000).unref?.();
    });
    try {
      processToStop.kill();
    } catch (_) {}
    await exited;
  }

  if (!childProcess) {
    currentState = isSupported() ? 'stopped' : 'unsupported';
    currentError = null;
    lastSessionInfo = { hasSession: false, title: '', artist: '', sourceApp: '', isPlaying: false };
    currentQueueState = queueProvider.unavailableQueue();
    notifyStatusChanged();
  }
}

function restartWidget() {
  if (restartPromise) return restartPromise;
  restartPromise = (async () => {
    crashHistory = [];
    await stopWidget();
    return startWidget();
  })().finally(() => {
    restartPromise = null;
  });
  return restartPromise;
}

async function setEnabled(enabled) {
  if (typeof enabled !== 'boolean') {
    throw new TypeError('LabMedia enabled must be a boolean.');
  }
  const current = getSettings();
  current.enabled = enabled;
  saveSettings(current);

  if (enabled && isInstalled()) {
    await restartWidget();
  } else {
    await stopWidget();
  }
  try { require('./tray').updateTrayMenu?.(); } catch (_) {}
  return getStatus();
}

async function updateSettings(updates = {}) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new TypeError('LabMedia settings updates must be an object.');
  }
  const current = getSettings();
  const next = {
    ...current,
    ...updates,
    controls: {
      ...current.controls,
      ...(updates.controls || {})
    }
  };
  const validated = saveSettings(next);

  if (validated.enabled && isInstalled()) {
    if (!childProcess && currentState !== 'starting' && !restartTimer) {
      startWidget();
    }
  } else {
    await stopWidget();
  }

  notifyStatusChanged();
  return getStatus();
}

function resetSettings() {
  saveSettings(DEFAULT_LABMEDIA_SETTINGS);
  if (DEFAULT_LABMEDIA_SETTINGS.enabled && isInstalled()) {
    return restartWidget().then(() => getStatus());
  } else {
    return stopWidget().then(() => getStatus());
  }
}

async function handleInstalledAppsChanged(installedAppsValue) {
  if (isInstalled(installedAppsValue)) {
    if (getSettings().enabled) startWidget();
  } else {
    saveSettings(DEFAULT_LABMEDIA_SETTINGS);
    await stopWidget();
  }
  try { require('./tray').updateTrayMenu?.(); } catch (_) {}
  notifyStatusChanged();
  return getStatus();
}

function initMediaWidget(getMainWindowArg) {
  if (typeof getMainWindowArg === 'function') mainWindowGetter = getMainWindowArg;
  if (initialized) return;
  initialized = true;
  youtubeLibraryProvider.initialize().catch(() => {});
  if (!isSupported()) {
    currentState = 'unsupported';
    return;
  }

  const settings = getSettings();
  if (isInstalled() && settings.enabled) {
    startWidget();
  }

  app.on('before-quit', () => {
    youtubeLibraryProvider.shutdown();
    stopWidget();
  });
}

async function connectYouTube() {
  await youtubeLibraryProvider.handleAction('connect');
  return getStatus();
}

async function reconnectYouTube() {
  await youtubeLibraryProvider.handleAction('reconnect');
  return getStatus();
}

async function disconnectYouTube() {
  await youtubeLibraryProvider.handleAction('disconnect');
  return getStatus();
}

async function refreshYouTubeLibrary() {
  await youtubeLibraryProvider.handleAction('refresh');
  return getStatus();
}

async function refreshYouTubeSetupState() {
  await youtubeLibraryProvider.initialize();
  updateLibraryRuntime();
  return getStatus();
}

function openYouTubeOAuthSettings() {
  return navigateMainWindow('settings');
}

function sendMediaAction(action = 'playPause', params = {}) {
  if (process.platform !== 'win32') return false;
  const scriptPath = path.join(__dirname, 'controlSmtc.ps1');
  if (fs.existsSync(scriptPath)) {
    try {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-action', action];
      if (params && params.positionSeconds !== undefined) {
        args.push('-positionSeconds', String(params.positionSeconds));
      }
      spawn('powershell.exe', args, { windowsHide: true });
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

function getHistory() {
  return [...historyLog];
}

module.exports = {
  isSupported,
  getSettings,
  validateSettings,
  writeConfigFile,
  getStatus,
  getHistory,
  connectYouTube,
  reconnectYouTube,
  disconnectYouTube,
  refreshYouTubeLibrary,
  refreshYouTubeSetupState,
  openYouTubeOAuthSettings,
  isInstalled,
  handleInstalledAppsChanged,
  setEnabled,
  updateSettings,
  resetSettings,
  sendMediaAction,
  startWidget,
  stopWidget,
  restartWidget,
  initMediaWidget,
  DEFAULT_LABMEDIA_SETTINGS
};
