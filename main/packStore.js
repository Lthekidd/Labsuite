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
const crypto = require('crypto');

const PACK_FORMAT = 'labsuite-small-file-pack';
const PACK_VERSION = 1;

function normalizeRelativePath(relativePath) {
  return String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function assertSafeRelativePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split('/').filter(Boolean);
  if (!normalized || parts.some(part => part === '..' || part === '.')) {
    throw new Error(`Unsafe packed file path: ${relativePath}`);
  }
  return normalized;
}

function getPackSettings(db) {
  return {
    enabled: db.getSetting('pack_small_files_enabled') !== '0',
    smallFileMaxBytes: Number(db.getSetting('pack_small_file_max_bytes')) || 65536,
    maxRawBytes: Number(db.getSetting('pack_max_raw_bytes')) || 16 * 1024 * 1024,
    maxFiles: Number(db.getSetting('pack_max_files')) || 1000
  };
}

function shouldPackItem(item, settings) {
  if (!settings || !settings.enabled) return false;
  return Number(item.size) <= settings.smallFileMaxBytes;
}

function makePackId(folder, runId, index, items) {
  const hash = crypto.createHash('sha256');
  hash.update(String(folder.id));
  hash.update('\n');
  hash.update(String(runId));
  hash.update('\n');
  hash.update(String(index));
  for (const item of items) {
    hash.update('\n');
    hash.update(normalizeRelativePath(item.relativePath));
    hash.update(':');
    hash.update(String(item.size || 0));
    hash.update(':');
    hash.update(String(item.mtimeMs || 0));
  }
  return `${runId}-${String(index).padStart(4, '0')}-${hash.digest('hex').slice(0, 12)}`;
}

function makePackRemoteRoot(folder) {
  const rclone = require('./rclone');
  return rclone.getVaultPath('packs', folder.remote_path).replace(/\\/g, '/');
}

function makePackRemotePath(folder, packId) {
  return `${makePackRemoteRoot(folder)}/${packId}.vspack`.replace(/\\/g, '/');
}

function groupPackItems(items, settings) {
  const groups = [];
  let current = [];
  let currentBytes = 0;

  for (const item of items) {
    const size = Number(item.size) || 0;
    const wouldOverflowBytes = current.length > 0 && currentBytes + size > settings.maxRawBytes;
    const wouldOverflowFiles = current.length > 0 && current.length >= settings.maxFiles;

    if (wouldOverflowBytes || wouldOverflowFiles) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(item);
    currentBytes += size;
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

function makeTempPackPath(packId) {
  const dir = path.join(os.tmpdir(), 'labsuite-packs');
  safeMkdirSync(dir, { recursive: true });
  return path.join(dir, `${packId}.vspack`);
}

function createPackFile(folder, packId, items) {
  const tempPath = makeTempPackPath(packId);
  const files = items.map(item => {
    const content = safeReadFileSync(item.localPath); if(!content) throw new Error("Could not read file");
    return {
      relativePath: normalizeRelativePath(item.relativePath),
      size: Number(item.size) || content.length,
      mtimeMs: Number(item.mtimeMs) || 0,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      contentBase64: content.toString('base64')
    };
  });

  const payload = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    folderId: folder.id,
    folderRemotePath: folder.remote_path,
    packId,
    createdAt: new Date().toISOString(),
    files
  };

  if (!safeWriteFileSync(tempPath, JSON.stringify(payload), 'utf8')) {
    throw new Error(`Could not create temporary small-file pack: ${tempPath}`);
  }

  // Generate metadata-only payload
  const metaPayload = {
    format: PACK_FORMAT + '-metadata',
    version: PACK_VERSION,
    folderId: folder.id,
    folderRemotePath: folder.remote_path,
    packId,
    createdAt: payload.createdAt,
    files: files.map(f => ({
      relativePath: f.relativePath,
      size: f.size,
      mtimeMs: f.mtimeMs,
      sha256: f.sha256
    }))
  };
  const tempMetaPath = tempPath + '.meta';
  if (!safeWriteFileSync(tempMetaPath, JSON.stringify(metaPayload), 'utf8')) {
    safeUnlinkSync(tempPath);
    throw new Error(`Could not create temporary small-file pack metadata: ${tempMetaPath}`);
  }

  return {
    tempPath,
    tempMetaPath,
    payload,
    rawBytes: files.reduce((sum, file) => sum + file.size, 0),
    packedBytes: fs.statSync(tempPath).size
  };
}

function readPackFile(packPath) {
  const payload = safeParseJson(safeReadFileSync(packPath, 'utf8') || "{}");
  if (!payload || payload.format !== PACK_FORMAT || payload.version !== PACK_VERSION) {
    throw new Error('Unsupported LabSuite pack format');
  }
  return payload;
}

function getNonOverwritingPath(outputPath) {
  if (!fs.existsSync(outputPath)) return outputPath;
  const extension = path.extname(outputPath);
  const base = path.basename(outputPath, extension);
  const directory = path.dirname(outputPath);
  let index = 1;
  let candidate;
  do {
    const suffix = index === 1 ? ' (Restored)' : ` (Restored ${index})`;
    candidate = path.join(directory, `${base}${suffix}${extension}`);
    index += 1;
  } while (fs.existsSync(candidate));
  return candidate;
}

function extractPackedFile(packPath, relativePath, destinationRoot, options = {}) {
  const normalized = assertSafeRelativePath(relativePath);
  const payload = readPackFile(packPath);
  const entry = payload.files.find(file => normalizeRelativePath(file.relativePath) === normalized);
  if (!entry) throw new Error(`Packed file not found: ${normalized}`);

  const requestedOutputPath = path.join(destinationRoot, normalized.replace(/\//g, path.sep));
  const outputPath = options.overwrite === true ? requestedOutputPath : getNonOverwritingPath(requestedOutputPath);
  safeMkdirSync(path.dirname(outputPath), { recursive: true });
  const content = Buffer.from(entry.contentBase64 || '', 'base64');
  const actualHash = crypto.createHash('sha256').update(content).digest('hex');
  if (entry.sha256 && entry.sha256 !== actualHash) {
    throw new Error(`Packed file checksum mismatch: ${normalized}`);
  }
  safeWriteFileSync(outputPath, content);
  return outputPath;
}

function verifyPackFile(packPath, expectedFiles = []) {
  const payload = readPackFile(packPath);
  const entriesByPath = new Map();
  const verified = [];

  for (const entry of payload.files || []) {
    const normalized = assertSafeRelativePath(entry.relativePath);
    const content = Buffer.from(entry.contentBase64 || '', 'base64');
    const actualHash = crypto.createHash('sha256').update(content).digest('hex');
    if (entry.sha256 && entry.sha256 !== actualHash) {
      throw new Error(`Packed file checksum mismatch: ${normalized}`);
    }
    if (Number(entry.size) !== content.length) {
      throw new Error(`Packed file size mismatch: ${normalized}`);
    }
    entriesByPath.set(normalized, { ...entry, content, sha256: actualHash });
    verified.push(normalized);
  }

  for (const expected of expectedFiles || []) {
    const normalized = assertSafeRelativePath(expected.relativePath || expected.packMemberPath);
    const entry = entriesByPath.get(normalized);
    if (!entry) throw new Error(`Packed file missing expected member: ${normalized}`);

    if (expected.localPath && fs.existsSync(expected.localPath)) {
      const localContent = safeReadFileSync(expected.localPath); if(!localContent) return false;
      const localHash = crypto.createHash('sha256').update(localContent).digest('hex');
      if (entry.sha256 !== localHash) {
        throw new Error(`Packed file does not match local file: ${normalized}`);
      }
      if (Number(expected.size) && Number(expected.size) !== localContent.length) {
        throw new Error(`Local file size changed during pack verification: ${normalized}`);
      }
    }
  }

  return { ok: true, filesVerified: verified.length };
}

function safeUnlink(filePath) {
  try {
    safeUnlinkSync(filePath);
  } catch (_) {
    // Temporary pack cleanup is best-effort.
  }
}

module.exports = {
  PACK_FORMAT,
  PACK_VERSION,
  normalizeRelativePath,
  assertSafeRelativePath,
  getPackSettings,
  shouldPackItem,
  groupPackItems,
  makePackId,
  makePackRemotePath,
  createPackFile,
  readPackFile,
  extractPackedFile,
  getNonOverwritingPath,
  verifyPackFile,
  safeUnlink
};
