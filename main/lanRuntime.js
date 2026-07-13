const lanDiscovery = require('./lanDiscovery');
const lanFileServer = require('./lanFileServer');
const lanTrust = require('./lanTrust');
const windowsFirewall = require('./windowsFirewall');

let lastFirewall = null;

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
  lastFirewall = null;

  if (settings.firewallRule && options.ensureFirewall !== false) {
    firewall = windowsFirewall.ensureLanFirewallRules(status.port);
    lastFirewall = firewall;
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
  lastFirewall = null;
  return lanFileServer.getStatus();
}

async function configureFirewall() {
  const status = lanFileServer.getStatus();
  if (!status.enabled || !status.port) {
    throw new Error('Enable Network Drive before configuring its firewall rules.');
  }
  lastFirewall = await windowsFirewall.configureLanFirewallRulesElevated(status.port);
  return lastFirewall;
}

function refreshAdvertisement() {
  const status = lanFileServer.getStatus();
  if (status.enabled) {
    lanDiscovery.updateService(buildAdvertisement(status));
  }
  return status;
}

function getStatus() {
  return { ...lanFileServer.getStatus(), firewall: lastFirewall };
}

module.exports = {
  startNetworkDrive,
  stopNetworkDrive,
  configureFirewall,
  refreshAdvertisement,
  getStatus,
  getCapabilities
};
