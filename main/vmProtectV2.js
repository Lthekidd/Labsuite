const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');

const SMALL_FILE_BUNDLE_BYTES = 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_PARALLEL_UPLOADS = 4;
const MAX_BATCH_ENTRIES = 10000;
const MAX_BATCH_JSON_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const BATCH_TTL_MS = 24 * 60 * 60 * 1000;

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeWindowsSegment(value) {
  const segment = String(value || '').normalize('NFC');
  if (!segment || segment === '.' || segment === '..' || segment.length > 180
    || /[<>:"/\\|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
    throw Object.assign(new Error('The VM agent manifest contains an unsafe path segment.'), { statusCode: 400 });
  }
  return segment;
}

function normalizeRelativePath(value) {
  const original = String(value || '').normalize('NFC').replace(/\\/g, '/');
  if (!original || original.length > 32767 || original.startsWith('/') || /^[A-Za-z]:/.test(original)) {
    throw Object.assign(new Error('A relative VM agent manifest path is required.'), { statusCode: 400 });
  }
  const segments = original.split('/').map(safeWindowsSegment);
  if (segments.length < 2 || !/^root-[a-f0-9]{8,64}$/i.test(segments[0])) {
    throw Object.assign(new Error('VM agent paths must be scoped to a configured root.'), { statusCode: 400 });
  }
  const relativePath = segments.join('/');
  return { relativePath, key: relativePath.toLowerCase(), segments };
}

function normalizeRoots(input) {
  if (!Array.isArray(input)) return [];
  const output = [];
  const ids = new Set();
  for (const item of input.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').toLowerCase();
    const displayPath = String(item.path || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32767);
    const type = item.type === 'file' ? 'file' : 'folder';
    if (!/^root-[a-f0-9]{8,64}$/.test(id) || !displayPath || ids.has(id)) continue;
    ids.add(id);
    output.push({ id, path: displayPath, type, recursive: type === 'folder' ? item.recursive !== false : false });
  }
  return output;
}

function normalizeEntries(input, maxFileBytes) {
  if (!Array.isArray(input) || !input.length) {
    throw Object.assign(new Error('A VM agent batch must contain at least one manifest entry.'), { statusCode: 400 });
  }
  if (input.length > MAX_BATCH_ENTRIES) {
    throw Object.assign(new Error(`A VM agent batch may contain at most ${MAX_BATCH_ENTRIES} entries.`), { statusCode: 413 });
  }
  const seenIds = new Set();
  const seenPaths = new Set();
  return input.map(raw => {
    const id = String(raw && raw.id || '').toLowerCase();
    if (!/^[a-f0-9]{16,128}$/.test(id) || seenIds.has(id)) {
      throw Object.assign(new Error('A VM agent batch contains an invalid or duplicate entry id.'), { statusCode: 400 });
    }
    seenIds.add(id);
    const normalized = normalizeRelativePath(raw.relativePath);
    if (seenPaths.has(normalized.key)) {
      throw Object.assign(new Error('A VM agent batch contains duplicate manifest paths.'), { statusCode: 400 });
    }
    seenPaths.add(normalized.key);
    const type = raw.type === 'tombstone' ? 'tombstone' : 'file';
    if (type === 'tombstone') return { id, type, ...normalized };
    const size = Number(raw.size);
    const mtimeUtc = String(raw.mtimeUtc || '');
    const fileSha256 = String(raw.sha256 || '').toLowerCase();
    if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes || !/^\d{4}-\d{2}-\d{2}T/.test(mtimeUtc)
      || !/^[a-f0-9]{64}$/.test(fileSha256)) {
      throw Object.assign(new Error('A VM agent file entry is invalid or exceeds the configured size limit.'), { statusCode: 400 });
    }
    return { id, type, ...normalized, size, mtimeUtc: new Date(mtimeUtc).toISOString(), sha256: fileSha256 };
  });
}

function createVmProtectV2Protocol(dependencies) {
  const fs = dependencies.fs;
  const now = dependencies.now || (() => Date.now());
  const activeGuestUploads = new Map();
  const batchLocks = new Map();
  let activeUploads = 0;

  function assertGuestId(guestId) {
    const id = String(guestId || '');
    if (!/^[a-f0-9-]{16,64}$/i.test(id)) throw new Error('Invalid VM agent identifier.');
    return id;
  }

  function getAgentRoot(guestId) {
    const root = path.resolve(dependencies.getStagingRoot());
    const currentRoot = path.resolve(root, assertGuestId(guestId), 'current');
    if (!isPathInside(root, currentRoot)) throw new Error('VM agent staging path escaped its root.');
    return currentRoot;
  }

  function getMetadataRoot(guestId) {
    const root = path.resolve(dependencies.getMetadataRoot());
    const metadataRoot = path.resolve(root, assertGuestId(guestId));
    if (!isPathInside(root, metadataRoot)) throw new Error('VM agent metadata path escaped its root.');
    return metadataRoot;
  }

  function manifestPath(guestId) {
    return path.join(getMetadataRoot(guestId), 'manifest.json');
  }

  function batchPath(guestId, batchId) {
    return path.join(getMetadataRoot(guestId), 'batches', `${batchId}.json`);
  }

  function batchFilesRoot(guestId, batchId) {
    return path.join(getMetadataRoot(guestId), 'batches', batchId, 'files');
  }

  function assertBatchId(value) {
    const id = String(value || '').toLowerCase();
    if (!/^[a-f0-9-]{16,64}$/.test(id)) {
      throw Object.assign(new Error('The VM agent batch id is invalid.'), { statusCode: 400 });
    }
    return id;
  }

  async function readStoredJson(filePath, fallback) {
    try {
      const text = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(text);
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  async function writeStoredJson(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temporary, filePath);
  }

  async function loadManifest(guestId) {
    const fallback = { version: 2, generation: 0, entries: {} };
    const loaded = await readStoredJson(manifestPath(guestId), fallback);
    if (!loaded || loaded.version !== 2 || !loaded.entries || typeof loaded.entries !== 'object') return fallback;
    return { version: 2, generation: Number(loaded.generation) || 0, entries: loaded.entries };
  }

  async function saveManifest(guestId, manifest) {
    await writeStoredJson(manifestPath(guestId), manifest);
  }

  async function loadBatch(guestId, batchId) {
    return readStoredJson(batchPath(guestId, batchId), null);
  }

  async function saveBatch(guestId, batch) {
    await writeStoredJson(batchPath(guestId, batch.batchId), batch);
  }

  async function withBatchLock(guestId, batchId, work) {
    const key = `${guestId}:${batchId}`;
    const previous = batchLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const holder = previous.then(() => gate);
    batchLocks.set(key, holder);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (batchLocks.get(key) === holder) batchLocks.delete(key);
    }
  }

  async function readRawBody(req, auth, maxBytes) {
    if (auth.contentLength > maxBytes) {
      req.resume();
      throw Object.assign(new Error('VM agent request exceeds the allowed size.'), { statusCode: 413 });
    }
    const chunks = [];
    let received = 0;
    await new Promise((resolve, reject) => {
      req.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes || received > auth.contentLength) {
          reject(Object.assign(new Error('VM agent request body exceeds its declared size.'), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', resolve);
      req.on('aborted', () => reject(Object.assign(new Error('VM agent request was aborted.'), { statusCode: 400 })));
      req.on('error', reject);
    });
    const body = Buffer.concat(chunks);
    if (body.length !== auth.contentLength) {
      throw Object.assign(new Error('VM agent request length does not match Content-Length.'), { statusCode: 400 });
    }
    if (!timingSafeStringEqual(sha256(body), auth.contentSha256)) {
      throw Object.assign(new Error('VM agent request SHA-256 verification failed.'), { statusCode: 422 });
    }
    return body;
  }

  async function readJsonBody(req, auth, maxBytes = MAX_BATCH_JSON_BYTES) {
    const raw = await readRawBody(req, auth, maxBytes);
    try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
    catch (_) { throw Object.assign(new Error('VM agent request body is not valid JSON.'), { statusCode: 400 }); }
  }

  function getStorageRelativePath(rootPath, normalized) {
    const ordinary = normalized.relativePath;
    const resolved = path.resolve(rootPath, ...normalized.segments);
    if (isPathInside(rootPath, resolved) && resolved.length < 240) return ordinary;
    const suffix = crypto.createHash('sha256').update(normalized.relativePath.toLowerCase(), 'utf8').digest('hex');
    return `_long-paths/${suffix.slice(0, 2)}/${suffix}-${normalized.segments[normalized.segments.length - 1]}`;
  }

  function resolveStoragePath(rootPath, storageRelativePath) {
    const segments = String(storageRelativePath || '').replace(/\\/g, '/').split('/').map(safeWindowsSegment);
    const resolved = path.resolve(rootPath, ...segments);
    if (!isPathInside(rootPath, resolved)) throw new Error('VM agent staging path escaped its root.');
    return resolved;
  }

  function calculateProjectedBytes(manifest, entries) {
    const items = new Map(Object.entries(manifest.entries || {}).map(([key, value]) => [key, Number(value.size) || 0]));
    for (const entry of entries) {
      if (entry.type === 'tombstone') items.delete(entry.key);
      else items.set(entry.key, entry.size);
    }
    return [...items.values()].reduce((total, value) => total + value, 0);
  }

  function batchPlan(batch) {
    const completed = batch.files || {};
    return {
      batchId: batch.batchId,
      committed: batch.status === 'committed',
      missing: (batch.missingIds || []).filter(id => !completed[id] || !completed[id].complete),
      chunkOffsets: Object.fromEntries(Object.entries(completed).map(([id, value]) => [id, Number(value.bytes) || 0])),
      smallFileBundleBytes: SMALL_FILE_BUNDLE_BYTES,
      chunkBytes: CHUNK_BYTES,
      maxParallelUploads: MAX_PARALLEL_UPLOADS
    };
  }

  async function prepare(req, res, url) {
    const auth = dependencies.authenticate(req, url);
    const body = await readJsonBody(req, auth);
    if (Number(auth.guest.protocolVersion || 1) < 2) {
      throw Object.assign(new Error('This VM is paired with the legacy VM Protect protocol. Generate a v2 agent to upgrade it.'), { statusCode: 409 });
    }
    const batchId = assertBatchId(body.batchId);
    const entries = normalizeEntries(body.entries, dependencies.getMaxFileBytes());
    const roots = normalizeRoots(body.roots);
    const requestDigest = sha256(Buffer.from(JSON.stringify({ entries, roots, generation: Number(body.generation) || 0 })));
    let batch = await loadBatch(auth.guest.id, batchId);
    if (batch && batch.requestDigest !== requestDigest) {
      throw Object.assign(new Error('A VM agent batch id cannot be reused with different manifest entries.'), { statusCode: 409 });
    }
    if (!batch) {
      const manifest = await loadManifest(auth.guest.id);
      const projectedBytes = calculateProjectedBytes(manifest, entries);
      if (projectedBytes > dependencies.getGuestQuotaBytes()) {
        throw Object.assign(new Error(`This VM would exceed its ${dependencies.getGuestQuotaBytes()}-byte protected staging quota.`), { statusCode: 507 });
      }
      const root = getAgentRoot(auth.guest.id);
      const missingIds = entries
        .filter(entry => entry.type === 'file')
        .filter(entry => {
          const previous = manifest.entries[entry.key];
          if (!previous || previous.sha256 !== entry.sha256 || Number(previous.size) !== entry.size) return true;
          try { return !fs.existsSync(resolveStoragePath(root, previous.storageRelativePath)); } catch (_) { return true; }
        })
        .map(entry => entry.id);
      batch = {
        version: 2,
        batchId,
        guestId: auth.guest.id,
        requestDigest,
        generation: Number(body.generation) || 0,
        roots,
        entries,
        missingIds,
        files: {},
        createdAt: new Date(now()).toISOString(),
        updatedAt: new Date(now()).toISOString(),
        status: 'prepared'
      };
      await saveBatch(auth.guest.id, batch);
    }
    auth.guest.protocolVersion = 2;
    auth.guest.policy = { roots: batch.roots, excludePatterns: Array.isArray(body.excludePatterns) ? body.excludePatterns.slice(0, 100) : [] };
    auth.guest.pendingFiles = (batch.missingIds || []).filter(id => !batch.files[id] || !batch.files[id].complete).length;
    auth.guest.pendingBytes = (batch.missingIds || []).reduce((total, id) => {
      const entry = batch.entries.find(item => item.id === id);
      return total + (entry ? entry.size : 0);
    }, 0);
    dependencies.touchGuest(auth.guest, true);
    dependencies.emitState();
    dependencies.sendJson(res, 200, { success: true, serverTimeMs: now(), ...batchPlan(batch) });
  }

  async function withUploadSlot(guestId, work) {
    const guestActive = Number(activeGuestUploads.get(guestId)) || 0;
    if (activeUploads >= MAX_PARALLEL_UPLOADS || guestActive >= MAX_PARALLEL_UPLOADS) {
      throw Object.assign(new Error('The VM agent receiver is busy; retry this transfer shortly.'), { statusCode: 503, retryAfter: '3' });
    }
    activeUploads += 1;
    activeGuestUploads.set(guestId, guestActive + 1);
    try { return await work(); }
    finally {
      activeUploads -= 1;
      const remaining = (Number(activeGuestUploads.get(guestId)) || 1) - 1;
      if (remaining > 0) activeGuestUploads.set(guestId, remaining);
      else activeGuestUploads.delete(guestId);
    }
  }

  function getPreparedEntry(batch, fileId) {
    const entry = (batch.entries || []).find(item => item.id === fileId && item.type === 'file');
    if (!entry || !(batch.missingIds || []).includes(fileId)) {
      throw Object.assign(new Error('This VM agent upload is not part of the prepared batch.'), { statusCode: 409 });
    }
    return entry;
  }

  async function receiveBundle(req, res, url, batchId) {
    const auth = dependencies.authenticate(req, url);
    const raw = await readRawBody(req, auth, MAX_BUNDLE_BYTES);
    let json = raw;
    if (String(req.headers['content-encoding'] || '').toLowerCase() === 'gzip') {
      try { json = zlib.gunzipSync(raw, { maxOutputLength: MAX_BUNDLE_UNCOMPRESSED_BYTES }); }
      catch (_) { throw Object.assign(new Error('The VM agent bundle could not be decompressed.'), { statusCode: 400 }); }
    }
    if (json.length > MAX_BUNDLE_UNCOMPRESSED_BYTES) throw Object.assign(new Error('The VM agent bundle is too large.'), { statusCode: 413 });
    let body;
    try { body = JSON.parse(json.toString('utf8')); }
    catch (_) { throw Object.assign(new Error('The VM agent bundle is not valid JSON.'), { statusCode: 400 }); }
    const incoming = Array.isArray(body.entries) ? body.entries : [];
    if (!incoming.length || incoming.length > 1000) throw Object.assign(new Error('The VM agent bundle has an invalid entry count.'), { statusCode: 400 });
    const accepted = [];
    let finalBatch = null;
    await withUploadSlot(auth.guest.id, async () => {
      await withBatchLock(auth.guest.id, batchId, async () => {
        const batch = await loadBatch(auth.guest.id, batchId);
        if (!batch || batch.status !== 'prepared') throw Object.assign(new Error('The VM agent batch was not found or is no longer writable.'), { statusCode: 404 });
        const filesRoot = batchFilesRoot(auth.guest.id, batchId);
        await fs.promises.mkdir(filesRoot, { recursive: true });
        for (const item of incoming) {
          const id = String(item && item.id || '').toLowerCase();
          const entry = getPreparedEntry(batch, id);
          if (entry.size > SMALL_FILE_BUNDLE_BYTES) throw Object.assign(new Error('Large files must use resumable chunk uploads.'), { statusCode: 400 });
          const encoded = String(item.data || '');
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw Object.assign(new Error('The VM agent bundle contains invalid Base64 data.'), { statusCode: 400 });
          const data = Buffer.from(encoded, 'base64');
          if (data.length !== entry.size || !timingSafeStringEqual(sha256(data), entry.sha256)) {
            throw Object.assign(new Error(`Bundle content verification failed for ${entry.relativePath}.`), { statusCode: 422 });
          }
          const temporary = path.join(filesRoot, `${id}.${crypto.randomBytes(6).toString('hex')}.tmp`);
          const destination = path.join(filesRoot, `${id}.upload`);
          await fs.promises.writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
          await dependencies.atomicReplace(temporary, destination);
          batch.files[id] = { path: destination, bytes: data.length, sha256: entry.sha256, complete: true };
          accepted.push(id);
        }
        batch.updatedAt = new Date(now()).toISOString();
        await saveBatch(auth.guest.id, batch);
        finalBatch = batch;
      });
    });
    dependencies.touchGuest(auth.guest, true);
    dependencies.sendJson(res, 200, { success: true, accepted, ...batchPlan(finalBatch) });
  }

  async function receiveChunk(req, res, url, batchId, fileId, offsetText) {
    const auth = dependencies.authenticate(req, url);
    const offset = Number(offsetText);
    if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('The VM agent chunk offset is invalid.'), { statusCode: 400 });
    const data = await readRawBody(req, auth, Math.min(CHUNK_BYTES, dependencies.getMaxFileBytes()));
    const result = await withUploadSlot(auth.guest.id, async () => {
      return withBatchLock(auth.guest.id, batchId, async () => {
        const batch = await loadBatch(auth.guest.id, batchId);
        if (!batch || batch.status !== 'prepared') throw Object.assign(new Error('The VM agent batch was not found or is no longer writable.'), { statusCode: 404 });
        const entry = getPreparedEntry(batch, fileId);
        const filesRoot = batchFilesRoot(auth.guest.id, batchId);
        await fs.promises.mkdir(filesRoot, { recursive: true });
        const partialPath = path.join(filesRoot, `${fileId}.part`);
        let existing = 0;
        try { existing = (await fs.promises.stat(partialPath)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (offset !== existing) {
          if (offset < existing) return { nextOffset: existing, complete: !!(batch.files[fileId] && batch.files[fileId].complete) };
          throw Object.assign(new Error(`The VM agent chunk offset is ahead of the receiver (${existing}).`), { statusCode: 409 });
        }
        if (existing + data.length > entry.size) throw Object.assign(new Error('The VM agent chunk exceeds the declared file size.'), { statusCode: 413 });
        await fs.promises.appendFile(partialPath, data, { mode: 0o600 });
        const nextOffset = existing + data.length;
        if (nextOffset === entry.size) {
          const completed = await fs.promises.readFile(partialPath);
          if (!timingSafeStringEqual(sha256(completed), entry.sha256)) {
            await fs.promises.unlink(partialPath).catch(() => {});
            throw Object.assign(new Error(`Chunked file verification failed for ${entry.relativePath}.`), { statusCode: 422 });
          }
          const destination = path.join(filesRoot, `${fileId}.upload`);
          await dependencies.atomicReplace(partialPath, destination);
          batch.files[fileId] = { path: destination, bytes: nextOffset, sha256: entry.sha256, complete: true };
        } else {
          batch.files[fileId] = { path: partialPath, bytes: nextOffset, sha256: entry.sha256, complete: false };
        }
        batch.updatedAt = new Date(now()).toISOString();
        await saveBatch(auth.guest.id, batch);
        return { nextOffset, complete: nextOffset === entry.size };
      });
    });
    dependencies.touchGuest(auth.guest, true);
    dependencies.sendJson(res, 200, { success: true, ...result });
  }

  async function commit(req, res, url, batchId) {
    const auth = dependencies.authenticate(req, url);
    const body = await readJsonBody(req, auth);
    const batch = await loadBatch(auth.guest.id, batchId);
    if (!batch) throw Object.assign(new Error('The VM agent batch was not found.'), { statusCode: 404 });
    if (batch.status === 'committed') {
      dependencies.touchGuest(auth.guest);
      dependencies.sendJson(res, 200, { success: true, replayed: true, result: batch.result || {} });
      return;
    }
    if (batch.status !== 'prepared') throw Object.assign(new Error('The VM agent batch cannot be committed.'), { statusCode: 409 });
    const incomplete = (batch.missingIds || []).filter(id => !batch.files[id] || !batch.files[id].complete);
    if (incomplete.length) throw Object.assign(new Error(`The VM agent batch is incomplete (${incomplete.length} file(s) still missing).`), { statusCode: 409 });

    const manifest = await loadManifest(auth.guest.id);
    const root = getAgentRoot(auth.guest.id);
    await fs.promises.mkdir(root, { recursive: true });
    const changedPaths = [];
    const deletedRelativePaths = [];
    let transferredBytes = 0;
    for (const entry of batch.entries) {
      const previous = manifest.entries[entry.key];
      if (entry.type === 'tombstone') {
        if (previous) {
          const previousPath = resolveStoragePath(root, previous.storageRelativePath);
          await fs.promises.rm(previousPath, { force: true });
          delete manifest.entries[entry.key];
          deletedRelativePaths.push(previous.relativePath || entry.relativePath);
        }
        continue;
      }
      const storageRelativePath = previous && previous.storageRelativePath
        ? previous.storageRelativePath
        : getStorageRelativePath(root, entry);
      const destinationPath = resolveStoragePath(root, storageRelativePath);
      const received = batch.files[entry.id];
      if (received && received.complete) {
        await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
        await dependencies.atomicReplace(received.path, destinationPath);
        transferredBytes += entry.size;
        changedPaths.push(destinationPath);
      }
      manifest.entries[entry.key] = {
        relativePath: entry.relativePath,
        storageRelativePath,
        size: entry.size,
        mtimeUtc: entry.mtimeUtc,
        sha256: entry.sha256,
        updatedAt: new Date(now()).toISOString()
      };
    }
    manifest.generation = Math.max(Number(manifest.generation) || 0, Number(batch.generation) || 0, Number(body.generation) || 0) + 1;
    await saveManifest(auth.guest.id, manifest);
    const stagingBytes = Object.values(manifest.entries).reduce((total, entry) => total + (Number(entry.size) || 0), 0);
    const committedAt = new Date(now()).toISOString();
    batch.status = 'committed';
    batch.committedAt = committedAt;
    batch.result = { batchId, generation: manifest.generation, changedCount: changedPaths.length, deletedCount: deletedRelativePaths.length, transferredBytes, committedAt };
    await saveBatch(auth.guest.id, batch);
    auth.guest.protocolVersion = 2;
    auth.guest.policy = { roots: batch.roots, excludePatterns: Array.isArray(body.excludePatterns) ? body.excludePatterns.slice(0, 100) : (auth.guest.policy && auth.guest.policy.excludePatterns) || [] };
    auth.guest.selectedFiles = batch.roots.map(rootEntry => rootEntry.path);
    auth.guest.rootCount = batch.roots.length;
    auth.guest.manifestFileCount = Object.keys(manifest.entries).length;
    auth.guest.pendingFiles = 0;
    auth.guest.pendingBytes = 0;
    auth.guest.stagingBytes = stagingBytes;
    auth.guest.lastCommitAt = committedAt;
    auth.guest.lastUploadAt = committedAt;
    auth.guest.lastUploadBytes = transferredBytes;
    dependencies.touchGuest(auth.guest, true);
    const payload = {
      guest: dependencies.publicGuest(auth.guest),
      guestRoot: root,
      stagingRoot: root,
      batchId,
      generation: manifest.generation,
      changedPaths,
      deletedRelativePaths,
      transferredBytes,
      committedAt
    };
    dependencies.safeEmit('batchCommitted', payload);
    dependencies.emitState();
    dependencies.sendJson(res, 200, { success: true, ...batch.result, stagingBytes, manifestFileCount: auth.guest.manifestFileCount });
  }

  async function heartbeat(req, res, url) {
    const auth = dependencies.authenticate(req, url);
    const body = await readJsonBody(req, auth, 1024 * 1024);
    const roots = normalizeRoots(body.roots);
    if (roots.length) {
      auth.guest.protocolVersion = 2;
      auth.guest.policy = { ...(auth.guest.policy || {}), roots };
      auth.guest.rootCount = roots.length;
    }
    const queue = body.queue && typeof body.queue === 'object' ? body.queue : {};
    auth.guest.pendingFiles = Math.max(0, Math.min(Number(queue.pendingFiles) || 0, MAX_BATCH_ENTRIES));
    auth.guest.pendingBytes = Math.max(0, Math.min(Number(queue.pendingBytes) || 0, dependencies.getGuestQuotaBytes()));
    dependencies.touchGuest(auth.guest, true);
    dependencies.emitState();
    dependencies.sendJson(res, 200, {
      success: true,
      serverTimeMs: now(),
      policy: {
        smallFileBundleBytes: SMALL_FILE_BUNDLE_BYTES,
        chunkBytes: CHUNK_BYTES,
        maxParallelUploads: MAX_PARALLEL_UPLOADS,
        maxFileBytes: dependencies.getMaxFileBytes(),
        guestQuotaBytes: dependencies.getGuestQuotaBytes(),
        roots: auth.guest.policy && auth.guest.policy.roots || []
      }
    });
  }

  async function status(req, res, url) {
    const auth = dependencies.authenticate(req, url);
    if (auth.contentLength !== 0 || auth.contentSha256 !== dependencies.emptySha256) {
      throw Object.assign(new Error('VM agent status requests must sign an empty request body.'), { statusCode: 400 });
    }
    dependencies.touchGuest(auth.guest);
    dependencies.sendJson(res, 200, {
      success: true,
      service: {
        protocolVersion: 2,
        smallFileBundleBytes: SMALL_FILE_BUNDLE_BYTES,
        chunkBytes: CHUNK_BYTES,
        maxParallelUploads: MAX_PARALLEL_UPLOADS,
        activeUploads
      },
      guest: dependencies.publicGuest(auth.guest)
    });
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (req.method === 'POST' && pathname === '/agent/v2/heartbeat') return heartbeat(req, res, url);
    if (req.method === 'GET' && pathname === '/agent/v2/status') return status(req, res, url);
    if (req.method === 'POST' && pathname === '/agent/v2/batches/prepare') return prepare(req, res, url);
    const bundle = /^\/agent\/v2\/batches\/([a-f0-9-]{16,64})\/bundle$/i.exec(pathname);
    if (req.method === 'PUT' && bundle) return receiveBundle(req, res, url, bundle[1].toLowerCase());
    const chunk = /^\/agent\/v2\/batches\/([a-f0-9-]{16,64})\/files\/([a-f0-9]{16,128})\/chunks\/(\d+)$/i.exec(pathname);
    if (req.method === 'PUT' && chunk) return receiveChunk(req, res, url, chunk[1].toLowerCase(), chunk[2].toLowerCase(), chunk[3]);
    const commitMatch = /^\/agent\/v2\/batches\/([a-f0-9-]{16,64})\/commit$/i.exec(pathname);
    if (req.method === 'POST' && commitMatch) return commit(req, res, url, commitMatch[1].toLowerCase());
    return false;
  }

  return {
    handle,
    getActiveUploads: () => activeUploads,
    getGuestRoot: getAgentRoot,
    getMetadataRoot,
    constants: { SMALL_FILE_BUNDLE_BYTES, CHUNK_BYTES, MAX_PARALLEL_UPLOADS }
  };
}

module.exports = {
  createVmProtectV2Protocol,
  SMALL_FILE_BUNDLE_BYTES,
  CHUNK_BYTES,
  MAX_PARALLEL_UPLOADS,
  normalizeRelativePath,
  normalizeEntries
};
