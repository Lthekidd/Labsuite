import React, { useState, useEffect, useCallback } from 'react';
import AppIcon from '../AppIcon';
import LabMediaMark from '../LabMediaMark';
import { Play } from '@phosphor-icons/react/Play';
import { Pause } from '@phosphor-icons/react/Pause';
import { CaretLeft } from '@phosphor-icons/react/CaretLeft';
import { CaretRight } from '@phosphor-icons/react/CaretRight';

const ipcRenderer = window.electron?.ipcRenderer;

export default function LabMedia({ active = true }) {
  const [status, setStatus] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const refreshStatus = useCallback(async () => {
    try {
      const res = await ipcRenderer?.invoke('labmedia:getStatus');
      setStatus(res || null);
    } catch (err) {
      console.error('Failed to get LabMedia status:', err);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    refreshStatus();

    const handleStatusChanged = (_event, nextStatus) => {
      setStatus(nextStatus);
    };

    ipcRenderer?.on('labmedia:statusChanged', handleStatusChanged);
    const interval = setInterval(refreshStatus, 2000);

    return () => {
      ipcRenderer?.removeListener('labmedia:statusChanged', handleStatusChanged);
      clearInterval(interval);
    };
  }, [active, refreshStatus]);

  const handleToggleEnable = async () => {
    if (!status) return;
    try {
      setIsBusy(true);
      setActionError('');
      const nextEnabled = !status.settings?.enabled;
      const res = await ipcRenderer?.invoke('labmedia:setEnabled', { enabled: nextEnabled });
      setStatus(res || null);
    } catch (err) {
      setActionError(err.message || 'Failed to toggle LabMedia');
    } finally {
      setIsBusy(false);
    }
  };

  const handleUpdateSetting = async (key, value) => {
    if (!status) return;
    try {
      setActionError('');
      const updates = { [key]: value };
      const res = await ipcRenderer?.invoke('labmedia:updateSettings', { updates });
      setStatus(res || null);
    } catch (err) {
      setActionError(err.message || 'Failed to update setting');
    }
  };

  const handleUpdateControl = async (controlKey, value) => {
    if (!status) return;
    try {
      setActionError('');
      const currentControls = status.settings?.controls || {};
      const updates = {
        controls: {
          ...currentControls,
          [controlKey]: value
        }
      };
      const res = await ipcRenderer?.invoke('labmedia:updateSettings', { updates });
      setStatus(res || null);
    } catch (err) {
      setActionError(err.message || 'Failed to update control toggle');
    }
  };

  const handleResetSettings = async () => {
    if (!window.confirm('Reset LabMedia settings to defaults?')) return;
    try {
      setIsBusy(true);
      setActionError('');
      const res = await ipcRenderer?.invoke('labmedia:resetSettings');
      setStatus(res || null);
    } catch (err) {
      setActionError(err.message || 'Failed to reset settings');
    } finally {
      setIsBusy(false);
    }
  };

  const handleRestartWidget = async () => {
    try {
      setIsBusy(true);
      setActionError('');
      const res = await ipcRenderer?.invoke('labmedia:restart');
      setStatus(res || null);
    } catch (err) {
      setActionError(err.message || 'Failed to restart widget');
    } finally {
      setIsBusy(false);
    }
  };

  if (!status) {
    return (
      <div style={{ padding: '40px', color: 'var(--text-secondary)' }}>
        Loading LabMedia settings...
      </div>
    );
  }

  const settings = status.settings || {};
  const controls = settings.controls || {};
  const session = status.session || {};

  const getStatusBadge = () => {
    switch (status.state) {
      case 'unsupported':
        return { label: 'Unsupported OS', color: '#eab308', bg: 'rgba(234, 179, 8, 0.15)' };
      case 'stopped':
        return { label: 'Stopped', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.15)' };
      case 'starting':
        return { label: 'Starting...', color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.15)' };
      case 'running':
        return { label: 'Active in Taskbar', color: '#10b981', bg: 'rgba(16, 185, 129, 0.15)' };
      case 'no_session':
        return { label: 'No Media Session', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)' };
      case 'error':
        return { label: 'Error', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)' };
      default:
        return { label: 'Unknown', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.15)' };
    }
  };

  const badge = getStatusBadge();

  return (
    <div className="labmedia-container" style={{ padding: '40px', height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: 'rgba(29, 185, 84, 0.15)', display: 'grid', placeItems: 'center' }}>
            <AppIcon appId="labmedia" size={28} color="#1db954" />
          </div>
          <div>
            <h1 style={{ fontSize: '26px', margin: 0, color: 'var(--text-primary)', fontWeight: 800 }}>
              LabMedia
            </h1>
            <p style={{ fontSize: '14px', margin: '4px 0 0 0', color: 'var(--text-secondary)' }}>
              Taskbar player for Spotify, YouTube, YouTube Music, and browser media controls.
            </p>
          </div>
        </div>

        <span style={{
          padding: '6px 14px',
          borderRadius: '999px',
          fontSize: '12.5px',
          fontWeight: 700,
          color: badge.color,
          background: badge.bg,
          border: `1px solid ${badge.color}40`
        }}>
          {badge.label}
        </span>
      </div>

      {actionError && (
        <div style={{ marginBottom: '24px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', fontSize: '13px' }}>
          {actionError}
        </div>
      )}

      {status.error && (
        <div style={{ marginBottom: '24px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', fontSize: '13px' }}>
          {status.error}
        </div>
      )}

      {!status.supported && (
        <div style={{ marginBottom: '28px', padding: '16px 20px', borderRadius: '10px', background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.3)', color: '#fde047', fontSize: '13.5px' }}>
          ⚠️ LabMedia requires Windows. It is unsupported on this platform.
        </div>
      )}

      {/* Main Controls Card */}
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '24px', marginBottom: '24px' }}>
        {/* Enable / Show Toggle */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '20px', borderBottom: '1px solid var(--border-color)' }}>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Enable Taskbar Player
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              Shows media playback widget in unused taskbar space.
            </div>
          </div>
          <button
            type="button"
            onClick={handleToggleEnable}
            disabled={isBusy || !status.supported}
            style={{
              height: '36px',
              padding: '0 20px',
              borderRadius: '8px',
              border: 'none',
              background: settings.enabled ? '#1db954' : 'rgba(255, 255, 255, 0.1)',
              color: settings.enabled ? '#fff' : 'var(--text-secondary)',
              fontSize: '13px',
              fontWeight: 700,
              cursor: isBusy || !status.supported ? 'default' : 'pointer'
            }}
          >
            {settings.enabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>

        {/* Size Selection */}
        <div style={{ padding: '20px 0', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
            Widget Size
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
            Select taskbar widget width and padding preset.
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            {['compact', 'normal', 'large'].map(sizeOpt => {
              const activeSize = (settings.size || 'normal') === sizeOpt;
              return (
                <button
                  key={sizeOpt}
                  type="button"
                  onClick={() => handleUpdateSetting('size', sizeOpt)}
                  disabled={!settings.enabled}
                  style={{
                    height: '34px',
                    padding: '0 16px',
                    borderRadius: '6px',
                    border: activeSize ? '1px solid #1db954' : '1px solid var(--border-color)',
                    background: activeSize ? 'rgba(29, 185, 84, 0.2)' : 'rgba(0, 0, 0, 0.2)',
                    color: activeSize ? '#4ade80' : 'var(--text-secondary)',
                    fontWeight: 700,
                    fontSize: '12.5px',
                    cursor: settings.enabled ? 'pointer' : 'default',
                    textTransform: 'capitalize'
                  }}
                >
                  {sizeOpt}
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom Preset Themes */}
        <div style={{ padding: '20px 0', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
            Widget Preset Theme
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
            Choose a visual style preset for the taskbar media surface.
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {[
              { id: 'spotify', label: 'Spotify Green', bg: '#18181b', accent: '#1db954' },
              { id: 'oled', label: 'OLED Black', bg: '#000000', accent: '#10b981' },
              { id: 'neon', label: 'Cyberpunk Neon', bg: '#0d0221', accent: '#00f5d4' },
              { id: 'glass', label: 'Glassmorphism', bg: '#1a1a2e', accent: '#38bdf8' },
              { id: 'minimal', label: 'Minimalist', bg: '#111827', accent: '#9ca3af' }
            ].map((theme) => {
              const active = (settings.theme || 'spotify') === theme.id;
              return (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => handleUpdateSetting('theme', theme.id)}
                  disabled={!settings.enabled}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    height: '36px',
                    padding: '0 14px',
                    borderRadius: '8px',
                    border: active ? `1.5px solid ${theme.accent}` : '1px solid var(--border-color)',
                    background: active ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.2)',
                    color: active ? '#ffffff' : 'var(--text-secondary)',
                    fontWeight: 700,
                    fontSize: '12.5px',
                    cursor: settings.enabled ? 'pointer' : 'default'
                  }}
                >
                  <span style={{ width: '12px', height: '12px', borderRadius: '50%', background: theme.accent, display: 'inline-block' }} />
                  {theme.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Opacity Slider */}
        <div style={{ padding: '20px 0', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Widget Opacity
            </div>
            <span style={{ fontSize: '13px', fontWeight: 700, color: '#1db954' }}>
              {Math.round((settings.opacity ?? 1) * 100)}%
            </span>
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
            Adjust the artwork, text, and controls transparency (40%–100%).
          </div>
          <input
            type="range"
            min="0.4"
            max="1.0"
            step="0.05"
            value={settings.opacity ?? 1}
            disabled={!settings.enabled}
            onChange={(e) => handleUpdateSetting('opacity', parseFloat(e.target.value))}
            style={{ width: '100%', cursor: settings.enabled ? 'pointer' : 'default' }}
          />
        </div>

        {/* Display Toggles */}
        <div style={{ padding: '20px 0 0 0' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '14px' }}>
            UI Element Toggles
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
            <ToggleOption label="Album Art" checked={!!settings.showAlbumArt} onChange={(val) => handleUpdateSetting('showAlbumArt', val)} disabled={!settings.enabled} />
            <ToggleOption label="Progress Bar" checked={!!settings.showProgress} onChange={(val) => handleUpdateSetting('showProgress', val)} disabled={!settings.enabled} />
            <ToggleOption label="Previous Button" checked={!!controls.previous} onChange={(val) => handleUpdateControl('previous', val)} disabled={!settings.enabled} />
            <ToggleOption label="Play/Pause Button" checked={!!controls.playPause} onChange={(val) => handleUpdateControl('playPause', val)} disabled={!settings.enabled} />
            <ToggleOption label="Next Button" checked={!!controls.next} onChange={(val) => handleUpdateControl('next', val)} disabled={!settings.enabled} />
            <ToggleOption label="Hide in Fullscreen" checked={!!settings.hideWhenFullscreen} onChange={(val) => handleUpdateSetting('hideWhenFullscreen', val)} disabled={!settings.enabled} />
          </div>
        </div>
      </div>

      {/* Live Session Card */}
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '20px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <div style={{ fontSize: '12px', color: '#1db954', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
            Live Session Preview
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            🔊 Hover taskbar widget &amp; scroll wheel to adjust volume
          </div>
        </div>
        {session.hasSession ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: '8px', background: 'rgba(29, 185, 84, 0.15)', display: 'grid', placeItems: 'center' }}>
                <LabMediaMark size={24} />
              </div>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {session.title || 'Unknown Track'}
                </div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px', display: 'flex', alignItems: 'center' }}>
                  {session.artist || 'Unknown Artist'} • {session.isPlaying ? 'Playing' : 'Paused'}
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 700,
                    background: 'rgba(29, 185, 84, 0.15)',
                    color: '#4ade80',
                    marginLeft: '8px'
                  }}>
                    {session.sourceApp?.toLowerCase().includes('spotify') ? 'Spotify' :
                     session.sourceApp?.toLowerCase().includes('youtube') ? 'YouTube' :
                     session.sourceApp?.toLowerCase().includes('chrome') ? 'Chrome' :
                     session.sourceApp?.toLowerCase().includes('edge') ? 'Edge' :
                     'SMTC Session'}
                  </span>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                onClick={() => ipcRenderer?.invoke('labmedia:mediaAction', { action: 'previous' })}
                style={previewControlStyle(false)}
                title="Previous"
              >
                <CaretLeft size={18} weight="bold" />
              </button>
              <button
                type="button"
                onClick={() => ipcRenderer?.invoke('labmedia:mediaAction', { action: 'playPause' })}
                style={previewControlStyle(true)}
                title="Play / Pause"
              >
                {session.isPlaying ? <Pause size={16} weight="bold" /> : <Play size={16} weight="bold" style={{ marginLeft: '1px' }} />}
              </button>
              <button
                type="button"
                onClick={() => ipcRenderer?.invoke('labmedia:mediaAction', { action: 'next' })}
                style={previewControlStyle(false)}
                title="Next"
              >
                <CaretRight size={18} weight="bold" />
              </button>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: '13.5px', color: 'var(--text-secondary)' }}>
            No active media session detected. Start playing music or videos on Spotify, YouTube, or YouTube Music to view playback controls.
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={handleResetSettings}
          disabled={isBusy}
          style={{
            height: '38px',
            padding: '0 18px',
            borderRadius: '8px',
            border: '1px solid var(--border-color)',
            background: 'rgba(0, 0, 0, 0.2)',
            color: 'var(--text-secondary)',
            fontSize: '13px',
            fontWeight: 700,
            cursor: isBusy ? 'default' : 'pointer'
          }}
        >
          Reset to Defaults
        </button>

        <button
          type="button"
          onClick={handleRestartWidget}
          disabled={isBusy || !status.supported}
          style={{
            height: '38px',
            padding: '0 18px',
            borderRadius: '8px',
            border: 'none',
            background: 'linear-gradient(90deg, #1db954, #15803d)',
            color: '#fff',
            fontSize: '13px',
            fontWeight: 700,
            cursor: isBusy || !status.supported ? 'default' : 'pointer'
          }}
        >
          Restart Widget
        </button>
      </div>
    </div>
  );
}

function previewControlStyle(primary) {
  return {
    height: primary ? '38px' : '34px',
    width: primary ? '38px' : '34px',
    padding: 0,
    borderRadius: '50%',
    border: primary ? '1px solid #69e596' : '1px solid #73c9ff',
    background: primary ? '#1db954' : '#eaf7ff',
    color: primary ? '#fff' : '#46515c',
    boxShadow: '0 0 8px rgba(56, 189, 248, 0.3)',
    cursor: 'pointer',
    display: 'grid',
    placeItems: 'center'
  };
}

function ToggleOption({ label, checked, onChange, disabled }) {
  return (
    <label style={{
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      fontSize: '13px',
      color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
      cursor: disabled ? 'default' : 'pointer',
      padding: '8px 12px',
      borderRadius: '6px',
      background: 'rgba(0, 0, 0, 0.15)',
      border: '1px solid var(--border-color)'
    }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ cursor: disabled ? 'default' : 'pointer' }}
      />
      <span>{label}</span>
    </label>
  );
}
