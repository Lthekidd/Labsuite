const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn: nodeSpawn } = require('child_process');
const { createVmProtectV2Protocol } = require('./vmProtectV2');

let nativeFs;
try {
  nativeFs = require('original-fs');
} catch (_) {
  nativeFs = require('fs');
}

const DEFAULT_PORT = 41238;
const DEFAULT_ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_BULK_ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SINGLE_ENROLLMENT_TTL_MS = 60 * 60 * 1000;
const MAX_BULK_ENROLLMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BULK_ENROLLMENT_GUESTS = 10000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MAX_FILE_BYTES = 100 * 1024 * 1024 * 1024;
const DEFAULT_GUEST_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_GUEST_QUOTA_BYTES = 500 * 1024 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const MAX_ACTIVE_UPLOADS = 4;
const MAX_JSON_BODY_BYTES = 128 * 1024;
const NONCE_CACHE_LIMIT = 20000;
const GUESTS_SETTING = 'vm_protect_guests';
const MAX_BYTES_SETTING = 'vm_protect_max_file_bytes';
const GUEST_QUOTA_SETTING = 'vm_protect_guest_quota_bytes';
const EMPTY_SHA256 = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

function getPathAndQuery(url) {
  return `${url.pathname}${url.search}`;
}

function buildCanonicalRequest(method, pathAndQuery, timestamp, nonce, contentLength, contentSha256) {
  return [
    String(method || '').toUpperCase(),
    String(pathAndQuery || ''),
    String(timestamp || ''),
    String(nonce || ''),
    String(contentLength),
    String(contentSha256 || '').toLowerCase()
  ].join('\n');
}

function makeSignature(token, method, pathAndQuery, timestamp, nonce, contentLength, contentSha256) {
  return crypto
    .createHmac('sha256', String(token || ''))
    .update(buildCanonicalRequest(method, pathAndQuery, timestamp, nonce, contentLength, contentSha256))
    .digest('hex');
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeGuestAbsolutePath(input) {
  const original = String(input || '').trim();
  if (!original || original.length > 32767 || original.includes('\0')) {
    throw new Error('A valid Windows guest file path is required.');
  }

  const windowsPath = original.replace(/\//g, '\\');
  if (/^\\\\[?.]\\/.test(windowsPath)) {
    throw new Error('Windows device paths are not accepted.');
  }

  let rootLabel;
  let segments;
  const driveMatch = /^([A-Za-z]):\\(.+)$/.exec(windowsPath);
  if (driveMatch) {
    rootLabel = driveMatch[1].toUpperCase();
    segments = driveMatch[2].split(/\\+/);
  } else {
    const uncMatch = /^\\\\([^\\]+)\\([^\\]+)\\(.+)$/.exec(windowsPath);
    if (!uncMatch) {
      throw new Error('The guest file path must be an absolute drive or UNC path.');
    }
    rootLabel = '_UNC';
    segments = [uncMatch[1], uncMatch[2], ...uncMatch[3].split(/\\+/)];
  }

  if (!segments.length || segments.some(segment => (
    !segment || segment === '.' || segment === '..' || /[:*?"<>|]/.test(segment)
      || /[. ]$/.test(segment) || /[\u0000-\u001f]/.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  ))) {
    throw new Error('The guest file path contains an unsafe Windows path segment.');
  }

  const normalizedGuestPath = driveMatch
    ? `${driveMatch[1].toUpperCase()}:\\${segments.join('\\')}`
    : `\\\\${segments.join('\\')}`;
  const basename = segments[segments.length - 1];
  const safeBasename = makeSafeBasename(basename);
  const pathHash = crypto.createHash('sha256').update(normalizedGuestPath.toLowerCase(), 'utf8').digest('hex');
  return {
    normalizedGuestPath,
    rootLabel,
    basename,
    relativePath: path.join(rootLabel, ...segments),
    fallbackRelativePath: path.join(rootLabel, '_long-paths', pathHash.slice(0, 2), `${pathHash}-${safeBasename}`)
  };
}

function makeSafeBasename(name) {
  let safe = String(name || '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 96);
  if (!safe) safe = 'guest-file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  return safe;
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveStagingTarget(stagingRoot, guestId, guestPath) {
  const safeGuestId = String(guestId || '');
  if (!/^[a-f0-9-]{16,64}$/i.test(safeGuestId)) {
    throw new Error('Invalid VM Protect guest identifier.');
  }
  const normalized = normalizeGuestAbsolutePath(guestPath);
  const guestRoot = path.resolve(stagingRoot, safeGuestId);
  let destinationPath = path.resolve(guestRoot, normalized.relativePath);
  let usedFallback = false;
  // Keep the normal guest tree readable. Only flatten exceptionally long paths, which
  // otherwise fail on Windows installations without long-path support.
  if (destinationPath.length >= 240) {
    destinationPath = path.resolve(guestRoot, normalized.fallbackRelativePath);
    usedFallback = true;
  }
  if (!isPathInside(guestRoot, destinationPath)) {
    throw new Error('Guest path escaped its managed staging directory.');
  }
  return { ...normalized, guestRoot, destinationPath, usedFallback };
}

function parseStoredGuests(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    const ids = new Set();
    const tokens = new Set();
    return parsed.filter(item => {
      if (!item || typeof item !== 'object') return false;
      const id = String(item.id || '');
      const token = String(item.token || '');
      if (!/^[a-f0-9-]{16,64}$/i.test(id) || token.length < 32 || ids.has(id) || tokens.has(token)) return false;
      ids.add(id);
      tokens.add(token);
      return true;
    }).map(item => ({
      id: String(item.id),
      token: String(item.token),
      name: cleanLabel(item.name, 'Windows VM'),
      machineName: cleanLabel(item.machineName, ''),
      vmId: cleanMetadata(item.vmId, 256),
      vmxPath: cleanMetadata(item.vmxPath, 32767),
      vmwareUuid: cleanMetadata(item.vmwareUuid, 256),
      status: item.status === 'online' ? 'online' : 'offline',
      createdAt: validIso(item.createdAt) || new Date().toISOString(),
      lastSeen: validIso(item.lastSeen),
      lastUploadAt: validIso(item.lastUploadAt),
      lastUploadBytes: Number.isFinite(Number(item.lastUploadBytes)) ? Number(item.lastUploadBytes) : 0,
      stagingBytes: Number.isSafeInteger(Number(item.stagingBytes)) && Number(item.stagingBytes) >= 0 ? Number(item.stagingBytes) : 0,
      selectedFiles: normalizeSelectedFiles(item.selectedFiles),
      protocolVersion: Number(item.protocolVersion) >= 2 ? 2 : 1,
      policy: item.policy && typeof item.policy === 'object' ? item.policy : {},
      rootCount: Math.max(0, Math.min(Number(item.rootCount) || 0, 200)),
      manifestFileCount: Math.max(0, Number(item.manifestFileCount) || 0),
      pendingFiles: Math.max(0, Number(item.pendingFiles) || 0),
      pendingBytes: Math.max(0, Number(item.pendingBytes) || 0),
      lastCommitAt: validIso(item.lastCommitAt),
      lastError: cleanMetadata(item.lastError, 1000)
    }));
  } catch (_) {
    return [];
  }
}

function cleanLabel(value, fallback) {
  const cleaned = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return cleaned || fallback;
}

function cleanMetadata(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function validIso(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function normalizeSelectedFiles(files) {
  if (!Array.isArray(files)) return [];
  const output = [];
  const seen = new Set();
  for (const file of files.slice(0, 1000)) {
    try {
      const normalized = normalizeGuestAbsolutePath(file).normalizedGuestPath;
      const key = normalized.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        output.push(normalized);
      }
    } catch (_) {}
  }
  return output;
}

function normalizeAgentRoots(roots) {
  if (!Array.isArray(roots)) return [];
  const output = [];
  const seen = new Set();
  for (const root of roots.slice(0, 200)) {
    if (!root || typeof root !== 'object') continue;
    const id = String(root.id || '').toLowerCase();
    if (!/^root-[a-f0-9]{8,64}$/.test(id) || seen.has(id)) continue;
    try {
      const normalizedPath = normalizeGuestAbsolutePath(root.path).normalizedGuestPath;
      seen.add(id);
      output.push({
        id,
        path: normalizedPath,
        type: root.type === 'file' ? 'file' : 'folder',
        recursive: root.type === 'file' ? false : root.recursive !== false
      });
    } catch (_) {}
  }
  return output;
}

function publicGuest(guest, now = Date.now()) {
  const lastSeenMs = Date.parse(guest.lastSeen || '');
  const online = guest.status === 'online' && Number.isFinite(lastSeenMs) && now - lastSeenMs <= ONLINE_WINDOW_MS;
  return {
    id: guest.id,
    name: guest.name,
    machineName: guest.machineName,
    vmId: guest.vmId || '',
    vmxPath: guest.vmxPath || '',
    vmwareUuid: guest.vmwareUuid || '',
    status: online ? 'online' : 'offline',
    createdAt: guest.createdAt,
    lastSeen: guest.lastSeen || '',
    lastUploadAt: guest.lastUploadAt || '',
    lastUploadBytes: guest.lastUploadBytes || 0,
    stagingBytes: guest.stagingBytes || 0,
    selectedFiles: [...guest.selectedFiles],
    protocolVersion: Number(guest.protocolVersion) >= 2 ? 2 : 1,
    rootCount: Number(guest.rootCount) || 0,
    manifestFileCount: Number(guest.manifestFileCount) || 0,
    pendingFiles: Number(guest.pendingFiles) || 0,
    pendingBytes: Number(guest.pendingBytes) || 0,
    lastCommitAt: guest.lastCommitAt || '',
    lastError: guest.lastError || '',
    policy: guest.policy && typeof guest.policy === 'object'
      ? { roots: Array.isArray(guest.policy.roots) ? guest.policy.roots.map(root => ({ ...root })) : [], excludePatterns: Array.isArray(guest.policy.excludePatterns) ? [...guest.policy.excludePatterns] : [] }
      : { roots: [], excludePatterns: [] }
  };
}

function listCandidateAddresses(networkInterfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [interfaceName, entries] of Object.entries(networkInterfaces || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== 'IPv4' || !entry.address) continue;
      let priority = 50;
      if (/vmware.*vmnet1|vmnet1.*vmware/i.test(interfaceName)) priority = 0;
      else if (/vmware.*vmnet8|vmnet8.*vmware/i.test(interfaceName)) priority = 5;
      else if (/vmware|vmnet/i.test(interfaceName)) priority = 10;
      else if (/ethernet|wi-?fi|wireless/i.test(interfaceName)) priority = 20;
      candidates.push({ address: entry.address, interfaceName, priority });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || a.interfaceName.localeCompare(b.interfaceName));
  const seen = new Set();
  return candidates.filter(candidate => {
    if (seen.has(candidate.address)) return false;
    seen.add(candidate.address);
    return true;
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error('JSON request body is too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (_) {
        reject(Object.assign(new Error('Request body is not valid JSON.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('Request was aborted.'), { statusCode: 400 })));
  });
}

function normalizeHosts(options, candidateAddresses) {
  const requested = [];
  if (Array.isArray(options.serverUrls)) requested.push(...options.serverUrls);
  if (Array.isArray(options.hosts)) requested.push(...options.hosts);
  if (options.host) requested.push(options.host);
  if (!requested.length) requested.push(...candidateAddresses.map(item => item.address));
  if (!requested.length) requested.push('127.0.0.1');
  return requested;
}

function formatServerUrl(hostOrUrl, port) {
  const raw = String(hostOrUrl || '').trim();
  if (!raw) return '';
  if (/^https:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') throw new Error('VM Protect helpers require HTTPS.');
    if (!parsed.port) parsed.port = String(port);
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  }
  const host = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw;
  return `https://${host}:${port}`;
}

function findVmrunCandidates() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const candidates = [];
  if (process.env.VMWARE_VMRUN) candidates.push(process.env.VMWARE_VMRUN);
  for (const root of roots) {
    candidates.push(path.join(root, 'VMware', 'VMware Workstation', 'vmrun.exe'));
    candidates.push(path.join(root, 'VMware', 'VMware VIX', 'vmrun.exe'));
  }
  return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
}

function createVmProtectService(dependencies = {}) {
  const fs = dependencies.fs || nativeFs;
  const httpsModule = dependencies.https || https;
  const spawn = dependencies.spawn || nodeSpawn;
  const now = dependencies.now || (() => Date.now());
  const networkInterfaces = dependencies.networkInterfaces || (() => os.networkInterfaces());
  const events = new EventEmitter();
  events.setMaxListeners(50);

  let server = null;
  let activePort = null;
  let tlsIdentity = null;
  let guests = null;
  let activeUploads = 0;
  let v2Protocol = null;
  const activeGuestUploads = new Set();
  const enrollments = new Map();
  const usedNonces = new Map();
  const lastSeenPersistedAt = new Map();

  function getDb() {
    return dependencies.db || require('./database');
  }

  function getUserDataDir() {
    if (dependencies.userDataDir) return path.resolve(dependencies.userDataDir);
    const electronApp = dependencies.app || require('electron').app;
    return electronApp.getPath('userData');
  }

  function getStagingRoot() {
    return path.join(getUserDataDir(), 'vm-protect-staging');
  }

  function getV2StagingRoot() {
    return path.join(getUserDataDir(), 'vm-protect-staging-v2');
  }

  function getV2MetadataRoot() {
    return path.join(getUserDataDir(), 'vm-protect-v2-meta');
  }

  function loadGuests() {
    if (!guests) {
      guests = parseStoredGuests(getDb().getSetting(GUESTS_SETTING));
      guests.forEach(guest => lastSeenPersistedAt.set(guest.id, Date.parse(guest.lastSeen || '') || 0));
    }
    return guests;
  }

  function persistGuests() {
    getDb().setSetting(GUESTS_SETTING, JSON.stringify(loadGuests()));
  }

  function safeEmit(eventName, payload) {
    try {
      events.emit(eventName, payload);
    } catch (error) {
      console.error(`VM Protect ${eventName} event listener failed:`, error);
    }
  }

  function emitState() {
    safeEmit('state', getState());
  }

  function getV2Protocol() {
    if (v2Protocol) return v2Protocol;
    v2Protocol = createVmProtectV2Protocol({
      fs,
      now,
      getStagingRoot: getV2StagingRoot,
      getMetadataRoot: getV2MetadataRoot,
      authenticate,
      getMaxFileBytes,
      getGuestQuotaBytes,
      emptySha256: EMPTY_SHA256,
      sendJson,
      touchGuest,
      publicGuest: guest => publicGuest(guest, now()),
      safeEmit,
      emitState,
      atomicReplace
    });
    return v2Protocol;
  }

  function getTlsIdentity() {
    if (tlsIdentity) return tlsIdentity;
    const certDir = path.join(getUserDataDir(), 'vm-protect-tls');
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });

    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      // A certificate without its matching private key is unusable. Remove only this
      // incomplete identity pair before creating a fresh atomic pair.
      try { fs.unlinkSync(keyPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { fs.unlinkSync(certPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const selfsigned = dependencies.selfsigned || require('selfsigned');
      const pems = selfsigned.generate([{ name: 'commonName', value: `LabSuite VM Protect ${os.hostname()}` }], {
        days: 3650,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true }
        ]
      });
      const keyTemp = `${keyPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      const certTemp = `${certPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(keyTemp, pems.private, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.writeFileSync(certTemp, pems.cert, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(keyTemp, keyPath);
      fs.renameSync(certTemp, certPath);
    }

    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');
    const fingerprint = new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();
    tlsIdentity = { key, cert, fingerprint, keyPath, certPath };
    return tlsIdentity;
  }

  function getMaxFileBytes() {
    const configured = dependencies.maxFileBytes !== undefined
      ? Number(dependencies.maxFileBytes)
      : Number(getDb().getSetting(MAX_BYTES_SETTING));
    if (!Number.isSafeInteger(configured) || configured < 1024 * 1024) return DEFAULT_MAX_FILE_BYTES;
    return Math.min(configured, MAX_MAX_FILE_BYTES);
  }

  function getGuestQuotaBytes() {
    const configured = dependencies.guestQuotaBytes !== undefined
      ? Number(dependencies.guestQuotaBytes)
      : Number(getDb().getSetting(GUEST_QUOTA_SETTING));
    if (!Number.isSafeInteger(configured) || configured < 100 * 1024 * 1024) return DEFAULT_GUEST_QUOTA_BYTES;
    return Math.min(configured, MAX_GUEST_QUOTA_BYTES);
  }

  function cleanupTransientCaches() {
    const current = now();
    for (const [id, enrollment] of enrollments) {
      if (enrollment.expiresAtMs <= current || (enrollment.consumed && !enrollment.multiUse)) enrollments.delete(id);
    }
    for (const [key, expiresAt] of usedNonces) {
      if (expiresAt <= current) usedNonces.delete(key);
    }
    if (usedNonces.size > NONCE_CACHE_LIMIT) {
      const overflow = usedNonces.size - NONCE_CACHE_LIMIT;
      let removed = 0;
      for (const key of usedNonces.keys()) {
        usedNonces.delete(key);
        removed += 1;
        if (removed >= overflow) break;
      }
    }
  }

  function touchGuest(guest, forcePersist = false) {
    const current = now();
    const previousPersisted = lastSeenPersistedAt.get(guest.id) || 0;
    guest.status = 'online';
    guest.lastSeen = new Date(current).toISOString();
    if (forcePersist || current - previousPersisted >= 60 * 1000) {
      persistGuests();
      lastSeenPersistedAt.set(guest.id, current);
    }
  }

  function authenticate(req, url, canonicalPathAndQuery = getPathAndQuery(url)) {
    cleanupTransientCaches();
    const guestId = String(req.headers['x-labsuite-guest-id'] || '');
    const timestamp = String(req.headers['x-labsuite-timestamp'] || '');
    const nonce = String(req.headers['x-labsuite-nonce'] || '');
    const signature = String(req.headers['x-labsuite-signature'] || '').toLowerCase();
    const contentSha256 = String(req.headers['x-content-sha256'] || '').toLowerCase();
    const contentLengthHeader = req.headers['content-length'];
    const contentLength = contentLengthHeader === undefined && req.method === 'GET'
      ? 0
      : Number(contentLengthHeader);
    const guest = loadGuests().find(item => item.id === guestId);

    if (!guest) throw Object.assign(new Error('Unknown or forgotten VM Protect guest.'), { statusCode: 401 });
    if (!/^\d{10,17}$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > MAX_CLOCK_SKEW_MS) {
      throw Object.assign(new Error('Request signature is expired or incomplete.'), { statusCode: 401 });
    }
    if (!/^[a-f0-9]{24,128}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)
      || !/^[a-f0-9]{64}$/i.test(contentSha256)) {
      throw Object.assign(new Error('Request signature headers are incomplete.'), { statusCode: 401 });
    }
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw Object.assign(new Error('A valid Content-Length header is required.'), { statusCode: 411 });
    }
    if (req.headers['transfer-encoding']) {
      throw Object.assign(new Error('Chunked request bodies are not accepted.'), { statusCode: 400 });
    }

    const expected = makeSignature(
      guest.token,
      req.method,
      canonicalPathAndQuery,
      timestamp,
      nonce,
      contentLength,
      contentSha256
    );
    if (!timingSafeStringEqual(expected, signature)) {
      throw Object.assign(new Error('Request signature is invalid.'), { statusCode: 401 });
    }
    const nonceKey = `${guest.id}:${nonce.toLowerCase()}`;
    if (usedNonces.has(nonceKey)) {
      throw Object.assign(new Error('Request nonce has already been used.'), { statusCode: 409 });
    }
    usedNonces.set(nonceKey, now() + MAX_CLOCK_SKEW_MS);
    return { guest, contentLength, contentSha256 };
  }

  async function handleEnrollment(req, res, options = {}) {
    const protocolVersion = options.protocolVersion === 2 ? 2 : 1;
    const body = await readJsonBody(req);
    cleanupTransientCaches();
    const id = String(body.enrollmentId || '');
    const secret = String(body.secret || '');
    const enrollment = enrollments.get(id);
    if (!enrollment || enrollment.expiresAtMs <= now() || (enrollment.consumed && !enrollment.multiUse)) {
      sendJson(res, 401, { success: false, error: 'Enrollment is invalid, expired, or already used.' });
      return;
    }
    if (!timingSafeStringEqual(enrollment.secret, secret)) {
      enrollment.failedAttempts = (enrollment.failedAttempts || 0) + 1;
      if (enrollment.failedAttempts >= 10) enrollments.delete(id);
      sendJson(res, 401, { success: false, error: 'Enrollment secret is invalid.' });
      return;
    }

    if (enrollment.state === 'rejected') {
      // A 200 response lets Windows PowerShell 5 read the structured rejection without
      // losing it behind Invoke-RestMethod's generic WebException handling.
      sendJson(res, 200, { success: false, rejected: true, error: 'The LabSuite host rejected this VM pairing request.' });
      enrollments.delete(id);
      emitState();
      return;
    }

    const request = {
      name: cleanLabel(body.name || enrollment.name, 'Windows VM'),
      machineName: cleanLabel(body.machineName, ''),
      selectedFiles: normalizeSelectedFiles(body.selectedFiles || enrollment.selectedFiles),
      roots: protocolVersion === 2 ? normalizeAgentRoots(body.roots || enrollment.roots) : []
    };

    const issueGuest = () => {
      if (enrollment.multiUse) {
        const maxGuests = Math.max(1, Math.min(Number(enrollment.maxGuests) || MAX_BULK_ENROLLMENT_GUESTS, MAX_BULK_ENROLLMENT_GUESTS));
        if (Number(enrollment.createdGuests || 0) >= maxGuests) {
          throw Object.assign(new Error('This bulk VM Protect helper has reached its VM limit.'), { statusCode: 403 });
        }
      } else {
        enrollment.consumed = true;
      }
      const source = enrollment.multiUse ? request : (enrollment.request || request);
      const guest = {
        id: crypto.randomUUID(),
        token: crypto.randomBytes(32).toString('base64url'),
        name: cleanLabel(source.name || enrollment.name, 'Windows VM'),
        machineName: cleanLabel(source.machineName, ''),
        vmId: enrollment.vmId,
        vmxPath: enrollment.vmxPath,
        vmwareUuid: enrollment.vmwareUuid,
        status: 'online',
        createdAt: new Date(now()).toISOString(),
        lastSeen: new Date(now()).toISOString(),
        lastUploadAt: '',
        lastUploadBytes: 0,
        stagingBytes: 0,
        selectedFiles: protocolVersion === 2
          ? source.roots.map(root => root.path)
          : normalizeSelectedFiles(source.selectedFiles || enrollment.selectedFiles),
        protocolVersion,
        policy: protocolVersion === 2 ? { roots: source.roots, excludePatterns: [] } : {},
        rootCount: protocolVersion === 2 ? source.roots.length : 0,
        manifestFileCount: 0,
        pendingFiles: 0,
        pendingBytes: 0,
        lastCommitAt: '',
        lastError: ''
      };
      try {
        loadGuests().push(guest);
        persistGuests();
        lastSeenPersistedAt.set(guest.id, now());
        if (enrollment.multiUse) {
          enrollment.createdGuests = Number(enrollment.createdGuests || 0) + 1;
          enrollment.lastGuestAt = new Date(now()).toISOString();
          enrollment.request = request;
        } else {
          enrollments.delete(id);
        }
        return guest;
      } catch (error) {
        const index = loadGuests().indexOf(guest);
        if (index >= 0) loadGuests().splice(index, 1);
        if (!enrollment.multiUse) enrollment.consumed = false;
        throw error;
      }
    };

    const sendGuest = guest => {
      emitState();
      sendJson(res, 200, {
        success: true,
        serverTimeMs: now(),
        guestId: guest.id,
        token: guest.token,
        guest: {
          id: guest.id,
          name: guest.name,
          status: 'online',
          selectedFiles: [...guest.selectedFiles],
          protocolVersion: guest.protocolVersion,
          policy: guest.policy
        },
        protocolVersion,
        policy: protocolVersion === 2 ? guest.policy : undefined,
        maxFileBytes: getMaxFileBytes(),
        guestQuotaBytes: getGuestQuotaBytes(),
        smallFileBundleBytes: protocolVersion === 2 ? getV2Protocol().constants.SMALL_FILE_BUNDLE_BYTES : undefined,
        chunkBytes: protocolVersion === 2 ? getV2Protocol().constants.CHUNK_BYTES : undefined,
        maxParallelUploads: protocolVersion === 2 ? getV2Protocol().constants.MAX_PARALLEL_UPLOADS : undefined
      });
    };

    if (enrollment.autoApprove) {
      if (enrollment.state === 'invited') {
        enrollment.state = 'approved';
        enrollment.approvedAt = new Date(now()).toISOString();
      }
      sendGuest(issueGuest());
      return;
    }

    if (enrollment.state === 'invited') {
      enrollment.state = 'pending';
      enrollment.requestedAt = new Date(now()).toISOString();
      enrollment.request = request;
      emitState();
      sendJson(res, 202, {
        success: true,
        serverTimeMs: now(),
        pending: true,
        pairingCode: enrollment.pairingCode,
        expiresAt: enrollment.expiresAt,
        retryAfterSeconds: 2
      });
      return;
    }

    if (enrollment.state !== 'approved') {
      sendJson(res, 202, {
        success: true,
        serverTimeMs: now(),
        pending: true,
        pairingCode: enrollment.pairingCode,
        expiresAt: enrollment.expiresAt,
        retryAfterSeconds: 2
      });
      return;
    }

    sendGuest(issueGuest());
  }

  async function atomicReplace(tempPath, destinationPath) {
    try {
      await fs.promises.rename(tempPath, destinationPath);
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code) || !fs.existsSync(destinationPath)) throw error;
    }
    const displacedPath = `${tempPath}.previous`;
    await fs.promises.rename(destinationPath, displacedPath);
    try {
      await fs.promises.rename(tempPath, destinationPath);
      await fs.promises.unlink(displacedPath).catch(() => {});
    } catch (error) {
      await fs.promises.rename(displacedPath, destinationPath).catch(() => {});
      throw error;
    }
  }

  async function createImmutableRevision(target, sha256) {
    const sourceRelativePath = target.usedFallback ? target.fallbackRelativePath : target.relativePath;
    const extension = path.extname(target.basename || '');
    const stamp = new Date(now()).toISOString().replace(/[-:.TZ]/g, '');
    let revisionDirectory = path.resolve(
      target.guestRoot,
      '_LabSuite Received Versions',
      path.dirname(sourceRelativePath),
      path.basename(sourceRelativePath)
    );
    if (revisionDirectory.length >= 210) {
      const pathKey = crypto.createHash('sha256').update(target.normalizedGuestPath.toLowerCase()).digest('hex');
      revisionDirectory = path.resolve(target.guestRoot, '_LabSuite Received Versions', '_long', pathKey.slice(0, 24));
    }
    const revisionPath = path.resolve(
      revisionDirectory,
      `${stamp}-${sha256.slice(0, 16)}-${crypto.randomBytes(4).toString('hex')}${extension}`
    );
    if (!isPathInside(target.guestRoot, revisionPath)) {
      throw new Error('VM Protect revision path escaped its managed staging directory.');
    }
    await fs.promises.mkdir(revisionDirectory, { recursive: true });
    try {
      await fs.promises.link(target.destinationPath, revisionPath);
    } catch (_) {
      const tempRevision = `${revisionPath}.${process.pid}.tmp`;
      try {
        await fs.promises.copyFile(target.destinationPath, tempRevision, fs.constants.COPYFILE_EXCL);
        await fs.promises.rename(tempRevision, revisionPath);
      } finally {
        await fs.promises.unlink(tempRevision).catch(() => {});
      }
    }
    return revisionPath;
  }

  async function receiveUpload(req, auth, target) {
    const maxFileBytes = getMaxFileBytes();
    if (auth.contentLength > maxFileBytes) {
      throw Object.assign(new Error(`File exceeds the VM Protect limit of ${maxFileBytes} bytes.`), { statusCode: 413 });
    }
    await fs.promises.mkdir(path.dirname(target.destinationPath), { recursive: true });
    const tempDirectory = path.join(getStagingRoot(), '.tmp', auth.guest.id);
    await fs.promises.mkdir(tempDirectory, { recursive: true });
    const tempPath = path.join(tempDirectory, `${process.pid}-${crypto.randomBytes(16).toString('hex')}.upload`);
    const hash = crypto.createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > auth.contentLength || received > maxFileBytes) {
          callback(Object.assign(new Error('Upload body exceeds its declared or allowed size.'), { statusCode: 413 }));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      }
    });

    try {
      await pipeline(req, meter, fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
      if (received !== auth.contentLength) {
        throw Object.assign(new Error('Upload body length does not match Content-Length.'), { statusCode: 400 });
      }
      const actualSha256 = hash.digest('hex');
      if (!timingSafeStringEqual(actualSha256, auth.contentSha256)) {
        throw Object.assign(new Error('Upload SHA-256 verification failed.'), { statusCode: 422 });
      }
      await atomicReplace(tempPath, target.destinationPath);
      const revisionPath = await createImmutableRevision(target, actualSha256);
      return { bytes: received, sha256: actualSha256, revisionPath };
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async function handleUpload(req, res, url) {
    if (activeUploads >= (Number(dependencies.maxActiveUploads) || MAX_ACTIVE_UPLOADS)) {
      sendJson(res, 503, { success: false, error: 'VM Protect is busy; retry this upload shortly.' }, { 'retry-after': '5' });
      req.resume();
      return;
    }
    const encodedGuestPath = String(req.headers['x-labsuite-file-path-base64'] || '');
    let guestPath = '';
    let canonicalPathAndQuery = getPathAndQuery(url);
    if (encodedGuestPath) {
      if (!/^[A-Za-z0-9_-]{1,65536}$/.test(encodedGuestPath)) {
        throw Object.assign(new Error('The encoded guest file path header is invalid.'), { statusCode: 400 });
      }
      const decoded = Buffer.from(encodedGuestPath, 'base64url');
      if (decoded.toString('base64url') !== encodedGuestPath) {
        throw Object.assign(new Error('The encoded guest file path header is malformed.'), { statusCode: 400 });
      }
      guestPath = decoded.toString('utf8');
      canonicalPathAndQuery = `/upload?path64=${encodedGuestPath}`;
    } else {
      guestPath = url.searchParams.get('path') || String(req.headers['x-labsuite-file-path'] || '');
    }
    const auth = authenticate(req, url, canonicalPathAndQuery);
    const target = resolveStagingTarget(getStagingRoot(), auth.guest.id, guestPath);
    const fileKey = target.normalizedGuestPath.toLowerCase();
    if (!auth.guest.selectedFiles.some(item => item.toLowerCase() === fileKey)) {
      req.resume();
      throw Object.assign(new Error('This path was not approved during VM pairing.'), { statusCode: 403 });
    }
    if (activeGuestUploads.has(auth.guest.id)) {
      req.resume();
      throw Object.assign(new Error('Another upload from this VM is still active; retry shortly.'), { statusCode: 409 });
    }
    const quota = getGuestQuotaBytes();
    const conservativeAdditionalBytes = auth.contentLength * 2;
    if ((Number(auth.guest.stagingBytes) || 0) + conservativeAdditionalBytes > quota) {
      req.resume();
      throw Object.assign(new Error(`This VM reached its ${quota}-byte protected staging quota.`), { statusCode: 507 });
    }
    activeGuestUploads.add(auth.guest.id);
    activeUploads += 1;
    try {
      const result = await receiveUpload(req, auth, target);
      auth.guest.stagingBytes = (Number(auth.guest.stagingBytes) || 0) + conservativeAdditionalBytes;
      auth.guest.lastUploadAt = new Date(now()).toISOString();
      auth.guest.lastUploadBytes = result.bytes;
      touchGuest(auth.guest, true);
      const upload = {
        guest: publicGuest(auth.guest, now()),
        guestPath: target.normalizedGuestPath,
        stagingPath: target.destinationPath,
        revisionPath: result.revisionPath,
        relativePath: path.relative(getStagingRoot(), target.destinationPath),
        bytes: result.bytes,
        sha256: result.sha256,
        receivedAt: auth.guest.lastUploadAt
      };
      safeEmit('upload', upload);
      emitState();
      sendJson(res, 200, {
        success: true,
        guestPath: upload.guestPath,
        bytes: upload.bytes,
        sha256: upload.sha256,
        receivedAt: upload.receivedAt
      });
    } finally {
      activeUploads -= 1;
      activeGuestUploads.delete(auth.guest.id);
    }
  }

  async function handleRequest(req, res) {
    try {
      const url = new URL(req.url, 'https://vm-protect.local');
      if (req.method === 'POST' && url.pathname === '/agent/v2/pair') {
        await handleEnrollment(req, res, { protocolVersion: 2 });
        return;
      }
      if (url.pathname.startsWith('/agent/v2/')) {
        const handled = await getV2Protocol().handle(req, res, url);
        if (handled !== false) return;
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const guestId = String(req.headers['x-labsuite-guest-id'] || '');
        if (guestId) {
          const auth = authenticate(req, url);
          if (auth.contentLength !== 0 || auth.contentSha256 !== EMPTY_SHA256) {
            throw Object.assign(new Error('Status requests must sign an empty request body.'), { statusCode: 400 });
          }
          touchGuest(auth.guest);
          sendJson(res, 200, {
            success: true,
            service: {
              enabled: !!server,
              port: activePort,
              transport: 'https',
              maxFileBytes: getMaxFileBytes()
            },
            guest: publicGuest(auth.guest, now())
          });
        } else {
          sendJson(res, 200, {
            success: true,
            service: {
              enabled: !!server,
              port: activePort,
              transport: 'https',
              tlsFingerprint: getTlsIdentity().fingerprint,
              enrollmentRequired: true
            }
          });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/enroll') {
        await handleEnrollment(req, res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/upload') {
        await handleUpload(req, res, url);
        return;
      }
      sendJson(res, 404, { success: false, error: 'Unknown VM Protect route.' });
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, Number(error.statusCode) || 500, {
          success: false,
          error: Number(error.statusCode) ? error.message : 'VM Protect could not process this request.'
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
      if (!error.statusCode) console.error('VM Protect request failed:', error);
    }
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      const identity = getTlsIdentity();
      const nextServer = httpsModule.createServer({ key: identity.key, cert: identity.cert }, handleRequest);
      nextServer.headersTimeout = 15 * 1000;
      nextServer.requestTimeout = 30 * 60 * 1000;
      nextServer.keepAliveTimeout = 5 * 1000;
      nextServer.maxRequestsPerSocket = 100;
      const onError = error => reject(error);
      nextServer.once('error', onError);
      nextServer.listen(port, dependencies.bindAddress || '0.0.0.0', () => {
        nextServer.removeListener('error', onError);
        nextServer.on('error', error => console.error('VM Protect HTTPS server error:', error.message));
        resolve(nextServer);
      });
    });
  }

  async function start(portOrOptions = {}) {
    if (server) return getState();
    const options = typeof portOrOptions === 'number' ? { port: portOrOptions } : (portOrOptions || {});
    const requestedPort = Number(options.port) || DEFAULT_PORT;
    if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
      throw new Error('VM Protect port must be between 1024 and 65535.');
    }
    loadGuests().forEach(guest => { guest.status = 'offline'; });
    persistGuests();
    server = await listen(requestedPort);
    activePort = requestedPort;
    emitState();
    return getState();
  }

  async function stop() {
    const currentServer = server;
    server = null;
    activePort = null;
    enrollments.clear();
    usedNonces.clear();
    activeGuestUploads.clear();
    if (guests) {
      guests.forEach(guest => { guest.status = 'offline'; });
      persistGuests();
    }
    if (currentServer) {
      await new Promise(resolve => currentServer.close(() => resolve()));
    }
    emitState();
    return getState();
  }

  function getState() {
    const identity = getTlsIdentity();
    const addresses = listCandidateAddresses(networkInterfaces());
    return {
      enabled: !!server,
      port: activePort,
      defaultPort: DEFAULT_PORT,
      transport: 'https',
      tlsFingerprint: identity.fingerprint,
      stagingRoot: getStagingRoot(),
      maxFileBytes: getMaxFileBytes(),
      guestQuotaBytes: getGuestQuotaBytes(),
      activeUploads: activeUploads + (v2Protocol ? v2Protocol.getActiveUploads() : 0),
      addresses,
      v2StagingRoot: getV2StagingRoot(),
      v2MetadataRoot: getV2MetadataRoot(),
      guests: loadGuests().map(guest => publicGuest(guest, now())),
      pendingEnrollments: [...enrollments.values()]
        .filter(item => ['invited', 'pending', 'approved'].includes(item.state) && (!item.consumed || item.multiUse) && item.expiresAtMs > now())
        .map(item => ({
          enrollmentId: item.id,
          state: item.state,
          pairingCode: item.pairingCode,
          name: cleanLabel(item.request && item.request.name || item.name, 'Windows VM'),
          machineName: cleanLabel(item.request && item.request.machineName, ''),
          selectedFiles: [...(item.request && item.request.selectedFiles || item.selectedFiles || [])],
          roots: (item.request && item.request.roots || item.roots || []).map(root => ({ ...root })),
          protocolVersion: Number(item.protocolVersion) >= 2 ? 2 : 1,
          vmId: item.vmId,
          vmxPath: item.vmxPath,
          vmwareUuid: item.vmwareUuid,
          multiUse: item.multiUse === true,
          autoApprove: item.autoApprove === true,
          maxGuests: Number(item.maxGuests) || 1,
          createdGuests: Number(item.createdGuests) || 0,
          lastGuestAt: item.lastGuestAt || '',
          requestedAt: item.requestedAt || '',
          expiresAt: item.expiresAt
        }))
    };
  }

  async function createEnrollment(options = {}) {
    if (!server) await start(options.port || DEFAULT_PORT);
    cleanupTransientCaches();
    const multiUse = options.multiUse === true;
    const protocolVersion = options.protocolVersion === 2 ? 2 : 1;
    const maxTtl = multiUse ? MAX_BULK_ENROLLMENT_TTL_MS : MAX_SINGLE_ENROLLMENT_TTL_MS;
    const defaultTtl = multiUse ? DEFAULT_BULK_ENROLLMENT_TTL_MS : DEFAULT_ENROLLMENT_TTL_MS;
    const ttl = Math.max(60 * 1000, Math.min(Number(options.ttlMs) || defaultTtl, maxTtl));
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const pairingCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAtMs = now() + ttl;
    const addresses = listCandidateAddresses(networkInterfaces());
    const serverUrls = [...new Set(normalizeHosts(options, addresses)
      .map(host => formatServerUrl(host, activePort))
      .filter(Boolean))];
    const enrollment = {
      id,
      secret,
      pairingCode,
      name: cleanLabel(options.name, 'Windows VM'),
      selectedFiles: normalizeSelectedFiles(options.selectedFiles || options.files),
      roots: protocolVersion === 2 ? normalizeAgentRoots(options.roots) : [],
      protocolVersion,
      vmId: cleanMetadata(options.vmId, 256),
      vmxPath: cleanMetadata(options.vmxPath, 32767),
      vmwareUuid: cleanMetadata(options.vmwareUuid, 256),
      serverUrls,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
      multiUse,
      autoApprove: multiUse && options.autoApprove === true,
      maxGuests: multiUse ? Math.max(1, Math.min(Number(options.maxGuests) || MAX_BULK_ENROLLMENT_GUESTS, MAX_BULK_ENROLLMENT_GUESTS)) : 1,
      createdGuests: 0,
      lastGuestAt: '',
      consumed: false,
      state: multiUse && options.autoApprove === true ? 'approved' : 'invited',
      approvedAt: multiUse && options.autoApprove === true ? new Date(now()).toISOString() : '',
      failedAttempts: 0
    };
    enrollments.set(id, enrollment);
    emitState();
    return {
      enrollmentId: id,
      secret,
      pairingCode,
      name: enrollment.name,
      selectedFiles: [...enrollment.selectedFiles],
      roots: enrollment.roots.map(root => ({ ...root })),
      protocolVersion: enrollment.protocolVersion,
      vmId: enrollment.vmId,
      vmxPath: enrollment.vmxPath,
      vmwareUuid: enrollment.vmwareUuid,
      multiUse: enrollment.multiUse,
      autoApprove: enrollment.autoApprove,
      maxGuests: enrollment.maxGuests,
      serverUrls: [...serverUrls],
      tlsFingerprint: getTlsIdentity().fingerprint,
      expiresAt: enrollment.expiresAt,
      port: activePort
    };
  }

  function cancelEnrollment(id) {
    const removed = enrollments.delete(String(id || ''));
    if (removed) emitState();
    return removed;
  }

  function approveEnrollment(id) {
    cleanupTransientCaches();
    const enrollment = enrollments.get(String(id || ''));
    if (!enrollment || enrollment.state !== 'pending' || enrollment.expiresAtMs <= now()) {
      return { success: false, error: 'Pending VM Protect enrollment was not found or has expired.' };
    }
    enrollment.state = 'approved';
    enrollment.approvedAt = new Date(now()).toISOString();
    emitState();
    return { success: true, enrollmentId: enrollment.id, pairingCode: enrollment.pairingCode };
  }

  function rejectEnrollment(id) {
    cleanupTransientCaches();
    const enrollment = enrollments.get(String(id || ''));
    if (!enrollment || !['invited', 'pending', 'approved'].includes(enrollment.state) || enrollment.expiresAtMs <= now()) {
      return { success: false, error: 'Pending VM Protect enrollment was not found or has expired.' };
    }
    enrollment.state = 'rejected';
    enrollment.rejectedAt = new Date(now()).toISOString();
    emitState();
    return { success: true, enrollmentId: enrollment.id };
  }

  async function writePortableHelper(options = {}) {
    const enrollment = options.enrollment && options.enrollment.enrollmentId
      ? options.enrollment
      : await createEnrollment(options);
    const protocolVersion = Number(options.protocolVersion || enrollment.protocolVersion) >= 2 ? 2 : 1;
    const bootstrap = {
      enrollmentId: enrollment.enrollmentId,
      secret: enrollment.secret,
      serverUrls: enrollment.serverUrls,
      tlsFingerprint: enrollment.tlsFingerprint,
      expiresAt: enrollment.expiresAt,
      name: cleanLabel(options.name || enrollment.name, 'Windows VM'),
      selectedFiles: normalizeSelectedFiles(options.selectedFiles || options.files || enrollment.selectedFiles),
      roots: protocolVersion === 2 ? (enrollment.roots || []).map(root => ({ ...root })) : [],
      protocolVersion,
      alwaysProtect: options.alwaysProtect === true,
      multiUse: enrollment.multiUse === true,
      autoApprove: enrollment.autoApprove === true,
      pollSeconds: Math.max(10, Math.min(Number(options.pollSeconds) || 20, 3600))
    };
    const helperText = protocolVersion === 2
      ? require('./vmProtectAgentV2').buildPowerShellV2Agent(bootstrap)
      : buildPowerShellHelper(bootstrap);
    const helperDir = path.join(getUserDataDir(), 'vm-protect-helpers');
    const outputPath = path.resolve(options.outputPath || path.join(helperDir, `LabSuite-VM-Protect-${enrollment.enrollmentId.slice(0, 8)}.ps1`));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    const tempPath = `${outputPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tempPath, helperText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, outputPath);
    return {
      success: true,
      path: outputPath,
      enrollment,
      capabilities: {
        protocolVersion,
        manifestBatches: protocolVersion === 2,
        oneShotUpload: protocolVersion === 1,
        alwaysProtect: true,
        startup: 'HKCU Run (current Windows user)',
        watcher: protocolVersion === 2 ? 'FileSystemWatcher with periodic reconciliation' : 'poll-and-hash'
      }
    };
  }

  async function locateVmrun(explicitPath) {
    const candidates = explicitPath ? [path.resolve(explicitPath)] : findVmrunCandidates();
    for (const candidate of candidates) {
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch (_) {}
    }
    if (!explicitPath && process.platform === 'win32') {
      try {
        const result = await runChild(spawn, 'where.exe', ['vmrun.exe'], { timeoutMs: 5000, label: 'locate vmrun' });
        const first = result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
        if (first && fs.existsSync(first)) return path.resolve(first);
      } catch (_) {}
    }
    throw new Error('vmrun.exe was not found. Install VMware Workstation/VIX or select vmrun.exe manually.');
  }

  async function deployHelper(options = {}) {
    const vmxPath = path.resolve(String(options.vmxPath || ''));
    const username = String(options.username || options.guestUsername || '');
    const password = String(options.password || options.guestPassword || '');
    if (!options.vmxPath || !fs.existsSync(vmxPath)) throw new Error('Select an existing .vmx file before deploying VM Protect.');
    if (!username || !password) throw new Error('The guest Windows username and password are required for direct deployment.');
    const vmrunPath = await locateVmrun(options.vmrunPath);
    const helper = options.helperPath
      ? { path: path.resolve(options.helperPath), enrollment: options.enrollment || null }
      : await writePortableHelper(options);
    if (!fs.existsSync(helper.path)) throw new Error('The generated VM Protect helper could not be found.');

    const guestDirectory = String(options.guestDirectory || 'C:\\Users\\Public\\Documents\\LabSuite VM Protect');
    if (!/^[A-Za-z]:\\/.test(guestDirectory) || /[\r\n\0]/.test(guestDirectory)) {
      throw new Error('Direct deployment requires a safe absolute Windows guest directory.');
    }
    const guestHelperPath = `${guestDirectory.replace(/[\\/]+$/, '')}\\LabSuite-VM-Protect.ps1`;
    const timeoutMs = Math.max(10000, Math.min(Number(options.timeoutMs) || 120000, 10 * 60 * 1000));
    const commonArgs = ['-T', String(options.vmwareType || 'ws'), '-gu', username, '-gp', password];
    const runVmrun = (commandArgs, label) => runChild(spawn, vmrunPath, [...commonArgs, ...commandArgs], { timeoutMs, label });

    // vmrun only accepts guest passwords as process arguments. They are used in memory for
    // these calls and are deliberately never logged, persisted, returned, or embedded.
    await runVmrun(['createDirectoryInGuest', vmxPath, guestDirectory], 'create guest helper directory').catch(error => {
      if (!/already exists/i.test(`${error.message} ${error.stderr || ''}`)) throw error;
    });
    await runVmrun(['copyFileFromHostToGuest', vmxPath, helper.path, guestHelperPath], 'copy VM Protect helper');
    await runVmrun([
      'runProgramInGuest', vmxPath, '-noWait', '-interactive',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guestHelperPath
    ], 'launch VM Protect helper');

    return {
      success: true,
      vmxPath,
      vmrunPath,
      helperPath: helper.path,
      guestHelperPath,
      enrollment: helper.enrollment || null,
      launched: true
    };
  }

  async function forgetGuest(guestId, options = {}) {
    const id = String(guestId || '');
    const index = loadGuests().findIndex(guest => guest.id === id);
    if (index < 0) return { success: false, error: 'VM Protect guest was not found.' };
    const [forgotten] = loadGuests().splice(index, 1);
    lastSeenPersistedAt.delete(id);
    persistGuests();
    let stagingDeleted = false;
    if (options.deleteStaging === true) {
      const root = getStagingRoot();
      const guestRoot = path.resolve(root, id);
      if (!isPathInside(root, guestRoot) || guestRoot === path.resolve(root)) {
        throw new Error('Refusing to delete an unsafe VM Protect staging path.');
      }
      await fs.promises.rm(guestRoot, { recursive: true, force: true });
      await fs.promises.rm(path.join(root, '.tmp', id), { recursive: true, force: true });
      const v2Root = getV2StagingRoot();
      const v2GuestRoot = path.resolve(v2Root, id);
      const v2MetadataRoot = getV2MetadataRoot();
      const v2GuestMetadataRoot = path.resolve(v2MetadataRoot, id);
      if (isPathInside(v2Root, v2GuestRoot) && v2GuestRoot !== path.resolve(v2Root)) {
        await fs.promises.rm(v2GuestRoot, { recursive: true, force: true });
      }
      if (isPathInside(v2MetadataRoot, v2GuestMetadataRoot) && v2GuestMetadataRoot !== path.resolve(v2MetadataRoot)) {
        await fs.promises.rm(v2GuestMetadataRoot, { recursive: true, force: true });
      }
      stagingDeleted = true;
    }
    emitState();
    return { success: true, guest: publicGuest(forgotten, now()), stagingDeleted };
  }

  return {
    events,
    start,
    stop,
    getState,
    createEnrollment,
    approveEnrollment,
    rejectEnrollment,
    cancelEnrollment,
    writePortableHelper,
    deployHelper,
    forgetGuest,
    locateVmrun,
    getStagingRoot,
    getV2StagingRoot,
    getTlsFingerprint: () => getTlsIdentity().fingerprint
  };
}

function runChild(spawn, executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const maxOutput = 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = Number(options.timeoutMs) || 120000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(Object.assign(new Error(`${options.label || 'VMware command'} timed out after ${timeoutMs}ms.`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-maxOutput);
    if (child.stdout) child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    if (child.stderr) child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(Object.assign(new Error(`${options.label || 'VMware command'} failed (exit ${code}).`), { code, stdout, stderr }));
    });
  });
}

function buildPowerShellHelper(bootstrap) {
  const encodedBootstrap = Buffer.from(JSON.stringify(bootstrap), 'utf8').toString('base64');
  return POWER_SHELL_HELPER_TEMPLATE.replace('__LABSUITE_BOOTSTRAP_BASE64__', encodedBootstrap);
}

// Kept ASCII-only so Windows PowerShell 5 can read the generated UTF-8 file even when it
// does not honor UTF-8 without a BOM. Enrollment material is encoded as Base64 JSON.
const POWER_SHELL_HELPER_TEMPLATE = String.raw`# LabSuite VM Protect portable helper
# This helper sends selected files to the paired LabSuite host. It never receives Google
# Drive credentials, vault passwords, or encryption keys.
[CmdletBinding()]
param(
  [string[]]$Files,
  [switch]$AlwaysProtect,
  [switch]$InstallStartup,
  [switch]$RunWatcher,
  [switch]$NoPicker,
  [switch]$NoPause,
  [switch]$Diagnostics
)

$ErrorActionPreference = 'Stop'
$StateDir = Join-Path $env:LOCALAPPDATA 'LabSuiteVMProtect'
$StatePath = Join-Path $StateDir 'state.json'
$InstalledScript = Join-Path $StateDir 'LabSuite-VM-Protect.ps1'
$RunLogPath = Join-Path $StateDir 'last-run.log'
$DiagnosticPath = Join-Path $StateDir 'diagnostic.txt'
$script:PauseBeforeExit = -not $NoPause -and -not $RunWatcher

function Write-RunLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    $line = [DateTime]::Now.ToString('s') + ' ' + $Message
    Add-Content -LiteralPath $RunLogPath -Value $line -Encoding UTF8
  } catch {}
}

function Wait-BeforeExit([string]$Prompt) {
  if (-not $script:PauseBeforeExit -or -not [Environment]::UserInteractive) { return }
  try { Read-Host $Prompt | Out-Null } catch {}
}

function Test-TcpEndpoint([Uri]$Endpoint) {
  $client = $null
  try {
    $port = if ($Endpoint.Port -gt 0) { $Endpoint.Port } else { 443 }
    $client = New-Object Net.Sockets.TcpClient
    $pending = $client.BeginConnect($Endpoint.Host, $port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(1500, $false)) { return 'UNREACHABLE (timeout)' }
    $client.EndConnect($pending)
    return 'REACHABLE'
  } catch {
    return ('UNREACHABLE (' + $_.Exception.Message + ')')
  } finally {
    if ($null -ne $client) { $client.Dispose() }
  }
}

function New-DiagnosticReport($Failure) {
  $lines = New-Object Collections.Generic.List[string]
  $lines.Add('LabSuite VM Protect diagnostic')
  $lines.Add(('Generated: ' + [DateTime]::Now.ToString('s')))
  $lines.Add(('Computer: ' + [Environment]::MachineName))
  $lines.Add(('Windows: ' + [Environment]::OSVersion.VersionString))
  $lines.Add(('PowerShell: ' + [string]$PSVersionTable.PSVersion))
  try {
    $profiles = @(Get-NetConnectionProfile -ErrorAction Stop | ForEach-Object { [string]$_.InterfaceAlias + '=' + [string]$_.NetworkCategory })
    $lines.Add(('Network profiles: ' + $(if ($profiles.Count) { $profiles -join ', ' } else { 'none reported' })))
  } catch {
    $lines.Add(('Network profiles: unavailable (' + $_.Exception.Message + ')'))
  }
  $lines.Add(('Saved pairing exists: ' + [string](Test-Path -LiteralPath $StatePath -PathType Leaf)))
  $lines.Add(('Selected file count: ' + [string]@($requestedFiles).Count))
  $endpoints = @($Bootstrap.serverUrls)
  if ($endpoints.Count -eq 0) {
    $lines.Add('Receiver endpoints: none')
  } else {
    $lines.Add('Receiver endpoints:')
    foreach ($server in $endpoints) {
      try {
        $endpoint = [Uri][string]$server
        $lines.Add(('  ' + $endpoint.Scheme + '://' + $endpoint.Host + ':' + $endpoint.Port + ' -> ' + (Test-TcpEndpoint $endpoint)))
      } catch {
        $lines.Add(('  invalid endpoint -> ' + $_.Exception.Message))
      }
    }
  }
  if ($null -ne $Failure) {
    $lines.Add('Failure:')
    $lines.Add(('  Message: ' + $Failure.Exception.Message))
    $lines.Add(('  Type: ' + $Failure.Exception.GetType().FullName))
    $lines.Add(('  Category: ' + [string]$Failure.CategoryInfo.Category))
    $lines.Add(('  Error ID: ' + [string]$Failure.FullyQualifiedErrorId))
    if (-not [string]::IsNullOrWhiteSpace([string]$Failure.ScriptStackTrace)) {
      $lines.Add(('  Stack: ' + ([string]$Failure.ScriptStackTrace).Replace([Environment]::NewLine, ' | ')))
    }
  } else {
    $lines.Add('Failure: none (manual diagnostic run)')
  }
  return ($lines -join [Environment]::NewLine)
}

function Save-AndCopyDiagnostics($Failure) {
  $report = New-DiagnosticReport $Failure
  try {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    Set-Content -LiteralPath $DiagnosticPath -Value $report -Encoding UTF8
  } catch {}
  $copied = $false
  try {
    $clip = Join-Path $env:SystemRoot 'System32\clip.exe'
    if (Test-Path -LiteralPath $clip -PathType Leaf) {
      $report | & $clip
      $copied = $LASTEXITCODE -eq 0
    }
  } catch {}
  return [PSCustomObject]@{ Report = $report; Copied = $copied }
}

trap {
  $detail = $_.Exception.Message
  Write-RunLog ('ERROR: ' + $detail)
  $diagnostic = Save-AndCopyDiagnostics $_
  Write-Host ''
  Write-Host 'LabSuite VM Protect could not finish setup.' -ForegroundColor Red
  Write-Host $diagnostic.Report -ForegroundColor Yellow
  if ($diagnostic.Copied) { Write-Host 'The diagnostic report was copied to your clipboard.' -ForegroundColor Green }
  else { Write-Host 'Clipboard copy was unavailable; select and copy the report shown above.' -ForegroundColor Yellow }
  Write-Host ('Diagnostic report: ' + $DiagnosticPath) -ForegroundColor DarkGray
  Write-Host ('Run log: ' + $RunLogPath) -ForegroundColor DarkGray
  Wait-BeforeExit 'Press Enter to close'
  exit 1
}

Write-Host 'LabSuite VM Protect is starting...' -ForegroundColor Cyan
Write-Host 'If setup fails, a safe diagnostic report will be copied to your clipboard.' -ForegroundColor DarkGray
Write-RunLog 'Helper started.'
$Bootstrap = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__LABSUITE_BOOTSTRAP_BASE64__')) | ConvertFrom-Json
$EmptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security

if ($Diagnostics) {
  $diagnostic = Save-AndCopyDiagnostics $null
  Write-Host $diagnostic.Report -ForegroundColor Cyan
  if ($diagnostic.Copied) { Write-Host 'The diagnostic report was copied to your clipboard.' -ForegroundColor Green }
  Write-Host ('Diagnostic report: ' + $DiagnosticPath) -ForegroundColor DarkGray
  Wait-BeforeExit 'Diagnostics finished. Press Enter to close'
  exit 0
}

function Get-CertificateSha256([System.Security.Cryptography.X509Certificates.X509Certificate]$Certificate) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Certificate.GetRawCertData()))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

$script:ExpectedFingerprint = ([string]$Bootstrap.tlsFingerprint).Replace(':', '').ToLowerInvariant()
[Net.ServicePointManager]::ServerCertificateValidationCallback = {
  param($sender, $certificate, $chain, $sslPolicyErrors)
  if ($null -eq $certificate) { return $false }
  return (Get-CertificateSha256 $certificate) -eq $script:ExpectedFingerprint
}

function Protect-Token([string]$Token) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Token)
  $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  return [Convert]::ToBase64String($protected)
}

function Unprotect-Token([string]$ProtectedToken) {
  $bytes = [Convert]::FromBase64String($ProtectedToken)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  return [Text.Encoding]::UTF8.GetString($plain)
}

function Load-State {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json }
  catch { throw 'The saved VM Protect pairing is damaged. Remove %LOCALAPPDATA%\LabSuiteVMProtect\state.json and pair again.' }
}

function Save-State($State) {
  New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
  $temporary = $StatePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $StatePath -Force
}

function Select-ProtectedFiles {
  Add-Type -AssemblyName System.Windows.Forms
  Write-Host 'Choose the files this VM should protect.' -ForegroundColor Cyan
  $dialog = New-Object Windows.Forms.OpenFileDialog
  $dialog.Title = 'Choose files to protect with LabSuite'
  $dialog.Multiselect = $true
  $dialog.CheckFileExists = $true
  if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return @() }
  return @($dialog.FileNames)
}

function Merge-Files([object[]]$Existing, [object[]]$Additional) {
  $result = New-Object Collections.Generic.List[string]
  $seen = @{}
  foreach ($item in @($Existing) + @($Additional)) {
    $value = [string]$item
    if ([string]::IsNullOrWhiteSpace($value)) { continue }
    try { $full = [IO.Path]::GetFullPath($value) } catch { continue }
    $key = $full.ToLowerInvariant()
    if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; $result.Add($full) }
  }
  return @($result)
}

function Invoke-PinnedJson([string]$Method, [string]$Uri, $Body) {
  $parameters = @{ Method = $Method; Uri = $Uri; UseBasicParsing = $true; TimeoutSec = 8 }
  if ($null -ne $Body) {
    $parameters.ContentType = 'application/json'
    $parameters.Body = ($Body | ConvertTo-Json -Depth 6 -Compress)
  }
  return Invoke-RestMethod @parameters
}

function Get-WebFailureDetail($Failure) {
  $detail = $Failure.Exception.Message
  $response = $Failure.Exception.Response
  if ($null -eq $response) { return $detail }
  try {
    $reader = New-Object IO.StreamReader($response.GetResponseStream())
    try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if (-not [string]::IsNullOrWhiteSpace($text)) {
      try {
        $payload = $text | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$payload.error)) {
          return ($detail + ' Host reason: ' + [string]$payload.error)
        }
      } catch {}
      return ($detail + ' Host response: ' + $text)
    }
  } catch {}
  finally { try { $response.Dispose() } catch {} }
  return $detail
}

function Connect-LabSuite([string[]]$SelectedFiles) {
  $lastError = $null
  $announced = $false
  $lastConnectionNotice = [DateTime]::MinValue
  $deadline = [DateTime]::Parse([string]$Bootstrap.expiresAt).ToUniversalTime()
  if ([bool]$Bootstrap.autoApprove) {
    $autoApproveDeadline = [DateTime]::UtcNow.AddSeconds(45)
    if ($autoApproveDeadline -lt $deadline) { $deadline = $autoApproveDeadline }
  }
  Write-Host 'Connecting this VM to the LabSuite Secure Receiver...' -ForegroundColor Cyan
  while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($server in @($Bootstrap.serverUrls)) {
      $response = $null
      try {
        $response = Invoke-PinnedJson 'POST' ($server.TrimEnd('/') + '/enroll') @{
          enrollmentId = [string]$Bootstrap.enrollmentId
          secret = [string]$Bootstrap.secret
          name = [string]$Bootstrap.name
          machineName = [Environment]::MachineName
          selectedFiles = @($SelectedFiles)
        }
      } catch {
        $lastError = $_
        Write-RunLog ('Connection failed for ' + [string]$server + ': ' + (Get-WebFailureDetail $_))
        continue
      }
      if ($response.pending) {
        if (-not $announced) {
          Write-Host ('Approve this VM in LabSuite. Confirmation code: ' + [string]$response.pairingCode) -ForegroundColor Cyan
          $announced = $true
        }
        continue
      }
      if ($response.rejected) { throw 'The LabSuite host rejected this VM pairing request.' }
      if (-not $response.success) { throw [string]$response.error }
      # Once a token is issued the invitation is consumed. Local state failures must be
      # surfaced immediately instead of retrying enrollment with an already-used invite.
      $state = [PSCustomObject]@{
        enrollmentId = [string]$Bootstrap.enrollmentId
        guestId = [string]$response.guestId
        tokenProtected = Protect-Token ([string]$response.token)
        serverUrl = $server.TrimEnd('/')
        tlsFingerprint = [string]$Bootstrap.tlsFingerprint
        clockOffsetMs = if ($null -ne $response.serverTimeMs) { [int64]$response.serverTimeMs - (Get-UnixMilliseconds) } else { [int64]0 }
        files = @($SelectedFiles)
        fileStamps = @{}
        alwaysProtect = [bool]($AlwaysProtect -or $Bootstrap.alwaysProtect)
        pollSeconds = [int]$Bootstrap.pollSeconds
      }
      Save-State $state
      Write-RunLog 'Pairing completed.'
      return $state
    }
    if (([DateTime]::UtcNow - $lastConnectionNotice).TotalSeconds -ge 10) {
      Write-Host 'Waiting for the LabSuite host. Keep LabSuite and its Secure Receiver open.' -ForegroundColor Yellow
      $lastConnectionNotice = [DateTime]::UtcNow
    }
    Start-Sleep -Seconds 2
  }
  if ([bool]$Bootstrap.autoApprove) {
    throw "The bulk helper could not reach the LabSuite Secure Receiver within 45 seconds. $lastError"
  }
  throw "Pairing was not approved before the invitation expired. $lastError"
}

function New-Nonce {
  $bytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-UnixMilliseconds {
  return [int64](([DateTime]::UtcNow - [DateTime]'1970-01-01T00:00:00Z').TotalMilliseconds)
}

function Get-HmacHex([string]$Token, [string]$Canonical) {
  $hmac = New-Object Security.Cryptography.HMACSHA256
  try {
    $hmac.Key = [Text.Encoding]::UTF8.GetBytes($Token)
    return ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Canonical)))).Replace('-', '').ToLowerInvariant()
  } finally { $hmac.Dispose() }
}

function Get-Sha256Hex([IO.Stream]$Stream) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function New-SignedHeaders($State, [string]$Method, [string]$PathAndQuery, [int64]$Length, [string]$Sha256) {
  $timestamp = [string]((Get-UnixMilliseconds) + [int64]$State.clockOffsetMs)
  $nonce = New-Nonce
  $lf = [string][char]10
  $canonical = $Method.ToUpperInvariant() + $lf + $PathAndQuery + $lf + $timestamp + $lf + $nonce + $lf + [string]$Length + $lf + $Sha256.ToLowerInvariant()
  $token = Unprotect-Token ([string]$State.tokenProtected)
  return @{
    'x-labsuite-guest-id' = [string]$State.guestId
    'x-labsuite-timestamp' = $timestamp
    'x-labsuite-nonce' = $nonce
    'x-content-sha256' = $Sha256.ToLowerInvariant()
    'x-labsuite-signature' = Get-HmacHex $token $canonical
  }
}

function Send-ProtectedFile($State, [string]$FilePath, [int]$MaxAttempts = 3) {
  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    Write-Warning "Waiting for missing file: $FilePath"
    return $false
  }
  $attemptLimit = [Math]::Max(1, $MaxAttempts)
  for ($attempt = 1; $attempt -le $attemptLimit; $attempt += 1) {
    $stream = $null
    try {
      $stream = [IO.File]::Open($FilePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
      $length = $stream.Length
      $sha256 = Get-Sha256Hex $stream
      $stream.Position = 0
      $fullPath = [IO.Path]::GetFullPath($FilePath)
      $pathBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($fullPath)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
      $pathAndQuery = '/upload?path64=' + $pathBase64
      $headers = New-SignedHeaders $State 'POST' $pathAndQuery $length $sha256
      $headers['x-labsuite-file-path-base64'] = $pathBase64
      $request = [Net.HttpWebRequest]::Create(([string]$State.serverUrl).TrimEnd('/') + '/upload')
      $request.Method = 'POST'
      $request.ContentType = 'application/octet-stream'
      $request.ContentLength = $length
      $request.AllowWriteStreamBuffering = $false
      $request.Timeout = 120000
      $request.ReadWriteTimeout = 120000
      foreach ($key in $headers.Keys) { $request.Headers.Add($key, [string]$headers[$key]) }
      $requestStream = $request.GetRequestStream()
      try { $stream.CopyTo($requestStream, 1MB) } finally { $requestStream.Dispose() }
      $response = $request.GetResponse()
      try {
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $result = $reader.ReadToEnd() | ConvertFrom-Json
        if (-not $result.success) { throw [string]$result.error }
        Write-Host ("Protected: " + $FilePath) -ForegroundColor Green
        return $true
      } finally { $response.Dispose() }
    } catch {
      $detail = Get-WebFailureDetail $_
      if ($attempt -lt $attemptLimit) {
        Write-Warning ("Upload attempt " + $attempt + ' of ' + $attemptLimit + " failed for " + $FilePath + ': ' + $detail + '. Retrying...')
        Start-Sleep -Milliseconds (500 * $attempt)
      } else {
        Write-Warning ("Could not protect " + $FilePath + ' after ' + $attemptLimit + ' attempts: ' + $detail)
      }
    } finally {
      if ($null -ne $stream) { $stream.Dispose() }
    }
  }
  return $false
}

function Send-Heartbeat($State) {
  try {
    $pathAndQuery = '/status'
    $headers = New-SignedHeaders $State 'GET' $pathAndQuery 0 $EmptySha256
    $request = [Net.HttpWebRequest]::Create(([string]$State.serverUrl).TrimEnd('/') + $pathAndQuery)
    $request.Method = 'GET'
    $request.ContentLength = 0
    $request.Timeout = 15000
    foreach ($key in $headers.Keys) { $request.Headers.Add($key, [string]$headers[$key]) }
    $response = $request.GetResponse()
    $response.Dispose()
    return $true
  } catch { return $false }
}

function Install-AlwaysProtect {
  New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
  $source = $MyInvocation.ScriptName
  if ([string]::IsNullOrWhiteSpace($source)) { throw 'Always Protect requires this helper to be saved as a .ps1 file.' }
  if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($InstalledScript)) {
    Copy-Item -LiteralPath $source -Destination $InstalledScript -Force
  }
  $quoted = '"' + $InstalledScript.Replace('"', '""') + '"'
  $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $quoted + ' -RunWatcher'
  New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Force | Out-Null
  New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'LabSuiteVMProtect' -Value $command -PropertyType String -Force | Out-Null
  return $InstalledScript
}

function Start-HiddenWatcher([string]$ScriptPath) {
  $safe = $ScriptPath.Replace("'", "''")
  $command = "& '$safe' -RunWatcher"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) | Out-Null
}

$state = Load-State
$requestedFiles = Merge-Files @($Bootstrap.selectedFiles) @($Files)
$stateMatchesHelper = $null -ne $state -and [string]$state.enrollmentId -eq [string]$Bootstrap.enrollmentId
$replaceExistingPairing = $null -ne $state -and -not $RunWatcher -and -not $stateMatchesHelper
if ($null -eq $state -or $replaceExistingPairing) {
  if ($replaceExistingPairing) {
    Write-Host 'A different VM Protect pairing was found. This helper will replace it.' -ForegroundColor Yellow
    Write-RunLog 'Replacing an existing pairing with this helper.'
  }
  if ($requestedFiles.Count -eq 0 -and -not $NoPicker -and -not $RunWatcher) { $requestedFiles = Select-ProtectedFiles }
  if ($requestedFiles.Count -eq 0) { throw 'No files were selected. Run the helper again and choose at least one file.' }
  $state = Connect-LabSuite $requestedFiles
} else {
  if (-not $RunWatcher) { Write-Host 'This helper is already paired. Checking protected files for changes...' -ForegroundColor Cyan }
  $script:ExpectedFingerprint = ([string]$state.tlsFingerprint).Replace(':', '').ToLowerInvariant()
  $loadedStamps = @{}
  if ($null -ne $state.fileStamps) {
    foreach ($property in $state.fileStamps.PSObject.Properties) { $loadedStamps[$property.Name] = [string]$property.Value }
  }
  if ($null -eq $state.fileStamps) { $state | Add-Member -NotePropertyName fileStamps -NotePropertyValue $loadedStamps }
  else { $state.fileStamps = $loadedStamps }
  # The host-approved allowlist is immutable for this pairing. Create a new helper
  # when adding files so the host shows another explicit approval request.
  $requestedFiles = @()
  $state.files = Merge-Files @($state.files) @()
}

if ($AlwaysProtect -or $InstallStartup -or [bool]$Bootstrap.alwaysProtect) { $state.alwaysProtect = $true }
$state.files = Merge-Files @($state.files) $requestedFiles
Save-State $state

if ($RunWatcher) {
  $created = $false
  $mutex = New-Object Threading.Mutex($true, ('Local\LabSuiteVMProtect-' + [string]$state.guestId), [ref]$created)
  if (-not $created) { exit 0 }
  $stamps = @{}
  if ($null -ne $state.fileStamps) {
    foreach ($key in @($state.fileStamps.Keys)) { $stamps[[string]$key] = [string]$state.fileStamps[$key] }
  }
  $lastHeartbeat = [DateTime]::MinValue
  try {
    while ($true) {
      foreach ($file in @($state.files)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        $item = Get-Item -LiteralPath $file
        $stamp = [string]$item.Length + ':' + [string]$item.LastWriteTimeUtc.Ticks
        if (-not $stamps.ContainsKey($file) -or $stamps[$file] -ne $stamp) {
          # Avoid capturing a transient half-written version while an editor is saving.
          Start-Sleep -Milliseconds 1200
          if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
          $stableItem = Get-Item -LiteralPath $file
          $stableStamp = [string]$stableItem.Length + ':' + [string]$stableItem.LastWriteTimeUtc.Ticks
          if ($stableStamp -eq $stamp -and (Send-ProtectedFile $state $file)) {
            $stamps[$file] = $stableStamp
            $state.fileStamps = $stamps
            Save-State $state
          }
        }
      }
      if (([DateTime]::UtcNow - $lastHeartbeat).TotalSeconds -ge 60) {
        Send-Heartbeat $state | Out-Null
        $lastHeartbeat = [DateTime]::UtcNow
      }
      Start-Sleep -Seconds ([Math]::Max(10, [int]$state.pollSeconds))
    }
  } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
}

$failedFiles = New-Object Collections.Generic.List[string]
foreach ($file in @($state.files)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    Write-Warning "Waiting for missing file: $file"
    $failedFiles.Add([string]$file)
    continue
  }
  $item = Get-Item -LiteralPath $file
  $currentStamp = [string]$item.Length + ':' + [string]$item.LastWriteTimeUtc.Ticks
  if ($state.fileStamps.ContainsKey($file) -and [string]$state.fileStamps[$file] -eq $currentStamp) { continue }
  if (Send-ProtectedFile $state $file) {
    $state.fileStamps[$file] = $currentStamp
  } else {
    $failedFiles.Add([string]$file)
  }
}
Save-State $state

if ([bool]$state.alwaysProtect) {
  if ($failedFiles.Count -gt 0) {
    throw ('Setup could not verify the initial upload for ' + $failedFiles.Count + ' selected file(s): ' + ($failedFiles -join ', '))
  }
  $installed = Install-AlwaysProtect
  Start-HiddenWatcher $installed
  Write-Host 'Always Protect is enabled. LabSuite will catch up whenever this VM and the host are available.' -ForegroundColor Green
  Write-RunLog 'Always Protect enabled successfully.'
} else {
  if ($failedFiles.Count -gt 0) {
    throw ('Protection failed for ' + $failedFiles.Count + ' selected file(s): ' + ($failedFiles -join ', '))
  }
  Write-Host 'One-time protection finished. Run this helper again to send updated copies.' -ForegroundColor Green
  Write-RunLog 'One-time protection finished successfully.'
}
Write-Host ('Diagnostic log: ' + $RunLogPath) -ForegroundColor DarkGray
Wait-BeforeExit 'Setup finished. Press Enter to close'
`;

let defaultService = null;
function getDefaultService() {
  if (!defaultService) defaultService = createVmProtectService();
  return defaultService;
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_ENROLLMENT_TTL_MS,
  DEFAULT_MAX_FILE_BYTES,
  MAX_CLOCK_SKEW_MS,
  EMPTY_SHA256,
  buildCanonicalRequest,
  makeSignature,
  timingSafeStringEqual,
  normalizeGuestAbsolutePath,
  resolveStagingTarget,
  parseStoredGuests,
  listCandidateAddresses,
  buildPowerShellHelper,
  findVmrunCandidates,
  runChild,
  createVmProtectService,
  get events() { return getDefaultService().events; },
  start: (...args) => getDefaultService().start(...args),
  stop: (...args) => getDefaultService().stop(...args),
  getState: (...args) => getDefaultService().getState(...args),
  createEnrollment: (...args) => getDefaultService().createEnrollment(...args),
  approveEnrollment: (...args) => getDefaultService().approveEnrollment(...args),
  rejectEnrollment: (...args) => getDefaultService().rejectEnrollment(...args),
  cancelEnrollment: (...args) => getDefaultService().cancelEnrollment(...args),
  writePortableHelper: (...args) => getDefaultService().writePortableHelper(...args),
  deployHelper: (...args) => getDefaultService().deployHelper(...args),
  forgetGuest: (...args) => getDefaultService().forgetGuest(...args),
  getV2StagingRoot: (...args) => getDefaultService().getV2StagingRoot(...args),
  locateVmrun: (...args) => getDefaultService().locateVmrun(...args)
};
