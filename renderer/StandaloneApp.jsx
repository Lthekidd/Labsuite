import React, { lazy, Suspense } from 'react';
import { Minus } from '@phosphor-icons/react/Minus';
import { Square } from '@phosphor-icons/react/Square';
import { X } from '@phosphor-icons/react/X';
import ErrorBoundary from './ErrorBoundary';
import AppIcon from './AppIcon';

// ── Lazy-load app components ────────────────────────────────────────────────
const LabSuiteSheets = lazy(() => import('./apps/LabSuiteSheets'));
const LabSuiteNotebook = lazy(() => import('./apps/LabSuiteNotebook'));
const LabSuiteTodo = lazy(() => import('./apps/LabSuiteTodo'));
const LanPeerDrive = lazy(() => import('./apps/LanPeerDrive'));
const VMProtect = lazy(() => import('./apps/VMProtect'));
const LabShot = lazy(() => import('./apps/LabShot'));
const LabShotOverlay = lazy(() => import('./apps/LabShotOverlay'));
const LabShotPin = lazy(() => import('./apps/LabShotPin'));

const ipcRenderer = window.electron?.ipcRenderer;

// ── App metadata for titlebars ──────────────────────────────────────────────
const APP_META = {
  sheets:       { title: 'Encrypted Tables', icon: 'sheets', color: '#8b5cf6' },
  notebook:     { title: 'Secure Notebook', icon: 'notebook', color: '#f59e0b' },
  todo:         { title: 'Task Board', icon: 'todo', color: '#ec4899' },
  lan:          { title: 'Network Drive', icon: 'lan', color: '#10b981' },
  'vm-protect': { title: 'VM Protect', icon: 'vm-protect', color: '#2dd4bf' },
  labshot:      { title: 'LabShot', icon: 'labshot', color: '#a78bfa' }
};

// ── Standalone App Shell ────────────────────────────────────────────────────
// This is the root component for standalone app windows.
// It renders a minimal titlebar + the app component, with no sidebar.

export default function StandaloneApp({ appId, filePath }) {
  if (appId === 'labshot-overlay') {
    return (
      <ErrorBoundary compact>
        <Suspense fallback={null}>
          <LabShotOverlay />
        </Suspense>
      </ErrorBoundary>
    );
  }

  if (appId === 'labshot-pin') {
    return (
      <ErrorBoundary compact>
        <Suspense fallback={null}>
          <LabShotPin />
        </Suspense>
      </ErrorBoundary>
    );
  }

  const meta = APP_META[appId] || { title: appId, icon: 'package', color: '#408A71' };

  const handleMinimize = () => ipcRenderer?.send('window:minimize');
  const handleMaximize = () => ipcRenderer?.send('window:maximize');
  const handleClose = () => ipcRenderer?.send('window:close');

  const renderApp = () => {
    switch (appId) {
      case 'sheets':
        return <LabSuiteSheets />;
      case 'notebook':
        return <LabSuiteNotebook externalFilePath={filePath || null} />;
      case 'todo':
        return <LabSuiteTodo />;
      case 'lan':
        return <LanPeerDrive />;
      case 'vm-protect':
        return <VMProtect />;
      case 'labshot':
        return <LabShot />;
      default:
        return (
          <div style={{ padding: '40px', color: 'var(--text-secondary)', textAlign: 'center' }}>
            <div style={{ marginBottom: '16px', color: '#408A71' }}><AppIcon appId="package" size={48} weight="duotone" /></div>
            <h2 style={{ color: 'var(--text-primary)' }}>Unknown App</h2>
            <p>App "{appId}" could not be found.</p>
          </div>
        );
    }
  };

  return (
    <div className="app-container dark suite-layout standalone-app">
      {/* Standalone Titlebar */}
      <div
        className="titlebar drag-region standalone-titlebar"
        style={{
          WebkitAppRegion: 'drag',
          height: '36px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: '16px',
          background: 'var(--bg-panel)',
          borderBottom: `1px solid var(--border-color)`,
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <div className="titlebar-title" style={{ fontSize: '13px', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '16px', height: '16px', display: 'grid', placeItems: 'center', color: meta.color }}><AppIcon appId={meta.icon} size={16} weight="duotone" /></span>
          <span style={{ fontWeight: 800, color: meta.color }}>{meta.title}</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, opacity: 0.6 }}>— LabSuite</span>
        </div>
        <div className="titlebar-controls" style={{ WebkitAppRegion: 'no-drag', display: 'flex', height: '100%' }}>
          <button aria-label="Minimize" onClick={handleMinimize} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', width: '46px', height: '100%', cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Minus size={15} weight="bold" /></button>
          <button aria-label="Maximize" onClick={handleMaximize} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', width: '46px', height: '100%', cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Square size={13} /></button>
          <button aria-label="Close" onClick={handleClose} className="close-btn" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', width: '46px', height: '100%', cursor: 'pointer', display: 'grid', placeItems: 'center' }}><X size={15} weight="bold" /></button>
        </div>
      </div>

      {/* App Content */}
      <main style={{ height: 'calc(100vh - 36px)', overflow: 'hidden', position: 'relative', background: 'var(--bg-main)' }}>
        <ErrorBoundary compact>
          <Suspense fallback={<StandaloneLoadingState meta={meta} />}>
            {renderApp()}
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}

function StandaloneLoadingState({ meta }) {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-secondary)' }}>
      <div style={{ textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto 12px' }} />
        <div style={{ fontSize: '13px', fontWeight: 600 }}>Loading {meta.title}…</div>
      </div>
    </div>
  );
}
