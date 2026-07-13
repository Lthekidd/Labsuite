const os = require('os');
const path = require('path');
let fs;
try {
  fs = require('original-fs');
} catch (e) {
  fs = require('fs');
}

const db = require('./database');
const rclone = require('./rclone');
const filesystem = require('./filesystem');
const packStore = require('./packStore');

function getActiveEntries(folder) {
  return Object.values(db.getManifestEntries(folder.id))
    .filter(entry => entry.status === 'backed_up')
    .filter(entry => entry.relative_path && entry.remote_path);
}

function getLocalPath(folder, entry) {
  return entry.local_path || path.join(folder.local_path, String(entry.relative_path || '').replace(/\//g, path.sep));
}

async function verifyPackedEntries(folder, entries, onLog) {
  const byPack = new Map();
  for (const entry of entries) {
    const packRemotePath = entry.pack_remote_path || entry.remote_path;
    if (!packRemotePath) throw new Error(`Packed backup has no pack path: ${entry.relative_path}`);
    if (!byPack.has(packRemotePath)) byPack.set(packRemotePath, []);
    byPack.get(packRemotePath).push(entry);
  }

  const tempDir = path.join(os.tmpdir(), 'labsuite-verify-packs');
  fs.mkdirSync(tempDir, { recursive: true });
  let packsChecked = 0;
  let packedFilesChecked = 0;

  for (const [packRemotePath, packEntries] of byPack.entries()) {
    const tempPath = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.vspack`);
    try {
      if (onLog) onLog(`Verifying packed backup object: ${packRemotePath}\n`);
      await rclone.copyFileRemoteToLocal(packRemotePath, tempPath);
      const expectedFiles = packEntries.map(entry => ({
        relativePath: entry.pack_member_path || entry.relative_path,
        localPath: getLocalPath(folder, entry),
        size: Number(entry.size) || 0
      }));
      const result = packStore.verifyPackFile(tempPath, expectedFiles);
      packsChecked += 1;
      packedFilesChecked += result.filesVerified || expectedFiles.length;
    } finally {
      packStore.safeUnlink(tempPath);
    }
  }

  return { packsChecked, packedFilesChecked };
}

async function verifyFolder(folder, onLog) {
  if (!folder || !folder.local_path || !folder.remote_path) {
    throw new Error('Folder is not configured for verification.');
  }

  if (!fs.existsSync(folder.local_path)) {
    throw new Error(`Local backup folder missing: ${folder.local_path}`);
  }

  const entries = getActiveEntries(folder);
  const directEntries = entries.filter(entry => (entry.storage || 'file') !== 'pack');
  const packedEntries = entries.filter(entry => (entry.storage || 'file') === 'pack');

  for (const entry of entries) {
    const localPath = getLocalPath(folder, entry);
    if (!fs.existsSync(localPath)) {
      throw new Error(`Local file missing during backup verification: ${entry.relative_path}`);
    }
  }

  if (directEntries.length > 0) {
    if (onLog) onLog(`Crypt-checking ${directEntries.length} direct backup file(s).\n`);
    const remoteDir = folder.source_type === 'file'
      ? folder.remote_path.substring(0, folder.remote_path.lastIndexOf('/'))
      : folder.remote_path;
    await rclone.cryptCheckFiles(
      folder.local_path,
      remoteDir,
      directEntries.map(entry => entry.relative_path),
      onLog,
      filesystem.buildFolderExcludePatterns(folder)
    );
  }

  const packStats = await verifyPackedEntries(folder, packedEntries, onLog);
  return {
    ok: true,
    directFilesChecked: directEntries.length,
    packedFilesChecked: packStats.packedFilesChecked,
    packsChecked: packStats.packsChecked,
    totalFilesChecked: directEntries.length + packedEntries.length
  };
}

module.exports = {
  verifyFolder
};
