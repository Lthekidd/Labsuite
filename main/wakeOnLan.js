const dgram = require('dgram');
const dns = require('dns');
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');

const DEFAULT_WOL_PORT = 9;
const DEFAULT_BURST_COUNT = 3;
const DEFAULT_BURST_INTERVAL_MS = 120;
const DEFAULT_VERIFY_TIMEOUT_MS = 30000;
const DEFAULT_VERIFY_INTERVAL_MS = 2000;
const MAX_DISCOVERY_HOSTS_PER_SUBNET = 1024;

const COMMON_OUI_VENDORS = new Map([
  ['000569', 'VMware'],
  ['000C29', 'VMware'],
  ['001C14', 'VMware'],
  ['005056', 'VMware'],
  ['080027', 'Oracle VirtualBox'],
  ['00155D', 'Microsoft Hyper-V'],
  ['B827EB', 'Raspberry Pi'],
  ['DCA632', 'Raspberry Pi'],
  ['E45F01', 'Raspberry Pi'],
  ['D83ADD', 'Raspberry Pi'],
  ['2CCF67', 'Raspberry Pi'],
  ['001422', 'Dell'],
  ['001AA0', 'Dell'],
  ['F8B156', 'Dell'],
  ['001B78', 'HP'],
  ['3CD92B', 'HP'],
  ['0021CC', 'Lenovo'],
  ['E86A64', 'Lenovo'],
  ['2CFDA1', 'ASUSTek'],
  ['000393', 'Apple'],
  ['000A95', 'Apple'],
  ['0017F2', 'Apple'],
  ['3C22FB', 'Apple']
]);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => {
      const timer = setTimeout(() => resolve(fallback), timeoutMs);
      timer.unref?.();
    })
  ]);
}

function normalizeMac(macAddress) {
  const cleanMac = String(macAddress || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(cleanMac)) {
    throw new Error('MAC address must contain exactly 12 hexadecimal characters.');
  }
  if (cleanMac === '000000000000' || cleanMac === 'FFFFFFFFFFFF') {
    throw new Error('MAC address cannot be all zeroes or the broadcast address.');
  }
  if ((parseInt(cleanMac.slice(0, 2), 16) & 1) === 1) {
    throw new Error('MAC address must identify a unicast network adapter.');
  }
  return cleanMac.match(/.{2}/g).join(':');
}

function normalizeIPv4(value, label, { allowAuto = false, optional = false } = {}) {
  const text = String(value || '').trim();
  if (optional && !text) return '';
  if (allowAuto && (!text || text.toLowerCase() === 'auto')) return 'auto';
  if (!net.isIPv4(text)) {
    throw new Error(`${label} must be a valid IPv4 address${allowAuto ? ' or "auto"' : ''}.`);
  }
  return text;
}

function normalizePort(value) {
  const port = Number(value === undefined || value === null || value === '' ? DEFAULT_WOL_PORT : value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Wake-on-LAN port must be an integer from 1 to 65535.');
  }
  return port;
}

function normalizeStoredDevice(device = {}) {
  const legacyBroadcast = String(device.ip || '').trim();
  const broadcastIp = normalizeIPv4(
    device.broadcastIp || legacyBroadcast || 'auto',
    'Broadcast IP',
    { allowAuto: true }
  );
  let hostIp = '';
  try {
    hostIp = normalizeIPv4(device.hostIp || '', 'Host IP', { optional: true });
  } catch (_) {
    hostIp = '';
  }

  return {
    ...device,
    id: String(device.id || ''),
    name: String(device.name || 'Unnamed PC').trim() || 'Unnamed PC',
    mac: normalizeMac(device.mac),
    hostIp,
    broadcastIp,
    ip: broadcastIp,
    port: normalizePort(device.port),
    hostname: String(device.hostname || '').trim().slice(0, 255),
    vendor: String(device.vendor || lookupMacVendor(device.mac)).trim().slice(0, 120)
  };
}

function validateDeviceInput(payload = {}, existingDevices = [], editingId = '') {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('Device name is required.');
  if (name.length > 80) throw new Error('Device name must be 80 characters or fewer.');

  const mac = normalizeMac(payload.mac);
  const hostIp = normalizeIPv4(payload.hostIp || '', 'Host IP', { optional: true });
  const broadcastIp = normalizeIPv4(payload.broadcastIp || payload.ip || 'auto', 'Broadcast IP', { allowAuto: true });
  const port = normalizePort(payload.port);
  const normalizedEditingId = String(editingId || payload.id || '');

  const duplicate = existingDevices
    .map(device => {
      try { return normalizeStoredDevice(device); } catch (_) { return null; }
    })
    .find(device => device && device.id !== normalizedEditingId && device.mac === mac);
  if (duplicate) {
    throw new Error(`A device named "${duplicate.name}" already uses MAC address ${mac}.`);
  }

  return {
    name,
    mac,
    hostIp,
    broadcastIp,
    ip: broadcastIp,
    port,
    hostname: String(payload.hostname || '').trim().slice(0, 255),
    vendor: String(payload.vendor || lookupMacVendor(mac)).trim().slice(0, 120)
  };
}

function ipv4ToInt(address) {
  if (!net.isIPv4(address)) throw new Error(`Invalid IPv4 address: ${address}`);
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0) >>> 0;
}

function intToIPv4(value) {
  const unsigned = Number(value) >>> 0;
  return [
    (unsigned >>> 24) & 255,
    (unsigned >>> 16) & 255,
    (unsigned >>> 8) & 255,
    unsigned & 255
  ].join('.');
}

function countMaskBits(maskInt) {
  let value = maskInt >>> 0;
  let count = 0;
  while (value !== 0) {
    count += value & 1;
    value >>>= 1;
  }
  return count;
}

function getInterfaceDetails(networkInterfaces = os.networkInterfaces()) {
  const details = [];
  for (const [name, addresses] of Object.entries(networkInterfaces || {})) {
    for (const iface of addresses || []) {
      const family = typeof iface.family === 'string' ? iface.family : (iface.family === 4 ? 'IPv4' : String(iface.family));
      if (family !== 'IPv4' || iface.internal || !net.isIPv4(iface.address) || !net.isIPv4(iface.netmask)) continue;

      const addressInt = ipv4ToInt(iface.address);
      const maskInt = ipv4ToInt(iface.netmask);
      const networkInt = (addressInt & maskInt) >>> 0;
      const broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;
      details.push({
        name,
        address: iface.address,
        netmask: iface.netmask,
        cidr: countMaskBits(maskInt),
        network: intToIPv4(networkInt),
        broadcastIp: intToIPv4(broadcastInt),
        networkInt,
        broadcastInt
      });
    }
  }
  return details;
}

function resolveBroadcastTargets(broadcastIp = 'auto', networkInterfaces = os.networkInterfaces()) {
  const configured = normalizeIPv4(broadcastIp || 'auto', 'Broadcast IP', { allowAuto: true });
  const targets = getInterfaceDetails(networkInterfaces).map(iface => ({
    broadcastIp: iface.broadcastIp,
    localAddress: iface.address,
    interfaceName: iface.name,
    source: 'adapter'
  }));

  if (configured !== 'auto') {
    targets.push({
      broadcastIp: configured,
      localAddress: '',
      interfaceName: 'Configured target',
      source: 'configured'
    });
  }
  if (targets.length === 0) {
    targets.push({
      broadcastIp: configured === 'auto' ? '255.255.255.255' : configured,
      localAddress: '',
      interfaceName: 'Default route',
      source: 'fallback'
    });
  }

  const seen = new Set();
  return targets.filter(target => {
    const key = `${target.localAddress}|${target.broadcastIp}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildMagicPacket(macAddress) {
  const cleanMac = normalizeMac(macAddress).replace(/:/g, '');
  const macBytes = Buffer.from(cleanMac, 'hex');
  const packet = Buffer.alloc(102, 0xFF);
  for (let index = 0; index < 16; index += 1) {
    macBytes.copy(packet, 6 + index * 6);
  }
  return packet;
}

function sendPacketToTarget(packet, target, port, options = {}) {
  const dgramModule = options.dgramModule || dgram;
  const burstCount = Math.max(1, Math.min(
    10,
    options.burstCount === undefined ? DEFAULT_BURST_COUNT : Number(options.burstCount)
  ));
  const burstIntervalMs = Math.max(
    0,
    options.burstIntervalMs === undefined ? DEFAULT_BURST_INTERVAL_MS : Number(options.burstIntervalMs)
  );

  return new Promise((resolve, reject) => {
    const socket = dgramModule.createSocket('udp4');
    let settled = false;

    const finish = error => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch (_) {}
      if (error) reject(error);
      else resolve(burstCount);
    };

    socket.once('error', finish);
    const bindArgs = target.localAddress ? [0, target.localAddress] : [0];
    socket.bind(...bindArgs, async () => {
      try {
        socket.setBroadcast(true);
        for (let index = 0; index < burstCount; index += 1) {
          await new Promise((resolveSend, rejectSend) => {
            socket.send(packet, 0, packet.length, port, target.broadcastIp, error => {
              if (error) rejectSend(error);
              else resolveSend();
            });
          });
          if (index + 1 < burstCount && burstIntervalMs > 0) await delay(burstIntervalMs);
        }
        finish();
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function sendMagicPacket(macAddress, options = {}) {
  const port = normalizePort(options.port);
  const packet = buildMagicPacket(macAddress);
  const targets = resolveBroadcastTargets(options.broadcastIp || 'auto', options.networkInterfaces);
  const outcomes = await Promise.allSettled(
    targets.map(target => sendPacketToTarget(packet, target, port, options).then(packetCount => ({
      ...target,
      packetCount
    })))
  );
  const sent = outcomes.filter(outcome => outcome.status === 'fulfilled').map(outcome => outcome.value);
  if (sent.length === 0) {
    const firstError = outcomes.find(outcome => outcome.status === 'rejected');
    throw firstError?.reason || new Error('No Wake-on-LAN packet could be sent.');
  }
  return {
    success: true,
    port,
    targetCount: sent.length,
    packetCount: sent.reduce((sum, target) => sum + target.packetCount, 0),
    targets: sent
  };
}

function pingHost(hostIp, timeoutMs = 1200, execFileImpl = execFile) {
  if (!net.isIPv4(hostIp)) return Promise.resolve({ online: false, method: '' });
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', String(Math.max(250, timeoutMs)), hostIp]
    : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), hostIp];

  return new Promise(resolve => {
    execFileImpl('ping', args, { windowsHide: true, timeout: timeoutMs + 500 }, error => {
      resolve({ online: !error, method: !error ? 'ping' : '' });
    });
  });
}

function probeTcpPort(hostIp, port, timeoutMs = 800, netModule = net) {
  return new Promise(resolve => {
    let settled = false;
    const socket = netModule.createConnection({ host: hostIp, port });
    const finish = (online, method = '') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ online, method });
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true, `tcp:${port}`));
    socket.once('error', error => {
      // A refused connection proves that the host answered even though the
      // selected service is closed.
      finish(error && error.code === 'ECONNREFUSED', error && error.code === 'ECONNREFUSED' ? `tcp:${port}:refused` : '');
    });
  });
}

async function checkDeviceOnline(hostIp, options = {}) {
  const normalizedIp = normalizeIPv4(hostIp, 'Host IP');
  const ports = Array.isArray(options.ports) && options.ports.length > 0
    ? options.ports.map(normalizePort)
    : [445, 3389, 22, 80, 443];
  const checks = [
    pingHost(normalizedIp, options.pingTimeoutMs, options.execFileImpl),
    ...ports.map(port => probeTcpPort(normalizedIp, port, options.tcpTimeoutMs, options.netModule))
  ];
  const results = await Promise.all(checks);
  return results.find(result => result.online) || { online: false, method: '' };
}

async function wakeAndVerify(deviceInput, options = {}) {
  const device = normalizeStoredDevice(deviceInput);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const sendOptions = {
    broadcastIp: device.broadcastIp,
    port: device.port,
    burstCount: options.burstCount,
    burstIntervalMs: options.burstIntervalMs,
    networkInterfaces: options.networkInterfaces,
    dgramModule: options.dgramModule
  };

  onProgress({ status: 'sending', message: 'Sending packet burst to local adapters...' });
  const sent = await sendMagicPacket(device.mac, sendOptions);
  onProgress({
    status: 'sent',
    message: `Sent ${sent.packetCount} packets through ${sent.targetCount} network target${sent.targetCount === 1 ? '' : 's'}.`,
    sent
  });

  if (!device.hostIp) {
    return {
      success: true,
      online: null,
      verified: false,
      sent,
      message: 'Magic packets sent. Add a host IP to verify when this device comes online.'
    };
  }

  const timeoutMs = Math.max(1000, Number(options.verifyTimeoutMs) || DEFAULT_VERIFY_TIMEOUT_MS);
  const intervalMs = Math.max(250, Number(options.verifyIntervalMs) || DEFAULT_VERIFY_INTERVAL_MS);
  const startedAt = Date.now();
  let attempt = 0;
  const checkOnline = typeof options.checkOnline === 'function'
    ? options.checkOnline
    : hostIp => checkDeviceOnline(hostIp, options);

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    onProgress({
      status: 'checking',
      attempt,
      elapsedMs: Date.now() - startedAt,
      message: `Waiting for ${device.hostIp} to come online...`
    });
    const result = await checkOnline(device.hostIp);
    if (result.online) {
      const elapsedMs = Date.now() - startedAt;
      onProgress({
        status: 'online',
        attempt,
        elapsedMs,
        method: result.method,
        message: `Device is online (${result.method}).`
      });
      return {
        success: true,
        online: true,
        verified: true,
        method: result.method,
        elapsedMs,
        sent,
        message: 'Device is online.'
      };
    }

    if (attempt % 3 === 0 && Date.now() - startedAt < timeoutMs) {
      onProgress({ status: 'retrying', attempt, message: 'Device has not answered yet; sending another packet burst...' });
      await sendMagicPacket(device.mac, sendOptions);
    }
    await delay(intervalMs);
  }

  onProgress({
    status: 'timeout',
    attempt,
    elapsedMs: Date.now() - startedAt,
    message: 'Wake packets were sent, but the device did not answer verification checks.'
  });
  return {
    success: true,
    online: false,
    verified: true,
    sent,
    message: 'Wake packets were sent, but online verification timed out.'
  };
}

function getDiscoverySubnets(networkInterfaces = os.networkInterfaces(), maxHosts = MAX_DISCOVERY_HOSTS_PER_SUBNET) {
  const seen = new Set();
  return getInterfaceDetails(networkInterfaces)
    .filter(iface => {
      const key = `${iface.networkInt}/${iface.cidr}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(iface => {
      const firstHost = iface.networkInt + 1;
      const lastHost = Math.max(firstHost - 1, iface.broadcastInt - 1);
      const availableHosts = Math.max(0, lastHost - firstHost + 1);
      const hostCount = Math.min(availableHosts, Math.max(1, maxHosts));
      // On very large corporate/VPN subnets, scan a bounded window around the
      // local adapter instead of the first addresses in the network, which may
      // be nowhere near the machine's actual neighbors.
      const idealStart = iface.address
        ? ipv4ToInt(iface.address) - Math.floor(hostCount / 2)
        : firstHost;
      const scanStart = Math.max(firstHost, Math.min(
        idealStart,
        Math.max(firstHost, lastHost - hostCount + 1)
      ));
      const targets = [];
      for (let offset = 0; offset < hostCount; offset += 1) {
        const ip = intToIPv4(scanStart + offset);
        if (ip !== iface.address) targets.push(ip);
      }
      return {
        ...iface,
        subnet: `${iface.network}/${iface.cidr}`,
        availableHosts,
        truncated: availableHosts > maxHosts,
        targets
      };
    });
}

async function populateNeighborTable(subnets, options = {}) {
  const dgramModule = options.dgramModule || dgram;
  for (const subnet of subnets) {
    await new Promise(resolve => {
      const socket = dgramModule.createSocket('udp4');
      const dummy = Buffer.alloc(1);
      let index = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch (_) {}
        resolve();
      };
      socket.once('error', finish);
      socket.bind(0, subnet.address, async () => {
        while (index < subnet.targets.length) {
          const batch = subnet.targets.slice(index, index + 32);
          await Promise.all(batch.map(ip => new Promise(resolveSend => {
            socket.send(dummy, 0, dummy.length, 9, ip, () => resolveSend());
          })));
          index += batch.length;
          if (index < subnet.targets.length) await delay(8);
        }
        await delay(250);
        finish();
      });
    });
  }
}

function parseArpTable(stdout, subnets = []) {
  const devices = [];
  const seen = new Set();
  let interfaceAddress = '';
  const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
  const macRegex = /(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/;

  for (const line of String(stdout || '').split(/\r?\n/)) {
    const interfaceMatch = line.match(/Interface:\s*((?:\d{1,3}\.){3}\d{1,3})/i);
    if (interfaceMatch) {
      interfaceAddress = interfaceMatch[1];
      continue;
    }
    const ipMatch = line.match(ipRegex);
    const macMatch = line.match(macRegex);
    if (!ipMatch || !macMatch || !net.isIPv4(ipMatch[0])) continue;

    const ip = ipMatch[0];
    let mac;
    try {
      mac = normalizeMac(macMatch[0]);
    } catch (_) {
      continue;
    }
    const firstOctet = Number(ip.split('.')[0]);
    if (
      firstOctet === 0 ||
      firstOctet === 127 ||
      firstOctet >= 224 ||
      seen.has(mac)
    ) {
      continue;
    }

    const ipInt = ipv4ToInt(ip);
    const subnet = subnets.find(item => ipInt > item.networkInt && ipInt < item.broadcastInt);
    if (subnets.length > 0 && !subnet) continue;
    seen.add(mac);
    devices.push({
      ip,
      hostIp: ip,
      mac,
      interfaceAddress: interfaceAddress || subnet?.address || '',
      interfaceName: subnet?.name || '',
      subnet: subnet?.subnet || '',
      broadcastIp: subnet?.broadcastIp || 'auto'
    });
  }
  return devices;
}

function readArpTable(execFileImpl = execFile) {
  const args = process.platform === 'win32' ? ['-a'] : ['-an'];
  return new Promise(resolve => {
    execFileImpl('arp', args, { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout || ''));
    });
  });
}

function lookupMacVendor(macAddress) {
  let cleanMac = '';
  try {
    cleanMac = normalizeMac(macAddress).replace(/:/g, '');
  } catch (_) {
    return 'Unknown vendor';
  }
  if ((parseInt(cleanMac.slice(0, 2), 16) & 2) === 2) {
    return 'Private/randomized address';
  }
  return COMMON_OUI_VENDORS.get(cleanMac.slice(0, 6)) || 'Unknown vendor';
}

async function lookupHostname(ip, options = {}) {
  const reverseImpl = options.reverseImpl || dns.promises.reverse.bind(dns.promises);
  try {
    const names = await withTimeout(reverseImpl(ip).catch(() => []), options.timeoutMs || 800, []);
    if (Array.isArray(names) && names[0]) return String(names[0]).replace(/\.$/, '');
  } catch (_) {
    // Windows name resolution below can still find NetBIOS/local DNS names.
  }
  if (process.platform !== 'win32') return '';

  const execFileImpl = options.execFileImpl || execFile;
  return new Promise(resolve => {
    execFileImpl(
      'ping',
      ['-a', '-n', '1', '-w', '400', ip],
      { windowsHide: true, timeout: 1000 },
      (_error, stdout) => {
        const match = String(stdout || '').match(/Pinging\s+([^\s\[]+)\s+\[/i);
        resolve(match && match[1] && match[1] !== ip ? match[1].replace(/\.$/, '') : '');
      }
    );
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function discoverDevices(options = {}) {
  const subnets = getDiscoverySubnets(options.networkInterfaces, options.maxHosts);
  await populateNeighborTable(subnets, options);
  const arpText = await readArpTable(options.execFileImpl);
  const neighbors = parseArpTable(arpText, subnets);
  const devices = await mapWithConcurrency(neighbors, 8, async device => ({
    ...device,
    hostname: await lookupHostname(device.ip, options),
    vendor: lookupMacVendor(device.mac)
  }));
  return {
    devices,
    subnets: subnets.map(subnet => ({
      name: subnet.name,
      address: subnet.address,
      subnet: subnet.subnet,
      broadcastIp: subnet.broadcastIp,
      availableHosts: subnet.availableHosts,
      scannedHosts: subnet.targets.length,
      truncated: subnet.truncated
    }))
  };
}

module.exports = {
  sendMagicPacket,
  wakeAndVerify,
  checkDeviceOnline,
  discoverDevices,
  normalizeStoredDevice,
  validateDeviceInput,
  lookupMacVendor,
  __private: {
    normalizeMac,
    normalizeIPv4,
    normalizePort,
    ipv4ToInt,
    intToIPv4,
    getInterfaceDetails,
    resolveBroadcastTargets,
    buildMagicPacket,
    getDiscoverySubnets,
    parseArpTable,
    lookupHostname,
    sendPacketToTarget
  }
};
