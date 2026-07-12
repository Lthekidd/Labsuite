const fs = require('fs');
const path = require('path');
const assert = require('assert');
const runner = require('./runner');

const {
  setupEnvironment,
  launchApp,
  APP_USER_DATA,
  TEST_DRIVE,
  LOCAL_FILES,
  getStoredPassword
} = runner;

async function test_scenario_1_standard_first_sync() {
  // Scenario 1: Standard First Sync Setup
  setupEnvironment({ setupComplete: false });
  const app = await launchApp();
  try {
    await app.waitForSelector('.onboarding-container');
    // Mock the OAuth connection
    await app.evaluate(`window.electron.ipcRenderer.invoke('settings:set', { key: 'setup_complete', value: '1' })`);
    await app.evaluate(`window.electron.ipcRenderer.invoke('auth:setCryptPassword', { password: 'InitialPassword123', passwordHint: 'hint text' })`);
    
    // Add folder
    await app.evaluate(`window.electron.ipcRenderer.invoke('folders:add', { localPath: ${JSON.stringify(LOCAL_FILES)} })`);

    // Verify DB
    const dbData = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    assert.strictEqual(dbData.settings.setup_complete, '1');
    assert.strictEqual(dbData.folders.length, 1);
    
    const keychainPass = await getStoredPassword();
    assert.strictEqual(keychainPass, 'InitialPassword123');
  } finally {
    await app.close();
  }
}

async function test_scenario_2_multiple_folders_exclusions() {
  // Scenario 2: Multiple Folder Backup & Exclusion
  setupEnvironment({
    setupComplete: true,
    folders: [
      { localPath: path.join(LOCAL_FILES, 'FolderA'), exclusions: ['*.log', '**/node_modules/**'] }
    ],
    password: 'Password123'
  });

  const folderA = path.join(LOCAL_FILES, 'FolderA');
  fs.mkdirSync(folderA, { recursive: true });
  fs.writeFileSync(path.join(folderA, 'app.js'), 'console.log("hello");', 'utf8');
  fs.writeFileSync(path.join(folderA, 'error.log'), 'error here', 'utf8');
  fs.mkdirSync(path.join(folderA, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(folderA, 'node_modules', 'dep.js'), 'dependency code', 'utf8');

  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    // Run full sync
    await app.evaluate(`window.electron.ipcRenderer.invoke('sync:triggerNow')`);
    // Poll until sync completes (folder.sync_state is no longer 'syncing' or 'preparing')
    for (let i = 0; i < 40; i++) {
      await app.wait(200);
      const folders = await app.evaluate(`window.electron.ipcRenderer.invoke('folders:list')`);
      const active = folders.some(f => f.sync_state === 'syncing' || f.sync_state === 'preparing');
      if (!active) break;
    }

    // Check remote (TEST_DRIVE)
    // The crypt remote encrypts paths, but we can verify via rclone or the decrypted files
    // Let's check using restore list
    const remoteItems = await app.evaluate(`window.electron.ipcRenderer.invoke('restore:listRemote', { remotePath: 'computers/PC/FolderA' })`);
    
    // app.js should exist, but error.log and node_modules should not
    const names = remoteItems.map(item => item.Name);
    assert.ok(names.includes('app.js'), 'app.js should be synced');
    assert.ok(!names.includes('error.log'), 'error.log should be excluded');
    assert.ok(!names.includes('node_modules'), 'node_modules should be excluded');
  } finally {
    await app.close();
  }
}

async function test_scenario_3_backup_metadata_restore() {
  // Scenario 3: Backup, Password Hint Update & Restore
  setupEnvironment({
    setupComplete: true,
    folders: [{ localPath: LOCAL_FILES }],
    settings: { pack_small_files_enabled: '0' },
    password: 'SecretPassword'
  });

  // Create file to backup
  fs.writeFileSync(path.join(LOCAL_FILES, 'secret.txt'), 'top secret file content', 'utf8');

  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    // Sync file
    await app.evaluate(`window.electron.ipcRenderer.invoke('sync:triggerNow')`);
    // Poll until sync completes (folder.sync_state is no longer 'syncing' or 'preparing')
    for (let i = 0; i < 40; i++) {
      await app.wait(200);
      const folders = await app.evaluate(`window.electron.ipcRenderer.invoke('folders:list')`);
      const active = folders.some(f => f.sync_state === 'syncing' || f.sync_state === 'preparing');
      if (!active) break;
    }

    // Update password hint in settings
    await app.evaluate(`window.electron.ipcRenderer.invoke('settings:set', { key: 'password_hint', value: 'new hint value' })`);
    await app.wait(500);

    // Verify metadata updated on remote
    const metadata = await app.evaluate(`window.electron.ipcRenderer.invoke('vault:metadata')`);
    assert.strictEqual(metadata.passwordHint, 'new hint value');

    // Restore to destination
    const restoreDest = path.join(LOCAL_FILES, 'restore_destination');
    fs.mkdirSync(restoreDest, { recursive: true });

    await app.evaluate(`window.electron.ipcRenderer.invoke('restore:start', {
      remotePath: 'computers/PC/temp_local_files/secret.txt',
      localDestination: ${JSON.stringify(restoreDest)}
    })`);
    
    // Verify file content restored with polling
    const restoredFilePath = path.join(restoreDest, 'secret.txt');
    let restored = false;
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(restoredFilePath)) {
        restored = true;
        break;
      }
      await app.wait(200);
    }
    assert.ok(restored, 'Restored file should exist');
    const content = fs.readFileSync(restoredFilePath, 'utf8');
    assert.strictEqual(content, 'top secret file content', 'Content of restored file should match');
  } finally {
    await app.close();
  }
}

async function test_scenario_4_caching_load() {
  // Scenario 4: Startup caching check under load
  // Launch and close the app 3 times in a row, checking database stability
  for (let i = 0; i < 3; i++) {
    setupEnvironment({ setupComplete: true, settings: { iteration: String(i) } });
    const app = await launchApp();
    try {
      await app.waitForSelector('.app-body');
      const settings = await app.evaluate(`window.electron.ipcRenderer.invoke('settings:get')`);
      assert.strictEqual(settings.iteration, String(i), `Setting load check on launch ${i}`);
    } finally {
      await app.close();
    }
  }
}

async function test_scenario_5_interrupted_sync_reauth() {
  // Scenario 5: Interrupted Sync and Re-auth
  setupEnvironment({
    setupComplete: true,
    folders: [{ localPath: LOCAL_FILES }],
    password: 'PasswordOne'
  });

  const app = await launchApp();
  try {
    // Perform sign out (wipe all)
    await app.evaluate(`window.electron.ipcRenderer.invoke('auth:disconnect')`);
    await app.wait(300);

    // Verify everything is wiped
    const stored = await getStoredPassword();
    assert.strictEqual(stored, null, 'Keychain password should be wiped after disconnect');

    // Onboard with new password
    fs.writeFileSync(path.join(APP_USER_DATA, 'rclone.conf'), `[gdrive]
type = alias
remote = ${TEST_DRIVE.replace(/\\/g, '/')}
`, 'utf8');
    await app.evaluate(`window.electron.ipcRenderer.invoke('settings:set', { key: 'setup_complete', value: '1' })`);
    await app.evaluate(`window.electron.ipcRenderer.invoke('auth:setCryptPassword', { password: 'NewPasswordTwo', passwordHint: 'two' })`);
    await app.evaluate(`window.electron.ipcRenderer.invoke('folders:add', { localPath: ${JSON.stringify(LOCAL_FILES)} })`);

    // Verify new password is set
    const stored2 = await getStoredPassword();
    assert.strictEqual(stored2, 'NewPasswordTwo');
  } finally {
    await app.close();
  }
}

module.exports = {
  test_scenario_1_standard_first_sync,
  test_scenario_2_multiple_folders_exclusions,
  test_scenario_3_backup_metadata_restore,
  test_scenario_4_caching_load,
  test_scenario_5_interrupted_sync_reauth
};
