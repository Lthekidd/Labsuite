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
const useDevRenderer = process.env.LABSUITE_UI_SMOKE_DEV === '1';
fs.mkdirSync(fakeDrive, { recursive: true });

fs.writeFileSync(path.join(tempDir, 'rclone.conf'), `[gdrive]\ntype = alias\nremote = ${fakeDrive.replace(/\\/g, '/')}\n`, 'utf8');
const seededFolders = Array.from({ length: 80 }, (_, index) => ({
  id: index + 1,
  local_path: path.join(tempDir, 'seeded-folders', `folder-${index + 1}`),
  remote_path: `computers/Smoke Test/folder-${index + 1}`,
  enabled: 1,
  encrypted: 1,
  added_at: new Date(1700000000000 + index * 1000).toISOString(),
  last_success_at: new Date(1700100000000 + index * 1000).toISOString(),
  exclusions: []
}));
const seededManifest = Object.fromEntries(seededFolders.map(folder => ([
  String(folder.id),
  Object.fromEntries(Array.from({ length: 100 }, (_, index) => ([
    `file-${index}.txt`,
    {
      relative_path: `file-${index}.txt`,
      status: index % 37 === 0 ? 'failed' : 'backed_up',
      size_bytes: 1024 + index,
      versions: []
    }
  ])))
])));
const seededLogs = Array.from({ length: 5000 }, (_, index) => ({
  id: index + 1,
  folder_id: (index % seededFolders.length) + 1,
  file_path: `file-${index}.txt`,
  status: index % 41 === 0 ? 'failed' : 'success',
  size_bytes: 1024 + index,
  synced_at: new Date(1700200000000 + index * 1000).toISOString()
}));
fs.writeFileSync(path.join(tempDir, 'labsuite_db.json'), JSON.stringify({
  folders: seededFolders,
  backup_manifest: seededManifest,
  restore_points: [],
  sync_log: seededLogs,
  settings: {
    setup_complete: '1',
    sync_paused: '1',
    start_on_login: '0',
    installed_apps: JSON.stringify(['notebook', 'sheets', 'lan', 'vm-protect', 'todo', 'labshot', 'hwmonitor'])
  },
  cache: {}
}), 'utf8');

const child = spawn(electronPath, [
  path.join(root, 'main', 'index.js'),
  `--user-data-dir=${tempDir}`,
  `--remote-debugging-port=${port}`
], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: useDevRenderer ? 'development' : process.env.NODE_ENV,
    LABSUITE_LOAD_DIST: useDevRenderer ? '0' : '1'
  },
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
  assert.strictEqual(
    await evaluate(`(() => {
      const name = document.querySelector('.suite-device-name')?.textContent.trim();
      return !!name && name !== 'This PC';
    })()`),
    true,
    'Sidebar did not render the Windows PC name.'
  );

  await evaluate(`(() => {
    window.__labsuiteLongTasks = [];
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      window.__labsuiteLongTaskObserver = new PerformanceObserver(list => {
        window.__labsuiteLongTasks.push(...list.getEntries().map(entry => entry.duration));
      });
      window.__labsuiteLongTaskObserver.observe({ type: 'longtask' });
    }
    return true;
  })()`);

  const labels = ['Network Drive', 'VM Protect', 'Encrypted Tables', 'Secure Notebook', 'Task Board', 'LabShot', 'LabHWMonitor', 'Crypto Portfolio', 'Suite Settings'];
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
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await response.json();
      const vmWindowOpened = targets.some(item => (
        item.type === 'page' && String(item.url || '').includes('app=vm-protect')
      ));
      assert.strictEqual(vmWindowOpened, true, 'VM Protect standalone window did not open.');
    }
  }

  assert.strictEqual(await evaluate(`(async () => {
    const panel = document.querySelector('[data-workspace-id="settings"]');
    const label = [...panel.querySelectorAll('div')]
      .find(item => item.textContent.trim() === 'Cyberpunk Neon');
    if (!label) return false;
    label.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const settings = await window.electron.ipcRenderer.invoke('settings:get');
    return settings.theme === 'cyberpunk' && document.body.classList.contains('theme-cyberpunk');
  })()`), true, 'Theme selection did not persist through the settings IPC contract.');

  assert.strictEqual(await evaluate(`(async () => {
    const panel = document.querySelector('[data-workspace-id="settings"]');
    const button = [...panel.querySelectorAll('button')]
      .find(item => item.textContent.trim() === 'Copy Crash Reports');
    if (!button) return false;
    button.click();
    await new Promise(resolve => setTimeout(resolve, 150));
    return panel.textContent.includes('Copied a diagnostic summary')
      || panel.textContent.includes('crash diagnostic item');
  })()`), true, 'Crash reports could not be copied from Suite Settings.');

  const timedNavigation = async (label, workspaceId) => {
    const alreadyActive = await evaluate(
      `document.querySelector('[data-workspace-id="${workspaceId}"]')?.dataset.workspaceActive === 'true'`
    );
    if (alreadyActive) {
      const fallbackLabel = workspaceId === 'hub' ? 'Backup Engine' : 'App Hub';
      const movedAway = await evaluate(`(() => {
        const fallback = [...document.querySelectorAll('.suite-sidebar .nav-item')]
          .find(item => item.textContent.includes(${JSON.stringify(fallbackLabel)}));
        if (!fallback) return false;
        fallback.click();
        return true;
      })()`);
      assert.strictEqual(movedAway, true, `Could not leave ${label} before measuring navigation.`);
      await wait(100);
    }

    const duration = await evaluate(`new Promise((resolve, reject) => {
      const button = [...document.querySelectorAll('.suite-sidebar .nav-item')]
        .find(item => item.textContent.includes(${JSON.stringify(label)}));
      if (!button) {
        reject(new Error('Missing navigation item: ' + ${JSON.stringify(label)}));
        return;
      }
      performance.clearMeasures(${JSON.stringify(`workspace-nav-${workspaceId}`)});
      button.click();
      const startedAt = performance.now();
      const check = () => {
        const panel = document.querySelector(
          '[data-workspace-id=${workspaceId}][data-workspace-active="true"]'
        );
        const measurement = performance.getEntriesByName(
          ${JSON.stringify(`workspace-nav-${workspaceId}`)},
          'measure'
        ).at(-1);
        if (panel && measurement) {
          resolve(measurement.duration);
          return;
        }
        if (performance.now() - startedAt > 3000) {
          const panel = document.querySelector('[data-workspace-id="${workspaceId}"]');
          const marks = performance.getEntriesByName(
            ${JSON.stringify(`workspace-nav-${workspaceId}-start`)},
            'mark'
          ).length;
          reject(new Error(
            'Timed out navigating to ${workspaceId} (active=' +
            panel?.dataset.workspaceActive + ', startMarks=' + marks + ')'
          ));
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    })`);
    assert.ok(Number.isFinite(duration), `${label} did not produce a navigation measurement.`);
    return duration;
  };

  // Warm every embedded workspace, then measure repeated navigation.
  await timedNavigation('Backup Engine', 'backup');
  await timedNavigation('Telegram Backup', 'telegram');
  await timedNavigation('Crypto Portfolio', 'crypto');
  await timedNavigation('Suite Settings', 'settings');
  await timedNavigation('App Hub', 'hub');
  assert.strictEqual(await evaluate(`(() => {
    const panel = document.querySelector('[data-workspace-id="hub"]');
    const restartButton = [...panel.querySelectorAll('button')]
      .find(item => item.textContent.trim() === 'Restart Internet');
    const refreshPublicIpButton = panel.querySelector('button[aria-label="Refresh public IP"]');
    if (!restartButton || !refreshPublicIpButton) return false;
    restartButton.click();
    return true;
  })()`), true, 'App Hub did not render the Restart Internet action and public-IP refresh control.');
  await wait(100);
  assert.strictEqual(await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="router-login-title"]');
    const address = dialog?.querySelector('#router-address')?.value;
    return !!dialog
      && address === 'http://192.168.100.1'
      && dialog.textContent.includes('Windows Credential Manager');
  })()`), true, 'Restart Internet did not open the secure router-login dialog.');
  await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="router-login-title"]');
    const cancel = [...dialog.querySelectorAll('button')].find(item => item.textContent.trim() === 'Cancel');
    cancel.click();
  })()`);
  await timedNavigation('Secure Notebook', 'notebook');
  await evaluate(`window.__labsuiteLongTasks = []`);

  const warmDurations = [];
  for (let pass = 0; pass < 4; pass += 1) {
    warmDurations.push(await timedNavigation('Backup Engine', 'backup'));
    warmDurations.push(await timedNavigation('Crypto Portfolio', 'crypto'));
    warmDurations.push(await timedNavigation('Telegram Backup', 'telegram'));
    warmDurations.push(await timedNavigation('Suite Settings', 'settings'));
  }
  const sortedDurations = [...warmDurations].sort((a, b) => a - b);
  const p95 = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1];
  const navigationBudget = useDevRenderer ? 200 : 100;
  assert.ok(
    p95 <= navigationBudget,
    `Warm navigation p95 was ${p95.toFixed(1)}ms (budget: ${navigationBudget}ms).`
  );

  // Backup subtab state must survive leaving and returning to the workspace.
  await timedNavigation('Backup Engine', 'backup');
  assert.strictEqual(await evaluate(`(() => {
    const panel = document.querySelector('[data-workspace-id="backup"]');
    const button = [...panel.querySelectorAll('button')].find(item => item.textContent.trim() === 'Restore');
    if (!button) return false;
    button.click();
    return true;
  })()`), true, 'Could not select the Backup Restore subtab.');
  await timedNavigation('Crypto Portfolio', 'crypto');
  await timedNavigation('Backup Engine', 'backup');
  assert.strictEqual(await evaluate(`(() => {
    const panel = document.querySelector('[data-workspace-id="backup"]');
    const button = [...panel.querySelectorAll('button')].find(item => item.textContent.trim() === 'Restore');
    return !!button && button.classList.contains('btn-primary');
  })()`), true, 'Backup subtab state was lost during navigation.');

  const duplicateWorkspaceIds = await evaluate(`(() => {
    const counts = {};
    for (const panel of document.querySelectorAll('[data-workspace-id]')) {
      counts[panel.dataset.workspaceId] = (counts[panel.dataset.workspaceId] || 0) + 1;
    }
    return Object.entries(counts).filter(([, count]) => count !== 1);
  })()`);
  assert.deepStrictEqual(duplicateWorkspaceIds, [], 'Navigation created duplicate workspace panels.');

  const bootstrapRequestCounts = await evaluate(`(() => {
    const rows = window.__labsuiteResourceCache?.snapshot?.() || [];
    const counts = {};
    for (const row of rows) {
      counts[row.channel] = (counts[row.channel] || 0) + row.requestCount;
    }
    return counts;
  })()`);
  assert.ok(
    (bootstrapRequestCounts['settings:get'] || 0) <= 1,
    `settings:get ran ${bootstrapRequestCounts['settings:get']} times instead of sharing its bootstrap request.`
  );
  assert.ok(
    (bootstrapRequestCounts['app:getVersion'] || 0) <= 1,
    `app:getVersion ran ${bootstrapRequestCounts['app:getVersion']} times instead of sharing its bootstrap request.`
  );

  const longTasks = await evaluate(`window.__labsuiteLongTasks || []`);
  const navigationLongTasks = longTasks.filter(duration => duration > 50);
  assert.strictEqual(
    navigationLongTasks.length,
    0,
    `Navigation produced ${navigationLongTasks.length} long task(s) over 50ms.`
  );

  socket.close();
  console.log(`Electron UI smoke verification passed (${useDevRenderer ? 'development' : 'production'}, ${labels.length} lazy-loaded workspaces, warm p95 ${p95.toFixed(1)}ms).`);
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
