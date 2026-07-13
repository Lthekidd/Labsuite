const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const db = require('./database');
const rclone = require('./rclone');
const planner = require('./backupPlanner');
const manifest = require('./backupManifest');
const filesystem = require('./filesystem');
const packStore = require('./packStore');
const remoteSafety = require('./remoteSafety');
const backupVerifier = require('./backupVerifier');
const remoteCatalog = require('./remoteCatalog');

const FILE_ACTIVITY_PREVIEW_LIMIT = 200;
const DB_COMPLETION_BATCH_SIZE = 200;

class BackupWorker extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.dirtyFolders = new Set();
    this.timer = null;
    this.firstDirtyAt = null;
    this.watcherDebounceMs = 10000;
    this.watcherMaxWaitMs = 60000;
    this.currentRunStats = null;
  }

  markDirtyForPath(filePath, action = 'changed') {
    const folders = db.getEnabledFolders();
    const folder = folders.find(f => (
      filesystem.isPathInsideFolder(filePath, f.local_path) &&
      filesystem.isPathIncluded(filePath, f)
    ));
    if (!folder || filesystem.isPathExcluded(filePath, folder)) return false;

    if (action === 'deleted') {
      manifest.markDeleted(folder, filePath);
    } else {
      manifest.markDirty(folder, filePath, action);
    }

    this.dirtyFolders.add(folder.id);
    this.emit('backup:dirty', { folderId: folder.id, filePath, action });
    this.scheduleBackup();
    return true;
  }

  scheduleBackup(delayMs = this.watcherDebounceMs) {
    if (this.timer) clearTimeout(this.timer);
    if (!this.firstDirtyAt) this.firstDirtyAt = Date.now();

    const waitedMs = Date.now() - this.firstDirtyAt;
    const cappedDelayMs = Math.max(0, Math.min(delayMs, this.watcherMaxWaitMs - waitedMs));

    this.timer = setTimeout(() => {
      const folderIds = [...this.dirtyFolders];
      this.timer = null;
      this.firstDirtyAt = null;
      this.runBackup(folderIds, { dirtyOnly: true }).catch(error => {
        console.error('BackupWorker: scheduled backup failed:', error.message);
      });
    }, cappedDelayMs);
  }

  cancelScheduledBackup() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.firstDirtyAt = null;
  }

  clearDirtyFolder(folderId) {
    this.dirtyFolders.delete(folderId);
    if (this.dirtyFolders.size === 0) {
      this.cancelScheduledBackup();
    }
  }

  resumeScheduledBackup() {
    if (this.dirtyFolders.size > 0 && !this.timer && !this.isRunning) {
      this.scheduleBackup();
    }
  }

  async runBackup(folderIds = null, options = {}) {
    if (this.isRunning) {
      console.log('BackupWorker: backup already running, request coalesced.');
      if (options.dirtyOnly) this.scheduleBackup();
      return false;
    }

    if (!options.dirtyOnly && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.firstDirtyAt = null;
    }

    const network = require('./network');
    const netStatus = network.isSyncAllowed({ manual: options.manual === true });
    if (!netStatus.allowed) {
      this.emit('backup:paused', netStatus.reason);
      if (options.dirtyOnly) {
        this.scheduleBackup(60000);
      }
      return false;
    }

    this.isRunning = true;
    this.currentRunStats = {
      filesSynced: 0,
      filesFailed: 0,
      bytesSynced: 0,
      globalFilesTotal: 0,
      globalBytesTotal: 0,
      globalFilesDone: 0,
      globalBytesDone: 0,
      startedAt: Date.now()
    };
    this.emit('backup:start', {});

    // Device detection & hostname change alignment
    await this.alignDeviceIdentity();

    const processedFolderIds = new Set();

    try {
      const folders = db.getEnabledFolders();
      remoteSafety.ensureVaultMarker().catch(error => {
        console.warn('BackupWorker: remote vault marker refresh failed:', error.message);
      });
      const selectedIds = Array.isArray(folderIds) && folderIds.length > 0
        ? new Set(folderIds)
        : null;
      const selected = selectedIds
        ? folders.filter(folder => selectedIds.has(folder.id))
        : folders;
      const { effective, covered } = this.getEffectiveFolders(selected);

      // Pre-calculation phase: plan all folders to get global totals
      const folderPlans = new Map();
      const planner = require('./backupPlanner');
      for (const folder of effective) {
        try {
          const folderPlan = !!options.dirtyOnly
            ? await planner.planDirtyFolderAsync(folder)
            : await planner.planFolderAsync(folder);

          const executableItems = folderPlan.workItems.filter(item =>
            ['repair_active', 'upload', 'delete_history'].includes(item.type)
          );

          const folderFiles = executableItems.length;
          const folderBytes = executableItems.reduce((sum, item) => sum + (Number(item.size) || 0), 0);

          this.currentRunStats.globalFilesTotal += folderFiles;
          this.currentRunStats.globalBytesTotal += folderBytes;

          folderPlans.set(folder.id, { plan: folderPlan, filesTotal: folderFiles, bytesTotal: folderBytes });
        } catch (e) {
          console.warn(`BackupWorker: pre-planning failed for folder ${folder.id}:`, e.message);
        }
      }

      this.emitOverallProgress({
        stage: 'queued',
        stageLabel: 'Backup queue ready',
        bytesDone: 0,
        filesDone: 0,
        speed: 0,
        etaSec: null,
        currentItem: ''
      });

      for (const [index, folder] of effective.entries()) {
        processedFolderIds.add(folder.id);
        const folderPrePlan = folderPlans.get(folder.id);
        await this.runFolderBackup(folder, {
          folderNumber: index + 1,
          totalFolders: effective.length,
          coveredChildren: covered.get(folder.id) || [],
          dirtyOnly: !!options.dirtyOnly,
          prePlan: folderPrePlan
        });

        if (folderPrePlan && this.currentRunStats) {
          this.currentRunStats.globalFilesDone += folderPrePlan.filesTotal;
          this.currentRunStats.globalBytesDone += folderPrePlan.bytesTotal;
        }
      }

      db.setSetting('last_full_sync', new Date().toISOString());
      if (!options.dirtyOnly) {
        db.setSetting('last_full_reconcile', new Date().toISOString());
      }
      await this.purgeExpiredHistory();
      await remoteCatalog.publish();
      // A replica mirrors the encrypted vault itself (including version history
      // and restore metadata), never a second upload from the local folders.
      // Replica failures are recorded against that destination but do not turn
      // a successful primary backup into a failure.
      const vaultDestinations = require('./vaultDestinations');
      const replicaOutcomes = await vaultDestinations.replicateAll();
      const failedReplicas = replicaOutcomes.filter(outcome => outcome && outcome.ok === false);
      if (failedReplicas.length > 0) {
        console.warn(`BackupWorker: ${failedReplicas.length} vault replica(s) need attention.`);
      }
      await db.flushWritesAsync();
      this.emit('backup:complete', { ...(this.currentRunStats || {}) });
      return true;
    } catch (error) {
      this.recordRunFailure();
      this.emit('backup:error', {
        ...(this.currentRunStats || {}),
        error: error && error.message ? error.message : String(error)
      });
      throw error;
    } finally {
      db.flushWrites();
      this.currentRunStats = null;
      this.isRunning = false;
      if (options.dirtyOnly) {
        for (const folderId of processedFolderIds) this.dirtyFolders.delete(folderId);
      }
      if (this.dirtyFolders.size > 0) this.scheduleBackup();
    }
  }

  getEffectiveFolders(folders) {
    const enabled = [...folders].sort((a, b) => a.local_path.length - b.local_path.length);
    const effective = [];
    const covered = new Map();

    for (const folder of enabled) {
      const parent = effective.find(existing =>
        existing.id !== folder.id &&
        (!Array.isArray(existing.include_paths) || existing.include_paths.length === 0) &&
        filesystem.isPathInsideFolder(folder.local_path, existing.local_path)
      );

      if (parent) {
        if (!covered.has(parent.id)) covered.set(parent.id, []);
        covered.get(parent.id).push(folder);
      } else {
        effective.push(folder);
      }
    }

    return { effective, covered };
  }

  
  
  async alignDeviceIdentity() {
    const os = require('os');
    const hostname = os.hostname() || 'My-PC';
    const folderIdentity = require('./folderIdentity');
    const parseStringMap = (value) => {
      if (!value) return {};
      let parsed = value;
      if (typeof value === 'string') {
        try {
          parsed = JSON.parse(value);
        } catch (_) {
          return {};
        }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const result = {};
      for (const [key, rawValue] of Object.entries(parsed)) {
        const cleanKey = String(key || '').trim();
        const cleanValue = String(rawValue || '').trim();
        if (cleanKey && cleanValue) result[cleanKey] = cleanValue;
      }
      return result;
    };
    
    // 1. Get our local device fingerprint (persistent hardware ID)
    const fingerprint = folderIdentity.getDeviceFingerprint();
    const existingFingerprints = parseStringMap(db.getSetting('device_fingerprints') || '{}');
    // Once this machine's stable fingerprint already maps to its current name,
    // there is no reason to download and parse the multi-megabyte restore
    // catalog before every backup. A hostname change still follows the full
    // remote reconciliation path below.
    if (existingFingerprints[fingerprint] === hostname) return;
    
    // 2. Get the remote catalog
    let catalog;
    try {
      catalog = await remoteCatalog.readRemote();
    } catch (error) {
      console.log('BackupWorker: remote catalog not found or empty, skipping identity alignment:', error.message);
      return;
    }

    if (!catalog || !catalog.body) return;

    // 3. Check if this fingerprint is registered in the catalog
    catalog.body.device_fingerprints = {
      ...existingFingerprints,
      ...parseStringMap(catalog.body.device_fingerprints)
    };
    db.setSetting('device_fingerprints', JSON.stringify(catalog.body.device_fingerprints));
    
    const registeredName = catalog.body.device_fingerprints[fingerprint];
    
    if (registeredName) {
      if (registeredName !== hostname) {
        console.log(`BackupWorker: Device name change detected! Fingerprint ${fingerprint} was registered as '${registeredName}', now is '${hostname}'. Renaming remote folders...`);
        
        // A. Rename the remote computer folder
        const oldRemoteRoot = `computers/${registeredName}`;
        const newRemoteRoot = `computers/${hostname}`;
        
        try {
          await rclone.moveRemoteFile(oldRemoteRoot, newRemoteRoot);
          console.log(`BackupWorker: successfully renamed remote directory from ${oldRemoteRoot} to ${newRemoteRoot}`);
        } catch (renameError) {
          console.warn(`BackupWorker: failed to rename remote directory:`, renameError.message);
        }

        // B. Update local folder remote paths in the database
        const folders = db.getFolders();
        for (const folder of folders) {
          if (folder.remote_path && folder.remote_path.startsWith(oldRemoteRoot)) {
            const oldPath = folder.remote_path;
            const newPath = folder.remote_path.replace(oldRemoteRoot, newRemoteRoot);
            db.updateFolderRemotePath(folder.id, newPath);
            console.log(`BackupWorker: updated local folder ${folder.id} remote_path from ${oldPath} to ${newPath}`);
          }
        }

        // C. Update the catalog mapping
        catalog.body.device_fingerprints[fingerprint] = hostname;
        db.setSetting('device_fingerprints', JSON.stringify(catalog.body.device_fingerprints));
        
        // Also update remote paths of folders inside the catalog body!
        if (Array.isArray(catalog.body.folders)) {
          for (const folder of catalog.body.folders) {
            if (folder.remote_path && folder.remote_path.startsWith(oldRemoteRoot)) {
              folder.remote_path = folder.remote_path.replace(oldRemoteRoot, newRemoteRoot);
            }
          }
        }
        
        // Save database & publish catalog
        db.flushWrites();
        await remoteCatalog.publish();
      }
    } else {
      // Fingerprint not registered yet, register this computer name
      catalog.body.device_fingerprints[fingerprint] = hostname;
      db.setSetting('device_fingerprints', JSON.stringify(catalog.body.device_fingerprints));
      await remoteCatalog.publish();
    }
  }

  emitOverallProgress(folderProgress) {
    if (!this.currentRunStats) return;

    const stats = this.currentRunStats;
    const now = Date.now();
    const elapsed = (now - stats.startedAt) / 1000;

    const globalBytesDone = (stats.globalBytesDone || 0) + (folderProgress.bytesDone || 0);
    const globalBytesTotal = stats.globalBytesTotal || 0;

    const globalFilesDone = (stats.globalFilesDone || 0) + (folderProgress.filesDone || 0);
    const globalFilesTotal = stats.globalFilesTotal || 0;

    let percent = 0;
    if (globalBytesTotal > 0) {
      percent = Math.round((globalBytesDone / globalBytesTotal) * 100);
    } else if (globalFilesTotal > 0) {
      percent = Math.round((globalFilesDone / globalFilesTotal) * 100);
    }

    const speed = folderProgress.speed || 0;
    const remainingBytes = Math.max(0, globalBytesTotal - globalBytesDone);
    
    const averageSpeed = elapsed > 0 ? globalBytesDone / elapsed : 0;
    const effectiveSpeed = averageSpeed > 0 ? averageSpeed : speed;
    const etaSec = effectiveSpeed > 0 && remainingBytes > 0 ? Math.round(remainingBytes / effectiveSpeed) : null;

    const progressPayload = {
      percent: Math.max(0, Math.min(100, percent)),
      bytesDone: globalBytesDone,
      bytesTotal: globalBytesTotal,
      filesDone: globalFilesDone,
      filesTotal: globalFilesTotal,
      speed,
      etaSec,
      elapsed,
      currentFolder: folderProgress.folderPath,
      currentItem: folderProgress.currentItem || ''
    };

    this.emit('backup:overall-progress', progressPayload);
  }

  emitFolderProgress(folder, progress, coveredChildren = []) {
    db.updateFolderSyncProgress(folder.id, progress);
    this.emit('backup:folder-progress', progress);
    this.emitOverallProgress(progress);

    for (const child of coveredChildren) {
      const childProgress = {
        ...progress,
        folderId: child.id,
        folderPath: child.local_path,
        remotePath: child.remote_path,
        stageLabel: `${progress.stageLabel || 'Backing up'} via ${folder.local_path}`,
        coveredBy: folder.local_path
      };
      db.updateFolderSyncProgress(child.id, childProgress);
      this.emit('backup:folder-progress', childProgress);
    }
  }

  makeFileActivityId(folder, item) {
    return `${folder.id}:${item.type}:${item.relativePath}`;
  }

  makeFileActivity(folder, item, patch = {}) {
    const now = new Date().toISOString();
    const fileName = path.basename(item.relativePath || item.localPath || folder.local_path);
    const id = this.makeFileActivityId(folder, item);

    return {
      id,
      folderId: folder.id,
      folderPath: folder.local_path,
      localPath: item.localPath || '',
      relativePath: item.relativePath || '',
      fileName,
      action: item.type === 'delete_history'
        ? 'preserve-delete'
        : (item.type === 'repair_active' ? 'repair-active-copy' : 'backup-upload'),
      size: Number(item.size) || 0,
      status: 'queued',
      percent: 0,
      bytesDone: 0,
      bytesTotal: Number(item.size) || 0,
      speed: 0,
      etaSec: null,
      retryCount: 0,
      error: '',
      queuedAt: now,
      updatedAt: now,
      ...patch
    };
  }

  emitFileActivity(folder, item, patch = {}) {
    const activity = this.makeFileActivity(folder, item, patch);
    this.emit('backup:file-activity', activity);
    return activity;
  }

  emitItems(folder, items, patch, options = {}) {
    const updatedAt = new Date().toISOString();
    const previewableStatuses = new Set(['queued', 'preparing', 'packing']);
    const shouldPreview = options.preview !== false &&
      items.length > FILE_ACTIVITY_PREVIEW_LIMIT &&
      previewableStatuses.has(patch && patch.status);
    const visibleItems = shouldPreview ? items.slice(0, FILE_ACTIVITY_PREVIEW_LIMIT) : items;

    for (const item of visibleItems) {
      this.emitFileActivity(folder, item, { ...patch, updatedAt });
    }
  }

  normalizeTransferPath(value) {
    return String(value || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .toLowerCase();
  }

  findTransferItem(items, transferName) {
    const normalizedTransfer = this.normalizeTransferPath(transferName);
    if (!normalizedTransfer) return null;
    return items.find(item => {
      const relativePath = this.normalizeTransferPath(item.relativePath);
      const localPath = this.normalizeTransferPath(item.localPath);
      return normalizedTransfer === relativePath ||
        normalizedTransfer.endsWith(`/${relativePath}`) ||
        (localPath && (normalizedTransfer === localPath || localPath.endsWith(`/${normalizedTransfer}`)));
    }) || null;
  }

  emitActiveTransfers(folder, items, progress, status) {
    const transfers = Array.isArray(progress.transferring) ? progress.transferring : [];
    const updatedAt = new Date().toISOString();
    for (const transfer of transfers) {
      const item = this.findTransferItem(items, transfer.name);
      if (!item) continue;
      this.emitFileActivity(folder, item, {
        status,
        percent: Number.isFinite(Number(transfer.percentage)) ? transfer.percentage : 0,
        bytesDone: Number(transfer.bytes) || 0,
        bytesTotal: Number(transfer.totalBytes) || Number(item.size) || 0,
        speed: Number(transfer.speed) || Number(progress.speed) || 0,
        etaSec: progress.etaSec ?? null,
        updatedAt,
        error: ''
      });
    }
  }

  makeRunId() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
  }

  recordRunFailure(count = 1) {
    if (!this.currentRunStats) return;
    this.currentRunStats.filesFailed += Math.max(1, Number(count) || 1);
  }

  async recordCompletedItems(folder, items, counters, recordItem) {
    for (let index = 0; index < items.length; index += DB_COMPLETION_BATCH_SIZE) {
      const chunk = items.slice(index, index + DB_COMPLETION_BATCH_SIZE);
      await db.withWriteBatch(async () => {
        for (const item of chunk) {
          recordItem(item);
          this.completeItem(folder, item, counters);
        }
      });
      await this.yieldToEventLoop();
    }
  }

  makeStagingRoot(folder, runId) {
    return rclone.getVaultPath('staging', `${runId}/${folder.remote_path}`).replace(/\\/g, '/');
  }

  makeHistoryRoot(folder, stamp = this.makeRunId()) {
    return rclone.getVaultPath('history', `${stamp}/${folder.remote_path}`).replace(/\\/g, '/');
  }

  joinRemote(root, relativePath) {
    return `${root}/${manifest.normalizeRelativePath(relativePath)}`.replace(/\\/g, '/');
  }

  emitBatchProgress(folder, base, coveredChildren, counters, totals, progress, fallbackLabel) {
    const batchBytesDone = Number(progress.bytesDone) || 0;
    const batchFilesDone = Number(progress.filesDone) || 0;
    const bytesDone = counters.bytesDone + batchBytesDone;
    const filesDone = counters.filesDone + batchFilesDone;
    const percent = totals.bytesTotal > 0
      ? Math.round((bytesDone / totals.bytesTotal) * 100)
      : Math.round((filesDone / Math.max(1, totals.filesTotal)) * 100);

    this.emitFolderProgress(folder, {
      ...base,
      ...progress,
      stage: progress.stage || base.stage,
      stageLabel: progress.stageLabel || fallbackLabel,
      percent: Math.max(0, Math.min(100, percent)),
      filesDone,
      filesTotal: totals.filesTotal,
      bytesDone,
      bytesTotal: totals.bytesTotal,
      elapsed: (Date.now() - counters.startedMs) / 1000
    }, coveredChildren);
  }

  shouldCheckRemoteIntegrity(folder) {
    const intervalHours = Number(db.getSetting('remote_integrity_check_interval_hours')) || 24;
    if (intervalHours <= 0) return false;

    const lastScan = Date.parse(folder.last_remote_integrity_scan || '');
    if (!Number.isFinite(lastScan)) return true;

    return Date.now() - lastScan >= intervalHours * 60 * 60 * 1000;
  }

  shouldVerifyAfterBackup(dirtyOnly) {
    return !dirtyOnly && db.getSetting('verify_after_backup') !== '0';
  }

  async verifyFolderBeforeProtected(folder, base, coveredChildren, dirtyOnly) {
    if (!this.shouldVerifyAfterBackup(dirtyOnly)) return true;

    this.emitFolderProgress(folder, {
      ...base,
      stage: 'verifying',
      stageLabel: 'Cryptographically verifying backup',
      percent: 99,
      currentItem: ''
    }, coveredChildren);

    try {
      const result = await backupVerifier.verifyFolder(folder, logLine => {
        this.emit('backup:verify-log', { folderId: folder.id, logLine });
      });
      db.updateFolderVerificationStatus(folder.id, true, result);
      db.addSyncLog({
        folderId: folder.id,
        filePath: folder.local_path,
        action: 'backup-verify',
        status: 'success',
        sizeBytes: result.totalFilesChecked
      });
      return true;
    } catch (error) {
      this.recordRunFailure();
      db.updateFolderVerificationStatus(folder.id, false, { error: error.message });
      db.updateFolderSyncStatus(folder.id, false, error.message);
      db.addSyncLog({
        folderId: folder.id,
        filePath: folder.local_path,
        action: 'backup-verify',
        status: 'failed',
        sizeBytes: 0,
        errorMsg: error.message
      });
      this.emitFolderProgress(folder, {
        ...base,
        stage: 'error',
        stageLabel: 'Backup verification failed',
        percent: 99,
        error: error.message
      }, coveredChildren);
      return false;
    }
  }

  async runFolderBackup(folder, { folderNumber, totalFolders, coveredChildren, dirtyOnly = false, prePlan = null }) {
    const startedAt = new Date().toISOString();
    const base = {
      folderId: folder.id,
      folderPath: folder.local_path,
      remotePath: folder.remote_path,
      folderNumber,
      totalFolders,
      phase: folder.last_success_at ? 'backup' : 'initial',
      startedAt,
      speed: 0,
      etaSec: null,
      currentItem: ''
    };

    this.emitFolderProgress(folder, {
      ...base,
      stage: dirtyOnly ? 'preparing' : 'scanning',
      stageLabel: dirtyOnly ? 'Preparing changed files' : 'Scanning files and planning backup',
      percent: 0,
      filesDone: 0,
      filesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0
    }, coveredChildren);

    if (!dirtyOnly && folder.last_success_at && this.shouldCheckRemoteIntegrity(folder)) {
      this.emitFolderProgress(folder, {
        ...base,
        stage: 'scanning',
        stageLabel: 'Checking remote backup integrity',
        percent: 0,
        filesDone: 0,
        filesTotal: 0,
        bytesDone: 0,
        bytesTotal: 0
      }, coveredChildren);

      try {
        const repairScan = await remoteSafety.markMissingActiveCopiesForFolder(folder);
        db.updateFolderRemoteIntegrityScan(folder.id);
        if (repairScan.marked > 0) {
          this.emitFolderProgress(folder, {
            ...base,
            stage: 'scanning',
            stageLabel: `Queued ${repairScan.marked} missing remote backup ${repairScan.marked === 1 ? 'item' : 'items'} for repair`,
            percent: 0,
            filesDone: 0,
            filesTotal: repairScan.marked,
            bytesDone: 0,
            bytesTotal: 0
          }, coveredChildren);
        }
      } catch (error) {
        db.updateFolderRemoteIntegrityScan(folder.id);
        console.warn('BackupWorker: remote integrity repair scan skipped:', error.message);
      }
    }

    let plan;
    try {
      if (prePlan && prePlan.plan) {
      plan = prePlan.plan;
    } else {
      plan = dirtyOnly ? await planner.planDirtyFolderAsync(folder) : await planner.planFolderAsync(folder);
    }
    } catch (error) {
      this.recordRunFailure();
      db.updateFolderSyncStatus(folder.id, false, error.message);
      this.emitFolderProgress(folder, {
        ...base,
        stage: 'error',
        stageLabel: 'Backup planning failed',
        percent: 0,
        error: error.message
      }, coveredChildren);
      return;
    }

    const folderMissing = plan.workItems.find(item => item.type === 'folder_missing');
    if (folderMissing) {
      this.recordRunFailure();
      db.updateFolderSyncStatus(folder.id, false, folderMissing.error);
      this.emitFolderProgress(folder, {
        ...base,
        stage: 'error',
        stageLabel: 'Backup folder missing',
        percent: 0,
        error: folderMissing.error
      }, coveredChildren);
      return;
    }

    const scanErrors = plan.workItems.filter(item => item.type === 'scan_error');
    const repairItems = plan.workItems.filter(item => item.type === 'repair_active');
    const uploadItems = plan.workItems.filter(item => item.type === 'upload');
    const deleteItems = plan.workItems.filter(item => item.type === 'delete_history');
    const executableItems = [...repairItems, ...uploadItems, ...deleteItems];
    const totals = {
      filesTotal: executableItems.length,
      bytesTotal: executableItems.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
    };

    this.emitItems(folder, repairItems, {
      status: 'at_risk',
      percent: 0,
      queuedAt: startedAt,
      error: 'Active backup copy needs repair'
    });
    this.emitItems(folder, [...uploadItems, ...deleteItems], {
      status: 'queued',
      percent: 0,
      queuedAt: startedAt,
      error: ''
    });

    if (plan.sourceUnavailable && executableItems.length === 0 && scanErrors.length === 0) {
      this.emitFolderProgress(folder, {
        ...base,
        stage: 'complete',
        stageLabel: 'Selected file is missing - backup disabled',
        percent: 100,
        filesDone: 0,
        filesTotal: 0,
        bytesDone: 0,
        bytesTotal: 0,
        completedAt: new Date().toISOString()
      }, coveredChildren);
      db.deactivateMissingSource(folder.id);
      return;
    }

    if (executableItems.length === 0 && scanErrors.length === 0) {
      if (!(await this.verifyFolderBeforeProtected(folder, base, coveredChildren, dirtyOnly))) return;
      db.updateFolderSyncStatus(folder.id, true);
      db.addRestorePoint({
        folderId: folder.id,
        folderPath: folder.local_path,
        remotePath: folder.remote_path,
        filesTotal: plan.scannedFiles,
        bytesTotal: plan.scannedBytes,
        startedAt,
        completedAt: new Date().toISOString()
      });
      this.emitFolderProgress(folder, {
        ...base,
        stage: 'complete',
        stageLabel: 'Protected - no changes found',
        percent: 100,
        filesDone: 0,
        filesTotal: 0,
        bytesDone: 0,
        bytesTotal: 0,
        completedAt: new Date().toISOString()
      }, coveredChildren);
      return;
    }

    const counters = { filesDone: 0, bytesDone: 0, startedMs: Date.now() };
    const packSettings = packStore.getPackSettings(db);
    const { packed: packedUploadItems, direct: directUploadItems } = this.partitionUploadItems(uploadItems, packSettings);
    const packedToDirectItems = directUploadItems.filter(item => item.previousStorage === 'pack' && item.previousPackRemotePath);
    const newDirectItems = directUploadItems.filter(item => !item.previousRemotePath);
    const modifiedDirectItems = directUploadItems.filter(item => item.previousRemotePath && !(item.previousStorage === 'pack' && item.previousPackRemotePath));

    await this.repairActiveCopies(folder, repairItems, base, coveredChildren, counters, totals);
    await this.uploadPackedFiles(folder, packedUploadItems, base, coveredChildren, counters, totals, packSettings);
    await this.uploadPackedFileMigrations(folder, packedToDirectItems, base, coveredChildren, counters, totals);
    await this.uploadNewFiles(folder, newDirectItems, base, coveredChildren, counters, totals);
    await this.uploadModifiedFiles(folder, modifiedDirectItems, base, coveredChildren, counters, totals);
    await this.deleteFilesToHistory(folder, deleteItems, base, coveredChildren, counters, totals);

    for (const scanError of scanErrors) {
      db.addSyncLog({
        folderId: folder.id,
        filePath: scanError.localPath,
        action: 'scan',
        status: 'failed',
        sizeBytes: 0,
        errorMsg: scanError.error
      });
    }
    if (scanErrors.length > 0) {
      this.recordRunFailure(scanErrors.length);
    }

    const failures = executableItems
      .map(item => db.getManifestEntry(folder.id, item.relativePath))
      .filter(entry => entry && ['failed', 'active_repair_needed'].includes(entry.status));

    if (failures.length > 0 || scanErrors.length > 0) {
      const atRiskCount = failures.filter(entry => entry.status === 'active_repair_needed').length;
      const failedCount = failures.length - atRiskCount + scanErrors.length;
      const error = atRiskCount > 0
        ? `${atRiskCount} backup item${atRiskCount === 1 ? '' : 's'} need active-copy repair.`
        : `${failedCount} backup item${failedCount === 1 ? '' : 's'} failed and will retry later.`;
      db.updateFolderSyncStatus(folder.id, false, error);
      this.emitFolderProgress(folder, {
        ...base,
        stage: 'error',
        stageLabel: atRiskCount > 0 ? 'Backup at risk - active copy repair needed' : 'Backup partially failed',
        percent: Math.round((counters.filesDone / Math.max(1, totals.filesTotal)) * 100),
        filesDone: counters.filesDone,
        filesTotal: totals.filesTotal,
        bytesDone: counters.bytesDone,
        bytesTotal: totals.bytesTotal,
        error
      }, coveredChildren);
      return;
    }

    if (plan.sourceUnavailable) {
      this.emitFolderProgress(folder, {
        ...base,
        stage: 'complete',
        stageLabel: 'Cloud copy preserved - missing file backup disabled',
        percent: 100,
        filesDone: counters.filesDone,
        filesTotal: totals.filesTotal,
        bytesDone: counters.bytesDone,
        bytesTotal: totals.bytesTotal,
        speed: 0,
        etaSec: null,
        completedAt: new Date().toISOString(),
        currentItem: ''
      }, coveredChildren);
      db.deactivateMissingSource(folder.id);
      return;
    }

    if (!(await this.verifyFolderBeforeProtected(folder, base, coveredChildren, dirtyOnly))) return;

    db.updateFolderSyncStatus(folder.id, true);
    db.addRestorePoint({
      folderId: folder.id,
      folderPath: folder.local_path,
      remotePath: folder.remote_path,
      filesTotal: plan.scannedFiles,
      bytesTotal: plan.scannedBytes,
      startedAt,
      completedAt: new Date().toISOString()
    });
    db.addSyncLog({
      folderId: folder.id,
      filePath: folder.local_path,
      action: 'backup',
      status: 'success',
      sizeBytes: counters.bytesDone
    });

    this.emitFolderProgress(folder, {
      ...base,
      stage: 'complete',
      stageLabel: 'Protected',
      percent: 100,
      filesDone: counters.filesDone,
      filesTotal: totals.filesTotal,
      bytesDone: counters.bytesDone,
      bytesTotal: totals.bytesTotal,
      speed: 0,
      etaSec: null,
      completedAt: new Date().toISOString(),
      currentItem: ''
    }, coveredChildren);
  }

  completeItem(folder, item, counters) {
    counters.filesDone += 1;
    counters.bytesDone += Number(item.size) || 0;
    if (this.currentRunStats) {
      this.currentRunStats.filesSynced += 1;
      this.currentRunStats.bytesSynced += Number(item.size) || 0;
    }
    const completedAt = new Date().toISOString();
    this.emitFileActivity(folder, item, {
      status: 'completed',
      percent: 100,
      bytesDone: Number(item.size) || 0,
      bytesTotal: Number(item.size) || 0,
      completedAt,
      updatedAt: completedAt,
      error: ''
    });
  }

  partitionUploadItems(items, packSettings) {
    const packed = items.filter(item => packStore.shouldPackItem(item, packSettings));
    const direct = items.filter(item => !packStore.shouldPackItem(item, packSettings));

    // A bundle containing one file adds a temporary source and metadata upload
    // without providing any batching benefit. Upload it directly instead.
    if (packed.length === 1) {
      direct.push(packed[0]);
      packed.length = 0;
    }

    return { packed, direct };
  }

  async retryPackedItemsDirect(folder, items, counters, reason, completedPackId = '') {
    console.warn(`BackupWorker: packed upload unavailable; retrying ${items.length} original file(s) directly:`, reason && reason.message ? reason.message : reason);
    for (const item of items) {
      const entry = db.getManifestEntry(folder.id, item.relativePath);
      if (completedPackId && entry && entry.status === 'backed_up' && entry.pack_id === completedPackId) continue;
      await this.uploadSingleItem(folder, item, counters);
    }
  }

  async syncLocalFileWithStagingFallback(localPath, remotePath) {
    try {
      return await rclone.syncFile(localPath, remotePath);
    } catch (originalError) {
      const message = String(originalError && originalError.message ? originalError.message : originalError);
      if (!/source doesn't exist or is a directory/i.test(message)) throw originalError;

      let stat;
      try {
        stat = fs.statSync(localPath);
      } catch (_) {
        throw originalError;
      }
      if (!stat.isFile()) throw originalError;

      const stagingDir = path.join(os.tmpdir(), 'labsuite-source-retry');
      fs.mkdirSync(stagingDir, { recursive: true });
      const extension = path.extname(localPath).slice(0, 16);
      const stagingPath = path.join(stagingDir, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`);

      try {
        fs.copyFileSync(localPath, stagingPath);
        const stagedStat = fs.statSync(stagingPath);
        console.warn('BACKUP_LOCAL_STAGING_RETRY', JSON.stringify({
          originalPath: localPath,
          originalSize: stat.size,
          stagingPath,
          stagedSize: stagedStat.size,
          remotePath,
          originalError: message
        }));
        return await rclone.syncFile(stagingPath, remotePath);
      } catch (stagingError) {
        const combined = new Error(
          `Local source retry failed. Node verified the original file at "${localPath}" (${stat.size} bytes), ` +
          `but rclone also rejected the staged copy. Original: ${message} Staged: ${stagingError.message || stagingError}`
        );
        combined.cause = stagingError;
        throw combined;
      } finally {
        try { fs.unlinkSync(stagingPath); } catch (_) {}
      }
    }
  }

  failItem(folder, item, error, status = 'failed') {
    const failedAt = new Date().toISOString();
    const entry = db.getManifestEntry(folder.id, item.relativePath) || {};
    const localSource = (() => {
      try {
        const stat = fs.statSync(item.localPath);
        return {
          path: item.localPath,
          exists: true,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          realPath: fs.realpathSync(item.localPath)
        };
      } catch (sourceError) {
        return {
          path: item.localPath || '',
          exists: false,
          errorCode: sourceError.code || '',
          error: sourceError.message
        };
      }
    })();
    console.error('BACKUP_FAILURE', JSON.stringify({
      timestamp: failedAt,
      folderId: folder.id,
      folderPath: folder.local_path,
      remoteRoot: folder.remote_path,
      sourceType: folder.source_type || 'folder',
      itemType: item.type,
      relativePath: item.relativePath,
      previousRemotePath: item.previousRemotePath || entry.remote_path || '',
      previousStorage: item.previousStorage || entry.storage || '',
      manifestStatus: entry.status || '',
      retryCount: entry.retry_count || 0,
      localSource,
      error: error && error.message ? error.message : String(error)
    }));
    if (this.currentRunStats) {
      this.currentRunStats.filesFailed += 1;
    }
    this.emitFileActivity(folder, item, {
      status,
      percent: 0,
      error: error && error.message ? error.message : String(error),
      retryCount: entry.retry_count || 1,
      completedAt: failedAt,
      updatedAt: failedAt
    });
    db.addSyncLog({
      folderId: folder.id,
      filePath: item.localPath || item.relativePath,
      action: item.type,
      status: 'failed',
      sizeBytes: item.size,
      errorMsg: error && error.message ? error.message : String(error)
    });
  }

  async handleDisappearedLocalItem(folder, item, counters) {
    try {
      if (fs.statSync(item.localPath).isFile()) return false;
    } catch (error) {
      if (!error || !['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    }
    const entry = db.getManifestEntry(folder.id, item.relativePath) || {};
    const previousRemotePath = item.previousRemotePath || entry.remote_path || null;
    const previousStorage = item.previousStorage || entry.storage || 'file';
    const previousPackRemotePath = item.previousPackRemotePath || entry.pack_remote_path || null;

    if (previousStorage === 'pack' && previousPackRemotePath) {
      manifest.recordDeleted(folder, item.relativePath, previousPackRemotePath);
      counters.filesDone += 1;
    } else if (previousRemotePath) {
      await this.deleteSingleItem(folder, {
        ...item,
        type: 'delete_history',
        previousRemotePath,
        previousStorage
      }, counters);
      const result = db.getManifestEntry(folder.id, item.relativePath);
      if (result && result.status !== 'deleted') return true;
      if (folder.source_type === 'file') db.deactivateMissingSource(folder.id);
      return true;
    } else {
      db.removeManifestEntry(folder.id, item.relativePath);
      counters.filesDone += 1;
    }

    if (folder.source_type === 'file') db.deactivateMissingSource(folder.id);

    const skippedAt = new Date().toISOString();
    this.emitFileActivity(folder, item, {
      status: 'skipped',
      percent: 100,
      completedAt: skippedAt,
      updatedAt: skippedAt,
      error: 'File disappeared before upload; it was skipped safely.'
    });
    return true;
  }

  async repairActiveCopies(folder, items, base, coveredChildren, counters, totals) {
    for (const item of items) {
      this.emitItems(folder, [item], { status: 'versioning', percent: 0, error: 'Repairing active backup copy' });
      this.emitFolderProgress(folder, {
        ...base,
        stage: 'versioning',
        stageLabel: 'Repairing active backup copies',
        percent: Math.round((counters.filesDone / Math.max(1, totals.filesTotal)) * 100),
        filesDone: counters.filesDone,
        filesTotal: totals.filesTotal,
        bytesDone: counters.bytesDone,
        bytesTotal: totals.bytesTotal,
        currentItem: item.relativePath,
        elapsed: (Date.now() - counters.startedMs) / 1000
      }, coveredChildren);

      try {
        await rclone.moveRemoteFile(item.stagingRemotePath, manifest.getRemoteFilePath(folder, item.relativePath));
        if (item.historyRemotePath) {
          manifest.recordHistory(folder, item.relativePath, item.historyRemotePath, 'modified');
        }
        manifest.recordBackedUp(folder, item, manifest.getRemoteFilePath(folder, item.relativePath));
        this.completeItem(folder, item, counters);
      } catch (error) {
        if (await this.reconcilePromotedItem(folder, item, counters)) continue;
        manifest.recordActiveRepairFailure(folder, item.relativePath, error);
        this.failItem(folder, item, error, 'at_risk');
      }
    }
  }

  async uploadPackedFiles(folder, items, base, coveredChildren, counters, totals, packSettings) {
    if (items.length === 0) return;

    const availableItems = [];
    for (const item of items) {
      if (fs.existsSync(item.localPath)) availableItems.push(item);
      else await this.handleDisappearedLocalItem(folder, item, counters);
    }
    items = availableItems;
    if (items.length === 0) return;

    const runId = this.makeRunId();
    const directMigrationHistoryRoot = this.makeHistoryRoot(folder, runId);
    const groups = packStore.groupPackItems(items, packSettings);

    for (const [index, group] of groups.entries()) {
      const packId = packStore.makePackId(folder, runId, index + 1, group);
      const packRemotePath = packStore.makePackRemotePath(folder, packId);
      let packFile = null;

      this.emitItems(folder, group, {
        status: 'packing',
        percent: 0,
        error: 'Packing small files for faster Google Drive upload'
      });
      this.emitFolderProgress(folder, {
        ...base,
        stage: 'packing',
        stageLabel: 'Packing small files',
        percent: Math.round((counters.filesDone / Math.max(1, totals.filesTotal)) * 100),
        filesDone: counters.filesDone,
        filesTotal: totals.filesTotal,
        bytesDone: counters.bytesDone,
        bytesTotal: totals.bytesTotal,
        currentItem: `${group.length} small files`,
        elapsed: (Date.now() - counters.startedMs) / 1000
      }, coveredChildren);

      try {
        packFile = packStore.createPackFile(folder, packId, group);
      } catch (error) {
        const survivingItems = [];
        let missingCount = 0;
        for (const item of group) {
          if (fs.existsSync(item.localPath)) {
            survivingItems.push(item);
          } else {
            missingCount += 1;
            await this.handleDisappearedLocalItem(folder, item, counters);
          }
        }
        if (missingCount > 0) {
          if (survivingItems.length > 0) {
            await this.uploadPackedFiles(folder, survivingItems, base, coveredChildren, counters, totals, packSettings);
          }
          continue;
        }
        await this.retryPackedItemsDirect(folder, survivingItems, counters, error, packId);
        continue;
      }

      try {
        const groupRawBytes = group.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        this.emitItems(folder, group, {
          status: 'uploading',
          percent: 0,
          error: `Uploading one encrypted bundle for ${group.length} small files`
        });
        await rclone.syncFile(packFile.tempPath, packRemotePath, progress => {
          const packBytesTotal = Number(progress.bytesTotal) || Number(packFile.packedBytes) || 0;
          const packBytesDone = Number(progress.bytesDone) || 0;
          const ratio = packBytesTotal > 0
            ? Math.max(0, Math.min(1, packBytesDone / packBytesTotal))
            : Math.max(0, Math.min(1, (Number(progress.percent) || 0) / 100));

          this.emitBatchProgress(folder, base, coveredChildren, counters, totals, {
            ...progress,
            stage: 'encrypting_uploading',
            stageLabel: 'Uploading packed small files',
            bytesDone: Math.round(groupRawBytes * ratio),
            bytesTotal: groupRawBytes,
            currentItem: `${group.length} small files`
          }, 'Uploading packed small files');
        }, {
          idleLabel: 'Starting packed small-file upload',
          activeLabel: 'Uploading packed small files'
        });

        // Sync companion meta file (upload is fast, typically <1KB)
        const packMetaRemotePath = packRemotePath + '.meta';
        await rclone.syncFile(packFile.tempMetaPath, packMetaRemotePath);

        this.emitBatchProgress(folder, base, coveredChildren, counters, totals, {
          stage: 'encrypting_uploading',
          stageLabel: 'Uploaded packed small files',
          filesDone: 0,
          bytesDone: groupRawBytes,
          speed: 0,
          etaSec: null,
          currentItem: packRemotePath
        }, 'Uploaded packed small files');

        const completedItems = [];
        const directHistoryPaths = new Map();

        for (const item of group) {
          if (item.previousStorage === 'pack' && item.previousPackRemotePath) {
            directHistoryPaths.set(item.relativePath, {
              remotePath: item.previousPackRemotePath,
              extra: {
                storage: 'pack',
                pack_id: item.previousPackId || null,
                pack_remote_path: item.previousPackRemotePath,
                pack_member_path: item.previousPackMemberPath || item.relativePath
              }
            });
          }
          if (item.previousStorage === 'file' && item.previousRemotePath) {
            const historyPath = this.joinRemote(directMigrationHistoryRoot, item.relativePath);
            try {
              const moved = await rclone.moveRemoteFile(item.previousRemotePath, historyPath).catch(error => {
                if (!rclone.__private.isNotFoundError(error)) throw error;
                return { skipped: true };
              });
              if (!moved || !moved.skipped) {
                directHistoryPaths.set(item.relativePath, {
                  remotePath: historyPath,
                  extra: { storage: 'file' }
                });
              }
            } catch (error) {
              manifest.recordFailure(folder, item.relativePath, error);
              this.failItem(folder, item, error);
              continue;
            }
          }
          completedItems.push(item);
        }

        await this.recordCompletedItems(folder, completedItems, counters, item => {
          const history = directHistoryPaths.get(item.relativePath);
          if (history) {
            manifest.recordHistory(folder, item.relativePath, history.remotePath, 'modified', history.extra);
          }
          manifest.recordPackedBackedUp(folder, item, { packId, remotePath: packRemotePath });
          db.addSyncLog({
            folderId: folder.id,
            filePath: item.localPath,
            action: 'backup-pack-upload',
            status: 'success',
            sizeBytes: item.size
          });
        });
      } catch (error) {
        await this.retryPackedItemsDirect(folder, group, counters, error, packId);
      } finally {
        if (packFile) {
          packStore.safeUnlink(packFile.tempPath);
          packStore.safeUnlink(packFile.tempMetaPath);
        }
      }
    }
  }

  async uploadNewFiles(folder, items, base, coveredChildren, counters, totals) {
    if (items.length === 0) return;

    try {
      await rclone.copyFilesFrom(folder.local_path, folder.remote_path, items.map(item => item.relativePath), progress => {
        this.emitActiveTransfers(folder, items, progress, 'uploading');
        this.emitBatchProgress(folder, base, coveredChildren, counters, totals, progress, 'Starting Google Drive upload');
      });
      await this.recordCompletedItems(folder, items, counters, item => {
        manifest.recordBackedUp(folder, item, manifest.getRemoteFilePath(folder, item.relativePath));
        db.addSyncLog({
          folderId: folder.id,
          filePath: item.localPath,
          action: 'backup-upload',
          status: 'success',
          sizeBytes: item.size
        });
      });
    } catch (error) {
      console.warn('BackupWorker: batch upload failed; falling back to per-file uploads:', error.message);
      for (const item of items) {
        await this.uploadSingleItem(folder, item, counters);
      }
    }
  }

  recordPackedMigrationHistory(folder, item) {
    if (!item.previousPackRemotePath) return;

    manifest.recordHistory(folder, item.relativePath, item.previousPackRemotePath, 'storage-migrated', {
      storage: 'pack',
      pack_id: item.previousPackId || null,
      pack_remote_path: item.previousPackRemotePath,
      pack_member_path: item.previousPackMemberPath || item.relativePath
    });
  }

  async uploadPackedFileMigrations(folder, items, base, coveredChildren, counters, totals) {
    if (items.length === 0) return;

    this.emitItems(folder, items, {
      status: 'uploading',
      percent: 0,
      error: 'Migrating packed file to Explorer-visible backup'
    });

    try {
      await rclone.copyFilesFrom(folder.local_path, folder.remote_path, items.map(item => item.relativePath), progress => {
        this.emitActiveTransfers(folder, items, progress, 'uploading');
        this.emitBatchProgress(folder, base, coveredChildren, counters, totals, {
          ...progress,
          stage: 'encrypting_uploading',
          stageLabel: 'Migrating packed files for Explorer mount'
        }, 'Migrating packed files for Explorer mount');
      });
      await this.recordCompletedItems(folder, items, counters, item => {
        this.recordPackedMigrationHistory(folder, item);
        manifest.recordBackedUp(folder, item, manifest.getRemoteFilePath(folder, item.relativePath));
        db.addSyncLog({
          folderId: folder.id,
          filePath: item.localPath,
          action: 'backup-pack-migrate',
          status: 'success',
          sizeBytes: item.size
        });
      });
    } catch (error) {
      console.warn('BackupWorker: packed-to-direct batch migration failed; falling back to per-file uploads:', error.message);
      for (const item of items) {
        await this.uploadSinglePackedFileMigration(folder, item, counters);
      }
    }
  }

  async uploadSinglePackedFileMigration(folder, item, counters) {
    this.emitItems(folder, [item], {
      status: 'uploading',
      percent: 0,
      error: 'Migrating packed file to Explorer-visible backup'
    });

    try {
      const activePath = manifest.getRemoteFilePath(folder, item.relativePath);
      await this.syncLocalFileWithStagingFallback(item.localPath, activePath);
      this.recordPackedMigrationHistory(folder, item);
      manifest.recordBackedUp(folder, item, activePath);
      db.addSyncLog({
        folderId: folder.id,
        filePath: item.localPath,
        action: 'backup-pack-migrate',
        status: 'success',
        sizeBytes: item.size
      });
      this.completeItem(folder, item, counters);
    } catch (error) {
      if (await this.handleDisappearedLocalItem(folder, item, counters)) return;
      manifest.recordFailure(folder, item.relativePath, error);
      this.failItem(folder, item, error);
    }
  }

  async uploadModifiedFiles(folder, items, base, coveredChildren, counters, totals) {
    if (items.length === 0) return;

    const runId = this.makeRunId();
    const stagingRoot = this.makeStagingRoot(folder, runId);
    const historyRoot = this.makeHistoryRoot(folder, runId);

    try {
      await rclone.copyFilesFrom(folder.local_path, stagingRoot, items.map(item => item.relativePath), progress => {
        this.emitActiveTransfers(folder, items, progress, 'uploading');
        this.emitBatchProgress(folder, base, coveredChildren, counters, totals, progress, 'Starting Google Drive upload');
      });
    } catch (error) {
      console.warn('BackupWorker: staged batch upload failed; falling back to per-file uploads:', error.message);
      for (const item of items) {
        await this.uploadSingleItem(folder, item, counters);
      }
      return;
    }

    try {
      await rclone.moveFilesFrom(folder.remote_path, historyRoot, items.map(item => item.relativePath), progress => {
        this.emitActiveTransfers(folder, items, progress, 'versioning');
        this.emitBatchProgress(folder, base, coveredChildren, counters, totals, {
          ...progress,
          stage: 'versioning',
          stageLabel: 'Preserving previous versions'
        }, 'Preserving previous versions');
      });
      for (let index = 0; index < items.length; index += DB_COMPLETION_BATCH_SIZE) {
        const chunk = items.slice(index, index + DB_COMPLETION_BATCH_SIZE);
        await db.withWriteBatch(async () => {
          for (const item of chunk) {
            manifest.recordHistory(folder, item.relativePath, this.joinRemote(historyRoot, item.relativePath), 'modified');
          }
        });
        await this.yieldToEventLoop();
      }
    } catch (error) {
      console.warn('BackupWorker: batch version move failed; isolating files one by one:', error.message);
      for (const item of items) {
        await this.promoteStagedItem(folder, item, stagingRoot, historyRoot, counters);
      }
      return;
    }

    try {
      await rclone.moveFilesFrom(stagingRoot, folder.remote_path, items.map(item => item.relativePath), progress => {
        this.emitActiveTransfers(folder, items, progress, 'versioning');
        this.emitBatchProgress(folder, base, coveredChildren, counters, totals, {
          ...progress,
          stage: 'versioning',
          stageLabel: 'Promoting staged backup copies'
        }, 'Promoting staged backup copies');
      });
      await this.recordCompletedItems(folder, items, counters, item => {
        manifest.recordBackedUp(folder, item, manifest.getRemoteFilePath(folder, item.relativePath));
        db.addSyncLog({
          folderId: folder.id,
          filePath: item.localPath,
          action: 'backup-upload',
          status: 'success',
          sizeBytes: item.size
        });
      });
    } catch (error) {
      console.warn('BackupWorker: staged promotion failed; marking files at risk:', error.message);
      for (const item of items) {
        if (await this.reconcilePromotedItem(folder, item, counters)) continue;
        manifest.recordActiveRepairNeeded(folder, item, {
          stagingRemotePath: this.joinRemote(stagingRoot, item.relativePath),
          historyRemotePath: this.joinRemote(historyRoot, item.relativePath),
          error
        });
        this.failItem(folder, item, error, 'at_risk');
      }
    }
  }

  async reconcilePromotedItem(folder, item, counters) {
    const activePath = manifest.getRemoteFilePath(folder, item.relativePath);
    const metadata = await rclone.getRemoteFileMetadata(activePath);
    if (!metadata) return false;

    manifest.recordBackedUp(folder, item, activePath);
    db.addSyncLog({
      folderId: folder.id,
      filePath: item.localPath || item.relativePath,
      action: 'backup-upload',
      status: 'success',
      sizeBytes: item.size
    });
    this.completeItem(folder, item, counters);
    return true;
  }

  async promoteStagedItem(folder, item, stagingRoot, historyRoot, counters) {
    const historyPath = this.joinRemote(historyRoot, item.relativePath);
    const stagingPath = this.joinRemote(stagingRoot, item.relativePath);
    const activePath = manifest.getRemoteFilePath(folder, item.relativePath);

    try {
      const previousMove = await rclone.moveRemoteFile(activePath, historyPath).catch(error => {
        if (!rclone.__private.isNotFoundError(error)) throw error;
        console.warn(`BackupWorker: previous active copy was already absent; promoting staged file directly: ${activePath}`);
        return { skipped: true };
      });
      if (!previousMove || !previousMove.skipped) {
        manifest.recordHistory(folder, item.relativePath, historyPath, 'modified');
      }
      await rclone.moveRemoteFile(stagingPath, activePath);
      manifest.recordBackedUp(folder, item, activePath);
      db.addSyncLog({
        folderId: folder.id,
        filePath: item.localPath,
        action: 'backup-upload',
        status: 'success',
        sizeBytes: item.size
      });
      this.completeItem(folder, item, counters);
    } catch (error) {
      if (String(error.message || error).toLowerCase().includes('staging')) {
        manifest.recordFailure(folder, item.relativePath, error);
        this.failItem(folder, item, error);
        return;
      }
      manifest.recordActiveRepairNeeded(folder, item, {
        stagingRemotePath: stagingPath,
        historyRemotePath: historyPath,
        error
      });
      this.failItem(folder, item, error, 'at_risk');
    }
  }

  async uploadSingleItem(folder, item, counters) {
    this.emitItems(folder, [item], { status: 'uploading', percent: 0, error: '' });

    if (!item.previousRemotePath) {
      try {
        await this.syncLocalFileWithStagingFallback(item.localPath, manifest.getRemoteFilePath(folder, item.relativePath));
        manifest.recordBackedUp(folder, item, manifest.getRemoteFilePath(folder, item.relativePath));
        db.addSyncLog({
          folderId: folder.id,
          filePath: item.localPath,
          action: 'backup-upload',
          status: 'success',
          sizeBytes: item.size
        });
        this.completeItem(folder, item, counters);
      } catch (error) {
        if (await this.handleDisappearedLocalItem(folder, item, counters)) return;
        manifest.recordFailure(folder, item.relativePath, error);
        this.failItem(folder, item, error);
      }
      return;
    }

    const runId = this.makeRunId();
    const stagingRoot = this.makeStagingRoot(folder, runId);
    const historyRoot = this.makeHistoryRoot(folder, runId);
    const stagingPath = this.joinRemote(stagingRoot, item.relativePath);

    try {
      await this.syncLocalFileWithStagingFallback(item.localPath, stagingPath);
    } catch (error) {
      if (await this.handleDisappearedLocalItem(folder, item, counters)) return;
      manifest.recordFailure(folder, item.relativePath, error);
      this.failItem(folder, item, error);
      return;
    }

    await this.promoteStagedItem(folder, item, stagingRoot, historyRoot, counters);
  }

  async deleteFilesToHistory(folder, items, base, coveredChildren, counters, totals) {
    if (items.length === 0) return;

    const packedItems = items.filter(item => item.previousStorage === 'pack' && item.previousPackRemotePath);
    for (const item of packedItems.slice(0, FILE_ACTIVITY_PREVIEW_LIMIT)) {
      this.emitItems(folder, [item], {
        status: 'versioning',
        percent: 0,
        error: 'Preserving packed file in backup history'
      });
    }
    await this.recordCompletedItems(folder, packedItems, counters, item => {
      manifest.recordDeleted(folder, item.relativePath, item.previousPackRemotePath);
      db.addSyncLog({
        folderId: folder.id,
        filePath: item.relativePath,
        action: 'backup-delete-history',
        status: 'success',
        sizeBytes: item.size
      });
    });

    items = items.filter(item => !(item.previousStorage === 'pack' && item.previousPackRemotePath));
    if (items.length === 0) return;

    const historyRoot = this.makeHistoryRoot(folder, this.makeRunId());

    try {
      await rclone.moveFilesFrom(folder.remote_path, historyRoot, items.map(item => item.relativePath), progress => {
        this.emitActiveTransfers(folder, items, progress, 'versioning');
        this.emitBatchProgress(folder, base, coveredChildren, counters, totals, {
          ...progress,
          stage: 'deleting',
          stageLabel: 'Moving deleted files to backup history'
        }, 'Moving deleted files to backup history');
      });
      await this.recordCompletedItems(folder, items, counters, item => {
        manifest.recordDeleted(folder, item.relativePath, this.joinRemote(historyRoot, item.relativePath));
        db.addSyncLog({
          folderId: folder.id,
          filePath: item.relativePath,
          action: 'backup-delete-history',
          status: 'success',
          sizeBytes: item.size
        });
      });
    } catch (error) {
      console.warn('BackupWorker: batch delete-history move failed; falling back to per-file moves:', error.message);
      for (const item of items) {
        await this.deleteSingleItem(folder, item, counters);
      }
    }
  }

  async deleteSingleItem(folder, item, counters) {
    const existingRemote = item.previousRemotePath || manifest.getRemoteFilePath(folder, item.relativePath);
    const historyPath = this.joinRemote(this.makeHistoryRoot(folder, this.makeRunId()), item.relativePath);
    try {
      const moved = await rclone.moveRemoteFile(existingRemote, historyPath);
      manifest.recordDeleted(folder, item.relativePath, moved && moved.skipped ? null : historyPath);
      db.addSyncLog({
        folderId: folder.id,
        filePath: item.relativePath,
        action: 'backup-delete-history',
        status: 'success',
        sizeBytes: item.size
      });
      this.completeItem(folder, item, counters);
    } catch (error) {
      manifest.recordFailure(folder, item.relativePath, error);
      this.failItem(folder, item, error);
    }
  }

  getReferencedPackPaths() {
    const referenced = new Set();
    for (const folder of db.getFolders()) {
      const entries = db.getManifestEntries(folder.id);
      for (const entry of Object.values(entries)) {
        if (entry.storage === 'pack' && entry.pack_remote_path) {
          referenced.add(entry.pack_remote_path);
        }
        for (const version of Array.isArray(entry.versions) ? entry.versions : []) {
          const packPath = version.pack_remote_path || (version.storage === 'pack' ? version.remote_path : null);
          if (packPath) referenced.add(packPath);
        }
      }
    }
    return referenced;
  }

  async pruneUnreferencedPacks(candidatePaths) {
    if (!candidatePaths || candidatePaths.size === 0) return;
    const referenced = this.getReferencedPackPaths();
    for (const packPath of candidatePaths) {
      if (!packPath || referenced.has(packPath)) continue;
      try {
        await rclone.moveRemoteFile(packPath, rclone.getVaultPath('expired', packPath));
      } catch (error) {
        if (!rclone.__private.isNotFoundError(error)) {
          console.warn('BackupWorker: pack expiry skipped:', error.message);
        }
      }
    }
  }

  shouldPrunePackRoots() {
    const intervalHours = Number(db.getSetting('pack_root_prune_interval_hours')) || 24;
    if (intervalHours <= 0) return false;

    const lastPrune = Date.parse(db.getSetting('last_pack_root_prune') || '');
    if (!Number.isFinite(lastPrune)) return true;

    return Date.now() - lastPrune >= intervalHours * 60 * 60 * 1000;
  }

  async pruneUnreferencedPackRoots() {
    if (!this.shouldPrunePackRoots()) return;

    db.setSetting('last_pack_root_prune', new Date().toISOString());
    const candidates = new Set();
    for (const folder of db.getFolders()) {
      const packRoot = rclone.getVaultPath('packs', folder.remote_path).replace(/\\/g, '/');
      const items = await rclone.listRemoteDir(packRoot);
      for (const item of items) {
        if (item.IsDir) continue;
        const itemPath = String(item.Path || item.Name || '').replace(/\\/g, '/');
        if (!itemPath.toLowerCase().endsWith('.vspack')) continue;
        candidates.add(`${packRoot}/${itemPath}`.replace(/\\/g, '/'));
      }
    }
    await this.pruneUnreferencedPacks(candidates);
  }

  async purgeExpiredHistory() {
    const versionDays = Number(db.getSetting('backup_version_retention_days')) || 30;
    const deletedDays = Number(db.getSetting('backup_deleted_retention_days')) || 90;
    const minVersions = Number(db.getSetting('backup_min_versions_per_file')) || 20;
    const now = Date.now();
    const versionCutoff = now - (versionDays * 24 * 60 * 60 * 1000);
    const deletedCutoff = now - (deletedDays * 24 * 60 * 60 * 1000);
    const packExpiryCandidates = new Set();

    for (const folder of db.getFolders()) {
      const entries = db.getManifestEntries(folder.id);
      for (const [relativePath, entry] of Object.entries(entries)) {
        const versions = Array.isArray(entry.versions) ? entry.versions.slice() : [];
        if (versions.length === 0) continue;

        const sorted = versions
          .map((version, index) => ({ ...version, index }))
          .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        const keep = new Set();

        sorted.forEach((version, index) => {
          const created = new Date(version.created_at || 0).getTime();
          const cutoff = entry.status === 'deleted' ? deletedCutoff : versionCutoff;
          const isRecent = Number.isNaN(created) || created >= cutoff;
          const isMinimum = index < minVersions;
          const isOnlyDeletedCopy = entry.status === 'deleted' && versions.length <= 1;
          if (isRecent || isMinimum || isOnlyDeletedCopy) keep.add(version.index);
        });

        const retained = [];
        for (const [index, version] of versions.entries()) {
          if (keep.has(index)) {
            retained.push(version);
            continue;
          }
          const packPath = version.pack_remote_path || (version.storage === 'pack' ? version.remote_path : null);
          if (packPath) {
            packExpiryCandidates.add(packPath);
            continue;
          }
          try {
            await rclone.moveRemoteFile(version.remote_path, rclone.getVaultPath('expired', version.remote_path));
          } catch (error) {
            console.warn('BackupWorker: history expiry skipped:', error.message);
            retained.push(version);
          }
        }

        if (retained.length !== versions.length) {
          db.upsertManifestEntry(folder.id, relativePath, { versions: retained });
        }
      }
    }

    await this.pruneUnreferencedPacks(packExpiryCandidates);
    await this.pruneUnreferencedPackRoots();
  }
}

module.exports = new BackupWorker();
