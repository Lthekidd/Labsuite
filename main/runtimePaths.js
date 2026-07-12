const fs = require('fs');
const path = require('path');

function getRcloneFileName(platform = process.platform) {
  return platform === 'win32' ? 'rclone-win.exe' : 'rclone-mac';
}

function getBundledRcloneCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const fileName = getRcloneFileName(platform);
  const isPackaged = Boolean(options.isPackaged);

  if (!isPackaged) {
    const mainDir = options.mainDir || __dirname;
    return [path.resolve(mainDir, '../bin', fileName)];
  }

  const resourcesPath = options.resourcesPath || process.resourcesPath;
  if (!resourcesPath) {
    throw new Error('Electron resourcesPath is unavailable in the packaged application.');
  }

  return [
    // electron-builder extraResources places bin directly under resources.
    path.join(resourcesPath, 'bin', fileName),
    // Retain compatibility with older builds that unpacked bin from app.asar.
    path.join(resourcesPath, 'app.asar.unpacked', 'bin', fileName)
  ];
}

function resolveBundledRclonePath(options = {}) {
  const candidates = getBundledRcloneCandidates(options);
  const resolved = candidates.find(candidate => fs.existsSync(candidate));
  if (resolved) return resolved;

  const error = new Error(`Bundled rclone executable was not found. Checked: ${candidates.join(', ')}`);
  error.code = 'RCLONE_BINARY_MISSING';
  error.candidates = candidates;
  throw error;
}

module.exports = {
  getRcloneFileName,
  getBundledRcloneCandidates,
  resolveBundledRclonePath
};
