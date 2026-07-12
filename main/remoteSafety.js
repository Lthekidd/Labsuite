let fs;
try {
  fs = require('original-fs');
} catch (e) {
  fs = require('fs');
}

function safeMkdirSync(dir, opts) {
  try { fs.mkdirSync(dir, opts); } catch (e) { if (e.code !== 'EEXIST') console.error('mkdirSync err:', e.message); }
}
function safeUnlinkSync(file) {
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') console.error('unlinkSync err:', e.message); }
}
function safeWriteFileSync(file, data, opts) {
  try { fs.writeFileSync(file, data, opts); return true; } catch (e) { console.error('writeFileSync err:', e.message); return false; }
}
function safeReadFileSync(file, opts) {
  try { return fs.readFileSync(file, opts); } catch (e) { console.error('readFileSync err:', e.message); return null; }
}
function safeParseJson(str, fallback = null) {
  try { return JSON.parse(str); } catch(e) { console.error('JSON parse err:', e.message); return fallback; }
}

const os = require('os');
const path = require('path');
const db = require('./database');
const rclone = require('./rclone');
const manifest = require('./backupManifest');
const remoteCatalog = require('./remoteCatalog');

const VAULT_MARKER_FILE = 'vault-marker.json';
const VAULT_METADATA_FILE = 'vault-metadata.json';

function getVaultMarkerPath() {
  return rclone.getVaultPath('control', VAULT_MARKER_FILE);
}

function getVaultMetadataRawPath() {
  return `${rclone.getControlFolderName()}/${VAULT_METADATA_FILE}`;
}

function getControlFolderNameForEncryptedFolder(encryptedFolder = '') {
  return /^VaultSync-Encrypted$/i.test(String(encryptedFolder || '')) ? 'VaultSync-Control' : 'LabSuite-Control';
}

function getVaultMetadataRawPathForEncryptedFolder(encryptedFolder = '') {
  return `${getControlFolderNameForEncryptedFolder(encryptedFolder)}/${VAULT_METADATA_FILE}`;
}

function makeTempJsonFile(prefix, payload) {
  const dir = path.join(os.tmpdir(), 'labsuite-control');
  safeMkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  safeWriteFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

function safeUnlink(filePath) {
  try {
    safeUnlinkSync(filePath);
  } catch (_) {
    // Best-effort temp cleanup.
  }
}

async function ensureVaultMarker() {
  const payload = {
    app: 'LabSuite',
    marker: 'encrypted-backup-vault',
    createdAt: db.getSetting('vault_marker_created_at') || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const tempPath = makeTempJsonFile('vault-marker', payload);
  try {
    const markerPath = getVaultMarkerPath();
    await rclone.syncFile(tempPath, markerPath);
    db.setSetting('vault_marker_created_at', payload.createdAt);
    db.setSetting('vault_marker_last_seen_at', payload.updatedAt);
    db.setSetting('vault_marker_missing_since', '');
    return { ok: true, markerPath };
  } finally {
    safeUnlink(tempPath);
  }
}

async function ensureVaultMetadata() {
  const payload = {
    app: 'LabSuite',
    marker: 'labsuite-vault-metadata',
    encryptedFolder: rclone.getEncryptedFolder(),
    createdAt: db.getSetting('vault_metadata_created_at') || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    passwordHint: db.getSetting('password_hint') || ''
  };
  const tempPath = makeTempJsonFile('vault-metadata', payload);
  try {
    const metadataPath = getVaultMetadataRawPath();
    await rclone.syncRawFile(tempPath, metadataPath);
    db.setSetting('vault_metadata_created_at', payload.createdAt);
    db.setSetting('vault_metadata_last_seen_at', payload.updatedAt);
    return { ok: true, metadataPath, metadata: payload };
  } finally {
    safeUnlink(tempPath);
  }
}

async function readVaultMetadata(encryptedFolder = rclone.getEncryptedFolder()) {
  try {
    const text = await rclone.readRawText(getVaultMetadataRawPathForEncryptedFolder(encryptedFolder));
    const metadata = safeParseJson(text);
    if (metadata && ['labsuite-vault-metadata', 'vaultsync-vault-metadata'].includes(metadata.marker)) {
      db.setSetting('vault_metadata_last_seen_at', new Date().toISOString());
      return metadata;
    }
  } catch (_) {
    // Older vaults may not have metadata yet.
  }
  return null;
}

async function readVaultMarker() {
  const text = await rclone.readText(getVaultMarkerPath());
  const marker = safeParseJson(text);
  const validMarker = marker &&
    ['LabSuite', 'VaultSync'].includes(marker.app) &&
    ['encrypted-backup-vault', 'vaultsync-encrypted-backup-vault'].includes(marker.marker);
  if (!validMarker) {
    throw new Error('Remote vault marker is invalid.');
  }
  db.setSetting('vault_marker_last_seen_at', new Date().toISOString());
  db.setSetting('vault_marker_missing_since', '');
  return marker;
}

async function validateExistingVaultAccess() {
  const rawVault = await inspectRawVault();
  if (!rawVault.exists || rawVault.encryptedRootItemCount === 0) {
    return { ok: true, status: 'empty_or_new', rawVault };
  }

  try {
    const marker = await readVaultMarker();
    return { ok: true, status: 'marker_verified', marker, rawVault };
  } catch (markerError) {
    try {
      const catalog = await remoteCatalog.readRemote();
      return { ok: true, status: 'catalog_verified', catalogGeneratedAt: catalog.generatedAt, rawVault };
    } catch (catalogError) {
      // Early VaultSync vaults predate both control files. A successful strict
      // decrypted listing is still a sound compatibility check: rclone emits a
      // crypto error for undecryptable names when the password is wrong.
      try {
        const decryptedItems = await rclone.listRemoteDirStrict('', 1, { timeoutMs: 45000 });
        if (Array.isArray(decryptedItems) && decryptedItems.length > 0) {
          return {
            ok: true,
            status: 'legacy_root_verified',
            decryptedRootItemCount: decryptedItems.length,
            rawVault
          };
        }
      } catch (legacyError) {
        const combinedMessage = [markerError, catalogError, legacyError]
          .map(error => String(error && error.message ? error.message : error).toLowerCase())
          .join(' ');
        const isConnectivityFailure = /timed out|timeout|connection|network|rate limit|quota|403/.test(combinedMessage);
        const error = new Error(isConnectivityFailure
          ? 'LabSuite could not finish checking the vault because Google Drive did not respond in time. The password was not rejected; check the connection and try again.'
          : 'The master password could not decrypt this existing VaultSync/LabSuite vault. Check the password and its exact capitalization, then try again.');
        error.cause = { markerError, catalogError, legacyError };
        throw error;
      }

      const error = new Error(
        'The master password could not decrypt this existing VaultSync/LabSuite vault. Check the password and its exact capitalization, then try again.'
      );
      error.cause = { markerError, catalogError };
      throw error;
    }
  }
}

async function inspectRawVault() {
  const localPasswordHint = db.getSetting('password_hint') || '';
  const candidates = [
    rclone.getEncryptedFolder(),
    rclone.ENCRYPTED_FOLDER,
    rclone.LEGACY_ENCRYPTED_FOLDER
  ].filter((value, index, list) => value && list.indexOf(value) === index);

  const inspected = [];
  for (const encryptedFolder of candidates) {
    const metadata = await readVaultMetadata(encryptedFolder);
    let encryptedRootExists = false;
    let encryptedRootItemCount = 0;

    try {
      const items = await rclone.listRawDirStrict(encryptedFolder);
      encryptedRootExists = true;
      encryptedRootItemCount = Array.isArray(items) ? items.length : 0;
    } catch (_) {
      encryptedRootExists = false;
    }

    inspected.push({
      encryptedFolder,
      encryptedRootExists,
      encryptedRootItemCount,
      metadata,
      metadataPath: getVaultMetadataRawPathForEncryptedFolder(encryptedFolder)
    });
  }

  const selected = inspected.find(item => item.metadata) ||
    inspected.find(item => item.encryptedRootExists) ||
    inspected[0] ||
    { encryptedFolder: rclone.getEncryptedFolder(), encryptedRootExists: false, encryptedRootItemCount: 0, metadata: null, metadataPath: getVaultMetadataRawPath() };
  const metadata = selected.metadata;
  const encryptedRootExists = !!selected.encryptedRootExists;
  const encryptedRootItemCount = selected.encryptedRootItemCount || 0;
  const exists = !!metadata || encryptedRootExists;
  return {
    exists,
    encryptedRootExists,
    encryptedRootItemCount,
    metadata,
    passwordHint: metadata && metadata.passwordHint ? metadata.passwordHint : localPasswordHint,
    passwordHintSource: metadata && metadata.passwordHint ? 'remote' : (localPasswordHint ? 'local' : ''),
    metadataPath: selected.metadataPath,
    encryptedFolder: selected.encryptedFolder,
    candidates: inspected.map(item => ({
      encryptedFolder: item.encryptedFolder,
      encryptedRootExists: item.encryptedRootExists,
      encryptedRootItemCount: item.encryptedRootItemCount,
      metadataPath: item.metadataPath,
      metadataMarker: item.metadata && item.metadata.marker ? item.metadata.marker : ''
    }))
  };
}

async function checkVaultMarker() {
  try {
    const markerPath = getVaultMarkerPath();
    const metadata = await rclone.getRemoteFileMetadata(markerPath);
    if (metadata) {
      db.setSetting('vault_marker_last_seen_at', new Date().toISOString());
      db.setSetting('vault_marker_missing_since', '');
      return { ok: true, status: 'ok', markerPath };
    }
    if (!hasProtectedState()) {
      return { ok: true, status: 'not_initialized', markerPath };
    }
    const missingSince = db.getSetting('vault_marker_missing_since') || new Date().toISOString();
    db.setSetting('vault_marker_missing_since', missingSince);
    return {
      ok: false,
      status: 'missing',
      severity: 'critical',
      markerPath,
      missingSince,
      message: 'The encrypted Google Drive vault marker is missing. The remote backup folder may have been deleted or reset.'
    };
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      severity: 'warning',
      markerPath,
      message: error.message
    };
  }
}

function hasProtectedState() {
  if (db.getRestorePoints().length > 0) return true;
  for (const folder of db.getFolders()) {
    if (folder.last_success_at) return true;
    const entries = Object.values(db.getManifestEntries(folder.id));
    if (entries.some(entry => ['backed_up', 'deleted', 'deleted_pending_history', 'active_repair_needed'].includes(entry.status))) {
      return true;
    }
  }
  return false;
}

function getEntryRemotePath(entry) {
  if (entry.storage === 'pack' && entry.pack_remote_path) return entry.pack_remote_path;
  return entry.remote_path || null;
}

function normalizeRemotePath(value) {
  return manifest.normalizeRelativePath(value);
}

function joinRemotePath(root, relativePath) {
  const normalizedRoot = normalizeRemotePath(root);
  const normalizedRelative = normalizeRemotePath(relativePath);
  return normalizedRelative ? `${normalizedRoot}/${normalizedRelative}`.replace(/\\/g, '/') : normalizedRoot;
}

function makePackRemoteRoot(folder) {
  return rclone.getVaultPath('packs', folder.remote_path).replace(/\\/g, '/');
}

function stripRemoteRoot(remotePath, remoteRoot) {
  const normalizedPath = normalizeRemotePath(remotePath);
  const normalizedRoot = normalizeRemotePath(remoteRoot);
  if (!normalizedRoot) return normalizedPath;
  if (normalizedPath === normalizedRoot) return '';
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

function makeRemoteObjectSet(items = [], remoteRoot = '') {
  const root = normalizeRemotePath(remoteRoot);
  const paths = new Set();

  for (const item of items) {
    if (!item || item.IsDir) continue;
    const itemPath = normalizeRemotePath(item.Path || item.Name || '');
    if (!itemPath) continue;
    paths.add(itemPath);
    if (root) paths.add(joinRemotePath(root, itemPath));
  }

  return paths;
}

async function listRemoteObjectSet(remoteRoot, options = {}) {
  try {
    const items = options.recursive === false
      ? await rclone.listRemoteDirStrict(remoteRoot)
      : await rclone.listRemoteTreeStrict(remoteRoot);
    return makeRemoteObjectSet(items, remoteRoot);
  } catch (error) {
    if (rclone.__private.isNotFoundError(error)) {
      return new Set();
    }
    throw error;
  }
}

function getActiveManifestEntries(folder) {
  return Object.values(db.getManifestEntries(folder.id))
    .filter(entry => entry.status === 'backed_up')
    .filter(entry => !!normalizeRemotePath(entry.relative_path))
    .filter(entry => !!getEntryRemotePath(entry));
}

function getExpectedDirectPath(entry, folder) {
  return normalizeRemotePath(entry.relative_path || stripRemoteRoot(entry.remote_path, folder.remote_path));
}

function getExpectedPackPath(entry, folder) {
  const packPath = entry.pack_remote_path || entry.remote_path;
  return normalizeRemotePath(packPath || '');
}

function getSampleEntries(folder, maxSamples) {
  const entries = Object.values(db.getManifestEntries(folder.id))
    .filter(entry => entry.status === 'backed_up')
    .filter(entry => !!getEntryRemotePath(entry));
  const direct = entries.filter(entry => entry.storage !== 'pack');
  const packed = entries.filter(entry => entry.storage === 'pack');
  return [...direct.slice(0, maxSamples), ...packed.slice(0, maxSamples)].slice(0, maxSamples);
}

async function checkProtectedSamples(maxSamplesPerFolder = 3) {
  const warnings = [];

  for (const folder of db.getEnabledFolders()) {
    if (!folder.last_success_at) continue;
    const samples = getSampleEntries(folder, maxSamplesPerFolder);
    if (samples.length === 0) continue;

    let missing = 0;
    const checked = [];
    for (const entry of samples) {
      const remotePath = getEntryRemotePath(entry);
      const metadata = await rclone.getRemoteFileMetadata(remotePath);
      checked.push({ relativePath: entry.relative_path, remotePath, exists: !!metadata });
      if (!metadata) missing += 1;
    }

    if (missing > 0) {
      warnings.push({
        folderId: folder.id,
        folderPath: folder.local_path,
        severity: missing === samples.length ? 'critical' : 'warning',
        checked,
        message: `${missing} of ${samples.length} sampled protected backup object${samples.length === 1 ? '' : 's'} are missing from Google Drive. The remote folder may have been deleted or partially removed.`
      });
    }
  }

  return warnings;
}

async function findMissingActiveCopiesForFolder(folder) {
  if (!folder || !folder.last_success_at) {
    return { checked: 0, missing: [], skipped: true };
  }

  const entries = getActiveManifestEntries(folder);
  if (entries.length === 0) {
    return { checked: 0, missing: [] };
  }

  const directEntries = entries.filter(entry => entry.storage !== 'pack');
  const packedEntries = entries.filter(entry => entry.storage === 'pack');
  const missing = [];
  let directObjects = null;
  let packObjects = null;
  const packRoot = makePackRemoteRoot(folder);

  if (directEntries.length > 0) {
    directObjects = await listRemoteObjectSet(folder.remote_path);
    for (const entry of directEntries) {
      const expected = getExpectedDirectPath(entry, folder);
      const fullExpected = joinRemotePath(folder.remote_path, expected);
      if (!directObjects.has(expected) && !directObjects.has(fullExpected)) {
        missing.push({
          entry,
          relativePath: expected,
          remotePath: fullExpected,
          storage: 'file'
        });
      }
    }
  }

  if (packedEntries.length > 0) {
    packObjects = await listRemoteObjectSet(packRoot, { recursive: false });
    for (const entry of packedEntries) {
      const packPath = getExpectedPackPath(entry, folder);
      if (!packPath) continue;
      const packRelativePath = stripRemoteRoot(packPath, packRoot);
      if (!packObjects.has(packPath) && !packObjects.has(packRelativePath)) {
        missing.push({
          entry,
          relativePath: normalizeRemotePath(entry.relative_path),
          remotePath: packPath,
          storage: 'pack'
        });
      }
    }
  }

  return {
    checked: entries.length,
    missing
  };
}

async function markMissingActiveCopiesForFolder(folder) {
  const result = await findMissingActiveCopiesForFolder(folder);
  if (!result.missing || result.missing.length === 0) return { ...result, marked: 0 };

  await db.withWriteBatch(async () => {
    for (const item of result.missing) {
      manifest.recordRemoteMissing(folder, item.entry, item.remotePath);
    }
  });

  return { ...result, marked: result.missing.length };
}

async function getRemoteSafetyStatus({ sample = true } = {}) {
  const marker = await checkVaultMarker();
  const sampleWarnings = sample ? await checkProtectedSamples() : [];
  const ok = marker.ok && sampleWarnings.length === 0;
  return {
    ok,
    isSafe: ok,
    marker,
    sampleWarnings,
    checkedAt: new Date().toISOString()
  };
}

module.exports = {
  VAULT_MARKER_PATH: getVaultMarkerPath(),
  VAULT_METADATA_RAW_PATH: getVaultMetadataRawPath(),
  getVaultMarkerPath,
  getVaultMetadataRawPath,
  ensureVaultMarker,
  ensureVaultMetadata,
  readVaultMetadata,
  readVaultMarker,
  validateExistingVaultAccess,
  inspectRawVault,
  checkVaultMarker,
  checkProtectedSamples,
  findMissingActiveCopiesForFolder,
  markMissingActiveCopiesForFolder,
  getRemoteSafetyStatus
};
