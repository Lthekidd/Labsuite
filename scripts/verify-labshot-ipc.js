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

  // 2. Check tray asset exists
  const trayAssetPath = path.join(__dirname, '../assets/tray-labshot.png');
  assert(fs.existsSync(trayAssetPath), 'assets/tray-labshot.png must exist');

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
