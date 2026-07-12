const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_PORTS = [5173, 5174, 5175, 5176];
const ports = String(process.env.LABSUITE_DEV_PORTS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
  .map(Number)
  .filter(val => Number.isFinite(val) && val > 0);
const candidatePorts = ports.length > 0 ? ports : DEFAULT_PORTS;
const timeoutMs = Number(process.env.LABSUITE_DEV_WAIT_MS) || 60000;

function checkServer(port) {
  return new Promise(resolve => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/',
      timeout: 1200
    }, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitForVite() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const port of candidatePorts) {
      if (await checkServer(port)) return port;
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error(`Vite dev server did not become ready on ports ${candidatePorts.join(', ')}.`);
}

async function main() {
  const port = await waitForVite();
  const electronPath = require('electron');
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    VITE_PORT: String(port)
  };

  let child = null;
  let restartRequested = false;
  let restartTimer = null;
  let shuttingDown = false;

  const launchElectron = () => {
    if (shuttingDown) return;
    console.log(`Launching Electron against http://127.0.0.1:${port}/`);
    const electronArgs = [];
    const inspectPort = Number(process.env.LABSUITE_INSPECT_PORT) || 0;
    if (inspectPort > 0) electronArgs.push(`--inspect=${inspectPort}`);
    electronArgs.push('.');
    child = spawn(electronPath, electronArgs, {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
      windowsHide: false
    });

    child.on('exit', (code, signal) => {
      child = null;
      if (restartRequested && !shuttingDown) {
        restartRequested = false;
        launchElectron();
        return;
      }
      if (shuttingDown) return;
      process.exit(signal ? 1 : (code || 0));
    });
    child.on('error', error => {
      console.error('Failed to launch Electron:', error.message);
      process.exit(1);
    });
  };

  const requestRestart = () => {
    if (shuttingDown) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartRequested = true;
      if (child && !child.killed) {
        console.log('Main or preload code changed; restarting Electron.');
        child.kill();
      } else {
        restartRequested = false;
        launchElectron();
      }
    }, 150);
  };

  // Renderer changes are handled by Vite HMR.  Main-process and preload
  // changes need a fresh Electron process; otherwise the old preload bridge
  // keeps rejecting newly added IPC channels until a manual restart.
  fs.watch(path.join(process.cwd(), 'main'), { recursive: true }, (_event, filename) => {
    if (filename && /\.(?:js|json)$/i.test(filename)) requestRestart();
  });

  const stopChild = () => {
    shuttingDown = true;
    clearTimeout(restartTimer);
    if (child && !child.killed) child.kill();
  };
  process.on('SIGINT', stopChild);
  process.on('SIGTERM', stopChild);

  launchElectron();
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
