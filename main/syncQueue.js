const EventEmitter = require('events');
const path = require('path');
let fs;
try {
  fs = require('original-fs');
} catch (e) {
  fs = require('fs');
}
const rclone = require('./rclone');
const db = require('./database');
const { BrowserWindow } = require('electron');
const { isPathExcluded, isPathIncluded, isPathInsideFolder } = require('./filesystem');

async function resolveConflictInteractive(folder, filePath, localSize, remoteSize, localTime, remoteTime, remoteFilePath) {
  const windows = BrowserWindow.getAllWindows();
  const mainWindow = windows.find(w => !w.isDestroyed());
  
  if (mainWindow && mainWindow.isVisible()) {
    return new Promise((resolve) => {
      const id = filePath;
      global.pendingConflicts = global.pendingConflicts || new Map();
      global.pendingConflicts.set(id, { resolve });
      
      if (mainWindow.webContents) {
        const { showNotification } = require('./notifier');
        showNotification('Backup Conflict Detected', `Resolution required for "${path.basename(filePath)}"`, 'warning');
        
        mainWindow.webContents.send('sync:conflict', {
          folderId: folder.id,
          filePath,
          localSize,
          remoteSize,
          localTime,
          remoteTime,
          relativeRemotePath: remoteFilePath
        });
      } else {
        resolve('keep_both');
      }
    });
  } else {
    return 'keep_both';
  }
}

function getAvailableConflictPath(filePath) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const dir = path.dirname(filePath);

  let candidate = path.join(dir, `${base} [Conflict]${ext}`);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} [Conflict ${counter}]${ext}`);
    counter++;
  }
  return candidate;
}

class SyncQueue extends EventEmitter {
  constructor() {
    super();
    this.queue = new Map(); // filePath -> action ('upload' | 'delete')
    this.debounceTimer = null;
    this.isProcessing = false;
    this.stats = {
      filesTotal: 0,
      filesDone: 0,
      filesSucceeded: 0,
      filesFailed: 0,
      filesSkipped: 0,
    };
  }

  /**
   * Queue a file upload or deletion
   */
  add(action, filePath) {
    // Only queue if it's within a configured enabled folder
    const folders = db.getEnabledFolders();
    const folder = folders.find(f => isPathInsideFolder(filePath, f.local_path) && isPathIncluded(filePath, f));
    if (!folder) {
      return;
    }

    if (isPathExcluded(filePath, folder)) {
      console.log(`SyncQueue: Skipping excluded path: ${filePath}`);
      return;
    }

    // Set/overwrite action (latest action wins, e.g. upload after edit wins)
    this.queue.set(filePath, action);
    console.log(`SyncQueue: Queued ${action} for ${filePath}`);

    this.emit('queue:change', { size: this.queue.size });

    // Debounce flush: wait 3 seconds after the last file change to execute
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), 3000);
  }

  /**
   * Process all queued changes
   */
  async flush() {
    if (this.isProcessing) {
      // If already processing, check again in 1 second
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.flush(), 1000);
      return;
    }

    if (this.queue.size === 0) return;

    const network = require('./network');
    const netStatus = network.isSyncAllowed();
    if (!netStatus.allowed) {
      // Re-arm timer to check again in 1 minute
      this.debounceTimer = setTimeout(() => this.flush(), 60000);
      this.emit('sync:paused', netStatus.reason);
      return;
    }

    this.isProcessing = true;
    const items = Array.from(this.queue.entries());
    this.queue.clear();

    this.stats.filesTotal = items.length;
    this.stats.filesDone = 0;
    this.stats.filesSucceeded = 0;
    this.stats.filesFailed = 0;
    this.stats.filesSkipped = 0;

    this.emit('sync:start', { filesTotal: this.stats.filesTotal });

    // Cache current active folders list
    const folders = db.getEnabledFolders();

    for (const [filePath, action] of items) {
      const folder = folders.find(f => isPathInsideFolder(filePath, f.local_path) && isPathIncluded(filePath, f));
      if (!folder) {
        // Skip if folder was deleted or disabled during wait
        this.stats.filesSkipped++;
        this.stats.filesDone++;
        continue;
      }

      if (isPathExcluded(filePath, folder)) {
        console.log(`SyncQueue: Skipping excluded queued path: ${filePath}`);
        this.stats.filesSkipped++;
        this.stats.filesDone++;
        continue;
      }

      // Calculate relative destination path
      const relativePath = path.relative(folder.local_path, filePath);
      const remoteFilePath = path.join(folder.remote_path, relativePath).replace(/\\/g, '/');

      let sizeBytes = 0;
      try {
        if (action === 'upload' && fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          sizeBytes = stat.size;
        }
      } catch (e) {}

      this.emit('sync:item-start', { filePath, action });

      try {
        const baseProgress = {
          folderId: folder.id,
          folderPath: folder.local_path,
          remotePath: folder.remote_path,
          phase: 'sync',
          stage: action === 'delete' ? 'deleting' : 'encrypting_uploading',
          stageLabel: action === 'delete' ? 'Deleting remote copy' : 'Encrypting and uploading changed file',
          percent: Math.round((this.stats.filesDone / Math.max(1, this.stats.filesTotal)) * 100),
          filesDone: this.stats.filesDone,
          filesTotal: this.stats.filesTotal,
          bytesDone: 0,
          bytesTotal: sizeBytes,
          speed: 0,
          etaSec: null,
          currentItem: filePath,
          startedAt: new Date().toISOString()
        };
        db.updateFolderSyncProgress(folder.id, baseProgress);
        this.emit('sync:folder-progress', baseProgress);

        if (action === 'upload') {
          let shouldUpload = true;
          try {
            if (fs.existsSync(filePath)) {
              const stat = fs.statSync(filePath);
              const localSize = stat.size;
              const localTime = stat.mtime.toISOString();
              
              const remoteMeta = await rclone.getRemoteFileMetadata(remoteFilePath);
              if (remoteMeta) {
                const remoteTime = remoteMeta.ModTime;
                const remoteSize = remoteMeta.Size;
                
                const lastSync = folder.last_success_at ? new Date(folder.last_success_at) : new Date(0);
                const remoteMod = new Date(remoteTime);
                
                // If remote file is newer than our last successful sync, and differs
                if (remoteMod > lastSync && (remoteSize !== localSize || Math.abs(stat.mtime - remoteMod) > 5000)) {
                  console.log(`SyncQueue: Conflict detected for ${filePath}`);
                  const resolution = await resolveConflictInteractive(folder, filePath, localSize, remoteSize, localTime, remoteTime, remoteFilePath);
                  console.log(`SyncQueue: Conflict resolved as: ${resolution}`);
                  
                  if (resolution === 'keep_remote') {
                    shouldUpload = false;
                    await rclone.copyFileRemoteToLocal(remoteFilePath, filePath);
                  } else if (resolution === 'keep_both') {
                    // Rename local file to conflict name
                    const conflictPath = getAvailableConflictPath(filePath);
                    fs.renameSync(filePath, conflictPath);
                    
                    // Download cloud file to original local path
                    await rclone.copyFileRemoteToLocal(remoteFilePath, filePath);
                    
                    // Upload renamed local conflict file to remote
                    const relativeConflict = path.relative(folder.local_path, conflictPath);
                    const remoteConflictPath = path.join(folder.remote_path, relativeConflict).replace(/\\/g, '/');
                    await rclone.syncFile(conflictPath, remoteConflictPath);
                    
                    shouldUpload = false;
                  }
                  // If 'keep_local', we proceed with upload (shouldUpload = true)
                }
              }
            }
          } catch (err) {
            console.error('SyncQueue: Conflict resolution failed, uploading default', err.message);
          }

          if (shouldUpload) {
            await rclone.syncFile(filePath, remoteFilePath);
          }

          db.addSyncLog({
            folderId: folder.id,
            filePath,
            action: 'upload',
            status: 'success',
            sizeBytes
          });
        } else if (action === 'delete') {
          await rclone.deleteFile(remoteFilePath);
          db.addSyncLog({
            folderId: folder.id,
            filePath,
            action: 'delete',
            status: 'success'
          });
        }

        this.stats.filesSucceeded++;
        this.stats.filesDone++;
        db.updateFolderSyncStatus(folder.id, true);
        const completeProgress = {
          ...baseProgress,
          stage: 'complete',
          stageLabel: 'Change backed up',
          percent: Math.round((this.stats.filesDone / Math.max(1, this.stats.filesTotal)) * 100),
          filesDone: this.stats.filesDone,
          bytesDone: sizeBytes,
          speed: 0,
          etaSec: null,
          currentItem: ''
        };
        db.updateFolderSyncProgress(folder.id, completeProgress);
        this.emit('sync:folder-progress', completeProgress);
        this.emit('sync:item-complete', {
          filePath,
          action,
          filesDone: this.stats.filesDone,
          filesSucceeded: this.stats.filesSucceeded,
          filesFailed: this.stats.filesFailed,
          filesTotal: this.stats.filesTotal
        });

      } catch (error) {
        console.error(`SyncQueue: Failed to back up ${filePath}:`, error.message);
        this.stats.filesFailed++;
        this.stats.filesDone++;
        
        db.addSyncLog({
          folderId: folder.id,
          filePath,
          action,
          status: 'failed',
          sizeBytes,
          errorMsg: error.message
        });

        db.updateFolderSyncStatus(folder.id, false, error.message);
        this.emit('sync:folder-progress', {
          folderId: folder.id,
          folderPath: folder.local_path,
          remotePath: folder.remote_path,
          phase: 'sync',
          stage: 'error',
          stageLabel: 'Change backup failed',
          percent: Math.round((this.stats.filesDone / Math.max(1, this.stats.filesTotal)) * 100),
          filesDone: this.stats.filesDone,
          filesTotal: this.stats.filesTotal,
          bytesDone: 0,
          bytesTotal: sizeBytes,
          speed: 0,
          etaSec: null,
          currentItem: filePath,
          error: error.message
        });

        this.emit('sync:item-error', {
          filePath,
          action,
          error: error.message,
          filesDone: this.stats.filesDone,
          filesSucceeded: this.stats.filesSucceeded,
          filesFailed: this.stats.filesFailed,
          filesTotal: this.stats.filesTotal
        });
      }
    }

    this.isProcessing = false;
    this.emit('sync:complete', {
      filesSynced: this.stats.filesSucceeded,
      filesFailed: this.stats.filesFailed,
      filesSkipped: this.stats.filesSkipped,
      filesProcessed: this.stats.filesDone
    });
    
    // Check if new items were queued during this execution
    if (this.queue.size > 0) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.flush(), 1000);
    }
  }
}

module.exports = new SyncQueue();
