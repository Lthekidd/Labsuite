const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_TAIL_BYTES = 64 * 1024;
const SESSION_FILE = 'current-session.json';
const REPORT_PREFIX = 'crash-';

let db = null;
let configuredReportDir = '';
let configuredCrashDumpsDir = '';
let configuredLogPath = null;
let configuredAppVersion = null;
let currentSession = null;
const recentReports = new Map();

function resolveOption(option, fallback = '') {
  try {
    const value = typeof option === 'function' ? option() : option;
    return String(value || fallback);
  } catch (_) {
    return String(fallback || '');
  }
}

function defaultReportDir() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'Crash Reports');
  } catch (_) {
    return path.join(__dirname, '../data/crash-reports');
  }
}

function configure(options = {}) {
  db = options.db || db;
  configuredReportDir = options.reportDir || configuredReportDir;
  configuredCrashDumpsDir = options.crashDumpsDir || configuredCrashDumpsDir;
  configuredLogPath = options.logPath || configuredLogPath;
  configuredAppVersion = options.appVersion || configuredAppVersion;
}

function getReportDir() {
  return resolveOption(configuredReportDir, defaultReportDir());
}

function getCrashDumpsDir() {
  return resolveOption(configuredCrashDumpsDir);
}

function ensureReportDir() {
  const reportDir = getReportDir();
  fs.mkdirSync(reportDir, { recursive: true });
  return reportDir;
}

function getEndpoint() {
  const envEndpoint = String(process.env.LABSUITE_CRASH_REPORT_URL || '').trim();
  if (envEndpoint) return envEndpoint;
  try {
    return db ? String(db.getSetting('crash_report_url') || '').trim() : '';
  } catch (_) {
    return '';
  }
}

function redactText(value) {
  return String(value || '')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/("(?:client[_ -]?secret|password|access[_ -]?token|refresh[_ -]?token|authorization)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/((?:client[_ -]?secret|password|access[_ -]?token|refresh[_ -]?token)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
}

function safeClone(value) {
  const seen = new WeakSet();
  try {
    return JSON.parse(JSON.stringify(value, (key, item) => {
      if (typeof item === 'string') {
        if (/(?:client[_ -]?secret|password|access[_ -]?token|refresh[_ -]?token|authorization)/i.test(key)) {
          return '[REDACTED]';
        }
        return redactText(item);
      }
      if (item instanceof Error) {
        return { name: item.name, message: item.message, stack: item.stack, code: item.code };
      }
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }));
  } catch (_) {
    return String(value);
  }
}

function readLogTail() {
  const logPath = resolveOption(configuredLogPath);
  if (!logPath || !fs.existsSync(logPath)) return '';
  let descriptor;
  try {
    const stat = fs.statSync(logPath);
    const bytes = Math.min(stat.size, LOG_TAIL_BYTES);
    if (!bytes) return '';
    const buffer = Buffer.alloc(bytes);
    descriptor = fs.openSync(logPath, 'r');
    fs.readSync(descriptor, buffer, 0, bytes, stat.size - bytes);
    return redactText(buffer.toString('utf8'));
  } catch (_) {
    return '';
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
  }
}

function makePayload(type, error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error || '');
  const stack = error instanceof Error ? error.stack : '';
  return {
    app: 'LabSuite',
    type: String(type || 'unknown'),
    message: redactText(message),
    stack: redactText(stack),
    extra: safeClone(extra),
    recentLog: readLogTail(),
    hostname: os.hostname(),
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    version: resolveOption(configuredAppVersion, process.versions.electron || process.version),
    electronVersion: process.versions.electron || '',
    timestamp: new Date().toISOString()
  };
}

function writeLocalReport(payload) {
  try {
    const reportDir = ensureReportDir();
    const timestamp = payload.timestamp.replace(/[:.]/g, '-');
    const safeType = payload.type.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 50) || 'unknown';
    const suffix = Math.random().toString(16).slice(2, 8);
    const reportPath = path.join(reportDir, `${REPORT_PREFIX}${timestamp}-${safeType}-${suffix}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2), 'utf8');
    return reportPath;
  } catch (_) {
    return '';
  }
}

function sendRemote(payload) {
  const endpoint = getEndpoint();
  if (!endpoint) return false;

  let target;
  try {
    target = new URL(endpoint);
  } catch (_) {
    return false;
  }
  if (!['http:', 'https:'].includes(target.protocol)) return false;

  const body = JSON.stringify(payload);
  const client = target.protocol === 'https:' ? https : http;
  const req = client.request(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    },
    timeout: 5000
  }, res => res.resume());
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
  return true;
}

function report(type, error, extra = {}) {
  const dedupeKey = `${type}:${error instanceof Error ? error.message : String(error || '')}`;
  const now = Date.now();
  if (now - (recentReports.get(dedupeKey) || 0) < 15000) return false;
  recentReports.set(dedupeKey, now);
  for (const [key, timestamp] of recentReports) {
    if (now - timestamp > 60000) recentReports.delete(key);
  }

  const payload = makePayload(type, error, extra);
  const reportPath = writeLocalReport(payload);
  sendRemote(payload);
  return Boolean(reportPath);
}

function walkDumpFiles(directory, output = [], depth = 0) {
  if (!directory || depth > 4 || !fs.existsSync(directory)) return output;
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return output; }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkDumpFiles(entryPath, output, depth + 1);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dmp')) output.push(entryPath);
  }
  return output;
}

function prune() {
  const cutoff = Date.now() - RETENTION_MS;
  let removedReports = 0;
  let removedDumps = 0;
  try {
    const reportDir = ensureReportDir();
    for (const entry of fs.readdirSync(reportDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(REPORT_PREFIX) || !entry.name.endsWith('.json')) continue;
      const entryPath = path.join(reportDir, entry.name);
      if (fs.statSync(entryPath).mtimeMs < cutoff) {
        fs.unlinkSync(entryPath);
        removedReports += 1;
      }
    }
  } catch (_) {}

  for (const dumpPath of walkDumpFiles(getCrashDumpsDir())) {
    try {
      if (fs.statSync(dumpPath).mtimeMs < cutoff) {
        fs.unlinkSync(dumpPath);
        removedDumps += 1;
      }
    } catch (_) {}
  }
  return { removedReports, removedDumps };
}

function listReports() {
  prune();
  const reports = [];
  try {
    for (const entry of fs.readdirSync(ensureReportDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(REPORT_PREFIX) || !entry.name.endsWith('.json')) continue;
      const entryPath = path.join(getReportDir(), entry.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
        reports.push({ ...parsed, fileName: entry.name });
      } catch (_) {
        reports.push({ type: 'unreadable-report', message: 'This report could not be parsed.', fileName: entry.name });
      }
    }
  } catch (_) {}
  return reports.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
}

function listCrashDumps() {
  const cutoff = Date.now() - RETENTION_MS;
  return walkDumpFiles(getCrashDumpsDir()).flatMap(dumpPath => {
    try {
      const stat = fs.statSync(dumpPath);
      if (stat.mtimeMs < cutoff) return [];
      return [{ fileName: path.basename(dumpPath), path: dumpPath, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() }];
    } catch (_) {
      return [];
    }
  }).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function getSummary() {
  const reports = listReports();
  const dumps = listCrashDumps();
  return {
    reportCount: reports.length,
    dumpCount: dumps.length,
    newestAt: reports[0]?.timestamp || dumps[0]?.modifiedAt || null,
    retentionDays: 7,
    reportDir: getReportDir()
  };
}

function formatReportsForClipboard() {
  const reports = listReports();
  const dumps = listCrashDumps();
  const lines = [
    'LabSuite Crash Reports (last 7 days)',
    `Generated: ${new Date().toISOString()}`,
    `App version: ${resolveOption(configuredAppVersion, 'unknown')}`,
    `Computer: ${os.hostname()} (${process.platform} ${os.arch()} ${os.release()})`,
    `Saved reports: ${reports.length}; native crash dumps: ${dumps.length}`,
    ''
  ];

  if (!reports.length) lines.push('No saved LabSuite crash or hang reports were found.', '');
  reports.forEach((item, index) => {
    lines.push(`===== Report ${index + 1}: ${item.type || 'unknown'} =====`);
    lines.push(`Time: ${item.timestamp || 'unknown'}`);
    lines.push(`Message: ${item.message || '(none)'}`);
    if (item.stack) lines.push('Stack:', redactText(item.stack));
    if (item.extra && Object.keys(item.extra).length) {
      lines.push('Details:', redactText(JSON.stringify(item.extra, null, 2)));
    }
    if (item.recentLog) lines.push('Recent log context:', redactText(item.recentLog));
    lines.push('');
  });

  if (dumps.length) {
    lines.push('===== Native crash dumps =====');
    dumps.forEach(item => lines.push(`${item.modifiedAt} | ${item.fileName} | ${item.sizeBytes} bytes | ${item.path}`));
    lines.push('Native .dmp files are binary; their full file paths are listed above.');
  }
  return lines.join('\n').trim();
}

function sessionPath() {
  return path.join(ensureReportDir(), SESSION_FILE);
}

function writeSession() {
  if (!currentSession) return false;
  try {
    fs.writeFileSync(sessionPath(), JSON.stringify(currentSession, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function beginSession() {
  prune();
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(sessionPath(), 'utf8')); } catch (_) {}
  if (previous && previous.cleanExit !== true) {
    report('uncleanExit', new Error('LabSuite did not complete a clean shutdown.'), {
      previousSession: previous
    });
  }
  currentSession = {
    sessionId: `${Date.now()}-${process.pid}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    cleanExit: false,
    version: resolveOption(configuredAppVersion, process.versions.electron || process.version)
  };
  writeSession();
  return Boolean(previous && previous.cleanExit !== true);
}

function heartbeat() {
  if (!currentSession) return false;
  currentSession.lastHeartbeatAt = new Date().toISOString();
  return writeSession();
}

function endSession() {
  if (!currentSession) return false;
  currentSession.lastHeartbeatAt = new Date().toISOString();
  currentSession.endedAt = new Date().toISOString();
  currentSession.cleanExit = true;
  return writeSession();
}

module.exports = {
  RETENTION_MS,
  configure,
  report,
  prune,
  listReports,
  listCrashDumps,
  getSummary,
  getReportDir,
  formatReportsForClipboard,
  beginSession,
  heartbeat,
  endSession
};
