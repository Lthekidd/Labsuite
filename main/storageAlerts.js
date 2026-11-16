const db = require('./database');
const notifier = require('./notifier');
const rclone = require('./rclone');

const formatBytes = (bytes) => {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

/**
 * Checks Google Drive and folder storage limits against configured alert thresholds.
 * Dispatches desktop notifications if warnings are triggered (debounced to once every 24h).
 */
async function checkStorageAlerts() {
  if (db.getSetting('storage_warning_notifications_enabled') === '0') return;

  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  // 1. Check Google Drive account usage
  try {
    const driveWarnPct = Number(db.getSetting('storage_warning_percent')) || 85;
    const gdriveInfo = await rclone.getGDriveInfo().catch(() => null);
    if (gdriveInfo && gdriveInfo.total > 0 && gdriveInfo.used > 0) {
      const usedPct = (gdriveInfo.used / gdriveInfo.total) * 100;
      if (usedPct >= driveWarnPct) {
        const lastWarn = Number(db.getSetting('last_storage_warn_drive')) || 0;
        if (now - lastWarn > ONE_DAY_MS) {
          db.setSetting('last_storage_warn_drive', String(now));
          notifier.showNotification(
            'Google Drive Storage Warning',
            `Your cloud storage is at ${usedPct.toFixed(1)}% capacity (${formatBytes(gdriveInfo.used)} of ${formatBytes(gdriveInfo.total)} used). Purge old history or trash in LabSuite to reclaim space.`,
            'warning'
          );
        }
      }
    }
  } catch (err) {
    console.warn('checkStorageAlerts: drive check error:', err.message);
  }

  // 2. Check individual backup folder sizes
  try {
    const folderWarnGib = Number(db.getSetting('storage_folder_warning_gib')) || 100;
    const folderWarnBytes = folderWarnGib * 1024 * 1024 * 1024;
    const folders = db.getFolders();

    for (const folder of folders) {
      if (!folder.remote_path) continue;
      const bytes = folder.sync_bytes_total || 0;
      if (bytes >= folderWarnBytes) {
        const warnKey = `last_storage_warn_folder_${folder.id}`;
        const lastWarn = Number(db.getSetting(warnKey)) || 0;
        if (now - lastWarn > ONE_DAY_MS) {
          db.setSetting(warnKey, String(now));
          notifier.showNotification(
            'Large Backup Folder Detected',
            `Folder "${folder.local_path || folder.remote_path}" is using ${formatBytes(bytes)} of cloud storage (> ${folderWarnGib} GiB). Consider reviewing or deleting unnecessary cloud data.`,
            'warning'
          );
        }
      }
    }
  } catch (err) {
    console.warn('checkStorageAlerts: folder check error:', err.message);
  }
}

module.exports = { checkStorageAlerts };
