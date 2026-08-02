const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const preload = fs.readFileSync(path.join(root, 'main', 'preload.js'), 'utf8');
const mainSources = [
  path.join(root, 'main', 'index.js'),
  path.join(root, 'main', 'ipc.js'),
  path.join(root, 'main', 'labShot.js'),
  path.join(root, 'main', 'labHwMonitor.js')
].map(filePath => fs.readFileSync(filePath, 'utf8')).join('\n');

const invokeBlock = preload.match(/const INVOKE_CHANNELS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(invokeBlock, 'Could not find the preload invoke-channel whitelist.');

const allowed = new Set(
  [...invokeBlock[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1])
);
const handled = new Set(
  [...mainSources.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map(match => match[1])
);
const missing = [...allowed].filter(channel => !handled.has(channel)).sort();

assert.deepStrictEqual(
  missing,
  [],
  `Preload invoke channels without main-process handlers: ${missing.join(', ')}`
);

assert.ok(
  mainSources.includes('const MOUNT_READY_TIMEOUT_MS = 45000;'),
  'Vault mount readiness window must accommodate Google Drive and WinFsp startup latency.'
);
assert.ok(
  mainSources.includes("'--read-only'"),
  'Restore disk mounts must not permit writes to the encrypted backup vault.'
);
assert.ok(allowed.has('updates:install'), 'The renderer must be allowed to request restart-and-install.');
assert.ok(allowed.has('sync:getShutdownAfterBackup'), 'The renderer must be able to read shutdown-after-backup state.');
assert.ok(allowed.has('sync:setShutdownAfterBackup'), 'The renderer must be able to arm and cancel shutdown after backup.');
assert.ok(allowed.has('diagnostics:copyCrashReports'), 'The renderer must be allowed to copy the seven-day crash archive.');
assert.ok(allowed.has('diagnostics:openCrashReportsFolder'), 'The renderer must be allowed to open the crash-report folder.');
assert.ok(
  mainSources.includes("'theme',") && mainSources.includes('RENDERER_WRITABLE_SETTINGS'),
  'Theme changes must be writable through the renderer settings contract.'
);
assert.ok(
  mainSources.includes('autoUpdater.quitAndInstall(true, true)'),
  'Downloaded updates must support silent installation followed by automatic relaunch.'
);
assert.ok(
  fs.readFileSync(path.join(root, 'renderer', 'apps', 'LabSuiteSettings.jsx'), 'utf8').includes('Restart & Install'),
  'Software Updates must expose the restart-and-install action.'
);
assert.ok(
  fs.readFileSync(path.join(root, 'renderer', 'apps', 'LabSuiteSettings.jsx'), 'utf8').includes('Copy Crash Reports'),
  'Suite Settings must expose the one-click crash-report copy action.'
);
const backupUiSource = fs.readFileSync(path.join(root, 'renderer', 'apps', 'LabSuiteBackup.jsx'), 'utf8');
const backupCssSource = fs.readFileSync(path.join(root, 'renderer', 'index.css'), 'utf8');
assert.ok(backupUiSource.includes('Shut down after backup'), 'Activity controls must expose shutdown after backup.');
assert.ok(backupUiSource.includes('Cancel scheduled shutdown'), 'The automatic shutdown must remain cancelable during its grace period.');
assert.ok(
  backupCssSource.includes('.activity-header') && backupCssSource.includes('flex-direction: column'),
  'The Activity title must remain above its button row.'
);
assert.ok(
  mainSources.includes("backupWorker.on('backup:idle'") && mainSources.includes("shutdown.exe', ['/s', '/t'") && mainSources.includes("shutdown.exe', ['/a']"),
  'Shutdown after backup must wait for idle and provide native Windows cancellation.'
);
assert.ok(
  mainSources.includes("app.exit(0);") && mainSources.includes("if (!gotTheLock)"),
  'Duplicate LabSuite processes must exit immediately before starting backup services.'
);
assert.ok(
  mainSources.includes('Object.values(db.getManifestEntries(folder.id)).map'),
  'VM Protect reconciliation must convert manifest entry maps before iterating them.'
);

console.log(`IPC contract verification passed (${allowed.size} invoke channels).`);
