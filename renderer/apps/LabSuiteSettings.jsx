import React, { useState, useEffect } from 'react';

const ipcRenderer = window.electron?.ipcRenderer;

const inputStyle = {
  padding: '8px',
  background: 'rgba(255,255,255,0.05)',
  color: '#fff',
  border: '1px solid var(--border-color)',
  borderRadius: '6px'
};

const compactInputStyle = {
  ...inputStyle,
  padding: '6px',
  fontSize: '12px'
};

export default function LabSuiteSettings() {
  const [settings, setSettings] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [updateStatus, setUpdateStatus] = useState({
    supported: false,
    status: 'loading',
    currentVersion: '',
    message: 'Loading update status...'
  });
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [googleClientStatus, setGoogleClientStatus] = useState({
    hasRemote: false,
    usesOwnClientId: false,
    clientIdHint: ''
  });
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [googleClientMessage, setGoogleClientMessage] = useState('');
  const [googleClientError, setGoogleClientError] = useState('');
  const [isReconnectingGoogle, setIsReconnectingGoogle] = useState(false);

  useEffect(() => {
    loadSettings();
    loadGoogleClientStatus();
    ipcRenderer.invoke('updates:getStatus')
      .then((status) => setUpdateStatus(status || {}))
      .catch((error) => setUpdateStatus({
        supported: false,
        status: 'error',
        message: `Could not load update status: ${error.message}`
      }));

    const handleUpdateStatus = (_event, status) => setUpdateStatus(status || {});
    ipcRenderer.on('updates:status', handleUpdateStatus);
    return () => ipcRenderer.removeListener('updates:status', handleUpdateStatus);
  }, []);

  const loadSettings = async () => {
    try {
      setIsLoading(true);
      const data = await ipcRenderer.invoke('settings:get');
      setSettings(data || {});
    } catch (e) {
      console.error('Failed to load settings:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const loadGoogleClientStatus = async () => {
    try {
      const status = await ipcRenderer.invoke('auth:getGDriveClientStatus');
      setGoogleClientStatus(status || {});
    } catch (error) {
      console.error('Failed to load Google OAuth client status:', error);
    }
  };

  const reconnectGoogleDriveClient = async () => {
    setGoogleClientError('');
    setGoogleClientMessage('');
    setIsReconnectingGoogle(true);
    try {
      const status = await ipcRenderer.invoke('auth:reconnectGDriveClient', {
        clientId: googleClientId,
        clientSecret: googleClientSecret
      });
      setGoogleClientStatus(status || {});
      setGoogleClientId('');
      setGoogleClientSecret('');
      setGoogleClientMessage('Google Drive was reauthorized with your personal OAuth client. Backups have resumed.');
    } catch (error) {
      setGoogleClientError(error.message || 'Google Drive could not be reauthorized.');
    } finally {
      setIsReconnectingGoogle(false);
    }
  };

  const updateSetting = async (key, value) => {
    // Optimistic update
    setSettings(prev => ({ ...prev, [key]: value }));
    try {
      await ipcRenderer.invoke('settings:set', { key, value: String(value) });
    } catch (e) {
      console.error(`Failed to update ${key}:`, e);
      loadSettings(); // revert on fail
    }
  };

  const exportDecryptTool = async () => {
    try {
      const result = await ipcRenderer.invoke('settings:exportDecryptTool');
      if (result === true || result?.success) {
        alert('Standalone decryption recovery script saved successfully.');
      } else if (result !== false && !result?.canceled) {
        alert('Failed to export decryption tool' + (result?.error ? ': ' + result.error : '.'));
      }
    } catch (e) {
      console.error(e);
    }
  };

  const exportRecoverySheet = async () => {
    try {
      const result = await ipcRenderer.invoke('settings:exportRecoverySheet');
      if (result === true || result?.success) {
        alert('Emergency recovery sheet saved successfully.');
      } else if (result !== false && !result?.canceled) {
        alert('Failed to export recovery sheet' + (result?.error ? ': ' + result.error : '.'));
      }
    } catch (e) {
      console.error(e);
    }
  };

  const checkForUpdates = async () => {
    setUpdateStatus((current) => ({
      ...current,
      status: 'checking',
      message: 'Checking GitHub for a newer LabSuite release...'
    }));
    try {
      const status = await ipcRenderer.invoke('updates:check');
      setUpdateStatus(status || {});
    } catch (error) {
      setUpdateStatus((current) => ({
        ...current,
        status: 'error',
        message: `Update check failed: ${error.message}`
      }));
    }
  };

  const restartAndInstallUpdate = async () => {
    setIsInstallingUpdate(true);
    setUpdateStatus((current) => ({
      ...current,
      status: 'installing',
      message: 'Preparing to restart and install the update...'
    }));
    try {
      await ipcRenderer.invoke('updates:install');
    } catch (error) {
      setIsInstallingUpdate(false);
      setUpdateStatus((current) => ({
        ...current,
        status: 'error',
        message: error.message || 'LabSuite could not restart to install the update.'
      }));
    }
  };

  if (isLoading) {
    return (
      <div style={{ padding: '30px', color: '#fff', display: 'flex', justifyContent: 'center' }}>
        <div className="tree-spinner"></div>
      </div>
    );
  }

  return (
    <div style={{ padding: '30px', color: '#fff', height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      <h1 style={{ marginBottom: '24px', fontSize: '24px', color: 'var(--accent-primary)' }}>Suite Settings</h1>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '30px', maxWidth: '800px' }}>
        
        {/* Backup & Sync Behavior */}
        <section style={{ background: 'var(--bg-panel)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
          <h2 style={{ fontSize: '18px', marginBottom: '16px', color: 'var(--text-primary)' }}>Backup Engine Behavior</h2>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={settings.start_on_login === '1'} 
                onChange={(e) => updateSetting('start_on_login', e.target.checked ? '1' : '0')}
                style={{ width: '18px', height: '18px', accentColor: 'var(--accent-primary)' }}
              />
              <span style={{ fontSize: '14px' }}>Start on System Boot</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={settings.wifi_only === '1'} 
                onChange={(e) => updateSetting('wifi_only', e.target.checked ? '1' : '0')}
                style={{ width: '18px', height: '18px', accentColor: 'var(--accent-primary)' }}
              />
              <span style={{ fontSize: '14px' }}>Sync on Wi-Fi Only</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={settings.pause_on_metered === '1'} 
                onChange={(e) => updateSetting('pause_on_metered', e.target.checked ? '1' : '0')}
                style={{ width: '18px', height: '18px', accentColor: 'var(--accent-primary)' }}
              />
              <span style={{ fontSize: '14px' }}>Pause on Metered Networks</span>
            </label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '14px' }}>Background Sync Interval</label>
              <select 
                value={settings.sync_interval_minutes || '15'}
                onChange={(e) => updateSetting('sync_interval_minutes', e.target.value)}
                style={inputStyle}
              >
                <option value="0">Manual / Watcher Only</option>
                <option value="5">Every 5 Minutes</option>
                <option value="15">Every 15 Minutes</option>
                <option value="30">Every 30 Minutes</option>
                <option value="60">Every 1 Hour</option>
                <option value="1440">Once a day</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '14px' }}>Deep Reconcile Scan</label>
              <select
                value={settings.full_reconcile_interval_hours || '24'}
                onChange={(e) => updateSetting('full_reconcile_interval_hours', e.target.value)}
                style={inputStyle}
              >
                <option value="6">Every 6 Hours</option>
                <option value="12">Every 12 Hours</option>
                <option value="24">Daily</option>
                <option value="72">Every 3 Days</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '14px' }}>Backup Schedule Mode</label>
              <select
                value={settings.sync_schedule_type || 'ALWAYS'}
                onChange={(e) => updateSetting('sync_schedule_type', e.target.value)}
                style={inputStyle}
              >
                <option value="ALWAYS">Always</option>
                <option value="NIGHT">Night Backup</option>
                <option value="CUSTOM">Custom Hours</option>
              </select>
            </div>

            {settings.sync_schedule_type === 'CUSTOM' && (
              <div style={{ display: 'flex', gap: '10px', alignItems: 'end' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Start</label>
                  <input
                    type="time"
                    value={settings.schedule_start || '00:00'}
                    onChange={(e) => updateSetting('schedule_start', e.target.value)}
                    style={inputStyle}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>End</label>
                  <input
                    type="time"
                    value={settings.schedule_end || '23:59'}
                    onChange={(e) => updateSetting('schedule_end', e.target.value)}
                    style={inputStyle}
                  />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '14px' }}>Battery Backup Rule</label>
              <select
                value={settings.battery_mode || 'OFF'}
                onChange={(e) => updateSetting('battery_mode', e.target.value)}
                style={inputStyle}
              >
                <option value="OFF">Always Back Up</option>
                <option value="ON_BATTERY">Pause on Battery</option>
                <option value="LOW_BATTERY">Pause Below 20%</option>
              </select>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.sync_only_when_idle === '1'}
                onChange={(e) => updateSetting('sync_only_when_idle', e.target.checked ? '1' : '0')}
                style={{ width: '18px', height: '18px', accentColor: 'var(--accent-primary)' }}
              />
              <span style={{ fontSize: '14px' }}>Only Back Up When Idle</span>
            </label>

            {settings.sync_only_when_idle === '1' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '14px' }}>Idle Threshold Minutes</label>
                <input
                  type="number"
                  min="1"
                  value={settings.sync_idle_threshold_minutes || '5'}
                  onChange={(e) => updateSetting('sync_idle_threshold_minutes', e.target.value)}
                  style={inputStyle}
                />
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.sync_active_hours_enabled === '1'}
                onChange={(e) => updateSetting('sync_active_hours_enabled', e.target.checked ? '1' : '0')}
                style={{ width: '18px', height: '18px', accentColor: 'var(--accent-primary)' }}
              />
              <span style={{ fontSize: '14px' }}>Enable Active Hours Window</span>
            </label>

            {settings.sync_active_hours_enabled === '1' && (
              <div style={{ display: 'flex', gap: '10px', alignItems: 'end' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Start</label>
                  <input
                    type="time"
                    value={settings.sync_active_hours_start || '09:00'}
                    onChange={(e) => updateSetting('sync_active_hours_start', e.target.value)}
                    style={inputStyle}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>End</label>
                  <input
                    type="time"
                    value={settings.sync_active_hours_end || '17:00'}
                    onChange={(e) => updateSetting('sync_active_hours_end', e.target.value)}
                    style={inputStyle}
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Network & Performance */}
        <section style={{ background: 'var(--bg-panel)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
          <h2 style={{ fontSize: '18px', marginBottom: '16px', color: 'var(--text-primary)' }}>Performance & Throttling</h2>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '14px' }}>Network Bandwidth Limit (Upload Speed)</label>
              <select 
                value={settings.bwlimit || '0'}
                onChange={(e) => updateSetting('bwlimit', e.target.value)}
                style={inputStyle}
              >
                <option value="0">Unlimited (Fastest)</option>
                <option value="1M">1 MB/s (Light)</option>
                <option value="5M">5 MB/s (Moderate)</option>
                <option value="10M">10 MB/s (Heavy)</option>
                <option value="50M">50 MB/s (Very Heavy)</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '14px' }}>Backup Performance Profile</label>
              <select
                value={settings.backup_transfer_profile || 'fast'}
                onChange={(e) => updateSetting('backup_transfer_profile', e.target.value)}
                style={inputStyle}
              >
                <option value="conservative">Conservative</option>
                <option value="fast">Fast</option>
                <option value="turbo">Turbo</option>
              </select>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.bwlimit_scheduler_enabled === '1'}
                onChange={(e) => updateSetting('bwlimit_scheduler_enabled', e.target.checked ? '1' : '0')}
                style={{ width: '18px', height: '18px', accentColor: 'var(--accent-primary)' }}
              />
              <span style={{ fontSize: '14px' }}>Enable Speed Limiter Schedule</span>
            </label>

            {settings.bwlimit_scheduler_enabled === '1' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Limit</label>
                  <select
                    value={settings.bwlimit_scheduled_value || '1M'}
                    onChange={(e) => updateSetting('bwlimit_scheduled_value', e.target.value)}
                    style={compactInputStyle}
                  >
                    <option value="512K">512 KB/s</option>
                    <option value="1M">1 MB/s</option>
                    <option value="5M">5 MB/s</option>
                    <option value="10M">10 MB/s</option>
                  </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Start</label>
                  <input
                    type="time"
                    value={settings.bwlimit_scheduled_start || '09:00'}
                    onChange={(e) => updateSetting('bwlimit_scheduled_start', e.target.value)}
                    style={compactInputStyle}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>End</label>
                  <input
                    type="time"
                    value={settings.bwlimit_scheduled_end || '17:00'}
                    onChange={(e) => updateSetting('bwlimit_scheduled_end', e.target.value)}
                    style={compactInputStyle}
                  />
                </div>
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.smart_throttle_enabled === '1'}
                onChange={(e) => updateSetting('smart_throttle_enabled', e.target.checked ? '1' : '0')}
                style={{ width: '18px', height: '18px', accentColor: 'var(--accent-primary)' }}
              />
              <div>
                <div style={{ fontSize: '14px' }}>Smart Dynamic Throttling</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Adjusts upload speed based on whether the PC is idle.</div>
              </div>
            </label>

            {settings.smart_throttle_enabled === '1' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Upload Capacity Mbps</label>
                  <input
                    type="number"
                    min="1"
                    value={settings.upload_speed_capacity || '10'}
                    onChange={(e) => updateSetting('upload_speed_capacity', e.target.value)}
                    style={compactInputStyle}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Idle Delay Minutes</label>
                  <input
                    type="number"
                    min="1"
                    value={settings.smart_throttle_idle_mins || '15'}
                    onChange={(e) => updateSetting('smart_throttle_idle_mins', e.target.value)}
                    style={compactInputStyle}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Active Speed Cap: {settings.smart_throttle_min_pct || '15'}%</label>
                  <input
                    type="range"
                    min="5"
                    max="50"
                    step="5"
                    value={settings.smart_throttle_min_pct || '15'}
                    onChange={(e) => updateSetting('smart_throttle_min_pct', e.target.value)}
                    style={{ accentColor: 'var(--accent-primary)' }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Idle Speed Cap: {settings.smart_throttle_max_pct || '75'}%</label>
                  <input
                    type="range"
                    min="50"
                    max="95"
                    step="5"
                    value={settings.smart_throttle_max_pct || '75'}
                    onChange={(e) => updateSetting('smart_throttle_max_pct', e.target.value)}
                    style={{ accentColor: 'var(--accent-primary)' }}
                  />
                </div>
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={settings.throttle_cpu === '1'} 
                onChange={(e) => updateSetting('throttle_cpu', e.target.checked ? '1' : '0')}
                style={{ width: '18px', height: '18px', accentColor: 'var(--accent-primary)' }}
              />
              <div>
                <div style={{ fontSize: '14px' }}>Throttle CPU Usage</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Lowers the priority of the encryption engine to reduce system lag.</div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.use_default_exclusions !== '0'}
                onChange={(e) => updateSetting('use_default_exclusions', e.target.checked ? '1' : '0')}
                style={{ width: '18px', height: '18px', accentColor: 'var(--accent-primary)' }}
              />
              <div>
                <div style={{ fontSize: '14px' }}>Smart Exclusions</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Ignore system folders, caches, temporary files, logs, and build output.</div>
              </div>
            </label>
          </div>
        </section>

        <section style={{ background: 'var(--bg-panel)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
          <h2 style={{ fontSize: '18px', marginBottom: '16px', color: 'var(--text-primary)' }}>Cloud Account & Security</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <label style={{ fontSize: '14px' }}>Master Password Hint</label>
            <input
              type="text"
              value={settings.password_hint || ''}
              onChange={(e) => updateSetting('password_hint', e.target.value)}
              placeholder="Enter a hint to help remember your password"
              style={inputStyle}
            />
          </div>

          <div style={{ borderTop: '1px solid var(--border-color)', marginTop: '22px', paddingTop: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ fontSize: '15px', margin: '0 0 6px', color: 'var(--text-primary)' }}>Google OAuth Client</h3>
                <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                  rclone's shared Google client is being retired during 2026. Use your own Desktop OAuth client on every LabSuite PC.
                </p>
              </div>
              <span
                style={{
                  padding: '5px 9px',
                  borderRadius: '999px',
                  fontSize: '11px',
                  fontWeight: 700,
                  color: googleClientStatus.usesOwnClientId ? 'var(--accent-secondary)' : '#fbbf24',
                  background: googleClientStatus.usesOwnClientId ? 'rgba(52, 211, 153, 0.1)' : 'rgba(251, 191, 36, 0.1)',
                  border: googleClientStatus.usesOwnClientId ? '1px solid rgba(52, 211, 153, 0.25)' : '1px solid rgba(251, 191, 36, 0.3)'
                }}
              >
                {googleClientStatus.usesOwnClientId ? 'Personal client active' : 'Shared client needs migration'}
              </span>
            </div>

            {googleClientStatus.clientIdHint && (
              <p style={{ fontSize: '11.5px', color: 'var(--text-muted)', margin: '10px 0 0' }}>
                Active Client ID: {googleClientStatus.clientIdHint}
              </p>
            )}

            <button
              type="button"
              onClick={() => ipcRenderer.invoke('app:openExternal', { url: 'https://rclone.org/drive/#making-your-own-client-id' })}
              style={{ background: 'none', border: 0, color: '#60a5fa', padding: '10px 0 0', cursor: 'pointer', fontSize: '12px', textDecoration: 'underline' }}
            >
              Open the official setup guide
            </button>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '14px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px' }}>OAuth Client ID</label>
                <input
                  type="text"
                  autoComplete="off"
                  value={googleClientId}
                  onChange={(event) => setGoogleClientId(event.target.value)}
                  placeholder="...apps.googleusercontent.com"
                  style={inputStyle}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px' }}>OAuth Client Secret</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={googleClientSecret}
                  onChange={(event) => setGoogleClientSecret(event.target.value)}
                  placeholder="Enter the client secret"
                  style={inputStyle}
                />
              </div>
            </div>

            <p style={{ fontSize: '11.5px', color: 'var(--text-muted)', margin: '10px 0 14px', lineHeight: 1.5 }}>
              Save only when no backup is running. LabSuite briefly pauses new backup work, opens Google approval in your browser, and never sends these credentials to the renderer again.
            </p>
            {googleClientError && <p style={{ color: 'var(--accent-error)', fontSize: '12px', margin: '0 0 12px' }}>{googleClientError}</p>}
            {googleClientMessage && <p style={{ color: 'var(--accent-secondary)', fontSize: '12px', margin: '0 0 12px' }}>{googleClientMessage}</p>}
            <button
              className="btn btn-primary"
              type="button"
              disabled={isReconnectingGoogle || !googleClientId.trim() || !googleClientSecret.trim() || !googleClientStatus.hasRemote}
              onClick={reconnectGoogleDriveClient}
              style={{ padding: '9px 14px' }}
            >
              {isReconnectingGoogle ? 'Approve in Browser...' : 'Save Credentials & Reconnect'}
            </button>
          </div>
        </section>

        {/* Software Updates */}
        <section style={{ background: 'var(--bg-panel)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
          <h2 style={{ fontSize: '18px', marginBottom: '8px', color: 'var(--text-primary)' }}>Software Updates</h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '0 0 18px' }}>
            Installed version: {updateStatus.currentVersion ? `v${updateStatus.currentVersion}` : 'Unknown'}. LabSuite also checks automatically after startup and every six hours.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              type="button"
              onClick={updateStatus.status === 'downloaded' ? restartAndInstallUpdate : checkForUpdates}
              disabled={!updateStatus.supported || isInstallingUpdate || ['checking', 'available', 'downloading', 'installing'].includes(updateStatus.status)}
              style={{ minWidth: '170px', padding: '10px 16px' }}
            >
              {updateStatus.status === 'checking' && 'Checking...'}
              {updateStatus.status === 'available' && 'Starting Download...'}
              {updateStatus.status === 'downloading' && `Downloading ${Math.round(updateStatus.progress || 0)}%`}
              {updateStatus.status === 'downloaded' && 'Restart & Install'}
              {updateStatus.status === 'installing' && 'Restarting...'}
              {!['checking', 'available', 'downloading', 'downloaded', 'installing'].includes(updateStatus.status) && 'Check for Updates'}
            </button>
            <div
              role="status"
              aria-live="polite"
              style={{
                flex: '1 1 320px',
                fontSize: '13px',
                lineHeight: 1.5,
                color: updateStatus.status === 'error'
                  ? 'var(--accent-error)'
                  : updateStatus.status === 'downloaded'
                    ? 'var(--accent-secondary)'
                    : 'var(--text-secondary)'
              }}
            >
              {updateStatus.message || 'Click the button to check for a new release.'}
            </div>
          </div>
          {updateStatus.status === 'downloaded' && (
            <p style={{ margin: '14px 0 0', color: 'var(--text-muted)', fontSize: '12px' }}>
              LabSuite will safely close its background services, install the update, and reopen automatically.
            </p>
          )}
        </section>

        {/* Advanced Emergency Tools */}
        <section style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '24px', borderRadius: '12px', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
          <h2 style={{ fontSize: '18px', marginBottom: '16px', color: '#fca5a5' }}>Emergency Recovery Tools</h2>
          <p style={{ fontSize: '13px', color: '#fca5a5', opacity: 0.8, marginBottom: '20px' }}>
            These tools are essential if you lose access to this PC and need to decrypt your LabSuite data on another device.
          </p>
          
          <div style={{ display: 'flex', gap: '16px' }}>
            <button 
              onClick={exportRecoverySheet}
              style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}
            >
              Export Recovery Sheet (.txt)
            </button>
            <button 
              onClick={exportDecryptTool}
              style={{ background: 'rgba(239,68,68,0.2)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.5)', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}
            >
              Export Recovery Script (.py)
            </button>
          </div>
        </section>

      </div>
    </div>
  );
}
