import React, { useState, useEffect, useCallback } from 'react';
import AppIcon from '../AppIcon';
import LabMediaMark from '../LabMediaMark';
import { Play } from '@phosphor-icons/react/Play';
import { Pause } from '@phosphor-icons/react/Pause';
import { CaretLeft } from '@phosphor-icons/react/CaretLeft';
import { CaretRight } from '@phosphor-icons/react/CaretRight';
import { Palette } from '@phosphor-icons/react/Palette';
import { Sliders } from '@phosphor-icons/react/Sliders';
import { Clock } from '@phosphor-icons/react/Clock';
import { Bell } from '@phosphor-icons/react/Bell';
import { ClockCounterClockwise } from '@phosphor-icons/react/ClockCounterClockwise';
import { Sparkle } from '@phosphor-icons/react/Sparkle';
import { Copy } from '@phosphor-icons/react/Copy';
import { Check } from '@phosphor-icons/react/Check';
import { ArrowsOut } from '@phosphor-icons/react/ArrowsOut';

const ipcRenderer = window.electron?.ipcRenderer;

const THEME_STYLES = {
  spotify: { label: 'Spotify Green', bg: '#18181b', accent: '#1db954', border: '#27272a', text: '#f8fafc' },
  oled: { label: 'OLED Black', bg: '#000000', accent: '#10b981', border: '#18181b', text: '#ffffff' },
  neon: { label: 'Cyberpunk Neon', bg: '#0d0221', accent: '#00f5d4', border: '#7209b7', text: '#00f5d4' },
  glass: { label: 'Glassmorphism', bg: '#1a1a2e', accent: '#38bdf8', border: '#334155', text: '#f1f5f9' },
  minimal: { label: 'Minimalist', bg: '#111827', accent: '#9ca3af', border: '#1f2937', text: '#e5e7eb' },
  transparent: { label: 'Transparent Glass', bg: 'rgba(255, 255, 255, 0.04)', accent: '#38bdf8', border: 'rgba(255, 255, 255, 0.25)', text: '#ffffff' }
};

export default function LabMedia({ active = true }) {
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [isBusy, setIsBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [copiedId, setCopiedId] = useState(null);
  const [activeTab, setActiveTab] = useState('settings'); // 'settings' | 'history'

  const refreshStatus = useCallback(async () => {
    try {
      const res = await ipcRenderer?.invoke('labmedia:getStatus');
      setStatus(res || null);
    } catch (err) {
      console.error('Failed to get LabMedia status:', err);
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const res = await ipcRenderer?.invoke('labmedia:getHistory');
      setHistory(Array.isArray(res) ? res : []);
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    refreshStatus();
    refreshHistory();

    const handleStatusChanged = (_event, nextStatus) => {
      setStatus(nextStatus);
    };

    ipcRenderer?.on('labmedia:statusChanged', handleStatusChanged);
    const interval = setInterval(() => {
      refreshStatus();
      refreshHistory();
    }, 2000);

    return () => {
      ipcRenderer?.removeListener('labmedia:statusChanged', handleStatusChanged);
      clearInterval(interval);
    };
  }, [active, refreshStatus, refreshHistory]);

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

  const handleCopyTrack = async (item) => {
    const text = `${item.artist} - ${item.title}`;
    await ipcRenderer?.invoke('labmedia:copyTrackInfo', { text });
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  if (!status) {
    return (
      <div style={{ padding: '40px', color: 'var(--text-secondary)', fontFamily: 'Inter, sans-serif' }}>
        Loading LabMedia settings...
      </div>
    );
  }

  const settings = status.settings || {};
  const controls = settings.controls || {};
  const session = status.session || {};
  const themeObj = THEME_STYLES[settings.theme] || THEME_STYLES.spotify;

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
    <div className="labmedia-container" style={{ padding: '36px 40px', height: '100%', overflowY: 'auto', boxSizing: 'border-box', fontFamily: 'Inter, Segoe UI, sans-serif' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: 'rgba(29, 185, 84, 0.15)', display: 'grid', placeItems: 'center' }}>
            <AppIcon appId="labmedia" size={28} color="#1db954" />
          </div>
          <div>
            <h1 style={{ fontSize: '24px', margin: 0, color: 'var(--text-primary)', fontWeight: 800, letterSpacing: '-0.3px' }}>
              LabMedia
            </h1>
            <p style={{ fontSize: '13.5px', margin: '3px 0 0 0', color: 'var(--text-secondary)' }}>
              Taskbar media player for Spotify, YouTube, YouTube Music, and web browser audio.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{
            padding: '6px 14px',
            borderRadius: '999px',
            fontSize: '12px',
            fontWeight: 700,
            color: badge.color,
            background: badge.bg,
            border: `1px solid ${badge.color}40`
          }}>
            {badge.label}
          </span>
        </div>
      </div>

      {/* Tabs Header */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
        <button
          type="button"
          onClick={() => setActiveTab('settings')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 16px',
            borderRadius: '8px',
            border: 'none',
            background: activeTab === 'settings' ? 'rgba(29, 185, 84, 0.15)' : 'transparent',
            color: activeTab === 'settings' ? '#4ade80' : 'var(--text-secondary)',
            fontWeight: 700,
            fontSize: '13px',
            cursor: 'pointer'
          }}
        >
          <Sliders size={16} weight="bold" />
          Settings &amp; Layout
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('history')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 16px',
            borderRadius: '8px',
            border: 'none',
            background: activeTab === 'history' ? 'rgba(29, 185, 84, 0.15)' : 'transparent',
            color: activeTab === 'history' ? '#4ade80' : 'var(--text-secondary)',
            fontWeight: 700,
            fontSize: '13px',
            cursor: 'pointer'
          }}
        >
          <ClockCounterClockwise size={16} weight="bold" />
          Recently Played ({history.length})
        </button>
      </div>

      {actionError && (
        <div style={{ marginBottom: '20px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', fontSize: '13px' }}>
          {actionError}
        </div>
      )}

      {status.error && (
        <div style={{ marginBottom: '20px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', fontSize: '13px' }}>
          {status.error}
        </div>
      )}

      {!status.supported && (
        <div style={{ marginBottom: '20px', padding: '16px 20px', borderRadius: '10px', background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.3)', color: '#fde047', fontSize: '13.5px' }}>
          ⚠️ LabMedia requires Windows. It is unsupported on this platform.
        </div>
      )}

      {activeTab === 'settings' && (
        <>
          {/* Live Taskbar Widget Preview Card (#13) */}
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '20px', marginBottom: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <div style={{ fontSize: '12px', color: '#1db954', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Sparkle size={15} weight="bold" /> Live Taskbar Widget Preview
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                🔊 Scroll wheel over taskbar widget adjusts active app volume
              </div>
            </div>

            {/* Interactive Widget Surface Preview */}
            <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0', background: '#090a0f', borderRadius: '10px', border: '1px border-color' }}>
              <div style={{
                width: settings.size === 'micro' ? '140px' : settings.size === 'compact' ? '200px' : settings.size === 'large' ? '360px' : '280px',
                height: '40px',
                borderRadius: '8px',
                background: themeObj.bg,
                border: `1px solid ${themeObj.border}`,
                opacity: settings.opacity ?? 1,
                boxSizing: 'border-box',
                padding: '4px 8px',
                display: 'flex',
                alignItems: 'center',
                justify: 'space-between',
                position: 'relative',
                boxShadow: `0 0 12px ${themeObj.accent}30`,
                transition: 'all 0.25s ease'
              }}>
                {settings.showAlbumArt !== false && (
                  <div style={{ width: '30px', height: '30px', borderRadius: '5px', background: `${themeObj.accent}25`, display: 'grid', placeItems: 'center', flexShrink: 0, marginRight: '8px' }}>
                    <LabMediaMark size={18} />
                  </div>
                )}

                {settings.size !== 'micro' && (
                  <div style={{ flex: 1, minWidth: 0, marginRight: '8px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: themeObj.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {session.title || 'Kamel messoudi - Topic'}
                    </div>
                    <div style={{ fontSize: '9.5px', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '1px' }}>
                      {session.artist || 'YouTube Music'}
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                  {controls.previous && (
                    <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', display: 'grid', placeItems: 'center', color: '#fff' }}>
                      <CaretLeft size={12} weight="bold" />
                    </div>
                  )}
                  {controls.playPause && (
                    <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: themeObj.accent, display: 'grid', placeItems: 'center', color: '#fff', boxShadow: `0 0 6px ${themeObj.accent}` }}>
                      {session.isPlaying ? <Pause size={13} weight="bold" /> : <Play size={13} weight="bold" style={{ marginLeft: '1px' }} />}
                    </div>
                  )}
                  {controls.next && (
                    <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', display: 'grid', placeItems: 'center', color: '#fff' }}>
                      <CaretRight size={12} weight="bold" />
                    </div>
                  )}
                </div>

                {settings.showProgress !== false && (
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '3px', background: 'rgba(255,255,255,0.15)', borderRadius: '0 0 8px 8px', overflow: 'hidden' }}>
                    <div style={{ width: '45%', height: '100%', background: themeObj.accent, boxShadow: `0 0 6px ${themeObj.accent}` }} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Main Controls Card */}
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '24px', marginBottom: '24px' }}>
            {/* Enable Toggle */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '20px', borderBottom: '1px solid var(--border-color)' }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Enable Taskbar Player
                </div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  Displays floating playback widget directly inside your Windows taskbar.
                </div>
              </div>
              <ToggleSwitch checked={!!settings.enabled} onChange={handleToggleEnable} disabled={isBusy || !status.supported} />
            </div>

            {/* Size Selection (#7 Micro Lozenge Mode) */}
            <div style={{ padding: '20px 0', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <ArrowsOut size={16} /> Widget Size &amp; Layout
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                Choose width preset for your taskbar space.
              </div>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                {[
                  { id: 'micro', label: 'Micro (140px)', desc: 'Lozenge mode (art + controls)' },
                  { id: 'compact', label: 'Compact (200px)', desc: 'Tight taskbar' },
                  { id: 'normal', label: 'Normal (280px)', desc: 'Standard layout' },
                  { id: 'large', label: 'Large (360px)', desc: 'Full details' }
                ].map(sizeOpt => {
                  const activeSize = (settings.size || 'normal') === sizeOpt.id;
                  return (
                    <button
                      key={sizeOpt.id}
                      type="button"
                      onClick={() => handleUpdateSetting('size', sizeOpt.id)}
                      disabled={!settings.enabled}
                      style={{
                        height: '36px',
                        padding: '0 16px',
                        borderRadius: '8px',
                        border: activeSize ? '1.5px solid #1db954' : '1px solid var(--border-color)',
                        background: activeSize ? 'rgba(29, 185, 84, 0.2)' : 'rgba(0, 0, 0, 0.2)',
                        color: activeSize ? '#4ade80' : 'var(--text-secondary)',
                        fontWeight: 700,
                        fontSize: '12.5px',
                        cursor: settings.enabled ? 'pointer' : 'default'
                      }}
                    >
                      {sizeOpt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Custom Preset Themes (#16) */}
            <div style={{ padding: '20px 0', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Palette size={16} /> Theme Presets
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
                Select visual style for taskbar player surface.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px' }}>
                {Object.entries(THEME_STYLES).map(([id, theme]) => {
                  const active = (settings.theme || 'spotify') === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => handleUpdateSetting('theme', id)}
                      disabled={!settings.enabled}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        padding: '10px 12px',
                        borderRadius: '10px',
                        border: active ? `2px solid ${theme.accent}` : '1px solid var(--border-color)',
                        background: active ? `${theme.accent}15` : 'rgba(0, 0, 0, 0.25)',
                        color: active ? '#ffffff' : 'var(--text-secondary)',
                        fontWeight: 700,
                        fontSize: '12.5px',
                        cursor: settings.enabled ? 'pointer' : 'default',
                        textAlign: 'left'
                      }}
                    >
                      <div style={{ height: '16px', borderRadius: '4px', background: theme.bg, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', padding: '0 4px' }}>
                        <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: theme.accent }} />
                      </div>
                      <span>{theme.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Auto-Hide Settings */}
            <div style={{ padding: '20px 0', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Clock size={16} /> Auto-Hide Behavior
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
                Controls whether the taskbar widget auto-hides when media playback stops.
              </div>

              <div style={{ marginBottom: '16px' }}>
                <ToggleRow
                  label="Auto-Hide Widget When Idle"
                  checked={!!settings.autoHideWhenIdle}
                  onChange={(val) => handleUpdateSetting('autoHideWhenIdle', val)}
                  disabled={!settings.enabled}
                />
              </div>

              {settings.autoHideWhenIdle ? (
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                    Grace Period Before Hiding:
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {[0, 5, 15, 30].map(sec => {
                      const active = (settings.autoHideGraceSec ?? 0) === sec;
                      return (
                        <button
                          key={sec}
                          type="button"
                          onClick={() => handleUpdateSetting('autoHideGraceSec', sec)}
                          disabled={!settings.enabled}
                          style={{
                            height: '34px',
                            padding: '0 16px',
                            borderRadius: '6px',
                            border: active ? '1.5px solid #1db954' : '1px solid var(--border-color)',
                            background: active ? 'rgba(29, 185, 84, 0.2)' : 'rgba(0, 0, 0, 0.2)',
                            color: active ? '#4ade80' : 'var(--text-secondary)',
                            fontWeight: 700,
                            fontSize: '12.5px',
                            cursor: settings.enabled ? 'pointer' : 'default'
                          }}
                        >
                          {sec === 0 ? 'Instant (0s)' : `${sec} seconds`}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div style={{
                  padding: '10px 14px',
                  borderRadius: '8px',
                  background: 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid rgba(16, 185, 129, 0.25)',
                  fontSize: '12.5px',
                  color: '#34d399',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Check size={16} /> Widget is Always Visible on Taskbar (Does not auto-hide when idle).
                </div>
              )}
            </div>

            {/* Opacity Slider */}
            <div style={{ padding: '20px 0', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <div style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Widget Opacity
                </div>
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#1db954' }}>
                  {Math.round((settings.opacity ?? 1) * 100)}%
                </span>
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

            {/* UI Element Toggles & Toast Notifications (#14 Custom Switches, #19 Notifications) */}
            <div style={{ padding: '20px 0 0 0' }}>
              <div style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '14px' }}>
                Feature &amp; UI Toggles
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' }}>
                <ToggleRow label="Album Art Thumbnail" checked={!!settings.showAlbumArt} onChange={(val) => handleUpdateSetting('showAlbumArt', val)} disabled={!settings.enabled} />
                <ToggleRow label="Progress Bar Line" checked={!!settings.showProgress} onChange={(val) => handleUpdateSetting('showProgress', val)} disabled={!settings.enabled} />
                <ToggleRow label="Previous Button" checked={!!controls.previous} onChange={(val) => handleUpdateControl('previous', val)} disabled={!settings.enabled} />
                <ToggleRow label="Play/Pause Button" checked={!!controls.playPause} onChange={(val) => handleUpdateControl('playPause', val)} disabled={!settings.enabled} />
                <ToggleRow label="Next Button" checked={!!controls.next} onChange={(val) => handleUpdateControl('next', val)} disabled={!settings.enabled} />
                <ToggleRow label="Hide in Fullscreen" checked={!!settings.hideWhenFullscreen} onChange={(val) => handleUpdateSetting('hideWhenFullscreen', val)} disabled={!settings.enabled} />
                <ToggleRow label="Now Playing Toast" checked={!!settings.showToastNotifications} onChange={(val) => handleUpdateSetting('showToastNotifications', val)} disabled={!settings.enabled} icon={<Bell size={14} />} />
              </div>
            </div>
          </div>
        </>
      )}

      {/* History Log Tab (#21) */}
      {activeTab === 'history' && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '24px', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Recently Played Tracks
            </div>
            <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
              Rolling log of the last 50 played tracks
            </div>
          </div>

          {history.length === 0 ? (
            <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13.5px' }}>
              No playback history recorded yet. Start listening on Spotify, YouTube, or browser media tabs!
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {history.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'rgba(0, 0, 0, 0.2)',
                    border: '1px solid var(--border-color)'
                  }}
                >
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {item.title}
                    </div>
                    <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>{item.artist}</span>
                      <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: 'rgba(29, 185, 84, 0.15)', color: '#4ade80', fontWeight: 700 }}>
                        {item.sourceApp}
                      </span>
                      <span>• {item.timestamp}</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleCopyTrack(item)}
                    style={{
                      height: '32px',
                      padding: '0 12px',
                      borderRadius: '6px',
                      border: '1px solid var(--border-color)',
                      background: copiedId === item.id ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                      color: copiedId === item.id ? '#4ade80' : 'var(--text-secondary)',
                      fontSize: '12px',
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    {copiedId === item.id ? <Check size={14} weight="bold" /> : <Copy size={14} />}
                    {copiedId === item.id ? 'Copied' : 'Copy'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
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

function ToggleSwitch({ checked, onChange, disabled }) {
  return (
    <div
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: '42px',
        height: '24px',
        borderRadius: '12px',
        background: checked ? '#1db954' : 'rgba(255, 255, 255, 0.15)',
        position: 'relative',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background 0.2s ease',
        flexShrink: 0
      }}
    >
      <div
        style={{
          width: '18px',
          height: '18px',
          borderRadius: '50%',
          background: '#ffffff',
          position: 'absolute',
          top: '3px',
          left: checked ? '21px' : '3px',
          transition: 'left 0.2s ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)'
        }}
      />
    </div>
  );
}

function ToggleRow({ label, checked, onChange, disabled, icon }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 12px',
      borderRadius: '8px',
      background: 'rgba(0, 0, 0, 0.15)',
      border: '1px solid var(--border-color)'
    }}>
      <span style={{ fontSize: '13px', color: disabled ? 'var(--text-muted)' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        {icon}
        {label}
      </span>
      <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}
