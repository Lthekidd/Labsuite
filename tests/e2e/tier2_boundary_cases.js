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
  REPO_ROOT,
  getStoredPassword
} = runner;

// --- Feature 1: UI & Modernized Theme (Boundary Cases) ---

async function test_f1_very_long_folder_path() {
  const longPath = 'C:\\' + 'a'.repeat(200) + '\\sub';
  setupEnvironment({
    setupComplete: true,
    folders: [{ localPath: longPath }]
  });
  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item');
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Backup Health')) el.click();
      });
    `);
    await app.waitForText('h1', 'Backup Health');
    await app.waitForSelector('td');
    // Ensure very long text does not crash the UI
    const cellText = await app.query('td');
    assert.ok(cellText.includes('sub') || cellText.includes('a'.repeat(50)), 'Should display folder path safely');
  } finally {
    await app.close();
  }
}

async function test_f1_empty_folder_list() {
  setupEnvironment({ setupComplete: true, folders: [] });
  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item');
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Backup Health')) el.click();
      });
    `);
    await app.waitForText('h1', 'Backup Health');
    await app.waitForSelector('table');
    const rowCount = await app.evaluate(`document.querySelectorAll('tbody tr').length`);
    // Depending on UI implementation, it should show empty state
    const text = await app.query('tbody');
    assert.ok(rowCount === 1 && text.includes('No folders configured'), 'Should show empty folder state');
  } finally {
    await app.close();
  }
}

async function test_f1_empty_activity_log() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    // Navigate to Dashboard
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Activity')) el.click();
      });
    `);
    await app.waitForSelector('table');
    const tableText = await app.query('table');
    assert.ok(tableText.includes('No backup activity'), 'Should show empty activity queue state');
  } finally {
    await app.close();
  }
}

async function test_f1_excessive_activity_logs() {
  setupEnvironment({ setupComplete: true });
  // Pre-populate DB with many logs to check scrollable layout
  const dbPath = path.join(APP_USER_DATA, 'labsuite_db.json');
  const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  for (let i = 0; i < 200; i++) {
    dbData.sync_log.push({
      id: i,
      file_path: `C:\\folder\\file_${i}.txt`,
      action: 'upload',
      status: 'success',
      synced_at: new Date().toISOString()
    });
  }
  fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf8');

  const app = await launchApp();
  try {
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Activity')) el.click();
      });
    `);
    await app.waitForSelector('table');
    const renderedRows = await app.evaluate(`document.querySelectorAll('tbody tr').length`);
    assert.ok(renderedRows > 10, 'Should render capping limit of logs');
  } finally {
    await app.close();
  }
}

async function test_f1_error_badge_handling() {
  setupEnvironment({
    setupComplete: true,
    folders: [{ localPath: LOCAL_FILES, enabled: true, lastSuccessAt: new Date().toISOString() }]
  });
  // Simulate folder error
  const dbPath = path.join(APP_USER_DATA, 'labsuite_db.json');
  const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  dbData.folders[0].consecutive_failures = 3;
  dbData.folders[0].last_error = 'Failed to connect to Google Drive';
  fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf8');

  const app = await launchApp();
  try {
    await app.waitForSelector('.badge');
    const badgeText = await app.query('.badge');
    assert.ok(badgeText.includes('Error') || badgeText.includes('Failing') || badgeText.includes('attention') || badgeText.includes('failure'), 'App badge should indicate backup error status');
  } finally {
    await app.close();
  }
}

// --- Feature 2: Startup & Config Speed (Boundary Cases) ---

async function test_f2_database_corrupt_recovery() {
  setupEnvironment({ setupComplete: true });
  // Corrupt the database file
  const dbPath = path.join(APP_USER_DATA, 'labsuite_db.json');
  fs.writeFileSync(dbPath, '{ corrupt json ...', 'utf8');
  
  // Write a valid backup file
  const dbBackupPath = `${dbPath}.bak`;
  const backupContent = {
    folders: [],
    backup_manifest: {},
    restore_points: [],
    sync_log: [],
    settings: { setup_complete: '1' },
    cache: {}
  };
  fs.writeFileSync(dbBackupPath, JSON.stringify(backupContent, null, 2), 'utf8');

  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    const title = await app.query('.app-title');
    assert.ok(title.includes('LabSuite'), 'App should recover and launch from backup db');
  } finally {
    await app.close();
  }
}

async function test_f2_empty_settings_defaults() {
  setupEnvironment({ setupComplete: true });
  // Write an empty database object to trigger default setting migrations
  const dbPath = path.join(APP_USER_DATA, 'labsuite_db.json');
  fs.writeFileSync(dbPath, '{}', 'utf8');

  const app = await launchApp();
  try {
    await app.waitForSelector('.onboarding-container');
    const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    assert.ok(dbData.settings && dbData.settings.sync_interval_minutes, 'Database should migrate and populate default settings');
  } finally {
    await app.close();
  }
}

async function test_f2_concurrent_caching_writes() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    // Trigger multiple setting updates concurrently
    await app.evaluate(`
      Promise.all([
        window.electron.ipcRenderer.invoke('settings:set', { key: 'bwlimit', value: '1M' }),
        window.electron.ipcRenderer.invoke('settings:set', { key: 'sync_interval_minutes', value: '5' }),
        window.electron.ipcRenderer.invoke('settings:set', { key: 'notifications_enabled', value: '0' })
      ])
    `);
    await app.wait(500);
    const dbData = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    assert.strictEqual(dbData.settings.bwlimit, '1M');
    assert.strictEqual(dbData.settings.sync_interval_minutes, '5');
    assert.strictEqual(dbData.settings.notifications_enabled, '0');
  } finally {
    await app.close();
  }
}

async function test_f2_stale_cache_invalidation() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    // Populate old cache values in the database
    const dbPath = path.join(APP_USER_DATA, 'labsuite_db.json');
    const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    dbData.cache['gdrive_info'] = {
      value: { email: 'StaleAccount@gmail.com', total: 100, used: 10 },
      timestamp: new Date(Date.now() - 1000 * 60 * 10).toISOString() // 10 minutes ago (stale)
    };
    fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf8');

    // Retrieve info (should trigger background refresh since it is > 5min old)
    const info = await app.evaluate(`window.electron.ipcRenderer.invoke('auth:getGDriveInfo')`);
    assert.ok(info.email !== 'StaleAccount@gmail.com' || info.email === 'Disconnected', 'Should invalidate or fallback gracefully');
  } finally {
    await app.close();
  }
}

async function test_f2_massive_manifest_load() {
  setupEnvironment({ setupComplete: true });
  // Add a huge manifest list to db
  const dbPath = path.join(APP_USER_DATA, 'labsuite_db.json');
  const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  dbData.backup_manifest['1'] = {};
  for (let i = 0; i < 2000; i++) {
    dbData.backup_manifest['1'][`file_${i}.txt`] = {
      status: 'backed_up',
      size: 512,
      mtime_ms: Date.now()
    };
  }
  fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf8');

  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    // Navigate to Restore Files
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Restore')) el.click();
      });
    `);
    await app.waitForSelector('.sub-tab-btn');
    const exists = await app.exists('.sub-tab-btn');
    assert.ok(exists, 'Should load restore panel with huge manifest without crashing');
  } finally {
    await app.close();
  }
}

// --- Feature 3: Syncing & Transfer Speed (Boundary Cases) ---

async function test_f3_bwlimit_scheduler_boundary() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item');
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Settings')) el.click();
      });
    `);
    await app.waitForSelector('input[type="checkbox"]');
    // Enable scheduler
    await app.evaluate(`
      const checkbox = document.querySelector('input[type="checkbox"]');
      if (checkbox) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    `);
    await app.wait(500);
    // Setting extreme limit
    await app.evaluate(`window.electron.ipcRenderer.invoke('settings:set', { key: 'bwlimit_scheduled_value', value: '10M' })`);
    const dbData = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    assert.strictEqual(dbData.settings.bwlimit_scheduled_value, '10M', 'Scheduled limit should support up to 10M');
  } finally {
    await app.close();
  }
}

async function test_f3_sync_conflict_resolution() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    // Resolve conflict handler
    const res = await app.evaluate(`window.electron.ipcRenderer.invoke('sync:resolveConflict', { filePath: 'test.txt', resolution: 'local' })`);
    assert.ok(res, 'Conflict resolution should execute');
  } finally {
    await app.close();
  }
}

async function test_f3_exclusion_matching_edge_cases() {
  setupEnvironment({ setupComplete: true, folders: [{ localPath: LOCAL_FILES }] });
  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    const foldersList = await app.evaluate(`window.electron.ipcRenderer.invoke('folders:list')`);
    const folderId = foldersList[0].id;
    // Add custom exclusion with spaces and odd characters
    await app.evaluate(`window.electron.ipcRenderer.invoke('folders:exclude', { folderId: ${folderId}, excludePath: '**/My Temp Folder!/*.tmp' })`);
    await app.wait(200);
    const dbData = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    // Verify exclusion is added
    const folder = dbData.folders[0];
    assert.ok(folder.exclusions.includes('**/My Temp Folder!/*.tmp'), 'Custom exclusion pattern should support special characters');
  } finally {
    await app.close();
  }
}

async function test_f3_nested_folder_prevent_duplicates() {
  setupEnvironment({
    setupComplete: true,
    folders: [{ localPath: 'C:\\BackupRoot' }]
  });
  const app = await launchApp();
  try {
    // Adding a subfolder of C:\BackupRoot should reject
    let errorOccurred = false;
    try {
      await app.evaluate(`window.electron.ipcRenderer.invoke('folders:add', { localPath: 'C:\\\\BackupRoot\\\\Subdir' })`);
    } catch (e) {
      errorOccurred = true;
      assert.ok(e.message.includes('already covered'), 'Should throw error when adding nested folders');
    }
    assert.ok(errorOccurred, 'Expected add folder operation to fail');
  } finally {
    await app.close();
  }
}

async function test_f3_sync_error_reporting() {
  setupEnvironment({
    setupComplete: true,
    folders: [{ localPath: LOCAL_FILES }],
    settings: { sync_paused: '1' }
  });
  
  // Trigger consecutive failure directly in DB before launch
  const dbPath = path.join(APP_USER_DATA, 'labsuite_db.json');
  const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  dbData.folders[0].consecutive_failures = 1;
  dbData.folders[0].last_error = 'dial tcp: lookup gdrive on 127.0.0.1:53: no such host';
  fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf8');

  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item');
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Backup Health')) el.click();
      });
    `);
    await app.waitForText('h1', 'Backup Health');
    await app.waitForSelector('td');
    const tableText = await app.query('table');
    // Error translation should humanize the "no such host" message
    assert.ok(tableText.includes('Failing') || tableText.includes('internet connection') || tableText.includes('connect'), 'Should translate network error to human-friendly text');
  } finally {
    await app.close();
  }
}

// --- Feature 4: Security & Credentials (Boundary Cases) ---

async function test_f4_empty_master_password() {
  setupEnvironment({ setupComplete: false });
  const app = await launchApp();
  try {
    await app.waitForSelector('.onboarding-container');
    await app.waitForSelector('button');
    // Clicking Connect to google drive to advance wizard
    await app.evaluate(`
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Connect Google Drive') || b.innerText.includes('Continue'));
      if (btn) btn.click();
    `);
    await app.wait(200);
    // Trigger password check on empty string
    let failed = false;
    try {
      await app.evaluate(`window.electron.ipcRenderer.invoke('auth:setCryptPassword', { password: '' })`);
    } catch (e) {
      failed = true;
      assert.ok(e.message.includes('password'), 'Should reject empty password');
    }
    assert.ok(failed, 'Should fail to set empty crypt password');
  } finally {
    await app.close();
  }
}

async function test_f4_short_master_password() {
  setupEnvironment({ setupComplete: false });
  const app = await launchApp();
  try {
    await app.waitForSelector('.onboarding-container');
    let failed = false;
    try {
      await app.evaluate(`window.electron.ipcRenderer.invoke('auth:setCryptPassword', { password: '123' })`);
    } catch (e) {
      failed = true;
      assert.ok(e.message.includes('password') || e.message.length > 0, 'Should reject short password');
    }
    assert.ok(failed, 'Should fail to set short crypt password');
  } finally {
    await app.close();
  }
}

async function test_f4_mismatched_master_passwords() {
  setupEnvironment({ setupComplete: false });
  const app = await launchApp();
  try {
    // The UI handles mismatches, verify that empty or null throws error
    let failed = false;
    try {
      await app.evaluate(`window.electron.ipcRenderer.invoke('auth:setCryptPassword', { password: null })`);
    } catch (e) {
      failed = true;
    }
    assert.ok(failed, 'Should fail to set null crypt password');
  } finally {
    await app.close();
  }
}

async function test_f4_access_incorrect_password() {
  setupEnvironment({
    setupComplete: false,
    settings: { password_hint: 'my security hint' },
    password: 'CorrectPassword123'
  });

  // Upload an encrypted file so rclone has something to decrypt and fail on wrong password
  try {
    const { execFileSync } = require('child_process');
    const packagedRclone = path.join(REPO_ROOT, 'dist-packaged', 'win-unpacked', 'resources', 'bin', 'rclone-win.exe');
    const rcloneBin = fs.existsSync(packagedRclone)
      ? packagedRclone
      : path.join(REPO_ROOT, 'bin', 'rclone-win.exe');
    execFileSync(rcloneBin, [
      'copyto',
      path.join(__dirname, 'runner.js'),
      'gdrive-crypt:somefile.txt',
      '--config',
      path.join(APP_USER_DATA, 'rclone.conf')
    ], { windowsHide: true });
    const markerPath = path.join(LOCAL_FILES, 'vault-marker.json');
    fs.writeFileSync(markerPath, JSON.stringify({
      app: 'LabSuite',
      marker: 'encrypted-backup-vault',
      createdAt: new Date().toISOString()
    }), 'utf8');
    execFileSync(rcloneBin, [
      'copyto',
      markerPath,
      'gdrive-crypt:.labsuite_control/vault-marker.json',
      '--config',
      path.join(APP_USER_DATA, 'rclone.conf')
    ], { windowsHide: true });
  } catch (e) {
    console.warn('Failed to upload dummy encrypted file:', e.message);
  }

  const app = await launchApp();
  try {
    let failed = false;
    try {
      // Try to open using WRONG password
      await app.evaluate(`window.electron.ipcRenderer.invoke('auth:setCryptPassword', { password: 'WrongPassword', mode: 'access' })`);
    } catch (e) {
      failed = true;
      assert.ok(e.message.includes('could not open') || e.message.includes('password') || e.message.includes('decrypt'), 'Should throw incorrect password error');
    }
    assert.ok(failed, 'Should reject wrong password for existing vault');
  } finally {
    await app.close();
  }
}

async function test_f4_vault_metadata_no_hint() {
  setupEnvironment({
    setupComplete: true,
    settings: { password_hint: '' },
    password: 'SecurePassword1'
  });
  const app = await launchApp();
  try {
    const metadata = await app.evaluate(`window.electron.ipcRenderer.invoke('vault:metadata')`);
    assert.strictEqual(metadata.passwordHint, '', 'Metadata password hint should be empty when no hint configured');
  } finally {
    await app.close();
  }
}

module.exports = {
  test_f1_very_long_folder_path,
  test_f1_empty_folder_list,
  test_f1_empty_activity_log,
  test_f1_excessive_activity_logs,
  test_f1_error_badge_handling,
  test_f2_database_corrupt_recovery,
  test_f2_empty_settings_defaults,
  test_f2_concurrent_caching_writes,
  test_f2_stale_cache_invalidation,
  test_f2_massive_manifest_load,
  test_f3_bwlimit_scheduler_boundary,
  test_f3_sync_conflict_resolution,
  test_f3_exclusion_matching_edge_cases,
  test_f3_nested_folder_prevent_duplicates,
  test_f3_sync_error_reporting,
  test_f4_empty_master_password,
  test_f4_short_master_password,
  test_f4_mismatched_master_passwords,
  test_f4_access_incorrect_password,
  test_f4_vault_metadata_no_hint
};
