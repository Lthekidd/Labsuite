const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-restore-activity-'));
  const testDbPath = path.join(dataDir, 'labsuite_db.json');

  require.cache[require.resolve('electron')] = {
    id: 'electron',
    filename: 'electron',
    loaded: true,
    exports: { app: { getPath: () => dataDir } }
  };

  fs.writeFileSync(testDbPath, JSON.stringify({
    folders: [],
    backup_manifest: {},
    restore_points: [],
    sync_log: [],
    active_restores: [],
    settings: {},
    cache: {}
  }), 'utf8');

  const db = require('../main/database');
  const started = db.upsertActiveRestore({
    id: 'restore-test',
    remotePath: 'computers/PC/Documents',
    localDestination: 'D:\\Recovered',
    label: 'Documents',
    status: 'restoring',
    filesDone: 2,
    filesTotal: 10,
    bytesDone: 200,
    bytesTotal: 1000,
    speed: 50
  });

  const progressed = db.upsertActiveRestore({
    id: started.id,
    bytesDone: 500,
    speed: 75,
    status: 'restoring'
  });

  assert.strictEqual(progressed.remotePath, started.remotePath, 'partial checkpoints must preserve the remote path');
  assert.strictEqual(progressed.localDestination, started.localDestination, 'partial checkpoints must preserve the destination');
  assert.strictEqual(progressed.label, 'Documents', 'partial checkpoints must preserve the display label');
  assert.strictEqual(progressed.filesDone, 2, 'omitted counters must not be reset');
  assert.strictEqual(progressed.filesTotal, 10, 'omitted totals must not be reset');
  assert.strictEqual(progressed.bytesDone, 500, 'provided counters must update');
  assert.strictEqual(progressed.bytesTotal, 1000, 'omitted byte totals must not be reset');
  assert.strictEqual(progressed.startedAt, started.startedAt, 'resume checkpoints must retain the original start time');

  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'apps', 'LabSuiteBackup.jsx'), 'utf8');
  assert.ok(
    rendererSource.includes("listen('backup:file-activity-batch'"),
    'the Activity panel must consume batched backup activity'
  );
  assert.ok(
    rendererSource.includes("listen('restore:activity-update'"),
    'the Activity panel must consume restore activity'
  );
  assert.ok(
    rendererSource.includes('ipcRenderer.removeListener(channel, handler)'),
    'the Activity panel must remove only the listeners it registered'
  );
  assert.ok(
    rendererSource.includes("'restoring', 'interrupted'"),
    'live restore states must be included in the unified activity list'
  );

  const ipcSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc.js'), 'utf8');
  assert.ok(
    ipcSource.includes("if (job.status === 'restoring') return { ...job, status: 'interrupted', speed: 0 }"),
    'a stale persisted restore must not be reported as currently running after restart'
  );
  assert.ok(
    ipcSource.includes('now - previous < 5000'),
    'restore checkpoints should be throttled to avoid rewriting a large catalog every second'
  );

  await db.flushWritesAsync();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('Restore activity verification passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
