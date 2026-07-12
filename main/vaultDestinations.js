const crypto = require('crypto');
const db = require('./database');
const rclone = require('./rclone');
const keychain = require('./keychain');

const DESTINATIONS_SETTING = 'vault_destinations';
const JOBS_SETTING = 'vault_transfer_jobs';
const APPS_ROOT = 'LabSuite-Apps';

function readList(key) {
  try {
    const parsed = JSON.parse(db.getSetting(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeList(key, rows) {
  db.setSetting(key, JSON.stringify(rows));
}

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function getDestinations() {
  const activeRaw = rclone.getRawRemoteName();
  return readList(DESTINATIONS_SETTING).map(destination => ({
    ...destination,
    isPrimary: destination.rawRemote === activeRaw
  }));
}

function saveDestination(next) {
  const destinations = readList(DESTINATIONS_SETTING);
  const index = destinations.findIndex(destination => destination.id === next.id);
  if (index >= 0) destinations[index] = next;
  else destinations.push(next);
  writeList(DESTINATIONS_SETTING, destinations);
  return next;
}

function getDestination(id) {
  const destination = readList(DESTINATIONS_SETTING).find(item => item.id === id);
  if (!destination) throw new Error('Backup destination not found.');
  return destination;
}

function updateDestination(id, changes) {
  const existing = getDestination(id);
  return saveDestination({ ...existing, ...changes, updatedAt: new Date().toISOString() });
}

function addJob(destinationId, mode) {
  const jobs = readList(JOBS_SETTING);
  const job = {
    id: makeId(),
    destinationId,
    mode,
    status: 'queued',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    roots: [],
    error: ''
  };
  jobs.push(job);
  writeList(JOBS_SETTING, jobs.slice(-50));
  return job;
}

function updateJob(id, changes) {
  const jobs = readList(JOBS_SETTING);
  const index = jobs.findIndex(job => job.id === id);
  if (index < 0) return null;
  jobs[index] = { ...jobs[index], ...changes, updatedAt: new Date().toISOString() };
  writeList(JOBS_SETTING, jobs);
  return jobs[index];
}

function getVaultRoots() {
  return [
    { key: 'vault', label: 'Encrypted backup vault', path: rclone.getEncryptedFolder(), required: true },
    { key: 'control', label: 'Vault metadata and restore catalog', path: rclone.getControlFolderName(), required: false },
    { key: 'apps', label: 'Encrypted LabSuite app data', path: APPS_ROOT, required: false }
  ];
}

async function connectDestination({ label = '', clientId = '', clientSecret = '' } = {}) {
  const id = makeId();
  const rawRemote = `labsuite_dest_${id}`;
  const cryptRemote = `labsuite_crypt_${id}`;
  let destination = {
    id,
    label: String(label || '').trim() || 'Google Drive destination',
    rawRemote,
    cryptRemote,
    mode: 'unassigned',
    status: 'connecting',
    state: 'empty',
    accountEmail: '',
    displayName: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveDestination(destination);

  try {
    await rclone.startGoogleAuthForRemote(rawRemote, clientId, clientSecret);
    const info = await rclone.getGDriveInfoForRemote(rawRemote);
    if (info.email === 'Disconnected') throw new Error('Google Drive sign-in could not be verified.');
    destination = updateDestination(id, {
      status: 'connected',
      accountEmail: info.accountEmail || info.email,
      displayName: info.displayName || '',
      quota: { used: info.used, total: info.total, free: info.free }
    });
    return destination;
  } catch (error) {
    updateDestination(id, { status: 'error', error: error.message || String(error) });
    throw error;
  }
}

async function assertEmptyTarget(destination, roots) {
  for (const root of roots) {
    if (await rclone.remotePathExists(destination.rawRemote, root.path)) {
      throw new Error(`The selected account already contains "${root.path}". Choose a clean account or remove this destination and use its existing vault separately.`);
    }
  }
}

async function verifyRoots(sourceRemote, targetRemote, roots) {
  const verified = [];
  for (const root of roots) {
    await rclone.checkNamedRemoteTree(sourceRemote, root.path, targetRemote, root.path);
    const source = await rclone.getNamedRemoteSize(sourceRemote, root.path);
    const target = await rclone.getNamedRemoteSize(targetRemote, root.path);
    if (source.bytes !== target.bytes || source.count !== target.count) {
      throw new Error(`Verification mismatch in ${root.label}.`);
    }
    verified.push({ ...root, bytes: source.bytes, count: source.count });
  }
  return verified;
}

async function transferToDestination(destinationId, mode, options = {}) {
  if (!['migrate', 'replica'].includes(mode)) throw new Error('Unsupported vault transfer mode.');
  const destination = getDestination(destinationId);
  const resumableTransfer = destination.status === 'error' && destination.state === 'copying';
  if (destination.status !== 'connected' && destination.status !== 'ready' && !resumableTransfer) {
    throw new Error('Connect and verify the destination Google Drive account first.');
  }
  const sourceRemote = rclone.getRawRemoteName();
  if (sourceRemote === destination.rawRemote) throw new Error('The selected Google Drive is already the active backup destination.');

  const password = await keychain.getPassword();
  if (!password) throw new Error('Unlock the encrypted vault with its master password before transferring it.');

  const allRoots = getVaultRoots();
  const roots = [];
  for (const root of allRoots) {
    const exists = await rclone.remotePathExists(sourceRemote, root.path);
    if (root.required && !exists) throw new Error(`The source ${root.label.toLowerCase()} could not be found.`);
    if (exists) roots.push(root);
  }

  const sourceSizes = await Promise.all(roots.map(root => rclone.getNamedRemoteSize(sourceRemote, root.path)));
  const bytesRequired = sourceSizes.reduce((sum, size) => sum + (Number(size.bytes) || 0), 0);
  const targetInfo = await rclone.getGDriveInfoForRemote(destination.rawRemote);
  if (Number(targetInfo.total) > 0 && Number(targetInfo.free) < bytesRequired) {
    throw new Error('The destination Google Drive does not have enough free space for this encrypted vault.');
  }

  const job = addJob(destination.id, mode);
  updateDestination(destination.id, { status: 'transferring', state: 'copying', mode });
  try {
    if (destination.state === 'empty') await assertEmptyTarget(destination, allRoots);
    updateJob(job.id, { status: 'copying', bytesRequired, roots: roots.map(root => ({ key: root.key, status: 'queued' })) });

    const copiedRoots = [];
    for (const root of roots) {
      updateJob(job.id, { currentRoot: root.key, status: 'copying' });
      await rclone.copyNamedRemoteTree(sourceRemote, root.path, destination.rawRemote, root.path, {
        onProgress: progress => options.onProgress && options.onProgress({ jobId: job.id, destinationId, root: root.key, ...progress })
      });
      copiedRoots.push(root);
    }

    updateJob(job.id, { status: 'verifying', currentRoot: '' });
    const verifiedRoots = await verifyRoots(sourceRemote, destination.rawRemote, copiedRoots);
    await rclone.createCryptRemoteFor({
      rawRemote: destination.rawRemote,
      cryptRemote: destination.cryptRemote,
      encryptedFolder: rclone.getEncryptedFolder(),
      password
    });

    const completedAt = new Date().toISOString();
    let next = updateDestination(destination.id, {
      status: 'ready',
      state: 'verified',
      mode,
      verifiedAt: completedAt,
      lastReplicatedAt: mode === 'replica' ? completedAt : destination.lastReplicatedAt || '',
      roots: verifiedRoots,
      error: ''
    });

    if (mode === 'migrate') {
      db.setSetting('active_raw_remote', destination.rawRemote);
      db.setSetting('active_crypt_remote', destination.cryptRemote);
      next = updateDestination(destination.id, { mode: 'primary', promotedAt: completedAt });
    }
    updateJob(job.id, { status: 'completed', completedAt, roots: verifiedRoots });
    return { destination: { ...next, isPrimary: mode === 'migrate' }, job: updateJob(job.id, {}) };
  } catch (error) {
    updateDestination(destination.id, { status: 'error', error: error.message || String(error) });
    updateJob(job.id, { status: 'failed', error: error.message || String(error) });
    throw error;
  }
}

async function replicateDestination(destinationId, options = {}) {
  const destination = getDestination(destinationId);
  if (destination.mode !== 'replica' || destination.state !== 'verified') {
    throw new Error('This destination is not a verified backup replica.');
  }
  const sourceRemote = rclone.getRawRemoteName();
  if (sourceRemote === destination.rawRemote) return { skipped: true, reason: 'Destination is active primary.' };
  const configuredRoots = getVaultRoots().filter(root => root.required || destination.roots?.some(item => item.key === root.key));
  const roots = [];
  for (const root of configuredRoots) {
    const exists = await rclone.remotePathExists(sourceRemote, root.path);
    if (root.required && !exists) throw new Error(`The source ${root.label.toLowerCase()} could not be found.`);
    if (exists) roots.push(root);
  }
  const job = addJob(destination.id, 'replica-sync');
  try {
    updateJob(job.id, { status: 'copying' });
    for (const root of roots) {
      await rclone.copyNamedRemoteTree(sourceRemote, root.path, destination.rawRemote, root.path, {
        mirror: true,
        onProgress: progress => options.onProgress && options.onProgress({ jobId: job.id, destinationId, root: root.key, ...progress })
      });
    }
    const verifiedRoots = await verifyRoots(sourceRemote, destination.rawRemote, roots);
    const completedAt = new Date().toISOString();
    updateDestination(destination.id, { status: 'ready', lastReplicatedAt: completedAt, verifiedAt: completedAt, roots: verifiedRoots, error: '' });
    updateJob(job.id, { status: 'completed', completedAt, roots: verifiedRoots });
    return { ok: true, destinationId, completedAt };
  } catch (error) {
    updateDestination(destination.id, { status: 'error', error: error.message || String(error) });
    updateJob(job.id, { status: 'failed', error: error.message || String(error) });
    throw error;
  }
}

async function replicateAll(options = {}) {
  const outcomes = [];
  for (const destination of getDestinations().filter(item => item.mode === 'replica' && item.state === 'verified')) {
    try {
      outcomes.push(await replicateDestination(destination.id, options));
    } catch (error) {
      outcomes.push({ ok: false, destinationId: destination.id, error: error.message || String(error) });
    }
  }
  return outcomes;
}

module.exports = {
  getDestinations,
  connectDestination,
  transferToDestination,
  replicateDestination,
  replicateAll,
  getVaultRoots,
  __private: { readList, writeList, getDestination, getVaultRoots }
};
