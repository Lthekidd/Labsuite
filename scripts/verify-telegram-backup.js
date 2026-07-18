const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../main/database');
const telegramBackup = require('../main/telegramBackup');

// Initialize database in a temporary location
const tempDbPath = path.join(os.tmpdir(), `labsuite_test_db_${Date.now()}.json`);
db.initDatabase(tempDbPath);

console.log('Running Telegram Backup backend verification tests...');

// 1. Verify Database Operations
console.log('Testing Database operations...');
const initialInstalls = db.getTelegramInstalls();
assert.ok(Array.isArray(initialInstalls), 'getTelegramInstalls should return an array');

const tdataPath = path.join(os.tmpdir(), `tdata_mock_${Date.now()}`);
fs.mkdirSync(tdataPath, { recursive: true });

// Create key_datas to simulate an account
fs.writeFileSync(path.join(tdataPath, 'key_datas'), 'mock_key_data_content');

const install = db.addTelegramInstall(
  'Test Telegram Account',
  tdataPath,
  1,
  'TelegramBackup/TEST-PC/tdata'
);

assert.strictEqual(install.label, 'Test Telegram Account');
assert.strictEqual(install.tdata_path, tdataPath);
assert.strictEqual(install.account_count, 1);
assert.strictEqual(install.enabled, true);
assert.strictEqual(install.schedule, 'daily');

const expectedTempDestination = path.join(os.tmpdir(), 'LabSuite_Temp', `telegram_${install.id}`);
assert.strictEqual(
  telegramBackup.getTelegramTempDestination(install.id),
  expectedTempDestination,
  'Telegram staging must use this PC\'s local temp directory, not a configured backup source drive'
);

const missingTempRoot = path.join(os.tmpdir(), `labsuite_missing_temp_root_${Date.now()}`);
const nestedTempDestination = telegramBackup.getTelegramTempDestination(install.id, missingTempRoot);
fs.mkdirSync(nestedTempDestination, { recursive: true });
assert.ok(fs.existsSync(nestedTempDestination), 'Telegram staging must support a missing temp parent directory');
fs.rmSync(missingTempRoot, { recursive: true, force: true });

const updated = db.updateTelegramInstall(install.id, {
  label: 'Updated Label',
  enabled: false,
  schedule: 'weekly'
});

assert.strictEqual(updated.label, 'Updated Label');
assert.strictEqual(updated.enabled, false);
assert.strictEqual(updated.schedule, 'weekly');

// 2. Test Account Detection
console.log('Testing Account detection...');
const count1 = telegramBackup.detectAccounts(tdataPath);
assert.strictEqual(count1, 1, `Expected 1 account, got ${count1}`);

// Add a settings_01 directory to simulate a second account
const settingsPath = path.join(tdataPath, 'settings_01');
fs.mkdirSync(settingsPath, { recursive: true });
fs.writeFileSync(path.join(settingsPath, 'key_datas'), 'mock_key_data_content');

const count2 = telegramBackup.detectAccounts(tdataPath);
assert.strictEqual(count2, 2, `Expected 2 accounts, got ${count2}`);

// 3. Test remove
db.removeTelegramInstall(install.id);
const listAfterRemove = db.getTelegramInstalls();
assert.ok(!listAfterRemove.some(i => i.id === install.id), 'Telegram install should be removed from database');

// Cleanup
try {
  fs.rmSync(tdataPath, { recursive: true, force: true });
  if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  if (fs.existsSync(tempDbPath + '.bak')) fs.unlinkSync(tempDbPath + '.bak');
} catch (_) {}

console.log('Telegram Backup backend verification tests passed successfully!');
