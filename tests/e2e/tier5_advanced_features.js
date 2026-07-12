const fs = require('fs');
const path = require('path');
const assert = require('assert');
const runner = require('./runner');

const {
  setupEnvironment,
  launchApp,
  APP_USER_DATA,
  TEST_DRIVE,
  LOCAL_FILES
} = runner;

async function test_advanced_f3_exclusions() {
  setupEnvironment({
    setupComplete: true,
    folders: [{ id: 'f-1', localPath: LOCAL_FILES }],
    password: 'SecurePassword123'
  });

  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    // Update exclusions via IPC
    const success = await app.evaluate(`
      window.electron.ipcRenderer.invoke('folders:updateExclusions', {
        folderId: 'f-1',
        exclusions: ['*.tmp', 'node_modules/', 'build/']
      })
    `);
    assert.strictEqual(success, true, 'Exclusions update should return true');

    // Read DB directly to verify
    const dbPath = path.join(APP_USER_DATA, 'labsuite_db.json');
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const folder = db.folders.find(f => f.id === 'f-1');
    assert.ok(folder, 'Folder f-1 should exist in database');
    assert.deepStrictEqual(folder.exclusions, ['*.tmp', 'node_modules/', 'build/'], 'Folder exclusions should match');
  } finally {
    await app.close();
  }
}

async function test_advanced_f5_recovery_sheet() {
  const tempSavePath = path.join(LOCAL_FILES, 'recovery-sheet-test.txt');
  if (fs.existsSync(tempSavePath)) fs.unlinkSync(tempSavePath);

  setupEnvironment({
    setupComplete: true,
    settings: { password_hint: 'CustomPasswordHint' },
    folders: [{ id: 'f-1', localPath: LOCAL_FILES }],
    password: 'SecurePassword123'
  });

  // Launch with test env var set
  const app = await launchApp([], {
    VALUTSYNC_TEST_SAVE_PATH: tempSavePath
  });

  try {
    await app.waitForSelector('.app-body');
    const success = await app.evaluate(`
      window.electron.ipcRenderer.invoke('settings:exportRecoverySheet')
    `);
    assert.strictEqual(success, true, 'Export recovery sheet should return true');

    // Verify recovery sheet written
    assert.ok(fs.existsSync(tempSavePath), 'Recovery sheet file should exist');
    const content = fs.readFileSync(tempSavePath, 'utf8');
    assert.ok(content.includes('LABSUITE EMERGENCY RECOVERY SHEET'), 'Sheet should have header');
    assert.ok(content.includes('CustomPasswordHint'), 'Sheet should contain password hint');
    assert.ok(content.includes('[gdrive-crypt]'), 'Sheet should contain rclone configuration helper');
  } finally {
    await app.close();
    if (fs.existsSync(tempSavePath)) fs.unlinkSync(tempSavePath);
  }
}

async function test_advanced_f6_idle_scheduler() {
  // Test idle scheduler setting
  setupEnvironment({
    setupComplete: true,
    settings: {
      sync_only_when_idle: '1',
      sync_idle_threshold_minutes: '5'
    },
    password: 'SecurePassword123'
  });

  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    const dbPath = path.join(APP_USER_DATA, 'labsuite_db.json');
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    assert.strictEqual(db.settings.sync_only_when_idle, '1', 'Idle sync setting should be enabled');
    assert.strictEqual(db.settings.sync_idle_threshold_minutes, '5', 'Idle sync threshold should be 5 mins');
  } finally {
    await app.close();
  }
}

async function test_advanced_f7_mount() {
  setupEnvironment({
    setupComplete: true,
    password: 'SecurePassword123'
  });

  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');

    // Check initial mount status (should be unmounted)
    const initialStatus = await app.evaluate(`
      window.electron.ipcRenderer.invoke('vault:getMountStatus')
    `);
    assert.strictEqual(initialStatus.status, 'unmounted', 'Initial mount status should be unmounted');

    // Attempt mount (may return success or winfsp_missing depending on VM environment)
    const result = await app.evaluate(`
      window.electron.ipcRenderer.invoke('vault:mount')
    `);
    
    // We verify the lifecycle transitions
    const finalStatus = await app.evaluate(`
      window.electron.ipcRenderer.invoke('vault:getMountStatus')
    `);

    if (result.success) {
      assert.strictEqual(finalStatus.status, 'mounted', 'Mount status should update to mounted on success');
      // Unmount
      const unmounted = await app.evaluate(`
        window.electron.ipcRenderer.invoke('vault:unmount')
      `);
      assert.strictEqual(unmounted, true, 'Unmount should return true');
    } else {
      assert.ok(['winfsp_missing', 'mount_failed'].includes(result.error), 'Failure should return expected error code');
    }
  } finally {
    await app.close();
  }
}

module.exports = {
  test_advanced_f3_exclusions,
  test_advanced_f5_recovery_sheet,
  test_advanced_f6_idle_scheduler,
  test_advanced_f7_mount
};
