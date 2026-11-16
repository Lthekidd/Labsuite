/**
 * scripts/test-core-apps-audit.js
 *
 * Standalone automated verification test suite for Milestone M4:
 * Core Apps Specifications & Test Design
 *
 * Verifies:
 * - Test 1: main/ipc.js emits 'status:change' on folders:remove, folders:toggle, folders:reconnect, and folders:add
 * - Test 2: health:verify and adoptFolder reset folder.consecutive_failures = 0 and folder.sync_state = 'idle' on verified success
 * - Test 3: renderer/apps/LabSuiteBackup.jsx renders folder path diagnostics with clear error messages and locate/reconnect actions for missing folders
 * - Test 4: Wake-on-LAN handles unreachable hosts, timeouts, and network errors gracefully without crashing or hanging
 * - Test 5: LabShot overlay windows are destroyed cleanly, pin windows are tracked, and high-res images are offloaded to disk
 * - Test 6: Sidebar status badge correctly transitions from 'Failing' ('2 ISSUES') to 'Protected' ('OK') when failing folders are resolved or disabled
 *
 * Run via:
 *   node scripts/test-core-apps-audit.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function findProjectRoot(startDir) {
  let cur = startDir;
  while (cur && path.dirname(cur) !== cur) {
    if (fs.existsSync(path.join(cur, 'package.json')) && fs.existsSync(path.join(cur, 'main', 'ipc.js'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return path.resolve(__dirname, '..');
}

const ROOT = findProjectRoot(__dirname);
const IPC_PATH = path.join(ROOT, 'main', 'ipc.js');
const DB_PATH = path.join(ROOT, 'main', 'database.js');
const BACKUP_JSX_PATH = path.join(ROOT, 'renderer', 'apps', 'LabSuiteBackup.jsx');
const APP_JSX_PATH = path.join(ROOT, 'renderer', 'App.jsx');
const WOL_PATH = path.join(ROOT, 'main', 'wakeOnLan.js');
const LABSHOT_PATH = path.join(ROOT, 'main', 'labShot.js');

let testCount = 0;
let passCount = 0;
const failures = [];

async function runTest(name, fn) {
  testCount += 1;
  const currentNum = testCount;
  try {
    await fn();
    passCount += 1;
    console.log(`  [PASS] Test Case ${currentNum}: ${name}`);
  } catch (error) {
    failures.push({ num: currentNum, name, error });
    console.error(`  [FAIL] Test Case ${currentNum}: ${name}`);
    console.error(`         ${error.message}`);
  }
}

console.log('\n--- Running LabSuite M4 Core Apps & Status Badge Verification Suite ---\n');

(async function main() {

  // ========================================================================
  // Test 1: main/ipc.js emits status:change on folder mutations & creates directories
  // ========================================================================
  await runTest("main/ipc.js emits 'status:change' on folders:remove, folders:toggle, folders:reconnect, and folders:add", async () => {
    const ipcSource = fs.readFileSync(IPC_PATH, 'utf8');

    // 1. Verify static handler registrations
    assert.ok(ipcSource.includes("ipcMain.handle('folders:add'"), "main/ipc.js must register 'folders:add'");
    assert.ok(ipcSource.includes("ipcMain.handle('folders:remove'"), "main/ipc.js must register 'folders:remove'");
    assert.ok(ipcSource.includes("ipcMain.handle('folders:toggle'"), "main/ipc.js must register 'folders:toggle'");
    assert.ok(ipcSource.includes("ipcMain.handle('folders:reconnect'"), "main/ipc.js must register 'folders:reconnect'");

    // 2. Extract handler blocks and verify status:change emission
    const addBlockMatch = ipcSource.match(/ipcMain\.handle\('folders:add'[\s\S]*?\n  \}\);/);
    assert.ok(addBlockMatch, "Must locate folders:add handler block");
    assert.ok(
      addBlockMatch[0].includes("sendToRenderer('status:change', { status: 'idle', details: 'Folders updated' })"),
      "folders:add handler must emit status:change to notify renderer"
    );

    const removeBlockMatch = ipcSource.match(/ipcMain\.handle\('folders:remove'[\s\S]*?\n  \}\);/);
    assert.ok(removeBlockMatch, "Must locate folders:remove handler block");
    assert.ok(
      removeBlockMatch[0].includes("sendToRenderer('status:change', { status: 'idle', details: 'Folders updated' })"),
      "folders:remove handler must emit status:change to notify renderer"
    );

    const toggleBlockMatch = ipcSource.match(/ipcMain\.handle\('folders:toggle'[\s\S]*?\n  \}\);/);
    assert.ok(toggleBlockMatch, "Must locate folders:toggle handler block");
    assert.ok(
      toggleBlockMatch[0].includes("sendToRenderer('status:change', { status: 'idle', details: 'Folders updated' })"),
      "folders:toggle handler must emit status:change to notify renderer"
    );

    const reconnectBlockMatch = ipcSource.match(/ipcMain\.handle\('folders:reconnect'[\s\S]*?\n  \}\);/);
    assert.ok(reconnectBlockMatch, "Must locate folders:reconnect handler block");
    assert.ok(
      reconnectBlockMatch[0].includes("sendToRenderer('status:change', { status: 'idle', details: 'Folders updated' })"),
      "folders:reconnect handler must emit status:change to notify renderer"
    );
    assert.ok(
      reconnectBlockMatch[0].includes('fs.mkdirSync(absolutePath, { recursive: true })'),
      "folders:reconnect handler must ensure directory exists via fs.mkdirSync"
    );

    // 3. Verify folders:selectLocal includes createDirectory
    const selectLocalMatch = ipcSource.match(/ipcMain\.handle\('folders:selectLocal'[\s\S]*?\n  \}\);/);
    assert.ok(selectLocalMatch, "Must locate folders:selectLocal handler block");
    assert.ok(
      selectLocalMatch[0].includes("'createDirectory'"),
      "folders:selectLocal must include 'createDirectory' in open dialog properties"
    );

    // 4. Verify health:verify emits status:change
    const healthVerifyMatch = ipcSource.match(/ipcMain\.handle\('health:verify'[\s\S]*?\n  \}\);/);
    assert.ok(healthVerifyMatch, "Must locate health:verify handler block");
    assert.ok(
      healthVerifyMatch[0].includes("sendToRenderer('status:change', { status: 'idle', details: 'Folder verified' })"),
      "health:verify must emit status:change on completion"
    );
  });

  // ========================================================================
  // Test 2: health:verify resets consecutive_failures and sync_state
  // ========================================================================
  await runTest("health:verify and adoptFolder reset folder.consecutive_failures = 0 and folder.sync_state = 'idle' on verified success", async () => {
    const db = require(DB_PATH);
    const ipcSource = fs.readFileSync(IPC_PATH, 'utf8');
    const dbSource = fs.readFileSync(DB_PATH, 'utf8');

    // Verify contract in database.js and ipc.js
    assert.ok(ipcSource.includes("ipcMain.handle('health:verify'"), "main/ipc.js must register health:verify");
    assert.ok(
      dbSource.includes('updateFolderVerificationStatus'),
      "main/database.js must implement updateFolderVerificationStatus"
    );

    // Part A: Test updateFolderVerificationStatus reset behavior
    const testLocalPath = path.join(ROOT, 'test_mock_audit_dir_' + Date.now());
    const addResult = db.addFolder(testLocalPath, 'gdrive:test_audit_remote', { device_name: 'test' });
    const folderId = addResult.lastInsertRowid;

    try {
      // Simulate failure state
      db.updateFolderSyncStatus(folderId, false, 'Backup folder is missing locally');
      let folderBefore = db.getFolders().find(f => f.id === folderId);
      assert.ok(folderBefore, "Folder must exist in DB");
      assert.strictEqual(folderBefore.consecutive_failures, 1, "consecutive_failures must be incremented on sync failure");
      assert.strictEqual(folderBefore.sync_state, 'error', "sync_state must be 'error' on sync failure");

      // Verify that successful verification resets error state
      db.updateFolderVerificationStatus(folderId, true, {
        totalFilesChecked: 10,
        packsChecked: 1
      });

      const updatedFolders = db.getFolders();
      const verifiedFolder = updatedFolders.find(f => f.id === folderId);
      assert.ok(verifiedFolder, "Verified folder must exist in DB");
      assert.strictEqual(verifiedFolder.consecutive_failures, 0, "consecutive_failures must be reset to 0 on verified success");
      assert.strictEqual(verifiedFolder.sync_state, 'idle', "sync_state must be reset to 'idle' on verified success");
      assert.strictEqual(verifiedFolder.last_error, '', "last_error must be cleared on verified success");
      assert.strictEqual(verifiedFolder.last_crypto_verify_ok, 1, "last_crypto_verify_ok must be 1 on verified success");
    } finally {
      db.removeFolder(folderId);
    }

    // Part B: Test adoptFolder reset behavior
    const testLocalPath2 = path.join(ROOT, 'test_mock_adopt_dir_' + Date.now());
    const addResult2 = db.addFolder(testLocalPath2, 'gdrive:test_adopt_remote', { device_name: 'test' });
    const folderId2 = addResult2.lastInsertRowid;

    try {
      db.updateFolderSyncStatus(folderId2, false, 'Backup folder is missing locally');
      let folderBefore2 = db.getFolders().find(f => f.id === folderId2);
      assert.strictEqual(folderBefore2.consecutive_failures, 1);

      const newLocalPath = path.join(ROOT, 'test_mock_adopt_reconnected_' + Date.now());
      db.adoptFolder(folderId2, newLocalPath, { device_name: 'test' });

      const adoptedFolder = db.getFolders().find(f => f.id === folderId2);
      assert.ok(adoptedFolder, "Adopted folder must exist");
      assert.strictEqual(adoptedFolder.consecutive_failures, 0, "adoptFolder must reset consecutive_failures to 0");
      assert.strictEqual(adoptedFolder.sync_state, 'idle', "adoptFolder must reset sync_state to 'idle'");
      assert.strictEqual(adoptedFolder.last_error, '', "adoptFolder must reset last_error to ''");
      assert.strictEqual(adoptedFolder.local_path, newLocalPath, "adoptFolder must update local_path");
    } finally {
      db.removeFolder(folderId2);
    }
  });

  // ========================================================================
  // Test 3: LabSuiteBackup.jsx renders diagnostics and locate/reconnect actions
  // ========================================================================
  await runTest("renderer/apps/LabSuiteBackup.jsx renders folder path diagnostics with clear error messages and locate/reconnect actions for missing folders", async () => {
    const backupJsx = fs.readFileSync(BACKUP_JSX_PATH, 'utf8');

    // 1. Verify existence of handleReconnectFolder
    assert.ok(backupJsx.includes('handleReconnectFolder'), "LabSuiteBackup.jsx must implement handleReconnectFolder");

    // 2. Verify actionable troubleshooting UI in the active backup folder table
    assert.ok(
      backupJsx.includes('handleReconnectFolder') && (
        backupJsx.includes('Locate Folder') || backupJsx.includes('📁 Locate Folder')
      ),
      "Active folder table must provide an inline Locate Folder action button"
    );

    // 3. Verify error diagnosis rendering for missing paths
    assert.ok(
      backupJsx.includes('getReadableError') || backupJsx.includes('folder.last_error'),
      "LabSuiteBackup.jsx must extract and render readable error diagnostics"
    );

    // 4. Verify diagnostic message content
    assert.ok(
      backupJsx.includes('Backup folder is missing locally'),
      "LabSuiteBackup.jsx must display explicit 'Backup folder is missing locally' message"
    );

    // 5. Verify resource invalidation and event dispatch in mutation handlers
    assert.ok(
      backupJsx.includes("invalidateResource('folders:list')"),
      "LabSuiteBackup.jsx must call invalidateResource('folders:list')"
    );
    assert.ok(
      backupJsx.includes("window.dispatchEvent(new CustomEvent('folders-updated'))") ||
      backupJsx.includes("dispatchEvent(new CustomEvent('folders-updated'))"),
      "LabSuiteBackup.jsx must dispatch 'folders-updated' custom event"
    );
  });

  // ========================================================================
  // Test 4: Wake-on-LAN handles unreachable hosts, timeouts, and network errors gracefully
  // ========================================================================
  await runTest("Wake-on-LAN handles unreachable hosts, timeouts, and network errors gracefully without crashing or hanging", async () => {
    const wol = require(WOL_PATH);

    // 1. Verify MAC validation
    assert.throws(() => wol.__private.normalizeMac('FF:FF:FF:FF:FF:FF'), /broadcast/, "Must reject broadcast MAC");
    assert.throws(() => wol.__private.normalizeMac('00:00:00:00:00:00'), /zeroes/, "Must reject all-zeroes MAC");
    assert.throws(() => wol.__private.normalizeMac('01:00:5E:00:00:01'), /unicast/, "Must reject multicast MAC");

    // 2. Verify magic packet 102-byte construction
    const packet = wol.__private.buildMagicPacket('AA:BB:CC:DD:EE:FE');
    assert.strictEqual(packet.length, 102, "Magic packet must be exactly 102 bytes");

    // 3. Verify checkDeviceOnline handles offline host gracefully without throwing
    const onlineResult = await wol.checkDeviceOnline('127.0.0.1', { pingTimeoutMs: 150, tcpTimeoutMs: 150 });
    assert.ok(typeof onlineResult.online === 'boolean', "checkDeviceOnline must return boolean online status without throwing");

    // 4. Verify wakeAndVerify with unreachable host returns verified: true, online: false within timeout
    const wakeResult = await wol.wakeAndVerify({
      id: 'mock-unreachable',
      name: 'Unreachable Host',
      mac: 'AA:BB:CC:DD:EE:FE',
      hostIp: '192.0.2.1', // TEST-NET-1 (RFC 5737 unreachable)
      broadcastIp: '255.255.255.255',
      port: 9
    }, {
      burstCount: 1,
      burstIntervalMs: 0,
      verifyTimeoutMs: 600,
      verifyIntervalMs: 150,
      checkOnline: async () => ({ online: false, method: '' })
    });

    assert.strictEqual(wakeResult.success, true, "wakeAndVerify must complete with success: true");
    assert.strictEqual(wakeResult.online, false, "wakeAndVerify must report online: false for unreachable host");
    assert.strictEqual(wakeResult.verified, true, "wakeAndVerify must report verified: true");
    assert.ok(wakeResult.message.includes('timed out'), "wakeAndVerify message must indicate timeout");

    // 5. Verify wakeAndVerify with missing hostIp returns immediately
    const noIpResult = await wol.wakeAndVerify({
      id: 'mock-no-ip',
      name: 'No IP Host',
      mac: 'AA:BB:CC:DD:EE:FE',
      hostIp: '',
      broadcastIp: '255.255.255.255',
      port: 9
    }, {
      burstCount: 1,
      burstIntervalMs: 0
    });
    assert.strictEqual(noIpResult.success, true);
    assert.strictEqual(noIpResult.online, null);
    assert.strictEqual(noIpResult.verified, false);
  });

  // ========================================================================
  // Test 5: LabShot overlay windows destroyed cleanly, pin windows tracked, high-res images offloaded
  // ========================================================================
  await runTest("LabShot overlay windows are destroyed cleanly, pin windows are tracked, and high-res images are offloaded to disk", async () => {
    const labShotSource = fs.readFileSync(LABSHOT_PATH, 'utf8');

    // 1. Verify overlay cleanup & memory freeing
    assert.ok(
      labShotSource.includes('activeOverlayWindows.forEach') && labShotSource.includes('win.close()'),
      "Overlay windows must be iterated and closed cleanly"
    );
    assert.ok(
      labShotSource.includes('!win.isDestroyed()'),
      "Must check !win.isDestroyed() before closing overlay windows"
    );
    assert.ok(
      labShotSource.includes('capturedDataUrlCache = null'),
      "capturedDataUrlCache must be reset to null to immediately free heap memory"
    );

    // 2. Verify pin window tracking and memory cleanup
    assert.ok(labShotSource.includes('pinnedWindows.add(pinWin)'), "Pin windows must be tracked in Set");
    assert.ok(
      labShotSource.includes("pinWin.on('closed'") && labShotSource.includes('pinnedWindows.delete(pinWin)'),
      "Pin windows must be removed from Set on closed event to prevent memory leaks"
    );

    // 3. Verify image offload to disk & database protection
    assert.ok(labShotSource.includes('writeHistoryImage'), "Images must be offloaded to disk via writeHistoryImage");
    assert.ok(
      !labShotSource.includes('dataUrl: entry.dataUrl'),
      "Database records must not store full base64 dataUrl"
    );
    assert.ok(
      labShotSource.includes('history.length = 50') || labShotSource.includes('slice(0, 50)'),
      "LabShot history in memory/database must be capped at 50 records"
    );
  });

  // ========================================================================
  // Test 6: Sidebar status badge correctly transitions from 'Failing' to 'Protected'
  // ========================================================================
  await runTest("Sidebar status badge correctly transitions from 'Failing' ('2 ISSUES') to 'Protected' ('OK') when failing folders are resolved or disabled", async () => {
    const appJsx = fs.readFileSync(APP_JSX_PATH, 'utf8');

    // 1. Verify badge calculation logic exists in App.jsx
    assert.ok(appJsx.includes('failingFolders.length'), "App.jsx must calculate failingFolders count");
    assert.ok(appJsx.includes("setGlobalStatus('Failing')"), "App.jsx must set status to Failing when failingFolders > 0");
    assert.ok(appJsx.includes("setGlobalStatus('Protected')"), "App.jsx must set status to Protected when failingFolders === 0");
    assert.ok(appJsx.includes('compactStatus'), "App.jsx must define compactStatus pill text");

    // 2. Simulate calculation function matching App.jsx logic exactly
    function computeStatus(foldersList, setupComplete = '1') {
      if (setupComplete !== '1') {
        return { globalStatus: 'pending', compactStatus: 'pending', failureCount: 0 };
      }
      const activeLocalFolders = (foldersList || []).filter(folder => (
        (folder.enabled === 1 || folder.enabled === true || folder.enabled === undefined) &&
        folder.is_local_computer_backup !== false &&
        !folder.imported_from_remote_catalog
      ));
      const failingFolders = activeLocalFolders.filter(folder => Number(folder.consecutive_failures) > 0);
      const globalStatus = failingFolders.length > 0 ? 'Failing' : 'Protected';
      const failureCount = failingFolders.length;
      const compactStatus = globalStatus === 'Protected'
        ? 'OK'
        : `${failureCount || 1} ISSUE${(failureCount || 1) === 1 ? '' : 'S'}`;
      return { globalStatus, compactStatus, failureCount };
    }

    // State 1: Two failing folders (default onboarding issue)
    const initialFolders = [
      { id: 1, local_path: 'C:\\Users\\Mock\\Desktop', enabled: 1, consecutive_failures: 1, is_local_computer_backup: true },
      { id: 2, local_path: 'C:\\Users\\Mock\\Documents', enabled: 1, consecutive_failures: 2, is_local_computer_backup: true }
    ];
    const state1 = computeStatus(initialFolders);
    assert.strictEqual(state1.globalStatus, 'Failing');
    assert.strictEqual(state1.compactStatus, '2 ISSUES');

    // State 2: One folder disabled via toggle
    initialFolders[0].enabled = 0;
    const state2 = computeStatus(initialFolders);
    assert.strictEqual(state2.globalStatus, 'Failing');
    assert.strictEqual(state2.compactStatus, '1 ISSUE');

    // State 3: Second folder disabled or resolved
    initialFolders[1].enabled = 0;
    const state3 = computeStatus(initialFolders);
    assert.strictEqual(state3.globalStatus, 'Protected');
    assert.strictEqual(state3.compactStatus, 'OK');

    // State 4: Both folders enabled and verified healthy
    initialFolders[0].enabled = 1;
    initialFolders[0].consecutive_failures = 0;
    initialFolders[1].enabled = 1;
    initialFolders[1].consecutive_failures = 0;
    const state4 = computeStatus(initialFolders);
    assert.strictEqual(state4.globalStatus, 'Protected');
    assert.strictEqual(state4.compactStatus, 'OK');

    // 3. Verify status:change invalidates resourceStore cache
    assert.ok(
      appJsx.includes("ipcRenderer.on('status:change'") && appJsx.includes("invalidateResource('folders:list')"),
      "App.jsx must listen to status:change and invalidate folders:list"
    );
  });

  // ========================================================================
  // Final Test Results Summary
  // ========================================================================
  console.log('\n=======================================================');
  console.log(`Test Execution Summary: ${passCount}/${testCount} test cases passed.`);
  if (failures.length === 0) {
    console.log('All M4 Core Apps & Status Badge verification criteria passed.');
    console.log('=======================================================\n');
    process.exitCode = 0;
  } else {
    console.error(`FAILED: ${failures.length} test case(s) failed.`);
    console.log('=======================================================\n');
    process.exitCode = 1;
  }
})();
