const { ipcMain, dialog, app } = require('electron');
const fs = require('fs');

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
function safeStatSync(file) {
  try { return fs.statSync(file); } catch (_) { return null; }
}

function getNonOverwritingRestorePath(destinationRoot, relativePath) {
  const normalized = packStore.assertSafeRelativePath(relativePath);
  const requestedPath = path.join(destinationRoot, normalized.replace(/\//g, path.sep));
  return packStore.getNonOverwritingPath(requestedPath);
}

const https = require('https');
const os = require('os');
const path = require('path');
const db = require('./database');
const rclone = require('./rclone');
const keychain = require('./keychain');
const watcher = require('./watcher');
const scheduler = require('./scheduler');
const syncQueue = require('./syncQueue');
const backupWorker = require('./backupWorker');
const restorePlanner = require('./restorePlanner');
const autostart = require('./autostart');
const filesystem = require('./filesystem');
const folderIdentity = require('./folderIdentity');
const packStore = require('./packStore');
const remoteSafety = require('./remoteSafety');
const remoteCatalog = require('./remoteCatalog');
const restorePaths = require('./restorePaths');
const backupShortcuts = require('./backupShortcuts');
const vaultDestinations = require('./vaultDestinations');
const backupVerifier = require('./backupVerifier');
const aliases = require('./aliases');
const tray = require('./tray');

let storageAnalyticsRefresh = null;
let gDriveInfoRefresh = null;
let remoteSafetyRefresh = null;

const FILE_ACTIVITY_IPC_FLUSH_MS = 500;
const FILE_ACTIVITY_IPC_BATCH_LIMIT = 250;
const FILE_ACTIVITY_IPC_BUFFER_LIMIT = 1000;
const PACKED_BROWSE_CACHE_MS = 5 * 60 * 1000;
const DIRECT_BROWSE_CACHE_MS = 60 * 1000;
const BACKUP_SHORTCUT_CACHE_MS = 5 * 60 * 1000;
const DIAGNOSTIC_TAIL_BYTES = 256 * 1024;

const packedBrowseCache = new Map();
const directBrowseCache = new Map();
const restoreListInflight = new Map();
let backupShortcutCache = null;
let backupShortcutRefresh = null;

const RENDERER_WRITABLE_SETTINGS = new Set([
  'sync_interval_minutes',
  'sync_on_file_change',
  'start_on_login',
  'notifications_enabled',
  'bwlimit',
  'bwlimit_scheduler_enabled',
  'bwlimit_scheduled_value',
  'bwlimit_scheduled_start',
  'bwlimit_scheduled_end',
  'schedule_start',
  'schedule_end',
  'sync_schedule_type',
  'wifi_only',
  'pause_on_metered',
  'battery_mode',
  'throttle_cpu',
  'sync_only_when_idle',
  'sync_idle_threshold_minutes',
  'sync_active_hours_enabled',
  'sync_active_hours_start',
  'sync_active_hours_end',
  'use_default_exclusions',
  'password_hint',
  'setup_complete',
  'smart_throttle_enabled',
  'upload_speed_capacity',
  'smart_throttle_min_pct',
  'smart_throttle_max_pct',
  'smart_throttle_idle_mins',
  'backup_retention_days',
  'full_reconcile_interval_hours',
  'remote_integrity_check_interval_hours',
  'verify_after_backup',
  'backup_version_retention_days',
  'backup_deleted_retention_days',
  'backup_min_versions_per_file',
  'backup_transfer_profile',
  'pack_small_files_enabled',
  'pack_small_file_max_bytes',
  'pack_max_raw_bytes',
  'pack_max_files',
  'pack_root_prune_interval_hours',
  'explorer_friendly_active_vault',
  'crash_report_url'
]);

function isPlaceholderGDriveInfo(info) {
  const label = String(info && info.email || '').trim();
  return !label || label === 'Disconnected' || label === 'Connected Account' || label === 'Google Drive Account';
}

function normalizeRemotePath(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function redactDiagnosticText(text = '') {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/token\s*=\s*\{[^}\r\n]*\}/gi, 'token = <redacted>')
    .replace(/password=([^\s]+)/gi, 'password=<redacted>')
    .replace(/client_secret=([^\s]+)/gi, 'client_secret=<redacted>');
}

function readTextTail(filePath, maxBytes = DIAGNOSTIC_TAIL_BYTES) {
  const stat = safeStatSync(filePath);
  if (!stat || !stat.isFile()) return null;

  const length = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - length);
  const buffer = Buffer.alloc(length);
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, length, start);
    return {
      path: filePath,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      truncated: stat.size > maxBytes,
      text: redactDiagnosticText(buffer.toString('utf8'))
    };
  } catch (error) {
    return {
      path: filePath,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      truncated: stat.size > maxBytes,
      error: error.message
    };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function getDuplicateFolderGroupsForDiagnostics(folders = []) {
  const groups = new Map();
  for (const folder of folders) {
    const key = normalizeRemotePath(folder && folder.remote_path).toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      id: folder.id,
      local_path: folder.local_path,
      remote_path: folder.remote_path,
      enabled: folder.enabled,
      imported_from_remote_catalog: !!folder.imported_from_remote_catalog,
      device_name: folder.device_name || '',
      has_device_fingerprint: !!folder.device_fingerprint
    });
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([remote_path, items]) => ({ remote_path, items }));
}

function getDiagnosticPathState(filePath = '') {
  const requestedPath = String(filePath || '');
  if (!requestedPath) return { path: '', exists: false, error: 'No path recorded' };
  try {
    const stat = fs.statSync(requestedPath);
    return {
      path: requestedPath,
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      realPath: fs.realpathSync(requestedPath)
    };
  } catch (error) {
    return {
      path: requestedPath,
      exists: false,
      errorCode: error.code || '',
      error: error.message
    };
  }
}

function getBackupFailuresForDiagnostics(folders, state) {
  const foldersById = new Map(folders.map(folder => [String(folder.id), folder]));
  const manifestFailures = [];
  for (const [folderId, entries] of Object.entries(state.backup_manifest || {})) {
    const folder = foldersById.get(String(folderId)) || {};
    for (const [relativePath, entry] of Object.entries(entries || {})) {
      if (!['failed', 'active_repair_needed'].includes(String(entry.status || ''))) continue;
      const currentCandidatePath = folder.local_path
        ? path.join(folder.local_path, ...String(relativePath).replace(/\\/g, '/').split('/').filter(Boolean))
        : '';
      manifestFailures.push({
        folderId,
        folderPath: folder.local_path || '',
        selectionPath: folder.selection_path || '',
        remoteRoot: folder.remote_path || '',
        relativePath,
        status: entry.status || '',
        storage: entry.storage || '',
        remotePath: entry.remote_path || '',
        retryCount: entry.retry_count || 0,
        lastError: redactDiagnosticText(entry.last_error || ''),
        recordedLocalSource: getDiagnosticPathState(entry.local_path || ''),
        currentLocalCandidate: getDiagnosticPathState(currentCandidatePath),
        selectedSource: getDiagnosticPathState(folder.selection_path || '')
      });
    }
  }

  return {
    manifestFailures: manifestFailures.slice(0, 200),
    recentFailedActivity: (state.sync_log || [])
      .filter(log => log.status !== 'success')
      .slice(-200)
      .reverse()
      .map(log => ({
        timestamp: log.synced_at,
        folderId: log.folder_id,
        filePath: log.file_path,
        action: log.action,
        size: log.size_bytes || 0,
        error: redactDiagnosticText(log.error_msg || '')
      }))
  };
}

function buildDiagnosticsReport() {
  const userDataDir = app.getPath('userData');
  const logsDir = app.getPath('logs');
  const dbFile = path.join(userDataDir, 'labsuite_db.json');
  const folders = db.getFolders();
  const state = db.getDb();
  const backupManifest = state.backup_manifest || {};
  const manifestEntryCount = Object.values(backupManifest)
    .reduce((sum, entries) => sum + Object.keys(entries || {}).length, 0);
  const logFiles = ['labsuite.log', 'labsuite.log.1', 'labsuite.log.2', 'labsuite.log.3', 'labsuite.log.4', 'labsuite.log.5']
    .map(file => path.join(logsDir, file))
    .filter(file => fs.existsSync(file));

  return {
    generatedAt: new Date().toISOString(),
    app: {
      name: 'LabSuite',
      version: app.getVersion(),
      userDataDir,
      logsDir,
      isPackaged: app.isPackaged
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      electron: process.versions.electron || '',
      chrome: process.versions.chrome || '',
      uptimeSec: Math.round(process.uptime()),
      memoryUsage: process.memoryUsage()
    },
    vault: {
      encryptedFolder: rclone.getEncryptedFolder(),
      vaultNamespace: rclone.getVaultNamespace(),
      configuredCryptRemoteRoot: redactDiagnosticText(rclone.getConfiguredCryptRemoteRoot())
    },
    database: {
      path: dbFile,
      bytes: safeStatSync(dbFile)?.size || 0,
      folderCount: folders.length,
      manifestFolderCount: Object.keys(backupManifest).length,
      manifestEntryCount,
      restorePointCount: (state.restore_points || []).length,
      syncLogCount: (state.sync_log || []).length,
      duplicateFolderGroups: getDuplicateFolderGroupsForDiagnostics(folders)
    },
    folders: folders.map(folder => ({
      id: folder.id,
      local_path: folder.local_path,
      remote_path: folder.remote_path,
      enabled: folder.enabled,
      imported_from_remote_catalog: !!folder.imported_from_remote_catalog,
      device_name: folder.device_name || '',
      has_device_fingerprint: !!folder.device_fingerprint,
      last_success_at: folder.last_success_at || '',
      sync_state: folder.sync_state || '',
      consecutive_failures: folder.consecutive_failures || 0,
      last_error: redactDiagnosticText(folder.last_error || '')
    })),
    settings: {
      sync_interval_minutes: db.getSetting('sync_interval_minutes'),
      sync_on_file_change: db.getSetting('sync_on_file_change'),
      backup_transfer_profile: db.getSetting('backup_transfer_profile'),
      full_reconcile_interval_hours: db.getSetting('full_reconcile_interval_hours'),
      remote_integrity_check_interval_hours: db.getSetting('remote_integrity_check_interval_hours'),
      explorer_friendly_active_vault: db.getSetting('explorer_friendly_active_vault')
    },
    backupFailures: getBackupFailuresForDiagnostics(folders, state),
    logs: Object.fromEntries(logFiles.map(file => [path.basename(file), readTextTail(file)])),
    rendererCrashLog: readTextTail(path.join(userDataDir, 'react_crash_logs.txt')),
    notes: [
      'Log text is tail-truncated and lightly redacted for email addresses, tokens, client secrets, and password arguments.',
      'The report intentionally omits rclone.conf and the full backup manifest.'
    ]
  };
}

function isRemotePathSameOrInside(childPath = '', parentPath = '') {
  const child = normalizeRemotePath(childPath);
  const parent = normalizeRemotePath(parentPath);
  return !!child && !!parent && (child === parent || child.startsWith(`${parent}/`));
}

function getLikelyRestoreFolderRoot(remotePath = '') {
  const current = normalizeRemotePath(remotePath);
  if (!current) return '';

  const knownFolderRoot = db.getFolders()
    .map(folder => normalizeRemotePath(folder && folder.remote_path))
    .filter(folderPath => folderPath && isRemotePathSameOrInside(current, folderPath))
    .sort((a, b) => b.length - a.length)[0];
  if (knownFolderRoot) return knownFolderRoot;

  const parts = current.split('/').filter(Boolean);
  if (parts[0] && parts[0].toLowerCase() === 'computers') {
    return parts.length >= 3 ? parts.slice(0, 3).join('/') : '';
  }
  return parts[0] || '';
}

function isComputerBackupAggregatePath(remotePath = '') {
  const parts = normalizeRemotePath(remotePath).split('/').filter(Boolean);
  return parts[0] && parts[0].toLowerCase() === 'computers' && parts.length < 3;
}

function assertDeletableVaultPath(remotePath = '') {
  const normalized = normalizeRemotePath(remotePath);
  if (!normalized) {
    throw new Error('Select a vault file or folder before deleting.');
  }

  const root = normalized.split('/')[0].toLowerCase();
  if (root.startsWith('.labsuite_') || root.startsWith('.vaultsync_')) {
    throw new Error('LabSuite system folders cannot be deleted from Vault Explorer.');
  }
  return normalized;
}

function cleanupLocalRecordsForDeletedRemotePath(remotePath = '') {
  const deletedPath = normalizeRemotePath(remotePath);
  let removedFolders = 0;
  let removedManifestEntries = 0;
  let removedRestorePoints = 0;

  for (const folder of db.getFolders()) {
    const folderRemotePath = normalizeRemotePath(folder.remote_path);
    if (!folderRemotePath) continue;

    if (isRemotePathSameOrInside(folderRemotePath, deletedPath)) {
      removedRestorePoints += db.removeRestorePointsForFolder(folder.id);
      db.removeFolder(folder.id);
      removedFolders += 1;
    } else if (isRemotePathSameOrInside(deletedPath, folderRemotePath)) {
      const relativePrefix = normalizeRemotePath(deletedPath.slice(folderRemotePath.length));
      removedManifestEntries += db.removeManifestEntriesUnderPath(folder.id, relativePrefix);
    }
  }

  return { removedFolders, removedManifestEntries, removedRestorePoints };
}

function getPackMirrorPath(remotePath = '') {
  const normalized = normalizeRemotePath(remotePath);
  return normalizeRemotePath(rclone.getVaultPath('packs', normalized));
}

function isPackFile(item) {
  return item && !item.IsDir && String(item.Name || item.Path || '').toLowerCase().endsWith('.vspack');
}

function getAncestorPaths(remotePath = '') {
  const parts = normalizeRemotePath(remotePath).split('/').filter(Boolean);
  const ancestors = [];
  for (let i = parts.length; i >= 0; i -= 1) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  return ancestors;
}

async function listRemoteDirOrEmpty(remotePath) {
  try {
    const items = await rclone.listRemoteDirStrict(remotePath);
    return Array.isArray(items) ? items : [];
  } catch (error) {
    if (rclone.__private.isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function getCachedPackedEntries(folderRemotePath) {
  const cacheKey = normalizeRemotePath(folderRemotePath) || '__vault_root__';
  const cached = packedBrowseCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.entries;
  }
  return null;
}

function setCachedPackedEntries(folderRemotePath, entries) {
  const cacheKey = normalizeRemotePath(folderRemotePath) || '__vault_root__';
  packedBrowseCache.set(cacheKey, {
    expiresAt: Date.now() + PACKED_BROWSE_CACHE_MS,
    entries
  });
}

function getCachedDirectListing(folderRemotePath) {
  const cacheKey = normalizeRemotePath(folderRemotePath) || '__vault_root__';
  const cached = directBrowseCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.items;
  }
  return null;
}

function setCachedDirectListing(folderRemotePath, items) {
  const cacheKey = normalizeRemotePath(folderRemotePath) || '__vault_root__';
  directBrowseCache.set(cacheKey, {
    expiresAt: Date.now() + DIRECT_BROWSE_CACHE_MS,
    items
  });
}

async function getCachedOrFreshGDriveInfo(options = {}) {
  const cached = options.force === true ? null : db.getCache('gdrive_info', 60 * 1000);
  if (cached && !isPlaceholderGDriveInfo(cached)) return cached;

  const stale = db.getCache('gdrive_info');
  if (gDriveInfoRefresh) {
    if (options.force !== true && stale && !isPlaceholderGDriveInfo(stale)) return stale;
    try {
      const inFlightInfo = await gDriveInfoRefresh;
      return isPlaceholderGDriveInfo(inFlightInfo) && stale && !isPlaceholderGDriveInfo(stale)
        ? stale
        : inFlightInfo;
    } catch (e) {
      return stale && !isPlaceholderGDriveInfo(stale)
        ? stale
        : { email: 'Disconnected', total: 0, used: 0 };
    }
  }

  gDriveInfoRefresh = rclone.getGDriveInfo()
    .then(info => {
      if (!isPlaceholderGDriveInfo(info)) {
        db.setCache('gdrive_info', info);
      }
      return info;
    })
    .finally(() => {
      gDriveInfoRefresh = null;
    });

  try {
    const fresh = await gDriveInfoRefresh;
    return isPlaceholderGDriveInfo(fresh) && stale && !isPlaceholderGDriveInfo(stale)
      ? stale
      : fresh;
  } catch (e) {
    return stale && !isPlaceholderGDriveInfo(stale)
      ? stale
      : { email: 'Disconnected', total: 0, used: 0 };
  }
}

async function readPackedEntriesForFolder(folderRemotePath, packFiles, mirrorItems = []) {
  const normalizedFolderRemotePath = normalizeRemotePath(folderRemotePath);
  const cached = getCachedPackedEntries(normalizedFolderRemotePath);
  if (cached) return cached;

  const entries = [];
  const packMirrorRoot = getPackMirrorPath(normalizedFolderRemotePath);
  const tempDir = path.join(os.tmpdir(), 'labsuite-browse-packs');
  safeMkdirSync(tempDir, { recursive: true });

  const availableMetaFiles = new Set(
    (mirrorItems || []).map(item => String(item.Path || item.Name || '').toLowerCase())
  );

  for (const item of packFiles) {
    if (!isPackFile(item)) continue;
    const listedPath = normalizeRemotePath(item.Path || item.Name);
    const packRootPrefix = `${rclone.getVaultPath('packs')}/`;
    const packRemotePath = listedPath.startsWith(packRootPrefix)
      ? listedPath
      : normalizeRemotePath(`${packMirrorRoot}/${listedPath}`);

    const metaRemotePath = packRemotePath + '.meta';
    const listedMetaName = listedPath + '.meta';
    const hasMetaFile = availableMetaFiles.has(metaRemotePath.toLowerCase()) ||
                        availableMetaFiles.has(listedMetaName.toLowerCase());

    if (hasMetaFile) {
      const tempMetaPath = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.vsmeta`);
      try {
        await rclone.copyFileRemoteToLocal(metaRemotePath, tempMetaPath);
        const payload = JSON.parse(safeReadFileSync(tempMetaPath, 'utf8') || "{}");
        const payloadFolderRemotePath = normalizeRemotePath(payload.folderRemotePath || normalizedFolderRemotePath);
        for (const file of payload.files || []) {
          const memberPath = normalizeRemotePath(file.relativePath || '');
          if (!payloadFolderRemotePath || !memberPath) continue;
          entries.push({
            fullPath: normalizeRemotePath(`${payloadFolderRemotePath}/${memberPath}`),
            memberPath,
            packRemotePath,
            packId: payload.packId || path.basename(packRemotePath, '.vspack'),
            size: Number(file.size) || 0,
            modTime: file.mtimeMs ? new Date(Number(file.mtimeMs)).toISOString() : (payload.createdAt || item.ModTime)
          });
        }
        continue; // Meta successfully loaded, skip full pack download!
      } catch (error) {
        console.warn('Restore browse: failed to inspect pack meta:', metaRemotePath, error.message);
      } finally {
        packStore.safeUnlink(tempMetaPath);
      }
    }

    const tempPath = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.vspack`);

    try {
      await rclone.copyFileRemoteToLocal(packRemotePath, tempPath);
      const payload = packStore.readPackFile(tempPath);
      const payloadFolderRemotePath = normalizeRemotePath(payload.folderRemotePath || normalizedFolderRemotePath);
      for (const file of payload.files || []) {
        const memberPath = normalizeRemotePath(file.relativePath || '');
        if (!payloadFolderRemotePath || !memberPath) continue;
        entries.push({
          fullPath: normalizeRemotePath(`${payloadFolderRemotePath}/${memberPath}`),
          memberPath,
          packRemotePath,
          packId: payload.packId || path.basename(packRemotePath, '.vspack'),
          size: Number(file.size) || 0,
          modTime: file.mtimeMs ? new Date(Number(file.mtimeMs)).toISOString() : (payload.createdAt || item.ModTime)
        });
      }
    } catch (error) {
      console.warn('Restore browse: failed to inspect pack:', packRemotePath, error.message);
    } finally {
      packStore.safeUnlink(tempPath);
    }
  }

  setCachedPackedEntries(normalizedFolderRemotePath, entries);
  return entries;
}

async function getPackedBrowseItemsForPath(remotePath) {
  const current = normalizeRemotePath(remotePath);
  if (isComputerBackupAggregatePath(current)) {
    return [];
  }

  const folderRoot = getLikelyRestoreFolderRoot(current);
  const mirrorRoot = getPackMirrorPath(current);
  let mirrorItems = [];

  try {
    mirrorItems = await listRemoteDirOrEmpty(mirrorRoot);
  } catch (error) {
    console.warn('Restore browse: failed to inspect pack mirror:', mirrorRoot, error.message);
  }

  const mirrorDirs = mirrorItems
    .filter(item => item && item.IsDir)
    .map(item => ({
      Name: item.Name,
      Path: normalizeRemotePath(current ? `${current}/${item.Name}` : item.Name),
      IsDir: true,
      Size: 0,
      ModTime: item.ModTime,
      PackedVirtual: true
    }));

  let packFolderRemotePath = current;
  let packFiles = mirrorItems.filter(isPackFile);
  let activeMirrorItems = mirrorItems;

  if (packFiles.length === 0 && current && folderRoot && current !== folderRoot) {
    const rootMirrorRoot = getPackMirrorPath(folderRoot);
    try {
      const rootMirrorItems = await listRemoteDirOrEmpty(rootMirrorRoot);
      const rootPackFiles = rootMirrorItems.filter(isPackFile);
      if (rootPackFiles.length > 0) {
        packFolderRemotePath = folderRoot;
        packFiles = rootPackFiles;
        activeMirrorItems = rootMirrorItems;
      }
    } catch (error) {
      console.warn('Restore browse: failed to inspect folder pack mirror:', rootMirrorRoot, error.message);
    }
  }

  const packedEntries = packFiles.length > 0
    ? await readPackedEntriesForFolder(packFolderRemotePath, packFiles, activeMirrorItems)
    : [];
  const packedItems = buildPackedBrowseItems(current, packedEntries);
  const existingNames = new Set(packedItems.map(item => String(item.Name || '').toLowerCase()));
  const mergedMirrorDirs = mirrorDirs.filter(item => !existingNames.has(String(item.Name || '').toLowerCase()));

  return [...mergedMirrorDirs, ...packedItems];
}

function buildPackedBrowseItems(remotePath, entries) {
  const current = normalizeRemotePath(remotePath);
  const prefix = current ? `${current}/` : '';
  const dirs = new Map();
  const files = new Map();

  for (const entry of entries) {
    const fullPath = normalizeRemotePath(entry.fullPath);
    if (current && fullPath !== current && !fullPath.startsWith(prefix)) continue;
    const rest = current ? fullPath.slice(prefix.length) : fullPath;
    if (!rest) continue;

    const slashIndex = rest.indexOf('/');
    if (slashIndex >= 0) {
      const name = rest.slice(0, slashIndex);
      if (!dirs.has(name)) {
        dirs.set(name, {
          Name: name,
          Path: normalizeRemotePath(prefix ? `${current}/${name}` : name),
          IsDir: true,
          Size: 0,
          ModTime: entry.modTime,
          PackedVirtual: true
        });
      }
      continue;
    }

    if (!files.has(rest)) {
      files.set(rest, {
        Name: rest,
        Path: fullPath,
        Size: entry.size,
        ModTime: entry.modTime,
        IsDir: false,
        Packed: true,
        RelativePath: entry.memberPath,
        PackRemotePath: entry.packRemotePath,
        PackId: entry.packId
      });
    }
  }

  return [...dirs.values(), ...files.values()];
}

async function listRestoreDirectory(remotePath) {
  const normalizedPath = restorePaths.normalizeRestoreSystemPath(remotePath, rclone.getVaultPath);
  const inflightKey = normalizedPath || '__vault_root__';
  const inFlight = restoreListInflight.get(inflightKey);
  if (inFlight) return inFlight;

  const listingPromise = (async () => {
    // Check direct listing cache first
    const cachedDirect = getCachedDirectListing(normalizedPath);

    // Run both calls in parallel for speed
    const [directResult, packedResult] = await Promise.allSettled([
      cachedDirect
        ? Promise.resolve(cachedDirect)
        : rclone.listRemoteDirStrict(
            normalizedPath,
            1,
            isComputerBackupAggregatePath(normalizedPath)
              ? { directoriesOnly: true, timeoutMs: 45000 }
              : { timeoutMs: 45000 }
          ).then(items => {
            const normalizedItems = (Array.isArray(items) ? items : []).map(item => ({
              ...item,
              Path: restorePaths.resolveListedRemotePath(normalizedPath, item && item.Path, item && item.Name)
            }));
            setCachedDirectListing(normalizedPath, normalizedItems);
            return normalizedItems;
          }),
      getPackedBrowseItemsForPath(normalizedPath)
    ]);

    const directItems = directResult.status === 'fulfilled' && Array.isArray(directResult.value)
      ? directResult.value
      : [];
    const directError = directResult.status === 'rejected' ? directResult.reason : null;
    const packedItems = packedResult.status === 'fulfilled' && Array.isArray(packedResult.value)
      ? packedResult.value
      : [];

    if (directError && packedItems.length === 0) {
      throw directError;
    }
    if (packedResult.status === 'rejected') {
      console.warn('Restore browse: failed to inspect packed files:', packedResult.reason?.message);
    }

    const existingNames = new Set(directItems.map(item => String(item.Name || '').toLowerCase()));
    const mergedPacked = packedItems.filter(item => !existingNames.has(String(item.Name || '').toLowerCase()));
    return [...directItems, ...mergedPacked].sort((a, b) => {
      if (!!a.IsDir !== !!b.IsDir) return a.IsDir ? -1 : 1;
      return String(a.Name || '').localeCompare(String(b.Name || ''), undefined, { sensitivity: 'base' });
    });
  })();

  restoreListInflight.set(inflightKey, listingPromise);
  try {
    return await listingPromise;
  } finally {
    if (restoreListInflight.get(inflightKey) === listingPromise) {
      restoreListInflight.delete(inflightKey);
    }
  }
}

async function getRestoreShortcuts(options = {}) {
  const now = Date.now();
  if (options.force !== true && backupShortcutCache && now < backupShortcutCache.expiresAt) {
    return backupShortcutCache.items;
  }
  if (backupShortcutRefresh) return backupShortcutRefresh;

  const refreshPromise = (async () => {
    let remoteEntries = [];
    try {
      remoteEntries = await rclone.listRemoteShortcutCandidates();
    } catch (error) {
      console.warn('LabSuite: Could not discover common backup shortcuts:', error.message);
    }

    const items = backupShortcuts.makeBackupShortcuts({
      folders: db.getFolders(),
      remoteEntries,
      aliases: aliases.getLocalAliases()
    });
    backupShortcutCache = {
      items,
      expiresAt: Date.now() + BACKUP_SHORTCUT_CACHE_MS
    };
    return items;
  })();

  backupShortcutRefresh = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (backupShortcutRefresh === refreshPromise) backupShortcutRefresh = null;
  }
}

function rankFileActivity(row) {
  const rank = {
    failed: 0,
    at_risk: 0,
    uploading: 1,
    versioning: 1,
    packing: 2,
    preparing: 3,
    queued: 4,
    completed: 5,
    skipped: 6
  };
  return rank[row && row.status] ?? 5;
}

function getFolderExcludePatterns(folder) {
  return filesystem.buildFolderExcludePatterns(folder);
}

function setupIpc(mainWindowArg, getMainWindow) {
  const getWin = typeof getMainWindow === 'function' ? getMainWindow : () => mainWindowArg;

  const sendToRenderer = (channel, data) => {
    const win = getWin();
    if (win && win.webContents && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  };

  let fileActivityBuffer = new Map();
  let fileActivityFlushTimer = null;

  const sortFileActivityRows = (rows) => rows.sort((a, b) => {
    const rankDiff = rankFileActivity(a) - rankFileActivity(b);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.updatedAt || b.queuedAt || 0) - new Date(a.updatedAt || a.queuedAt || 0);
  });

  const trimFileActivityBuffer = () => {
    if (fileActivityBuffer.size <= FILE_ACTIVITY_IPC_BUFFER_LIMIT) return;
    const retained = sortFileActivityRows([...fileActivityBuffer.values()])
      .slice(0, FILE_ACTIVITY_IPC_BUFFER_LIMIT);
    fileActivityBuffer = new Map(retained.map(row => [row.id, row]));
  };

  const flushFileActivityBuffer = () => {
    if (fileActivityFlushTimer) {
      clearTimeout(fileActivityFlushTimer);
    }
    fileActivityFlushTimer = null;
    if (fileActivityBuffer.size === 0) return;

    const rows = sortFileActivityRows([...fileActivityBuffer.values()]);
    fileActivityBuffer.clear();

    for (let index = 0; index < rows.length; index += FILE_ACTIVITY_IPC_BATCH_LIMIT) {
      sendToRenderer('backup:file-activity-batch', rows.slice(index, index + FILE_ACTIVITY_IPC_BATCH_LIMIT));
    }
  };

  const queueFileActivityForRenderer = (data) => {
    if (!data || !data.id) return;
    const existing = fileActivityBuffer.get(data.id) || {};
    fileActivityBuffer.set(data.id, { ...existing, ...data });
    trimFileActivityBuffer();

    if (!fileActivityFlushTimer) {
      fileActivityFlushTimer = setTimeout(flushFileActivityBuffer, FILE_ACTIVITY_IPC_FLUSH_MS);
    }
  };

  const backupsArePaused = () => db.getSetting('sync_paused') === '1';
  const getLocalBackupDeviceMetadata = () => {
    const metadata = { device_name: folderIdentity.getLocalComputerName() };
    try {
      metadata.device_fingerprint = folderIdentity.getDeviceFingerprint();
    } catch (error) {
      console.warn('LabSuite: Could not read local backup device fingerprint:', error.message);
      metadata.device_fingerprint = '';
    }
    return metadata;
  };

  // Folders API
  ipcMain.handle('folders:list', async () => {
    const localDevice = getLocalBackupDeviceMetadata();
    return db.getFolders().map(folder => ({
      ...folder,
      remote_computer_name: folderIdentity.getRemoteComputerName(folder.remote_path),
      is_local_computer_backup: folderIdentity.isFolderForDevice(folder, {
        computerName: localDevice.device_name,
        deviceFingerprint: localDevice.device_fingerprint
      })
    }));
  });

  ipcMain.handle('folders:add', async (event, { localPath }) => {
    const path = require('path');
    const absolutePath = path.resolve(localPath);
    const folders = db.getFolders();
    const activeFolders = folders.filter(folderIdentity.isFolderEnabled);

    // 1. Check if the path is already inside an existing folder
    const parentFolder = activeFolders.find(f =>
      filesystem.isPathInsideFolder(absolutePath, path.resolve(f.local_path))
    );
    if (parentFolder) {
      throw new Error(`This folder is already covered by your backup: "${parentFolder.local_path}".`);
    }

    // 2. Check if the path contains any existing folder
    const childFolder = activeFolders.find(f =>
      filesystem.isPathInsideFolder(path.resolve(f.local_path), absolutePath)
    );
    if (childFolder) {
      throw new Error(`This folder contains another configured backup: "${childFolder.local_path}". Please remove "${childFolder.local_path}" first.`);
    }

    const localDevice = getLocalBackupDeviceMetadata();
    const reusableFolder = folderIdentity.findReusableFolder(folders, absolutePath, {
      computerName: localDevice.device_name,
      deviceFingerprint: localDevice.device_fingerprint
    });
    if (reusableFolder) {
      const result = db.adoptFolder(reusableFolder.id, absolutePath, localDevice);
      if (!backupsArePaused()) {
        watcher.addPath(absolutePath);
      }
      await remoteCatalog.publish();
      return { id: result.id, remotePath: result.remote_path, reconnected: true };
    }

    const remotePath = filesystem.toRemotePath(localPath);

    // Add to DB
    const result = db.addFolder(localPath, remotePath, localDevice);
    const folderId = result.lastInsertRowid;

    // Add path to live chokidar watcher only when backups are active.
    if (!backupsArePaused()) {
      watcher.addPath(localPath);
    }

    const startedAt = new Date().toISOString();
    const startProgress = {
      folderId,
      folderPath: localPath,
      remotePath,
      folderNumber: 1,
      totalFolders: 1,
      phase: 'initial',
      stage: 'queued',
      stageLabel: 'Queued for initial backup',
      percent: 0,
      filesTotal: 0,
      filesDone: 0,
      bytesTotal: 0,
      bytesDone: 0,
      speed: 0,
      etaSec: null,
      startedAt,
      currentItem: ''
    };
    db.updateFolderSyncProgress(folderId, startProgress);
    sendToRenderer('sync:folder-progress', startProgress);

    return { id: folderId, remotePath };
  });

  ipcMain.handle('folders:addFile', async (_event, { filePath } = {}) => {
    const absoluteFilePath = path.resolve(String(filePath || ''));
    let stat;
    try {
      stat = fs.statSync(absoluteFilePath);
    } catch (_) {
      throw new Error('The selected file no longer exists.');
    }
    if (!stat.isFile()) throw new Error('Select a regular file to protect.');

    const parentPath = path.dirname(absoluteFilePath);
    const relativePath = path.basename(absoluteFilePath);
    const folders = db.getFolders();
    const activeFolders = folders.filter(folderIdentity.isFolderEnabled);
    const coveringFolder = activeFolders.find(folder => {
      if (!filesystem.isPathInsideFolder(absoluteFilePath, path.resolve(folder.local_path))) return false;
      const includes = Array.isArray(folder.include_paths) ? folder.include_paths : [];
      return includes.length === 0 || filesystem.isPathIncluded(absoluteFilePath, folder);
    });
    if (coveringFolder) {
      throw new Error(`This file is already covered by your backup: "${coveringFolder.selection_path || coveringFolder.local_path}".`);
    }

    const localDevice = getLocalBackupDeviceMetadata();
    // Give every standalone file its own remote root. This avoids catalog
    // collisions when two selected files live in the same local directory.
    const remotePath = filesystem.toRemotePath(absoluteFilePath);
    const result = db.addFolder(parentPath, remotePath, {
      ...localDevice,
      include_paths: [relativePath],
      selection_path: absoluteFilePath,
      source_type: 'file'
    });
    const folderId = result.lastInsertRowid;

    if (!backupsArePaused()) watcher.addPath(parentPath);
    await remoteCatalog.publish();
    backupWorker.runBackup([folderId], { manual: true, reason: 'single-file-added' }).catch(error => {
      console.error('Initial single-file backup failed:', error.message);
    });
    return { id: folderId, remotePath, selectionPath: absoluteFilePath };
  });

  ipcMain.handle('folders:reconnect', async (event, { folderId, localPath }) => {
    const absolutePath = path.resolve(localPath);
    const folders = db.getFolders();
    const folder = folders.find(f => String(f.id) === String(folderId));
    if (!folder) {
      throw new Error(`Folder not found: ${folderId}`);
    }

    const localDevice = getLocalBackupDeviceMetadata();
    if (!folderIdentity.isFolderForDevice(folder, {
      computerName: localDevice.device_name,
      deviceFingerprint: localDevice.device_fingerprint
    })) {
      const remoteComputer = folderIdentity.getRemoteComputerName(folder.remote_path) || 'another computer';
      const localComputer = localDevice.device_name;
      throw new Error(`This cloud backup belongs to ${remoteComputer}, not ${localComputer}. Use Restore for it instead of reconnecting it as this PC's backup.`);
    }

    const activeFolders = folders.filter(f => folderIdentity.isFolderEnabled(f) && String(f.id) !== String(folderId));
    const parentFolder = activeFolders.find(f =>
      filesystem.isPathInsideFolder(absolutePath, path.resolve(f.local_path))
    );
    if (parentFolder) {
      throw new Error(`This folder is already covered by your backup: "${parentFolder.local_path}".`);
    }

    const childFolder = activeFolders.find(f =>
      filesystem.isPathInsideFolder(path.resolve(f.local_path), absolutePath)
    );
    if (childFolder) {
      throw new Error(`This folder contains another configured backup: "${childFolder.local_path}". Please remove "${childFolder.local_path}" first.`);
    }

    const result = db.adoptFolder(folderId, absolutePath, localDevice);
    // Add path to live chokidar watcher only when backups are active.
    if (!backupsArePaused()) {
      watcher.addPath(absolutePath);
    }
    await remoteCatalog.publish();
    return result;
  });

  ipcMain.handle('folders:remove', async (event, folderId) => {
    const folders = db.getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
      watcher.removePath(folder.local_path);
    }
    const result = db.removeFolder(folderId);
    remoteCatalog.publish().catch(error => {
      console.warn('LabSuite: Failed to publish remote catalog after folder removal:', error.message);
    });
    return result;
  });

  ipcMain.handle('folders:toggle', async (event, { folderId, enabled }) => {
    db.updateFolderEnabled(folderId, enabled);
    const folders = db.getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
      if (enabled) {
        if (!backupsArePaused()) watcher.addPath(folder.local_path);
      } else {
        watcher.removePath(folder.local_path);
        backupWorker.clearDirtyFolder(folderId);
      }
    }
    return true;
  });

  ipcMain.handle('folders:exclude', async (event, { folderId, excludePath }) => {
    db.addFolderExclusion(folderId, excludePath);
    if (!backupsArePaused()) watcher.initWatcher();
    return true;
  });

  ipcMain.handle('folders:include', async (event, { folderId, excludePath }) => {
    db.removeFolderExclusion(folderId, excludePath);
    if (!backupsArePaused()) watcher.initWatcher();
    return true;
  });

  ipcMain.handle('folders:setEncryption', async (event, { folderId }) => {
    db.updateFolderEncryption(folderId, true);
    // Compatibility handler for older renderers. LabSuite is encrypted-only.
    scheduler.runFullSync(null, { manual: true, reason: 'encryption-setting-refresh' }).catch(err => {
      console.error('Encrypted backup refresh failed:', err.message);
    });
    return { encrypted: true };
  });

  // Open directory selection dialog
  ipcMain.handle('folders:selectLocal', async () => {
    const win = getWin() || null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Folder to Back Up',
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('folders:selectRestoreDest', async () => {
    const win = getWin() || null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Destination Folder for Restore',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('folders:getSystemPaths', async () => {
    const folders = db.getFolders();
    const activeFolders = folders.filter(folderIdentity.isFolderEnabled);
    const systemFolderTypes = [
      { id: 'desktop', name: 'Desktop', pathName: 'desktop', description: 'Files, folders, and shortcuts on your desktop workspace.' },
      { id: 'documents', name: 'Documents', pathName: 'documents', description: 'Your personal documents, letters, and work files.' },
      { id: 'pictures', name: 'Pictures', pathName: 'pictures', description: 'Photos, images, and saved graphics.' },
      { id: 'downloads', name: 'Downloads', pathName: 'downloads', description: 'Your default web downloads folder.' },
      { id: 'music', name: 'Music', pathName: 'music', description: 'Your local music collection.' },
      { id: 'videos', name: 'Videos', pathName: 'videos', description: 'Your videos and screen recordings.' }
    ];

    const result = [];
    for (const item of systemFolderTypes) {
      try {
        const fullPath = app.getPath(item.pathName);
        if (fullPath && fs.existsSync(fullPath)) {
          // Check if folder is already configured as a backup (either exactly or as a parent/child)
          const reconnectRemotePath = filesystem.toRemotePath(fullPath);
          const isConfigured = activeFolders.some(f => {
            const normExisting = path.resolve(f.local_path).toLowerCase();
            const normSystem = path.resolve(fullPath).toLowerCase();
            return normExisting === normSystem || normSystem.startsWith(normExisting + path.sep);
          });

          result.push({
            id: item.id,
            name: item.name,
            path: fullPath,
            description: item.description,
            reconnectRemotePath,
            isConfigured
          });
        }
      } catch (err) {
        console.warn(`Could not resolve path for ${item.pathName}:`, err.message);
      }
    }
    return result;
  });

  // Sync API
  ipcMain.handle('sync:triggerNow', async () => {
    scheduler.runFullSync(null, { manual: true, reason: 'manual' }).catch(err => {
      console.error('Manual backup failed:', err.message);
    });
    return true;
  });

  ipcMain.handle('sync:pause', async () => {
    watcher.stopWatcher();
    scheduler.stopScheduler();
    backupWorker.cancelScheduledBackup();
    db.setSetting('sync_paused', '1');
    sendToRenderer('status:change', { status: 'paused' });
    return true;
  });

  ipcMain.handle('sync:resume', async () => {
    watcher.initWatcher();
    scheduler.startScheduler();
    db.setSetting('sync_paused', '0');
    backupWorker.resumeScheduledBackup();
    sendToRenderer('status:change', { status: 'idle' });
    return true;
  });

  // Settings API
  ipcMain.handle('settings:get', async () => {
    const settings = db.getAllSettings();
    // Trust records contain authentication tokens used only by the main process.
    // Never copy them into the renderer, even though ordinary preferences live in
    // the same JSON settings collection.
    delete settings.lan_trusted_devices;
    delete settings.vm_protect_guests;
    settings.start_on_login = autostart.getAutostart() ? '1' : '0';
    return settings;
  });

  ipcMain.handle('device:getIdentity', () => ({
    computerName: folderIdentity.getLocalComputerName()
  }));

  ipcMain.handle('logs:export', async (event, { logsText }) => {
    const win = getWin() || null;
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Backup Logs',
      defaultPath: path.join(require('os').homedir(), 'labsuite_logs.txt'),
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    });

    if (result.canceled || !result.filePath) {
      return false;
    }

    const fs = require('fs');
    safeWriteFileSync(result.filePath, logsText, 'utf8');
    return true;
  });

  ipcMain.handle('diagnostics:export', async () => {
    const win = getWin() || null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await dialog.showSaveDialog(win, {
      title: 'Export LabSuite Diagnostics',
      defaultPath: path.join(os.homedir(), `labsuite-diagnostics-${stamp}.json`),
      filters: [{ name: 'JSON Files', extensions: ['json'] }]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    safeWriteFileSync(result.filePath, JSON.stringify(buildDiagnosticsReport(), null, 2), 'utf8');
    return { success: true, filePath: result.filePath };
  });

  ipcMain.handle('diagnostics:getFailureLog', () => (
    JSON.stringify(buildDiagnosticsReport(), null, 2)
  ));

  ipcMain.handle('settings:exportDecryptTool', async () => {
    const win = getWin() || null;
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Standalone Decryption Tool',
      defaultPath: path.join(require('os').homedir(), 'decrypt_vault.py'),
      filters: [{ name: 'Python Scripts', extensions: ['py'] }]
    });

    if (result.canceled || !result.filePath) {
      return false;
    }

    const fs = require('fs');
    const { decryptScriptText } = require('./decryptScript');
    safeWriteFileSync(
      result.filePath,
      decryptScriptText.replace(/remote=gdrive:LabSuite-Encrypted/g, `remote=gdrive:${rclone.getEncryptedFolder()}`),
      'utf8'
    );
    return true;
  });

  ipcMain.handle('sync:resolveConflict', async (event, { filePath, resolution }) => {
    if (global.pendingConflicts) {
      const pending = global.pendingConflicts.get(filePath);
      if (pending) {
        pending.resolve(resolution);
        global.pendingConflicts.delete(filePath);
      }
    }
    return true;
  });

  ipcMain.handle('settings:set', async (event, { key, value }) => {
    if (!RENDERER_WRITABLE_SETTINGS.has(String(key || ''))) {
      throw new Error(`Setting is not writable from the renderer: ${key}`);
    }
    if (key === 'start_on_login') {
      const enabled = value === '1';
      const applied = autostart.setAutostart(enabled);
      const actual = autostart.getAutostart();
      db.setSetting(key, actual ? '1' : '0');
      return { success: applied, enabled: actual };
    }
    db.setSetting(key, value);
    if (key === 'setup_complete') {
      if (value === '1' && !backupsArePaused()) {
        watcher.initWatcher();
        scheduler.startScheduler();
        tray.updateTrayStatus('idle', '');
      } else if (value !== '1') {
        watcher.stopWatcher();
        scheduler.stopScheduler();
        backupWorker.cancelScheduledBackup();
        tray.updateTrayStatus('idle', 'Onboarding required');
      }
    }
    if (key === 'sync_interval_minutes') {
      if (!backupsArePaused()) {
        scheduler.updateInterval(parseInt(value, 10));
      }
    }
    if (key === 'use_default_exclusions') {
      if (!backupsArePaused()) watcher.initWatcher();
    }
    if (key === 'password_hint') {
      remoteSafety.ensureVaultMetadata().catch(error => {
        console.warn('LabSuite: Failed to update vault metadata:', error.message);
      });
    }
    return true;
  });

  ipcMain.handle('aliases:sync', async (event, options = {}) => aliases.syncAliases(options));

  ipcMain.handle('aliases:save', async (event, { computerName, alias }) => {
    const updated = await aliases.saveAlias(computerName, alias);
    backupShortcutCache = null;
    rebuildActiveMountView().catch(error => {
      console.warn('LabSuite: Failed to refresh mounted alias view:', error.message);
    });
    return updated;
  });

  // Auth & Onboarding API
  ipcMain.handle('auth:startGDrive', async (event, { clientId, clientSecret } = {}) => {
    return rclone.startGoogleAuth(clientId, clientSecret);
  });

  ipcMain.handle('auth:checkConfig', async () => {
    return rclone.checkConfig();
  });

  ipcMain.handle('auth:getGDriveClientStatus', async () => {
    return rclone.getGoogleDriveClientStatus();
  });

  ipcMain.handle('auth:reconnectGDriveClient', async (_event, { clientId, clientSecret } = {}) => {
    if (backupWorker.isRunning) {
      throw new Error('Wait for the current backup to finish before reconnecting Google Drive.');
    }
    const shouldResume = !backupsArePaused();
    if (shouldResume) {
      watcher.stopWatcher();
      scheduler.stopScheduler();
      backupWorker.cancelScheduledBackup();
      db.setSetting('sync_paused', '1');
      sendToRenderer('status:change', { status: 'paused', details: 'Google Drive reconnect in progress' });
    }
    try {
      const result = await rclone.reconnectGoogleDriveClient(clientId, clientSecret);
      gDriveInfoRefresh = null;
      db.deleteCache('gdrive_info');
      return result;
    } finally {
      if (shouldResume) {
        watcher.initWatcher();
        scheduler.startScheduler();
        db.setSetting('sync_paused', '0');
        backupWorker.resumeScheduledBackup();
        sendToRenderer('status:change', { status: 'idle', details: '' });
      }
    }
  });

  ipcMain.handle('vault:metadata', async () => {
    return remoteSafety.inspectRawVault();
  });

  ipcMain.handle('auth:setCryptPassword', async (event, { password, passwordHint = '', mode = 'backup' } = {}) => {
    if (!password || typeof password !== 'string') {
      throw new Error('A master password is required.');
    }
    if (mode !== 'access' && password.length < 8) {
      throw new Error('Master password must be at least 8 characters long.');
    }
    const { configPath } = rclone.getPaths();
    const previousConfig = fs.existsSync(configPath) ? safeReadFileSync(configPath, 'utf8') : null;
    const previousPassword = await keychain.getPassword().catch(() => null);
    try {
      await rclone.createCryptRemote(password);

      if (mode === 'access') {
        await remoteSafety.validateExistingVaultAccess();
        try {
          await remoteCatalog.importRemote();
        } catch (catalogError) {
          if (!rclone.__private.isNotFoundError(catalogError)) {
            console.warn('LabSuite: Remote restore catalog import skipped:', catalogError.message);
          }
        }
        db.setSetting('setup_complete', '1');
        if (db.getSetting('password_hint')) {
          await remoteSafety.ensureVaultMetadata().catch(error => {
            console.warn('LabSuite: Failed to publish vault metadata:', error.message);
          });
        }
      } else {
        if (passwordHint !== undefined) {
          db.setSetting('password_hint', passwordHint || '');
        }
        await remoteSafety.ensureVaultMarker();
        await remoteSafety.ensureVaultMetadata().catch(error => {
          console.warn('LabSuite: Failed to publish vault metadata:', error.message);
        });
        await remoteCatalog.publish().catch(error => {
          console.warn('LabSuite: Initial remote restore catalog publish skipped:', error.message);
        });
      }
      await keychain.setPassword(password);
    } catch (error) {
      if (previousPassword) {
        await keychain.setPassword(previousPassword).catch(() => {});
      } else {
        await keychain.deletePassword().catch(() => {});
      }
      try {
        if (previousConfig === null) {
          if (fs.existsSync(configPath)) safeUnlinkSync(configPath);
        } else {
          safeWriteFileSync(configPath, previousConfig, 'utf8');
        }
      } catch (restoreError) {
        console.warn('LabSuite: Failed to restore previous rclone config after password error:', restoreError.message);
      }
      throw error;
    }
    return true;
  });

  ipcMain.handle('auth:disconnect', async () => {
    watcher.stopWatcher();
    scheduler.stopScheduler();
    await rclone.disconnect();
    await keychain.deletePassword();
    db.clearSyncLogs();
    
    // Remove folders from db
    const folders = db.getFolders();
    for (const f of folders) {
      db.removeFolder(f.id);
    }
    
    db.setSetting('setup_complete', '0');
    db.setSetting('last_full_sync', '');
    sendToRenderer('status:change', { status: 'idle' });
    return true;
  });

  ipcMain.handle('auth:getGDriveInfo', async (event, options = {}) => {
    return getCachedOrFreshGDriveInfo(options);
  });

  ipcMain.handle('vault:destinations', async () => {
    return vaultDestinations.getDestinations();
  });

  ipcMain.handle('vault:connectDestination', async (_event, options = {}) => {
    return vaultDestinations.connectDestination(options);
  });

  const runVaultTransferSafely = async (destinationId, mode) => {
    if (backupWorker.isRunning) {
      throw new Error('Wait for the current backup to finish before moving or replicating the vault.');
    }
    const shouldResume = !backupsArePaused();
    if (shouldResume) {
      watcher.stopWatcher();
      scheduler.stopScheduler();
      backupWorker.cancelScheduledBackup();
      db.setSetting('sync_paused', '1');
      sendToRenderer('status:change', { status: 'paused', details: 'Vault transfer in progress' });
    }
    try {
      const result = await vaultDestinations.transferToDestination(destinationId, mode, {
        onProgress: progress => sendToRenderer('vault:transfer-progress', { mode, ...progress })
      });
      if (mode === 'migrate') {
        await remoteSafety.ensureVaultMarker();
        await remoteSafety.ensureVaultMetadata();
        await remoteCatalog.publish();
        gDriveInfoRefresh = null;
        db.deleteCache('gdrive_info');
      }
      return result;
    } finally {
      if (shouldResume) {
        watcher.initWatcher();
        scheduler.startScheduler();
        db.setSetting('sync_paused', '0');
        backupWorker.resumeScheduledBackup();
        sendToRenderer('status:change', { status: 'idle', details: '' });
      }
    }
  };

  ipcMain.handle('vault:transferDestination', async (_event, { destinationId, mode } = {}) => {
    return runVaultTransferSafely(String(destinationId || ''), mode);
  });

  ipcMain.handle('vault:syncReplica', async (_event, { destinationId } = {}) => {
    if (backupWorker.isRunning) {
      throw new Error('Wait for the current backup to finish before syncing a replica.');
    }
    const shouldResume = !backupsArePaused();
    if (shouldResume) {
      watcher.stopWatcher();
      scheduler.stopScheduler();
      backupWorker.cancelScheduledBackup();
      db.setSetting('sync_paused', '1');
      sendToRenderer('status:change', { status: 'paused', details: 'Replica synchronization in progress' });
    }
    try {
      return await vaultDestinations.replicateDestination(String(destinationId || ''), {
        onProgress: progress => sendToRenderer('vault:transfer-progress', { mode: 'replica-sync', ...progress })
      });
    } finally {
      if (shouldResume) {
        watcher.initWatcher();
        scheduler.startScheduler();
        db.setSetting('sync_paused', '0');
        backupWorker.resumeScheduledBackup();
        sendToRenderer('status:change', { status: 'idle', details: '' });
      }
    }
  });

  // Sync log / Activity API
  ipcMain.handle('activity:get', async (event, { limit } = {}) => {
    return db.getSyncLogs(limit || 100);
  });

  ipcMain.handle('backup:restorePoints', async (event, { folderId } = {}) => {
    return db.getRestorePoints(folderId || null);
  });

  ipcMain.handle('backup:planRestorePoint', async (event, { folderId, restoreTime }) => {
    return restorePlanner.planPointInTimeRestore(folderId, restoreTime);
  });

  ipcMain.handle('restore:pointInTime', async (event, { folderId, restoreTime, localDestination }) => {
    const plan = restorePlanner.planPointInTimeRestore(folderId, restoreTime);

    (async () => {
      let filesDone = 0;
      let bytesDone = 0;
      const emitProgress = (currentItem = '') => {
        sendToRenderer('restore:progress', {
          remotePath: `restore-point:${folderId}:${restoreTime}`,
          filesTotal: plan.totalFiles,
          filesDone,
          bytesTotal: plan.totalBytes,
          bytesDone,
          currentItem
        });
      };

      try {
        emitProgress();

        const directFiles = plan.files.filter(file => file.storage !== 'pack');
        const packedFiles = plan.files.filter(file => file.storage === 'pack' && file.packRemotePath);

        for (const file of directFiles) {
          const relativePath = packStore.assertSafeRelativePath(file.relativePath);
          const outputPath = getNonOverwritingRestorePath(localDestination, relativePath);
          safeMkdirSync(path.dirname(outputPath), { recursive: true });
          emitProgress(relativePath);
          await rclone.copyFileRemoteToLocal(file.remotePath, outputPath);
          filesDone += 1;
          bytesDone += Number(file.size) || 0;
          emitProgress(relativePath);
        }

        const filesByPack = new Map();
        for (const file of packedFiles) {
          if (!filesByPack.has(file.packRemotePath)) filesByPack.set(file.packRemotePath, []);
          filesByPack.get(file.packRemotePath).push(file);
        }

        for (const [packRemotePath, files] of filesByPack.entries()) {
          const tempDir = path.join(os.tmpdir(), 'labsuite-restore-packs');
          safeMkdirSync(tempDir, { recursive: true });
          const tempPath = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.vspack`);
          try {
            emitProgress(packRemotePath);
            await rclone.copyFileRemoteToLocal(packRemotePath, tempPath);
            for (const file of files) {
              const memberPath = file.packMemberPath || file.relativePath;
          packStore.extractPackedFile(tempPath, memberPath, localDestination);
              filesDone += 1;
              bytesDone += Number(file.size) || 0;
              emitProgress(file.relativePath);
            }
          } finally {
            packStore.safeUnlink(tempPath);
          }
        }

        sendToRenderer('restore:complete', {
          remotePath: `restore-point:${folderId}:${restoreTime}`,
          restoredFiles: filesDone
        });
      } catch (err) {
        sendToRenderer('restore:error', {
          remotePath: `restore-point:${folderId}:${restoreTime}`,
          error: err.message
        });
      }
    })();

    return { started: true, plan };
  });

  ipcMain.handle('backup:manifestSummary', async () => {
    return db.getManifestSummary();
  });

  ipcMain.handle('activity:clear', async () => {
    return db.clearSyncLogs();
  });

  // Restore API
  ipcMain.handle('restore:listRemote', async (event, { remotePath }) => {
    return listRestoreDirectory(remotePath || '');
  });

  ipcMain.handle('restore:listShortcuts', async (event, options = {}) => {
    return getRestoreShortcuts(options);
  });

  ipcMain.handle('restore:deleteRemote', async (event, { remotePath }) => {
    const normalizedPath = assertDeletableVaultPath(remotePath);
    const activeFolder = db.getFolders().find(folder =>
      folderIdentity.isFolderEnabled(folder) &&
      folder.remote_path &&
      (
        isRemotePathSameOrInside(normalizedPath, folder.remote_path) ||
        isRemotePathSameOrInside(folder.remote_path, normalizedPath)
      )
    );

    if (activeFolder) {
      throw new Error(`"${activeFolder.local_path}" is still an active backup on this PC. Stop backing it up first, otherwise LabSuite would upload it again.`);
    }

    const deleteResult = await rclone.deleteRemotePath(normalizedPath);
    const cleanup = cleanupLocalRecordsForDeletedRemotePath(normalizedPath);
    directBrowseCache.clear();
    packedBrowseCache.clear();
    await remoteCatalog.publish().catch(error => {
      console.warn('LabSuite: Failed to publish remote catalog after vault deletion:', error.message);
    });
    return { success: true, remotePath: normalizedPath, ...deleteResult, cleanup };
  });

  ipcMain.handle('restore:start', async (event, { remotePath, localDestination }) => {
    rclone.restore(remotePath, localDestination, (stats) => {
      sendToRenderer('restore:progress', {
        remotePath,
        filesTotal: stats.totalTransfers || 0,
        filesDone: stats.transfers || 0,
        bytesTotal: stats.totalBytes || 0,
        bytesDone: stats.bytes || 0
      });
    }).then(() => {
      sendToRenderer('restore:complete', { remotePath });
    }).catch(err => {
      sendToRenderer('restore:error', { remotePath, error: err.message });
    });
    return true;
  });

  ipcMain.handle('restore:packedFile', async (event, { packRemotePath, relativePath, localDestination }) => {
    const tempDir = path.join(os.tmpdir(), 'labsuite-restore-packs');
    safeMkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.vspack`);

    rclone.copyFileRemoteToLocal(packRemotePath, tempPath).then(() => {
      sendToRenderer('restore:progress', {
        remotePath: packRemotePath,
        filesTotal: 1,
        filesDone: 0,
        bytesTotal: 0,
        bytesDone: 0
      });
      const outputPath = packStore.extractPackedFile(tempPath, relativePath, localDestination);
      sendToRenderer('restore:progress', {
        remotePath: packRemotePath,
        filesTotal: 1,
        filesDone: 1,
        bytesTotal: 1,
        bytesDone: 1
      });
      sendToRenderer('restore:complete', { remotePath: packRemotePath, outputPath });
    }).catch(err => {
      sendToRenderer('restore:error', { remotePath: packRemotePath, error: err.message });
    }).finally(() => {
      packStore.safeUnlink(tempPath);
    });

    return true;
  });

  // Wire up backup engine events to Electron main window webContents
  backupWorker.on('backup:start', () => {
    tray.updateTrayStatus('syncing', 'Starting backup...');
    sendToRenderer('status:change', { status: 'syncing', details: 'Starting backup...' });
  });

  backupWorker.on('backup:folder-progress', (data) => {
    sendToRenderer('sync:folder-progress', data);
    sendToRenderer('sync:progress', data);
  });

  backupWorker.on('backup:overall-progress', (data) => {
    sendToRenderer('sync:overall-progress', data);
  });

  backupWorker.on('backup:file-activity', (data) => {
    if (['failed', 'at_risk'].includes(data.status)) {
      tray.updateTrayStatus('error', data.error || 'Backup item failed');
    }
    queueFileActivityForRenderer(data);
  });

  backupWorker.on('backup:complete', (data = {}) => {
    flushFileActivityBuffer();
    const failedCount = Number(data.filesFailed) || 0;
    if (failedCount > 0) {
      tray.updateTrayStatus('error', `${failedCount} backup ${failedCount === 1 ? 'item needs' : 'items need'} attention`);
    } else {
      tray.updateTrayStatus('idle');
    }
    sendToRenderer('syncQueue:complete', data);
    sendToRenderer('status:change', failedCount > 0
      ? { status: 'error', details: `${failedCount} backup ${failedCount === 1 ? 'item needs' : 'items need'} attention` }
      : { status: 'idle', details: '' });
    sendToRenderer('sync:complete', data);
  });

  backupWorker.on('backup:error', (data = {}) => {
    const message = data.error || 'Backup failed';
    flushFileActivityBuffer();
    tray.updateTrayStatus('error', message);
    sendToRenderer('status:change', { status: 'error', details: message });
    sendToRenderer('sync:complete', data);
  });

  backupWorker.on('backup:paused', (reason) => {
    tray.updateTrayStatus('paused', reason);
    sendToRenderer('status:change', { status: 'paused', details: reason });
  });

  // Legacy SyncQueue events retained for older file-change paths.
  syncQueue.on('sync:start', (data) => {
    tray.updateTrayStatus('syncing', 'Starting backup...');
    sendToRenderer('syncQueue:start', data);
    sendToRenderer('status:change', { status: 'syncing' });
  });

  syncQueue.on('sync:item-start', (data) => {
    sendToRenderer('syncQueue:item-start', data);
  });

  syncQueue.on('sync:item-complete', (data) => {
    sendToRenderer('syncQueue:item-complete', data);
  });

  syncQueue.on('sync:item-error', (data) => {
    tray.updateTrayStatus('error', data.error || 'Backup item failed');
    sendToRenderer('syncQueue:item-error', data);
  });

  syncQueue.on('sync:folder-progress', (data) => {
    sendToRenderer('sync:folder-progress', data);
  });

  syncQueue.on('sync:complete', (data = {}) => {
    const failedCount = Number(data.filesFailed) || 0;
    if (failedCount > 0) {
      tray.updateTrayStatus('error', `${failedCount} backup ${failedCount === 1 ? 'item needs' : 'items need'} attention`);
    } else {
      tray.updateTrayStatus('idle');
    }
    sendToRenderer('syncQueue:complete', data);
    sendToRenderer('status:change', failedCount > 0
      ? { status: 'error', details: `${failedCount} backup ${failedCount === 1 ? 'item needs' : 'items need'} attention` }
      : { status: 'idle', details: '' });
    sendToRenderer('sync:complete', data);
  });

  syncQueue.on('sync:paused', (reason) => {
    tray.updateTrayStatus('paused', reason);
    sendToRenderer('status:change', { status: 'paused', details: reason });
  });

  // Filesystem browser API
  ipcMain.handle('filesystem:listDrives', async () => {
    return filesystem.listDrives();
  });

  ipcMain.handle('filesystem:listDir', async (event, { dirPath }) => {
    return filesystem.listDir(dirPath);
  });

  // Disk Analyzer API
  ipcMain.handle('disk-analyzer:getDrives', async () => {
    return filesystem.listDrives();
  });

  ipcMain.handle('disk-analyzer:startScan', async (event, { rootPath }) => {
    const diskAnalyzer = require('./diskAnalyzer');
    try {
      const result = await diskAnalyzer.startDiskScan(rootPath, (progressData) => {
        sendToRenderer('disk-analyzer:progress', progressData);
      });
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('disk-analyzer:cancelScan', async () => {
    const diskAnalyzer = require('./diskAnalyzer');
    diskAnalyzer.cancelDiskScan();
    return true;
  });

  // Health API
  ipcMain.handle('health:get', async () => {
    let version = db.getCache('rclone_version', 10 * 60 * 1000);
    if (!version) {
      version = await rclone.getVersion();
      db.setCache('rclone_version', version);
    }

    const gdriveInfo = await getCachedOrFreshGDriveInfo();

    // Get safety status from cache (or default if no cache exists)
    let cachedSafety = db.getCache('remote_safety_status');
    const freshSafety = db.getCache('remote_safety_status', 5 * 60 * 1000);
    const isSafetyCacheStale = !freshSafety;
    const remoteSafetyStatus = cachedSafety || { ok: true, marker: { status: 'checking' }, sampleWarnings: [], pending: true };

    if (isSafetyCacheStale && gdriveInfo.email !== 'Disconnected' && !remoteSafetyRefresh) {
      // Trigger background check
      remoteSafetyRefresh = (async () => {
        try {
          console.log('LabSuite: Starting background remote safety integrity check...');
          const freshStatus = await remoteSafety.getRemoteSafetyStatus({ sample: true });
          db.setCache('remote_safety_status', freshStatus);
          sendToRenderer('health:safety-update', freshStatus);
          tray.refreshTrayHealth({ sampleRemote: false });
        } catch (err) {
          console.warn('LabSuite: Background remote safety check failed:', err.message);
        } finally {
          remoteSafetyRefresh = null;
        }
      })();
    }

    return {
      rcloneVersion: version,
      gdriveStatus: gdriveInfo.email !== 'Disconnected' ? 'Connected' : 'Disconnected',
      remoteSafety: remoteSafetyStatus
    };
  });

  ipcMain.handle('health:verify', async (event, { folderId }) => {
    const folders = db.getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (!folder) throw new Error('Folder not found');

    const result = await backupVerifier.verifyFolder(folder, (logLine) => {
      sendToRenderer('health:verify-log', { folderId, logLine });
    });
    db.updateFolderVerificationStatus(folder.id, true, result);
    return result;
  });

  ipcMain.handle('health:restoreDrill', async (event, options = {}) => {
    const restoreDrill = require('./restoreDrill');
    return restoreDrill.runRestoreDrill(options);
  });

  // Search & Analytics API
  ipcMain.handle('search:files', async (event, query) => {
    const searchText = String(query || '').trim().toLowerCase();
    if (!searchText) return [];

    const directResults = await rclone.searchFiles(query);
    const folders = new Map(db.getFolders().map(folder => [String(folder.id), folder]));
    const packedResults = [];

    for (const folder of folders.values()) {
      const entries = db.getManifestEntries(folder.id);
      for (const entry of Object.values(entries)) {
        if (entry.storage !== 'pack' || !entry.pack_remote_path) continue;
        const relativePath = entry.relative_path || entry.pack_member_path || '';
        if (!relativePath.toLowerCase().includes(searchText)) continue;
        packedResults.push({
          Name: path.basename(relativePath),
          Path: relativePath,
          Size: Number(entry.size) || 0,
          ModTime: entry.last_backed_up_at || entry.updated_at || new Date().toISOString(),
          IsDir: false,
          Packed: true,
          FolderId: folder.id,
          FolderPath: folder.local_path,
          RelativePath: relativePath,
          PackRemotePath: entry.pack_remote_path,
          PackId: entry.pack_id || null
        });
      }
    }

    return [
      ...directResults.map(item => ({ ...item, Packed: false })),
      ...packedResults
    ];
  });

  ipcMain.handle('analytics:storage', async () => {
    const cached = db.getCache('storage_analytics', 30 * 60 * 1000); // 30 min cache
    if (cached) return cached;

    // Return stale cache immediately while fetching in background
    const stale = db.getCache('storage_analytics') || { count: 0, bytes: 0 };

    if (!storageAnalyticsRefresh) {
      storageAnalyticsRefresh = rclone.getStorageAnalytics()
        .then(result => {
          db.setCache('storage_analytics', result);
          sendToRenderer('analytics:storage-updated', result);
          return result;
        })
        .catch(err => {
          console.error('Background storage analytics failed:', err);
          return null;
        })
        .finally(() => {
          storageAnalyticsRefresh = null;
        });
    }

    return stale;
  });

  ipcMain.handle('analytics:summary', async () => {
    return db.getAnalyticsSummary();
  });

  // Web Server API
  ipcMain.handle('serve:start', async () => {
    return rclone.startHttpServer(8080);
  });

  ipcMain.handle('serve:stop', async () => {
    return rclone.stopHttpServer();
  });

  // --- LabSuite App Suite (LAN & Productivity) ---
  const runExecutable = (file, args) => new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.details = String(stderr || stdout || '').trim();
        reject(error);
      } else {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    });
  });

  const clearShutdownSchedule = async () => db.withWriteBatch(async () => {
    db.setSetting('power_shutdown_due_at', '');
    db.setSetting('power_shutdown_label', '');
  });

  const getShutdownSchedule = () => {
    const dueAt = db.getSetting('power_shutdown_due_at') || '';
    const dueTime = Date.parse(dueAt);
    if (!dueAt || !Number.isFinite(dueTime) || dueTime <= Date.now()) return null;
    return {
      dueAt,
      label: db.getSetting('power_shutdown_label') || '',
      remainingSeconds: Math.max(0, Math.ceil((dueTime - Date.now()) / 1000))
    };
  };

  ipcMain.handle('power:getShutdownSchedule', async () => getShutdownSchedule());

  ipcMain.handle('power:scheduleShutdown', async (_event, { seconds, label } = {}) => {
    if (process.platform !== 'win32') throw new Error('Shutdown scheduling is currently supported on Windows only.');
    const delaySeconds = Number(seconds);
    if (!Number.isInteger(delaySeconds) || delaySeconds < 60 || delaySeconds > 24 * 60 * 60) {
      throw new Error('Shutdown delay must be between 1 minute and 24 hours.');
    }
    await runExecutable('shutdown.exe', ['/s', '/t', String(delaySeconds)]);
    const dueAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    await db.withWriteBatch(async () => {
      db.setSetting('power_shutdown_due_at', dueAt);
      db.setSetting('power_shutdown_label', String(label || '').slice(0, 40));
    });
    return getShutdownSchedule();
  });

  ipcMain.handle('power:cancelShutdown', async () => {
    if (process.platform !== 'win32') throw new Error('Shutdown scheduling is currently supported on Windows only.');
    await runExecutable('shutdown.exe', ['/a']);
    await clearShutdownSchedule();
    return true;
  });

  const getSheetsRecoveryDir = () => {
    let documentsDir;
    try {
      documentsDir = app.getPath('documents');
    } catch (_) {
      documentsDir = app.getPath('userData');
    }
    return path.join(documentsDir, 'LabSuite', 'Sheet Recovery');
  };

  const safeRecoveryBaseName = (value, fallback = 'Recovered Sheet') => {
    const cleaned = String(value || '')
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 120);
    return cleaned || fallback;
  };

  ipcMain.handle('sheets:writeLocalRecovery', async (_event, { fileName, tableName, csv } = {}) => {
    const dir = getSheetsRecoveryDir();
    fs.mkdirSync(dir, { recursive: true });
    const outputName = `${safeRecoveryBaseName(tableName || fileName)}.csv`;
    const filePath = path.join(dir, outputName);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, String(csv || ''), 'utf8');
      fs.renameSync(tempPath, filePath);
    } finally {
      if (fs.existsSync(tempPath)) safeUnlinkSync(tempPath);
    }
    return { success: true, filePath, dir };
  });

  ipcMain.handle('sheets:deleteLocalRecovery', async (_event, { fileName, tableName } = {}) => {
    const dir = getSheetsRecoveryDir();
    const filePath = path.join(dir, `${safeRecoveryBaseName(tableName || fileName)}.csv`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true, filePath, dir };
  });

  ipcMain.handle('sheets:openRecoveryDir', async () => {
    const dir = getSheetsRecoveryDir();
    fs.mkdirSync(dir, { recursive: true });
    const { shell } = require('electron');
    const error = await shell.openPath(dir);
    return error ? { success: false, error, dir } : { success: true, dir };
  });

  // VM Protect keeps guest credentials and Google Drive completely separate:
  // VMware credentials are used only for the optional one-time helper copy,
  // while the guest receives a narrowly scoped upload credential after pairing.
  const vmDiscovery = require('./vmDiscovery');
  const vmProtect = require('./vmProtect');
  const windowsFirewall = require('./windowsFirewall');
  const nodeCrypto = require('crypto');
  let vmProtectFirewall = null;

  const isWindowsVm = vm => {
    const guestOS = String(vm && (vm.guestOS || vm.guestOs) || '').toLowerCase();
    return /(^|[^a-z])win(?:dows|net|vista|xp|7|8|9|10|11|12)/i.test(guestOS);
  };

  const formatVmProtectState = (rawState = vmProtect.getState()) => {
    const backupSources = db.getFolders();
    return {
      server: {
        running: !!rawState.enabled,
        enabled: !!rawState.enabled,
        port: rawState.port || rawState.defaultPort || null,
        transport: rawState.transport || 'https',
        addresses: Array.isArray(rawState.addresses) ? rawState.addresses : [],
        activeUploads: Number(rawState.activeUploads) || 0,
        agentProtocolVersion: 2,
        guestQuotaBytes: Number(rawState.guestQuotaBytes) || 0,
        firewall: vmProtectFirewall || windowsFirewall.getLastVmProtectFirewallResult()
      },
      guests: (rawState.guests || []).map(guest => {
        const source = backupSources.find(folder => String(folder.vm_guest_id || '') === String(guest.id));
        const uploadTime = Date.parse(guest.lastCommitAt || guest.lastUploadAt || '') || 0;
        const backupTime = Date.parse(source && source.last_success_at || '') || 0;
        const failed = Number(source && source.consecutive_failures) > 0;
        const backupStatus = failed
          ? 'error'
          : backupTime > 0 && backupTime >= uploadTime
            ? 'protected'
            : uploadTime > 0 ? 'pending' : 'waiting';
        return {
          ...guest,
          guestId: guest.id,
          vmName: guest.name,
          connected: guest.status === 'online',
          online: guest.status === 'online',
          selectedFileCount: Number(guest.manifestFileCount) || (Array.isArray(guest.selectedFiles) ? guest.selectedFiles.length : 0),
          protectedRootCount: Number(guest.rootCount) || (Array.isArray(guest.policy?.roots) ? guest.policy.roots.length : 0),
          backupStatus,
          lastBackupAt: source && source.last_success_at || '',
          backupError: source && source.last_error || ''
        };
      }),
      enrollments: (rawState.pendingEnrollments || []).map(enrollment => ({
        ...enrollment,
        id: enrollment.enrollmentId,
        vmName: enrollment.name
      }))
    };
  };

  const emitVmProtectState = rawState => {
    sendToRenderer('vmProtect:state', formatVmProtectState(rawState));
  };

  const ensureVmProtectServer = async () => {
    const state = await vmProtect.start();
    db.setSetting('vm_protect_enabled', '1');
    windowsFirewall.ensureVmProtectFirewallRuleAsync(state.port || state.defaultPort)
      .then(result => {
        vmProtectFirewall = result;
        emitVmProtectState();
      })
      .catch(error => {
        vmProtectFirewall = { attempted: true, ok: false, message: error.message };
        emitVmProtectState();
      });
    return state;
  };

  const vmRemoteSegment = value => String(value || 'Windows VM')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80) || 'Windows VM';

  const getVmProtectGuestRoot = (guest, state = vmProtect.getState(), explicitRoot = '') => {
    if (explicitRoot) return path.resolve(explicitRoot);
    if (Number(guest && guest.protocolVersion) >= 2) {
      return path.resolve(state.v2StagingRoot || path.join(app.getPath('userData'), 'vm-protect-staging-v2'), String(guest.id), 'current');
    }
    return path.resolve(state.stagingRoot, String(guest.id));
  };

  const markVmTreeDirty = async (rootPath, folder, maxFiles = 5000) => {
    const manifestEntries = folder
      ? new Map(db.getManifestEntries(folder.id).map(entry => [String(entry.relative_path || '').replace(/\\/g, '/').toLowerCase(), entry]))
      : new Map();
    const queue = [rootPath];
    let marked = 0;
    while (queue.length > 0 && marked < maxFiles) {
      const current = queue.shift();
      let entries = [];
      try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) queue.push(fullPath);
        else if (entry.isFile()) {
          let shouldMark = true;
          if (folder) {
            const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/').toLowerCase();
            const existing = manifestEntries.get(relativePath);
            try {
              const stat = await fs.promises.stat(fullPath);
              shouldMark = !existing
                || existing.status !== 'backed_up'
                || Number(existing.size) !== stat.size
                || Math.abs(Number(existing.mtime_ms || 0) - Math.trunc(stat.mtimeMs)) > 1000;
            } catch (_) {
              shouldMark = false;
            }
          }
          if (shouldMark) backupWorker.markDirtyForPath(fullPath, 'added');
          marked += 1;
          if (marked >= maxFiles) break;
        }
      }
    }
    return marked;
  };

  const registerVmUploadForBackup = async upload => {
    const guest = upload && upload.guest;
    if (!guest || !guest.id) throw new Error('VM Protect upload did not include a guest identity.');
    const state = vmProtect.getState();
    const guestRoot = getVmProtectGuestRoot(guest, state, upload.guestRoot || upload.stagingRoot);
    fs.mkdirSync(guestRoot, { recursive: true });
    const normalizedRoot = guestRoot.toLowerCase();
    let folder = db.getFolders().find(candidate => (
      candidate.local_path && path.resolve(candidate.local_path).toLowerCase() === normalizedRoot && folderIdentity.isFolderEnabled(candidate)
    ));

    if (!folder) {
      const localDevice = getLocalBackupDeviceMetadata();
      const computer = vmRemoteSegment(localDevice.device_name || folderIdentity.getLocalComputerName());
      const vmName = vmRemoteSegment(guest.name || guest.machineName);
      const remotePath = `computers/${computer}/Virtual Machines/${vmName}-${String(guest.id).slice(0, 8)}`;
      const result = db.addFolder(guestRoot, remotePath, {
        ...localDevice,
        source_type: 'vm',
        selection_path: `VM Protect — ${vmName}`,
        vm_guest_id: guest.id,
        vm_name: vmName,
        vmx_path: guest.vmxPath || '',
        share_on_lan: false
      });
      folder = db.getFolders().find(candidate => String(candidate.id) === String(result.lastInsertRowid));
      // V2 has an explicit committed-manifest event. Avoid a second storm of local watcher
      // notifications for the same batch; legacy uploads still use the normal watcher path.
      if (!backupsArePaused() && Number(guest.protocolVersion) < 2) watcher.addPath(guestRoot);
      remoteCatalog.publish().catch(error => {
        console.warn('VM Protect catalog publish failed:', error.message);
      });
    }

    if (folder) {
      let marked = false;
      const changedPaths = Array.isArray(upload.changedPaths)
        ? upload.changedPaths
        : [upload.stagingPath, upload.revisionPath];
      for (const changedPath of changedPaths) {
        if (changedPath && fs.existsSync(changedPath)) {
          marked = backupWorker.markDirtyForPath(changedPath, 'changed') || marked;
        }
      }
      for (const relativePath of Array.isArray(upload.deletedRelativePaths) ? upload.deletedRelativePaths : []) {
        const deletedPath = path.resolve(guestRoot, String(relativePath || '').replace(/\//g, path.sep));
        const relative = path.relative(guestRoot, deletedPath);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
          marked = backupWorker.markDirtyForPath(deletedPath, 'deleted') || marked;
        }
      }
      if (!marked) await markVmTreeDirty(guestRoot, folder);
    }
  };

  const reconcileVmProtectBackupSources = rawState => {
    const state = rawState && rawState.stagingRoot ? rawState : vmProtect.getState();
    for (const guest of state.guests || []) {
      const guestRoot = getVmProtectGuestRoot(guest, state);
      if (!fs.existsSync(guestRoot)) continue;
      const registeredSource = db.getFolders().find(candidate => (
        candidate.local_path && path.resolve(candidate.local_path).toLowerCase() === guestRoot.toLowerCase()
        && folderIdentity.isFolderEnabled(candidate)
      ));
      if (!registeredSource) {
        registerVmUploadForBackup({ guest }).catch(error => {
          console.error('VM Protect source reconciliation failed:', error.message);
        });
      } else {
        markVmTreeDirty(guestRoot, registeredSource).catch(error => {
          console.error('VM Protect staged-file reconciliation failed:', error.message);
        });
      }
    }
  };

  let vmProtectWasEnabled = false;
  const pendingVmBatchBackups = new Map();
  const queueVmBatchBackup = batch => {
    const guest = batch && batch.guest;
    if (!guest || !guest.id) return;
    const key = String(guest.id);
    const existing = pendingVmBatchBackups.get(key) || {
      guest,
      guestRoot: batch.guestRoot || batch.stagingRoot || '',
      changedPaths: new Set(),
      deletedRelativePaths: new Set(),
      timer: null
    };
    existing.guest = guest;
    existing.guestRoot = batch.guestRoot || batch.stagingRoot || existing.guestRoot;
    for (const filePath of Array.isArray(batch.changedPaths) ? batch.changedPaths : []) existing.changedPaths.add(filePath);
    for (const relativePath of Array.isArray(batch.deletedRelativePaths) ? batch.deletedRelativePaths : []) existing.deletedRelativePaths.add(relativePath);
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      pendingVmBatchBackups.delete(key);
      registerVmUploadForBackup({
        guest: existing.guest,
        guestRoot: existing.guestRoot,
        changedPaths: [...existing.changedPaths],
        deletedRelativePaths: [...existing.deletedRelativePaths]
      }).catch(error => {
        console.error('VM Protect v2 batch backup registration failed:', error.message);
      });
    }, 2500);
    pendingVmBatchBackups.set(key, existing);
  };
  vmProtect.events.on('state', state => {
    emitVmProtectState(state);
    const becameEnabled = !!(state && state.enabled) && !vmProtectWasEnabled;
    vmProtectWasEnabled = !!(state && state.enabled);
    if (becameEnabled) reconcileVmProtectBackupSources(state);
  });
  vmProtect.events.on('upload', upload => {
    registerVmUploadForBackup(upload).catch(error => {
      console.error('VM Protect could not register its backup source:', error.message);
    });
  });
  backupWorker.on('backup:complete', () => emitVmProtectState());
  backupWorker.on('backup:error', () => emitVmProtectState());

  ipcMain.handle('vmProtect:discover', async () => {
    const result = await vmDiscovery.discoverVMs();
    const capabilities = result.capabilities || {};
    const adapters = vmProtect.listCandidateAddresses
      ? vmProtect.listCandidateAddresses().filter(adapter => /vmware|vmnet/i.test(adapter.interfaceName || ''))
      : [];
    const warnings = [];
    if (result.status && ['limited', 'partial'].includes(result.status.code)) warnings.push(result.status.message);
    for (const error of result.errors || []) {
      const message = error && (error.message || error.error);
      if (message) warnings.push(message);
    }
    return {
      supported: capabilities.supported !== false,
      vmwareInstalled: !!(capabilities.vmrunAvailable || (result.vms || []).length),
      vmrunPath: capabilities.vmrunPath || '',
      directDeployAvailable: !!capabilities.canAttemptDirectHelperPush,
      adapters,
      vms: (result.vms || []).map(vm => ({
        ...vm,
        vmId: vm.id,
        directDeployAvailable: !!(capabilities.canAttemptDirectHelperPush && vm.running && isWindowsVm(vm))
      })),
      warnings: [...new Set(warnings)],
      status: result.status,
      capabilities,
      discoveredAt: result.discoveredAt
    };
  });

  ipcMain.handle('vmProtect:getState', () => formatVmProtectState());

  ipcMain.handle('vmProtect:startServer', async () => {
    const state = await ensureVmProtectServer();
    return { success: true, ...formatVmProtectState(state) };
  });

  ipcMain.handle('vmProtect:stopServer', async () => {
    const current = vmProtect.getState();
    if ((current.guests || []).length > 0 || (current.pendingEnrollments || []).length > 0) {
      return { success: false, error: 'The receiver must stay on while VMs are paired or awaiting approval.' };
    }
    const state = await vmProtect.stop();
    db.setSetting('vm_protect_enabled', '0');
    return { success: true, ...formatVmProtectState(state) };
  });

  ipcMain.handle('vmProtect:configureFirewall', async () => {
    const current = vmProtect.getState();
    if (!current.enabled) {
      throw new Error('Start the Secure Receiver before configuring its firewall rule.');
    }
    vmProtectFirewall = await windowsFirewall.configureVmProtectFirewallRuleElevated(current.port || current.defaultPort);
    emitVmProtectState(current);
    return { success: true, ...formatVmProtectState(current) };
  });

  ipcMain.handle('vmProtect:createHelper', async (_event, options = {}) => {
    const vmName = vmRemoteSegment(options.vmName || 'Windows VM');
    const saveResult = await dialog.showSaveDialog(getWin(), {
      title: `Create VM Protect helper for ${vmName}`,
      defaultPath: path.join(app.getPath('documents'), `LabSuite VM Protect - ${vmName}.ps1`),
      filters: [{ name: 'PowerShell helper', extensions: ['ps1'] }]
    });
    if (saveResult.canceled || !saveResult.filePath) return { success: true, canceled: true };
    const outputPath = saveResult.filePath.toLowerCase().endsWith('.ps1') ? saveResult.filePath : `${saveResult.filePath}.ps1`;
    await ensureVmProtectServer();
    const helper = await vmProtect.writePortableHelper({
      outputPath,
      name: vmName,
      vmId: String(options.vmId || ''),
      vmxPath: String(options.vmxPath || ''),
      vmwareUuid: String(options.vmwareUuid || ''),
      alwaysProtect: true,
      protocolVersion: 2
    });
    return {
      success: true,
      path: helper.path,
      expiresAt: helper.enrollment && helper.enrollment.expiresAt,
      method: 'portable'
    };
  });
  vmProtect.events.on('batchCommitted', batch => {
    queueVmBatchBackup(batch);
  });

  ipcMain.handle('vmProtect:createBulkHelper', async (_event, options = {}) => {
    const saveResult = await dialog.showSaveDialog(getWin(), {
      title: 'Create passwordless VM Protect bulk helper',
      defaultPath: path.join(app.getPath('documents'), 'LabSuite VM Protect - Bulk.ps1'),
      filters: [{ name: 'PowerShell helper', extensions: ['ps1'] }]
    });
    if (saveResult.canceled || !saveResult.filePath) return { success: true, canceled: true };
    const outputPath = saveResult.filePath.toLowerCase().endsWith('.ps1') ? saveResult.filePath : `${saveResult.filePath}.ps1`;
    await ensureVmProtectServer();
    const helper = await vmProtect.writePortableHelper({
      outputPath,
      name: 'Bulk VM Protect agent',
      alwaysProtect: true,
      ttlMs: 24 * 60 * 60 * 1000,
      multiUse: true,
      autoApprove: true,
      maxGuests: 10000,
      protocolVersion: 2
    });
    return {
      success: true,
      path: helper.path,
      expiresAt: helper.enrollment && helper.enrollment.expiresAt,
      selectedFiles: [],
      method: 'bulk'
    };
  });

  ipcMain.handle('vmProtect:deployHelper', async (_event, options = {}) => {
    const username = String(options.username || '').trim();
    const password = String(options.password || '');
    if (!username || username.length > 256 || !password || password.length > 1024) {
      throw new Error('Enter a valid Windows username and password for this VM.');
    }
    const discovery = await vmDiscovery.discoverVMs();
    const requestedPath = path.resolve(String(options.vmxPath || '')).toLowerCase();
    const vm = (discovery.vms || []).find(candidate => (
      String(candidate.id) === String(options.vmId || '') || path.resolve(candidate.vmxPath).toLowerCase() === requestedPath
    ));
    if (!vm || !vm.available) throw new Error('This VM is no longer available. Refresh VM Protect and try again.');
    if (!vm.running) throw new Error('Start this VM before installing the helper directly.');
    if (!isWindowsVm(vm)) throw new Error('Direct helper installation currently supports Windows guests only.');
    if (!discovery.capabilities || !discovery.capabilities.vmrunAvailable) {
      throw new Error('VMware guest operations are unavailable. Create a portable helper instead.');
    }

    await ensureVmProtectServer();
    const enrollment = await vmProtect.createEnrollment({
      name: vm.name || options.vmName || 'Windows VM',
      vmId: vm.id,
      vmxPath: vm.vmxPath,
      vmwareUuid: vm.vmwareUuid || '',
      alwaysProtect: true,
      protocolVersion: 2
    });
    const helperPath = path.join(app.getPath('temp'), `labsuite-vm-protect-${nodeCrypto.randomBytes(12).toString('hex')}.ps1`);
    try {
      await vmProtect.writePortableHelper({
        outputPath: helperPath,
        enrollment,
        name: vm.name || 'Windows VM',
        alwaysProtect: true,
        protocolVersion: 2
      });
      await vmProtect.deployHelper({
        vmxPath: vm.vmxPath,
        vmrunPath: discovery.capabilities.vmrunPath,
        vmwareType: /player/i.test(discovery.capabilities.vmrunPath || '') ? 'player' : 'ws',
        helperPath,
        enrollment,
        username,
        password
      });
      return {
        success: true,
        message: `The helper was launched in ${vm.name || 'the VM'}. Approve the matching code when it appears.`,
        expiresAt: enrollment.expiresAt
      };
    } catch (error) {
      vmProtect.cancelEnrollment(enrollment.enrollmentId);
      throw error;
    } finally {
      fs.promises.unlink(helperPath).catch(() => {});
    }
  });

  ipcMain.handle('vmProtect:approveEnrollment', (_event, { enrollmentId } = {}) => (
    vmProtect.approveEnrollment(enrollmentId)
  ));

  ipcMain.handle('vmProtect:rejectEnrollment', (_event, { enrollmentId } = {}) => (
    vmProtect.rejectEnrollment(enrollmentId)
  ));

  ipcMain.handle('vmProtect:forgetGuest', async (_event, { guestId } = {}) => {
    const result = await vmProtect.forgetGuest(guestId, { deleteStaging: false });
    if (result.success) {
      const source = db.getFolders().find(folder => String(folder.vm_guest_id || '') === String(guestId || ''));
      if (source && folderIdentity.isFolderEnabled(source)) {
        db.updateFolderEnabled(source.id, false);
        watcher.removePath(source.local_path);
        backupWorker.clearDirtyFolder(source.id);
        remoteCatalog.publish().catch(error => {
          console.warn('VM Protect catalog publish after forgetting guest failed:', error.message);
        });
      }
    }
    return result;
  });

  const lanDiscovery = require('./lanDiscovery');
  const lanFileServer = require('./lanFileServer');
  const lanRuntime = require('./lanRuntime');
  const lanTrust = require('./lanTrust');
  const lanTransferQueue = require('./lanTransferQueue');
  const webdavServer = require('./webdavServer');
  const fastCrypt = require('./fastCrypt');
  const fastDriveSync = require('./fastDriveSync');
  const cryptoMarketData = require('./cryptoMarketData');
  const notepadEngine = require('./notepadEngine');
  let lanDiscoveryHandlersAttached = false;

  const attachLanDiscoveryHandlers = () => {
    if (lanDiscoveryHandlersAttached) return;
    const emitPeers = peers => sendToRenderer('lan:peers', formatLanPeers(peers));
    lanDiscovery.on('peer-discovered', emitPeers);
    lanDiscovery.on('peer-updated', emitPeers);
    lanDiscovery.on('peer-lost', emitPeers);
    lanFileServer.onPairRequest(request => {
      sendToRenderer('lan:pair-request', request);
    });
    lanTransferQueue.on('change', jobs => {
      sendToRenderer('lan:transfer-queue', jobs);
    });
    lanDiscoveryHandlersAttached = true;
  };

  const formatLanPeer = (peer) => {
    if (!peer) return null;
    const trusted = lanTrust.getTrustedDevice(peer.deviceId || peer.id);
    return {
      id: peer.deviceId || peer.id,
      instanceId: peer.instanceId,
      deviceId: peer.deviceId || peer.id,
      hostname: peer.hostname,
      deviceName: peer.deviceName || peer.hostname || 'LabSuite PC',
      ip: peer.ip,
      webdavPort: peer.webdavPort || null,
      filePort: peer.filePort || null,
      networkDriveEnabled: !!peer.networkDriveEnabled,
      capabilities: Array.isArray(peer.capabilities) ? peer.capabilities : [],
      lastSeen: peer.lastSeen,
      paired: !!trusted,
      permissions: trusted ? trusted.permissions : null
    };
  };

  const formatLanPeers = peers => (peers || []).map(formatLanPeer).filter(Boolean);

  const hydratePeer = (peer = {}) => {
    const deviceId = peer.deviceId || peer.id;
    const discovered = lanDiscovery.getPeers().find(candidate => (
      candidate.deviceId === deviceId || candidate.id === deviceId || candidate.instanceId === peer.instanceId
    ));
    return { ...(discovered || {}), ...peer, deviceId };
  };

  const sendTransferProgress = progress => {
    sendToRenderer('lan:transfer-progress', {
      fileName: progress.fileName || '',
      bytesDone: progress.bytesDone || 0,
      bytesTotal: progress.bytesTotal || 0,
      done: !!progress.done,
      direction: progress.direction || 'transfer',
      fileIndex: progress.fileIndex || null,
      fileCount: progress.fileCount || null,
      path: progress.path || null
    });
  };

  const enqueueLanTransfer = payload => {
    const job = lanTransferQueue.enqueue(payload);
    sendToRenderer('lan:transfer-queue', lanTransferQueue.getJobs());
    return job;
  };

  // LAN Discovery API
  ipcMain.handle('lan:startDiscovery', async (event, options = {}) => {
    attachLanDiscoveryHandlers();
    lanDiscovery.start({
      ...options,
      deviceId: lanTrust.ensureLocalDeviceId(),
      deviceName: lanTrust.getDeviceName()
    });
    return true;
  });

  ipcMain.handle('lan:stopDiscovery', () => {
    lanDiscovery.stop();
    return true;
  });

  ipcMain.handle('lan:getPeers', () => {
    return formatLanPeers(lanDiscovery.getPeers());
  });

  ipcMain.handle('lan:pingPeer', async (event, { peer, timeoutMs } = {}) => {
    return lanFileServer.pingPeer(hydratePeer(peer), timeoutMs);
  });

  ipcMain.handle('lan:pingPeers', async (event, { peers, timeoutMs } = {}) => {
    const sourcePeers = Array.isArray(peers) && peers.length ? peers : formatLanPeers(lanDiscovery.getPeers());
    return Promise.all(sourcePeers.map(async (peer) => {
      const result = await lanFileServer.pingPeer(hydratePeer(peer), timeoutMs);
      return {
        peerId: peer.deviceId || peer.id || peer.instanceId || `${peer.ip}:${peer.filePort}`,
        deviceId: peer.deviceId || peer.id || null,
        ip: peer.ip || null,
        filePort: peer.filePort || null,
        ...result
      };
    }));
  });

  ipcMain.handle('lan:enableFileAccess', async (event, { enabled, port } = {}) => {
    attachLanDiscoveryHandlers();

    if (!enabled) {
      const status = lanRuntime.stopNetworkDrive();
      sendToRenderer('lan:peers', []);
      return status;
    }

    const status = await lanRuntime.startNetworkDrive({ port });
    sendToRenderer('lan:peers', formatLanPeers(lanDiscovery.getPeers()));
    return status;
  });

  ipcMain.handle('lan:configureFirewall', async () => {
    return lanRuntime.configureFirewall();
  });

  ipcMain.handle('lan:getFileAccessStatus', () => {
    return lanRuntime.getStatus();
  });

  ipcMain.handle('lan:getSettings', () => {
    return {
      ...lanTrust.getSettings(),
      trustedDevices: Object.values(lanTrust.getTrustedDevices()).map(lanFileServer.sanitizeTrustedDevice)
    };
  });

  ipcMain.handle('lan:setSettings', async (event, settings = {}) => {
    const result = lanTrust.updateSettings(settings);
    lanRuntime.refreshAdvertisement();
    return {
      ...result,
      trustedDevices: Object.values(lanTrust.getTrustedDevices()).map(lanFileServer.sanitizeTrustedDevice)
    };
  });

  ipcMain.handle('lan:requestPair', async (event, { peer } = {}) => {
    attachLanDiscoveryHandlers();
    const result = await lanFileServer.requestPair(hydratePeer(peer));
    sendToRenderer('lan:peers', formatLanPeers(lanDiscovery.getPeers()));
    return result;
  });

  ipcMain.handle('lan:respondPairRequest', async (event, { requestId, accepted } = {}) => {
    const result = lanFileServer.respondToPairRequest(requestId, !!accepted);
    sendToRenderer('lan:peers', formatLanPeers(lanDiscovery.getPeers()));
    return result;
  });

  ipcMain.handle('lan:getTrustedDevices', () => {
    return Object.values(lanTrust.getTrustedDevices()).map(lanFileServer.sanitizeTrustedDevice);
  });

  ipcMain.handle('lan:forgetTrustedDevice', async (event, { deviceId } = {}) => {
    lanTrust.forgetTrustedDevice(deviceId);
    sendToRenderer('lan:peers', formatLanPeers(lanDiscovery.getPeers()));
    return true;
  });

  ipcMain.handle('lan:listPeerDrives', async (event, { peer } = {}) => {
    return lanFileServer.listPeerDrives(hydratePeer(peer));
  });

  ipcMain.handle('lan:listPeerDir', async (event, { peer, dirPath, offset, limit, includeStats } = {}) => {
    return lanFileServer.listPeerDir(hydratePeer(peer), dirPath, { offset, limit, includeStats });
  });

  ipcMain.handle('lan:getTransferQueue', () => {
    return lanTransferQueue.getJobs();
  });

  ipcMain.handle('lan:cancelTransferJob', async (event, { jobId } = {}) => {
    return lanTransferQueue.cancel(jobId);
  });

  ipcMain.handle('lan:retryTransferJob', async (event, { jobId } = {}) => {
    return lanTransferQueue.retry(jobId);
  });

  ipcMain.handle('lan:clearFinishedTransfers', () => {
    return lanTransferQueue.clearFinished();
  });

  ipcMain.handle('lan:getDropSettings', () => ({
    ...lanFileServer.getDropSettings(),
    recentDrops: lanFileServer.getRecentDrops()
  }));

  ipcMain.handle('lan:setDropSettings', async (_event, settings = {}) => {
    if (Object.prototype.hasOwnProperty.call(settings, 'enabled')) {
      db.setSetting('lan_drop_enabled', settings.enabled ? '1' : '0');
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'folder')) {
      const requestedFolder = String(settings.folder || '').trim();
      if (!requestedFolder) throw new Error('Quick Drop inbox cannot be empty.');
      const folder = path.resolve(requestedFolder);
      if (!path.isAbsolute(folder)) throw new Error('Quick Drop inbox must be an absolute path.');
      fs.mkdirSync(folder, { recursive: true });
      if (!fs.statSync(folder).isDirectory()) throw new Error('Quick Drop inbox must be a folder.');
      db.setSetting('lan_drop_inbox_folder', folder);
    }
    lanRuntime.refreshAdvertisement();
    return {
      ...lanFileServer.getDropSettings(),
      recentDrops: lanFileServer.getRecentDrops()
    };
  });

  ipcMain.handle('lan:openDropInbox', async () => {
    const settings = lanFileServer.getDropSettings();
    fs.mkdirSync(settings.folder, { recursive: true });
    const { shell } = require('electron');
    const error = await shell.openPath(settings.folder);
    return error ? { success: false, error, folder: settings.folder } : { success: true, folder: settings.folder };
  });

  ipcMain.handle('lan:queueDropPathsToPeer', async (_event, { peer, paths, selectFolder, conflictStrategy } = {}) => {
    let selectedPaths = Array.isArray(paths) ? paths.map(value => String(value || '')).filter(Boolean) : [];
    if (selectedPaths.length === 0) {
      const result = await dialog.showOpenDialog(getWin(), {
        title: selectFolder ? 'Choose a folder to drop' : 'Choose files to drop',
        properties: selectFolder ? ['openDirectory'] : ['openFile', 'multiSelections']
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      selectedPaths = result.filePaths;
    }
    if (selectedPaths.length > 100) throw new Error('Quick Drop supports at most 100 selected items at a time.');

    const hydratedPeer = hydratePeer(peer);
    const dropStatus = await lanFileServer.checkDropStatus(hydratedPeer);
    if (!dropStatus || !dropStatus.enabled || !dropStatus.folder) {
      throw new Error('Quick Drop is disabled on the destination PC.');
    }

    const jobs = selectedPaths.map(localPath => {
      const stat = fs.statSync(localPath);
      return enqueueLanTransfer({
        kind: stat.isDirectory() ? 'upload-folder' : 'upload-file',
        direction: 'upload',
        label: path.basename(localPath),
        peer: hydratedPeer,
        localPath,
        remoteDestinationDir: dropStatus.folder,
        conflictStrategy
      });
    });
    return { success: true, count: jobs.length, jobs };
  });

  ipcMain.handle('lan:queueDropTextToPeer', async (_event, { peer, text } = {}) => {
    const value = String(text || '').trim();
    if (!value) throw new Error('Drop text cannot be empty.');
    if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw new Error('Drop text cannot exceed 1 MB.');
    const hydratedPeer = hydratePeer(peer);
    const dropStatus = await lanFileServer.checkDropStatus(hydratedPeer);
    if (!dropStatus || !dropStatus.enabled) throw new Error('Quick Drop is disabled on the destination PC.');
    const job = enqueueLanTransfer({
      kind: 'drop-text',
      direction: 'upload',
      label: `Pasted text (${value.slice(0, 15)}${value.length > 15 ? '...' : ''})`,
      peer: hydratedPeer,
      text: value
    });
    return { success: true, count: 1, job };
  });

  ipcMain.handle('lan:queueDownloadPeerItem', async (event, { peer, item, conflictStrategy } = {}) => {
    const result = await dialog.showOpenDialog(getWin(), {
      title: 'Choose where to save the item',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { success: false, canceled: true };
    }
    const hydratedPeer = hydratePeer(peer);
    const isDirectory = !!(item && item.isDir);
    const job = enqueueLanTransfer({
      kind: isDirectory ? 'download-folder' : 'download-file',
      direction: 'download',
      label: item?.name || path.basename(item?.path || 'Remote item'),
      peer: hydratedPeer,
      remotePath: item?.path,
      destination: result.filePaths[0],
      conflictStrategy
    });
    return { success: true, job };
  });

  ipcMain.handle('lan:queueUploadFilesToPeer', async (event, { peer, remoteDestinationDir, conflictStrategy } = {}) => {
    const result = await dialog.showOpenDialog(getWin(), {
      title: 'Choose files to send',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const hydratedPeer = hydratePeer(peer);
    const jobs = result.filePaths.map(localPath => enqueueLanTransfer({
      kind: 'upload-file',
      direction: 'upload',
      label: path.basename(localPath),
      peer: hydratedPeer,
      localPath,
      remoteDestinationDir,
      conflictStrategy
    }));
    return { success: true, count: jobs.length, jobs };
  });

  ipcMain.handle('lan:queueUploadFolderToPeer', async (event, { peer, remoteDestinationDir, conflictStrategy } = {}) => {
    const result = await dialog.showOpenDialog(getWin(), {
      title: 'Choose a folder to send',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { success: false, canceled: true };
    }
    const localPath = result.filePaths[0];
    const job = enqueueLanTransfer({
      kind: 'upload-folder',
      direction: 'upload',
      label: path.basename(localPath),
      peer: hydratePeer(peer),
      localPath,
      remoteDestinationDir,
      conflictStrategy
    });
    return { success: true, job };
  });

  ipcMain.handle('lan:downloadPeerFile', async (event, { peer, remotePath } = {}) => {
    const result = await dialog.showOpenDialog(getWin(), {
      title: 'Choose where to save the file',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { success: false, canceled: true };
    }
    return lanFileServer.downloadPeerFile(hydratePeer(peer), remotePath, result.filePaths[0], progress => {
      sendTransferProgress({ direction: 'download', fileName: progress.fileName || path.basename(remotePath || ''), ...progress });
    });
  });

  ipcMain.handle('lan:downloadPeerFolder', async (event, { peer, remotePath } = {}) => {
    const result = await dialog.showOpenDialog(getWin(), {
      title: 'Choose where to save the folder',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { success: false, canceled: true };
    }
    return lanFileServer.downloadPeerFolder(hydratePeer(peer), remotePath, result.filePaths[0], sendTransferProgress);
  });

  ipcMain.handle('lan:movePeerPathToLocal', async (event, { peer, remotePath, isDirectory } = {}) => {
    const result = await dialog.showOpenDialog(getWin(), {
      title: 'Choose where to copy the item',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { success: false, canceled: true };
    }
    return lanFileServer.movePeerPathToLocal(hydratePeer(peer), remotePath, !!isDirectory, result.filePaths[0], sendTransferProgress);
  });

  ipcMain.handle('lan:uploadFileToPeer', async (event, { peer, remoteDestinationDir } = {}) => {
    const result = await dialog.showOpenDialog(getWin(), {
      title: 'Choose files to send',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const results = [];
    for (let index = 0; index < result.filePaths.length; index += 1) {
      const localPath = result.filePaths[index];
      results.push(await lanFileServer.uploadFileToPeer(hydratePeer(peer), localPath, remoteDestinationDir, progress => {
        sendTransferProgress({ direction: 'upload', fileName: progress.fileName || path.basename(localPath || ''), fileIndex: index + 1, fileCount: result.filePaths.length, ...progress });
      }));
    }
    return { success: true, count: results.length, results };
  });

  ipcMain.handle('lan:uploadFolderToPeer', async (event, { peer, remoteDestinationDir } = {}) => {
    const result = await dialog.showOpenDialog(getWin(), {
      title: 'Choose a folder to send',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { success: false, canceled: true };
    }
    return lanFileServer.uploadFolderToPeer(hydratePeer(peer), result.filePaths[0], remoteDestinationDir, sendTransferProgress);
  });

  ipcMain.handle('lan:moveLocalPathToPeer', async (event, { peer, remoteDestinationDir } = {}) => {
    const result = await dialog.showOpenDialog(getWin(), {
      title: 'Choose files to send',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const results = [];
    for (const localPath of result.filePaths) {
      const stat = fs.statSync(localPath);
      results.push(await lanFileServer.moveLocalPathToPeer(hydratePeer(peer), localPath, stat.isDirectory(), remoteDestinationDir, sendTransferProgress));
    }
    return { success: true, count: results.length, results };
  });

  ipcMain.handle('lan:moveLocalFolderToPeer', async (event, { peer, remoteDestinationDir } = {}) => {
    const result = await dialog.showOpenDialog(getWin(), {
      title: 'Choose a folder to send',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { success: false, canceled: true };
    }
    const moved = await lanFileServer.moveLocalPathToPeer(hydratePeer(peer), result.filePaths[0], true, remoteDestinationDir, sendTransferProgress);
    return { success: true, count: 1, results: [moved] };
  });

  // WebDAV Share API
  ipcMain.handle('webdav:start', async (event, { folderPath, port, allowLan } = {}) => {
    return webdavServer.startWebdavServer(folderPath, { port, allowLan: !!allowLan });
  });

  ipcMain.handle('webdav:stop', () => {
    webdavServer.stopWebdavServer();
    return true;
  });

  // Fast Crypt API
  ipcMain.handle('crypt:encrypt', async (event, { text }) => {
    return fastCrypt.encrypt(text);
  });

  ipcMain.handle('crypt:decrypt', async (event, { base64Data }) => {
    return fastCrypt.decrypt(base64Data);
  });

  // Fast Drive Sync API
  ipcMain.handle('fastSync:upload', async (event, { appName, fileName, data }) => {
    return fastDriveSync.uploadData(appName, fileName, data);
  });

  ipcMain.handle('fastSync:download', async (event, { appName, fileName }) => {
    return fastDriveSync.downloadData(appName, fileName);
  });

  ipcMain.handle('fastSync:list', async (event, { appName }) => {
    return fastDriveSync.listFiles(appName);
  });

  ipcMain.handle('fastSync:delete', async (event, { appName, fileName }) => {
    return fastDriveSync.deleteFile(appName, fileName);
  });

  // Crypto market data API
  ipcMain.handle('crypto:marketData', async (event, { ids }) => {
    return cryptoMarketData.getMarketData(ids);
  });

  ipcMain.handle('crypto:history', async (event, { coinId, days }) => {
    return cryptoMarketData.getHistory(coinId, days);
  });

  ipcMain.handle('crypto:historyRange', async (event, { coinId, days }) => {
    return cryptoMarketData.getHistory(coinId, days);
  });

  ipcMain.handle('crypto:search', async (event, { query }) => {
    return cryptoMarketData.search(query);
  });

  // ── Secure Notepad API ────────────────────────────────────────────────────────
  ipcMain.handle('notepad:listLocal', async () => {
    return notepadEngine.listLocal();
  });
  
  ipcMain.handle('notepad:readFile', async (event, { filePath }) => {
    const fs = require('fs');
    return fs.readFileSync(notepadEngine.assertAllowedTextFile(filePath), 'utf8');
  });

  ipcMain.handle('notepad:save', async (event, { filePath, content }) => {
    return notepadEngine.saveWithVersioning(filePath, content);
  });

  ipcMain.handle('notepad:getVersions', async (event, { filePath }) => {
    return notepadEngine.getVersions(filePath);
  });

  ipcMain.handle('notepad:restoreVersion', async (event, { filePath, versionId }) => {
    return notepadEngine.restoreVersion(filePath, versionId);
  });

  // --- Advanced Features (1, 3, 5, 7) ---

  // Feature 1: Restore Points Version Browser
  ipcMain.handle('restore:browseSnapshot', async (event, { folderId, restoreTime }) => {
    try {
      const plan = restorePlanner.planPointInTimeRestore(folderId, restoreTime);
      return plan.files.map(file => ({
        path: String(file.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, ''),
        remotePath: file.remotePath,
        size: file.size,
        storage: file.storage,
        packRemotePath: file.packRemotePath,
        packMemberPath: file.packMemberPath || file.relativePath
      }));
    } catch (e) {
      console.error('restore:browseSnapshot failed:', e);
      throw new Error(`Could not open this checkpoint: ${e.message}`);
    }
  });

  // Feature 3: Exclusions Update
  ipcMain.handle('folders:updateExclusions', async (event, { folderId, exclusions }) => {
    const result = db.updateFolderExclusions(folderId, exclusions);
    if (!backupsArePaused()) watcher.initWatcher();
    remoteCatalog.publish().catch(error => {
      console.warn('LabSuite: Failed to publish remote catalog after exclusions update:', error.message);
    });
    return result;
  });

  // Feature 5: Emergency Recovery Sheet Generator
  ipcMain.handle('settings:exportRecoverySheet', async () => {
    let filePath;
    if (process.env.VALUTSYNC_TEST_SAVE_PATH) {
      filePath = process.env.VALUTSYNC_TEST_SAVE_PATH;
    } else {
      const result = await dialog.showSaveDialog({
        title: 'Export Recovery Sheet',
        defaultPath: 'LabSuite-Recovery-Sheet.txt',
        filters: [{ name: 'Text Files', extensions: ['txt'] }]
      });

      if (result.canceled || !result.filePath) return false;
      filePath = result.filePath;
    }

    const hint = db.getSetting('password_hint') || 'No password hint configured.';
    const folders = db.getFolders();
    const { configPath } = rclone.getPaths();
    let configContent = '';
    if (fs.existsSync(configPath)) {
      try {
        configContent = safeReadFileSync(configPath, 'utf8');
      } catch (err) {
        configContent = 'Failed to read rclone.conf: ' + err.message;
      }
    }

    let foldersText = '';
    folders.forEach(f => {
      foldersText += `- Local Folder: ${f.local_path}\n  Vault Subfolder: ${f.remote_path}\n`;
    });

    const content = `==================================================
LABSUITE EMERGENCY RECOVERY SHEET
==================================================
Generated on: ${new Date().toString()}

This document contains instructions to recover your files manually from the encrypted vault in the event of an emergency (e.g. system failure, LabSuite app is unavailable).

Keep this sheet stored in a safe physical place!

--------------------------------------------------
1. CONFIGURED FOLDERS
--------------------------------------------------
${foldersText || 'No folders configured.\n'}
--------------------------------------------------
2. MASTER PASSWORD HINT
--------------------------------------------------
Password Hint   : ${hint}

--------------------------------------------------
3. DECRYPTION INSTRUCTIONS (RCLONE)
--------------------------------------------------
To decrypt your vault manually without LabSuite:

Step 1: Download and install rclone (https://rclone.org/downloads/)
Step 2: Create a config file or add the following sections to your rclone.conf:

[gdrive]
type = drive
scope = drive

[gdrive-crypt]
type = crypt
remote = gdrive:${rclone.getEncryptedFolder()}
filename_encryption = standard
directory_name_encryption = true
password = <your master password>

Step 3: Run the following command to decrypt and download all files:
  rclone copy gdrive-crypt: /path/to/destination

--------------------------------------------------
4. RAW RCLONE CONFIGURATION (REFERENCE)
--------------------------------------------------
Below is the raw configuration currently in use on this machine.
DO NOT share this configuration with anyone as it contains keys and encrypted credentials!

${configContent}

==================================================
`;

    try {
      safeWriteFileSync(filePath, content, 'utf8');
      return true;
    } catch (err) {
      console.error('Failed to write recovery sheet:', err);
      throw err;
    }
  });

  // Feature 7: Vault Mounting as Virtual Drive
  let activeMountProcess = null;
  let activeMountDrive = null;
  let activeBackendMountPoint = null;
  let activeMountViewRoot = null;
  let mountStatus = 'unmounted'; // 'unmounted', 'mounting', 'mounted', 'error'
  let mountError = '';
  // Google Drive crypt mounts commonly need 10-15 seconds to initialize on
  // Windows. The old 8-second window killed a healthy rclone process just
  // before WinFsp created the directory mount point.
  const MOUNT_READY_TIMEOUT_MS = 45000;

  function getFreeDriveLetter() {
    if (process.platform !== 'win32') return '/mnt/labsuite';
    const letters = 'JKLMNOPQRSTUWXYZ';
    try {
      const { execSync } = require('child_process');
      const stdout = execSync('wmic logicaldisk get caption', { windowsHide: true }).toString();
      for (const char of letters) {
        if (!stdout.includes(char + ':')) {
          return char + ':';
        }
      }
    } catch (e) {}
    return 'V:';
  }

  function getMountBaseDir() {
    return path.join(app.getPath('userData'), 'mounts');
  }

  function assertInsideMountBase(targetPath) {
    const base = path.resolve(getMountBaseDir());
    const target = path.resolve(targetPath);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
      throw new Error(`Refusing to modify mount path outside LabSuite mount state: ${target}`);
    }
  }

  function resetMountDirectory(dirPath) {
    assertInsideMountBase(dirPath);
    fs.rmSync(dirPath, { recursive: true, force: true });
    safeMkdirSync(dirPath, { recursive: true });
  }

  function prepareBackendMountPoint(dirPath) {
    assertInsideMountBase(dirPath);
    fs.rmSync(dirPath, { recursive: true, force: true });
    safeMkdirSync(path.dirname(dirPath), { recursive: true });
  }

  function cleanupMountDirectory(dirPath) {
    if (!dirPath) return;
    try {
      assertInsideMountBase(dirPath);
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (error) {
      console.warn('LabSuite: Failed to clean mount directory:', error.message);
    }
  }

  function sanitizeExplorerName(name, fallback = 'Computer') {
    const cleaned = String(name || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim();
    const safe = cleaned || fallback;
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
    return reserved.test(safe) ? `${safe}_` : safe.slice(0, 180);
  }

  function uniqueExplorerName(name, usedNames) {
    const base = sanitizeExplorerName(name);
    let candidate = base;
    let counter = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      candidate = sanitizeExplorerName(`${base} (${counter})`);
      counter += 1;
    }
    usedNames.add(candidate.toLowerCase());
    return candidate;
  }

  function createDirectoryJunction(targetPath, linkPath) {
    fs.symlinkSync(path.resolve(targetPath), linkPath, 'junction');
  }

  function tryCreateFileLink(targetPath, linkPath) {
    try {
      fs.symlinkSync(path.resolve(targetPath), linkPath, 'file');
    } catch (error) {
      console.warn(`LabSuite: Skipping mounted view file link for ${targetPath}:`, error.message);
    }
  }

  function preventLocalWritesToViewDirectory(dirPath) {
    if (process.platform !== 'win32') return;
    try {
      const { execFileSync } = require('child_process');
      const principal = process.env.USERDOMAIN && process.env.USERNAME
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : os.userInfo().username;
      execFileSync('icacls', [dirPath, '/deny', `${principal}:(WD,AD)`], { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      console.warn('LabSuite: Failed to mark mounted alias view root read-only:', error.message);
    }
  }

  function getComputerMountName(computerName) {
    const computerAliases = aliases.getLocalAliases();
    const alias = computerAliases[computerName];
    return alias ? `${alias} (${computerName})` : computerName;
  }

  function buildComputersMountView(backendComputersRoot, viewComputersRoot) {
    safeMkdirSync(viewComputersRoot, { recursive: true });
    const usedNames = new Set();
    let entries = [];
    try {
      entries = fs.readdirSync(backendComputersRoot, { withFileTypes: true });
    } catch (error) {
      console.warn('LabSuite: Could not read mounted computers folder:', error.message);
      return;
    }

    for (const entry of entries) {
      const targetPath = path.join(backendComputersRoot, entry.name);
      const displayName = entry.isDirectory() ? getComputerMountName(entry.name) : entry.name;
      const linkName = uniqueExplorerName(displayName, usedNames);
      const linkPath = path.join(viewComputersRoot, linkName);

      if (entry.isDirectory()) {
        createDirectoryJunction(targetPath, linkPath);
      } else if (entry.isFile()) {
        tryCreateFileLink(targetPath, linkPath);
      }
    }
    preventLocalWritesToViewDirectory(viewComputersRoot);
  }

  function buildBackupShortcutMountView(backendRoot, shortcutViewRoot, shortcuts = []) {
    safeMkdirSync(shortcutViewRoot, { recursive: true });
    const usedNames = new Set();
    const resolvedBackendRoot = path.resolve(backendRoot);

    for (const shortcut of shortcuts) {
      const remotePath = normalizeRemotePath(shortcut && shortcut.Path);
      if (!remotePath) continue;
      const targetPath = path.resolve(backendRoot, ...remotePath.split('/').filter(Boolean));
      if (!targetPath.startsWith(`${resolvedBackendRoot}${path.sep}`)) continue;
      const linkPath = path.join(shortcutViewRoot, uniqueExplorerName(shortcut.Name || 'Backup folder', usedNames));
      try {
        createDirectoryJunction(targetPath, linkPath);
      } catch (error) {
        console.warn(`LabSuite: Could not create mounted backup shortcut for ${remotePath}:`, error.message);
      }
    }
    preventLocalWritesToViewDirectory(shortcutViewRoot);
  }

  function buildMountAliasView(backendRoot, viewRoot, shortcuts = []) {
    resetMountDirectory(viewRoot);
    const usedRootNames = new Set();
    const entries = fs.readdirSync(backendRoot, { withFileTypes: true });

    for (const entry of entries) {
      const targetPath = path.join(backendRoot, entry.name);

      if (entry.isDirectory() && entry.name === 'computers') {
        const viewComputersRoot = path.join(viewRoot, uniqueExplorerName('computers', usedRootNames));
        buildComputersMountView(targetPath, viewComputersRoot);
        continue;
      }

      const linkName = uniqueExplorerName(entry.name, usedRootNames);
      const linkPath = path.join(viewRoot, linkName);
      if (entry.isDirectory()) {
        createDirectoryJunction(targetPath, linkPath);
      } else if (entry.isFile()) {
        tryCreateFileLink(targetPath, linkPath);
      }
    }
    if (shortcuts.length > 0) {
      const shortcutRoot = path.join(viewRoot, uniqueExplorerName('Backup shortcuts', usedRootNames));
      buildBackupShortcutMountView(backendRoot, shortcutRoot, shortcuts);
    }
    preventLocalWritesToViewDirectory(viewRoot);
  }

  async function waitForMountReady(backendRoot, timeoutMs = MOUNT_READY_TIMEOUT_MS) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        fs.readdirSync(backendRoot);
        return true;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    throw lastError || new Error('Mounted vault did not become ready in time.');
  }

  function visibleDrivePath(drive) {
    return process.platform === 'win32' ? `${drive}\\` : drive;
  }

  function createVisibleDrive(drive, viewRoot) {
    if (process.platform !== 'win32') return;
    const { execFileSync } = require('child_process');
    execFileSync('subst', [drive, viewRoot], { windowsHide: true });
  }

  function removeVisibleDrive(drive) {
    if (process.platform !== 'win32' || !drive) return;
    try {
      const { execFileSync } = require('child_process');
      execFileSync('subst', [drive, '/D'], { windowsHide: true, stdio: 'ignore' });
    } catch (_) {}
  }

  async function rebuildActiveMountView() {
    if (mountStatus !== 'mounted' || !activeBackendMountPoint || !activeMountViewRoot) return false;
    await waitForMountReady(activeBackendMountPoint);
    const shortcuts = await getRestoreShortcuts().catch(() => []);
    buildMountAliasView(activeBackendMountPoint, activeMountViewRoot, shortcuts);
    return true;
  }

  function cleanupMountState() {
    removeVisibleDrive(activeMountDrive);
    cleanupMountDirectory(activeMountViewRoot);
    cleanupMountDirectory(activeBackendMountPoint);
    activeBackendMountPoint = null;
    activeMountViewRoot = null;
  }

  ipcMain.handle('vault:mount', async () => {
    if (mountStatus === 'mounted') {
      const { shell } = require('electron');
      if (activeMountDrive) shell.openPath(visibleDrivePath(activeMountDrive));
      return { success: true, drive: activeMountDrive };
    }

    mountStatus = 'mounting';
    mountError = '';

    const { spawn } = require('child_process');
    const { shell } = require('electron');
    const { rcloneBin, configPath } = rclone.getPaths();
    const drive = getFreeDriveLetter();
    const mountBaseDir = getMountBaseDir();
    const backendMountPoint = path.join(mountBaseDir, 'backend');
    const mountViewRoot = path.join(mountBaseDir, 'view');

    cleanupMountState();
    prepareBackendMountPoint(backendMountPoint);
    resetMountDirectory(mountViewRoot);

    const args = [
      'mount',
      `${rclone.getRemote()}:`,
      backendMountPoint,
      // Disk Mount is a restore browser. Keep the remote immutable even if a
      // program reaches the backend through one of the Explorer junctions.
      '--read-only',
      '--vfs-cache-mode', 'off',
      '--config', configPath
    ];

    console.log(`Spawning rclone mount: ${rcloneBin} ${args.join(' ')}`);
    
    const proc = spawn(rcloneBin, args, { windowsHide: true });
    activeMountProcess = proc;
    activeMountDrive = drive;
    activeBackendMountPoint = backendMountPoint;
    activeMountViewRoot = mountViewRoot;

    return new Promise((resolve) => {
      let resolved = false;
      let stderr = '';

      proc.on('error', (error) => {
        console.error('IPC Spawn error:', error.message);
        if (resolved) return;
        resolved = true;
        mountStatus = 'error';
        mountError = 'mount_failed';
        activeMountProcess = null;
        cleanupMountState();
        activeMountDrive = null;
        resolve({ success: false, error: 'mount_failed', details: error.message });
      });

      proc.stderr.on('data', (d) => {
        const text = d.toString();
        stderr += text;
        console.log('rclone mount stderr:', text);
        if (text.toLowerCase().includes('requires winfsp') || text.toLowerCase().includes('mount not helper found') || text.toLowerCase().includes('not found in path') || text.toLowerCase().includes('winfsp')) {
          if (!resolved) {
            resolved = true;
            mountStatus = 'error';
            mountError = 'winfsp_missing';
            activeMountProcess = null;
            activeMountDrive = null;
            cleanupMountState();
            try { proc.kill(); } catch (e) {}
            resolve({ success: false, error: 'winfsp_missing' });
          }
        }
      });

      proc.on('close', (code) => {
        console.log(`rclone mount exited with code ${code}`);
        activeMountProcess = null;
        cleanupMountState();
        activeMountDrive = null;
        mountStatus = 'unmounted';
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: 'mount_failed' });
        }
      });

      // Start probing shortly after spawn, then allow the full readiness window
      // for Google Drive authentication and WinFsp initialization.
      setTimeout(async () => {
        if (!resolved) {
          try {
            await waitForMountReady(backendMountPoint);
            const shortcuts = await getRestoreShortcuts().catch(error => {
              console.warn('LabSuite: Mounted shortcut discovery failed:', error.message);
              return [];
            });
            buildMountAliasView(backendMountPoint, mountViewRoot, shortcuts);
            createVisibleDrive(drive, mountViewRoot);
            resolved = true;
            mountStatus = 'mounted';
            shell.openPath(visibleDrivePath(drive));
            resolve({ success: true, drive });
          } catch (error) {
            resolved = true;
            mountStatus = 'error';
            mountError = 'mount_failed';
            activeMountProcess = null;
            try { proc.kill(); } catch (e) {}
            cleanupMountState();
            activeMountDrive = null;
            console.warn('LabSuite: Failed to create mounted alias view:', error.message);
            resolve({ success: false, error: 'mount_failed' });
          }
        }
      }, 1500);
    });
  });

  ipcMain.handle('vault:unmount', async () => {
    if (activeMountProcess) {
      try {
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          execSync(`taskkill /F /PID ${activeMountProcess.pid} /T`, { stdio: 'ignore' });
        } else {
          activeMountProcess.kill();
        }
      } catch (e) {}
      activeMountProcess = null;
      cleanupMountState();
      activeMountDrive = null;
      mountStatus = 'unmounted';
      return true;
    }
    return false;
  });

  ipcMain.handle('vault:getMountStatus', async () => {
    return { status: mountStatus, drive: activeMountDrive, error: mountError };
  });

  function downloadFile(url, dest, onProgress, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(url);
      } catch (error) {
        reject(error);
        return;
      }
      if (target.protocol !== 'https:') {
        reject(new Error('Installer download must use HTTPS.'));
        return;
      }
      const request = https.get(target, (response) => {
        if ([301, 302, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (!response.headers.location) {
            reject(new Error('Installer download redirect did not include a destination.'));
            return;
          }
          if (redirectCount >= 5) {
            reject(new Error('Installer download exceeded the redirect limit.'));
            return;
          }
          const redirectUrl = new URL(response.headers.location, target).toString();
          downloadFile(redirectUrl, dest, onProgress, redirectCount + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Failed to download installer: HTTP ${response.statusCode}`));
          return;
        }

        const file = fs.createWriteStream(dest, { flags: 'wx' });
        const totalSize = Number.parseInt(response.headers['content-length'], 10) || 0;
        let downloaded = 0;
        response.on('data', chunk => {
          downloaded += chunk.length;
          if (totalSize > 0 && onProgress) {
            onProgress(Math.min(100, Math.round((downloaded / totalSize) * 100)));
          }
        });
        response.on('error', error => file.destroy(error));
        file.on('error', reject);
        file.on('finish', () => file.close(resolve));
        response.pipe(file);
      });
      request.setTimeout(30000, () => request.destroy(new Error('Installer download timed out.')));
      request.on('error', reject);
    });
  }

  async function verifyWindowsSignature(filePath) {
    if (process.platform !== 'win32') return true;
    const escapedPath = String(filePath).replace(/'/g, "''");
    const result = await runExecutable('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-AuthenticodeSignature -LiteralPath '${escapedPath}').Status.ToString()`
    ]);
    if (result.stdout.trim() !== 'Valid') {
      throw new Error(`WinFsp installer signature is ${result.stdout.trim() || 'unknown'}.`);
    }
    return true;
  }

  ipcMain.handle('vault:installWinFsp', async () => {
    const win = getWin();
    const tempDir = app.getPath('temp');
    const tempPath = path.join(tempDir, 'winfsp-installer.msi');
    const msiUrl = 'https://github.com/winfsp/winfsp/releases/download/v2.0/winfsp-2.0.23075.msi';

    try {
      console.log(`Starting WinFsp download from: ${msiUrl}`);
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
      }

      await downloadFile(msiUrl, tempPath, (percent) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('winfsp:install-progress', { stage: 'downloading', percent });
        }
      });

      await verifyWindowsSignature(tempPath);

      console.log('WinFsp download completed, starting installation...');
      if (win && !win.isDestroyed()) {
        win.webContents.send('winfsp:install-progress', { stage: 'installing', percent: 100 });
      }

      await runExecutable('msiexec.exe', ['/i', tempPath, '/passive']);

      console.log('WinFsp installation completed successfully.');
      try { fs.unlinkSync(tempPath); } catch (_) {}
      return { success: true };
    } catch (error) {
      console.error('WinFsp download/install failed:', error);
      if (win && !win.isDestroyed()) {
        win.webContents.send('winfsp:install-progress', { stage: 'error', error: error.message });
      }
      try { fs.unlinkSync(tempPath); } catch (_) {}
      return { success: false, error: error.message };
    }
  });

  app.on('will-quit', () => {
    if (activeMountProcess) {
      try {
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          execSync(`taskkill /F /PID ${activeMountProcess.pid} /T`, { stdio: 'ignore' });
        } else {
          activeMountProcess.kill();
        }
      } catch (e) {}
    }
  });
}

module.exports = { setupIpc };
