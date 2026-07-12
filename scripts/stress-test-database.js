const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Create a unique temporary directory for this test run
const testId = `db_stress_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
const tempDir = path.join(os.tmpdir(), testId);
fs.mkdirSync(tempDir, { recursive: true });

console.log(`Setting up isolated database environment in: ${tempDir}`);

// Mock electron's app.getPath('userData') so main/database.js uses our temp directory
const mockElectron = {
  app: {
    getPath: (name) => {
      if (name === 'userData') {
        return tempDir;
      }
      return tempDir;
    }
  }
};

// Inject the mock electron into require.cache
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: mockElectron
};

// Now import the database module. It will initialize and write to tempDir/labsuite_db.json.
const db = require('../main/database');
const dbFilePath = path.join(tempDir, 'labsuite_db.json');

// Assert that the database file was created
assert.ok(fs.existsSync(dbFilePath), 'Database file should be initialized on disk.');

// Keep track of fs read/write operations to verify caching behaviour
let originalReadFileSync = fs.readFileSync;
let originalWriteFileSync = fs.writeFileSync;
let originalRenameSync = fs.renameSync;

let readCount = 0;
let writeCount = 0;
let renameCount = 0;

fs.readFileSync = function (filePath, ...args) {
  if (filePath === dbFilePath) readCount++;
  return originalReadFileSync.call(fs, filePath, ...args);
};

fs.writeFileSync = function (filePath, ...args) {
  if (filePath.includes('labsuite_db.json')) writeCount++;
  return originalWriteFileSync.call(fs, filePath, ...args);
};

fs.renameSync = function (src, dest, ...args) {
  if (dest === dbFilePath) renameCount++;
  return originalRenameSync.call(fs, src, dest, ...args);
};

async function runStressTests() {
  console.log('\n--- 1. SPEED IMPROVEMENTS & BATCHING PERFORMANCE ---');

  // Verify caching on reads
  readCount = 0;
  const readStart = process.hrtime.bigint();
  const readOps = 20000;
  for (let i = 0; i < readOps; i++) {
    db.getSetting('sync_interval_minutes');
  }
  const readEnd = process.hrtime.bigint();
  const readDurationNs = Number(readEnd - readStart);
  const readDurationMs = readDurationNs / 1000000;
  console.log(`Completed ${readOps} reads in ${readDurationMs.toFixed(2)}ms (${(readOps / (readDurationMs / 1000)).toFixed(0)} ops/sec).`);
  assert.strictEqual(readCount, 0, 'Subsequent reads must not trigger disk reads (fully cached).');

  // Direct disk read baseline (simulating NO caching)
  const diskReadStart = process.hrtime.bigint();
  const diskReadOps = 1000;
  for (let i = 0; i < diskReadOps; i++) {
    const raw = originalReadFileSync(dbFilePath, 'utf8');
    JSON.parse(raw);
  }
  const diskReadEnd = process.hrtime.bigint();
  const diskReadDurationNs = Number(diskReadEnd - diskReadStart);
  const diskReadDurationMs = diskReadDurationNs / 1000000;
  console.log(`Direct disk baseline: read/parse ${diskReadOps} times from disk took ${diskReadDurationMs.toFixed(2)}ms.`);
  
  const readSpeedup = (diskReadDurationMs / diskReadOps) / (readDurationMs / readOps);
  console.log(`>> Read Cache Speedup: ~${readSpeedup.toFixed(1)}x faster than direct disk reads.`);

  // Write Batching vs Unbatched Performance
  const writeOps = 500;
  
  // Unbatched writes: each write triggers a synchronous save to disk
  writeCount = 0;
  renameCount = 0;
  const unbatchedStart = process.hrtime.bigint();
  for (let i = 0; i < writeOps; i++) {
    db.upsertManifestEntry(1, `file_unbatched_${i}.txt`, { size: 100 + i, hash: `abc${i}` });
  }
  const unbatchedEnd = process.hrtime.bigint();
  const unbatchedDurationMs = Number(unbatchedEnd - unbatchedStart) / 1000000;
  const unbatchedWrites = writeCount;
  console.log(`Unbatched: ${writeOps} updates took ${unbatchedDurationMs.toFixed(2)}ms (Disk writes: ${unbatchedWrites}, renames: ${renameCount}).`);

  // Batched writes: multiple updates inside withWriteBatch, should trigger only 1 disk write
  writeCount = 0;
  renameCount = 0;
  const batchedStart = process.hrtime.bigint();
  await db.withWriteBatch(async () => {
    for (let i = 0; i < writeOps; i++) {
      db.upsertManifestEntry(1, `file_batched_${i}.txt`, { size: 100 + i, hash: `xyz${i}` });
    }
  });
  const batchedEnd = process.hrtime.bigint();
  const batchedDurationMs = Number(batchedEnd - batchedStart) / 1000000;
  const batchedWrites = writeCount;
  console.log(`Batched: ${writeOps} updates took ${batchedDurationMs.toFixed(2)}ms (Disk writes: ${batchedWrites}, renames: ${renameCount}).`);
  
  assert.strictEqual(batchedWrites, 1, 'Batched updates must trigger exactly 1 disk write.');
  const writeSpeedup = unbatchedDurationMs / batchedDurationMs;
  console.log(`>> Write Batching Speedup: ~${writeSpeedup.toFixed(1)}x faster.`);


  console.log('\n--- 2. CACHE CONSISTENCY & ATOMICITY ---');

  // Verify that setting values are instantly visible in memory
  db.setSetting('test_consistent_key', 'hello_world');
  assert.strictEqual(db.getSetting('test_consistent_key'), 'hello_world', 'Setting must be instantly consistent in memory.');

  // Verify that settings are written to disk
  let onDiskData = JSON.parse(originalReadFileSync(dbFilePath, 'utf8'));
  assert.strictEqual(onDiskData.settings.test_consistent_key, 'hello_world', 'Written setting must be persisted to disk.');

  // Verify consistency with batching
  let valDuringBatch = null;
  await db.withWriteBatch(async () => {
    db.setSetting('batch_key', 'value_inside');
    valDuringBatch = db.getSetting('batch_key'); // read during batch
  });
  assert.strictEqual(valDuringBatch, 'value_inside', 'Read-after-write inside batch must return the value.');
  
  onDiskData = JSON.parse(originalReadFileSync(dbFilePath, 'utf8'));
  assert.strictEqual(onDiskData.settings.batch_key, 'value_inside', 'Batch modifications must persist on batch completion.');

  // Verify failure atomicity (batch fails)
  try {
    await db.withWriteBatch(async () => {
      db.setSetting('fail_key', 'failed_val');
      throw new Error('Simulation of failure inside batch');
    });
  } catch (err) {
    assert.strictEqual(err.message, 'Simulation of failure inside batch');
  }
  // The value should be rolled back and not present in memory or disk
  assert.strictEqual(db.getSetting('fail_key'), null, 'Changes made before failure inside batch should be rolled back.');
  onDiskData = JSON.parse(originalReadFileSync(dbFilePath, 'utf8'));
  assert.strictEqual(onDiskData.settings.fail_key, undefined, 'Failed batch changes must not be flushed to disk.');


  console.log('\n--- 3. CONCURRENCY & RACE CONDITIONS ---');

  // Run multiple concurrent updates and reads using Promise.all to check for race conditions
  const concurrencyLevel = 50;
  const opsPerTask = 20;
  const tasks = [];

  const taskStart = process.hrtime.bigint();
  for (let t = 0; t < concurrencyLevel; t++) {
    tasks.push((async (taskId) => {
      // mix of batched and unbatched operations
      if (taskId % 2 === 0) {
        await db.withWriteBatch(async () => {
          for (let i = 0; i < opsPerTask; i++) {
            db.upsertManifestEntry(1, `concurrent_file_${taskId}_${i}.txt`, { size: i * 10, hash: `hash-${taskId}-${i}` });
            // perform intermediate read
            const entry = db.getManifestEntry(1, `concurrent_file_${taskId}_${i}.txt`);
            assert.strictEqual(entry.size, i * 10);
          }
        });
      } else {
        for (let i = 0; i < opsPerTask; i++) {
          db.upsertManifestEntry(1, `concurrent_file_${taskId}_${i}.txt`, { size: i * 10, hash: `hash-${taskId}-${i}` });
        }
      }
    })(t));
  }

  await Promise.all(tasks);
  const taskEnd = process.hrtime.bigint();
  console.log(`Successfully completed ${concurrencyLevel} concurrent tasks (${concurrencyLevel * opsPerTask} total ops) in ${Number(taskEnd - taskStart) / 1000000}ms.`);

  // Verify data integrity: read all concurrent records and ensure they exist and match
  for (let t = 0; t < concurrencyLevel; t++) {
    for (let i = 0; i < opsPerTask; i++) {
      const entry = db.getManifestEntry(1, `concurrent_file_${t}_${i}.txt`);
      assert.ok(entry, `Entry concurrent_file_${t}_${i}.txt should exist`);
      assert.strictEqual(entry.size, i * 10);
    }
  }

  // Ensure JSON database file is readable and matches exactly
  const finalDiskData = JSON.parse(originalReadFileSync(dbFilePath, 'utf8'));
  assert.strictEqual(Object.keys(finalDiskData.backup_manifest['1']).length, (writeOps * 2) + (concurrencyLevel * opsPerTask), 'Manifest entry count on disk mismatch.');
  console.log('Database integrity check passed: all concurrent writes persisted and match exactly.');


  console.log('\n--- 4. MEMORY LEAKS OR GROWTH ---');

  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }

  const initialMemory = process.memoryUsage().heapUsed;
  console.log(`Initial Heap Used: ${(initialMemory / 1024 / 1024).toFixed(2)} MB`);

  const leakOps = 40000;
  const memoryCheckpointStart = process.hrtime.bigint();

  // Run 40,000 read/write operations
  await db.withWriteBatch(async () => {
    for (let i = 0; i < leakOps; i++) {
      // mix of setSetting, getSetting, upsertManifestEntry, getManifestEntry
      const key = `leak_test_key_${i % 1000}`;
      db.setSetting(key, `val-${i}`);
      db.getSetting(key);

      if (i % 10 === 0) {
        db.upsertManifestEntry(1, `leak_file_${i % 500}.txt`, { size: i, hash: `h-${i}` });
      }
    }
  });

  const memoryCheckpointEnd = process.hrtime.bigint();
  if (global.gc) {
    global.gc();
  }
  const finalMemory = process.memoryUsage().heapUsed;
  const memoryIncrease = finalMemory - initialMemory;

  console.log(`Completed ${leakOps} ops in ${Number(memoryCheckpointEnd - memoryCheckpointStart) / 1000000}ms.`);
  console.log(`Final Heap Used: ${(finalMemory / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Heap Difference: ${(memoryIncrease / 1024 / 1024).toFixed(2)} MB`);

  // Memory shouldn't grow drastically since we recycle keys and cap sync_log/restore_points in database.js
  // Let's assert memory growth is reasonable (< 15MB for 40k ops, which allows for normal V8 heap slack)
  assert.ok(memoryIncrease < 15 * 1024 * 1024, `Memory growth is too high: ${(memoryIncrease / 1024 / 1024).toFixed(2)} MB`);
  console.log('Memory leak check passed: no unbounded memory growth detected.');

  console.log('\n=========================================');
  console.log('ALL VERIFICATION STRESS TESTS PASSED!');
  console.log('=========================================');
}

runStressTests()
  .then(() => {
    // Restore original functions
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
    fs.renameSync = originalRenameSync;

    // Clean up temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('Warning: Could not remove temporary test directory:', e.message);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('STRESS TEST FAILED:', err);
    process.exit(1);
  });
