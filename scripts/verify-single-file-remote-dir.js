const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-single-file-remote-dir-'));
const protectedFile = path.join(tempDir, 'testfile.txt');
fs.writeFileSync(protectedFile, 'file contents', 'utf8');

// Mock Electron app path
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: { app: { getPath: () => tempDir } }
};

async function main() {
  try {
    const db = require('../main/database');
    const rclone = require('../main/rclone');
    const backupVerifier = require('../main/backupVerifier');
    const remoteSafety = require('../main/remoteSafety');
    const backupWorker = require('../main/backupWorker');
    const packStore = require('../main/packStore');

    // Insert mock folder of type 'file'
    const remotePath = 'computers/TestDevice/C/Users/Name/Desktop/testfile.txt';
    const result = db.addFolder(tempDir, remotePath, {
      include_paths: ['testfile.txt'],
      selection_path: protectedFile,
      source_type: 'file'
    });
    const folderId = result.lastInsertRowid;
    
    // Set folder sync status to success so it has last_success_at populated
    db.updateFolderSyncStatus(folderId, true);
    
    const [folder] = db.getFolders().filter(f => f.id === folderId);

    // 1. Verify packStore.makePackRemotePath(folder, 'pack123')
    const expectedRemoteDir = 'computers/TestDevice/C/Users/Name/Desktop';
    const packPath = packStore.makePackRemotePath(folder, 'pack123');
    assert.ok(packPath.includes(expectedRemoteDir), `packStore.makePackRemotePath should include ${expectedRemoteDir}`);

    // 2. Verify backupWorker.makeStagingRoot and makeHistoryRoot
    const workerInstance = new backupWorker.constructor();
    const stagingRoot = workerInstance.makeStagingRoot(folder, 'run123');
    const historyRoot = workerInstance.makeHistoryRoot(folder, 'stamp123');
    assert.ok(stagingRoot.endsWith(`run123/${expectedRemoteDir}`), `backupWorker.makeStagingRoot should end with run123/${expectedRemoteDir}`);
    assert.ok(historyRoot.endsWith(`stamp123/${expectedRemoteDir}`), `backupWorker.makeHistoryRoot should end with stamp123/${expectedRemoteDir}`);

    // 3. Verify backupVerifier.verifyFolder resolves the remote directory
    // Insert a manifest entry to make verifyFolder run crypt check
    db.upsertManifestEntry(folderId, 'testfile.txt', {
      local_path: protectedFile,
      remote_path: remotePath,
      status: 'backed_up',
      size: 13,
      mtime_ms: Date.now()
    });

    let cryptCheckFilesRemotePath = null;
    rclone.cryptCheckFiles = async (localPath, remotePathArg, relativePaths, onLog, extraExclusions) => {
      cryptCheckFilesRemotePath = remotePathArg;
      return '';
    };

    const verifyResult = await backupVerifier.verifyFolder(folder);
    assert.ok(verifyResult.ok, 'Verification should succeed.');
    assert.strictEqual(cryptCheckFilesRemotePath, expectedRemoteDir, `backupVerifier should pass remote directory: ${expectedRemoteDir}`);

    // 4. Verify remoteSafety.findMissingActiveCopiesForFolder uses the correct parent remote directory for listing
    let listRemoteTreeStrictPath = null;
    rclone.listRemoteTreeStrict = async (remotePathArg) => {
      listRemoteTreeStrictPath = remotePathArg;
      return [{ Path: 'testfile.txt', IsDir: false }];
    };

    const safetyResult = await remoteSafety.findMissingActiveCopiesForFolder(folder);
    assert.strictEqual(listRemoteTreeStrictPath, expectedRemoteDir, `remoteSafety should list parent remote directory: ${expectedRemoteDir}`);
    assert.strictEqual(safetyResult.missing.length, 0, 'No files should be missing since we returned it in mock lsjson.');

    console.log('Single-file remote directory verification tests passed successfully!');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
