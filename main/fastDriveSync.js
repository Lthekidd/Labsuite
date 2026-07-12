const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const APPS_FOLDER = 'LabSuite-Apps';

function getRawRemote() {
  return require('./rclone').getRawRemoteName();
}

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

function getConfigPath() {
  let userDataDir;
  try {
    const { app } = require('electron');
    userDataDir = app.getPath('userData');
  } catch (e) {
    userDataDir = path.join(__dirname, '../data');
  }
  return path.join(userDataDir, 'rclone.conf');
}

function runRcloneCommand(args, options = {}) {
  return new Promise((resolve, reject) => {
    const rcloneBin = getRcloneBin();
    const configPath = getConfigPath();
    const fullArgs = [...args, '--config', configPath];
    const timeoutMs = Number(options.timeoutMs) || 12000;
    
    const proc = spawn(rcloneBin, fullArgs, { windowsHide: true });
    
    let stderr = '';
    let stdout = '';
    let settled = false;
    let timeoutTimer = null;

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(value);
    };

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      reject(error);
    };

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        try { proc.kill(); } catch (_) {}
        rejectOnce(new Error(`rclone fast sync timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    
    proc.stdout.on('data', data => stdout += data.toString());
    proc.stderr.on('data', data => stderr += data.toString());
    
    proc.on('close', code => {
      if (code === 0) resolveOnce(stdout);
      else rejectOnce(new Error(`rclone error: ${stderr}`));
    });
    
    proc.on('error', err => rejectOnce(err));
  });
}

async function uploadData(appName, fileName, data) {
  const os = require('os');
  const tempPath = path.join(os.tmpdir(), `vs-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  fs.writeFileSync(tempPath, data);
  const remotePath = `${getRawRemote()}:/${APPS_FOLDER}/${appName}/${fileName}`;
  try {
    await runRcloneCommand(['copyto', tempPath, remotePath], { timeoutMs: 20000 });
  } finally {
    try { fs.unlinkSync(tempPath); } catch (e) {}
  }
}

async function downloadData(appName, fileName) {
  const os = require('os');
  const tempPath = path.join(os.tmpdir(), `vs-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const remotePath = `${getRawRemote()}:/${APPS_FOLDER}/${appName}/${fileName}`;
  try {
    await runRcloneCommand(['copyto', remotePath, tempPath], { timeoutMs: 12000 });
    return fs.readFileSync(tempPath, 'utf8');
  } finally {
    try { fs.unlinkSync(tempPath); } catch (e) {}
  }
}

async function listFiles(appName) {
  const remotePath = `${getRawRemote()}:/${APPS_FOLDER}/${appName}`;
  try {
    const output = await runRcloneCommand(['lsjson', remotePath], { timeoutMs: 12000 });
    return JSON.parse(output);
  } catch (e) {
    if (e.message.includes('directory not found')) {
      return [];
    }
    throw e;
  }
}

async function deleteFile(appName, fileName) {
  const remotePath = `${getRawRemote()}:/${APPS_FOLDER}/${appName}/${fileName}`;
  await runRcloneCommand(['deletefile', remotePath], { timeoutMs: 12000 });
}

module.exports = {
  uploadData,
  downloadData,
  listFiles,
  deleteFile
};
