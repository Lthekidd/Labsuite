const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  YTMDesktopProvider,
  BASE_URL,
  REALTIME_URL,
  MAX_QUEUE_ITEMS,
  __private
} = require('../main/ytmDesktopProvider');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'a'.repeat(512);
const HARDENED_METADATA = {
  apiVersions: ['v1'],
  product: 'YTmusic',
  securityProfile: 'labsuite-hardened-v1',
  transport: 'loopback-only'
};

function response(status, body = {}, headers = {}) {
  return { status, body, headers, text: JSON.stringify(body) };
}

function queueItem(index, overrides = {}) {
  return {
    title: `Track ${index}`,
    author: `Artist ${index}`,
    duration: index % 2 ? '3:05' : '1:02:03',
    videoId: `abcde${String(index).padStart(6, '0')}`.slice(0, 11),
    thumbnails: [{ url: 'http://unsafe.example/art.jpg', width: 100, height: 100 }, { url: `https://safe.example/${index}.jpg`, width: 200, height: 200 }],
    selected: false,
    ...overrides
  };
}

function playerState() {
  return {
    player: {
      trackState: 1,
      videoProgress: 42,
      volume: 72,
      muted: false,
      queue: {
        autoplay: true,
        isGenerating: false,
        isInfinite: false,
        repeatMode: 1,
        selectedItemIndex: 1,
        items: [queueItem(0), queueItem(1, { selected: true }), queueItem(2), queueItem(3)],
        automixItems: [queueItem(4), queueItem(5)]
      }
    },
    video: {
      id: 'abcdefghijk', title: 'Playing track', author: 'Current artist', album: 'Current album',
      durationSeconds: 240, likeStatus: 2, thumbnails: [{ url: 'https://safe.example/current.jpg', width: 512, height: 512 }]
    },
    playlistId: 'PL_test'
  };
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.disconnected = false;
  }
  disconnect() { this.disconnected = true; }
  close() { this.disconnected = true; }
}

function testStateTransformation() {
  const transformed = __private.transformPlayerState(playerState());
  assert.strictEqual(transformed.playback.title, 'Playing track');
  assert.strictEqual(transformed.playback.repeatMode, 'all');
  assert.strictEqual(transformed.playback.likeState, 'liked');
  assert.strictEqual(transformed.queue.status, 'ready');
  assert.strictEqual(transformed.queue.autoplay, true);
  assert.deepStrictEqual(transformed.queue.items.map(item => item.queueIndex), [2, 3, 4, 5]);
  assert.deepStrictEqual(transformed.queue.items.map(item => item.kind), ['queue', 'queue', 'automix', 'automix']);
  assert.ok(transformed.queue.items[2].attribution.includes('Autoplay'));
  assert.strictEqual(transformed.queue.items[0].artworkUrl, 'https://safe.example/2.jpg');
  assert.strictEqual(transformed.queue.items[0].durationMs, 3723000);
  assert.strictEqual(transformed.capabilities.canPlayQueueItem, true);

  const long = playerState();
  long.player.queue.selectedItemIndex = -1;
  long.player.queue.items = Array.from({ length: 75 }, (_, index) => queueItem(index));
  long.player.queue.automixItems = [];
  assert.strictEqual(__private.transformPlayerState(long).queue.items.length, MAX_QUEUE_ITEMS);
}

async function testPairingRealtimeCommandsAndForget() {
  let storedToken = '';
  let deleted = false;
  let socketUrl = '';
  let socketOptions = null;
  let spawnArgs = null;
  const socket = new FakeSocket();
  const commands = [];
  let now = 1000;
  const request = async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    assert.strictEqual(url.origin, BASE_URL);
    if (url.pathname === '/metadata') return response(200, HARDENED_METADATA);
    if (url.pathname === '/api/v1/auth/requestcode') {
      assert.ok(!options.headers.Authorization);
      const body = JSON.parse(options.body);
      assert.strictEqual(body.appId, 'labsuite_labmedia');
      return response(200, { code: '4821' });
    }
    if (url.pathname === '/api/v1/auth/request') return response(200, { token: TOKEN });
    if (url.pathname === '/api/v1/state') {
      assert.strictEqual(options.headers.Authorization, TOKEN);
      return response(200, playerState());
    }
    if (url.pathname === '/api/v1/command') {
      assert.strictEqual(options.headers.Authorization, TOKEN);
      commands.push(JSON.parse(options.body));
      return response(204, {});
    }
    throw new Error(`Unexpected YTMDesktop request: ${url}`);
  };

  const provider = new YTMDesktopProvider({
    request,
    getCredential: async () => null,
    setCredential: async token => { storedToken = token; },
    deleteCredential: async () => { deleted = true; },
    findExecutable: () => 'C:\\Trusted\\labsuite-music.exe',
    validateExecutable: () => true,
    spawn: (_executable, args) => { spawnArgs = args; return { unref() {} }; },
    isProcessRunning: async () => true,
    socketFactory: (url, options) => { socketUrl = url; socketOptions = options; return socket; },
    now: () => now,
    sleep: async ms => { now += ms; },
    appVersion: '2.10.37'
  });

  await provider.initialize();
  assert.strictEqual(provider.getState().status, 'requiresPairing');
  const pairPromise = provider.pair();
  await pairPromise;
  assert.deepStrictEqual(spawnArgs, ['labsuite-music://pair'], 'Connect must open YTmusic with one-time approval enabled');
  assert.strictEqual(storedToken, TOKEN);
  assert.strictEqual(socketUrl, REALTIME_URL);
  assert.deepStrictEqual(socketOptions.transports, ['websocket']);
  assert.strictEqual(socketOptions.auth.token, TOKEN);
  assert.strictEqual(socketOptions.reconnectionAttempts, 8);
  assert.notStrictEqual(socketOptions.reconnectionAttempts, Infinity);

  const inactive = provider.getState({ sourceAppId: 'Spotify.exe' });
  assert.strictEqual(inactive.active, false);
  assert.strictEqual(inactive.queue.status, 'unavailable');
  const active = provider.getState({ sourceAppId: 'labsuite-music' });
  assert.strictEqual(active.active, true);
  assert.strictEqual(active.queue.items.length, 4);
  assert.ok(!JSON.stringify(active).includes(TOKEN), 'Sanitized provider state must never contain the companion token');

  await Promise.all([
    provider.sendCommand('setVolume', { value: 10 }),
    provider.sendCommand('setVolume', { value: 20 }),
    provider.sendCommand('setVolume', { value: 30 })
  ]);
  assert.ok(commands.filter(command => command.command === 'setVolume').length <= 2, 'Rapid volume updates must be coalesced');
  assert.strictEqual(commands.filter(command => command.command === 'setVolume').at(-1).data, 30);
  await provider.sendCommand('playQueueIndex', { queueIndex: 4 });
  assert.throws(() => provider.sendCommand('playQueueIndex', { queueIndex: 99 }), /no longer available/i);
  assert.throws(() => provider.sendCommand('playQueueIndex', { queueIndex: 1 }), /no longer available/i);
  await provider.playLibraryItem({ playlistId: 'PL_test', videoId: 'abcdefghijk' });
  assert.deepStrictEqual(commands.at(-1), { command: 'changeVideo', data: { videoId: 'abcdefghijk', playlistId: 'PL_test' } });

  socket.emit('state-update', { ...playerState(), video: { ...playerState().video, title: 'Socket update' } });
  assert.strictEqual(provider.getState({ sourceApp: 'YTmusic' }).playback.title, 'Socket update');

  await provider.forget();
  assert.strictEqual(deleted, true);
  assert.strictEqual(socket.disconnected, true);
  assert.strictEqual(provider.getState().paired, false);
}

async function testRevokedCredential() {
  let deleted = false;
  const provider = new YTMDesktopProvider({
    request: async urlValue => {
      const url = new URL(urlValue);
      if (url.pathname === '/metadata') return response(200, HARDENED_METADATA);
      if (url.pathname === '/api/v1/state') return response(401, { error: 'UNAUTHORIZED' });
      throw new Error(`Unexpected request ${url}`);
    },
    getCredential: async () => TOKEN,
    deleteCredential: async () => { deleted = true; },
    findExecutable: () => 'C:\\Trusted\\labsuite-music.exe',
    isProcessRunning: async () => true,
    socketFactory: () => new FakeSocket()
  });
  await provider.initialize();
  assert.strictEqual(provider.getState().status, 'reauthRequired');
  assert.strictEqual(deleted, true);
}

async function testRejectsUpstreamService() {
  const provider = new YTMDesktopProvider({
    request: async urlValue => {
      const url = new URL(urlValue);
      if (url.pathname === '/metadata') return response(200, { apiVersions: ['v1'] });
      throw new Error(`Unexpected request ${url}`);
    },
    getCredential: async () => null,
    findExecutable: () => '',
    isProcessRunning: async () => true
  });
  const state = await provider.initialize();
  assert.strictEqual(state.status, 'incompatible');
  assert.match(state.message, /non-hardened YTMDesktop service/i);
}

async function testBundledHardenedInstall() {
  let spawnCalled = false;
  const provider = new YTMDesktopProvider({
    platform: 'win32',
    spawn: () => { spawnCalled = true; },
    findExecutable: () => 'C:\\Trusted\\labsuite-music.exe',
    validateExecutable: () => true,
    isProcessRunning: async () => false,
    request: async urlValue => {
      const url = new URL(urlValue);
      if (url.pathname === '/metadata') throw new Error('not running');
      throw new Error(`Unexpected request ${url}`);
    },
    getCredential: async () => null
  });
  const state = await provider.install();
  assert.strictEqual(state.installed, true);
  assert.strictEqual(spawnCalled, false, 'Install must never invoke Winget or an upstream installer');
}

async function testLibraryStartsAndHandsOffToYTmusic() {
  let companionReady = false;
  let spawnArgs = null;
  const commands = [];
  const provider = new YTMDesktopProvider({
    request: async (urlValue, options = {}) => {
      const url = new URL(urlValue);
      if (!companionReady) throw new Error('companion is not ready');
      if (url.pathname === '/metadata') return response(200, HARDENED_METADATA);
      if (url.pathname === '/api/v1/state') return response(200, playerState());
      if (url.pathname === '/api/v1/command') {
        commands.push(JSON.parse(options.body));
        return response(204, {});
      }
      throw new Error(`Unexpected request ${url}`);
    },
    getCredential: async () => TOKEN,
    findExecutable: () => 'C:\\Trusted\\labsuite-music.exe',
    validateExecutable: () => true,
    isProcessRunning: async () => true,
    spawn: (_executable, args) => {
      spawnArgs = args;
      companionReady = true;
      return { unref() {} };
    },
    socketFactory: () => new FakeSocket(),
    sleep: async () => {}
  });

  const initial = await provider.initialize();
  assert.strictEqual(initial.status, 'serverDisabled');
  const handled = await provider.playLibraryItem({ playlistId: 'PL_test', videoId: 'abcdefghijk' });
  assert.strictEqual(handled, true, 'YouTube Library items must hand playback to a paired YTmusic install');
  assert.deepStrictEqual(spawnArgs, ['labsuite-music://pair'], 'A disabled local service must be re-enabled through the hardened protocol');
  assert.deepStrictEqual(commands, [{ command: 'changeVideo', data: { videoId: 'abcdefghijk', playlistId: 'PL_test' } }]);
}

function testBundledExecutableIntegrity() {
  const bundled = path.join(ROOT, 'bin', 'LabSuiteMusic', 'labsuite-music.exe');
  const manifest = path.join(ROOT, 'bin', 'LabSuiteMusic', 'labsuite-music.manifest.json');
  if (fs.existsSync(bundled) && fs.existsSync(manifest)) {
    assert.strictEqual(__private.isTrustedExecutable(bundled), true, 'Staged YTmusic must match its hardened manifest hash');
  }

  if (fs.existsSync(manifest)) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-music-integrity-'));
    try {
      fs.writeFileSync(path.join(temporary, 'labsuite-music.exe'), 'tampered');
      fs.copyFileSync(
        manifest,
        path.join(temporary, 'labsuite-music.manifest.json')
      );
      assert.strictEqual(__private.isTrustedExecutable(path.join(temporary, 'labsuite-music.exe')), false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function testStaticSecurityContract() {
  const providerSource = fs.readFileSync(path.join(ROOT, 'main', 'ytmDesktopProvider.js'), 'utf8');
  const supervisorSource = fs.readFileSync(path.join(ROOT, 'main', 'mediaWidget.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(ROOT, 'main', 'preload.js'), 'utf8');
  const ipcSource = fs.readFileSync(path.join(ROOT, 'main', 'ipc.js'), 'utf8');
  const nativeSource = fs.readFileSync(path.join(ROOT, 'native', 'LabMediaWidget', 'MainWindow.xaml.cs'), 'utf8');
  assert.strictEqual(BASE_URL, 'http://127.0.0.1:9863');
  assert.ok(!providerSource.includes('0.0.0.0'));
  assert.ok(providerSource.includes("CREDENTIAL_SERVICE = 'LabSuite.LabMedia.LabSuiteMusic'"));
  assert.ok(providerSource.includes("REQUIRED_SECURITY_PROFILE = 'labsuite-hardened-v1'"));
  assert.ok(providerSource.includes("metadata.body.product !== REQUIRED_PRODUCT"));
  assert.ok(providerSource.includes("url.origin !== BASE_URL"));
  assert.ok(providerSource.includes("new YTMDesktopError('redirectRejected'"));
  assert.ok(!providerSource.includes('console.log') && !providerSource.includes('console.error'));
  const rendererSource = fs.readFileSync(path.join(ROOT, 'renderer', 'apps', 'LabMedia.jsx'), 'utf8');
  const builderConfig = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const afterSignSource = fs.readFileSync(path.join(ROOT, 'scripts', 'after-sign-labsuite-music.js'), 'utf8');
  const buildScript = fs.readFileSync(path.join(ROOT, 'scripts', 'build-labsuite-music.ps1'), 'utf8');
  const releaseWorkflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-windows.yml'), 'utf8');
  const pinnedCommit = 'fad6e9ae4d1136be8253ecf4ea0c57ef588dbbdb';
  assert.ok(rendererSource.includes('labsuite-hardened-v1')
    && rendererSource.includes('unreviewed upstream builds are rejected'),
    'LabMedia settings must disclose the hardened companion trust boundary');
  assert.ok(!providerSource.includes('winget.exe') && !providerSource.includes('Ytmdesktop.Ytmdesktop'));
  assert.ok(!providerSource.includes('github.com/ytmdesktop/ytmdesktop/releases'));
  assert.ok(builderConfig.includes('afterSign: scripts/after-sign-labsuite-music.js'));
  assert.ok(releaseWorkflow.includes('repository: Lthekidd/YTmusic')
    && releaseWorkflow.includes(`ref: ${pinnedCommit}`)
    && releaseWorkflow.includes(`-ExpectedCommit '${pinnedCommit}'`),
    'Windows releases must build the public hardened fork at an exact reviewed commit');
  assert.ok(releaseWorkflow.indexOf('Build hardened YTmusic companion')
    < releaseWorkflow.indexOf('npx electron-builder --win --publish never'),
    'The hardened companion must be staged before electron-builder packages the installer');
  assert.ok(releaseWorkflow.includes('node scripts/verify-release-security.js --labsuite-music-only'),
    'Windows releases must verify the packaged companion and corresponding GPL source');
  assert.ok(buildScript.includes('[string]$ExpectedCommit')
    && buildScript.includes('does not match pinned commit'),
    'The companion build must reject source revisions that differ from the workflow pin');
  assert.ok(afterSignSource.includes("securityProfile !== 'labsuite-hardened-v1'")
    && afterSignSource.includes("createHash('sha256')"),
    'Windows packaging must refresh the manifest after Authenticode changes the sidecar bytes');
  assert.ok(supervisorSource.includes("type: 'ytmd:update'"));
  assert.ok(supervisorSource.includes("action === 'connect'")
    && nativeSource.includes('Console.InputEncoding = Encoding.UTF8'),
    'The native flyout must support one-click YTmusic connection and UTF-8 runtime messages');
  assert.ok(!nativeSource.includes('Authorization') && !nativeSource.includes('companion token'));
  for (const action of ['ytmdInstall', 'ytmdLaunch', 'ytmdPair', 'ytmdReconnect', 'ytmdForget', 'ytmdRefresh']) {
    assert.ok(preloadSource.includes(`labmedia:${action}`));
    assert.ok(ipcSource.includes(`labmedia:${action}`));
  }
  assert.throws(() => __private.validateVideoId('https://evil.example'), /Invalid/);
  assert.throws(() => __private.validatePlaylistId('../escape'), /Invalid/);
}

async function main() {
  testStateTransformation();
  await testPairingRealtimeCommandsAndForget();
  await testRevokedCredential();
  await testRejectsUpstreamService();
  await testBundledHardenedInstall();
  await testLibraryStartsAndHandsOffToYTmusic();
  testBundledExecutableIntegrity();
  testStaticSecurityContract();
  console.log('All LabMedia YTmusic companion tests passed cleanly!');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
