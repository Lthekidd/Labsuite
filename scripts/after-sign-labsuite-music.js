const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = async function refreshLabSuiteMusicManifest(context) {
  if (context.electronPlatformName !== 'win32') return;

  const bundlePath = path.join(context.appOutDir, 'resources', 'bin', 'LabSuiteMusic');
  const executablePath = path.join(bundlePath, 'labsuite-music.exe');
  const manifestPath = path.join(bundlePath, 'labsuite-music.manifest.json');

  // YTmusic is an optional companion binary — skip gracefully if not bundled
  if (!fs.existsSync(executablePath) || !fs.existsSync(manifestPath)) {
    console.log('  • YTmusic companion binary not bundled — skipping hash refresh');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (manifest.product !== 'YTmusic' || manifest.securityProfile !== 'labsuite-hardened-v1') {
    throw new Error('Refusing to update an unexpected YTmusic manifest.');
  }

  manifest.executableSha256 = crypto.createHash('sha256').update(fs.readFileSync(executablePath)).digest('hex').toUpperCase();
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`  • refreshed YTmusic signed artifact hash  sha256=${manifest.executableSha256}`);
};
