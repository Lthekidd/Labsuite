const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const preloadSource = fs.readFileSync(path.join(root, 'main', 'preload.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'main', 'ipc.js'), 'utf8');
const rcloneSource = fs.readFileSync(path.join(root, 'main', 'rclone.js'), 'utf8');
const dbSource = fs.readFileSync(path.join(root, 'main', 'database.js'), 'utf8');
const backupWorkerSource = fs.readFileSync(path.join(root, 'main', 'backupWorker.js'), 'utf8');
const backupUiSource = fs.readFileSync(path.join(root, 'renderer', 'apps', 'LabSuiteBackup.jsx'), 'utf8');

console.log('--- Running LabSuite Storage Retention & Safety Policy Verification ---');

// 1. Database Default Settings Check
assert.ok(dbSource.includes("backup_min_versions_per_file: '2'"), 'Default min versions per file must be 2 (1 recent + 1 old)');
assert.ok(dbSource.includes("backup_version_retention_days: '30'"), 'Default version retention days must be 30');
assert.ok(dbSource.includes("backup_trash_retention_days: '30'"), 'Default trash retention days must be 30');
assert.ok(dbSource.includes("backup_auto_prune_enabled: '1'"), 'Auto prune must be enabled by default');
assert.ok(dbSource.includes("storage_warning_percent: '85'"), 'Storage warning percent must default to 85%');
assert.ok(dbSource.includes("storage_folder_warning_gib: '100'"), 'Folder warning threshold must default to 100 GiB');
console.log('  [PASS] Test Case 1: Database defaults for retention & warnings verified');

// 2. Settings Allowlist Check in ipc.js
const expectedWritableSettings = [
  'backup_version_retention_days',
  'backup_deleted_retention_days',
  'backup_min_versions_per_file',
  'backup_trash_retention_days',
  'backup_auto_prune_enabled',
  'storage_warning_percent',
  'storage_folder_warning_gib',
  'storage_warning_notifications_enabled'
];
for (const s of expectedWritableSettings) {
  assert.ok(ipcSource.includes(`'${s}'`), `ipc.js RENDERER_WRITABLE_SETTINGS must allow setting '${s}'`);
}
console.log('  [PASS] Test Case 2: All retention & alert settings allowed in RENDERER_WRITABLE_SETTINGS');

// 3. Preload and IPC Channel Check
const expectedChannels = [
  'storage:runRetentionPrune',
  'storage:checkAlerts'
];
for (const ch of expectedChannels) {
  assert.ok(preloadSource.includes(`'${ch}'`), `preload.js must allow channel '${ch}'`);
  assert.ok(ipcSource.includes(`ipcMain.handle('${ch}'`), `ipc.js must handle channel '${ch}'`);
}
console.log('  [PASS] Test Case 3: Retention prune and alert IPC channels verified in preload and main');

// 4. Backend rclone.js & storageAlerts.js exports check
const rclone = require('../main/rclone');
assert.strictEqual(typeof rclone.pruneRetention, 'function', 'rclone.pruneRetention must be an exported function');

const storageAlerts = require('../main/storageAlerts');
assert.strictEqual(typeof storageAlerts.checkStorageAlerts, 'function', 'storageAlerts.checkStorageAlerts must be an exported function');
console.log('  [PASS] Test Case 4: rclone.pruneRetention and storageAlerts.checkStorageAlerts exported');

// 5. BackupWorker Max Revisions Logic
assert.ok(backupWorkerSource.includes('minVersions = Number(db.getSetting(\'backup_min_versions_per_file\')) || 2'), 'BackupWorker must default to 2 revisions');
assert.ok(backupWorkerSource.includes('isWithinMaxCount && (isRecent || index === 0)'), 'BackupWorker must cap revisions to max count');
assert.ok(backupWorkerSource.includes('rclone.pruneRetention()'), 'BackupWorker must invoke auto-prune retention');
console.log('  [PASS] Test Case 5: BackupWorker 2-revision cap & auto-prune integration verified');

// 6. UI Controls in LabSuiteBackup.jsx
assert.ok(backupUiSource.includes('Automatic Storage & Retention Policy'), 'UI must render Automatic Storage & Retention Policy card');
assert.ok(backupUiSource.includes('Run Retention Prune Now'), 'UI must include Run Retention Prune Now button');
assert.ok(backupUiSource.includes('Max Revisions per File'), 'UI must include Max Revisions selector');
assert.ok(backupUiSource.includes('Auto-Empty Trash Older Than'), 'UI must include Vault Trash retention selector');
assert.ok(backupUiSource.includes('Storage Warning Triggers'), 'UI must include Storage Warning Triggers section');
assert.ok(backupUiSource.includes('Drive Usage Threshold'), 'UI must include Drive Usage Threshold selector');
assert.ok(backupUiSource.includes('Folder Size Warning'), 'UI must include Folder Size Warning selector');
console.log('  [PASS] Test Case 6: UI retention policy card and controls verified in LabSuiteBackup.jsx');

console.log('=======================================================');
console.log('All Storage Retention & Safety Policy tests PASSED.');
console.log('=======================================================');
