const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mediaWidget = require('../main/mediaWidget');

const ROOT = path.join(__dirname, '..');

function testSettingsValidation() {
  const defaults = mediaWidget.DEFAULT_LABMEDIA_SETTINGS;
  assert.strictEqual(defaults.schemaVersion, 1);
  assert.strictEqual(defaults.enabled, true);
  assert.strictEqual(defaults.size, 'normal');
  assert.strictEqual(defaults.opacity, 1.0);
  assert.strictEqual(defaults.showAlbumArt, true);
  assert.strictEqual(defaults.showProgress, true);
  assert.strictEqual(defaults.hideWhenFullscreen, true);
  assert.deepStrictEqual(defaults.controls, { previous: true, playPause: true, next: true });

  // Custom valid settings
  const custom = mediaWidget.validateSettings({
    size: 'compact',
    opacity: 0.75,
    showAlbumArt: false,
    controls: { previous: false, playPause: true, next: true }
  });
  assert.strictEqual(custom.size, 'compact');
  assert.strictEqual(custom.opacity, 0.75);
  assert.strictEqual(custom.showAlbumArt, false);
  assert.strictEqual(custom.controls.previous, false);

  // Invalid size string
  const invalidSize = mediaWidget.validateSettings({ size: 'super_large' });
  assert.strictEqual(invalidSize.size, 'normal');

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
  assert.strictEqual(content.schemaVersion, 1);
  assert.strictEqual(content.size, 'large');
  assert.strictEqual(content.opacity, 0.9);

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
  console.log('labmedia-test: IPC channel allowlist tests passed.');
}

function testNativeSourceIntegrity() {
  const nativeDir = path.join(ROOT, 'native', 'LabMediaWidget');
  assert.ok(fs.existsSync(path.join(nativeDir, 'LabMediaWidget.csproj')), 'LabMediaWidget.csproj must exist');
  assert.ok(fs.existsSync(path.join(nativeDir, 'MainWindow.xaml')), 'MainWindow.xaml must exist');
  assert.ok(fs.existsSync(path.join(nativeDir, 'MainWindow.xaml.cs')), 'MainWindow.xaml.cs must exist');
  assert.ok(fs.existsSync(path.join(nativeDir, 'SmtcManager.cs')), 'SmtcManager.cs must exist');
  assert.ok(fs.existsSync(path.join(nativeDir, 'TaskbarAnchor.cs')), 'TaskbarAnchor.cs must exist');

  const smtcSource = fs.readFileSync(path.join(nativeDir, 'SmtcManager.cs'), 'utf8');
  assert.ok(smtcSource.includes('spotify'), 'SMTC manager must filter sessions for Spotify');

  const anchorSource = fs.readFileSync(path.join(nativeDir, 'TaskbarAnchor.cs'), 'utf8');
  assert.ok(anchorSource.includes('TaskbarAl'), 'Taskbar anchor must read TaskbarAl registry key');
  assert.ok(anchorSource.includes('Shell_TrayWnd'), 'Taskbar anchor must find Shell_TrayWnd handle');
  assert.ok(anchorSource.includes('AutomationElement.AutomationIdProperty'), 'Taskbar anchor must use UI Automation');
  assert.ok(anchorSource.includes('WidgetsButton'), 'Taskbar anchor must use the Widgets button bound');
  assert.ok(anchorSource.includes('StartButton'), 'Taskbar anchor must use the Start button bound');
  assert.ok(anchorSource.includes('IsAutoHideEnabled'), 'Taskbar anchor must follow taskbar auto-hide state');
  assert.ok(anchorSource.includes('Version.Build < 22000'), 'Taskbar anchor must recognize the Windows 10 classic taskbar');
  assert.ok(anchorSource.includes('GetLegacyTaskButtonsRight'), 'Taskbar anchor must read Windows 10 task buttons through MSAA');
  assert.ok(anchorSource.includes('anchors.TaskButtonsRight ?? anchors.StartRight'),
    'Windows 10 anchoring must not require the Start button after Explorer rebuilds');
  assert.ok(!anchorSource.includes('tbLeftDip + 300'), 'Taskbar anchor must not use fixed icon-position fallbacks');

  const mainWinSource = fs.readFileSync(path.join(nativeDir, 'MainWindow.xaml.cs'), 'utf8');
  const mainWinXaml = fs.readFileSync(path.join(nativeDir, 'MainWindow.xaml'), 'utf8');
  assert.ok(mainWinSource.includes('WS_EX_TOOLWINDOW'), 'MainWindow must set WS_EX_TOOLWINDOW style');
  assert.ok(mainWinSource.includes('WS_EX_NOACTIVATE'), 'MainWindow must set WS_EX_NOACTIVATE style');
  assert.ok(mainWinSource.includes('!_hasSession'), 'MainWindow must hide when Spotify has no session');
  assert.ok(mainWinSource.includes('await _smtc.RefreshAsync()'), 'MainWindow must poll for browser sessions created after startup');
  assert.ok(/x:Name="MainBorder"[^>]*Background="Transparent"[^>]*BorderBrush="Transparent"[^>]*BorderThickness="0"/.test(mainWinXaml),
    'Widget surface must remain transparent so the native taskbar shows through');
  assert.ok(mainWinXaml.includes('x:Key="MediaIconButton"'), 'Media controls must use the circular vector icon style');
  assert.ok(mainWinXaml.includes('StrokeLineJoin="Round"'), 'Previous and next controls must use rounded vector chevrons');
  assert.ok(!mainWinXaml.includes('Content="⏮"') && !mainWinXaml.includes('Content="⏭"'),
    'Media controls must not depend on font-specific symbol glyphs');

  console.log('labmedia-test: native source integrity tests passed.');
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
  testThirdPartyNotices();

  console.log('All LabMedia verification tests passed cleanly!');
}

main();
