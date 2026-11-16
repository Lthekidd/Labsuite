const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

const VERSION = '1.75.2';
const BIN_DIR = path.join(__dirname, '../bin');

// Map platforms to rclone download urls
const URLS = {
  win32: process.arch === 'arm64'
    ? `https://downloads.rclone.org/v${VERSION}/rclone-v${VERSION}-windows-arm64.zip`
    : (process.arch === 'ia32'
      ? `https://downloads.rclone.org/v${VERSION}/rclone-v${VERSION}-windows-386.zip`
      : `https://downloads.rclone.org/v${VERSION}/rclone-v${VERSION}-windows-amd64.zip`),
  darwin: process.arch === 'arm64' 
    ? `https://downloads.rclone.org/v${VERSION}/rclone-v${VERSION}-osx-arm64.zip`
    : `https://downloads.rclone.org/v${VERSION}/rclone-v${VERSION}-osx-amd64.zip`
};

function downloadToBuffer(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      reject(new Error(`Too many redirects when requesting ${url}`));
      return;
    }
    const client = url.startsWith('http:') ? http : https;
    const options = { headers: { 'User-Agent': `rclone/v${VERSION}` } };
    client.get(url, options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadToBuffer(nextUrl, maxRedirects - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download: Status Code ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function downloadFile(url, dest, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      reject(new Error(`Too many redirects when requesting ${url}`));
      return;
    }
    const client = url.startsWith('http:') ? http : https;
    const options = { headers: { 'User-Agent': `rclone/v${VERSION}` } };
    client.get(url, options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadFile(nextUrl, dest, maxRedirects - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download: Status Code ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
      file.on('error', (err) => {
        file.close(() => {
          fs.unlink(dest, () => reject(err));
        });
      });
    }).on('error', reject);
  });
}

async function verifyDownloadChecksum(zipPath, zipFileName) {
  const sumsUrl = `https://downloads.rclone.org/v${VERSION}/SHA256SUMS`;
  const sumsText = (await downloadToBuffer(sumsUrl)).toString('utf8');
  const expectedLine = sumsText.split(/\r?\n/).find(line => {
    const parts = line.trim().split(/\s+/);
    return parts.length >= 2 && parts[parts.length - 1].replace(/^\*/, '') === zipFileName;
  });
  if (!expectedLine) {
    throw new Error(`Could not find ${zipFileName} in SHA256SUMS`);
  }

  const expected = expectedLine.trim().split(/\s+/)[0].toLowerCase();
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

    if (fs.existsSync(tempExtractDir)) {
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
    }
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

      const packagedBinDir = path.join(__dirname, '../dist-packaged/win-unpacked/resources/bin');
      if (fs.existsSync(packagedBinDir)) {
        fs.copyFileSync(sourceExe, path.join(packagedBinDir, 'rclone-win.exe'));
        console.log(`Copied ${sourceExe} -> ${path.join(packagedBinDir, 'rclone-win.exe')}`);
      }
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
