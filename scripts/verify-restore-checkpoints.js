const assert = require('assert');
const fs = require('fs');
const path = require('path');

const databasePath = require.resolve('../main/database');
const plannerPath = require.resolve('../main/restorePlanner');
const targetTime = '2026-07-10T12:00:00.000Z';

require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: {
    getFolders: () => [{ id: 42, local_path: 'C:\\Protected' }],
    getRestorePoints: () => [{ folder_id: '42', folder_path: 'C:\\Protected' }],
    getManifestEntries: folderId => {
      assert.strictEqual(String(folderId), '42');
      return {
        'Documents\\report.txt': {
          relative_path: 'Documents\\report.txt',
          remote_path: 'computers/PC/C/Protected/Documents/report.txt',
          last_backed_up_at: '2026-07-10T11:00:00.000Z',
          size: 123
        }
      };
    }
  }
};

delete require.cache[plannerPath];
const restorePlanner = require('../main/restorePlanner');
const plan = restorePlanner.planPointInTimeRestore('42', targetTime);
assert.strictEqual(plan.totalFiles, 1, 'string checkpoint IDs must match numeric folder IDs');
assert.strictEqual(plan.files[0].relativePath, 'Documents\\report.txt');

const ipcSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc.js'), 'utf8');
assert.ok(
  !ipcSource.includes("db.getFolders().find(f => f.id === folderId);\n    if (!folder) return [];"),
  'snapshot browsing must not reject imported checkpoints before the restore planner can resolve them'
);
assert.ok(
  ipcSource.includes("replace(/\\\\/g, '/')"),
  'snapshot paths must be normalized for the slash-based browser'
);
assert.ok(
  ipcSource.includes('remotePath: file.remotePath'),
  'snapshot files must retain the encrypted remote path needed for restore'
);

const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'apps', 'LabSuiteBackup.jsx'), 'utf8');
assert.ok(
  /remotePath:\s*item\.remotePath,\s*localDestination:\s*dest/.test(rendererSource),
  'single-file checkpoint restore must use the planned encrypted remote path'
);

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'backupWorker.js'), 'utf8');
assert.ok(
  /if \(!dirtyOnly\) \{\s*db\.addRestorePoint\(\{/.test(workerSource),
  'unchanged dirty-only scans must not create duplicate checkpoint dates'
);

console.log('Restore checkpoint verification passed.');
