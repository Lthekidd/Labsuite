const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-single-file-'));
const protectedFile = path.join(tempDir, 'protected.txt');
const siblingFile = path.join(tempDir, 'not-selected.txt');
fs.writeFileSync(protectedFile, 'keep this', 'utf8');
fs.writeFileSync(siblingFile, 'do not back up', 'utf8');

require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: { app: { getPath: () => tempDir } }
};

try {
  const db = require('../main/database');
  const filesystem = require('../main/filesystem');
  const planner = require('../main/backupPlanner');
  const backupWorker = require('../main/backupWorker');

  const first = db.addFolder(tempDir, 'computers/Test/protected.txt', {
    include_paths: ['protected.txt'],
    selection_path: protectedFile,
    source_type: 'file'
  });
  const second = db.addFolder(tempDir, 'computers/Test/not-selected.txt', {
    include_paths: ['not-selected.txt'],
    selection_path: siblingFile,
    source_type: 'file'
  });
  const [firstFolder, secondFolder] = db.getFolders();

  assert.strictEqual(filesystem.isPathIncluded(protectedFile, firstFolder), true);
  assert.strictEqual(filesystem.isPathIncluded(siblingFile, firstFolder), false);

  const plan = planner.planFolder(firstFolder);
  const uploads = plan.workItems.filter(item => item.type === 'upload');
  assert.strictEqual(uploads.length, 1, 'Single-file backup should plan exactly one upload.');
  assert.strictEqual(uploads[0].localPath, protectedFile);
  assert.strictEqual(uploads[0].relativePath, 'protected.txt');

  db.upsertManifestEntry(firstFolder.id, 'protected.txt', {
    local_path: protectedFile,
    remote_path: 'computers/Test/protected.txt/protected.txt',
    status: 'backed_up',
    size: 9,
    mtime_ms: Date.now()
  });
  fs.unlinkSync(protectedFile);
  const deletionPlan = planner.planFolder(firstFolder);
  assert.strictEqual(deletionPlan.sourceUnavailable, true, 'A deleted standalone source must be marked unavailable.');
  assert.strictEqual(
    deletionPlan.workItems.filter(item => item.type === 'delete_history').length,
    1,
    'A selected file deleted while the app was closed must be preserved in history on reconcile.'
  );

  const effective = backupWorker.getEffectiveFolders([firstFolder, secondFolder]).effective;
  assert.strictEqual(effective.length, 2, 'Two selected files in one parent directory must stay independent backups.');
  const partitioned = backupWorker.partitionUploadItems([{ size: 9, relativePath: 'protected.txt' }], {
    enabled: true,
    smallFileMaxBytes: 65536
  });
  assert.strictEqual(partitioned.packed.length, 0, 'A lone small file must not use a temporary bundle.');
  assert.strictEqual(partitioned.direct.length, 1, 'A lone small file must upload directly.');
  const batchPartition = backupWorker.partitionUploadItems([
    { size: 9, relativePath: 'one.txt' },
    { size: 12, relativePath: 'two.txt' }
  ], { enabled: true, smallFileMaxBytes: 65536 });
  assert.strictEqual(batchPartition.packed.length, 2, 'Multiple small files should retain the batching optimization.');

  fs.unlinkSync(siblingFile);
  fs.mkdirSync(siblingFile);
  const replacedByDirectoryPlan = planner.planDirtyFolder(secondFolder);
  assert.strictEqual(replacedByDirectoryPlan.sourceUnavailable, true, 'A standalone file replaced by a directory must be disabled safely.');
  assert.strictEqual(replacedByDirectoryPlan.workItems.some(item => item.type === 'upload'), false);
  assert.strictEqual(replacedByDirectoryPlan.workItems.some(item => item.type === 'scan_error'), false);

  db.deactivateMissingSource(firstFolder.id);
  const deactivated = db.getFolders().find(folder => folder.id === firstFolder.id);
  assert.strictEqual(deactivated.enabled, 0, 'A missing standalone source must be disabled after its cloud copy is preserved.');
  assert.strictEqual(deactivated.consecutive_failures, 0);
  assert.strictEqual(deactivated.last_error, '');
  assert.ok(deactivated.missing_source_at);
  assert.ok(first.lastInsertRowid && second.lastInsertRowid);
  console.log('Single-file backup verification passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
