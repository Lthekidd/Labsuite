let fs;
try {
  fs = require('original-fs');
} catch (e) {
  fs = require('fs');
}
const path = require('path');
const db = require('./database');
const filesystem = require('./filesystem');
const manifest = require('./backupManifest');

function makeEmptyPlan(folder) {
  return {
    folder,
    scannedFiles: 0,
    scannedBytes: 0,
    workItems: [],
    skipped: 0,
    startedAt: new Date().toISOString()
  };
}

function toFileInfo(folder, localPath, stat) {
  const relativePath = manifest.getRelativePath(folder, localPath);
  return {
    localPath,
    relativePath,
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs)
  };
}

function hasChanged(entry, fileInfo) {
  if (!entry) return true;
  if (entry.status === 'active_repair_needed') return false;
  if (entry.status !== 'backed_up') return true;
  if (shouldMigratePackedActiveEntry(entry)) return true;
  return Number(entry.size) !== Number(fileInfo.size) ||
    Math.abs(Number(entry.mtime_ms || 0) - Number(fileInfo.mtimeMs || 0)) > 1000;
}

function shouldMigratePackedActiveEntry(entry) {
  return !!(
    entry &&
    entry.status === 'backed_up' &&
    entry.storage === 'pack' &&
    db.getSetting('pack_small_files_enabled') === '0'
  );
}

function addUploadIfNeeded(plan, fileInfo, entry) {
  if (!fileInfo.relativePath) return;
  plan.scannedFiles += 1;
  plan.scannedBytes += fileInfo.size;

  if (!hasChanged(entry, fileInfo)) return;

  plan.workItems.push({
    type: 'upload',
    folderId: plan.folder.id,
    localPath: fileInfo.localPath,
    relativePath: fileInfo.relativePath,
    size: fileInfo.size,
    mtimeMs: fileInfo.mtimeMs,
    previousRemotePath: entry && entry.status === 'backed_up' ? entry.remote_path : null,
    previousStorage: entry && entry.status === 'backed_up' ? (entry.storage || 'file') : null,
    previousPackId: entry && entry.status === 'backed_up' ? entry.pack_id || null : null,
    previousPackRemotePath: entry && entry.status === 'backed_up' ? entry.pack_remote_path || null : null,
    previousPackMemberPath: entry && entry.status === 'backed_up' ? entry.pack_member_path || null : null
  });
}

function hasPreviousRemoteCopy(entry) {
  return !!(entry && entry.remote_path && entry.dirty_reason !== 'remote_missing');
}

function makeMissingFileDeleteItem(folder, relativePath, entry) {
  if (!hasPreviousRemoteCopy(entry)) return null;
  return {
    type: 'delete_history',
    folderId: folder.id,
    relativePath,
    size: Number(entry.size) || 0,
    previousRemotePath: entry.remote_path || manifest.getRemoteFilePath(folder, relativePath),
    previousStorage: entry.storage || 'file',
    previousPackId: entry.pack_id || null,
    previousPackRemotePath: entry.pack_remote_path || null,
    previousPackMemberPath: entry.pack_member_path || null
  };
}

function handleMissingFileDuringScan(folder, plan, entries, relativePath, error) {
  if (!error || error.code !== 'ENOENT') return false;
  const normalized = manifest.normalizeRelativePath(relativePath);
  const entry = entries[normalized];
  const deleteItem = makeMissingFileDeleteItem(folder, normalized, entry);
  if (deleteItem) {
    plan.workItems.push(deleteItem);
  } else if (entry) {
    db.removeManifestEntry(folder.id, normalized);
  }
  plan.skipped += 1;
  return true;
}

function addManifestRepairs(folder, plan, entries) {
  for (const [relativePath, entry] of Object.entries(entries)) {
    if (entry.status !== 'active_repair_needed') continue;
    plan.workItems.push({
      type: 'repair_active',
      folderId: folder.id,
      localPath: entry.local_path || path.join(folder.local_path, relativePath),
      relativePath,
      size: Number(entry.size) || 0,
      mtimeMs: Number(entry.mtime_ms) || 0,
      stagingRemotePath: entry.staging_path,
      historyRemotePath: entry.repair_history_path,
      previousRemotePath: entry.remote_path || manifest.getRemoteFilePath(folder, relativePath)
    });
  }
}

function addDirtyManifestUploads(folder, plan, entries) {
  for (const [relativePath, entry] of Object.entries(entries)) {
    if (!['dirty', 'failed'].includes(entry.status)) continue;

    const localPath = entry.local_path || path.join(folder.local_path, relativePath);
    if (filesystem.isPathExcluded(localPath, folder)) {
      db.removeManifestEntry(folder.id, relativePath);
      plan.skipped += 1;
      continue;
    }
    try {
      const stat = fs.statSync(localPath);
      if (!stat.isFile()) {
        plan.skipped += 1;
        continue;
      }
      plan.scannedFiles += 1;
      plan.scannedBytes += stat.size;
      plan.workItems.push({
        type: 'upload',
        folderId: folder.id,
        localPath,
        relativePath,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        previousRemotePath: hasPreviousRemoteCopy(entry) ? entry.remote_path : null,
        previousStorage: hasPreviousRemoteCopy(entry) ? (entry.storage || 'file') : null,
        previousPackId: hasPreviousRemoteCopy(entry) ? entry.pack_id || null : null,
        previousPackRemotePath: hasPreviousRemoteCopy(entry) ? entry.pack_remote_path || null : null,
        previousPackMemberPath: hasPreviousRemoteCopy(entry) ? entry.pack_member_path || null : null
      });
    } catch (error) {
      if (handleMissingFileDuringScan(folder, plan, entries, relativePath, error)) continue;
      plan.workItems.push({
        type: 'scan_error',
        folderId: folder.id,
        localPath,
        relativePath,
        error: error.message
      });
    }
  }
}

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

async function maybeYield(counter, every = 500) {
  if (counter > 0 && counter % every === 0) {
    await yieldToEventLoop();
  }
}

function walkFolder(folder, plan, entries) {
  const includes = Array.isArray(folder.include_paths) ? folder.include_paths : [];
  if (includes.length > 0) {
    for (const relativePath of includes) {
      const normalized = manifest.normalizeRelativePath(relativePath);
      if (!normalized || normalized.split('/').includes('..')) continue;
      const filePath = path.join(folder.local_path, ...normalized.split('/'));
      if (filesystem.isPathExcluded(filePath, folder)) continue;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const fileInfo = toFileInfo(folder, filePath, stat);
        addUploadIfNeeded(plan, fileInfo, entries[fileInfo.relativePath]);
      } catch (error) {
        if (handleMissingFileDuringScan(folder, plan, entries, normalized, error)) continue;
        plan.workItems.push({
          type: 'scan_error',
          folderId: folder.id,
          localPath: filePath,
          relativePath: normalized,
          error: error.message
        });
      }
    }
    return;
  }
  const stack = [folder.local_path];

  while (stack.length > 0) {
    const current = stack.pop();
    let children;
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        plan.skipped += 1;
        continue;
      }
      plan.workItems.push({
        type: 'scan_error',
        folderId: folder.id,
        localPath: current,
        relativePath: manifest.getRelativePath(folder, current),
        error: error.message
      });
      continue;
    }

    for (const child of children) {
      const childPath = path.join(current, child.name);
      if (filesystem.isPathExcluded(childPath, folder)) {
        plan.skipped += 1;
        continue;
      }

      if (child.isDirectory()) {
        stack.push(childPath);
        continue;
      }

      if (!child.isFile()) {
        plan.skipped += 1;
        continue;
      }

      try {
        const stat = fs.statSync(childPath);
        const fileInfo = toFileInfo(folder, childPath, stat);
        addUploadIfNeeded(plan, fileInfo, entries[fileInfo.relativePath]);
      } catch (error) {
        const relativePath = manifest.getRelativePath(folder, childPath);
        if (handleMissingFileDuringScan(folder, plan, entries, relativePath, error)) continue;
        plan.workItems.push({
          type: 'scan_error',
          folderId: folder.id,
          localPath: childPath,
          relativePath,
          error: error.message
        });
      }
    }
  }
}

async function walkFolderAsync(folder, plan, entries) {
  const includes = Array.isArray(folder.include_paths) ? folder.include_paths : [];
  if (includes.length > 0) {
    walkFolder(folder, plan, entries);
    await yieldToEventLoop();
    return;
  }
  const stack = [folder.local_path];
  let visited = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    visited += 1;
    await maybeYield(visited);

    let children;
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        plan.skipped += 1;
        continue;
      }
      plan.workItems.push({
        type: 'scan_error',
        folderId: folder.id,
        localPath: current,
        relativePath: manifest.getRelativePath(folder, current),
        error: error.message
      });
      continue;
    }

    for (const child of children) {
      visited += 1;
      if (visited % 500 === 0) await yieldToEventLoop();

      const childPath = path.join(current, child.name);
      if (filesystem.isPathExcluded(childPath, folder)) {
        plan.skipped += 1;
        continue;
      }

      if (child.isDirectory()) {
        stack.push(childPath);
        continue;
      }

      if (!child.isFile()) {
        plan.skipped += 1;
        continue;
      }

      try {
        const stat = fs.statSync(childPath);
        const fileInfo = toFileInfo(folder, childPath, stat);
        addUploadIfNeeded(plan, fileInfo, entries[fileInfo.relativePath]);
      } catch (error) {
        const relativePath = manifest.getRelativePath(folder, childPath);
        if (handleMissingFileDuringScan(folder, plan, entries, relativePath, error)) continue;
        plan.workItems.push({
          type: 'scan_error',
          folderId: folder.id,
          localPath: childPath,
          relativePath,
          error: error.message
        });
      }
    }
  }
}

async function addManifestRepairsAsync(folder, plan, entries) {
  let visited = 0;
  for (const [relativePath, entry] of Object.entries(entries)) {
    visited += 1;
    await maybeYield(visited);
    if (entry.status !== 'active_repair_needed') continue;
    plan.workItems.push({
      type: 'repair_active',
      folderId: folder.id,
      localPath: entry.local_path || path.join(folder.local_path, relativePath),
      relativePath,
      size: Number(entry.size) || 0,
      mtimeMs: Number(entry.mtime_ms) || 0,
      stagingRemotePath: entry.staging_path,
      historyRemotePath: entry.repair_history_path,
      previousRemotePath: entry.remote_path || manifest.getRemoteFilePath(folder, relativePath)
    });
  }
}

async function addDirtyManifestUploadsAsync(folder, plan, entries) {
  let visited = 0;
  for (const [relativePath, entry] of Object.entries(entries)) {
    visited += 1;
    await maybeYield(visited);
    if (!['dirty', 'failed'].includes(entry.status)) continue;

    const localPath = entry.local_path || path.join(folder.local_path, relativePath);
    if (filesystem.isPathExcluded(localPath, folder)) {
      db.removeManifestEntry(folder.id, relativePath);
      plan.skipped += 1;
      continue;
    }
    try {
      const stat = fs.statSync(localPath);
      if (!stat.isFile()) {
        plan.skipped += 1;
        continue;
      }
      plan.scannedFiles += 1;
      plan.scannedBytes += stat.size;
      plan.workItems.push({
        type: 'upload',
        folderId: folder.id,
        localPath,
        relativePath,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        previousRemotePath: hasPreviousRemoteCopy(entry) ? entry.remote_path : null,
        previousStorage: hasPreviousRemoteCopy(entry) ? (entry.storage || 'file') : null,
        previousPackId: hasPreviousRemoteCopy(entry) ? entry.pack_id || null : null,
        previousPackRemotePath: hasPreviousRemoteCopy(entry) ? entry.pack_remote_path || null : null,
        previousPackMemberPath: hasPreviousRemoteCopy(entry) ? entry.pack_member_path || null : null
      });
    } catch (error) {
      if (handleMissingFileDuringScan(folder, plan, entries, relativePath, error)) continue;
      plan.workItems.push({
        type: 'scan_error',
        folderId: folder.id,
        localPath,
        relativePath,
        error: error.message
      });
    }
  }
}

async function addManifestDeletesAsync(folder, plan, entries) {
  let visited = 0;
  for (const [relativePath, entry] of Object.entries(entries)) {
    visited += 1;
    await maybeYield(visited);
    if (entry.status !== 'deleted_pending_history') continue;
    plan.workItems.push({
      type: 'delete_history',
      folderId: folder.id,
      relativePath,
      size: Number(entry.size) || 0,
      previousRemotePath: entry.remote_path || manifest.getRemoteFilePath(folder, relativePath),
      previousStorage: entry.storage || 'file',
      previousPackId: entry.pack_id || null,
      previousPackRemotePath: entry.pack_remote_path || null,
      previousPackMemberPath: entry.pack_member_path || null
    });
  }
}

function addManifestDeletes(folder, plan, entries) {
  for (const [relativePath, entry] of Object.entries(entries)) {
    if (entry.status !== 'deleted_pending_history') continue;
    plan.workItems.push({
      type: 'delete_history',
      folderId: folder.id,
      relativePath,
      size: Number(entry.size) || 0,
      previousRemotePath: entry.remote_path || manifest.getRemoteFilePath(folder, relativePath),
      previousStorage: entry.storage || 'file',
      previousPackId: entry.pack_id || null,
      previousPackRemotePath: entry.pack_remote_path || null,
      previousPackMemberPath: entry.pack_member_path || null
    });
  }
}

function planFolder(folder) {
  const plan = makeEmptyPlan(folder);
  const entries = db.getManifestEntries(folder.id);

  if (!fs.existsSync(folder.local_path)) {
    plan.workItems.push({
      type: 'folder_missing',
      folderId: folder.id,
      localPath: folder.local_path,
      relativePath: '',
      error: 'Backup folder is missing locally'
    });
    return plan;
  }

  addManifestRepairs(folder, plan, entries);
  walkFolder(folder, plan, entries);
  addManifestDeletes(folder, plan, entries);

  const uploadItems = plan.workItems.filter(item => item.type === 'upload');
  plan.bytesToUpload = uploadItems.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  plan.filesToUpload = uploadItems.length;
  plan.deleteItems = plan.workItems.filter(item => item.type === 'delete_history').length;
  plan.repairItems = plan.workItems.filter(item => item.type === 'repair_active').length;
  return plan;
}

async function planFolderAsync(folder) {
  const plan = makeEmptyPlan(folder);
  const entries = db.getManifestEntries(folder.id);

  if (!fs.existsSync(folder.local_path)) {
    plan.workItems.push({
      type: 'folder_missing',
      folderId: folder.id,
      localPath: folder.local_path,
      relativePath: '',
      error: 'Backup folder is missing locally'
    });
    return plan;
  }

  await addManifestRepairsAsync(folder, plan, entries);
  await walkFolderAsync(folder, plan, entries);
  await addManifestDeletesAsync(folder, plan, entries);

  const uploadItems = plan.workItems.filter(item => item.type === 'upload');
  plan.bytesToUpload = uploadItems.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  plan.filesToUpload = uploadItems.length;
  plan.deleteItems = plan.workItems.filter(item => item.type === 'delete_history').length;
  plan.repairItems = plan.workItems.filter(item => item.type === 'repair_active').length;
  return plan;
}

function planDirtyFolder(folder) {
  const plan = makeEmptyPlan(folder);
  const entries = db.getManifestEntries(folder.id);

  if (!fs.existsSync(folder.local_path)) {
    plan.workItems.push({
      type: 'folder_missing',
      folderId: folder.id,
      localPath: folder.local_path,
      relativePath: '',
      error: 'Backup folder is missing locally'
    });
    return plan;
  }

  addManifestRepairs(folder, plan, entries);
  addDirtyManifestUploads(folder, plan, entries);
  addManifestDeletes(folder, plan, entries);

  const uploadItems = plan.workItems.filter(item => item.type === 'upload');
  plan.bytesToUpload = uploadItems.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  plan.filesToUpload = uploadItems.length;
  plan.deleteItems = plan.workItems.filter(item => item.type === 'delete_history').length;
  plan.repairItems = plan.workItems.filter(item => item.type === 'repair_active').length;
  return plan;
}

async function planDirtyFolderAsync(folder) {
  const plan = makeEmptyPlan(folder);
  const entries = db.getManifestEntries(folder.id);

  if (!fs.existsSync(folder.local_path)) {
    plan.workItems.push({
      type: 'folder_missing',
      folderId: folder.id,
      localPath: folder.local_path,
      relativePath: '',
      error: 'Backup folder is missing locally'
    });
    return plan;
  }

  await addManifestRepairsAsync(folder, plan, entries);
  await addDirtyManifestUploadsAsync(folder, plan, entries);
  await addManifestDeletesAsync(folder, plan, entries);

  const uploadItems = plan.workItems.filter(item => item.type === 'upload');
  plan.bytesToUpload = uploadItems.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  plan.filesToUpload = uploadItems.length;
  plan.deleteItems = plan.workItems.filter(item => item.type === 'delete_history').length;
  plan.repairItems = plan.workItems.filter(item => item.type === 'repair_active').length;
  return plan;
}

module.exports = {
  hasChanged,
  shouldMigratePackedActiveEntry,
  planFolder,
  planFolderAsync,
  planDirtyFolder,
  planDirtyFolderAsync,
  __private: {
    makeMissingFileDeleteItem,
    handleMissingFileDuringScan
  }
};
