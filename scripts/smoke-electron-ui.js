const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const root = path.join(__dirname, '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-ui-smoke-'));
const fakeDrive = path.join(tempDir, 'drive');
const port = 19300 + Math.floor(Math.random() * 300);
fs.mkdirSync(fakeDrive, { recursive: true });

fs.writeFileSync(path.join(tempDir, 'rclone.conf'), `[gdrive]\ntype = alias\nremote = ${fakeDrive.replace(/\\/g, '/')}\n`, 'utf8');
fs.writeFileSync(path.join(tempDir, 'labsuite_db.json'), JSON.stringify({
  folders: [],
  backup_manifest: {},
  restore_points: [],
  sync_log: [],
  settings: { setup_complete: '1', sync_paused: '1', start_on_login: '0' },
  cache: {}
}), 'utf8');

const child = spawn(electronPath, [
  path.join(root, 'main', 'index.js'),
  `--user-data-dir=${tempDir}`,
  `--remote-debugging-port=${port}`
], {
  cwd: root,
  env: { ...process.env, LABSUITE_LOAD_DIST: '1' },
  windowsHide: true,
  stdio: 'ignore'
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getDebugTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(200);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (!response.ok) continue;
      const targets = await response.json();
      const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch (_) {}
  }
  throw new Error('Electron renderer did not expose a debugging target.');
}

async function run() {
  const target = await getDebugTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('Could not connect to Electron renderer.'));
  });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer evaluation failed.');
    return result.result && result.result.value;
  };

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate(`!!document.querySelector('.app-body')`)) break;
    await wait(100);
  }
  assert.strictEqual(await evaluate(`!!document.querySelector('.app-body')`), true, 'Main UI did not render.');

  const labels = ['Network Drive', 'VM Protect', 'Encrypted Tables', 'Secure Notebook', 'Task Board', 'Crypto Portfolio', 'Suite Settings'];
  for (const label of labels) {
    const clicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('.suite-sidebar .nav-item')]
        .find(item => item.textContent.includes(${JSON.stringify(label)}));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.strictEqual(clicked, true, `Could not navigate to ${label}.`);
    await wait(350);
    const crashed = await evaluate(`document.body.innerText.includes('Something went wrong')`);
    assert.strictEqual(crashed, false, `${label} crashed its UI boundary.`);
    const blockedIpc = await evaluate(`document.body.innerText.includes('Channel not allowed')`);
    assert.strictEqual(blockedIpc, false, `${label} attempted to use a blocked IPC channel.`);
    if (label === 'VM Protect') {
      const vmWorkspaceRendered = await evaluate(`document.body.innerText.includes('Detected virtual machines')`);
      assert.strictEqual(vmWorkspaceRendered, true, 'VM Protect did not render its discovery workspace.');
    }
  }

  socket.close();
  console.log(`Electron UI smoke verification passed (${labels.length} lazy-loaded workspaces).`);
}

run().finally(() => {
  try {
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch (_) {
    try { child.kill(); } catch (_) {}
  }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}).catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
