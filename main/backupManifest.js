const path = require('path');
const db = require('./database');

function normalizeRelativePath(relativePath) {
  return String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function getRelativePath(folder, filePath) {
  return normalizeRelativePath(path.relative(folder.local_path, filePath));
}

function getRemoteFilePath(folder, relativePath) {
  const rel = normalizeRelativePath(relativePath);
  if (folder && folder.source_type === 'file') {
    return String(folder.remote_path || '').replace(/\\/g, '/');
  }
  return rel ? `${folder.remote_path}/${rel}`.replace(/\\/g, '/') : folder.remote_path;
}

function markDirty(folder, filePath, reason = 'changed') {
  const relativePath = getRelativePath(folder, filePath);
  if (!relativePath) return null;
  return db.markManifestDirty(folder.id, relativePath, reason);
}

function markDeleted(folder, filePath) {
  const relativePath = getRelativePath(folder, filePath);
  if (!relativePath) return null;
  return db.markManifestDeleted(folder.id, relativePath);
}

function recordBackedUp(folder, fileInfo, remoteFilePath) {
  return db.upsertManifestEntry(folder.id, fileInfo.relativePath, {
    status: 'backed_up',
    dirty_reason: '',
    local_path: fileInfo.localPath,
    remote_path: remoteFilePath,
    storage: 'file',
    pack_id: null,
    pack_remote_path: null,
    pack_member_path: null,
    size: fileInfo.size,
    mtime_ms: fileInfo.mtimeMs,
    last_backed_up_at: new Date().toISOString(),
    retry_count: 0,
    last_error: '',
    deleted_at: null,
    staging_path: null,
    repair_history_path: null,
    active_missing_since: null
  });
}

function recordPackedBackedUp(folder, fileInfo, packInfo) {
  return db.upsertManifestEntry(folder.id, fileInfo.relativePath, {
    status: 'backed_up',
    dirty_reason: '',
    local_path: fileInfo.localPath,
    remote_path: packInfo.remotePath,
    storage: 'pack',
    pack_id: packInfo.packId,
    pack_remote_path: packInfo.remotePath,
    pack_member_path: normalizeRelativePath(fileInfo.relativePath),
    size: fileInfo.size,
    mtime_ms: fileInfo.mtimeMs,
    last_backed_up_at: new Date().toISOString(),
    retry_count: 0,
    last_error: '',
    deleted_at: null,
    staging_path: null,
    repair_history_path: null,
    active_missing_since: null
  });
}

function recordHistory(folder, relativePath, historyRemotePath, reason, extra = {}) {
  const existing = db.getManifestEntry(folder.id, relativePath) || {};
  const versions = Array.isArray(existing.versions) ? existing.versions.slice(-49) : [];
  versions.push({
    remote_path: historyRemotePath,
    reason,
    created_at: new Date().toISOString(),
    ...extra
  });

  return db.upsertManifestEntry(folder.id, relativePath, { versions });
}

function recordDeleted(folder, relativePath, historyRemotePath) {
  const patch = {
    status: 'deleted',
    deleted_at: new Date().toISOString(),
    last_error: ''
  };
    if (historyRemotePath) {
    const existing = db.getManifestEntry(folder.id, relativePath) || {};
    const versions = Array.isArray(existing.versions) ? existing.versions.slice(-49) : [];
    versions.push({
      remote_path: historyRemotePath,
      reason: 'deleted',
      created_at: new Date().toISOString(),
      storage: existing.storage || 'file',
      pack_id: existing.pack_id || null,
      pack_remote_path: existing.pack_remote_path || null,
      pack_member_path: existing.pack_member_path || null
    });
    patch.versions = versions;
  }
  return db.upsertManifestEntry(folder.id, relativePath, patch);
}

function recordFailure(folder, relativePath, error) {
  const existing = db.getManifestEntry(folder.id, relativePath) || {};
  return db.upsertManifestEntry(folder.id, relativePath, {
    status: 'failed',
    retry_count: (existing.retry_count || 0) + 1,
    last_error: error && error.message ? error.message : String(error)
  });
}

function recordRemoteMissing(folder, entry, remotePath) {
  const relativePath = normalizeRelativePath(entry.relative_path);
  const existing = db.getManifestEntry(folder.id, relativePath) || entry || {};
  const message = `Active backup copy is missing from Google Drive: ${remotePath || existing.remote_path || relativePath}`;

  return db.upsertManifestEntry(folder.id, relativePath, {
    status: 'dirty',
    dirty_reason: 'remote_missing',
    local_path: existing.local_path || path.join(folder.local_path, relativePath),
    remote_path: existing.remote_path || remotePath || getRemoteFilePath(folder, relativePath),
    storage: existing.storage || 'file',
    pack_id: existing.pack_id || null,
    pack_remote_path: existing.pack_remote_path || null,
    pack_member_path: existing.pack_member_path || null,
    size: Number(existing.size) || 0,
    mtime_ms: Number(existing.mtime_ms) || 0,
    remote_missing_since: existing.remote_missing_since || new Date().toISOString(),
    last_error: message
  });
}

function recordActiveRepairNeeded(folder, fileInfo, { stagingRemotePath, historyRemotePath, error }) {
  const message = error && error.message ? error.message : String(error || 'Active backup copy needs repair');
  const existing = db.getManifestEntry(folder.id, fileInfo.relativePath) || {};
  const versions = Array.isArray(existing.versions) ? existing.versions.slice() : [];
  if (historyRemotePath && !versions.some(version => version.remote_path === historyRemotePath)) {
    versions.push({
      remote_path: historyRemotePath,
      reason: 'modified',
      created_at: new Date().toISOString()
    });
  }
  return db.upsertManifestEntry(folder.id, fileInfo.relativePath, {
    status: 'active_repair_needed',
    dirty_reason: 'repair_active_copy',
    local_path: fileInfo.localPath || '',
    remote_path: getRemoteFilePath(folder, fileInfo.relativePath),
    size: Number(fileInfo.size) || 0,
    mtime_ms: fileInfo.mtimeMs || fileInfo.mtime_ms || 0,
    staging_path: stagingRemotePath,
    repair_history_path: historyRemotePath,
    active_missing_since: new Date().toISOString(),
    retry_count: (existing.retry_count || 0) + 1,
    last_error: message,
    versions
  });
}

function recordActiveRepairFailure(folder, relativePath, error) {
  const existing = db.getManifestEntry(folder.id, relativePath) || {};
  const message = error && error.message ? error.message : String(error || 'Active backup copy repair failed');
  return db.upsertManifestEntry(folder.id, relativePath, {
    status: 'active_repair_needed',
    retry_count: (existing.retry_count || 0) + 1,
    last_error: message
  });
}

module.exports = {
  normalizeRelativePath,
  getRelativePath,
  getRemoteFilePath,
  markDirty,
  markDeleted,
  recordBackedUp,
  recordHistory,
  recordDeleted,
  recordFailure,
  recordRemoteMissing,
  recordPackedBackedUp,
  recordActiveRepairNeeded,
  recordActiveRepairFailure
};
