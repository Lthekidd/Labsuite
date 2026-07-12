/**
 * LabSuite File Logger
 * Writes persistent logs to the Electron userData directory.
 * In production, patches console.log/warn/error to also write to disk.
 * Rotates at ~5 MB, keeping several backup files.
 */

const fs = require('fs');
const path = require('path');
const crashMonitor = require('./crashMonitor');

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

let logFilePath = null;
let logStream = null;

function getLogDir() {
  try {
    const { app } = require('electron');
    return app.getPath('logs');
  } catch (e) {
    return path.join(__dirname, '../data/logs');
  }
}

const MAX_BACKUP_FILES = 5;
const MAX_LOG_AGE_DAYS = 30;

function rotateLogs(dir) {
  try {
    for (let i = MAX_BACKUP_FILES - 1; i >= 1; i--) {
      const src = path.join(dir, `labsuite.log.${i}`);
      const dst = path.join(dir, `labsuite.log.${i + 1}`);
      if (fs.existsSync(src)) {
        if (fs.existsSync(dst)) fs.unlinkSync(dst);
        fs.renameSync(src, dst);
      }
    }
    const backup1 = path.join(dir, `labsuite.log.1`);
    if (fs.existsSync(backup1)) fs.unlinkSync(backup1);
    fs.renameSync(logFilePath, backup1);
  } catch (e) {
    console.error('Logger: rotation failed:', e.message);
  }
}

function cleanOldLogs(dir) {
  try {
    const files = fs.readdirSync(dir);
    const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (file.startsWith('labsuite.log.') || file === 'labsuite.old.log') {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          console.log(`Logger: Pruned old log backup: ${file}`);
        }
      }
    }
  } catch (e) {
    console.error('Logger: cleanOldLogs failed:', e.message);
  }
}

function openStream() {
  try {
    const dir = getLogDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    logFilePath = path.join(dir, 'labsuite.log');

    // Rotate if file is too large
    if (fs.existsSync(logFilePath)) {
      const stat = fs.statSync(logFilePath);
      if (stat.size >= MAX_SIZE_BYTES) {
        rotateLogs(dir);
      }
    }

    logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
    logStream.on('error', (err) => {
      logStream = null;
    });

    cleanOldLogs(dir);
  } catch (e) {
    logStream = null;
  }
}

function formatLine(level, args) {
  const ts = new Date().toISOString();
  const msg = args
    .map(a => (typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a)))
    .join(' ');
  return `[${ts}] [${level}] ${msg}\n`;
}

function write(level, args) {
  if (!logStream) return;
  try {
    logStream.write(formatLine(level, args));
  } catch (e) {
    // Silently ignore write errors
  }
}

/**
 * Initialise the logger. Call once from main/index.js.
 * In production, patches console so all existing log calls persist to disk.
 * In dev, leaves console untouched (logs still appear in terminal).
 */
function initLogger(isDev = false) {
  openStream();

  if (!isDev) {
    // Patch console so all existing calls across all modules are captured
    const origLog   = console.log.bind(console);
    const origWarn  = console.warn.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args) => { origLog(...args);   write('INFO',  args); };
    console.warn = (...args) => { origWarn(...args);  write('WARN',  args); };
    console.error = (...args) => { origError(...args); write('ERROR', args); };
  }

  // Always capture uncaught exceptions / rejections to the log file
  process.on('uncaughtException', (err) => {
    write('FATAL', [`Uncaught Exception: ${err.stack || err.message}`]);
    crashMonitor.report('uncaughtException', err);
    // Allow process to exit naturally — don't suppress, just log it
  });

  process.on('unhandledRejection', (reason) => {
    write('FATAL', [`Unhandled Rejection: ${reason instanceof Error ? reason.stack : String(reason)}`]);
    crashMonitor.report('unhandledRejection', reason);
  });

  write('INFO', [`LabSuite logger initialised. Log file: ${logFilePath}`]);
}

function getLogPath() {
  return logFilePath;
}

module.exports = { initLogger, getLogPath, write };
