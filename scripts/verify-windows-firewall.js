const assert = require('assert');
const windowsFirewall = require('../main/windowsFirewall');

const {
  normalizeFirewallPort,
  getLanRuleDefinitions,
  getVmProtectRuleDefinitions,
  buildElevatedLanFirewallScript,
  buildElevatedVmProtectFirewallScript,
  encodePowerShell
} = windowsFirewall.__private;

assert.strictEqual(normalizeFirewallPort('41235'), 41235);
assert.throws(() => normalizeFirewallPort('41235; Remove-Item C:\\'), /whole number/);
assert.throws(() => normalizeFirewallPort(0), /between 1 and 65535/);
assert.throws(() => normalizeFirewallPort(65536), /between 1 and 65535/);

assert.deepStrictEqual(getLanRuleDefinitions(41235), [
  { name: 'LabSuite Network Drive TCP', protocol: 'TCP', port: 41235 },
  { name: 'LabSuite Network Discovery UDP', protocol: 'UDP', port: windowsFirewall.DISCOVERY_PORT }
]);
assert.deepStrictEqual(getVmProtectRuleDefinitions(41443), [
  { name: 'LabSuite VM Protect TCP', protocol: 'TCP', port: 41443 }
]);

const script = buildElevatedLanFirewallScript(41235);
assert.ok(script.includes("Name = 'LabSuite Network Drive TCP'"));
assert.ok(script.includes("Name = 'LabSuite Network Discovery UDP'"));
assert.ok(script.includes('remoteip=LocalSubnet'));
assert.ok(script.includes('profile=private,public'));
assert.ok(script.includes('localport=$($rule.Port)'));
assert.ok(script.includes('delete rule'));
assert.ok(script.includes('add rule'));

const encoded = encodePowerShell(script);
assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf16le'), script);

const vmScript = buildElevatedVmProtectFirewallScript(41443);
assert.ok(vmScript.includes("Name = 'LabSuite VM Protect TCP'"));
assert.ok(vmScript.includes('Port = 41443'));
assert.ok(vmScript.includes('remoteip=LocalSubnet'));
assert.ok(vmScript.includes('profile=private,public'));
assert.ok(!vmScript.includes('Network Discovery'));

console.log('Windows firewall verification passed (LAN and VM Protect validated ports, scoped rules, and elevated scripts).');
