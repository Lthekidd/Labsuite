const https = require('https');
const http = require('http');
const os = require('os');

let db = null;

function configure(options = {}) {
  db = options.db || db;
}

function getEndpoint() {
  const envEndpoint = String(process.env.LABSUITE_CRASH_REPORT_URL || '').trim();
  if (envEndpoint) return envEndpoint;
  try {
    return db ? String(db.getSetting('crash_report_url') || '').trim() : '';
  } catch (_) {
    return '';
  }
}

function makePayload(type, error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error || '');
  const stack = error instanceof Error ? error.stack : '';
  return {
    app: 'LabSuite',
    type,
    message,
    stack,
    extra,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    version: process.versions.electron || process.version,
    timestamp: new Date().toISOString()
  };
}

function report(type, error, extra = {}) {
  const endpoint = getEndpoint();
  if (!endpoint) return false;

  let target;
  try {
    target = new URL(endpoint);
  } catch (_) {
    return false;
  }

  if (!['http:', 'https:'].includes(target.protocol)) return false;

  const body = JSON.stringify(makePayload(type, error, extra));
  const client = target.protocol === 'https:' ? https : http;
  const req = client.request(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    },
    timeout: 5000
  }, res => {
    res.resume();
  });

  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
  return true;
}

module.exports = {
  configure,
  report
};
