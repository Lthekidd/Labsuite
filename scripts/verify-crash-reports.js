const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-crash-reports-'));
const reportDir = path.join(tempDir, 'reports');
const dumpDir = path.join(tempDir, 'dumps', 'completed');
const logPath = path.join(tempDir, 'labsuite.log');
fs.mkdirSync(reportDir, { recursive: true });
fs.mkdirSync(dumpDir, { recursive: true });
fs.writeFileSync(logPath, '[ERROR] transfer failed password=do-not-copy {"access_token":"also-secret"}\nlast useful line\n', 'utf8');

const crashMonitor = require('../main/crashMonitor');
crashMonitor.configure({
  reportDir,
  crashDumpsDir: path.join(tempDir, 'dumps'),
  logPath,
  appVersion: '9.9.9-test',
  db: { getSetting: () => '' }
});

try {
  assert.strictEqual(
    crashMonitor.report('testFailure', new Error('test crash'), { password: 'secret-value', phase: 'upload' }),
    true,
    'A local report should be written even when no remote endpoint is configured.'
  );

  let reports = crashMonitor.listReports();
  assert.strictEqual(reports.length, 1, 'The new local crash report was not listed.');
  assert.strictEqual(reports[0].version, '9.9.9-test');
  assert.strictEqual(reports[0].extra.password, '[REDACTED]');
  assert.ok(reports[0].recentLog.includes('last useful line'));
  assert.ok(!reports[0].recentLog.includes('do-not-copy'), 'Common credentials must be redacted from saved log context.');
  assert.ok(!reports[0].recentLog.includes('also-secret'), 'JSON-formatted credential fields must also be redacted.');

  const oldReport = path.join(reportDir, 'crash-old.json');
  const oldDump = path.join(dumpDir, 'old.dmp');
  const recentDump = path.join(dumpDir, 'recent.dmp');
  fs.writeFileSync(oldReport, '{}', 'utf8');
  fs.writeFileSync(oldDump, 'old', 'utf8');
  fs.writeFileSync(recentDump, 'recent', 'utf8');
  const oldTime = new Date(Date.now() - crashMonitor.RETENTION_MS - 60000);
  fs.utimesSync(oldReport, oldTime, oldTime);
  fs.utimesSync(oldDump, oldTime, oldTime);
  const removed = crashMonitor.prune();
  assert.strictEqual(removed.removedReports, 1);
  assert.strictEqual(removed.removedDumps, 1);
  assert.ok(!fs.existsSync(oldReport));
  assert.ok(!fs.existsSync(oldDump));
  assert.ok(fs.existsSync(recentDump), 'A native dump newer than seven days must be retained.');

  assert.strictEqual(crashMonitor.beginSession(), false, 'The first session should not be reported as unclean.');
  crashMonitor.heartbeat();
  assert.strictEqual(crashMonitor.beginSession(), true, 'An interrupted prior session should create an unclean-exit report.');
  reports = crashMonitor.listReports();
  assert.ok(reports.some(item => item.type === 'uncleanExit'));
  crashMonitor.endSession();
  assert.strictEqual(crashMonitor.beginSession(), false, 'A clean prior session must not create a crash report.');
  crashMonitor.endSession();

  const copied = crashMonitor.formatReportsForClipboard();
  assert.ok(copied.includes('LabSuite Crash Reports (last 7 days)'));
  assert.ok(copied.includes('test crash'));
  assert.ok(copied.includes('recent.dmp'));
  assert.ok(!copied.includes('secret-value'));

  const summary = crashMonitor.getSummary();
  assert.ok(summary.reportCount >= 2);
  assert.strictEqual(summary.dumpCount, 1);
  assert.strictEqual(summary.retentionDays, 7);
  console.log(`Crash report verification passed (${summary.reportCount} reports, ${summary.dumpCount} native dump).`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
