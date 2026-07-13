const { execFile } = require('child_process');
let fs;
try {
  fs = require('original-fs');
} catch (e) {
  fs = require('fs');
}
const path = require('path');

// ─── Default exclusion patterns ─────────────────────────────────────────────
// Applied to every rclone call via --exclude flags.
// These prevent backing up OS junk, caches, and build artefacts.
const DEFAULT_EXCLUSIONS = [
  // Windows system directories
  'Windows/**',
  'WINDOWS/**',
  'Program Files/**',
  'PROGRAM FILES/**',
  'Program Files (x86)/**',
  'PROGRAM FILES (X86)/**',
  '$Recycle.Bin/**',
  '$RECYCLE.BIN/**',
  '$WINDOWS.~BT/**',
  '$WINDOWS.~bt/**',
  '$WinREAgent/**',
  '$WINREAGENT/**',
  'Recovery/**',
  'RECOVERY/**',
  'System Volume Information/**',
  'SYSTEM VOLUME INFORMATION/**',
  'ProgramData/**',
  'PROGRAMDATA/**',
  'MSOCache/**',
  'MSOCACHE/**',

  // Temp / cache
  '**/Temp/**',
  '**/tmp/**',
  '**/.tmp/**',
  '**/AppData/Local/Temp/**',
  '**/AppData/Local/Microsoft/Windows/INetCache/**',
  '**/AppData/Local/Google/Chrome/User Data/Default/Cache/**',
  '**/AppData/Local/BraveSoftware/**/Cache/**',
  '**/AppData/Roaming/Spotify/Storage/**',

  // Build & dev artefacts
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/dist-packaged/**',
  '**/.next/**',
  '**/__pycache__/**',
  '**/*.pyc',
  '**/.venv/**',
  '**/venv/**',
  '**/.cache/**',
  '**/.DS_Store',

  // Log & crash files
  '*.log',
  '**/*.log',
  'DumpStack.log',
  'DumpStack.log.tmp',
  '**/DumpStack.log.tmp',
  'hiberfil.sys',
  '**/hiberfil.sys',
  'pagefile.sys',
  '**/pagefile.sys',
  'swapfile.sys',
  '**/swapfile.sys',
];

// Folders to hide from the tree browser (too dangerous / always excluded)
const SKIP_TREE_WINDOWS = new Set([
  '$Recycle.Bin', 'System Volume Information', 'Recovery',
  '$WINDOWS.~BT', '$WinREAgent', 'Windows.old', 'DumpStack.log.tmp',
  'pagefile.sys', 'swapfile.sys', 'hiberfil.sys', 'Config.Msi',
  'MSOCache', 'Windows', 'boot'
]);

/**
 * Build the list of --exclude flags to pass to rclone.
 * Merges default exclusions with any user-defined extras.
 * @param {string[]} extraExclusions - additional patterns from user settings
 * @returns {string[]} flat array of '--exclude', '<pattern>' pairs
 */
function buildExcludeArgs(extraExclusions = []) {
  const db = require('./database');
  const settings = db.getDb().settings || {};
  const useDefault = settings.use_default_exclusions !== '0';

  const all = useDefault ? [...DEFAULT_EXCLUSIONS, ...extraExclusions] : [...extraExclusions];
  const args = [];
  for (const pattern of all) {
    args.push('--exclude', pattern);
  }
  return args;
}

function buildFolderExcludePatterns(folder) {
  if (!folder || !folder.exclusions || folder.exclusions.length === 0) return [];

  return folder.exclusions.map(exPath => {
    const rel = path.relative(folder.local_path, exPath);
    const cleanRel = normalizePathForMatch(rel);
    return `/${cleanRel}/**`;
  });
}

function normalizePathForMatch(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function globToRegExp(pattern) {
  const normalized = normalizePathForMatch(pattern);
  let output = '';

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (char === '*') {
      if (next === '*') {
        output += '.*';
        i++;
      } else {
        output += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      output += '[^/]';
      continue;
    }

    output += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }

  return new RegExp(`^${output}$`, 'i');
}

const exclusionMatcherCache = new Map();

function compileExclusionPattern(pattern) {
  const rawPattern = String(pattern || '').replace(/\\/g, '/');
  const anchored = rawPattern.startsWith('/');
  const pat = normalizePathForMatch(rawPattern);
  if (!pat) return () => false;

  if (pat.endsWith('/**')) {
    const dir = normalizePathForMatch(pat.slice(0, -3).replace(/^\*\*\//, ''));
    if (!dir) return () => false;
    if (anchored || !pat.startsWith('**/')) {
      return rel => rel === dir || rel.startsWith(`${dir}/`);
    }
    return rel => rel === dir || rel.endsWith(`/${dir}`) || rel.includes(`/${dir}/`);
  }

  if (!pat.includes('*') && !pat.includes('?')) {
    return anchored
      ? rel => rel === pat
      : rel => rel === pat || rel.endsWith(`/${pat}`);
  }

  const direct = globToRegExp(pat);
  const nested = anchored ? null : globToRegExp(`**/${pat}`);
  return rel => direct.test(rel) || (!!nested && nested.test(rel));
}

function getExclusionMatcher(pattern) {
  const key = String(pattern || '');
  let matcher = exclusionMatcherCache.get(key);
  if (!matcher) {
    matcher = compileExclusionPattern(key);
    exclusionMatcherCache.set(key, matcher);
  }
  return matcher;
}

function matchesExclusionPattern(pattern, relativePath) {
  const rel = normalizePathForMatch(relativePath);
  if (!rel) return false;
  return getExclusionMatcher(pattern)(rel);
}

function createPathExclusionMatcher(folder, useDefault = true) {
  const matchers = [
    ...(useDefault ? DEFAULT_EXCLUSIONS : []),
    ...buildFolderExcludePatterns(folder)
  ].map(getExclusionMatcher);
  return filePath => {
    if (!folder || !isPathInsideFolder(filePath, folder.local_path)) return false;
    const rel = normalizePathForMatch(path.relative(folder.local_path, filePath));
    return !!rel && matchers.some(matcher => matcher(rel));
  };
}

function isPathInsideFolder(filePath, folderPath) {
  const rel = path.relative(folderPath, filePath);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function isPathExcluded(filePath, folder) {
  if (!folder || !isPathInsideFolder(filePath, folder.local_path)) return false;

  const db = require('./database');
  const settings = db.getDb().settings || {};
  const useDefault = settings.use_default_exclusions !== '0';
  const patterns = [
    ...(useDefault ? DEFAULT_EXCLUSIONS : []),
    ...buildFolderExcludePatterns(folder)
  ];

  const rel = normalizePathForMatch(path.relative(folder.local_path, filePath));
  return patterns.some(pattern => matchesExclusionPattern(pattern, rel));
}

/**
 * A normal backup includes its full root. Selective backups (currently used
 * for a single protected file) include only their declared relative paths,
 * while keeping ancestor directories watchable by chokidar.
 */
function isPathIncluded(filePath, folder) {
  const includes = Array.isArray(folder && folder.include_paths)
    ? folder.include_paths.map(normalizePathForMatch).filter(Boolean)
    : [];
  if (includes.length === 0) return true;
  if (!folder || !isPathInsideFolder(filePath, folder.local_path)) return false;

  const relative = normalizePathForMatch(path.relative(folder.local_path, filePath));
  if (!relative) return true;
  return includes.some(includePath => (
    relative === includePath || includePath.startsWith(`${relative}/`)
  ));
}

/**
 * List all drives/partitions on the current OS, prepending user folder shortcuts.
 * Returns array of { path, name, icon, size, free, used, isDir, isDrive }
 */
function runCommand(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, ...options }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function listDrives() {
  const drives = [];
  try {
    const homedir = require('os').homedir();
    const shortcuts = [
      { name: 'Desktop', path: path.join(homedir, 'Desktop'), icon: '🖥️' },
      { name: 'Downloads', path: path.join(homedir, 'Downloads'), icon: '📥' },
      { name: 'Documents', path: path.join(homedir, 'Documents'), icon: '📁' },
      { name: 'Pictures', path: path.join(homedir, 'Pictures'), icon: '🖼️' },
      { name: 'Music', path: path.join(homedir, 'Music'), icon: '🎵' },
      { name: 'Videos', path: path.join(homedir, 'Videos'), icon: '🎥' }
    ];
    for (const s of shortcuts) {
      if (fs.existsSync(s.path)) {
        drives.push({
          path: s.path,
          name: s.name,
          icon: s.icon,
          isDir: true,
          isDrive: false,
          hasChildren: true
        });
      }
    }
  } catch (err) {
    console.error('Failed to resolve folder shortcuts:', err);
  }

  let realDrives = [];
  if (process.platform === 'win32') {
    realDrives = await _listDrivesWindows();
  } else {
    realDrives = await _listDrivesPosix();
  }

  return [...drives, ...realDrives];
}

async function _listDrivesWindows() {
  // Primary: PowerShell Get-PSDrive (available Win7+, not deprecated)
  try {
    const ps = `Get-PSDrive -PSProvider FileSystem | ` +
               `Select-Object Name,Used,Free | ` +
               `ConvertTo-Json -Compress`;
    const output = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000 });
    const parsed = JSON.parse(output.trim());
    const rows = Array.isArray(parsed) ? parsed : [parsed];

    return rows
      .filter(r => r && r.Name)
      .map(r => {
        const used = Number(r.Used) || 0;
        const free = Number(r.Free) || 0;
        const size = used + free;
        const name = r.Name.toUpperCase();
        return {
          path: `${name}:\\`,
          name: `${name}:`,
          size,
          free,
          used,
          isDir: true,
          isDrive: true,
          hasChildren: true
        };
      });
  } catch (e) {
    console.warn('PowerShell drive listing failed, falling back to letter probe:', e.message);
  }

  // Fallback: probe common drive letters
  const drives = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const p = `${letter}:\\`;
    try {
      fs.accessSync(p, fs.constants.R_OK);
      drives.push({
        path: p, name: `${letter}:`,
        size: 0, free: 0, used: 0,
        isDir: true, isDrive: true, hasChildren: true
      });
    } catch (_) {}
  }
  return drives;
}

async function _listDrivesPosix() {
  try {
    const out = await runCommand('sh', ['-c', "df -k 2>/dev/null | awk 'NR>1{print $2,$3,$4,$5,$6}'"], { timeout: 5000 });
    return out.trim().split('\n')
      .map(line => {
        const [blocks, used, avail, , mount] = line.split(' ');
        if (!mount) return null;
        const size = parseInt(blocks) * 1024 || 0;
        const usedB = parseInt(used) * 1024 || 0;
        const free = parseInt(avail) * 1024 || 0;
        return {
          path: mount, name: mount,
          size, free, used: usedB,
          isDir: true, isDrive: true, hasChildren: true
        };
      })
      .filter(Boolean);
  } catch (e) {
    return [{ path: '/', name: '/', size: 0, free: 0, isDir: true, isDrive: true, hasChildren: true }];
  }
}

/**
 * List immediate subdirectories of a given path (lazy tree loading).
 * Filters out hidden and known system folders.
 */
async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function listDir(dirPath, options = {}) {
  try {
    const offset = Math.max(0, Number(options.offset) || 0);
    const requestedLimit = Number(options.limit);
    const hasFiniteLimit = Number.isFinite(requestedLimit) && requestedLimit > 0;
    const limit = hasFiniteLimit ? Math.min(Math.floor(requestedLimit), 1000) : Infinity;
    const includeStats = options.includeStats !== false;
    const includeHasChildren = options.includeHasChildren !== false;

    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const candidates = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (process.platform === 'win32' && SKIP_TREE_WINDOWS.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const isDir = entry.isDirectory();
      candidates.push({ path: fullPath, name: entry.name, isDir, isDrive: false });
    }

    // Sort before slicing so paging is stable and folder-first like Explorer.
    candidates.sort((a, b) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const paged = hasFiniteLimit ? candidates.slice(offset, offset + limit) : candidates;
    const items = await mapWithConcurrency(paged, 16, async item => {
      let stat = null;
      if (includeStats) {
        try {
          stat = await fs.promises.stat(item.path);
        } catch (_) {}
      }

      let hasChildren = false;
      if (includeHasChildren && item.isDir) {
        try {
          const sub = await fs.promises.readdir(item.path, { withFileTypes: true });
          hasChildren = sub.some(e =>
            e.isDirectory() &&
            !e.name.startsWith('.') &&
            !(process.platform === 'win32' && SKIP_TREE_WINDOWS.has(e.name))
          );
        } catch (_) {}
      }

      return {
        ...item,
        hasChildren,
        size: stat ? stat.size : 0,
        mtimeMs: stat ? stat.mtimeMs : null
      };
    });

    return {
      success: true,
      items,
      total: candidates.length,
      offset,
      limit: hasFiniteLimit ? limit : candidates.length,
      hasMore: hasFiniteLimit && offset + limit < candidates.length
    };

  } catch (e) {
    return { success: false, items: [], total: 0, offset: 0, limit: 0, hasMore: false, error: e.message };
  }
}

/**
 * Convert a local path to a sensible remote rclone path.
 * e.g.  C:\Users\username\Documents  →  C/Users/username/Documents
 *       C:\                        →  C
 */
function toRemotePath(localPath) {
  const os = require('os');
  const hostname = os.hostname() || 'My-PC';
  const cleanPath = localPath
    .replace(/^([A-Za-z]):[\\\/]/, '$1/')
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
    || localPath.replace(/[:\\\/]/g, '_');
  return `computers/${hostname}/${cleanPath}`;
}

function getSharedPaths() {
  const db = require('./database');
  const folders = db.getEnabledFolders().filter(folder => folder.share_on_lan !== false && folder.share_on_lan !== 0);
  return folders.map(f => path.resolve(f.local_path).replace(/\\/g, '/').replace(/\/+$/, ''));
}

function isWithinSharedPaths(targetPath) {
  if (!targetPath) return false;
  try {
    const resolved = path.resolve(targetPath).replace(/\\/g, '/').replace(/\/+$/, '');
    const sharedPaths = getSharedPaths();
    return sharedPaths.some(shared => resolved.toLowerCase() === shared.toLowerCase() || resolved.toLowerCase().startsWith(shared.toLowerCase() + '/'));
  } catch (_) {
    return false;
  }
}

module.exports = {
  listDrives,
  listDir,
  toRemotePath,
  buildExcludeArgs,
  buildFolderExcludePatterns,
  matchesExclusionPattern,
  isPathExcluded,
  createPathExclusionMatcher,
  isPathIncluded,
  isPathInsideFolder,
  isWithinSharedPaths,
  DEFAULT_EXCLUSIONS,
  SKIP_TREE_WINDOWS
};
