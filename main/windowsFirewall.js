const { execFile, spawnSync } = require('child_process');

const DISCOVERY_PORT = 41234;
let lastVmProtectFirewall = null;

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

function normalizeFirewallPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('The firewall port must be a whole number between 1 and 65535.');
  }
  return port;
}

function encodePowerShell(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

function getLanRuleDefinitions(filePort) {
  return [
    { name: 'LabSuite Network Drive TCP', protocol: 'TCP', port: normalizeFirewallPort(filePort) },
    { name: 'LabSuite Network Discovery UDP', protocol: 'UDP', port: DISCOVERY_PORT }
  ];
}

function getVmProtectRuleDefinitions(receiverPort) {
  return [
    { name: 'LabSuite VM Protect TCP', protocol: 'TCP', port: normalizeFirewallPort(receiverPort) }
  ];
}

function buildElevatedFirewallScript(rules) {
  const ruleBlocks = rules.map(rule => `@{ Name = '${rule.name}'; Protocol = '${rule.protocol}'; Port = ${rule.port} }`).join(",\n  ");
  return `$ErrorActionPreference = 'Stop'
$netsh = Join-Path $env:SystemRoot 'System32\\netsh.exe'
$rules = @(
  ${ruleBlocks}
)
foreach ($rule in $rules) {
  & $netsh advfirewall firewall delete rule "name=$($rule.Name)" | Out-Null
  & $netsh advfirewall firewall add rule "name=$($rule.Name)" dir=in action=allow "protocol=$($rule.Protocol)" "localport=$($rule.Port)" remoteip=LocalSubnet profile=private,public enable=yes | Out-Null
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
exit 0`;
}

function buildElevatedLanFirewallScript(filePort) {
  return buildElevatedFirewallScript(getLanRuleDefinitions(filePort));
}

function buildElevatedVmProtectFirewallScript(receiverPort) {
  return buildElevatedFirewallScript(getVmProtectRuleDefinitions(receiverPort));
}

function runElevatedPowerShell(script, options = {}) {
  const encodedInnerScript = encodePowerShell(script);
  const outerScript = `$ErrorActionPreference = 'Stop'
try {
  $powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  $process = Start-Process -FilePath $powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${encodedInnerScript}')
  exit $process.ExitCode
} catch {
  Write-Error $_
  exit 1223
}`;

  return new Promise(resolve => {
    execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodePowerShell(outerScript)
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeoutMs || 120000,
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
  const existing = showRule(name);
  const containsPort = new RegExp(`(^|\\D)${String(port)}(\\D|$)`).test(existing.output || '');
  const containsProtocol = new RegExp(`\\b${protocol}\\b`, 'i').test(existing.output || '');
  const containsLocalSubnet = /LocalSubnet/i.test(existing.output || '');
  if (existing.ok && containsPort && containsProtocol && containsLocalSubnet) {
    return { ok: true, existing: true, output: existing.output };
  }

  const args = [
    'advfirewall', 'firewall', 'add', 'rule',
    `name=${name}`,
    'dir=in',
    'action=allow',
    `protocol=${protocol}`,
    `localport=${port}`,
    'enable=yes'
  ];
  if (options.remoteIp) args.push(`remoteip=${options.remoteIp}`);
  if (options.profile) args.push(`profile=${options.profile}`);
  const result = runNetsh(args);
  if (result.ok || /already exists|specified rule already exists/i.test(result.output)) {
    return { ok: true, output: result.output };
  }
  return result;
}

function showRule(name) {
  return runNetsh(['advfirewall', 'firewall', 'show', 'rule', `name=${name}`]);
}

function ensureVmProtectFirewallRule(port) {
  if (process.platform !== 'win32') {
    return { attempted: false, ok: true, message: 'Firewall rule is only needed on Windows.' };
  }

  const normalizedPort = normalizeFirewallPort(port);
  const tcp = addRule('LabSuite VM Protect TCP', 'TCP', normalizedPort, {
    remoteIp: 'LocalSubnet',
    profile: 'private,public'
  });
  const result = {
    attempted: true,
    ok: tcp.ok,
    tcp,
    needsElevation: !tcp.ok,
    message: tcp.ok
      ? 'The VM Protect receiver is allowed from local and VMware networks.'
      : 'Windows needs approval for the VM Protect receiver rule. Select Allow Through Firewall and approve the Windows prompt.'
  };
  lastVmProtectFirewall = result;
  return result;
}

async function ensureVmProtectFirewallRuleAsync(port) {
  return ensureVmProtectFirewallRule(port);
}

async function configureVmProtectFirewallRuleElevated(port, options = {}) {
  if (process.platform !== 'win32') {
    return { attempted: false, elevated: false, ok: true, message: 'Firewall rules are only needed on Windows.' };
  }

  const normalizedPort = normalizeFirewallPort(port);
  const runner = options.runner || runElevatedPowerShell;
  const elevated = await runner(buildElevatedVmProtectFirewallScript(normalizedPort));
  if (!elevated.ok) {
    const canceled = String(elevated.status) === '1223' || /canceled|cancelled|operation was canceled/i.test(elevated.output || '');
    const result = {
      attempted: true,
      elevated: true,
      ok: false,
      canceled,
      needsElevation: true,
      message: canceled
        ? 'Windows firewall approval was canceled. Select Allow Through Firewall when you are ready to approve it.'
        : 'Windows could not add the VM Protect receiver rule. Check Windows Security or your administrator policy.'
    };
    lastVmProtectFirewall = result;
    return result;
  }

  const tcp = showRule('LabSuite VM Protect TCP');
  const result = {
    attempted: true,
    elevated: true,
    ok: tcp.ok,
    tcp,
    needsElevation: !tcp.ok,
    message: tcp.ok
      ? 'Windows firewall now allows the VM Protect receiver from local and VMware networks.'
      : 'Windows reported success, but LabSuite could not verify the VM Protect receiver rule.'
  };
  lastVmProtectFirewall = result;
  return result;
}

function getLastVmProtectFirewallResult() {
  return lastVmProtectFirewall;
}

function ensureLanFirewallRules(filePort) {
  if (process.platform !== 'win32') {
    return { attempted: false, ok: true, message: 'Firewall rule is only needed on Windows.' };
  }

  const normalizedPort = normalizeFirewallPort(filePort);
  const tcp = addRule('LabSuite Network Drive TCP', 'TCP', normalizedPort, {
    remoteIp: 'LocalSubnet',
    profile: 'private,public'
  });
  const udp = addRule('LabSuite Network Discovery UDP', 'UDP', DISCOVERY_PORT, {
    remoteIp: 'LocalSubnet',
    profile: 'private,public'
  });
  const ok = tcp.ok && udp.ok;

  return {
    attempted: true,
    ok,
    tcp,
    udp,
    needsElevation: !ok,
    message: ok
      ? 'Windows firewall rules are ready.'
      : 'Windows needs approval to add the Network Drive firewall rules. Select Allow Through Firewall and approve the Windows prompt.'
  };
}

async function configureLanFirewallRulesElevated(filePort, options = {}) {
  if (process.platform !== 'win32') {
    return { attempted: false, elevated: false, ok: true, message: 'Firewall rules are only needed on Windows.' };
  }

  const normalizedPort = normalizeFirewallPort(filePort);
  const runner = options.runner || runElevatedPowerShell;
  const elevated = await runner(buildElevatedLanFirewallScript(normalizedPort));
  if (!elevated.ok) {
    const canceled = String(elevated.status) === '1223' || /canceled|cancelled|operation was canceled/i.test(elevated.output || '');
    return {
      attempted: true,
      elevated: true,
      ok: false,
      canceled,
      needsElevation: true,
      message: canceled
        ? 'Windows firewall approval was canceled. Select Allow Through Firewall when you are ready to approve it.'
        : 'Windows could not add the Network Drive firewall rules. Check Windows Security or your administrator policy.'
    };
  }

  const tcp = showRule('LabSuite Network Drive TCP');
  const udp = showRule('LabSuite Network Discovery UDP');
  const ok = tcp.ok && udp.ok;
  return {
    attempted: true,
    elevated: true,
    ok,
    tcp,
    udp,
    needsElevation: !ok,
    message: ok
      ? 'Windows firewall now allows LabSuite Network Drive on the local subnet.'
      : 'Windows reported success, but LabSuite could not verify both firewall rules.'
  };
}

module.exports = {
  ensureLanFirewallRules,
  configureLanFirewallRulesElevated,
  ensureVmProtectFirewallRule,
  ensureVmProtectFirewallRuleAsync,
  configureVmProtectFirewallRuleElevated,
  getLastVmProtectFirewallResult,
  DISCOVERY_PORT,
  __private: {
    normalizeFirewallPort,
    getLanRuleDefinitions,
    getVmProtectRuleDefinitions,
    buildElevatedFirewallScript,
    buildElevatedLanFirewallScript,
    buildElevatedVmProtectFirewallScript,
    encodePowerShell
  }
};
