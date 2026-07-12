const os = require('os');
const path = require('path');
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


const db = require('./database');
const rclone = require('./rclone');

const REMOTE_ALIASES_FILE = 'computer-aliases.json';

function getRemoteAliasesPath() {
  return rclone.getVaultPath('control', REMOTE_ALIASES_FILE);
}
let cachedRemoteAliases = null;
let cachedRemoteAliasesAt = 0;
let activeSyncPromise = null;
let activePublishPromise = null;

function normalizeAliases(value) {
  const aliases = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return aliases;

  for (const [computerName, alias] of Object.entries(value)) {
    const key = String(computerName || '').trim();
    const label = String(alias || '').trim();
    if (key && label) aliases[key] = label;
  }
  return aliases;
}

function parseAliases(value) {
  if (!value) return {};
  if (typeof value === 'object') return normalizeAliases(value);
  try {
    return normalizeAliases(safeParseJson(String(value), {}));
  } catch (_) {
    return {};
  }
}

function stableAliases(value) {
  const aliases = normalizeAliases(value);
  return Object.keys(aliases)
    .sort()
    .reduce((sorted, key) => {
      sorted[key] = aliases[key];
      return sorted;
    }, {});
}

function aliasesEqual(left, right) {
  return JSON.stringify(stableAliases(left)) === JSON.stringify(stableAliases(right));
}

function applyAliasValue(aliases, computerName, alias) {
  const next = { ...normalizeAliases(aliases) };
  const key = String(computerName || '').trim();
  const label = String(alias || '').trim();
  if (!key) return stableAliases(next);

  if (label) {
    next[key] = label;
  } else {
    delete next[key];
  }
  return stableAliases(next);
}

function getLocalAliases() {
  return parseAliases(db.getSetting('computer_aliases') || '{}');
}

function setLocalAliases(aliases) {
  db.setSetting('computer_aliases', JSON.stringify(stableAliases(aliases)));
}

async function readRemoteAliases() {
  try {
    const text = await rclone.readText(getRemoteAliasesPath());
    return { found: true, aliases: parseAliases(text) };
  } catch (error) {
    console.log('No remote aliases file found or failed to read:', error.message);
    return { found: false, aliases: {} };
  }
}

function makeUploadTempPath() {
  const dir = path.join(os.tmpdir(), 'labsuite-control');
  safeMkdirSync(dir, { recursive: true });
  return path.join(dir, `computer-aliases-${process.pid}-${Date.now()}.json`);
}

async function writeRemoteAliases(aliases) {
  const tempPath = makeUploadTempPath();
  const normalized = stableAliases(aliases);
  try {
    safeWriteFileSync(tempPath, JSON.stringify(normalized, null, 2), 'utf8');
    await rclone.syncControlFile(tempPath, getRemoteAliasesPath());
    cachedRemoteAliases = normalized;
    cachedRemoteAliasesAt = Date.now();
  } finally {
    try {
      safeUnlinkSync(tempPath);
    } catch (_) {}
  }
}

async function performAliasSync() {
  const localAliases = getLocalAliases();
  const remote = await readRemoteAliases();
  cachedRemoteAliases = stableAliases(remote.aliases);
  cachedRemoteAliasesAt = Date.now();

  const mergedAliases = stableAliases({ ...localAliases, ...remote.aliases });

  if (!aliasesEqual(mergedAliases, localAliases)) {
    setLocalAliases(mergedAliases);
  }

  if (!aliasesEqual(mergedAliases, remote.aliases) && Object.keys(mergedAliases).length > 0) {
    try {
      await writeRemoteAliases(mergedAliases);
    } catch (error) {
      console.warn('LabSuite: Failed to publish local computer aliases:', error.message);
    }
  }

  return mergedAliases;
}

async function syncAliases(options = {}) {
  const maxAgeMs = Number(options.maxAgeMs) || 0;
  const force = options.force === true;
  const now = Date.now();

  if (!force && cachedRemoteAliases && maxAgeMs > 0 && now - cachedRemoteAliasesAt < maxAgeMs) {
    const localAliases = getLocalAliases();
    const mergedAliases = stableAliases({ ...localAliases, ...cachedRemoteAliases });
    if (!aliasesEqual(mergedAliases, localAliases)) {
      setLocalAliases(mergedAliases);
    }
    return mergedAliases;
  }

  if (!force && activeSyncPromise) {
    return activeSyncPromise;
  }

  const syncPromise = performAliasSync();
  activeSyncPromise = syncPromise;
  try {
    return await syncPromise;
  } finally {
    if (activeSyncPromise === syncPromise) {
      activeSyncPromise = null;
    }
  }
}

function scheduleAliasPublish(computerName, alias) {
  const key = String(computerName || '').trim();
  const label = String(alias || '').trim();
  const previousPublish = activePublishPromise || Promise.resolve();

  const publishPromise = previousPublish
    .catch(() => {})
    .then(async () => {
      const localAliases = getLocalAliases();
      const remote = await readRemoteAliases();
      const mergedAliases = applyAliasValue(
        { ...remote.aliases, ...localAliases },
        key,
        label
      );
      await writeRemoteAliases(mergedAliases);
    })
    .catch(error => {
      console.warn('LabSuite: Failed to publish computer alias update:', error.message);
    });

  let trackedPromise;
  trackedPromise = publishPromise.finally(() => {
    if (activePublishPromise === trackedPromise) {
      activePublishPromise = null;
    }
  });
  activePublishPromise = trackedPromise;
  trackedPromise.catch(() => {});
}

async function saveAlias(computerName, alias) {
  const key = String(computerName || '').trim();
  if (!key) throw new Error('Computer name is required.');

  const localAliases = getLocalAliases();
  const normalized = applyAliasValue(localAliases, key, alias);
  setLocalAliases(normalized);

  if (cachedRemoteAliases) {
    cachedRemoteAliases = applyAliasValue({ ...cachedRemoteAliases, ...normalized }, key, alias);
    cachedRemoteAliasesAt = Date.now();
  }

  scheduleAliasPublish(key, alias);
  return normalized;
}

module.exports = {
  REMOTE_ALIASES_PATH: getRemoteAliasesPath(),
  getRemoteAliasesPath,
  getLocalAliases,
  parseAliases,
  saveAlias,
  syncAliases,
  writeRemoteAliases
};
