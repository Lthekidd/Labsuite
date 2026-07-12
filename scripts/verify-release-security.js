const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REQUIRED_RCLONE_VERSION = '1.74.4';
const MIN_ELECTRON_MAJOR = 43;
const PACKAGE_VERSION = require('../package.json').version;

function fail(message) {
  console.error(`release-security: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    ...options
  });
}

function checkElectronVersion() {
  const version = require('electron/package.json').version;
  const major = Number(version.split('.')[0]);
  if (!Number.isFinite(major) || major < MIN_ELECTRON_MAJOR) {
    fail(`Electron ${version} is below the required major version ${MIN_ELECTRON_MAJOR}.`);
  }
  console.log(`release-security: Electron ${version} ok.`);
}

function walkFiles(dir, predicate, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, files);
    } else if (!predicate || predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function checkNoInlineScripts() {
  const html = readProjectFile('index.html');
  const inlineScripts = html.match(/<script\b(?![^>]*\bsrc=)[^>]*>/gi) || [];
  if (inlineScripts.length > 0) {
    fail('index.html contains inline script tags, which violate the production CSP.');
  }
  console.log('release-security: CSP inline script check ok.');
}

function checkNoRendererElectronRequire() {
  const files = walkFiles(path.join(ROOT, 'renderer'), filePath => /\.(jsx?|tsx?)$/i.test(filePath));
  const offenders = files.filter(filePath => /require\(\s*['"]electron['"]\s*\)/.test(fs.readFileSync(filePath, 'utf8')));
  if (offenders.length > 0) {
    fail(`renderer imports Electron directly: ${offenders.map(filePath => path.relative(ROOT, filePath)).join(', ')}`);
  }
  console.log('release-security: renderer Electron require check ok.');
}

function checkNoRemoteCssImports() {
  const files = walkFiles(path.join(ROOT, 'renderer'), filePath => /\.css$/i.test(filePath));
  const offenders = files.filter(filePath => /@import\s+(?:url\()?['"]?https?:/i.test(fs.readFileSync(filePath, 'utf8')));
  if (offenders.length > 0) {
    fail(`renderer CSS imports remote stylesheets blocked by CSP: ${offenders.map(filePath => path.relative(ROOT, filePath)).join(', ')}`);
  }
  console.log('release-security: remote CSS import check ok.');
}

function checkDatabaseFileName() {
  const databaseSource = readProjectFile('main/database.js');
  if (!databaseSource.includes("'labsuite_db.json'")) {
    fail('main/database.js must use labsuite_db.json as the primary database filename.');
  }
  console.log('release-security: database filename check ok.');
}

function checkNoWorkspaceRcloneSecrets() {
  const configPath = path.join(ROOT, 'data', 'rclone.conf');
  if (!fs.existsSync(configPath)) {
    console.log('release-security: no workspace rclone.conf found.');
    return;
  }

  const config = fs.readFileSync(configPath, 'utf8');
  if (/(^|\n)\s*(token|password|password2|client_secret)\s*=|access_token|refresh_token/i.test(config)) {
    fail('data/rclone.conf contains credential material. Move it out of the workspace and reconnect/rotate credentials before release.');
  }
  console.log('release-security: workspace rclone.conf has no credential material.');
}

function parseRcloneCheck(output) {
  const yours = output.match(/yours:\s*([\d.]+)/i)?.[1];
  const latest = output.match(/latest:\s*([\d.]+)/i)?.[1];
  return { yours, latest };
}

function checkRcloneBinary(binaryPath, label) {
  if (!fs.existsSync(binaryPath)) {
    fail(`${label} is missing at ${binaryPath}.`);
  }

  const versionOutput = run(binaryPath, ['version', '--check'], { timeout: 60000 });
  const { yours, latest } = parseRcloneCheck(versionOutput);
  if (yours !== REQUIRED_RCLONE_VERSION) {
    fail(`${label} is ${yours || 'unknown'}, expected ${REQUIRED_RCLONE_VERSION}.`);
  }
  if (latest && latest !== yours) {
    fail(`${label} is ${yours}, but rclone latest is ${latest}.`);
  }
  console.log(`release-security: ${label} ${yours} ok.`);
}

function getAuthenticodeStatus(filePath) {
  const escaped = filePath.replace(/'/g, "''");
  return run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`
  ]).trim();
}

function checkSignedIfPackaged(filePath, label) {
  if (process.platform !== 'win32' || !fs.existsSync(filePath)) return;

  const status = getAuthenticodeStatus(filePath);
  if (status !== 'Valid') {
    if (status === 'NotSigned') {
      console.warn(`release-security: ${label} is unsigned by personal-use policy; Windows will show an Unknown publisher warning.`);
      return;
    }
    fail(`${label} is not signed with a valid Authenticode signature (status: ${status}).`);
  }
  console.log(`release-security: ${label} signature ok.`);
}

function main() {
  checkNoInlineScripts();
  checkNoRendererElectronRequire();
  checkNoRemoteCssImports();
  checkDatabaseFileName();
  checkNoWorkspaceRcloneSecrets();
  checkElectronVersion();
  checkRcloneBinary(path.join(ROOT, 'bin', process.platform === 'win32' ? 'rclone-win.exe' : 'rclone-mac'), 'bundled rclone');

  for (const candidate of [
    ['dist-packaged/win-unpacked/LabSuite.exe', 'packaged LabSuite.exe'],
    [`dist-packaged/LabSuite-v${PACKAGE_VERSION}-Setup.exe`, 'LabSuite installer']
  ]) {
    checkSignedIfPackaged(path.join(ROOT, candidate[0]), candidate[1]);
  }
}

main();
