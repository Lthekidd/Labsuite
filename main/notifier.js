const { Notification, app } = require('electron');
const path = require('path');
const db = require('./database');

/**
 * Display a native desktop notification if notifications are enabled.
 * @param {string} title - Notification title
 * @param {string} body - Notification description text
 * @param {string} type - icon type ('info' | 'error' | 'warning')
 */
function showNotification(title, body, type = 'info') {
  try {
    const settings = db.getDb().settings || {};
    if (settings.notifications_enabled === '0') {
      return; // Disabled by user settings
    }

    if (!Notification.isSupported()) {
      console.warn('Notifications: Native desktop notifications not supported on this OS.');
      return;
    }

    // Pick icon based on status
    const iconName = type === 'error' 
      ? 'tray-error.png' 
      : type === 'warning'
      ? 'tray-paused.png'
      : 'tray-idle.png';
      
    const baseDir = app.isPackaged 
      ? path.join(process.resourcesPath, 'assets') 
      : path.join(__dirname, '../assets');
    const iconPath = path.join(baseDir, iconName);

    const notification = new Notification({
      title: title || 'LabSuite',
      body: body || '',
      icon: iconPath,
      silent: false
    });

    notification.show();
    console.log(`Notifications: Dispatched native notification: [${title}] ${body}`);
  } catch (err) {
    console.error('Notifications: Failed to trigger notification:', err.message);
  }
}

module.exports = { showNotification };
