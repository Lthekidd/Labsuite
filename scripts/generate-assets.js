const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '../assets');
const REQUIRED_FILES = [
  'icon.png',
  'icon.ico',
  'tray-idle.png',
  'tray-syncing.png',
  'tray-paused.png',
  'tray-error.png',
  'tray-setup.png',
  'tray-labshot.png',
  path.join('brand', 'labsuite-mark.png'),
  path.join('brand', 'labsuite-mark-ui.png')
];

const missing = REQUIRED_FILES.filter(fileName => !fs.existsSync(path.join(ASSETS_DIR, fileName)));

if (missing.length > 0) {
  console.error(`Missing brand assets:\n${missing.map(fileName => `  - assets/${fileName}`).join('\n')}`);
  console.error('Run scripts/generate-brand-assets.py with Pillow installed.');
  process.exitCode = 1;
} else {
  console.log(`Verified ${REQUIRED_FILES.length} LabSuite brand assets.`);
}
