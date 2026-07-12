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

async function test_cross_f1_f3() {
  // Cross-Feature: UI (F1) + Sync Transfer Speeds (F3)
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item');
    // Navigate to Settings
    await app.evaluate(`
      Array.from(document.querySelectorAll('.nav-item')).forEach(el => {
        if (el.innerText.includes('Settings')) el.click();
      });
    `);
    await app.waitForSelector('select');
    // Change backup transfer profile to Turbo
    await app.evaluate(`{
      const selects = document.querySelectorAll('select');
      const profileSelect = Array.from(selects).find(s => s.innerHTML.includes('turbo'));
      if (profileSelect) {
        profileSelect.value = 'turbo';
        profileSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }`);
    await app.wait(400);

    // Verify UI reflects selection
    const dbData = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    assert.strictEqual(dbData.settings.backup_transfer_profile, 'turbo', 'DB should update profile to turbo');

    // Change to Conservative and verify
    await app.evaluate(`{
      const selects = document.querySelectorAll('select');
      const profileSelect = Array.from(selects).find(s => s.innerHTML.includes('conservative'));
      if (profileSelect) {
        profileSelect.value = 'conservative';
        profileSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }`);
    await app.wait(400);
    const dbData2 = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    assert.strictEqual(dbData2.settings.backup_transfer_profile, 'conservative', 'DB should update profile to conservative');
  } finally {
    await app.close();
  }
}

async function test_cross_f2_f4() {
  // Cross-Feature: Caching DB (F2) + Credential Security (F4)
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.app-body');
    // Perform password credential save
    await app.evaluate(`window.electron.ipcRenderer.invoke('auth:setCryptPassword', { password: 'CrossPassword789' })`);
    await app.wait(300);

    // Access settings and verify the cached settings contains no passwords
    const allSettings = await app.evaluate(`window.electron.ipcRenderer.invoke('settings:get')`);
    assert.ok(allSettings.password_hint !== undefined, 'Settings should load successfully');
    const rcloneConf = fs.readFileSync(path.join(APP_USER_DATA, 'rclone.conf'), 'utf8');
    assert.ok(!rcloneConf.includes('CrossPassword789'), 'rclone.conf should contain no plaintext password');
  } finally {
    await app.close();
  }
}

async function test_cross_f3_f4() {
  // Cross-Feature: Sync Exclusions & Scheduled throttle (F3) + Encryption Credentials (F4)
  setupEnvironment({
    setupComplete: true,
    folders: [{ localPath: LOCAL_FILES }],
    password: 'EncryptedPassword999'
  });
  const app = await launchApp();
  try {
    // Add dynamic throttling config and verify crypt function remains active
    await app.evaluate(`window.electron.ipcRenderer.invoke('settings:set', { key: 'smart_throttle_enabled', value: '1' })`);
    await app.evaluate(`window.electron.ipcRenderer.invoke('settings:set', { key: 'upload_speed_capacity', value: '25' })`);
    await app.wait(300);

    const dbData = JSON.parse(fs.readFileSync(path.join(APP_USER_DATA, 'labsuite_db.json'), 'utf8'));
    assert.strictEqual(dbData.settings.smart_throttle_enabled, '1');
    assert.strictEqual(dbData.settings.upload_speed_capacity, '25');

    // Verify password is still correct in keychain
    const pass = await getStoredPassword();
    assert.strictEqual(pass, 'EncryptedPassword999');
  } finally {
    await app.close();
  }
}

async function test_cross_f1_f2() {
  // Cross-Feature: UI Navigation (F1) + Startup DB Caching (F2)
  setupEnvironment({ setupComplete: true });
  const app = await launchApp();
  try {
    await app.waitForSelector('.nav-item');
    // Rapidly click between My Computer and Settings tabs
    await app.evaluate(`
      const navs = Array.from(document.querySelectorAll('.nav-item'));
      const foldersTab = navs.find(n => n.innerText.includes('My Computer'));
      const settingsTab = navs.find(n => n.innerText.includes('Settings'));
      if (foldersTab) foldersTab.click();
      if (settingsTab) settingsTab.click();
      if (foldersTab) foldersTab.click();
    `);
    await app.wait(300);
    // Verify it renders the Backup Locations screen correctly
    const activeText = await app.query('.nav-item.active');
    assert.ok(activeText.includes('My Computer'), 'Active tab highlight should be My Computer');
  } finally {
    await app.close();
  }
}

module.exports = {
  test_cross_f1_f3,
  test_cross_f2_f4,
  test_cross_f3_f4,
  test_cross_f1_f2
};
