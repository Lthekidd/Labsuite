import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft } from '@phosphor-icons/react/ArrowLeft';
import { ArrowRight } from '@phosphor-icons/react/ArrowRight';
import { ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise';
import { Plus } from '@phosphor-icons/react/Plus';
import { Folder } from '@phosphor-icons/react/Folder';
import { ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { Lock } from '@phosphor-icons/react/Lock';
import { CloudArrowUp } from '@phosphor-icons/react/CloudArrowUp';
import { CloudCheck } from '@phosphor-icons/react/CloudCheck';
import { CloudWarning } from '@phosphor-icons/react/CloudWarning';

const DEFAULT_URL = 'https://cryptpad.fr/sheet/';
const DRIVE_URL = 'https://cryptpad.fr/drive/';

const ipcRenderer = window.electron?.ipcRenderer;

async function safeInvoke(channel, ...args) {
  try {
    if (!ipcRenderer) return null;
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    console.warn(`IPC Error on ${channel}:`, err.message);
    return null;
  }
}

export default function CryptPadSheets({ active = true }) {
  const webviewRef = useRef(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(DEFAULT_URL);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Session sync states: 'restoring' | 'synced' | 'unsynced' | 'syncing' | 'error'
  const [syncStatus, setSyncStatus] = useState('restoring');
  const [syncStatusText, setSyncStatusText] = useState('Restoring session from vault...');
  const [lastSyncedTime, setLastSyncedTime] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const updateNavState = () => {
    const wv = webviewRef.current;
    if (!wv) return;
    try {
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
      const url = wv.getURL();
      if (url) setCurrentUrl(url);
    } catch (_) {}
  };

  // Lifecycle Hook: Restore vault session on component mount before loading webview
  useEffect(() => {
    let isMounted = true;

    async function restoreSession() {
      setSyncStatus('restoring');
      setSyncStatusText('Restoring session from vault...');
      try {
        const res = await safeInvoke('cryptpad:restoreSession');
        if (!isMounted) return;
        if (res && res.success) {
          setSyncStatus('synced');
          setSyncStatusText('Encrypted Session Synced to Vault');
          if (res.lastSynced || res.exportedAt) {
            setLastSyncedTime(res.lastSynced || res.exportedAt);
          }
        } else if (res && res.noSession) {
          setSyncStatus('synced');
          setSyncStatusText('Encrypted Session Synced to Vault');
        } else if (res && res.error) {
          setSyncStatus('error');
          setSyncStatusText(res.error || 'Session restore failed');
        } else {
          setSyncStatus('synced');
          setSyncStatusText('Encrypted Session Synced to Vault');
        }
      } catch (err) {
        if (!isMounted) return;
        console.warn('CryptPad session restore error:', err);
        setSyncStatus('error');
        setSyncStatusText('Session restore offline');
      } finally {
        if (isMounted) {
          setSessionReady(true);
        }
      }
    }

    restoreSession();
    return () => {
      isMounted = false;
    };
  }, []);

  // Webview lifecycle event listeners
  useEffect(() => {
    if (!sessionReady) return;
    const wv = webviewRef.current;
    if (!wv) return;

    const handleStartLoading = () => {
      setIsLoading(true);
      setHasError(false);
      setErrorMessage('');
    };

    const handleStopLoading = () => {
      setIsLoading(false);
      updateNavState();
    };

    const handleFailLoad = (event) => {
      // Ignore aborted loads (code -3 is ERR_ABORTED, common during redirect)
      if (event.errorCode === -3) return;
      setIsLoading(false);
      setHasError(true);
      setErrorMessage(event.errorDescription || 'Could not connect to CryptPad.');
    };

    const handleNavigationChange = () => {
      updateNavState();
      setSyncStatus(prev => (prev === 'synced' ? 'unsynced' : prev));
      setSyncStatusText(prev => (prev.includes('Synced') ? 'Unsynced changes' : prev));
    };

    wv.addEventListener('did-start-loading', handleStartLoading);
    wv.addEventListener('did-stop-loading', handleStopLoading);
    wv.addEventListener('did-fail-load', handleFailLoad);
    wv.addEventListener('did-navigate', handleNavigationChange);
    wv.addEventListener('did-navigate-in-page', handleNavigationChange);

    return () => {
      wv.removeEventListener('did-start-loading', handleStartLoading);
      wv.removeEventListener('did-stop-loading', handleStopLoading);
      wv.removeEventListener('did-fail-load', handleFailLoad);
      wv.removeEventListener('did-navigate', handleNavigationChange);
      wv.removeEventListener('did-navigate-in-page', handleNavigationChange);
    };
  }, [sessionReady]);

  // Manual session save to Google Drive vault
  const handleSaveSession = async () => {
    if (isSyncing || !sessionReady) return;
    setIsSyncing(true);
    setSyncStatus('syncing');
    setSyncStatusText('Syncing...');
    try {
      const res = await safeInvoke('cryptpad:saveSession');
      if (res && res.success) {
        setSyncStatus('synced');
        setSyncStatusText('Encrypted Session Synced to Vault');
        setLastSyncedTime(res.lastSynced || res.exportedAt || Date.now());
      } else {
        setSyncStatus('error');
        setSyncStatusText(res?.error ? `Sync failed: ${res.error}` : 'Sync failed');
      }
    } catch (err) {
      console.warn('Error saving CryptPad session:', err);
      setSyncStatus('error');
      setSyncStatusText('Failed to sync session');
    } finally {
      setIsSyncing(false);
    }
  };

  // Debounced auto-save on unsynced changes (20s)
  useEffect(() => {
    if (syncStatus !== 'unsynced') return;
    const timer = setTimeout(() => {
      handleSaveSession();
    }, 20000);
    return () => clearTimeout(timer);
  }, [syncStatus]);

  const handleBack = () => {
    const wv = webviewRef.current;
    if (wv && wv.canGoBack()) wv.goBack();
  };

  const handleForward = () => {
    const wv = webviewRef.current;
    if (wv && wv.canGoForward()) wv.goForward();
  };

  const handleReload = () => {
    const wv = webviewRef.current;
    if (wv) {
      setHasError(false);
      wv.reload();
    }
  };

  const handleNewSheet = () => {
    const wv = webviewRef.current;
    if (wv) {
      setHasError(false);
      wv.loadURL(DEFAULT_URL);
    }
  };

  const handleOpenDrive = () => {
    const wv = webviewRef.current;
    if (wv) {
      setHasError(false);
      wv.loadURL(DRIVE_URL);
    }
  };

  const handleOpenExternal = () => {
    const url = currentUrl || DEFAULT_URL;
    safeInvoke('app:openExternal', { url });
  };

  const renderSyncBadge = () => {
    let icon = <Lock size={13} weight="fill" />;
    let color = '#2dd4bf';
    let background = 'rgba(0, 163, 137, 0.12)';
    let border = 'rgba(0, 163, 137, 0.3)';
    let isPulsing = false;

    if (syncStatus === 'syncing' || syncStatus === 'restoring') {
      icon = <ArrowClockwise size={13} weight="bold" className="spin" />;
      color = '#38bdf8';
      background = 'rgba(56, 189, 248, 0.12)';
      border = 'rgba(56, 189, 248, 0.3)';
      isPulsing = true;
    } else if (syncStatus === 'unsynced') {
      icon = <Lock size={13} weight="fill" />;
      color = '#fbbf24';
      background = 'rgba(245, 158, 11, 0.12)';
      border = 'rgba(245, 158, 11, 0.3)';
      isPulsing = true;
    } else if (syncStatus === 'error') {
      icon = <CloudWarning size={14} weight="bold" />;
      color = '#f87171';
      background = 'rgba(239, 68, 68, 0.12)';
      border = 'rgba(239, 68, 68, 0.3)';
      isPulsing = false;
    } else if (syncStatus === 'synced') {
      icon = <CloudCheck size={14} weight="bold" />;
      color = '#2dd4bf';
      background = 'rgba(0, 163, 137, 0.12)';
      border = 'rgba(0, 163, 137, 0.3)';
      isPulsing = false;
    }

    return (
      <div
        className="cryptpad-sync-badge"
        title={lastSyncedTime ? `Last synced: ${new Date(lastSyncedTime).toLocaleTimeString()}` : syncStatusText}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 12px',
          borderRadius: '999px',
          background,
          border: `1px solid ${border}`,
          color,
          fontSize: '11.5px',
          fontWeight: 600,
          letterSpacing: '0.2px',
          transition: 'all 200ms ease'
        }}
      >
        {icon}
        <span>{syncStatusText}</span>
        {isPulsing && (
          <span style={{
            display: 'inline-block',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: color,
            marginLeft: '2px',
            animation: 'pulse 1.2s infinite ease-in-out'
          }} />
        )}
      </div>
    );
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      width: '100%',
      backgroundColor: '#1b2326',
      color: 'var(--text-primary)',
      overflow: 'hidden'
    }}>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.9); }
        }
        .spin {
          animation: spin 1s linear infinite;
        }
      `}</style>

      {/* CryptPad Navigation & Action Bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 14px',
        backgroundColor: 'rgba(15, 20, 22, 0.95)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        minHeight: '44px',
        gap: '10px',
        userSelect: 'none'
      }}>
        {/* Left: History & Quick Links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleBack}
            disabled={!canGoBack}
            title="Go Back"
            style={{ padding: '6px 10px', height: '32px', opacity: canGoBack ? 1 : 0.4 }}
          >
            <ArrowLeft size={16} weight="bold" />
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleForward}
            disabled={!canGoForward}
            title="Go Forward"
            style={{ padding: '6px 10px', height: '32px', opacity: canGoForward ? 1 : 0.4 }}
          >
            <ArrowRight size={16} weight="bold" />
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleReload}
            title="Reload Sheet"
            style={{ padding: '6px 10px', height: '32px' }}
          >
            <ArrowClockwise size={16} weight="bold" className={isLoading ? 'spin' : ''} />
          </button>

          <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.1)', margin: '0 4px' }} />

          <button
            type="button"
            className="btn btn-primary"
            onClick={handleNewSheet}
            title="Create New Blank Spreadsheet"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              height: '32px',
              padding: '0 12px',
              fontSize: '12.5px',
              fontWeight: 600,
              background: 'linear-gradient(90deg, #00a389, #008770)',
              borderColor: '#00a389'
            }}
          >
            <Plus size={15} weight="bold" />
            <span>New Sheet</span>
          </button>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleOpenDrive}
            title="Open CryptDrive Folder"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              height: '32px',
              padding: '0 12px',
              fontSize: '12.5px'
            }}
          >
            <Folder size={15} weight="duotone" />
            <span>CryptDrive</span>
          </button>
        </div>

        {/* Center: Session Encryption & Sync Status Badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {renderSyncBadge()}
        </div>

        {/* Right: Manual Session Sync & External Browser Link */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            className="btn btn-secondary cryptpad-btn-sync"
            onClick={handleSaveSession}
            disabled={isSyncing || !sessionReady}
            title="Encrypt session cookies with master key and backup to Google Drive vault"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              height: '32px',
              padding: '0 12px',
              fontSize: '12px',
              fontWeight: 600,
              color: isSyncing ? '#38bdf8' : (syncStatus === 'unsynced' ? '#fbbf24' : 'var(--text-primary)'),
              borderColor: syncStatus === 'unsynced' ? 'rgba(245, 158, 11, 0.4)' : undefined,
              opacity: (isSyncing || !sessionReady) ? 0.7 : 1,
              cursor: (isSyncing || !sessionReady) ? 'not-allowed' : 'pointer'
            }}
          >
            <CloudArrowUp size={15} weight="bold" className={isSyncing ? 'spin' : ''} />
            <span>{isSyncing ? 'Syncing...' : 'Sync Session to Cloud'}</span>
          </button>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleOpenExternal}
            title="Open Current Sheet in Default Web Browser"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              height: '32px',
              padding: '0 10px',
              fontSize: '12px'
            }}
          >
            <ArrowSquareOut size={15} />
            <span>Open in Browser</span>
          </button>
        </div>
      </div>

      {/* Main View Area */}
      <div style={{ flex: 1, position: 'relative', width: '100%', height: '100%' }}>
        {!sessionReady ? (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#1b2326',
            color: 'var(--text-secondary)'
          }}>
            <div className="loading-spinner" style={{
              width: '32px',
              height: '32px',
              border: '3px solid rgba(0, 163, 137, 0.2)',
              borderTopColor: '#00a389',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
              marginBottom: '16px'
            }} />
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
              Restoring Encrypted Session…
            </div>
            <div style={{ fontSize: '12px', marginTop: '6px', opacity: 0.7 }}>
              Decrypting and restoring authentication cookies from vault
            </div>
          </div>
        ) : (
          <>
            {hasError ? (
              <div style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '30px',
                textAlign: 'center',
                backgroundColor: '#1b2326',
                zIndex: 10
              }}>
                <div style={{
                  padding: '24px 32px',
                  borderRadius: '12px',
                  background: 'rgba(0, 0, 0, 0.3)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  maxWidth: '440px'
                }}>
                  <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
                  <h3 style={{ margin: '0 0 8px 0', fontSize: '18px', color: '#fca5a5' }}>
                    Connection Failed
                  </h3>
                  <p style={{ margin: '0 0 16px 0', color: 'var(--text-secondary)', fontSize: '13.5px', lineHeight: 1.5 }}>
                    {errorMessage || 'Unable to connect to cryptpad.fr. CryptPad Sheets requires an active internet connection for real-time encrypted sync.'}
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleReload}
                    style={{ height: '36px', padding: '0 18px', fontSize: '13px' }}
                  >
                    Retry Connection
                  </button>
                </div>
              </div>
            ) : null}

            {/* Embedded Webview */}
            <webview
              ref={webviewRef}
              src={DEFAULT_URL}
              partition="persist:cryptpad"
              allowpopups="true"
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                display: hasError ? 'none' : 'flex'
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
