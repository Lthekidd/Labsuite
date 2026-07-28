const { execFileSync } = require('child_process');

const SERVICE_NAME = 'LabSuite';
const ACCOUNT_NAME = 'master';

let keytar = null;

try {
  keytar = require('keytar');
  console.log('Successfully loaded native keytar for secure credential storage.');
} catch (e) {
  console.warn('Native keytar failed to load. Using OS command-line fallback for credential vault.');
}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script, input = '') {
  const quietScript = `$ProgressPreference = 'SilentlyContinue'\n${script}`;
  return execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePowerShell(quietScript)
  ], {
    input,
    encoding: 'utf8',
    windowsHide: true
  }).trim();
}

function normalizeCredentialKey(value, label) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) {
    throw new Error(`Invalid ${label} for secure credential storage.`);
  }
  return normalized;
}

/**
 * Save a value to the secure OS keychain.
 */
async function setCredential(serviceName, accountName, password) {
  const service = normalizeCredentialKey(serviceName, 'service name');
  const account = normalizeCredentialKey(accountName, 'account name');
  const secret = String(password || '');

  if (keytar) {
    return keytar.setPassword(service, account, secret);
  }

  if (process.platform === 'win32') {
    runPowerShell(`
      [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
      $password = [Console]::In.ReadToEnd()
      $vault = [Windows.Security.Credentials.PasswordVault]::new()
      try {
        $existing = $vault.Retrieve('${service}', '${account}')
        $vault.Remove($existing)
      } catch {}
      $cred = [Windows.Security.Credentials.PasswordCredential]::new('${service}', '${account}', $password)
      $vault.Add($cred)
    `, secret);
    return true;
  } else if (process.platform === 'darwin') {
    execFileSync('security', [
      'add-generic-password',
      '-a', account,
      '-s', service,
      '-w', secret,
      '-U'
    ], { windowsHide: true });
    return true;
  } else {
    throw new Error('OS keychain not supported on this platform');
  }
}

/**
 * Retrieve a value from the secure OS keychain.
 */
async function getCredential(serviceName, accountName) {
  const service = normalizeCredentialKey(serviceName, 'service name');
  const account = normalizeCredentialKey(accountName, 'account name');

  if (keytar) {
    return keytar.getPassword(service, account);
  }

  try {
    if (process.platform === 'win32') {
      const result = runPowerShell(`
        [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
        $vault = [Windows.Security.Credentials.PasswordVault]::new()
        try {
          $cred = $vault.Retrieve('${service}', '${account}')
          $cred.RetrievePassword()
          Write-Output $cred.Password
        } catch {
          exit 1
        }
      `);
      return result || null;
    } else if (process.platform === 'darwin') {
      const result = execFileSync('security', [
        'find-generic-password',
        '-a', account,
        '-s', service,
        '-w'
      ], { encoding: 'utf8', windowsHide: true }).trim();
      return result || null;
    }
  } catch (e) {
    // Credential not found or failed to retrieve
    return null;
  }
  return null;
}

/**
 * Delete a value from the secure OS keychain.
 */
async function deleteCredential(serviceName, accountName) {
  const service = normalizeCredentialKey(serviceName, 'service name');
  const account = normalizeCredentialKey(accountName, 'account name');

  if (keytar) {
    return keytar.deletePassword(service, account);
  }

  try {
    if (process.platform === 'win32') {
      return runPowerShell(`
        [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
        $vault = [Windows.Security.Credentials.PasswordVault]::new()
        try {
          $cred = $vault.Retrieve('${service}', '${account}')
          $vault.Remove($cred)
          Write-Output 'true'
        } catch {
          Write-Output 'false'
        }
      `) === 'true';
    } else if (process.platform === 'darwin') {
      execFileSync('security', [
        'delete-generic-password',
        '-a', account,
        '-s', service
      ], { windowsHide: true });
      return true;
    }
  } catch (e) {
    return false;
  }
  return false;
}

async function setPassword(password) {
  return setCredential(SERVICE_NAME, ACCOUNT_NAME, password);
}

async function getPassword() {
  return getCredential(SERVICE_NAME, ACCOUNT_NAME);
}

async function deletePassword() {
  return deleteCredential(SERVICE_NAME, ACCOUNT_NAME);
}

module.exports = {
  setPassword,
  getPassword,
  deletePassword,
  setCredential,
  getCredential,
  deleteCredential
};
