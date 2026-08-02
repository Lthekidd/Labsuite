const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rclone = require('../main/rclone');

assert.strictEqual(rclone.UNIFIED_CLOUD_ROOT, "LABSUITE - DON'T DELETE");
assert.strictEqual(rclone.ENCRYPTED_FOLDER, "LABSUITE - DON'T DELETE/Encrypted");
assert.strictEqual(rclone.APPS_FOLDER, "LABSUITE - DON'T DELETE/Apps");
assert.strictEqual(rclone.CONTROL_FOLDER, "LABSUITE - DON'T DELETE/Control");

const rcloneSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'rclone.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'index.js'), 'utf8');

for (const legacyRoot of [
  'VaultSync-Encrypted',
  'LabSuite-Encrypted',
  'VaultSync-Control',
  'LabSuite-Control',
  'VaultSync-Apps',
  'LabSuite-Apps'
]) {
  assert.ok(rcloneSource.includes(legacyRoot), `Migration must recognize ${legacyRoot}.`);
}

assert.ok(rcloneSource.includes('DONT DELETE - LABSUITE DATA.txt'), 'Unified root must contain a visible warning note.');
assert.ok(rcloneSource.includes("'moveto'"), 'Whole legacy roots should be moved server-side when possible.');
assert.ok(rcloneSource.includes("'--delete-empty-src-dirs'"), 'Merged legacy roots should be removed after migration.');
const moveBeforeConfig = rcloneSource.indexOf('await moveRawTreeInto(configuredEncryptedFolder, ENCRYPTED_FOLDER)');
const configAfterMove = rcloneSource.indexOf('writeRcloneConfigAtomically(configPath, updatedConfig)', moveBeforeConfig);
assert.ok(moveBeforeConfig >= 0 && configAfterMove > moveBeforeConfig, 'Encrypted data must move before the crypt config switches paths.');
assert.ok(rcloneSource.includes('for (const source of [LEGACY_ENCRYPTED_FOLDER, PREVIOUS_ENCRYPTED_FOLDER])'), 'Interrupted encrypted-root moves must be retried.');

const migrationIndex = indexSource.indexOf('ensureUnifiedCloudLayout()');
const watcherIndex = indexSource.indexOf('watcher.initWatcher();', migrationIndex);
assert.ok(migrationIndex >= 0 && watcherIndex > migrationIndex, 'Cloud migration must finish before backup watching starts.');

console.log('Unified cloud layout verification passed.');
