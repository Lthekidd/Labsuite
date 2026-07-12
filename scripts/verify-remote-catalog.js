const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-catalog-'));
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: { app: { getPath: () => tempDir, isPackaged: false } }
};

try {
  const db = require('../main/database');
  db.setSetting('computer_aliases', JSON.stringify({ 'Test-PC': 'Office' }));
  const remoteCatalog = require('../main/remoteCatalog');
  const { catalog, payload } = remoteCatalog.__private.makeCatalogPayload();
  const parsed = JSON.parse(payload);
  assert.strictEqual(parsed.hashAlgorithm, 'json-v1');
  assert.deepStrictEqual(remoteCatalog.verifyCatalog(parsed), parsed);

  const legacyBody = { folders: [], backup_manifest: {}, restore_points: [] };
  const legacy = {
    format: 'labsuite-restore-catalog',
    version: 1,
    bodySha256: remoteCatalog.__private.sha256Json(legacyBody),
    body: legacyBody
  };
  assert.deepStrictEqual(remoteCatalog.verifyCatalog(legacy), legacy, 'Legacy stable-hash catalogs must remain readable.');

  const corrupt = JSON.parse(JSON.stringify(catalog));
  corrupt.body.settings.computer_aliases = '{}';
  assert.throws(() => remoteCatalog.verifyCatalog(corrupt), /checksum mismatch/);
  console.log('Remote catalog verification passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
