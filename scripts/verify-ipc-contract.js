const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const preload = fs.readFileSync(path.join(root, 'main', 'preload.js'), 'utf8');
const mainSources = [
  path.join(root, 'main', 'index.js'),
  path.join(root, 'main', 'ipc.js')
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
assert.ok(
  mainSources.includes('autoUpdater.quitAndInstall(true, true)'),
  'Downloaded updates must support silent installation followed by automatic relaunch.'
);
assert.ok(
  fs.readFileSync(path.join(root, 'renderer', 'apps', 'LabSuiteSettings.jsx'), 'utf8').includes('Restart & Install'),
  'Software Updates must expose the restart-and-install action.'
);

console.log(`IPC contract verification passed (${allowed.size} invoke channels).`);
