const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./database');
const rclone = require('./rclone');

const activeBackups = new Set();
let schedulerInterval = null;
let scheduledRunActive = false;

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

function runAutomation(action, payload = {}, options = {}) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Telegram chat export automation currently requires Windows.'));
  }

  const scriptPath = ensureAutomationScript();
  const payloadDir = path.join(os.tmpdir(), 'LabSuite_Temp', 'telegram_archive_payloads');
  fs.mkdirSync(payloadDir, { recursive: true });
  const payloadPath = path.join(payloadDir, `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Action', action,
      '-PayloadPath', payloadPath
    ], { windowsHide: true });

    let stdout = '';
    let stderr = '';
    const maxOutput = 1024 * 1024;
    const timeoutMs = Number(options.timeoutMs) || 35 * 60 * 1000;
    const timeout = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('Telegram automation timed out.'));
    }, timeoutMs);

    child.stdout.on('data', data => {
      if (stdout.length < maxOutput) stdout += data.toString();
    });
    child.stderr.on('data', data => {
      if (stderr.length < maxOutput) stderr += data.toString();
    });
    child.on('error', error => {
      clearTimeout(timeout);
      try { fs.unlinkSync(payloadPath); } catch (_) {}
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      try { fs.unlinkSync(payloadPath); } catch (_) {}
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
        reject(new Error(detail || `Telegram automation exited with code ${code}.`));
        return;
      }
      try {
        resolve(parseAutomationOutput(stdout));
      } catch (error) {
        reject(error);
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
  const previousForeground = await runAutomation('foreground', {}, { timeoutMs: 30 * 1000 });
  try {
    return await scanChatsWithoutFocusRestore();
  } finally {
    try { await runAutomation('restore-foreground', previousForeground, { timeoutMs: 30 * 1000 }); } catch (_) {}
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
    child.stderr.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.stats && onProgress) {
            const stats = entry.stats;
            const percent = stats.totalBytes > 0 ? Math.round((stats.bytes / stats.totalBytes) * 100) : 100;
            onProgress({ stage: 'uploading', percent: Math.min(99, 70 + Math.round(percent * 0.29)), message: `Uploading encrypted archive: ${percent}%` });
          }
        } catch (_) {}
      }
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(true) : reject(new Error(`Encrypted archive upload exited with code ${code}.`)));
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
    progress({ stage: 'indexing', percent: 55, message: 'Indexing new and changed messages...' });
    const ingested = ingestExport(chat, exported.resultPath, { checkpointDate: exported.startedAt });
    cleanupNewExport(exported.resultPath, exported.startedAt);

    const remotePath = `TelegramArchive/v1/${chat.account_id}/${chat.id}`;
    progress({ stage: 'uploading', percent: 70, message: 'Uploading new archive files through encrypted rclone...' });
    let uploadError = null;
    try {
      await runRcloneCopy(ingested.chatDir, remotePath, progress);
    } catch (error) {
      uploadError = error;
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
    return { ...ingested, uploadError: uploadError ? uploadError.message : null };
  } catch (error) {
    db.updateTelegramArchiveChat(chatId, {
      last_backup_status: 'failed',
      last_error: error.message
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
    cleanupNewExport
  }
};
