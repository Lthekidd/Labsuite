const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const wakeOnLan = require('../main/wakeOnLan');

const mockInterfaces = {
  Ethernet: [{
    family: 'IPv4',
    internal: false,
    address: '192.168.10.12',
    netmask: '255.255.254.0'
  }],
  WiFi: [{
    family: 'IPv4',
    internal: false,
    address: '10.0.0.5',
    netmask: '255.255.255.0'
  }],
  Loopback: [{
    family: 'IPv4',
    internal: true,
    address: '127.0.0.1',
    netmask: '255.0.0.0'
  }]
};

function makeFakeDgram(sentPackets) {
  return {
    createSocket() {
      const socket = new EventEmitter();
      socket.setBroadcast = enabled => {
        socket.broadcastEnabled = enabled;
      };
      socket.bind = (...args) => {
        const callback = args[args.length - 1];
        socket.localAddress = args.length > 2 ? args[1] : '';
        setImmediate(callback);
      };
      socket.send = (packet, offset, length, port, target, callback) => {
        sentPackets.push({
          packet: Buffer.from(packet.subarray(offset, offset + length)),
          port,
          target,
          localAddress: socket.localAddress
        });
        setImmediate(() => callback(null));
      };
      socket.close = () => {};
      return socket;
    }
  };
}

async function run() {
  const privateApi = wakeOnLan.__private;

  assert.strictEqual(privateApi.normalizeMac('aa-bb-cc-dd-ee-fe'), 'AA:BB:CC:DD:EE:FE');
  assert.throws(() => privateApi.normalizeMac('01:00:5E:00:00:01'), /unicast/);
  assert.strictEqual(privateApi.ipv4ToInt('192.168.10.1'), 3232238081);
  assert.strictEqual(privateApi.intToIPv4(3232238081), '192.168.10.1');

  const interfaceDetails = privateApi.getInterfaceDetails(mockInterfaces);
  assert.deepStrictEqual(
    interfaceDetails.map(item => ({
      name: item.name,
      cidr: item.cidr,
      network: item.network,
      broadcastIp: item.broadcastIp
    })),
    [
      { name: 'Ethernet', cidr: 23, network: '192.168.10.0', broadcastIp: '192.168.11.255' },
      { name: 'WiFi', cidr: 24, network: '10.0.0.0', broadcastIp: '10.0.0.255' }
    ],
    'directed broadcasts must be calculated from each adapter netmask'
  );

  const targets = privateApi.resolveBroadcastTargets('255.255.255.255', mockInterfaces);
  assert.deepStrictEqual(
    targets.map(target => target.broadcastIp),
    ['192.168.11.255', '10.0.0.255', '255.255.255.255'],
    'packet bursts must include every adapter plus an explicitly configured target'
  );

  const packet = privateApi.buildMagicPacket('AA:BB:CC:DD:EE:FE');
  assert.strictEqual(packet.length, 102);
  assert.ok(packet.subarray(0, 6).every(value => value === 0xFF));
  for (let offset = 6; offset < packet.length; offset += 6) {
    assert.strictEqual(packet.subarray(offset, offset + 6).toString('hex'), 'aabbccddeefe');
  }

  const subnets = privateApi.getDiscoverySubnets(mockInterfaces);
  assert.strictEqual(subnets[0].subnet, '192.168.10.0/23');
  assert.strictEqual(subnets[0].availableHosts, 510);
  assert.strictEqual(subnets[0].targets.length, 509, 'the local interface address must not be probed');
  assert.strictEqual(subnets[0].truncated, false);

  const arpOutput = `
Interface: 192.168.10.12 --- 0x7
  Internet Address      Physical Address      Type
  192.168.10.50         00-0c-29-aa-bb-cc     dynamic
  192.168.11.255        ff-ff-ff-ff-ff-ff     static
Interface: 10.0.0.5 --- 0xb
  10.0.0.20             08-00-27-11-22-34     dynamic
`;
  const parsed = privateApi.parseArpTable(arpOutput, subnets);
  assert.deepStrictEqual(
    parsed.map(device => ({
      ip: device.ip,
      mac: device.mac,
      broadcastIp: device.broadcastIp,
      subnet: device.subnet
    })),
    [
      {
        ip: '192.168.10.50',
        mac: '00:0C:29:AA:BB:CC',
        broadcastIp: '192.168.11.255',
        subnet: '192.168.10.0/23'
      },
      {
        ip: '10.0.0.20',
        mac: '08:00:27:11:22:34',
        broadcastIp: '10.0.0.255',
        subnet: '10.0.0.0/24'
      }
    ]
  );
  assert.strictEqual(wakeOnLan.lookupMacVendor(parsed[0].mac), 'VMware');
  assert.strictEqual(wakeOnLan.lookupMacVendor(parsed[1].mac), 'Oracle VirtualBox');
  const resolvedHostname = await privateApi.lookupHostname('192.168.10.50', {
    reverseImpl: async () => [],
    execFileImpl: (_command, _args, _options, callback) => {
      callback(null, 'Pinging GAMING-PC [192.168.10.50] with 32 bytes of data:');
    }
  });
  if (process.platform === 'win32') {
    assert.strictEqual(resolvedHostname, 'GAMING-PC');
  } else {
    assert.strictEqual(resolvedHostname, '');
  }

  const existing = [{
    id: 'one',
    name: 'Existing',
    mac: 'AA:BB:CC:DD:EE:FE',
    hostIp: '192.168.10.50',
    broadcastIp: 'auto',
    port: 9
  }];
  assert.throws(
    () => wakeOnLan.validateDeviceInput({
      name: 'Duplicate',
      mac: 'AA-BB-CC-DD-EE-FE',
      hostIp: '192.168.10.51',
      broadcastIp: 'auto',
      port: 9
    }, existing),
    /already uses MAC address/
  );
  assert.strictEqual(
    wakeOnLan.validateDeviceInput({
      id: 'one',
      name: 'Edited',
      mac: 'AA:BB:CC:DD:EE:FE',
      hostIp: '192.168.10.51',
      broadcastIp: '192.168.11.255',
      port: 7
    }, existing, 'one').port,
    7,
    'editing the same device must not trip duplicate-MAC protection'
  );

  const sentPackets = [];
  const sent = await wakeOnLan.sendMagicPacket('AA:BB:CC:DD:EE:FE', {
    broadcastIp: 'auto',
    port: 9,
    burstCount: 3,
    burstIntervalMs: 0,
    networkInterfaces: mockInterfaces,
    dgramModule: makeFakeDgram(sentPackets)
  });
  assert.strictEqual(sent.targetCount, 2);
  assert.strictEqual(sent.packetCount, 6);
  assert.strictEqual(sentPackets.length, 6);
  assert.ok(sentPackets.every(item => item.packet.length === 102 && item.port === 9));

  let onlineChecks = 0;
  const wakeResult = await wakeOnLan.wakeAndVerify({
    id: 'wake-test',
    name: 'Wake Test',
    mac: 'AA:BB:CC:DD:EE:FE',
    hostIp: '192.168.10.50',
    broadcastIp: 'auto',
    port: 9
  }, {
    burstCount: 1,
    burstIntervalMs: 0,
    verifyTimeoutMs: 3000,
    verifyIntervalMs: 250,
    networkInterfaces: mockInterfaces,
    dgramModule: makeFakeDgram([]),
    checkOnline: async () => {
      onlineChecks += 1;
      return onlineChecks >= 2
        ? { online: true, method: 'tcp:445' }
        : { online: false, method: '' };
    }
  });
  assert.strictEqual(wakeResult.online, true);
  assert.strictEqual(wakeResult.method, 'tcp:445');
  assert.strictEqual(onlineChecks, 2);

  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'apps', 'WakeOnLan.jsx'), 'utf8');
  for (const channel of ['wol:updateDevice', 'wol:testDevice', 'wol:wakeDevice', 'wol:discoverDevices']) {
    assert.ok(preload.includes(`'${channel}'`), `preload must allow ${channel}`);
    assert.ok(ipc.includes(`ipcMain.handle('${channel}'`), `main process must handle ${channel}`);
  }
  assert.ok(preload.includes("'wol:wake-progress'"), 'wake progress events must cross the preload boundary');
  assert.ok(renderer.includes('Subnet-aware Discovery'));
  assert.ok(renderer.includes('Wake and verify'));
  assert.ok(renderer.includes('Save Changes'));

  console.log('Wake-on-LAN verification passed (broadcasts, retries, validation, and subnet discovery).');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
