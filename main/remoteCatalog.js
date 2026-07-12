const crypto = require('crypto');
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
const aliases = require('./aliases');
const folderIdentity = require('./folderIdentity');

const CATALOG_FILE = 'restore-catalog.json';
const CATALOG_FORMAT = 'labsuite-restore-catalog';
const LEGACY_CATALOG_FORMAT = 'vaultsync-restore-catalog';
const CATALOG_VERSION = 1;

function getCatalogPath() {
  return rclone.getVaultPath('control', CATALOG_FILE);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
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

function getDeviceFingerprints(settings = {}) {
  const fingerprints = parseStringMap(settings.device_fingerprints || '{}');
  try {
    fingerprints[folderIdentity.getDeviceFingerprint()] = os.hostname() || 'My-PC';
  } catch (error) {
    console.warn('LabSuite: Could not add local device fingerprint to restore catalog:', error.message);
  }
  return fingerprints;
}

function makeCatalogBody() {
  const state = db.getDb();
  const computerAliases = aliases.getLocalAliases();
  const deviceFingerprints = getDeviceFingerprints(state.settings || {});
  return {
    folders: (state.folders || []).map(folder => ({ ...folder })),
    // Serialization below creates the immutable upload snapshot. Avoid cloning
    // the 20+ MB manifest once here only to stringify it again immediately.
    backup_manifest: state.backup_manifest || {},
    restore_points: state.restore_points || [],
    device_fingerprints: deviceFingerprints,
    computer_aliases: computerAliases,
    settings: {
      computer_aliases: JSON.stringify(computerAliases)
    }
  };
}

function makeCatalogPayload() {
  const body = makeCatalogBody();
  const bodyJson = JSON.stringify(body);
  const header = {
    format: rclone.getVaultNamespace() === 'vaultsync' ? LEGACY_CATALOG_FORMAT : CATALOG_FORMAT,
    version: CATALOG_VERSION,
    generatedAt: new Date().toISOString(),
    hashAlgorithm: 'json-v1',
    bodySha256: sha256Text(bodyJson)
  };
  const headerJson = JSON.stringify(header);
  return {
    catalog: { ...header, body },
    payload: `${headerJson.slice(0, -1)},"body":${bodyJson}}`
  };
}

function makeCatalog() {
  return makeCatalogPayload().catalog;
}

function verifyCatalog(catalog) {
  const validFormat = catalog && [CATALOG_FORMAT, LEGACY_CATALOG_FORMAT].includes(catalog.format);
  if (!validFormat || catalog.version !== CATALOG_VERSION || !catalog.body) {
    throw new Error('Unsupported remote restore catalog.');
  }
  const actual = catalog.hashAlgorithm === 'json-v1'
    ? sha256Text(JSON.stringify(catalog.body))
    : sha256Json(catalog.body);
  if (catalog.bodySha256 && catalog.bodySha256 !== actual) {
    throw new Error('Remote restore catalog checksum mismatch.');
  }
  return catalog;
}

function makeTempCatalogPath() {
  const dir = path.join(os.tmpdir(), 'labsuite-control');
  safeMkdirSync(dir, { recursive: true });
  return path.join(dir, `restore-catalog-${process.pid}-${Date.now()}.json`);
}

async function publish() {
  const { catalog, payload } = makeCatalogPayload();
  const tempPath = makeTempCatalogPath();
  try {
    await fs.promises.writeFile(tempPath, payload, 'utf8');
    const catalogPath = getCatalogPath();
    await rclone.syncControlFile(tempPath, catalogPath);
    db.setSetting('remote_catalog_last_published_at', catalog.generatedAt);
    db.setSetting('device_fingerprints', JSON.stringify(catalog.body.device_fingerprints || {}));
    return {
      ok: true,
      catalogPath,
      generatedAt: catalog.generatedAt,
      folders: catalog.body.folders.length,
      restorePoints: catalog.body.restore_points.length
    };
  } finally {
    try {
      safeUnlinkSync(tempPath);
    } catch (_) {}
  }
}

async function readRemote() {
  const text = await rclone.readText(getCatalogPath());
  return verifyCatalog(safeParseJson(text));
}

async function importRemote() {
  const catalog = await readRemote();
  const result = db.importRemoteCatalog(catalog);
  return { ok: true, catalogPath: getCatalogPath(), generatedAt: catalog.generatedAt, ...result };
}

module.exports = {
  CATALOG_PATH: getCatalogPath(),
  getCatalogPath,
  makeCatalog,
  publish,
  readRemote,
  importRemote,
  verifyCatalog,
  __private: {
    stableStringify,
    sha256Json,
    makeCatalogPayload
  }
};
