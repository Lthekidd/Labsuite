const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vmDiscovery = require('../main/vmDiscovery');

const fsp = fs.promises;

async function main() {
  const normalized = vmDiscovery.normalizeVmxPath('file:///C:/Users/Test/Virtual%20Machines/Demo/Demo.vmx');
  assert.strictEqual(normalized, 'C:\\Users\\Test\\Virtual Machines\\Demo\\Demo.vmx');
  assert.strictEqual(
    vmDiscovery.stableVmId('C:\\VMs\\Demo\\Demo.vmx'),
    vmDiscovery.stableVmId('c:/vms/demo/demo.vmx'),
    'VM IDs must be stable across Windows path casing and slash styles'
  );

  const metadata = vmDiscovery.parseVmxMetadata([
    '.encoding = "UTF-8"',
    'displayName = "Windows 11 Lab"',
    'guestOS = "windows11-64"',
    'uuid.bios = "56 4d 12 34-abcd"'
  ].join('\n'));
  assert.deepStrictEqual(metadata, {
    displayName: 'Windows 11 Lab',
    guestOS: 'windows11-64',
    vmwareUuid: '56 4d 12 34-abcd'
  });
  assert.strictEqual(
    vmDiscovery.stableVmId('C:\\moved\\Demo.vmx', metadata.vmwareUuid),
    vmDiscovery.stableVmId('D:\\renamed\\Demo.vmx', metadata.vmwareUuid),
    'VM IDs should follow VMware UUIDs when a VM is moved'
  );

  const inventoryText = [
    'vmlist0.config = "C:\\Users\\Test\\Documents\\Virtual Machines\\Windows 11\\Windows 11.vmx"',
    'vmlist0.DisplayName = "Windows 11 Lab"',
    'pref.mruVM0.filename = "C:\\Users\\Test\\Documents\\Virtual Machines\\Windows 11\\Windows 11.vmx"'
  ].join('\n');
  const inventory = vmDiscovery.parseInventoryText(inventoryText, {
    sourcePath: 'C:\\Users\\Test\\AppData\\Roaming\\VMware\\inventory.vmls'
  });
  assert.strictEqual(inventory.length, 1, 'Duplicate inventory references should collapse to one VM');
  assert.strictEqual(inventory[0].name, 'Windows 11 Lab');

  const quotedCommand = '"C:\\Program Files\\VMware\\VMware Workstation\\x64\\vmware-vmx.exe" -s foo=bar "C:\\Users\\Test\\Virtual Machines\\Demo VM\\Demo VM.vmx"';
  assert.deepStrictEqual(
    vmDiscovery.extractVmxPathsFromCommandLine(quotedCommand),
    ['C:\\Users\\Test\\Virtual Machines\\Demo VM\\Demo VM.vmx']
  );
  const unquotedCommand = 'C:\\VMware\\vmware-vmx.exe -s vmx.noUI=true C:\\VMs\\Demo VM\\Demo VM.vmx';
  assert.deepStrictEqual(
    vmDiscovery.extractVmxPathsFromCommandLine(unquotedCommand),
    ['C:\\VMs\\Demo VM\\Demo VM.vmx']
  );

  const processOutput = JSON.stringify([
    { ProcessId: 41, CommandLine: quotedCommand },
    { ProcessId: 42, CommandLine: null }
  ]);
  assert.deepStrictEqual(
    vmDiscovery.parsePowerShellProcessOutput(processOutput),
    ['C:\\Users\\Test\\Virtual Machines\\Demo VM\\Demo VM.vmx']
  );
  assert.deepStrictEqual(
    vmDiscovery.parseVmrunListOutput('Total running VMs: 1\r\nC:\\VMs\\Demo VM\\Demo VM.vmx\r\n'),
    ['C:\\VMs\\Demo VM\\Demo VM.vmx']
  );

  const merged = vmDiscovery.normalizeVmCandidates([
    { vmxPath: 'C:\\VMs\\Demo\\Demo.vmx', source: 'inventory', name: 'Demo' },
    { vmxPath: 'c:/vms/demo/demo.vmx', source: 'running', running: true },
    { vmxPath: 'C:\\VMs\\Other\\Other.vmx', source: 'scan' }
  ]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].running, true);
  assert.deepStrictEqual(merged[0].sources, ['running', 'inventory']);

  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'labsuite-vm-discovery-'));
  try {
    const vmFolder = path.join(temporaryRoot, 'Nested', 'Demo VM');
    await fsp.mkdir(vmFolder, { recursive: true });
    const vmxPath = path.join(vmFolder, 'Demo VM.vmx');
    await fsp.writeFile(vmxPath, 'displayName = "Discovered Demo"\nguestOS = "windows11-64"\n', 'utf8');

    const scan = await vmDiscovery.scanVmRoots([temporaryRoot], {
      maxDepth: 3,
      maxDirectories: 20,
      maxVms: 10
    });
    assert.deepStrictEqual(scan.paths, [vmxPath]);
    assert.strictEqual(scan.truncated, false);
    assert(scan.visitedDirectories <= 20, 'Scan must honor its directory bound');

    const fakeVmrun = path.join(temporaryRoot, 'vmrun.exe');
    await fsp.writeFile(fakeVmrun, 'not executed', 'utf8');
    const vmrun = await vmDiscovery.findVmrun({
      platform: 'win32',
      env: { PATH: temporaryRoot },
      standardPaths: [],
      queryRegistry: false
    });
    assert.strictEqual(vmrun.path, fakeVmrun);
    assert.strictEqual(vmrun.source, 'path');

    const inventoryFile = path.join(temporaryRoot, 'inventory.vmls');
    await fsp.writeFile(inventoryFile, `vmlist0.config = "${vmxPath}"\n`, 'utf8');
    const result = await vmDiscovery.discoverVMs({
      platform: 'win32',
      vmrunPath: null,
      runningVmxPaths: [vmxPath],
      inventoryFiles: [inventoryFile],
      commonRoots: [temporaryRoot],
      scanLimits: { maxDepth: 3, maxDirectories: 20, maxVms: 10 }
    });
    assert.strictEqual(result.vms.length, 1, 'End-to-end discovery should deduplicate all sources');
    assert.strictEqual(result.vms[0].name, 'Discovered Demo');
    assert.strictEqual(result.vms[0].guestOS, 'windows11-64');
    assert.strictEqual(result.vms[0].running, true);
    assert.strictEqual(result.vms[0].available, true);
    assert.strictEqual(result.status.code, 'limited');
    assert.strictEqual(result.capabilities.canAttemptDirectHelperPush, false);
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }

  console.log('VM discovery verification passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
