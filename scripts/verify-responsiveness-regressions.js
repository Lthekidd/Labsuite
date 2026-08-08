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
assert.ok(asyncWalk.includes('fsPromises.opendir'), 'Async backup walking must stream directory entries.');
assert.ok(asyncWalk.includes('fsPromises.stat'), 'Async backup walking must use asynchronous stat calls.');
assert.ok(!asyncWalk.includes('fsPromises.readdir'), 'Async backup walking must not materialize huge directory arrays.');
assert.ok(!asyncWalk.includes('readdirSync'), 'Async backup walking must not block on readdirSync.');
assert.ok(!asyncWalk.includes('statSync'), 'Async backup walking must not block on statSync.');
const asyncManifestLoops = planner.slice(asyncWalkEnd, planner.indexOf('function addManifestDeletes'));
assert.ok(!asyncManifestLoops.includes('Object.entries(entries)'), 'Async manifest planning must not materialize the entire manifest as entry arrays.');
assert.ok(planner.includes('finishPlanAsync'), 'Large plan summarization must yield to Electron.');

const database = read('main/database.js');
assert.ok(database.includes('writeJsonFileIncrementally'), 'Large database persistence must use yielding JSON serialization.');
assert.ok(database.includes('await new Promise(resolve => setImmediate(resolve))'), 'Database serialization must yield to Electron.');
assert.ok(database.includes('saveDatabaseDeferred();'), 'Manifest traffic must use debounced persistence.');
assert.ok(database.includes('getManifestEntriesView'), 'Large backup planning must avoid cloning the entire manifest.');
assert.ok(database.includes('computeManifestSummaryAsync'), 'Large manifest summaries must yield to Electron.');

const watcher = read('main/watcher.js');
assert.ok(watcher.includes('addNativeRecursiveWatcher'), 'Windows folder watching must use low-overhead native recursion.');
assert.ok(watcher.includes("process.platform !== 'win32' || !addNativeRecursiveWatcher(localPath)"), 'All Windows backup folders must avoid Chokidar startup crawls when native watching is available.');

const backupWorker = read('main/backupWorker.js');
assert.ok(backupWorker.includes('groupPlanWorkItems'), 'Large backup plans must be grouped with yielding loops.');
assert.ok(backupWorker.includes('partitionUploadItemsAsync'), 'Large upload queues must be partitioned without blocking Electron.');
assert.ok(!backupWorker.includes('const folderPlans = new Map()'), 'All folder plans must not be retained in memory before uploads begin.');
assert.ok(backupWorker.includes('*getTransferBatches(items, options = {})'), 'Transfer batches must be generated lazily for very large queues.');
assert.ok(backupWorker.includes('BULK_TRANSFER_BATCH_FILES = 512'), 'Bulk uploads must keep rclone alive across hundreds of files.');
assert.ok(!backupWorker.includes('const batchSize = Math.max(1, Number(rclone.getTransferConcurrency'), 'Transfer process lifetime must not be limited to active transfer slots.');
assert.ok(backupWorker.includes('estimateOverallRunEta'), 'Overall ETA must use run progress instead of a tiny file speed sample.');
assert.ok(backupWorker.includes('filesPerSec'), 'Small-file workloads must expose an effective file rate.');

const rclone = read('main/rclone.js');
assert.ok(rclone.includes('Number(s.speed)'), 'Progress must consume rclone-reported speed when byte deltas are unavailable.');
assert.ok(rclone.includes('Could not parse progress JSON'), 'Progress parse failures must be diagnosable.');
assert.ok(rclone.includes("'--retries=8'"), 'Long-running cloud transfers must retry transient failures in the same process.');
assert.ok(rclone.includes("'--no-traverse'"), 'Bounded upload batches must not repeatedly traverse the full Drive destination.');
assert.ok(rclone.includes('transfers: 8') && rclone.includes('transfers: 12'), 'Fast and Turbo profiles must provide useful small-file parallelism without excessive Drive pressure.');

const backupUi = read('renderer/apps/LabSuiteBackup.jsx');
assert.ok(backupUi.includes('formatTelemetryState'), 'Backup UI must show the current non-transfer stage.');
assert.ok(backupUi.includes('Estimated Queue ETA'), 'The queue ETA must be labeled as an estimate.');
assert.ok(backupUi.includes('Effective Transfer Rate'), 'The queue must distinguish effective throughput from one active file sample.');
assert.ok(!backupUi.includes("formatSpeed(displaySpeed) || 'Calculating...'"), 'Transfer speed must not remain indefinitely on Calculating.');
assert.ok(backupUi.includes("healthInfo.gdriveStatus === 'Connected' || hasRealEmail"), 'Backup connection status must trust the authenticated account identity.');

const appUi = read('renderer/App.jsx');
assert.ok(appUi.includes("healthStatus === 'Connected' || !!hasRealEmail"), 'Global and Backup connection indicators must use the same account evidence.');

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
  const databaseModule = require('../main/database');
  const largeManifest = {};
  for (let index = 0; index < 100000; index += 1) {
    largeManifest[`old/file-${index}.txt`] = {
      status: 'backed_up',
      size: index,
      mtime_ms: 1700000000000,
      remote_path: `remote/file-${index}.txt`
    };
  }
  databaseModule.getDb().backup_manifest['1'] = largeManifest;
  const originalReadDirSync = fs.readdirSync;
  const originalStatSync = fs.statSync;
  let timerTicks = 0;
  let maxTimerGapMs = 0;
  let lastTimerAt = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTimerAt);
    lastTimerAt = now;
    timerTicks += 1;
  }, 5);
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
    assert.ok(timerTicks > 5, 'Large manifest planning did not yield to the event loop.');
    assert.ok(maxTimerGapMs < 250, `Large manifest planning blocked the event loop for ${maxTimerGapMs}ms.`);
    assert.ok(!Object.prototype.hasOwnProperty.call(plan.workItems[0], 'folderId'), 'Planned upload items must omit redundant folder IDs.');
    assert.ok(!Object.prototype.hasOwnProperty.call(plan.workItems[0], 'previousPackId'), 'Planned upload items must omit empty previous-version fields.');
  } finally {
    clearInterval(timer);
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
