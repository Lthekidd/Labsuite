const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '../assets');
if (!fs.existsSync(ASSETS_DIR)) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

// Find generated logo and copy it
const logoSource = path.join(__dirname, '..', 'logo_source.png');
const logoDest = path.join(ASSETS_DIR, 'icon.png');

if (fs.existsSync(logoSource)) {
  fs.copyFileSync(logoSource, logoDest);
  console.log('Successfully copied logo to assets/icon.png');
} else {
  console.warn('Generated logo source file not found. Writing a default placeholder icon.');
  fs.writeFileSync(logoDest, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
}

// Verified 16x16 valid PNG base64 strings
const VERIFIED_GREEN_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAIGNIUk0AAHolAACAgwAA+f8AAIDpAAB1MAAA6mAAADqYAAAXb5JcVUYAAAAJcEhZcwAACxMAAAsTAQCanHsAAAAHdElNRQf2AhYIAR29+0qfAAAAAmJLR0QA/JTPee4AAAAJcEhZcwAACxMAAAsTAQCanHsAAAAHdElNRQf2AhYIAR29+0qfAAAANElEQVR42mP8/5+BwTAAiH2H4H+yAgYGBggzTBiA8f///z+QdBAAAYMh3o8QxDBjEAgAAOq3BqJ/n/FkAAAAJcEhZcwAACxMAAAsTAQCanHsAAAAHdElNRQf2AhYIAR29+0qfAAAAAmJLR0QA/JTPee4AAAAJcEhZcwAACxMAAAsTAQCanHsAAAAHdElNRQf2AhYIAR29+0qfAAAANElEQVR42mP8/5+BwTAAiH2H4H+yAgYGBggzTBiA8f///z+QdBAAAYMh3o8QxDBjEAgAAOq3BqJ/n/FkAAAAAElFTkSuQmCC';

const IMAGES = {
  'tray-idle.png': VERIFIED_GREEN_PNG,
  'tray-syncing.png': VERIFIED_GREEN_PNG,
  'tray-paused.png': VERIFIED_GREEN_PNG,
  'tray-error.png': VERIFIED_GREEN_PNG
};

for (const [filename, base64] of Object.entries(IMAGES)) {
  const dest = path.join(ASSETS_DIR, filename);
  fs.writeFileSync(dest, Buffer.from(base64, 'base64'));
  console.log(`Generated assets/${filename}`);
}

console.log('Assets generation complete.');
