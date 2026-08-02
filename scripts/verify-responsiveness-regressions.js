const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const planner = read('main/backupPlanner.js');
const asyncWalkStart = planner.indexOf('async function walkFolderAsync');
const asyncWalkEnd = planner.indexOf('async function addManifestRepairsAsync');
assert.ok(asyncWalkStart >= 0 && asyncWalkEnd > asyncWalkStart, 'Could not locate the asynchronous backup walker.');
const asyncWalk = planner.slice(asyncWalkStart, asyncWalkEnd);
assert.ok(asyncWalk.includes('fsPromises.readdir'), 'Async backup walking must use asynchronous directory reads.');
assert.ok(asyncWalk.includes('fsPromises.stat'), 'Async backup walking must use asynchronous stat calls.');
assert.ok(!asyncWalk.includes('readdirSync'), 'Async backup walking must not block on readdirSync.');
assert.ok(!asyncWalk.includes('statSync'), 'Async backup walking must not block on statSync.');

const database = read('main/database.js');
assert.ok(database.includes('writeJsonFileIncrementally'), 'Large database persistence must use yielding JSON serialization.');
assert.ok(database.includes('await new Promise(resolve => setImmediate(resolve))'), 'Database serialization must yield to Electron.');
assert.ok(database.includes('saveDatabaseDeferred();'), 'Manifest traffic must use debounced persistence.');

const rclone = read('main/rclone.js');
assert.ok(rclone.includes('Number(s.speed)'), 'Progress must consume rclone-reported speed when byte deltas are unavailable.');
assert.ok(rclone.includes('Could not parse progress JSON'), 'Progress parse failures must be diagnosable.');

const backupUi = read('renderer/apps/LabSuiteBackup.jsx');
assert.ok(backupUi.includes('formatTelemetryState'), 'Backup UI must show the current non-transfer stage.');
assert.ok(backupUi.includes('Estimated Queue ETA'), 'The queue ETA must be labeled as an estimate.');
assert.ok(!backupUi.includes("formatSpeed(displaySpeed) || 'Calculating...'"), 'Transfer speed must not remain indefinitely on Calculating.');

const hwBackend = read('main/labHwMonitor.js');
const hwUi = read('renderer/apps/LabHWMonitor.jsx');
assert.ok(hwBackend.includes('samplingCycleInFlight'), 'Hardware monitoring must prevent overlapping WMI cycles.');
assert.ok(hwUi.includes('function LabHWMonitor({ active = true })'), 'Hardware monitoring must honor workspace visibility.');
assert.ok(hwUi.includes('}, [active]);'), 'Hardware subscriptions must follow workspace visibility changes.');

const index = read('main/index.js');
assert.ok(index.includes("app.on('browser-window-created'"), 'Every LabSuite and LabShot window must receive diagnostics.');
assert.ok(index.includes("win.on('unresponsive'"), 'Window hangs must be logged.');
assert.ok(index.includes("app.on('child-process-gone'"), 'Electron child process exits must be logged.');
assert.ok(index.includes('startMainLoopWatchdog'), 'Electron main-loop stalls must be detected.');
assert.ok(index.includes('crashReporter.start'), 'Native crash dumps must be captured locally.');

const logger = read('main/logger.js');
assert.ok(logger.includes('a instanceof Error'), 'Error objects must retain their message and stack in logs.');

async function verifyAsyncPlannerBehavior() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-planner-async-'));
  const sourceDir = path.join(tempDir, 'source');
  const nestedDir = path.join(sourceDir, 'nested');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'one.txt'), 'one');
  fs.writeFileSync(path.join(nestedDir, 'two.txt'), 'two');
  fs.writeFileSync(path.join(tempDir, 'labsuite_db.json'), JSON.stringify({
    folders: [{ id: 1, local_path: sourceDir, remote_path: 'computers/Test/source', enabled: 1 }],
    backup_manifest: { 1: {} },
    restore_points: [],
    sync_log: [],
    settings: { setup_complete: '1' },
    cache: {}
  }));

  require.cache[require.resolve('electron')] = {
    id: 'electron',
    filename: 'electron',
    loaded: true,
    exports: { app: { getPath: () => tempDir } }
  };

  const backupPlanner = require('../main/backupPlanner');
  const originalReadDirSync = fs.readdirSync;
  const originalStatSync = fs.statSync;
  try {
    fs.readdirSync = () => { throw new Error('async planner called readdirSync'); };
    fs.statSync = () => { throw new Error('async planner called statSync'); };
    const plan = await backupPlanner.planFolderAsync({
      id: 1,
      local_path: sourceDir,
      remote_path: 'computers/Test/source',
      enabled: 1
    });
    assert.strictEqual(plan.filesToUpload, 2, 'Async planner must discover nested files without synchronous filesystem calls.');
  } finally {
    fs.readdirSync = originalReadDirSync;
    fs.statSync = originalStatSync;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

verifyAsyncPlannerBehavior().then(() => {
  console.log('Responsiveness regression verification passed.');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
