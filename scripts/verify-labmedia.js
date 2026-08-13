const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mediaWidget = require('../main/mediaWidget');
const labmediaQueue = require('../main/labmediaQueue');

const ROOT = path.join(__dirname, '..');

function testSettingsValidation() {
  const defaults = mediaWidget.DEFAULT_LABMEDIA_SETTINGS;
  assert.strictEqual(defaults.schemaVersion, 2);
  assert.strictEqual(defaults.enabled, true);
  assert.strictEqual(defaults.size, 'normal');
  assert.strictEqual(defaults.theme, 'spotify');
  assert.strictEqual(defaults.opacity, 1.0);
  assert.strictEqual(defaults.autoHideWhenIdle, false);
  assert.strictEqual(defaults.showAlbumArt, true);
  assert.strictEqual(defaults.showProgress, true);
  assert.strictEqual(defaults.hideWhenFullscreen, true);
  assert.strictEqual(defaults.primaryClickAction, 'panel');
  assert.strictEqual(defaults.taskbarControlMode, 'adaptive');
  assert.deepStrictEqual(defaults.controls, { previous: true, playPause: true, next: true });

  // Custom valid settings
  const custom = mediaWidget.validateSettings({
    size: 'micro',
    theme: 'neon',
    opacity: 0.75,
    autoHideGraceSec: 15,
    showAlbumArt: false,
    primaryClickAction: 'openSource',
    taskbarControlMode: 'minimal',
    controls: { previous: false, playPause: true, next: true }
  });
  assert.strictEqual(custom.size, 'micro');
  assert.strictEqual(custom.theme, 'neon');
  assert.strictEqual(custom.opacity, 0.75);
  assert.strictEqual(custom.autoHideGraceSec, 15);
  assert.strictEqual(custom.showAlbumArt, false);
  assert.strictEqual(custom.primaryClickAction, 'openSource');
  assert.strictEqual(custom.taskbarControlMode, 'minimal');
  assert.strictEqual(custom.controls.previous, false);

  const migrated = mediaWidget.validateSettings({
    schemaVersion: 1,
    size: 'compact',
    theme: 'glass',
    showProgress: false,
    controls: { previous: false, playPause: true, next: false }
  });
  assert.strictEqual(migrated.schemaVersion, 2);
  assert.strictEqual(migrated.size, 'compact');
  assert.strictEqual(migrated.theme, 'glass');
  assert.strictEqual(migrated.showProgress, false);
  assert.deepStrictEqual(migrated.controls, { previous: false, playPause: true, next: false });
  assert.strictEqual(migrated.primaryClickAction, 'panel');
  assert.strictEqual(migrated.taskbarControlMode, 'adaptive');

  const transparentTheme = mediaWidget.validateSettings({ theme: 'transparent' });
  assert.strictEqual(transparentTheme.theme, 'transparent');

  // Invalid size string & invalid theme string
  const invalidSize = mediaWidget.validateSettings({ size: 'super_large', theme: 'invalid_theme' });
  assert.strictEqual(invalidSize.size, 'normal');
  assert.strictEqual(invalidSize.theme, 'spotify');

  const invalidProgressiveDisclosure = mediaWidget.validateSettings({
    primaryClickAction: 'launchEverything',
    taskbarControlMode: 'crowded'
  });
  assert.strictEqual(invalidProgressiveDisclosure.primaryClickAction, 'panel');
  assert.strictEqual(invalidProgressiveDisclosure.taskbarControlMode, 'adaptive');

  // Opacity clamping
  const lowOpacity = mediaWidget.validateSettings({ opacity: 0.1 });
  assert.strictEqual(lowOpacity.opacity, 0.4);
  const highOpacity = mediaWidget.validateSettings({ opacity: 2.5 });
  assert.strictEqual(highOpacity.opacity, 1.0);
  const nonFiniteOpacity = mediaWidget.validateSettings({ opacity: Infinity });
  assert.strictEqual(nonFiniteOpacity.opacity, 1.0);

  const strictBooleans = mediaWidget.validateSettings({
    enabled: 'false',
    showAlbumArt: 0,
    controls: { previous: 'false' }
  });
  assert.strictEqual(strictBooleans.enabled, true);
  assert.strictEqual(strictBooleans.showAlbumArt, true);
  assert.strictEqual(strictBooleans.controls.previous, true);

  assert.strictEqual(mediaWidget.isInstalled('["labmedia"]'), true);
  assert.strictEqual(mediaWidget.isInstalled('["notebook"]'), false);

  console.log('labmedia-test: settings validation tests passed.');
}

function testConfigFileWriting() {
  const settings = mediaWidget.validateSettings({ size: 'large', opacity: 0.9 });
  const writtenPath = mediaWidget.writeConfigFile(settings);
  assert.ok(writtenPath, 'Config file path must be returned');
  assert.ok(fs.existsSync(writtenPath), 'Config file must exist on disk');

  const content = JSON.parse(fs.readFileSync(writtenPath, 'utf8'));
  assert.strictEqual(content.schemaVersion, 2);
  assert.strictEqual(content.size, 'large');
  assert.strictEqual(content.opacity, 0.9);
  assert.strictEqual(content.primaryClickAction, 'panel');
  assert.strictEqual(content.taskbarControlMode, 'adaptive');

  console.log('labmedia-test: config file writing tests passed.');
}

function testIpcChannelsAllowlist() {
  const preloadSource = fs.readFileSync(path.join(ROOT, 'main', 'preload.js'), 'utf8');
  const requiredInvokes = [
    'labmedia:getStatus',
    'labmedia:setEnabled',
    'labmedia:updateSettings',
    'labmedia:resetSettings',
    'labmedia:restart'
  ];
  for (const channel of requiredInvokes) {
    assert.ok(preloadSource.includes(`'${channel}'`), `Preload INVOKE_CHANNELS must include '${channel}'`);
  }

  assert.ok(preloadSource.includes("'labmedia:statusChanged'"), "Preload LISTEN_CHANNELS must include 'labmedia:statusChanged'");
  assert.ok(preloadSource.includes("'app:navigate'"), "Preload LISTEN_CHANNELS must allow tray navigation");

  const ipcSource = fs.readFileSync(path.join(ROOT, 'main', 'ipc.js'), 'utf8');
  assert.ok(ipcSource.includes("key === 'installed_apps'"), 'App installation changes must be observed by main process');
  assert.ok(ipcSource.includes('handleInstalledAppsChanged'), 'App installation changes must control the LabMedia helper');

  const supervisorSource = fs.readFileSync(path.join(ROOT, 'main', 'mediaWidget.js'), 'utf8');
  assert.ok(supervisorSource.includes('intentionalStops'), 'Supervisor must track intentional stops per child process');
  assert.ok(supervisorSource.includes("spawnedProcess.once('error'"), 'Supervisor must handle child spawn errors');
  assert.ok(supervisorSource.includes('if (!isInstalled() || !settings.enabled)'), 'Supervisor must require installation before launch');
  assert.ok(supervisorSource.includes("stdio: ['pipe', 'pipe', 'pipe']"),
    'Supervisor must maintain a bidirectional JSON-lines channel with the native helper');
  assert.ok(supervisorSource.includes("type: 'queue:update'"),
    'Supervisor must send provider-neutral queue states to the native helper');
  assert.ok(!supervisorSource.includes("../native/LabMediaWidget/bin/"),
    'Supervisor must not launch stale native build outputs when the published helper is missing');
  console.log('labmedia-test: IPC channel allowlist tests passed.');
}

function testNativeSourceIntegrity() {
  const nativeDir = path.join(ROOT, 'native', 'LabMediaWidget');
  assert.ok(fs.existsSync(path.join(nativeDir, 'LabMediaWidget.csproj')), 'LabMediaWidget.csproj must exist');
  assert.ok(fs.existsSync(path.join(nativeDir, 'MainWindow.xaml')), 'MainWindow.xaml must exist');
  assert.ok(fs.existsSync(path.join(nativeDir, 'MainWindow.xaml.cs')), 'MainWindow.xaml.cs must exist');
  assert.ok(fs.existsSync(path.join(nativeDir, 'SmtcManager.cs')), 'SmtcManager.cs must exist');
  assert.ok(fs.existsSync(path.join(nativeDir, 'TaskbarAnchor.cs')), 'TaskbarAnchor.cs must exist');
  assert.ok(fs.existsSync(path.join(nativeDir, 'NowPlayingPanel.xaml')), 'NowPlayingPanel.xaml must exist');
  assert.ok(fs.existsSync(path.join(nativeDir, 'NowPlayingPanel.xaml.cs')), 'NowPlayingPanel.xaml.cs must exist');
  assert.ok(fs.existsSync(path.join(nativeDir, 'QueueModels.cs')), 'QueueModels.cs must exist');

  const smtcSource = fs.readFileSync(path.join(nativeDir, 'SmtcManager.cs'), 'utf8');
  assert.ok(smtcSource.includes('spotify'), 'SMTC manager must filter sessions for Spotify');

  const anchorSource = fs.readFileSync(path.join(nativeDir, 'TaskbarAnchor.cs'), 'utf8');
  assert.ok(anchorSource.includes('Shell_TrayWnd'), 'Taskbar anchor must find Shell_TrayWnd handle');
  assert.ok(anchorSource.includes('IsAutoHideEnabled'), 'Taskbar anchor must follow taskbar auto-hide state');
  assert.ok(anchorSource.includes('CalculateFlyoutPosition'), 'Taskbar anchor must position and clamp the flyout');
  assert.ok(anchorSource.includes('TaskbarEdge.Left') && anchorSource.includes('TaskbarEdge.Right'),
    'Flyout placement must handle vertical taskbar edges');
  assert.ok(!anchorSource.includes('AutomationElement'), 'Taskbar polling must not query Explorer through UI Automation');

  const mainWinSource = fs.readFileSync(path.join(nativeDir, 'MainWindow.xaml.cs'), 'utf8');
  const nativeMethodsSource = fs.readFileSync(path.join(nativeDir, 'NativeMethods.cs'), 'utf8');
  const appVolumeSource = fs.readFileSync(path.join(nativeDir, 'AppVolume.cs'), 'utf8');
  const fallbackWorkerSource = fs.readFileSync(path.join(ROOT, 'main', 'smtcWorker.ps1'), 'utf8');
  const configModelSource = fs.readFileSync(path.join(nativeDir, 'ConfigModel.cs'), 'utf8');
  const mainWinXaml = fs.readFileSync(path.join(nativeDir, 'MainWindow.xaml'), 'utf8');
  const panelSource = fs.readFileSync(path.join(nativeDir, 'NowPlayingPanel.xaml.cs'), 'utf8');
  const panelXaml = fs.readFileSync(path.join(nativeDir, 'NowPlayingPanel.xaml'), 'utf8');
  assert.ok(configModelSource.includes('Theme'), 'ConfigModel must include Theme property');
  assert.ok(configModelSource.includes('PrimaryClickAction') && configModelSource.includes('TaskbarControlMode'),
    'ConfigModel must include progressive-disclosure schema-v2 settings');
  assert.ok(mainWinSource.includes('_config.Theme'), 'MainWindow must apply theme visual styling in ApplyConfig');
  assert.ok(mainWinSource.includes('WS_EX_TOOLWINDOW'), 'MainWindow must set WS_EX_TOOLWINDOW style');
  assert.ok(mainWinSource.includes('WS_EX_NOACTIVATE'), 'MainWindow must set WS_EX_NOACTIVATE style');
  assert.ok(mainWinSource.includes('AutoHideWhenIdle'), 'MainWindow must respect AutoHideWhenIdle setting');
  assert.ok(smtcSource.includes('SelectSessionAsync'), 'SMTC manager must support explicit player selection');
  assert.ok(smtcSource.includes('SessionId') && smtcSource.includes('Album'),
    'SMTC state must include stable runtime session IDs and album metadata');
  assert.ok(smtcSource.includes('SourceAppId') && mainWinSource.includes('state.SourceAppId'),
    'Volume controls must retain the raw SMTC application identity instead of relying on a display label');
  assert.ok(smtcSource.includes('CanSeek') && smtcSource.includes('CanShuffle') && smtcSource.includes('CanRepeat'),
    'SMTC state must expose capability-aware panel controls');
  assert.ok(mainWinSource.includes('await _smtc.RefreshAsync()'), 'MainWindow must poll for browser sessions created after startup');
  assert.ok(mainWinSource.includes('HandlePrimaryClick') && mainWinSource.includes('ApplyAdaptiveLayout'),
    'MainWindow must map body clicks to the flyout and apply adaptive collapsed layouts');
  assert.ok(!mainWinSource.includes('GWLP_HWNDPARENT') && !nativeMethodsSource.includes('GWLP_HWNDPARENT'),
    'LabMedia must never attach its native owner to Explorer');
  assert.ok(!appVolumeSource.includes('Marshal.ReadIntPtr') && !appVolumeSource.includes('GetDelegateForFunctionPointer'),
    'Native volume control must use typed COM interop instead of raw vtable calls');
  assert.ok(!appVolumeSource.includes('AdjustSystemVolume'), 'AppVolume must not call AdjustSystemVolume');
  assert.ok(appVolumeSource.includes('GetMediaVolume') && appVolumeSource.includes('SetMediaVolume')
    && appVolumeSource.includes('GetMediaMute') && appVolumeSource.includes('SetMediaMute'),
    'Native volume interface must expose typed get, set, and mute operations');
  assert.ok(appVolumeSource.includes('hint.Contains("youtube") && !HasBrowserIdentity(hint) && IsBrowserProcess(name)'),
    'Generic YouTube sessions must match a browser without overriding a browser-specific session identity');
  assert.ok(mainWinSource.includes('if (currentVol < 0) return;'),
    'The wheel toast must not claim success when no matching audio session was changed');
  assert.ok(!fallbackWorkerSource.includes('Marshal.ReadIntPtr') && !fallbackWorkerSource.includes('GetDelegateForFunctionPointer'),
    'PowerShell fallback must not use unmanaged audio vtable calls');
  assert.ok(/x:Name="MainBorder"[^>]*CornerRadius="8"/.test(mainWinXaml),
    'Widget surface must use frosted pill style with CornerRadius="8"');
  assert.ok(mainWinXaml.includes('x:Key="MediaIconButton"'), 'Media controls must use the circular vector icon style');
  assert.ok(!mainWinXaml.includes('BtnSwitchSession'), 'Player switching must not occupy the taskbar strip');
  assert.ok(mainWinXaml.includes('x:Name="ControlsRail"'), 'Normal mode must reserve a stable control rail');
  assert.ok(mainWinXaml.includes('VolToastBorder'), 'MainWindow XAML must include live volume toast badge');
  assert.ok(!mainWinXaml.includes('Content="⏮"') && !mainWinXaml.includes('Content="⏭"'),
    'Media controls must not depend on font-specific symbol glyphs');
  assert.ok(panelXaml.includes('Width="384"') && panelXaml.includes('MaxHeight="520"'),
    'Now Playing flyout must use the planned 384 by 520 DIP bounds');
  assert.ok(panelXaml.includes('x:Name="SessionPicker"') && panelXaml.includes('x:Name="VolumeSlider"')
    && panelXaml.includes('Up Next'), 'Flyout must include session selection, per-app volume, and Up Next');
  assert.ok(panelSource.includes('Window_Deactivated') && panelSource.includes('Key.Escape'),
    'Flyout must dismiss on outside focus and Escape');
  assert.ok(!panelXaml.includes('Owner=') && !panelSource.includes('Owner ='),
    'Flyout must remain a separate LabMedia window without an Explorer owner');

  console.log('labmedia-test: native source integrity tests passed.');
}

function testQueueContract() {
  const unavailable = labmediaQueue.unavailableQueue('VLC');
  assert.strictEqual(unavailable.status, 'unavailable');
  assert.strictEqual(unavailable.items.length, 0);
  assert.ok(unavailable.message.includes('VLC'));

  const invalid = labmediaQueue.normalizeQueueState({ status: 'invented', items: [{ title: 'Do not show' }] });
  assert.strictEqual(invalid.status, 'error');

  const ready = labmediaQueue.normalizeQueueState({
    status: 'ready',
    provider: 'test-provider',
    items: Array.from({ length: 12 }, (_, index) => ({
      id: `track-${index}`,
      title: `Track ${index}`,
      artist: 'Artist',
      artworkUrl: index === 0 ? 'http://unsafe.example/art.jpg' : 'https://safe.example/art.jpg',
      durationMs: 245000,
      attribution: 'Test'
    }))
  });
  assert.strictEqual(ready.status, 'ready');
  assert.strictEqual(ready.items.length, labmediaQueue.MAX_QUEUE_ITEMS);
  assert.strictEqual(ready.items[0].artworkUrl, '');
  assert.strictEqual(ready.items[1].artworkUrl, 'https://safe.example/art.jpg');

  const empty = labmediaQueue.normalizeQueueState({ status: 'ready', items: [] });
  assert.strictEqual(empty.status, 'empty');

  const spotify = labmediaQueue.getQueueStateForSession({ sourceApp: 'Spotify.exe' });
  assert.strictEqual(spotify.status, 'unavailable');
  assert.ok(spotify.message.includes('approved provider access'));

  console.log('labmedia-test: queue provider contract tests passed.');
}

function testSettingsInformationArchitecture() {
  const rendererSource = fs.readFileSync(path.join(ROOT, 'renderer', 'apps', 'LabMedia.jsx'), 'utf8');
  assert.ok(rendererSource.includes('label="Taskbar"'), 'LabMedia settings must include the Taskbar tab');
  assert.ok(rendererSource.includes('label="Expanded Panel"'), 'LabMedia settings must include the Expanded Panel tab');
  assert.ok(rendererSource.includes("activeTab === 'history'"), 'LabMedia settings must include the History tab');
  assert.ok(rendererSource.includes("id: 'collapsed', label: 'Collapsed'")
    && rendererSource.includes("id: 'expanded', label: 'Expanded'"),
    'Settings preview must switch between collapsed and expanded modes');
  assert.ok(rendererSource.includes('primaryClickAction') && rendererSource.includes('taskbarControlMode'),
    'Settings UI must configure schema-v2 progressive disclosure controls');
  assert.ok(rendererSource.includes('Queue data is provider-controlled'),
    'Expanded Panel settings must explain honest provider queue availability');

  console.log('labmedia-test: settings information architecture tests passed.');
}

function testThirdPartyNotices() {
  const noticesPath = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
  assert.ok(fs.existsSync(noticesPath), 'THIRD_PARTY_NOTICES.md must exist');
  const content = fs.readFileSync(noticesPath, 'utf8');
  assert.ok(content.includes('Taskbar Widget for Spotify'), 'THIRD_PARTY_NOTICES.md must include the upstream project name');
  assert.ok(content.includes('MIT License'), 'THIRD_PARTY_NOTICES.md must include MIT License');
  assert.ok(content.includes('Copyright (c) 2026 MechanicWB'), 'THIRD_PARTY_NOTICES.md must preserve the upstream copyright');

  const builder = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  assert.ok(builder.includes('from: THIRD_PARTY_NOTICES.md'), 'Packaged app must include third-party notices');

  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-windows.yml'), 'utf8');
  assert.ok(workflow.includes('actions/setup-dotnet@v4'), 'Windows release must provision the .NET SDK');

  console.log('labmedia-test: third party notices tests passed.');
}

function main() {
  testSettingsValidation();
  testConfigFileWriting();
  testIpcChannelsAllowlist();
  testNativeSourceIntegrity();
  testQueueContract();
  testSettingsInformationArchitecture();
  testThirdPartyNotices();

  console.log('All LabMedia verification tests passed cleanly!');
}

main();
