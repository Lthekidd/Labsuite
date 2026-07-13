const assert = require('assert');

const filesystem = require('../main/filesystem');
const rclone = require('../main/rclone');
const backupManifest = require('../main/backupManifest');
const backupPlanner = require('../main/backupPlanner');
const restorePlanner = require('../main/restorePlanner');
const backupWorker = require('../main/backupWorker');
const packStore = require('../main/packStore');
const remoteSafety = require('../main/remoteSafety');
const network = require('../main/network');
const folderIdentity = require('../main/folderIdentity');
const restorePaths = require('../main/restorePaths');
const backupShortcuts = require('../main/backupShortcuts');

const {
  getRemotePath,
  redactRcloneArg,
  isNotFoundError,
  normalizeFilesFromPaths,
  buildRcloneErrorMessage,
  getRcloneRemoteConfigValue,
  updateRcloneRemoteConfig,
  validateGoogleClientCredentials
} = rclone.__private;

assert.strictEqual(getRemotePath('folder/file.txt'), 'gdrive-crypt:folder/file.txt');
assert.strictEqual(getRemotePath(''), 'gdrive-crypt:');
assert.ok(!getRemotePath('folder/file.txt').includes('LabSuite-Plain'));
assert.ok(!getRemotePath('folder/file.txt').startsWith('gdrive:'));

assert.strictEqual(
  restorePaths.resolveListedRemotePath('computers', 'DESKTOP-A4J3VMI', 'DESKTOP-A4J3VMI'),
  'computers/DESKTOP-A4J3VMI'
);
assert.strictEqual(
  restorePaths.resolveListedRemotePath('computers/DESKTOP-A4J3VMI', 'C', 'C'),
  'computers/DESKTOP-A4J3VMI/C'
);
assert.strictEqual(
  restorePaths.normalizeRestoreSystemPath('.labsuite_history/2026-07-12', kind => `.vaultsync_${kind}`),
  '.vaultsync_history/2026-07-12'
);

const shortcutItems = backupShortcuts.makeBackupShortcuts({
  folders: [{ local_path: 'E:\\', remote_path: 'computers/CURRENT-PC/E', last_success_at: '2026-07-12T00:00:00.000Z' }],
  remoteEntries: [
    { Path: 'OLD-PC/C/Users/alex/Desktop', ModTime: '2026-07-01T00:00:00.000Z' },
    { Path: 'OLD-PC/C/Users/alex/Documents', ModTime: '2026-07-01T00:00:00.000Z' },
    { Path: 'OLD-PC/C/Users/alex/Desktop/project', ModTime: '2026-07-01T00:00:00.000Z' }
  ],
  aliases: { 'CURRENT-PC': 'Antigravity', 'OLD-PC': 'Old PC' }
});
assert.deepStrictEqual(
  shortcutItems.map(item => [item.Name, item.Path]),
  [
    ['Desktop — Old PC', 'computers/OLD-PC/C/Users/alex/Desktop'],
    ['Documents — Old PC', 'computers/OLD-PC/C/Users/alex/Documents'],
    ['Drive E: — Antigravity', 'computers/CURRENT-PC/E']
  ]
);
assert.ok(shortcutItems.every(item => item.Shortcut && item.IsDir));

assert.strictEqual(redactRcloneArg('password=super-secret'), 'password=***');
assert.strictEqual(redactRcloneArg('client_secret=super-secret'), 'client_secret=***');
assert.strictEqual(redactRcloneArg('remote=gdrive:LabSuite-Encrypted'), 'remote=gdrive:LabSuite-Encrypted');

const sharedClientNotice = "2026/07/12 16:49:37 NOTICE: gdrive: This remote uses rclone's shared Google Drive client_id, which is being retired and will stop working during 2026.";
const actionableBackupError = buildRcloneErrorMessage({
  code: 1,
  signal: null,
  stderr: `${sharedClientNotice}\n2026/07/12 16:49:38 ERROR : oldpctext.txt: Failed to copy: unexpected EOF`
});
assert.ok(actionableBackupError.includes('unexpected EOF'));
assert.ok(!actionableBackupError.includes('shared Google Drive client_id'));
assert.strictEqual(
  buildRcloneErrorMessage({ code: 1, signal: null, stderr: sharedClientNotice }),
  'The backup process stopped (code 1).'
);

const sampleRcloneConfig = [
  '[gdrive]',
  'type = drive',
  'scope = drive',
  'token = {"access_token":"keep-me"}',
  '',
  '[gdrive-crypt]',
  'type = crypt',
  'remote = gdrive:LabSuite-Encrypted',
  ''
].join('\r\n');
const updatedRcloneConfig = updateRcloneRemoteConfig(sampleRcloneConfig, 'gdrive', {
  client_id: '123456789-example.apps.googleusercontent.com',
  client_secret: 'GOCSPX-example'
});
assert.strictEqual(
  getRcloneRemoteConfigValue(updatedRcloneConfig, 'gdrive', 'client_id'),
  '123456789-example.apps.googleusercontent.com'
);
assert.strictEqual(getRcloneRemoteConfigValue(updatedRcloneConfig, 'gdrive', 'client_secret'), 'GOCSPX-example');
assert.ok(updatedRcloneConfig.includes('token = {"access_token":"keep-me"}'));
assert.ok(updatedRcloneConfig.includes('[gdrive-crypt]'));
assert.throws(
  () => validateGoogleClientCredentials('not-a-google-client', 'secret'),
  /apps\.googleusercontent\.com/
);

assert.ok(filesystem.matchesExclusionPattern('**/*.log', 'logs/app.log'));
assert.ok(filesystem.matchesExclusionPattern('**/node_modules/**', 'project/node_modules/pkg/index.js'));
assert.ok(filesystem.matchesExclusionPattern('**/dist-packaged/**', 'LabSuite/dist-packaged/win-unpacked.tmp/locales/en-US.pak'));
assert.ok(filesystem.matchesExclusionPattern('/private/**', 'private/secret.txt'));
assert.ok(!filesystem.matchesExclusionPattern('/private/**', 'public/private/secret.txt'));

assert.ok(filesystem.isPathInsideFolder('C:\\root\\child\\file.txt', 'C:\\root'));
assert.ok(!filesystem.isPathInsideFolder('C:\\root-other\\file.txt', 'C:\\root'));

assert.ok(isNotFoundError(new Error('object not found')));
assert.ok(!isNotFoundError(new Error('Config file "rclone.conf" not found - using defaults')));
assert.deepStrictEqual(
  normalizeFilesFromPaths(['\\a\\b.txt', '/a/b.txt', 'nested/file.txt', 'nested/file.txt', '']),
  ['a/b.txt', 'nested/file.txt']
);

assert.strictEqual(backupManifest.normalizeRelativePath('\\nested\\file.txt'), 'nested/file.txt');
assert.strictEqual(
  backupManifest.getRemoteFilePath({ remote_path: 'computers/PC/E/folder' }, 'nested/file.txt'),
  'computers/PC/E/folder/nested/file.txt'
);

assert.strictEqual(
  folderIdentity.getProfileAgnosticKeyForLocalPath('C:\\Users\\jento\\Desktop'),
  'c/users/*/desktop'
);
assert.strictEqual(
  folderIdentity.getProfileAgnosticKeyForRemotePath('computers/DESKTOP-A4J3VMI/C/Users/atre/Desktop'),
  'c/users/*/desktop'
);
assert.strictEqual(
  folderIdentity.getRemoteComputerName('computers/DESKTOP-A4J3VMI/C/Users/atre/Desktop'),
  'DESKTOP-A4J3VMI'
);
assert.strictEqual(
  folderIdentity.findReusableFolder([
    {
      id: 1,
      local_path: 'C:\\Users\\atre\\Desktop',
      remote_path: 'computers/DESKTOP-A4J3VMI/C/Users/atre/Desktop',
      enabled: 0,
      imported_from_remote_catalog: true
    }
  ], 'C:\\Users\\jento\\Desktop', { computerName: 'DESKTOP-A4J3VMI' }).id,
  1
);
assert.strictEqual(
  folderIdentity.findReusableFolder([
    {
      id: 1,
      local_path: 'C:\\Users\\atre\\Desktop',
      remote_path: 'computers/VIOLETA/C/Users/atre/Desktop',
      device_fingerprint: 'remote-fingerprint',
      enabled: 0,
      imported_from_remote_catalog: true
    }
  ], 'C:\\Users\\jento\\Desktop', { computerName: 'VIOLETA', deviceFingerprint: 'local-fingerprint' }),
  null
);
assert.strictEqual(
  folderIdentity.findReusableFolder([
    {
      id: 1,
      local_path: 'C:\\Users\\atre\\Desktop',
      remote_path: 'computers/VIOLETA/C/Users/atre/Desktop',
      device_fingerprint: 'local-fingerprint',
      enabled: 0,
      imported_from_remote_catalog: true
    }
  ], 'C:\\Users\\jento\\Desktop', { computerName: 'CURRENT-PC', deviceFingerprint: 'local-fingerprint' }).id,
  1
);
assert.strictEqual(
  folderIdentity.findReusableFolder([
    { id: 1, remote_path: 'computers/PC1/C/Users/one/Desktop', enabled: 0, imported_from_remote_catalog: true },
    { id: 2, remote_path: 'computers/PC2/C/Users/two/Desktop', enabled: 0, imported_from_remote_catalog: true }
  ], 'C:\\Users\\jento\\Desktop'),
  null
);

assert.ok(backupPlanner.hasChanged(null, { size: 1, mtimeMs: 1 }));
assert.ok(!backupPlanner.hasChanged({ status: 'backed_up', size: 1, mtime_ms: 1000 }, { size: 1, mtimeMs: 1500 }));
assert.ok(backupPlanner.hasChanged({ status: 'backed_up', size: 1, mtime_ms: 1000 }, { size: 2, mtimeMs: 1000 }));
assert.ok(backupPlanner.hasChanged({ status: 'dirty', size: 1, mtime_ms: 1000 }, { size: 1, mtimeMs: 1000 }));
assert.ok(!backupPlanner.hasChanged({ status: 'active_repair_needed', size: 1, mtime_ms: 1000 }, { size: 2, mtimeMs: 2000 }));
assert.ok(backupPlanner.shouldMigratePackedActiveEntry({ status: 'backed_up', storage: 'pack' }));
assert.ok(backupPlanner.hasChanged({ status: 'backed_up', storage: 'pack', size: 1, mtime_ms: 1000 }, { size: 1, mtimeMs: 1000 }));
assert.deepStrictEqual(
  backupPlanner.__private.makeMissingFileDeleteItem(
    { id: 5, remote_path: 'computers/PC/E' },
    'temporary/file.tmp',
    { remote_path: 'computers/PC/E/temporary/file.tmp', storage: 'file', size: 12 }
  ),
  {
    type: 'delete_history',
    folderId: 5,
    relativePath: 'temporary/file.tmp',
    size: 12,
    previousRemotePath: 'computers/PC/E/temporary/file.tmp',
    previousStorage: 'file',
    previousPackId: null,
    previousPackRemotePath: null,
    previousPackMemberPath: null
  }
);
assert.strictEqual(
  backupPlanner.__private.makeMissingFileDeleteItem(
    { id: 5, remote_path: 'computers/PC/E' },
    'temporary/new-file.tmp',
    { status: 'dirty' }
  ),
  null
);

const packSettings = { enabled: true, smallFileMaxBytes: 64, maxRawBytes: 100, maxFiles: 2 };
assert.strictEqual(
  rclone.__private.isNotFoundError(new Error("CRITICAL: Source doesn't exist or is a directory")),
  true,
  'A missing prior remote source must be treated as absent during version promotion.'
);
assert.ok(packStore.shouldPackItem({ size: 64 }, packSettings));
assert.ok(!packStore.shouldPackItem({ size: 65 }, packSettings));
assert.deepStrictEqual(
  packStore.groupPackItems([
    { relativePath: 'a.txt', size: 10 },
    { relativePath: 'b.txt', size: 10 },
    { relativePath: 'c.txt', size: 10 }
  ], packSettings).map(group => group.map(item => item.relativePath)),
  [['a.txt', 'b.txt'], ['c.txt']]
);
const packId = packStore.makePackId({ id: 1 }, 'run', 1, [{ relativePath: 'a.txt', size: 1, mtimeMs: 2 }]);
assert.ok(
  packStore.makePackRemotePath({ remote_path: 'computers/PC/E/root' }, packId)
    .startsWith(`${rclone.getVaultPath('packs', 'computers/PC/E/root')}/run-0001-`)
);

const restoreEntry = {
  remote_path: 'latest/file.txt',
  last_backed_up_at: '2026-01-03T00:00:00.000Z',
  versions: [
    { remote_path: 'history/t1/file.txt', created_at: '2026-01-02T00:00:00.000Z' }
  ]
};
assert.strictEqual(
  restorePlanner.chooseRemoteForTime(restoreEntry, new Date('2026-01-01T12:00:00.000Z').getTime()).remotePath,
  'history/t1/file.txt'
);
assert.strictEqual(
  restorePlanner.chooseRemoteForTime(restoreEntry, new Date('2026-01-04T00:00:00.000Z').getTime()).remotePath,
  'latest/file.txt'
);
const packedRestoreEntry = {
  remote_path: '.labsuite_packs/root/new.vspack',
  storage: 'pack',
  pack_remote_path: '.labsuite_packs/root/new.vspack',
  pack_member_path: 'nested/tiny.txt',
  last_backed_up_at: '2026-01-03T00:00:00.000Z',
  versions: [
    {
      remote_path: '.labsuite_packs/root/old.vspack',
      storage: 'pack',
      pack_remote_path: '.labsuite_packs/root/old.vspack',
      pack_member_path: 'nested/tiny.txt',
      created_at: '2026-01-03T00:00:00.000Z'
    }
  ]
};
const packedChoice = restorePlanner.chooseRemoteForTime(packedRestoreEntry, new Date('2026-01-02T12:00:00.000Z').getTime());
assert.strictEqual(packedChoice.storage, 'pack');
assert.strictEqual(packedChoice.packRemotePath, '.labsuite_packs/root/old.vspack');

const activityFolder = { id: 42, local_path: 'E:\\root', remote_path: 'computers/PC/E/root' };
const activityItem = { type: 'upload', relativePath: 'nested/file.txt', localPath: 'E:\\root\\nested\\file.txt', size: 123 };
assert.strictEqual(
  backupWorker.makeFileActivityId(activityFolder, activityItem),
  backupWorker.makeFileActivityId(activityFolder, activityItem)
);
const activity = backupWorker.makeFileActivity(activityFolder, activityItem, { status: 'failed', error: 'network timeout', retryCount: 2 });
assert.strictEqual(activity.id, '42:upload:nested/file.txt');
assert.strictEqual(activity.fileName, 'file.txt');
assert.strictEqual(activity.status, 'failed');
assert.strictEqual(activity.retryCount, 2);
assert.strictEqual(activity.error, 'network timeout');
const repairActivity = backupWorker.makeFileActivity(activityFolder, { ...activityItem, type: 'repair_active' }, { status: 'at_risk' });
assert.strictEqual(repairActivity.action, 'repair-active-copy');
assert.strictEqual(repairActivity.status, 'at_risk');
assert.strictEqual(
  backupWorker.findTransferItem([activityItem], 'email ebay extractor/test_profile/nested/file.txt'),
  activityItem
);
assert.strictEqual(backupWorker.watcherDebounceMs, 10000);
assert.strictEqual(backupWorker.watcherMaxWaitMs, 60000);
assert.strictEqual(remoteSafety.VAULT_MARKER_PATH, rclone.getVaultPath('control', 'vault-marker.json'));
assert.ok(network.__private.isWithinWindow('23:00', '06:00') === true || network.__private.isWithinWindow('23:00', '06:00') === false);

// Verify that the generated rclone process arguments include the chunk size.
const db = require('../main/database');
const getTransferFlagArgs = rclone.__private.getTransferFlagArgs;
const originalDriveChunkSize = db.getSetting('drive_chunk_size') || '';
let shouldRestoreDriveChunkSize = true;
process.on('exit', () => {
  if (shouldRestoreDriveChunkSize) {
    try { db.setSetting('drive_chunk_size', originalDriveChunkSize); } catch (_) {}
  }
});

// Test with chunk size not set (should not contain --drive-chunk-size)
db.setSetting('drive_chunk_size', '');
let rcloneArgs = getTransferFlagArgs();
assert.ok(!rcloneArgs.some(arg => arg.startsWith('--drive-chunk-size=')), 'Should not contain --drive-chunk-size when unset');

// Test with chunk size set to e.g. 64M
db.setSetting('drive_chunk_size', '64M');
rcloneArgs = getTransferFlagArgs();
assert.ok(rcloneArgs.includes('--drive-chunk-size=64M'), 'Should contain --drive-chunk-size=64M');

// Test with chunk size set to e.g. 128M
db.setSetting('drive_chunk_size', '128M');
rcloneArgs = getTransferFlagArgs();
assert.ok(rcloneArgs.includes('--drive-chunk-size=128M'), 'Should contain --drive-chunk-size=128M');

// Restore the developer's original setting instead of forcing it to empty.
db.setSetting('drive_chunk_size', originalDriveChunkSize);
shouldRestoreDriveChunkSize = false;

console.log('Backup logic verification passed.');
