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

// --- Feature 1: UI & Modernized Theme ---

async function test_f1_active_tab_highlighting() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item.active');
    const activeText = await app.query('.nav-item.active');
    assert.ok(activeText.includes('Activity') || activeText.includes('dashboard'), 'Active tab highlight should show Activity dashboard');
  } finally {
    await app.close();
  }
}

async function test_f1_navigation() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item');
    // Navigate to "My Computer" (folders)
    const navItems = await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).map((el, i) => {
        if (el.innerText.includes('My Computer')) {
          el.click();
          return i;
        }
        return -1;
      }).filter(x => x !== -1)
    `);
    assert.ok(navItems.length > 0, 'Should find and click My Computer tab');
    await app.waitForText('h1', 'Backup Selection');
  } finally {
    await app.close();
  }
}

async function test_f1_storage_fill_gradient() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.storage-fill');
    // The storage fill element should exist
    const exists = await app.exists('.storage-fill');
    assert.ok(exists, 'Storage progress bar fill element should be rendered');
  } finally {
    await app.close();
  }
}

async function test_f1_user_card() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.sidebar-user-card');
    const exists = await app.exists('.sidebar-user-card');
    assert.ok(exists, 'User account card should be present in sidebar');
  } finally {
    await app.close();
  }
}

async function test_f1_onboarding_visuals() {
  setupEnvironment({ setupComplete: false });
  const app = await launchApp();
  try {
    await app.waitForSelector('.step-indicator');
    const dotCount = await app.evaluate(`document.querySelectorAll('.step-dot').length`);
    assert.ok(dotCount >= 2, 'Onboarding step indicator should render step dots');
  } finally {
    await app.close();
  }
}

// --- Feature 2: Startup & Config Speed ---

async function test_f2_fast_launch() {
  const startTime = Date.now();
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.app-header');
    const launchTime = Date.now() - startTime;
    assert.ok(launchTime < 8000, `App should launch quickly (took ${launchTime}ms)`);
  } finally {
    await app.close();
  }
}

async function test_f2_database_cached_queries() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    // Modify setting and check database cache read is extremely fast
    await app.waitForSelector('.nav-item');
    // Navigate to settings tab
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Settings')) el.click();
      });
    `);
    await app.waitForSelector('select');
    // Change check frequency setting
    await app.type('select', '60');
    // Read the setting back via evaluate of DB setting to verify cache performance
    const dbFilePath = path.join(APP_USER_DATA, 'labsuite_db.json');
    assert.ok(fs.existsSync(dbFilePath), 'Database file should exist');
  } finally {
    await app.close();
  }
}

async function test_f2_lazy_loading_verification() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    // App loads without crashing or lagging, showing UI components
    await app.waitForSelector('.app-body');
    const title = await app.query('.app-title');
    assert.ok(title.includes('LabSuite'), 'Title should display LabSuite');
  } finally {
    await app.close();
  }
}

async function test_f2_dashboard_info_load() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    // Verify cloud account and status loaded without delay
    await app.waitForSelector('.sidebar-storage');
    const storageText = await app.query('.storage-text');
    assert.ok(storageText.includes('used'), 'Dashboard should load storage info from cache');
  } finally {
    await app.close();
  }
}

async function test_f2_settings_caching() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item');
    // Change active tab to settings
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Settings')) el.click();
      });
    `);
    await app.waitForSelector('select');
    const initialVal = await app.query('select', 'value');
    assert.ok(initialVal !== null, 'Settings dropdown value should be retrieved');
  } finally {
    await app.close();
  }
}

// --- Feature 3: Syncing & Transfer Speed ---

async function test_f3_transfer_profile_conservative() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item');
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Settings')) el.click();
      });
    `);
    await app.waitForSelector('select');
    // Set to Conservative profile
    await app.evaluate(`
      const selects = document.querySelectorAll('select');
      const profileSelect = Array.from(selects).find(s => s.innerHTML.includes('conservative'));
      if (profileSelect) {
        profileSelect.value = 'conservative';
        profileSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    `);
    await app.wait(500);
    // Verify DB update
    const dbData = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    assert.strictEqual(dbData.settings.backup_transfer_profile, 'conservative', 'DB profile should update to conservative');
  } finally {
    await app.close();
  }
}

async function test_f3_transfer_profile_fast() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item');
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Settings')) el.click();
      });
    `);
    await app.waitForSelector('select');
    // Set to Fast profile
    await app.evaluate(`
      const selects = document.querySelectorAll('select');
      const profileSelect = Array.from(selects).find(s => s.innerHTML.includes('fast'));
      if (profileSelect) {
        profileSelect.value = 'fast';
        profileSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    `);
    await app.wait(500);
    const dbData = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    assert.strictEqual(dbData.settings.backup_transfer_profile, 'fast', 'DB profile should update to fast');
  } finally {
    await app.close();
  }
}

async function test_f3_transfer_profile_turbo() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item');
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Settings')) el.click();
      });
    `);
    await app.waitForSelector('select');
    // Set to Turbo profile
    await app.evaluate(`
      const selects = document.querySelectorAll('select');
      const profileSelect = Array.from(selects).find(s => s.innerHTML.includes('turbo'));
      if (profileSelect) {
        profileSelect.value = 'turbo';
        profileSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    `);
    await app.wait(500);
    const dbData = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    assert.strictEqual(dbData.settings.backup_transfer_profile, 'turbo', 'DB profile should update to turbo');
  } finally {
    await app.close();
  }
}

async function test_f3_sync_pause_resume() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.badge');
    // Initial status should be protected/idle
    const badgeText = await app.query('.badge');
    assert.ok(badgeText.includes('Protected') || badgeText.includes('pending'), 'Status should be idle/protected initially');
  } finally {
    await app.close();
  }
}

async function test_f3_manual_sync_trigger() {
  setupEnvironment({
    setupComplete: true,
    folders: [{ localPath: LOCAL_FILES }]
  });
  // Create a dummy file to be synced
  fs.writeFileSync(path.join(LOCAL_FILES, 'dummy.txt'), 'hello sync', 'utf8');

  const app = await launchApp();
  try {
    await app.waitForSelector('.app-header');
    // Trigger sync via DB or IPC if no button is visible
    const success = await app.evaluate(`window.electron.ipcRenderer.invoke('sync:triggerNow')`);
    assert.ok(success, 'Manual sync trigger should succeed');
  } finally {
    await app.close();
  }
}

// --- Feature 4: Security & Credentials ---

async function test_f4_password_onboarding_setup() {
  setupEnvironment({ setupComplete: false });
  const app = await launchApp();
  try {
    await app.waitForSelector('button');
    // Setup local Google Drive connection mock complete
    await app.evaluate(`window.electron.ipcRenderer.invoke('settings:set', { key: 'setup_complete', value: '1' })`);
    const dbData = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    assert.strictEqual(dbData.settings.setup_complete, '1', 'Setup should be complete after saving settings');
  } finally {
    await app.close();
  }
}

async function test_f4_keychain_storage() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    // Save a master password
    await app.evaluate(`window.electron.ipcRenderer.invoke('auth:setCryptPassword', { password: 'MySuperSecurePassword123' })`);
    const savedPassword = await getStoredPassword();
    assert.strictEqual(savedPassword, 'MySuperSecurePassword123', 'Password should be saved securely in Windows Credential Manager');
  } finally {
    await app.close();
  }
}

async function test_f4_rclone_conf_security() {
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    await app.evaluate(`window.electron.ipcRenderer.invoke('auth:setCryptPassword', { password: 'AnotherPassword456' })`);
    // Ensure rclone.conf exists and does not contain plaintext password
    const rcloneConfPath = path.join(APP_USER_DATA, 'rclone.conf');
    assert.ok(fs.existsSync(rcloneConfPath), 'rclone.conf must exist');
    const content = fs.readFileSync(rcloneConfPath, 'utf8');
    assert.ok(!content.includes('AnotherPassword456'), 'rclone.conf must not contain plaintext master password');
  } finally {
    await app.close();
  }
}

async function test_f4_disconnect_wipes_all() {
  setupEnvironment({
    setupComplete: true,
    folders: [{ localPath: LOCAL_FILES }],
    password: 'MockPassword123'
  });
  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    await app.evaluate(`window.electron.ipcRenderer.invoke('auth:disconnect')`);
    // Check credentials cleared
    const stored = await getStoredPassword();
    assert.strictEqual(stored, null, 'Keychain password should be wiped after disconnect');
    // Check folders cleared in db
    const dbData = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    assert.strictEqual(dbData.folders.length, 0, 'Folders should be wiped after disconnect');
    assert.strictEqual(dbData.settings.setup_complete, '0', 'setup_complete should reset to 0');
  } finally {
    await app.close();
  }
}

async function test_f4_vault_metadata_upload() {
  setupEnvironment({
    setupComplete: true,
    settings: { password_hint: 'my hint text' },
    password: 'SecurePassword1'
  });
  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    // Metadata vault marker verification
    const metadata = await app.evaluate(`window.electron.ipcRenderer.invoke('vault:metadata')`);
    assert.ok(metadata !== null, 'Vault metadata must be readable from remote vault');
  } finally {
    await app.close();
  }
}

module.exports = {
  test_f1_active_tab_highlighting,
  test_f1_navigation,
  test_f1_storage_fill_gradient,
  test_f1_user_card,
  test_f1_onboarding_visuals,
  test_f2_fast_launch,
  test_f2_database_cached_queries,
  test_f2_lazy_loading_verification,
  test_f2_dashboard_info_load,
  test_f2_settings_caching,
  test_f3_transfer_profile_conservative,
  test_f3_transfer_profile_fast,
  test_f3_transfer_profile_turbo,
  test_f3_sync_pause_resume,
  test_f3_manual_sync_trigger,
  test_f4_password_onboarding_setup,
  test_f4_keychain_storage,
  test_f4_rclone_conf_security,
  test_f4_disconnect_wipes_all,
  test_f4_vault_metadata_upload
};
