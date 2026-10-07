import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft } from '@phosphor-icons/react/ArrowLeft';
import { ArrowRight } from '@phosphor-icons/react/ArrowRight';
import { ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise';
import { Plus } from '@phosphor-icons/react/Plus';
import { Folder } from '@phosphor-icons/react/Folder';
import { ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { Lock } from '@phosphor-icons/react/Lock';

const DEFAULT_URL = 'https://cryptpad.fr/sheet/';
const DRIVE_URL = 'https://cryptpad.fr/drive/';

export default function CryptPadSheets() {
  const webviewRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(DEFAULT_URL);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

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

  useEffect(() => {
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
      // Ignore aborted loads (code -3 is ERR_ABORTED, common when redirecting)
      if (event.errorCode === -3) return;
      setIsLoading(false);
      setHasError(true);
      setErrorMessage(event.errorDescription || 'Could not connect to CryptPad.');
    };

    wv.addEventListener('did-start-loading', handleStartLoading);
    wv.addEventListener('did-stop-loading', handleStopLoading);
    wv.addEventListener('did-fail-load', handleFailLoad);

    return () => {
      wv.removeEventListener('did-start-loading', handleStartLoading);
      wv.removeEventListener('did-stop-loading', handleStopLoading);
      wv.removeEventListener('did-fail-load', handleFailLoad);
    };
  }, []);

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
    window.electron?.ipcRenderer?.invoke('app:openExternal', { url }).catch(err => {
      console.warn('Failed to open external link:', err);
    });
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

        {/* Center: E2EE Security Badge */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 10px',
          borderRadius: '999px',
          background: 'rgba(0, 163, 137, 0.12)',
          border: '1px solid rgba(0, 163, 137, 0.3)',
          color: '#2dd4bf',
          fontSize: '11.5px',
          fontWeight: 600,
          letterSpacing: '0.2px'
        }}>
          <Lock size={13} weight="fill" />
          <span>Zero-Knowledge Encrypted</span>
          {isLoading && (
            <span style={{
              display: 'inline-block',
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: '#2dd4bf',
              marginLeft: '2px',
              animation: 'pulse 1.2s infinite ease-in-out'
            }} />
          )}
        </div>

        {/* Right: External Browser Link */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
            backgroundColor: '#1b2326'
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
      </div>
    </div>
  );
}
