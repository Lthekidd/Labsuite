const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-db-cache-'));
const testDbPath = path.join(dataDir, 'labsuite_db.json');

require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: { app: { getPath: () => dataDir } }
};

// Write initial mock database content
const initialData = {
  folders: [{ id: 1, local_path: 'C:\\test', remote_path: 'gdrive:test', enabled: 1 }],
  backup_manifest: {},
  restore_points: [],
  sync_log: [],
  settings: { sync_interval_minutes: '15' },
  cache: {}
};
fs.writeFileSync(testDbPath, JSON.stringify(initialData, null, 2), 'utf8');

// Spy on fs.readFileSync
let readCount = 0;
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (filePath, encoding) {
  if (filePath === testDbPath) {
    readCount++;
  }
  return originalReadFileSync.apply(this, arguments);
};

// Now import the database module.
// Upon import/initialization, it will call loadDatabase() synchronously and read from disk.
const db = require('../main/database');

// Loading may perform one additional integrity read if default-setting
// migration immediately persists the normalized database.
const readsAfterLoad = readCount;
assert.ok(readsAfterLoad >= 1 && readsAfterLoad <= 2, 'Database startup should use at most two integrity reads.');

// Now let's call several database operations.
const folders = db.getFolders();
assert.deepStrictEqual(folders[0].local_path, 'C:\\test');

const setting = db.getSetting('sync_interval_minutes');
assert.strictEqual(setting, '15');

// None of these subsequent reads should trigger a readFileSync call.
assert.strictEqual(readCount, readsAfterLoad, 'Subsequent reads must not trigger disk reads.');

// Verify that writes STILL write to disk correctly.
db.setSetting('sync_interval_minutes', '30');
assert.strictEqual(db.getSetting('sync_interval_minutes'), '30');

// Read the file directly from disk to verify the write persisted.
const fileContent = JSON.parse(originalReadFileSync(testDbPath, 'utf8'));
assert.strictEqual(fileContent.settings.sync_interval_minutes, '30', 'Writes must persist to disk.');

// Clean up
fs.readFileSync = originalReadFileSync;
try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch (e) {}

console.log('Database cache verification passed.');
