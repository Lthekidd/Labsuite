function normalizeSlashes(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
}

function normalizeLocalPathForCompare(value = '') {
  return normalizeSlashes(value).toLowerCase();
}

function normalizeRemotePath(value = '') {
  return normalizeSlashes(value).replace(/^\/+/, '');
}

function normalizeComputerName(value = '') {
  return String(value || '').trim().toLowerCase();
}

function getLocalComputerName() {
  const os = require('os');
  return os.hostname() || 'My-PC';
}

function getRemoteComputerName(remotePath = '') {
  const parts = normalizeRemotePath(remotePath).split('/').filter(Boolean);
  return parts[0] === 'computers' && parts[1] ? parts[1] : '';
}

function isRemotePathForComputer(remotePath = '', computerName = getLocalComputerName()) {
  const remoteComputer = getRemoteComputerName(remotePath);
  return !remoteComputer || normalizeComputerName(remoteComputer) === normalizeComputerName(computerName);
}

function isFolderForDevice(folder = {}, options = {}) {
  const deviceFingerprint = String(options.deviceFingerprint || '').trim();
  const folderFingerprint = String(folder.device_fingerprint || '').trim();
  if (folderFingerprint && deviceFingerprint) return folderFingerprint === deviceFingerprint;
  if (folderFingerprint && options.requireFingerprint === true) return false;
  return isRemotePathForComputer(folder.remote_path, options.computerName || getLocalComputerName());
}

function isFolderEnabled(folder = {}) {
  return folder.enabled === 1 || folder.enabled === true || folder.enabled === undefined;
}

function localPathToPortableParts(localPath = '') {
  const cleaned = normalizeSlashes(localPath)
    .replace(/^([A-Za-z]):\//, '$1/')
    .replace(/^([A-Za-z]):$/, '$1');

  return cleaned
    .split('/')
    .filter(Boolean)
    .map((part, index) => (index === 0 && /^[A-Za-z]$/.test(part) ? part.toUpperCase() : part));
}

function remotePathToPortableParts(remotePath = '') {
  const parts = normalizeRemotePath(remotePath).split('/').filter(Boolean);
  if (parts[0] !== 'computers' || parts.length < 3) return [];
  return parts.slice(2).map((part, index) => (index === 0 && /^[A-Za-z]$/.test(part) ? part.toUpperCase() : part));
}

function makeProfileAgnosticKey(parts = []) {
  if (!parts.length) return '';
  const lowered = parts.map(part => String(part || '').toLowerCase());
  if (lowered.length >= 4 && lowered[1] === 'users') {
    return [lowered[0], 'users', '*', ...lowered.slice(3)].join('/');
  }
  return lowered.join('/');
}

function getProfileAgnosticKeyForLocalPath(localPath = '') {
  return makeProfileAgnosticKey(localPathToPortableParts(localPath));
}

function getProfileAgnosticKeyForRemotePath(remotePath = '') {
  return makeProfileAgnosticKey(remotePathToPortableParts(remotePath));
}

function getFolderIdentityKeys(folder = {}) {
  return new Set([
    getProfileAgnosticKeyForLocalPath(folder.local_path),
    getProfileAgnosticKeyForRemotePath(folder.remote_path)
  ].filter(Boolean));
}

function findReusableFolder(folders = [], localPath = '', options = {}) {
  const targetPath = normalizeLocalPathForCompare(localPath);
  const computerName = options.computerName || getLocalComputerName();
  const deviceFingerprint = options.deviceFingerprint || '';
  const allowForeignComputer = options.allowForeignComputer === true;
  const inactiveFolders = folders.filter(folder =>
    !isFolderEnabled(folder) &&
    (allowForeignComputer || isFolderForDevice(folder, { computerName, deviceFingerprint }))
  );

  const exactMatches = inactiveFolders.filter(folder =>
    normalizeLocalPathForCompare(folder.local_path) === targetPath
  );
  if (exactMatches.length === 1) return exactMatches[0];

  const targetKey = getProfileAgnosticKeyForLocalPath(localPath);
  if (!targetKey) return null;

  const identityMatches = inactiveFolders.filter(folder =>
    getFolderIdentityKeys(folder).has(targetKey)
  );
  if (identityMatches.length === 1) return identityMatches[0];

  const importedMatches = identityMatches.filter(folder => folder.imported_from_remote_catalog);
  return importedMatches.length === 1 ? importedMatches[0] : null;
}


let cachedFingerprint = null;

function getDeviceFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;

  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  let fingerprintPath = '';
  try {
    const { app } = require('electron');
    fingerprintPath = path.join(app.getPath('userData'), 'device-fingerprint');
    // Upgrade existing installations without changing their identity: older
    // releases stored the hardware fingerprint only in this hostname map.
    // Seed the new lightweight local file from that value when possible.
    try {
      const db = require('./database');
      const mappings = JSON.parse(db.getSetting('device_fingerprints') || '{}');
      const matches = Object.entries(mappings || {}).filter(([fingerprint, name]) => (
        /^[a-f0-9]{32}$/i.test(fingerprint) && normalizeComputerName(name) === normalizeComputerName(os.hostname())
      ));
      if (matches.length === 1) {
        cachedFingerprint = matches[0][0].toLowerCase();
        try { fs.writeFileSync(fingerprintPath, cachedFingerprint, { encoding: 'utf8', mode: 0o600 }); } catch (_) {}
        return cachedFingerprint;
      }
    } catch (_) {}
    if (fs.existsSync(fingerprintPath)) {
      const stored = fs.readFileSync(fingerprintPath, 'utf8').trim();
      if (/^[a-f0-9]{32}$/i.test(stored)) {
        cachedFingerprint = stored.toLowerCase();
        return cachedFingerprint;
      }
    }
  } catch (_) {}

  const macs = [];
  for (const networks of Object.values(os.networkInterfaces())) {
    for (const network of networks || []) {
      if (!network.internal && network.mac && network.mac !== '00:00:00:00:00:00') {
        macs.push(network.mac.toLowerCase());
      }
    }
  }
  const rawId = macs.sort().join('-') || os.hostname() || crypto.randomUUID();
  cachedFingerprint = crypto.createHash('md5').update(rawId).digest('hex');
  if (fingerprintPath) {
    try {
      fs.writeFileSync(fingerprintPath, cachedFingerprint, { encoding: 'utf8', mode: 0o600 });
    } catch (_) {}
  }
  return cachedFingerprint;
}

module.exports = {
  normalizeLocalPathForCompare,
  normalizeRemotePath,
  normalizeComputerName,
  getLocalComputerName,
  getRemoteComputerName,
  isRemotePathForComputer,
  isFolderForDevice,
  isFolderEnabled,
  localPathToPortableParts,
  remotePathToPortableParts,
  getProfileAgnosticKeyForLocalPath,
  getProfileAgnosticKeyForRemotePath,
  findReusableFolder,
  getDeviceFingerprint
};
