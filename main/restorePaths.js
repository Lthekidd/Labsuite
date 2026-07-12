function normalizeRemotePath(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function normalizeRestoreSystemPath(remotePath = '', getVaultPath = kind => `.labsuite_${kind}`) {
  const normalized = normalizeRemotePath(remotePath);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return normalized;

  const systemRoot = parts[0].match(/^\.(?:labsuite|vaultsync)_(trash|history|staging|expired|packs|control)$/i);
  if (!systemRoot) return normalized;
  parts[0] = normalizeRemotePath(getVaultPath(systemRoot[1].toLowerCase()));
  return parts.join('/');
}

function resolveListedRemotePath(parentPath = '', listedPath = '', itemName = '') {
  const parent = normalizeRemotePath(parentPath);
  const child = normalizeRemotePath(listedPath || itemName);
  if (!parent) return child;
  if (!child) return parent;
  if (child === parent || child.startsWith(`${parent}/`)) return child;
  return normalizeRemotePath(`${parent}/${child}`);
}

module.exports = {
  normalizeRestoreSystemPath,
  resolveListedRemotePath
};
