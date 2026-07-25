const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-notepad-'));
const sharedDisabledRoot = path.join(tempDir, 'lan-disabled');
const disabledRoot = path.join(tempDir, 'backup-disabled');
const selectiveRoot = path.join(tempDir, 'selective');

fs.mkdirSync(sharedDisabledRoot);
fs.mkdirSync(disabledRoot);
fs.mkdirSync(selectiveRoot);

const allowedNote = path.join(sharedDisabledRoot, 'allowed.TXT');
const disabledNote = path.join(disabledRoot, 'disabled.txt');
const selectedNote = path.join(selectiveRoot, 'selected.txt');
const unselectedNote = path.join(selectiveRoot, 'unselected.txt');

fs.writeFileSync(allowedNote, 'allowed', 'utf8');
fs.writeFileSync(disabledNote, 'disabled', 'utf8');
fs.writeFileSync(selectedNote, 'selected', 'utf8');
fs.writeFileSync(unselectedNote, 'unselected', 'utf8');

const folders = [
  {
    id: 1,
    local_path: sharedDisabledRoot,
    enabled: 1,
    share_on_lan: false
  },
  {
    id: 2,
    local_path: disabledRoot,
    enabled: 0,
    share_on_lan: true
  },
  {
    id: 3,
    local_path: selectiveRoot,
    enabled: 1,
    share_on_lan: true,
    include_paths: ['selected.txt']
  }
];

const databasePath = require.resolve('../main/database');
const fastDriveSyncPath = require.resolve('../main/fastDriveSync');
const fastCryptPath = require.resolve('../main/fastCrypt');

require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: {
    getEnabledFolders: () => folders.filter(folder => folder.enabled === 1),
    getDb: () => ({ settings: { use_default_exclusions: '1' } })
  }
};
require.cache[fastDriveSyncPath] = {
  id: fastDriveSyncPath,
  filename: fastDriveSyncPath,
  loaded: true,
  exports: {}
};
require.cache[fastCryptPath] = {
  id: fastCryptPath,
  filename: fastCryptPath,
  loaded: true,
  exports: {}
};

try {
  const notepadEngine = require('../main/notepadEngine');
  const listedPaths = notepadEngine.listLocal().map(file => path.resolve(file.path));

  assert.ok(
    listedPaths.includes(path.resolve(allowedNote)),
    'LAN sharing must not control Secure Notebook access.'
  );
  assert.ok(
    listedPaths.includes(path.resolve(selectedNote)),
    'A selected standalone text file should be listed.'
  );
  assert.ok(
    !listedPaths.includes(path.resolve(disabledNote)),
    'Text files from disabled backups must not be listed.'
  );
  assert.ok(
    !listedPaths.includes(path.resolve(unselectedNote)),
    'Siblings of a standalone-file backup must not be listed.'
  );
  for (const listedPath of listedPaths) {
    assert.strictEqual(
      notepadEngine.assertAllowedTextFile(listedPath),
      listedPath,
      'Every note shown in the sidebar must pass the open-file allowlist.'
    );
  }

  assert.strictEqual(notepadEngine.assertAllowedTextFile(allowedNote), path.resolve(allowedNote));
  assert.strictEqual(notepadEngine.assertAllowedTextFile(selectedNote), path.resolve(selectedNote));
  if (fs.realpathSync.native) {
    const originalRealpathNative = fs.realpathSync.native;
    fs.realpathSync.native = filePath => `\\\\?\\${originalRealpathNative(filePath).replace(/^\\\\\\?\\/, '')}`;
    try {
      assert.strictEqual(
        notepadEngine.assertAllowedTextFile(allowedNote),
        path.resolve(allowedNote),
        'Windows extended-length paths must still match their configured backup root.'
      );
    } finally {
      fs.realpathSync.native = originalRealpathNative;
    }
  }
  assert.throws(() => notepadEngine.assertAllowedTextFile(disabledNote), /configured backup folders/);
  assert.throws(() => notepadEngine.assertAllowedTextFile(unselectedNote), /configured backup folders/);
  assert.throws(
    () => notepadEngine.assertAllowedTextFile(path.join(sharedDisabledRoot, 'not-text.md')),
    /only open text files/
  );

  console.log('Secure Notebook path verification passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
