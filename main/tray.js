const { Tray, Menu, app, nativeImage, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const watcher = require('./watcher');
const scheduler = require('./scheduler');
const backupWorker = require('./backupWorker');
const rclone = require('./rclone');
const remoteSafety = require('./remoteSafety');

function getMainWindow() {
  const windows = BrowserWindow.getAllWindows();
  return windows.find(w => !w.isDestroyed());
}

function sendToWindow(channel, data) {
  const win = getMainWindow();
  if (win && win.webContents && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

let trayInstance = null;
let appStatus = 'idle';
let currentVisualStatus = 'idle';
let statusText = 'Protected';
let detailText = 'Never';
let lastProblem = '';
let lastDriveInfo = null;
let healthTimer = null;
let healthRefreshInFlight = null;

const STATUS_COLORS = {
  idle: [34, 197, 94, 255],
  syncing: [59, 130, 246, 255],
  paused: [234, 179, 8, 255],
  error: [239, 68, 68, 255],
  setup: [148, 163, 184, 255]
};

const STATUS_ICON_FILES = {
  idle: 'tray-idle.png',
  syncing: 'tray-syncing.png',
  paused: 'tray-paused.png',
  error: 'tray-error.png',
  setup: 'tray-setup.png'
};

function resolveAssetPath(fileName) {
  const candidates = [
    app.isPackaged && process.resourcesPath ? path.join(process.resourcesPath, 'assets', fileName) : null,
    path.join(__dirname, '../assets', fileName),
    path.join(process.cwd(), 'assets', fileName)
  ].filter(Boolean);

  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function createTrayNativeImage(status) {
  const color = STATUS_COLORS[status] || STATUS_COLORS.idle;
  const size = 16;
  const data = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = 6.8;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const distance = Math.sqrt((x - center) ** 2 + (y - center) ** 2);
      if (distance <= radius) {
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
        data[i + 3] = color[3];
      } else if (distance <= radius + 1.2) {
        data[i] = 15;
        data[i + 1] = 23;
        data[i + 2] = 42;
        data[i + 3] = 210;
      }
    }
  }

  return nativeImage.createFromBuffer(data, { width: size, height: size });
}

function createTrayImage(status) {
  const iconPath = resolveAssetPath(STATUS_ICON_FILES[status] || STATUS_ICON_FILES.idle);
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    if (typeof image.setTemplateImage === 'function') image.setTemplateImage(false);
    return image;
  }
  return createTrayNativeImage(status);
}

function formatRelativeLastBackup() {
  const lastSync = db.getSetting('last_full_sync');
  if (!lastSync) return 'Never backed up';
  const diffMin = Math.round((Date.now() - new Date(lastSync).getTime()) / 60000);
  if (!Number.isFinite(diffMin) || diffMin < 0) return 'Last backup time unknown';
  if (diffMin <= 0) return 'Backed up just now';
  if (diffMin < 60) return `Backed up ${diffMin} min ago`;
  const hours = Math.round(diffMin / 60);
  return `Backed up ${hours} hr${hours === 1 ? '' : 's'} ago`;
}

function getDriveFreeWarning(info) {
  if (!info || info.email === 'Disconnected') return 'Google Drive disconnected';
  const total = Number(info.total) || 0;
  const free = Number(info.free) || Math.max(0, total - (Number(info.used) || 0));
  if (total <= 0) return '';
  const freePercent = free / total;
  if (freePercent <= 0.05) return 'Google Drive is almost full';
  if (freePercent < 0.20) return 'Google Drive has less than 20% free space';
  return '';
}

function getLocalFolderProblem() {
  const folders = db.getEnabledFolders();
  for (const folder of folders) {
    if (!fs.existsSync(folder.local_path)) {
      return `Local backup folder missing: ${folder.local_path}`;
    }
    if (folder.consecutive_failures > 0) {
      return folder.last_error || `Backup failed for ${folder.local_path}`;
    }
    const entries = Object.values(db.getManifestEntries(folder.id));
    const failedEntry = entries.find(entry => entry.status === 'failed');
    if (failedEntry) {
      return failedEntry.last_error || `Backup failed for ${failedEntry.relative_path || folder.local_path}`;
    }
    if (entries.some(entry => entry.status === 'active_repair_needed')) {
      return `Active backup repair needed: ${folder.local_path}`;
    }
  }
  return '';
}

function computeVisualStatus() {
  if (lastProblem) return 'error';
  if (appStatus === 'syncing') return 'syncing';
  if (appStatus === 'paused') return 'paused';
  if (db.getSetting('setup_complete') !== '1') return 'setup';
  return 'idle';
}

function applyTrayVisual() {
  currentVisualStatus = computeVisualStatus();

  if (lastProblem) {
    statusText = 'Backup needs attention';
    detailText = lastProblem;
  } else if (appStatus === 'syncing') {
    statusText = 'Backing up';
    detailText = detailText || 'Backup in progress';
  } else if (appStatus === 'paused') {
    statusText = 'Backups paused';
    detailText = 'Paused';
  } else if (db.getSetting('setup_complete') !== '1') {
    statusText = 'Setup required';
    detailText = 'Open LabSuite to finish setup';
  } else {
    statusText = 'Protected';
    detailText = formatRelativeLastBackup();
  }

  if (!trayInstance) return;
  try {
    trayInstance.setImage(createTrayImage(currentVisualStatus));
  } catch (error) {
    console.error('Tray: failed to update icon:', error.message);
  }
  trayInstance.setToolTip(`LabSuite - ${statusText}${detailText ? ` - ${detailText}` : ''}`);
  updateTrayMenu();
}

async function refreshTrayHealth({ sampleRemote = false } = {}) {
  if (healthRefreshInFlight) return healthRefreshInFlight;

  healthRefreshInFlight = (async () => {
    try {
      if (db.getSetting('setup_complete') !== '1') {
        lastProblem = '';
        lastDriveInfo = null;
        applyTrayVisual();
        return;
      }

      let info = db.getCache('gdrive_info', 5 * 60 * 1000);
      if (!info) {
        info = await rclone.getGDriveInfo();
        if (info && info.email !== 'Disconnected') db.setCache('gdrive_info', info);
      }
      lastDriveInfo = info;

      const problems = [];
      const driveProblem = getDriveFreeWarning(info);
      if (driveProblem) problems.push(driveProblem);

      const localProblem = getLocalFolderProblem();
      if (localProblem) problems.push(localProblem);

      if (info && info.email !== 'Disconnected') {
        const safety = await remoteSafety.getRemoteSafetyStatus({ sample: sampleRemote });
        if (safety.marker && safety.marker.ok === false && safety.marker.message) {
          problems.push(safety.marker.message);
        }
        if (safety.sampleWarnings && safety.sampleWarnings.length > 0) {
          problems.push(safety.sampleWarnings[0].message);
        }
      }

      lastProblem = problems[0] || '';
      applyTrayVisual();
    } catch (error) {
      lastProblem = error.message || 'Tray health check failed';
      applyTrayVisual();
    } finally {
      healthRefreshInFlight = null;
    }
  })();

  return healthRefreshInFlight;
}

function updateTrayMenu() {
  if (!trayInstance) return;

  const isPaused = db.getSetting('sync_paused') === '1';
  const driveLine = lastDriveInfo && lastDriveInfo.total > 0
    ? `Drive free: ${Math.round(((lastDriveInfo.free || Math.max(0, lastDriveInfo.total - lastDriveInfo.used)) / lastDriveInfo.total) * 100)}%`
    : '';

  const contextMenu = Menu.buildFromTemplate([
    { label: 'LabSuite', enabled: false },
    { type: 'separator' },
    { label: statusText, enabled: false },
    { label: detailText, enabled: false, visible: !!detailText },
    { label: driveLine, enabled: false, visible: !!driveLine },
    { type: 'separator' },
    {
      label: 'Open Dashboard',
      click: () => {
        const win = getMainWindow();
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Back Up Now',
      enabled: !isPaused && appStatus !== 'syncing',
      click: () => {
        scheduler.runFullSync(null, { manual: true, reason: 'tray-manual' }).then(() => {
          refreshTrayHealth({ sampleRemote: true });
        }).catch(error => {
          updateTrayStatus('error', error.message);
        });
      }
    },
    {
      label: isPaused ? 'Resume Backups' : 'Pause Backups',
      click: () => {
        if (isPaused) {
          watcher.initWatcher();
          scheduler.startScheduler();
          db.setSetting('sync_paused', '0');
          backupWorker.resumeScheduledBackup();
          updateTrayStatus('idle', '');
          sendToWindow('status:change', { status: 'idle' });
        } else {
          watcher.stopWatcher();
          scheduler.stopScheduler();
          backupWorker.cancelScheduledBackup();
          db.setSetting('sync_paused', '1');
          updateTrayStatus('paused', '');
          sendToWindow('status:change', { status: 'paused' });
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit()
    }
  ]);

  trayInstance.setContextMenu(contextMenu);
}

function initTray() {
  trayInstance = new Tray(createTrayImage(currentVisualStatus));
  applyTrayVisual();

  trayInstance.on('click', () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => {
    refreshTrayHealth({ sampleRemote: true });
  }, 5 * 60 * 1000);

  // Optimize: Defer heavy initial network check to allow app to start instantly
  setTimeout(() => {
    refreshTrayHealth({ sampleRemote: false });
  }, 5000);
  
  console.log('Tray initialized successfully.');
}

function updateTrayStatus(status, details = '') {
  appStatus = status;
  detailText = details || '';
  if (status === 'error' && details) {
    lastProblem = details;
  }
  if (status === 'idle' || status === 'syncing') {
    refreshTrayHealth({ sampleRemote: status === 'idle' });
  } else {
    applyTrayVisual();
  }
}

module.exports = {
  initTray,
  updateTrayStatus,
  refreshTrayHealth
};
