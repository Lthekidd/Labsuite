import React, { useCallback, useEffect, useState } from 'react';
import AppIcon from '../AppIcon';
import LabMediaMark from '../LabMediaMark';
import { Play } from '@phosphor-icons/react/Play';
import { Pause } from '@phosphor-icons/react/Pause';
import { CaretLeft } from '@phosphor-icons/react/CaretLeft';
import { CaretRight } from '@phosphor-icons/react/CaretRight';
import { Sliders } from '@phosphor-icons/react/Sliders';
import { Bell } from '@phosphor-icons/react/Bell';
import { ClockCounterClockwise } from '@phosphor-icons/react/ClockCounterClockwise';
import { Sparkle } from '@phosphor-icons/react/Sparkle';
import { Copy } from '@phosphor-icons/react/Copy';
import { Check } from '@phosphor-icons/react/Check';

const ipcRenderer = window.electron?.ipcRenderer;

const THEME_STYLES = {
  spotify: { label: 'Spotify Green', bg: '#18181b', accent: '#1db954', border: '#27272a', text: '#f8fafc' },
  oled: { label: 'OLED Black', bg: '#000000', accent: '#10b981', border: '#18181b', text: '#ffffff' },
  neon: { label: 'Cyberpunk Neon', bg: '#0d0221', accent: '#00f5d4', border: '#7209b7', text: '#00f5d4' },
  glass: { label: 'Glassmorphism', bg: '#1a1a2e', accent: '#38bdf8', border: '#334155', text: '#f1f5f9' },
  minimal: { label: 'Minimalist', bg: '#111827', accent: '#9ca3af', border: '#1f2937', text: '#e5e7eb' },
  transparent: { label: 'Transparent Glass', bg: 'rgba(255,255,255,.04)', accent: '#38bdf8', border: 'rgba(255,255,255,.25)', text: '#fff' }
};

const SIZE_OPTIONS = [
  { id: 'micro', label: 'Micro', width: 140, description: 'Artwork, play/pause, progress' },
  { id: 'compact', label: 'Compact', width: 200, description: 'Artwork, title, play/pause' },
  { id: 'normal', label: 'Normal', width: 280, description: 'Two-line metadata and adaptive controls' },
  { id: 'large', label: 'Large', width: 360, description: 'Full transport controls' }
];

const CONTROL_MODES = [
  { id: 'adaptive', label: 'Adaptive', description: 'Secondary controls appear only when space or hover allows.' },
  { id: 'always', label: 'Always visible', description: 'Show configured previous and next buttons at every size.' },
  { id: 'minimal', label: 'Minimal', description: 'Keep only play/pause in the taskbar strip.' }
];

export default function LabMedia({ active = true }) {
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [isBusy, setIsBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [copiedId, setCopiedId] = useState(null);
  const [activeTab, setActiveTab] = useState('taskbar');
  const [previewMode, setPreviewMode] = useState('collapsed');

  const refreshStatus = useCallback(async () => {
    try {
      const result = await ipcRenderer?.invoke('labmedia:getStatus');
      setStatus(result || null);
    } catch (error) {
      console.error('Failed to get LabMedia status:', error);
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const result = await ipcRenderer?.invoke('labmedia:getHistory');
      setHistory(Array.isArray(result) ? result : []);
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    refreshStatus();
    refreshHistory();
    const handleStatus = (_event, nextStatus) => setStatus(nextStatus);
    ipcRenderer?.on('labmedia:statusChanged', handleStatus);
    const interval = setInterval(() => {
      refreshStatus();
      refreshHistory();
    }, 2000);
    return () => {
      ipcRenderer?.removeListener('labmedia:statusChanged', handleStatus);
      clearInterval(interval);
    };
  }, [active, refreshHistory, refreshStatus]);

  const invokeAndSetStatus = async (channel, payload, fallbackMessage) => {
    try {
      setActionError('');
      const result = await ipcRenderer?.invoke(channel, payload);
      setStatus(result || null);
      return result;
    } catch (error) {
      setActionError(error.message || fallbackMessage);
      return null;
    }
  };

  const updateSetting = (key, value) => invokeAndSetStatus(
    'labmedia:updateSettings',
    { updates: { [key]: value } },
    'Failed to update LabMedia setting'
  );

  const updateControl = (key, value) => invokeAndSetStatus(
    'labmedia:updateSettings',
    { updates: { controls: { ...(status?.settings?.controls || {}), [key]: value } } },
    'Failed to update taskbar control'
  );

  const toggleEnabled = async () => {
    setIsBusy(true);
    await invokeAndSetStatus(
      'labmedia:setEnabled',
      { enabled: !status?.settings?.enabled },
      'Failed to toggle LabMedia'
    );
    setIsBusy(false);
  };

  const restartWidget = async () => {
    setIsBusy(true);
    await invokeAndSetStatus('labmedia:restart', undefined, 'Failed to restart LabMedia');
    setIsBusy(false);
  };

  const resetSettings = async () => {
    if (!window.confirm('Reset LabMedia settings to defaults?')) return;
    setIsBusy(true);
    await invokeAndSetStatus('labmedia:resetSettings', undefined, 'Failed to reset LabMedia');
    setIsBusy(false);
  };

  const youtubeAction = async (action) => {
    if (action === 'disconnect' && !window.confirm('Disconnect YouTube from LabMedia? This removes the LabMedia grant but does not delete anything from YouTube.')) return;
    const channels = {
      connect: 'labmedia:youtubeConnect',
      reconnect: 'labmedia:youtubeReconnect',
      disconnect: 'labmedia:youtubeDisconnect',
      refresh: 'labmedia:youtubeRefresh',
      setup: 'labmedia:openYouTubeOAuthSettings'
    };
    const channel = channels[action];
    if (!channel) return;
    setIsBusy(true);
    await invokeAndSetStatus(channel, undefined, `Failed to ${action} YouTube`);
    setIsBusy(false);
  };

  const ytmdAction = async (action) => {
    if (action === 'install' && !window.confirm('Check for the bundled GPL-licensed YTmusic build?')) return;
    if (action === 'forget' && !window.confirm('Forget LabMedia’s YTmusic token? To revoke it inside YTmusic too, remove LabSuite from its Authorized companions list.')) return;
    const channels = {
      install: 'labmedia:ytmdInstall',
      launch: 'labmedia:ytmdLaunch',
      open: 'labmedia:ytmdLaunch',
      pair: 'labmedia:ytmdPair',
      reconnect: 'labmedia:ytmdReconnect',
      forget: 'labmedia:ytmdForget',
      refresh: 'labmedia:ytmdRefresh'
    };
    const channel = channels[action];
    if (!channel) return;
    setIsBusy(true);
    await invokeAndSetStatus(channel, undefined, `Failed to ${action} YTmusic`);
    setIsBusy(false);
  };

  const copyTrack = async (item) => {
    await ipcRenderer?.invoke('labmedia:copyTrackInfo', { text: `${item.artist} - ${item.title}` });
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  if (!status) {
    return <div style={{ padding: 40, color: 'var(--text-secondary)' }}>Loading LabMedia settings…</div>;
  }

  const settings = status.settings || {};
  const controls = settings.controls || {};
  const session = status.session || {};
  const queue = status.queue || {};
  const youtube = status.youtubeLibrary || {};
  const ytmd = status.ytmDesktop || {};
  const theme = THEME_STYLES[settings.theme] || THEME_STYLES.spotify;
  const badge = statusBadge(status.state);

  const selectTab = (tab) => {
    setActiveTab(tab);
    if (tab === 'taskbar') setPreviewMode('collapsed');
    if (tab === 'panel') setPreviewMode('expanded');
  };

  return (
    <div className="labmedia-container" style={{ padding: '32px 40px 48px', height: '100%', overflowY: 'auto', boxSizing: 'border-box', fontFamily: 'Inter, Segoe UI, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 13, background: 'rgba(29,185,84,.14)', display: 'grid', placeItems: 'center' }}>
            <AppIcon appId="labmedia" size={28} color="#1db954" />
          </div>
          <div>
            <h1 style={{ fontSize: 24, margin: 0, color: 'var(--text-primary)', fontWeight: 800 }}>LabMedia</h1>
            <p style={{ fontSize: 13.5, margin: '3px 0 0', color: 'var(--text-secondary)' }}>
              A calm taskbar controller with details on demand.
            </p>
          </div>
        </div>
        <span style={{ padding: '6px 13px', borderRadius: 999, fontSize: 12, fontWeight: 700, color: badge.color, background: badge.bg, border: `1px solid ${badge.color}40` }}>
          {badge.label}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 7, borderBottom: '1px solid var(--border-color)', paddingBottom: 11, marginBottom: 20 }}>
        <TabButton active={activeTab === 'taskbar'} onClick={() => selectTab('taskbar')} icon={<Sliders size={16} />} label="Taskbar" />
        <TabButton active={activeTab === 'panel'} onClick={() => selectTab('panel')} icon={<Sparkle size={16} />} label="Expanded Panel" />
        <TabButton active={activeTab === 'history'} onClick={() => selectTab('history')} icon={<ClockCounterClockwise size={16} />} label={`History (${history.length})`} />
      </div>

      {actionError && <Notice color="#ef4444">{actionError}</Notice>}
      {status.error && <Notice color="#ef4444">{status.error}</Notice>}
      {!status.supported && <Notice color="#eab308">LabMedia requires Windows.</Notice>}

      {activeTab !== 'history' && (
        <SectionCard>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: theme.accent, fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.55px' }}>
              <Sparkle size={15} weight="bold" /> Interactive Preview
            </div>
            <Segmented
              value={previewMode}
              options={[{ id: 'collapsed', label: 'Collapsed' }, { id: 'expanded', label: 'Expanded' }]}
              onChange={setPreviewMode}
              compact
            />
          </div>
          <div style={{ minHeight: previewMode === 'expanded' ? 510 : 92, padding: 18, borderRadius: 11, border: '1px solid var(--border-color)', background: '#090a0f', display: 'grid', placeItems: 'center' }}>
            {previewMode === 'collapsed'
              ? <TaskbarPreview settings={settings} controls={controls} session={session} theme={theme} />
              : <PanelPreview session={session} queue={queue} theme={theme} />}
          </div>
        </SectionCard>
      )}

      {activeTab === 'taskbar' && (
        <>
          <SectionCard title="Taskbar Controller" description="Configure the glanceable 40px strip. The expanded player remains fully functional regardless of this density.">
            <SettingRow title="Enable Taskbar Player" description="Keep LabMedia available in the Windows taskbar.">
              <ToggleSwitch checked={!!settings.enabled} onChange={toggleEnabled} disabled={isBusy || !status.supported} />
            </SettingRow>

            <SettingBlock title="Primary click" description="Choose what artwork and track text do when clicked.">
              <Segmented
                value={settings.primaryClickAction || 'panel'}
                options={[{ id: 'panel', label: 'Open panel' }, { id: 'openSource', label: 'Open source app' }]}
                onChange={(value) => updateSetting('primaryClickAction', value)}
                disabled={!settings.enabled}
              />
            </SettingBlock>

            <SettingBlock title="Widget size" description="Each size has a deliberate information hierarchy; the height always stays at 40px.">
              <ChoiceGrid
                value={settings.size || 'normal'}
                options={SIZE_OPTIONS}
                onChange={(value) => updateSetting('size', value)}
                disabled={!settings.enabled}
              />
            </SettingBlock>

            <SettingBlock title="Control density" description="Adaptive mode keeps the strip calm while retaining fast playback access.">
              <ChoiceGrid
                value={settings.taskbarControlMode || 'adaptive'}
                options={CONTROL_MODES}
                onChange={(value) => updateSetting('taskbarControlMode', value)}
                disabled={!settings.enabled}
              />
            </SettingBlock>

            <SettingBlock title="Taskbar elements" description="These switches affect only the collapsed strip, not the expanded player.">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
                <ToggleRow label="Album artwork" checked={!!settings.showAlbumArt} onChange={(value) => updateSetting('showAlbumArt', value)} disabled={!settings.enabled} />
                <ToggleRow label="Progress line" checked={!!settings.showProgress} onChange={(value) => updateSetting('showProgress', value)} disabled={!settings.enabled} />
                <ToggleRow label="Previous button" checked={!!controls.previous} onChange={(value) => updateControl('previous', value)} disabled={!settings.enabled} />
                <ToggleRow label="Play/pause button" checked={!!controls.playPause} onChange={(value) => updateControl('playPause', value)} disabled={!settings.enabled} />
                <ToggleRow label="Next button" checked={!!controls.next} onChange={(value) => updateControl('next', value)} disabled={!settings.enabled} />
                <ToggleRow label="Hide in fullscreen" checked={!!settings.hideWhenFullscreen} onChange={(value) => updateSetting('hideWhenFullscreen', value)} disabled={!settings.enabled} />
              </div>
            </SettingBlock>

            <SettingBlock title="Idle behavior" description="Keep the controller docked, or hide it after media sessions stop.">
              <ToggleRow label="Auto-hide when idle" checked={!!settings.autoHideWhenIdle} onChange={(value) => updateSetting('autoHideWhenIdle', value)} disabled={!settings.enabled} />
              {settings.autoHideWhenIdle && (
                <div style={{ marginTop: 10 }}>
                  <Segmented
                    value={String(settings.autoHideGraceSec ?? 0)}
                    options={[0, 5, 15, 30].map((seconds) => ({ id: String(seconds), label: seconds ? `${seconds}s` : 'Instant' }))}
                    onChange={(value) => updateSetting('autoHideGraceSec', Number(value))}
                    disabled={!settings.enabled}
                  />
                </div>
              )}
            </SettingBlock>
          </SectionCard>

          <SectionCard title="Appearance" description="Existing visual presets remain available; this redesign changes behavior and hierarchy rather than replacing themes.">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(135px,1fr))', gap: 9, marginBottom: 18 }}>
              {Object.entries(THEME_STYLES).map(([id, item]) => (
                <button key={id} type="button" onClick={() => updateSetting('theme', id)} disabled={!settings.enabled}
                  style={{ padding: 10, borderRadius: 9, border: settings.theme === id ? `2px solid ${item.accent}` : '1px solid var(--border-color)', background: settings.theme === id ? `${item.accent}14` : 'rgba(0,0,0,.18)', color: settings.theme === id ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: settings.enabled ? 'pointer' : 'default', textAlign: 'left', fontWeight: 700 }}>
                  <div style={{ height: 15, borderRadius: 4, background: item.bg, border: `1px solid ${item.border}`, marginBottom: 7, padding: '0 4px', display: 'flex', alignItems: 'center' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: item.accent }} />
                  </div>
                  {item.label}
                </button>
              ))}
            </div>
            <SettingRow title="Widget opacity" description="Applies to the collapsed taskbar surface.">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 240 }}>
                <input type="range" min="0.4" max="1" step="0.05" value={settings.opacity ?? 1} disabled={!settings.enabled}
                  onChange={(event) => updateSetting('opacity', Number(event.target.value))} style={{ flex: 1 }} />
                <span style={{ color: theme.accent, fontWeight: 800, width: 42 }}>{Math.round((settings.opacity ?? 1) * 100)}%</span>
              </div>
            </SettingRow>
          </SectionCard>
        </>
      )}

      {activeTab === 'panel' && (
        <>
          <SectionCard title="Expanded Now Playing" description="A native flyout anchored above LabMedia. It takes focus only while you interact with it and closes like a standard Windows flyout.">
            <InfoGrid items={[
              ['Open', settings.primaryClickAction === 'panel' ? 'Click artwork or track text' : 'Switch Primary click to Open panel'],
              ['Dismiss', 'Outside click, Escape, fullscreen, taskbar auto-hide'],
              ['Playback', 'Timeline, transport, shuffle, repeat, app volume and mute'],
              ['Players', 'Explicit selector when multiple media sessions are open']
            ]} />
            <div style={{ marginTop: 14 }}>
              <ToggleRow label="Now Playing notifications" icon={<Bell size={14} />} checked={!!settings.showToastNotifications}
                onChange={(value) => updateSetting('showToastNotifications', value)} disabled={!settings.enabled} />
            </div>
          </SectionCard>

          <SectionCard title="Up Next" description="Queue data is provider-controlled and is never fabricated from history or open browser sessions.">
            <QueueCapability state={queue} />
            <p style={{ margin: '12px 0 0', color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.55 }}>
              Spotify support is capability-gated for public builds. Authentication and refresh tokens remain in LabSuite’s main process; the native panel receives only sanitized, read-only queue items.
            </p>
          </SectionCard>

      <SectionCard title="YTmusic" description="A community-maintained, hardened fork of YTMDesktop that provides live YouTube Music playback, queue data, and richer controls.">
            <YTMDesktopConnection state={ytmd} busy={isBusy} onAction={ytmdAction} />
            <p style={{ margin: '12px 0 0', color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.55 }}>
              YTmusic is a fork of YTMDesktop, not an official LabSuite or Google product. LabMedia accepts only its <code>labsuite-hardened-v1</code> service on <code>127.0.0.1:9863</code>; browser-origin requests, network clients, and unreviewed upstream builds are rejected.
            </p>
          </SectionCard>

          <SectionCard title="YouTube Library" description="Browse owned playlists and Liked Music from the flyout, then hand playback to YouTube Music.">
            <YouTubeConnection state={youtube} busy={isBusy} onAction={youtubeAction} />
            <div style={{ marginTop: 16 }}>
              <SettingBlock title="Browser fallback" description="If YTmusic is not connected, choose which browser app window should play playlists or tracks.">
                <ChoiceGrid
                  value={settings.youtubePlaybackApp || 'auto'}
                  disabled={!settings.enabled}
                  onChange={(val) => updateSetting('youtubePlaybackApp', val)}
                  options={[
                    { id: 'auto', label: 'Automatic', description: 'Prefer Edge, then Chrome, only when YTmusic is unavailable.' },
                    { id: 'edge', label: 'Microsoft Edge', description: 'Use an Edge app window as the fallback.' },
                    { id: 'chrome', label: 'Google Chrome', description: 'Use a Chrome app window as the fallback.' }
                  ]}
                />
              </SettingBlock>
              <div style={{ marginTop: 12 }}>
                <ToggleRow
                  label="Start YouTube Music app window minimized to taskbar"
                  checked={settings.youtubeAppMinimized !== false}
                  onChange={(val) => updateSetting('youtubeAppMinimized', val)}
                  disabled={!settings.enabled}
                />
              </div>
            </div>
            <p style={{ margin: '12px 0 0', color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.55 }}>
              LabMedia uses a separate read-only YouTube grant for the same Gmail account as Drive. It does not reuse or modify the Drive token, and playlist content is kept only in memory.
            </p>
          </SectionCard>
        </>
      )}

      {activeTab === 'history' && (
        <SectionCard title="Recently Played" description="A rolling session log of the last 50 tracks. History is never presented as an upcoming queue.">
          {history.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13.5 }}>No playback history recorded yet.</div>
          ) : history.map((item) => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 13px', borderRadius: 9, background: 'rgba(0,0,0,.18)', border: '1px solid var(--border-color)', marginBottom: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: 'var(--text-primary)', fontSize: 13.5, fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 3 }}>{item.artist} · {item.sourceApp} · {item.timestamp}</div>
              </div>
              <button type="button" onClick={() => copyTrack(item)} style={smallButton(copiedId === item.id)}>
                {copiedId === item.id ? <Check size={14} /> : <Copy size={14} />}
                {copiedId === item.id ? 'Copied' : 'Copy'}
              </button>
            </div>
          ))}
        </SectionCard>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" onClick={resetSettings} disabled={isBusy} style={secondaryAction}>Reset defaults</button>
        <button type="button" onClick={restartWidget} disabled={isBusy || !status.supported} style={primaryAction}>Restart widget</button>
      </div>
    </div>
  );
}

function TaskbarPreview({ settings, controls, session, theme }) {
  const [hovered, setHovered] = useState(false);
  const size = SIZE_OPTIONS.find((item) => item.id === settings.size) || SIZE_OPTIONS[2];
  const mode = settings.taskbarControlMode || 'adaptive';
  const showInfo = size.id !== 'micro';
  const showArtist = size.id === 'normal' || size.id === 'large';
  const showSecondary = mode === 'always' || (mode === 'adaptive' && (size.id === 'large' || (size.id === 'normal' && hovered)));
  const reserveSecondary = mode === 'always' || (mode === 'adaptive' && (size.id === 'large' || size.id === 'normal'));
  const artSize = ['micro', 'compact'].includes(size.id) ? 28 : 32;
  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      title="Clicking artwork or track text opens Now Playing"
      style={{ width: size.width, height: 40, boxSizing: 'border-box', borderRadius: 8, background: theme.bg, border: `1px solid ${theme.border}`, opacity: settings.opacity ?? 1, display: 'flex', alignItems: 'center', padding: '3px 6px', position: 'relative', boxShadow: `0 8px 22px rgba(0,0,0,.4)` }}>
      {settings.showAlbumArt !== false && <div style={{ width: artSize, height: artSize, borderRadius: 5, flex: '0 0 auto', background: `${theme.accent}24`, display: 'grid', placeItems: 'center', marginRight: 8 }}><LabMediaMark size={16} /></div>}
      {showInfo && <div style={{ flex: 1, minWidth: 0, marginRight: 7 }}>
        <div style={{ color: theme.text, fontSize: 11, fontWeight: 750, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{session.title || 'Night Drive'}</div>
        {showArtist && <div style={{ color: '#8c98a7', fontSize: 9.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{session.artist || 'LabMedia Radio'}</div>}
      </div>}
      <div style={{ width: reserveSecondary ? 86 : 30, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, flex: '0 0 auto' }}>
        {reserveSecondary && controls.previous !== false && <span style={{ opacity: showSecondary ? 1 : 0, pointerEvents: showSecondary ? 'auto' : 'none' }}><RoundControl><CaretLeft size={12} weight="bold" /></RoundControl></span>}
        {controls.playPause !== false && <RoundControl primary color={theme.accent}>{session.isPlaying ? <Pause size={12} weight="bold" /> : <Play size={12} weight="bold" />}</RoundControl>}
        {reserveSecondary && controls.next !== false && <span style={{ opacity: showSecondary ? 1 : 0, pointerEvents: showSecondary ? 'auto' : 'none' }}><RoundControl><CaretRight size={12} weight="bold" /></RoundControl></span>}
      </div>
      {settings.showProgress !== false && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, borderRadius: '0 0 8px 8px', background: 'rgba(255,255,255,.12)', overflow: 'hidden' }}><div style={{ width: '44%', height: '100%', background: theme.accent }} /></div>}
    </div>
  );
}

function PanelPreview({ session, queue, theme }) {
  const queueReady = queue.status === 'ready' && Array.isArray(queue.items) && queue.items.length > 0;
  return (
    <div style={{ width: 384, maxWidth: '100%', boxSizing: 'border-box', borderRadius: 16, padding: 18, background: theme.bg, border: `1px solid ${theme.border}`, boxShadow: '0 20px 45px rgba(0,0,0,.58)', color: theme.text }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, padding: 3, borderRadius: 8, background: 'rgba(255,255,255,.04)', marginBottom: 12, fontSize: 11, fontWeight: 750, textAlign: 'center' }}>
        <span style={{ padding: 6, borderRadius: 6, background: `${theme.accent}22`, color: theme.accent }}>Now Playing</span>
        <span style={{ padding: 6, color: '#8c98a7' }}>Library</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ padding: '5px 9px', borderRadius: 10, background: `${theme.accent}20`, color: theme.accent, fontSize: 11, fontWeight: 800 }}>{session.sourceApp || 'Media Player'}</span>
        <span style={{ marginLeft: 9, color: '#8c98a7', fontSize: 11, flex: 1 }}>{session.sessionCount > 1 ? `${session.sessionCount} players available` : 'Now playing'}</span>
        <span style={{ color: '#8c98a7', letterSpacing: 2 }}>•••</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: 12, alignItems: 'center' }}>
        <div style={{ width: 88, height: 88, borderRadius: 10, background: `${theme.accent}20`, display: 'grid', placeItems: 'center' }}><LabMediaMark size={38} /></div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 17, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.title || 'Night Drive'}</div>
          <div style={{ color: '#a7b0bc', fontSize: 12, marginTop: 4 }}>{session.artist || 'LabMedia Radio'}</div>
          <div style={{ color: '#707b88', fontSize: 11, marginTop: 2 }}>{session.album || 'Now Playing'}</div>
          <div style={{ display: 'flex', gap: 7, marginTop: 10 }}><MiniPill>Open source ↗</MiniPill><MiniPill>Copy</MiniPill></div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <div style={{ height: 4, borderRadius: 4, background: 'rgba(255,255,255,.13)' }}><div style={{ width: '43%', height: '100%', borderRadius: 4, background: theme.accent }} /></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#7c8794', fontSize: 10, marginTop: 5 }}><span>1:42</span><span>3:58</span></div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', margin: '8px 22px 14px' }}>
        <RoundControl>SH</RoundControl><RoundControl><CaretLeft size={14} /></RoundControl><RoundControl primary color={theme.accent} large>{session.isPlaying ? <Pause size={16} /> : <Play size={16} />}</RoundControl><RoundControl><CaretRight size={14} /></RoundControl><RoundControl>RP</RoundControl>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}><span style={{ fontSize: 10, fontWeight: 800 }}>VOL</span><div style={{ flex: 1, height: 4, borderRadius: 4, background: 'rgba(255,255,255,.13)' }}><div style={{ width: '72%', height: '100%', borderRadius: 4, background: theme.accent }} /></div><span style={{ color: '#a7b0bc', fontSize: 11 }}>72%</span></div>
      <div style={{ borderTop: '1px solid rgba(255,255,255,.1)', paddingTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>Up Next</div>
        {queueReady ? queue.items.slice(0, 3).map((item) => <div key={item.id} style={{ padding: '7px 9px', background: 'rgba(255,255,255,.04)', borderRadius: 7, marginBottom: 5, fontSize: 11 }}>{item.title} <span style={{ color: '#7c8794' }}>· {item.artist}</span></div>)
          : <div style={{ padding: 12, borderRadius: 9, border: '1px solid rgba(255,255,255,.09)', color: '#98a3b1', fontSize: 11 }}>{queue.message || 'Up Next is not shared by this player.'}</div>}
      </div>
    </div>
  );
}

function QueueCapability({ state = {} }) {
  const labels = { unavailable: 'Unavailable', requiresAuth: 'Connection required', loading: 'Loading', ready: 'Available', empty: 'Queue empty', error: 'Provider error' };
  const color = state.status === 'ready' ? '#34d399' : state.status === 'error' ? '#f87171' : '#94a3b8';
  return <div style={{ padding: 13, borderRadius: 9, border: `1px solid ${color}40`, background: `${color}10` }}>
    <div style={{ color, fontWeight: 800, fontSize: 12 }}>{labels[state.status] || 'Unavailable'}{state.attribution ? ` · ${state.attribution}` : ''}</div>
    <div style={{ color: 'var(--text-secondary)', fontSize: 12.5, marginTop: 4 }}>{state.message || 'Up Next is not shared by this player.'}</div>
  </div>;
}

function YTMDesktopConnection({ state = {}, busy, onAction }) {
  const labels = {
    notInstalled: 'Not installed',
    starting: 'Starting…',
    stopped: 'Installed · Not running',
    serverDisabled: 'Companion server disabled',
    requiresPairing: 'Pairing required',
    pairing: 'Waiting for approval',
    connected: state.active ? 'Connected · Active player' : 'Connected',
    reauthRequired: 'Pair again',
    incompatible: 'Incompatible API',
    error: 'Connection interrupted'
  };
  const healthy = state.status === 'connected';
  const warning = ['notInstalled', 'starting', 'stopped', 'serverDisabled', 'requiresPairing', 'pairing'].includes(state.status);
  const color = healthy ? '#34d399' : warning ? '#fbbf24' : '#f87171';
  return <div style={{ padding: 14, borderRadius: 10, border: `1px solid ${color}40`, background: `${color}0c` }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ color, fontWeight: 800, fontSize: 12 }}>{labels[state.status] || 'Unavailable'}</div>
        <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 700, marginTop: 4, lineHeight: 1.4 }}>
          {state.message || 'YTmusic status is unavailable.'}
        </div>
        {state.pairingCode && <div aria-live="polite" style={{ marginTop: 9, fontSize: 22, fontWeight: 900, letterSpacing: 6, color: '#f8fafc' }}>
          {state.pairingCode}
        </div>}
        {state.installing && <div aria-live="polite" style={{ color: 'var(--text-secondary)', fontSize: 11.5, marginTop: 6 }}>
          {state.installProgress || 'Installing…'}
        </div>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 7, maxWidth: 330 }}>
        {state.status === 'notInstalled' && <button type="button" disabled={busy || state.installing} onClick={() => onAction('install')} style={primaryAction}>Check installation</button>}
        {state.status === 'stopped' && <button type="button" disabled={busy} onClick={() => onAction('launch')} style={primaryAction}>Start YTmusic</button>}
        {['serverDisabled', 'requiresPairing', 'reauthRequired'].includes(state.status) && <button type="button" disabled={busy} onClick={() => onAction('pair')} style={primaryAction}>Connect YTmusic</button>}
        {['connected', 'error'].includes(state.status) && <button type="button" disabled={busy} onClick={() => onAction(state.status === 'connected' ? 'open' : 'reconnect')} style={primaryAction}>{state.status === 'connected' ? 'Open YTmusic' : 'Reconnect'}</button>}
        {!['notInstalled', 'starting', 'pairing'].includes(state.status) && <button type="button" disabled={busy} onClick={() => onAction('refresh')} style={secondaryAction}>Refresh status</button>}
        {(state.paired || state.status === 'reauthRequired') && <button type="button" disabled={busy} onClick={() => onAction('forget')} style={secondaryAction}>Forget connection</button>}
      </div>
    </div>
    {['serverDisabled', 'requiresPairing', 'reauthRequired'].includes(state.status) && <div style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5, marginTop: 10 }}>
      Connect starts YTmusic, enables its loopback companion service for approval, and opens a one-time authorization window. Confirm the matching code in YTmusic; approval closes automatically.
    </div>}
    {healthy && <div style={{ color: 'var(--text-secondary)', fontSize: 11.5, marginTop: 8 }}>
      YTmusic does not expose the signed-in Gmail address to LabSuite, so confirm it uses the same account as the optional YouTube Library connection.
    </div>}
  </div>;
}

function YouTubeConnection({ state = {}, busy, onAction }) {
  const connection = state.connection || {};
  const library = state.library || {};
  const labels = {
    requiresSetup: 'Setup required', requiresAuth: 'Not connected', connecting: 'Connecting…',
    connected: 'Connected', reauthRequired: 'Reconnect required', error: 'Connection error'
  };
  const connected = connection.status === 'connected';
  const color = connected ? '#34d399' : connection.status === 'error' || connection.status === 'reauthRequired' ? '#f87171' : '#fbbf24';
  return <div style={{ padding: 14, borderRadius: 10, border: `1px solid ${color}40`, background: `${color}0c` }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ color, fontWeight: 800, fontSize: 12 }}>{labels[connection.status] || 'Setup required'}</div>
        <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 700, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {connection.channelTitle || connection.email || connection.message || 'YouTube Data API v3 is not configured.'}
        </div>
        {connection.email && connection.channelTitle && <div style={{ color: 'var(--text-secondary)', fontSize: 11.5, marginTop: 2 }}>{connection.email}</div>}
        {connected && <div style={{ color: 'var(--text-secondary)', fontSize: 11.5, marginTop: 5 }}>
          Library: {library.status || 'idle'}{Number.isFinite(library.playlistCount) ? ` · ${library.playlistCount} loaded` : ''}
        </div>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 7 }}>
        {connection.status === 'requiresAuth' && <button type="button" disabled={busy} onClick={() => onAction('connect')} style={primaryAction}>Connect</button>}
        {connection.status === 'requiresSetup' && <button type="button" disabled={busy} onClick={() => onAction('setup')} style={primaryAction}>Open OAuth setup</button>}
        {['reauthRequired', 'error'].includes(connection.status) && <button type="button" disabled={busy} onClick={() => onAction('reconnect')} style={primaryAction}>Reconnect</button>}
        {connected && <button type="button" disabled={busy} onClick={() => onAction('refresh')} style={secondaryAction}>Refresh</button>}
        {connected && <button type="button" disabled={busy} onClick={() => onAction('reconnect')} style={secondaryAction}>Reconnect</button>}
        {(connected || connection.email) && <button type="button" disabled={busy} onClick={() => onAction('disconnect')} style={secondaryAction}>Disconnect</button>}
      </div>
    </div>
    {connection.status === 'requiresSetup' && <div style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5, marginTop: 9 }}>
      In Suite Settings → Cloud Account &amp; Security → Google OAuth Client, enter a Desktop client ID and secret, save and reconnect Drive, then enable YouTube Data API v3 in that project.
    </div>}
  </div>;
}

function SectionCard({ title, description, children }) {
  return <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 22, marginBottom: 20 }}>
    {title && <div style={{ marginBottom: 16 }}><div style={{ color: 'var(--text-primary)', fontSize: 15, fontWeight: 800 }}>{title}</div>{description && <div style={{ color: 'var(--text-secondary)', fontSize: 12.5, marginTop: 4, lineHeight: 1.45 }}>{description}</div>}</div>}
    {children}
  </section>;
}

function SettingRow({ title, description, children }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20, paddingBottom: 18, borderBottom: '1px solid var(--border-color)' }}><div><div style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 750 }}>{title}</div><div style={{ color: 'var(--text-secondary)', fontSize: 12.5, marginTop: 3 }}>{description}</div></div>{children}</div>;
}

function SettingBlock({ title, description, children }) {
  return <div style={{ padding: '18px 0', borderBottom: '1px solid var(--border-color)' }}><div style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 750 }}>{title}</div><div style={{ color: 'var(--text-secondary)', fontSize: 12.5, margin: '3px 0 11px' }}>{description}</div>{children}</div>;
}

function TabButton({ active, onClick, icon, label }) {
  return <button type="button" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px', border: 0, borderRadius: 8, background: active ? 'rgba(29,185,84,.14)' : 'transparent', color: active ? '#4ade80' : 'var(--text-secondary)', fontSize: 13, fontWeight: 750, cursor: 'pointer' }}>{icon}{label}</button>;
}

function Segmented({ value, options, onChange, disabled, compact }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{options.map((option) => <button key={option.id} type="button" disabled={disabled} onClick={() => onChange(option.id)} style={{ minHeight: compact ? 28 : 34, padding: compact ? '0 10px' : '0 14px', borderRadius: 7, border: value === option.id ? '1.5px solid #1db954' : '1px solid var(--border-color)', background: value === option.id ? 'rgba(29,185,84,.16)' : 'rgba(0,0,0,.16)', color: value === option.id ? '#4ade80' : 'var(--text-secondary)', fontSize: compact ? 11.5 : 12.5, fontWeight: 750, cursor: disabled ? 'default' : 'pointer' }}>{option.label}</button>)}</div>;
}

function ChoiceGrid({ value, options, onChange, disabled }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: 9 }}>{options.map((option) => <button key={option.id} type="button" disabled={disabled} onClick={() => onChange(option.id)} style={{ padding: 11, borderRadius: 9, textAlign: 'left', border: value === option.id ? '1.5px solid #1db954' : '1px solid var(--border-color)', background: value === option.id ? 'rgba(29,185,84,.13)' : 'rgba(0,0,0,.15)', color: 'var(--text-primary)', cursor: disabled ? 'default' : 'pointer' }}><div style={{ fontSize: 12.5, fontWeight: 800 }}>{option.label}</div><div style={{ marginTop: 4, color: 'var(--text-secondary)', fontSize: 11.5, lineHeight: 1.35 }}>{option.description}</div></button>)}</div>;
}

function ToggleSwitch({ checked, onChange, disabled }) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} style={{ width: 44, height: 25, padding: 0, border: 0, borderRadius: 13, background: checked ? '#1db954' : 'rgba(255,255,255,.15)', position: 'relative', cursor: disabled ? 'default' : 'pointer', flex: '0 0 auto' }}><span style={{ width: 19, height: 19, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: checked ? 22 : 3, boxShadow: '0 1px 3px rgba(0,0,0,.4)' }} /></button>;
}

function ToggleRow({ label, checked, onChange, disabled, icon }) {
  return <div style={{ minHeight: 42, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 11px', borderRadius: 8, background: 'rgba(0,0,0,.14)', border: '1px solid var(--border-color)' }}><span style={{ display: 'flex', alignItems: 'center', gap: 6, color: disabled ? 'var(--text-muted)' : 'var(--text-primary)', fontSize: 12.5 }}>{icon}{label}</span><ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} /></div>;
}

function InfoGrid({ items }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 9 }}>{items.map(([label, value]) => <div key={label} style={{ padding: 11, borderRadius: 8, border: '1px solid var(--border-color)', background: 'rgba(0,0,0,.14)' }}><div style={{ color: '#4ade80', fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div><div style={{ color: 'var(--text-primary)', fontSize: 12.5, marginTop: 4 }}>{value}</div></div>)}</div>;
}

function RoundControl({ children, primary, color = '#1db954', large }) {
  return <span style={{ width: large ? 44 : 25, height: large ? 44 : 25, borderRadius: '50%', background: primary ? color : 'rgba(255,255,255,.1)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 7, fontWeight: 800, flex: '0 0 auto' }}>{children}</span>;
}

function MiniPill({ children }) {
  return <span style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.06)', color: '#d4d8de', fontSize: 10 }}>{children}</span>;
}

function Notice({ color, children }) {
  return <div style={{ marginBottom: 16, padding: '11px 14px', borderRadius: 8, background: `${color}18`, border: `1px solid ${color}45`, color, fontSize: 12.5 }}>{children}</div>;
}

function statusBadge(state) {
  const values = {
    unsupported: ['Unsupported OS', '#eab308'], stopped: ['Stopped', '#94a3b8'], starting: ['Starting…', '#3b82f6'],
    running: ['Active in Taskbar', '#10b981'], no_session: ['Waiting for media', '#38bdf8'], error: ['Error', '#ef4444']
  };
  const [label, color] = values[state] || ['Unknown', '#94a3b8'];
  return { label, color, bg: `${color}20` };
}

function smallButton(active) {
  return { minWidth: 80, height: 32, padding: '0 11px', borderRadius: 7, border: '1px solid var(--border-color)', background: active ? 'rgba(16,185,129,.18)' : 'rgba(255,255,255,.05)', color: active ? '#4ade80' : 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, fontWeight: 750, cursor: 'pointer' };
}

const secondaryAction = { height: 38, padding: '0 17px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'rgba(0,0,0,.18)', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 750, cursor: 'pointer' };
const primaryAction = { ...secondaryAction, border: 0, background: 'linear-gradient(90deg,#1db954,#15803d)', color: '#fff' };
