const assert = require('assert');

const db = require('../main/database');
const rclone = require('../main/rclone');
const backupWorker = require('../main/backupWorker');

async function run() {
  const fakeRegistry = new Map();
  let backupKills = 0;
  let restoreKills = 0;
  const backupProcess = {
    operation: 'backup',
    cancelled: false,
    proc: { kill: () => { backupKills += 1; } }
  };
  const restoreProcess = {
    operation: 'restore',
    cancelled: false,
    proc: { kill: () => { restoreKills += 1; } }
  };
  fakeRegistry.set('backup', backupProcess);
  fakeRegistry.set('restore', restoreProcess);

  const cancelled = rclone.__private.cancelOperationInRegistry(
    fakeRegistry,
    'backup',
    'Backup paused by test'
  );
  assert.strictEqual(cancelled, 1, 'pause must cancel the active backup process');
  assert.strictEqual(backupKills, 1, 'the backup process must be terminated');
  assert.strictEqual(restoreKills, 0, 'pausing backups must not terminate a restore');
  assert.strictEqual(backupProcess.cancelled, true);
  assert.strictEqual(backupProcess.cancelReason, 'Backup paused by test');
  assert.strictEqual(restoreProcess.cancelled, false);

  assert.strictEqual(
    rclone.runWithOperation('backup', () => rclone.__private.getCurrentOperation()),
    'backup',
    'backup rclone calls must inherit the backup operation scope'
  );
  assert.strictEqual(rclone.__private.getCurrentOperation(), 'general');
  assert.ok(rclone.isOperationCancelledError({ code: 'ERR_RCLONE_OPERATION_CANCELLED' }));

  const original = {
    isRunning: backupWorker.isRunning,
    activeRun: backupWorker.activeRun,
    dirtyFolders: backupWorker.dirtyFolders,
    timer: backupWorker.timer,
    firstDirtyAt: backupWorker.firstDirtyAt,
    pausedRunRequest: backupWorker.pausedRunRequest,
    resumeAfterStop: backupWorker.resumeAfterStop,
    cancelOperation: rclone.cancelOperation,
    getEnabledFolders: db.getEnabledFolders,
    getSetting: db.getSetting
  };

  try {
    let cancelledOperation = null;
    rclone.cancelOperation = (operation, reason) => {
      cancelledOperation = { operation, reason };
      return 2;
    };
    db.getEnabledFolders = () => [];

    backupWorker.isRunning = true;
    backupWorker.activeRun = { cancelRequested: false, cancelReason: '' };
    backupWorker.dirtyFolders = new Set([42]);
    backupWorker.timer = null;

    const result = backupWorker.stopBackup('Backup paused by user');
    assert.strictEqual(
      backupWorker.isRunning,
      true,
      'pause must keep the worker locked until the active run unwinds'
    );
    assert.strictEqual(backupWorker.activeRun.cancelRequested, true);
    assert.strictEqual(backupWorker.activeRun.cancelReason, 'Backup paused by user');
    assert.deepStrictEqual(cancelledOperation, {
      operation: 'backup',
      reason: 'Backup paused by user'
    });
    assert.strictEqual(result.cancelledProcesses, 2);
    assert.ok(
      backupWorker.dirtyFolders.has(42),
      'queued dirty folders must survive pause so resume can continue them'
    );
    assert.throws(
      () => backupWorker.rethrowIfCancelled(new Error('transfer stopped')),
      error => error && error.code === 'ERR_BACKUP_PAUSED',
      'cancelled transfers must unwind as a pause, not a backup failure'
    );

    backupWorker.isRunning = false;
    backupWorker.activeRun = null;
    db.getSetting = key => (key === 'sync_paused' ? '1' : original.getSetting(key));
    assert.strictEqual(
      await backupWorker.runBackup(null, { manual: true }),
      false,
      'manual runs must not bypass an explicit user pause'
    );
  } finally {
    backupWorker.isRunning = original.isRunning;
    backupWorker.activeRun = original.activeRun;
    backupWorker.dirtyFolders = original.dirtyFolders;
    backupWorker.timer = original.timer;
    backupWorker.firstDirtyAt = original.firstDirtyAt;
    backupWorker.pausedRunRequest = original.pausedRunRequest;
    backupWorker.resumeAfterStop = original.resumeAfterStop;
    rclone.cancelOperation = original.cancelOperation;
    db.getEnabledFolders = original.getEnabledFolders;
    db.getSetting = original.getSetting;
  }

  console.log('Backup pause verification passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
