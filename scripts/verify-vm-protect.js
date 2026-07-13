const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const vmProtect = require('../main/vmProtect');

function requestJson(port, requestPath, options = {}) {
  const body = options.body === undefined
    ? null
    : Buffer.isBuffer(options.body) ? options.body : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const request = https.request({
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
    request.on('error', reject);
    if (body) request.end(body);
    else request.end();
  });
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function canonicalExistingPath(filePath) {
  try {
    return fs.realpathSync.native(filePath).toLowerCase();
  } catch (_) {
    return path.resolve(filePath).toLowerCase();
  }
}

function waitForProcess(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('PowerShell VM helper timed out.'));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-vm-protect-'));
  const settings = new Map();
  const db = {
    getSetting: key => settings.get(key),
    setSetting: (key, value) => settings.set(key, String(value))
  };
  const service = vmProtect.createVmProtectService({
    userDataDir: tempDir,
    db,
    bindAddress: '127.0.0.1',
    networkInterfaces: () => ({
      'VMware Network Adapter VMnet1': [{ family: 'IPv4', internal: false, address: '127.0.0.1' }]
    }),
    maxFileBytes: 1024 * 1024
  });
  const port = 22000 + crypto.randomInt(0, 1000);
  let lastUploadEvent = null;
  service.events.on('upload', upload => { lastUploadEvent = upload; });

  try {
    await service.start(port);
    const invitation = await service.createEnrollment({
      name: 'Windows Test VM',
      vmId: 'vm_test',
      vmxPath: 'C:\\VMs\\Test\\Test.vmx',
      serverUrls: [`https://127.0.0.1:${port}`],
      alwaysProtect: true
    });
    assert.match(invitation.secret, /^[A-Za-z0-9_-]{40,}$/);
    assert.match(invitation.pairingCode, /^\d{6}$/);
    const invitedState = service.getState();
    assert.strictEqual(invitedState.pendingEnrollments[0].state, 'invited');
    assert.ok(!JSON.stringify(invitedState).includes(invitation.secret));
    const helperPath = path.join(tempDir, 'LabSuite-VM-Protect.ps1');
    await service.writePortableHelper({
      outputPath: helperPath,
      enrollment: invitation,
      name: 'Windows Test VM',
      alwaysProtect: true
    });
    const helperSource = fs.readFileSync(helperPath, 'utf8');
    assert.match(helperSource, /Protect-Token/);
    assert.match(helperSource, /Approve this VM in LabSuite/);
    if (process.platform === 'win32') {
      const escapedHelperPath = helperPath.replace(/'/g, "''");
      const parserErrors = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${escapedHelperPath}', [ref]$tokens, [ref]$errors) | Out-Null; $errors.Count`
      ], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
      assert.strictEqual(parserErrors, '0', 'Generated PowerShell helper must parse without errors.');
    }

    const enrollBody = {
      enrollmentId: invitation.enrollmentId,
      secret: invitation.secret,
      name: 'Windows Test VM',
      machineName: 'TEST-GUEST',
      selectedFiles: ['C:\\Users\\Test\\Desktop\\notes.txt']
    };
    const pending = await requestJson(port, '/enroll', { body: enrollBody });
    assert.strictEqual(pending.statusCode, 202);
    assert.strictEqual(pending.payload.pending, true);
    assert.strictEqual(pending.payload.pairingCode, invitation.pairingCode);
    const pendingState = service.getState();
    assert.strictEqual(pendingState.pendingEnrollments.length, 1);
    assert.ok(!JSON.stringify(pendingState).includes(invitation.secret), 'Public state must not expose the invitation secret.');

    assert.strictEqual(service.approveEnrollment(invitation.enrollmentId).success, true);
    const enrolled = await requestJson(port, '/enroll', { body: enrollBody });
    assert.strictEqual(enrolled.statusCode, 200);
    assert.strictEqual(enrolled.payload.success, true);
    assert.ok(Number.isSafeInteger(enrolled.payload.serverTimeMs), 'Enrollment must return host time for clock-skew correction.');
    assert.ok(enrolled.payload.guestId);
    assert.ok(enrolled.payload.token);

    const fileBody = Buffer.from('VM Protect integration test\n', 'utf8');
    const contentSha256 = crypto.createHash('sha256').update(fileBody).digest('hex');
    const guestPath = 'C:\\Users\\Test\\Desktop\\notes.txt';
    const uploadPath = `/upload?path=${encodeURIComponent(guestPath)}`;
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const signature = vmProtect.makeSignature(
      enrolled.payload.token,
      'POST',
      uploadPath,
      timestamp,
      nonce,
      fileBody.length,
      contentSha256
    );
    const headers = {
      'x-labsuite-guest-id': enrolled.payload.guestId,
      'x-labsuite-timestamp': timestamp,
      'x-labsuite-nonce': nonce,
      'x-content-sha256': contentSha256,
      'x-labsuite-signature': signature
    };
    const uploaded = await requestJson(port, uploadPath, { body: fileBody, raw: true, headers });
    assert.strictEqual(uploaded.statusCode, 200);
    assert.strictEqual(uploaded.payload.sha256, contentSha256);

    const expectedPath = path.join(
      tempDir,
      'vm-protect-staging',
      enrolled.payload.guestId,
      'C',
      'Users',
      'Test',
      'Desktop',
      'notes.txt'
    );
    assert.strictEqual(fs.readFileSync(expectedPath, 'utf8'), fileBody.toString('utf8'));
    assert.ok(lastUploadEvent && fs.existsSync(lastUploadEvent.revisionPath), 'Every received version must have an immutable staged revision.');
    assert.strictEqual(service.getState().guests[0].stagingBytes, fileBody.length * 2);

    const replay = await requestJson(port, uploadPath, { body: fileBody, raw: true, headers });
    assert.strictEqual(replay.statusCode, 409, 'A replayed signed request must be rejected.');

    const unauthorizedPath = `/upload?path=${encodeURIComponent('C:\\Users\\Test\\Desktop\\not-approved.txt')}`;
    const unauthorizedTimestamp = String(Date.now());
    const unauthorizedNonce = crypto.randomBytes(16).toString('hex');
    const unauthorizedHeaders = {
      'x-labsuite-guest-id': enrolled.payload.guestId,
      'x-labsuite-timestamp': unauthorizedTimestamp,
      'x-labsuite-nonce': unauthorizedNonce,
      'x-content-sha256': contentSha256,
      'x-labsuite-signature': vmProtect.makeSignature(
        enrolled.payload.token,
        'POST',
        unauthorizedPath,
        unauthorizedTimestamp,
        unauthorizedNonce,
        fileBody.length,
        contentSha256
      )
    };
    const unauthorized = await requestJson(port, unauthorizedPath, { body: fileBody, raw: true, headers: unauthorizedHeaders });
    assert.strictEqual(unauthorized.statusCode, 403, 'A paired guest must not upload paths outside its approved selection.');
    assert.ok(!JSON.stringify(service.getState()).includes(enrolled.payload.token), 'Public state must not expose guest tokens.');
    assert.throws(() => vmProtect.normalizeGuestAbsolutePath('..\\escape.txt'));

    const bulkInvitation = await service.createEnrollment({
      name: 'Bulk Passwordless Helper',
      serverUrls: [`https://127.0.0.1:${port}`],
      selectedFiles: ['C:\\Users\\Shared\\Desktop\\watched.txt'],
      multiUse: true,
      autoApprove: true,
      maxGuests: 2
    });
    assert.strictEqual(bulkInvitation.multiUse, true);
    assert.strictEqual(bulkInvitation.autoApprove, true);
    const bulkOne = await requestJson(port, '/enroll', {
      body: {
        enrollmentId: bulkInvitation.enrollmentId,
        secret: bulkInvitation.secret,
        name: 'Bulk VM One',
        machineName: 'BULK-ONE',
        selectedFiles: ['C:\\Users\\Shared\\Desktop\\watched.txt']
      }
    });
    const bulkTwo = await requestJson(port, '/enroll', {
      body: {
        enrollmentId: bulkInvitation.enrollmentId,
        secret: bulkInvitation.secret,
        name: 'Bulk VM Two',
        machineName: 'BULK-TWO',
        selectedFiles: ['C:\\Users\\Shared\\Desktop\\watched.txt']
      }
    });
    assert.strictEqual(bulkOne.statusCode, 200, 'Bulk helpers should pair without per-VM approval.');
    assert.strictEqual(bulkTwo.statusCode, 200, 'A multi-use helper should enroll more than one VM.');
    assert.notStrictEqual(bulkOne.payload.guestId, bulkTwo.payload.guestId, 'Each bulk-enrolled VM must receive a separate guest identity.');
    const bulkFull = await requestJson(port, '/enroll', {
      body: {
        enrollmentId: bulkInvitation.enrollmentId,
        secret: bulkInvitation.secret,
        name: 'Bulk VM Three',
        machineName: 'BULK-THREE',
        selectedFiles: ['C:\\Users\\Shared\\Desktop\\watched.txt']
      }
    });
    assert.strictEqual(bulkFull.statusCode, 403, 'Bulk helpers must honor their configured VM limit.');

    const fakeVmx = path.join(tempDir, 'Direct Test.vmx');
    const directHelper = path.join(tempDir, 'Direct Helper.ps1');
    fs.writeFileSync(fakeVmx, 'displayName = "Direct Test"\n', 'utf8');
    fs.copyFileSync(helperPath, directHelper);
    const spawnCalls = [];
    const fakeSpawn = (executable, args, options) => {
      spawnCalls.push({ executable, args: [...args], options: { ...options } });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => child.emit('close', 0));
      return child;
    };
    const deployService = vmProtect.createVmProtectService({ userDataDir: tempDir, db, spawn: fakeSpawn });
    const directResult = await deployService.deployHelper({
      vmxPath: fakeVmx,
      vmrunPath: process.execPath,
      helperPath: directHelper,
      username: 'vm-user',
      password: 'temporary-secret'
    });
    assert.strictEqual(directResult.launched, true);
    assert.strictEqual(spawnCalls.length, 3);
    assert.ok(spawnCalls.every(call => call.options.shell === false), 'Direct deployment must never use a shell command string.');
    assert.ok(spawnCalls.every(call => call.args.includes('temporary-secret')), 'vmrun guest credentials must be passed only in the argument array.');
    assert.ok(!JSON.stringify(directResult).includes('temporary-secret'), 'Direct-deploy results must not return the guest password.');

    if (process.platform === 'win32') {
      const guestProfile = path.join(tempDir, 'guest-profile');
      const runtimeFile = path.join(tempDir, 'nasa.dream17', 'Other computers', 'octo', 'Documents', 'paula.txt');
      const runtimeHelper = path.join(tempDir, 'Runtime-VM-Protect.ps1');
      fs.mkdirSync(guestProfile, { recursive: true });
      fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
      fs.writeFileSync(runtimeFile, 'runtime helper test\n', 'utf8');
      const runtimeInvitation = await service.createEnrollment({
        name: 'PowerShell Runtime VM',
        serverUrls: [`https://127.0.0.1:${port}`],
        selectedFiles: [runtimeFile]
      });
      await service.writePortableHelper({
        outputPath: runtimeHelper,
        enrollment: runtimeInvitation,
        name: 'PowerShell Runtime VM',
        selectedFiles: [runtimeFile],
        alwaysProtect: false,
        pollSeconds: 10
      });
      let runtimeUploads = 0;
      const canonicalRuntimeFile = canonicalExistingPath(runtimeFile);
      service.events.on('upload', upload => {
        if (canonicalExistingPath(String(upload.guestPath)) === canonicalRuntimeFile) runtimeUploads += 1;
      });
      const helperEnv = { ...process.env, LOCALAPPDATA: guestProfile };
      const firstRun = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runtimeHelper, '-NoPicker', '-NoPause'
      ], { env: helperEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let firstRunOutput = '';
      firstRun.stdout.on('data', chunk => { firstRunOutput += chunk.toString(); });
      firstRun.stderr.on('data', chunk => { firstRunOutput += chunk.toString(); });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const pendingEnrollment = service.getState().pendingEnrollments.find(item => item.enrollmentId === runtimeInvitation.enrollmentId);
        if (pendingEnrollment && pendingEnrollment.state === 'pending') break;
        await wait(50);
      }
      assert.strictEqual(service.approveEnrollment(runtimeInvitation.enrollmentId).success, true);
      assert.strictEqual(
        await waitForProcess(firstRun),
        0,
        `Portable helper should enroll and upload successfully in Windows PowerShell.\n${firstRunOutput.trim()}`
      );
      assert.strictEqual(
        runtimeUploads,
        1,
        `Initial helper run should upload the selected file exactly once.\n${firstRunOutput.trim()}`
      );

      const watcherRun = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runtimeHelper, '-RunWatcher', '-NoPicker', '-NoPause'
      ], { env: helperEnv, windowsHide: true, stdio: 'ignore' });
      await wait(2500);
      try { watcherRun.kill(); } catch (_) {}
      await waitForProcess(watcherRun, 5000).catch(() => null);
      assert.strictEqual(runtimeUploads, 1, 'The watcher must seed persisted stamps instead of reuploading unchanged files at login.');

      const bulkRuntimeHelper = path.join(tempDir, 'Bulk-Runtime-VM-Protect.ps1');
      const bulkRuntimeInvitation = await service.createEnrollment({
        name: 'PowerShell Bulk Runtime VM',
        serverUrls: [`https://127.0.0.1:${port}`],
        selectedFiles: [runtimeFile],
        multiUse: true,
        autoApprove: true,
        maxGuests: 10
      });
      await service.writePortableHelper({
        outputPath: bulkRuntimeHelper,
        enrollment: bulkRuntimeInvitation,
        name: 'PowerShell Bulk Runtime VM',
        selectedFiles: [runtimeFile],
        alwaysProtect: false,
        pollSeconds: 10
      });
      const bulkRun = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bulkRuntimeHelper, '-NoPicker', '-NoPause'
      ], { env: helperEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let bulkRunOutput = '';
      bulkRun.stdout.on('data', chunk => { bulkRunOutput += chunk.toString(); });
      bulkRun.stderr.on('data', chunk => { bulkRunOutput += chunk.toString(); });
      assert.strictEqual(
        await waitForProcess(bulkRun),
        0,
        `Bulk PowerShell helper should auto-enroll and upload successfully.\n${bulkRunOutput.trim()}`
      );
      assert.match(bulkRunOutput, /different VM Protect pairing was found/i, 'A new bulk helper must replace an existing VM pairing.');
      assert.match(bulkRunOutput, /One-time protection finished/i);
      assert.strictEqual(runtimeUploads, 2, 'A new bulk helper must enroll and upload instead of silently reusing the old pairing.');
      const replacedState = JSON.parse(fs.readFileSync(path.join(guestProfile, 'LabSuiteVMProtect', 'state.json'), 'utf8').replace(/^\uFEFF/, ''));
      assert.strictEqual(replacedState.enrollmentId, bulkRuntimeInvitation.enrollmentId, 'Local state must record which helper created the pairing.');
      assert.ok(fs.existsSync(path.join(guestProfile, 'LabSuiteVMProtect', 'last-run.log')), 'The helper must preserve a local diagnostic log.');

      const emptyProfile = path.join(tempDir, 'empty-guest-profile');
      const emptyRuntimeHelper = path.join(tempDir, 'Empty-Runtime-VM-Protect.ps1');
      fs.mkdirSync(emptyProfile, { recursive: true });
      const emptyInvitation = await service.createEnrollment({
        name: 'PowerShell Empty Runtime VM',
        serverUrls: [`https://127.0.0.1:${port}`],
        multiUse: true,
        autoApprove: true,
        maxGuests: 10
      });
      await service.writePortableHelper({
        outputPath: emptyRuntimeHelper,
        enrollment: emptyInvitation,
        name: 'PowerShell Empty Runtime VM',
        alwaysProtect: false
      });
      const emptyRun = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', emptyRuntimeHelper, '-NoPicker', '-NoPause'
      ], { env: { ...process.env, LOCALAPPDATA: emptyProfile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let emptyRunOutput = '';
      emptyRun.stdout.on('data', chunk => { emptyRunOutput += chunk.toString(); });
      emptyRun.stderr.on('data', chunk => { emptyRunOutput += chunk.toString(); });
      assert.notStrictEqual(await waitForProcess(emptyRun), 0, 'A helper with no selected files must fail visibly.');
      assert.match(emptyRunOutput, /LabSuite VM Protect could not finish setup/i);
      assert.match(emptyRunOutput, /No files were selected/i);
      assert.match(emptyRunOutput, /LabSuite VM Protect diagnostic/i);
      assert.match(emptyRunOutput, /Network profiles:/i);
      assert.ok(fs.existsSync(path.join(emptyProfile, 'LabSuiteVMProtect', 'diagnostic.txt')), 'Startup failures must create a copyable diagnostic report.');
      const failureDiagnostic = fs.readFileSync(path.join(emptyProfile, 'LabSuiteVMProtect', 'diagnostic.txt'), 'utf8');
      assert.match(failureDiagnostic, /Failure:[\s\S]*No files were selected/i);
      assert.match(failureDiagnostic, /Receiver endpoints:[\s\S]*127\.0\.0\.1[\s\S]*REACHABLE/i);
      assert.ok(!failureDiagnostic.includes(emptyInvitation.secret), 'Diagnostics must never expose the enrollment secret.');
      assert.match(
        fs.readFileSync(path.join(emptyProfile, 'LabSuiteVMProtect', 'last-run.log'), 'utf8'),
        /ERROR: No files were selected/i,
        'Startup failures must be written to the local diagnostic log'
      );

      const diagnosticRun = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', emptyRuntimeHelper, '-Diagnostics', '-NoPause'
      ], { env: { ...process.env, LOCALAPPDATA: emptyProfile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let diagnosticRunOutput = '';
      diagnosticRun.stdout.on('data', chunk => { diagnosticRunOutput += chunk.toString(); });
      diagnosticRun.stderr.on('data', chunk => { diagnosticRunOutput += chunk.toString(); });
      assert.strictEqual(await waitForProcess(diagnosticRun), 0, `Manual diagnostic mode should succeed.\n${diagnosticRunOutput.trim()}`);
      assert.match(diagnosticRunOutput, /manual diagnostic run/i);

      const skewHostDir = path.join(tempDir, 'clock-skew-host');
      const skewGuestProfile = path.join(tempDir, 'clock-skew-guest');
      const skewRuntimeFile = path.join(tempDir, 'clock skew files', 'protected file.txt');
      const skewRuntimeHelper = path.join(tempDir, 'Clock-Skew-VM-Protect.ps1');
      fs.mkdirSync(path.dirname(skewRuntimeFile), { recursive: true });
      fs.mkdirSync(skewGuestProfile, { recursive: true });
      fs.writeFileSync(skewRuntimeFile, 'clock skew upload test\n', 'utf8');
      const skewSettings = new Map();
      const skewService = vmProtect.createVmProtectService({
        userDataDir: skewHostDir,
        db: {
          getSetting: key => skewSettings.get(key),
          setSetting: (key, value) => skewSettings.set(key, String(value))
        },
        bindAddress: '127.0.0.1',
        networkInterfaces: () => ({
          'VMware Network Adapter VMnet1': [{ family: 'IPv4', internal: false, address: '127.0.0.1' }]
        }),
        now: () => Date.now() + 10 * 60 * 1000,
        maxFileBytes: 1024 * 1024
      });
      const skewPort = 24000 + crypto.randomInt(0, 1000);
      let skewUploads = 0;
      skewService.events.on('upload', () => { skewUploads += 1; });
      try {
        await skewService.start(skewPort);
        const skewInvitation = await skewService.createEnrollment({
          name: 'Clock Skew Runtime VM',
          serverUrls: [`https://127.0.0.1:${skewPort}`],
          selectedFiles: [skewRuntimeFile],
          multiUse: true,
          autoApprove: true,
          maxGuests: 10
        });
        await skewService.writePortableHelper({
          outputPath: skewRuntimeHelper,
          enrollment: skewInvitation,
          name: 'Clock Skew Runtime VM',
          selectedFiles: [skewRuntimeFile],
          alwaysProtect: false
        });
        const skewRun = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', skewRuntimeHelper, '-NoPicker', '-NoPause'
        ], { env: { ...process.env, LOCALAPPDATA: skewGuestProfile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let skewRunOutput = '';
        skewRun.stdout.on('data', chunk => { skewRunOutput += chunk.toString(); });
        skewRun.stderr.on('data', chunk => { skewRunOutput += chunk.toString(); });
        assert.strictEqual(
          await waitForProcess(skewRun),
          0,
          `The helper must correct a ten-minute VM/host clock difference.\n${skewRunOutput.trim()}`
        );
        assert.strictEqual(skewUploads, 1, 'Clock correction must allow the signed upload.');
      } finally {
        await skewService.stop().catch(() => {});
      }
    }
  } finally {
    await service.stop().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('VM Protect verification passed (approval, bulk helper enrollment, authenticated upload, immutable revisions, allowlist, replay defense, PowerShell watcher).');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
