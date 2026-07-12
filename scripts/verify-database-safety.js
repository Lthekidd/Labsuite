const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-db-safety-'));
const dbPath = path.join(tempDir, 'labsuite_db.json');
const backupPath = `${dbPath}.bak`;
const validBackup = {
  folders: [],
  backup_manifest: {},
  restore_points: [],
  sync_log: [],
  settings: { sync_interval_minutes: '15', sentinel: 'recovered' },
  cache: {}
};

fs.writeFileSync(dbPath, '{ corrupt json', 'utf8');
fs.writeFileSync(backupPath, JSON.stringify(validBackup), 'utf8');

require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: { app: { getPath: () => tempDir } }
};

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
console.error = () => {};
console.warn = () => {};

try {
  const db = require('../main/database');
  assert.strictEqual(db.getSetting('sentinel'), 'recovered');
  assert.strictEqual(JSON.parse(fs.readFileSync(dbPath, 'utf8')).settings.sentinel, 'recovered');
  assert.strictEqual(JSON.parse(fs.readFileSync(backupPath, 'utf8')).settings.sentinel, 'recovered');

  const originalRenameSync = fs.renameSync;
  fs.renameSync = function (source, destination) {
    if (destination === dbPath) {
      const error = new Error('simulated disk failure');
      error.code = 'ENOSPC';
      throw error;
    }
    return originalRenameSync.apply(this, arguments);
  };
  try {
    assert.throws(() => db.setSetting('must_not_report_success', '1'), /simulated disk failure/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  console.log('Database safety verification passed.');
} finally {
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  fs.rmSync(tempDir, { recursive: true, force: true });
}
