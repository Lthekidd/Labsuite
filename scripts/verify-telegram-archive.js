const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = path.join(os.tmpdir(), `labsuite_telegram_archive_test_${process.pid}_${Date.now()}`);
process.env.LABSUITE_TELEGRAM_ARCHIVE_ROOT = path.join(tempRoot, 'archive');
const telegramArchive = require('../main/telegramArchive');
const automationScript = fs.readFileSync(path.join(__dirname, '..', 'main', 'telegramArchiveAutomation.ps1'), 'utf8');

console.log('Running Telegram readable archive verification tests...');

assert.ok(automationScript.includes('[string]$ResultPath'), 'Telegram automation should accept a direct result-file path');
assert.ok(automationScript.includes('Write-LabSuiteResult'), 'Telegram automation should persist machine-readable results outside PowerShell stdout');

const exportDir = path.join(tempRoot, 'ChatExport_test');
fs.mkdirSync(path.join(exportDir, 'files'), { recursive: true });
fs.writeFileSync(path.join(exportDir, 'files', 'note.txt'), 'telegram media payload');

const resultPath = path.join(exportDir, 'result.json');
const chat = {
  id: 'tg_test_chat',
  account_id: 'account_test',
  account_name: 'Test Account',
  name: 'Saved Messages',
  type: 'Saved Messages',
  checkpoint_date: null,
  telegram_chat_id: null
};

const result = {
  type: 'saved_messages',
  id: 12345,
  messages: [
    {
      id: 1,
      type: 'message',
      date: '2026-07-17T12:00:00',
      date_unixtime: '1784289600',
      from: 'Test Account',
      from_id: 'user12345',
      text: 'first saved message',
      file: 'files/note.txt'
    },
    {
      id: 2,
      type: 'message',
      date: '2026-07-18T12:00:00',
      date_unixtime: '1784376000',
      from: 'Test Account',
      from_id: 'user12345',
      text: [{ type: 'bold', text: 'second' }, ' message']
    }
  ]
};
fs.writeFileSync(resultPath, JSON.stringify(result), 'utf8');

const first = telegramArchive.__private.ingestExport(chat, resultPath);
assert.strictEqual(first.newMessages, 2, 'First import should retain all messages');
assert.strictEqual(first.totalMessages, 2, 'First import should count unique message ids');
assert.strictEqual(first.mediaCount, 1, 'Referenced media should be content-addressed once');
assert.ok(first.manifest.checkpointDate, 'Newest exported message should create a checkpoint');

const second = telegramArchive.__private.ingestExport(chat, resultPath);
assert.strictEqual(second.newMessages, 0, 'Overlapping exports should not duplicate unchanged messages');
assert.strictEqual(second.totalMessages, 2, 'Overlapping exports should keep the same total');
assert.strictEqual(second.mediaCount, 1, 'Overlapping media should remain deduplicated');

result.messages[1].text = 'second message, edited';
fs.writeFileSync(resultPath, JSON.stringify(result), 'utf8');
const third = telegramArchive.__private.ingestExport(chat, resultPath);
assert.strictEqual(third.newMessages, 1, 'An edited message should create one new archive record');
assert.strictEqual(third.totalMessages, 2, 'An edited message must not increase the unique message count');

const allMessages = telegramArchive.getMessages(chat.id, { limit: 20 });
assert.strictEqual(allMessages.total, 2, 'Viewer should fold message edits by Telegram message id');
assert.ok(allMessages.messages.some(message => message._archive_text === 'second message, edited'));

const search = telegramArchive.getMessages(chat.id, { query: 'edited', limit: 20 });
assert.strictEqual(search.total, 1, 'Viewer search should match normalized message text');

const mediaFiles = fs.readdirSync(path.join(first.chatDir, 'media'));
assert.strictEqual(mediaFiles.length, 1, 'Media directory should contain one content-addressed file');

const selectedId = telegramArchive.__private.discoveredChatId('account', 'Saved Messages', 'Saved Messages');
assert.strictEqual(selectedId, telegramArchive.__private.discoveredChatId('account', 'Saved Messages', 'Saved Messages'));
assert.notStrictEqual(selectedId, telegramArchive.__private.discoveredChatId('account', 'Chat', 'Another chat'));
assert.ok(
  telegramArchive.__private.isRetryableScanOutputError({ telegramAction: 'scan', message: 'Telegram automation returned no readable result.' }),
  'Empty Telegram scan output should receive one automatic recovery attempt'
);
assert.ok(
  !telegramArchive.__private.isRetryableScanOutputError({ telegramAction: 'open-export', message: 'Telegram automation returned no readable result.' }),
  'Only chat scans should automatically retry an empty response'
);

telegramArchive.__private.appendDiagnosticEvent({
  outcome: 'failure',
  operation: 'rclone-upload',
  stage: 'copy',
  message: `token=super-secret failed below ${os.homedir()}\\TelegramArchive`
});
const events = telegramArchive.__private.readDiagnosticEvents();
assert.strictEqual(events.length, 1, 'Telegram diagnostics should persist failure events');
assert.ok(!JSON.stringify(events).includes('super-secret'), 'Telegram diagnostics must redact credential-like values');
assert.ok(JSON.stringify(events).includes('%USERPROFILE%'), 'Telegram diagnostics should redact the user profile path');
const failureReport = telegramArchive.__private.buildFailureReport({ skipSystemProbe: true });
assert.strictEqual(failureReport.latestFailure.stage, 'copy', 'Failure report should identify the exact failed stage');
assert.ok(failureReport.privacy.includes('No message bodies'), 'Failure report should explain its privacy boundary');
assert.ok(failureReport.recommendations.some(item => item.includes('rclone')), 'Upload failures should receive an rclone-specific recommendation');

fs.rmSync(tempRoot, { recursive: true, force: true });
delete process.env.LABSUITE_TELEGRAM_ARCHIVE_ROOT;

console.log('Telegram readable archive verification tests passed.');
