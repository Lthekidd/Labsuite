function normalizeRemotePath(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function computerNameFromPath(remotePath = '') {
  const parts = normalizeRemotePath(remotePath).split('/').filter(Boolean);
  return parts[0] === 'computers' ? (parts[1] || '') : '';
}

function computerLabel(computerName, aliases = {}) {
  return aliases[computerName] || computerName || 'Computer';
}

function configuredFolderLabel(folder = {}) {
  const localPath = String(folder.selection_path || folder.local_path || '');
  const driveMatch = localPath.match(/^([A-Za-z]):[\\/]?$/);
  if (driveMatch) return `Drive ${driveMatch[1].toUpperCase()}:`;
  const localLeaf = localPath.split(/[\\/]+/).filter(Boolean).pop();
  const remoteLeaf = normalizeRemotePath(folder.remote_path).split('/').filter(Boolean).pop();
  return localLeaf || remoteLeaf || 'Backup folder';
}

function parseRecognizedFolder(remoteEntry = {}) {
  const relativePath = normalizeRemotePath(remoteEntry.Path || remoteEntry.path);
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length < 5) return null;

  const [computerName, drive, usersSegment, profile, ...tail] = parts;
  if (!computerName || !/^[A-Za-z]$/.test(drive) || !/^users$/i.test(usersSegment) || !profile) return null;

  const standardNames = new Map([
    ['desktop', 'Desktop'],
    ['documents', 'Documents'],
    ['downloads', 'Downloads'],
    ['pictures', 'Pictures'],
    ['music', 'Music'],
    ['videos', 'Videos']
  ]);

  let folderName = '';
  let provider = '';
  if (tail.length === 1) {
    folderName = standardNames.get(String(tail[0]).toLowerCase()) || '';
  } else if (tail.length === 2 && /^onedrive(?:\s*-.*)?$/i.test(tail[0])) {
    folderName = standardNames.get(String(tail[1]).toLowerCase()) || '';
    provider = 'OneDrive';
  }
  if (!folderName) return null;

  return {
    remotePath: `computers/${relativePath}`,
    computerName,
    profile,
    baseLabel: provider ? `${folderName} (${provider})` : folderName,
    modTime: remoteEntry.ModTime || remoteEntry.modTime || ''
  };
}

function makeBackupShortcuts({ folders = [], remoteEntries = [], aliases = {} } = {}) {
  const candidates = [];
  const seenPaths = new Set();

  const addCandidate = candidate => {
    const remotePath = normalizeRemotePath(candidate.remotePath);
    const key = remotePath.toLowerCase();
    if (!remotePath || seenPaths.has(key)) return;
    seenPaths.add(key);
    candidates.push({ ...candidate, remotePath });
  };

  for (const folder of folders || []) {
    if (!folder || !folder.remote_path) continue;
    const computerName = computerNameFromPath(folder.remote_path);
    addCandidate({
      remotePath: folder.remote_path,
      computerName,
      profile: '',
      baseLabel: configuredFolderLabel(folder),
      modTime: folder.last_success_at || folder.imported_at || folder.added_at || '',
      configured: true
    });
  }

  for (const entry of remoteEntries || []) {
    const recognized = parseRecognizedFolder(entry);
    if (recognized) addCandidate(recognized);
  }

  const baseNameCounts = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.baseLabel.toLowerCase()}|${computerLabel(candidate.computerName, aliases).toLowerCase()}`;
    baseNameCounts.set(key, (baseNameCounts.get(key) || 0) + 1);
  }

  return candidates
    .map(candidate => {
      const deviceLabel = computerLabel(candidate.computerName, aliases);
      const nameKey = `${candidate.baseLabel.toLowerCase()}|${deviceLabel.toLowerCase()}`;
      const profileSuffix = baseNameCounts.get(nameKey) > 1 && candidate.profile ? ` (${candidate.profile})` : '';
      return {
        Name: `${candidate.baseLabel}${profileSuffix} — ${deviceLabel}`,
        Path: candidate.remotePath,
        IsDir: true,
        Size: 0,
        ModTime: candidate.modTime,
        Shortcut: true,
        ConfiguredBackupRoot: candidate.configured === true,
        ComputerName: candidate.computerName
      };
    })
    .sort((left, right) => String(left.Name).localeCompare(String(right.Name), undefined, { sensitivity: 'base' }));
}

module.exports = {
  makeBackupShortcuts,
  parseRecognizedFolder
};
