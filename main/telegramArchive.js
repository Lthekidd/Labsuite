const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const db = require('./database');
const rclone = require('./rclone');

const activeBackups = new Set();
let schedulerInterval = null;
let scheduledRunActive = false;
const MAX_DIAGNOSTIC_EVENTS = 120;
const MAX_DIAGNOSTIC_BYTES = 512 * 1024;

function hashId(value, length = 24) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, length);
}

function getUserDataRoot() {
  try {
    const { app } = require('electron');
    return app.getPath('userData');
  } catch (_) {
    return path.join(__dirname, '../data');
  }
}

function getArchiveRoot() {
  if (process.env.LABSUITE_TELEGRAM_ARCHIVE_ROOT) {
    return path.resolve(process.env.LABSUITE_TELEGRAM_ARCHIVE_ROOT);
  }
  return path.join(getUserDataRoot(), 'TelegramArchive');
}

function getChatArchiveDir(chatId) {
  const safeId = String(chatId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('Invalid Telegram archive chat id.');
  return path.join(getArchiveRoot(), safeId);
}

function getDiagnosticPaths() {
  const diagnosticDir = path.join(getArchiveRoot(), 'diagnostics');
  return {
    diagnosticDir,
    eventLogPath: path.join(diagnosticDir, 'telegram-failure-log.jsonl')
  };
}

function redactDiagnosticText(value) {
  let text = String(value === undefined || value === null ? '' : value);
  const home = os.homedir();
  if (home) text = text.replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '%USERPROFILE%');
  text = text
    .replace(/(client_secret|access_token|refresh_token|password|token)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/Authorization:\s*(?:Bearer|Basic)\s+[^\s]+/gi, 'Authorization: [REDACTED]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, match => match.replace(/(\\Users\\)[^\\]+/i, '$1[USER]'));
  return text.slice(0, 12000);
}

function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeDiagnosticValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, child]) => [key, sanitizeDiagnosticValue(child, depth + 1)]));
}

function appendDiagnosticEvent(event = {}) {
  try {
    const { diagnosticDir, eventLogPath } = getDiagnosticPaths();
    fs.mkdirSync(diagnosticDir, { recursive: true });
    const safeEvent = sanitizeDiagnosticValue({
      timestamp: new Date().toISOString(),
      outcome: event.outcome || 'info',
      operation: event.operation || 'telegram-archive',
      stage: event.stage || 'unknown',
      message: event.message || '',
      ...event
    });
    fs.appendFileSync(eventLogPath, `${JSON.stringify(safeEvent)}\n`, 'utf8');
    const stat = fs.statSync(eventLogPath);
    if (stat.size > MAX_DIAGNOSTIC_BYTES) {
      const lines = fs.readFileSync(eventLogPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-MAX_DIAGNOSTIC_EVENTS);
      fs.writeFileSync(eventLogPath, `${lines.join('\n')}\n`, 'utf8');
    }
    return safeEvent;
  } catch (_) {
    return null;
  }
}

function readDiagnosticEvents() {
  try {
    const { eventLogPath } = getDiagnosticPaths();
    if (!fs.existsSync(eventLogPath)) return [];
    return fs.readFileSync(eventLogPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-MAX_DIAGNOSTIC_EVENTS)
      .map(line => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function getAppVersion() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getVersion === 'function') return app.getVersion();
  } catch (_) {}
  try { return require('../package.json').version; } catch (_) { return 'unknown'; }
}

function collectWindowsEnvironment() {
  if (process.platform !== 'win32') return { supported: false };
  const script = `
$telegram = @(Get-Process Telegram -ErrorAction SilentlyContinue)
$usable = @($telegram | Where-Object { $_.MainWindowHandle -ne 0 })
$candidatePaths = @(
  (Join-Path $env:APPDATA 'Telegram Desktop\\Telegram.exe'),
  (Join-Path $env:LOCALAPPDATA 'Telegram Desktop\\Telegram.exe')
)
$exePath = $null
foreach ($item in $usable) { try { if ($item.Path) { $exePath = $item.Path; break } } catch {} }
if (-not $exePath) { $exePath = $candidatePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1 }
$version = $null
if ($exePath) { try { $version = (Get-Item -LiteralPath $exePath).VersionInfo.ProductVersion } catch {} }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
[ordered]@{
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  labSuiteElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  telegramRunning = ($telegram.Count -gt 0)
  telegramProcessCount = $telegram.Count
  telegramUsableWindowCount = $usable.Count
  telegramExecutableFound = [bool]$exePath
  telegramExecutablePath = $exePath
  telegramVersion = $version
} | ConvertTo-Json -Compress
`;
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
    ], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `PowerShell exited with code ${result.status}.`);
    return sanitizeDiagnosticValue(JSON.parse(String(result.stdout || '').trim()));
  } catch (error) {
    return { probeError: redactDiagnosticText(error.message || error) };
  }
}

function checkArchiveStorage() {
  const archiveRoot = getArchiveRoot();
  const result = { archiveRoot: redactDiagnosticText(archiveRoot), exists: fs.existsSync(archiveRoot), writable: false };
  try {
    const { diagnosticDir } = getDiagnosticPaths();
    fs.mkdirSync(diagnosticDir, { recursive: true });
    const probePath = path.join(diagnosticDir, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probePath, 'ok', 'utf8');
    fs.unlinkSync(probePath);
    result.exists = true;
    result.writable = true;
  } catch (error) {
    result.error = redactDiagnosticText(error.message || error);
  }
  return result;
}

function getRcloneEnvironment() {
  try {
    const { rcloneBin, configPath } = rclone.getPaths();
    const configuredRemote = rclone.getRemote();
    let sections = [];
    if (fs.existsSync(configPath)) {
      sections = Array.from(fs.readFileSync(configPath, 'utf8').matchAll(/^\s*\[([^\]]+)\]\s*$/gm), match => match[1]);
    }
    return {
      executableFound: fs.existsSync(rcloneBin),
      executablePath: redactDiagnosticText(rcloneBin),
      configFound: fs.existsSync(configPath),
      configPath: redactDiagnosticText(configPath),
      encryptedRemote: configuredRemote,
      encryptedRemoteConfigured: sections.some(section => section.toLowerCase() === configuredRemote.toLowerCase()),
      configuredSections: sections
    };
  } catch (error) {
    return { error: redactDiagnosticText(error.message || error) };
  }
}

function buildFailureReport(options = {}) {
  const events = readDiagnosticEvents();
  const failures = events.filter(event => event.outcome === 'failure');
  let chats = [];
  let sessionInstalls = [];
  try { chats = db.getTelegramArchiveChats(); } catch (_) {}
  try { sessionInstalls = db.getTelegramInstalls(); } catch (_) {}
  const latestFailure = failures[failures.length - 1] || null;
  const recommendations = [
    'Confirm both PCs are running this same LabSuite version.',
    'Keep Telegram Desktop unlocked, visible, and on its main chat list while testing.',
    'Use Telegram Desktop in English; this automation currently matches English accessibility labels.',
    'Run LabSuite and Telegram at the same privilege level (normally both non-administrator).',
    'If local export succeeds but upload fails, reconnect Google Drive/rclone on that PC.'
  ];
  if (latestFailure && latestFailure.operation === 'rclone-upload') {
    recommendations.unshift('The readable local copy completed; focus on the Google Drive/rclone error shown in the latest event.');
  } else if (latestFailure && latestFailure.operation === 'telegram-automation') {
    recommendations.unshift(`Telegram UI automation stopped at '${latestFailure.stage}'. Check Telegram language, lock state, and version.`);
  } else if (latestFailure && latestFailure.operation === 'session-backup') {
    recommendations.unshift(`Telegram session backup stopped at '${latestFailure.stage}'. Use its error and source-path check below.`);
  }
  return sanitizeDiagnosticValue({
    reportType: 'LabSuite Telegram copy failure log',
    generatedAt: new Date().toISOString(),
    privacy: 'No message bodies, media contents, OAuth tokens, or rclone secrets are included.',
    labSuite: {
      version: getAppVersion(),
      packaged: !!process.resourcesPath,
      processElevated: options.skipSystemProbe ? 'not-probed' : undefined
    },
    system: {
      platform: process.platform,
      release: os.release(),
      version: typeof os.version === 'function' ? os.version() : '',
      arch: process.arch,
      computerName: os.hostname(),
      ...(options.skipSystemProbe ? {} : collectWindowsEnvironment())
    },
    telegramCompatibility: {
      requiredInterfaceLanguage: 'English',
      requiredState: 'Unlocked Telegram Desktop main window with accessibility available'
    },
    archiveStorage: checkArchiveStorage(),
    encryptedUpload: getRcloneEnvironment(),
    chatSummary: {
      detected: chats.length,
      selected: chats.filter(chat => chat.selected).length,
      protected: chats.filter(chat => chat.last_backup_status === 'success').length,
      localOnly: chats.filter(chat => chat.last_backup_status === 'local-only').length,
      failed: chats.filter(chat => chat.last_backup_status === 'failed').length
    },
    sessionBackupSummary: sessionInstalls.map(install => ({
      id: install.id,
      label: install.label,
      sourcePath: redactDiagnosticText(install.tdata_path),
      sourceExists: !!install.tdata_path && fs.existsSync(install.tdata_path),
      enabled: install.enabled !== false,
      lastBackupAt: install.last_backup_at,
      lastStatus: install.last_backup_status,
      consecutiveFailures: install.consecutive_failures || 0,
      lastError: redactDiagnosticText(install.last_error || '')
    })),
    latestFailure,
    recentEvents: events.slice(-40),
    recommendations
  });
}

function getFailureLog(options = {}) {
  return JSON.stringify(buildFailureReport(options), null, 2);
}

function automationError(error, action, details = {}) {
  const wrapped = error instanceof Error ? error : new Error(String(error || 'Telegram automation failed.'));
  wrapped.telegramAction = action;
  Object.assign(wrapped, details);
  appendDiagnosticEvent({
    outcome: 'failure',
    operation: 'telegram-automation',
    stage: action,
    message: wrapped.message,
    exitCode: details.exitCode,
    stderrTail: details.stderrTail
  });
  return wrapped;
}

function ensureAutomationScript() {
  const sourcePath = path.join(__dirname, 'telegramArchiveAutomation.ps1');
  const source = fs.readFileSync(sourcePath);
  const digest = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
  const destinationDir = path.join(os.tmpdir(), 'LabSuite_Temp', 'telegram_archive_automation');
  const destinationPath = path.join(destinationDir, `telegram-archive-${digest}.ps1`);
  fs.mkdirSync(destinationDir, { recursive: true });
  if (!fs.existsSync(destinationPath)) fs.writeFileSync(destinationPath, source);
  return destinationPath;
}

function parseAutomationOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (_) {}
  }
  throw new Error('Telegram automation returned no readable result.');
}

function isRetryableScanOutputError(error) {
  return !!(error && error.telegramAction === 'scan' && /returned no readable result/i.test(error.message || ''));
}

function runAutomation(action, payload = {}, options = {}) {
  if (process.platform !== 'win32') {
    return Promise.reject(automationError(new Error('Telegram chat export automation currently requires Windows.'), action));
  }

  const scriptPath = ensureAutomationScript();
  const payloadDir = path.join(os.tmpdir(), 'LabSuite_Temp', 'telegram_archive_payloads');
  fs.mkdirSync(payloadDir, { recursive: true });
  const payloadPath = path.join(payloadDir, `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  const resultPath = `${payloadPath}.result.json`;
  fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Action', action,
      '-PayloadPath', payloadPath,
      '-ResultPath', resultPath
    ], { windowsHide: true });

    let stdout = '';
    let stderr = '';
    const maxOutput = 1024 * 1024;
    const timeoutMs = Number(options.timeoutMs) || 35 * 60 * 1000;
    let settled = false;
    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timeout = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      rejectOnce(automationError(new Error('Telegram automation timed out.'), action, { timeoutMs }));
    }, timeoutMs);
    const cleanupPayloadFiles = () => {
      try { fs.unlinkSync(payloadPath); } catch (_) {}
      try { fs.unlinkSync(resultPath); } catch (_) {}
    };

    child.stdout.on('data', data => {
      if (stdout.length < maxOutput) stdout += data.toString();
    });
    child.stderr.on('data', data => {
      if (stderr.length < maxOutput) stderr += data.toString();
    });
    child.on('error', error => {
      clearTimeout(timeout);
      cleanupPayloadFiles();
      rejectOnce(automationError(error, action));
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
        cleanupPayloadFiles();
        rejectOnce(automationError(
          new Error(detail || `Telegram automation exited with code ${code}.`),
          action,
          { exitCode: code, stderrTail: detail }
        ));
        return;
      }
      try {
        let fileOutput = '';
        try { fileOutput = fs.readFileSync(resultPath, 'utf8'); } catch (_) {}
        cleanupPayloadFiles();
        settled = true;
        try {
          resolve(parseAutomationOutput(fileOutput));
        } catch (_) {
          resolve(parseAutomationOutput(stdout));
        }
      } catch (error) {
        settled = false;
        rejectOnce(automationError(error, action));
      }
    });
  });
}

async function runTelegramExport(payload) {
  const setupTimeout = { timeoutMs: 2 * 60 * 1000 };
  const previousForeground = await runAutomation('foreground', {}, { timeoutMs: 30 * 1000 });
  try {
    if (payload.accountName) {
      const current = await runAutomation('scan', { maxScrolls: 0 }, setupTimeout);
      const currentName = String(current.accounts && current.accounts[0] && current.accounts[0].name || '').trim().toLowerCase();
      const targetName = String(payload.accountName).trim().toLowerCase();
      if (currentName !== targetName) {
        await runAutomation('open-account-switcher', {}, setupTimeout);
        const switcher = await runAutomation('list-account-switcher', {}, setupTimeout);
        const target = (Array.isArray(switcher.accounts) ? switcher.accounts : []).find(account =>
          String(account.buttonName || '').trim().toLowerCase().includes(targetName)
        );
        if (!target) {
          try { await runAutomation('dismiss', {}, setupTimeout); } catch (_) {}
          throw new Error(`Telegram account '${payload.accountName}' is not available in the account switcher.`);
        }
        await runAutomation('switch-account', { buttonName: target.buttonName }, setupTimeout);
      }
    }
    await runAutomation('open-export', payload, setupTimeout);
    const format = await runAutomation('open-format', payload, setupTimeout);
    if (format.needsJsonSelection) {
      await runAutomation('select-json', {}, setupTimeout);
    }
    let dateApplied = false;
    if (payload.checkpointDate) {
      const date = await runAutomation('open-date', payload, setupTimeout);
      if (date.needsDateSelection) {
        await runAutomation('select-date', { targetDate: date.targetDate }, setupTimeout);
        dateApplied = true;
      }
    }
    return await runAutomation('start-export', { ...payload, dateApplied }, {
      timeoutMs: (Number(payload.timeoutSeconds) || 1800) * 1000 + 60 * 1000
    });
  } finally {
    try { await runAutomation('restore-foreground', previousForeground, { timeoutMs: 30 * 1000 }); } catch (_) {}
  }
}

function normalizeChatType(type, name) {
  const value = String(type || '').trim();
  if (String(name || '').trim().toLowerCase() === 'saved messages') return 'Saved Messages';
  return value || 'Chat';
}

function discoveredChatId(accountId, type, name) {
  return `tg_${hashId(`${accountId}\n${String(type).toLowerCase()}\n${String(name).trim().toLowerCase()}`)}`;
}

async function scanChatsWithoutFocusRestore() {
  const scanOptions = { timeoutMs: 3 * 60 * 1000 };
  const firstResult = await runAutomation('scan', { maxScrolls: 60 }, scanOptions);
  const scannedAccounts = [...(Array.isArray(firstResult.accounts) ? firstResult.accounts : [])];
  const accountNames = new Set(scannedAccounts.map(account => String(account.name || '').trim().toLowerCase()));
  const originalAccountName = String(scannedAccounts[0] && scannedAccounts[0].name || '').trim().toLowerCase();

  // Telegram exposes additional signed-in accounts only after expanding the
  // account header in its main menu. Each switch and scan uses a fresh
  // automation process so Qt's accessibility tree is refreshed reliably.
  try {
    await runAutomation('open-account-switcher', {}, { timeoutMs: 30 * 1000 });
    const switcher = await runAutomation('list-account-switcher', {}, { timeoutMs: 30 * 1000 });
    const candidates = (Array.isArray(switcher.accounts) ? switcher.accounts : []).slice(0, 8);
    for (const candidate of candidates) {
      if (!candidate || !candidate.buttonName) continue;
      try {
        await runAutomation('switch-account', { buttonName: candidate.buttonName }, { timeoutMs: 30 * 1000 });
        const accountResult = await runAutomation('scan', { maxScrolls: 60 }, scanOptions);
        for (const account of Array.isArray(accountResult.accounts) ? accountResult.accounts : []) {
          const key = String(account.name || '').trim().toLowerCase();
          if (!accountNames.has(key)) {
            scannedAccounts.push(account);
            accountNames.add(key);
          }
        }
        await runAutomation('open-account-switcher', {}, { timeoutMs: 30 * 1000 });
        await runAutomation('list-account-switcher', {}, { timeoutMs: 30 * 1000 });
      } catch (error) {
        console.warn(`Telegram account scan skipped '${candidate.buttonName}':`, error.message);
        appendDiagnosticEvent({
          outcome: 'failure',
          operation: 'account-scan',
          stage: 'switch-account',
          message: error.message
        });
      }
    }
    if (candidates.length > 0) {
      const original = candidates.find(candidate => String(candidate.buttonName || '').toLowerCase().includes(originalAccountName));
      try {
        if (original) await runAutomation('switch-account', { buttonName: original.buttonName }, { timeoutMs: 30 * 1000 });
        else await runAutomation('dismiss', {}, { timeoutMs: 15 * 1000 });
      } catch (_) {}
    }
  } catch (_) {
    // A single-account Telegram session has no expandable account rows.
  }

  const result = { accounts: scannedAccounts, scannedAt: firstResult.scannedAt };
  const discovered = [];
  for (const account of Array.isArray(result.accounts) ? result.accounts : []) {
    const accountName = String(account.name || 'Telegram account').trim();
    const accountIdentity = String(account.identity || accountName).trim().toLowerCase();
    const accountId = `account_${hashId(accountIdentity, 20)}`;
    for (const chat of Array.isArray(account.chats) ? account.chats : []) {
      const name = String(chat.name || '').trim();
      if (!name) continue;
      const type = normalizeChatType(chat.type, name);
      discovered.push({
        id: discoveredChatId(accountId, type, name),
        account_id: accountId,
        account_name: accountName,
        name,
        type,
        preview: String(chat.preview || ''),
        preview_time: String(chat.time || ''),
        unread: String(chat.unread || ''),
        muted: String(chat.muted || '')
      });
    }
  }
  db.upsertTelegramArchiveChats(discovered);
  return {
    accounts: Array.isArray(result.accounts) ? result.accounts.length : 0,
    chats: discovered.length,
    scannedAt: result.scannedAt || new Date().toISOString(),
    items: getChats()
  };
}

async function scanChats() {
  appendDiagnosticEvent({ outcome: 'started', operation: 'chat-scan', stage: 'starting', message: 'Telegram account and chat scan started.' });
  let previousForeground;
  try {
    previousForeground = await runAutomation('foreground', {}, { timeoutMs: 30 * 1000 });
    let result;
    try {
      result = await scanChatsWithoutFocusRestore();
    } catch (error) {
      if (!isRetryableScanOutputError(error)) throw error;
      appendDiagnosticEvent({
        outcome: 'retrying',
        operation: 'chat-scan',
        stage: 'recover-empty-output',
        message: 'Telegram returned an empty scan response; dismissing any popup and retrying once.'
      });
      try { await runAutomation('dismiss', {}, { timeoutMs: 15 * 1000 }); } catch (_) {}
      result = await scanChatsWithoutFocusRestore();
    }
    appendDiagnosticEvent({
      outcome: 'success',
      operation: 'chat-scan',
      stage: 'completed',
      message: `Detected ${result.chats} chats across ${result.accounts} account(s).`
    });
    return result;
  } catch (error) {
    appendDiagnosticEvent({
      outcome: 'failure',
      operation: 'chat-scan',
      stage: error.telegramAction || 'scan',
      message: error.message
    });
    throw error;
  } finally {
    if (previousForeground) {
      try { await runAutomation('restore-foreground', previousForeground, { timeoutMs: 30 * 1000 }); } catch (_) {}
    }
  }
}

function getChats() {
  return db.getTelegramArchiveChats()
    .map(chat => ({ ...chat, running: activeBackups.has(chat.id) }))
    .sort((left, right) => {
      if (!!left.selected !== !!right.selected) return left.selected ? -1 : 1;
      if (left.account_name !== right.account_name) return left.account_name.localeCompare(right.account_name);
      return left.name.localeCompare(right.name);
    });
}

function updateChat(chatId, updates) {
  const allowed = {};
  for (const key of ['selected', 'enabled', 'include_media', 'schedule', 'schedule_time']) {
    if (updates && updates[key] !== undefined) allowed[key] = updates[key];
  }
  return db.updateTelegramArchiveChat(chatId, allowed);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function flattenMessageText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

function isInside(parentDir, candidatePath) {
  const parent = path.resolve(parentDir);
  const candidate = path.resolve(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function archiveMediaFile(sourcePath, mediaDir) {
  const content = fs.readFileSync(sourcePath);
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  const extension = path.extname(sourcePath).slice(0, 16).toLowerCase();
  const fileName = `${digest}${extension}`;
  const destination = path.join(mediaDir, fileName);
  fs.mkdirSync(mediaDir, { recursive: true });
  if (!fs.existsSync(destination)) fs.writeFileSync(destination, content);
  return { relativePath: `media/${fileName}`, digest, created: destination };
}

function rewriteMediaReferences(value, exportDir, mediaDir, mediaDigests) {
  if (Array.isArray(value)) {
    return value.map(item => rewriteMediaReferences(item, exportDir, mediaDir, mediaDigests));
  }
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && !path.isAbsolute(child) && child.length < 2048) {
      const sourcePath = path.resolve(exportDir, child.replace(/\//g, path.sep));
      if (isInside(exportDir, sourcePath) && fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
        const archived = archiveMediaFile(sourcePath, mediaDir);
        output[key] = archived.relativePath;
        mediaDigests.add(archived.digest);
        continue;
      }
    }
    output[key] = rewriteMediaReferences(child, exportDir, mediaDir, mediaDigests);
  }
  return output;
}

function messageIdentity(message, index) {
  if (message && message.id !== undefined && message.id !== null) return String(message.id);
  return `synthetic:${hashId(`${message && message.date_unixtime || ''}\n${flattenMessageText(message && message.text)}\n${index}`, 32)}`;
}

function ingestExport(chat, resultPath, options = {}) {
  const raw = readJson(resultPath, null);
  if (!raw || !Array.isArray(raw.messages)) throw new Error('Telegram result.json is invalid or contains no message array.');

  const chatDir = getChatArchiveDir(chat.id);
  const segmentsDir = path.join(chatDir, 'segments');
  const mediaDir = path.join(chatDir, 'media');
  const statePath = path.join(chatDir, 'state.json');
  const manifestPath = path.join(chatDir, 'manifest.json');
  fs.mkdirSync(segmentsDir, { recursive: true });

  const state = readJson(statePath, { schemaVersion: 1, messages: {}, media: {}, messageCount: 0 });
  if (!state.messages || typeof state.messages !== 'object') state.messages = {};
  const exportDir = path.dirname(resultPath);
  const changedMessages = [];
  const mediaDigests = new Set(Object.keys(state.media || {}));
  let checkpointUnix = Number(chat.checkpoint_date ? Date.parse(chat.checkpoint_date) / 1000 : 0) || 0;
  const runCheckpointUnix = Number(options.checkpointDate ? Date.parse(options.checkpointDate) / 1000 : 0) || 0;
  checkpointUnix = Math.max(checkpointUnix, runCheckpointUnix);

  raw.messages.forEach((originalMessage, index) => {
    const rewritten = rewriteMediaReferences(originalMessage, exportDir, mediaDir, mediaDigests);
    rewritten._archive_text = flattenMessageText(rewritten.text);
    const id = messageIdentity(rewritten, index);
    const digest = crypto.createHash('sha256').update(JSON.stringify(rewritten)).digest('hex');
    if (state.messages[id] !== digest) {
      changedMessages.push({ ...rewritten, _archive_id: id });
      state.messages[id] = digest;
    }
    const unix = Number(rewritten.date_unixtime || 0);
    if (Number.isFinite(unix)) checkpointUnix = Math.max(checkpointUnix, unix);
  });

  const exportedAt = new Date().toISOString();
  if (changedMessages.length > 0) {
    const segmentName = `${exportedAt.replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.json`;
    writeJsonAtomic(path.join(segmentsDir, segmentName), {
      schemaVersion: 1,
      exportedAt,
      account: { id: chat.account_id, name: chat.account_name },
      chat: { id: chat.id, telegramId: raw.id || null, name: chat.name, type: raw.type || chat.type },
      messages: changedMessages
    });
  }

  state.schemaVersion = 1;
  state.messageCount = Object.keys(state.messages).length;
  state.media = Object.fromEntries(Array.from(mediaDigests).map(digest => [digest, true]));
  state.updatedAt = exportedAt;
  writeJsonAtomic(statePath, state);

  const manifest = {
    schemaVersion: 1,
    accountId: chat.account_id,
    accountName: chat.account_name,
    chatId: chat.id,
    telegramChatId: raw.id !== undefined ? String(raw.id) : chat.telegram_chat_id,
    chatName: chat.name,
    chatType: raw.type || chat.type,
    messageCount: state.messageCount,
    mediaCount: mediaDigests.size,
    checkpointDate: checkpointUnix > 0 ? new Date(checkpointUnix * 1000).toISOString() : chat.checkpoint_date,
    updatedAt: exportedAt
  };
  writeJsonAtomic(manifestPath, manifest);

  return {
    chatDir,
    manifest,
    newMessages: changedMessages.length,
    totalMessages: state.messageCount,
    mediaCount: mediaDigests.size
  };
}

function runRcloneCopy(localPath, remotePath, onProgress) {
  const { rcloneBin, configPath } = rclone.getPaths();
  const destination = `${rclone.getRemote()}:${remotePath}`;
  const args = ['copy', localPath, destination, '--config', configPath, '--stats=1s', '--use-json-log'];
  return new Promise((resolve, reject) => {
    const child = spawn(rcloneBin, args, { windowsHide: true });
    let buffer = '';
    const errorLines = [];
    child.stderr.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-64 * 1024);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.level === 'error' || entry.level === 'critical' || entry.level === 'warning') {
            errorLines.push(entry.msg || line);
            if (errorLines.length > 12) errorLines.shift();
          }
          if (entry.stats && onProgress) {
            const stats = entry.stats;
            const percent = stats.totalBytes > 0 ? Math.round((stats.bytes / stats.totalBytes) * 100) : 100;
            onProgress({ stage: 'uploading', percent: Math.min(99, 70 + Math.round(percent * 0.29)), message: `Uploading encrypted archive: ${percent}%` });
          }
        } catch (_) {
          if (line.trim()) {
            errorLines.push(line.trim());
            if (errorLines.length > 12) errorLines.shift();
          }
        }
      }
    });
    child.on('error', error => {
      error.rcloneStage = 'launch';
      reject(error);
    });
    child.on('close', code => {
      if (code === 0) {
        resolve(true);
        return;
      }
      if (buffer.trim()) {
        try {
          const entry = JSON.parse(buffer.trim());
          errorLines.push(entry.msg || buffer.trim());
        } catch (_) {
          errorLines.push(buffer.trim());
        }
      }
      const detail = errorLines.slice(-8).join(' | ');
      const error = new Error(detail ? `Encrypted archive upload failed: ${detail}` : `Encrypted archive upload exited with code ${code}.`);
      error.exitCode = code;
      error.rcloneStage = 'copy';
      reject(error);
    });
  });
}

function cleanupNewExport(resultPath, startedAt) {
  try {
    const exportDir = path.dirname(resultPath);
    if (!/^ChatExport_/i.test(path.basename(exportDir))) return;
    const stat = fs.statSync(exportDir);
    const startedMs = Date.parse(startedAt || '');
    if (!Number.isFinite(startedMs) || stat.birthtimeMs < startedMs - 5000) return;
    fs.rmSync(exportDir, { recursive: true, force: true });
  } catch (_) {}
}

async function backupChat(chatId, onProgress) {
  if (activeBackups.has(chatId)) throw new Error('This Telegram chat archive is already running.');
  const chat = db.getTelegramArchiveChats().find(item => item.id === chatId);
  if (!chat) throw new Error(`Telegram archive chat not found: ${chatId}`);
  if (!chat.selected) throw new Error('Select this chat before backing it up.');

  activeBackups.add(chatId);
  db.updateTelegramArchiveChat(chatId, { last_backup_status: 'running', last_error: null });
  const progress = value => { if (onProgress) onProgress({ chatId, ...value }); };
  let failureStage = 'telegram-export';
  appendDiagnosticEvent({
    outcome: 'started',
    operation: 'chat-backup',
    stage: 'starting',
    chatId,
    chatType: chat.type,
    message: `Backup started for selected ${chat.type || 'chat'}.`
  });
  try {
    progress({ stage: 'opening', percent: 5, message: `Opening ${chat.name} in Telegram...` });
    const exported = await runTelegramExport({
      chatName: chat.name,
      chatType: chat.type,
      accountName: chat.account_name,
      includeMedia: chat.include_media !== false,
      checkpointDate: chat.checkpoint_date,
      timeoutSeconds: 1800
    });
    appendDiagnosticEvent({ outcome: 'success', operation: 'chat-backup', stage: 'telegram-export', chatId, message: 'Telegram JSON export completed.' });
    failureStage = 'local-archive-copy';
    progress({ stage: 'indexing', percent: 55, message: 'Indexing new and changed messages...' });
    const ingested = ingestExport(chat, exported.resultPath, { checkpointDate: exported.startedAt });
    cleanupNewExport(exported.resultPath, exported.startedAt);
    appendDiagnosticEvent({
      outcome: 'success',
      operation: 'chat-backup',
      stage: 'local-archive-copy',
      chatId,
      message: `Stored ${ingested.newMessages} new or changed message records locally.`
    });

    const remotePath = `TelegramArchive/v1/${chat.account_id}/${chat.id}`;
    failureStage = 'encrypted-cloud-copy';
    progress({ stage: 'uploading', percent: 70, message: 'Uploading new archive files through encrypted rclone...' });
    let uploadError = null;
    try {
      await runRcloneCopy(ingested.chatDir, remotePath, progress);
      appendDiagnosticEvent({ outcome: 'success', operation: 'rclone-upload', stage: 'encrypted-cloud-copy', chatId, message: 'Encrypted Google Drive copy completed.' });
    } catch (error) {
      uploadError = error;
      appendDiagnosticEvent({
        outcome: 'failure',
        operation: 'rclone-upload',
        stage: error.rcloneStage || 'encrypted-cloud-copy',
        chatId,
        message: error.message,
        exitCode: error.exitCode
      });
    }

    const updates = {
      last_backup_at: new Date().toISOString(),
      last_backup_status: uploadError ? 'local-only' : 'success',
      last_error: uploadError ? `Local archive succeeded; encrypted upload failed: ${uploadError.message}` : null,
      checkpoint_date: ingested.manifest.checkpointDate,
      telegram_chat_id: ingested.manifest.telegramChatId,
      remote_path: remotePath,
      message_count: ingested.totalMessages,
      media_count: ingested.mediaCount
    };
    db.updateTelegramArchiveChat(chatId, updates);
    progress({
      stage: 'completed',
      percent: 100,
      message: uploadError
        ? `Saved ${ingested.newMessages} new/changed messages locally; cloud upload needs attention.`
        : `Backed up ${ingested.newMessages} new/changed messages.`
    });
    appendDiagnosticEvent({
      outcome: uploadError ? 'partial' : 'success',
      operation: 'chat-backup',
      stage: 'completed',
      chatId,
      message: uploadError ? 'Local archive completed, but encrypted cloud copy failed.' : 'Local archive and encrypted cloud copy completed.'
    });
    return { ...ingested, uploadError: uploadError ? uploadError.message : null };
  } catch (error) {
    db.updateTelegramArchiveChat(chatId, {
      last_backup_status: 'failed',
      last_error: error.message
    });
    appendDiagnosticEvent({
      outcome: 'failure',
      operation: 'chat-backup',
      stage: error.telegramAction || failureStage,
      chatId,
      message: error.message
    });
    throw error;
  } finally {
    activeBackups.delete(chatId);
  }
}

async function backupSelected(onProgress) {
  const selected = db.getTelegramArchiveChats().filter(chat => chat.selected && chat.enabled !== false);
  if (selected.length === 0) throw new Error('Select at least one Telegram chat to back up.');
  const results = [];
  for (let index = 0; index < selected.length; index += 1) {
    const chat = selected[index];
    if (onProgress) onProgress({
      chatId: chat.id,
      stage: 'queued',
      percent: 1,
      message: `Chat ${index + 1} of ${selected.length}: ${chat.name}`
    });
    try {
      results.push({ chatId: chat.id, success: true, result: await backupChat(chat.id, onProgress) });
    } catch (error) {
      results.push({ chatId: chat.id, success: false, error: error.message });
    }
  }
  return results;
}

function loadArchiveMessages(chatId) {
  const segmentsDir = path.join(getChatArchiveDir(chatId), 'segments');
  if (!fs.existsSync(segmentsDir)) return [];
  const folded = new Map();
  const segmentFiles = fs.readdirSync(segmentsDir).filter(name => name.endsWith('.json')).sort();
  for (const name of segmentFiles) {
    const segment = readJson(path.join(segmentsDir, name), null);
    if (!segment || !Array.isArray(segment.messages)) continue;
    for (const message of segment.messages) {
      const id = String(message._archive_id || message.id || hashId(JSON.stringify(message), 32));
      folded.set(id, message);
    }
  }
  return Array.from(folded.values()).sort((left, right) => {
    const leftTime = Number(left.date_unixtime || Date.parse(left.date || '') / 1000 || 0);
    const rightTime = Number(right.date_unixtime || Date.parse(right.date || '') / 1000 || 0);
    return leftTime - rightTime;
  });
}

function getMessages(chatId, options = {}) {
  const query = String(options.query || '').trim().toLowerCase();
  const limit = Math.min(500, Math.max(1, Number(options.limit) || 150));
  const offset = Math.max(0, Number(options.offset) || 0);
  let messages = loadArchiveMessages(chatId);
  if (query) {
    messages = messages.filter(message => {
      const haystack = [
        message._archive_text,
        flattenMessageText(message.text),
        message.from,
        message.from_id,
        message.file,
        message.photo
      ].filter(Boolean).join('\n').toLowerCase();
      return haystack.includes(query);
    });
  }
  const total = messages.length;
  const start = Math.max(0, total - offset - limit);
  const end = Math.max(0, total - offset);
  return { total, messages: messages.slice(start, end) };
}

function isDue(chat, now = Date.now()) {
  if (!chat.selected || chat.enabled === false || chat.schedule === 'manual') return false;
  const last = chat.last_backup_at ? Date.parse(chat.last_backup_at) : 0;
  const elapsed = now - last;
  if (chat.schedule === 'hourly') return elapsed >= 60 * 60 * 1000;
  if (chat.schedule === '6hours') return elapsed >= 6 * 60 * 60 * 1000;
  if (chat.schedule === 'daily') return elapsed >= 24 * 60 * 60 * 1000;
  return elapsed >= 7 * 24 * 60 * 60 * 1000;
}

function startScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(async () => {
    if (scheduledRunActive || activeBackups.size > 0) return;
    const due = db.getTelegramArchiveChats().filter(chat => isDue(chat));
    if (due.length === 0) return;
    scheduledRunActive = true;
    try {
      for (const chat of due) {
        try { await backupChat(chat.id); } catch (error) { console.error(`Scheduled Telegram chat archive failed for ${chat.id}:`, error.message); }
      }
    } finally {
      scheduledRunActive = false;
    }
  }, 60 * 1000);
}

function stopScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = null;
}

module.exports = {
  scanChats,
  getChats,
  updateChat,
  backupChat,
  backupSelected,
  getMessages,
  getArchiveRoot,
  getChatArchiveDir,
  getFailureLog,
  recordDiagnosticEvent: appendDiagnosticEvent,
  startScheduler,
  stopScheduler,
  isDue,
  __private: {
    hashId,
    discoveredChatId,
    flattenMessageText,
    ingestExport,
    runAutomation,
    runTelegramExport,
    cleanupNewExport,
    isRetryableScanOutputError,
    appendDiagnosticEvent,
    readDiagnosticEvents,
    redactDiagnosticText,
    buildFailureReport
  }
};
