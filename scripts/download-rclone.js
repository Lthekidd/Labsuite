const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

const VERSION = '1.74.4';
const BIN_DIR = path.join(__dirname, '../bin');

// Map platforms to rclone download urls
const URLS = {
  win32: `https://downloads.rclone.org/v${VERSION}/rclone-v${VERSION}-windows-amd64.zip`,
  darwin: process.arch === 'arm64' 
    ? `https://downloads.rclone.org/v${VERSION}/rclone-v${VERSION}-osx-arm64.zip`
    : `https://downloads.rclone.org/v${VERSION}/rclone-v${VERSION}-osx-amd64.zip`
};

function downloadToBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: Status Code ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: Status Code ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

async function verifyDownloadChecksum(zipPath, zipFileName) {
  const sumsUrl = `https://downloads.rclone.org/v${VERSION}/SHA256SUMS`;
  const sumsText = (await downloadToBuffer(sumsUrl)).toString('utf8');
  const expectedLine = sumsText.split(/\r?\n/).find(line => line.endsWith(`  ${zipFileName}`));
  if (!expectedLine) {
    throw new Error(`Could not find ${zipFileName} in SHA256SUMS`);
  }

  const expected = expectedLine.split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${zipFileName}: expected ${expected}, got ${actual}`);
  }
  console.log(`Verified SHA256 for ${zipFileName}.`);
}

async function main() {
  const platform = process.platform;
  if (!URLS[platform]) {
    console.log(`Unsupported platform: ${platform}. Skipping automatic rclone download.`);
    return;
  }

  const url = URLS[platform];
  const zipFileName = path.basename(new URL(url).pathname);
  const zipPath = path.join(__dirname, `rclone-temp.zip`);
  const tempExtractDir = path.join(__dirname, 'rclone-temp-extract');

  console.log(`Creating directory: ${BIN_DIR}`);
  fs.mkdirSync(BIN_DIR, { recursive: true });

  console.log(`Downloading rclone v${VERSION} for ${platform} from ${url}...`);
  try {
    await downloadFile(url, zipPath);
    await verifyDownloadChecksum(zipPath, zipFileName);
    console.log('Download complete. Extracting...');

    fs.mkdirSync(tempExtractDir, { recursive: true });
    
    // Extract using tar (natively supported on Windows 10+ and macOS)
    execSync(`tar -xf "${zipPath}" -C "${tempExtractDir}"`);

    // Find the extracted folder
    const files = fs.readdirSync(tempExtractDir);
    const folderName = files.find(f => f.startsWith('rclone-'));
    if (!folderName) {
      throw new Error('Could not find extracted rclone directory');
    }

    const sourceFolder = path.join(tempExtractDir, folderName);
    
    if (platform === 'win32') {
      const sourceExe = path.join(sourceFolder, 'rclone.exe');
      const destExe = path.join(BIN_DIR, 'rclone-win.exe');
      fs.copyFileSync(sourceExe, destExe);
      console.log(`Copied ${sourceExe} -> ${destExe}`);
    } else {
      const sourceBin = path.join(sourceFolder, 'rclone');
      const destBin = path.join(BIN_DIR, 'rclone-mac');
      fs.copyFileSync(sourceBin, destBin);
      fs.chmodSync(destBin, '755'); // make executable
      console.log(`Copied ${sourceBin} -> ${destBin}`);
    }

    console.log('rclone binary setup successfully.');
  } catch (error) {
    console.error('Failed to set up rclone:', error);
    process.exit(1);
  } finally {
    // Clean up
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (fs.existsSync(tempExtractDir)) {
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
    }
  }
}

main();
