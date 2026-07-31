const fs = require('fs');
const path = require('path');
const https = require('https');

const cssPath = path.join(__dirname, '..', 'scratch_fonts.css');
const outputDir = path.join(__dirname, '..', 'renderer', 'fonts');
const fontsCssPath = path.join(__dirname, '..', 'renderer', 'fonts.css');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
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

async function main() {
  const content = fs.readFileSync(cssPath, 'utf8');
  
  // Split content by font-face blocks
  const fontFaceRegex = /\/\*\s*latin\s*\*\/[\s\S]*?@font-face\s*\{([\s\S]*?)\}/g;
  let match;
  const localRules = [];

  while ((match = fontFaceRegex.exec(content)) !== null) {
    const blockContent = match[1];
    
    // Parse font-family, font-style, font-weight, src url, and unicode-range
    const familyMatch = blockContent.match(/font-family:\s*['"]?([^'"]+)['"]?/);
    const styleMatch = blockContent.match(/font-style:\s*([^;]+)/);
    const weightMatch = blockContent.match(/font-weight:\s*([^;]+)/);
    const urlMatch = blockContent.match(/src:\s*url\((https:\/\/[^)]+)\)/);
    const unicodeMatch = blockContent.match(/unicode-range:\s*([^;]+)/);

    if (familyMatch && styleMatch && weightMatch && urlMatch && unicodeMatch) {
      const family = familyMatch[1].trim();
      const style = styleMatch[1].trim();
      const weight = weightMatch[1].trim();
      const url = urlMatch[1].trim();
      const unicodeRange = unicodeMatch[1].trim();

      const fileName = `${family.toLowerCase().replace(/\s+/g, '-')}-${style}-${weight}.woff2`;
      const destPath = path.join(outputDir, fileName);

      console.log(`Downloading ${family} (${style}, ${weight}) -> ${fileName}...`);
      await downloadFile(url, destPath);

      localRules.push(`/* latin */
@font-face {
  font-family: '${family}';
  font-style: ${style};
  font-weight: ${weight};
  font-display: swap;
  src: url('./fonts/${fileName}') format('woff2');
  unicode-range: ${unicodeRange};
}`);
    }
  }

  fs.writeFileSync(fontsCssPath, localRules.join('\n\n') + '\n', 'utf8');
  console.log(`Successfully wrote ${fontsCssPath}`);
}

main().catch(console.error);
