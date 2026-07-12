const lanDiscovery = require('./lanDiscovery');
const lanFileServer = require('./lanFileServer');
const lanTrust = require('./lanTrust');
const windowsFirewall = require('./windowsFirewall');

function getCapabilities() {
  return ['pairing', 'file-browser', 'folder-transfer', 'lan-drop'];
}

function buildAdvertisement(status = lanFileServer.getStatus()) {
  const settings = lanTrust.getSettings();
  return {
    filePort: status.port,
    networkDriveEnabled: !!status.enabled,
    capabilities: status.enabled ? getCapabilities() : [],
    deviceId: settings.deviceId,
    deviceName: settings.deviceName
  };
}

async function startNetworkDrive(options = {}) {
  const status = await lanFileServer.start(options.port);
  const settings = lanTrust.getSettings();
  let firewall = null;

  if (settings.firewallRule && options.ensureFirewall !== false) {
    firewall = windowsFirewall.ensureLanFirewallRules(status.port);
  }

  lanDiscovery.start(buildAdvertisement(status));
  return { ...status, firewall };
}

function stopNetworkDrive() {
  lanFileServer.stop();
  lanDiscovery.updateService({
    filePort: null,
    networkDriveEnabled: false,
    capabilities: [],
    deviceId: lanTrust.ensureLocalDeviceId(),
    deviceName: lanTrust.getDeviceName()
  });
  lanDiscovery.stop();
  return lanFileServer.getStatus();
}

function refreshAdvertisement() {
  const status = lanFileServer.getStatus();
  if (status.enabled) {
    lanDiscovery.updateService(buildAdvertisement(status));
  }
  return status;
}

function getStatus() {
  return lanFileServer.getStatus();
}

module.exports = {
  startNetworkDrive,
  stopNetworkDrive,
  refreshAdvertisement,
  getStatus,
  getCapabilities
};
