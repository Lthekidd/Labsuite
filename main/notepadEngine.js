const fs = require('fs');
const path = require('path');
const db = require('./database');
const fastDriveSync = require('./fastDriveSync');
const fastCrypt = require('./fastCrypt');
const crypto = require('crypto');

function resolveExistingPath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    const realPath = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    // Windows can return an extended-length path (\\?\C:\...) here, while
    // path.join/readdir return a normal drive path. Keep both sides of the
    // backup-root comparison in the same form.
    return realPath
      .replace(/^\\\\\?\\UNC\\/i, '\\\\')
      .replace(/^\\\\\?\\/, '');
  } catch (_) {
    return resolved;
  }
}

function getNotebookFolders() {
  return db.getEnabledFolders()
    .map(folder => {
      const localPath = folder.local_path || folder.path;
      if (!localPath || typeof localPath !== 'string') return null;
      return {
        ...folder,
        local_path: resolveExistingPath(localPath)
      };
    })
    .filter(Boolean);
}

function isAllowedByFolder(filePath, folder) {
  const filesystem = require('./filesystem');
  return filesystem.isPathInsideFolder(filePath, folder.local_path)
    && filesystem.isPathIncluded(filePath, folder)
    && !filesystem.isPathExcluded(filePath, folder);
}

/**
 * Scan all LabSuite managed folders for .txt files.
 */
function listLocal() {
  const folders = getNotebookFolders();
  const txtFiles = [];
  const seenPaths = new Set();

  const walkSync = (dir, folder, rootName) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          // Do not follow links or junctions outside the configured backup root.
          if (entry.isSymbolicLink() || !isAllowedByFolder(fullPath, folder)) continue;

          if (entry.isDirectory()) {
            walkSync(fullPath, folder, rootName);
          } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.txt') {
            const canonicalPath = resolveExistingPath(fullPath);
            if (!isAllowedByFolder(canonicalPath, folder)) continue;

            const pathKey = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
            if (seenPaths.has(pathKey)) continue;
            seenPaths.add(pathKey);

            const stat = fs.statSync(canonicalPath);
            txtFiles.push({
              path: canonicalPath,
              name: entry.name,
              rootId: folder.id,
              rootName: rootName,
              size: stat.size,
              mtime: stat.mtimeMs
            });
          }
        } catch (err) {
          // Ignore permissions errors
        }
      }
    } catch (err) {
      // Ignore directory read errors
    }
  };

  for (const f of folders) {
    const localPath = f.local_path;
    if (localPath && fs.existsSync(localPath)) {
      walkSync(localPath, f, path.basename(localPath) || localPath);
    }
  }

  return txtFiles;
}

function assertAllowedTextFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Missing note path.');
  }

  const resolved = resolveExistingPath(filePath);
  if (path.extname(resolved).toLowerCase() !== '.txt') {
    throw new Error('Secure Notebook can only open text files.');
  }

  if (!getNotebookFolders().some(folder => isAllowedByFolder(resolved, folder))) {
    throw new Error('Secure Notebook can only access files inside configured backup folders.');
  }

  return resolved;
}

/**
 * Generate a unique safe hash for a file path to use as a directory name in the cloud.
 */
function getPathHash(filePath) {
  return crypto.createHash('md5').update(filePath.toLowerCase()).digest('hex');
}

/**
 * Save new content to a local .txt file, but push the previous content to cloud version history first.
 */
async function saveWithVersioning(filePath, newContent) {
  filePath = assertAllowedTextFile(filePath);

  if (!fs.existsSync(filePath)) {
    // New file, no previous version
    fs.writeFileSync(filePath, newContent, 'utf8');
    return;
  }

  const oldContent = fs.readFileSync(filePath, 'utf8');
  if (oldContent === newContent) {
    return; // No changes
  }

  // Push old content to version history
  const fileHash = getPathHash(filePath);
  const versionId = `v_${Date.now()}`;
  
  try {
    const encryptedData = await fastCrypt.encrypt(oldContent);
    // Upload below the unified LabSuite cloud root: Apps/NotepadVersions/...
    await fastDriveSync.uploadData(`NotepadVersions/${fileHash}`, `${versionId}.enc`, encryptedData);
    
    // Prune old versions (keep last 10)
    const versions = await fastDriveSync.listFiles(`NotepadVersions/${fileHash}`);
    if (versions && versions.length > 10) {
      // Sort oldest first (by filename timestamp)
      versions.sort((a, b) => a.Name.localeCompare(b.Name));
      const toDelete = versions.slice(0, versions.length - 10);
      for (const oldVer of toDelete) {
        await fastDriveSync.deleteFile(`NotepadVersions/${fileHash}`, oldVer.Name);
      }
    }
  } catch (err) {
    console.error(`LabSuite Notepad: Failed to save version history for ${filePath}:`, err.message);
  }

  // Save locally
  fs.writeFileSync(filePath, newContent, 'utf8');
}

/**
 * Fetch all available cloud versions for a file
 */
async function getVersions(filePath) {
  filePath = assertAllowedTextFile(filePath);
  const fileHash = getPathHash(filePath);
  try {
    const versions = await fastDriveSync.listFiles(`NotepadVersions/${fileHash}`);
    return versions.map(v => ({
      id: v.Name.replace('.enc', ''),
      timestamp: parseInt(v.Name.split('_')[1]),
      size: v.Size
    })).sort((a, b) => b.timestamp - a.timestamp); // newest first
  } catch (err) {
    console.error('Failed to list versions:', err.message);
    return [];
  }
}

/**
 * Download and decrypt a specific version
 */
async function restoreVersion(filePath, versionId) {
  filePath = assertAllowedTextFile(filePath);
  const fileHash = getPathHash(filePath);
  try {
    const encryptedData = await fastDriveSync.downloadData(`NotepadVersions/${fileHash}`, `${versionId}.enc`);
    const rawText = await fastCrypt.decrypt(encryptedData);
    return rawText;
  } catch (err) {
    console.error('Failed to restore version:', err.message);
    throw err;
  }
}

module.exports = {
  listLocal,
  assertAllowedTextFile,
  saveWithVersioning,
  getVersions,
  restoreVersion
};
