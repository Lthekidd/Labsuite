const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let webdavProcess = null;
let webdavStatus = null;

function getRcloneBin() {
  let isPackaged = false;
  try {
    const { app } = require('electron');
    isPackaged = app.isPackaged;
  } catch (e) {}

  return isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', process.platform === 'win32' ? 'rclone-win.exe' : 'rclone-mac')
    : path.join(__dirname, '../bin', process.platform === 'win32' ? 'rclone-win.exe' : 'rclone-mac');
}

function normalizePort(value, fallback = 41235) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('WebDAV port must be between 1024 and 65535.');
  }
  return port;
}

function startWebdavServer(folderPath, options = {}) {
  if (webdavProcess) throw new Error('WebDAV server already running');

  const requestedPath = String(folderPath || '').trim();
  if (!path.isAbsolute(requestedPath)) throw new Error('Shared folder path must be absolute.');
  if (!fs.existsSync(requestedPath)) throw new Error('Shared folder does not exist.');
  if (!fs.statSync(requestedPath).isDirectory()) throw new Error('Shared path must be a folder.');

  const port = normalizePort(options.port);
  const host = options.allowLan ? '0.0.0.0' : '127.0.0.1';
  const username = 'labsuite';
  const password = crypto.randomBytes(24).toString('base64url');

  const rcloneBin = getRcloneBin();
  const args = [
    'serve', 'webdav',
    requestedPath,
    '--addr', `${host}:${port}`,
    '--vfs-cache-mode', 'writes',
    '--user', username,
    '--pass', password
  ];

  return new Promise((resolve, reject) => {
    const processHandle = spawn(rcloneBin, args, { windowsHide: true });
    webdavProcess = processHandle;
    let settled = false;
    let stderr = '';

    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    processHandle.stderr.on('data', chunk => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    
    processHandle.on('error', err => {
      console.error('WebDAV process error:', err.message);
      if (webdavProcess === processHandle) webdavProcess = null;
      rejectOnce(err);
    });

    processHandle.on('close', code => {
      if (webdavProcess === processHandle) webdavProcess = null;
      webdavStatus = null;
      rejectOnce(new Error(`WebDAV server exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });

    setTimeout(() => {
      if (!settled && webdavProcess === processHandle && processHandle.exitCode === null && !processHandle.killed) {
        settled = true;
        processHandle.started = true;
        webdavStatus = {
          port,
          host,
          url: `http://127.0.0.1:${port}`,
          lanEnabled: !!options.allowLan,
          username,
          password
        };
        resolve(webdavStatus);
      } else {
        rejectOnce(new Error('Failed to start WebDAV server'));
      }
    }, 1000);
  });
}

function stopWebdavServer() {
  if (webdavProcess && !webdavProcess.killed) {
    webdavProcess.kill();
  }
  webdavProcess = null;
  webdavStatus = null;
}

module.exports = {
  startWebdavServer,
  stopWebdavServer,
  getStatus: () => webdavStatus
};
