const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-db-large-'));
const dbPath = path.join(tempDir, 'labsuite_db.json');
const manifest = {};
for (let index = 0; index < 22000; index += 1) {
  manifest[`folder/file-${index}.txt`] = {
    folder_id: 1,
    relative_path: `folder/file-${index}.txt`,
    local_path: `C:\\LargeFolder\\file-${index}.txt`,
    remote_path: `computers/Test/LargeFolder/file-${index}.txt`,
    status: 'backed_up',
    size: index,
    mtime_ms: 1700000000000 + index,
    last_backed_up_at: '2026-07-12T00:00:00.000Z',
    versions: []
  };
}
const initial = {
  folders: [{ id: 1, local_path: 'C:\\LargeFolder', remote_path: 'computers/Test/LargeFolder', enabled: 1 }],
  backup_manifest: { 1: manifest },
  restore_points: [],
  sync_log: [],
  settings: { setup_complete: '1' },
  cache: {}
};
fs.writeFileSync(dbPath, JSON.stringify(initial), 'utf8');
assert.ok(fs.statSync(dbPath).size > 4 * 1024 * 1024, 'Fixture must exercise the large-database path.');

require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: { app: { getPath: () => tempDir } }
};

(async () => {
  try {
    const db = require('../main/database');
    const startedAt = Date.now();
    db.setSetting('async_write_sentinel', 'persisted');
    const schedulingMs = Date.now() - startedAt;
    assert.ok(schedulingMs < 500, `Large database mutation blocked for ${schedulingMs}ms.`);
    await db.flushWritesAsync();
    const saved = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    assert.strictEqual(saved.settings.async_write_sentinel, 'persisted');
    assert.ok(fs.existsSync(`${dbPath}.bak`), 'Large async writes must retain a recovery copy.');
    console.log(`Large database async verification passed (scheduled in ${schedulingMs}ms).`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
