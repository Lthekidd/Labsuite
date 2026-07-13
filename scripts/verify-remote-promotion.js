const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-remote-promotion-'));
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: { app: { getPath: () => tempDir, getVersion: () => 'test' } }
};

(async () => {
  const db = require('../main/database');
  const rclone = require('../main/rclone');
  const worker = require('../main/backupWorker');
  const localFile = path.join(tempDir, 'file.txt');
  fs.writeFileSync(localFile, 'current data', 'utf8');
  db.addFolder(tempDir, 'computers/Test/Desktop');
  const folder = db.getFolders()[0];
  const activePath = 'computers/Test/Desktop/file.txt';
  db.upsertManifestEntry(folder.id, 'file.txt', {
    local_path: localFile,
    remote_path: activePath,
    status: 'failed',
    size: 12,
    retry_count: 3
  });

  const originalMoveRemoteFile = rclone.moveRemoteFile;
  const moves = [];
  rclone.moveRemoteFile = async (source, destination) => {
    moves.push({ source, destination });
    if (source === activePath) throw new Error("CRITICAL: Source doesn't exist or is a directory");
    return '';
  };

  try {
    const counters = { filesDone: 0, bytesDone: 0 };
    await worker.promoteStagedItem(folder, {
      type: 'upload',
      folderId: folder.id,
      localPath: localFile,
      relativePath: 'file.txt',
      size: 12,
      mtimeMs: Date.now(),
      previousRemotePath: activePath,
      previousStorage: 'file'
    }, '.labsuite_staging/run/computers/Test/Desktop', '.labsuite_history/run/computers/Test/Desktop', counters);

    const entry = db.getManifestEntry(folder.id, 'file.txt');
    assert.strictEqual(moves.length, 2, 'Promotion must continue after the previous active copy is already absent.');
    assert.strictEqual(entry.status, 'backed_up');
    assert.strictEqual(entry.remote_path, activePath);
    assert.strictEqual((entry.versions || []).length, 0, 'A nonexistent previous copy must not create a fake history version.');
    assert.strictEqual(counters.filesDone, 1);
    console.log('Remote promotion verification passed.');
  } finally {
    rclone.moveRemoteFile = originalMoveRemoteFile;
  }
})().finally(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
}).catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
