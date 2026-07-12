const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVICE_NAME = 'LabSuite';
const ACCOUNT_NAME = 'master';

let keytar = null;
try {
  keytar = require('keytar');
} catch (e) {}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script, input = '') {
  return execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePowerShell(script)
  ], {
    input,
    encoding: 'utf8',
    windowsHide: true
  }).trim();
}

async function getStoredPassword() {
  if (keytar) {
    return keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  }
  if (process.platform === 'win32') {
    try {
      const result = runPowerShell(`
        [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
        $vault = [Windows.Security.Credentials.PasswordVault]::new()
        try {
          $cred = $vault.Retrieve('${SERVICE_NAME}', '${ACCOUNT_NAME}')
          Write-Output $cred.Password
        } catch {
          exit 1
        }
      `);
      return result || null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

async function setStoredPassword(password) {
  if (keytar) {
    return keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, password);
  }
  if (process.platform === 'win32') {
    runPowerShell(`
      [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
      $password = [Console]::In.ReadToEnd()
      $vault = [Windows.Security.Credentials.PasswordVault]::new()
      try {
        $existing = $vault.Retrieve('${SERVICE_NAME}', '${ACCOUNT_NAME}')
        $vault.Remove($existing)
      } catch {}
      $cred = [Windows.Security.Credentials.PasswordCredential]::new('${SERVICE_NAME}', '${ACCOUNT_NAME}', $password)
      $vault.Add($cred)
    `, password);
    return true;
  }
  return false;
}

async function deleteStoredPassword() {
  if (keytar) {
    return keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
  }
  if (process.platform === 'win32') {
    try {
      runPowerShell(`
        [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
        $vault = [Windows.Security.Credentials.PasswordVault]::new()
        try {
          $cred = $vault.Retrieve('${SERVICE_NAME}', '${ACCOUNT_NAME}')
          $vault.Remove($cred)
          Write-Output 'true'
        } catch {
          Write-Output 'false'
        }
      `);
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

let originalPassword = null;
let passwordBackedUp = false;

async function backupCredentialManager() {
  try {
    originalPassword = await getStoredPassword();
    passwordBackedUp = true;
    await deleteStoredPassword();
  } catch (e) {
    console.error('Failed to backup credentials:', e);
  }
}

async function restoreCredentialManager() {
  if (!passwordBackedUp) return;
  try {
    if (originalPassword !== null) {
      await setStoredPassword(originalPassword);
    } else {
      await deleteStoredPassword();
    }
  } catch (e) {
    console.error('Failed to restore credentials:', e);
  }
}

// Environment Paths
const E2E_DIR = __dirname;
const REPO_ROOT = path.resolve(E2E_DIR, '..', '..');
const APP_USER_DATA = path.join(E2E_DIR, 'temp_user_data_app');
const RUNNER_USER_DATA = path.join(E2E_DIR, 'temp_user_data_runner');
const TEST_DRIVE = path.join(E2E_DIR, 'temp_test_drive');
const LOCAL_FILES = path.join(E2E_DIR, 'temp_local_files');

function getAppExecutable() {
  const packagedPath = path.join(REPO_ROOT, 'dist-packaged', 'win-unpacked', 'LabSuite.exe');
  if (process.env.LABSUITE_E2E_USE_PACKAGED === '1' && fs.existsSync(packagedPath)) {
    return packagedPath;
  }
  const localElectron = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(localElectron)) {
    return localElectron;
  }
  if (fs.existsSync(packagedPath)) {
    return packagedPath;
  }
  return 'electron';
}

function cleanDirectory(dirPath) {
  if (fs.existsSync(dirPath)) {
    let deleted = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        deleted = true;
        break;
      } catch (e) {
        if (attempt === 5) {
          console.warn(`Could not clean directory ${dirPath} after 5 attempts: ${e.message}`);
        } else {
          // Sleep for 250ms and retry
          try {
            execFileSync('powershell.exe', ['-Command', `Start-Sleep -Milliseconds 250`], { windowsHide: true });
          } catch (_) {}
        }
      }
    }
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function setupEnvironment({ setupComplete = false, folders = [], settings = {}, password = null, obscuredPassword = null } = {}) {
  // Clean all test folders
  cleanDirectory(APP_USER_DATA);
  cleanDirectory(RUNNER_USER_DATA);
  cleanDirectory(TEST_DRIVE);
  cleanDirectory(LOCAL_FILES);

  // If password is set but not obscured, we generate it using rclone obscure
  let finalObscuredPassword = obscuredPassword;
  if (password && !finalObscuredPassword) {
    try {
      const exe = getAppExecutable();
      let rcloneBin;
      if (exe.endsWith('LabSuite.exe')) {
        rcloneBin = path.join(REPO_ROOT, 'dist-packaged', 'win-unpacked', 'resources', 'bin', 'rclone-win.exe');
      } else {
        rcloneBin = path.join(REPO_ROOT, 'bin', 'rclone-win.exe');
      }
      if (!fs.existsSync(rcloneBin)) {
        rcloneBin = path.join(REPO_ROOT, 'dist-packaged-fixed', 'win-unpacked', 'resources', 'bin', 'rclone-win.exe');
      }
      if (fs.existsSync(rcloneBin)) {
        const out = execFileSync(rcloneBin, ['obscure', '-'], {
          input: password + '\n',
          encoding: 'utf8',
          windowsHide: true
        });
        finalObscuredPassword = out.trim();
      }
    } catch (e) {
      console.warn('Failed to obscure password using rclone:', e.message);
    }
  }

  // Pre-populate rclone.conf
  const rcloneConfPath = path.join(APP_USER_DATA, 'rclone.conf');
  let rcloneConfContent = `[gdrive]
type = alias
remote = ${TEST_DRIVE.replace(/\\/g, '/')}
`;

  if (password || finalObscuredPassword) {
    rcloneConfContent += `
[gdrive-crypt]
type = crypt
remote = gdrive:LabSuite-Encrypted
filename_encryption = standard
directory_name_encryption = true
password = ${finalObscuredPassword || 'dummyobscured'}
`;
  }

  fs.writeFileSync(rcloneConfPath, rcloneConfContent, 'utf8');

  // Pre-populate labsuite_db.json
  const dbPath = path.join(APP_USER_DATA, 'labsuite_db.json');
  const dbContent = {
    folders: folders.map(f => ({
      id: f.id || Date.now() + Math.floor(Math.random() * 1000),
      local_path: f.localPath,
      remote_path: f.remotePath || `computers/PC/${path.basename(f.localPath)}`,
      enabled: f.enabled !== undefined ? (f.enabled ? 1 : 0) : 1,
      encrypted: 1,
      added_at: new Date().toISOString(),
      last_success_at: f.lastSuccessAt || null,
      exclusions: f.exclusions || []
    })),
    backup_manifest: {},
    restore_points: [],
    sync_log: [],
    settings: {
      sync_interval_minutes: '15',
      sync_on_file_change: '1',
      start_on_login: '1',
      notifications_enabled: '1',
      bwlimit: '0',
      setup_complete: setupComplete ? '1' : '0',
      sync_paused: '0',
      password_hint: settings.password_hint || '',
      ...settings
    },
    cache: {}
  };

  fs.writeFileSync(dbPath, JSON.stringify(dbContent, null, 2), 'utf8');

  // Set up test credentials if password is provided
  if (password) {
    setStoredPassword(password);
  }
}

class AppInstance {
  constructor(child, ws) {
    this.child = child;
    this.ws = ws;
    this.messageId = 1;
    this.pendingRequests = new Map();

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const { resolve, reject } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else if (msg.result && msg.result.exceptionDetails) {
            reject(new Error(msg.result.exceptionDetails.exception.description || 'JS Exception'));
          } else if (msg.result && msg.result.result) {
            resolve(msg.result.result.value);
          } else {
            resolve(undefined);
          }
        }
      } catch (e) {
        console.error('Error handling WebSocket message:', e);
      }
    };
  }

  async evaluate(expression) {
    const id = this.messageId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true
        }
      }));
    });
  }

  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async query(selector, prop = 'innerText') {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el[${JSON.stringify(prop)}] : null;
    })()`;
    return this.evaluate(expr);
  }

  async queryAll(selector, prop = 'innerText') {
    const expr = `(() => {
      return Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(el => el[${JSON.stringify(prop)}]);
    })()`;
    return this.evaluate(expr);
  }

  async exists(selector) {
    const expr = `!!document.querySelector(${JSON.stringify(selector)})`;
    return this.evaluate(expr);
  }

  async click(selector) {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()`;
    return this.evaluate(expr);
  }

  async type(selector, text) {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    return this.evaluate(expr);
  }

  async waitForSelector(selector, timeout = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (await this.exists(selector)) {
        return true;
      }
      await this.wait(100);
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  async waitForText(selector, text, timeout = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const content = await this.query(selector);
      if (content && content.includes(text)) {
        return true;
      }
      await this.wait(100);
    }
    throw new Error(`Timeout waiting for text "${text}" in selector: ${selector}`);
  }

  async close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.child) {
      if (process.platform === 'win32') {
        try {
          const { execSync } = require('child_process');
          execSync(`taskkill /F /PID ${this.child.pid} /T`, { stdio: 'ignore' });
          execSync(`taskkill /F /IM rclone-win.exe`, { stdio: 'ignore' });
        } catch (e) {}
      } else {
        this.child.kill();
        try {
          const { execSync } = require('child_process');
          execSync(`killall rclone-mac`, { stdio: 'ignore' });
        } catch (e) {}
      }
      await this.wait(500);
      this.child = null;
    }
    
    // Poll until port 19222 is completely closed to avoid process leaks between tests
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch('http://localhost:19222/json');
        if (!res.ok) break;
        await this.wait(100);
      } catch (e) {
        break; // Port is closed
      }
    }
    
    await deleteStoredPassword();
  }
}

async function launchApp(extraArgs = [], env = {}) {
  const exe = getAppExecutable();
  const args = [];
  if (exe.endsWith('electron.exe') || exe === 'electron') {
    args.push(path.join(REPO_ROOT, 'main', 'index.js'));
  }
  args.push('--user-data-dir=' + APP_USER_DATA);
  args.push('--remote-debugging-port=19222');
  args.push(...extraArgs);

  const child = spawn(exe, args, {
    env: { ...process.env, LABSUITE_LOAD_DIST: '1', ...env },
    windowsHide: true
  });

  // Poll for WebSocket target
  let pageTarget = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      const res = await fetch('http://localhost:19222/json');
      if (res.ok) {
        const targets = await res.json();
        pageTarget = targets.find(t => t.type === 'page' || t.url.includes('localhost') || t.url.includes('index.html'));
        if (pageTarget && pageTarget.webSocketDebuggerUrl) {
          break;
        }
      }
    } catch (e) {}
  }

  if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
    child.kill();
    throw new Error('Failed to connect to remote debugging target on port 19222');
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(new Error('WebSocket connection failed: ' + err.message));
  });

  return new AppInstance(child, ws);
}

module.exports = {
  backupCredentialManager,
  restoreCredentialManager,
  setupEnvironment,
  launchApp,
  APP_USER_DATA,
  RUNNER_USER_DATA,
  TEST_DRIVE,
  LOCAL_FILES,
  REPO_ROOT,
  getStoredPassword,
  setStoredPassword,
  deleteStoredPassword
};
