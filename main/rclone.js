// module_hash: 0x4c6162
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const net = require('net');
const { buildExcludeArgs } = require('./filesystem');
const { resolveBundledRclonePath } = require('./runtimePaths');

const REMOTE = 'gdrive-crypt';         // encrypted remote
const ENCRYPTED_FOLDER = 'LabSuite-Encrypted';
const LEGACY_ENCRYPTED_FOLDER = 'VaultSync-Encrypted';
const RAW_REMOTE = 'gdrive';
const RCLONE_VERSION = '1.74.4';

function isSafeRemoteName(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(value || ''));
}

function getActiveRemoteNames() {
  try {
    const db = require('./database');
    const raw = db.getSetting('active_raw_remote') || RAW_REMOTE;
    const crypt = db.getSetting('active_crypt_remote') || REMOTE;
    return {
      raw: isSafeRemoteName(raw) ? raw : RAW_REMOTE,
      crypt: isSafeRemoteName(crypt) ? crypt : REMOTE
    };
  } catch (_) {
    return { raw: RAW_REMOTE, crypt: REMOTE };
  }
}

function safeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/**
 * Returns the encrypted rclone remote prefix.
 */
function getRemote() {
  return getActiveRemoteNames().crypt;
}

function getRawRemoteName() {
  return getActiveRemoteNames().raw;
}

function getRemotePath(remotePath = '') {
  return `${getRemote()}:${remotePath || ''}`;
}

function getRawRemotePath(remotePath = '') {
  return `${getRawRemoteName()}:${remotePath || ''}`;
}

function getRemoteSectionBounds(lines, remoteName) {
  const sectionName = `[${String(remoteName || '').trim()}]`.toLowerCase();
  const start = lines.findIndex(line => String(line).trim().toLowerCase() === sectionName);
  if (start < 0) return null;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function getRcloneRemoteConfigValue(configText, remoteName, key) {
  const lines = String(configText || '').split(/\r?\n/);
  const bounds = getRemoteSectionBounds(lines, remoteName);
  if (!bounds) return '';
  const escapedKey = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.*?)\\s*$`, 'i');

  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const match = lines[index].match(matcher);
    if (match) return match[1];
  }
  return '';
}

function updateRcloneRemoteConfig(configText, remoteName, updates = {}) {
  const text = String(configText || '');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const bounds = getRemoteSectionBounds(lines, remoteName);
  if (!bounds) {
    throw new Error('The configured Google Drive account was not found. Reconnect the account from LabSuite setup.');
  }

  const pending = new Map(
    Object.entries(updates).map(([key, value]) => [String(key).toLowerCase(), { key, value: String(value) }])
  );
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (index > bounds.start && index < bounds.end) {
      const keyMatch = lines[index].match(/^\s*([A-Za-z0-9_]+)\s*=/);
      const normalizedKey = keyMatch ? keyMatch[1].toLowerCase() : '';
      if (normalizedKey && pending.has(normalizedKey)) {
        const replacement = pending.get(normalizedKey);
        output.push(`${replacement.key} = ${replacement.value}`);
        pending.delete(normalizedKey);
        continue;
      }
    }

    if (index === bounds.end) {
      for (const replacement of pending.values()) {
        output.push(`${replacement.key} = ${replacement.value}`);
      }
      pending.clear();
    }
    output.push(lines[index]);
  }

  if (bounds.end === lines.length) {
    const insertionIndex = output.length > 0 && output[output.length - 1] === ''
      ? output.length - 1
      : output.length;
    output.splice(insertionIndex, 0, ...[...pending.values()].map(({ key, value }) => `${key} = ${value}`));
  }

  return output.join(newline);
}

function validateGoogleClientCredentials(clientId, clientSecret) {
  const normalizedClientId = String(clientId || '').trim();
  const normalizedClientSecret = String(clientSecret || '').trim();
  if (!normalizedClientId || !normalizedClientSecret) {
    throw new Error('Both the Google OAuth Client ID and Client Secret are required.');
  }
  if (/\r|\n/.test(normalizedClientId) || /\r|\n/.test(normalizedClientSecret)) {
    throw new Error('Google OAuth credentials contain invalid line breaks.');
  }
  if (!normalizedClientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error('Enter a Google OAuth Desktop app Client ID ending in .apps.googleusercontent.com.');
  }
  if (normalizedClientId.length > 512 || normalizedClientSecret.length > 512) {
    throw new Error('Google OAuth credentials are longer than expected.');
  }
  return { clientId: normalizedClientId, clientSecret: normalizedClientSecret };
}

// Helper to get paths
function getPaths() {
  let userDataDir;
  let isPackaged = false;
  try {
    const { app } = require('electron');
    userDataDir = app.getPath('userData');
    isPackaged = app.isPackaged;
  } catch (e) {
    userDataDir = path.join(__dirname, '../data');
  }

  const rcloneBin = resolveBundledRclonePath({
    isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: __dirname
  });

  const configPath = path.join(userDataDir, 'rclone.conf');

  return { rcloneBin, configPath };
}

function getConfiguredCryptRemoteRoot() {
  const { configPath } = getPaths();
  try {
    if (!fs.existsSync(configPath)) return '';
    const content = fs.readFileSync(configPath, 'utf8');
    const activeCrypt = getRemote().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionMatch = content.match(new RegExp(`\\[${activeCrypt}\\]([\\s\\S]*?)(?:\\n\\[[^\\]]+\\]|\\s*$)`, 'i'));
    if (!sectionMatch) return '';
    const remoteMatch = sectionMatch[1].match(/^\s*remote\s*=\s*(.+?)\s*$/im);
    return remoteMatch ? remoteMatch[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function getEncryptedFolder() {
  const remoteRoot = getConfiguredCryptRemoteRoot();
  const activeRaw = getRawRemoteName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = remoteRoot.match(new RegExp(`^${activeRaw}:(.+)$`, 'i'));
  return match && match[1] ? match[1].replace(/^\/+|\/+$/g, '') : ENCRYPTED_FOLDER;
}

function getVaultBrand() {
  return /^VaultSync-Encrypted$/i.test(getEncryptedFolder()) ? 'VaultSync' : 'LabSuite';
}

function getControlFolderName() {
  return `${getVaultBrand()}-Control`;
}

function getVaultNamespace() {
  return getVaultBrand().toLowerCase();
}

function getVaultPath(kind, suffix = '') {
  const root = `.${getVaultNamespace()}_${kind}`;
  const cleanSuffix = String(suffix || '').replace(/^\/+/, '');
  return cleanSuffix ? `${root}/${cleanSuffix}` : root;
}

async function rawFolderExists(remotePath) {
  try {
    await listRawDirStrict(remotePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function detectEncryptedFolder() {
  const configured = getEncryptedFolder();
  if (configured && !/^LabSuite-Encrypted$/i.test(configured)) {
    return configured;
  }

  if (await rawFolderExists(ENCRYPTED_FOLDER)) {
    return ENCRYPTED_FOLDER;
  }
  if (await rawFolderExists(LEGACY_ENCRYPTED_FOLDER)) {
    return LEGACY_ENCRYPTED_FOLDER;
  }
  return configured || ENCRYPTED_FOLDER;
}

function hardenConfigFilePermissions(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return;

  try {
    fs.chmodSync(configPath, 0o600);
  } catch (e) {
    console.warn('rclone: chmod hardening skipped:', e.message);
  }

  if (process.platform !== 'win32') return;

  try {
    const user = process.env.USERNAME;
    if (!user) return;

    const account = process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${user}`
      : user;

    const result = spawnSync('icacls', [
      configPath,
      '/inheritance:r',
      '/grant:r',
      `${account}:F`
    ], {
      windowsHide: true,
      encoding: 'utf8'
    });

    if (result.status !== 0) {
      console.warn('rclone: ACL hardening skipped:', (result.stderr || result.stdout || '').trim());
    }
  } catch (e) {
    console.warn('rclone: ACL hardening skipped:', e.message);
  }
}

function redactRcloneArg(arg) {
  if (typeof arg !== 'string') return arg;
  return arg.replace(/^(password2?|client_secret|token)=.+$/i, '$1=***');
}

function redactRcloneOutput(text) {
  return String(text || '')
    .replace(/(password2?|client_secret|token)=\S+/gi, '$1=***')
    .replace(/("?(?:password2?|client_secret|token)"?\s*:\s*)"[^"]+"/gi, '$1"***"');
}

function parseRcloneLogText(text = '') {
  const entries = [];
  const rawLines = [];

  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = safeParseJson(trimmed);
      if (parsed && typeof parsed === 'object') {
        entries.push(parsed);
        continue;
      }
    } catch (_) {
      // Plain rclone output is handled below.
    }

    rawLines.push(redactRcloneOutput(trimmed));
  }

  return { entries, rawLines };
}

function summarizeRcloneEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const message = entry.msg || entry.error || '';
  if (!message) return '';
  const object = entry.object || entry.path || entry.Path || '';
  return redactRcloneOutput(object ? `${object}: ${message}` : message).replace(/\s+/g, ' ').trim();
}

function isSharedGoogleClientRetirementNotice(text) {
  const normalized = String(text || '').toLowerCase();
  return normalized.includes('shared google drive client_id') &&
    (normalized.includes('retir') || normalized.includes('stop working during 2026'));
}

function uniqueMessages(messages, limit = 3) {
  const seen = new Set();
  const result = [];

  for (const message of messages) {
    const cleaned = redactRcloneOutput(message).replace(/\s+/g, ' ').trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= limit) break;
  }

  return result;
}

function truncateMessage(message, maxLength = 900) {
  if (!message || message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - 1).trim()}...`;
}

function translateToHumanError(text) {
  const t = String(text || '').toLowerCase();
  
  if (t.includes('no such host') || t.includes('network is unreachable') || t.includes('dial tcp') || t.includes('connect: connection refused') || t.includes('connection timed out')) {
    return 'Could not connect to Google Drive. Please check your internet connection and try again.';
  }
  if (t.includes('invalid_grant') || t.includes('token expired') || t.includes('unauthorized') || t.includes('oauth2: token') || t.includes('401 unauthorized')) {
    return 'Google Drive login session expired. Please go to Settings and reconnect your Google account.';
  }
  if (t.includes('quotaexceeded') || t.includes('storage limit') || t.includes('403 forbidden') || t.includes('rate limit exceeded')) {
    return 'Google Drive storage or API rate limit exceeded. Please ensure you have enough cloud storage space.';
  }
  if (t.includes('permission denied') || t.includes('access is denied') || t.includes('eacces') || t.includes('failed to open source')) {
    return 'Permission denied. Please ensure LabSuite has permission to read the selected backup folders.';
  }
  if (t.includes('no space left on device') || t.includes('disk full') || t.includes('enospc')) {
    return 'Operation failed because your computer\'s local hard drive is full.';
  }
  if (t.includes('used by another process') || t.includes('file locked') || t.includes('sharing violation')) {
    return 'One or more files are locked by another open program. Please close any active files and try again.';
  }
  if (t.includes('directory not found') || t.includes('object not found') || t.includes('file not found')) {
    return 'The backup destination was not found on Google Drive. It may have been renamed or deleted.';
  }
  if (t.includes('bad decrypt') || t.includes('failed to decrypt') || t.includes('password') || t.includes('crypto')) {
    return 'Decryption failed. Please verify that your encryption master password is correct.';
  }

  return text;
}

function buildRcloneErrorMessage({ code, signal, stderr }) {
  const { entries, rawLines } = parseRcloneLogText(stderr);
  const actionableEntries = entries.filter(entry => !isSharedGoogleClientRetirementNotice(summarizeRcloneEntry(entry)));
  const actionableRawLines = rawLines.filter(line => !isSharedGoogleClientRetirementNotice(line));
  const warnings = actionableEntries.filter(entry => String(entry.level || '').toLowerCase() === 'warning');
  const errors = actionableEntries.filter(entry => {
    const level = String(entry.level || '').toLowerCase();
    return level === 'error' || level === 'fatal' || level === 'panic';
  });
  const duplicateDirWarnings = warnings.filter(entry => entry.msg === 'Duplicate directory found in destination - ignoring');

  const errorMessages = uniqueMessages([
    ...errors.map(summarizeRcloneEntry),
    ...actionableRawLines
  ]);

  const rawCombined = errorMessages.join('; ');
  if (rawCombined) {
    const humanized = translateToHumanError(rawCombined);
    if (humanized !== rawCombined) {
      return humanized;
    }
    return truncateMessage(rawCombined);
  }

  if (duplicateDirWarnings.length > 0) {
    return 'Google Drive contains duplicate destination folders. Please merge or resolve conflicts in your Drive dashboard.';
  }

  const warningMessages = uniqueMessages(warnings.map(summarizeRcloneEntry));
  if (warningMessages.length > 0) {
    const combinedWarnings = warningMessages.join('; ');
    return truncateMessage(translateToHumanError(combinedWarnings));
  }

  if (signal) {
    return `The backup process was stopped (interrupted by ${signal}).`;
  }
  if (code !== null && code !== undefined) {
    return `The backup process stopped (code ${code}).`;
  }

  return 'The backup process stopped unexpectedly.';
}

function normalizeTransferItem(item = {}) {
  const name = item.name || item.Name || item.path || item.Path || item.eta || 'Processing file...';
  const bytes = Number(item.bytes || item.Bytes || item.size || 0);
  const totalBytes = Number(item.size || item.totalBytes || item.total || 0);
  const percentage = Number.isFinite(Number(item.percentage))
    ? Number(item.percentage)
    : (totalBytes > 0 ? Math.round((bytes / totalBytes) * 100) : 0);

  return {
    name,
    bytes,
    totalBytes,
    percentage: Math.max(0, Math.min(100, percentage)),
    speed: Number(item.speed || item.Speed || 0)
  };
}

function normalizeFilesFromPaths(relativePaths = []) {
  const seen = new Set();
  const paths = [];
  for (const relativePath of relativePaths) {
    const cleaned = String(relativePath || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    paths.push(cleaned);
  }
  return paths;
}

function writeFilesFromList(relativePaths = []) {
  const paths = normalizeFilesFromPaths(relativePaths);
  const listPath = path.join(os.tmpdir(), `labsuite-files-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  fs.writeFileSync(listPath, `${paths.join('\n')}\n`, 'utf8');
  return { listPath, paths };
}

function getTransferTuning() {
  const db = require('./database');
  const settings = db.getDb().settings || {};
  const profile = String(settings.backup_transfer_profile || 'fast').toLowerCase();

  if (profile === 'turbo') {
    return { transfers: 8, checkers: 16, pacerSleep: '10ms', pacerBurst: 200 };
  }
  if (profile === 'conservative') {
    return { transfers: 4, checkers: 8, pacerSleep: '20ms', pacerBurst: 100 };
  }

  return { transfers: 6, checkers: 12, pacerSleep: '15ms', pacerBurst: 150 };
}

function getTransferFlagArgs() {
  const tuning = getTransferTuning();
  const args = [
    `--transfers=${tuning.transfers}`,
    `--checkers=${tuning.checkers}`,
    `--drive-pacer-min-sleep=${tuning.pacerSleep}`,
    `--drive-pacer-burst=${tuning.pacerBurst}`
  ];

  const db = require('./database');
  const driveChunkSize = db.getSetting('drive_chunk_size');
  if (driveChunkSize && driveChunkSize.trim()) {
    args.push(`--drive-chunk-size=${driveChunkSize.trim()}`);
  }

  return args;
}

function withTransferStats(args, onProgress, labels = {}) {
  const finalArgs = [
    ...args,
    ...getTransferFlagArgs(),
    '--stats=2s',
    '--stats-one-line',
    '--stats-log-level',
    'NOTICE',
    '--use-json-log'
  ];

  if (!onProgress) {
    return runRclone(finalArgs);
  }

  const startTime = Date.now();
  let lastBytes = 0;
  let lastTime = startTime;
  let stderrBuffer = '';
  let lastProgress = null;
  let lastMessage = '';
  const idleStage = labels.idleStage || 'preparing';
  const activeStage = labels.activeStage || 'encrypting_uploading';
  const idleLabel = labels.idleLabel || 'Starting Google Drive operation';
  const activeLabel = labels.activeLabel || 'Transferring files';

  const heartbeat = setInterval(() => {
    onProgress({
      ...(lastProgress || {}),
      stage: lastProgress?.stage || idleStage,
      stageLabel: lastProgress?.stageLabel || idleLabel,
      elapsed: (Date.now() - startTime) / 1000,
      heartbeat: true
    });
  }, 5000);

  return runRclone(finalArgs, {
    onStderr: (data) => {
      stderrBuffer += data;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = safeParseJson(trimmed);
          if (labels.onLogEntry) {
            labels.onLogEntry(entry);
          }
          const level = String(entry.level || '').toLowerCase();
          if (entry.msg && !['warning', 'notice'].includes(level)) {
            lastMessage = entry.object ? `${entry.object}: ${entry.msg}` : entry.msg;
          }
          if (!entry.stats) continue;

          const s = entry.stats;
          const now = Date.now();
          const bytesDone = Number(s.bytes) || 0;
          const bytesTotal = Number(s.totalBytes) || 0;
          const windowMs = now - lastTime;
          const byteDelta = bytesDone - lastBytes;
          const speed = windowMs > 0 ? (byteDelta / windowMs) * 1000 : 0;
          const remaining = bytesTotal - bytesDone;
          const etaSec = speed > 0 && remaining > 0 ? Math.round(remaining / speed) : null;
          const transferring = (s.transferring || []).map(normalizeTransferItem);
          const percent = bytesTotal > 0
            ? Math.round((bytesDone / bytesTotal) * 100)
            : ((s.totalTransfers || 0) > 0 ? Math.round(((s.transfers || 0) / s.totalTransfers) * 100) : 0);

          lastBytes = bytesDone;
          lastTime = now;
          lastProgress = {
            stage: transferring.length > 0 ? activeStage : idleStage,
            stageLabel: transferring.length > 0 ? activeLabel : idleLabel,
            filesDone: Number(s.transfers) || 0,
            filesTotal: Number(s.totalTransfers) || 0,
            bytesDone,
            bytesTotal,
            percent,
            speed,
            etaSec,
            elapsed: (now - startTime) / 1000,
            transferring,
            currentItem: transferring[0]?.name || lastMessage || ''
          };
          onProgress(lastProgress);
        } catch (_) {}
      }
    }
  }).finally(() => {
    clearInterval(heartbeat);
  });
}

function obscurePassword(password) {
  const { rcloneBin } = getPaths();

  return new Promise((resolve, reject) => {
    const proc = spawn(rcloneBin, ['obscure', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
  proc.on('error', err => console.error('Process error:', err.message));

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => {
      stdout += d.toString();
    });

    proc.stderr.on('data', d => {
      stderr += d.toString();
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `rclone obscure exited with code ${code}`));
      }
    });

    proc.on('error', reject);
    proc.stdin.end(`${password}\n`);
  });
}

const activeRcloneProcesses = new Map();

function getFreeRcPort() {
  let port = 5572;
  const busyPorts = new Set(Array.from(activeRcloneProcesses.values()).map(p => p.rcPort));
  while (busyPorts.has(port)) {
    port++;
  }
  return port;
}

function getSystemIdleTime() {
  try {
    const { powerMonitor } = require('electron');
    return powerMonitor.getSystemIdleTime();
  } catch (e) {
    return 0;
  }
}

function isUserActive() {
  return getSystemIdleTime() < 60;
}

function getSmartBwlimit(settings, idleSeconds) {
  const capacityMbps = Number(settings.upload_speed_capacity) || 10;
  const minPct = Number(settings.smart_throttle_min_pct) || 15;
  const maxPct = Number(settings.smart_throttle_max_pct) || 75;
  const idleMins = Number(settings.smart_throttle_idle_mins) || 15;
  const idleLimitSecs = idleMins * 60;

  let percentage = minPct / 100;
  if (idleSeconds >= idleLimitSecs) {
    percentage = maxPct / 100;
  } else if (idleSeconds >= 60) {
    const fraction = (idleSeconds - 60) / (idleLimitSecs - 60);
    percentage = (minPct + fraction * (maxPct - minPct)) / 100;
  }
  
  const targetMbps = capacityMbps * percentage;
  const targetKbps = Math.round(targetMbps * 122);
  const finalKbps = Math.max(128, targetKbps);
  return `${finalKbps}K`;
}

let lastAppliedBwlimit = null;
let smartThrottleInterval = null;

function startSmartThrottleMonitor() {
  if (smartThrottleInterval) return;
  
  smartThrottleInterval = setInterval(() => {
    if (activeRcloneProcesses.size === 0) return;
    
    const db = require('./database');
    const settings = db.getDb().settings || {};
    if (settings.smart_throttle_enabled !== '1') return;
    
    const currentIdleTime = getSystemIdleTime();
    const calculatedLimit = getSmartBwlimit(settings, currentIdleTime);
    
    if (calculatedLimit !== lastAppliedBwlimit) {
      lastAppliedBwlimit = calculatedLimit;
      console.log(`rclone: Dynamic Bandwidth Adjustment. Idle Time: ${currentIdleTime}s. Applying limit: ${calculatedLimit}`);
      
      const { rcloneBin, configPath } = getPaths();
      for (const [id, procInfo] of activeRcloneProcesses.entries()) {
        try {
          const rcProc = spawn(rcloneBin, [
            'rc', 
            'core/bwlimit', 
            `limit=${calculatedLimit}`, 
            '--rc-addr', `127.0.0.1:${procInfo.rcPort}`,
            '--config', configPath
          ], {
            windowsHide: true
          });
  rcProc.on('error', err => console.error('Process error:', err.message));
          
          rcProc.on('error', (err) => {
            console.warn(`rclone: Failed to send dynamic bwlimit to process ${id} on port ${procInfo.rcPort}:`, err.message);
          });
        } catch (err) {
          console.warn(`rclone: Error sending dynamic bwlimit to process ${id}:`, err.message);
        }
      }
    }
  }, 10000);
}

function stopSmartThrottleMonitor() {
  if (smartThrottleInterval) {
    clearInterval(smartThrottleInterval);
    smartThrottleInterval = null;
  }
  lastAppliedBwlimit = null;
}

function getCurrentBwlimit() {
  const db = require('./database');
  const settings = db.getDb().settings || {};
  const defaultLimit = settings.bwlimit || '0';

  if (settings.smart_throttle_enabled === '1') {
    try {
      const currentIdleTime = getSystemIdleTime();
      return getSmartBwlimit(settings, currentIdleTime);
    } catch (e) {
      console.error('rclone: Smart throttle calculation error:', e.message);
    }
  }

  if (settings.bwlimit_scheduler_enabled === '1') {
    try {
      const now = new Date();
      const currentMins = now.getHours() * 60 + now.getMinutes();

      const [startH, startM] = (settings.bwlimit_scheduled_start || '09:00').split(':').map(Number);
      const [endH, endM] = (settings.bwlimit_scheduled_end || '17:00').split(':').map(Number);
      const startMins = startH * 60 + startM;
      const endMins = endH * 60 + endM;

      let inSchedule = false;
      if (startMins <= endMins) {
        inSchedule = currentMins >= startMins && currentMins <= endMins;
      } else {
        inSchedule = currentMins >= startMins || currentMins <= endMins;
      }

      if (inSchedule) {
        console.log(`rclone: Bandwidth Scheduler active. Applying limit: ${settings.bwlimit_scheduled_value}`);
        return settings.bwlimit_scheduled_value || '1M';
      }
    } catch (e) {
      console.error('rclone: Scheduler calculation error:', e.message);
    }
  }
  return defaultLimit;
}

function findNestedField(value, fieldNames) {
  if (!value || typeof value !== 'object') return '';
  const wanted = new Set(fieldNames.map(name => name.toLowerCase()));

  for (const [key, item] of Object.entries(value)) {
    if (wanted.has(String(key).toLowerCase()) && item) {
      return String(item);
    }
  }

  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') {
      const found = findNestedField(item, fieldNames);
      if (found) return found;
    }
  }

  return '';
}

function parseJsonOrObjectText(text) {
  try {
    return safeParseJson(text);
  } catch (_) {
    const emailMatch = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return emailMatch ? { email: emailMatch[0] } : {};
  }
}

/**
 * Execute rclone with given arguments, automatically applying the sandbox config path.
 */
function runRclone(args, options = {}) {
  const { rcloneBin, configPath } = getPaths();
  const bwlimit = getCurrentBwlimit();
  const configDir = path.dirname(configPath);
  const timeoutMs = Number(options.timeoutMs) || 0;
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const [command, ...restArgs] = args;
  const finalArgs = [
    command,
    ...restArgs,
    '--config', configPath
  ];
  
  const isTransferCommand = ['copy', 'sync', 'copyto', 'restore', 'move', 'moveto'].includes(command);
  const applyTransferControls = options.applyTransferControls !== false;
  let allocatedPort = null;

  if (isTransferCommand && applyTransferControls) {
    if (bwlimit && bwlimit !== '0') {
      finalArgs.push(`--bwlimit=${bwlimit}`);
    }
    const db = require('./database');
    const settings = db.getDb().settings || {};
    if (settings.smart_throttle_enabled === '1') {
      allocatedPort = getFreeRcPort();
      finalArgs.push('--rc', '--rc-no-auth', '--rc-addr', `127.0.0.1:${allocatedPort}`);
    }
  }
  
  console.log(`Spawning rclone: ${rcloneBin} ${finalArgs.map(redactRcloneArg).join(' ')}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(rcloneBin, finalArgs, {
      windowsHide: true,
      ...(options.spawnOptions || {})
    });
    
    const procId = Date.now() + Math.random();
    if (isTransferCommand && applyTransferControls && allocatedPort !== null) {
      activeRcloneProcesses.set(procId, { proc, rcPort: allocatedPort });
      const db = require('./database');
      if (db.getDb().settings?.smart_throttle_enabled === '1') {
        startSmartThrottleMonitor();
      }
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutTimer = null;

    const cleanupProcess = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (isTransferCommand) {
        activeRcloneProcesses.delete(procId);
        if (activeRcloneProcesses.size === 0) {
          stopSmartThrottleMonitor();
        }
      }
    };

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanupProcess();
      resolve(value);
    };

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanupProcess();
      reject(error);
    };

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        try {
          proc.kill();
        } catch (_) {}
        rejectOnce(new Error(`rclone ${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    // CPU Throttling (deprioritize process CPU scheduling)
    try {
      const db = require('./database');
      if (db.getDb().settings?.throttle_cpu === '1') {
        const os = require('os');
        os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        console.log(`rclone: Set process CPU priority to BELOW_NORMAL for PID ${proc.pid}`);
      }
    } catch (e) {
      console.log('rclone: CPU priority adjustment skipped', e.message);
    }

    if (proc.stdout) {
      proc.stdout.on('data', d => {
        const text = d.toString();
        stdout += text;
        if (options.onStdout) {
          options.onStdout(text);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', d => {
        const text = d.toString();
        stderr += text;
        if (options.onStderr) {
          options.onStderr(text);
        }
      });
    }

    proc.on('close', (code, signal) => {
      hardenConfigFilePermissions(configPath);
      if (code === 0) {
        resolveOnce(stdout);
      } else {
        rejectOnce(new Error(buildRcloneErrorMessage({ code, signal, stderr })));
      }
    });

    proc.on('error', err => {
      console.error('Process error:', err.message);
      rejectOnce(err);
    });
  });
}

/**
 * Starts the interactive Google OAuth process
 */
function startGoogleAuthForRemote(remoteName, clientId = '', clientSecret = '') {
  if (!isSafeRemoteName(remoteName)) {
    throw new Error('Invalid Google Drive destination name.');
  }
  let credentials = null;
  if (clientId || clientSecret) {
    credentials = validateGoogleClientCredentials(clientId, clientSecret);
  }
  const args = [
    'config',
    'create',
    remoteName,
    'drive',
    'scope=drive',
  ];

  if (credentials) args.push(`client_id=${credentials.clientId}`);
  if (credentials) args.push(`client_secret=${credentials.clientSecret}`);

  // We let rclone spawn the default browser and run its local redirect server
  // WaitMsBeforeAsync is handled by Electron's IPC spawning the promise in the background
  return runRclone(args);
}

function startGoogleAuth(clientId = '', clientSecret = '') {
  return startGoogleAuthForRemote(getRawRemoteName(), clientId, clientSecret);
}

/**
 * Creates the encrypted crypt remote pointing to the gdrive folder
 */
async function createCryptRemoteFor({ rawRemote, cryptRemote, encryptedFolder, password }) {
  if (!password || typeof password !== 'string') {
    throw new Error('A non-empty encryption password is required.');
  }
  if (!isSafeRemoteName(rawRemote) || !isSafeRemoteName(cryptRemote)) {
    throw new Error('Invalid encrypted destination configuration.');
  }

  const obscuredPassword = await obscurePassword(password);
  const targetEncryptedFolder = String(encryptedFolder || '').replace(/^\/+|\/+$/g, '') || ENCRYPTED_FOLDER;

  try {
    await runRclone(['config', 'delete', cryptRemote]);
  } catch (_) {
    // Recreate the crypt remote cleanly when the user retries a password.
  }

  return runRclone([
    'config',
    'create',
    cryptRemote,
    'crypt',
    `remote=${rawRemote}:${targetEncryptedFolder}`,
    'filename_encryption=standard',
    'directory_name_encryption=true',
    `password=${obscuredPassword}`,
    '--no-obscure'
  ]);
}

function syncRawFile(localFilePath, remoteFilePath) {
  return runRclone([
    'copyto',
    localFilePath,
    getRawRemotePath(remoteFilePath)
  ]);
}

function readRawText(remoteFilePath) {
  return runRclone(['cat', getRawRemotePath(remoteFilePath)]);
}

function readText(remoteFilePath) {
  return runRclone(['cat', getRemotePath(remoteFilePath)]);
}

function getNamedRemotePath(remoteName, remotePath = '') {
  if (!isSafeRemoteName(remoteName)) throw new Error('Invalid remote name.');
  const suffix = String(remotePath || '').replace(/^\/+/, '');
  return `${remoteName}:${suffix}`;
}

async function getGDriveInfoForRemote(remoteName) {
  try {
    const stdout = await runRclone(['about', getNamedRemotePath(remoteName), '--json'], { timeoutMs: 15000 });
    const info = safeParseJson(stdout) || {};
    let accountEmail = '';
    let displayName = '';
    try {
      const userInfo = parseJsonOrObjectText(await runRclone([
        'backend', 'userinfo', getNamedRemotePath(remoteName)
      ], { timeoutMs: 15000 }));
      accountEmail = findNestedField(userInfo, ['email', 'emailAddress', 'email_address', 'userPrincipalName']);
      displayName = findNestedField(userInfo, ['name', 'displayName', 'display_name']);
    } catch (_) {}
    return {
      email: accountEmail || displayName || 'Google Drive Account',
      accountEmail,
      displayName,
      used: Number(info.used) || 0,
      total: Number(info.total) || 0,
      free: Number(info.free) || 0
    };
  } catch (error) {
    return { email: 'Disconnected', accountEmail: '', displayName: '', used: 0, total: 0, free: 0 };
  }
}

async function remotePathExists(remoteName, remotePath) {
  try {
    await runRclone(['lsjson', getNamedRemotePath(remoteName, remotePath)], { timeoutMs: 20000 });
    return true;
  } catch (_) {
    return false;
  }
}

async function getNamedRemoteSize(remoteName, remotePath = '') {
  const stdout = await runRclone(['size', getNamedRemotePath(remoteName, remotePath), '--json'], { timeoutMs: 60000 });
  const parsed = safeParseJson(stdout) || {};
  return { bytes: Number(parsed.bytes) || 0, count: Number(parsed.count) || 0 };
}

function copyNamedRemoteTree(sourceRemote, sourcePath, targetRemote, targetPath, options = {}) {
  const command = options.mirror === true ? 'sync' : 'copy';
  const args = [
    command,
    getNamedRemotePath(sourceRemote, sourcePath),
    getNamedRemotePath(targetRemote, targetPath)
  ];
  if (options.onProgress) {
    return withTransferStats(args, options.onProgress, {
      idleStage: 'preparing',
      activeStage: 'copying',
      idleLabel: 'Preparing encrypted vault transfer',
      activeLabel: options.mirror ? 'Mirroring encrypted vault' : 'Copying encrypted vault'
    });
  }
  return runRclone([...args, ...getTransferFlagArgs()]);
}

function checkNamedRemoteTree(sourceRemote, sourcePath, targetRemote, targetPath) {
  return runRclone([
    'check',
    getNamedRemotePath(sourceRemote, sourcePath),
    getNamedRemotePath(targetRemote, targetPath),
    '--size-only',
    '--one-way'
  ], { timeoutMs: 0, applyTransferControls: false });
}

/**
 * Verifies if rclone configuration has gdrive and gdrive-crypt
 */
async function checkConfig() {
  try {
    const list = await runRclone(['config', 'show']);
    const hasGDrive = list.includes(`[${getRawRemoteName()}]`);
    const hasCrypt = list.includes(`[${getRemote()}]`);
    return { hasGDrive, hasCrypt };
  } catch (e) {
    return { hasGDrive: false, hasCrypt: false };
  }
}

function getGoogleDriveClientStatus() {
  const { configPath } = getPaths();
  const remoteName = getRawRemoteName();
  if (!fs.existsSync(configPath)) {
    return { hasRemote: false, usesOwnClientId: false, clientIdHint: '' };
  }

  try {
    const configText = fs.readFileSync(configPath, 'utf8');
    const clientId = getRcloneRemoteConfigValue(configText, remoteName, 'client_id');
    return {
      hasRemote: !!getRemoteSectionBounds(configText.split(/\r?\n/), remoteName),
      usesOwnClientId: !!clientId,
      clientIdHint: clientId ? `${clientId.slice(0, 8)}...${clientId.slice(-24)}` : ''
    };
  } catch (_) {
    return { hasRemote: false, usesOwnClientId: false, clientIdHint: '' };
  }
}

async function reconnectGoogleDriveClient(clientId, clientSecret) {
  if (activeRcloneProcesses.size > 0) {
    throw new Error('Wait for the current backup or restore transfer to finish, then reconnect Google Drive.');
  }
  const credentials = validateGoogleClientCredentials(clientId, clientSecret);
  const { configPath } = getPaths();
  const remoteName = getRawRemoteName();
  if (!fs.existsSync(configPath)) {
    throw new Error('No Google Drive account is configured on this PC. Connect it from LabSuite setup first.');
  }

  const previousConfig = fs.readFileSync(configPath, 'utf8');
  const updatedConfig = updateRcloneRemoteConfig(previousConfig, remoteName, {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret
  });

  try {
    fs.writeFileSync(configPath, updatedConfig, 'utf8');
    hardenConfigFilePermissions(configPath);
    await runRclone([
      'config',
      'reconnect',
      `${remoteName}:`,
      '--auto-confirm'
    ], { timeoutMs: 10 * 60 * 1000, applyTransferControls: false });
    return getGoogleDriveClientStatus();
  } catch (error) {
    try {
      fs.writeFileSync(configPath, previousConfig, 'utf8');
      hardenConfigFilePermissions(configPath);
    } catch (restoreError) {
      console.warn('rclone: Failed to restore Google Drive configuration after reconnect error:', restoreError.message);
    }
    throw error;
  }
}

/**
 * Delete a remote config completely (e.g. on disconnect)
 */
async function disconnect() {
  const { configPath } = getPaths();
  try {
    await runRclone(['config', 'delete', REMOTE]);
  } catch(e) {}
  try {
    await runRclone(['config', 'delete', 'gdrive']);
  } catch(e) {}
  
  if (fs.existsSync(configPath)) {
    try {
      fs.unlinkSync(configPath);
    } catch(e) {}
  }
}

/**
 * Get size of the encrypted backup folder
 * Returns e.g. { bytes: 102400, count: 12 }
 */
async function getRemoteSize() {
  try {
    const stdout = await runRclone(['size', `${getRemote()}:`, '--json']);
    return safeParseJson(stdout);
  } catch (error) {
    console.error('Failed to get remote size:', error);
    return { bytes: 0, count: 0 };
  }
}

/**
 * Run a full sync of a folder (copies local → remote).
 * @param {string} localPath
 * @param {string} remotePath
 * @param {function} onProgress  - called with rich progress object
 * @param {object}  opts
 * @param {boolean} opts.isInitial       - true for the first-ever upload of a folder
 * @param {string[]} opts.extraExclusions - additional --exclude patterns
 */
function fullSync(localPath, remotePath, onProgress, opts = {}) {
  const excludeArgs = buildExcludeArgs(opts.extraExclusions || []);
  const date = new Date().toISOString().split('T')[0];
  const destPath = getRemotePath(remotePath);
  const trashPath = `${getRemote()}:${getVaultPath('trash', `${date}/${remotePath}`)}`;

  const args = [
    'sync',
    localPath,
    destPath,
    '--backup-dir',
    trashPath,
    ...getTransferFlagArgs(),
    '--stats=2s',
    '--stats-one-line',
    '--stats-log-level',
    'NOTICE',
    '--use-json-log',
    ...excludeArgs
  ];

  const startTime = Date.now();
  let lastBytes = 0;
  let lastTime = startTime;
  let stderrBuffer = '';
  let lastMessage = '';
  let lastProgress = null;
  let heartbeat = null;

  if (onProgress) {
    const initialProgress = {
      phase: opts.isInitial ? 'initial' : 'sync',
      stage: 'scanning',
      stageLabel: 'Scanning and comparing files',
      filesDone: 0,
      filesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0,
      percent: 0,
      speed: 0,
      etaSec: null,
      elapsed: 0,
      transferring: [],
      currentItem: ''
    };
    lastProgress = initialProgress;
    onProgress(initialProgress);

    heartbeat = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      onProgress({
        ...(lastProgress || initialProgress),
        elapsed,
        heartbeat: true,
        stageLabel: lastProgress?.stageLabel || 'Scanning and comparing files'
      });
    }, 5000);
  }

  return runRclone(args, {
    onStderr: (data) => {
      if (!onProgress) return;
      // rclone emits JSON log lines to stderr when --use-json-log is set
      stderrBuffer += data;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = safeParseJson(trimmed);
          const level = String(entry.level || '').toLowerCase();
          if (entry.msg && !['warning', 'notice'].includes(level)) {
            lastMessage = entry.object ? `${entry.object}: ${entry.msg}` : entry.msg;
          }
          // Stats entries have a 'stats' key
          if (entry.stats) {
            const s = entry.stats;
            const now = Date.now();
            const bytesDone = s.bytes || 0;
            const bytesTotal = s.totalBytes || 0;
            const elapsed = (now - startTime) / 1000; // seconds

            // Estimate speed (bytes/s) using a rolling window
            const windowMs = now - lastTime;
            const byteDelta = bytesDone - lastBytes;
            const speed = windowMs > 0 ? (byteDelta / windowMs) * 1000 : 0;
            lastBytes = bytesDone;
            lastTime = now;

            // ETA in seconds
            const remaining = bytesTotal - bytesDone;
            const etaSec = speed > 0 ? Math.round(remaining / speed) : null;
            const transferring = (s.transferring || []).map(normalizeTransferItem);
            const percent = bytesTotal > 0
              ? Math.round((bytesDone / bytesTotal) * 100)
              : ((s.totalTransfers || 0) > 0 ? Math.round(((s.transfers || 0) / s.totalTransfers) * 100) : 0);
            const currentItem = transferring[0]?.name || lastMessage || '';

            lastProgress = {
              phase: opts.isInitial ? 'initial' : 'sync',
              stage: transferring.length > 0 ? 'encrypting_uploading' : 'scanning',
              stageLabel: transferring.length > 0 ? 'Encrypting and uploading' : 'Scanning and comparing files',
              filesDone: s.transfers || 0,
              filesTotal: s.totalTransfers || 0,
              bytesDone,
              bytesTotal,
              percent,
              speed,           // bytes/sec
              etaSec,          // null if unknown
              elapsed,         // seconds since start
              transferring,
              currentItem
            };
            onProgress(lastProgress);
          }
        } catch (_) {}
      }
    }
  }).then(result => {
    if (heartbeat) clearInterval(heartbeat);
    if (onProgress) {
      onProgress({
        ...(lastProgress || {}),
        phase: opts.isInitial ? 'initial' : 'sync',
        stage: 'complete',
        stageLabel: 'Backup complete',
        percent: 100,
        speed: 0,
        etaSec: null,
        elapsed: (Date.now() - startTime) / 1000,
        transferring: [],
        currentItem: ''
      });
    }
    return result;
  }).catch(error => {
    if (heartbeat) clearInterval(heartbeat);
    throw error;
  });
}

/**
 * Copy/Upload a single file
 */
function syncFile(localFilePath, remoteFilePath, onProgress, labels = {}) {
  const args = [
    'copyto',
    localFilePath,
    getRemotePath(remoteFilePath)
  ];

  if (onProgress) {
    return withTransferStats(args, onProgress, {
      idleStage: 'preparing',
      activeStage: 'encrypting_uploading',
      idleLabel: 'Starting file upload',
      activeLabel: 'Encrypting and uploading',
      ...labels
    });
  }

  return runRclone([
    ...args,
    ...getTransferFlagArgs()
  ]);
}

function syncControlFile(localFilePath, remoteFilePath) {
  return runRclone([
    'copyto',
    localFilePath,
    getRemotePath(remoteFilePath)
  ], { applyTransferControls: false });
}

async function copyFilesFrom(localRoot, remoteRoot, relativePaths, onProgress, options = {}) {
  const { listPath, paths } = writeFilesFromList(relativePaths);
  if (paths.length === 0) {
    fs.unlink(listPath, () => {});
    return '';
  }

  try {
    return await withTransferStats([
      'copy',
      localRoot,
      getRemotePath(remoteRoot),
      '--files-from',
      listPath
    ], onProgress, {
      idleStage: 'preparing',
      activeStage: 'encrypting_uploading',
      idleLabel: 'Starting Google Drive upload',
      activeLabel: 'Encrypting and uploading',
      onLogEntry: options.onLogEntry
    });
  } finally {
    fs.unlink(listPath, () => {});
  }
}

async function moveFilesFrom(remoteRoot, destinationRemoteRoot, relativePaths, onProgress, options = {}) {
  const { listPath, paths } = writeFilesFromList(relativePaths);
  if (paths.length === 0) {
    fs.unlink(listPath, () => {});
    return '';
  }

  try {
    return await withTransferStats([
      'move',
      getRemotePath(remoteRoot),
      getRemotePath(destinationRemoteRoot),
      '--files-from',
      listPath
    ], onProgress, {
      idleStage: 'versioning',
      activeStage: 'versioning',
      idleLabel: 'Preparing backup version move',
      activeLabel: 'Moving backup versions',
      onLogEntry: options.onLogEntry
    });
  } finally {
    fs.unlink(listPath, () => {});
  }
}

/**
 * Copy/Download a single file from remote to local
 */
function copyFileRemoteToLocal(remoteFilePath, localFilePath, options = {}) {
  return runRclone([
    'copyto',
    getRemotePath(remoteFilePath),
    localFilePath,
    ...(options.overwrite === true ? [] : ['--ignore-existing'])
  ]);
}

async function createCryptRemote(password) {
  return createCryptRemoteFor({
    rawRemote: getRawRemoteName(),
    cryptRemote: getRemote(),
    encryptedFolder: await detectEncryptedFolder(),
    password
  });
}

/**
 * Delete a single file from the remote (Moves to trash)
 */
function isNotFoundError(err) {
  const message = String(err && err.message ? err.message : err).toLowerCase();
  return message.includes('object not found') ||
    message.includes('directory not found') ||
    message.includes('file not found') ||
    message.includes('backup destination was not found') ||
    message.includes('not a regular file');
}

function deleteFile(remoteFilePath) {
  const date = new Date().toISOString().split('T')[0];
  const trashPath = getVaultPath('trash', `${date}/${remoteFilePath}`);
  const remote = getRemote();

  return runRclone([
    'moveto',
    `${remote}:${remoteFilePath}`,
    `${remote}:${trashPath}`
  ]).catch(err => {
    if (isNotFoundError(err)) {
      console.log(`deleteFile: remote file already absent: ${remoteFilePath}`);
      return { skipped: true };
    }
    throw err;
  });
}

function deleteRemotePath(remotePath) {
  const normalized = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) throw new Error('A remote vault path is required.');

  const date = new Date().toISOString().split('T')[0];
  const trashPath = getVaultPath('trash', `${date}/${normalized}`);
  const remote = getRemote();

  return runRclone([
    'moveto',
    `${remote}:${normalized}`,
    `${remote}:${trashPath}`
  ]).then(() => ({
    movedToTrash: true,
    trashPath
  })).catch(err => {
    if (isNotFoundError(err)) {
      console.log(`deleteRemotePath: remote path already absent: ${normalized}`);
      return { skipped: true, trashPath };
    }
    throw err;
  });
}

function moveRemoteFile(remoteFilePath, destinationRemoteFilePath) {
  const remote = getRemote();

  return runRclone([
    'moveto',
    `${remote}:${remoteFilePath}`,
    `${remote}:${destinationRemoteFilePath}`
  ]).catch(err => {
    if (isNotFoundError(err)) {
      console.log(`moveRemoteFile: remote file already absent: ${remoteFilePath}`);
      return { skipped: true };
    }
    throw err;
  });
}

/**
 * Restore (download & decrypt) remote folder to a local path
 */
function restore(remotePath, localDestination, onProgress, options = {}) {
  const args = [
    'copy',
    getRemotePath(remotePath),
    localDestination,
    ...(options.overwrite === true ? [] : ['--ignore-existing']),
    ...getTransferFlagArgs(),
    '--stats=1s',
    '--use-json-log'
  ];

  let stderrBuffer = '';

  return runRclone(args, {
    onStderr: (data) => {
      if (!onProgress) return;

      stderrBuffer += data;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = safeParseJson(trimmed);
          if (entry.stats) {
            onProgress(entry.stats);
          }
        } catch (e) {
          // ignore parsing errors
        }
      }
    }
  });
}

/**
 * List files and directories in a remote path (decrypted)
 */
async function listRemoteDir(remotePath = '') {
  try {
    const stdout = await runRclone(['lsjson', getRemotePath(remotePath)], { timeoutMs: 20000 });
    return safeParseJson(stdout);
  } catch (e) {
    console.error('Failed to list remote directory:', e);
    return [];
  }
}

async function listRemoteDirStrict(remotePath = '', retries = 1, options = {}) {
  try {
    let stderrText = '';
    const listArgs = ['lsjson', getRemotePath(remotePath)];
    if (options.directoriesOnly === true) {
      listArgs.push('--dirs-only');
    }
    const stdout = await runRclone(listArgs, {
      onStderr: (data) => { stderrText += data; },
      timeoutMs: Number(options.timeoutMs) || 45000
    });
    const lowerStderr = stderrText.toLowerCase();
    // Use precise crypto-specific phrases to avoid false positives from rclone NOTICEs
    if (lowerStderr.includes('bad decrypt') || lowerStderr.includes('failed to decrypt') || lowerStderr.includes('crypto/cipher') || lowerStderr.includes('undecryptable') || lowerStderr.includes('pkcs#7') || lowerStderr.includes('decryption failed') || lowerStderr.includes('incorrect password')) {
      throw new Error('Decryption failed. Please verify that your encryption master password is correct.');
    }
    return safeParseJson(stdout);
  } catch (error) {
    const errMsg = error.message.toLowerCase();
    // Match both raw rclone errors AND translated human-friendly messages
    // A missing object is definitive for this exact path. Retrying it only
    // delays the useful error and used to make a stale catalog entry look like
    // an intermittent Google Drive failure.
    const isTransient = errMsg.includes('rate limit') || 
                        errMsg.includes('quota') || 
                        errMsg.includes('rateLimitExceeded') ||
                        errMsg.includes('403') ||
                        errMsg.includes('transient') ||
                        errMsg.includes('connection reset') ||
                        errMsg.includes('econnreset') ||
                        errMsg.includes('etimedout') ||
                        errMsg.includes('timed out');
    if (isTransient && retries > 0) {
      console.warn(`listRemoteDirStrict: Transient error listing "${remotePath}", retrying in 1.5s... (${retries} left). Error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 1500));
      return listRemoteDirStrict(remotePath, retries - 1, options);
    }
    throw error;
  }
}

async function listRawDirStrict(remotePath = '') {
  const stdout = await runRclone(['lsjson', getRawRemotePath(remotePath)], { timeoutMs: 45000 });
  return safeParseJson(stdout);
}

async function listRemoteTree(remotePath = '') {
  try {
    const stdout = await runRclone(['lsjson', getRemotePath(remotePath), '-R'], { timeoutMs: 120000 });
    return safeParseJson(stdout);
  } catch (e) {
    console.error('Failed to list remote tree:', e);
    return [];
  }
}

async function listRemoteTreeStrict(remotePath = '') {
  const stdout = await runRclone(['lsjson', getRemotePath(remotePath), '-R'], { timeoutMs: 120000 });
  return safeParseJson(stdout);
}

async function listRemoteShortcutCandidates() {
  const stdout = await runRclone([
    'lsjson',
    getRemotePath('computers'),
    '-R',
    '--dirs-only',
    '--max-depth', '6',
    '--include', '*/Users/*/Desktop',
    '--include', '*/Users/*/Documents',
    '--include', '*/Users/*/Downloads',
    '--include', '*/Users/*/Pictures',
    '--include', '*/Users/*/Music',
    '--include', '*/Users/*/Videos',
    '--include', '*/Users/*/OneDrive*/Desktop',
    '--include', '*/Users/*/OneDrive*/Documents',
    '--include', '*/Users/*/OneDrive*/Pictures'
  ], { timeoutMs: 120000 });
  return safeParseJson(stdout) || [];
}

/**
 * Get metadata for a specific remote file path
 */
async function getRemoteFileMetadata(remoteFilePath) {
  try {
    const stdout = await runRclone(['lsjson', getRemotePath(remoteFilePath)], { timeoutMs: 15000 });
    const items = safeParseJson(stdout);
    return items.length > 0 ? items[0] : null;
  } catch (e) {
    return null;
  }
}

/**
 * Get Google Drive storage info and account email
 */
async function fetchUserInfoFromGoogleApi() {
  const { configPath } = getPaths();
  if (!fs.existsSync(configPath)) return null;

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(/token\s*=\s*(.+)/);
    if (!match) return null;
    const token = safeParseJson(match[1].trim());
    if (!token || !token.access_token) return null;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const options = {
        hostname: 'www.googleapis.com',
        path: '/drive/v3/about?fields=user',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token.access_token}`,
          'User-Agent': `rclone/v${RCLONE_VERSION}`,
          'X-Goog-Api-Client': 'gl-go/1.22.1 gdcl/0.156.0',
          'Accept-Encoding': 'identity'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const resJson = safeParseJson(data);
              if (resJson && resJson.user) {
                finish({
                  email: resJson.user.emailAddress || '',
                  name: resJson.user.displayName || ''
                });
                return;
              }
            } catch (_) {}
          }
          finish(null);
        });
      });

      req.on('error', () => finish(null));
      req.setTimeout(10000, () => {
        finish(null);
        req.destroy();
      });
      req.end();
    });
  } catch (e) {
    console.warn('Failed to fetch user info from API fallback:', e.message);
    return null;
  }
}

/**
 * Get Google Drive storage info and account email
 */
async function getGDriveInfo() {
  return getGDriveInfoForRemote(getRawRemoteName());
}

/**
 * Purge trash folders older than 30 days
 */
async function purgeOldTrash() {
  try {
    const dirs = await listRemoteDir(getVaultPath('trash'));
    const now = new Date();
    
    for (const dir of dirs) {
      if (!dir.IsDir) continue;
      // dir.Name should be YYYY-MM-DD
      const dirDate = new Date(dir.Name);
      if (isNaN(dirDate.getTime())) continue; // Not a date folder
      
      const diffDays = (now - dirDate) / (1000 * 60 * 60 * 24);
      if (diffDays > 30) {
        console.log(`Purging old trash folder: ${getVaultPath('trash', dir.Name)}`);
        await runRclone(['purge', `${getRemote()}:${getVaultPath('trash', dir.Name)}`]).catch(e => console.error(e));
      }
    }
  } catch (e) {
    // Trash folder might not exist yet, ignore
  }
}

/**
 * Run a cryptographic verification of a local folder against the remote encrypted backup
 */
function cryptCheck(localPath, remotePath, onLog, extraExclusions = []) {
  const { buildExcludeArgs } = require('./filesystem');
  const excludeArgs = buildExcludeArgs(extraExclusions);

  const args = [
    'cryptcheck',
    localPath,
    `${getRemote()}:${remotePath}`,
    '--one-way',
    ...excludeArgs
  ];

  return runRclone(args, {
    onStdout: onLog,
    onStderr: onLog
  });
}

async function cryptCheckFiles(localPath, remotePath, relativePaths = [], onLog, extraExclusions = []) {
  // rclone 1.74 rejects --files-from combined with normal filter flags.
  // The caller passes an explicit manifest-derived file list that is already
  // filtered, so targeted verification must use --files-from by itself.
  void extraExclusions;
  const { listPath, paths } = writeFilesFromList(relativePaths);
  if (paths.length === 0) {
    fs.unlink(listPath, () => {});
    return '';
  }

  try {
    return await runRclone([
      'cryptcheck',
      localPath,
      `${getRemote()}:${remotePath}`,
      '--one-way',
      '--files-from',
      listPath
    ], {
      onStdout: onLog,
      onStderr: onLog
    });
  } finally {
    fs.unlink(listPath, () => {});
  }
}

/**
 * Search for files matching a query across the remote vault
 */
async function searchFiles(query) {
  try {
    const stdout = await runRclone([
      'lsjson',
      `${getRemote()}:/`,
      '-R',
      '--exclude', '.labsuite_staging/**',
      '--exclude', '.labsuite_expired/**',
      '--exclude', '.labsuite_history/**',
      '--exclude', '.labsuite_trash/**',
      '--exclude', '.labsuite_packs/**',
      '--exclude', '.labsuite_control/**',
      '--exclude', '.vaultsync_staging/**',
      '--exclude', '.vaultsync_expired/**',
      '--exclude', '.vaultsync_history/**',
      '--exclude', '.vaultsync_trash/**',
      '--exclude', '.vaultsync_packs/**',
      '--exclude', '.vaultsync_control/**',
      '--include', `*${query}*`
    ]);
    return safeParseJson(stdout);
  } catch (e) {
    console.error('Search failed:', e);
    return [];
  }
}

/**
 * Get storage analytics (size and counts) for the remote vault
 */
async function getStorageAnalytics() {
  try {
    const stdout = await runRclone(['size', `${getRemote()}:/`, '--json']);
    return safeParseJson(stdout); // { count: 123, bytes: 45678 }
  } catch (e) {
    console.error('Analytics failed:', e);
    return { count: 0, bytes: 0 };
  }
}

let serveProcess = null;
let serveServer = null;
let serveUrl = '';
const activeServeDownloads = new Set();

/**
 * Start a local HTTP server to browse and download from the remote vault
 */
function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      // Port in use, try next
      findFreePort(startPort + 1).then(resolve).catch(reject);
    });
    server.listen(startPort, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function normalizeServeRemotePath(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function encodeRemotePath(remotePath = '') {
  const normalized = normalizeServeRemotePath(remotePath);
  return normalized.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatServeBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatServeDate(value = '') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function getServeRequestRemotePath(reqUrl) {
  if (reqUrl.searchParams.has('path')) {
    return normalizeServeRemotePath(reqUrl.searchParams.get('path') || '');
  }

  const rawPathname = String(reqUrl.pathname || '/');
  if (rawPathname === '/' || rawPathname === '/favicon.ico') return '';

  try {
    return normalizeServeRemotePath(decodeURIComponent(rawPathname));
  } catch (_) {
    return normalizeServeRemotePath(rawPathname);
  }
}

function getServeItemPath(currentPath, item) {
  const current = normalizeServeRemotePath(currentPath);
  const raw = normalizeServeRemotePath(item.Path || item.Name);
  if (!current) return raw;
  if (raw === current || raw.startsWith(`${current}/`)) return raw;
  return normalizeServeRemotePath(`${current}/${raw}`);
}

function isHiddenServeRootItem(currentPath, item) {
  if (normalizeServeRemotePath(currentPath)) return false;
  const name = String(item && item.Name || '').toLowerCase();
  return [
    '.labsuite_staging',
    '.labsuite_expired',
    '.labsuite_history',
    '.labsuite_trash',
    '.labsuite_packs',
    '.labsuite_control',
    '.vaultsync_staging',
    '.vaultsync_expired',
    '.vaultsync_history',
    '.vaultsync_trash',
    '.vaultsync_packs',
    '.vaultsync_control'
  ].includes(name);
}

function makeServeBreadcrumbs(currentPath) {
  const parts = normalizeServeRemotePath(currentPath).split('/').filter(Boolean);
  const crumbs = ['<a href="/">Vault</a>'];
  parts.forEach((part, index) => {
    const crumbPath = parts.slice(0, index + 1).join('/');
    crumbs.push(`<a href="/${encodeRemotePath(crumbPath)}/">${escapeHtml(part)}</a>`);
  });
  return crumbs.join('<span>/</span>');
}

function renderServePage({ currentPath = '', items = [], error = '' }) {
  const normalizedPath = normalizeServeRemotePath(currentPath);
  const parentPath = normalizedPath.split('/').slice(0, -1).join('/');
  const rows = [...items]
    .filter(item => !isHiddenServeRootItem(normalizedPath, item))
    .sort((a, b) => {
      if (!!a.IsDir !== !!b.IsDir) return a.IsDir ? -1 : 1;
      return String(a.Name || '').localeCompare(String(b.Name || ''), undefined, { sensitivity: 'base' });
    })
    .map(item => {
      const fullPath = getServeItemPath(normalizedPath, item);
      const name = item.Name || fullPath || 'Untitled';
      if (item.IsDir) {
        const href = `/${encodeRemotePath(fullPath)}/`;
        return `<tr>
          <td><a class="name" href="${href}"><span class="icon">folder</span>${escapeHtml(name)}</a></td>
          <td>Folder</td>
          <td>-</td>
          <td>${escapeHtml(formatServeDate(item.ModTime))}</td>
          <td><a class="button" href="${href}">Open</a></td>
        </tr>`;
      }

      const downloadHref = `/download?path=${encodeURIComponent(fullPath)}`;
      return `<tr>
        <td><a class="name" href="${downloadHref}"><span class="icon">file</span>${escapeHtml(name)}</a></td>
        <td>File</td>
        <td>${escapeHtml(formatServeBytes(item.Size))}</td>
        <td>${escapeHtml(formatServeDate(item.ModTime))}</td>
        <td><a class="button primary" href="${downloadHref}">Download</a></td>
      </tr>`;
    })
    .join('');

  const upHref = normalizedPath ? `/${encodeRemotePath(parentPath)}/` : '';
  const upRow = normalizedPath
    ? `<tr><td><a class="name" href="${upHref}"><span class="icon">up</span>Go up</a></td><td>-</td><td>-</td><td>-</td><td><a class="button" href="${upHref}">Open</a></td></tr>`
    : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LabSuite Vault</title>
  <style>
    :root { color-scheme: dark; font-family: Segoe UI, Arial, sans-serif; background: #101214; color: #f4f7fb; }
    body { margin: 0; background: #101214; color: #f4f7fb; }
    header { padding: 34px 48px; background: #242628; border-bottom: 1px solid #3a3d42; }
    h1 { margin: 0; font-size: 22px; font-weight: 700; }
    .crumbs { margin-top: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; color: #b7c0cc; }
    .crumbs a { color: #dfe9ff; text-decoration: none; }
    main { padding: 10px 48px 48px; }
    .error { margin: 20px 0; padding: 14px 16px; border: 1px solid #7f3131; background: #2b1717; color: #ffd6d6; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; table-layout: fixed; }
    th { color: #ffffff; text-align: left; border-bottom: 1px solid #5a5f68; padding: 10px 8px; font-size: 15px; }
    td { border-bottom: 1px dashed #3a3d42; padding: 12px 8px; color: #f7fbff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    th:nth-child(2), td:nth-child(2) { width: 110px; }
    th:nth-child(3), td:nth-child(3) { width: 120px; text-align: right; }
    th:nth-child(4), td:nth-child(4) { width: 220px; text-align: right; }
    th:nth-child(5), td:nth-child(5) { width: 120px; text-align: right; }
    a.name { color: #8ec7ff; text-decoration: none; font-weight: 600; }
    a.name:hover, .crumbs a:hover { text-decoration: underline; }
    .icon { display: inline-block; width: 52px; color: #ffd166; font-size: 12px; text-transform: uppercase; font-weight: 700; }
    .button { display: inline-block; padding: 7px 12px; border: 1px solid #58606a; border-radius: 6px; color: #f7fbff; text-decoration: none; background: #1c2025; font-weight: 700; font-size: 13px; }
    .button.primary { background: #2f806b; border-color: #3fa88c; }
    .empty { color: #aab4c2; padding: 34px 8px; }
    @media (max-width: 760px) {
      header, main { padding-left: 18px; padding-right: 18px; }
      th:nth-child(3), td:nth-child(3), th:nth-child(4), td:nth-child(4) { display: none; }
      th:nth-child(5), td:nth-child(5) { width: 110px; }
      .icon { width: 42px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>LabSuite Vault</h1>
    <nav class="crumbs">${makeServeBreadcrumbs(normalizedPath)}</nav>
  </header>
  <main>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th><th></th></tr></thead>
      <tbody>${upRow}${rows}</tbody>
    </table>
    ${!error && !upRow && !rows ? '<div class="empty">No files found.</div>' : ''}
  </main>
</body>
</html>`;
}

function sendServeHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(html);
}

function getAttachmentHeader(fileName) {
  const fallback = String(fileName || 'download')
    .replace(/[\\"]/g, '_')
    .replace(/[\r\n]/g, '')
    .slice(0, 120) || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName || fallback)}`;
}

async function handleServeDownload(remotePath, req, res) {
  const normalizedPath = normalizeServeRemotePath(remotePath);
  if (!normalizedPath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Missing file path.');
    return;
  }

  const fileName = path.posix.basename(normalizedPath) || 'download';
  const metadata = await getRemoteFileMetadata(normalizedPath).catch(() => null);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': getAttachmentHeader(fileName),
    'Cache-Control': 'no-store'
  };
  if (metadata && Number(metadata.Size) > 0) {
    headers['Content-Length'] = String(Number(metadata.Size));
  }
  res.writeHead(200, headers);

  const { rcloneBin, configPath } = getPaths();
  const proc = spawn(rcloneBin, [
    'cat',
    getRemotePath(normalizedPath),
    '--config',
    configPath
  ], { windowsHide: true });
  activeServeDownloads.add(proc);

  let stderr = '';
  proc.stderr.on('data', data => {
    stderr += data.toString();
  });
  proc.stdout.pipe(res);

  const cleanup = () => {
    activeServeDownloads.delete(proc);
  };
  res.on('close', () => {
    if (proc.exitCode === null && !proc.killed) {
      proc.kill();
    }
  });
  proc.on('error', error => {
    cleanup();
    console.warn('LabSuite web restore: download failed:', error.message);
    if (!res.destroyed) res.destroy(error);
  });
  proc.on('close', code => {
    cleanup();
    if (code !== 0) {
      console.warn('LabSuite web restore: rclone cat failed:', redactRcloneOutput(stderr));
      if (!res.destroyed && !res.writableEnded) res.destroy();
    }
  });
}

async function handleServeRequest(req, res) {
  const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
  if (reqUrl.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (reqUrl.pathname === '/download') {
    await handleServeDownload(reqUrl.searchParams.get('path') || '', req, res);
    return;
  }

  const currentPath = getServeRequestRemotePath(reqUrl);
  try {
    const listed = await listRemoteDirStrict(currentPath);
    sendServeHtml(res, 200, renderServePage({
      currentPath,
      items: Array.isArray(listed) ? listed : []
    }));
  } catch (error) {
    sendServeHtml(res, 500, renderServePage({
      currentPath,
      items: [],
      error: error.message || 'LabSuite could not read this vault folder.'
    }));
  }
}

function startHttpServer(port = 8080) {
  if (serveServer && serveUrl) return Promise.resolve(serveUrl);

  return findFreePort(port).then(freePort => {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        handleServeRequest(req, res).catch(error => {
          if (!res.headersSent) {
            sendServeHtml(res, 500, renderServePage({
              currentPath: '',
              items: [],
              error: error.message || 'LabSuite web server failed.'
            }));
          } else if (!res.destroyed) {
            res.destroy(error);
          }
        });
      });

      server.on('error', error => {
        serveServer = null;
        serveUrl = '';
        reject(error);
      });

      server.listen(freePort, '127.0.0.1', () => {
        serveServer = server;
        serveUrl = `http://127.0.0.1:${freePort}`;
        resolve(serveUrl);
      });
    });
  });
}

function stopHttpServer() {
  for (const proc of activeServeDownloads) {
    try {
      proc.kill();
    } catch (_) {}
  }
  activeServeDownloads.clear();

  if (serveServer) {
    try {
      serveServer.close();
    } catch (_) {}
    serveServer = null;
  }

  if (serveProcess) {
    serveProcess.kill();
    serveProcess = null;
  }
  serveUrl = '';
  return true;
}

/**
 * Get rclone version string
 */
async function getVersion() {
  try {
    const stdout = await runRclone(['version'], { timeoutMs: 10000 });
    return stdout.trim().split('\n')[0];
  } catch (e) {
    return 'Unknown';
  }
}

module.exports = {
  ENCRYPTED_FOLDER,
  LEGACY_ENCRYPTED_FOLDER,
  getConfiguredCryptRemoteRoot,
  getEncryptedFolder,
  detectEncryptedFolder,
  getControlFolderName,
  getVaultNamespace,
  getVaultPath,
  getRemote,
  getRawRemoteName,
  startGoogleAuth,
  startGoogleAuthForRemote,
  getGoogleDriveClientStatus,
  reconnectGoogleDriveClient,
  createCryptRemote,
  createCryptRemoteFor,
  syncRawFile,
  readRawText,
  readText,
  getGDriveInfoForRemote,
  remotePathExists,
  getNamedRemoteSize,
  copyNamedRemoteTree,
  checkNamedRemoteTree,
  checkConfig,
  disconnect,
  getRemoteSize,
  fullSync,
  syncFile,
  syncControlFile,
  copyFilesFrom,
  moveFilesFrom,
  deleteFile,
  deleteRemotePath,
  moveRemoteFile,
  restore,
  listRemoteDir,
  listRemoteDirStrict,
  listRawDirStrict,
  listRemoteTree,
  listRemoteTreeStrict,
  listRemoteShortcutCandidates,
  getRemoteFileMetadata,
  getGDriveInfo,
  getVersion,
  purgeOldTrash,
  cryptCheck,
  cryptCheckFiles,
  searchFiles,
  getStorageAnalytics,
  startHttpServer,
  stopHttpServer,
  copyFileRemoteToLocal,
  getPaths,
  __private: {
    getRemote,
    getRemotePath,
    getRawRemotePath,
    getNamedRemotePath,
    isNotFoundError,
    normalizeFilesFromPaths,
    redactRcloneArg,
    parseRcloneLogText,
    buildRcloneErrorMessage,
    isSharedGoogleClientRetirementNotice,
    getRcloneRemoteConfigValue,
    updateRcloneRemoteConfig,
    validateGoogleClientCredentials,
    getTransferFlagArgs
  }
};
