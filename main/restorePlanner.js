const db = require('./database');

function toTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function chooseRemoteForTime(entry, targetMs) {
  const versions = Array.isArray(entry.versions)
    ? [...entry.versions].sort((a, b) => toTime(a.created_at) - toTime(b.created_at))
    : [];

  const nextVersion = versions.find(version => {
    const createdMs = toTime(version.created_at);
    return createdMs !== null && createdMs > targetMs;
  });
  if (nextVersion) {
    return {
      remotePath: nextVersion.remote_path,
      storage: nextVersion.storage || 'file',
      packRemotePath: nextVersion.pack_remote_path || null,
      packMemberPath: nextVersion.pack_member_path || null,
      source: 'history',
      versionCreatedAt: nextVersion.created_at
    };
  }

  const deletedMs = toTime(entry.deleted_at);
  if (deletedMs !== null && deletedMs <= targetMs) return null;

  const backedUpMs = toTime(entry.last_backed_up_at);
  if (entry.remote_path && backedUpMs !== null && backedUpMs <= targetMs) {
    return {
      remotePath: entry.remote_path,
      storage: entry.storage || 'file',
      packRemotePath: entry.pack_remote_path || null,
      packMemberPath: entry.pack_member_path || null,
      source: 'latest',
      versionCreatedAt: entry.last_backed_up_at
    };
  }

  return null;
}

function planPointInTimeRestore(folderId, restoreTime) {
  const targetMs = toTime(restoreTime);
  if (targetMs === null) {
    throw new Error('Invalid restore time');
  }

  let folder = db.getFolders().find(item => item.id === folderId);
  let manifestFolderId = folderId;

  if (!folder) {
    const points = db.getRestorePoints();
    const point = points.find(p => p.folder_id === folderId);
    if (!point) throw new Error('Folder not found');
    
    folder = { id: folderId, local_path: point.folder_path };
    
    // Find if the user re-added the same drive/folder, and use its active manifest
    const activeFolder = db.getFolders().find(f => f.local_path === point.folder_path);
    if (activeFolder) {
      manifestFolderId = activeFolder.id;
    }
  }

  const entries = db.getManifestEntries(manifestFolderId);
  const files = [];

  for (const entry of Object.values(entries)) {
    const selected = chooseRemoteForTime(entry, targetMs);
    if (!selected) continue;
    files.push({
      relativePath: entry.relative_path,
      remotePath: selected.remotePath,
      storage: selected.storage,
      packRemotePath: selected.packRemotePath,
      packMemberPath: selected.packMemberPath,
      source: selected.source,
      versionCreatedAt: selected.versionCreatedAt,
      size: entry.size || 0
    });
  }

  return {
    folderId,
    folderPath: folder.local_path,
    restoreTime,
    files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
  };
}

module.exports = {
  chooseRemoteForTime,
  planPointInTimeRestore
};
