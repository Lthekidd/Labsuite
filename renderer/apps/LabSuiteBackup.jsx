// runtime_ref: 0x4c6162
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import FileTree from '../FileTree';

const ipcRenderer = window.electron.ipcRenderer;

async function safeInvoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    console.warn(`IPC Error on ${channel}:`, err.message);
    return null;
  }
}

function openExternal(url) {
  return safeInvoke('app:openExternal', { url });
}

const MAX_FILE_ACTIVITY_ROWS = 150;
const MAX_ACTIVITY_TABLE_ROWS = 180;
const FILE_ACTIVITY_RENDER_FLUSH_MS = 500;
const COMPUTER_BACKUPS_ROOT = 'computers';
const ACTIVITY_TABLE_ROW_HEIGHT = 48;
const ACTIVITY_TABLE_VIEWPORT_HEIGHT = 520;
const ACTIVITY_TABLE_OVERSCAN_ROWS = 12;

const TRANSFER_STATUSES = new Set(['uploading', 'versioning']);
const LIVE_SETTLE_STATUSES = new Set(['uploading', 'versioning', 'packing', 'preparing', 'queued']);
const OVERALL_QUEUE_STATUSES = new Set(['uploading', 'versioning', 'packing', 'preparing', 'queued']);

function getPercent(row) {
  return Math.max(0, Math.min(100, Number(row.percent ?? row.progress) || 0));
}

function isPackedBundleUpload(row) {
  return /uploading one encrypted bundle/i.test(row?.issue || row?.error || '');
}

function getActivityRank(row) {
  if (row.status === 'failed' || row.status === 'at_risk') return 0;
  if (TRANSFER_STATUSES.has(row.status)) {
    const percent = getPercent(row);
    if (percent > 0 && percent < 100) return 1;
    if (percent >= 100) return 3;
    if (isPackedBundleUpload(row)) return 1;
    return 5;
  }
  if (row.status === 'packing' || row.status === 'preparing') return 2;
  if (row.status === 'queued') return 6;
  if (row.status === 'completed') return 7;
  if (row.status === 'skipped') return 8;
  return 7;
}

function sortActivityRows(a, b) {
  const aRank = getActivityRank(a);
  const bRank = getActivityRank(b);
  if (aRank !== bRank) return aRank - bRank;
  return new Date(b.updatedAt || b.queuedAt || 0) - new Date(a.updatedAt || a.queuedAt || 0);
}

function buildActivityQueueProgress(rows = []) {
  const queueRows = rows.filter(row => row && row.isLive !== false && OVERALL_QUEUE_STATUSES.has(row.status));
  if (queueRows.length === 0) return null;

  let bytesDone = 0;
  let bytesTotal = 0;
  let speed = 0;
  let currentItem = '';

  for (const row of queueRows) {
    const total = Math.max(
      0,
      Number(row.bytesTotal) || 0,
      Number(row.size) || 0,
      Number(row.bytesDone) || 0
    );
    const percent = getPercent(row);
    let done = Math.max(0, Number(row.bytesDone) || 0);
    if (done === 0 && total > 0 && percent > 0) {
      done = Math.round((total * percent) / 100);
    }

    bytesTotal += total;
    bytesDone += Math.min(done, total || done);
    speed += Math.max(0, Number(row.speed) || 0);

    if (!currentItem && TRANSFER_STATUSES.has(row.status)) {
      currentItem = row.fileName || row.relativePath || '';
    }
  }

  const remainingBytes = Math.max(0, bytesTotal - bytesDone);
  const percent = bytesTotal > 0
    ? Math.round((bytesDone / bytesTotal) * 100)
    : Math.round((queueRows.filter(row => getPercent(row) >= 100).length / queueRows.length) * 100);

  return {
    source: 'activity',
    percent: Math.max(0, Math.min(100, percent)),
    bytesDone,
    bytesTotal,
    filesDone: queueRows.filter(row => getPercent(row) >= 100).length,
    filesTotal: queueRows.length,
    speed,
    etaSec: speed > 0 && remainingBytes > 0 ? Math.round(remainingBytes / speed) : null,
    elapsed: null,
    currentFolder: '',
    currentItem
  };
}

function getLiveActivityText(item) {
  if (item.status === 'queued') return 'Queued';
  if (item.status === 'failed') return 'Failed';
  if (item.status === 'at_risk') return 'Needs repair';
  if (TRANSFER_STATUSES.has(item.status) && item.progress >= 100) return 'Finalizing';
  if ((item.status === 'packing' || item.status === 'uploading') && isPackedBundleUpload(item)) {
    return item.progress > 0 ? `Uploading bundle (${item.progress}%)` : 'Uploading bundle';
  }
  if (item.status === 'packing') return 'Preparing package';
  if (item.status === 'preparing') return 'Preparing';
  return `Backing up (${item.progress}%)`;
}

const timeAgo = (dateStr) => {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '-';
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

function normalizeRemoteBrowsePath(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function resolveRemoteBrowseItemPath(parentPath = '', item = {}) {
  const parent = normalizeRemoteBrowsePath(parentPath);
  const child = normalizeRemoteBrowsePath(item.Path || item.Name || '');
  if (!parent) return child;
  if (!child) return parent;
  if (child === parent || child.startsWith(`${parent}/`)) return child;
  return normalizeRemoteBrowsePath(`${parent}/${child}`);
}

function getRemoteComputerName(remotePath = '') {
  const parts = normalizeRemoteBrowsePath(remotePath).split('/').filter(Boolean);
  return parts[0] === 'computers' && parts[1] ? parts[1] : '';
}

function formatRestorePathSegment(segment, displayIndex, visibleParts, computerAliases = {}) {
  if (segment === 'computers' && displayIndex === 0) return 'Computer backups';
  if (visibleParts[0] === 'computers' && displayIndex === 1) {
    const alias = computerAliases[segment];
    return alias ? `${alias} (${segment})` : segment;
  }
  if (/^[A-Za-z]$/.test(segment) && visibleParts[0] === 'computers' && displayIndex === 2) {

    return `Drive ${segment.toUpperCase()}:`;
  }
  return segment;
}

function isVaultHistoryRoot(value = '') {
  return /^\.(?:labsuite|vaultsync)_history$/i.test(String(value || ''));
}

function getRestoreBreadcrumbs(remotePath, computerAliases = {}) {
  const rawParts = normalizeRemoteBrowsePath(remotePath).split('/').filter(Boolean);
  const visibleParts = rawParts.filter(part => !isVaultHistoryRoot(part));
  const crumbs = [];
  let visibleIndex = -1;

  rawParts.forEach((segment, rawIndex) => {
    if (isVaultHistoryRoot(segment)) return;
    visibleIndex += 1;

    const label = formatRestorePathSegment(segment, visibleIndex, visibleParts, computerAliases);
    const rawKey = segment === 'computers' && visibleIndex === 0 ? '__computer_backups_root' : segment;
    const segmentPath = rawParts.slice(0, rawIndex + 1).join('/');
    const previous = crumbs[crumbs.length - 1];

    if (previous && previous.rawKey === rawKey) {
      previous.count += 1;
      previous.path = segmentPath;
      previous.label = `${label} x${previous.count}`;
      return;
    }

    crumbs.push({
      rawKey,
      label,
      path: segmentPath,
      count: 1
    });
  });

  return crumbs;
}

function getPathLeaf(value = '') {
  return String(value || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .pop() || '';
}

function getBackupFolderDisplayName(folder = {}, aliases = {}) {
  const alias = aliases[folder.local_path] || aliases[folder.remote_path];
  if (alias) return alias;
  return getPathLeaf(folder.local_path) || getPathLeaf(folder.remote_path) || 'Backup folder';
}

function isRemotePathInside(basePath = '', remotePath = '') {
  const base = normalizeRemoteBrowsePath(basePath);
  const current = normalizeRemoteBrowsePath(remotePath);
  return !!base && (current === base || current.startsWith(`${base}/`));
}

function getRestoreRootFolder(remotePath = '', folders = []) {
  const matches = folders
    .filter(folder => folder && folder.remote_path && isRemotePathInside(folder.remote_path, remotePath))
    .sort((a, b) => normalizeRemoteBrowsePath(b.remote_path).length - normalizeRemoteBrowsePath(a.remote_path).length);
  return matches[0] || null;
}

function getFriendlyRestorePath(remotePath = '', folders = [], aliases = {}) {
  const normalizedPath = normalizeRemoteBrowsePath(remotePath);
  if (!normalizedPath) return 'Backup folders';

  const rootFolder = getRestoreRootFolder(normalizedPath, folders);
  if (!rootFolder) {
    const fallbackCrumbs = getRestoreBreadcrumbs(normalizedPath, aliases);
    return fallbackCrumbs.map(crumb => crumb.label).join(' / ') || normalizedPath;
  }

  const rootPath = normalizeRemoteBrowsePath(rootFolder.remote_path);
  const relativePath = normalizedPath.slice(rootPath.length).replace(/^\/+/, '');
  const rootName = getBackupFolderDisplayName(rootFolder, aliases);
  return relativePath ? `${rootName} / ${relativePath}` : rootName;
}

function getFriendlyRestoreBreadcrumbs(remotePath = '', folders = [], aliases = {}) {
  const normalizedPath = normalizeRemoteBrowsePath(remotePath);
  const rootFolder = getRestoreRootFolder(normalizedPath, folders);
  if (!rootFolder) return getRestoreBreadcrumbs(normalizedPath, aliases);

  const rootPath = normalizeRemoteBrowsePath(rootFolder.remote_path);
  const relativeParts = normalizedPath.slice(rootPath.length).replace(/^\/+/, '').split('/').filter(Boolean);
  const crumbs = [{
    label: getBackupFolderDisplayName(rootFolder, aliases),
    path: rootPath
  }];

  relativeParts.forEach((segment, index) => {
    crumbs.push({
      label: segment,
      path: [rootPath, ...relativeParts.slice(0, index + 1)].filter(Boolean).join('/')
    });
  });

  return crumbs;
}

function getRestoreParentPath(remotePath = '', folders = []) {
  const normalizedPath = normalizeRemoteBrowsePath(remotePath);
  if (!normalizedPath) return '';

  const rootFolder = getRestoreRootFolder(normalizedPath, folders);
  const rootPath = rootFolder ? normalizeRemoteBrowsePath(rootFolder.remote_path) : '';
  if (rootPath && normalizedPath === rootPath) return '';

  const idx = normalizedPath.lastIndexOf('/');
  const parent = idx > 0 ? normalizedPath.substring(0, idx) : '';
  if (rootPath && !isRemotePathInside(rootPath, parent)) return '';
  return parent;
}

function getRestoreBrowseGuidance(errorMessage = '') {
  const message = String(errorMessage || '').toLowerCase();
  if (/decrypt|password|crypto|undecryptable/.test(message)) {
    return 'This is a decryption error. Use the exact master password that created the original VaultSync or LabSuite backup.';
  }
  if (/timed out|timeout|connection|network|rate limit|quota|403/.test(message)) {
    return 'Google Drive did not answer in time. Your password has not been identified as incorrect; wait for active backups to settle, then retry.';
  }
  if (/not found|renamed|deleted/.test(message)) {
    return 'The catalog entry and the cloud folder may be out of sync. Return to Computer backups and refresh before assuming the backup was deleted.';
  }
  return 'Return to Computer backups and retry. LabSuite will keep the remote backup unchanged.';
}

function getLatestFolderTimestamp(folders = []) {
  const timestamps = folders
    .map(folder => Date.parse(folder.last_success_at || folder.imported_at || folder.added_at || ''))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : '';
}

function getUniqueRestorableFolders(folders = []) {
  const byRemotePath = new Map();
  for (const folder of folders) {
    if (!folder || !folder.remote_path) continue;
    const key = normalizeRemoteBrowsePath(folder.remote_path).toLowerCase();
    if (!key) continue;
    const existing = byRemotePath.get(key);
    const folderEnabled = folder.enabled === 1 || folder.enabled === true || folder.enabled === undefined;
    const existingEnabled = existing && (existing.enabled === 1 || existing.enabled === true || existing.enabled === undefined);
    if (!existing || (folderEnabled && !existingEnabled) || (existing.imported_from_remote_catalog && !folder.imported_from_remote_catalog)) {
      byRemotePath.set(key, folder);
    }
  }
  return [...byRemotePath.values()];
}

export default function LabSuiteBackup() {
  // App-level state
  const [setupComplete, setSetupComplete] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard'); // 'dashboard', 'folders', 'activity', 'restore', 'settings'
  const [restoreSubTab, setRestoreSubTab] = useState('browse');
  const [syncStatus, setSyncStatus] = useState('idle'); // 'idle', 'syncing', 'paused', 'error'
  const [syncDetails, setSyncDetails] = useState('');
  const [appVersion, setAppVersion] = useState('');

  // Settings & DB State
  const [folders, setFolders] = useState([]);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState({});
  const [gdriveInfo, setGDriveInfo] = useState({ email: 'Disconnected', used: 0, total: 0 });
  const [vaultDestinations, setVaultDestinations] = useState([]);
  const [destinationLabel, setDestinationLabel] = useState('');
  const [destinationBusy, setDestinationBusy] = useState(false);
  const [destinationMessage, setDestinationMessage] = useState('');
  const [vaultTransferProgress, setVaultTransferProgress] = useState(null);
  const [healthInfo, setHealthInfo] = useState({ rcloneVersion: 'Loading...', gdriveStatus: 'Loading...', remoteSafety: null });
  const [syncProgress, setSyncProgress] = useState(null);
  const [overallProgress, setOverallProgress] = useState(null);
  // syncProgress shape: { folderId, phase, filesDone, filesTotal, bytesDone, bytesTotal, speed, etaSec, elapsed }
  const [folderProgress, setFolderProgress] = useState({});
  const [backupManifestSummary, setBackupManifestSummary] = useState([]);
  const [restorePoints, setRestorePoints] = useState([]);
  const [selectedRestorePointId, setSelectedRestorePointId] = useState('');
  const [restorePointPlan, setRestorePointPlan] = useState(null);
  const [isPlanningRestorePoint, setIsPlanningRestorePoint] = useState(false);
  const [fileActivity, setFileActivity] = useState({});
  const fileActivityBufferRef = useRef(new Map());

  const fileActivityFlushTimerRef = useRef(null);
  const [activityTableScrollTop, setActivityTableScrollTop] = useState(0);
  const activityTableScrollRafRef = useRef(null);
  const activityTablePendingScrollTopRef = useRef(0);
  const handleActivityTableScroll = useCallback((event) => {
    activityTablePendingScrollTopRef.current = event.currentTarget.scrollTop;
    if (activityTableScrollRafRef.current) return;
    activityTableScrollRafRef.current = requestAnimationFrame(() => {
      activityTableScrollRafRef.current = null;
      setActivityTableScrollTop(activityTablePendingScrollTopRef.current);
    });
  }, []);

  useEffect(() => {
    if (window.__legacyBackupTabPending) {
      const targetSubTab = window.__legacyBackupTabPending;
      window.__legacyBackupTabPending = null;
      if (targetSubTab === 'folders') setActiveTab('folders');
      else if (targetSubTab === 'health') setActiveTab('health');
      else if (targetSubTab === 'restore') setActiveTab('restore');
      else if (targetSubTab === 'dashboard') setActiveTab('dashboard');
    }

    const handleLegacyTab = (event) => {
      const targetSubTab = event.detail;
      if (targetSubTab === 'folders') setActiveTab('folders');
      else if (targetSubTab === 'health') setActiveTab('health');
      else if (targetSubTab === 'restore') setActiveTab('restore');
      else if (targetSubTab === 'dashboard') setActiveTab('dashboard');
    };
    window.addEventListener('legacy-backup-tab', handleLegacyTab);
    return () => {
      window.removeEventListener('legacy-backup-tab', handleLegacyTab);
    };
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('backup-subtab-changed', { detail: activeTab }));
  }, [activeTab]);

  // Onboarding Wizard State
  const [wizardStep, setWizardStep] = useState(1);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [gdriveAuthStarted, setGDriveAuthStarted] = useState(false);
  const [gdriveConnected, setGDriveConnected] = useState(false);
  const [isContinuingFromGoogle, setIsContinuingFromGoogle] = useState(false);
  const [authError, setAuthError] = useState('');
  const [setupMode, setSetupMode] = useState('');
  const [remoteVaultInfo, setRemoteVaultInfo] = useState({ exists: false, passwordHint: '' });
  const [isCheckingRemoteVault, setIsCheckingRemoteVault] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [passwordHint, setPasswordHint] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordCheckStatus, setPasswordCheckStatus] = useState('');
  const [passwordCheckMessage, setPasswordCheckMessage] = useState('');
  const [onboardingFolders, setOnboardingFolders] = useState([]);
  const [systemPaths, setSystemPaths] = useState([]);
  const [showQuickWizard, setShowQuickWizard] = useState(false);
  const [wizardFoldersToAdd, setWizardFoldersToAdd] = useState([]);

  // Restore State
  const [remotePath, setRemotePath] = useState('');
  const [remoteItems, setRemoteItems] = useState([]);
  const [restoreDest, setRestoreDest] = useState('');
  const [restoreStatus, setRestoreStatus] = useState(''); // '', 'restoring', 'success', 'error'
  const [restoreProgress, setRestoreProgress] = useState(null); // { filesDone, filesTotal, bytesDone, bytesTotal }
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreBrowseError, setRestoreBrowseError] = useState('');
  const [explorerSearch, setExplorerSearch] = useState('');
  const [selectedRemoteItem, setSelectedRemoteItem] = useState(null); // { Name, IsDir, Path, Size }
  const [selectedRestorePath, setSelectedRestorePath] = useState(''); // The path to restore
  const [vaultDeleteStatus, setVaultDeleteStatus] = useState('');
  const restoreBrowseRequestRef = useRef(0);
  const loadAppConfigsInFlightRef = useRef(null);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const [restoreTab, setRestoreTab] = useState('live'); // 'live' | 'trash' (version history)
  
  // Advanced Features State
  const [exclusionsFolder, setExclusionsFolder] = useState(null);
  const [exclusionsList, setExclusionsList] = useState([]);
  const [newExclusion, setNewExclusion] = useState('');

  const [browseRestorePointId, setBrowseRestorePointId] = useState('');
  const [browseSnapshotFiles, setBrowseSnapshotFiles] = useState([]);
  const [browseSnapshotLoading, setBrowseSnapshotLoading] = useState(false);
  const [browseSnapshotError, setBrowseSnapshotError] = useState('');
  const [browseSnapshotPath, setBrowseSnapshotPath] = useState(''); // Current folder path in browsed snapshot

  const [mountInfo, setMountInfo] = useState({ status: 'unmounted', drive: null, error: '' });
  const [showWinfspDialog, setShowWinfspDialog] = useState(false);
  const [showAliasModal, setShowAliasModal] = useState(false);
  const [aliasModalComputer, setAliasModalComputer] = useState('');
  const [aliasModalValue, setAliasModalValue] = useState('');
  const [aliasModalMode, setAliasModalMode] = useState('device'); // 'device' | 'folder'
  const [winfspInstallStage, setWinfspInstallStage] = useState('idle'); // 'idle' | 'downloading' | 'installing' | 'completed' | 'error'
  const [winfspInstallPercent, setWinfspInstallPercent] = useState(0);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [conflictData, setConflictData] = useState(null); // { folderId, filePath, localSize, remoteSize, localTime, remoteTime, relativeRemotePath }

  // Web Server State
  const [webServerUrl, setWebServerUrl] = useState('');
  const [webServerStarting, setWebServerStarting] = useState(false);

  // Health Verification State
  const [verifyLogs, setVerifyLogs] = useState([]);
  const [verifyingFolderId, setVerifyingFolderId] = useState(null);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState('');
  const [restoreDrillRunning, setRestoreDrillRunning] = useState(false);
  const [restoreDrillReport, setRestoreDrillReport] = useState(null);

  // Search & Analytics State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [vaultAnalytics, setVaultAnalytics] = useState({ count: 0, bytes: 0 });
  const [analyticsSummary, setAnalyticsSummary] = useState({ totalItems: 0, successCount: 0, failedCount: 0, totalBytes: 0, successRate: 100, graphData: [] });

  // Load configuration and status
  useEffect(() => {
    loadAppConfigs();

    // Request notification permissions
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
      Notification.requestPermission();
    }

    // Listen for sync events from backend IPC
    ipcRenderer.on('winfsp:install-progress', (event, data) => {
      setWinfspInstallStage(data.stage);
      setWinfspInstallPercent(data.percent || 0);
    });

    ipcRenderer.on('status:change', (event, data) => {
      setSyncStatus(data.status);
      if (data.details !== undefined) {
        setSyncDetails(data.details || '');
      } else if (data.status !== 'syncing') {
        setSyncDetails('');
      }
    });

    ipcRenderer.on('syncQueue:start', (event, data) => {
      setSyncStatus('syncing');
      setSyncDetails(`Preparing to back up ${data.filesTotal} files`);
    });

    ipcRenderer.on('syncQueue:item-start', (event, data) => {
      setSyncDetails(`Backing up: ${data.filePath}`);
    });

    ipcRenderer.on('syncQueue:item-complete', (event, data) => {
      const succeeded = Number(data.filesSucceeded ?? data.filesDone) || 0;
      const failed = Number(data.filesFailed) || 0;
      setSyncDetails(failed > 0
        ? `Backed up ${succeeded}/${data.filesTotal} files; ${failed} failed`
        : `Backed up ${succeeded}/${data.filesTotal} files`);
    });

    ipcRenderer.on('syncQueue:item-error', (event, data) => {
      setSyncDetails(`Error: ${data.error}`);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const fileName = String(data.filePath || '').split(/[\\/]/).pop() || 'a file';
        new Notification('LabSuite Backup Error', {
          body: `Failed to back up: ${fileName}. Click for details.`,
        });
      }
    });

    const settleLiveActivityRows = (data = {}) => {
      if (fileActivityFlushTimerRef.current) {
        clearTimeout(fileActivityFlushTimerRef.current);
        fileActivityFlushTimerRef.current = null;
      }

      const bufferedRows = [...fileActivityBufferRef.current.entries()];
      fileActivityBufferRef.current.clear();
      const completedAt = new Date().toISOString();
      const failedCount = Number(data && data.filesFailed) || 0;
      const settleQueuedRows = failedCount === 0;

      setFileActivity(prev => {
        const next = { ...prev };

        for (const [id, row] of bufferedRows) {
          next[id] = {
            ...(next[id] || {}),
            ...row
          };
        }

        for (const [id, row] of Object.entries(next)) {
          if (!row || row.isLive === false) continue;
          if (!LIVE_SETTLE_STATUSES.has(row.status)) continue;
          if (row.status === 'queued' && !settleQueuedRows) continue;
          next[id] = {
            ...row,
            status: 'completed',
            percent: 100,
            bytesDone: row.bytesTotal || row.bytesDone || row.size || 0,
            completedAt,
            updatedAt: completedAt,
            error: ''
          };
        }

        const rows = Object.values(next)
          .sort(sortActivityRows)
          .slice(0, MAX_FILE_ACTIVITY_ROWS);
        return Object.fromEntries(rows.map(row => [row.id, row]));
      });
    };

    ipcRenderer.on('syncQueue:complete', (event, data) => {
      const completedCount = Number(data && data.filesSynced) || 0;
      const failedCount = Number(data && data.filesFailed) || 0;

      setSyncStatus(failedCount > 0 ? 'error' : 'idle');
      setSyncDetails(failedCount > 0 ? `${failedCount} backup ${failedCount === 1 ? 'item needs' : 'items need'} attention` : '');
      setSyncProgress(null);
      setOverallProgress(null);
      settleLiveActivityRows(data);
      loadAppConfigs(); // Refresh folders status and sizes

      if (failedCount > 0 && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('LabSuite Backup Needs Attention', {
          body: completedCount > 0
            ? `Backed up ${completedCount} ${completedCount === 1 ? 'file' : 'files'}; ${failedCount} ${failedCount === 1 ? 'item needs' : 'items need'} attention.`
            : `${failedCount} backup ${failedCount === 1 ? 'item needs' : 'items need'} attention.`,
        });
      } else if (completedCount > 0 && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('LabSuite Backup Complete', {
          body: `Backed up ${completedCount} ${completedCount === 1 ? 'file' : 'files'}.`,
        });
      }
    });

    ipcRenderer.on('sync:progress', (event, data) => {
      setSyncProgress(data);
      setSyncStatus('syncing');
      setSyncDetails(data.stageLabel || (data.phase === 'initial' ? 'Initial backup in progress...' : 'Backing up changes to Google Drive...'));
    });

    ipcRenderer.on('sync:overall-progress', (event, data) => {
      setOverallProgress(data);
    });

    ipcRenderer.on('sync:folder-progress', (event, data) => {
      setFolderProgress(prev => ({
        ...prev,
        [data.folderId]: {
          ...(prev[data.folderId] || {}),
          ...data,
          updatedAt: new Date().toISOString()
        }
      }));
      if (data.stage !== 'complete' && data.stage !== 'error') {
        setSyncStatus('syncing');
        setSyncProgress(data);
      } else {
        setSyncProgress(null);
      }
      setSyncDetails(data.stageLabel || data.currentItem || '');
      if (data.stage === 'complete' || data.stage === 'error') {
        loadAppConfigs();
      }
    });

    const queueFileActivityRows = (rows) => {
      for (const data of rows) {
        if (!data || !data.id) continue;
        const existing = fileActivityBufferRef.current.get(data.id) || {};
        fileActivityBufferRef.current.set(data.id, {
          ...existing,
          ...data,
          updatedAt: data.updatedAt || new Date().toISOString()
        });
      }
    };

    ipcRenderer.on('backup:file-activity', (event, data) => {
      queueFileActivityRows([data]);
    });
    ipcRenderer.on('sync:complete', (event, data) => {
      setSyncProgress(null);
      settleLiveActivityRows(data || {});
      loadAppConfigs();
    });

    ipcRenderer.on('sync:conflict', (event, data) => {
      setConflictData(data);
      setShowConflictModal(true);
    });

    ipcRenderer.on('health:verify-log', (event, data) => {
      setVerifyLogs(prev => {
        const newLogs = [...prev, data.logLine];
        return newLogs.slice(-10);
      });
    });

    ipcRenderer.on('analytics:storage-updated', (event, data) => {
      setVaultAnalytics(data);
    });

    ipcRenderer.on('health:safety-update', (event, data) => {
      setHealthInfo(prev => ({
        ...prev,
        remoteSafety: data
      }));
    });

    ipcRenderer.on('vault:transfer-progress', (event, data) => {
      setVaultTransferProgress(data);
    });

    return () => {
      ipcRenderer.removeAllListeners('status:change');
      ipcRenderer.removeAllListeners('syncQueue:start');
      ipcRenderer.removeAllListeners('syncQueue:item-start');
      ipcRenderer.removeAllListeners('syncQueue:item-complete');
      ipcRenderer.removeAllListeners('syncQueue:complete');
      ipcRenderer.removeAllListeners('sync:progress');
      ipcRenderer.removeAllListeners('sync:folder-progress');
      ipcRenderer.removeAllListeners('sync:overall-progress');
      ipcRenderer.removeAllListeners('backup:file-activity');
      ipcRenderer.removeAllListeners('backup:file-activity-batch');
      ipcRenderer.removeAllListeners('sync:complete');
      ipcRenderer.removeAllListeners('sync:conflict');
      ipcRenderer.removeAllListeners('health:verify-log');
      ipcRenderer.removeAllListeners('analytics:storage-updated');
      ipcRenderer.removeAllListeners('winfsp:install-progress');
      ipcRenderer.removeAllListeners('health:safety-update');
      ipcRenderer.removeAllListeners('vault:transfer-progress');
      if (fileActivityFlushTimerRef.current) {
        clearTimeout(fileActivityFlushTimerRef.current);
        fileActivityFlushTimerRef.current = null;
      }
      if (activityTableScrollRafRef.current) {
        cancelAnimationFrame(activityTableScrollRafRef.current);
        activityTableScrollRafRef.current = null;
      }
      fileActivityBufferRef.current.clear();
    };
  }, []);

  const loadRemoteVaultInfo = async () => {
    setIsCheckingRemoteVault(true);
    try {
      const info = await safeInvoke('vault:metadata');
      setRemoteVaultInfo(info || { exists: false, passwordHint: '' });
      return info || { exists: false, passwordHint: '' };
    } finally {
      setIsCheckingRemoteVault(false);
    }
  };

  const refreshGDriveConnection = async () => {
    const { hasGDrive = false } = await safeInvoke('auth:checkConfig') || {};
    setGDriveConnected(!!hasGDrive);

    if (hasGDrive) {
      setGDriveAuthStarted(false);
      setAuthError('');
      const info = await safeInvoke('auth:getGDriveInfo', { force: true });
      setGDriveInfo(info);
    }

    return !!hasGDrive;
  };

  // Poll Google Drive config status while browser approval is in progress.
  useEffect(() => {
    let interval;
    let attempts = 0;
    let cancelled = false;

    if (gdriveAuthStarted && !gdriveConnected && setupComplete === false) {
      const pollAuth = async () => {
        try {
          const connected = await refreshGDriveConnection();
          if (connected || cancelled) {
            if (interval) clearInterval(interval);
            return;
          }

          attempts += 1;
          if (attempts >= 90) {
            setGDriveAuthStarted(false);
            setAuthError('Google approval is taking longer than expected. Close the browser tab and try connecting again.');
            if (interval) clearInterval(interval);
          }
        } catch (error) {
          if (!cancelled) {
            console.error('OAuth status check failed:', error);
          }
        }
      };

      pollAuth();
      interval = setInterval(async () => {
        await pollAuth();
      }, 2000);
    }
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [gdriveAuthStarted, gdriveConnected, setupComplete]);

  const loadSystemPaths = async () => {
    try {
      const paths = await ipcRenderer.invoke('folders:getSystemPaths');
      setSystemPaths(paths);
      return paths;
    } catch (e) {
      console.error('Failed to load system paths:', e);
      return [];
    }
  };

  useEffect(() => {
    if (setupComplete === false && wizardStep === 4) {
      loadSystemPaths().then((paths) => {
        const preSelected = paths
          .filter(p => !p.isConfigured && (p.id === 'documents' || p.id === 'desktop'))
          .map(p => p.path);
        setOnboardingFolders(preSelected);
      });
    }
  }, [setupComplete, wizardStep]);

  const fileActivityRows = useMemo(() => Object.values(fileActivity).sort(sortActivityRows), [fileActivity]);

  const unifiedActivityItems = useMemo(() => {
    const items = [];
    
    // 1. Add active items from fileActivity
    const activeLive = Object.values(fileActivity).filter(row =>
      ['uploading', 'versioning', 'preparing', 'packing', 'queued', 'failed', 'at_risk'].includes(row.status)
    );
    
    activeLive.forEach(row => {
      items.push({
        id: 'live-' + row.id,
        name: row.fileName || row.relativePath,
        filePath: row.localPath || row.relativePath,
        folderId: row.folderId,
        folderPath: row.folderPath,
        size: row.size || row.bytesTotal || 0,
        status: row.status,
        progress: Math.max(0, Math.min(100, Number(row.percent) || 0)),
        speed: row.speed,
        etaSec: row.etaSec,
        time: row.updatedAt || row.queuedAt || new Date().toISOString(),
        isLive: true,
        issue: row.error || ''
      });
    });

    // 2. Add logs
    logs.forEach((log, logIndex) => {
      const logFilePath = String(log.file_path || '');
      const pathParts = logFilePath.split(/[\\/]/);
      const fileName = pathParts.pop() || logFilePath || 'Backup item';
      
      items.push({
        id: `log-${log.id}-${logIndex}`,
        name: fileName,
        filePath: logFilePath,
        folderId: log.folder_id,
        folderPath: '',
        size: log.size_bytes || 0,
        status: log.status === 'success' ? 'completed' : 'failed',
        progress: 100,
        speed: 0,
        etaSec: null,
        time: log.synced_at,
        isLive: false,
        action: log.action,
        issue: log.error_msg || ''
      });
    });

    return items.sort((a, b) => {
      const aRank = a.isLive ? getActivityRank(a) : getActivityRank({ status: a.status, percent: a.progress });
      const bRank = b.isLive ? getActivityRank(b) : getActivityRank({ status: b.status, percent: b.progress });
      if (aRank !== bRank) return aRank - bRank;
      if (a.isLive && !b.isLive) return -1;
      if (!a.isLive && b.isLive) return 1;
      return new Date(b.time) - new Date(a.time);
    }).slice(0, MAX_ACTIVITY_TABLE_ROWS);
  }, [fileActivity, logs]);

  const loadAppConfigs = async () => {
    if (loadAppConfigsInFlightRef.current) {
      return loadAppConfigsInFlightRef.current;
    }

    const task = (async () => {
      try {
        const [activeFolders, logsList, appSettings, version] = await Promise.all([
          safeInvoke('folders:list'),
          safeInvoke('activity:get'),
          safeInvoke('settings:get'),
          safeInvoke('app:getVersion')
        ]);

        const resolvedSettings = appSettings || {};
        setFolders(activeFolders || []);
        setLogs(logsList || []);
        setSettings(resolvedSettings);
        setSetupComplete(resolvedSettings.setup_complete === '1');
        setAppVersion(version || 'Unknown');

        if (resolvedSettings.setup_complete === '1') {
          const [
            info,
            health,
            analytics,
            summary,
            manifestSummary,
            points,
            mount,
            destinations
          ] = await Promise.all([
            safeInvoke('auth:getGDriveInfo'),
            safeInvoke('health:get'),
            safeInvoke('analytics:storage'),
            safeInvoke('analytics:summary'),
            safeInvoke('backup:manifestSummary'),
            safeInvoke('backup:restorePoints'),
            safeInvoke('vault:getMountStatus'),
            safeInvoke('vault:destinations')
          ]);

          setGDriveInfo(info || null);
          setHealthInfo(health || { status: 'unknown' });
          setVaultAnalytics(analytics || {});
          setAnalyticsSummary(summary || {});
          setBackupManifestSummary(manifestSummary || []);
          setRestorePoints(points || []);
          setMountInfo(mount || { status: 'unmounted' });
          setVaultDestinations(destinations || []);
        } else {
          await refreshGDriveConnection();
        }
      } catch (e) {
        console.error('Failed to load configs:', e);
      }
    })();

    loadAppConfigsInFlightRef.current = task;
    try {
      return await task;
    } finally {
      if (loadAppConfigsInFlightRef.current === task) {
        loadAppConfigsInFlightRef.current = null;
      }
    }
  };

  // Advanced Features Handlers
  const handleManageExclusions = (folder) => {
    setExclusionsFolder(folder);
    setExclusionsList(folder.exclusions || []);
    setNewExclusion('');
  };

  const handleAddExclusion = () => {
    const trimmed = newExclusion.trim();
    if (trimmed && !exclusionsList.includes(trimmed)) {
      setExclusionsList(prev => [...prev, trimmed]);
      setNewExclusion('');
    }
  };

  const handleRemoveExclusion = (pattern) => {
    setExclusionsList(prev => prev.filter(p => p !== pattern));
  };

  const handleSaveExclusions = async () => {
    if (exclusionsFolder) {
      await ipcRenderer.invoke('folders:updateExclusions', { folderId: exclusionsFolder.id, exclusions: exclusionsList });
      setExclusionsFolder(null);
      loadAppConfigs();
    }
  };

  const handleMountVault = async () => {
    setMountInfo(prev => ({ ...prev, status: 'mounting' }));
    const result = await ipcRenderer.invoke('vault:mount');
    if (!result.success) {
      if (result.error === 'winfsp_missing') {
        setShowWinfspDialog(true);
        setMountInfo({ status: 'error', drive: null, error: 'winfsp_missing' });
      } else {
        setMountInfo({ status: 'error', drive: null, error: 'mount_failed' });
      }
    } else {
      setMountInfo({ status: 'mounted', drive: result.drive, error: '' });
    }
  };

  const handleUnmountVault = async () => {
    await ipcRenderer.invoke('vault:unmount');
    setMountInfo({ status: 'unmounted', drive: null, error: '' });
  };

  const handleConnectVaultDestination = async () => {
    if (destinationBusy) return;
    setDestinationBusy(true);
    setDestinationMessage('Complete Google sign-in in your browser. LabSuite will verify the account when it returns.');
    try {
      const destination = await ipcRenderer.invoke('vault:connectDestination', { label: destinationLabel });
      setDestinationLabel('');
      setDestinationMessage(`Connected ${destination.accountEmail || destination.label}. Choose Migrate or Add Replica below.`);
      await loadAppConfigs();
    } catch (error) {
      setDestinationMessage(error.message || 'Google Drive connection failed.');
    } finally {
      setDestinationBusy(false);
    }
  };

  const handleVaultTransfer = async (destination, mode) => {
    const action = mode === 'migrate' ? 'move the active backup destination' : 'create a complete replica';
    const approved = confirm(
      `LabSuite will pause backup writes, copy the complete encrypted vault, and verify it before it ${mode === 'migrate' ? 'switches to' : 'uses'} this Google Drive account.\n\nContinue to ${action}?`
    );
    if (!approved) return;
    setDestinationBusy(true);
    setVaultTransferProgress(null);
    setDestinationMessage(mode === 'migrate' ? 'Migrating and verifying the encrypted vault…' : 'Creating and verifying the encrypted vault replica…');
    try {
      await ipcRenderer.invoke('vault:transferDestination', { destinationId: destination.id, mode });
      setDestinationMessage(mode === 'migrate'
        ? 'Migration verified. This Google Drive is now the active backup destination.'
        : 'Replica verified. Future backups will mirror the encrypted vault to this account.');
      await loadAppConfigs();
    } catch (error) {
      setDestinationMessage(error.message || 'Vault transfer failed. The original destination was left unchanged.');
      await loadAppConfigs();
    } finally {
      setDestinationBusy(false);
      setVaultTransferProgress(null);
    }
  };

  const handleSyncVaultReplica = async (destination) => {
    setDestinationBusy(true);
    setDestinationMessage('Synchronizing and verifying the backup replica…');
    try {
      await ipcRenderer.invoke('vault:syncReplica', { destinationId: destination.id });
      setDestinationMessage('Replica synchronization verified.');
      await loadAppConfigs();
    } catch (error) {
      setDestinationMessage(error.message || 'Replica synchronization failed.');
      await loadAppConfigs();
    } finally {
      setDestinationBusy(false);
      setVaultTransferProgress(null);
    }
  };

  const handleInstallWinFsp = async () => {
    setWinfspInstallStage('downloading');
    setWinfspInstallPercent(0);
    try {
      const result = await ipcRenderer.invoke('vault:installWinFsp');
      if (result.success) {
        setWinfspInstallStage('completed');
        setTimeout(() => {
          setShowWinfspDialog(false);
          setWinfspInstallStage('idle');
          handleMountVault();
        }, 1500);
      } else {
        setWinfspInstallStage('error');
      }
    } catch (e) {
      console.error(e);
      setWinfspInstallStage('error');
    }
  };

  const handleLoadSnapshot = async (restorePointId) => {
    setBrowseRestorePointId(restorePointId);
    setBrowseSnapshotLoading(true);
    setBrowseSnapshotError('');
    setBrowseSnapshotFiles([]);
    setBrowseSnapshotPath('');
    try {
        const restorePoint = restorePoints.find(rp => String(rp.id) === String(restorePointId));
      if (restorePoint) {
        const files = await ipcRenderer.invoke('restore:browseSnapshot', { 
          folderId: restorePoint.folder_id, 
          restoreTime: restorePoint.completed_at 
        });
        setBrowseSnapshotFiles(files);
      } else if (restorePointId) {
        setBrowseSnapshotError('This checkpoint record could not be found. Refresh the Restore page and try again.');
      }
    } catch (e) {
      console.error('Failed to load snapshot:', e);
      setBrowseSnapshotError(e.message || 'This checkpoint could not be opened.');
    } finally {
      setBrowseSnapshotLoading(false);
    }
  };

  const handleRestoreSnapshotFile = async (item) => {
    const dest = await ipcRenderer.invoke('folders:selectRestoreDest');
    if (!dest) return;
    
    setRestoreDest(dest);
    setRestoreStatus('restoring');
    attachRestoreListeners();
    
    try {
      if (item.storage === 'pack' && item.packRemotePath) {
        await ipcRenderer.invoke('restore:packedFile', {
          packRemotePath: item.packRemotePath,
          relativePath: item.packMemberPath,
          localDestination: dest
        });
      } else {
        await ipcRenderer.invoke('restore:start', {
          remotePath: item.remotePath,
          localDestination: dest
        });
      }
    } catch (e) {
      console.error('File restore failed:', e);
      setRestoreStatus('error');
    }
  };

  // Google Auth Button
  const handleStartGoogleAuth = async () => {
    setAuthError('');
    setGDriveAuthStarted(true);
    try {
      await ipcRenderer.invoke('auth:startGDrive', { clientId, clientSecret });
      const connected = await refreshGDriveConnection();
      if (!connected) {
        setGDriveAuthStarted(false);
        setAuthError('Google sign-in finished, but LabSuite could not confirm the Drive connection. Try connecting again.');
      }
    } catch (error) {
      console.error('OAuth fail:', error);
      const connected = await refreshGDriveConnection().catch(() => false);
      if (!connected) {
        setAuthError(error.message || 'Authentication process failed to launch.');
        setGDriveAuthStarted(false);
      }
    }
  };

  const renderGoogleClientFields = () => (
    <details
      open
      style={{
        margin: '0 0 14px',
        padding: '10px 12px',
        borderRadius: '7px',
        border: '1px solid rgba(251, 191, 36, 0.25)',
        background: 'rgba(251, 191, 36, 0.06)'
      }}
    >
      <summary style={{ cursor: 'pointer', color: '#fbbf24', fontSize: '12px', fontWeight: 700 }}>
        Personal Google OAuth client (recommended)
      </summary>
      <p style={{ margin: '9px 0', fontSize: '11.5px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        rclone's shared Google client is being retired during 2026. Create a Desktop OAuth client, then enter it here for reliable backups.
      </p>
      <button
        type="button"
        onClick={() => openExternal('https://rclone.org/drive/#making-your-own-client-id')}
        style={{ background: 'none', border: 0, color: '#60a5fa', padding: '0 0 10px', cursor: 'pointer', fontSize: '11.5px', textDecoration: 'underline' }}
      >
        Open the official setup guide
      </button>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <input
          type="text"
          className="input-control"
          autoComplete="off"
          placeholder="OAuth Client ID"
          value={clientId}
          disabled={gdriveAuthStarted || gdriveConnected}
          onChange={event => setClientId(event.target.value)}
          style={{ padding: '8px 9px', fontSize: '12px' }}
        />
        <input
          type="password"
          className="input-control"
          autoComplete="new-password"
          placeholder="OAuth Client Secret"
          value={clientSecret}
          disabled={gdriveAuthStarted || gdriveConnected}
          onChange={event => setClientSecret(event.target.value)}
          style={{ padding: '8px 9px', fontSize: '12px' }}
        />
      </div>
      <p style={{ margin: '8px 0 0', fontSize: '10.5px', color: 'var(--text-muted)' }}>
        Both fields are required when using a personal client. They are stored only in LabSuite's protected rclone configuration on this PC.
      </p>
    </details>
  );

  const handleContinueFromGoogle = async () => {
    if (isContinuingFromGoogle) return;
    setAuthError('');
    if (gdriveConnected) {
      setWizardStep(2);
      loadRemoteVaultInfo();
      return;
    }

    setIsContinuingFromGoogle(true);
    try {
      const connected = await refreshGDriveConnection();
      if (!connected) {
        setAuthError('Connect a Google Drive account before choosing how to use LabSuite.');
        return;
      }
      setWizardStep(2);
      loadRemoteVaultInfo();
    } finally {
      setIsContinuingFromGoogle(false);
    }
  };

  const handleChooseSetupMode = (mode) => {
    setSetupMode(mode);
    setPassword('');
    setConfirmPassword('');
    setPasswordHint('');
    setPasswordError('');
    setPasswordCheckStatus('');
    setPasswordCheckMessage('');
    setWizardStep(3);
  };

  // Password Setup Button
  const handleSavePassword = async () => {
    setPasswordError('');
    setPasswordCheckStatus('');
    setPasswordCheckMessage('');
    if (setupMode === 'access' && !password) {
      setPasswordError('Enter the master password used on the original PC.');
      return;
    }
    if (setupMode !== 'access' && password.length < 8) {
      setPasswordError('Password must be at least 8 characters long.');
      return;
    }
    if (setupMode !== 'access' && password !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }

    setIsSavingPassword(true);
    try {
      if (setupMode === 'access') {
        setPasswordCheckStatus('checking');
        setPasswordCheckMessage('Checking this password against the existing vault...');
        await ipcRenderer.invoke('auth:setCryptPassword', { password, mode: 'access' });
        setPasswordCheckStatus('success');
        setPasswordCheckMessage('Master password matches this vault.');
        await new Promise(resolve => setTimeout(resolve, 900));
        setSetupComplete(true);
        setActiveTab('restore');
        await loadAppConfigs();
        return;
      }

      await ipcRenderer.invoke('auth:setCryptPassword', {
        password,
        passwordHint,
        mode: 'backup'
      });
      setWizardStep(4);
    } catch (error) {
      if (setupMode === 'access') {
        setPasswordCheckStatus('error');
        setPasswordCheckMessage(error.message || 'LabSuite could not validate this vault right now. Please try again.');
      } else {
        setPasswordError(error.message || 'Failed to save password.');
      }
    } finally {
      setIsSavingPassword(false);
    }
  };

  // Onboarding Folder Picker
  const handleSelectOnboardingFolder = async () => {
    const selected = await ipcRenderer.invoke('folders:selectLocal');
    if (selected && !onboardingFolders.includes(selected)) {
      setOnboardingFolders([...onboardingFolders, selected]);
    }
  };

  const handleFinishOnboarding = async () => {
    // Add all selected folders to backend
    for (const localPath of onboardingFolders) {
      await ipcRenderer.invoke('folders:add', { localPath });
    }
    
    // Complete onboarding setting
    await ipcRenderer.invoke('settings:set', { key: 'setup_complete', value: '1' });
    setSetupComplete(true);
    loadAppConfigs();
    if (onboardingFolders.length > 0) {
      await ipcRenderer.invoke('sync:triggerNow');
    }
  };

  const handleSelectQuickWizardFolder = async () => {
    const selected = await ipcRenderer.invoke('folders:selectLocal');
    if (selected && !wizardFoldersToAdd.includes(selected)) {
      setWizardFoldersToAdd([...wizardFoldersToAdd, selected]);
    }
  };

  const handleFinishQuickWizard = async () => {
    try {
      for (const localPath of wizardFoldersToAdd) {
        await ipcRenderer.invoke('folders:add', { localPath });
      }
      setShowQuickWizard(false);
      setWizardFoldersToAdd([]);
      loadAppConfigs();
      if (wizardFoldersToAdd.length > 0) {
        await ipcRenderer.invoke('sync:triggerNow');
      }
    } catch (error) {
      alert(error.message || 'Failed to add backup folders.');
    }
  };

  // Standard Operations
  const handleAddFolder = async () => {
    const localPath = await ipcRenderer.invoke('folders:selectLocal');
    if (localPath) {
      try {
        await ipcRenderer.invoke('folders:add', { localPath });
        loadAppConfigs();
        await ipcRenderer.invoke('sync:triggerNow');
      } catch (error) {
        alert(error.message || 'Failed to add folder.');
      }
    }
  };

  const handleReconnectFolder = async (folder) => {
    try {
      if (folder.is_local_computer_backup === false) {
        const remoteComputer = folder.remote_computer_name || getRemoteComputerName(folder.remote_path) || 'another computer';
        alert(`This cloud backup belongs to ${remoteComputer}. Use Restore to copy files from it; do not reconnect it as this PC's backup.`);
        return;
      }

      let paths = systemPaths;
      if (!paths || paths.length === 0) {
        paths = await loadSystemPaths();
      }
      const matchedSystemPath = paths.find(item => item.reconnectRemotePath && item.reconnectRemotePath === folder.remote_path);
      let localPath = matchedSystemPath ? matchedSystemPath.path : '';

      if (!localPath) {
        localPath = await ipcRenderer.invoke('folders:selectLocal');
      }
      if (!localPath) return;

      await ipcRenderer.invoke('folders:reconnect', { folderId: folder.id, localPath });
      loadAppConfigs();
      await ipcRenderer.invoke('sync:triggerNow');
    } catch (error) {
      alert(error.message || 'Failed to reconnect this backup folder.');
    }
  };

  const handleRemoveFolder = async (folderId) => {
    const folder = folders.find(f => f.id === folderId);
    const folderPath = folder ? folder.local_path : 'this folder';
    const confirmed = confirm(
      `Stop backing up:\n${folderPath}\n\n` +
      `Your existing encrypted files in Google Drive will NOT be deleted — ` +
      `they remain safe and can still be restored. ` +
      `Only future backups for this location will stop.\n\n` +
      `Continue?`
    );
    if (confirmed) {
      await ipcRenderer.invoke('folders:remove', folderId);
      loadAppConfigs();
    }
  };

  const handleToggleFolder = async (folderId, enabled) => {
    await ipcRenderer.invoke('folders:toggle', { folderId, enabled });
    loadAppConfigs();
  };

  const handleSyncNow = async () => {
    setSyncDetails('Starting backup...');
    await ipcRenderer.invoke('sync:triggerNow');
  };

  const handlePauseSync = async () => {
    await ipcRenderer.invoke('sync:pause');
    loadAppConfigs();
  };

  const handleResumeSync = async () => {
    await ipcRenderer.invoke('sync:resume');
    loadAppConfigs();
  };

  const handleClearActivity = async () => {
    await ipcRenderer.invoke('activity:clear');
    setFileActivity({});
    loadAppConfigs();
  };

  const handleCopyLogs = () => {
    if (logs.length === 0) return;
    const text = logs.map(log => {
      const time = new Date(log.synced_at).toLocaleString();
      const statusText = log.status === 'success' ? 'SUCCESS' : `FAILED (${log.error_msg || 'unknown error'})`;
      return `[${time}] ${log.action.toUpperCase()} - ${log.file_path} - Status: ${statusText}`;
    }).join('\n');
    
    navigator.clipboard.writeText(text);
    setCopiedLogs(true);
    setTimeout(() => setCopiedLogs(false), 2000);
  };

  const handleExportLogs = async () => {
    if (logs.length === 0) return;
    const text = logs.map(log => {
      const time = new Date(log.synced_at).toLocaleString();
      const statusText = log.status === 'success' ? 'SUCCESS' : `FAILED (${log.error_msg || 'unknown error'})`;
      return `[${time}] ${log.action.toUpperCase()} - ${log.file_path} - Status: ${statusText}`;
    }).join('\n');

    const success = await ipcRenderer.invoke('logs:export', { logsText: text });
    if (success) {
      alert('Logs exported successfully!');
    }
  };

  const handleDisconnect = async () => {
    if (confirm('WARNING: Disconnecting Google Drive will wipe all configuration settings, folders list, logs, and your master password from this PC. Are you sure you want to continue?')) {
      await ipcRenderer.invoke('auth:disconnect');
      setSetupComplete(false);
      setWizardStep(1);
      setGDriveConnected(false);
      setGDriveAuthStarted(false);
      setSetupMode('');
      setRemoteVaultInfo({ exists: false, passwordHint: '' });
      setOnboardingFolders([]);
      setPassword('');
      setConfirmPassword('');
      loadAppConfigs();
    }
  };

  // Restore folder browser logic
  const handleLoadRemoteDir = async (pathStr = '', options = {}) => {
    const normalizedPath = normalizeRemoteBrowsePath(pathStr);
    const requestId = restoreBrowseRequestRef.current + 1;
    restoreBrowseRequestRef.current = requestId;
    setRemotePath(normalizedPath);
    setRemoteItems([]);
    setRestoreBrowseError('');
    setRestoreLoading(true);
    try {
      if (restoreTab === 'live' && (!normalizedPath || normalizedPath === 'computers')) {
        syncComputerAliases({
          force: options.forceAliasSync === true,
          maxAgeMs: options.forceAliasSync === true ? 0 : 120000
        });
      }

      if (restoreTab === 'live' && !normalizedPath) {
        const folderRootItems = restorableFoldersList.map(folder => ({
          Name: getBackupFolderDisplayName(folder, restoreAliases),
          Path: normalizeRemoteBrowsePath(folder.remote_path),
          IsDir: true,
          Size: 0,
          ModTime: folder.last_success_at || folder.added_at || folder.imported_at,
          VirtualBackupRoot: true,
          FolderId: folder.id,
          Enabled: isBackupFolderEnabled(folder)
        }));

        const discoveredShortcuts = await ipcRenderer.invoke('restore:listShortcuts', {
          force: options.forceAliasSync === true
        });
        if (restoreBrowseRequestRef.current !== requestId) return;
        const shortcutItems = Array.isArray(discoveredShortcuts) ? discoveredShortcuts : [];

        const hasComputerBackups = [...restorableFoldersList, ...shortcutItems].some(item =>
          normalizeRemoteBrowsePath(item.remote_path || item.Path).startsWith(`${COMPUTER_BACKUPS_ROOT}/`)
        );

        // Computer-backed folders are already reachable through the aggregate
        // entry. Showing the same folder again as a root shortcut made one PC
        // appear twice under two different aliases.
        const shortcutPaths = new Set(shortcutItems.map(item => normalizeRemoteBrowsePath(item.Path).toLowerCase()));
        const nonComputerFolderItems = folderRootItems.filter(item =>
          !normalizeRemoteBrowsePath(item.Path).startsWith(`${COMPUTER_BACKUPS_ROOT}/`) &&
          !shortcutPaths.has(normalizeRemoteBrowsePath(item.Path).toLowerCase())
        );

        const rootItems = hasComputerBackups
          ? [{
              Name: 'Computer backups',
              Path: COMPUTER_BACKUPS_ROOT,
              IsDir: true,
              Size: 0,
              ModTime: getLatestFolderTimestamp(restorableFoldersList),
              VirtualComputerRoot: true
            }, ...shortcutItems, ...nonComputerFolderItems]
          : [...shortcutItems, ...folderRootItems];
        if (rootItems.length > 0) {
          setRemoteItems(rootItems);
          return;
        }
      }

      const items = await ipcRenderer.invoke('restore:listRemote', { remotePath: normalizedPath });
      if (restoreBrowseRequestRef.current !== requestId) return;
      
      // Filter out system folders from the root view of Live Vault
      if (restoreTab === 'live' && !normalizedPath) {
        const hiddenRoots = new Set([
          '.labsuite_trash', '.labsuite_history', '.labsuite_staging', '.labsuite_expired', '.labsuite_packs', '.labsuite_control',
          '.vaultsync_trash', '.vaultsync_history', '.vaultsync_staging', '.vaultsync_expired', '.vaultsync_packs', '.vaultsync_control'
        ]);
        setRemoteItems(items.filter(item => !hiddenRoots.has(item.Name)));
      } else {
        setRemoteItems(items);
      }
    } catch (error) {
      if (restoreBrowseRequestRef.current !== requestId) return;
      setRemoteItems([]);
      setRestoreBrowseError(error.message || 'LabSuite could not read this vault folder.');
    } finally {
      if (restoreBrowseRequestRef.current === requestId) {
        setRestoreLoading(false);
      }
    }
  };

  useEffect(() => {
    if (activeTab === 'restore') {
      if (restoreTab === 'live') {
        handleLoadRemoteDir('');
      } else {
        handleLoadRemoteDir('.labsuite_history');
      }
      setSelectedRemoteItem(null);
      setSelectedRestorePath('');
    }
  }, [restoreTab, activeTab]);

  const handleSelectRestoreDest = async () => {
    const dest = await ipcRenderer.invoke('folders:selectRestoreDest');
    if (dest) {
      setRestoreDest(dest);
    }
  };

  const openRestoreFolderPath = (folderRemotePath) => {
    if (!folderRemotePath) return;
    setActiveTab('restore');
    setRestoreSubTab('browse');
    setRestoreTab('live');
    setSelectedRemoteItem(null);
    setSelectedRestorePath('');
    setTimeout(() => {
      handleLoadRemoteDir(folderRemotePath);
    }, 50);
  };

  const handleEditComputerAlias = (computerName, mode = 'device') => {
    let parsedAliases = {};
    try {
      parsedAliases = JSON.parse(settings.computer_aliases || '{}');
    } catch (e) {}
    
    const currentAlias = parsedAliases[computerName] || '';
    setAliasModalComputer(computerName);
    setAliasModalValue(currentAlias);
    setAliasModalMode(mode);
    setShowAliasModal(true);
  };

  const handleSaveComputerAlias = async () => {
    const computerName = aliasModalComputer;
    const alias = aliasModalValue;
    const aliasLabel = String(alias || '').trim();
    let optimisticAliases = {};
    try {
      optimisticAliases = JSON.parse(settings.computer_aliases || '{}');
    } catch (e) {}

    if (aliasLabel) {
      optimisticAliases[computerName] = aliasLabel;
    } else {
      delete optimisticAliases[computerName];
    }

    setSettings(prev => ({
      ...prev,
      computer_aliases: JSON.stringify(optimisticAliases)
    }));
    setShowAliasModal(false);

    try {
      const updated = await ipcRenderer.invoke('aliases:save', {
        computerName,
        alias
      });
      
      if (updated) {
        setSettings(prev => ({
          ...prev,
          computer_aliases: JSON.stringify(updated)
        }));
      }
    } catch (error) {
      alert(`Could not save alias: ${error.message || error}`);
      syncComputerAliases({ force: true });
    }
  };

  const syncComputerAliases = async (options = {}) => {
    try {
      const merged = await ipcRenderer.invoke('aliases:sync', options);
      if (merged) {
        setSettings(prev => ({
          ...prev,
          computer_aliases: JSON.stringify(merged)
        }));
      }
      return merged || null;
    } catch (e) {
      console.log('Failed to sync computer aliases:', e.message);
      return null;
    }
  };

  const attachRestoreListeners = () => {
    const progListener = (event, data) => {
      setRestoreProgress(data);
    };

    const compListener = () => {
      setRestoreStatus('success');
      setRestoreProgress(null);
      ipcRenderer.removeListener('restore:progress', progListener);
      ipcRenderer.removeListener('restore:complete', compListener);
      ipcRenderer.removeListener('restore:error', errListener);
    };

    const errListener = (event, data) => {
      setRestoreStatus('error');
      alert(`Restore failed: ${data.error}`);
      ipcRenderer.removeListener('restore:progress', progListener);
      ipcRenderer.removeListener('restore:complete', compListener);
      ipcRenderer.removeListener('restore:error', errListener);
    };

    ipcRenderer.on('restore:progress', progListener);
    ipcRenderer.on('restore:complete', compListener);
    ipcRenderer.on('restore:error', errListener);
  };

  const handlePreviewRestorePoint = async () => {
    const point = restorePoints.find(item => String(item.id) === String(selectedRestorePointId));
    if (!point) return;
    setIsPlanningRestorePoint(true);
    try {
      const plan = await ipcRenderer.invoke('backup:planRestorePoint', {
        folderId: point.folder_id,
        restoreTime: point.completed_at
      });
      setRestorePointPlan(plan);
    } finally {
      setIsPlanningRestorePoint(false);
    }
  };

  const handleRestorePointRestore = async () => {
    const point = restorePoints.find(item => String(item.id) === String(selectedRestorePointId));
    if (!point || !restoreDest) return;
    setRestoreStatus('restoring');
    attachRestoreListeners();
    await ipcRenderer.invoke('restore:pointInTime', {
      folderId: point.folder_id,
      restoreTime: point.completed_at,
      localDestination: restoreDest
    });
  };

  const handleStartRestore = async () => {
    if (!restoreDest) return;
    setRestoreStatus('restoring');
    attachRestoreListeners();

    if (selectedRemoteItem && selectedRemoteItem.Packed) {
      await ipcRenderer.invoke('restore:packedFile', {
        packRemotePath: selectedRemoteItem.PackRemotePath,
        relativePath: selectedRemoteItem.RelativePath || selectedRemoteItem.Path,
        localDestination: restoreDest
      });
    } else {
      await ipcRenderer.invoke('restore:start', { 
        remotePath: selectedRestorePath || remotePath, 
        localDestination: restoreDest 
      });
    }
  };

  const handleInlineFolderRestore = async (folderItem, folderFullPath) => {
    const dest = await ipcRenderer.invoke('folders:selectRestoreDest');
    if (!dest) return;
    setSelectedRemoteItem(folderItem);
    setSelectedRestorePath(folderFullPath);
    setRestoreDest(dest);
    setRestoreStatus('restoring');
    attachRestoreListeners();
    await ipcRenderer.invoke('restore:start', {
      remotePath: folderFullPath,
      localDestination: dest
    });
  };

  const handleInlineFileRestore = async (fileItem, fileFullPath) => {
    const dest = await ipcRenderer.invoke('folders:selectRestoreDest');
    if (!dest) return;
    setSelectedRemoteItem(fileItem);
    setSelectedRestorePath(fileFullPath);
    setRestoreDest(dest);
    setRestoreStatus('restoring');
    attachRestoreListeners();

    try {
      if (fileItem && fileItem.Packed) {
        await ipcRenderer.invoke('restore:packedFile', {
          packRemotePath: fileItem.PackRemotePath,
          relativePath: fileItem.RelativePath || fileItem.Path || fileFullPath,
          localDestination: dest
        });
      } else {
        await ipcRenderer.invoke('restore:start', {
          remotePath: fileFullPath,
          localDestination: dest
        });
      }
    } catch (error) {
      setRestoreStatus('error');
      alert(`Restore failed: ${error.message || error}`);
    }
  };

  const handleDeleteRemoteItem = async (item, itemFullPath) => {
    const normalizedPath = normalizeRemoteBrowsePath(itemFullPath);
    if (!normalizedPath || restoreTab !== 'live') return;
    if (item?.Packed || item?.PackedVirtual) {
      alert('This is a packed virtual item. Restore it first, or delete the whole backup folder that contains it.');
      return;
    }

    const activeRoot = folders.find(folder => {
      const enabled = folder.enabled === 1 || folder.enabled === true || folder.enabled === undefined;
      return enabled && folder.remote_path && (
        isRemotePathInside(folder.remote_path, normalizedPath) ||
        isRemotePathInside(normalizedPath, folder.remote_path)
      );
    });
    if (activeRoot) {
      alert(`"${activeRoot.local_path}" is still an active backup on this PC. Stop backing it up first, otherwise LabSuite would upload it again.`);
      return;
    }

    const label = getFriendlyRestorePath(normalizedPath, restorableFoldersList, restoreAliases);
    const confirmed = confirm(
      `Move this backup item to LabSuite Trash?\n\n${label}\n\n` +
      'This removes it from the live encrypted vault. Google Drive will still show encrypted object names, so use LabSuite to manage this safely.'
    );
    if (!confirmed) return;

    setVaultDeleteStatus('deleting');
    try {
      await ipcRenderer.invoke('restore:deleteRemote', { remotePath: normalizedPath });
      setSelectedRemoteItem(null);
      setSelectedRestorePath('');
      await loadAppConfigs();
      await handleLoadRemoteDir(remotePath, { forceAliasSync: true });
      setVaultDeleteStatus('deleted');
      setTimeout(() => setVaultDeleteStatus(''), 2500);
    } catch (error) {
      setVaultDeleteStatus('');
      alert(error.message || 'Failed to delete this vault item.');
    }
  };

  const handleVerifyBackup = async (folderId) => {
    setVerifyingFolderId(folderId);
    setVerifyLogs(['Starting cryptographic verification...']);
    try {
      await ipcRenderer.invoke('health:verify', { folderId });
      setVerifyLogs(prev => [...prev, '✅ Verification complete. All files intact.']);
    } catch (e) {
      setVerifyLogs(prev => [...prev, `❌ Verification failed: ${e.message}`]);
    }
    setTimeout(() => {
      setVerifyingFolderId(null);
      setVerifyLogs([]);
    }, 5000); // Clear after 5s
  };

  const handleRunRestoreDrill = async () => {
    setRestoreDrillRunning(true);
    setRestoreDrillReport(null);
    try {
      const report = await ipcRenderer.invoke('health:restoreDrill', { maxFiles: 10 });
      setRestoreDrillReport(report);
    } catch (e) {
      setRestoreDrillReport({
        ok: false,
        sampled: 0,
        passed: 0,
        failed: 1,
        skipped: 0,
        durationMs: 0,
        details: [{ relativePath: 'Restore drill', error: e.message || String(e), ok: false }]
      });
    } finally {
      setRestoreDrillRunning(false);
    }
  };

  const handleExportDiagnostics = async () => {
    setDiagnosticsStatus('exporting');
    try {
      const result = await ipcRenderer.invoke('diagnostics:export');
      if (result && result.success) {
        setDiagnosticsStatus('exported');
        setTimeout(() => setDiagnosticsStatus(''), 2500);
      } else {
        setDiagnosticsStatus('');
      }
    } catch (error) {
      console.error('Failed to export diagnostics:', error);
      setDiagnosticsStatus('error');
      alert(error.message || 'Failed to export diagnostics.');
      setTimeout(() => setDiagnosticsStatus(''), 2500);
    }
  };

  const handleCopyFailureLog = async () => {
    setDiagnosticsStatus('exporting');
    try {
      const text = await ipcRenderer.invoke('diagnostics:getFailureLog');
      await navigator.clipboard.writeText(String(text || ''));
      setDiagnosticsStatus('copied');
      setTimeout(() => setDiagnosticsStatus(''), 2500);
    } catch (error) {
      console.error('Failed to copy failure log:', error);
      setDiagnosticsStatus('error');
      alert(error.message || 'Failed to copy the failure log.');
      setTimeout(() => setDiagnosticsStatus(''), 2500);
    }
  };

  // Rendering Helper: Step Wizard
  if (setupComplete === false) {
    const onboardingStepCount = setupMode === 'backup' ? 4 : 3;
    const panelStyle = {
      background: 'rgba(48, 63, 68, 0.45)',
      padding: '16px',
      borderRadius: '8px',
      border: '1px solid var(--border-color)',
      marginBottom: '20px'
    };
    const optionStyle = {
      width: '100%',
      textAlign: 'left',
      background: 'rgba(48, 63, 68, 0.45)',
      border: '1px solid var(--border-color)',
      borderRadius: '8px',
      padding: '16px',
      color: 'var(--text-primary)',
      cursor: 'pointer',
      marginBottom: '12px'
    };
    const vaultHint = remoteVaultInfo.passwordHint || '';
    const passwordCheckStyle = passwordCheckStatus ? {
      background: passwordCheckStatus === 'error' ? 'rgba(224, 108, 117, 0.12)' : 'rgba(97, 135, 100, 0.14)',
      border: passwordCheckStatus === 'error' ? '1px solid rgba(224, 108, 117, 0.35)' : '1px solid rgba(156, 176, 128, 0.25)',
      color: passwordCheckStatus === 'error' ? 'var(--accent-error)' : 'var(--accent-secondary)',
      fontSize: '13px',
      fontWeight: 600,
      lineHeight: 1.45,
      margin: '12px 0',
      padding: '10px 12px',
      textAlign: 'center',
      borderRadius: '6px'
    } : null;

    return (
      <div className="onboarding-container">
        <div className="onboarding-card">
          <div className="step-indicator">
            {Array.from({ length: onboardingStepCount }).map((_, index) => (
              <div
                key={index}
                className={`step-dot ${wizardStep >= index + 1 ? 'completed' : ''} ${wizardStep === index + 1 ? 'active' : ''}`}
              />
            ))}
          </div>

          {wizardStep === 1 && (
            <div>
              <h1 className="setup-title">Set Up LabSuite</h1>
              <p className="setup-description" style={{ marginBottom: '24px' }}>
                First connect the Google Drive account that holds your LabSuite backup, or the account you want to use for a new backup.
              </p>

              <div style={panelStyle}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600 }}>Google Drive Account</h3>
                <p style={{ margin: '0 0 14px 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
                  LabSuite needs Drive access before it can check for an existing vault or create a new one.
                </p>

                {!gdriveConnected && renderGoogleClientFields()}

                {authError && <p style={{ color: 'var(--accent-error)', fontSize: '13px', margin: '8px 0 12px 0', textAlign: 'center' }}>{authError}</p>}

                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  {!gdriveConnected ? (
                    <button
                      className="btn btn-primary"
                      style={{ padding: '8px 18px', display: 'flex', alignItems: 'center', gap: '8px' }}
                      disabled={gdriveAuthStarted}
                      onClick={handleStartGoogleAuth}
                    >
                      {gdriveAuthStarted ? (
                        <>
                          <div className="animate-spin" style={{ width: '12px', height: '12px', border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%' }} />
                          Approve in Browser...
                        </>
                      ) : 'Connect Google Drive'}
                    </button>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                      <span className="badge badge-success" style={{ fontSize: '12px', padding: '4px 10px' }}>
                        Google Drive Connected
                      </span>
                      <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                        {gdriveInfo.email}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '24px' }}>
                <button
                  className="btn btn-primary"
                  style={{ padding: '10px 24px' }}
                  disabled={!gdriveConnected || isContinuingFromGoogle}
                  onClick={handleContinueFromGoogle}
                >
                  {isContinuingFromGoogle ? 'Checking...' : 'Continue'}
                </button>
              </div>
            </div>
          )}

          {wizardStep === 2 && (
            <div>
              <h1 className="setup-title">Choose How To Use This PC</h1>
              <p className="setup-description" style={{ marginBottom: '24px' }}>
                You can unlock files backed up from another PC without backing up anything from this one.
              </p>

              <div style={{ ...panelStyle, marginBottom: '16px' }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600 }}>Detected Vault</h3>
                <p style={{ margin: 0, fontSize: '12.5px', color: remoteVaultInfo.exists ? 'var(--accent-secondary)' : 'var(--text-secondary)' }}>
                  {isCheckingRemoteVault
                    ? 'Checking Google Drive for an existing LabSuite or VaultSync vault...'
                    : remoteVaultInfo.exists
                    ? `Backup vault data was found in ${remoteVaultInfo.encryptedFolder || 'Google Drive'}.`
                    : 'No existing LabSuite vault was detected on this Google account.'}
                </p>
              </div>

              <button type="button" style={optionStyle} onClick={() => handleChooseSetupMode('access')}>
                <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '6px' }}>Access files already backed up</div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  Use the master password from your original PC, then go straight to Restore Files. No local folders are backed up.
                </div>
              </button>

              <button type="button" style={optionStyle} onClick={() => handleChooseSetupMode('backup')}>
                <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '6px' }}>Start a new backup on this PC</div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  Create a new master password for future backups. This will not unlock files encrypted with another password.
                </div>
              </button>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                <button className="btn btn-secondary" style={{ padding: '10px 20px' }} onClick={() => setWizardStep(1)}>Back</button>
              </div>
            </div>
          )}

          {wizardStep === 3 && (
            <div>
              <h1 className="setup-title">{setupMode === 'access' ? 'Enter Master Password' : 'Create Master Password'}</h1>
              <p className="setup-description" style={{ marginBottom: '24px' }}>
                {setupMode === 'access'
                  ? 'Use the same master password that was used when these files were backed up.'
                  : 'This password encrypts new backups from this PC. LabSuite cannot recover it if it is lost.'}
              </p>

              <div style={panelStyle}>
                {setupMode === 'access' && (
                  <div style={{ background: 'rgba(156, 176, 128, 0.08)', border: '1px solid rgba(156, 176, 128, 0.18)', padding: '10px 12px', borderRadius: '6px', marginBottom: '14px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                    <strong style={{ color: 'var(--text-primary)' }}>Password hint:</strong>{' '}
                    {vaultHint ? vaultHint : 'No hint was saved for this vault.'}
                  </div>
                )}

                {setupMode !== 'access' && (
                  <div style={{ background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.15)', padding: '8px 12px', borderRadius: '6px', marginBottom: '14px', fontSize: '11.5px', color: '#fca5a5', lineHeight: '1.4' }}>
                    Zero-knowledge protection: if this password is lost, files encrypted with it cannot be recovered.
                  </div>
                )}

                <div className="form-group" style={{ marginBottom: '12px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600 }}>Master Password</label>
                  <div style={{ position: 'relative', marginTop: '4px' }}>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      className="input-control"
                      placeholder={setupMode === 'access' ? 'Password from original PC' : 'At least 8 characters'}
                      value={password}
                      onChange={e => {
                        setPassword(e.target.value);
                        setPasswordCheckStatus('');
                        setPasswordCheckMessage('');
                      }}
                      style={{ paddingRight: '45px', padding: '8px 10px', fontSize: '13px' }}
                    />
                    <button
                      type="button"
                      style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '11px' }}
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>

                {setupMode !== 'access' && (
                  <>
                    <div className="form-group" style={{ marginBottom: '12px' }}>
                      <label style={{ fontSize: '12px', fontWeight: 600 }}>Confirm Password</label>
                      <div style={{ position: 'relative', marginTop: '4px' }}>
                        <input
                          type={showPassword ? 'text' : 'password'}
                          className="input-control"
                          placeholder="Re-enter password"
                          value={confirmPassword}
                          onChange={e => setConfirmPassword(e.target.value)}
                          style={{ paddingRight: '45px', padding: '8px 10px', fontSize: '13px' }}
                        />
                        <button
                          type="button"
                          style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '11px' }}
                          onClick={() => setShowPassword(!showPassword)}
                        >
                          {showPassword ? 'Hide' : 'Show'}
                        </button>
                      </div>
                    </div>

                    <div className="form-group" style={{ marginBottom: '4px' }}>
                      <label style={{ fontSize: '12px', fontWeight: 600 }}>Password Hint (Optional)</label>
                      <input
                        type="text"
                        className="input-control"
                        style={{ marginTop: '4px', padding: '8px 10px', fontSize: '13px' }}
                        placeholder="A hint you can safely see on another PC"
                        value={passwordHint}
                        onChange={e => setPasswordHint(e.target.value)}
                      />
                    </div>
                  </>
                )}
              </div>

              {passwordError && <p style={{ color: 'var(--accent-error)', fontSize: '13px', margin: '12px 0', textAlign: 'center' }}>{passwordError}</p>}
              {setupMode === 'access' && passwordCheckMessage && (
                <div role="status" aria-live="polite" style={passwordCheckStyle}>
                  {passwordCheckMessage}
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'space-between', marginTop: '24px' }}>
                <button className="btn btn-secondary" style={{ padding: '10px 20px' }} onClick={() => setWizardStep(2)}>Back</button>
                <button
                  className="btn btn-primary"
                  style={{ padding: '10px 24px' }}
                  disabled={isSavingPassword || !password || (setupMode !== 'access' && !confirmPassword)}
                  onClick={handleSavePassword}
                >
                  {isSavingPassword
                    ? passwordCheckStatus === 'success' ? 'Password matches' : setupMode === 'access' ? 'Checking password...' : 'Saving...'
                    : setupMode === 'access' ? 'Unlock Existing Vault' : 'Continue to Folder Setup'}
                </button>
              </div>
            </div>
          )}

          {wizardStep === 4 && (
            <div>
              <h1 className="setup-title">Add Backup Folders</h1>
              <p className="setup-description" style={{ marginBottom: '20px' }}>
                Select the folders you want to back up from this PC. You can choose from standard system folders or add custom locations.
              </p>

              {/* Discovered System Folders Section */}
              <div style={{ ...panelStyle, marginBottom: '16px', padding: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h3 style={{ margin: 0, fontSize: '13.5px', fontWeight: 600 }}>Standard System Folders</h3>
                  {systemPaths.length > 0 && (
                    <button
                      className="btn-text"
                      style={{ background: 'transparent', border: 'none', color: 'var(--accent-primary)', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}
                      onClick={() => {
                        const allPaths = systemPaths.map(p => p.path);
                        const hasAllSelected = systemPaths.every(p => onboardingFolders.includes(p.path));
                        if (hasAllSelected) {
                          // Deselect all system paths (keep only custom paths)
                          setOnboardingFolders(onboardingFolders.filter(f => !allPaths.includes(f)));
                        } else {
                          // Select all system paths (preserve existing custom paths)
                          const uniquePaths = Array.from(new Set([...onboardingFolders, ...allPaths]));
                          setOnboardingFolders(uniquePaths);
                        }
                      }}
                    >
                      {systemPaths.every(p => onboardingFolders.includes(p.path)) ? 'Deselect All' : 'Select All'}
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '240px', overflowY: 'auto', paddingRight: '4px' }}>
                  {systemPaths.length === 0 ? (
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', margin: '12px 0' }}>Discovering system folders...</p>
                  ) : (
                    systemPaths.map(sp => {
                      const isChecked = onboardingFolders.includes(sp.path);
                      const getIcon = (id) => {
                        switch (id) {
                          case 'desktop': return '🖥️';
                          case 'documents': return '📁';
                          case 'pictures': return '🖼️';
                          case 'downloads': return '📥';
                          case 'music': return '🎵';
                          case 'videos': return '🎥';
                          default: return '📁';
                        }
                      };
                      return (
                        <div
                          key={sp.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '10px 12px',
                            background: isChecked ? 'rgba(99, 102, 241, 0.08)' : 'rgba(0, 0, 0, 0.15)',
                            border: isChecked ? '1px solid rgba(99, 102, 241, 0.3)' : '1px solid rgba(255, 255, 255, 0.03)',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            transition: 'all 0.2s ease'
                          }}
                          onClick={() => {
                            if (isChecked) {
                              setOnboardingFolders(onboardingFolders.filter(f => f !== sp.path));
                            } else {
                              setOnboardingFolders([...onboardingFolders, sp.path]);
                            }
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: '18px', flexShrink: 0 }}>{getIcon(sp.id)}</span>
                            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{sp.name}</span>
                              <span style={{ fontSize: '11px', color: 'var(--text-muted)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={sp.path}>
                                {sp.path}
                              </span>
                            </div>
                          </div>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            readOnly
                            style={{ width: '15px', height: '15px', cursor: 'pointer', accentColor: 'var(--accent-primary)', marginLeft: '10px' }}
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Custom Folders Section */}
              <div style={{ ...panelStyle, marginBottom: '24px', padding: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h3 style={{ margin: 0, fontSize: '13.5px', fontWeight: 600 }}>Custom Locations</h3>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '11.5px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}
                    onClick={handleSelectOnboardingFolder}
                  >
                    ➕ Add Custom Folder
                  </button>
                </div>

                {(() => {
                  const customFolders = onboardingFolders.filter(f => !systemPaths.some(sp => sp.path === f));
                  if (customFolders.length === 0) {
                    return (
                      <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '11.5px', border: '1px dashed rgba(255,255,255,0.06)', borderRadius: '6px' }}>
                        No custom folders added yet.
                      </div>
                    );
                  }
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '150px', overflowY: 'auto' }}>
                      {customFolders.map((folderPath, idx) => (
                        <div
                          key={idx}
                          style={{
                            background: 'rgba(0,0,0,0.15)',
                            border: '1px solid rgba(255,255,255,0.03)',
                            padding: '8px 12px',
                            borderRadius: '6px',
                            fontSize: '12px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                          }}
                        >
                          <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '380px', fontWeight: 500 }} title={folderPath}>
                            {folderPath}
                          </span>
                          <button
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--accent-error)',
                              cursor: 'pointer',
                              fontWeight: 'bold',
                              fontSize: '14px',
                              padding: '0 4px'
                            }}
                            onClick={() => setOnboardingFolders(onboardingFolders.filter(f => f !== folderPath))}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'space-between', marginTop: '24px' }}>
                <button className="btn btn-secondary" style={{ padding: '10px 20px' }} onClick={() => setWizardStep(3)}>Back</button>
                <button
                  className="btn btn-primary"
                  style={{ padding: '10px 24px' }}
                  onClick={handleFinishOnboarding}
                >
                  {onboardingFolders.length > 0 ? 'Start Backing Up & Finish Setup' : 'Finish Setup'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );

    return (
      <div className="onboarding-container">
        <div className="onboarding-card">
          <div className="step-indicator">
            <div className={`step-dot ${wizardStep >= 1 ? 'completed' : ''} ${wizardStep === 1 ? 'active' : ''}`} />
            <div className={`step-dot ${wizardStep >= 2 ? 'completed' : ''} ${wizardStep === 2 ? 'active' : ''}`} />
          </div>

          {wizardStep === 1 && (
            <div>
              <h1 className="setup-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                🔒 Set Up LabSuite
              </h1>
              <p className="setup-description" style={{ marginBottom: '24px' }}>
                Welcome! Link your Google Drive account and configure your master encryption password to begin protecting your files.
              </p>

              {/* 1. Google Drive Connection Card */}
              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.04)', marginBottom: '20px' }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600 }}>1. Cloud Account</h3>
                <p style={{ margin: '0 0 14px 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
                  Authorize LabSuite to transfer encrypted backups directly to your Google Drive.
                </p>

                {!gdriveConnected && renderGoogleClientFields()}

                {authError && <p style={{ color: 'var(--accent-error)', fontSize: '13px', margin: '8px 0 12px 0', textAlign: 'center' }}>{authError}</p>}

                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  {!gdriveConnected ? (
                    <button 
                      className="btn btn-primary" 
                      style={{ padding: '8px 18px', display: 'flex', alignItems: 'center', gap: '8px' }}
                      disabled={gdriveAuthStarted}
                      onClick={handleStartGoogleAuth}
                    >
                      {gdriveAuthStarted ? (
                        <>
                          <div className="animate-spin" style={{ width: '12px', height: '12px', border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%' }} />
                          Approve in Browser...
                        </>
                      ) : 'Connect Google Drive'}
                    </button>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                      <span className="badge badge-success" style={{ fontSize: '12px', padding: '4px 10px' }}>
                        ✓ Google Drive Connected
                      </span>
                      <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                        {gdriveInfo.email}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* 2. Master Password Card */}
              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.04)', marginBottom: '20px' }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600 }}>2. Security Credentials</h3>
                <p style={{ margin: '0 0 14px 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
                  Files are encrypted locally. You must enter a master password to decrypt them.
                </p>

                <div style={{ background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.15)', padding: '8px 12px', borderRadius: '6px', marginBottom: '14px', fontSize: '11.5px', color: '#fca5a5', lineHeight: '1.4' }}>
                  ⚠️ Zero-Knowledge Protection: If lost, your backed-up files cannot be recovered. LabSuite does not store your password.
                </div>

                <div className="form-group" style={{ marginBottom: '12px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600 }}>Master Password</label>
                  <div style={{ position: 'relative', marginTop: '4px' }}>
                    <input 
                      type={showPassword ? "text" : "password"} 
                      className="input-control" 
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      style={{ paddingRight: '45px', padding: '8px 10px', fontSize: '13px' }}
                    />
                    <button
                      type="button"
                      style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '11px' }}
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>

                <div className="form-group" style={{ marginBottom: '12px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600 }}>Confirm Password</label>
                  <div style={{ position: 'relative', marginTop: '4px' }}>
                    <input 
                      type={showPassword ? "text" : "password"} 
                      className="input-control" 
                      placeholder="Re-enter password"
                      value={confirmPassword}
                      onChange={e => setConfirmPassword(e.target.value)}
                      style={{ paddingRight: '45px', padding: '8px 10px', fontSize: '13px' }}
                    />
                    <button
                      type="button"
                      style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '11px' }}
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>

                <div className="form-group" style={{ marginBottom: '4px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600 }}>Password Hint (Optional)</label>
                  <input 
                    type="text" 
                    className="input-control" 
                    style={{ marginTop: '4px', padding: '8px 10px', fontSize: '13px' }}
                    placeholder="e.g. My childhood pet name"
                    value={passwordHint}
                    onChange={e => setPasswordHint(e.target.value)}
                  />
                </div>
              </div>

              {passwordError && <p style={{ color: 'var(--accent-error)', fontSize: '13px', margin: '12px 0', textAlign: 'center' }}>{passwordError}</p>}

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '24px' }}>
                <button
                  className="btn btn-primary" 
                  style={{ padding: '10px 24px' }}
                  disabled={!gdriveConnected || !password || !confirmPassword} 
                  onClick={handleSavePassword}
                >
                  Continue to Folder Setup
                </button>
              </div>
            </div>
          )}

          {wizardStep === 2 && (
            <div>
              <h1 className="setup-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                📁 Add Initial Backup Folders
              </h1>
              <p className="setup-description" style={{ marginBottom: '24px' }}>
                Select the folders on your computer that you want to encrypt and back up to Google Drive. You can add or change folders at any time.
              </p>

              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.04)', marginBottom: '24px' }}>
                <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600 }}>Selected Backup Paths</h3>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: onboardingFolders.length > 0 ? '16px' : '0' }}>
                  {onboardingFolders.length === 0 ? (
                    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', border: '1.5px dashed rgba(255,255,255,0.06)', borderRadius: '8px' }}>
                      No folders selected yet. Click the button below to add your first folder.
                    </div>
                  ) : (
                    onboardingFolders.map((path, idx) => (
                      <div key={idx} style={{ background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(255,255,255,0.03)', padding: '10px 14px', borderRadius: '6px', fontSize: '13px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '380px', fontWeight: 500 }}>📁 {path}</span>
                        <button style={{ background: 'transparent', border: 'none', color: 'var(--accent-error)', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px', padding: '0 4px' }} onClick={() => setOnboardingFolders(onboardingFolders.filter(f => f !== path))}>×</button>
                      </div>
                    ))
                  )}
                </div>
                
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <button className="btn btn-secondary" style={{ padding: '8px 18px', fontSize: '12.5px', fontWeight: 600 }} onClick={handleSelectOnboardingFolder}>
                    ➕ Select Folder from PC
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'space-between', marginTop: '24px' }}>
                <button className="btn btn-secondary" style={{ padding: '10px 20px' }} onClick={() => setWizardStep(1)}>Back</button>
                <button 
                  className="btn btn-primary" 
                  style={{ padding: '10px 24px' }}
                  disabled={onboardingFolders.length === 0} 
                  onClick={handleFinishOnboarding}
                >
                  Start Backing Up &amp; Finish Setup
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Rendering Helper: Main Shell
  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatSpeed = (bytesPerSec) => {
    if (!bytesPerSec || bytesPerSec <= 0) return '';
    return formatBytes(bytesPerSec) + '/s';
  };

  const formatEta = (etaSec) => {
    if (etaSec === null || etaSec === undefined || etaSec < 0) return 'Calculating...';
    if (etaSec < 60) return `${etaSec}s remaining`;
    if (etaSec < 3600) return `${Math.round(etaSec / 60)}m remaining`;
    const h = Math.floor(etaSec / 3600);
    const m = Math.round((etaSec % 3600) / 60);
    return `${h}h ${m}m remaining`;
  };

  const formatDuration = (seconds) => {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    if (value < 60) return `${value}s`;
    if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    return `${h}h ${m}m`;
  };

  const formatDateTime = (value) => {
    if (!value) return 'Never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Never';
    return date.toLocaleString();
  };

  const getReadableError = (value) => {
    if (!value) return '';
    const text = String(value).trim();
    if (!text) return '';

    const messages = [];
    let duplicateDirWarnings = 0;
    const isSharedClientNotice = (message) => {
      const normalized = String(message || '').toLowerCase();
      return normalized.includes('shared google drive client_id') &&
        (normalized.includes('retir') || normalized.includes('stop working during 2026'));
    };

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const entry = JSON.parse(trimmed);
        if (entry?.msg === 'Duplicate directory found in destination - ignoring') {
          duplicateDirWarnings += 1;
          continue;
        }
        if (entry?.msg) {
          if (isSharedClientNotice(entry.msg)) continue;
          messages.push(entry.object ? `${entry.object}: ${entry.msg}` : entry.msg);
          continue;
        }
      } catch (_) {
        // Keep plain text errors readable below.
      }

      messages.push(...trimmed.split(/\s*;\s*/).filter(message => message && !isSharedClientNotice(message)));
    }

    if (duplicateDirWarnings > 0 && messages.length === 0) {
      return `${duplicateDirWarnings} duplicate Google Drive destination folder warning${duplicateDirWarnings === 1 ? '' : 's'}. rclone ignored the duplicates; clean up duplicate folder names in Drive if this repeats.`;
    }

    if (messages.length === 0 && isSharedClientNotice(text)) {
      return 'The last backup attempt failed, but an rclone retirement notice hid the cause. Retry with this LabSuite version to record the real error.';
    }

    const combined = [...new Set(messages)]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim() || text.replace(/\s+/g, ' ').trim();

    return combined.length > 260 ? `${combined.slice(0, 257).trim()}...` : combined;
  };

  const getFolderProgress = (folder) => {
    const live = folderProgress[folder.id];
    if (live) {
      return {
        ...live,
        error: getReadableError(live.error)
      };
    }

    return {
      folderId: folder.id,
      folderPath: folder.local_path,
      stage: folder.sync_state === 'error' ? 'error' : (folder.last_success_at ? 'complete' : 'waiting'),
      stageLabel: folder.sync_state === 'error'
        ? 'Backup failed'
        : (folder.last_success_at ? 'Protected' : 'Waiting for initial scan'),
      percent: folder.sync_percent || (folder.last_success_at ? 100 : 0),
      filesDone: folder.sync_files_done || 0,
      filesTotal: folder.sync_files_total || 0,
      bytesDone: folder.sync_bytes_done || 0,
      bytesTotal: folder.sync_bytes_total || 0,
      speed: folder.sync_speed || 0,
      etaSec: folder.sync_eta ?? null,
      currentItem: folder.sync_current_item || '',
      error: getReadableError(folder.last_error)
    };
  };

  const getFolderStatusBadge = (folder, progress) => {
    const summary = getManifestSummaryForFolder(folder.id);
    if (summary.atRiskFiles > 0) {
      return { text: 'At risk', color: '#f97316', bg: 'rgba(249,115,22,0.16)' };
    }
    if (progress.stage === 'error' || folder.consecutive_failures > 0) {
      return { text: 'Failed', color: '#fca5a5', bg: 'rgba(239,68,68,0.14)' };
    }
    if (['queued', 'scanning', 'preparing', 'versioning', 'encrypting_uploading', 'deleting'].includes(progress.stage)) {
      return { text: progress.stage === 'scanning' ? 'Scanning' : 'Backing up', color: '#93c5fd', bg: 'rgba(59,130,246,0.14)' };
    }
    if (folder.last_success_at) {
      return { text: 'Protected', color: '#34d399', bg: 'rgba(16,185,129,0.14)' };
    }
    return { text: 'Needs backup', color: '#fbbf24', bg: 'rgba(245,158,11,0.14)' };
  };

  const getManifestSummaryForFolder = (folderId) => {
    return backupManifestSummary.find(item => item.folderId === folderId) || {
      protectedFiles: 0,
      pendingFiles: 0,
      deletedFiles: 0,
      failedFiles: 0,
      atRiskFiles: 0,
      versionCount: 0
    };
  };

  const getActivityStatusStyle = (status) => {
    if (status === 'packing') {
      return { label: 'Packing', color: '#93c5fd', bg: 'rgba(59,130,246,0.14)', symbol: 'up' };
    }
    if (['uploading', 'versioning', 'preparing', 'packing'].includes(status)) {
      const label = status === 'versioning' ? 'Versioning' : (status === 'packing' ? 'Packing' : 'Uploading');
      return { label: status === 'versioning' ? 'Versioning' : 'Uploading', color: '#93c5fd', bg: 'rgba(59,130,246,0.14)', symbol: '↑' };
    }
    if (status === 'completed') {
      return { label: 'Complete', color: '#34d399', bg: 'rgba(16,185,129,0.14)', symbol: '✓' };
    }
    if (status === 'failed') {
      return { label: 'Failed', color: '#fca5a5', bg: 'rgba(239,68,68,0.14)', symbol: '!' };
    }
    if (status === 'at_risk') {
      return { label: 'At risk', color: '#fdba74', bg: 'rgba(249,115,22,0.16)', symbol: '!' };
    }
    if (status === 'skipped') {
      return { label: 'Skipped', color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.06)', symbol: '-' };
    }
    return { label: 'Queued', color: '#fbbf24', bg: 'rgba(245,158,11,0.14)', symbol: '…' };
  };

  const formatActivityTime = (row) => {
    const value = row.completedAt || row.updatedAt || row.startedAt || row.queuedAt;
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString();
  };

  const renderFileActivityTable = (rows, { compact = false } = {}) => {
    const maxRows = compact ? 60 : 220;
    const visibleRows = rows.slice(0, maxRows);
    return (
    <div style={{ maxHeight: compact ? '240px' : '520px', overflowY: 'auto', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: compact ? '11.5px' : '12.5px', textAlign: 'left' }}>
        <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1 }}>
          <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
            <th style={{ padding: compact ? '8px 10px' : '10px 12px' }}>Status</th>
            <th style={{ padding: compact ? '8px 10px' : '10px 12px' }}>Name</th>
            {!compact && <th style={{ padding: '10px 12px' }}>Folder</th>}
            <th style={{ padding: compact ? '8px 10px' : '10px 12px' }}>Size</th>
            <th style={{ padding: compact ? '8px 10px' : '10px 12px' }}>Progress</th>
            {!compact && <th style={{ padding: '10px 12px' }}>Time</th>}
            {!compact && <th style={{ padding: '10px 12px' }}>Issue</th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={compact ? 5 : 7} style={{ padding: '22px', textAlign: 'center', color: 'var(--text-muted)' }}>
                No live file activity yet.
              </td>
            </tr>
          ) : visibleRows.map((row, rowIndex) => {
            const status = getActivityStatusStyle(row.status);
            const active = ['uploading', 'versioning', 'preparing', 'packing'].includes(row.status);
            const pct = Math.max(0, Math.min(100, Number(row.percent) || 0));
            const showIndeterminate = active && pct === 0 && rowIndex < 8;
            return (
              <tr key={row.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.035)' }}>
                <td style={{ padding: compact ? '8px 10px' : '10px 12px', whiteSpace: 'nowrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: status.color, background: status.bg, borderRadius: '999px', padding: '3px 8px', fontSize: compact ? '10.5px' : '11px', fontWeight: 700 }}>
                    <span>{status.symbol}</span>{status.label}
                  </span>
                </td>
                <td style={{ padding: compact ? '8px 10px' : '10px 12px', minWidth: 0 }}>
                  <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: compact ? '360px' : '460px' }} title={row.localPath || row.relativePath}>
                    {row.fileName || row.relativePath}
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: compact ? '360px' : '460px' }}>
                    {row.relativePath}
                  </div>
                </td>
                {!compact && (
                  <td style={{ padding: '10px 12px', color: 'var(--text-muted)', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.folderPath}>
                    {row.folderPath}
                  </td>
                )}
                <td style={{ padding: compact ? '8px 10px' : '10px 12px', whiteSpace: 'nowrap' }}>
                  {formatBytes(row.size || row.bytesTotal || 0)}
                </td>
                <td style={{ padding: compact ? '8px 10px' : '10px 12px', minWidth: compact ? '130px' : '180px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ flex: 1, height: '5px', background: 'rgba(255,255,255,0.07)', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: active && pct === 0 ? '35%' : `${pct}%`, background: row.status === 'failed' ? '#ef4444' : 'linear-gradient(90deg, #60a5fa, #34d399)', animation: showIndeterminate ? 'indeterminate-bar 1.6s ease-in-out infinite' : 'none', transition: 'width 0.3s ease' }} />
                    </div>
                    <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', width: '34px', textAlign: 'right' }}>{pct}%</span>
                  </div>
                  {!compact && active && row.speed > 0 && (
                    <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      {formatSpeed(row.speed)} {row.etaSec !== null && row.etaSec !== undefined ? `- ${formatEta(row.etaSec)}` : ''}
                    </div>
                  )}
                </td>
                {!compact && <td style={{ padding: '10px 12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatActivityTime(row)}</td>}
                {!compact && (
                  <td style={{ padding: '10px 12px', color: row.error ? '#fca5a5' : 'var(--text-muted)', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.error ? getReadableError(row.error) : ''}>
                    {row.error ? getReadableError(row.error) : '-'}
                  </td>
                )}
              </tr>
            );
          })}
          {rows.length > visibleRows.length && (
            <tr>
              <td colSpan={compact ? 5 : 7} style={{ padding: '10px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px' }}>
                Showing {visibleRows.length} of {rows.length} recent rows. Older rows are kept in history.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
    );
  };

  const renderMiniProgress = (progress, compact = false) => {
    const pct = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    const indeterminate = pct === 0 && ['queued', 'preparing', 'scanning', 'versioning'].includes(progress.stage);
    return (
      <div style={{ width: '100%', minWidth: compact ? '180px' : '260px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: compact ? '10.5px' : '11.5px', color: 'var(--text-muted)', marginBottom: '5px' }}>
          <span>{progress.stageLabel || 'Waiting'}</span>
          <span>{pct > 0 ? `${pct}%` : (indeterminate ? 'Scanning' : '0%')}</span>
        </div>
        <div style={{ height: compact ? '5px' : '7px', background: 'rgba(255,255,255,0.07)', borderRadius: '4px', overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              width: indeterminate ? '35%' : `${pct}%`,
              background: progress.stage === 'error' ? '#ef4444' : 'linear-gradient(90deg, #60a5fa, #34d399)',
              animation: indeterminate ? 'indeterminate-bar 1.3s ease-in-out infinite' : 'none',
              transition: 'width 0.35s ease'
            }}
          />
        </div>
      </div>
    );
  };

  const driveUsedPercent = gdriveInfo.total > 0 ? (gdriveInfo.used / gdriveInfo.total) * 100 : 0;
  const hasDriveStorage = Number(gdriveInfo.used) > 0 || Number(gdriveInfo.total) > 0;
  const hasRealEmail = gdriveInfo.accountEmail || (gdriveInfo.email && !['Connected Account', 'Disconnected', 'Google Drive Account'].includes(gdriveInfo.email));
  const realEmail = gdriveInfo.accountEmail || (hasRealEmail ? gdriveInfo.email : '');
  const accountName = gdriveInfo.displayName ||
    realEmail ||
    (hasDriveStorage ? 'Google Drive Account' : 'Not Connected');
  const accountSubtitle = gdriveInfo.displayName && realEmail
    ? realEmail
    : (realEmail && realEmail !== accountName ? realEmail : 'Active Account');
  const accountLabel = accountName;
  const accountInitial = accountLabel && accountLabel !== 'Not Connected'
    ? accountLabel.charAt(0).toUpperCase()
    : 'U';
  const driveStatus = healthInfo.gdriveStatus === 'Connected' || (hasRealEmail && healthInfo.gdriveStatus !== 'Disconnected')
    ? 'connected'
    : healthInfo.gdriveStatus === 'Disconnected' || gdriveInfo.email === 'Disconnected'
      ? 'disconnected'
      : 'checking';
  const driveStatusText = driveStatus === 'connected'
    ? 'Connected'
    : driveStatus === 'disconnected'
      ? 'Disconnected'
      : 'Checking';
  const syncIntervalMinutes = Number(settings.sync_interval_minutes || '15');
  const quickBackupCadence = syncIntervalMinutes <= 0
    ? 'Manual + live file changes'
    : syncIntervalMinutes === 60
      ? 'Every hour'
      : `Every ${syncIntervalMinutes} minutes`;
  const reconcileHours = Number(settings.full_reconcile_interval_hours || '24');
  const fullScanCadence = reconcileHours === 24
    ? 'Daily'
    : reconcileHours % 24 === 0
      ? `Every ${reconcileHours / 24} days`
      : `Every ${reconcileHours} hours`;
  const performanceProfile = String(settings.backup_transfer_profile || 'fast').toLowerCase();
  const performanceDescription = performanceProfile === 'turbo'
    ? 'More parallel Google Drive transfers'
    : performanceProfile === 'conservative'
      ? 'Lower parallel load'
      : 'Balanced fast transfers';

  const isBackupFolderEnabled = (folder) => folder.enabled === 1 || folder.enabled === true || folder.enabled === undefined;
  const activeFoldersList = folders.filter(isBackupFolderEnabled);
  const inactiveFoldersList = folders.filter(folder => !isBackupFolderEnabled(folder));
  const restorableFoldersList = getUniqueRestorableFolders(folders);
  let restoreAliases = {};
  try { restoreAliases = JSON.parse(settings.computer_aliases || '{}'); } catch (e) {}
  const currentRestoreRootFolder = getRestoreRootFolder(remotePath, restorableFoldersList);
  const selectedRestoreDisplayPath = getFriendlyRestorePath(selectedRestorePath, restorableFoldersList, restoreAliases);
  const hasUnsyncedFolders = activeFoldersList.some(f => !f.last_success_at);
  const hasAtRiskFolders = backupManifestSummary.some(item => (item.atRiskFiles || 0) > 0);
  const hasFailedFolders = hasAtRiskFolders || activeFoldersList.some(f => f.consecutive_failures > 0);
  const topBackupIssue = activeFoldersList.find(f => f.consecutive_failures > 0 && f.last_error)?.last_error ||
    fileActivityRows.find(row => ['failed', 'at_risk'].includes(row.status) && row.error)?.error ||
    logs.find(log => log.status !== 'success' && log.error_msg)?.error_msg ||
    '';
  const folderProgressRows = activeFoldersList.map(folder => ({ folder, progress: getFolderProgress(folder) }));
  const activeProgressRows = folderProgressRows.filter(({ progress }) => ['queued', 'preparing', 'scanning', 'packing', 'versioning', 'encrypting_uploading', 'deleting'].includes(progress.stage));
  const completedFolderCount = activeFoldersList.filter(f => !!f.last_success_at).length;
  const verifiedFolderCount = activeFoldersList.filter(f => f.last_crypto_verify_ok === 1 || f.last_crypto_verify_ok === '1').length;
  const failedFolderCount = activeFoldersList.filter(f => Number(f.consecutive_failures) > 0 || f.sync_state === 'error').length;
  const pendingFolderCount = activeFoldersList.filter(f => !f.last_success_at).length;
  const remoteAlertCount = healthInfo.remoteSafety
    ? (healthInfo.remoteSafety.isSafe === false ? 1 : 0) + ((healthInfo.remoteSafety.sampleWarnings || []).length)
    : 0;
  const lastBackupTimes = activeFoldersList.map(f => Date.parse(f.last_success_at || '')).filter(Number.isFinite);
  const lastBackupAt = lastBackupTimes.length > 0 ? new Date(Math.max(...lastBackupTimes)).toLocaleString() : 'Never';
  const lastVerifyTimes = activeFoldersList.map(f => Date.parse(f.last_crypto_verify_at || '')).filter(Number.isFinite);
  const lastVerifyAt = lastVerifyTimes.length > 0 ? new Date(Math.max(...lastVerifyTimes)).toLocaleString() : 'Never';
  const healthScore = Math.max(0, Math.min(100,
    100
    - failedFolderCount * 25
    - pendingFolderCount * 10
    - remoteAlertCount * 20
    - (activeFoldersList.length > 0 && verifiedFolderCount === 0 ? 10 : 0)
    - (restoreDrillReport && restoreDrillReport.failed > 0 ? 25 : 0)
  ));
  const healthScoreColor = healthScore >= 85 ? '#86efac' : healthScore >= 60 ? '#fbbf24' : '#fca5a5';
  const aggregatePercent = activeFoldersList.length > 0
    ? Math.round(folderProgressRows.reduce((sum, row) => sum + (Number(row.progress.percent) || 0), 0) / activeFoldersList.length)
    : 100;
  const activityQueueProgress = buildActivityQueueProgress(fileActivityRows);
  const hasUsefulOverallProgress = overallProgress && (
    Number(overallProgress.bytesTotal) > 0 ||
    Number(overallProgress.filesTotal) > 0 ||
    Number(overallProgress.percent) > 0
  );
  const displayOverallProgress = syncStatus === 'syncing'
    ? (hasUsefulOverallProgress ? overallProgress : (activityQueueProgress || overallProgress))
    : null;
  const displayOverallPercent = displayOverallProgress
    ? Math.max(0, Math.min(100, Number(displayOverallProgress.percent) || 0))
    : 0;
  const displayBytesDone = Math.max(0, Number(displayOverallProgress?.bytesDone) || 0);
  const displayBytesTotal = Math.max(0, Number(displayOverallProgress?.bytesTotal) || 0);
  const displayBytesRemaining = Math.max(0, displayBytesTotal - displayBytesDone);
  const displayFilesDone = Math.max(0, Number(displayOverallProgress?.filesDone) || 0);
  const displayFilesTotal = Math.max(0, Number(displayOverallProgress?.filesTotal) || 0);
  const displayFilesRemaining = Math.max(0, displayFilesTotal - displayFilesDone);
  const displaySpeed = Math.max(0, Number(displayOverallProgress?.speed) || 0);
  const displayEtaSec = displayOverallProgress?.etaSec;
  const overallStatusSuffix = displayOverallProgress
    ? `(${displayOverallPercent}% overall${displayEtaSec !== null && displayEtaSec !== undefined ? ` - ${formatEta(displayEtaSec)}` : ''})`
    : (aggregatePercent > 0 && aggregatePercent < 100 ? `(${aggregatePercent}% overall)` : '');
  const activityTableTotalRows = unifiedActivityItems.length;
  const activityTableVisibleCount = Math.ceil(ACTIVITY_TABLE_VIEWPORT_HEIGHT / ACTIVITY_TABLE_ROW_HEIGHT) + (ACTIVITY_TABLE_OVERSCAN_ROWS * 2);
  const activityTableMaxScrollTop = Math.max(0, (activityTableTotalRows * ACTIVITY_TABLE_ROW_HEIGHT) - ACTIVITY_TABLE_VIEWPORT_HEIGHT);
  const activityTableClampedScrollTop = Math.min(activityTableScrollTop, activityTableMaxScrollTop);
  const activityTableStartIndex = Math.max(0, Math.floor(activityTableClampedScrollTop / ACTIVITY_TABLE_ROW_HEIGHT) - ACTIVITY_TABLE_OVERSCAN_ROWS);
  const activityTableEndIndex = Math.min(activityTableTotalRows, activityTableStartIndex + activityTableVisibleCount);
  const virtualizedActivityItems = unifiedActivityItems.slice(activityTableStartIndex, activityTableEndIndex);
  const activityTableTopSpacerHeight = activityTableStartIndex * ACTIVITY_TABLE_ROW_HEIGHT;
  const activityTableBottomSpacerHeight = Math.max(0, (activityTableTotalRows - activityTableEndIndex) * ACTIVITY_TABLE_ROW_HEIGHT);

  // Derived State for Snapshot Explorer (Feature 1)
  const currentPathPrefix = browseSnapshotPath ? browseSnapshotPath + '/' : '';
  const snapshotItemsMap = new Map();
  browseSnapshotFiles.forEach(file => {
    if (!file.path.startsWith(currentPathPrefix)) return;
    const subPath = file.path.substring(currentPathPrefix.length);
    const slashIdx = subPath.indexOf('/');
    if (slashIdx === -1) {
      snapshotItemsMap.set(subPath, {
        name: subPath,
        isDir: false,
        fullPath: file.path,
        size: file.size,
        storage: file.storage,
        remotePath: file.remotePath,
        packRemotePath: file.packRemotePath,
        packMemberPath: file.packMemberPath
      });
    } else {
      const dirName = subPath.substring(0, slashIdx);
      if (!snapshotItemsMap.has(dirName)) {
        snapshotItemsMap.set(dirName, {
          name: dirName,
          isDir: true,
          fullPath: currentPathPrefix + dirName
        });
      }
    }
  });

  const currentSnapshotItems = Array.from(snapshotItemsMap.values()).sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
    <div className="labsuite-backup-module" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', padding: '16px' }}>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <button className={"btn " + (activeTab === 'dashboard' ? 'btn-primary' : 'btn-secondary')} onClick={() => setActiveTab('dashboard')}>Activity</button>
        <button className={"btn " + (activeTab === 'folders' ? 'btn-primary' : 'btn-secondary')} onClick={() => setActiveTab('folders')}>My Computer</button>
        <button className={"btn " + (activeTab === 'health' ? 'btn-primary' : 'btn-secondary')} onClick={() => setActiveTab('health')}>Health</button>
        <button className={"btn " + (activeTab === 'restore' ? 'btn-primary' : 'btn-secondary')} onClick={() => setActiveTab('restore')}>Restore</button>
      </div>
      <div className="content-area" style={{ flex: 1, overflowY: 'auto', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', padding: '20px', border: '1px solid rgba(255,255,255,0.05)', position: 'relative' }}>
          {activeTab === 'dashboard' && (
            <div className="activity-view-container">
              <div className="activity-header">
                <div className="activity-title-section">
                  <h1>Activity</h1>
                  <span className="activity-status-text">
                    {syncStatus === 'syncing' 
                      ? `Backing up to Google Drive... ${overallStatusSuffix}`
                      : syncStatus === 'paused' 
                      ? 'Backup paused'
                      : hasFailedFolders
                      ? `Backup issues detected${topBackupIssue ? `: ${getReadableError(topBackupIssue)}` : ''}`
                      : hasUnsyncedFolders
                      ? 'Backup pending'
                      : 'Backup active'
                    }
                  </span>
                </div>
                <div className="activity-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={handleCopyFailureLog}
                    disabled={diagnosticsStatus === 'exporting'}
                    title="Copy paths, file checks, failed manifest entries, and sanitized LabSuite/rclone logs"
                  >
                    {diagnosticsStatus === 'exporting'
                      ? 'Preparing Log...'
                      : diagnosticsStatus === 'copied'
                        ? 'Failure Log Copied'
                        : 'Copy Failure Log'}
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ marginLeft: '8px' }}
                    onClick={handleClearActivity}
                    disabled={unifiedActivityItems.length === 0}
                    title="Clear live session queue and historical activity records"
                  >
                    Clear Activity
                  </button>
                  {syncStatus === 'paused' ? (
                    <button className="btn btn-primary" onClick={handleResumeSync}>Resume backup</button>
                  ) : (
                    <button className="btn btn-secondary" onClick={handlePauseSync}>Pause backup</button>
                  )}
                  <button className="btn btn-primary" style={{ marginLeft: '8px' }} disabled={syncStatus === 'syncing' || syncStatus === 'paused'} onClick={handleSyncNow}>
                    Back Up Now
                  </button>
                </div>
              </div>

              {syncStatus === 'syncing' && displayOverallProgress && (
                <div style={{
                  background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.7), rgba(15, 23, 42, 0.8))',
                  border: '1px solid rgba(148, 163, 184, 0.1)',
                  borderRadius: '12px',
                  padding: '16px 20px',
                  marginBottom: '20px',
                  backdropFilter: 'blur(10px)',
                  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div className="sync-status-icon pulsing" style={{ display: 'flex', alignItems: 'center' }}>
                        <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                        </svg>
                      </div>
                      <span style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Overall Backup Queue
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        Includes queued files
                      </span>
                    </div>
                    <span style={{ fontSize: '18px', fontWeight: 800, color: 'var(--accent-primary)', fontFamily: 'monospace' }}>
                      {displayOverallPercent}%
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div style={{ width: '100%', height: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '999px', overflow: 'hidden', marginBottom: '14px', border: '1px solid rgba(255,255,255,0.02)' }}>
                    <div style={{
                      width: `${displayOverallPercent}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, var(--accent-primary), #60a5fa)',
                      borderRadius: '999px',
                      transition: 'width 0.4s ease-out',
                      boxShadow: '0 0 8px var(--accent-primary)'
                    }} />
                  </div>

                  {/* Detailed Stats */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
                    <div>
                      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700 }}>Data Remaining</div>
                      <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '2px', color: 'var(--text-secondary)' }}>
                        {displayBytesTotal > 0 ? `${formatBytes(displayBytesRemaining)} left` : 'Calculating...'}
                        {displayBytesTotal > 0 && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '4px' }}>
                            (of {formatBytes(displayBytesTotal)})
                          </span>
                        )}
                      </div>
                    </div>

                    <div>
                      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700 }}>Files Remaining</div>
                      <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '2px', color: 'var(--text-secondary)' }}>
                        {displayFilesTotal > 0 ? `${displayFilesRemaining} files left` : 'Calculating...'}
                        {displayFilesTotal > 0 && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '4px' }}>
                            ({displayFilesDone} of {displayFilesTotal} done)
                          </span>
                        )}
                      </div>
                    </div>

                    <div>
                      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700 }}>Transfer Speed</div>
                      <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '2px', color: 'var(--text-secondary)' }}>
                        {formatSpeed(displaySpeed) || 'Calculating...'}
                      </div>
                    </div>

                    <div>
                      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700 }}>Time Left (ETA)</div>
                      <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '2px', color: 'var(--text-secondary)' }}>
                        {formatEta(displayEtaSec)}
                      </div>
                    </div>
                  </div>

                  {displayOverallProgress.currentItem && (
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Active transfer:</span> {displayOverallProgress.currentItem}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '14px' }}>
                <div style={{ padding: '12px 14px', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'rgba(255,255,255,0.025)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0, fontWeight: 700 }}>Google Drive</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '7px' }}>
                    <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: driveStatus === 'connected' ? '#22c55e' : driveStatus === 'disconnected' ? '#ef4444' : '#f59e0b', display: 'inline-block' }} />
                    <span style={{ fontSize: '14px', fontWeight: 700, color: driveStatus === 'connected' ? '#86efac' : driveStatus === 'disconnected' ? '#fca5a5' : '#fbbf24' }}>
                      {driveStatusText}
                    </span>
                  </div>
                  <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={realEmail || accountLabel}>
                    {driveStatus === 'connected' ? (realEmail || accountLabel) : 'Backups pause until Drive is available'}
                  </div>
                </div>

                <div style={{ padding: '12px 14px', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'rgba(255,255,255,0.025)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0, fontWeight: 700 }}>Quick Backup Check</div>
                  <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '7px' }}>{quickBackupCadence}</div>
                  <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '4px' }}>Uploads changed or pending files.</div>
                </div>

                <div style={{ padding: '12px 14px', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'rgba(255,255,255,0.025)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0, fontWeight: 700 }}>Deep Reconcile Scan</div>
                  <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '7px' }}>{fullScanCadence}</div>
                  <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '4px' }}>Verifies the full folder state.</div>
                </div>

                <div style={{ padding: '12px 14px', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'rgba(255,255,255,0.025)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0, fontWeight: 700 }}>Performance</div>
                  <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '7px', textTransform: 'capitalize' }}>{performanceProfile}</div>
                  <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '4px' }}>{performanceDescription}</div>
                </div>
              </div>

              {/* Activity table */}
              <div className="activity-table-card">
                <div
                  onScroll={handleActivityTableScroll}
                  style={{ overflow: 'auto', maxHeight: `${ACTIVITY_TABLE_VIEWPORT_HEIGHT}px` }}
                >
                  <table className="activity-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Folder</th>
                        <th>Size</th>
                        <th>Status</th>
                        <th>Issue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unifiedActivityItems.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--text-muted)' }}>
                            No backup activity. Added folders will show files here as they are backed up.
                          </td>
                        </tr>
                      ) : (
                        <>
                          {activityTableTopSpacerHeight > 0 && (
                            <tr aria-hidden="true">
                              <td colSpan={5} style={{ padding: 0, height: `${activityTableTopSpacerHeight}px`, borderBottom: 'none' }} />
                            </tr>
                          )}
                          {virtualizedActivityItems.map(item => {
                          // Icon helper
                          let statusIcon = null;
                          if (['uploading', 'versioning', 'packing', 'preparing'].includes(item.status)) {
                            statusIcon = (
                              <span className="sync-status-icon pulsing" title={item.status}>
                                <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                                </svg>
                              </span>
                            );
                          } else if (item.status === 'queued') {
                            statusIcon = (
                              <span className="sync-status-icon queued" title="Queued">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-warning)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="12" cy="12" r="10" />
                                  <polyline points="12 6 12 12 16 14" />
                                </svg>
                              </span>
                            );
                          } else if (item.status === 'failed') {
                            statusIcon = (
                              <span className="sync-status-icon failed" title="Failed">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-error)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="12" cy="12" r="10" />
                                  <line x1="12" y1="8" x2="12" y2="12" />
                                  <line x1="12" y1="16" x2="12.01" y2="16" />
                                </svg>
                              </span>
                            );
                          } else {
                            // Backed up / Completed
                            statusIcon = (
                              <span className="sync-status-icon success" title="Backed up">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              </span>
                            );
                          }

                          // Get folder basename
                          let folderName = '';
                          if (item.folderPath) {
                            folderName = item.folderPath.split(/[\\/]/).filter(Boolean).pop() || item.folderPath;
                          } else if (item.folderId) {
                            const folder = folders.find(f => String(f.id) === String(item.folderId));
                            if (folder) {
                              folderName = folder.local_path.split(/[\\/]/).filter(Boolean).pop() || folder.local_path;
                            }
                          }
                          if (!folderName) {
                            const parts = item.filePath.split(/[\\/]/).filter(Boolean);
                            folderName = parts.length > 1 ? parts[parts.length - 2] : 'Vault';
                          }

                          return (
                            <tr key={item.id}>
                              <td style={{ minWidth: '220px' }}>
                                <div className="name-cell-wrapper">
                                  <span className="sync-badge-wrapper">
                                    {statusIcon}
                                  </span>
                                  <svg className="file-doc-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <polyline points="14 2 14 8 20 8" />
                                  </svg>
                                  <span className="file-name-text" title={item.filePath}>{item.name}</span>
                                </div>
                              </td>
                              <td>
                                <span className="folder-link-cell" onClick={() => setActiveTab('folders')}>
                                  {folderName}
                                </span>
                              </td>
                              <td style={{ whiteSpace: 'nowrap' }}>{formatBytes(item.size)}</td>
                              <td style={{ whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                                {item.isLive ? (
                                  <span style={{ color: 'var(--accent-primary)', fontWeight: '600' }}>
                                    {getLiveActivityText(item)}
                                  </span>
                                ) : (
                                  timeAgo(item.time)
                                )}
                              </td>
                              <td className="activity-issue-cell" title={item.issue ? getReadableError(item.issue) : ''}>
                                {item.issue ? getReadableError(item.issue) : '-'}
                              </td>
                            </tr>
                          );
                        })}
                          {activityTableBottomSpacerHeight > 0 && (
                            <tr aria-hidden="true">
                              <td colSpan={5} style={{ padding: 0, height: `${activityTableBottomSpacerHeight}px`, borderBottom: 'none' }} />
                            </tr>
                          )}
                        </>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'folders' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
                <div>
                  <h1 style={{ marginBottom: '4px' }}>Backup Selection</h1>
                  <p style={{ fontSize: '13px', margin: 0 }}>Toggle a folder or drive to protect it all, or toggle one file to protect only that file. Folder selections include subfolders.</p>
                </div>
                <button
                  className="btn btn-primary"
                  style={{ padding: '8px 16px', fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}
                  onClick={async () => {
                    const paths = await loadSystemPaths();
                    // Pre-select any system path that is not already configured as a backup
                    const defaultSelection = paths
                      .filter(p => !p.isConfigured && (p.id === 'documents' || p.id === 'desktop'))
                      .map(p => p.path);
                    setWizardFoldersToAdd(defaultSelection);
                    setShowQuickWizard(true);
                  }}
                >
                  🪄 Quick Backup Wizard
                </button>
              </div>

              {/* Active backup folders with per-folder controls */}
              {activeFoldersList.length > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <p style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
                    Currently backing up ({activeFoldersList.length})
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {activeFoldersList.map(f => {
                      return (
                        <div key={f.id} className="card" style={{ 
                          display: 'flex', 
                          justifyContent: 'space-between', 
                          alignItems: 'center', 
                          padding: '10px 16px', 
                          marginBottom: 0, 
                          gap: '16px' 
                        }}>
                          {/* Folder path and encryption badge on the same horizontal line */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: '15px', flexShrink: 0 }}>📁</span>
                            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                              {(() => {
                                let parsedAliases = {};
                                try { parsedAliases = JSON.parse(settings.computer_aliases || '{}'); } catch (e) {}
                                const folderAlias = parsedAliases[f.selection_path || f.local_path];
                                return folderAlias ? (
                                  <>
                                    <span style={{ fontWeight: 700, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folderAlias}</span>
                                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.selection_path || f.local_path}</span>
                                  </>
                                ) : (
                                  <span style={{ fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.selection_path || f.local_path}</span>
                                );
                              })()}
                            </div>
                            <span style={{ fontSize: '10.5px', background: 'rgba(99,102,241,0.15)', color: '#a5b4fc', padding: '2px 8px', borderRadius: '999px', border: '1px solid rgba(99,102,241,0.25)', flexShrink: 0 }}>
                              {f.source_type === 'file' ? 'Single file' : f.source_type === 'vm' ? 'VM Protect' : 'Encrypted'}
                            </span>
                            <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="remote-path-label">
                              {'-> gdrive-crypt'}
                            </span>
                          </div>

                          {/* Alias, Exclusions and Remove buttons */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                            <button
                              className="btn btn-secondary"
                              title="Give this folder a friendly name"
                              style={{ padding: '4px 10px', fontSize: '11.5px', height: '26px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
                              onClick={() => handleEditComputerAlias(f.selection_path || f.local_path, 'folder')}
                            >
                              ✏️ Rename
                            </button>
                            {f.source_type === 'vm' ? (
                              <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Managed in VM Protect</span>
                            ) : (
                              <>
                                <button
                                  className="btn btn-secondary"
                                  style={{ padding: '4px 10px', fontSize: '11.5px', height: '26px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
                                  onClick={() => handleManageExclusions(f)}
                                >
                                  Exclusions ({f.exclusions ? f.exclusions.length : 0})
                                </button>
                                <button
                                  className="watch-chip-remove"
                                  title="Stop backing up this folder"
                                  style={{
                                    width: '22px',
                                    height: '22px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    borderRadius: '50%',
                                    fontSize: '14px',
                                    background: 'rgba(255,255,255,0.04)',
                                    border: 'none',
                                    color: 'var(--text-muted)',
                                    cursor: 'pointer',
                                    padding: 0
                                  }}
                                  onClick={() => handleRemoveFolder(f.id)}
                                >
                                  ×
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {inactiveFoldersList.length > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <p style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
                    Cloud backups available ({inactiveFoldersList.length})
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {inactiveFoldersList.map(f => {
                      let parsedAliases = {};
                      try { parsedAliases = JSON.parse(settings.computer_aliases || '{}'); } catch (e) {}
                      const folderAlias = parsedAliases[f.local_path] || parsedAliases[f.remote_path];
                      const remoteComputer = f.remote_computer_name || getRemoteComputerName(f.remote_path);
                      const computerAlias = remoteComputer ? parsedAliases[remoteComputer] : '';
                      const isLocalComputerBackup = f.is_local_computer_backup !== false;
                      const displayName = folderAlias || f.local_path || f.remote_path;
                      const remoteLabel = !isLocalComputerBackup && remoteComputer
                        ? `From ${computerAlias ? `${computerAlias} (${remoteComputer})` : remoteComputer} - ${f.remote_path}`
                        : f.remote_path;
                      return (
                        <div key={f.id} className="card" style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '10px 16px',
                          marginBottom: 0,
                          gap: '16px',
                          borderColor: 'rgba(245,158,11,0.18)',
                          background: 'rgba(245,158,11,0.035)'
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: '15px', flexShrink: 0 }}>ðŸ“¦</span>
                            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                              <span style={{ fontWeight: 700, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
                              <span style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{remoteLabel}</span>
                            </div>
                            <span style={{ fontSize: '10.5px', background: 'rgba(245,158,11,0.12)', color: '#fbbf24', padding: '2px 8px', borderRadius: '999px', border: '1px solid rgba(245,158,11,0.22)', flexShrink: 0 }}>
                              {isLocalComputerBackup ? 'Cloud only' : 'Restore only'}
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                            <button
                              className="btn btn-secondary"
                              style={{ padding: '4px 10px', fontSize: '11.5px', height: '26px', cursor: 'pointer' }}
                              onClick={() => openRestoreFolderPath(f.remote_path)}
                            >
                              Restore
                            </button>
                            {isLocalComputerBackup && (
                              <button
                                className="btn btn-primary"
                                style={{ padding: '4px 10px', fontSize: '11.5px', height: '26px', cursor: 'pointer' }}
                                onClick={() => handleReconnectFolder(f)}
                              >
                                Reconnect
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* File Tree */}
              {(() => {
                const excludedPaths = new Set();
                activeFoldersList.forEach(f => {
                  if (f.exclusions) {
                    f.exclusions.forEach(ex => {
                      excludedPaths.add(ex.toLowerCase().replace(/\\/g, '/').replace(/\/$/, ''));
                    });
                  }
                });

                const handleExcludeFolder = async (excludePath) => {
                  const folder = activeFoldersList.find(f => {
                    const normParent = f.local_path.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                    const normChild = excludePath.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                    return normChild.startsWith(normParent + '/') || normChild === normParent;
                  });
                  if (folder) {
                    await ipcRenderer.invoke('folders:exclude', { folderId: folder.id, excludePath });
                    loadAppConfigs();
                  }
                };

                const handleIncludeFolder = async (excludePath) => {
                  const folder = activeFoldersList.find(f => {
                    const normParent = f.local_path.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                    const normChild = excludePath.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                    return normChild.startsWith(normParent + '/') || normChild === normParent;
                  });
                  if (folder) {
                    await ipcRenderer.invoke('folders:include', { folderId: folder.id, excludePath });
                    loadAppConfigs();
                  }
                };

                return (
                  <FileTree
                    watchedPaths={new Set(activeFoldersList.map(f => f.selection_path || f.local_path))}
                    excludedPaths={excludedPaths}
                    onAdd={async (localPath, node) => {
                      try {
                        if (node && !node.isDir) {
                          await ipcRenderer.invoke('folders:addFile', { filePath: localPath });
                        } else {
                          await ipcRenderer.invoke('folders:add', { localPath });
                        }
                        loadAppConfigs();
                      } catch (err) {
                        alert(err.message || 'Failed to add backup selection.');
                      }
                    }}
                    onRemove={async (localPath) => {
                      const folder = activeFoldersList.find(f => (f.selection_path || f.local_path) === localPath);
                      if (folder) {
                        await ipcRenderer.invoke('folders:remove', folder.id);
                        loadAppConfigs();
                      }
                    }}
                    onExclude={handleExcludeFolder}
                    onInclude={handleIncludeFolder}
                  />
                );
              })()}

              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '12px' }}>
                💡 Tip: Toggle a whole drive (e.g. C:\) to back up everything on it. Subfolders shown in blue are already covered by their parent.
              </p>
            </div>
          )}

          {activeTab === 'health' && (
            <div>
              <h1>Backup Health</h1>
              <p style={{ marginBottom: '20px' }}>Monitor the integrity of your backup system.</p>

              <div className="responsive-grid">
                <div className="card" style={{ margin: 0 }}>
                  <h3>Backup Health Score</h3>
                  <p style={{ fontSize: '32px', margin: '10px 0 4px', color: healthScoreColor, fontWeight: 800 }}>
                    {healthScore}%
                  </p>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                    {failedFolderCount > 0 ? `${failedFolderCount} folder issue${failedFolderCount === 1 ? '' : 's'} detected` : 'No folder failures detected'}
                  </p>
                </div>

                <div className="card" style={{ margin: 0 }}>
                  <h3>Backup Coverage</h3>
                  <p style={{ fontSize: '20px', margin: '10px 0 4px', color: 'var(--text-primary)', fontWeight: 700 }}>
                    {completedFolderCount}/{activeFoldersList.length} folders backed up
                  </p>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                    Last successful backup: {lastBackupAt}
                  </p>
                </div>

                <div className="card" style={{ margin: 0 }}>
                  <h3>Verification</h3>
                  <p style={{ fontSize: '20px', margin: '10px 0 4px', color: verifiedFolderCount > 0 ? 'var(--accent-secondary)' : '#fbbf24', fontWeight: 700 }}>
                    {verifiedFolderCount}/{activeFoldersList.length} folders verified
                  </p>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                    Last crypt verification: {lastVerifyAt}
                  </p>
                </div>

                <div className="card" style={{ margin: 0 }}>
                  <h3>Connectivity</h3>
                  <p style={{ fontSize: '18px', margin: '10px 0 4px', color: healthInfo.gdriveStatus === 'Connected' ? 'var(--accent-secondary)' : 'var(--accent-error)' }}>
                    {healthInfo.gdriveStatus === 'Connected' ? 'Google Drive connected' : 'Google Drive disconnected'}
                  </p>
                  {healthInfo.gdriveStatus !== 'Connected' && healthInfo.gdriveError && (
                    <p style={{ fontSize: '11.5px', color: 'var(--accent-error)', margin: '4px 0 6px', lineHeight: 1.4, wordBreak: 'break-word' }}>
                      {healthInfo.gdriveError}
                    </p>
                  )}
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                    rclone version: {healthInfo.rcloneVersion}
                  </p>
                </div>

                <div className="card" style={{ margin: 0 }}>
                  <h3>Crash & Diagnostics</h3>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '8px 0 12px', lineHeight: 1.45 }}>
                    Export logs, crash console output, vault summary, and duplicate-folder checks for troubleshooting.
                  </p>
                  <button
                    className="btn btn-secondary"
                    onClick={handleExportDiagnostics}
                    disabled={diagnosticsStatus === 'exporting'}
                    style={{ padding: '7px 12px', fontSize: '12px' }}
                  >
                    {diagnosticsStatus === 'exporting'
                      ? 'Exporting...'
                      : diagnosticsStatus === 'exported'
                      ? 'Exported'
                      : 'Export Diagnostics'}
                  </button>
                </div>

                {healthInfo.remoteSafety && (healthInfo.remoteSafety.isSafe === false || (healthInfo.remoteSafety.sampleWarnings || []).length > 0) && (
                  <div className="card" style={{ margin: 0, borderColor: 'var(--accent-error)', background: 'rgba(239, 68, 68, 0.04)' }}>
                    <h3 style={{ color: '#fca5a5' }}>⚠️ Remote Integrity Alerts</h3>
                    {healthInfo.remoteSafety.isSafe === false && (
                      <p style={{ fontSize: '12.5px', color: '#fca5a5', margin: '6px 0' }}>
                        Critical: Remote files have changed or been deleted independently.
                      </p>
                    )}
                    {(healthInfo.remoteSafety.sampleWarnings || []).map((warning, index) => (
                      <p key={index} style={{ fontSize: '12px', color: warning.severity === 'critical' ? '#fca5a5' : '#fbbf24', margin: '6px 0' }}>
                        {warning.folderPath}: {warning.message}
                      </p>
                    ))}
                    <p style={{ fontSize: '11.5px', color: 'var(--text-muted)', margin: '10px 0 0 0' }}>
                      If your local files still exist, run Back Up Now to rebuild the remote vault.
                    </p>
                  </div>
                )}
              </div>

              <div className="card" style={{ marginTop: '16px', border: '1px solid rgba(99,102,241,0.28)', background: 'rgba(99,102,241,0.035)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div>
                    <h2 style={{ margin: '0 0 6px 0' }}>Vault Migration & Replication</h2>
                    <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: 0, lineHeight: 1.45, maxWidth: '700px' }}>
                      Connect another Google account, then either migrate the complete encrypted vault to it or keep it as a verified backup replica. The original account is never deleted by this feature.
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      value={destinationLabel}
                      onChange={event => setDestinationLabel(event.target.value)}
                      placeholder="New Drive label (optional)"
                      disabled={destinationBusy}
                      style={{ minWidth: '190px', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)' }}
                    />
                    <button className="btn btn-primary" disabled={destinationBusy} onClick={handleConnectVaultDestination}>
                      {destinationBusy ? 'Working…' : 'Connect another Google Drive'}
                    </button>
                  </div>
                </div>

                {destinationMessage && (
                  <p style={{ margin: '14px 0 0', fontSize: '12.5px', color: destinationMessage.toLowerCase().includes('failed') ? '#fca5a5' : '#bfdbfe' }}>
                    {destinationMessage}
                  </p>
                )}

                {vaultTransferProgress && (
                  <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {vaultTransferProgress.stageLabel || `Transferring ${vaultTransferProgress.root || 'vault data'}…`}
                    {vaultTransferProgress.percent ? ` ${Math.round(vaultTransferProgress.percent)}%` : ''}
                  </div>
                )}

                <div style={{ display: 'grid', gap: '10px', marginTop: '16px' }}>
                  {vaultDestinations.length === 0 ? (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '10px 0' }}>No secondary Google Drive accounts connected.</div>
                  ) : vaultDestinations.map(destination => (
                    <div key={destination.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'center', padding: '12px', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '8px', background: 'rgba(0,0,0,0.12)', flexWrap: 'wrap' }}>
                      <div style={{ minWidth: '220px' }}>
                        <div style={{ fontWeight: 700, fontSize: '13px' }}>
                          {destination.displayName || destination.label}
                          {destination.isPrimary && <span style={{ marginLeft: '8px', color: '#86efac', fontSize: '11px' }}>ACTIVE PRIMARY</span>}
                          {destination.mode === 'replica' && <span style={{ marginLeft: '8px', color: '#c4b5fd', fontSize: '11px' }}>REPLICA</span>}
                        </div>
                        <div style={{ marginTop: '3px', color: 'var(--text-muted)', fontSize: '11.5px' }}>
                          {destination.accountEmail || 'Google Drive account'} · {destination.status === 'ready' ? 'verified' : destination.status}
                          {destination.lastReplicatedAt ? ` · mirrored ${new Date(destination.lastReplicatedAt).toLocaleString()}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {!destination.isPrimary && destination.state === 'empty' && (
                          <>
                            <button className="btn btn-secondary" disabled={destinationBusy || destination.status !== 'connected'} onClick={() => handleVaultTransfer(destination, 'migrate')}>Migrate here</button>
                            <button className="btn btn-primary" disabled={destinationBusy || destination.status !== 'connected'} onClick={() => handleVaultTransfer(destination, 'replica')}>Add replica</button>
                          </>
                        )}
                        {!destination.isPrimary && destination.state === 'copying' && destination.status === 'error' && (
                          <button className="btn btn-primary" disabled={destinationBusy} onClick={() => handleVaultTransfer(destination, destination.mode === 'migrate' ? 'migrate' : 'replica')}>
                            Retry {destination.mode === 'migrate' ? 'migration' : 'replica copy'}
                          </button>
                        )}
                        {!destination.isPrimary && destination.mode === 'replica' && destination.state === 'verified' && (
                          <button className="btn btn-secondary" disabled={destinationBusy} onClick={() => handleSyncVaultReplica(destination)}>Sync replica now</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card" style={{ marginTop: '16px', border: '1px solid rgba(16,185,129,0.18)', background: 'rgba(16,185,129,0.035)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start' }}>
                  <div>
                    <h2 style={{ margin: '0 0 6px 0' }}>Restore Drill</h2>
                    <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: 0, lineHeight: 1.45 }}>
                      Restore a deterministic sample of backed-up files to a temporary folder and compare hashes against the local originals.
                    </p>
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={restoreDrillRunning || activeFoldersList.length === 0}
                    onClick={handleRunRestoreDrill}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {restoreDrillRunning ? 'Running...' : 'Run Restore Drill'}
                  </button>
                </div>

                {restoreDrillReport && (
                  <div style={{ marginTop: '14px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px', marginBottom: '12px' }}>
                      {[
                        ['Sampled', restoreDrillReport.sampled || 0, 'var(--text-primary)'],
                        ['Passed', restoreDrillReport.passed || 0, '#86efac'],
                        ['Failed', restoreDrillReport.failed || 0, '#fca5a5'],
                        ['Skipped', restoreDrillReport.skipped || 0, '#fbbf24']
                      ].map(([label, value, color]) => (
                        <div key={label} style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '6px', padding: '10px' }}>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700 }}>{label}</div>
                          <div style={{ marginTop: '4px', color, fontSize: '20px', fontWeight: 800 }}>{value}</div>
                        </div>
                      ))}
                    </div>

                    <div style={{ fontSize: '12.5px', color: restoreDrillReport.ok ? '#86efac' : '#fca5a5', marginBottom: '8px', fontWeight: 700 }}>
                      {restoreDrillReport.ok ? 'Restore drill passed.' : 'Restore drill needs attention.'}
                      {restoreDrillReport.durationMs ? ` Completed in ${(restoreDrillReport.durationMs / 1000).toFixed(1)}s.` : ''}
                    </div>

                    {(restoreDrillReport.details || []).length > 0 && (
                      <div style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '6px' }}>
                        {(restoreDrillReport.details || []).map((detail, index) => (
                          <div key={`${detail.relativePath}-${index}`} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: '10px', alignItems: 'center', padding: '8px 10px', borderBottom: index === restoreDrillReport.details.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.04)', fontSize: '12px' }}>
                            <span style={{ color: detail.ok ? '#86efac' : detail.skipped ? '#fbbf24' : '#fca5a5', fontWeight: 800 }}>
                              {detail.ok ? 'PASS' : detail.skipped ? 'SKIP' : 'FAIL'}
                            </span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={detail.relativePath}>
                              {detail.relativePath}
                            </span>
                            <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '260px' }} title={detail.error || detail.storage}>
                              {detail.error || detail.storage}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="card" style={{ padding: '0', overflow: 'hidden', marginTop: '16px' }}>
                <h2 style={{ padding: '16px', margin: 0, borderBottom: '1px solid var(--border-color)' }}>Backup Folders</h2>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                    <thead>
                      <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--border-color)' }}>
                        <th style={{ padding: '12px 16px' }}>Folder</th>
                        <th style={{ padding: '12px 16px' }}>Last Success</th>
                        <th style={{ padding: '12px 16px' }}>Status</th>
                        <th style={{ padding: '12px 16px', textAlign: 'right' }}>Integrity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeFoldersList.length === 0 ? (
                        <tr>
                          <td colSpan="4" style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>No active backup folders configured.</td>
                        </tr>
                      ) : (
                        activeFoldersList.map(folder => {
                          const isFailing = folder.consecutive_failures > 0;
                          const lastSuccess = folder.last_success_at ? new Date(folder.last_success_at).toLocaleString() : 'Never';
                          const progress = getFolderProgress(folder);
                          const isActive = ['queued', 'preparing', 'scanning', 'versioning', 'encrypting_uploading', 'deleting'].includes(progress.stage);
                          const readableIssue = getReadableError(progress.error || folder.last_error);
                          return (
                            <tr key={folder.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                              <td style={{ padding: '12px 16px', maxWidth: '250px', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={folder.local_path}>
                                {folder.local_path}
                              </td>
                              <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>
                                {lastSuccess}
                              </td>
                              <td style={{ padding: '12px 16px', maxWidth: '520px' }}>
                                {isActive ? (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: 'min(420px, 100%)' }}>
                                    <span style={{ color: '#a5b4fc', display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: '500' }}>
                                      <span>🔄 Backing up...</span>
                                      <span>{progress.bytesTotal > 0 ? `${Math.round((progress.bytesDone / progress.bytesTotal) * 100)}%` : (progress.percent ? `${progress.percent}%` : 'Calculating...')}</span>
                                    </span>
                                    <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
                                      {progress.bytesTotal > 0 || progress.percent > 0 ? (
                                        <div style={{ height: '100%', background: 'linear-gradient(90deg, #a78bfa, #8b5cf6)', width: `${Math.min(100, progress.bytesTotal > 0 ? (progress.bytesDone / progress.bytesTotal) * 100 : progress.percent)}%`, transition: 'width 0.4s ease' }} />
                                      ) : (
                                        <div style={{ height: '100%', width: '40%', background: 'linear-gradient(90deg, #c084fc, #a78bfa)', animation: 'indeterminate-bar 1.4s ease-in-out infinite' }} />
                                      )}
                                    </div>
                                  </div>
                                ) : isFailing ? (
                                  <span style={{ color: 'var(--accent-error)', display: 'flex', flexDirection: 'column', maxWidth: '520px' }}>
                                    <span>❌ Failing ({folder.consecutive_failures} attempts)</span>
                                    <span style={{ fontSize: '11px', opacity: 0.85, marginTop: '4px', lineHeight: 1.35 }}>{readableIssue || 'The last backup attempt failed.'}</span>
                                  </span>
                                ) : !folder.last_success_at ? (
                                  <span style={{ color: '#fbbf24', display: 'flex', flexDirection: 'column' }}>
                                    <span>⏳ Needs backup</span>
                                  </span>
                                ) : (
                                  <span style={{ color: 'var(--accent-secondary)' }}>✅ Healthy</span>
                                )}
                              </td>
                              <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                                <button 
                                  className="btn btn-secondary" 
                                  style={{ padding: '4px 10px', fontSize: '11px' }}
                                  disabled={verifyingFolderId !== null}
                                  onClick={() => handleVerifyBackup(folder.id)}
                                >
                                  {verifyingFolderId === folder.id ? 'Verifying...' : 'Verify Crypt'}
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              
              {verifyLogs.length > 0 && (
                <div className="card" style={{ marginTop: '16px', background: '#000', border: '1px solid var(--accent-primary)' }}>
                  <h3 style={{ margin: '0 0 10px 0', fontSize: '13px', color: 'var(--accent-primary)' }}>Verification Progress</h3>
                  <div style={{ fontFamily: 'monospace', fontSize: '11.5px', color: '#a3a3a3', whiteSpace: 'pre-wrap', maxHeight: '150px', overflowY: 'auto' }}>
                    {verifyLogs.map((log, i) => <div key={i}>{log}</div>)}
                  </div>
                </div>
              )}
            </div>
          )}

          {false && activeTab === 'activity' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h1>Backup Activity</h1>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={() => setFileActivity({})} disabled={fileActivityRows.length === 0}>
                    Clear Live Queue
                  </button>
                  <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={handleCopyLogs} disabled={logs.length === 0}>
                    {copiedLogs ? '📋 Copied!' : '📋 Copy Logs'}
                  </button>
                  <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={handleExportLogs} disabled={logs.length === 0}>
                    💾 Export Logs
                  </button>
                  <button className="btn btn-danger" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={handleClearActivity} disabled={logs.length === 0}>
                    Clear Log
                  </button>
                </div>
              </div>

              <div className="card" style={{ padding: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '12px' }}>
                  <div>
                    <h2 style={{ marginBottom: '4px' }}>Live File Queue</h2>
                    <p style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
                      Current session activity updates file by file while backups run.
                    </p>
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {fileActivityRows.length} rows
                  </span>
                </div>
                {renderFileActivityTable(fileActivityRows)}
              </div>

              <h2 style={{ marginTop: '18px' }}>History</h2>
              <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--border-color)' }}>
                      <th style={{ padding: '12px 16px' }}>File Path / Folder</th>
                      <th style={{ padding: '12px 16px' }}>Action</th>
                      <th style={{ padding: '12px 16px' }}>Status</th>
                      <th style={{ padding: '12px 16px' }}>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.length === 0 ? (
                      <tr>
                        <td colSpan="4" style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>No recent activity records.</td>
                      </tr>
                    ) : (
                      logs.map(log => (
                        <tr key={log.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                          <td style={{ padding: '12px 16px', maxWidth: '300px', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                            {log.file_path}
                          </td>
                          <td style={{ padding: '12px 16px', textTransform: 'capitalize' }}>{log.action}</td>
                          <td style={{ padding: '12px 16px' }}>
                            {log.status === 'success' ? (
                              <span style={{ color: 'var(--accent-secondary)' }}>✓ Success</span>
                            ) : (
                              <span style={{ color: 'var(--accent-error)' }} title={log.error_msg}>✗ Failed</span>
                            )}
                          </td>
                          <td style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>
                            {new Date(log.synced_at).toLocaleTimeString()}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'restore' && (
            <div>
              <div className="tab-header-area">
                <h1>Restore Files</h1>
                <p style={{ marginBottom: '14px', color: 'var(--text-secondary)' }}>Decrypt and recover your files from the secure Google Drive vault.</p>
              </div>

              <div className="card" style={{ padding: '14px 16px', marginBottom: '14px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.18)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: '4px' }}>Vault Explorer</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Open readable computer backups, restore files, or remove old cloud-only folders.</div>
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: '4px' }}>Search</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Find files by name, including small files stored inside packs.</div>
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: '4px' }}>Checkpoint</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Restore a folder as it looked at a completed backup time.</div>
                  </div>
                </div>
              </div>

              {/* Sub-navigation buttons */}
              <div className="sub-tab-nav">
                <button 
                  className={`sub-tab-btn ${restoreSubTab === 'browse' ? 'active' : ''}`}
                  onClick={() => setRestoreSubTab('browse')}
                >
                  📂 Browse Vault
                </button>
                <button 
                  className={`sub-tab-btn ${restoreSubTab === 'search' ? 'active' : ''}`}
                  onClick={() => setRestoreSubTab('search')}
                >
                  🔍 Search Backups
                </button>
                <button 
                  className={`sub-tab-btn ${restoreSubTab === 'checkpoint' ? 'active' : ''}`}
                  onClick={() => setRestoreSubTab('checkpoint')}
                >
                  🕒 Restore Checkpoint
                </button>
                <button
                  className={`sub-tab-btn ${restoreSubTab === 'mount' ? 'active' : ''}`}
                  onClick={() => setRestoreSubTab('mount')}
                >
                  Disk Mount
                </button>
                <button 
                  className={`sub-tab-btn ${restoreSubTab === 'webserver' ? 'active' : ''}`}
                  onClick={() => setRestoreSubTab('webserver')}
                >
                  🌐 Web Server
                </button>
              </div>

              <div className="sub-tab-content">
                {restoreSubTab === 'browse' && (
                  <div>
                    {/* Live Vault vs Version History buttons, followed by Explorer */}
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', background: 'rgba(0,0,0,0.15)', padding: '4px', borderRadius: '8px', width: 'fit-content' }}>
                      <button
                        className="btn"
                        style={{
                          padding: '8px 16px',
                          fontSize: '13px',
                          borderRadius: '6px',
                          background: restoreTab === 'live' ? 'var(--accent-primary)' : 'transparent',
                          color: restoreTab === 'live' ? '#fff' : 'var(--text-secondary)',
                          border: 'none',
                          boxShadow: restoreTab === 'live' ? '0 2px 4px rgba(0,0,0,0.2)' : 'none',
                          cursor: 'pointer',
                          transition: 'all 0.2s ease'
                        }}
                        onClick={() => setRestoreTab('live')}
                      >
                        🟢 Live Vault
                      </button>
                      <button
                        className="btn"
                        style={{
                          padding: '8px 16px',
                          fontSize: '13px',
                          borderRadius: '6px',
                          background: restoreTab === 'trash' ? 'var(--accent-primary)' : 'transparent',
                          color: restoreTab === 'trash' ? '#fff' : 'var(--text-secondary)',
                          border: 'none',
                          boxShadow: restoreTab === 'trash' ? '0 2px 4px rgba(0,0,0,0.2)' : 'none',
                          cursor: 'pointer',
                          transition: 'all 0.2s ease'
                        }}
                        onClick={() => setRestoreTab('trash')}
                      >
                        ℹ️ Version History
                      </button>
                    </div>

                    {restoreTab === 'trash' && (
                      <p style={{ fontSize: '12px', color: '#fbbf24', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.18)', padding: '10px 14px', borderRadius: '6px', marginBottom: '16px' }}>
                        ℹ️ <strong>Browsing Deleted & Overwritten Items:</strong> Explore retained backup versions by date. Select a file or folder from a version snapshot to restore it.
                      </p>
                    )}

                    {restoreTab === 'live' && !remotePath && !currentRestoreRootFolder && restorableFoldersList.length > 0 && (
                      <div style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.025)', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
                          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.7px' }}>Backup folders</div>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{restorableFoldersList.length} available</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '8px' }}>
                          {restorableFoldersList.map(folder => {
                            let parsedAliases = {};
                            try { parsedAliases = JSON.parse(settings.computer_aliases || '{}'); } catch (e) {}
                            const folderAlias = parsedAliases[folder.local_path] || parsedAliases[folder.remote_path];
                            const fallbackName = String(folder.local_path || folder.remote_path || 'Backup folder').split(/[\\/]+/).filter(Boolean).pop() || 'Backup folder';
                            const displayName = folderAlias || fallbackName;
                            const enabled = isBackupFolderEnabled(folder);
                            return (
                              <div key={`${folder.id}:${folder.remote_path}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '9px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.12)', minWidth: 0 }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: '13px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
                                  <div style={{ fontSize: '11px', color: enabled ? 'var(--accent-secondary)' : '#fbbf24', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {enabled ? 'Active backup' : 'Cloud only'}
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                                  <button
                                    className="btn btn-secondary"
                                    style={{ padding: '4px 9px', fontSize: '11.5px' }}
                                    onClick={() => openRestoreFolderPath(folder.remote_path)}
                                  >
                                    Open
                                  </button>
                                  <button
                                    className="btn btn-primary"
                                    style={{ padding: '4px 9px', fontSize: '11.5px' }}
                                    disabled={restoreStatus === 'restoring'}
                                    onClick={() => handleInlineFolderRestore({ Name: displayName, IsDir: true }, folder.remote_path)}
                                  >
                                    Restore
                                  </button>
                                  {!enabled && (
                                    <button
                                      className="btn btn-danger"
                                      style={{ padding: '4px 9px', fontSize: '11.5px' }}
                                      disabled={vaultDeleteStatus === 'deleting'}
                                      onClick={() => handleDeleteRemoteItem({ Name: displayName, IsDir: true }, folder.remote_path)}
                                    >
                                      Delete
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="explorer-container" style={{ marginBottom: '24px' }}>
                      {/* Explorer Header: Breadcrumbs & Search */}
                      <div className="explorer-header">
                        {/* Clickable Breadcrumbs */}
                        <div className="explorer-breadcrumbs">
                          <span 
                            className={`breadcrumb-segment ${(!remotePath || isVaultHistoryRoot(remotePath)) ? 'active' : ''}`}
                            onClick={() => {
                              if (restoreTab === 'live') {
                                handleLoadRemoteDir('');
                              } else {
                                handleLoadRemoteDir('.labsuite_history');
                              }
                              setSelectedRemoteItem(null);
                              setSelectedRestorePath('');
                            }}
                          >
                            {restoreTab === 'live' ? 'Backup folders' : 'Version history'}
                          </span>
                          {remotePath && !isVaultHistoryRoot(remotePath) && getFriendlyRestoreBreadcrumbs(remotePath, restorableFoldersList, restoreAliases).map((crumb, idx, arr) => {
                            const isLast = idx === arr.length - 1;
                            return (
                              <React.Fragment key={idx}>
                                <span style={{ color: 'var(--text-muted)' }}>/</span>
                                <span 
                                  className={`breadcrumb-segment ${isLast ? 'active' : ''}`}
                                  onClick={() => {
                                    handleLoadRemoteDir(crumb.path);
                                    setSelectedRemoteItem(null);
                                    setSelectedRestorePath('');
                                  }}
                                >
                                  {crumb.label}
                                </span>
                              </React.Fragment>
                            );
                          })}
                        </div>
                        {/* Quick Filter */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <input
                            type="text"
                            className="input-control explorer-search"
                            placeholder="Filter current folder..."
                            style={{ margin: 0, padding: '6px 12px', fontSize: '12px' }}
                            value={explorerSearch}
                            onChange={(e) => setExplorerSearch(e.target.value)}
                          />
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '6px 10px', fontSize: '12px' }}
                            disabled={restoreLoading}
                            onClick={() => handleLoadRemoteDir(remotePath, { forceAliasSync: true })}
                          >
                            {restoreLoading ? 'Loading...' : 'Refresh'}
                          </button>
                        </div>
                      </div>

                      {/* Explorer Body: File List */}
                      <div className="explorer-body">
                        {/* Up one directory option */}
                        {remotePath && (
                          <div 
                            className="explorer-row clickable"
                            style={{ background: 'rgba(255,255,255,0.01)', borderBottom: '1px solid rgba(255,255,255,0.02)' }}
                            onDoubleClick={() => {
                              const parent = getRestoreParentPath(remotePath, restorableFoldersList);
                              handleLoadRemoteDir(parent);
                              setSelectedRemoteItem(null);
                              setSelectedRestorePath('');
                            }}
                          >
                            <div className="explorer-item-name" style={{ color: 'var(--accent-primary)' }}>
                              <span>⬆️ .. (Parent Directory)</span>
                            </div>
                            <div className="explorer-item-size">-</div>
                            <div className="explorer-item-date">-</div>
                            <div className="explorer-item-actions">
                              <button 
                                className="btn btn-secondary explorer-item-action-btn"
                                onClick={() => {
                                  const parent = getRestoreParentPath(remotePath, restorableFoldersList);
                                  handleLoadRemoteDir(parent);
                                  setSelectedRemoteItem(null);
                                  setSelectedRestorePath('');
                                }}
                              >
                                Up
                              </button>
                            </div>
                          </div>
                        )}

                        {restoreBrowseError && (
                          <div style={{ margin: '14px', padding: '12px 14px', border: '1px solid rgba(224,108,117,0.28)', borderRadius: '6px', color: '#fca5a5', background: 'rgba(224,108,117,0.08)', fontSize: '12.5px', lineHeight: 1.45 }}>
                            <strong>Could not read this vault folder.</strong>
                            <div style={{ marginTop: '4px', color: 'var(--text-secondary)' }}>
                              {restoreBrowseError}
                            </div>
                            <div style={{ marginTop: '6px', color: 'var(--text-muted)' }}>
                              {getRestoreBrowseGuidance(restoreBrowseError)}
                            </div>
                          </div>
                        )}

                        {/* Empty state */}
                        {!restoreBrowseError && restoreLoading ? (
                          <div className="explorer-empty">
                            <span className="animate-spin" style={{ width: '18px', height: '18px', border: '2px solid var(--accent-secondary)', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block' }} />
                            <p>Loading vault folder...</p>
                          </div>
                        ) : !restoreBrowseError && remoteItems.length === 0 ? (
                          <div className="explorer-empty">
                            <span>📂</span>
                            <p>No restorable files were found in this folder.</p>
                          </div>
                        ) : (
                          remoteItems
                            .filter(item => String(item.Name || '').toLowerCase().includes(explorerSearch.toLowerCase()))
                            .map((item, idx) => {
                              const fullPath = resolveRemoteBrowseItemPath(remotePath, item);
                              const isSelected = selectedRemoteItem && selectedRemoteItem.Name === item.Name;
                              return (
                                <div 
                                  key={idx}
                                  className={`explorer-row clickable ${isSelected ? 'selected' : ''}`}
                                  onClick={() => {
                                    setSelectedRemoteItem(item);
                                    setSelectedRestorePath(fullPath);
                                  }}
                                  onDoubleClick={() => {
                                    if (item.IsDir) {
                                      handleLoadRemoteDir(fullPath);
                                      setSelectedRemoteItem(null);
                                      setSelectedRestorePath('');
                                    }
                                  }}
                                >
                                  <div className="explorer-item-name">
                                    <span>{item.IsDir ? '📁' : '📄'}</span>
                                    <span style={{ textOverflow: 'ellipsis', overflow: 'hidden' }}>
                                      {remotePath === 'computers' ? (
                                        (() => {
                                          let parsed = {};
                                          try { parsed = JSON.parse(settings.computer_aliases || '{}'); } catch(e){}
                                          const alias = parsed[item.Name];
                                          return alias ? `${alias} (${item.Name})` : item.Name;
                                        })()
                                      ) : item.Name}
                                    </span>
                                  </div>
                                  <div className="explorer-item-size">
                                    {item.IsDir ? 'Folder' : formatBytes(item.Size)}
                                  </div>
                                  <div className="explorer-item-date">
                                    {item.ModTime ? new Date(item.ModTime).toLocaleDateString() : 'Unknown'}
                                  </div>
                                  <div className="explorer-item-actions">
                                    {item.IsDir ? (
                                      <>
                                        <button 
                                          className="btn btn-secondary explorer-item-action-btn"
                                          style={{ padding: '3px 8px', fontSize: '11px' }}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleLoadRemoteDir(fullPath);
                                            setSelectedRemoteItem(null);
                                            setSelectedRestorePath('');
                                          }}
                                        >
                                          Open
                                        </button>
                                        <button 
                                          className="btn btn-primary explorer-item-action-btn"
                                          style={{ padding: '3px 8px', fontSize: '11px' }}
                                          disabled={restoreStatus === 'restoring'}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleInlineFolderRestore(item, fullPath);
                                          }}
                                        >
                                          ⬇ Download
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        className="btn btn-primary explorer-item-action-btn"
                                        style={{ padding: '3px 8px', fontSize: '11px' }}
                                        disabled={restoreStatus === 'restoring'}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleInlineFileRestore(item, fullPath);
                                        }}
                                      >
                                        â¬‡ Download
                                      </button>
                                    )}
                                    {restoreTab === 'live' && !item.Packed && !item.PackedVirtual && !item.Shortcut && !item.VirtualComputerRoot && !item.VirtualBackupRoot && (
                                      <button
                                        className="btn btn-danger explorer-item-action-btn"
                                        style={{ padding: '3px 8px', fontSize: '11px' }}
                                        disabled={vaultDeleteStatus === 'deleting'}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleDeleteRemoteItem(item, fullPath);
                                        }}
                                      >
                                        Delete
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })
                        )}
                      </div>

                      {/* Explorer Footer Action Bar */}
                      <div className="explorer-footer-bar">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: '12px', fontWeight: 500, margin: 0 }}>
                            Selected remote item:
                          </p>
                          <p style={{ fontSize: '13px', color: '#93c5fd', fontFamily: 'monospace', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', margin: '2px 0 0 0' }}>
                            {selectedRestorePath ? selectedRestoreDisplayPath : '(Please select a file or folder above)'}
                          </p>
                        </div>
                        
                        {selectedRestorePath && (
                          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                            {remotePath === 'computers' && (
                              <button
                                className="btn btn-secondary"
                                style={{ padding: '6px 12px', fontSize: '12px', borderColor: 'var(--accent-warning)', color: 'var(--accent-warning)' }}
                                onClick={() => handleEditComputerAlias(selectedRemoteItem.Name)}
                              >
                                ✏️ Rename/Alias Device
                              </button>
                            )}
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                              <input 
                                type="text" 
                                className="input-control" 
                                placeholder="Select download target" 
                                style={{ margin: 0, width: '180px', padding: '6px 12px', fontSize: '12.5px' }}
                                readOnly 
                                value={restoreDest} 
                              />
                              <button 
                                className="btn btn-secondary" 
                                style={{ padding: '6px 12px', fontSize: '12px' }}
                                onClick={handleSelectRestoreDest}
                              >
                                Browse...
                              </button>
                            </div>
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)', maxWidth: '190px', lineHeight: 1.35 }}>
                              Existing files are preserved. Use an empty destination to restore every item.
                            </span>
                            
                            <button 
                              className="btn btn-primary"
                              style={{ padding: '6px 16px', fontSize: '12px' }}
                              disabled={!restoreDest || restoreStatus === 'restoring'}
                              onClick={handleStartRestore}
                            >
                              Restore Selection
                            </button>
                            {restoreTab === 'live' && selectedRemoteItem && !selectedRemoteItem.Packed && !selectedRemoteItem.PackedVirtual && !selectedRemoteItem.Shortcut && !selectedRemoteItem.VirtualComputerRoot && !selectedRemoteItem.VirtualBackupRoot && (
                              <button
                                className="btn btn-danger"
                                style={{ padding: '6px 12px', fontSize: '12px' }}
                                disabled={vaultDeleteStatus === 'deleting'}
                                onClick={() => handleDeleteRemoteItem(selectedRemoteItem, selectedRestorePath)}
                              >
                                {vaultDeleteStatus === 'deleting' ? 'Deleting...' : 'Delete'}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Recovery progress feedback card */}
                    {restoreStatus === 'restoring' && (
                      <div style={{ margin: '16px 0', background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '8px', border: '1px solid var(--accent-warning)' }}>
                        <p style={{ fontSize: '13.5px', color: 'var(--accent-warning)', display: 'flex', gap: '8px', alignItems: 'center', margin: '0 0 12px 0', fontWeight: '500' }}>
                          <span className="animate-spin" style={{ width: '12px', height: '12px', border: '2px solid var(--accent-warning)', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block' }} />
                          Restoring Files &amp; Decrypting Blobs...
                        </p>
                        
                        {restoreProgress ? (
                          <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                              <span>Files completed: {restoreProgress.filesDone} / {restoreProgress.filesTotal}</span>
                              <span>{restoreProgress.bytesTotal > 0 ? `${Math.round((restoreProgress.bytesDone / restoreProgress.bytesTotal) * 100)}%` : 'Processing...'}</span>
                            </div>
                            
                            <div style={{ width: '100%', height: '8px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', overflow: 'hidden', marginBottom: '8px' }}>
                              {restoreProgress.bytesTotal > 0 && (
                                <div style={{ height: '100%', background: 'var(--accent-warning)', width: `${Math.round((restoreProgress.bytesDone / restoreProgress.bytesTotal) * 100)}%`, transition: 'width 0.4s ease' }} />
                              )}
                            </div>
                            
                            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
                              Data: {formatBytes(restoreProgress.bytesDone)} / {formatBytes(restoreProgress.bytesTotal)}
                            </p>
                          </div>
                        ) : (
                          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>Establishing secure decryption tunnel...</p>
                        )}
                      </div>
                    )}
                    {restoreStatus === 'success' && (
                      <div style={{ margin: '16px 0', padding: '12px 16px', background: 'rgba(16,185,129,0.08)', borderRadius: '8px', border: '1px solid rgba(16,185,129,0.2)', color: 'var(--accent-secondary)', fontSize: '13px' }}>
                        ✓ Decrypted restore completed successfully! Files are ready at: {restoreDest}
                      </div>
                    )}
                  </div>
                )}

                {restoreSubTab === 'search' && (
                  <div className="card" style={{ padding: '18px', margin: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '12px' }}>
                      <div>
                        <h2 style={{ marginBottom: '4px' }}>Search Backups</h2>
                        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
                          Find a backed-up file by name and restore it from the encrypted vault.
                        </p>
                      </div>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {formatBytes(vaultAnalytics.bytes)} protected
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="text"
                        className="input-control"
                        placeholder="Search by filename..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && searchQuery) {
                            setIsSearching(true);
                            ipcRenderer.invoke('search:files', searchQuery).then(res => {
                              setSearchResults(res || []);
                              setIsSearching(false);
                            });
                          }
                        }}
                      />
                      <button
                        className="btn btn-primary"
                        disabled={!searchQuery || isSearching}
                        onClick={() => {
                          setIsSearching(true);
                          ipcRenderer.invoke('search:files', searchQuery).then(res => {
                            setSearchResults(res || []);
                            setIsSearching(false);
                          });
                        }}
                      >
                        {isSearching ? 'Searching...' : 'Search'}
                      </button>
                    </div>

                    {searchResults.length > 0 && (
                      <div style={{ marginTop: '14px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', borderRadius: '8px', maxHeight: '260px', overflowY: 'auto' }}>
                        {searchResults.map((file, idx) => (
                          <div key={idx} style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', overflow: 'hidden' }}>
                              <span style={{ fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.Path}{file.Packed ? ' (packed)' : ''}</span>
                              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{formatBytes(file.Size)} • {new Date(file.ModTime).toLocaleString()}</span>
                            </div>
                            <button
                              className="btn btn-secondary"
                              style={{ fontSize: '11px', padding: '4px 10px', flexShrink: 0 }}
                              onClick={() => {
                                setRestoreDest('');
                                setSelectedRemoteItem(file);
                                setSelectedRestorePath(file.Path);
                                setRestoreSubTab('browse'); // Switch back to explorer to complete restore
                              }}
                            >
                              Select
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {searchResults.length === 0 && searchQuery && !isSearching && (
                      <p style={{ marginTop: '12px', color: 'var(--text-muted)', fontSize: '12.5px' }}>No files found matching "{searchQuery}".</p>
                    )}
                  </div>
                )}

                {restoreSubTab === 'checkpoint' && (
                  <div className="card" style={{ padding: '18px', margin: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '12px' }}>
                      <div>
                        <h2 style={{ marginBottom: '4px' }}>Point-in-Time Restore</h2>
                        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
                          Restore a protected folder exactly from a completed backup checkpoint, including packed small files.
                        </p>
                      </div>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {restorePoints.length} restore points
                      </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) auto auto', gap: '8px', alignItems: 'center' }}>
                      <select
                        className="input-control"
                        style={{ margin: 0 }}
                        value={selectedRestorePointId}
                        onChange={e => {
                          setSelectedRestorePointId(e.target.value);
                          setRestorePointPlan(null);
                          handleLoadSnapshot(e.target.value);
                        }}
                      >
                        <option value="">Select a restore point...</option>
                        {restorePoints.map(point => (
                          <option key={point.id} value={point.id}>
                            {new Date(point.completed_at).toLocaleString()} - {point.folder_path}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-secondary"
                        disabled={!selectedRestorePointId || isPlanningRestorePoint}
                        onClick={handlePreviewRestorePoint}
                      >
                        {isPlanningRestorePoint ? 'Planning...' : 'Preview'}
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={handleSelectRestoreDest}
                      >
                        Choose Destination
                      </button>
                    </div>

                    {restoreDest && (
                      <p style={{ marginTop: '10px', fontSize: '11.5px', color: 'var(--text-muted)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        Destination: {restoreDest}
                      </p>
                    )}

                    {/* Snapshot Folder Browser (Feature 1) */}
                    {browseRestorePointId && (
                      <div className="explorer-container" style={{ marginTop: '16px' }}>
                        <div className="explorer-header">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                            <span style={{ fontWeight: 600, fontSize: '12.5px', flexShrink: 0 }}>Snapshot Explorer</span>
                            <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`/${browseSnapshotPath}`}>
                              Path: /{browseSnapshotPath}
                            </span>
                          </div>
                          {browseSnapshotPath && (
                            <button
                              className="btn btn-secondary"
                              style={{ padding: '2px 8px', fontSize: '11px', height: '22px', cursor: 'pointer' }}
                              onClick={() => {
                                const parts = browseSnapshotPath.split('/');
                                parts.pop();
                                setBrowseSnapshotPath(parts.join('/'));
                              }}
                            >
                              ⬆ Up
                            </button>
                          )}
                        </div>

                        {browseSnapshotLoading ? (
                          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                            <div className="tree-spinner" style={{ marginRight: '8px' }}></div>
                            Loading snapshot files...
                          </div>
                        ) : browseSnapshotError ? (
                          <div style={{ padding: '24px', textAlign: 'center', color: '#fca5a5', fontSize: '13px' }}>
                            {browseSnapshotError}
                          </div>
                        ) : currentSnapshotItems.length === 0 ? (
                          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                            No recoverable files were recorded for this checkpoint.
                          </div>
                        ) : (
                          <ul className="snapshot-browser-list" style={{ margin: 0, borderRadius: 0, border: 'none', maxHeight: '280px' }}>
                            {currentSnapshotItems.map(item => (
                              <li key={item.name} className="snapshot-browser-item">
                                <div className="snapshot-file-info" style={{ cursor: item.isDir ? 'pointer' : 'default', minWidth: 0 }} onClick={() => { if (item.isDir) setBrowseSnapshotPath(item.fullPath); }}>
                                  <span style={{ fontSize: '16px', flexShrink: 0 }}>{item.isDir ? '📁' : '📄'}</span>
                                  <span className="snapshot-file-name" style={{ fontWeight: item.isDir ? 600 : 400 }}>{item.name}</span>
                                  {!item.isDir && (
                                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px', flexShrink: 0 }}>
                                      ({formatBytes(item.size)})
                                    </span>
                                  )}
                                </div>
                                {!item.isDir && (
                                  <button
                                    className="btn btn-secondary"
                                    style={{ padding: '2px 10px', fontSize: '11px', height: '24px', cursor: 'pointer', flexShrink: 0 }}
                                    onClick={() => handleRestoreSnapshotFile(item)}
                                  >
                                    Restore File
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                    {restorePointPlan && (
                      <div style={{ marginTop: '12px', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 700 }}>{restorePointPlan.totalFiles} files - {formatBytes(restorePointPlan.totalBytes)}</div>
                            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {restorePointPlan.folderPath}
                            </div>
                            <div style={{ marginTop: '4px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                              {(restorePointPlan.files || []).filter(file => file.storage === 'pack').length} packed files, {(restorePointPlan.files || []).filter(file => file.storage !== 'pack').length} direct files
                            </div>
                          </div>
                          <button
                            className="btn btn-primary"
                            disabled={!restoreDest || restoreStatus === 'restoring'}
                            onClick={handleRestorePointRestore}
                          >
                            Restore This Point
                          </button>
                        </div>

                        <div style={{ marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '10px' }}>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>Preview</div>
                          {(restorePointPlan.files || []).slice(0, 6).map(file => (
                            <div key={`${file.relativePath}-${file.remotePath}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '11.5px', padding: '3px 0' }}>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.relativePath}</span>
                              <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{file.storage === 'pack' ? 'packed' : 'file'} - {formatBytes(file.size)}</span>
                            </div>
                          ))}
                          {(restorePointPlan.files || []).length > 6 && (
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                              +{restorePointPlan.files.length - 6} more files
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {restoreSubTab === 'mount' && (
                  <div className="card" style={{ padding: '18px', background: 'linear-gradient(135deg, rgba(59,130,246,0.05), rgba(16,185,129,0.02))', border: '1px solid rgba(59,130,246,0.2)', margin: 0 }}>
                    <h2>Disk Mount</h2>
                    <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>
                      Mount the encrypted vault as a Windows drive and browse it in File Explorer.
                    </p>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '14px 16px' }}>
                      <div>
                        <div style={{ fontWeight: 700, marginBottom: '4px' }}>
                          {mountInfo.status === 'mounted'
                            ? `Mounted at ${mountInfo.drive}`
                            : mountInfo.status === 'mounting'
                            ? 'Mounting vault...'
                            : mountInfo.error === 'winfsp_missing'
                            ? 'WinFsp is required'
                            : mountInfo.error === 'mount_failed'
                            ? 'Mount failed'
                            : 'Vault is not mounted'}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          {mountInfo.status === 'mounted'
                            ? 'File Explorer should already be open. Unmount when you are done.'
                            : mountInfo.status === 'mounting'
                            ? 'Starting the encrypted Google Drive mount. The first mount can take up to 45 seconds.'
                            : mountInfo.error === 'mount_failed'
                            ? 'WinFsp is installed, but the mount did not become ready. Retry after active backup work has settled.'
                            : 'Requires rclone mount support and WinFsp on Windows.'}
                        </div>
                      </div>

                      {mountInfo.status === 'mounted' ? (
                        <button className="btn btn-danger" onClick={handleUnmountVault}>
                          Unmount
                        </button>
                      ) : (
                        <button className="btn btn-primary" disabled={mountInfo.status === 'mounting'} onClick={handleMountVault}>
                          {mountInfo.status === 'mounting' ? 'Mounting...' : 'Mount Vault'}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {restoreSubTab === 'webserver' && (
                  <div className="card" style={{ padding: '18px', background: 'linear-gradient(135deg, rgba(16,185,129,0.05), rgba(52,211,153,0.02))', border: '1px solid rgba(16,185,129,0.2)', margin: 0 }}>
                    <h2>🌐 Restore via Local Web Server</h2>
                    <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>
                      Mount your encrypted vault as a local web page. You can browse, view, and download individual decrypted files directly from your browser without restoring the entire folder structure.
                    </p>
                    {webServerUrl ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px 16px', borderRadius: '6px', fontFamily: 'monospace', color: '#34d399', fontSize: '14px', flex: 1 }}>
                          {webServerUrl}
                        </div>
                        <button 
                          className="btn btn-primary" 
                          onClick={() => openExternal(webServerUrl)}
                        >
                          Open in Browser
                        </button>
                        <button 
                          className="btn btn-danger" 
                          onClick={() => {
                            ipcRenderer.invoke('serve:stop');
                            setWebServerUrl('');
                          }}
                        >
                          Stop Server
                        </button>
                      </div>
                    ) : (
                      <button 
                        className="btn btn-secondary" 
                        disabled={webServerStarting}
                        onClick={() => {
                          setWebServerStarting(true);
                          ipcRenderer.invoke('serve:start').then(url => {
                            setWebServerUrl(url);
                            setWebServerStarting(false);
                          }).catch(e => {
                            console.error('Failed to start server:', e);
                            setWebServerStarting(false);
                          });
                        }}
                      >
                        {webServerStarting ? 'Starting Server...' : 'Start Web Server'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

      </div>
    </div>

      {exclusionsFolder && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '480px' }}>
            <div className="modal-header">
              <h2>Edit Folder Exclusions</h2>
              <button className="modal-close-btn" onClick={() => setExclusionsFolder(null)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: '12.5px', marginBottom: '14px' }}>
                Exclusions are glob patterns relative to the folder root: <strong>{exclusionsFolder.local_path}</strong>
              </p>
              
              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                <input
                  type="text"
                  className="input-control"
                  style={{ flex: 1, height: '36px', padding: '0 12px' }}
                  placeholder="e.g. *.tmp, node_modules, temp/"
                  value={newExclusion}
                  onChange={(e) => setNewExclusion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddExclusion(); }}
                />
                <button className="btn btn-primary" style={{ padding: '0 16px', height: '36px', cursor: 'pointer' }} onClick={handleAddExclusion}>
                  Add
                </button>
              </div>

              <label style={{ marginBottom: '8px', display: 'block' }}>Active Exclusions ({exclusionsList.length})</label>
              {exclusionsList.length === 0 ? (
                <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', background: 'rgba(0,0,0,0.1)', borderRadius: '6px' }}>
                  No custom exclusions. Everything will be backed up.
                </div>
              ) : (
                <ul className="exclusion-list" style={{ background: 'rgba(0,0,0,0.1)', padding: '6px', borderRadius: '6px' }}>
                  {exclusionsList.map(pattern => (
                    <li key={pattern} className="exclusion-item">
                      <span>{pattern}</span>
                      <button className="exclusion-item-remove" onClick={() => handleRemoveExclusion(pattern)}>×</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setExclusionsFolder(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveExclusions}>Save Exclusions</button>
            </div>
          </div>
        </div>
      )}

      {showQuickWizard && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '520px' }}>
            <div className="modal-header">
              <h2>🪄 Quick Backup Wizard</h2>
              <button className="modal-close-btn" onClick={() => setShowQuickWizard(false)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: 1.45 }}>
                Select standard directories to instantly add them to your encrypted backup.
              </p>

              {/* Standard Discovered Folders */}
              <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>Discovered Folders</span>
                  {systemPaths.length > 0 && (
                    <button
                      className="btn-text"
                      style={{ background: 'transparent', border: 'none', color: 'var(--accent-primary)', fontSize: '11.5px', cursor: 'pointer', fontWeight: 600 }}
                      onClick={() => {
                        const availablePaths = systemPaths.filter(p => !p.isConfigured).map(p => p.path);
                        const hasAllSelected = availablePaths.every(p => wizardFoldersToAdd.includes(p));
                        if (hasAllSelected) {
                          setWizardFoldersToAdd(wizardFoldersToAdd.filter(f => !availablePaths.includes(f)));
                        } else {
                          setWizardFoldersToAdd(Array.from(new Set([...wizardFoldersToAdd, ...availablePaths])));
                        }
                      }}
                    >
                      {systemPaths.filter(p => !p.isConfigured).every(p => wizardFoldersToAdd.includes(p.path)) ? 'Deselect All' : 'Select All'}
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto', paddingRight: '4px' }}>
                  {systemPaths.length === 0 ? (
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', margin: '12px 0' }}>Discovering system folders...</p>
                  ) : (
                    systemPaths.map(sp => {
                      const isChecked = wizardFoldersToAdd.includes(sp.path);
                      const getIcon = (id) => {
                        switch (id) {
                          case 'desktop': return '🖥️';
                          case 'documents': return '📁';
                          case 'pictures': return '🖼️';
                          case 'downloads': return '📥';
                          case 'music': return '🎵';
                          case 'videos': return '🎥';
                          default: return '📁';
                        }
                      };
                      return (
                        <div
                          key={sp.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '10px 12px',
                            background: sp.isConfigured ? 'rgba(255,255,255,0.01)' : isChecked ? 'rgba(99, 102, 241, 0.08)' : 'rgba(0, 0, 0, 0.15)',
                            border: isChecked && !sp.isConfigured ? '1px solid rgba(99, 102, 241, 0.3)' : '1px solid rgba(255, 255, 255, 0.03)',
                            borderRadius: '6px',
                            cursor: sp.isConfigured ? 'default' : 'pointer',
                            opacity: sp.isConfigured ? 0.6 : 1,
                            transition: 'all 0.2s ease'
                          }}
                          onClick={() => {
                            if (sp.isConfigured) return;
                            if (isChecked) {
                              setWizardFoldersToAdd(wizardFoldersToAdd.filter(f => f !== sp.path));
                            } else {
                              setWizardFoldersToAdd([...wizardFoldersToAdd, sp.path]);
                            }
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: '18px', flexShrink: 0 }}>{getIcon(sp.id)}</span>
                            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{sp.name}</span>
                              <span style={{ fontSize: '11px', color: 'var(--text-muted)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={sp.path}>
                                {sp.path}
                              </span>
                            </div>
                          </div>
                          {sp.isConfigured ? (
                            <span style={{ fontSize: '10px', background: 'rgba(52, 211, 153, 0.1)', color: '#34d399', padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(52, 211, 153, 0.2)' }}>
                              Backed Up
                            </span>
                          ) : (
                            <input
                              type="checkbox"
                              checked={isChecked}
                              readOnly
                              style={{ width: '15px', height: '15px', cursor: 'pointer', accentColor: 'var(--accent-primary)', marginLeft: '10px' }}
                            />
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Custom Locations */}
              <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>Custom Locations</span>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '11.5px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}
                    onClick={handleSelectQuickWizardFolder}
                  >
                    ➕ Add Custom Folder
                  </button>
                </div>

                {(() => {
                  const customFolders = wizardFoldersToAdd.filter(f => !systemPaths.some(sp => sp.path === f));
                  if (customFolders.length === 0) {
                    return (
                      <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '11.5px', border: '1px dashed rgba(255,255,255,0.06)', borderRadius: '6px' }}>
                        No custom folders added yet.
                      </div>
                    );
                  }
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '120px', overflowY: 'auto' }}>
                      {customFolders.map((folderPath, idx) => (
                        <div
                          key={idx}
                          style={{
                            background: 'rgba(0,0,0,0.15)',
                            border: '1px solid rgba(255, 255, 255, 0.03)',
                            padding: '8px 12px',
                            borderRadius: '6px',
                            fontSize: '12px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                          }}
                        >
                          <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '380px', fontWeight: 500 }} title={folderPath}>
                            {folderPath}
                          </span>
                          <button
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--accent-error)',
                              cursor: 'pointer',
                              fontWeight: 'bold',
                              fontSize: '14px',
                              padding: '0 4px'
                            }}
                            onClick={() => setWizardFoldersToAdd(wizardFoldersToAdd.filter(f => f !== folderPath))}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button className="btn btn-secondary" onClick={() => setShowQuickWizard(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={wizardFoldersToAdd.length === 0}
                onClick={handleFinishQuickWizard}
              >
                Start Backing Up
              </button>
            </div>
          </div>
        </div>
      )}

      {showWinfspDialog && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '440px' }}>
            <div className="modal-header">
              <h2>WinFsp Required</h2>
              <button className="modal-close-btn" onClick={() => setShowWinfspDialog(false)}>×</button>
            </div>
            <div className="modal-body" style={{ textAlign: 'center', padding: '24px' }}>
              <span style={{ fontSize: '48px', display: 'block', marginBottom: '16px' }}>💿</span>
              <h3 style={{ fontSize: '16px', marginBottom: '8px' }}>Windows File System Proxy (WinFsp) Missing</h3>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px', lineHeight: 1.5 }}>
                To mount your encrypted backup vault as a virtual drive in Windows Explorer, you need to install WinFsp. It is a secure, open-source file system manager.
              </p>

              {winfspInstallStage === 'idle' ? (
                <>
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', marginBottom: '10px', cursor: 'pointer' }}
                    onClick={handleInstallWinFsp}
                  >
                    ⚡ Download &amp; Install Automatically
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ width: '100%', marginBottom: '10px', cursor: 'pointer' }}
                    onClick={() => {
                      openExternal('https://winfsp.dev/rel/');
                    }}
                  >
                    🌐 Visit Download Page
                  </button>
                </>
              ) : winfspInstallStage === 'downloading' ? (
                <div style={{ padding: '10px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    <span>Downloading installer...</span>
                    <span>{winfspInstallPercent}%</span>
                  </div>
                  <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${winfspInstallPercent}%`, background: 'var(--accent-primary)', transition: 'width 0.2s' }} />
                  </div>
                </div>
              ) : winfspInstallStage === 'installing' ? (
                <div style={{ padding: '10px 0' }}>
                  <div className="tree-spinner" style={{ display: 'inline-block', marginBottom: '8px' }} />
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Installing WinFsp. Please approve the Windows UAC admin prompt...
                  </p>
                </div>
              ) : winfspInstallStage === 'completed' ? (
                <div style={{ padding: '10px 0', color: '#34d399' }}>
                  <span style={{ fontSize: '24px' }}>✓</span>
                  <p style={{ fontSize: '12px', marginTop: '6px' }}>WinFsp installed successfully! Starting mount...</p>
                </div>
              ) : (
                <div style={{ padding: '10px 0', color: '#f87171' }}>
                  <span style={{ fontSize: '24px' }}>⚠️</span>
                  <p style={{ fontSize: '12px', marginTop: '6px' }}>Installation failed. Please download and install manually.</p>
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', marginTop: '10px', cursor: 'pointer' }}
                    onClick={() => {
                      openExternal('https://winfsp.dev/rel/');
                    }}
                  >
                    🌐 Visit Download Page
                  </button>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => { setShowWinfspDialog(false); setWinfspInstallStage('idle'); }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {showConflictModal && conflictData && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          padding: '20px'
        }}>
          <div className="card" style={{
            maxWidth: '550px',
            width: '100%',
            background: '#121a2e',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            padding: '24px'
          }}>
            <h2 style={{ color: '#fbbf24', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              ⚠️ Backup Conflict Detected
            </h2>
            <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              The file below changed outside this backup run since your last backup check. How would you like to resolve this conflict?
            </p>
            
            <div style={{
              background: 'rgba(0,0,0,0.2)',
              padding: '12px 16px',
              borderRadius: '6px',
              fontFamily: 'monospace',
              fontSize: '12px',
              color: '#93c5fd',
              marginBottom: '20px',
              wordBreak: 'break-all'
            }}>
              <strong>File:</strong> {conflictData.filePath}
            </div>

            <div style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
              <div style={{ flex: 1, background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '12px', color: 'var(--text-muted)' }}>💻 LOCAL FILE</h4>
                <p style={{ margin: '0 0 4px 0', fontSize: '13px' }}>Size: <strong>{formatBytes(conflictData.localSize)}</strong></p>
                <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-muted)' }}>
                  Modified: {new Date(conflictData.localTime).toLocaleString()}
                </p>
              </div>
              <div style={{ flex: 1, background: 'rgba(59,130,246,0.05)', padding: '12px', borderRadius: '6px', border: '1px solid rgba(59,130,246,0.1)' }}>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '12px', color: '#60a5fa' }}>☁️ CLOUD FILE</h4>
                <p style={{ margin: '0 0 4px 0', fontSize: '13px' }}>Size: <strong>{formatBytes(conflictData.remoteSize)}</strong></p>
                <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-muted)' }}>
                  Modified: {new Date(conflictData.remoteTime).toLocaleString()}
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                className="btn btn-primary"
                style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', fontSize: '13px', background: 'var(--accent-primary)', color: '#fff' }}
                onClick={async () => {
                  await ipcRenderer.invoke('sync:resolveConflict', { filePath: conflictData.filePath, resolution: 'keep_local' });
                  setShowConflictModal(false);
                  setConflictData(null);
                }}
              >
                <span>Use Local Version</span>
                <span style={{ fontSize: '11px', opacity: 0.8 }}>(Overwrites Cloud)</span>
              </button>
              <button
                className="btn btn-secondary"
                style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', fontSize: '13px' }}
                onClick={async () => {
                  await ipcRenderer.invoke('sync:resolveConflict', { filePath: conflictData.filePath, resolution: 'keep_remote' });
                  setShowConflictModal(false);
                  setConflictData(null);
                }}
              >
                <span>Use Cloud Version</span>
                <span style={{ fontSize: '11px', opacity: 0.8 }}>(Overwrites Local PC)</span>
              </button>
              <button
                className="btn btn-secondary"
                style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', fontSize: '13px', borderColor: 'rgba(245,158,11,0.3)' }}
                onClick={async () => {
                  await ipcRenderer.invoke('sync:resolveConflict', { filePath: conflictData.filePath, resolution: 'keep_both' });
                  setShowConflictModal(false);
                  setConflictData(null);
                }}
              >
                <span>Keep Both Versions</span>
                <span style={{ fontSize: '11px', opacity: 0.8 }}>(Rename Local File &amp; Download)</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {showAliasModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '440px' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, fontSize: '16px' }}>{aliasModalMode === 'folder' ? 'Rename Backup Folder' : 'Rename / Alias Device'}</h3>
              <button className="modal-close-btn" style={{ fontSize: '20px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => setShowAliasModal(false)}>×</button>
            </div>
            <div className="modal-body" style={{ padding: '16px 20px' }}>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px', marginTop: 0 }}>
                {aliasModalMode === 'folder'
                  ? <>Enter a friendly name for folder <strong style={{ color: '#fff', wordBreak: 'break-all' }}>{aliasModalComputer}</strong>:</>
                  : <>Enter a friendly name or alias for computer <strong>{aliasModalComputer}</strong>:</>}
              </p>
              <input
                type="text"
                className="input-control"
                style={{ width: '100%', padding: '8px 12px', fontSize: '13.5px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', color: '#fff', boxSizing: 'border-box', marginBottom: '16px' }}
                placeholder={aliasModalMode === 'folder' ? 'e.g. Work Files, Desktop Backup...' : 'e.g. My Gaming PC, Work Laptop...'}
                value={aliasModalValue}
                onChange={(e) => setAliasModalValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveComputerAlias();
                }}
                autoFocus
              />
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
              <button className="btn btn-secondary" style={{ padding: '6px 14px', fontSize: '12.5px' }} onClick={() => setShowAliasModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" style={{ padding: '6px 14px', fontSize: '12.5px' }} onClick={handleSaveComputerAlias}>
                Save Alias
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
