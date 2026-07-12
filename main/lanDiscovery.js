const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');
const crypto = require('crypto');

const MULTICAST_ADDR = '224.0.0.114';
const PORT = 41234;
const BROADCAST_INTERVAL = 5000;
const PEER_TIMEOUT = 15000;

class LanDiscovery extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.broadcastTimer = null;
    this.peerCheckTimer = null;
    this.peers = new Map();
    this.serviceInfo = {
      webdavPort: null,
      filePort: null,
      networkDriveEnabled: false,
      capabilities: [],
      deviceId: null,
      deviceName: os.hostname()
    };
    this.instanceId = crypto.randomBytes(8).toString('hex');
  }

  getLocalIPs() {
    const ips = [];
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push(iface.address);
        }
      }
    }
    return ips;
  }

  normalizeServiceOptions(options) {
    if (options === null || typeof options === 'number' || typeof options === 'string') {
      return { webdavPort: options || null };
    }
    return options && typeof options === 'object' ? options : {};
  }

  updateService(options = {}) {
    const normalized = this.normalizeServiceOptions(options);
    for (const key of ['webdavPort', 'filePort', 'networkDriveEnabled', 'capabilities', 'deviceId', 'deviceName']) {
      if (Object.prototype.hasOwnProperty.call(normalized, key)) {
        this.serviceInfo[key] = normalized[key];
      }
    }

    this.serviceInfo.networkDriveEnabled = !!this.serviceInfo.networkDriveEnabled;
    if (!Array.isArray(this.serviceInfo.capabilities)) this.serviceInfo.capabilities = [];

    if (this.socket) this.broadcastPresence();
  }

  start(options = {}) {
    this.updateService(options);
    if (this.socket) return;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('listening', () => {
      try {
        this.socket.addMembership(MULTICAST_ADDR);
        this.socket.setMulticastTTL(128);
        this.socket.setMulticastLoopback(true);
      } catch (err) {
        console.error('LanDiscovery: Failed to configure multicast', err.message);
      }
      
      this.broadcastTimer = setInterval(() => this.broadcastPresence(), BROADCAST_INTERVAL);
      this.peerCheckTimer = setInterval(() => this.checkPeers(), 5000);
      this.broadcastPresence();
    });

    this.socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.app === 'LabSuite' && data.type === 'presence') {
          this.handlePresence(data, rinfo.address);
        }
      } catch (e) {
        // ignore invalid messages
      }
    });

    this.socket.on('error', (err) => {
      console.error('LanDiscovery socket error:', err);
      this.stop();
    });

    try {
      this.socket.bind(PORT);
    } catch (e) {
      console.error('LanDiscovery: Failed to bind port', e);
    }
  }

  broadcastPresence() {
    if (!this.socket) return;
    const msg = JSON.stringify({
      app: 'LabSuite',
      type: 'presence',
      instanceId: this.instanceId,
      hostname: os.hostname(),
      deviceId: this.serviceInfo.deviceId,
      deviceName: this.serviceInfo.deviceName,
      webdavPort: this.serviceInfo.webdavPort,
      filePort: this.serviceInfo.filePort,
      networkDriveEnabled: this.serviceInfo.networkDriveEnabled,
      capabilities: this.serviceInfo.capabilities
    });
    const buf = Buffer.from(msg);
    try {
      this.socket.send(buf, 0, buf.length, PORT, MULTICAST_ADDR);
    } catch (err) {
      // Ignore transient send errors
    }
  }

  handlePresence(data, ip) {
    if (data.instanceId === this.instanceId) return; // ignore self broadcasts
    if (data.deviceId && this.serviceInfo.deviceId && data.deviceId === this.serviceInfo.deviceId) return;
    
    const peerId = data.deviceId || data.instanceId;
    const previous = this.peers.get(peerId);
    const nextPeer = {
      id: peerId,
      instanceId: data.instanceId,
      deviceId: data.deviceId || data.instanceId,
      hostname: data.hostname,
      deviceName: data.deviceName || data.hostname || 'LabSuite PC',
      ip: ip,
      webdavPort: data.webdavPort,
      filePort: data.filePort || null,
      networkDriveEnabled: !!data.networkDriveEnabled,
      capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
      lastSeen: Date.now()
    };

    const isNew = !previous;
    const changed = isNew ||
      previous.hostname !== nextPeer.hostname ||
      previous.deviceName !== nextPeer.deviceName ||
      previous.ip !== nextPeer.ip ||
      previous.webdavPort !== nextPeer.webdavPort ||
      previous.filePort !== nextPeer.filePort ||
      previous.networkDriveEnabled !== nextPeer.networkDriveEnabled;

    this.peers.set(peerId, nextPeer);

    if (isNew) {
      this.emit('peer-discovered', this.getPeers());
    } else if (changed) {
      this.emit('peer-updated', this.getPeers());
    }
  }

  checkPeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers.entries()) {
      if (now - peer.lastSeen > PEER_TIMEOUT) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emit('peer-lost', this.getPeers());
    }
  }

  getPeers() {
    return Array.from(this.peers.values());
  }

  stop() {
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    if (this.peerCheckTimer) clearInterval(this.peerCheckTimer);
    if (this.socket) {
      try {
        this.socket.close();
      } catch(e) {}
    }
    this.socket = null;
    this.peers.clear();
  }
}

const discovery = new LanDiscovery();
module.exports = discovery;
