const crypto = require('crypto');
const os = require('os');
const path = require('path');
let fs;
try {
  fs = require('original-fs');
} catch (_) {
  fs = require('fs');
}

const db = require('./database');
const rclone = require('./rclone');
const packStore = require('./packStore');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function getLocalPath(folder, entry) {
  return entry.local_path || path.join(folder.local_path, String(entry.relative_path || '').replace(/\//g, path.sep));
}

function getActiveEntries(folder) {
  return Object.values(db.getManifestEntries(folder.id))
    .filter(entry => entry.status === 'backed_up')
    .filter(entry => entry.relative_path && entry.remote_path);
}

function pickSample(entries, maxFiles) {
  return entries
    .map(entry => ({ entry, sortKey: crypto.createHash('sha256').update(`${entry.relative_path}:${entry.last_backed_up_at || ''}`).digest('hex') }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .slice(0, maxFiles)
    .map(item => item.entry);
}

function cleanupDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_) {}
}

async function restoreEntry(folder, entry, drillDir) {
  const storage = entry.storage || 'file';
  const localPath = getLocalPath(folder, entry);
  const result = {
    folderId: folder.id,
    folderPath: folder.local_path,
    relativePath: entry.relative_path,
    storage,
    localPath,
    size: Number(entry.size) || 0,
    ok: false,
    skipped: false,
    error: ''
  };

  if (!fs.existsSync(localPath)) {
    result.skipped = true;
    result.error = 'Local source file is missing; cannot compare restored bytes.';
    return result;
  }

  const folderDir = path.join(drillDir, String(folder.id));
  fs.mkdirSync(folderDir, { recursive: true });
  let restoredPath;

  if (storage === 'pack') {
    const packPath = path.join(folderDir, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.vspack`);
    try {
      await rclone.copyFileRemoteToLocal(entry.pack_remote_path || entry.remote_path, packPath);
      restoredPath = packStore.extractPackedFile(
        packPath,
        entry.pack_member_path || entry.relative_path,
        path.join(folderDir, 'restored')
      );
    } finally {
      packStore.safeUnlink(packPath);
    }
  } else {
    restoredPath = path.join(folderDir, 'restored', String(entry.relative_path).replace(/\//g, path.sep));
    fs.mkdirSync(path.dirname(restoredPath), { recursive: true });
    await rclone.copyFileRemoteToLocal(entry.remote_path, restoredPath);
  }

  const localHash = sha256File(localPath);
  const restoredHash = sha256File(restoredPath);
  result.ok = localHash === restoredHash;
  if (!result.ok) {
    result.error = 'Restored file hash did not match local source.';
  }
  return result;
}

async function runRestoreDrill(options = {}) {
  const maxFiles = Math.max(1, Math.min(Number(options.maxFiles) || 10, 50));
  const startedAt = Date.now();
  const drillDir = path.join(os.tmpdir(), `labsuite-restore-drill-${process.pid}-${Date.now()}`);
  fs.mkdirSync(drillDir, { recursive: true });

  const report = {
    ok: false,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: '',
    durationMs: 0,
    maxFiles,
    sampled: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    details: []
  };

  try {
    const candidates = [];
    for (const folder of db.getEnabledFolders()) {
      if (!folder.local_path || !folder.remote_path) continue;
      for (const entry of getActiveEntries(folder)) {
        candidates.push({ folder, entry });
      }
    }

    const sample = pickSample(candidates, maxFiles);
    report.sampled = sample.length;

    for (const item of sample) {
      try {
        const detail = await restoreEntry(item.folder, item.entry, drillDir);
        report.details.push(detail);
        if (detail.skipped) report.skipped += 1;
        else if (detail.ok) report.passed += 1;
        else report.failed += 1;
      } catch (error) {
        report.failed += 1;
        report.details.push({
          folderId: item.folder.id,
          folderPath: item.folder.local_path,
          relativePath: item.entry.relative_path,
          storage: item.entry.storage || 'file',
          size: Number(item.entry.size) || 0,
          ok: false,
          skipped: false,
          error: error.message || String(error)
        });
      }
    }

    report.ok = report.sampled > 0 && report.failed === 0 && report.passed > 0;
    return report;
  } finally {
    report.completedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    cleanupDir(drillDir);
  }
}

module.exports = {
  runRestoreDrill
};
