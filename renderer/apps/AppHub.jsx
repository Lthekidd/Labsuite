import React, { useState, useEffect } from 'react';
import { ArrowRight } from '@phosphor-icons/react/ArrowRight';
import { ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { DownloadSimple } from '@phosphor-icons/react/DownloadSimple';
import { Trash } from '@phosphor-icons/react/Trash';
import AppIcon from '../AppIcon';
import BrandMark from '../BrandMark';

const ipcRenderer = window.electron?.ipcRenderer;

// ── App Registry ────────────────────────────────────────────────────────────
// Core apps are always available and cannot be uninstalled.
// Hub apps can be installed/uninstalled from the App Hub.

const CORE_APPS = [
  { id: 'backup', icon: 'backup', label: 'Backup Engine', description: 'Manage your encrypted cloud backups, configure local folders, and monitor real-time sync activity.', color: '#3b82f6', category: 'Backup' },
  { id: 'telegram', icon: 'telegram', label: 'Telegram Backup', description: 'Automatically back up your Telegram Desktop data including all messages, images, and videos.', color: '#0088cc', category: 'Backup' },
  { id: 'crypto', icon: 'crypto', label: 'Crypto Portfolio', description: 'Track your holdings and transactions with live market rates and custom SVG charts.', color: '#408A71', category: 'Productivity' },
];

const HUB_APPS = [
  { id: 'labshot', icon: 'labshot', label: 'LabShot', description: 'Capture, annotate, pin, and encrypt screenshots with live Flameshot tools and privacy blur.', color: '#8b5cf6', category: 'Productivity', mode: 'dual' },
  { id: 'notebook', icon: 'notebook', label: 'Secure Notebook', description: 'Maintain a private, distraction-free markdown knowledge base. Also opens as a standalone editor for .txt files.', color: '#f59e0b', category: 'Productivity', mode: 'dual' },
  { id: 'sheets', icon: 'sheets', label: 'Encrypted Tables', description: 'Keep structured rows and columns in your encrypted cloud workspace.', color: '#8b5cf6', category: 'Productivity', mode: 'standalone' },
  { id: 'lan', icon: 'lan', label: 'Network Drive', description: 'Discover computers on your local network and securely mount shared folders as native Windows drives.', color: '#10b981', category: 'Networking', mode: 'standalone' },
  { id: 'vm-protect', icon: 'vm-protect', label: 'VM Protect', description: 'Protect selected files inside VMware guests without backing up their entire virtual disks.', color: '#2dd4bf', category: 'Security', mode: 'standalone' },
  { id: 'todo', icon: 'todo', label: 'Task Board', description: 'Organize your life with an encrypted Kanban board using native drag-and-drop mechanics.', color: '#ec4899', category: 'Productivity', mode: 'standalone' },
];

function renderIcon(icon, size = 32) {
  return <AppIcon appId={icon} size={size} weight="duotone" />;
}

function renderSmallIcon(icon, size = 16) {
  return <AppIcon appId={icon} size={size} weight="regular" />;
}

const SHUTDOWN_PRESETS = [
  { label: '10 min', seconds: 10 * 60 },
  { label: '30 min', seconds: 30 * 60 },
  { label: '1 hr', seconds: 60 * 60 },
  { label: '3 hrs', seconds: 3 * 60 * 60 },
  { label: '5 hrs', seconds: 5 * 60 * 60 },
  { label: '8 hrs', seconds: 8 * 60 * 60 }
];

function formatShutdownDuration(totalSeconds = 0) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

function ShutdownTimerPanel({ active = true }) {
  const [selectedPreset, setSelectedPreset] = useState(SHUTDOWN_PRESETS[0]);
  const [schedule, setSchedule] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  const refreshSchedule = async () => {
    try {
      const next = await ipcRenderer?.invoke('power:getShutdownSchedule');
      setSchedule(next || null);
    } catch (_) {
      setSchedule(null);
    }
  };

  useEffect(() => {
    if (!active) return undefined;
    refreshSchedule();
    const interval = setInterval(refreshSchedule, 1000);
    return () => clearInterval(interval);
  }, [active]);

  const scheduleShutdown = async () => {
    if (!selectedPreset) return;
    const ok = window.confirm(`Schedule this PC to shut down in ${selectedPreset.label}?`);
    if (!ok) return;

    try {
      setIsBusy(true);
      setError('');
      const next = await ipcRenderer?.invoke('power:scheduleShutdown', {
        seconds: selectedPreset.seconds,
        label: selectedPreset.label
      });
      setSchedule(next || null);
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
      await ipcRenderer?.invoke('power:cancelShutdown');
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
      marginBottom: '32px',
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
        <div style={{ fontSize: '12px', color: '#408A71', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
          Power Management
        </div>
        <div style={{ marginTop: '4px', fontSize: '18px', color: 'var(--text-primary)', fontWeight: 800 }}>
          PC Shutdown / Restart Timer
        </div>
        <div style={{ marginTop: '4px', fontSize: '12.5px', color: error ? '#fca5a5' : 'var(--text-secondary)' }}>
          {error || (schedule ? `Scheduled for ${dueTime}` : 'Choose a duration to schedule an automatic PC shutdown/restart.')}
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
                border: active ? '1px solid #408A71' : '1px solid rgba(255, 255, 255, 0.1)',
                background: active ? 'rgba(64, 138, 113, 0.25)' : 'rgba(0, 0, 0, 0.2)',
                color: active ? '#B0E4CC' : 'var(--text-secondary)',
                cursor: isBusy ? 'default' : 'pointer',
                fontSize: '12.5px',
                fontWeight: 700,
                transition: 'all 0.15s ease'
              }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', flex: '0 1 auto', gap: '12px', alignItems: 'center', justifyContent: 'flex-end', marginLeft: 'auto' }}>
        {schedule && (
          <div style={{ minWidth: '96px', textAlign: 'right' }}>
            <div style={{ color: '#B0E4CC', fontSize: '18px', fontWeight: 800 }}>
              {formatShutdownDuration(schedule.remainingSeconds)}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase' }}>
              remaining
            </div>
          </div>
        )}
        {schedule ? (
          <button
            className="btn"
            onClick={cancelShutdown}
            disabled={isBusy}
            style={{
              height: '38px',
              padding: '0 16px',
              fontSize: '13px',
              fontWeight: 700,
              background: '#ef4444',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            className="btn"
            onClick={scheduleShutdown}
            disabled={isBusy}
            style={{
              height: '38px',
              padding: '0 18px',
              fontSize: '13px',
              fontWeight: 700,
              background: 'linear-gradient(90deg, #408A71, #2d6351)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            {isBusy ? 'Scheduling...' : 'Schedule'}
          </button>
        )}
      </div>
    </section>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function AppHub({ active = true, installedApps, onInstall, onUninstall, onOpenApp, onLaunchStandalone }) {
  const installedSet = new Set(installedApps || []);

  const installedHubApps = HUB_APPS.filter(a => installedSet.has(a.id));
  const availableHubApps = HUB_APPS.filter(a => !installedSet.has(a.id));

  return (
    <div className="apphub-container" style={{ padding: '40px', height: '100%', overflowY: 'auto' }}>
      {/* Header */}
      <div className="apphub-brand-header">
        <BrandMark size={58} className="apphub-brand-mark" />
        <div>
          <h1 style={{ fontSize: '32px', marginBottom: '8px', background: 'linear-gradient(90deg, #B0E4CC, #408A71)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Welcome to LabSuite
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '16px', margin: 0 }}>Your unified encrypted workspace and backup solution.</p>
        </div>
      </div>

      {/* PC Shutdown / Restart Timer Panel */}
      <ShutdownTimerPanel active={active} />

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
                <><ArrowSquareOut className="apphub-btn-icon" size={15} weight="bold" /> Launch</>
              ) : (
                <><ArrowRight className="apphub-btn-icon" size={15} weight="bold" /> Open</>
              )}
            </button>
            {!isCore && (
              <button
                className="apphub-btn apphub-btn-uninstall"
                onClick={onUninstall}
                title="Uninstall"
              >
                <Trash size={15} weight="bold" />
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
              <><DownloadSimple className="apphub-btn-icon" size={15} weight="bold" /> Install</>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
