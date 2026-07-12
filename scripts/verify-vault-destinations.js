const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-vault-destinations-'));
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: { app: { getPath: () => tempDir } }
};

const db = require('../main/database');
const rclonePath = require.resolve('../main/rclone');
const keychainPath = require.resolve('../main/keychain');
const destinationsPath = require.resolve('../main/vaultDestinations');
const copied = [];

const sourceRoots = new Set(['LabSuite-Encrypted', 'LabSuite-Control']);
const mockRclone = {
  getRawRemoteName: () => db.getSetting('active_raw_remote') || 'gdrive',
  getEncryptedFolder: () => 'LabSuite-Encrypted',
  getControlFolderName: () => 'LabSuite-Control',
  startGoogleAuthForRemote: async () => true,
  getGDriveInfoForRemote: async remote => ({
    email: `${remote}@example.test`, accountEmail: `${remote}@example.test`, displayName: 'Test Drive', used: 0, total: 10_000_000, free: 10_000_000
  }),
  remotePathExists: async (remote, remotePath) => remote === mockRclone.getRawRemoteName() && sourceRoots.has(remotePath),
  copyNamedRemoteTree: async (source, sourcePath, target, targetPath, options = {}) => {
    copied.push({ source, sourcePath, target, targetPath, mirror: !!options.mirror });
  },
  checkNamedRemoteTree: async () => true,
  getNamedRemoteSize: async (_remote, remotePath) => ({ bytes: remotePath === 'LabSuite-Encrypted' ? 4096 : 512, count: 3 }),
  createCryptRemoteFor: async () => true
};

require.cache[rclonePath] = { id: rclonePath, filename: rclonePath, loaded: true, exports: mockRclone };
require.cache[keychainPath] = { id: keychainPath, filename: keychainPath, loaded: true, exports: { getPassword: async () => 'test-master-password' } };
delete require.cache[destinationsPath];

try {
  const vaultDestinations = require('../main/vaultDestinations');

  (async () => {
    const migrationTarget = await vaultDestinations.connectDestination({ label: 'New primary' });
    const migrated = await vaultDestinations.transferToDestination(migrationTarget.id, 'migrate');
    assert.strictEqual(migrated.destination.isPrimary, true);
    assert.strictEqual(db.getSetting('active_raw_remote'), migrationTarget.rawRemote);
    assert.strictEqual(db.getSetting('active_crypt_remote'), migrationTarget.cryptRemote);
    assert.deepStrictEqual(copied.slice(0, 2).map(item => item.sourcePath).sort(), ['LabSuite-Control', 'LabSuite-Encrypted']);

    const replicaTarget = await vaultDestinations.connectDestination({ label: 'Replica' });
    const replicated = await vaultDestinations.transferToDestination(replicaTarget.id, 'replica');
    assert.strictEqual(replicated.destination.mode, 'replica');
    assert.strictEqual(replicated.destination.state, 'verified');

    const mirror = await vaultDestinations.replicateDestination(replicaTarget.id);
    assert.strictEqual(mirror.ok, true);
    assert.ok(copied.some(item => item.target === replicaTarget.rawRemote && item.mirror), 'Replica updates must use a vault mirror, not a local re-upload.');
    console.log('Vault destination verification passed.');
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} finally {
  process.on('exit', () => fs.rmSync(tempDir, { recursive: true, force: true }));
}
