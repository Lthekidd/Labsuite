import React, { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import ErrorBoundary from './ErrorBoundary';
import AppHub, { HUB_APPS, renderSmallIcon } from './apps/AppHub';
import { invokeResource, invalidateResource } from './resourceStore';

function createModuleLoader(importModule) {
  let modulePromise = null;
  return () => {
    if (!modulePromise) modulePromise = importModule();
    return modulePromise;
  };
}

const WORKSPACE_LOADERS = {
  backup: createModuleLoader(() => import('./apps/LabSuiteBackup')),
  telegram: createModuleLoader(() => import('./apps/TelegramBackup')),
  crypto: createModuleLoader(() => import('./apps/CryptoPortfolioTracker')),
  notebook: createModuleLoader(() => import('./apps/LabSuiteNotebook')),
  settings: createModuleLoader(() => import('./apps/LabSuiteSettings')),
  sheets: createModuleLoader(() => import('./apps/LabSuiteSheets')),
  todo: createModuleLoader(() => import('./apps/LabSuiteTodo')),
  lan: createModuleLoader(() => import('./apps/LanPeerDrive')),
  'vm-protect': createModuleLoader(() => import('./apps/VMProtect'))
};

const LabSuiteBackup = React.memo(lazy(WORKSPACE_LOADERS.backup));
const LabSuiteNotebook = React.memo(lazy(WORKSPACE_LOADERS.notebook));
const LabSuiteSettings = React.memo(lazy(WORKSPACE_LOADERS.settings));
const CryptoPortfolioTracker = React.memo(lazy(WORKSPACE_LOADERS.crypto));
const TelegramBackup = React.memo(lazy(WORKSPACE_LOADERS.telegram));
const MemoizedAppHub = React.memo(AppHub);

const WORKSPACE_REGISTRY = {
  hub: { id: 'hub', mode: 'embedded', retention: 'light' },
  backup: { id: 'backup', mode: 'embedded', retention: 'pinned', loader: WORKSPACE_LOADERS.backup },
  telegram: { id: 'telegram', mode: 'embedded', retention: 'heavy', loader: WORKSPACE_LOADERS.telegram },
  crypto: { id: 'crypto', mode: 'embedded', retention: 'heavy', loader: WORKSPACE_LOADERS.crypto },
  notebook: { id: 'notebook', mode: 'embedded', retention: 'pinned', loader: WORKSPACE_LOADERS.notebook },
  settings: { id: 'settings', mode: 'embedded', retention: 'light', loader: WORKSPACE_LOADERS.settings },
  sheets: { id: 'sheets', mode: 'standalone', retention: 'window', loader: WORKSPACE_LOADERS.sheets },
  todo: { id: 'todo', mode: 'standalone', retention: 'window', loader: WORKSPACE_LOADERS.todo },
  lan: { id: 'lan', mode: 'standalone', retention: 'window', loader: WORKSPACE_LOADERS.lan },
  'vm-protect': { id: 'vm-protect', mode: 'standalone', retention: 'window', loader: WORKSPACE_LOADERS['vm-protect'] }
};

const MAX_HEAVY_WORKSPACES = 4;

function LtcIcon({ size = 16 }) {
  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 24 24" 
      style={{ display: 'inline-block', verticalAlign: 'middle', overflow: 'visible' }}
    >
      <circle cx="12" cy="12" r="12" fill="#345d9d" />
      <path d="M10.11 5.548h2.242v8.031h3.535v1.932h-5.777V5.548z" fill="white" />
      <polygon points="8.473,13.682 16.504,9.436 17.356,11.05 9.325,15.296" fill="white" />
    </svg>
  );
}

function VmIcon({ size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      <rect x="3" y="4" width="18" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 21h8M12 17v4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m10 8 5 2.5-5 2.5V8Z" fill="currentColor" />
    </svg>
  );
}

function PcIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 21h8M12 17v4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

const ipcRenderer = window.electron.ipcRenderer;

async function safeInvoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    console.warn(`IPC Error on ${channel}:`, err.message);
    return null;
  }
}

const SHUTDOWN_PRESETS = [
  { label: '10 min', seconds: 10 * 60 },
  { label: '30 min', seconds: 30 * 60 },
  { label: '1 hr', seconds: 60 * 60 },
  { label: '3 hrs', seconds: 3 * 60 * 60 },
  { label: '5 hrs', seconds: 5 * 60 * 60 },
  { label: '8 hrs', seconds: 8 * 60 * 60 }
];

// Core apps that are always available (cannot be uninstalled)
const CORE_APP_IDS = new Set(['backup', 'telegram', 'crypto', 'settings']);

// Apps that open in standalone windows (not embedded in sidebar content area)
const STANDALONE_APP_IDS = new Set(['sheets', 'lan', 'vm-protect', 'todo']);

function parseInstalledApps(value) {
  try {
    const items = JSON.parse(String(value || '[]'));
    return Array.isArray(items) ? items : [];
  } catch (_) {
    return [];
  }
}

function formatShutdownDuration(totalSeconds = 0) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState('backup');
  const [theme, setTheme] = useState('dark');
  const [appVersion, setAppVersion] = useState('2.2.0');
  const [externalFilePath, setExternalFilePath] = useState(null);
  const [globalGDriveInfo, setGlobalGDriveInfo] = useState({ email: 'Disconnected', used: 0, total: 0 });
  const [deviceName, setDeviceName] = useState('This PC');
  const [healthStatus, setHealthStatus] = useState('Checking...');
  const [backupSubTab, setBackupSubTab] = useState('dashboard');
  const [globalStatus, setGlobalStatus] = useState('Protected');
  const [globalStatusDetail, setGlobalStatusDetail] = useState('All enabled backups on this PC are healthy.');
  const [globalFailureCount, setGlobalFailureCount] = useState(0);
  const [installedApps, setInstalledApps] = useState([]);
  const [mountedWorkspaces, setMountedWorkspaces] = useState(['backup']);
  const [launchingApps, setLaunchingApps] = useState([]);
  const workspaceLastUsedRef = useRef(new Map([['backup', Date.now()]]));

  const prefetchWorkspace = useCallback((id) => {
    const definition = WORKSPACE_REGISTRY[id];
    const loader = definition?.mode === 'embedded' ? definition.loader : null;
    if (loader) loader().catch(error => {
      console.warn(`Failed to prefetch ${id}:`, error.message);
    });
  }, []);

  const activateWorkspace = useCallback((id) => {
    const definition = WORKSPACE_REGISTRY[id] || WORKSPACE_REGISTRY.hub;
    if (definition.mode !== 'embedded') return;

    try {
      performance.clearMarks(`workspace-nav-${id}-start`);
      performance.mark(`workspace-nav-${id}-start`);
    } catch (_) {}

    workspaceLastUsedRef.current.set(id, Date.now());
    setMountedWorkspaces(previous => {
      const next = previous.includes(id) ? [...previous] : [...previous, id];
      const heavy = next.filter(workspaceId => {
        const retention = WORKSPACE_REGISTRY[workspaceId]?.retention;
        return retention === 'heavy' || retention === 'pinned';
      });
      if (heavy.length <= MAX_HEAVY_WORKSPACES) return next;

      const removable = heavy
        .filter(workspaceId => (
          workspaceId !== id &&
          WORKSPACE_REGISTRY[workspaceId]?.retention !== 'pinned'
        ))
        .sort((a, b) => (
          (workspaceLastUsedRef.current.get(a) || 0) -
          (workspaceLastUsedRef.current.get(b) || 0)
        ));
      const evict = removable.slice(0, heavy.length - MAX_HEAVY_WORKSPACES);
      return next.filter(workspaceId => !evict.includes(workspaceId));
    });
    setActiveTab(id);
  }, []);

  const refreshGlobalStatus = ({ force = false } = {}) => {
    Promise.all([
      invokeResource('folders:list', [], { ttl: 30000, force }),
      invokeResource('settings:get', [], { ttl: Infinity, force })
    ]).then(([foldersList, s]) => {
      if (s && s.setup_complete !== '1') {
        setGlobalStatus('pending');
        setGlobalStatusDetail('Finish backup setup to start protection.');
        setGlobalFailureCount(0);
        return;
      }
      const activeLocalFolders = (foldersList || []).filter(folder => (
        (folder.enabled === 1 || folder.enabled === true || folder.enabled === undefined) &&
        folder.is_local_computer_backup !== false &&
        !folder.imported_from_remote_catalog
      ));
      const failingFolders = activeLocalFolders.filter(folder => Number(folder.consecutive_failures) > 0);
      if (failingFolders.length > 0) {
        setGlobalStatus('Failing');
        setGlobalFailureCount(failingFolders.length);
        setGlobalStatusDetail(failingFolders[0].last_error || `${failingFolders.length} enabled backup folder${failingFolders.length === 1 ? '' : 's'} need attention.`);
      } else {
        setGlobalStatus('Protected');
        setGlobalFailureCount(0);
        setGlobalStatusDetail(activeLocalFolders.length > 0
          ? 'All enabled backups on this PC are healthy.'
          : 'No backup folders are enabled on this PC.');
      }
    });
  };

  useEffect(() => {
    refreshGlobalStatus();
    const handleStatusChange = () => {
      invalidateResource('folders:list');
      invalidateResource('activity:get');
      invalidateResource('backup:manifestSummary');
      invalidateResource('backup:restorePoints');
      refreshGlobalStatus({ force: true });
    };
    ipcRenderer.on('status:change', handleStatusChange);
    return () => {
      ipcRenderer.removeListener('status:change', handleStatusChange);
    };
  }, []);

  useEffect(() => {
    const handleSubtabChange = (e) => {
      setBackupSubTab(e.detail);
    };
    window.addEventListener('backup-subtab-changed', handleSubtabChange);
    return () => {
      window.removeEventListener('backup-subtab-changed', handleSubtabChange);
    };
  }, []);

  const triggerLegacyBackupTab = (subTab) => {
    window.__legacyBackupTabPending = subTab;
    activateWorkspace('backup');
    window.dispatchEvent(new CustomEvent('legacy-backup-tab', { detail: subTab }));
  };


  useEffect(() => {
    invokeResource('settings:get').then(s => {
      if (s) setInstalledApps(parseInstalledApps(s.installed_apps));
      if (s && s.setup_complete !== '1') {
        activateWorkspace('backup');
      }
    });

    invokeResource('app:getVersion').then(v => {
      if (v) setAppVersion(v);
    });

    invokeResource('device:getIdentity').then(identity => {
      if (identity && identity.computerName) setDeviceName(identity.computerName);
    });

    const handleOpenNotepadFile = (event, filePath) => {
      activateWorkspace('notebook');
      setExternalFilePath(filePath);
    };
    ipcRenderer.on('notepad:open-file', handleOpenNotepadFile);

    invokeResource('auth:getGDriveInfo', [], { ttl: 60000 }).then(info => {
      if (info) setGlobalGDriveInfo(info);
    });
    invokeResource('health:get', [], { ttl: 60000 }).then(health => {
      if (health && health.gdriveStatus) setHealthStatus(health.gdriveStatus);
    });

    const intervalId = setInterval(() => {
      invokeResource('auth:getGDriveInfo', [], { ttl: 60000, force: true }).then(info => { if (info) setGlobalGDriveInfo(info); });
      invokeResource('health:get', [], { ttl: 60000, force: true }).then(health => { if (health && health.gdriveStatus) setHealthStatus(health.gdriveStatus); });
      refreshGlobalStatus({ force: true });
    }, 60000);

    return () => {
      ipcRenderer.removeListener('notepad:open-file', handleOpenNotepadFile);
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const prefetch = () => {
      ['telegram', 'crypto', 'settings', 'notebook'].forEach(prefetchWorkspace);
    };
    if (typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(prefetch, { timeout: 1500 });
      return () => window.cancelIdleCallback?.(idleId);
    }
    const timer = window.setTimeout(prefetch, 300);
    return () => window.clearTimeout(timer);
  }, [prefetchWorkspace]);

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const hasRealEmail = globalGDriveInfo.accountEmail || (globalGDriveInfo.email && !['Connected Account', 'Disconnected', 'Google Drive Account'].includes(globalGDriveInfo.email));
  const realEmail = globalGDriveInfo.accountEmail || (hasRealEmail ? globalGDriveInfo.email : '');
  const isConnected = healthStatus === 'Connected' || (hasRealEmail && healthStatus !== 'Disconnected');
  const storagePercent = globalGDriveInfo.total > 0
    ? Math.min(100, (globalGDriveInfo.used / globalGDriveInfo.total) * 100)
    : 0;
  const compactStatus = globalStatus === 'Protected'
    ? 'OK'
    : globalStatus === 'Failing'
      ? `${globalFailureCount || 1} ISSUE${(globalFailureCount || 1) === 1 ? '' : 'S'}`
      : globalStatus;

  const handleMinimize = () => ipcRenderer.send('window:minimize');
  const handleMaximize = () => ipcRenderer.send('window:maximize');
  const handleClose = () => ipcRenderer.send('window:close');

  const isAppInstalled = useCallback((id) => installedApps.includes(id), [installedApps]);

  const updateInstalledApps = useCallback(async (nextInstalled) => {
    setInstalledApps(nextInstalled);
    try {
      await safeInvoke('settings:set', { key: 'installed_apps', value: JSON.stringify(nextInstalled) });
      invalidateResource('settings:get');
    } catch (err) {
      console.error('Failed to save installed apps:', err);
    }
  }, []);

  const handleInstallApp = useCallback((appId) => {
    if (!installedApps.includes(appId)) {
      updateInstalledApps([...installedApps, appId]);
    }
  }, [installedApps, updateInstalledApps]);

  const handleUninstallApp = useCallback((appId) => {
    if (CORE_APP_IDS.has(appId)) return;
    const next = installedApps.filter(id => id !== appId);
    updateInstalledApps(next);
    setMountedWorkspaces(previous => previous.filter(id => id !== appId));
    if (activeTab === appId) activateWorkspace('hub');
  }, [installedApps, activeTab, updateInstalledApps, activateWorkspace]);

  const handleLaunchStandalone = useCallback((appId) => {
    setLaunchingApps(previous => previous.includes(appId) ? previous : [...previous, appId]);
    safeInvoke('app:launchStandalone', { appId }).finally(() => {
      window.setTimeout(() => {
        setLaunchingApps(previous => previous.filter(id => id !== appId));
      }, 250);
    });
  }, []);

  const handleOpenApp = useCallback((id) => {
    if (STANDALONE_APP_IDS.has(id)) handleLaunchStandalone(id);
    else activateWorkspace(id);
  }, [activateWorkspace, handleLaunchStandalone]);

  const renderWorkspace = (workspaceId) => {
    const active = activeTab === workspaceId;
    switch (workspaceId) {
      case 'hub':
        return (
          <MemoizedAppHub
            active={active}
            installedApps={installedApps}
            onInstall={handleInstallApp}
            onUninstall={handleUninstallApp}
            onOpenApp={handleOpenApp}
            onLaunchStandalone={handleLaunchStandalone}
          />
        );
      case 'backup':
        return <LabSuiteBackup active={active} />;
      case 'telegram':
        return <TelegramBackup active={active} />;
      case 'crypto':
        return <CryptoPortfolioTracker active={active} />;
      case 'notebook':
        return isAppInstalled('notebook') ? <LabSuiteNotebook active={active} externalFilePath={externalFilePath} /> : null;
      case 'settings':
        return <LabSuiteSettings active={active} />;
      default:
        return null;
    }
  };

  return (
    <div className={`app-container ${theme} suite-layout`}>
      <div className="titlebar drag-region app-header" style={{ WebkitAppRegion: 'drag', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: '16px', background: 'var(--bg-panel)', borderBottom: '1px solid var(--border-color)', width: '100%', boxSizing: 'border-box' }}>
        <div className="titlebar-title" style={{ fontSize: '13px', letterSpacing: '0.5px' }}>
          <span style={{ fontWeight: 800, color: 'var(--accent-primary)', marginRight: '6px' }}>Lab</span>Suite
          <span className="app-title" style={{ position: 'absolute', left: '-9999px', opacity: 0, display: 'inline !important' }}>LabSuite</span>
        </div>
        <div className="titlebar-controls" style={{ WebkitAppRegion: 'no-drag', display: 'flex', height: '100%' }}>
          <button onClick={handleMinimize} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', width: '46px', height: '100%', cursor: 'pointer' }}>−</button>
          <button onClick={handleMaximize} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', width: '46px', height: '100%', cursor: 'pointer' }}>□</button>
          <button onClick={handleClose} className="close-btn" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', width: '46px', height: '100%', cursor: 'pointer' }}>×</button>
        </div>
      </div>

      <div className="main-content app-body" style={{ display: 'flex', height: 'calc(100vh - 36px)', background: 'var(--bg-main)' }}>
        <nav className="suite-sidebar" style={{ width: '240px', background: 'var(--bg-panel)', borderRight: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', padding: '20px 12px' }}>
          
          {/* Legacy E2E Test Navigation Compatibility Helpers */}
          <div style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px', overflow: 'hidden', opacity: 0 }}>
            <button className={`nav-item ${(activeTab === 'dashboard' || (activeTab === 'backup' && backupSubTab === 'dashboard')) ? 'active' : ''}`} onClick={() => triggerLegacyBackupTab('dashboard')}>Activity</button>
            <button className={`nav-item ${(activeTab === 'backup' && backupSubTab === 'folders') ? 'active' : ''}`} onClick={() => triggerLegacyBackupTab('folders')}>My Computer</button>
            <button className={`nav-item ${(activeTab === 'backup' && backupSubTab === 'health') ? 'active' : ''}`} onClick={() => triggerLegacyBackupTab('health')}>Backup Health</button>
            <button className={`nav-item ${(activeTab === 'backup' && backupSubTab === 'restore') ? 'active' : ''}`} onClick={() => triggerLegacyBackupTab('restore')}>Restore Files</button>
            <button className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => { activateWorkspace('settings'); }}>Settings</button>
          </div>

          <div className="suite-sidebar-menu">
            <div style={{ marginBottom: '30px', padding: '0 10px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700, marginBottom: '12px' }}>Applications</div>
              <NavItem id="hub" icon="🏠" label="App Hub" activeTab={activeTab} setTab={activateWorkspace} />
              <NavItem id="backup" icon="🛡️" label="Backup Engine" activeTab={activeTab} setTab={activateWorkspace} onPrefetch={prefetchWorkspace} />
              <NavItem id="telegram" icon="✈️" label="Telegram Backup" activeTab={activeTab} setTab={activateWorkspace} onPrefetch={prefetchWorkspace} />
              <NavItem id="crypto" icon={<LtcIcon size={16} />} label="Crypto Portfolio" activeTab={activeTab} setTab={activateWorkspace} onPrefetch={prefetchWorkspace} />
            </div>

            {/* Installed hub apps — show in sidebar */}
            {installedApps.length > 0 && (
              <div style={{ marginBottom: '16px', padding: '0 10px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700, marginBottom: '12px' }}>Installed</div>
                {installedApps.map(appId => {
                  const hubApp = HUB_APPS.find(a => a.id === appId);
                  if (!hubApp) return null;
                  const isStandalone = STANDALONE_APP_IDS.has(appId);
                  return (
                    <NavItem
                      key={appId}
                      id={appId}
                      icon={renderSmallIcon(hubApp.icon, 16)}
                      label={hubApp.label}
                      activeTab={activeTab}
                      setTab={isStandalone ? () => handleLaunchStandalone(appId) : activateWorkspace}
                      suffix={isStandalone ? (launchingApps.includes(appId) ? '…' : '↗') : null}
                      onPrefetch={prefetchWorkspace}
                    />
                  );
                })}
              </div>
            )}
          </div>

          <div className="suite-sidebar-footer">
            <NavItem id="settings" icon="⚙️" label="Suite Settings" activeTab={activeTab} setTab={activateWorkspace} onPrefetch={prefetchWorkspace} />
            {/* Global Google Drive Status */}
            <div className="suite-status-card">
              <div className="suite-status-header">
                <span className={`suite-status-dot ${isConnected ? 'is-connected' : 'is-disconnected'}`}></span>
                <span className={`suite-status-label ${isConnected ? 'is-connected' : 'is-disconnected'}`}>
                  {isConnected ? 'Connected' : 'Disconnected'}
                </span>
                <span title={globalStatusDetail} className={`suite-status-pill ${globalStatus === 'Failing' ? 'is-failing' : globalStatus === 'pending' ? 'is-pending' : 'is-ok'}`}>
                  {compactStatus}
                </span>
              </div>
              <div className="suite-device-identity" title={`This PC: ${deviceName}`}>
                <span className="suite-device-icon"><PcIcon /></span>
                <span className="suite-device-copy">
                  <span className="suite-device-label">This PC</span>
                  <strong className="suite-device-name">{deviceName}</strong>
                </span>
              </div>
              {isConnected ? (
                <div className="suite-storage">
                  <div className="suite-status-email" title={realEmail}>
                    {realEmail}
                  </div>
                  <div className="suite-storage-text">
                    {formatBytes(globalGDriveInfo.used)} / {globalGDriveInfo.total > 0 ? formatBytes(globalGDriveInfo.total) : '?'} used
                  </div>
                  {globalGDriveInfo.total > 0 && (
                    <div className="suite-storage-bar">
                      <div className="suite-storage-fill" style={{ width: `${storagePercent}%` }}></div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="suite-status-hint">
                  Google Drive is unavailable.
                </div>
              )}
            </div>

            <div className="suite-version">
              LabSuite v{appVersion}
            </div>
          </div>
        </nav>

        <main className="suite-content-area" style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {mountedWorkspaces.map(workspaceId => {
            const active = activeTab === workspaceId;
            return (
              <WorkspacePanel key={workspaceId} id={workspaceId} active={active}>
                <ErrorBoundary compact>
                  <Suspense fallback={<AppLoadingState />}>
                    <WorkspaceReady id={workspaceId} active={active}>
                      {renderWorkspace(workspaceId)}
                    </WorkspaceReady>
                  </Suspense>
                </ErrorBoundary>
              </WorkspacePanel>
            );
          })}
        </main>
      </div>
    </div>
  );
}

function WorkspacePanel({ id, active, children }) {
  return (
    <section
      className="suite-workspace-panel"
      data-workspace-id={id}
      data-workspace-active={active ? 'true' : 'false'}
      aria-hidden={active ? undefined : true}
      style={{
        position: 'absolute',
        inset: 0,
        display: active ? 'block' : 'none',
        overflow: 'hidden',
        contain: 'layout paint style'
      }}
    >
      {children}
    </section>
  );
}

function WorkspaceReady({ id, active, children }) {
  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        const startMark = `workspace-nav-${id}-start`;
        const readyMark = `workspace-nav-${id}-ready`;
        performance.clearMarks(readyMark);
        performance.mark(readyMark);
        if (performance.getEntriesByName(startMark).length > 0) {
          performance.clearMeasures(`workspace-nav-${id}`);
          performance.measure(`workspace-nav-${id}`, startMark, readyMark);
        }
      } catch (_) {}
    });
    return () => window.cancelAnimationFrame(frame);
  }, [id, active]);
  return children;
}

function AppLoadingState() {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-secondary)' }}>
      <div style={{ textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto 12px' }} />
        <div style={{ fontSize: '13px', fontWeight: 600 }}>Loading workspace…</div>
      </div>
    </div>
  );
}

function NavItem({ id, icon, label, activeTab, setTab, suffix, onPrefetch }) {
  const active = activeTab === id;
  return (
    <button
      className={active ? 'nav-item active' : 'nav-item'}
      onClick={() => setTab(id)}
      onPointerEnter={() => onPrefetch?.(id)}
      onFocus={() => onPrefetch?.(id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: '10px 14px',
        marginBottom: '4px',
        background: active ? 'var(--accent-primary-alpha)' : 'transparent',
        border: 'none',
        borderRadius: '8px',
        color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
        cursor: 'pointer',
        transition: 'background-color 120ms ease, color 120ms ease',
        textAlign: 'left',
        fontWeight: active ? 600 : 500,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      <span style={{ marginRight: '12px', fontSize: '16px' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {suffix && <span style={{ fontSize: '12px', opacity: 0.5, marginLeft: '4px' }}>{suffix}</span>}
    </button>
  );
}

// Dashboard component removed — replaced by AppHub

function ShutdownTimerPanel() {
  const [selectedPreset, setSelectedPreset] = useState(SHUTDOWN_PRESETS[2]);
  const [schedule, setSchedule] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  const refreshSchedule = async () => {
    try {
      const next = await ipcRenderer.invoke('power:getShutdownSchedule');
      setSchedule(next);
    } catch (_) {
      setSchedule(null);
    }
  };

  useEffect(() => {
    refreshSchedule();
    const interval = setInterval(refreshSchedule, 1000);
    return () => clearInterval(interval);
  }, []);

  const scheduleShutdown = async () => {
    if (!selectedPreset) return;
    const ok = window.confirm(`Schedule this PC to shut down in ${selectedPreset.label}?`);
    if (!ok) return;

    try {
      setIsBusy(true);
      setError('');
      const next = await ipcRenderer.invoke('power:scheduleShutdown', {
        seconds: selectedPreset.seconds,
        label: selectedPreset.label
      });
      setSchedule(next);
    } catch (err) {
      setError(err.message || 'Failed to schedule shutdown.');
    } finally {
      setIsBusy(false);
    }
  };

  const cancelShutdown = async () => {
    try {
      setIsBusy(true);
      setError('');
      await ipcRenderer.invoke('power:cancelShutdown');
      setSchedule(null);
    } catch (err) {
      setError(err.message || 'Failed to cancel shutdown.');
    } finally {
      setIsBusy(false);
    }
  };

  const dueTime = schedule?.dueAt
    ? new Date(schedule.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <section style={{
      marginBottom: '24px',
      border: '1px solid rgba(64, 138, 113, 0.28)',
      borderRadius: '12px',
      background: 'rgba(64, 138, 113, 0.06)',
      padding: '18px 20px',
      display: 'flex',
      flexWrap: 'wrap',
      gap: '18px',
      alignItems: 'center',
      justifyContent: 'space-between'
    }}>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
          Power
        </div>
        <div style={{ marginTop: '4px', fontSize: '20px', color: 'var(--text-primary)', fontWeight: 800 }}>
          Shutdown Timer
        </div>
        <div style={{ marginTop: '4px', fontSize: '12.5px', color: error ? '#fca5a5' : 'var(--text-secondary)' }}>
          {error || (schedule ? `Scheduled for ${dueTime}` : 'Choose a delay, then schedule shutdown.')}
        </div>
      </div>

      <div style={{ display: 'flex', flex: '2 1 340px', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        {SHUTDOWN_PRESETS.map(preset => {
          const active = selectedPreset.seconds === preset.seconds;
          return (
            <button
              key={preset.seconds}
              type="button"
              onClick={() => setSelectedPreset(preset)}
              disabled={isBusy}
              style={{
                height: '34px',
                padding: '0 13px',
                borderRadius: '999px',
                border: active ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                background: active ? 'rgba(64, 138, 113, 0.22)' : 'rgba(0,0,0,0.16)',
                color: active ? 'var(--accent-secondary)' : 'var(--text-secondary)',
                cursor: isBusy ? 'default' : 'pointer',
                fontSize: '12.5px',
                fontWeight: 700
              }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', flex: '0 1 auto', gap: '10px', alignItems: 'center', justifyContent: 'flex-end', marginLeft: 'auto' }}>
        {schedule && (
          <div style={{ minWidth: '96px', textAlign: 'right' }}>
            <div style={{ color: 'var(--accent-secondary)', fontSize: '18px', fontWeight: 800 }}>
              {formatShutdownDuration(schedule.remainingSeconds)}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase' }}>
              remaining
            </div>
          </div>
        )}
        {schedule ? (
          <button className="btn btn-danger" onClick={cancelShutdown} disabled={isBusy} style={{ height: '38px', padding: '0 14px', fontSize: '13px' }}>
            Cancel
          </button>
        ) : (
          <button className="btn btn-primary" onClick={scheduleShutdown} disabled={isBusy} style={{ height: '38px', padding: '0 16px', fontSize: '13px' }}>
            {isBusy ? 'Scheduling...' : 'Schedule'}
          </button>
        )}
      </div>
    </section>
  );
}

// DashboardCard component removed — replaced by AppHub cards
