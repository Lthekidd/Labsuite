let app;
try {
  const electron = require('electron');
  app = electron.app;
} catch (e) {
  // Graceful fallback for non-Electron environments (e.g. testing)
}

const AUTOSTART_NAME = 'LabSuite';
const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function isPackagedRuntime() {
  return !!(app && app.isPackaged);
}

function getExecutablePath() {
  if (!app) return '';
  return app.getPath('exe');
}

function quoteWindowsArg(value) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function getWindowsRunCommand() {
  return `${quoteWindowsArg(getExecutablePath())} --hidden`;
}

function runReg(args) {
  const { spawnSync } = require('child_process');
  return spawnSync('reg.exe', args, {
    windowsHide: true,
    encoding: 'utf8'
  });
}

function setWindowsRunKey(enabled) {
  if (process.platform !== 'win32' || !isPackagedRuntime()) return true;

  try {
    if (enabled) {
      const result = runReg([
        'add',
        WINDOWS_RUN_KEY,
        '/v',
        AUTOSTART_NAME,
        '/t',
        'REG_SZ',
        '/d',
        getWindowsRunCommand(),
        '/f'
      ]);
      if (result.status !== 0) {
        console.warn('Autostart: Failed to write Windows Run key:', (result.stderr || result.stdout || '').trim());
        return false;
      }
      return true;
    }

    const result = runReg([
      'delete',
      WINDOWS_RUN_KEY,
      '/v',
      AUTOSTART_NAME,
      '/f'
    ]);
    if (result.status !== 0) {
      const output = `${result.stderr || ''}${result.stdout || ''}`.toLowerCase();
      if (output.includes('unable to find') || output.includes('not find')) return true;
      console.warn('Autostart: Failed to remove Windows Run key:', (result.stderr || result.stdout || '').trim());
      return false;
    }
    return true;
  } catch (error) {
    console.warn('Autostart: Windows Run key operation failed:', error.message);
    return false;
  }
}

function getWindowsRunKeyValue() {
  if (process.platform !== 'win32' || !isPackagedRuntime()) return '';

  try {
    const result = runReg([
      'query',
      WINDOWS_RUN_KEY,
      '/v',
      AUTOSTART_NAME
    ]);
    if (result.status !== 0) return '';

    const line = String(result.stdout || '')
      .split(/\r?\n/)
      .find(value => value.includes(AUTOSTART_NAME) && value.includes('REG_SZ'));
    if (!line) return '';

    const match = line.match(/REG_SZ\s+(.+)$/);
    return match ? match[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function hasCurrentWindowsRunKey() {
  const value = getWindowsRunKeyValue();
  if (!value) return false;
  const exePath = getExecutablePath().toLowerCase();
  return value.toLowerCase().includes(exePath);
}

/**
 * Configure whether the app should launch at system login
 */
function setAutostart(enabled) {
  if (!app) {
    console.log(`Autostart mock: set to ${enabled}`);
    return false;
  }

  if (!isPackagedRuntime()) {
    console.log(`Autostart dev mock: set to ${enabled}`);
    return true;
  }

  let electronOk = true;
  let windowsRunOk = true;

  try {
    app.setLoginItemSettings({
      name: AUTOSTART_NAME,
      openAtLogin: enabled,
      openAsHidden: true,
      path: getExecutablePath(),
      args: enabled ? ['--hidden'] : []
    });
    console.log(`Autostart: Successfully set openAtLogin to ${enabled}`);
  } catch (error) {
    console.error('Autostart: Failed to set login item settings:', error);
    electronOk = false;
  }

  windowsRunOk = setWindowsRunKey(enabled);
  return electronOk || windowsRunOk;
}

/**
 * Check if the app is configured to start at login
 */
function getAutostart() {
  if (!app) return false;
  if (!isPackagedRuntime()) return false;

  try {
    const settings = app.getLoginItemSettings({
      name: AUTOSTART_NAME,
      path: getExecutablePath(),
      args: ['--hidden']
    });
    return !!(settings.openAtLogin || hasCurrentWindowsRunKey());
  } catch (error) {
    console.error('Autostart: Failed to get login item settings:', error);
    return hasCurrentWindowsRunKey();
  }
}

function reconcileAutostart(enabled) {
  if (!app || !isPackagedRuntime()) return false;
  const actual = getAutostart();
  if (enabled !== actual || (enabled && process.platform === 'win32' && !hasCurrentWindowsRunKey())) {
    setAutostart(enabled);
  }
  return getAutostart();
}

module.exports = {
  setAutostart,
  getAutostart,
  reconcileAutostart,
  __private: {
    getWindowsRunCommand,
    getWindowsRunKeyValue,
    hasCurrentWindowsRunKey
  }
};
