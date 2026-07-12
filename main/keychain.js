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
  return execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePowerShell(script)
  ], {
    input,
    encoding: 'utf8',
    windowsHide: true
  }).trim();
}

/**
 * Save password to secure OS keychain
 */
async function setPassword(password) {
  if (keytar) {
    return keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, password);
  }

  if (process.platform === 'win32') {
    runPowerShell(`
      [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
      $password = [Console]::In.ReadToEnd()
      $vault = [Windows.Security.Credentials.PasswordVault]::new()
      try {
        $existing = $vault.Retrieve('${SERVICE_NAME}', '${ACCOUNT_NAME}')
        $vault.Remove($existing)
      } catch {}
      $cred = [Windows.Security.Credentials.PasswordCredential]::new('${SERVICE_NAME}', '${ACCOUNT_NAME}', $password)
      $vault.Add($cred)
    `, password);
    return true;
  } else if (process.platform === 'darwin') {
    execFileSync('security', [
      'add-generic-password',
      '-a', ACCOUNT_NAME,
      '-s', SERVICE_NAME,
      '-w', password,
      '-U'
    ], { windowsHide: true });
    return true;
  } else {
    throw new Error('OS keychain not supported on this platform');
  }
}

/**
 * Retrieve password from secure OS keychain
 */
async function getPassword() {
  if (keytar) {
    return keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  }

  try {
    if (process.platform === 'win32') {
      const result = runPowerShell(`
        [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
        $vault = [Windows.Security.Credentials.PasswordVault]::new()
        try {
          $cred = $vault.Retrieve('${SERVICE_NAME}', '${ACCOUNT_NAME}')
          Write-Output $cred.Password
        } catch {
          exit 1
        }
      `);
      return result || null;
    } else if (process.platform === 'darwin') {
      const result = execFileSync('security', [
        'find-generic-password',
        '-a', ACCOUNT_NAME,
        '-s', SERVICE_NAME,
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
 * Delete password from secure OS keychain
 */
async function deletePassword() {
  if (keytar) {
    return keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
  }

  try {
    if (process.platform === 'win32') {
      return runPowerShell(`
        [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
        $vault = [Windows.Security.Credentials.PasswordVault]::new()
        try {
          $cred = $vault.Retrieve('${SERVICE_NAME}', '${ACCOUNT_NAME}')
          $vault.Remove($cred)
          Write-Output 'true'
        } catch {
          Write-Output 'false'
        }
      `) === 'true';
    } else if (process.platform === 'darwin') {
      execFileSync('security', [
        'delete-generic-password',
        '-a', ACCOUNT_NAME,
        '-s', SERVICE_NAME
      ], { windowsHide: true });
      return true;
    }
  } catch (e) {
    return false;
  }
  return false;
}

module.exports = {
  setPassword,
  getPassword,
  deletePassword
};
