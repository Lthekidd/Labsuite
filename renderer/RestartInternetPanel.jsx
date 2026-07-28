import React, { useEffect, useRef, useState } from 'react';
import { ArrowsClockwise } from '@phosphor-icons/react/ArrowsClockwise';
import { WifiHigh } from '@phosphor-icons/react/WifiHigh';

const ipcRenderer = window.electron?.ipcRenderer;
const DEFAULT_ROUTER_URL = 'http://192.168.100.1';

function cleanIpcError(error, fallback) {
  const message = String(error?.message || '').trim();
  return message
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i, '')
    .replace(/^RouterInternetError:\s*/i, '')
    || fallback;
}

function formatRouterLabel(routerUrl) {
  try {
    return new URL(routerUrl).host;
  } catch (_) {
    return routerUrl || '192.168.100.1';
  }
}

function normalizeStatus(value) {
  return {
    routerUrl: value?.routerUrl || DEFAULT_ROUTER_URL,
    hasCredentials: !!value?.hasCredentials,
    profiles: Array.isArray(value?.profiles) ? value.profiles : []
  };
}

const inputStyle = {
  width: '100%',
  height: '38px',
  marginTop: '7px',
  padding: '0 11px',
  boxSizing: 'border-box',
  color: 'var(--text-primary)',
  background: 'rgba(0, 0, 0, 0.24)',
  border: '1px solid var(--border-color)',
  borderRadius: '8px'
};

export default function RestartInternetPanel({ active = true }) {
  const [status, setStatus] = useState(normalizeStatus());
  const [isBusy, setIsBusy] = useState(false);
  const [isCredentialDialogOpen, setIsCredentialDialogOpen] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState({
    routerUrl: DEFAULT_ROUTER_URL,
    username: '',
    password: ''
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [publicIp, setPublicIp] = useState('');
  const [publicIpCheckedAt, setPublicIpCheckedAt] = useState('');
  const [publicIpError, setPublicIpError] = useState('');
  const [isPublicIpRefreshing, setIsPublicIpRefreshing] = useState(false);
  const publicIpRefreshTimers = useRef([]);

  const refreshStatus = async () => {
    try {
      const next = await ipcRenderer?.invoke('routerInternet:getStatus');
      if (next) setStatus(normalizeStatus(next));
    } catch (statusError) {
      setError(cleanIpcError(statusError, 'Could not read the saved router profile.'));
    }
  };

  const refreshPublicIp = async () => {
    try {
      setIsPublicIpRefreshing(true);
      setPublicIpError('');
      const result = await ipcRenderer?.invoke('routerInternet:getPublicIp');
      if (result?.ip) {
        setPublicIp(result.ip);
        setPublicIpCheckedAt(result.checkedAt || new Date().toISOString());
      }
    } catch (ipError) {
      setPublicIpError(cleanIpcError(ipError, 'Public IP refresh failed.'));
    } finally {
      setIsPublicIpRefreshing(false);
    }
  };

  useEffect(() => {
    if (!active) {
      publicIpRefreshTimers.current.forEach(timer => window.clearTimeout(timer));
      publicIpRefreshTimers.current = [];
      return undefined;
    }
    refreshStatus();
    refreshPublicIp();
    return () => {
      publicIpRefreshTimers.current.forEach(timer => window.clearTimeout(timer));
      publicIpRefreshTimers.current = [];
    };
  }, [active]);

  const schedulePublicIpRefresh = () => {
    publicIpRefreshTimers.current.forEach(timer => window.clearTimeout(timer));
    publicIpRefreshTimers.current = [8000, 22000].map(delay => window.setTimeout(refreshPublicIp, delay));
  };

  const openCredentialDialog = () => {
    setCredentialDraft({
      routerUrl: status.routerUrl || DEFAULT_ROUTER_URL,
      username: '',
      password: ''
    });
    setError('');
    setIsCredentialDialogOpen(true);
  };

  const runRestart = async payload => {
    try {
      setIsBusy(true);
      setError('');
      setMessage('Changing the WAN login and asking the router to reconnect…');
      const result = await ipcRenderer?.invoke('routerInternet:restart', payload);
      if (result?.status) setStatus(normalizeStatus(result.status));
      else await refreshStatus();
      setIsCredentialDialogOpen(false);
      setCredentialDraft(previous => ({ ...previous, password: '' }));
      setMessage(
        `Restart requested. The trailing 9 was ${result?.action || 'toggled'}; internet may be offline for 10–30 seconds while the public IP changes.`
      );
      schedulePublicIpRefresh();
    } catch (restartError) {
      setMessage('');
      setError(cleanIpcError(restartError, 'Failed to restart the internet connection.'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleRestart = async () => {
    if (!status.hasCredentials) {
      openCredentialDialog();
      return;
    }
    const confirmed = window.confirm(
      `Restart the internet through ${formatRouterLabel(status.routerUrl)} now? The connection will briefly go offline.`
    );
    if (confirmed) await runRestart({});
  };

  const submitCredentials = async event => {
    event.preventDefault();
    if (!credentialDraft.username.trim() || !credentialDraft.password) return;
    await runRestart({
      routerUrl: credentialDraft.routerUrl,
      username: credentialDraft.username.trim(),
      password: credentialDraft.password
    });
  };

  const switchProfile = async event => {
    const routerUrl = event.target.value;
    try {
      setIsBusy(true);
      setError('');
      setMessage('');
      const next = await ipcRenderer?.invoke('routerInternet:setActiveProfile', { routerUrl });
      if (next) setStatus(normalizeStatus(next));
      refreshPublicIp();
    } catch (profileError) {
      setError(cleanIpcError(profileError, 'Could not select that router profile.'));
    } finally {
      setIsBusy(false);
    }
  };

  const forgetProfile = async () => {
    if (!status.hasCredentials) return;
    const confirmed = window.confirm(`Forget the saved login for ${formatRouterLabel(status.routerUrl)}?`);
    if (!confirmed) return;
    try {
      setIsBusy(true);
      setError('');
      setMessage('');
      const next = await ipcRenderer?.invoke('routerInternet:forgetProfile', { routerUrl: status.routerUrl });
      setStatus(normalizeStatus(next));
      setIsCredentialDialogOpen(false);
      setMessage('Saved router login removed from Windows Credential Manager.');
    } catch (profileError) {
      setError(cleanIpcError(profileError, 'Could not remove the saved router login.'));
    } finally {
      setIsBusy(false);
    }
  };

  const statusText = error
    || message
    || (status.hasCredentials
      ? 'Login saved securely. Restart toggles the WAN username between its current value and the same value with a trailing 9.'
      : 'The first restart asks for the Huawei page login, then saves it securely on this PC.');

  return (
    <>
      <section style={{
        marginBottom: '32px',
        border: '1px solid rgba(59, 130, 246, 0.28)',
        borderRadius: '12px',
        background: 'linear-gradient(110deg, rgba(37, 99, 235, 0.09), rgba(14, 165, 233, 0.04))',
        padding: '18px 20px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '18px',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div style={{ flex: '1 1 330px', minWidth: 0, display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
          <div style={{
            width: '42px',
            height: '42px',
            flex: '0 0 42px',
            borderRadius: '11px',
            display: 'grid',
            placeItems: 'center',
            color: '#7dd3fc',
            background: 'rgba(14, 165, 233, 0.14)',
            border: '1px solid rgba(125, 211, 252, 0.16)'
          }}>
            <WifiHigh size={23} weight="duotone" />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '12px', color: '#60a5fa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
              Network Tools
            </div>
            <div style={{ marginTop: '4px', fontSize: '18px', color: 'var(--text-primary)', fontWeight: 800 }}>
              Restart Internet
            </div>
            <div
              role={error ? 'alert' : undefined}
              style={{ marginTop: '4px', fontSize: '12.5px', lineHeight: 1.45, color: error ? '#fca5a5' : message ? '#bae6fd' : 'var(--text-secondary)' }}
            >
              {statusText}
            </div>
          </div>
        </div>

        <div style={{ flex: '0 1 190px', minWidth: '170px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '10.5px', fontWeight: 750, textTransform: 'uppercase', letterSpacing: '0.45px' }}>
            Public IP
          </div>
          <div style={{ marginTop: '5px', display: 'flex', alignItems: 'center', gap: '7px' }}>
            <span style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: publicIpError && !publicIp ? '#fca5a5' : '#bae6fd',
              fontFamily: 'Consolas, "SFMono-Regular", monospace',
              fontSize: '14px',
              fontWeight: 750,
              whiteSpace: 'nowrap'
            }}>
              {publicIp || (isPublicIpRefreshing ? 'Checking…' : 'Unavailable')}
            </span>
            <button
              type="button"
              onClick={refreshPublicIp}
              disabled={isPublicIpRefreshing}
              aria-label="Refresh public IP"
              title={publicIpError || (publicIpCheckedAt
                ? `Last checked ${new Date(publicIpCheckedAt).toLocaleTimeString()}`
                : 'Refresh public IP')}
              style={{
                width: '25px',
                height: '25px',
                flex: '0 0 25px',
                padding: 0,
                display: 'grid',
                placeItems: 'center',
                color: publicIpError ? '#fca5a5' : '#7dd3fc',
                background: 'rgba(14, 165, 233, 0.10)',
                border: '1px solid rgba(125, 211, 252, 0.16)',
                borderRadius: '7px',
                cursor: isPublicIpRefreshing ? 'default' : 'pointer'
              }}
            >
              <ArrowsClockwise className={isPublicIpRefreshing ? 'animate-spin' : ''} size={13} weight="bold" />
            </button>
          </div>
          <div style={{ marginTop: '4px', color: publicIpError ? '#fca5a5' : 'var(--text-muted)', fontSize: '10.5px' }}>
            {publicIpError ? 'Refresh failed' : 'Current external address'}
          </div>
        </div>

        <div style={{ flex: '0 1 250px', minWidth: '210px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '10.5px', fontWeight: 750, textTransform: 'uppercase', letterSpacing: '0.45px' }}>
            Huawei router
          </div>
          {status.profiles.length > 1 ? (
            <select
              value={status.routerUrl}
              onChange={switchProfile}
              disabled={isBusy}
              aria-label="Saved router profile"
              style={{
                width: '100%',
                height: '34px',
                marginTop: '5px',
                padding: '0 10px',
                color: 'var(--text-primary)',
                background: 'rgba(0, 0, 0, 0.22)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px'
              }}
            >
              {status.profiles.map(profile => (
                <option key={profile.routerUrl} value={profile.routerUrl}>
                  {formatRouterLabel(profile.routerUrl)}
                </option>
              ))}
            </select>
          ) : (
            <div style={{ marginTop: '5px', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700 }}>
              {formatRouterLabel(status.routerUrl)}
            </div>
          )}
          <div style={{ marginTop: '4px', color: status.hasCredentials ? '#86efac' : 'var(--text-muted)', fontSize: '11px' }}>
            {status.hasCredentials ? '● Login saved locally' : '○ Login needed'}
          </div>
        </div>

        <div style={{ display: 'flex', flex: '0 1 auto', gap: '9px', alignItems: 'center', justifyContent: 'flex-end', marginLeft: 'auto' }}>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={openCredentialDialog}
            disabled={isBusy}
            style={{ height: '38px', padding: '0 14px', fontSize: '12.5px', fontWeight: 700 }}
          >
            {status.hasCredentials ? 'Login / network' : 'Set up login'}
          </button>
          <button
            className="btn"
            type="button"
            onClick={handleRestart}
            disabled={isBusy}
            style={{
              height: '38px',
              padding: '0 17px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '7px',
              fontSize: '13px',
              fontWeight: 750,
              color: '#fff',
              background: 'linear-gradient(90deg, #2563eb, #0284c7)',
              border: 'none',
              borderRadius: '8px',
              cursor: isBusy ? 'default' : 'pointer'
            }}
          >
            <ArrowsClockwise size={16} weight="bold" />
            {isBusy ? 'Restarting…' : 'Restart Internet'}
          </button>
        </div>
      </section>

      {isCredentialDialogOpen && (
        <div
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !isBusy) setIsCredentialDialogOpen(false);
          }}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0, 0, 0, 0.72)', backdropFilter: 'blur(4px)', display: 'grid', placeItems: 'center', padding: '24px' }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="router-login-title"
            onSubmit={submitCredentials}
            style={{ width: '100%', maxWidth: '470px', borderRadius: '13px', background: '#0d1b20', border: '1px solid rgba(255, 255, 255, 0.12)', boxShadow: '0 24px 70px rgba(0, 0, 0, 0.55)', overflow: 'hidden' }}
          >
            <div style={{ padding: '19px 20px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
              <div>
                <h2 id="router-login-title" style={{ margin: 0, fontSize: '17px' }}>Huawei router login</h2>
                <div style={{ marginTop: '6px', color: 'var(--text-muted)', fontSize: '12px', lineHeight: 1.5 }}>
                  Use the credentials for the web page in your screenshot, not the WAN/PPPoE password.
                </div>
              </div>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setIsCredentialDialogOpen(false)}
                disabled={isBusy}
                aria-label="Close router login dialog"
                style={{ width: '30px', height: '30px', padding: 0 }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '18px 20px' }}>
              <div style={{ padding: '11px 12px', borderRadius: '8px', background: 'rgba(37, 99, 235, 0.11)', border: '1px solid rgba(125, 211, 252, 0.12)', color: 'var(--text-secondary)', fontSize: '11.8px', lineHeight: 1.5 }}>
                LabSuite verifies the login once, stores it in Windows Credential Manager for this router address, and preserves the existing WAN password while toggling only the username’s final 9.
                If the router address uses HTTP, the router login itself is not encrypted while traveling over your local network.
              </div>

              <label htmlFor="router-address" style={{ display: 'block', marginTop: '16px', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 750, letterSpacing: '0.3px' }}>ROUTER ADDRESS</label>
              <input
                id="router-address"
                type="text"
                value={credentialDraft.routerUrl}
                onChange={event => setCredentialDraft(previous => ({ ...previous, routerUrl: event.target.value }))}
                placeholder="192.168.100.1"
                autoComplete="off"
                autoFocus
                disabled={isBusy}
                required
                style={inputStyle}
              />

              <label htmlFor="router-username" style={{ display: 'block', marginTop: '14px', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 750, letterSpacing: '0.3px' }}>WEB PAGE USERNAME</label>
              <input
                id="router-username"
                type="text"
                value={credentialDraft.username}
                onChange={event => setCredentialDraft(previous => ({ ...previous, username: event.target.value }))}
                placeholder="root"
                autoComplete="off"
                disabled={isBusy}
                required
                style={inputStyle}
              />

              <label htmlFor="router-password" style={{ display: 'block', marginTop: '14px', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 750, letterSpacing: '0.3px' }}>WEB PAGE PASSWORD</label>
              <input
                id="router-password"
                type="password"
                value={credentialDraft.password}
                onChange={event => setCredentialDraft(previous => ({ ...previous, password: event.target.value }))}
                placeholder="Router login password"
                autoComplete="new-password"
                disabled={isBusy}
                required
                style={inputStyle}
              />

              {error && <div role="alert" style={{ marginTop: '12px', color: '#fca5a5', fontSize: '11.8px', lineHeight: 1.45 }}>{error}</div>}
            </div>

            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', gap: '9px' }}>
              <div>
                {status.hasCredentials && (
                  <button className="btn btn-secondary" type="button" onClick={forgetProfile} disabled={isBusy} style={{ color: '#fca5a5' }}>
                    Forget saved login
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: '9px' }}>
                <button className="btn btn-secondary" type="button" onClick={() => setIsCredentialDialogOpen(false)} disabled={isBusy}>Cancel</button>
                <button className="btn btn-primary" type="submit" disabled={isBusy || !credentialDraft.routerUrl.trim() || !credentialDraft.username.trim() || !credentialDraft.password}>
                  {isBusy ? 'Connecting…' : 'Save & restart'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
