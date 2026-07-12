const assert = require('assert');
const path = require('path');

// Mock electron before loading main/index.js
const mockElectron = {
  app: {
    setName: () => {},
    setAppUserModelId: () => {},
    requestSingleInstanceLock: () => true,
    on: () => {},
    isPackaged: true
  },
  BrowserWindow: class {},
  ipcMain: {
    handle: () => {}
  }
};
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: mockElectron
};

// Load main/index.js
require('../main/index');

// Verify that the late required modules are NOT in require.cache
const dbPath = require.resolve('../main/database');
const watcherPath = require.resolve('../main/watcher');
const schedulerPath = require.resolve('../main/scheduler');
const trayPath = require.resolve('../main/tray');
const ipcPath = require.resolve('../main/ipc');

assert.ok(!require.cache[dbPath], 'database.js should not be loaded at startup');
assert.ok(!require.cache[watcherPath], 'watcher.js should not be loaded at startup');
assert.ok(!require.cache[schedulerPath], 'scheduler.js should not be loaded at startup');
assert.ok(!require.cache[trayPath], 'tray.js should not be loaded at startup');
assert.ok(!require.cache[ipcPath], 'ipc.js should not be loaded at startup');

console.log('Lazy loading verification passed.');
