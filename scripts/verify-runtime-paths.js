const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getBundledRcloneCandidates,
  resolveBundledRclonePath
} = require('../main/runtimePaths');

const root = path.join(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-runtime-paths-'));

try {
  const resourcesPath = path.join(tempRoot, 'resources');
  const packagedPath = path.join(resourcesPath, 'bin', 'rclone-win.exe');
  const legacyPath = path.join(resourcesPath, 'app.asar.unpacked', 'bin', 'rclone-win.exe');

  fs.mkdirSync(path.dirname(packagedPath), { recursive: true });
  fs.writeFileSync(packagedPath, 'packaged rclone');
  assert.strictEqual(
    resolveBundledRclonePath({ isPackaged: true, resourcesPath, platform: 'win32' }),
    packagedPath,
    'Packaged builds must prefer electron-builder extraResources at resources/bin.'
  );

  fs.rmSync(packagedPath, { force: true });
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, 'legacy rclone');
  assert.strictEqual(
    resolveBundledRclonePath({ isPackaged: true, resourcesPath, platform: 'win32' }),
    legacyPath,
    'Packaged builds must retain the legacy app.asar.unpacked fallback.'
  );

  fs.rmSync(legacyPath, { force: true });
  const expectedCandidates = getBundledRcloneCandidates({ isPackaged: true, resourcesPath, platform: 'win32' });
  assert.throws(
    () => resolveBundledRclonePath({ isPackaged: true, resourcesPath, platform: 'win32' }),
    error => error.code === 'RCLONE_BINARY_MISSING'
      && expectedCandidates.every(candidate => error.message.includes(candidate)),
    'A missing packaged binary must report every checked location.'
  );

  const modules = ['rclone.js', 'webdavServer.js', 'fastDriveSync.js'];
  for (const moduleName of modules) {
    const source = fs.readFileSync(path.join(root, 'main', moduleName), 'utf8');
    assert.match(source, /resolveBundledRclonePath/);
    assert.doesNotMatch(source, /app\.asar\.unpacked['"],\s*['"]bin/);
  }

  const builderConfig = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.match(builderConfig, /- from: bin\s+[\s\S]*?to: bin/);

  const releaseWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-windows.yml'), 'utf8');
  const downloadStepIndex = releaseWorkflow.indexOf('run: npm run download-rclone');
  const testStepIndex = releaseWorkflow.indexOf('run: npm test');
  const packageStepIndex = releaseWorkflow.indexOf('run: npx electron-builder --win --publish never');
  assert.ok(downloadStepIndex >= 0, 'Fresh release runners must download the excluded rclone binary.');
  assert.ok(downloadStepIndex < testStepIndex, 'rclone must be downloaded before the automated test suite.');
  assert.ok(downloadStepIndex < packageStepIndex, 'rclone must be downloaded before electron-builder packages extraResources.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('Runtime path verification passed (packaged, legacy, and missing-rclone layouts).');
