const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function verifyLabShot() {
  console.log('Running LabShot backend & IPC contract verification tests...');

  // 1. Check main/labShot.js exists and exports required methods
  const labShotPath = path.join(__dirname, '../main/labShot.js');
  assert(fs.existsSync(labShotPath), 'main/labShot.js must exist');
  const labShot = require(labShotPath);
  assert(typeof labShot.init === 'function', 'labShot.init must be a function');
  assert(typeof labShot.startCapture === 'function', 'labShot.startCapture must be a function');
  assert(typeof labShot.pinToScreen === 'function', 'labShot.pinToScreen must be a function');
  assert(typeof labShot.getVirtualDesktopBounds === 'function', 'labShot.getVirtualDesktopBounds must be a function');

  const virtualBounds = labShot.getVirtualDesktopBounds([
    { bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
    { bounds: { x: 0, y: -200, width: 2560, height: 1440 } }
  ]);
  assert.deepStrictEqual(
    virtualBounds,
    { x: -1920, y: -200, width: 4480, height: 1440 },
    'LabShot must cover the full virtual desktop, including negative monitor coordinates'
  );

  // 2. Check tray asset exists
  const trayAssetPath = path.join(__dirname, '../assets/brand/labshot-mark-ui.png');
  assert(fs.existsSync(trayAssetPath), 'assets/brand/labshot-mark-ui.png must exist');

  // 3. Verify preload IPC channels
  const preloadPath = path.join(__dirname, '../main/preload.js');
  const preloadContent = fs.readFileSync(preloadPath, 'utf8');
  assert(preloadContent.includes('labshot:startCapture'), 'preload.js must include labshot:startCapture');
  assert(preloadContent.includes('labshot:copyToClipboard'), 'preload.js must include labshot:copyToClipboard');
  assert(preloadContent.includes('labshot:saveToVault'), 'preload.js must include labshot:saveToVault');
  assert(preloadContent.includes('labshot:pinToScreen'), 'preload.js must include labshot:pinToScreen');
  assert(preloadContent.includes('labshot:getGallery'), 'preload.js must include labshot:getGallery');

  // 4. Verify AppHub registration
  const appHubPath = path.join(__dirname, '../renderer/apps/AppHub.jsx');
  const appHubContent = fs.readFileSync(appHubPath, 'utf8');
  assert(appHubContent.includes("id: 'labshot'"), 'AppHub.jsx must register labshot app');

  console.log('LabShot backend & IPC contract verification tests passed successfully!');
}

verifyLabShot().catch(err => {
  console.error('LabShot verification failed:', err);
  process.exit(1);
});
