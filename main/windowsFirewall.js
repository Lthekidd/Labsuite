const { execFile, spawnSync } = require('child_process');

const DISCOVERY_PORT = 41234;

function runNetsh(args) {
  const result = spawnSync('netsh.exe', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  });

  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim()
  };
}

function runNetshAsync(args) {
  return new Promise(resolve => {
    execFile('netsh.exe', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        status: error && error.code,
        output: `${stdout || ''}${stderr || ''}`.trim()
      });
    });
  });
}

function addRule(name, protocol, port, options = {}) {
  const args = [
    'advfirewall', 'firewall', 'add', 'rule',
    `name=${name}`,
    'dir=in',
    'action=allow',
    `protocol=${protocol}`,
    `localport=${port}`
  ];
  if (options.remoteIp) args.push(`remoteip=${options.remoteIp}`);
  if (options.profile) args.push(`profile=${options.profile}`);
  const result = runNetsh(args);
  if (result.ok || /already exists|specified rule already exists/i.test(result.output)) {
    return { ok: true, output: result.output };
  }
  return result;
}

function ensureVmProtectFirewallRule(port) {
  if (process.platform !== 'win32') {
    return { attempted: false, ok: true, message: 'Firewall rule is only needed on Windows.' };
  }

  const tcp = addRule('LabSuite VM Protect TCP', 'TCP', port, {
    remoteIp: 'LocalSubnet',
    profile: 'private,public'
  });
  return {
    attempted: true,
    ok: tcp.ok,
    tcp,
    message: tcp.ok
      ? 'The VM Protect receiver is allowed from local and VMware networks.'
      : 'Windows Firewall could not be configured automatically. Allow LabSuite on VMware networks or run it once as administrator.'
  };
}

async function ensureVmProtectFirewallRuleAsync(port) {
  if (process.platform !== 'win32') {
    return { attempted: false, ok: true, message: 'Firewall rule is only needed on Windows.' };
  }

  const name = 'LabSuite VM Protect TCP';
  let tcp = await runNetshAsync([
    'advfirewall', 'firewall', 'set', 'rule',
    `name=${name}`,
    'new',
    'enable=yes',
    'dir=in',
    'action=allow',
    'protocol=TCP',
    `localport=${port}`,
    'remoteip=LocalSubnet',
    'profile=private,public'
  ]);
  if (!tcp.ok) {
    await runNetshAsync(['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`]);
    tcp = await runNetshAsync([
      'advfirewall', 'firewall', 'add', 'rule',
      `name=${name}`,
      'dir=in',
      'action=allow',
      'protocol=TCP',
      `localport=${port}`,
      'remoteip=LocalSubnet',
      'profile=private,public'
    ]);
  }
  return {
    attempted: true,
    ok: tcp.ok,
    tcp,
    message: tcp.ok
      ? 'The VM Protect receiver is allowed from local and VMware networks.'
      : 'Windows Firewall could not be configured automatically. Allow LabSuite on VMware networks or run it once as administrator.'
  };
}

function ensureLanFirewallRules(filePort) {
  if (process.platform !== 'win32') {
    return { attempted: false, ok: true, message: 'Firewall rule is only needed on Windows.' };
  }

  const tcp = addRule('LabSuite Network Drive TCP', 'TCP', filePort);
  const udp = addRule('LabSuite Network Discovery UDP', 'UDP', DISCOVERY_PORT);
  const ok = tcp.ok && udp.ok;

  return {
    attempted: true,
    ok,
    tcp,
    udp,
    message: ok
      ? 'Windows firewall rules are ready.'
      : 'Windows firewall rule could not be added automatically. Run LabSuite as administrator or allow it in Windows Security.'
  };
}

module.exports = {
  ensureLanFirewallRules,
  ensureVmProtectFirewallRule,
  ensureVmProtectFirewallRuleAsync,
  DISCOVERY_PORT
};
