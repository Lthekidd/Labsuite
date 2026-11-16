/**
 * scripts/test-database-hardening.js
 *
 * Standalone verification test suite for Milestone M1:
 * Database Hardening & IPC Resilience
 *
 * Verifies:
 * - Test Case 1: Corrupt file recovery (labsuite_db.json containing literal "null")
 * - Test Case 2: Corrupt file recovery (labsuite_db.json containing empty string or truncated json)
 * - Test Case 3: Array element null corruption ({ "folders": [null] })
 * - Test Case 4: Settings null corruption ({ "settings": null })
 * - Test Case 5: Corrupt backup recovery (labsuite_db.json.bak containing literal "null")
 * - Test Case 6: Write protection assertion (asserting saveDatabaseSync never writes "null")
 * - Test Case 7: auth:getGDriveInfo invoked with null, { force: true }, or disconnected rclone
 * - Test Case 8: health:get invoked with rclone failure or missing binary
 *
 * Run via:
 *   node scripts/test-database-hardening.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findProjectRoot(startDir) {
  let cur = startDir;
  while (cur && path.dirname(cur) !== cur) {
    if (fs.existsSync(path.join(cur, 'package.json')) && fs.existsSync(path.join(cur, 'main', 'database.js'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return path.resolve(__dirname, '..');
}

const ROOT = findProjectRoot(__dirname);
const DB_MODULE_PATH = path.join(ROOT, 'main', 'database.js');
const IPC_MODULE_PATH = path.join(ROOT, 'main', 'ipc.js');
const RCLONE_MODULE_PATH = path.join(ROOT, 'main', 'rclone.js');

const REQUIRED_SCHEMA_KEYS = [
  'folders',
  'backup_manifest',
  'restore_points',
  'sync_log',
  'active_restores',
  'settings',
  'cache',
  'telegramInstalls',
  'telegramArchiveChats',
  'wolDevices',
  'labshot_history'
];

const REQUIRED_DEFAULT_SETTINGS = [
  'sync_interval_minutes',
  'theme',
  'start_on_login',
  'notifications_enabled',
  'speed_unit',
  'bwlimit'
];

let testCount = 0;
let passCount = 0;
const failures = [];

function runTest(name, fn) {
  testCount += 1;
  const currentNum = testCount;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `labsuite-m1-test-${currentNum}-`));
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};

  try {
    fn(tempDir);
    passCount += 1;
    process.stdout.write(`  [PASS] Test Case ${currentNum}: ${name}\n`);
  } catch (err) {
    failures.push({ num: currentNum, name, err });
    process.stderr.write(`  [FAIL] Test Case ${currentNum}: ${name}\n`);
    process.stderr.write(`         ${err.message}\n`);
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

async function runAsyncTest(name, fn) {
  testCount += 1;
  const currentNum = testCount;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `labsuite-m1-test-${currentNum}-`));
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};

  try {
    await fn(tempDir);
    passCount += 1;
    process.stdout.write(`  [PASS] Test Case ${currentNum}: ${name}\n`);
  } catch (err) {
    failures.push({ num: currentNum, name, err });
    process.stderr.write(`  [FAIL] Test Case ${currentNum}: ${name}\n`);
    process.stderr.write(`         ${err.message}\n`);
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function mockElectron(tempDir, registeredHandlers = new Map()) {
  require.cache[require.resolve('electron')] = {
    id: 'electron',
    filename: 'electron',
    loaded: true,
    exports: {
      app: {
        getPath: (name) => (name === 'userData' ? tempDir : os.tmpdir()),
        on: () => {},
        isPackaged: false
      },
      ipcMain: {
        handle: (channel, fn) => {
          registeredHandlers.set(channel, fn);
        },
        on: () => {}
      },
      dialog: {},
      BrowserWindow: class {
        constructor() {
          this.webContents = { send: () => {} };
        }
      }
    }
  };
}

function reloadDatabase() {
  delete require.cache[require.resolve(DB_MODULE_PATH)];
  return require(DB_MODULE_PATH);
}

function reloadIpc() {
  delete require.cache[require.resolve(IPC_MODULE_PATH)];
  return require(IPC_MODULE_PATH);
}

async function main() {
  console.log('\n--- Running LabSuite M1 Database Hardening & IPC Resilience Verification ---');

  // ============================================================================
  // Test Case 1: Corrupt file recovery (labsuite_db.json containing literal "null")
  // ============================================================================
  runTest('Corrupt file recovery (labsuite_db.json containing literal "null")', (tempDir) => {
    const dbPath = path.join(tempDir, 'labsuite_db.json');
    fs.writeFileSync(dbPath, 'null', 'utf8');

    mockElectron(tempDir);
    const db = reloadDatabase();

    const currentDb = db.getDb();
    assert.ok(currentDb && typeof currentDb === 'object', 'db.getDb() must return a valid object');

    for (const key of REQUIRED_SCHEMA_KEYS) {
      assert.ok(currentDb[key] !== undefined, `Schema key "${key}" must be defined`);
    }

    assert.ok(Array.isArray(currentDb.folders), 'folders must be an array');
    assert.ok(Array.isArray(currentDb.wolDevices), 'wolDevices must be an array');
    assert.ok(Array.isArray(currentDb.active_restores), 'active_restores must be an array');
    assert.ok(currentDb.settings && typeof currentDb.settings === 'object', 'settings must be an object');
    assert.strictEqual(db.getSetting('sync_interval_minutes'), '15', 'Default settings must be populated');

    // Verify file on disk is valid JSON and not literal "null"
    const diskContent = fs.readFileSync(dbPath, 'utf8').trim();
    assert.notStrictEqual(diskContent, 'null', 'labsuite_db.json on disk must not contain literal "null"');
    const parsedDisk = JSON.parse(diskContent);
    assert.ok(parsedDisk && typeof parsedDisk === 'object', 'Persisted file must be valid JSON object');
  });

  // ============================================================================
  // Test Case 2: Corrupt file recovery (empty string and truncated JSON)
  // ============================================================================
  runTest('Corrupt file recovery (empty string and truncated JSON)', (tempDir) => {
    const dbPath = path.join(tempDir, 'labsuite_db.json');

    // 2A: Empty string (0-byte file)
    fs.writeFileSync(dbPath, '', 'utf8');
    mockElectron(tempDir);
    let db = reloadDatabase();
    assert.ok(db.getDb() && typeof db.getDb() === 'object', 'Empty file must recover to valid database object');
    assert.ok(Array.isArray(db.getFolders()), 'db.getFolders() must return an array');
    assert.strictEqual(db.getSetting('sync_interval_minutes'), '15');

    // 2B: Truncated JSON
    fs.writeFileSync(dbPath, '{"folders": [{"id": "truncated_folder", "local_path":', 'utf8');
    db = reloadDatabase();
    assert.ok(db.getDb() && typeof db.getDb() === 'object', 'Truncated JSON must recover to valid database object');
    assert.ok(Array.isArray(db.getDb().folders), 'db.getDb().folders must be an array');
    assert.strictEqual(db.getSetting('sync_interval_minutes'), '15');
  });

  // ============================================================================
  // Test Case 3: Array element null corruption ({ "folders": [null] })
  // ============================================================================
  runTest('Array element null corruption ({ "folders": [null] })', (tempDir) => {
    const dbPath = path.join(tempDir, 'labsuite_db.json');
    const corruptedData = {
      folders: [
        null,
        {
          id: 'folder_valid_1',
          local_path: 'C:\\test\\valid',
          remote_path: 'valid_remote',
          enabled: 1,
          encrypted: 1
        },
        null
      ],
      telegramArchiveChats: [
        null,
        { id: 'chat_valid_1', name: 'Chat 1', account_name: 'Main' },
        null
      ],
      wolDevices: [
        null,
        { mac: '00:11:22:33:44:55', ip: '192.168.1.50', name: 'Server' },
        null
      ],
      settings: {
        sync_interval_minutes: '45'
      }
    };
    fs.writeFileSync(dbPath, JSON.stringify(corruptedData), 'utf8');

    mockElectron(tempDir);
    const db = reloadDatabase();

    // folders null filtering
    const folders = db.getFolders();
    assert.ok(Array.isArray(folders), 'db.getFolders() must return an array');
    assert.strictEqual(folders.length, 1, 'Corrupt null entries must be filtered out, preserving valid folders');
    assert.strictEqual(folders[0].id, 'folder_valid_1');

    // getEnabledFolders must not throw TypeError
    const enabled = db.getEnabledFolders();
    assert.strictEqual(enabled.length, 1);
    assert.strictEqual(enabled[0].id, 'folder_valid_1');

    // telegramArchiveChats null filtering
    const chats = db.getDb().telegramArchiveChats;
    assert.ok(Array.isArray(chats), 'telegramArchiveChats must be an array');
    assert.strictEqual(chats.length, 1, 'Corrupt null chat entries must be filtered out');
    assert.strictEqual(chats[0].id, 'chat_valid_1');

    // wolDevices null filtering
    const wolDevices = db.getDb().wolDevices;
    assert.ok(Array.isArray(wolDevices), 'wolDevices must be an array');
    assert.strictEqual(wolDevices.length, 1, 'Corrupt null WOL device entries must be filtered out');
    assert.strictEqual(wolDevices[0].mac, '00:11:22:33:44:55');
  });

  // ============================================================================
  // Test Case 4: Settings null corruption ({ "settings": null })
  // ============================================================================
  runTest('Settings null corruption ({ "settings": null })', (tempDir) => {
    const dbPath = path.join(tempDir, 'labsuite_db.json');
    fs.writeFileSync(dbPath, JSON.stringify({ settings: null, folders: [] }), 'utf8');

    mockElectron(tempDir);
    const db = reloadDatabase();

    const settings = db.getDb().settings;
    assert.ok(settings && typeof settings === 'object', 'Settings must be recovered to a non-null object');

    for (const key of REQUIRED_DEFAULT_SETTINGS) {
      assert.ok(settings[key] !== undefined, `Default setting key "${key}" must be present`);
    }
    assert.strictEqual(db.getSetting('sync_interval_minutes'), '15');

    // Modifying settings must succeed and persist cleanly
    db.setSetting('theme', 'dark');
    assert.strictEqual(db.getSetting('theme'), 'dark');
  });

  // ============================================================================
  // Test Case 5: Corrupt backup recovery (labsuite_db.json.bak containing literal "null")
  // ============================================================================
  runTest('Corrupt backup recovery (labsuite_db.json.bak containing literal "null")', (tempDir) => {
    const dbPath = path.join(tempDir, 'labsuite_db.json');
    const backupPath = `${dbPath}.bak`;

    fs.writeFileSync(dbPath, '{ corrupt json invalid', 'utf8');
    fs.writeFileSync(backupPath, 'null', 'utf8');

    mockElectron(tempDir);
    const db = reloadDatabase();

    const currentDb = db.getDb();
    assert.ok(currentDb && typeof currentDb === 'object', 'Database must recover cleanly to defaults');
    assert.ok(Array.isArray(currentDb.wolDevices), 'wolDevices must be initialized as array');
    assert.ok(Array.isArray(currentDb.active_restores), 'active_restores must be initialized as array');
    assert.strictEqual(db.getSetting('sync_interval_minutes'), '15');

    // Verify repaired primary file on disk
    const diskContent = fs.readFileSync(dbPath, 'utf8').trim();
    assert.notStrictEqual(diskContent, 'null', 'Repaired primary file must not be "null"');
    const parsed = JSON.parse(diskContent);
    assert.ok(parsed && typeof parsed === 'object', 'Repaired primary file must be valid JSON');
  });

  // ============================================================================
  // Test Case 6: Write protection assertion (never writes "null" to disk)
  // ============================================================================
  runTest('Write protection assertion (never writes "null" to disk)', (tempDir) => {
    const dbPath = path.join(tempDir, 'labsuite_db.json');
    const backupPath = `${dbPath}.bak`;

    mockElectron(tempDir);
    const db = reloadDatabase();

    // Subtest 6A: Standard persistence
    db.setSetting('test_write_key', 'test_write_value');

    const diskContent = fs.readFileSync(dbPath, 'utf8').trim();
    assert.notStrictEqual(diskContent, 'null', 'Database file must never contain literal "null"');
    assert.notStrictEqual(diskContent, '', 'Database file must not be empty');

    const parsed = JSON.parse(diskContent);
    assert.strictEqual(parsed.settings.test_write_key, 'test_write_value');

    // Subtest 6B: Verify backup protection: A corrupt primary file must never overwrite a valid backup
    fs.writeFileSync(dbPath, 'null', 'utf8');
    fs.writeFileSync(backupPath, JSON.stringify({ settings: { sentinel: 'good_backup' }, folders: [] }), 'utf8');

    const reloadedDb = reloadDatabase();
    assert.strictEqual(reloadedDb.getSetting('sentinel'), 'good_backup');
    const backupDisk = fs.readFileSync(backupPath, 'utf8').trim();
    assert.notStrictEqual(backupDisk, 'null', 'Backup file must not be overwritten with "null"');

    // Subtest 6C: If saveDatabaseSync or writeJsonFileIncrementally encounters corrupted state, it heals to default schema
    if (typeof db.saveDatabaseSync === 'function') {
      db.saveDatabaseSync();
      const contentAfterSync = fs.readFileSync(dbPath, 'utf8').trim();
      assert.notStrictEqual(contentAfterSync, 'null');
      assert.ok(JSON.parse(contentAfterSync));
    }
  });

  // ============================================================================
  // Test Case 7: auth:getGDriveInfo invoked with null, { force: true }, or disconnected
  // ============================================================================
  await runAsyncTest('auth:getGDriveInfo resilience (null, { force: true }, disconnected)', async (tempDir) => {
    const handlers = new Map();
    mockElectron(tempDir, handlers);

    const db = reloadDatabase();
    const ipc = reloadIpc();
    ipc.setupIpc({}, () => {}, () => {});

    const authHandler = handlers.get('auth:getGDriveInfo');
    assert.ok(typeof authHandler === 'function', 'auth:getGDriveInfo must be registered');

    // Subcase 7A: Invoked with null
    let resultNull = null;
    await assert.doesNotReject(
      async () => {
        resultNull = await authHandler({}, null);
      },
      'auth:getGDriveInfo must never throw when options is null'
    );
    assert.ok(resultNull && typeof resultNull === 'object', 'Must return an object');
    assert.ok(typeof resultNull.email === 'string', 'email must be a string');
    assert.ok(typeof resultNull.accountEmail === 'string', 'accountEmail must be a string');
    assert.ok(typeof resultNull.displayName === 'string', 'displayName must be a string');
    assert.ok(Number.isFinite(resultNull.used), 'used must be a number');
    assert.ok(Number.isFinite(resultNull.total), 'total must be a number');
    assert.ok(Number.isFinite(resultNull.free), 'free must be a number');

    // Subcase 7B: Invoked with undefined
    let resultUndefined = null;
    await assert.doesNotReject(
      async () => {
        resultUndefined = await authHandler({}, undefined);
      },
      'auth:getGDriveInfo must not reject when options is undefined'
    );
    assert.ok(resultUndefined && typeof resultUndefined === 'object');

    // Subcase 7C: Invoked with non-object (e.g. primitive number)
    let resultPrimitive = null;
    await assert.doesNotReject(
      async () => {
        resultPrimitive = await authHandler({}, 12345);
      },
      'auth:getGDriveInfo must not reject when options is non-object'
    );
    assert.ok(resultPrimitive && typeof resultPrimitive === 'object');

    // Subcase 7D: Invoked with { force: true }
    let resultForce = null;
    await assert.doesNotReject(
      async () => {
        resultForce = await authHandler({}, { force: true });
      },
      'auth:getGDriveInfo must not reject with { force: true }'
    );
    assert.ok(resultForce && typeof resultForce === 'object');

    // Subcase 7E: Disconnected / failed rclone simulation
    const rclone = require(RCLONE_MODULE_PATH);
    const originalGetGDriveInfo = rclone.getGDriveInfo;
    try {
      rclone.getGDriveInfo = () => Promise.reject(new Error('Simulated rclone connection error'));
      let resultError = null;
      await assert.doesNotReject(
        async () => {
          resultError = await authHandler({}, { force: true });
        },
        'auth:getGDriveInfo must handle rclone rejection gracefully'
      );
      assert.strictEqual(resultError.email, 'Disconnected');
      assert.strictEqual(resultError.total, 0);
      assert.strictEqual(resultError.used, 0);
      assert.strictEqual(resultError.free, 0);
      assert.ok(typeof resultError.accountEmail === 'string');
      assert.ok(typeof resultError.displayName === 'string');
    } finally {
      rclone.getGDriveInfo = originalGetGDriveInfo;
    }
  });

  // ============================================================================
  // Test Case 8: health:get invoked with rclone failure or missing binary
  // ============================================================================
  await runAsyncTest('health:get resilience (rclone failure or missing binary)', async (tempDir) => {
    const handlers = new Map();
    mockElectron(tempDir, handlers);

    const db = reloadDatabase();
    const ipc = reloadIpc();
    ipc.setupIpc({}, () => {}, () => {});

    const healthHandler = handlers.get('health:get');
    assert.ok(typeof healthHandler === 'function', 'health:get must be registered');

    // Subcase 8A: rclone.getVersion fails (missing binary or execution error)
    const rclone = require(RCLONE_MODULE_PATH);
    const originalGetVersion = rclone.getVersion;
    const originalGetGDriveInfo = rclone.getGDriveInfo;

    try {
      rclone.getVersion = () => Promise.reject(new Error('ENOENT: rclone binary not found'));
      rclone.getGDriveInfo = () => Promise.reject(new Error('Rclone unavailable'));

      let healthResult = null;
      await assert.doesNotReject(
        async () => {
          healthResult = await healthHandler({});
        },
        'health:get must never reject unhandled when rclone binary is missing'
      );

      assert.ok(healthResult && typeof healthResult === 'object', 'health:get must return an object');
      assert.ok(typeof healthResult.rcloneVersion === 'string', 'rcloneVersion must be a string');
      assert.ok(
        healthResult.gdriveStatus === 'Connected' || healthResult.gdriveStatus === 'Disconnected',
        'gdriveStatus must be Connected or Disconnected'
      );
      assert.ok(healthResult.remoteSafety && typeof healthResult.remoteSafety === 'object', 'remoteSafety must be an object');
      assert.ok(typeof healthResult.remoteSafety.ok === 'boolean', 'remoteSafety.ok must be a boolean');
      assert.ok(Array.isArray(healthResult.remoteSafety.sampleWarnings), 'remoteSafety.sampleWarnings must be an array');
      assert.strictEqual(typeof healthResult.remoteSafety.pending, 'boolean');
    } finally {
      rclone.getVersion = originalGetVersion;
      rclone.getGDriveInfo = originalGetGDriveInfo;
    }
  });

  console.log(`\n=======================================================`);
  console.log(`Test Execution Summary: ${passCount}/${testCount} test cases passed.`);
  if (failures.length > 0) {
    console.log(`Failed Cases (${failures.length}):`);
    for (const f of failures) {
      console.log(`  - Case ${f.num} (${f.name}): ${f.err.message}`);
    }
    console.log(`=======================================================\n`);
    process.exit(1);
  } else {
    console.log(`All M1 Database Hardening & IPC Resilience tests PASSED.`);
    console.log(`=======================================================\n`);
    process.exit(0);
  }
}

main().catch((fatal) => {
  console.error('Fatal test execution error:', fatal);
  process.exit(1);
});
