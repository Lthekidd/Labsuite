const os = require('os');
const crypto = require('crypto');
const db = require('./database');

const DEFAULT_PERMISSIONS = {
  browse: true,
  download: true,
  upload: true
};

function parseJsonSetting(key, fallback) {
  try {
    const value = db.getSetting(key);
    if (!value) return fallback;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJsonSetting(key, value) {
  db.setSetting(key, JSON.stringify(value));
}

function ensureLocalDeviceId() {
  let deviceId = String(db.getSetting('lan_device_id') || '').trim();
  if (!deviceId) {
    deviceId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    db.setSetting('lan_device_id', deviceId);
  }
  return deviceId;
}

function getDeviceName() {
  return String(db.getSetting('lan_device_name') || '').trim() || os.hostname() || 'LabSuite PC';
}

function setDeviceName(name) {
  const cleaned = String(name || '').trim().slice(0, 64) || os.hostname() || 'LabSuite PC';
  db.setSetting('lan_device_name', cleaned);
  return cleaned;
}

function getTrustedDevices() {
  const devices = parseJsonSetting('lan_trusted_devices', {});
  return Object.fromEntries(
    Object.entries(devices)
      .filter(([deviceId, device]) => deviceId && device && typeof device === 'object')
      .map(([deviceId, device]) => [deviceId, {
        deviceId,
        name: String(device.name || 'LabSuite PC'),
        token: String(device.token || ''),
        tlsFingerprint: String(device.tlsFingerprint || ''),
        permissions: { ...DEFAULT_PERMISSIONS, ...(device.permissions || {}) },
        pairedAt: device.pairedAt || new Date().toISOString(),
        lastSeen: device.lastSeen || ''
      }])
      .filter(([, device]) => device.token)
  );
}

function getTrustedDevice(deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return null;
  return getTrustedDevices()[id] || null;
}

function isTrusted(deviceId) {
  return !!getTrustedDevice(deviceId);
}

function saveTrustedDevice(device) {
  if (!device || !device.deviceId || !device.token) {
    throw new Error('Trusted device record is incomplete.');
  }
  const devices = getTrustedDevices();
  const deviceId = String(device.deviceId);
  devices[deviceId] = {
    deviceId,
    name: String(device.name || 'LabSuite PC').slice(0, 64),
    token: String(device.token),
    tlsFingerprint: String(device.tlsFingerprint || devices[deviceId]?.tlsFingerprint || ''),
    permissions: { ...DEFAULT_PERMISSIONS, ...(device.permissions || {}) },
    pairedAt: device.pairedAt || devices[deviceId]?.pairedAt || new Date().toISOString(),
    lastSeen: device.lastSeen || new Date().toISOString()
  };
  writeJsonSetting('lan_trusted_devices', devices);
  return devices[deviceId];
}

function forgetTrustedDevice(deviceId) {
  const devices = getTrustedDevices();
  delete devices[String(deviceId || '')];
  writeJsonSetting('lan_trusted_devices', devices);
  return true;
}

function getSettings() {
  return {
    deviceId: ensureLocalDeviceId(),
    deviceName: getDeviceName(),
    autoStart: db.getSetting('lan_auto_start') === '1',
    firewallRule: db.getSetting('lan_firewall_rule') !== '0'
  };
}

function updateSettings(settings = {}) {
  if (Object.prototype.hasOwnProperty.call(settings, 'deviceName')) {
    setDeviceName(settings.deviceName);
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'autoStart')) {
    db.setSetting('lan_auto_start', settings.autoStart ? '1' : '0');
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'firewallRule')) {
    db.setSetting('lan_firewall_rule', settings.firewallRule ? '1' : '0');
  }
  return getSettings();
}

function makePairToken() {
  return crypto.randomBytes(32).toString('hex');
}

function makePairCode(requestId, fromDeviceId, toDeviceId = ensureLocalDeviceId()) {
  const digest = crypto
    .createHash('sha256')
    .update(`${requestId}:${fromDeviceId}:${toDeviceId}`)
    .digest('hex');
  const numeric = Number.parseInt(digest.slice(0, 8), 16) % 1000000;
  return String(numeric).padStart(6, '0');
}

module.exports = {
  DEFAULT_PERMISSIONS,
  ensureLocalDeviceId,
  getDeviceName,
  setDeviceName,
  getTrustedDevices,
  getTrustedDevice,
  isTrusted,
  saveTrustedDevice,
  forgetTrustedDevice,
  getSettings,
  updateSettings,
  makePairToken,
  makePairCode
};
