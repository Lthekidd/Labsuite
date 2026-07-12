import React, { useEffect, useMemo, useRef, useState } from 'react';

const ipcRenderer = window.electron?.ipcRenderer;
const PAGE_SIZE = 250;

async function safeInvoke(channel, ...args) {
  if (!ipcRenderer) throw new Error('LabSuite IPC is unavailable.');
  return ipcRenderer.invoke(channel, ...args);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatProgress(bytesDone, bytesTotal) {
  if (!bytesTotal) return formatBytes(bytesDone) || 'Working';
  return `${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)}`;
}

function formatSpeed(bytesPerSecond) {
  return bytesPerSecond ? `${formatBytes(bytesPerSecond)}/s` : '';
}

function getJobPercent(job) {
  if (job.bytesTotal > 0) return Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 100));
  if (job.status === 'complete') return 100;
  return 0;
}

function getParentPath(value) {
  const trimmed = String(value || '').replace(/[\\/]+$/, '');
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return '';

  const lastSlash = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (lastSlash < 0) return '';

  const parent = trimmed.slice(0, lastSlash + 1);
  if (/^[A-Za-z]:\\?$/.test(parent)) return parent.endsWith('\\') ? parent : `${parent}\\`;
  return parent.replace(/[\\/]+$/, '');
}

function getItemType(item) {
  if (item.isDrive) return 'Drive';
  if (item.isDir) return 'Folder';
  return item.size ? formatBytes(item.size) : 'File';
}

function getCacheKey(peer, dirPath) {
  return `${peer?.deviceId || peer?.id || peer?.ip || 'peer'}::${dirPath}`;
}

function getPeerKey(peer = {}) {
  return peer.deviceId || peer.id || peer.instanceId || `${peer.ip || 'peer'}:${peer.filePort || ''}`;
}

function getTimestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatRelativeTime(value) {
  const timestamp = getTimestampMs(value);
  if (!timestamp) return 'unknown';
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 2000) return 'just now';
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getPeerHealthView(peer, health, checking) {
  if (checking) {
    return { label: 'Checking', detail: 'Testing file access', color: '#93c5fd', problem: false };
  }

  if (health?.success) {
    const latency = Number.isFinite(Number(health.latencyMs)) ? `${Math.max(1, Math.round(Number(health.latencyMs)))} ms` : 'Online';
    return { label: latency, detail: 'Reachable', color: '#86efac', problem: false };
  }

  if (health && health.success === false) {
    const blocked = health.status === 'blocked' || health.firewallHint;
    return {
      label: blocked ? 'Blocked' : 'Offline',
      detail: blocked ? 'File access did not answer' : (health.error || 'Not reachable'),
      color: '#fca5a5',
      problem: true,
      firewallHint: !!health.firewallHint
    };
  }

  return {
    label: peer.lastSeen ? 'Seen' : 'Unknown',
    detail: peer.lastSeen ? `Last seen ${formatRelativeTime(peer.lastSeen)}` : 'Waiting for health check',
    color: 'var(--text-secondary)',
    problem: false
  };
}

export default function LanPeerDrive() {
  const [accessStatus, setAccessStatus] = useState({ enabled: false, port: null });
  const [lanSettings, setLanSettings] = useState({ deviceName: '', autoStart: false, firewallRule: true, trustedDevices: [] });
  const [draftDeviceName, setDraftDeviceName] = useState('');
  const [peers, setPeers] = useState([]);
  const [peerHealth, setPeerHealth] = useState({});
  const [pingingPeers, setPingingPeers] = useState({});
  const [pendingPairRequests, setPendingPairRequests] = useState([]);
  const [selectedPeerId, setSelectedPeerId] = useState(null);
  const [drives, setDrives] = useState([]);
  const [items, setItems] = useState([]);
  const [currentPath, setCurrentPath] = useState('');
  const [pageInfo, setPageInfo] = useState({ loaded: 0, total: 0, hasMore: false });
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [transfer, setTransfer] = useState(null);
  const [transferJobs, setTransferJobs] = useState([]);
  const [conflictStrategy, setConflictStrategy] = useState('keepBoth');

  // Quick Drop states
  const [rightTab, setRightTab] = useState('drop'); // 'drop' or 'browse'
  const [dropSettings, setDropSettings] = useState({ enabled: true, folder: '', recentDrops: [] });
  const [dragOver, setDragOver] = useState(false);
  const [dropText, setDropText] = useState('');

  const listRequestSeq = useRef(0);
  const folderCache = useRef(new Map());
  const scrollRef = useRef(null);
  const transferUpdateTimerRef = useRef(null);
  const pendingTransferRef = useRef(null);

  const activePeers = useMemo(() => (
    peers.filter(peer => peer && peer.networkDriveEnabled && peer.filePort)
  ), [peers]);

  const selectedPeer = useMemo(() => (
    activePeers.find(peer => peer.id === selectedPeerId || peer.deviceId === selectedPeerId) || null
  ), [activePeers, selectedPeerId]);

  const activePeerSignature = useMemo(() => (
    activePeers.map(peer => `${getPeerKey(peer)}:${peer.ip}:${peer.filePort}:${peer.lastSeen || ''}`).join('|')
  ), [activePeers]);

  useEffect(() => {
    if (!ipcRenderer) return undefined;
    let mounted = true;

    const handlePeers = (event, nextPeers) => {
      if (mounted) setPeers(nextPeers || []);
    };

    const handlePairRequest = (event, request) => {
      if (!mounted || !request) return;
      setPendingPairRequests(previous => [
        request,
        ...previous.filter(item => item.requestId !== request.requestId)
      ]);
    };

    const handleTransfer = (event, progress) => {
      if (!mounted || !progress) return;
      pendingTransferRef.current = {
        ...progress,
        percent: progress.bytesTotal ? Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100)) : 0
      };
      if (transferUpdateTimerRef.current) return;
      transferUpdateTimerRef.current = window.setTimeout(() => {
        transferUpdateTimerRef.current = null;
        if (mounted && pendingTransferRef.current) setTransfer(pendingTransferRef.current);
      }, 100);
    };

    const handleTransferQueue = (event, jobs) => {
      if (mounted) setTransferJobs(jobs || []);
    };

    ipcRenderer.on('lan:peers', handlePeers);
    ipcRenderer.on('lan:pair-request', handlePairRequest);
    ipcRenderer.on('lan:transfer-progress', handleTransfer);
    ipcRenderer.on('lan:transfer-queue', handleTransferQueue);

    loadSettings();
    loadDropSettings();
    safeInvoke('lan:getTransferQueue')
      .then(jobs => {
        if (mounted) setTransferJobs(jobs || []);
      })
      .catch(() => {});
    safeInvoke('lan:getFileAccessStatus')
      .then(status => {
        if (!mounted || !status) return;
        setAccessStatus(status);
        if (status.enabled) {
          safeInvoke('lan:startDiscovery', {
            filePort: status.port,
            networkDriveEnabled: true,
            capabilities: ['pairing', 'file-browser', 'folder-transfer', 'lan-drop']
          }).catch(() => {});
          refreshPeers();
        }
      })
      .catch(err => setError(err.message));

    const dropSettingsTimer = setInterval(() => {
      if (mounted) {
        safeInvoke('lan:getDropSettings')
          .then(ds => {
            if (mounted && ds) {
              setDropSettings(previous => JSON.stringify(previous) === JSON.stringify(ds) ? previous : ds);
            }
          })
          .catch(() => {});
      }
    }, 10000);

    return () => {
      mounted = false;
      clearInterval(dropSettingsTimer);
      if (transferUpdateTimerRef.current) window.clearTimeout(transferUpdateTimerRef.current);
      transferUpdateTimerRef.current = null;
      pendingTransferRef.current = null;
      ipcRenderer.removeListener('lan:peers', handlePeers);
      ipcRenderer.removeListener('lan:pair-request', handlePairRequest);
      ipcRenderer.removeListener('lan:transfer-progress', handleTransfer);
      ipcRenderer.removeListener('lan:transfer-queue', handleTransferQueue);
    };
  }, []);

  useEffect(() => {
    if (selectedPeerId && !selectedPeer) {
      setSelectedPeerId(null);
      setDrives([]);
      setItems([]);
      setCurrentPath('');
      setPageInfo({ loaded: 0, total: 0, hasMore: false });
    }
  }, [selectedPeerId, selectedPeer]);

  useEffect(() => {
    const activeKeys = new Set(activePeers.map(getPeerKey));
    setPeerHealth(previous => {
      const next = {};
      for (const [key, value] of Object.entries(previous)) {
        if (activeKeys.has(key)) next[key] = value;
      }
      return Object.keys(next).length === Object.keys(previous).length ? previous : next;
    });
  }, [activePeerSignature, activePeers]);

  useEffect(() => {
    if (!accessStatus.enabled || activePeers.length === 0) return undefined;

    let cancelled = false;
    pingPeers(activePeers, { quiet: true });
    const timer = setInterval(() => {
      if (!cancelled) pingPeers(activePeers, { quiet: true });
    }, 12000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [accessStatus.enabled, activePeerSignature]);

  const loadSettings = async () => {
    try {
      const settings = await safeInvoke('lan:getSettings');
      if (settings) {
        setLanSettings(settings);
        setDraftDeviceName(settings.deviceName || '');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const saveSettings = async (patch = {}) => {
    setError('');
    setMessage('');
    try {
      const next = await safeInvoke('lan:setSettings', {
        deviceName: draftDeviceName,
        autoStart: lanSettings.autoStart,
        firewallRule: lanSettings.firewallRule,
        ...patch
      });
      if (next) {
        setLanSettings(next);
        setDraftDeviceName(next.deviceName || '');
      }
      setMessage('Network Drive settings saved.');
    } catch (err) {
      setError(err.message);
    }
  };

  const setPeersChecking = (targetPeers, checking) => {
    const keys = (targetPeers || []).map(getPeerKey).filter(Boolean);
    if (!keys.length) return;
    setPingingPeers(previous => {
      const next = { ...previous };
      for (const key of keys) {
        if (checking) next[key] = true;
        else delete next[key];
      }
      return next;
    });
  };

  const pingPeers = async (targetPeers = activePeers, options = {}) => {
    const candidates = (targetPeers || []).filter(peer => peer?.networkDriveEnabled && peer?.filePort);
    if (!candidates.length) return [];

    setPeersChecking(candidates, true);
    try {
      const results = await safeInvoke('lan:pingPeers', {
        peers: candidates,
        timeoutMs: options.timeoutMs || 2500
      });
      const checkedResults = Array.isArray(results) ? results : [];
      setPeerHealth(previous => {
        const next = { ...previous };
        candidates.forEach((peer, index) => {
          const result = checkedResults[index];
          if (result) next[getPeerKey(peer)] = result;
        });
        return next;
      });
      return checkedResults;
    } catch (err) {
      if (!options.quiet) setError(err.message);
      return [];
    } finally {
      setPeersChecking(candidates, false);
    }
  };

  const pingPeer = async (peer, options = {}) => {
    const results = await pingPeers([peer], options);
    return results[0] || null;
  };

  const refreshPeers = async (options = {}) => {
    try {
      const nextPeers = await safeInvoke('lan:getPeers');
      setPeers(nextPeers || []);
      if (options.checkHealth !== false) pingPeers(nextPeers || [], { quiet: true });
      return nextPeers || [];
    } catch (err) {
      setError(err.message);
      return [];
    }
  };

  const enableNetworkDrive = async () => {
    setIsBusy(true);
    setError('');
    setMessage('');
    try {
      const status = await safeInvoke('lan:enableFileAccess', { enabled: true });
      setAccessStatus(status || { enabled: true });
      await refreshPeers();
      const firewallNote = status?.firewall && status.firewall.ok === false ? ` ${status.firewall.message}` : '';
      setMessage(`Network Drive is enabled on this PC.${firewallNote}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const disableNetworkDrive = async () => {
    setIsBusy(true);
    setError('');
    setMessage('');
    try {
      const status = await safeInvoke('lan:enableFileAccess', { enabled: false });
      setAccessStatus(status || { enabled: false });
      setPeers([]);
      setSelectedPeerId(null);
      setDrives([]);
      setItems([]);
      setCurrentPath('');
      setPageInfo({ loaded: 0, total: 0, hasMore: false });
      folderCache.current.clear();
      setMessage('Network Drive is disabled on this PC.');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const requestPair = async (peer) => {
    setIsBusy(true);
    setError('');
    setMessage(`Waiting for ${peer.deviceName || peer.hostname} to approve pairing...`);
    try {
      await safeInvoke('lan:requestPair', { peer });
      await refreshPeers();
      await loadSettings();
      setMessage(`${peer.deviceName || peer.hostname} is paired.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const respondPair = async (request, accepted) => {
    setError('');
    setMessage('');
    try {
      await safeInvoke('lan:respondPairRequest', { requestId: request.requestId, accepted });
      setPendingPairRequests(previous => previous.filter(item => item.requestId !== request.requestId));
      await refreshPeers();
      await loadSettings();
      setMessage(accepted ? `${request.fromName} is paired.` : `Pair request from ${request.fromName} rejected.`);
    } catch (err) {
      setError(err.message);
    }
  };

  const forgetDevice = async (deviceId) => {
    setError('');
    setMessage('');
    try {
      await safeInvoke('lan:forgetTrustedDevice', { deviceId });
      await loadSettings();
      await refreshPeers();
      setMessage('Trusted device removed.');
    } catch (err) {
      setError(err.message);
    }
  };

  const loadDrives = async (peer) => {
    if (!peer) return;
    listRequestSeq.current += 1;
    setIsLoading(true);
    setError('');
    setMessage('');
    try {
      if (!peer.paired) throw new Error('Pair this PC before browsing its files.');
      const nextDrives = await safeInvoke('lan:listPeerDrives', { peer });
      setDrives(nextDrives || []);
      setItems([]);
      setCurrentPath('');
      setPageInfo({ loaded: 0, total: 0, hasMore: false });
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const selectPeer = async (peer) => {
    setRightTab('drop');
    setSelectedPeerId(peer.deviceId || peer.id);
    setDrives([]);
    setItems([]);
    setCurrentPath('');
    setPageInfo({ loaded: 0, total: 0, hasMore: false });
    if (peer.paired) {
      await loadDrives(peer);
    } else {
      setMessage(`Pair ${peer.deviceName || peer.hostname} before browsing.`);
    }
  };

  const loadDirectoryPage = async (dirPath, options = {}) => {
    const peer = options.peerOverride || selectedPeer;
    if (!peer || !dirPath) return;
    if (!peer.paired) {
      setError('Pair this PC before browsing its files.');
      return;
    }

    const append = !!options.append;
    const offset = append ? (options.offset ?? items.length) : 0;
    const cacheKey = getCacheKey(peer, dirPath);
    const requestId = ++listRequestSeq.current;

    if (!append && !options.force) {
      const cached = folderCache.current.get(cacheKey);
      if (cached) {
        setCurrentPath(dirPath);
        setItems(cached.items);
        setPageInfo(cached.pageInfo);
        setError('');
        setMessage('');
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        return;
      }
    }

    if (append) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
      setCurrentPath(dirPath);
      setItems([]);
      setPageInfo({ loaded: 0, total: 0, hasMore: false });
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
    setError('');
    setMessage('');

    try {
      const result = await safeInvoke('lan:listPeerDir', {
        peer,
        dirPath,
        offset,
        limit: PAGE_SIZE,
        includeStats: false
      });

      if (requestId !== listRequestSeq.current) return;
      if (!result || result.success === false) {
        throw new Error(result?.error || 'Could not open this folder.');
      }

      setItems(previousItems => {
        const nextItems = append ? [...previousItems, ...(result.items || [])] : (result.items || []);
        const nextPageInfo = {
          loaded: nextItems.length,
          total: Number(result.total) || nextItems.length,
          hasMore: !!result.hasMore,
          offset: Number(result.offset) || offset,
          limit: Number(result.limit) || PAGE_SIZE
        };
        setPageInfo(nextPageInfo);
        folderCache.current.set(cacheKey, { items: nextItems, pageInfo: nextPageInfo });
        return nextItems;
      });
    } catch (err) {
      if (requestId === listRequestSeq.current) setError(err.message);
    } finally {
      if (requestId === listRequestSeq.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  };

  const goToDrives = () => {
    listRequestSeq.current += 1;
    setCurrentPath('');
    setItems([]);
    setPageInfo({ loaded: 0, total: 0, hasMore: false });
    setIsLoading(false);
    setIsLoadingMore(false);
  };

  const goUp = async () => {
    if (!currentPath) return;
    const parentPath = getParentPath(currentPath);
    if (!parentPath) {
      goToDrives();
      return;
    }
    await loadDirectoryPage(parentPath);
  };

  const refreshCurrentView = async () => {
    if (!selectedPeer) return;
    if (!currentPath) {
      await loadDrives(selectedPeer);
      return;
    }
    folderCache.current.delete(getCacheKey(selectedPeer, currentPath));
    await loadDirectoryPage(currentPath, { force: true });
  };

  const refreshPeerConnection = async (peer) => {
    if (!peer) return;
    setError('');
    setMessage('');

    const refreshedPeers = await refreshPeers({ checkHealth: false });
    const latestPeer = refreshedPeers.find(candidate => getPeerKey(candidate) === getPeerKey(peer)) || peer;
    const result = await pingPeer(latestPeer, { quiet: true });
    const peerName = latestPeer.deviceName || latestPeer.hostname || 'This PC';

    if (result?.success) {
      setMessage(`${peerName} is reachable in ${Math.max(1, Math.round(Number(result.latencyMs) || 1))} ms.`);
      return;
    }

    const firewallNote = result?.firewallHint ? ' Windows Firewall may be blocking LabSuite on that PC.' : '';
    setError(`${peerName} was discovered, but file access did not answer.${firewallNote}`);
  };

  const transferRemoteItem = async (item) => {
    if (!selectedPeer || !item || item.isDrive) return;
    setIsBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await safeInvoke('lan:queueDownloadPeerItem', {
        peer: selectedPeer,
        item,
        conflictStrategy
      });
      if (result?.canceled) return;
      if (!result?.success) throw new Error(result?.error || 'Could not queue copy.');
      setMessage(`Queued ${item.name}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const uploadFilesHere = async () => {
    if (!selectedPeer || !currentPath) return;
    setIsBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await safeInvoke('lan:queueUploadFilesToPeer', {
        peer: selectedPeer,
        remoteDestinationDir: currentPath,
        conflictStrategy
      });
      if (result?.canceled) return;
      if (!result?.success) throw new Error(result?.error || 'Could not queue files.');
      setMessage(`Queued ${result.count} file${result.count === 1 ? '' : 's'} for ${selectedPeer.deviceName}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const uploadFolderHere = async () => {
    if (!selectedPeer || !currentPath) return;
    setIsBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await safeInvoke('lan:queueUploadFolderToPeer', {
        peer: selectedPeer,
        remoteDestinationDir: currentPath,
        conflictStrategy
      });
      if (result?.canceled) return;
      if (!result?.success) throw new Error(result?.error || 'Could not queue folder.');
      setMessage('Queued folder transfer.');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const loadDropSettings = async () => {
    try {
      const ds = await safeInvoke('lan:getDropSettings');
      if (ds) setDropSettings(ds);
    } catch (e) {
      console.warn('Failed to load drop settings:', e);
    }
  };

  const toggleDropEnabled = async (enabled) => {
    try {
      const next = await safeInvoke('lan:setDropSettings', { enabled });
      if (next) setDropSettings(next);
    } catch (err) {
      setError(err.message);
    }
  };

  const selectDropFolder = async () => {
    try {
      const result = await safeInvoke('folders:selectRestoreDest');
      if (result) {
        const next = await safeInvoke('lan:setDropSettings', { folder: result });
        if (next) setDropSettings(next);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const openDropInbox = async () => {
    try {
      await safeInvoke('lan:openDropInbox');
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    if (!selectedPeer) return;

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    setIsBusy(true);
    setError('');
    setMessage('');

    try {
      const paths = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const path = window.electron.getPathForFile(file);
        if (path) paths.push(path);
      }

      if (paths.length === 0) {
        throw new Error('Could not retrieve local paths for dragged files.');
      }

      const result = await safeInvoke('lan:queueDropPathsToPeer', {
        peer: selectedPeer,
        paths,
        conflictStrategy
      });

      if (result && result.success) {
        setMessage(`Successfully queued ${result.count} drop item${result.count === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const dropFiles = async (selectFolder = false) => {
    if (!selectedPeer) return;
    setIsBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await safeInvoke('lan:queueDropPathsToPeer', {
        peer: selectedPeer,
        selectFolder,
        conflictStrategy
      });
      if (result?.canceled) return;
      if (!result?.success) throw new Error(result?.error || 'Could not queue drop.');
      setMessage('Successfully queued drop.');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const sendDropText = async () => {
    if (!selectedPeer || !dropText.trim()) return;
    setIsBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await safeInvoke('lan:queueDropTextToPeer', {
        peer: selectedPeer,
        text: dropText
      });
      if (result && result.success) {
        setMessage('Pasted text drop successfully queued.');
        setDropText('');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const sendLocalHere = async (folder = false) => {
    if (!selectedPeer || !currentPath) return;
    setIsBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await safeInvoke(folder ? 'lan:queueUploadFolderToPeer' : 'lan:queueUploadFilesToPeer', {
        peer: selectedPeer,
        remoteDestinationDir: currentPath,
        conflictStrategy
      });
      if (result?.canceled) return;
      if (!result?.success) throw new Error(result?.error || 'Could not queue send.');
      setMessage(folder ? 'Queued folder send.' : `Queued ${result.count} file${result.count === 1 ? '' : 's'} for ${selectedPeer.deviceName}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const loadMore = async () => {
    if (!currentPath || !pageInfo.hasMore || isLoadingMore) return;
    await loadDirectoryPage(currentPath, { append: true, offset: pageInfo.loaded });
  };

  const cancelTransferJob = async (jobId) => {
    try {
      await safeInvoke('lan:cancelTransferJob', { jobId });
    } catch (err) {
      setError(err.message);
    }
  };

  const retryTransferJob = async (jobId) => {
    try {
      await safeInvoke('lan:retryTransferJob', { jobId });
    } catch (err) {
      setError(err.message);
    }
  };

  const clearFinishedTransfers = async () => {
    try {
      const jobs = await safeInvoke('lan:clearFinishedTransfers');
      setTransferJobs(jobs || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const displayedItems = currentPath ? items : drives;
  const countLabel = currentPath && pageInfo.total
    ? `${pageInfo.loaded} of ${pageInfo.total} loaded`
    : currentPath
      ? `${items.length} loaded`
      : `${drives.length} drive${drives.length === 1 ? '' : 's'}`;
  const transferPercent = transfer?.bytesTotal ? Math.min(100, transfer.percent || 0) : (transfer?.done ? 100 : 0);

  return (
    <div style={{ height: '100%', padding: '24px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '14px', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '24px' }}>Network Drive</h1>
          <div style={{ marginTop: '6px', color: 'var(--text-secondary)', fontSize: '13px' }}>
            {accessStatus.enabled ? `Enabled on port ${accessStatus.port}` : 'Disabled on this PC'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span style={{
            padding: '7px 10px',
            borderRadius: '999px',
            border: '1px solid var(--border-color)',
            color: accessStatus.enabled ? '#86efac' : 'var(--text-muted)',
            fontSize: '12px',
            fontWeight: 700
          }}>
            {accessStatus.enabled ? 'LAN Access On' : 'LAN Access Off'}
          </span>
          <button className="btn btn-secondary" onClick={refreshPeers} disabled={!accessStatus.enabled || isBusy}>Refresh</button>
          {accessStatus.enabled ? (
            <button className="btn btn-danger" onClick={disableNetworkDrive} disabled={isBusy}>Disable</button>
          ) : (
            <button className="btn btn-primary" onClick={enableNetworkDrive} disabled={isBusy}>Enable</button>
          )}
        </div>
      </div>

      <section style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '12px', background: 'rgba(255,255,255,0.025)', display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 160px auto auto auto', gap: '10px', alignItems: 'center' }}>
        <input
          className="input-control"
          value={draftDeviceName}
          onChange={event => setDraftDeviceName(event.target.value)}
          placeholder="Device name"
          style={{ height: '38px', padding: '8px 10px' }}
        />
        <select
          className="input-control"
          value={conflictStrategy}
          onChange={event => setConflictStrategy(event.target.value)}
          style={{ height: '38px', padding: '8px 10px' }}
          title="Conflict behavior"
        >
          <option value="keepBoth">Keep both</option>
          <option value="replace">Replace</option>
          <option value="skip">Skip existing</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', textTransform: 'none', letterSpacing: 0, fontSize: '12px' }}>
          <input
            type="checkbox"
            checked={!!lanSettings.autoStart}
            onChange={event => {
              const next = { ...lanSettings, autoStart: event.target.checked };
              setLanSettings(next);
              saveSettings({ autoStart: event.target.checked });
            }}
          />
          Auto-start
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', textTransform: 'none', letterSpacing: 0, fontSize: '12px' }}>
          <input
            type="checkbox"
            checked={lanSettings.firewallRule !== false}
            onChange={event => {
              const next = { ...lanSettings, firewallRule: event.target.checked };
              setLanSettings(next);
              saveSettings({ firewallRule: event.target.checked });
            }}
          />
          Firewall
        </label>
        <button className="btn btn-secondary" onClick={() => saveSettings()} disabled={isBusy}>Save Name</button>
      </section>

      {pendingPairRequests.length > 0 && (
        <section style={{ border: '1px solid rgba(64,138,113,0.45)', borderRadius: '8px', padding: '12px', background: 'rgba(64,138,113,0.08)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {pendingPairRequests.map(request => (
            <div key={request.requestId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <div style={{ minWidth: 0 }}>
                <strong>{request.fromName}</strong>
                <span style={{ marginLeft: '10px', color: 'var(--text-secondary)', fontSize: '13px' }}>{request.fromIp}</span>
                <span style={{ marginLeft: '10px', color: 'var(--accent-secondary)', fontWeight: 800, letterSpacing: '1px' }}>{request.code}</span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-secondary" onClick={() => respondPair(request, false)}>Reject</button>
                <button className="btn btn-primary" onClick={() => respondPair(request, true)}>Pair</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {transfer && (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '10px 12px', background: 'rgba(255,255,255,0.025)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '8px', fontSize: '13px' }}>
            <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {transfer.direction === 'upload' ? 'Uploading' : 'Downloading'} {transfer.fileName}
            </strong>
            <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              {transfer.fileIndex && transfer.fileCount ? `${transfer.fileIndex}/${transfer.fileCount} - ` : ''}{formatProgress(transfer.bytesDone, transfer.bytesTotal)}
            </span>
          </div>
          <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '999px', overflow: 'hidden' }}>
            <div style={{ width: `${transferPercent}%`, height: '100%', background: 'var(--accent-primary)', transition: 'width 0.15s ease' }} />
          </div>
        </div>
      )}

      {transferJobs.length > 0 && (
        <section style={{ border: '1px solid var(--border-color)', borderRadius: '8px', background: 'rgba(255,255,255,0.025)', overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <strong style={{ fontSize: '13px' }}>Transfer Queue</strong>
            <button className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: '12px' }} onClick={clearFinishedTransfers}>
              Clear Finished
            </button>
          </div>
          <div style={{ maxHeight: '190px', overflowY: 'auto' }}>
            {transferJobs.slice(0, 8).map(job => {
              const percent = getJobPercent(job);
              const running = job.status === 'running';
              const canCancel = job.status === 'queued' || running;
              const canRetry = job.status === 'failed' || job.status === 'canceled';
              return (
                <div key={job.id} style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.045)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: '10px', alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', minWidth: 0 }}>
                        <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.label}</strong>
                        <span style={{ color: job.status === 'failed' ? '#fca5a5' : job.status === 'complete' ? '#86efac' : 'var(--text-secondary)', fontSize: '12px', fontWeight: 700 }}>
                          {job.status}
                        </span>
                        {job.verified && <span style={{ color: '#86efac', fontSize: '12px', fontWeight: 700 }}>verified</span>}
                      </div>
                      <div style={{ marginTop: '4px', color: 'var(--text-muted)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {job.activeFileName ? `${job.activeFileName} - ` : ''}
                        {formatProgress(job.bytesDone, job.bytesTotal)}
                        {job.speed ? ` - ${formatSpeed(job.speed)}` : ''}
                        {job.etaSeconds > 0 ? ` - ${job.etaSeconds}s left` : ''}
                        {job.error ? ` - ${job.error}` : ''}
                      </div>
                    </div>
                    <div style={{ width: '120px', height: '6px', borderRadius: '999px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                      <div style={{ width: `${percent}%`, height: '100%', background: job.status === 'failed' ? '#ef4444' : 'var(--accent-primary)', transition: 'width 0.15s ease' }} />
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {canCancel && (
                        <button className="btn btn-secondary" style={{ padding: '6px 9px', fontSize: '12px' }} onClick={() => cancelTransferJob(job.id)}>
                          Cancel
                        </button>
                      )}
                      {canRetry && (
                        <button className="btn btn-primary" style={{ padding: '6px 9px', fontSize: '12px' }} onClick={() => retryTransferJob(job.id)}>
                          Retry
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {(message || error) && (
        <div style={{
          padding: '10px 12px',
          borderRadius: '8px',
          border: `1px solid ${error ? 'rgba(239,68,68,0.25)' : 'rgba(34,197,94,0.22)'}`,
          color: error ? '#fca5a5' : '#86efac',
          background: error ? 'rgba(239,68,68,0.06)' : 'rgba(34,197,94,0.06)',
          fontSize: '13px'
        }}>
          {error || message}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '310px minmax(0, 1fr)', gap: '18px', minHeight: 0, flex: 1 }}>
        <section style={{ minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'rgba(255,255,255,0.025)', overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-color)', fontWeight: 700 }}>LabSuite PCs</div>
          <div style={{ padding: '10px', overflowY: 'auto', minHeight: 0, flex: 1 }}>
            {!accessStatus.enabled ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '18px 10px', lineHeight: 1.5 }}>Enable Network Drive to discover enabled LabSuite PCs.</div>
            ) : activePeers.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '18px 10px', lineHeight: 1.5 }}>No enabled LabSuite PCs found on this network.</div>
            ) : (
              activePeers.map(peer => {
                const active = selectedPeerId === peer.deviceId || selectedPeerId === peer.id;
                const peerKey = getPeerKey(peer);
                const health = peerHealth[peerKey];
                const checking = !!pingingPeers[peerKey];
                const healthView = getPeerHealthView(peer, health, checking);
                const lastSeenLabel = peer.lastSeen ? formatRelativeTime(peer.lastSeen) : 'unknown';
                return (
                  <div
                    key={peer.deviceId || peer.id}
                    style={{
                      border: `1px solid ${active ? 'rgba(64,138,113,0.8)' : 'var(--border-color)'}`,
                      background: active ? 'rgba(64,138,113,0.16)' : 'rgba(0,0,0,0.16)',
                      borderRadius: '8px',
                      padding: '12px',
                      marginBottom: '10px'
                    }}
                  >
                    <button
                      onClick={() => selectPeer(peer)}
                      style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text-primary)', textAlign: 'left', padding: 0, cursor: 'pointer' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                        <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{peer.deviceName || peer.hostname || 'LabSuite PC'}</strong>
                        <span style={{ color: peer.paired ? '#86efac' : '#fbbf24', fontSize: '11px', fontWeight: 800 }}>
                          {peer.paired ? 'PAIRED' : 'NEW'}
                        </span>
                      </div>
                      <div style={{ marginTop: '6px', color: 'var(--text-secondary)', fontSize: '12px' }}>{peer.ip}:{peer.filePort}</div>
                      <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '12px' }}>
                        <span style={{ color: healthView.color, fontWeight: 800 }}>{healthView.label}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{healthView.detail}</span>
                        <span style={{ color: 'var(--text-muted)' }}>Last seen {lastSeenLabel}</span>
                      </div>
                      {healthView.problem && healthView.firewallHint && (
                        <div style={{ marginTop: '8px', color: '#fca5a5', fontSize: '12px', lineHeight: 1.45 }}>
                          Discovered on LAN, but file access is not reachable. Windows Firewall may be blocking LabSuite on this PC.
                        </div>
                      )}
                    </button>
                    <div style={{ marginTop: '10px', display: 'flex', gap: '8px' }}>
                      {!peer.paired ? (
                        <button className="btn btn-primary" style={{ padding: '7px 12px', flex: 1 }} onClick={() => requestPair(peer)} disabled={isBusy}>Pair</button>
                      ) : (
                        <button className="btn btn-secondary" style={{ padding: '7px 12px', flex: 1 }} onClick={() => forgetDevice(peer.deviceId)} disabled={isBusy}>Forget</button>
                      )}
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '7px 12px', minWidth: '92px' }}
                        onClick={() => refreshPeerConnection(peer)}
                        disabled={checking}
                      >
                        {checking ? 'Checking' : healthView.problem ? 'Reconnect' : 'Check'}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section style={{ minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'rgba(255,255,255,0.025)', overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedPeer ? (selectedPeer.deviceName || selectedPeer.hostname) : 'Remote Files'}
              </div>
              <div style={{ marginTop: '4px', color: 'var(--text-muted)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedPeer ? (selectedPeer.paired ? (rightTab === 'drop' ? 'Quick Drop Active' : `${currentPath || 'Drives'} - ${countLabel}`) : 'Pair required') : 'Select a PC'}
              </div>
            </div>

            {/* Segmented Control Tabs */}
            {selectedPeer && selectedPeer.paired && (
              <div style={{ display: 'flex', background: 'rgba(0,0,0,0.20)', padding: '3px', borderRadius: '8px', border: '1px solid var(--border-color)', margin: '0 auto 0 20px' }}>
                <button
                  type="button"
                  onClick={() => setRightTab('drop')}
                  style={{
                    padding: '5px 12px',
                    borderRadius: '6px',
                    border: 'none',
                    background: rightTab === 'drop' ? 'var(--accent-primary-alpha)' : 'transparent',
                    color: rightTab === 'drop' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: rightTab === 'drop' ? 700 : 500,
                    transition: 'all 0.15s'
                  }}
                >
                  🪂 Quick Drop
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab('browse')}
                  style={{
                    padding: '5px 12px',
                    borderRadius: '6px',
                    border: 'none',
                    background: rightTab === 'browse' ? 'var(--accent-primary-alpha)' : 'transparent',
                    color: rightTab === 'browse' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: rightTab === 'browse' ? 700 : 500,
                    transition: 'all 0.15s'
                  }}
                >
                  📁 Browse Files
                </button>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', flex: '0 0 auto', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {rightTab === 'browse' && (
                <>
                  <button className="btn btn-secondary" onClick={goToDrives} disabled={!selectedPeer?.paired || isLoading || isBusy}>Drives</button>
                  <button className="btn btn-secondary" onClick={goUp} disabled={!selectedPeer?.paired || !currentPath || isLoading || isBusy}>Up</button>
                  <button className="btn btn-secondary" onClick={refreshCurrentView} disabled={!selectedPeer?.paired || isLoading || isBusy}>Refresh Folder</button>
                  <button className="btn btn-primary" onClick={uploadFilesHere} disabled={!selectedPeer?.paired || !currentPath || isLoading || isBusy}>Send Files</button>
                  <button className="btn btn-primary" onClick={uploadFolderHere} disabled={!selectedPeer?.paired || !currentPath || isLoading || isBusy}>Send Folder</button>
                </>
              )}
              {rightTab === 'drop' && selectedPeer?.paired && (
                <>
                  <button className="btn btn-secondary" onClick={openDropInbox}>Open My Drop Inbox</button>
                </>
              )}
            </div>
          </div>

          <div ref={scrollRef} style={{ overflow: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
            {!selectedPeer ? (
              <div style={{ color: 'var(--text-muted)', padding: '36px', textAlign: 'center' }}>Pick an enabled LabSuite PC.</div>
            ) : !selectedPeer.paired ? (
              <div style={{ color: 'var(--text-muted)', padding: '36px', textAlign: 'center' }}>Pair this PC to browse its files.</div>
            ) : rightTab === 'drop' ? (
              <QuickDropPanel
                selectedPeer={selectedPeer}
                dropSettings={dropSettings}
                toggleDropEnabled={toggleDropEnabled}
                selectDropFolder={selectDropFolder}
                openDropInbox={openDropInbox}
                dragOver={dragOver}
                setDragOver={setDragOver}
                handleDrop={handleDrop}
                dropFiles={dropFiles}
                dropText={dropText}
                setDropText={setDropText}
                sendDropText={sendDropText}
                isBusy={isBusy}
              />
            ) : isLoading ? (
              <div style={{ color: 'var(--text-secondary)', padding: '36px', textAlign: 'center' }}>Loading...</div>
            ) : displayedItems.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', padding: '36px', textAlign: 'center' }}>This folder is empty.</div>
            ) : (
              <>
                <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                  <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1 }}>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '10px 14px', color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.8px', borderBottom: '1px solid var(--border-color)' }}>Name</th>
                      <th style={{ textAlign: 'left', width: '96px', padding: '10px 14px', color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.8px', borderBottom: '1px solid var(--border-color)' }}>Type</th>
                      <th style={{ textAlign: 'right', width: '260px', padding: '10px 14px', color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.8px', borderBottom: '1px solid var(--border-color)' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedItems.map(item => {
                      const canOpen = item.isDir || item.isDrive;
                      return (
                        <tr key={item.path} style={{ borderBottom: '1px solid rgba(255,255,255,0.045)' }}>
                          <td style={{ padding: '11px 14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <span style={{ color: canOpen ? 'var(--accent-secondary)' : 'var(--text-primary)', fontWeight: canOpen ? 700 : 500 }}>{item.name}</span>
                            {item.free && item.size ? (
                              <span style={{ marginLeft: '10px', color: 'var(--text-muted)', fontSize: '12px' }}>{formatBytes(item.free)} free</span>
                            ) : null}
                          </td>
                          <td style={{ padding: '11px 14px', color: 'var(--text-secondary)', fontSize: '13px' }}>{getItemType(item)}</td>
                          <td style={{ padding: '8px 14px', textAlign: 'right' }}>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
                              {canOpen && (
                                <button className="btn btn-secondary" style={{ padding: '7px 10px', minWidth: '60px' }} onClick={() => loadDirectoryPage(item.path)}>Open</button>
                              )}
                              {!item.isDrive && (
                                <>
                                  <button className="btn btn-primary" style={{ padding: '7px 10px', minWidth: '72px' }} onClick={() => transferRemoteItem(item)} disabled={isBusy}>Copy</button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {currentPath && pageInfo.hasMore && (
                  <div style={{ padding: '14px', display: 'flex', justifyContent: 'center' }}>
                    <button className="btn btn-secondary" onClick={loadMore} disabled={isLoadingMore || isBusy}>
                      {isLoadingMore ? 'Loading...' : `Load more (${pageInfo.loaded}/${pageInfo.total})`}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function QuickDropPanel({
  selectedPeer,
  dropSettings,
  toggleDropEnabled,
  selectDropFolder,
  openDropInbox,
  dragOver,
  setDragOver,
  handleDrop,
  dropFiles,
  dropText,
  setDropText,
  sendDropText,
  isBusy
}) {
  return (
    <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px', height: '100%', overflowY: 'auto' }}>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>

        {/* Drop Zone Card */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{
            minHeight: '200px',
            border: dragOver ? '2px dashed var(--accent-primary)' : '2px dashed var(--border-color)',
            background: dragOver ? 'var(--accent-primary-alpha)' : 'rgba(255,255,255,0.015)',
            borderRadius: '12px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            textAlign: 'center',
            cursor: 'default',
            transition: 'all 0.2s',
            boxShadow: dragOver ? '0 8px 24px var(--accent-primary-alpha)' : 'none'
          }}
        >
          <div style={{ fontSize: '42px', marginBottom: '14px' }}>🪂</div>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '16px', color: 'var(--text-primary)' }}>Drag & Drop Files Here</h3>
          <p style={{ margin: '0 0 16px 0', color: 'var(--text-secondary)', fontSize: '13px', maxWidth: '240px' }}>
            Drop files or folders to send them instantly to <strong>{selectedPeer.deviceName}</strong>.
          </p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn btn-primary" type="button" onClick={() => dropFiles(false)} disabled={isBusy} style={{ padding: '8px 14px', fontSize: '12.5px' }}>
              Send Files
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => dropFiles(true)} disabled={isBusy} style={{ padding: '8px 14px', fontSize: '12.5px' }}>
              Send Folder
            </button>
          </div>
        </div>

        {/* Text Drop Card */}
        <div style={{
          border: '1px solid var(--border-color)',
          borderRadius: '12px',
          background: 'rgba(255,255,255,0.015)',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '20px' }}>📝</span>
            <strong style={{ fontSize: '15px', color: 'var(--text-primary)' }}>Send Clipboard or Text</strong>
          </div>
          <textarea
            className="input-control"
            value={dropText}
            onChange={(e) => setDropText(e.target.value)}
            placeholder="Type or paste text here to drop as a .txt file..."
            style={{
              flex: 1,
              minHeight: '90px',
              resize: 'none',
              padding: '10px',
              fontSize: '13px',
              fontFamily: 'inherit',
              background: 'rgba(0,0,0,0.2)',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)'
            }}
          />
          <button
            className="btn btn-primary"
            type="button"
            onClick={sendDropText}
            disabled={isBusy || !dropText.trim()}
            style={{ width: '100%', padding: '9px', fontSize: '13px' }}
          >
            Send Text Drop
          </button>
        </div>

      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>

        {/* Local Inbox Settings */}
        <div style={{
          border: '1px solid var(--border-color)',
          borderRadius: '12px',
          background: 'rgba(255,255,255,0.015)',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '10px' }}>
            <span style={{ fontSize: '18px' }}>⚙️</span>
            <strong style={{ fontSize: '14px', color: 'var(--text-primary)' }}>My Quick Drop Settings</strong>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', cursor: 'pointer', color: 'var(--text-primary)' }}>
            <input
              type="checkbox"
              checked={!!dropSettings.enabled}
              onChange={(e) => toggleDropEnabled(e.target.checked)}
              style={{ width: '16px', height: '16px' }}
            />
            Allow incoming drops from paired PCs
          </label>

          <div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>Inbox Directory:</div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                className="input-control"
                value={dropSettings.folder}
                readOnly
                style={{
                  flex: 1,
                  height: '34px',
                  padding: '6px 10px',
                  fontSize: '12px',
                  background: 'rgba(0,0,0,0.15)',
                  borderColor: 'var(--border-color)',
                  color: 'var(--text-muted)'
                }}
              />
              <button
                className="btn btn-secondary"
                type="button"
                onClick={selectDropFolder}
                style={{ padding: '0 12px', height: '34px', fontSize: '12px' }}
              >
                Change
              </button>
            </div>
          </div>

          <button
            className="btn btn-secondary"
            type="button"
            onClick={openDropInbox}
            style={{ width: '100%', padding: '9px', fontSize: '13px' }}
          >
            Open Drop Inbox Folder
          </button>
        </div>

        {/* Recent Received Drops */}
        <div style={{
          border: '1px solid var(--border-color)',
          borderRadius: '12px',
          background: 'rgba(255,255,255,0.015)',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          minHeight: '220px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '10px' }}>
            <span style={{ fontSize: '18px' }}>📥</span>
            <strong style={{ fontSize: '14px', color: 'var(--text-primary)' }}>Recent Received Drops</strong>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', maxHeight: '180px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {!dropSettings.recentDrops || dropSettings.recentDrops.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', textAlign: 'center', marginTop: '24px' }}>
                No drops received yet.
              </div>
            ) : (
              dropSettings.recentDrops.map((drop, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: '8px 10px',
                    background: 'rgba(0,0,0,0.12)',
                    border: '1px solid rgba(255,255,255,0.03)',
                    borderRadius: '8px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '10px'
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }} title={drop.fileName}>
                      {drop.type === 'text' ? '📝' : '📁'} {drop.fileName}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      From {drop.from} • {formatBytes(drop.size)}
                    </div>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {formatRelativeTime(drop.timestamp)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

    </div>
  );
}
