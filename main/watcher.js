const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const backupWorker = require('./backupWorker');
const manifest = require('./backupManifest');
const { createPathExclusionMatcher, isPathIncluded, isPathInsideFolder } = require('./filesystem');

let watcherInstance = null;
const nativeWatchers = new Map();
const nativeEventTimers = new Map();
let watcherFolderConfigs = [];
const watchedPaths = new Set();
let pendingWatcherEventCount = 0;
let watcherEventLogTimer = null;

function logWatcherEventBatch() {
  pendingWatcherEventCount += 1;
  if (watcherEventLogTimer) return;

  watcherEventLogTimer = setTimeout(() => {
    console.log(`Watcher: ${pendingWatcherEventCount} file event(s) queued for backup.`);
    pendingWatcherEventCount = 0;
    watcherEventLogTimer = null;
  }, 5000);
}

/**
 * Keep chokidar's ignore behavior aligned with the rclone exclusion rules.
 */
function buildChokidarIgnored() {
  return (filePath) => {
    try {
      // More than one selected file can share the same parent directory.  Pick
      // the configuration that includes this path, rather than stopping at the
      // first configuration rooted at that directory.
      const config = watcherFolderConfigs.find(({ folder }) => (
        isPathInsideFolder(filePath, folder.local_path) && isPathIncluded(filePath, folder)
      ));
      if (config) return config.isExcluded(filePath);

      // A path inside a selectively protected parent, but outside every
      // selection, must not wake the backup worker.  Ancestor directories are
      // included by isPathIncluded above so chokidar can still reach a selected
      // file nested below them.
      return watcherFolderConfigs.some(({ folder }) => isPathInsideFolder(filePath, folder.local_path));
    } catch (err) {
      console.error('Watcher: Failed to fetch exclusion state', err.message);
      return false;
    }
  };
}

function refreshWatcherFolderConfigs() {
  const useDefault = db.getDb().settings?.use_default_exclusions !== '0';
  watcherFolderConfigs = db.getEnabledFolders().map(folder => ({
    folder,
    isExcluded: createPathExclusionMatcher(folder, useDefault)
  }));
}

function isWindowsDriveRoot(localPath) {
  if (process.platform !== 'win32') return false;
  const resolved = path.resolve(localPath);
  return resolved.toLowerCase() === path.parse(resolved).root.toLowerCase();
}

function findWatcherConfig(filePath) {
  return watcherFolderConfigs.find(({ folder, isExcluded }) => (
    isPathInsideFolder(filePath, folder.local_path) &&
    isPathIncluded(filePath, folder) &&
    !isExcluded(filePath)
  ));
}

function queueNativeEvent(rootPath, eventType, filename) {
  if (!filename) return;
  const fullPath = path.resolve(rootPath, filename.toString());
  const existingTimer = nativeEventTimers.get(fullPath);
  if (existingTimer) clearTimeout(existingTimer);
  nativeEventTimers.set(fullPath, setTimeout(() => {
    nativeEventTimers.delete(fullPath);
    const config = findWatcherConfig(fullPath);
    if (!config) return;

    fs.stat(fullPath, (error, stat) => {
      if (!error) {
        if (stat.isFile()) {
          logWatcherEventBatch();
          backupWorker.markDirtyForPath(fullPath, eventType === 'change' ? 'changed' : 'added');
        }
        return;
      }
      if (eventType !== 'rename' || error.code !== 'ENOENT') return;
      const relativePath = manifest.getRelativePath(config.folder, fullPath);
      if (!relativePath || !db.getManifestEntry(config.folder.id, relativePath)) return;
      logWatcherEventBatch();
      backupWorker.markDirtyForPath(fullPath, 'deleted');
    });
  }, 400));
}

function addNativeDriveWatcher(localPath) {
  if (nativeWatchers.has(localPath)) return true;
  try {
    const nativeWatcher = fs.watch(localPath, { persistent: true, recursive: true }, (eventType, filename) => {
      queueNativeEvent(localPath, eventType, filename);
    });
    nativeWatcher.on('error', error => console.error(`Native watcher error for ${localPath}: ${error.message}`));
    nativeWatchers.set(localPath, nativeWatcher);
    watchedPaths.add(localPath);
    console.log(`Watcher: Using low-overhead native recursive watch for drive root: ${localPath}`);
    return true;
  } catch (error) {
    console.warn(`Watcher: Native recursive watch unavailable for ${localPath}; falling back to chokidar:`, error.message);
    return false;
  }
}

function refreshExclusions() {
  if (watcherInstance) {
    console.log('Watcher: Exclusions updated. Refreshing watcher ignored rules.');
    initWatcher();
  }
}

/**
 * Initialize the folder watcher with all enabled folders from the database.
 * Called on every app launch (index.js → watcher.initWatcher()).
 * This correctly re-reads DB state, so watcher restart on app launch is handled.
 */
function initWatcher() {
  if (watcherInstance || nativeWatchers.size > 0) {
    stopWatcher();
  }

  refreshWatcherFolderConfigs();
  const folders = watcherFolderConfigs.map(config => config.folder);
  const pathsToWatch = [...new Set(folders.map(f => f.local_path))];

  console.log(`Watcher: Initializing. Watching ${pathsToWatch.length} folder(s):`,
    pathsToWatch.join(', ') || '(none)');

  if (pathsToWatch.length === 0) {
    // Nothing to watch yet — that's fine, addPath() will init later
    return;
  }

  const chokidarPaths = pathsToWatch.filter(localPath => !isWindowsDriveRoot(localPath) || !addNativeDriveWatcher(localPath));
  if (chokidarPaths.length === 0) return;

  watcherInstance = chokidar.watch(chokidarPaths, {
    persistent: true,
    ignoreInitial: true,
    ignored: buildChokidarIgnored(),
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500
    }
  });

  chokidarPaths.forEach(p => watchedPaths.add(p));
  _attachEvents();
}

/**
 * Add a new folder path to watch dynamically (called when user toggles a folder on).
 */
function addPath(localPath) {
  refreshWatcherFolderConfigs();
  if (isWindowsDriveRoot(localPath) && addNativeDriveWatcher(localPath)) return;
  if (!watcherInstance) {
    // No watcher yet — create one seeded with this path
    watcherInstance = chokidar.watch(localPath, {
      persistent: true,
      ignoreInitial: true,
      ignored: buildChokidarIgnored(),
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 500
      }
    });
    watchedPaths.add(localPath);
    _attachEvents();
    console.log(`Watcher: Created new watcher for: ${localPath}`);
    return;
  }

  if (!watchedPaths.has(localPath)) {
    console.log(`Watcher: Dynamically adding path: ${localPath}`);
    watcherInstance.add(localPath);
    watchedPaths.add(localPath);
  }
}

/**
 * Remove a folder path from watching (called when user toggles a folder off).
 */
function removePath(localPath) {
  const nativeWatcher = nativeWatchers.get(localPath);
  if (nativeWatcher) {
    nativeWatcher.close();
    nativeWatchers.delete(localPath);
    watchedPaths.delete(localPath);
  }
  watcherFolderConfigs = watcherFolderConfigs.filter(({ folder }) => folder.local_path !== localPath);
  if (!watcherInstance) return;
  if (watchedPaths.has(localPath)) {
    console.log(`Watcher: Dynamically removing path: ${localPath}`);
    watcherInstance.unwatch(localPath);
    watchedPaths.delete(localPath);
  }
}

/**
 * Stop watching all paths and tear down the watcher instance.
 */
function stopWatcher() {
  if (watcherInstance) {
    watcherInstance.close();
    watcherInstance = null;
    watchedPaths.clear();
    if (watcherEventLogTimer) {
      clearTimeout(watcherEventLogTimer);
      watcherEventLogTimer = null;
      pendingWatcherEventCount = 0;
    }
    console.log('Watcher: Stopped.');
  }
  for (const nativeWatcher of nativeWatchers.values()) nativeWatcher.close();
  nativeWatchers.clear();
  for (const timer of nativeEventTimers.values()) clearTimeout(timer);
  nativeEventTimers.clear();
  watchedPaths.clear();
  watcherFolderConfigs = [];
}

/**
 * Attach file-event handlers to the current watcherInstance.
 */
function _attachEvents() {
  watcherInstance.on('add', filePath => {
    logWatcherEventBatch();
    backupWorker.markDirtyForPath(filePath, 'added');
  });

  watcherInstance.on('change', filePath => {
    logWatcherEventBatch();
    backupWorker.markDirtyForPath(filePath, 'changed');
  });

  watcherInstance.on('unlink', filePath => {
    logWatcherEventBatch();
    backupWorker.markDirtyForPath(filePath, 'deleted');
  });

  watcherInstance.on('error', error => {
    console.error(`Watcher error: ${error.message}`);
  });
}

module.exports = {
  initWatcher,
  addPath,
  removePath,
  stopWatcher,
  refreshExclusions
};
