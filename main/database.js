const path = require('path');
const fs = require('fs');

let userDataDir;
try {
  const { app } = require('electron');
  userDataDir = app.getPath('userData');
} catch (e) {
  // Fallback for testing outside Electron
  userDataDir = path.join(__dirname, '../data');
}

if (!fs.existsSync(userDataDir)) {
  fs.mkdirSync(userDataDir, { recursive: true });
}

const dbPath = path.join(userDataDir, 'labsuite_db.json');
const dbBackupPath = `${dbPath}.bak`;
const legacyDbPath = path.join(userDataDir, 'vaultsync_db.json');
const legacyDbBackupPath = `${legacyDbPath}.bak`;
let writeBatchDepth = 0;
let hasDeferredWrite = false;
let isLoaded = false;
const ASYNC_WRITE_THRESHOLD_BYTES = 4 * 1024 * 1024;
const ASYNC_WRITE_DEBOUNCE_MS = 250;
let preferAsyncPersistence = false;
let primaryIsKnownGood = false;
let requestedWriteRevision = 0;
let persistedWriteRevision = 0;
let asyncWriteTimer = null;
let asyncWritePromise = null;
let asyncWriteError = null;
let asyncWriteWaiters = [];
const folderProgressPersistedAt = new Map();
const FOLDER_PROGRESS_PERSIST_INTERVAL_MS = 5000;

function safeReadFileSync(filePath, options) {
  try {
    return fs.readFileSync(filePath, options);
  } catch (error) {
    console.error('Database read error:', error.message);
    return null;
  }
}

function safeParseJson(content, fallback = null) {
  try {
    return JSON.parse(content);
  } catch (error) {
    console.error('Database JSON parse error:', error.message);
    return fallback;
  }
}

function readDatabaseFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = safeReadFileSync(filePath, 'utf8');
  if (content === null) return null;
  const parsed = safeParseJson(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  // Basic integrity check
  if (parsed.folders && !Array.isArray(parsed.folders)) return null;
  if (parsed.settings && (typeof parsed.settings !== 'object' || Array.isArray(parsed.settings))) return null;
  return parsed;
}

function cleanupStaleTempFiles() {
  try {
    const prefix = `${path.basename(dbPath)}.`;
    for (const name of fs.readdirSync(path.dirname(dbPath))) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      try { fs.unlinkSync(path.join(path.dirname(dbPath), name)); } catch (_) {}
    }
  } catch (_) {}
}

function getReadableDatabaseSource() {
  const candidates = [
    { path: dbPath, label: 'primary database' },
    { path: dbBackupPath, label: 'primary backup' },
    { path: legacyDbPath, label: 'legacy VaultSync database' },
    { path: legacyDbBackupPath, label: 'legacy VaultSync backup' }
  ];

  for (const candidate of candidates) {
    const parsed = readDatabaseFile(candidate.path);
    if (parsed) return { ...candidate, data: parsed };
    if (fs.existsSync(candidate.path)) {
      console.warn(`Database candidate ignored because it is empty or invalid: ${candidate.path}`);
    }
  }

  return null;
}

const DEFAULT_SETTINGS = {
  sync_interval_minutes: '15',
  sync_on_file_change: '1',
  start_on_login: '1',
  notifications_enabled: '1',
  bwlimit: '0',              // 0 = unlimited, otherwise e.g. '5M'
  bwlimit_scheduler_enabled: '0',
  bwlimit_scheduled_value: '1M',
  bwlimit_scheduled_start: '09:00',
  bwlimit_scheduled_end: '17:00',
  schedule_start: '00:00',   // 24h format
  schedule_end: '23:59',
  sync_schedule_type: 'ALWAYS', // ALWAYS, NIGHT, CUSTOM
  wifi_only: '0',
  pause_on_metered: '0',
  battery_mode: 'OFF',
  throttle_cpu: '0',
  sync_only_when_idle: '0',
  sync_idle_threshold_minutes: '5',
  sync_active_hours_enabled: '0',
  sync_active_hours_start: '09:00',
  sync_active_hours_end: '17:00',
  use_default_exclusions: '1',
  password_hint: '',
  last_full_sync: '',
  last_full_reconcile: '',
  setup_complete: '0',
  sync_paused: '0',
  smart_throttle_enabled: '0',
  upload_speed_capacity: '10',
  smart_throttle_min_pct: '15',
  smart_throttle_max_pct: '75',
  smart_throttle_idle_mins: '15',
  backup_retention_days: '90',
  full_reconcile_interval_hours: '24',
  remote_integrity_check_interval_hours: '24',
  verify_after_backup: '1',
  backup_version_retention_days: '30',
  backup_deleted_retention_days: '90',
  backup_min_versions_per_file: '20',
  backup_transfer_profile: 'fast',
  pack_small_files_enabled: '0',
  pack_small_file_max_bytes: '1048576',
  pack_max_raw_bytes: '33554432',
  pack_max_files: '2000',
  pack_root_prune_interval_hours: '24',
  explorer_friendly_active_vault: '1',
  computer_aliases: '{}',
  device_fingerprints: '{}',
  last_pack_root_prune: '',
  crash_report_url: '',
  active_raw_remote: 'gdrive',
  active_crypt_remote: 'gdrive-crypt',
  vault_destinations: '[]',
  vault_transfer_jobs: '[]',
  installed_apps: '[]'
};

// Default database structure matching SQLite schema
let data = {
  folders: [],
  backup_manifest: {},
  restore_points: [],
  sync_log: [],
  settings: { ...DEFAULT_SETTINGS },
  cache: {},
  telegramInstalls: [],
  telegramArchiveChats: []
};

function normalizeStoredErrorMessage(errorMessage) {
  const text = String(errorMessage || '').trim();
  if (!text) return '';

  const messages = [];
  let duplicateDirWarnings = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed);
      if (entry && entry.msg === 'Duplicate directory found in destination - ignoring') {
        duplicateDirWarnings += 1;
        continue;
      }
      if (entry && entry.msg) {
        messages.push(entry.object ? `${entry.object}: ${entry.msg}` : entry.msg);
        continue;
      }
    } catch (_) {
      // Plain text errors are handled below.
    }

    messages.push(trimmed);
  }

  if (duplicateDirWarnings > 0 && messages.length === 0) {
    return `${duplicateDirWarnings} duplicate Google Drive destination folder warning${duplicateDirWarnings === 1 ? '' : 's'}. rclone ignored those duplicates; clean up duplicate folder names in Drive if this repeats.`;
  }

  const uniqueMessages = [];
  const seen = new Set();
  for (const message of messages) {
    const cleaned = String(message).replace(/\s+/g, ' ').trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    uniqueMessages.push(cleaned);
  }

  const combined = uniqueMessages.join(' ') || text.replace(/\s+/g, ' ').trim();
  return combined.length > 900 ? `${combined.slice(0, 897).trim()}...` : combined;
}

function parseAliasMap(value) {
  if (!value) return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (_) {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const aliases = {};
  for (const [computerName, alias] of Object.entries(parsed)) {
    const key = String(computerName || '').trim();
    const label = String(alias || '').trim();
    if (key && label) aliases[key] = label;
  }
  return aliases;
}

function parseStringMap(value) {
  if (!value) return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (_) {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const result = {};
  for (const [key, rawValue] of Object.entries(parsed)) {
    const cleanKey = String(key || '').trim();
    const cleanValue = String(rawValue || '').trim();
    if (cleanKey && cleanValue) result[cleanKey] = cleanValue;
  }
  return result;
}

function normalizeRemotePathForCompare(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

function isFolderEnabled(folder = {}) {
  return folder.enabled === 1 || folder.enabled === true || folder.enabled === undefined;
}

function isPathInsideFolder(filePath, folderPath) {
  if (!filePath || !folderPath) return false;
  const rel = path.relative(folderPath, filePath);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function migrateStoredPath(storedPath, oldRoot, newRoot) {
  if (!storedPath || !oldRoot || !newRoot) return storedPath;
  if (!isPathInsideFolder(storedPath, oldRoot)) return storedPath;
  const relativePath = path.relative(oldRoot, storedPath);
  return relativePath ? path.join(newRoot, relativePath) : newRoot;
}

let manifestSummaryRevision = 0;
let manifestSummaryCache = null;
let manifestSummaryCacheRevision = -1;
let manifestSummaryFolderSignature = '';

function invalidateManifestSummaryCache() {
  manifestSummaryRevision += 1;
  manifestSummaryCache = null;
}

function getManifestSummarySignature() {
  return (data.folders || [])
    .map(folder => `${folder.id}:${folder.local_path || ''}:${folder.remote_path || ''}`)
    .join('|');
}

function computeManifestSummary() {
  return (data.folders || []).map(folder => {
    const entries = Object.values(data.backup_manifest[String(folder.id)] || {});
    return {
      folderId: folder.id,
      folderPath: folder.local_path,
      protectedFiles: entries.filter(entry => entry.status === 'backed_up').length,
      pendingFiles: entries.filter(entry => ['dirty', 'deleted_pending_history', 'failed', 'active_repair_needed'].includes(entry.status)).length,
      deletedFiles: entries.filter(entry => entry.status === 'deleted').length,
      failedFiles: entries.filter(entry => entry.status === 'failed').length,
      atRiskFiles: entries.filter(entry => entry.status === 'active_repair_needed').length,
      versionCount: entries.reduce((sum, entry) => sum + (Array.isArray(entry.versions) ? entry.versions.length : 0), 0)
    };
  });
}

function getCachedManifestSummary() {
  loadDatabase();
  const folderSignature = getManifestSummarySignature();
  if (
    manifestSummaryCache &&
    manifestSummaryCacheRevision === manifestSummaryRevision &&
    manifestSummaryFolderSignature === folderSignature
  ) {
    return manifestSummaryCache.map(item => ({ ...item }));
  }

  manifestSummaryCache = computeManifestSummary();
  manifestSummaryCacheRevision = manifestSummaryRevision;
  manifestSummaryFolderSignature = folderSignature;
  return manifestSummaryCache.map(item => ({ ...item }));
}

/**
 * Reads database state from disk
 */
function loadDatabase() {
  if (isLoaded) return;
  if (writeBatchDepth > 0) return;

  cleanupStaleTempFiles();

  const databaseSource = getReadableDatabaseSource();
  if (databaseSource) {
    try {
      data = databaseSource.data;
      primaryIsKnownGood = databaseSource.path === dbPath;
      try {
        preferAsyncPersistence = fs.statSync(databaseSource.path).size >= ASYNC_WRITE_THRESHOLD_BYTES;
      } catch (_) {}
      // Ensure required top-level properties exist
      if (!data.folders) data.folders = [];
      if (!data.backup_manifest) data.backup_manifest = {};
      if (!data.restore_points) data.restore_points = [];
      if (!data.sync_log) data.sync_log = [];
      if (!data.settings) data.settings = {};
      if (!data.cache) data.cache = {};
      if (!data.telegramInstalls) data.telegramInstalls = [];
      if (!data.telegramArchiveChats) data.telegramArchiveChats = [];

      // ── Migrations ──────────────────────────────────────────────────────
      let migrated = databaseSource.path !== dbPath;
      if (migrated) {
        console.warn(`Database loaded from ${databaseSource.label}; saving migrated copy to ${dbPath}`);
      }

      // A pre-release Telegram archive scanner could mistake the main-menu
      // "Set Emoji Status" label for an account name. It never represented a
      // real account and is safe to discard only while it has no archive data.
      const validTelegramArchiveChats = data.telegramArchiveChats.filter(chat => !(
        chat &&
        chat.account_name === 'Set Emoji Status' &&
        !chat.last_backup_at &&
        !(Number(chat.message_count) > 0)
      ));
      if (validTelegramArchiveChats.length !== data.telegramArchiveChats.length) {
        data.telegramArchiveChats = validTelegramArchiveChats;
        migrated = true;
      }

      // v1.1: Add encrypted field to existing folders (default: encrypted)
      // v1.3: Plain remotes were removed; all folders are encrypted.
      data.folders.forEach(folder => {
        if (folder.encrypted !== 1) {
          folder.encrypted = 1;
          migrated = true;
        }
        if (folder.last_error) {
          const normalizedError = normalizeStoredErrorMessage(folder.last_error);
          if (normalizedError !== folder.last_error) {
            folder.last_error = normalizedError;
            migrated = true;
          }
        }
        if (folder.sync_state === 'syncing') {
          folder.sync_state = folder.last_success_at ? 'idle' : 'pending';
          folder.sync_phase = folder.last_success_at ? 'complete' : 'interrupted';
          folder.sync_current_item = '';
          folder.sync_speed = 0;
          folder.sync_eta = null;
          migrated = true;
        }
        if (folder.last_success_at && !folder.last_remote_integrity_scan) {
          folder.last_remote_integrity_scan = new Date().toISOString();
          migrated = true;
        }
      });

      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (data.settings[key] === undefined) {
          data.settings[key] = value;
          migrated = true;
        }
      }

      // v1.2: Add bandwidth scheduler keys
      if (data.settings.bwlimit_scheduler_enabled === undefined) {
        data.settings.bwlimit_scheduler_enabled = '0';
        data.settings.bwlimit_scheduled_value = '1M';
        data.settings.bwlimit_scheduled_start = '09:00';
        data.settings.bwlimit_scheduled_end = '17:00';
        migrated = true;
      }

      if (!data.settings.last_full_reconcile && data.settings.last_full_sync) {
        data.settings.last_full_reconcile = data.settings.last_full_sync;
        migrated = true;
      }

      // v2.3: App Hub migration — auto-install apps that were previously visible
      if (data.settings.installed_apps === undefined || data.settings.installed_apps === '[]') {
        const allHubApps = ['notebook', 'sheets', 'lan', 'vm-protect', 'todo'];
        let hiddenFeatures = [];
        try {
          hiddenFeatures = JSON.parse(String(data.settings.sidebar_hidden_features || '[]'));
          if (!Array.isArray(hiddenFeatures)) hiddenFeatures = [];
        } catch (_) {}
        // Install all apps that were NOT hidden (i.e. were visible before the update)
        const installedApps = allHubApps.filter(id => !hiddenFeatures.includes(id));
        data.settings.installed_apps = JSON.stringify(installedApps);
        migrated = true;
      }

      if (data.settings.battery_mode === 'never') {
        data.settings.battery_mode = DEFAULT_SETTINGS.battery_mode;
        migrated = true;
      }

      if (data.settings.pack_small_file_max_bytes === '65536') {
        data.settings.pack_small_file_max_bytes = DEFAULT_SETTINGS.pack_small_file_max_bytes;
        migrated = true;
      }
      if (data.settings.pack_max_raw_bytes === '16777216') {
        data.settings.pack_max_raw_bytes = DEFAULT_SETTINGS.pack_max_raw_bytes;
        migrated = true;
      }
      if (data.settings.pack_max_files === '1000') {
        data.settings.pack_max_files = DEFAULT_SETTINGS.pack_max_files;
        migrated = true;
      }

      if (data.settings.explorer_friendly_active_vault !== '1') {
        data.settings.explorer_friendly_active_vault = '1';
        migrated = true;
      }

      if (data.settings.pack_small_files_enabled !== '0') {
        data.settings.pack_small_files_enabled = '0';
        migrated = true;
      }

      // Cap sync_log at 500 entries (newest last)
      if (data.sync_log.length > 500) {
        data.sync_log = data.sync_log.slice(-500);
        migrated = true;
      }

      if (data.restore_points.length > 500) {
        data.restore_points = data.restore_points.slice(-500);
        migrated = true;
      }

      if (migrated) saveDatabase();
      isLoaded = true;
    } catch (error) {
      console.error('Database load error, trying backup copy:', error);
      try {
        if (!fs.existsSync(dbBackupPath)) throw error;
        const backupContent = safeReadFileSync(dbBackupPath, 'utf8') || "{}";
        data = safeParseJson(backupContent);
        if (!data || typeof data !== 'object') {
          throw new Error('Backup database is not a valid JSON object');
        }
        if (!data.folders) data.folders = [];
        if (!data.backup_manifest) data.backup_manifest = {};
        if (!data.restore_points) data.restore_points = [];
        if (!data.sync_log) data.sync_log = [];
        if (!data.settings) data.settings = {};
        if (!data.cache) data.cache = {};
        if (!data.telegramInstalls) data.telegramInstalls = [];
        if (!data.telegramArchiveChats) data.telegramArchiveChats = [];

        console.warn('Database recovered from backup copy.');
        primaryIsKnownGood = false;
        try {
          preferAsyncPersistence = fs.statSync(dbBackupPath).size >= ASYNC_WRITE_THRESHOLD_BYTES;
        } catch (_) {}
        saveDatabase();
        isLoaded = true;
      } catch (backupError) {
        console.error('Database backup recovery failed, resetting to defaults:', backupError);
        data = {
          folders: [],
          backup_manifest: {},
          restore_points: [],
          sync_log: [],
          settings: { ...DEFAULT_SETTINGS },
          cache: {},
          telegramInstalls: [],
          telegramArchiveChats: []
        };
        saveDatabase();
        isLoaded = true;
      }
    }
  } else {
    saveDatabase();
    isLoaded = true;
  }
}

/**
 * Writes database state to disk
 */
function saveDatabaseSync() {
  if (writeBatchDepth > 0) {
    hasDeferredWrite = true;
    return;
  }

  let tempPath = null;
  try {
    // Never replace a known-good recovery copy with an unreadable primary.
    // This matters when loadDatabase() recovered from dbBackupPath and is now
    // repairing a corrupt dbPath.
    if (fs.existsSync(dbPath) && readDatabaseFile(dbPath)) {
      try {
        fs.copyFileSync(dbPath, dbBackupPath);
      } catch (backupError) {
        console.warn('Database backup copy failed:', backupError.message);
      }
    }

    tempPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
    const serialized = JSON.stringify(data, null, 2);
    fs.writeFileSync(tempPath, serialized, 'utf8');
    let fd = null;
    try {
      fd = fs.openSync(tempPath, 'r+');
      fs.fdatasyncSync(fd);
    } catch (fsyncError) {
      console.warn('Database fsync failed:', fsyncError.message);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_) {}
      }
    }

    let replaced = false;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.renameSync(tempPath, dbPath);
        replaced = true;
        break;
      } catch (error) {
        lastError = error;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        try {
          const buffer = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(buffer, 0, 0, 75);
        } catch (_) {
          const waitUntil = Date.now() + 75;
          while (Date.now() < waitUntil) {}
        }
      }
    }

    if (!replaced) {
      throw lastError || new Error('Database rename did not complete.');
    }
    primaryIsKnownGood = true;
    if (Buffer.byteLength(serialized) >= ASYNC_WRITE_THRESHOLD_BYTES) {
      preferAsyncPersistence = true;
    }
  } catch (error) {
    console.error('Database save error:', error);
    // A backup application must not report success for memory-only changes.
    // Let callers surface disk-full, permission, and rename failures.
    throw error;
  } finally {
    if (tempPath) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (_) {}
    }
  }
}

function shouldPersistAsynchronously() {
  if (preferAsyncPersistence) return true;
  try {
    if (fs.existsSync(dbPath) && fs.statSync(dbPath).size >= ASYNC_WRITE_THRESHOLD_BYTES) {
      preferAsyncPersistence = true;
      return true;
    }
  } catch (_) {}
  return false;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function renameWithRetry(source, destination) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.promises.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await delay(75);
    }
  }
  throw lastError || new Error('Database rename did not complete.');
}

async function persistDatabaseRevision(revision) {
  const tempPath = `${dbPath}.${process.pid}.${Date.now()}.${revision}.tmp`;
  let handle = null;
  try {
    // JSON serialization is the only CPU work left on the main thread. Compact
    // JSON cuts the large manifest snapshot by several MB; copying, flushing,
    // and renaming are all asynchronous so Electron keeps pumping messages.
    const serialized = JSON.stringify(data);
    if (primaryIsKnownGood && fs.existsSync(dbPath)) {
      try {
        await fs.promises.copyFile(dbPath, dbBackupPath);
      } catch (backupError) {
        console.warn('Database backup copy failed:', backupError.message);
      }
    }

    await fs.promises.writeFile(tempPath, serialized, 'utf8');
    try {
      handle = await fs.promises.open(tempPath, 'r+');
      await handle.datasync();
    } catch (fsyncError) {
      console.warn('Database fsync failed:', fsyncError.message);
    } finally {
      if (handle) {
        try { await handle.close(); } catch (_) {}
        handle = null;
      }
    }

    await renameWithRetry(tempPath, dbPath);
    primaryIsKnownGood = true;
    persistedWriteRevision = revision;
  } finally {
    if (handle) {
      try { await handle.close(); } catch (_) {}
    }
    try { await fs.promises.unlink(tempPath); } catch (_) {}
  }
}

function settleAsyncWriteWaiters(error = null) {
  const waiters = asyncWriteWaiters;
  asyncWriteWaiters = [];
  for (const waiter of waiters) {
    if (error) waiter.reject(error);
    else waiter.resolve(true);
  }
}

function startAsyncWriter() {
  if (asyncWritePromise) return asyncWritePromise;
  if (asyncWriteTimer) {
    clearTimeout(asyncWriteTimer);
    asyncWriteTimer = null;
  }

  asyncWritePromise = (async () => {
    do {
      const revision = requestedWriteRevision;
      await persistDatabaseRevision(revision);
      // Mutations that happened while the file operation was awaiting are
      // captured by one more pass, instead of launching concurrent writers.
    } while (persistedWriteRevision < requestedWriteRevision);
  })()
    .then(() => {
      asyncWriteError = null;
      settleAsyncWriteWaiters();
      return true;
    })
    .catch(error => {
      asyncWriteError = error;
      console.error('Asynchronous database save error:', error);
      settleAsyncWriteWaiters(error);
      return false;
    })
    .finally(() => {
      asyncWritePromise = null;
      if (!asyncWriteError && persistedWriteRevision < requestedWriteRevision) {
        startAsyncWriter();
      }
    });
  return asyncWritePromise;
}

function scheduleAsyncDatabaseSave() {
  requestedWriteRevision += 1;
  if (asyncWriteTimer || asyncWritePromise) return;
  asyncWriteTimer = setTimeout(() => {
    asyncWriteTimer = null;
    startAsyncWriter();
  }, ASYNC_WRITE_DEBOUNCE_MS);
}

function saveDatabase() {
  if (writeBatchDepth > 0) {
    hasDeferredWrite = true;
    return;
  }
  if (asyncWriteError) {
    const error = asyncWriteError;
    asyncWriteError = null;
    throw error;
  }
  if (shouldPersistAsynchronously()) {
    scheduleAsyncDatabaseSave();
    return;
  }
  saveDatabaseSync();
}

async function withWriteBatch(fn) {
  writeBatchDepth += 1;
  let snapshot = null;
  if (writeBatchDepth === 1 && !shouldPersistAsynchronously()) {
    snapshot = JSON.parse(JSON.stringify(data));
  }
  try {
    return await fn();
  } catch (error) {
    if (writeBatchDepth === 1 && snapshot !== null) {
      data = snapshot;
      hasDeferredWrite = false;
    }
    throw error;
  } finally {
    writeBatchDepth -= 1;
    if (writeBatchDepth === 0 && hasDeferredWrite) {
      hasDeferredWrite = false;
      saveDatabase();
    }
  }
}

function flushWrites() {
  if (hasDeferredWrite && writeBatchDepth === 0) {
    hasDeferredWrite = false;
    saveDatabase();
  }
}

async function flushWritesAsync() {
  flushWrites();
  if (!shouldPersistAsynchronously()) return true;
  if (persistedWriteRevision >= requestedWriteRevision && !asyncWriteTimer && !asyncWritePromise) {
    if (asyncWriteError) throw asyncWriteError;
    return true;
  }
  return new Promise((resolve, reject) => {
    asyncWriteWaiters.push({ resolve, reject });
    startAsyncWriter();
  });
}

// Initial load
loadDatabase();

module.exports = {
  initDatabase: (customDbPath) => {
    loadDatabase();
    console.log(`JSON Database initialized at ${dbPath}`);
  },
  
  getDb: () => data,

  // Folders operations
  getFolders: () => {
    loadDatabase();
    return data.folders;
  },

  getEnabledFolders: () => {
    loadDatabase();
    return data.folders.filter(f => f.enabled === 1 || f.enabled === true || f.enabled === undefined);
  },

  addFolder: (localPath, remotePath, metadata = {}) => {
    loadDatabase();
    const requestedIncludes = Array.isArray(metadata.include_paths)
      ? metadata.include_paths.map(value => String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean)
      : [];
    // Prevent duplicate active folders. Inactive imported folders from other PCs
    // are restore records and should not block this PC from backing up its own path.
    if (data.folders.some(f => {
      if (f.local_path !== localPath || !(f.enabled === 1 || f.enabled === true || f.enabled === undefined)) return false;
      const existingIncludes = Array.isArray(f.include_paths) ? f.include_paths : [];
      if (existingIncludes.length === 0 || requestedIncludes.length === 0) return true;
      return existingIncludes.some(value => requestedIncludes.includes(value));
    })) {
      throw new Error(`Folder already registered: ${localPath}`);
    }
    const newFolder = {
      id: Date.now(), // timestamp ID
      local_path: localPath,
      remote_path: remotePath,
      enabled: 1,
      encrypted: 1, // 1 = encrypted (default), 0 = plain upload
      device_fingerprint: String(metadata.device_fingerprint || '').trim(),
      device_name: String(metadata.device_name || '').trim(),
      include_paths: requestedIncludes,
      selection_path: String(metadata.selection_path || '').trim(),
      source_type: ['file', 'vm'].includes(metadata.source_type) ? metadata.source_type : 'folder',
      vm_guest_id: String(metadata.vm_guest_id || '').trim(),
      vm_name: String(metadata.vm_name || '').trim(),
      vmx_path: String(metadata.vmx_path || '').trim(),
      share_on_lan: metadata.share_on_lan !== false,
      added_at: new Date().toISOString()
    };
    data.folders.push(newFolder);
    invalidateManifestSummaryCache();
    saveDatabase();
    return { lastInsertRowid: newFolder.id };
  },

  adoptFolder: (id, localPath, metadata = {}) => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === id);
    if (!folder) {
      throw new Error(`Folder not found: ${id}`);
    }

    const previousLocalPath = folder.local_path || '';
    const now = new Date().toISOString();

    folder.local_path = localPath;
    folder.enabled = 1;
    folder.encrypted = 1;
    if (metadata.device_fingerprint) folder.device_fingerprint = String(metadata.device_fingerprint).trim();
    if (metadata.device_name) folder.device_name = String(metadata.device_name).trim();
    folder.reconnected_at = now;
    folder.reconnected_from_remote_catalog = !!folder.imported_from_remote_catalog;
    folder.imported_from_remote_catalog = false;

    if (Array.isArray(folder.exclusions) && previousLocalPath) {
      folder.exclusions = folder.exclusions.map(exclusion =>
        migrateStoredPath(exclusion, previousLocalPath, localPath)
      );
    }

    const previousPaths = Array.isArray(folder.previous_local_paths)
      ? folder.previous_local_paths.slice()
      : [];
    if (previousLocalPath && previousLocalPath !== localPath && !previousPaths.includes(previousLocalPath)) {
      previousPaths.push(previousLocalPath);
    }
    if (previousPaths.length > 0) {
      folder.previous_local_paths = previousPaths.slice(-10);
    }

    const entries = data.backup_manifest[String(id)] || {};
    for (const entry of Object.values(entries)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.local_path) {
        entry.local_path = migrateStoredPath(entry.local_path, previousLocalPath, localPath);
      } else if (entry.relative_path) {
        entry.local_path = path.join(localPath, entry.relative_path);
      }
      entry.updated_at = now;
    }

    for (const point of data.restore_points || []) {
      if (String(point.folder_id) === String(id)) {
        point.folder_path = localPath;
      }
    }

    const aliasMap = parseAliasMap(data.settings.computer_aliases || '{}');
    if (previousLocalPath && aliasMap[previousLocalPath] && !aliasMap[localPath]) {
      aliasMap[localPath] = aliasMap[previousLocalPath];
      delete aliasMap[previousLocalPath];
      data.settings.computer_aliases = JSON.stringify(aliasMap);
    }

    invalidateManifestSummaryCache();
    saveDatabase();
    return { ...folder, previous_local_path: previousLocalPath };
  },

  removeFolder: (id) => {
    loadDatabase();
    data.folders = data.folders.filter(f => f.id !== id);
    delete data.backup_manifest[String(id)];
    invalidateManifestSummaryCache();
    saveDatabase();
    return true;
  },

  updateFolderRemotePath: (id, remotePath) => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === id);
    if (folder) {
      folder.remote_path = remotePath;
      invalidateManifestSummaryCache();
      saveDatabase();
    }
    return true;
  },

  updateFolderEnabled: (id, enabled) => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === id);
    if (folder) {
      folder.enabled = enabled ? 1 : 0;
      saveDatabase();
    }
    return true;
  },

  updateFolderEncryption: (id, encrypted) => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === id);
    if (folder) {
      folder.encrypted = 1;
      saveDatabase();
    }
    return true;
  },

  addFolderExclusion: (folderId, excludePath) => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === folderId);
    if (folder) {
      if (!folder.exclusions) folder.exclusions = [];
      if (!folder.exclusions.includes(excludePath)) {
        folder.exclusions.push(excludePath);
        saveDatabase();
      }
    }
    return true;
  },

  removeFolderExclusion: (folderId, excludePath) => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === folderId);
    if (folder) {
      if (folder.exclusions) {
        folder.exclusions = folder.exclusions.filter(ex => ex !== excludePath);
        saveDatabase();
      }
    }
    return true;
  },

  updateFolderExclusions: (folderId, exclusions) => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === folderId);
    if (folder) {
      folder.exclusions = Array.isArray(exclusions) ? exclusions : [];
      saveDatabase();
    }
    return true;
  },

  updateFolderSyncStatus: (id, success, errorMessage = '') => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === id);
    if (folder) {
      folder.last_checked_at = new Date().toISOString();
      if (success) {
        folder.last_success_at = new Date().toISOString();
        folder.sync_state = 'idle';
        folder.sync_phase = 'complete';
        folder.sync_percent = 100;
        folder.sync_current_item = '';
        folder.sync_speed = 0;
        folder.sync_eta = null;
        folder.consecutive_failures = 0;
        folder.last_error = '';
      } else {
        folder.sync_state = 'error';
        folder.sync_phase = 'error';
        folder.sync_current_item = '';
        folder.sync_speed = 0;
        folder.sync_eta = null;
        folder.consecutive_failures = (folder.consecutive_failures || 0) + 1;
        folder.last_error = normalizeStoredErrorMessage(errorMessage);
      }
      saveDatabase();
    }
  },

  updateFolderSyncProgress: (id, progress = {}) => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === id);
    if (folder) {
      const now = new Date().toISOString();
      folder.sync_state = progress.state || 'syncing';
      folder.sync_phase = progress.phase || folder.sync_phase || 'preparing';
      folder.sync_percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : (folder.sync_percent || 0);
      folder.sync_bytes_done = Number(progress.bytesDone) || 0;
      folder.sync_bytes_total = Number(progress.bytesTotal) || 0;
      folder.sync_files_done = Number(progress.filesDone) || 0;
      folder.sync_files_total = Number(progress.filesTotal) || 0;
      folder.sync_speed = Number(progress.speed) || 0;
      folder.sync_eta = progress.etaSec ?? null;
      folder.sync_current_item = progress.currentItem || '';
      folder.sync_started_at = progress.startedAt || folder.sync_started_at || now;
      folder.last_checked_at = now;
      const terminal = ['complete', 'error', 'failed', 'paused', 'cancelled'].includes(String(progress.stage || progress.state || '').toLowerCase());
      const lastPersistedAt = folderProgressPersistedAt.get(id) || 0;
      if (terminal || Date.now() - lastPersistedAt >= FOLDER_PROGRESS_PERSIST_INTERVAL_MS) {
        folderProgressPersistedAt.set(id, Date.now());
        saveDatabase();
      }
    }
  },

  deactivateMissingSource: (id) => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === id);
    if (!folder) return false;
    folder.enabled = 0;
    folder.sync_state = 'idle';
    folder.sync_phase = 'inactive';
    folder.sync_percent = 0;
    folder.sync_current_item = '';
    folder.sync_speed = 0;
    folder.sync_eta = null;
    folder.consecutive_failures = 0;
    folder.last_error = '';
    folder.missing_source_at = new Date().toISOString();
    saveDatabase();
    return true;
  },

  updateFolderRemoteIntegrityScan: (id, timestamp = new Date().toISOString()) => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === id);
    if (folder) {
      folder.last_remote_integrity_scan = timestamp;
      saveDatabase();
    }
    return true;
  },

  updateFolderVerificationStatus: (id, success, details = {}) => {
    loadDatabase();
    const folder = data.folders.find(f => f.id === id);
    if (folder) {
      folder.last_crypto_verify_at = new Date().toISOString();
      folder.last_crypto_verify_ok = success ? 1 : 0;
      folder.last_crypto_verify_error = success ? '' : String(details.error || details.message || details || '');
      folder.last_crypto_verify_files = Number(details.totalFilesChecked) || 0;
      folder.last_crypto_verify_packs = Number(details.packsChecked) || 0;
      saveDatabase();
    }
    return true;
  },
  
  // Sync log operations
  getSyncLogs: (limit = 100) => {
    loadDatabase();
    return [...data.sync_log]
      .sort((a, b) => new Date(b.synced_at) - new Date(a.synced_at))
      .slice(0, limit);
  },

  addSyncLog: ({ folderId, filePath, action, status, sizeBytes, errorMsg }) => {
    loadDatabase();
    const logItem = {
      id: Date.now() + Math.random(),
      folder_id: folderId || null,
      file_path: filePath,
      action,
      status,
      size_bytes: sizeBytes || null,
      synced_at: new Date().toISOString(),
      error_msg: errorMsg || null
    };
    data.sync_log.push(logItem);
    if (data.sync_log.length > 500) data.sync_log = data.sync_log.slice(-500);
    saveDatabase();
    return logItem;
  },

  clearSyncLogs: () => {
    loadDatabase();
    data.sync_log = [];
    saveDatabase();
    return true;
  },

  // Backup manifest operations
  getManifestEntries: (folderId) => {
    loadDatabase();
    const key = String(folderId);
    return { ...(data.backup_manifest[key] || {}) };
  },

  getManifestEntry: (folderId, relativePath) => {
    loadDatabase();
    const folderEntries = data.backup_manifest[String(folderId)] || {};
    return folderEntries[relativePath] || null;
  },

  upsertManifestEntry: (folderId, relativePath, patch) => {
    loadDatabase();
    const key = String(folderId);
    if (!data.backup_manifest[key]) data.backup_manifest[key] = {};
    const existing = data.backup_manifest[key][relativePath] || {};
    data.backup_manifest[key][relativePath] = {
      ...existing,
      ...patch,
      folder_id: folderId,
      relative_path: relativePath,
      updated_at: new Date().toISOString()
    };
    invalidateManifestSummaryCache();
    saveDatabase();
    return data.backup_manifest[key][relativePath];
  },

  markManifestDirty: (folderId, relativePath, reason = 'changed') => {
    loadDatabase();
    const key = String(folderId);
    if (!data.backup_manifest[key]) data.backup_manifest[key] = {};
    const existing = data.backup_manifest[key][relativePath] || {};
    data.backup_manifest[key][relativePath] = {
      ...existing,
      folder_id: folderId,
      relative_path: relativePath,
      status: 'dirty',
      dirty_reason: reason,
      retry_count: existing.retry_count || 0,
      updated_at: new Date().toISOString()
    };
    invalidateManifestSummaryCache();
    saveDatabase();
    return data.backup_manifest[key][relativePath];
  },

  markManifestDeleted: (folderId, relativePath) => {
    loadDatabase();
    const key = String(folderId);
    if (!data.backup_manifest[key]) data.backup_manifest[key] = {};
    const existing = data.backup_manifest[key][relativePath] || {};
    const hasRestorableCopy = existing.status === 'backed_up' ||
      existing.status === 'active_repair_needed' ||
      !!existing.remote_path ||
      (Array.isArray(existing.versions) && existing.versions.length > 0);
    data.backup_manifest[key][relativePath] = {
      ...existing,
      folder_id: folderId,
      relative_path: relativePath,
      status: hasRestorableCopy ? 'deleted_pending_history' : 'deleted',
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    invalidateManifestSummaryCache();
    saveDatabase();
    return data.backup_manifest[key][relativePath];
  },

  removeManifestFolder: (folderId) => {
    loadDatabase();
    delete data.backup_manifest[String(folderId)];
    invalidateManifestSummaryCache();
    saveDatabase();
    return true;
  },

  removeManifestEntry: (folderId, relativePath) => {
    loadDatabase();
    const key = String(folderId);
    if (data.backup_manifest[key]) {
      delete data.backup_manifest[key][relativePath];
      invalidateManifestSummaryCache();
      saveDatabase();
    }
    return true;
  },

  removeManifestEntriesUnderPath: (folderId, relativePrefix) => {
    loadDatabase();
    const key = String(folderId);
    const prefix = String(relativePrefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!prefix || !data.backup_manifest[key]) return 0;

    let removed = 0;
    for (const relativePath of Object.keys(data.backup_manifest[key])) {
      const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
        delete data.backup_manifest[key][relativePath];
        removed += 1;
      }
    }
    if (removed > 0) {
      invalidateManifestSummaryCache();
      saveDatabase();
    }
    return removed;
  },

  removeRestorePointsForFolder: (folderId) => {
    loadDatabase();
    const before = (data.restore_points || []).length;
    data.restore_points = (data.restore_points || []).filter(point => String(point.folder_id) !== String(folderId));
    const removed = before - data.restore_points.length;
    if (removed > 0) saveDatabase();
    return removed;
  },

  addRestorePoint: ({ folderId, folderPath, remotePath, filesTotal, bytesTotal, status = 'success', startedAt, completedAt }) => {
    loadDatabase();
    const point = {
      id: Date.now() + Math.random(),
      folder_id: folderId,
      folder_path: folderPath,
      remote_path: remotePath,
      files_total: filesTotal || 0,
      bytes_total: bytesTotal || 0,
      status,
      started_at: startedAt || new Date().toISOString(),
      completed_at: completedAt || new Date().toISOString()
    };
    data.restore_points.push(point);
    if (data.restore_points.length > 500) data.restore_points = data.restore_points.slice(-500);
    saveDatabase();
    return point;
  },

  getRestorePoints: (folderId = null) => {
    loadDatabase();
    return [...(data.restore_points || [])]
      .filter(point => folderId === null || point.folder_id === folderId)
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
  },

  importRemoteCatalog: (catalog) => {
    loadDatabase();
    if (!catalog || !['vaultsync-restore-catalog', 'labsuite-restore-catalog'].includes(catalog.format) || !catalog.body) {
      throw new Error('Unsupported remote restore catalog.');
    }

    const body = catalog.body;
    const importedAt = new Date().toISOString();
    const existingFoldersById = new Map(data.folders.map(folder => [String(folder.id), folder]));
    const existingFoldersByRemotePath = new Map();
    for (const folder of data.folders) {
      const remoteKey = normalizeRemotePathForCompare(folder.remote_path);
      if (!remoteKey) continue;
      const existing = existingFoldersByRemotePath.get(remoteKey);
      if (!existing || (isFolderEnabled(folder) && !isFolderEnabled(existing))) {
        existingFoldersByRemotePath.set(remoteKey, folder);
      }
    }
    const importedFolderIdMap = new Map();

    for (const remoteFolder of Array.isArray(body.folders) ? body.folders : []) {
      if (!remoteFolder || remoteFolder.id === undefined || !remoteFolder.remote_path) continue;
      const key = String(remoteFolder.id);
      const remotePathKey = normalizeRemotePathForCompare(remoteFolder.remote_path);
      const importedFolder = {
        ...remoteFolder,
        enabled: 0,
        imported_from_remote_catalog: true,
        imported_at: importedAt
      };
      const existingFolder = existingFoldersById.get(key) ||
        (remotePathKey ? existingFoldersByRemotePath.get(remotePathKey) : null);

      if (existingFolder) {
        const previousId = existingFolder.id;
        const wasEnabled = isFolderEnabled(existingFolder);
        const localPath = existingFolder.local_path;
        const deviceFingerprint = existingFolder.device_fingerprint;
        const deviceName = existingFolder.device_name;

        Object.assign(existingFolder, importedFolder, { id: previousId });

        if (wasEnabled) {
          existingFolder.enabled = 1;
          existingFolder.local_path = localPath;
          existingFolder.imported_from_remote_catalog = false;
          if (deviceFingerprint) existingFolder.device_fingerprint = deviceFingerprint;
          if (deviceName) existingFolder.device_name = deviceName;
        }

        importedFolderIdMap.set(key, String(previousId));
        existingFoldersById.set(String(previousId), existingFolder);
        if (remotePathKey) existingFoldersByRemotePath.set(remotePathKey, existingFolder);
      } else {
        data.folders.push(importedFolder);
        importedFolderIdMap.set(key, String(importedFolder.id));
        existingFoldersById.set(key, importedFolder);
        if (remotePathKey) existingFoldersByRemotePath.set(remotePathKey, importedFolder);
      }
    }

    for (const [folderId, entries] of Object.entries(body.backup_manifest || {})) {
      const targetFolderId = importedFolderIdMap.get(String(folderId)) || String(folderId);
      if (!data.backup_manifest[targetFolderId]) data.backup_manifest[targetFolderId] = {};
      data.backup_manifest[targetFolderId] = {
        ...data.backup_manifest[targetFolderId],
        ...(entries || {})
      };
    }

    const seenRestorePoints = new Set(
      (data.restore_points || []).map(point => `${point.folder_id}|${point.completed_at}|${point.remote_path}`)
    );
    for (const point of Array.isArray(body.restore_points) ? body.restore_points : []) {
      const mappedPoint = {
        ...point,
        folder_id: importedFolderIdMap.get(String(point.folder_id)) || point.folder_id,
        imported_from_remote_catalog: true
      };
      const key = `${mappedPoint.folder_id}|${mappedPoint.completed_at}|${mappedPoint.remote_path}`;
      if (seenRestorePoints.has(key)) continue;
      data.restore_points.push(mappedPoint);
      seenRestorePoints.add(key);
    }
    if (data.restore_points.length > 500) data.restore_points = data.restore_points.slice(-500);

    const catalogAliases = parseAliasMap(
      body.computer_aliases || (body.settings && body.settings.computer_aliases)
    );
    if (Object.keys(catalogAliases).length > 0) {
      const localAliases = parseAliasMap(data.settings.computer_aliases || '{}');
      data.settings.computer_aliases = JSON.stringify({
        ...localAliases,
        ...catalogAliases
      });
    }

    const catalogDeviceFingerprints = parseStringMap(body.device_fingerprints);
    if (Object.keys(catalogDeviceFingerprints).length > 0) {
      const localDeviceFingerprints = parseStringMap(data.settings.device_fingerprints || '{}');
      data.settings.device_fingerprints = JSON.stringify({
        ...localDeviceFingerprints,
        ...catalogDeviceFingerprints
      });
    }

    data.settings.remote_catalog_imported_at = importedAt;
    data.settings.remote_catalog_generated_at = catalog.generatedAt || '';
    invalidateManifestSummaryCache();
    saveDatabase();
    return {
      folders: Array.isArray(body.folders) ? body.folders.length : 0,
      restorePoints: Array.isArray(body.restore_points) ? body.restore_points.length : 0,
      manifestFolders: Object.keys(body.backup_manifest || {}).length,
      aliases: Object.keys(catalogAliases).length
    };
  },

  getManifestSummary: () => getCachedManifestSummary(),

  getAnalyticsSummary: () => {
    loadDatabase();
    const logs = data.sync_log || [];
    
    let totalItems = logs.length;
    let successCount = 0;
    let failedCount = 0;
    let totalBytes = 0;

    // Calculate last 7 days history
    const dailyTransfer = {};
    for (let i = 0; i < 7; i++) {
      const dateStr = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      dailyTransfer[dateStr] = 0;
    }

    logs.forEach(log => {
      if (log.status === 'success') {
        successCount++;
        if (log.size_bytes) {
          totalBytes += log.size_bytes;
          const dayStr = log.synced_at.split('T')[0];
          if (dailyTransfer[dayStr] !== undefined) {
            dailyTransfer[dayStr] += log.size_bytes;
          }
        }
      } else if (log.status === 'failed') {
        failedCount++;
      }
    });

    const graphData = Object.keys(dailyTransfer)
      .sort((a, b) => new Date(a) - new Date(b))
      .map(date => ({
        date,
        bytes: dailyTransfer[date]
      }));

    return {
      totalItems,
      successCount,
      failedCount,
      totalBytes,
      successRate: totalItems > 0 ? Math.round((successCount / totalItems) * 100) : 100,
      graphData
    };
  },

  // Settings operations
  getSetting: (key) => {
    loadDatabase();
    return data.settings[key] !== undefined ? String(data.settings[key]) : null;
  },

  setSetting: (key, value) => {
    loadDatabase();
    data.settings[key] = String(value);
    saveDatabase();
    return true;
  },

  getAllSettings: () => {
    loadDatabase();
    const settingsCopy = {};
    for (const key in data.settings) {
      settingsCopy[key] = String(data.settings[key]);
    }
    return settingsCopy;
  },

  setCache: (key, value) => {
    loadDatabase();
    if (!data.cache) data.cache = {};
    data.cache[key] = {
      value,
      timestamp: new Date().toISOString()
    };
    saveDatabase();
  },

  getCache: (key, maxAgeMs = null) => {
    loadDatabase();
    if (!data.cache) data.cache = {};
    const entry = data.cache[key];
    if (!entry) return null;
    
    if (maxAgeMs !== null) {
      const age = new Date() - new Date(entry.timestamp);
      if (age > maxAgeMs) {
        delete data.cache[key];
        saveDatabase();
        return null;
      }
    }
    
    return entry.value;
  },

  deleteCache: (key) => {
    loadDatabase();
    if (!data.cache || !Object.prototype.hasOwnProperty.call(data.cache, key)) return false;
    delete data.cache[key];
    saveDatabase();
    return true;
  },

  // Telegram operations
  getTelegramInstalls: () => {
    loadDatabase();
    return data.telegramInstalls || [];
  },

  addTelegramInstall: (label, tdata_path, account_count, remote_path, metadata = {}) => {
    loadDatabase();
    if (!data.telegramInstalls) data.telegramInstalls = [];
    
    // Check for duplicates
    if (data.telegramInstalls.some(i => i.tdata_path.toLowerCase() === tdata_path.toLowerCase())) {
      throw new Error(`Telegram installation already registered for path: ${tdata_path}`);
    }

    const newInstall = {
      id: Date.now(),
      label: String(label || 'Telegram Desktop').trim(),
      tdata_path: String(tdata_path).trim(),
      account_count: Number(account_count) || 1,
      remote_path: String(remote_path).trim(),
      enabled: metadata.enabled !== false,
      schedule: metadata.schedule || 'daily',
      schedule_time: metadata.schedule_time || '03:00',
      last_backup_at: null,
      last_backup_size_bytes: 0,
      last_backup_duration_sec: 0,
      last_backup_status: null,
      last_error: null,
      consecutive_failures: 0,
      backup_history: []
    };

    data.telegramInstalls.push(newInstall);
    saveDatabase();
    return newInstall;
  },

  updateTelegramInstall: (id, updates = {}) => {
    loadDatabase();
    if (!data.telegramInstalls) data.telegramInstalls = [];
    const install = data.telegramInstalls.find(i => i.id === id);
    if (!install) {
      throw new Error(`Telegram installation not found: ${id}`);
    }

    if (updates.label !== undefined) install.label = String(updates.label).trim();
    if (updates.enabled !== undefined) install.enabled = !!updates.enabled;
    if (updates.schedule !== undefined) install.schedule = String(updates.schedule);
    if (updates.schedule_time !== undefined) install.schedule_time = String(updates.schedule_time);
    if (updates.last_backup_at !== undefined) install.last_backup_at = updates.last_backup_at;
    if (updates.last_backup_size_bytes !== undefined) install.last_backup_size_bytes = Number(updates.last_backup_size_bytes);
    if (updates.last_backup_duration_sec !== undefined) install.last_backup_duration_sec = Number(updates.last_backup_duration_sec);
    if (updates.last_backup_status !== undefined) install.last_backup_status = updates.last_backup_status;
    if (updates.last_error !== undefined) install.last_error = updates.last_error;
    if (updates.consecutive_failures !== undefined) install.consecutive_failures = Number(updates.consecutive_failures);
    if (updates.backup_history !== undefined) install.backup_history = updates.backup_history;

    saveDatabase();
    return install;
  },

  removeTelegramInstall: (id) => {
    loadDatabase();
    if (!data.telegramInstalls) data.telegramInstalls = [];
    data.telegramInstalls = data.telegramInstalls.filter(i => i.id !== id);
    saveDatabase();
    return true;
  },

  getTelegramArchiveChats: () => {
    loadDatabase();
    return data.telegramArchiveChats || [];
  },

  upsertTelegramArchiveChats: (discoveredChats = []) => {
    loadDatabase();
    if (!data.telegramArchiveChats) data.telegramArchiveChats = [];
    const now = new Date().toISOString();

    for (const discovered of discoveredChats) {
      if (!discovered || !discovered.id) continue;
      const existing = data.telegramArchiveChats.find(chat => chat.id === discovered.id);
      if (existing) {
        existing.account_id = String(discovered.account_id || existing.account_id || 'default');
        existing.account_name = String(discovered.account_name || existing.account_name || 'Telegram account');
        existing.name = String(discovered.name || existing.name || 'Unnamed chat');
        existing.type = String(discovered.type || existing.type || 'Chat');
        existing.preview = String(discovered.preview || '');
        existing.preview_time = String(discovered.preview_time || '');
        existing.unread = String(discovered.unread || '');
        existing.muted = String(discovered.muted || '');
        existing.last_seen_at = now;
      } else {
        data.telegramArchiveChats.push({
          id: String(discovered.id),
          account_id: String(discovered.account_id || 'default'),
          account_name: String(discovered.account_name || 'Telegram account'),
          name: String(discovered.name || 'Unnamed chat'),
          type: String(discovered.type || 'Chat'),
          preview: String(discovered.preview || ''),
          preview_time: String(discovered.preview_time || ''),
          unread: String(discovered.unread || ''),
          muted: String(discovered.muted || ''),
          selected: false,
          enabled: true,
          include_media: true,
          schedule: 'weekly',
          schedule_time: '03:00',
          message_count: 0,
          media_count: 0,
          last_backup_at: null,
          last_backup_status: null,
          last_error: null,
          checkpoint_date: null,
          telegram_chat_id: null,
          remote_path: null,
          discovered_at: now,
          last_seen_at: now
        });
      }
    }

    saveDatabase();
    return data.telegramArchiveChats;
  },

  updateTelegramArchiveChat: (id, updates = {}) => {
    loadDatabase();
    if (!data.telegramArchiveChats) data.telegramArchiveChats = [];
    const chat = data.telegramArchiveChats.find(item => item.id === id);
    if (!chat) throw new Error(`Telegram archive chat not found: ${id}`);

    const booleanFields = ['selected', 'enabled', 'include_media'];
    const stringFields = [
      'schedule', 'schedule_time', 'last_backup_at', 'last_backup_status',
      'last_error', 'checkpoint_date', 'telegram_chat_id', 'remote_path',
      'account_id', 'account_name', 'name', 'type', 'preview', 'preview_time'
    ];
    const numberFields = ['message_count', 'media_count'];

    for (const field of booleanFields) {
      if (updates[field] !== undefined) chat[field] = !!updates[field];
    }
    for (const field of stringFields) {
      if (updates[field] !== undefined) chat[field] = updates[field] === null ? null : String(updates[field]);
    }
    for (const field of numberFields) {
      if (updates[field] !== undefined) chat[field] = Math.max(0, Number(updates[field]) || 0);
    }

    saveDatabase();
    return chat;
  },

  withWriteBatch,
  flushWrites,
  flushWritesAsync
};
