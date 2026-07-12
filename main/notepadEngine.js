const fs = require('fs');
const path = require('path');
const db = require('./database');
const fastDriveSync = require('./fastDriveSync');
const fastCrypt = require('./fastCrypt');
const crypto = require('crypto');

/**
 * Scan all LabSuite managed folders for .txt files.
 */
function listLocal() {
  const folders = db.getFolders();
  const txtFiles = [];

  const walkSync = (dir, rootId, rootName) => {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            walkSync(fullPath, rootId, rootName);
          } else if (file.endsWith('.txt')) {
            txtFiles.push({
              path: fullPath,
              name: file,
              rootId: rootId,
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
    const localPath = f.local_path || f.path;
    if (localPath && fs.existsSync(localPath)) {
      walkSync(localPath, f.id, path.basename(localPath));
    }
  }

  return txtFiles;
}

function assertAllowedTextFile(filePath) {
  const filesystem = require('./filesystem');
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Missing note path.');
  }

  const resolved = path.resolve(filePath);
  if (path.extname(resolved).toLowerCase() !== '.txt') {
    throw new Error('Secure Notebook can only open text files.');
  }

  if (!filesystem.isWithinSharedPaths(resolved)) {
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
    // Upload to gdrive:/LabSuite-Apps/NotepadVersions/<hash>/<versionId>.enc
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
