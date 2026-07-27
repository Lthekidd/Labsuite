const path = require('path');
const { spawn, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const vitePath = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const smokePath = path.join(__dirname, 'smoke-electron-ui.js');
const port = 19700 + Math.floor(Math.random() * 200);

const vite = spawn(process.execPath, [vitePath,
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort'
], {
  cwd: root,
  windowsHide: true,
  stdio: 'ignore'
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForVite() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch (_) {}
  }
  throw new Error(`Vite did not start on port ${port}.`);
}

function stopVite() {
  try {
    execFileSync('taskkill.exe', ['/PID', String(vite.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
  } catch (_) {
    try { vite.kill(); } catch (_) {}
  }
}

async function main() {
  await waitForVite();
  const smoke = spawn(process.execPath, [smokePath], {
    cwd: root,
    env: {
      ...process.env,
      LABSUITE_UI_SMOKE_DEV: '1',
      VITE_PORT: String(port)
    },
    windowsHide: true,
    stdio: 'inherit'
  });
  const exitCode = await new Promise((resolve, reject) => {
    smoke.on('exit', code => resolve(code || 0));
    smoke.on('error', reject);
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

main()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(stopVite);
