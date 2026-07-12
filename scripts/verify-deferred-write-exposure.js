const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const testId = `db_exposure_${Date.now()}`;
const tempDir = path.join(os.tmpdir(), testId);
fs.mkdirSync(tempDir, { recursive: true });

const mockElectron = {
  app: {
    getPath: () => tempDir
  }
};
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: mockElectron
};

// Delete database module from require cache to ensure fresh load with new electron mock
delete require.cache[require.resolve('../main/database')];
const db = require('../main/database');
const dbFilePath = path.join(tempDir, 'labsuite_db.json');

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function runExposureTest() {
  console.log('Starting exposure test for global writeBatchDepth side-effects...');

  // 1. Start an async batch task
  let batchFinished = false;
  const batchPromise = db.withWriteBatch(async () => {
    console.log('Batch task started, writeBatchDepth incremented.');
    await sleep(200);
    console.log('Batch task finishing, writeBatchDepth will decrement.');
    batchFinished = true;
  });

  // 2. Immediately perform a non-batched write while the batch task is still running (awaiting sleep)
  await sleep(50);
  console.log('Performing unbatched write during active batch...');
  db.setSetting('critical_unbatched_key', 'important_data');

  // 3. Read raw file from disk directly to see if the unbatched write was persisted
  const diskDataBeforeBatchEnd = JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
  
  // Critique assertion: because writeBatchDepth > 0, the unbatched write was deferred!
  const isKeyOnDiskBefore = diskDataBeforeBatchEnd.settings.critical_unbatched_key !== undefined;
  console.log(`Is critical key on disk before batch ends? ${isKeyOnDiskBefore ? 'YES' : 'NO'}`);
  
  // 4. Wait for batch to finish
  await batchPromise;
  
  // 5. Read raw file from disk again
  const diskDataAfterBatchEnd = JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
  const isKeyOnDiskAfter = diskDataAfterBatchEnd.settings.critical_unbatched_key !== undefined;
  console.log(`Is critical key on disk after batch ends? ${isKeyOnDiskAfter ? 'YES' : 'NO'}`);

  assert.strictEqual(isKeyOnDiskBefore, false, 'Unbatched write should have been deferred because of the active batch.');
  assert.strictEqual(isKeyOnDiskAfter, true, 'Unbatched write should be persisted after batch finishes.');

  console.log('Exposure test completed successfully: demonstrated that active batches defer all concurrent unbatched writes.');
}

runExposureTest()
  .then(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
    process.exit(0);
  })
  .catch(err => {
    console.error('Exposure test failed:', err);
    process.exit(1);
  });
