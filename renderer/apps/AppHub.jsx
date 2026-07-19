import React, { useState, useEffect } from 'react';

const ipcRenderer = window.electron?.ipcRenderer;

// ── App Registry ────────────────────────────────────────────────────────────
// Core apps are always available and cannot be uninstalled.
// Hub apps can be installed/uninstalled from the App Hub.

const CORE_APPS = [
  { id: 'backup', icon: '🛡️', label: 'Backup Engine', description: 'Manage your encrypted cloud backups, configure local folders, and monitor real-time sync activity.', color: '#3b82f6', category: 'Backup' },
  { id: 'telegram', icon: '✈️', label: 'Telegram Backup', description: 'Automatically back up your Telegram Desktop data including all messages, images, and videos.', color: '#0088cc', category: 'Backup' },
  { id: 'crypto', icon: 'crypto', label: 'Crypto Portfolio', description: 'Track your holdings and transactions with live market rates and custom SVG charts.', color: '#408A71', category: 'Productivity' },
];

const HUB_APPS = [
  { id: 'notebook', icon: '📓', label: 'Secure Notebook', description: 'Maintain a private, distraction-free markdown knowledge base. Also opens as a standalone editor for .txt files.', color: '#f59e0b', category: 'Productivity', mode: 'dual' },
  { id: 'sheets', icon: '📊', label: 'Encrypted Tables', description: 'Keep structured rows and columns in your encrypted cloud workspace.', color: '#8b5cf6', category: 'Productivity', mode: 'standalone' },
  { id: 'lan', icon: '📡', label: 'Network Drive', description: 'Discover computers on your local network and securely mount shared folders as native Windows drives.', color: '#10b981', category: 'Networking', mode: 'standalone' },
  { id: 'vm-protect', icon: 'vm', label: 'VM Protect', description: 'Protect selected files inside VMware guests without backing up their entire virtual disks.', color: '#2dd4bf', category: 'Security', mode: 'standalone' },
  { id: 'todo', icon: '📋', label: 'Task Board', description: 'Organize your life with an encrypted Kanban board using native drag-and-drop mechanics.', color: '#ec4899', category: 'Productivity', mode: 'standalone' },
];

function LtcIconSmall({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'inline-block', verticalAlign: 'middle', overflow: 'visible' }}>
      <circle cx="12" cy="12" r="12" fill="#345d9d" />
      <path d="M10.11 5.548h2.242v8.031h3.535v1.932h-5.777V5.548z" fill="white" />
      <polygon points="8.473,13.682 16.504,9.436 17.356,11.05 9.325,15.296" fill="white" />
    </svg>
  );
}

function LtcIconLarge({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'inline-block', verticalAlign: 'middle', overflow: 'visible' }}>
      <circle cx="12" cy="12" r="12" fill="#345d9d" />
      <path d="M10.11 5.548h2.242v8.031h3.535v1.932h-5.777V5.548z" fill="white" />
      <polygon points="8.473,13.682 16.504,9.436 17.356,11.05 9.325,15.296" fill="white" />
    </svg>
  );
}

function VmIconHub({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
      <rect x="3" y="4" width="18" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 21h8M12 17v4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m10 8 5 2.5-5 2.5V8Z" fill="currentColor" />
    </svg>
  );
}

function renderIcon(icon, size = 32) {
  if (icon === 'crypto') return <LtcIconLarge size={size} />;
  if (icon === 'vm') return <VmIconHub size={size} />;
  return <span style={{ fontSize: `${size}px`, lineHeight: 1 }}>{icon}</span>;
}

function renderSmallIcon(icon, size = 16) {
  if (icon === 'crypto') return <LtcIconSmall size={size} />;
  if (icon === 'vm') return <VmIconHub size={size} />;
  return <span style={{ fontSize: `${size}px`, lineHeight: 1 }}>{icon}</span>;
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function AppHub({ installedApps, onInstall, onUninstall, onOpenApp, onLaunchStandalone }) {
  const installedSet = new Set(installedApps || []);

  const installedHubApps = HUB_APPS.filter(a => installedSet.has(a.id));
  const availableHubApps = HUB_APPS.filter(a => !installedSet.has(a.id));

  return (
    <div className="apphub-container" style={{ padding: '40px', height: '100%', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ marginBottom: '36px' }}>
        <h1 style={{ fontSize: '32px', marginBottom: '8px', background: 'linear-gradient(90deg, #B0E4CC, #408A71)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Welcome to LabSuite
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '16px', margin: 0 }}>Your unified encrypted workspace and backup solution.</p>
      </div>

      {/* Core Apps — always visible */}
      <div style={{ marginBottom: '36px' }}>
        <div className="apphub-section-header">
          <span className="apphub-section-dot" style={{ background: '#408A71' }}></span>
          <span className="apphub-section-title">Core</span>
          <span className="apphub-section-badge">{CORE_APPS.length}</span>
        </div>
        <div className="apphub-grid">
          {CORE_APPS.map(app => (
            <AppCard
              key={app.id}
              app={app}
              installed={true}
              isCore={true}
              onOpen={() => onOpenApp(app.id)}
            />
          ))}
        </div>
      </div>

      {/* Installed Hub Apps */}
      {installedHubApps.length > 0 && (
        <div style={{ marginBottom: '36px' }}>
          <div className="apphub-section-header">
            <span className="apphub-section-dot" style={{ background: '#3b82f6' }}></span>
            <span className="apphub-section-title">Installed</span>
            <span className="apphub-section-badge">{installedHubApps.length}</span>
          </div>
          <div className="apphub-grid">
            {installedHubApps.map(app => (
              <AppCard
                key={app.id}
                app={app}
                installed={true}
                isCore={false}
                onOpen={() => app.mode === 'standalone' ? onLaunchStandalone(app.id) : onOpenApp(app.id)}
                onUninstall={() => onUninstall(app.id)}
                isStandalone={app.mode === 'standalone'}
              />
            ))}
          </div>
        </div>
      )}

      {/* Available Apps (not yet installed) */}
      {availableHubApps.length > 0 && (
        <div style={{ marginBottom: '36px' }}>
          <div className="apphub-section-header">
            <span className="apphub-section-dot" style={{ background: 'var(--text-muted)' }}></span>
            <span className="apphub-section-title">Available</span>
            <span className="apphub-section-badge">{availableHubApps.length}</span>
          </div>
          <div className="apphub-grid">
            {availableHubApps.map(app => (
              <AppCard
                key={app.id}
                app={app}
                installed={false}
                isCore={false}
                onInstall={() => onInstall(app.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Re-export for sidebar use
export { HUB_APPS, CORE_APPS, renderSmallIcon };

// ── App Card ────────────────────────────────────────────────────────────────

function AppCard({ app, installed, isCore, onOpen, onInstall, onUninstall, isStandalone }) {
  const [isInstalling, setIsInstalling] = useState(false);
  const [justInstalled, setJustInstalled] = useState(false);

  const handleInstall = async () => {
    setIsInstalling(true);
    try {
      await onInstall?.();
      setJustInstalled(true);
      setTimeout(() => setJustInstalled(false), 1200);
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <div
      className={`apphub-card${installed ? ' is-installed' : ''}${justInstalled ? ' just-installed' : ''}`}
      style={{ '--card-accent': app.color }}
    >
      <div className="apphub-card-header">
        <div className="apphub-card-icon">
          {renderIcon(app.icon, 32)}
        </div>
        <div className="apphub-card-meta">
          {app.mode === 'standalone' && <span className="apphub-card-badge standalone">Standalone</span>}
          {app.mode === 'dual' && <span className="apphub-card-badge dual">Dual Mode</span>}
          {isCore && <span className="apphub-card-badge core">Core</span>}
        </div>
      </div>

      <h3 className="apphub-card-title">{app.label}</h3>
      <p className="apphub-card-description">{app.description}</p>

      <div className="apphub-card-actions">
        {installed ? (
          <>
            <button
              className="apphub-btn apphub-btn-open"
              onClick={onOpen}
            >
              {isStandalone ? (
                <><span className="apphub-btn-icon">↗</span> Launch</>
              ) : (
                <><span className="apphub-btn-icon">→</span> Open</>
              )}
            </button>
            {!isCore && (
              <button
                className="apphub-btn apphub-btn-uninstall"
                onClick={onUninstall}
                title="Uninstall"
              >
                ×
              </button>
            )}
          </>
        ) : (
          <button
            className={`apphub-btn apphub-btn-install${isInstalling ? ' is-installing' : ''}`}
            onClick={handleInstall}
            disabled={isInstalling}
          >
            {isInstalling ? (
              <><span className="apphub-install-spinner"></span> Installing...</>
            ) : (
              <><span className="apphub-btn-icon">↓</span> Install</>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
