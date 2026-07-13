const https = require('https');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Writable } = require('stream');
const { pipeline } = require('stream/promises');
let fs;
try {
  fs = require('original-fs');
} catch (_) {
  fs = require('fs');
}

const filesystem = require('./filesystem');
const lanTrust = require('./lanTrust');
const db = require('./database');

function getDropInboxFolder() {
  const { app } = require('electron');
  let folder = db.getSetting('lan_drop_inbox_folder');
  if (!folder) {
    folder = path.join(app.getPath('downloads'), 'LabSuite Drops');
  }
  return folder;
}

function getDropSettings() {
  return {
    enabled: db.getSetting('lan_drop_enabled') !== '0', // default true
    folder: getDropInboxFolder()
  };
}

function getRecentDrops() {
  try {
    const raw = db.getSetting('lan_recent_drops');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function addRecentDrop(drop) {
  try {
    const list = getRecentDrops();
    list.unshift(drop);
    const limited = list.slice(0, 15); // limit to 15 items
    db.setSetting('lan_recent_drops', JSON.stringify(limited));
  } catch (e) {
    console.error('Failed to add recent drop:', e);
  }
}

function isPathAllowed(targetPath) {
  if (!targetPath) return false;
  try {
    const resolved = path.resolve(targetPath);
    if (filesystem.isWithinSharedPaths(resolved)) return true;
    const inbox = path.resolve(getDropInboxFolder());
    return resolved === inbox || resolved.startsWith(inbox + path.sep);
  } catch (_) {
    return false;
  }
}

const DEFAULT_PORT = 41236;
const MAX_PORT_ATTEMPTS = 20;
const DEFAULT_LIST_LIMIT = 250;
const MAX_LIST_LIMIT = 1000;

let server = null;
let activePort = null;
const pendingPairRequests = new Map();
const events = new EventEmitter();
let tlsIdentityCache = null;

function getTlsIdentity() {
  if (tlsIdentityCache) return tlsIdentityCache;
  const { app } = require('electron');
  const certDir = path.join(app.getPath('userData'), 'lan-tls');
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  fs.mkdirSync(certDir, { recursive: true });

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const selfsigned = require('selfsigned');
    const attrs = [{ name: 'commonName', value: lanTrust.ensureLocalDeviceId() }];
    const pems = selfsigned.generate(attrs, {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true }
      ]
    });
    fs.writeFileSync(keyPath, pems.private, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(certPath, pems.cert, 'utf8');
  }

  const key = fs.readFileSync(keyPath, 'utf8');
  const cert = fs.readFileSync(certPath, 'utf8');
  const fingerprint = new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();
  tlsIdentityCache = { key, cert, fingerprint };
  return tlsIdentityCache;
}

function getLocalTlsFingerprint() {
  return getTlsIdentity().fingerprint;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function getPermissionName(action) {
  if (action === 'drives' || action === 'list') return 'browse';
  if (action === 'download') return 'download';
  if (action === 'upload' || action === 'mkdir') return 'upload';
  if (action === 'delete') return 'delete';
  return 'browse';
}

function makeSignature(token, method, pathAndSearch, timestamp, nonce) {
  return crypto
    .createHmac('sha256', token)
    .update(`${method}\n${pathAndSearch}\n${timestamp}\n${nonce}`)
    .digest('hex');
}

function authorizeTrustedPeer(req, res, url, action) {
  const deviceId = String(req.headers['x-labsuite-device-id'] || '');
  const timestamp = String(req.headers['x-labsuite-timestamp'] || '');
  const nonce = String(req.headers['x-labsuite-nonce'] || '');
  const signature = String(req.headers['x-labsuite-signature'] || '');
  const trusted = lanTrust.getTrustedDevice(deviceId);

  if (!trusted) {
    sendJson(res, 401, { success: false, error: 'Pair this LabSuite device before browsing files.' });
    return null;
  }

  const permission = getPermissionName(action);
  if (!trusted.permissions || trusted.permissions[permission] !== true) {
    sendJson(res, 403, { success: false, error: `Trusted device is not allowed to ${permission}.` });
    return null;
  }

  const skewMs = Math.abs(Date.now() - Number(timestamp));
  if (!timestamp || !nonce || !signature || !Number.isFinite(skewMs) || skewMs > 5 * 60 * 1000) {
    sendJson(res, 401, { success: false, error: 'Peer request signature expired or incomplete.' });
    return null;
  }

  const expected = makeSignature(trusted.token, req.method, `${url.pathname}${url.search}`, timestamp, nonce);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    sendJson(res, 401, { success: false, error: 'Peer request signature is invalid.' });
    return null;
  }

  return trusted;
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > maxBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function makePublicPairRequest(payload, ip) {
  const requestId = String(payload.requestId || crypto.randomBytes(12).toString('hex'));
  const fromDeviceId = String(payload.deviceId || '').trim();
  const fromName = String(payload.deviceName || payload.hostname || 'LabSuite PC').trim().slice(0, 64);
  if (!fromDeviceId || !payload.pairToken) {
    throw new Error('Pair request is missing device identity.');
  }
  return {
    requestId,
    fromDeviceId,
    fromName,
    fromIp: ip,
    pairToken: String(payload.pairToken),
    tlsFingerprint: String(payload.tlsFingerprint || '').replace(/:/g, '').toLowerCase(),
    permissions: { ...lanTrust.DEFAULT_PERMISSIONS, ...(payload.permissions || {}) },
    code: lanTrust.makePairCode(requestId, fromDeviceId),
    receivedAt: new Date().toISOString()
  };
}

async function handlePairRequest(req, res) {
  const payload = await readJsonBody(req);
  const incoming = makePublicPairRequest(payload, req.socket.remoteAddress);

  const response = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingPairRequests.delete(incoming.requestId);
      resolve({ accepted: false, error: 'Pair request timed out.' });
    }, 120000);

    pendingPairRequests.set(incoming.requestId, {
      ...incoming,
      resolve,
      timeout
    });

    events.emit('pair-request', {
      requestId: incoming.requestId,
      fromDeviceId: incoming.fromDeviceId,
      fromName: incoming.fromName,
      fromIp: incoming.fromIp,
      code: incoming.code,
      receivedAt: incoming.receivedAt
    });
  });

  sendJson(res, response.accepted ? 200 : 403, {
    success: response.accepted,
    accepted: !!response.accepted,
    error: response.error || null,
    deviceId: lanTrust.ensureLocalDeviceId(),
    deviceName: lanTrust.getDeviceName(),
    permissions: response.permissions || lanTrust.DEFAULT_PERMISSIONS,
    tlsFingerprint: getLocalTlsFingerprint()
  });
}

function respondToPairRequest(requestId, accepted) {
  const pending = pendingPairRequests.get(String(requestId || ''));
  if (!pending) return { success: false, error: 'Pair request is no longer pending.' };

  clearTimeout(pending.timeout);
  pendingPairRequests.delete(pending.requestId);

  if (!accepted) {
    pending.resolve({ accepted: false, error: 'Pair request was rejected.' });
    return { success: true, accepted: false };
  }

  const trusted = lanTrust.saveTrustedDevice({
    deviceId: pending.fromDeviceId,
    name: pending.fromName,
    token: pending.pairToken,
    tlsFingerprint: pending.tlsFingerprint,
    permissions: pending.permissions,
    pairedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString()
  });

  pending.resolve({
    accepted: true,
    permissions: trusted.permissions
  });

  return { success: true, accepted: true, device: sanitizeTrustedDevice(trusted) };
}

function sanitizeTrustedDevice(device) {
  if (!device) return null;
  return {
    deviceId: device.deviceId,
    name: device.name,
    permissions: device.permissions,
    tlsFingerprint: device.tlsFingerprint || '',
    pairedAt: device.pairedAt,
    lastSeen: device.lastSeen
  };
}

function isSafeFileName(fileName) {
  const name = String(fileName || '').trim();
  return !!name && name === path.basename(name) && !/[<>:"/\\|?*\x00-\x1f]/.test(name);
}

function getAvailablePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let counter = 2;
  while (counter < 10000) {
    const candidate = path.join(dir, `${base} (${counter})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    counter += 1;
  }
  throw new Error('Could not find an available destination file name.');
}

function normalizeConflictStrategy(strategy) {
  const value = String(strategy || 'keepBoth').trim();
  return ['keepBoth', 'replace', 'skip'].includes(value) ? value : 'keepBoth';
}

function resolveDestinationPath(targetPath, strategy = 'keepBoth') {
  const conflictStrategy = normalizeConflictStrategy(strategy);
  if (!fs.existsSync(targetPath)) {
    return { path: targetPath, skipped: false, replaced: false, conflictStrategy };
  }

  if (conflictStrategy === 'skip') {
    return { path: targetPath, skipped: true, replaced: false, conflictStrategy };
  }

  if (conflictStrategy === 'replace') {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      throw new Error('Cannot replace a folder with a file.');
    }
    fs.unlinkSync(targetPath);
    return { path: targetPath, skipped: false, replaced: true, conflictStrategy };
  }

  return {
    path: getAvailablePath(targetPath),
    skipped: false,
    replaced: false,
    conflictStrategy
  };
}

function resolveDirectoryPath(targetPath, strategy = 'keepBoth') {
  const conflictStrategy = normalizeConflictStrategy(strategy);
  if (!fs.existsSync(targetPath)) {
    return { path: targetPath, skipped: false, replaced: false, conflictStrategy };
  }

  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    if (conflictStrategy === 'skip') {
      return { path: targetPath, skipped: true, replaced: false, conflictStrategy };
    }
    if (conflictStrategy === 'replace') {
      fs.unlinkSync(targetPath);
      return { path: targetPath, skipped: false, replaced: true, conflictStrategy };
    }
    return { path: getAvailablePath(targetPath), skipped: false, replaced: false, conflictStrategy };
  }

  if (conflictStrategy === 'keepBoth') {
    return { path: getAvailablePath(targetPath), skipped: false, replaced: false, conflictStrategy };
  }

  return { path: targetPath, skipped: conflictStrategy === 'skip', replaced: false, conflictStrategy };
}

function discardRequest(req) {
  return pipeline(req, new Writable({
    write(chunk, encoding, callback) {
      callback();
    }
  }));
}

function createCancelError() {
  const error = new Error('Transfer canceled.');
  error.code = 'ERR_TRANSFER_CANCELED';
  return error;
}

function getRequestUrl(req) {
  return new URL(req.url, 'https://127.0.0.1');
}

function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function parseBool(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

async function handleRequest(req, res) {
  try {
    const url = getRequestUrl(req);

    if (req.method === 'GET' && url.pathname === '/status') {
      sendJson(res, 200, {
        success: true,
        hostname: os.hostname(),
        port: activePort,
        deviceId: lanTrust.ensureLocalDeviceId(),
        deviceName: lanTrust.getDeviceName(),
        tlsFingerprint: getLocalTlsFingerprint()
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/drop/status') {
      const trusted = authorizeTrustedPeer(req, res, url, 'list');
      if (!trusted) return;
      const settings = getDropSettings();
      sendJson(res, 200, {
        success: true,
        enabled: settings.enabled,
        folder: settings.folder
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/drop/text') {
      const trusted = authorizeTrustedPeer(req, res, url, 'upload');
      if (!trusted) return;

      const settings = getDropSettings();
      if (!settings.enabled) {
        sendJson(res, 400, { success: false, error: 'Quick Drop is disabled on this device.' });
        return;
      }

      const payload = await readJsonBody(req);
      const text = String(payload.text || '');
      const deviceName = String(payload.deviceName || trusted.name || 'Peer');

      const inboxFolder = settings.folder;
      fs.mkdirSync(inboxFolder, { recursive: true });

      const cleanDevice = deviceName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
      const fileName = `Drop_from_${cleanDevice}_${timestamp}.txt`;
      const targetPath = path.join(inboxFolder, fileName);

      fs.writeFileSync(targetPath, text, 'utf8');

      addRecentDrop({
        fileName,
        type: 'text',
        size: Buffer.byteLength(text, 'utf8'),
        from: deviceName,
        timestamp: new Date().toISOString()
      });

      sendJson(res, 200, { success: true, fileName, path: targetPath });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/pair/request') {
      await handlePairRequest(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/drives') {
      if (!authorizeTrustedPeer(req, res, url, 'drives')) return;
      sendJson(res, 200, { success: true, items: await filesystem.listDrives() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/list') {
      if (!authorizeTrustedPeer(req, res, url, 'list')) return;
      const dirPath = url.searchParams.get('path') || '';
      if (!isPathAllowed(dirPath)) {
        sendJson(res, 403, { success: false, error: 'Access denied: Path is outside allowed folders.' });
        return;
      }
      sendJson(res, 200, await filesystem.listDir(dirPath, {
        offset: parsePositiveInt(url.searchParams.get('offset'), 0),
        limit: parsePositiveInt(url.searchParams.get('limit'), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
        includeStats: parseBool(url.searchParams.get('includeStats'), false),
        includeHasChildren: parseBool(url.searchParams.get('includeHasChildren'), false)
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/download') {
      if (!authorizeTrustedPeer(req, res, url, 'download')) return;
      const filePath = url.searchParams.get('path') || '';
      if (!isPathAllowed(filePath)) {
        sendJson(res, 403, { success: false, error: 'Access denied: Path is outside allowed folders.' });
        return;
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        sendJson(res, 400, { success: false, error: 'Requested path is not a file.' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': stat.size,
        'x-labsuite-filename': encodeURIComponent(path.basename(filePath))
      });
      await pipeline(fs.createReadStream(filePath), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/upload') {
      const trusted = authorizeTrustedPeer(req, res, url, 'upload');
      if (!trusted) return;
      const destDir = url.searchParams.get('destDir') || '';
      if (!isPathAllowed(destDir)) {
        sendJson(res, 403, { success: false, error: 'Access denied: Path is outside allowed folders.' });
        return;
      }
      const fileName = url.searchParams.get('fileName') || '';
      const conflictStrategy = normalizeConflictStrategy(url.searchParams.get('conflict'));
      const expectedSize = Number(req.headers['content-length']) || 0;
      if (!isSafeFileName(fileName)) {
        sendJson(res, 400, { success: false, error: 'Unsafe file name.' });
        return;
      }

      // Quick Drop uses a dedicated inbox that may not exist until the first
      // file arrives. Create only that approved destination automatically;
      // regular uploads must still target an existing shared folder.
      const resolvedDestDir = path.resolve(destDir);
      const resolvedDropInbox = path.resolve(getDropInboxFolder());
      if (resolvedDestDir === resolvedDropInbox) {
        fs.mkdirSync(resolvedDropInbox, { recursive: true });
      }
      const destStat = fs.statSync(destDir);
      if (!destStat.isDirectory()) {
        sendJson(res, 400, { success: false, error: 'Destination is not a folder.' });
        return;
      }
      const destination = resolveDestinationPath(path.join(destDir, fileName), conflictStrategy);
      if (destination.skipped) {
        await discardRequest(req);
        sendJson(res, 200, {
          success: true,
          skipped: true,
          verified: true,
          path: destination.path,
          size: fs.existsSync(destination.path) ? fs.statSync(destination.path).size : 0,
          expectedSize,
          conflictStrategy
        });
        return;
      }
      const outputPath = destination.path;
      await pipeline(req, fs.createWriteStream(outputPath));
      const writtenSize = fs.statSync(outputPath).size;
      const verified = expectedSize === 0 || writtenSize === expectedSize;

      // Treat uploads into the drop inbox as received drops
      const inboxFolder = path.resolve(getDropInboxFolder());
      const resolvedOutput = path.resolve(outputPath);
      if (resolvedOutput.startsWith(inboxFolder)) {
        addRecentDrop({
          fileName: path.basename(outputPath),
          type: 'file',
          size: writtenSize,
          from: trusted.name || 'Peer',
          timestamp: new Date().toISOString()
        });
      }

      sendJson(res, 200, {
        success: true,
        path: outputPath,
        size: writtenSize,
        expectedSize,
        verified,
        replaced: destination.replaced,
        skipped: false,
        conflictStrategy
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/mkdir') {
      if (!authorizeTrustedPeer(req, res, url, 'mkdir')) return;
      const dirPath = url.searchParams.get('path') || '';
      if (!isPathAllowed(dirPath)) {
        sendJson(res, 403, { success: false, error: 'Access denied: Path is outside allowed folders.' });
        return;
      }
      const conflictStrategy = normalizeConflictStrategy(url.searchParams.get('conflict'));
      if (!dirPath) {
        sendJson(res, 400, { success: false, error: 'Missing folder path.' });
        return;
      }
      const destination = resolveDirectoryPath(dirPath, conflictStrategy);
      if (!destination.skipped) {
        fs.mkdirSync(destination.path, { recursive: true });
      }
      sendJson(res, 200, {
        success: true,
        path: destination.path,
        skipped: destination.skipped,
        replaced: destination.replaced,
        verified: true,
        conflictStrategy
      });
      return;
    }

    sendJson(res, 404, { success: false, error: 'Unknown LAN file API route.' });
  } catch (error) {
    sendJson(res, 500, { success: false, error: error.message });
  }
}

function listenOnPort(port) {
  return new Promise((resolve, reject) => {
    const tlsIdentity = getTlsIdentity();
    const nextServer = https.createServer({
      key: tlsIdentity.key,
      cert: tlsIdentity.cert
    }, (req, res) => {
      handleRequest(req, res);
    });

    nextServer.on('error', reject);
    nextServer.listen(port, '0.0.0.0', () => {
      nextServer.removeListener('error', reject);
      resolve(nextServer);
    });
  });
}

async function start(port = DEFAULT_PORT) {
  if (server) return getStatus();

  const requestedPort = Number(port) || DEFAULT_PORT;
  let lastError = null;
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const candidatePort = requestedPort + offset;
    try {
      server = await listenOnPort(candidatePort);
      activePort = candidatePort;
      return getStatus();
    } catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') break;
    }
  }

  throw lastError || new Error('Could not start LAN file server.');
}

function stop() {
  if (server) {
    try {
      server.close();
    } catch (_) {}
  }
  server = null;
  activePort = null;
  return true;
}

function getStatus() {
  return {
    enabled: !!server,
    port: activePort,
    hostname: os.hostname(),
      deviceId: lanTrust.ensureLocalDeviceId(),
      deviceName: lanTrust.getDeviceName(),
      tlsFingerprint: getLocalTlsFingerprint(),
      transport: 'https'
  };
}

function makePeerUrl(peer, pathname, params = {}) {
  if (!peer || !peer.ip || !peer.filePort) {
    throw new Error('Peer is not advertising LabSuite file access.');
  }
  const url = new URL(`https://${peer.ip}:${peer.filePort}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

function getPairTokenForPeer(peer) {
  if (peer && peer.pairToken) return String(peer.pairToken);
  const trusted = lanTrust.getTrustedDevice(peer && peer.deviceId);
  return trusted ? trusted.token : '';
}

function getExpectedTlsFingerprint(peer) {
  const explicit = String(peer && peer.tlsFingerprint || '').replace(/:/g, '').toLowerCase();
  if (explicit) return explicit;
  const trusted = lanTrust.getTrustedDevice(peer && peer.deviceId);
  return String(trusted && trusted.tlsFingerprint || '').replace(/:/g, '').toLowerCase();
}

function getResponseTlsFingerprint(res) {
  const cert = res.socket && res.socket.getPeerCertificate(true);
  if (!cert || !cert.raw) return '';
  return crypto.createHash('sha256').update(cert.raw).digest('hex').toLowerCase();
}

function verifyPeerTlsFingerprint(res, peer) {
  const expected = getExpectedTlsFingerprint(peer);
  if (!expected) return;
  const actual = getResponseTlsFingerprint(res);
  if (!actual || actual !== expected) {
    throw new Error('Peer TLS certificate fingerprint does not match the paired device.');
  }
}

function getSignedPeerHeaders(peer, url, method) {
  if (peer && peer.skipAuth) return {};
  const token = getPairTokenForPeer(peer);
  if (!token) {
    throw new Error('Pair this LabSuite device before browsing files.');
  }
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('hex');
  return {
    'x-labsuite-device-id': lanTrust.ensureLocalDeviceId(),
    'x-labsuite-timestamp': timestamp,
    'x-labsuite-nonce': nonce,
    'x-labsuite-signature': makeSignature(token, method, `${url.pathname}${url.search}`, timestamp, nonce)
  };
}

function requestPeer(peer, pathname, params = {}, options = {}) {
  const url = makePeerUrl(peer, pathname, params);
  const method = options.method || 'GET';
  return new Promise((resolve, reject) => {
    if (options.cancelToken && options.cancelToken.cancelled) {
      reject(createCancelError());
      return;
    }

    let signedHeaders = {};
    try {
      signedHeaders = getSignedPeerHeaders(peer, url, method);
    } catch (error) {
      reject(error);
      return;
    }

    const req = https.request(url, {
      method,
      rejectUnauthorized: false,
      headers: {
        ...signedHeaders,
        ...(options.headers || {})
      }
    }, (res) => {
      try {
        verifyPeerTlsFingerprint(res, peer);
      } catch (error) {
        res.resume();
        reject(error);
        return;
      }
      if (options.streamResponse) {
        resolve(res);
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          if (res.statusCode >= 400 || parsed.success === false) {
            reject(new Error(parsed.error || `Peer request failed (${res.statusCode})`));
            return;
          }
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });

    let removeCancelHandler = null;
    if (options.cancelToken && typeof options.cancelToken.onCancel === 'function') {
      removeCancelHandler = options.cancelToken.onCancel(() => {
        req.destroy(createCancelError());
      });
    }

    req.on('error', reject);
    req.on('close', () => {
      if (removeCancelHandler) removeCancelHandler();
    });
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(new Error('Peer request timed out.'));
      });
    }
    if (options.body !== undefined) {
      req.end(options.body);
    } else if (options.bodyStream) {
      options.bodyStream.on('error', error => req.destroy(error));
      options.bodyStream.pipe(req);
    } else {
      req.end();
    }
  });
}

function getPingFailureStatus(error) {
  const code = error && error.code;
  if (['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(code)) {
    return 'blocked';
  }
  if (error && error.message === 'Timed out') return 'blocked';
  return 'offline';
}

function pingPeer(peer, timeoutMs = 2500) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let url;
    try {
      url = makePeerUrl(peer, '/status');
    } catch (error) {
      resolve({
        success: false,
        online: false,
        status: 'unreachable',
        latencyMs: null,
        checkedAt: Date.now(),
        firewallHint: false,
        error: error.message
      });
      return;
    }

    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        ...payload
      });
    };

    const req = https.get(url, { rejectUnauthorized: false }, (res) => {
      try {
        verifyPeerTlsFingerprint(res, peer);
      } catch (error) {
        res.resume();
        finish({
          success: false,
          online: false,
          status: 'blocked',
          firewallHint: true,
          error: error.message
        });
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let parsed = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch (_) {
          parsed = {};
        }

        if (res.statusCode >= 400 || parsed.success === false) {
          finish({
            success: false,
            online: false,
            status: 'blocked',
            firewallHint: true,
            error: parsed.error || `Peer health check failed (${res.statusCode}).`
          });
          return;
        }

        finish({
          success: true,
          online: true,
          status: 'online',
          firewallHint: false,
          hostname: parsed.hostname || null,
          deviceId: parsed.deviceId || null,
          deviceName: parsed.deviceName || null,
          port: parsed.port || null,
          tlsFingerprint: parsed.tlsFingerprint || getResponseTlsFingerprint(res)
        });
      });
    });

    req.setTimeout(Number(timeoutMs) || 2500, () => {
      const error = new Error('Timed out');
      error.code = 'ETIMEDOUT';
      req.destroy(error);
    });

    req.on('error', (error) => {
      finish({
        success: false,
        online: false,
        status: getPingFailureStatus(error),
        firewallHint: true,
        error: error.message || 'Could not reach this LabSuite PC.'
      });
    });
  });
}

async function listPeerDrives(peer) {
  const result = await requestPeer(peer, '/drives');
  return result.items || [];
}

async function listPeerDir(peer, dirPath, options = {}) {
  return requestPeer(peer, '/list', {
    path: dirPath,
    offset: options.offset || 0,
    limit: options.limit || DEFAULT_LIST_LIMIT,
    includeStats: options.includeStats === true ? '1' : '0',
    includeHasChildren: options.includeHasChildren === true ? '1' : '0'
  }, { timeoutMs: 20000 });
}

async function downloadPeerFile(peer, remotePath, localDestination, onProgress, options = {}) {
  const stat = fs.statSync(localDestination);
  if (!stat.isDirectory()) throw new Error('Local destination is not a folder.');
  const conflictStrategy = normalizeConflictStrategy(options.conflictStrategy);
  const preferredName = path.basename(String(remotePath || '').replace(/[\\/]+$/, '')) || 'download';
  const destination = resolveDestinationPath(path.join(localDestination, preferredName), conflictStrategy);
  if (destination.skipped) {
    const existingSize = fs.existsSync(destination.path) ? fs.statSync(destination.path).size : 0;
    return {
      success: true,
      skipped: true,
      verified: true,
      path: destination.path,
      size: existingSize,
      expectedSize: existingSize,
      conflictStrategy
    };
  }

  const response = await requestPeer(peer, '/download', { path: remotePath }, {
    streamResponse: true,
    cancelToken: options.cancelToken
  });
  if (response.statusCode >= 400) {
    let body = '';
    response.setEncoding('utf8');
    for await (const chunk of response) body += chunk;
    let message = `Download failed (${response.statusCode})`;
    try {
      message = JSON.parse(body).error || message;
    } catch (_) {}
    throw new Error(message);
  }
  const encodedName = response.headers['x-labsuite-filename'] || encodeURIComponent(path.basename(remotePath));
  const fileName = decodeURIComponent(encodedName);
  const outputPath = destination.path || getAvailablePath(path.join(localDestination, fileName));
  const bytesTotal = Number(response.headers['content-length']) || 0;
  let bytesDone = 0;
  const outputStream = fs.createWriteStream(outputPath);
  let removeCancelHandler = null;
  if (options.cancelToken && typeof options.cancelToken.onCancel === 'function') {
    removeCancelHandler = options.cancelToken.onCancel(() => {
      response.destroy(createCancelError());
      outputStream.destroy(createCancelError());
    });
  }
  if (typeof onProgress === 'function') {
    onProgress({ bytesDone, bytesTotal, fileName, path: outputPath });
    response.on('data', chunk => {
      bytesDone += chunk.length;
      onProgress({ bytesDone, bytesTotal, fileName, path: outputPath });
    });
  }
  try {
    await pipeline(response, outputStream);
  } finally {
    if (removeCancelHandler) removeCancelHandler();
  }
  const writtenSize = fs.statSync(outputPath).size;
  const verified = bytesTotal === 0 || writtenSize === bytesTotal;
  if (typeof onProgress === 'function') {
    onProgress({ bytesDone: bytesTotal || bytesDone, bytesTotal, fileName, path: outputPath, done: true, verified });
  }
  return {
    success: true,
    path: outputPath,
    size: writtenSize,
    expectedSize: bytesTotal,
    verified,
    skipped: false,
    replaced: destination.replaced,
    conflictStrategy
  };
}

async function uploadFileToPeer(peer, localPath, remoteDestinationDir, onProgress, options = {}) {
  const stat = fs.statSync(localPath);
  if (!stat.isFile()) throw new Error('Selected path is not a file.');
  const fileName = path.basename(localPath);
  const bodyStream = fs.createReadStream(localPath);
  let bytesDone = 0;
  let removeCancelHandler = null;
  if (options.cancelToken && typeof options.cancelToken.onCancel === 'function') {
    removeCancelHandler = options.cancelToken.onCancel(() => {
      bodyStream.destroy(createCancelError());
    });
  }
  if (typeof onProgress === 'function') {
    onProgress({ bytesDone, bytesTotal: stat.size, fileName, path: localPath });
    bodyStream.on('data', chunk => {
      bytesDone += chunk.length;
      onProgress({ bytesDone, bytesTotal: stat.size, fileName, path: localPath });
    });
  }
  return requestPeer(peer, '/upload', {
    destDir: remoteDestinationDir,
    fileName,
    conflict: normalizeConflictStrategy(options.conflictStrategy)
  }, {
    method: 'POST',
    headers: { 'content-length': stat.size },
    bodyStream,
    cancelToken: options.cancelToken
  }).then(result => {
    if (removeCancelHandler) removeCancelHandler();
    const verified = result.skipped || (result.verified === true && (Number(result.size) === stat.size || result.skipped));
    if (typeof onProgress === 'function') {
      onProgress({ bytesDone: stat.size, bytesTotal: stat.size, fileName, path: localPath, done: true, verified });
    }
    return { ...result, verified, expectedSize: stat.size };
  }).catch(error => {
    if (removeCancelHandler) removeCancelHandler();
    throw error;
  });
}

async function requestPair(peer) {
  const requestId = crypto.randomBytes(12).toString('hex');
  const pairToken = lanTrust.makePairToken();
  const permissions = { ...lanTrust.DEFAULT_PERMISSIONS };
  const body = JSON.stringify({
    requestId,
    pairToken,
    permissions,
    deviceId: lanTrust.ensureLocalDeviceId(),
    deviceName: lanTrust.getDeviceName(),
    hostname: os.hostname(),
    tlsFingerprint: getLocalTlsFingerprint()
  });

  const response = await requestPeer({ ...peer, skipAuth: true }, '/pair/request', {}, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    },
    body,
    timeoutMs: 125000
  });

  if (!response.accepted) {
    throw new Error(response.error || 'Pair request was rejected.');
  }

  const trusted = lanTrust.saveTrustedDevice({
    deviceId: peer.deviceId,
    name: peer.deviceName || peer.hostname || response.deviceName || 'LabSuite PC',
    token: pairToken,
    tlsFingerprint: response.tlsFingerprint || peer.tlsFingerprint || '',
    permissions: response.permissions || permissions,
    pairedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString()
  });

  return { success: true, accepted: true, device: sanitizeTrustedDevice(trusted) };
}

async function mkdirPeerDir(peer, dirPath, options = {}) {
  return requestPeer(peer, '/mkdir', {
    path: dirPath,
    conflict: normalizeConflictStrategy(options.conflictStrategy)
  }, {
    method: 'POST',
    cancelToken: options.cancelToken
  });
}

function pathLooksWindows(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || '')) || String(value || '').includes('\\');
}

function joinRemotePath(basePath, ...parts) {
  const sep = pathLooksWindows(basePath) ? '\\' : '/';
  const cleanBase = String(basePath || '').replace(/[\\/]+$/, '');
  const cleanParts = parts
    .flatMap(part => String(part || '').split(/[\\/]+/))
    .filter(Boolean);
  return [cleanBase, ...cleanParts].filter(Boolean).join(sep);
}

function relativePathFromRoot(rootPath, childPath) {
  const root = String(rootPath || '');
  const child = String(childPath || '');
  const rel = pathLooksWindows(root)
    ? path.win32.relative(root, child)
    : path.posix.relative(root, child);
  return rel.replace(/\\/g, '/');
}

function safeRelativeParts(relativePath) {
  return String(relativePath || '')
    .split(/[\\/]+/)
    .filter(part => part && part !== '.' && part !== '..');
}

function walkLocalFolder(rootPath) {
  const dirs = [];
  const files = [];

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        dirs.push({ path: fullPath, relativePath });
        walk(fullPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        files.push({ path: fullPath, relativePath, size: stat.size });
      }
    }
  }

  walk(rootPath);
  return { dirs, files };
}

async function walkRemoteFolder(peer, rootPath) {
  const dirs = [{ path: rootPath, relativePath: '' }];
  const files = [];
  const queue = [rootPath];

  while (queue.length > 0) {
    const dirPath = queue.shift();
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const result = await listPeerDir(peer, dirPath, {
        offset,
        limit: MAX_LIST_LIMIT,
        includeStats: true
      });
      for (const item of result.items || []) {
        const relativePath = relativePathFromRoot(rootPath, item.path);
        if (item.isDir) {
          dirs.push({ path: item.path, relativePath });
          queue.push(item.path);
        } else {
          files.push({ path: item.path, relativePath, size: Number(item.size) || 0 });
        }
      }
      hasMore = !!result.hasMore;
      offset += Number(result.limit) || MAX_LIST_LIMIT;
    }
  }

  return { dirs, files };
}

async function downloadPeerFolder(peer, remoteFolderPath, localDestination, onProgress, options = {}) {
  const stat = fs.statSync(localDestination);
  if (!stat.isDirectory()) throw new Error('Local destination is not a folder.');

  const conflictStrategy = normalizeConflictStrategy(options.conflictStrategy);
  const tree = await walkRemoteFolder(peer, remoteFolderPath);
  const rootName = path.basename(String(remoteFolderPath).replace(/[\\/]+$/, '')) || 'Remote Folder';
  const rootDestination = resolveDirectoryPath(path.join(localDestination, rootName), conflictStrategy);
  const targetRoot = rootDestination.path;
  if (!rootDestination.skipped) fs.mkdirSync(targetRoot, { recursive: true });

  for (const dir of tree.dirs) {
    if (!dir.relativePath) continue;
    fs.mkdirSync(path.join(targetRoot, ...safeRelativeParts(dir.relativePath)), { recursive: true });
  }

  const bytesTotal = tree.files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  let completedBytes = 0;
  let skippedFiles = 0;
  let verifiedFiles = 0;

  for (let index = 0; index < tree.files.length; index += 1) {
    if (options.cancelToken && options.cancelToken.cancelled) throw createCancelError();
    const file = tree.files[index];
    const relativeParts = safeRelativeParts(file.relativePath);
    const fileDir = path.join(targetRoot, ...relativeParts.slice(0, -1));
    fs.mkdirSync(fileDir, { recursive: true });

    const fileResult = await downloadPeerFile(peer, file.path, fileDir, progress => {
      if (typeof onProgress !== 'function') return;
      onProgress({
        direction: 'download',
        fileName: relativeParts[relativeParts.length - 1] || path.basename(file.path),
        bytesDone: completedBytes + (progress.bytesDone || 0),
        bytesTotal,
        fileIndex: index + 1,
        fileCount: tree.files.length,
        path: targetRoot
      });
    }, { conflictStrategy, cancelToken: options.cancelToken });

    if (fileResult.skipped) skippedFiles += 1;
    if (fileResult.verified) verifiedFiles += 1;
    completedBytes += Number(file.size) || 0;
  }

  if (typeof onProgress === 'function') {
    onProgress({
      direction: 'download',
      fileName: rootName,
      bytesDone: bytesTotal,
      bytesTotal,
      fileIndex: tree.files.length,
      fileCount: tree.files.length,
      path: targetRoot,
      done: true,
      verified: verifiedFiles === tree.files.length
    });
  }

  return {
    success: true,
    path: targetRoot,
    fileCount: tree.files.length,
    skippedFiles,
    verifiedFiles,
    verified: verifiedFiles === tree.files.length,
    bytes: bytesTotal,
    conflictStrategy
  };
}

async function uploadFolderToPeer(peer, localFolderPath, remoteDestinationDir, onProgress, options = {}) {
  const stat = fs.statSync(localFolderPath);
  if (!stat.isDirectory()) throw new Error('Selected path is not a folder.');

  const conflictStrategy = normalizeConflictStrategy(options.conflictStrategy);
  const rootName = path.basename(String(localFolderPath).replace(/[\\/]+$/, '')) || 'Folder';
  const requestedRemoteRoot = joinRemotePath(remoteDestinationDir, rootName);
  const tree = walkLocalFolder(localFolderPath);
  const bytesTotal = tree.files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  let completedBytes = 0;
  let skippedFiles = 0;
  let verifiedFiles = 0;

  const rootResult = await mkdirPeerDir(peer, requestedRemoteRoot, { conflictStrategy, cancelToken: options.cancelToken });
  const remoteRoot = rootResult.path || requestedRemoteRoot;
  for (const dir of tree.dirs) {
    if (options.cancelToken && options.cancelToken.cancelled) throw createCancelError();
    await mkdirPeerDir(peer, joinRemotePath(remoteRoot, ...safeRelativeParts(dir.relativePath)), {
      conflictStrategy: 'replace',
      cancelToken: options.cancelToken
    });
  }

  for (let index = 0; index < tree.files.length; index += 1) {
    if (options.cancelToken && options.cancelToken.cancelled) throw createCancelError();
    const file = tree.files[index];
    const relativeParts = safeRelativeParts(file.relativePath);
    const remoteDir = joinRemotePath(remoteRoot, ...relativeParts.slice(0, -1));

    const fileResult = await uploadFileToPeer(peer, file.path, remoteDir, progress => {
      if (typeof onProgress !== 'function') return;
      onProgress({
        direction: 'upload',
        fileName: relativeParts[relativeParts.length - 1] || path.basename(file.path),
        bytesDone: completedBytes + (progress.bytesDone || 0),
        bytesTotal,
        fileIndex: index + 1,
        fileCount: tree.files.length,
        path: localFolderPath
      });
    }, { conflictStrategy, cancelToken: options.cancelToken });

    if (fileResult.skipped) skippedFiles += 1;
    if (fileResult.verified) verifiedFiles += 1;
    completedBytes += Number(file.size) || 0;
  }

  if (typeof onProgress === 'function') {
    onProgress({
      direction: 'upload',
      fileName: rootName,
      bytesDone: bytesTotal,
      bytesTotal,
      fileIndex: tree.files.length,
      fileCount: tree.files.length,
      path: localFolderPath,
      done: true,
      verified: verifiedFiles === tree.files.length
    });
  }

  return {
    success: true,
    path: remoteRoot,
    fileCount: tree.files.length,
    skippedFiles,
    verifiedFiles,
    verified: verifiedFiles === tree.files.length,
    bytes: bytesTotal,
    conflictStrategy
  };
}

async function movePeerPathToLocal(peer, remotePath, isDirectory, localDestination, onProgress, options = {}) {
  const result = isDirectory
    ? await downloadPeerFolder(peer, remotePath, localDestination, onProgress, options)
    : await downloadPeerFile(peer, remotePath, localDestination, onProgress, options);
  return { ...result, copied: true, sourceRetained: true };
}

async function moveLocalPathToPeer(peer, localPath, isDirectory, remoteDestinationDir, onProgress, options = {}) {
  const result = isDirectory
    ? await uploadFolderToPeer(peer, localPath, remoteDestinationDir, onProgress, options)
    : await uploadFileToPeer(peer, localPath, remoteDestinationDir, onProgress, options);
  return { ...result, copied: true, sourceRetained: true };
}

async function checkDropStatus(peer) {
  return requestPeer(peer, '/drop/status');
}

async function sendDropText(peer, text) {
  const body = JSON.stringify({
    text,
    deviceName: lanTrust.getDeviceName()
  });
  return requestPeer(peer, '/drop/text', {}, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    },
    body
  });
}

module.exports = {
  start,
  stop,
  getStatus,
  requestPair,
  respondToPairRequest,
  onPairRequest: listener => events.on('pair-request', listener),
  offPairRequest: listener => events.off('pair-request', listener),
  sanitizeTrustedDevice,
  pingPeer,
  listPeerDrives,
  listPeerDir,
  downloadPeerFile,
  downloadPeerFolder,
  uploadFileToPeer,
  uploadFolderToPeer,
  movePeerPathToLocal,
  moveLocalPathToPeer,
  mkdirPeerDir,
  checkDropStatus,
  sendDropText,
  getDropSettings,
  getRecentDrops,
  addRecentDrop
};
