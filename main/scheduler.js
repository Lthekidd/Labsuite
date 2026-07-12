const db = require('./database');
const backupWorker = require('./backupWorker');

let scheduleInterval = null;
let resumeHandlersRegistered = false;

/**
 * Executes a backup run for all active folders.
 * Kept as runFullSync for compatibility with existing IPC/tray callers.
 */
async function runFullSync(onProgressCallback, options = {}) {
  if (backupWorker.isRunning) {
    console.log('Scheduler: Backup already in progress, skipping scheduled run.');
    return false;
  }

  console.log('Scheduler: Starting backup run...');
  return backupWorker.runBackup(null, {
    manual: options.manual === true,
    reason: options.reason || (options.manual === true ? 'manual' : 'full')
  }).then(result => {
    if (onProgressCallback) {
      // Progress is emitted through backupWorker events; this callback remains for old callers.
    }
    return result;
  });
}

function shouldRunFullReconcile() {
  const intervalHours = Number(db.getSetting('full_reconcile_interval_hours')) || 24;
  if (intervalHours <= 0) return false;

  const last = Date.parse(db.getSetting('last_full_reconcile') || '');
  if (!Number.isFinite(last)) return true;

  return Date.now() - last >= intervalHours * 60 * 60 * 1000;
}

function isWithinActiveHours() {
  const enabled = db.getSetting('sync_active_hours_enabled') === '1';
  if (!enabled) return true;

  const startStr = db.getSetting('sync_active_hours_start'); // e.g. "09:00"
  const endStr = db.getSetting('sync_active_hours_end');     // e.g. "17:00"
  if (!startStr || !endStr) return true;

  const [startH, startM] = startStr.split(':').map(Number);
  const [endH, endM] = endStr.split(':').map(Number);

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + (startM || 0);
  const endMinutes = endH * 60 + (endM || 0);

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  } else {
    // Overnight active hours window, e.g. 22:00 to 06:00
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }
}

async function runScheduledBackup() {
  if (backupWorker.isRunning) {
    console.log('Scheduler: Backup already in progress, skipping scheduled run.');
    return false;
  }

  const network = require('./network');
  const policy = network.isSyncAllowed({ manual: false });
  if (!policy.allowed) {
    console.log(`Scheduler: ${policy.reason}. Skipping backup.`);
    return false;
  }

  if (shouldRunFullReconcile()) {
    console.log('Scheduler: Starting scheduled full reconciliation backup...');
    return backupWorker.runBackup(null, { reason: 'scheduled-full-reconcile' });
  }

  console.log('Scheduler: Starting quick changed-file backup...');
  return backupWorker.runBackup(null, { dirtyOnly: true, reason: 'scheduled-quick' });
}

let nextRunTime = null;
let currentIntervalMinutes = null;

function maybeRunDueBackup(reason = 'scheduled') {
  if (!nextRunTime || Date.now() < nextRunTime) return false;
  nextRunTime = Date.now() + currentIntervalMinutes * 60 * 1000;
  runScheduledBackup().catch(err => {
    console.error(`Scheduler: ${reason} backup failed:`, err.message);
  });
  return true;
}

function registerResumeHandlers() {
  if (resumeHandlersRegistered) return;
  resumeHandlersRegistered = true;
  try {
    const { powerMonitor } = require('electron');
    const onResume = () => {
      if (scheduleInterval) {
        maybeRunDueBackup('resume');
      }
    };
    powerMonitor.on('resume', onResume);
    powerMonitor.on('unlock-screen', onResume);
  } catch (_) {
    // Electron powerMonitor is unavailable in unit-test contexts.
  }
}

function startScheduler(intervalMinutes) {
  stopScheduler();

  if (intervalMinutes === undefined || intervalMinutes === null) {
    const saved = db.getSetting('sync_interval_minutes');
    intervalMinutes = parseInt(saved, 10) || 15;
  }

  if (intervalMinutes <= 0) {
    console.log('Scheduler: Interval set to manual. Periodic backups disabled.');
    return;
  }

  console.log(`Scheduler: Starting periodic backups every ${intervalMinutes} minutes.`);
  currentIntervalMinutes = intervalMinutes;
  nextRunTime = Date.now() + intervalMinutes * 60 * 1000;
  registerResumeHandlers();

  scheduleInterval = setInterval(() => {
    maybeRunDueBackup('scheduled');
  }, 30000);
}

function stopScheduler() {
  if (scheduleInterval) {
    clearInterval(scheduleInterval);
    scheduleInterval = null;
    nextRunTime = null;
    currentIntervalMinutes = null;
    console.log('Scheduler: Stopped.');
  }
}

function updateInterval(intervalMinutes) {
  db.setSetting('sync_interval_minutes', String(intervalMinutes));
  startScheduler(intervalMinutes);
}

module.exports = {
  startScheduler,
  stopScheduler,
  updateInterval,
  runFullSync,
  runScheduledBackup
};
