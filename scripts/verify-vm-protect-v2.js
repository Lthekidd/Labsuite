const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawn } = require('child_process');
const vmProtect = require('../main/vmProtect');

function request(port, requestPath, options = {}) {
  const body = options.body === undefined ? null : Buffer.isBuffer(options.body) ? options.body : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: options.method || (body ? 'POST' : 'GET'),
      rejectUnauthorized: false,
      headers: {
        ...(body && !options.raw ? { 'content-type': 'application/json' } : {}),
        ...(body ? { 'content-length': body.length } : {}),
        ...(options.headers || {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { text }; }
        resolve({ statusCode: response.statusCode, payload });
      });
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

function signedHeaders(token, method, requestPath, body) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const contentSha256 = crypto.createHash('sha256').update(body).digest('hex');
  return {
    timestamp,
    nonce,
    contentSha256,
    signature: vmProtect.makeSignature(token, method, requestPath, timestamp, nonce, body.length, contentSha256)
  };
}

function runPowerShell(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error(`PowerShell VM Protect v2 agent timed out.\n${output}`));
    }, options.timeoutMs || 120000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error(`PowerShell VM Protect v2 agent exited ${code}.\n${output}`));
    });
  });
}

async function signedRequest(port, guestId, token, method, requestPath, body, extraHeaders = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const signature = signedHeaders(token, method, requestPath, raw);
  return request(port, requestPath, {
    method,
    body: raw,
    raw: true,
    headers: {
      'content-type': 'application/json',
      'x-labsuite-guest-id': guestId,
      'x-labsuite-timestamp': signature.timestamp,
      'x-labsuite-nonce': signature.nonce,
      'x-content-sha256': signature.contentSha256,
      'x-labsuite-signature': signature.signature,
      ...extraHeaders
    }
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-vm-protect-v2-'));
  const settings = new Map();
  const service = vmProtect.createVmProtectService({
    userDataDir: tempDir,
    db: { getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, String(value)) },
    bindAddress: '127.0.0.1',
    networkInterfaces: () => ({ Test: [{ family: 'IPv4', internal: false, address: '127.0.0.1' }] }),
    maxFileBytes: 16 * 1024 * 1024,
    guestQuotaBytes: 32 * 1024 * 1024
  });
  const port = 23000 + crypto.randomInt(0, 1000);
  const events = [];
  service.events.on('batchCommitted', event => events.push(event));

  try {
    await service.start(port);
    const invitation = await service.createEnrollment({
      name: 'V2 Test VM',
      serverUrls: [`https://127.0.0.1:${port}`],
      multiUse: true,
      autoApprove: true,
      protocolVersion: 2
    });
    assert.strictEqual(invitation.protocolVersion, 2);
    const helperPath = path.join(tempDir, 'LabSuite-VM-Protect-v2.ps1');
    await service.writePortableHelper({ outputPath: helperPath, enrollment: invitation, protocolVersion: 2 });
    const helper = fs.readFileSync(helperPath, 'utf8');
    assert.match(helper, /\/agent\/v2\/batches\/prepare/);
    assert.match(helper, /FileSystemWatcher/);
    assert.match(helper, /\$Diagnostics/);
    if (process.platform === 'win32') {
      const escaped = helperPath.replace(/'/g, "''");
      const parserErrors = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null; $errors.Count`
      ], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
      assert.strictEqual(parserErrors, '0', 'Generated VM Protect v2 agent must parse in Windows PowerShell.');
    }

    const rootId = 'root-aabbccddeeff001122334455';
    const paired = await request(port, '/agent/v2/pair', {
      body: {
        enrollmentId: invitation.enrollmentId,
        secret: invitation.secret,
        name: 'V2 Test VM',
        machineName: 'VM-V2-TEST',
        roots: [{ id: rootId, path: 'C:\\Users\\Test\\Documents', type: 'folder', recursive: true }]
      }
    });
    assert.strictEqual(paired.statusCode, 200);
    assert.strictEqual(paired.payload.protocolVersion, 2);
    const { guestId, token } = paired.payload;
    assert.ok(guestId && token);

    const small = Buffer.from('many small files should share one request', 'utf8');
    const unicode = Buffer.from('unicode paths are part of the manifest\n', 'utf8');
    const large = crypto.randomBytes(1024 * 1024 + 64);
    const entrySmall = {
      id: '11'.repeat(16), type: 'file', relativePath: `${rootId}/nested folder/a file.txt`, size: small.length,
      mtimeUtc: new Date().toISOString(), sha256: crypto.createHash('sha256').update(small).digest('hex')
    };
    const entryLarge = {
      id: '22'.repeat(16), type: 'file', relativePath: `${rootId}/nested folder/large.bin`, size: large.length,
      mtimeUtc: new Date().toISOString(), sha256: crypto.createHash('sha256').update(large).digest('hex')
    };
    const entryUnicode = {
      id: '55'.repeat(16), type: 'file', relativePath: `${rootId}/nested folder/équipe/合同.txt`, size: unicode.length,
      mtimeUtc: new Date().toISOString(), sha256: crypto.createHash('sha256').update(unicode).digest('hex')
    };
    const batchId = crypto.randomUUID();
    const preparePath = '/agent/v2/batches/prepare';
    const prepared = await signedRequest(port, guestId, token, 'POST', preparePath, {
      batchId,
      generation: 1,
      roots: [{ id: rootId, path: 'C:\\Users\\Test\\Documents', type: 'folder', recursive: true }],
      entries: [entrySmall, entryLarge, entryUnicode]
    });
    assert.strictEqual(prepared.statusCode, 200, JSON.stringify(prepared.payload));
    assert.deepStrictEqual(new Set(prepared.payload.missing), new Set([entrySmall.id, entryLarge.id, entryUnicode.id]));
    assert.strictEqual(prepared.payload.smallFileBundleBytes, 1024 * 1024);

    const bundlePath = `/agent/v2/batches/${batchId}/bundle`;
    const bundle = zlib.gzipSync(Buffer.from(JSON.stringify({ entries: [
      { id: entrySmall.id, data: small.toString('base64') },
      { id: entryUnicode.id, data: unicode.toString('base64') }
    ] })));
    const bundled = await signedRequest(port, guestId, token, 'PUT', bundlePath, bundle, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    assert.strictEqual(bundled.statusCode, 200, JSON.stringify(bundled.payload));
    assert.deepStrictEqual(bundled.payload.accepted, [entrySmall.id, entryUnicode.id]);

    const firstLength = 600000;
    const chunkOnePath = `/agent/v2/batches/${batchId}/files/${entryLarge.id}/chunks/0`;
    const chunkOne = await signedRequest(port, guestId, token, 'PUT', chunkOnePath, large.subarray(0, firstLength), { 'content-type': 'application/octet-stream' });
    assert.strictEqual(chunkOne.statusCode, 200, JSON.stringify(chunkOne.payload));
    assert.strictEqual(chunkOne.payload.nextOffset, firstLength);
    const chunkTwoPath = `/agent/v2/batches/${batchId}/files/${entryLarge.id}/chunks/${firstLength}`;
    const chunkTwo = await signedRequest(port, guestId, token, 'PUT', chunkTwoPath, large.subarray(firstLength), { 'content-type': 'application/octet-stream' });
    assert.strictEqual(chunkTwo.statusCode, 200, JSON.stringify(chunkTwo.payload));
    assert.strictEqual(chunkTwo.payload.complete, true);

    const commitPath = `/agent/v2/batches/${batchId}/commit`;
    const committed = await signedRequest(port, guestId, token, 'POST', commitPath, { generation: 1 });
    assert.strictEqual(committed.statusCode, 200, JSON.stringify(committed.payload));
    assert.strictEqual(committed.payload.changedCount, 3);
    assert.strictEqual(events.length, 1, 'A manifest batch must emit one backup event.');
    const currentRoot = path.join(tempDir, 'vm-protect-staging-v2', guestId, 'current', rootId, 'nested folder');
    assert.deepStrictEqual(fs.readFileSync(path.join(currentRoot, 'a file.txt')), small);
    assert.deepStrictEqual(fs.readFileSync(path.join(currentRoot, 'large.bin')), large);
    assert.deepStrictEqual(fs.readFileSync(path.join(currentRoot, 'équipe', '合同.txt')), unicode);
    assert.ok(!fs.existsSync(path.join(currentRoot, '_LabSuite Received Versions')), 'V2 must not create a revision for each file.');
    const state = service.getState().guests.find(guest => guest.id === guestId);
    assert.strictEqual(state.protocolVersion, 2);
    assert.strictEqual(state.manifestFileCount, 3);
    assert.strictEqual(state.rootCount, 1);

    const deleteBatch = crypto.randomUUID();
    const tombstone = { id: '33'.repeat(16), type: 'tombstone', relativePath: entrySmall.relativePath };
    const deletePrepared = await signedRequest(port, guestId, token, 'POST', preparePath, { batchId: deleteBatch, generation: 2, entries: [tombstone] });
    assert.strictEqual(deletePrepared.statusCode, 200, JSON.stringify(deletePrepared.payload));
    const deleted = await signedRequest(port, guestId, token, 'POST', `/agent/v2/batches/${deleteBatch}/commit`, { generation: 2 });
    assert.strictEqual(deleted.statusCode, 200, JSON.stringify(deleted.payload));
    assert.strictEqual(deleted.payload.deletedCount, 1);
    assert.ok(!fs.existsSync(path.join(currentRoot, 'a file.txt')));

    const traversal = await signedRequest(port, guestId, token, 'POST', preparePath, {
      batchId: crypto.randomUUID(), generation: 3,
      entries: [{ ...entrySmall, id: '44'.repeat(16), relativePath: `${rootId}/../escape.txt` }]
    });
    assert.strictEqual(traversal.statusCode, 400, 'Traversal must be rejected before any staging write.');

    if (process.platform === 'win32') {
      const runtimeProfile = path.join(tempDir, 'runtime-profile');
      const runtimeRoot = path.join(tempDir, 'runtime-agent-files');
      const runtimeHelper = path.join(tempDir, 'Runtime-VM-Protect-v2.ps1');
      fs.mkdirSync(runtimeProfile, { recursive: true });
      fs.mkdirSync(path.join(runtimeRoot, 'deep folder'), { recursive: true });
      fs.writeFileSync(path.join(runtimeRoot, 'one.txt'), 'one\n', 'utf8');
      fs.writeFileSync(path.join(runtimeRoot, 'deep folder', 'two.txt'), 'two\n', 'utf8');
      fs.writeFileSync(path.join(runtimeRoot, 'large-one.bin'), crypto.randomBytes(1024 * 1024 + 32));
      fs.writeFileSync(path.join(runtimeRoot, 'large-two.bin'), crypto.randomBytes(1024 * 1024 + 64));
      const runtimeInvitation = await service.createEnrollment({
        name: 'V2 Runtime VM', serverUrls: [`https://127.0.0.1:${port}`], multiUse: true, autoApprove: true, protocolVersion: 2
      });
      await service.writePortableHelper({ outputPath: runtimeHelper, enrollment: runtimeInvitation, protocolVersion: 2 });
      try {
        const runtimeOutput = await runPowerShell([
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runtimeHelper,
          '-Paths', runtimeRoot, '-NoPicker', '-NoPause'
        ], {
          env: { ...process.env, LOCALAPPDATA: runtimeProfile }, timeoutMs: 120000
        });
        assert.match(runtimeOutput, /reconciliation completed/i);
      } catch (error) { throw new Error(`The generated VM Protect v2 agent could not pair and sync on Windows PowerShell.\n${error.message}`); }
      const runtimeGuest = service.getState().guests.find(guest => guest.name === 'V2 Runtime VM');
      assert.ok(runtimeGuest, 'The PowerShell runtime agent must complete v2 pairing.');
      assert.strictEqual(runtimeGuest.manifestFileCount, 4, 'The runtime agent must batch every selected folder file, including parallel large transfers.');
    }
  } finally {
    await service.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().then(() => console.log('VM Protect v2 verification passed.')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
