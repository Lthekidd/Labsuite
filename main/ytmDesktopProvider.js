const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { URL } = require('url');

const keychain = require('./keychain');

const BASE_URL = 'http://127.0.0.1:9863';
const REALTIME_URL = `${BASE_URL}/api/v1/realtime`;
const CREDENTIAL_SERVICE = 'LabSuite.LabMedia.LabSuiteMusic';
const CREDENTIAL_ACCOUNT = 'companion-v1';
const APP_ID = 'labsuite_labmedia';
const APP_NAME = 'LabSuite LabMedia';
const REQUIRED_PRODUCT = 'YTmusic';
const REQUIRED_SECURITY_PROFILE = 'labsuite-hardened-v1';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE_ITEMS = 50;
const MIN_COMMAND_INTERVAL_MS = 550;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_PATTERN = /^[a-fA-F0-9]{64,1024}$/;
const CONNECTION_STATES = Object.freeze([
  'notInstalled',
  'starting',
  'stopped',
  'serverDisabled',
  'requiresPairing',
  'pairing',
  'connected',
  'reauthRequired',
  'incompatible',
  'error'
]);

class YTMDesktopError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'YTMDesktopError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeText(value, maxLength = 300) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function safeHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' ? parsed.toString().slice(0, 2048) : '';
  } catch (_) {
    return '';
  }
}

function parseDuration(value) {
  const parts = String(value || '').split(':').map(Number);
  if (!parts.length || parts.some(part => !Number.isFinite(part) || part < 0)) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Math.max(0, Math.round(seconds * 1000));
}

function bestThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails)) return '';
  return thumbnails
    .map(item => ({
      url: safeHttpsUrl(item?.url),
      area: Math.max(0, Number(item?.width || 0)) * Math.max(0, Number(item?.height || 0))
    }))
    .filter(item => item.url)
    .sort((left, right) => right.area - left.area)[0]?.url || '';
}

function validateToken(value) {
  const token = String(value || '').trim();
  if (!TOKEN_PATTERN.test(token)) throw new YTMDesktopError('invalidToken', 'YTmusic returned an invalid companion token.');
  return token;
}

function validateVideoId(value, optional = false) {
  const id = String(value || '').trim();
  if (optional && !id) return '';
  if (!VIDEO_ID_PATTERN.test(id)) throw new YTMDesktopError('invalidId', 'Invalid YouTube video ID.');
  return id;
}

function validatePlaylistId(value, optional = false) {
  const id = String(value || '').trim();
  if (optional && !id) return '';
  if (!PLAYLIST_ID_PATTERN.test(id)) throw new YTMDesktopError('invalidId', 'Invalid YouTube playlist ID.');
  return id;
}

function isYTMDesktopSession(session = {}) {
  const identity = [session.sourceAppId, session.sourceApp, session.sessionId]
    .map(value => String(value || '').toLowerCase())
    .join(' ');
  return /(?:ytmusic|labsuite[-_. ]?music|youtube[-_. ]?music[-_. ]?desktop|ytmdesktop)/i.test(identity);
}

function emptyPlayback() {
  return {
    hasTrack: false,
    videoId: '',
    title: '',
    artist: '',
    album: '',
    artworkUrl: '',
    durationSeconds: 0,
    positionSeconds: 0,
    isPlaying: false,
    isBuffering: false,
    volume: 0,
    muted: false,
    shuffleActive: false,
    repeatMode: 'none',
    likeState: 'unknown',
    autoplay: false,
    isGenerating: false,
    isInfinite: false
  };
}

function emptyCapabilities() {
  return {
    canPlayPause: false,
    canSkipPrevious: false,
    canSkipNext: false,
    canSeek: false,
    canShuffle: false,
    canRepeat: false,
    canLike: false,
    canDislike: false,
    canSetVolume: false,
    canMute: false,
    canPlayQueueItem: false
  };
}

function unavailableQueue(message = 'YTmusic is not connected.') {
  return {
    status: 'unavailable',
    provider: 'ytmdesktop',
    message: safeText(message, 500),
    attribution: 'YouTube Music',
    autoplay: false,
    items: []
  };
}

function initialState() {
  return {
    status: 'notInstalled',
    message: 'YTmusic is missing from this LabSuite installation.',
    installed: false,
    running: false,
    paired: false,
    pairingCode: '',
    apiVersion: '',
    installing: false,
    installProgress: '',
    active: false,
    playback: emptyPlayback(),
    capabilities: emptyCapabilities(),
    queue: unavailableQueue()
  };
}

function normalizeQueueItem(item, queueIndex, kind) {
  const videoId = safeText(item?.videoId, 32);
  const available = VIDEO_ID_PATTERN.test(videoId);
  return {
    id: `${kind}-${queueIndex}-${available ? videoId : 'unavailable'}`,
    title: safeText(item?.title || 'Unavailable item', 300),
    artist: safeText(item?.author, 300),
    artworkUrl: bestThumbnail(item?.thumbnails),
    durationMs: parseDuration(item?.duration),
    attribution: kind === 'automix' ? 'YouTube Music · Autoplay' : 'YouTube Music',
    queueIndex,
    kind,
    available
  };
}

function transformPlayerState(raw = {}) {
  const player = raw?.player && typeof raw.player === 'object' ? raw.player : {};
  const video = raw?.video && typeof raw.video === 'object' ? raw.video : null;
  const queue = player?.queue && typeof player.queue === 'object' ? player.queue : null;
  const regularItems = Array.isArray(queue?.items) ? queue.items : [];
  const automixItems = Array.isArray(queue?.automixItems) ? queue.automixItems : [];
  let selectedIndex = Number.isInteger(queue?.selectedItemIndex) ? queue.selectedItemIndex : -1;
  if (selectedIndex < 0 || selectedIndex >= regularItems.length) {
    selectedIndex = regularItems.findIndex(item => item?.selected === true);
  }

  const upcoming = [];
  const regularStart = selectedIndex >= 0 ? selectedIndex + 1 : 0;
  for (let index = regularStart; index < regularItems.length && upcoming.length < MAX_QUEUE_ITEMS; index += 1) {
    upcoming.push(normalizeQueueItem(regularItems[index], index, 'queue'));
  }
  for (let index = 0; index < automixItems.length && upcoming.length < MAX_QUEUE_ITEMS; index += 1) {
    upcoming.push(normalizeQueueItem(automixItems[index], regularItems.length + index, 'automix'));
  }

  const repeatModes = { 0: 'none', 1: 'all', 2: 'one' };
  const likeStates = { 0: 'disliked', 1: 'neutral', 2: 'liked' };
  const playback = {
    hasTrack: !!video,
    videoId: VIDEO_ID_PATTERN.test(String(video?.id || '')) ? String(video.id) : '',
    title: safeText(video?.title, 300),
    artist: safeText(video?.author, 300),
    album: safeText(video?.album, 300),
    artworkUrl: bestThumbnail(video?.thumbnails),
    durationSeconds: Math.max(0, Number(video?.durationSeconds || 0)),
    positionSeconds: Math.max(0, Number(player?.videoProgress || 0)),
    isPlaying: Number(player?.trackState) === 1,
    isBuffering: Number(player?.trackState) === 2,
    volume: Math.max(0, Math.min(100, Number(player?.volume || 0))),
    muted: !!player?.muted,
    shuffleActive: false,
    repeatMode: repeatModes[Number(queue?.repeatMode)] || 'none',
    likeState: likeStates[Number(video?.likeStatus)] || 'unknown',
    autoplay: !!queue?.autoplay,
    isGenerating: !!queue?.isGenerating,
    isInfinite: !!queue?.isInfinite
  };

  let status = 'ready';
  let message = '';
  if (!queue) {
    status = video ? 'loading' : 'empty';
    message = video ? 'YouTube Music is preparing the queue…' : 'Start playback in YTmusic to load Up Next.';
  } else if (!upcoming.length && queue.isGenerating) {
    status = 'loading';
    message = 'YouTube Music is generating more recommendations…';
  } else if (!upcoming.length) {
    status = 'empty';
    message = 'The YouTube Music queue is currently empty.';
  }

  return {
    playback,
    capabilities: {
      canPlayPause: !!video,
      canSkipPrevious: !!video,
      canSkipNext: !!video,
      canSeek: !!video && playback.durationSeconds > 0,
      canShuffle: !!queue,
      canRepeat: !!queue,
      canLike: !!video,
      canDislike: !!video,
      canSetVolume: true,
      canMute: true,
      canPlayQueueItem: upcoming.some(item => item.available)
    },
    queue: {
      status,
      provider: 'ytmdesktop',
      message,
      attribution: queue?.autoplay ? 'YouTube Music · Autoplay' : 'YouTube Music · Live',
      autoplay: !!queue?.autoplay,
      items: upcoming
    },
    queueLength: regularItems.length + automixItems.length
  };
}

function defaultRequest(urlValue, options = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlValue); } catch (_) {
      reject(new YTMDesktopError('invalidUrl', 'Invalid YTmusic companion address.'));
      return;
    }
    if (url.origin !== BASE_URL || !url.pathname.startsWith('/api/v1/') && url.pathname !== '/metadata') {
      reject(new YTMDesktopError('invalidUrl', 'YTmusic requests are restricted to the local companion server.'));
      return;
    }

    const request = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: false
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        reject(new YTMDesktopError('redirectRejected', 'YTmusic companion redirects are not allowed.'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          request.destroy(new YTMDesktopError('responseTooLarge', 'YTmusic returned an oversized response.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : {}; } catch (_) { body = null; }
        resolve({ status: Number(response.statusCode || 0), headers: response.headers || {}, body, text });
      });
    });
    request.on('error', error => reject(new YTMDesktopError('unreachable', 'YTmusic could not be reached.', { cause: error })));
    request.setTimeout(options.timeoutMs || 5000, () => {
      request.destroy(new YTMDesktopError('timeout', 'YTmusic timed out.'));
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}

function isTrustedExecutable(candidate) {
  try {
    if (!candidate || !/^labsuite-music\.exe$/i.test(path.basename(candidate)) || !fs.existsSync(candidate)) return false;
    const manifestPath = path.join(path.dirname(candidate), 'labsuite-music.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
    if (
      manifest.product !== REQUIRED_PRODUCT ||
      manifest.securityProfile !== REQUIRED_SECURITY_PROFILE ||
      manifest.correspondingSource !== 'source' ||
      !/^[A-Fa-f0-9]{64}$/.test(String(manifest.executableSha256 || ''))
    ) return false;
    const sourcePath = path.join(path.dirname(candidate), manifest.correspondingSource);
    if (!fs.existsSync(path.join(sourcePath, 'LICENSE')) || !fs.existsSync(path.join(sourcePath, 'LABSUITE_FORK.md'))) return false;
    const actual = crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest();
    const expected = Buffer.from(manifest.executableSha256, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function defaultFindExecutable() {
  const projectRoot = path.resolve(__dirname, '..');
  const candidates = [
    path.join(projectRoot, 'bin', 'LabSuiteMusic', 'labsuite-music.exe'),
    path.join(process.resourcesPath || projectRoot, 'bin', 'LabSuiteMusic', 'labsuite-music.exe')
  ].filter(Boolean);
  return candidates.find(isTrustedExecutable) || '';
}

function defaultIsProcessRunning() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise(resolve => {
    execFile('tasklist.exe', ['/FI', 'IMAGENAME eq labsuite-music.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 3000
    }, (error, stdout) => resolve(!error && /labsuite-music\.exe/i.test(String(stdout || ''))));
  });
}

class YTMDesktopProvider {
  constructor(dependencies = {}) {
    this._request = dependencies.request || defaultRequest;
    this._getCredential = dependencies.getCredential || (() => keychain.getCredential(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT));
    this._setCredential = dependencies.setCredential || (token => keychain.setCredential(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT, token));
    this._deleteCredential = dependencies.deleteCredential || (() => keychain.deleteCredential(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT));
    this._findExecutable = dependencies.findExecutable || defaultFindExecutable;
    this._validateExecutable = dependencies.validateExecutable || isTrustedExecutable;
    this._isProcessRunning = dependencies.isProcessRunning || defaultIsProcessRunning;
    this._spawn = dependencies.spawn || spawn;
    this._socketFactory = dependencies.socketFactory || ((url, options) => require('socket.io-client').io(url, options));
    this._sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this._now = dependencies.now || (() => Date.now());
    this._appVersion = safeText(dependencies.appVersion || require('../package.json').version, 32) || '0.0.0';
    this._platform = dependencies.platform || process.platform;
    this._onChange = typeof dependencies.onChange === 'function' ? dependencies.onChange : (() => {});
    this._state = initialState();
    this._token = '';
    this._socket = null;
    this._rawPlayerState = null;
    this._queueLength = 0;
    this._initializePromise = null;
    this._pairPromise = null;
    this._pendingCommands = [];
    this._processingCommands = false;
    this._lastCommandAt = 0;
    this._shuttingDown = false;
  }

  setOnChange(handler) {
    this._onChange = typeof handler === 'function' ? handler : (() => {});
  }

  _publish() {
    try { this._onChange(this.getState()); } catch (_) {}
  }

  _patchState(patch = {}) {
    this._state = { ...this._state, ...patch };
    this._publish();
  }

  getState(session = {}) {
    const result = clone(this._state);
    result.active = result.status === 'connected' && isYTMDesktopSession(session);
    if (!result.active) result.queue = unavailableQueue(
      result.status === 'connected'
        ? 'Select the YTmusic media session to show its live queue.'
        : result.message
    );
    return result;
  }

  getQueueForSession(session = {}) {
    return this.getState(session).queue;
  }

  handlesSession(session = {}) {
    return isYTMDesktopSession(session);
  }

  isConnected() {
    return this._state.status === 'connected' && !!this._token;
  }

  async initialize() {
    if (this._initializePromise) return this._initializePromise;
    this._initializePromise = (async () => {
      this._shuttingDown = false;
      let storedToken = '';
      try { storedToken = String(await this._getCredential() || '').trim(); } catch (_) {}
      this._token = TOKEN_PATTERN.test(storedToken) ? storedToken : '';
      if (storedToken && !this._token) await this._deleteCredential().catch(() => {});
      return this.refreshStatus({ connect: true });
    })().finally(() => { this._initializePromise = null; });
    return this._initializePromise;
  }

  async refreshStatus({ connect = true } = {}) {
    const executablePath = this._findExecutable();
    const running = await this._isProcessRunning().catch(() => false);
    let serverReached = false;
    try {
      const metadata = await this._request(`${BASE_URL}/metadata`, { timeoutMs: 3000 });
      serverReached = true;
      if (metadata.status !== 200 || !Array.isArray(metadata.body?.apiVersions)) {
        throw new YTMDesktopError('incompatible', 'YTmusic returned invalid companion metadata.');
      }
      if (
        metadata.body.product !== REQUIRED_PRODUCT ||
        metadata.body.securityProfile !== REQUIRED_SECURITY_PROFILE ||
        metadata.body.transport !== 'loopback-only'
      ) {
        throw new YTMDesktopError('incompatible', 'A non-hardened YTMDesktop service is using port 9863. Close it and start YTmusic.');
      }
      if (!metadata.body.apiVersions.includes('v1')) {
        this._disconnectSocket();
        this._patchState({
          status: 'incompatible', message: 'This YTmusic build does not expose Companion API v1.',
          installed: !!executablePath || running, running: true, paired: !!this._token, apiVersion: '', pairingCode: ''
        });
        return this.getState();
      }
      this._patchState({
        status: this._token ? 'connected' : 'requiresPairing',
        message: this._token ? 'Connecting to YTmusic…' : 'Connect LabMedia to YTmusic on this PC.',
        installed: true, running: true, paired: !!this._token, apiVersion: 'v1', pairingCode: ''
      });
      if (this._token && connect) await this._connectAuthenticated();
      return this.getState();
    } catch (error) {
      if (error?.code === 'reauthRequired' || this._state.status === 'reauthRequired') return this.getState();
      this._disconnectSocket();
      this._rawPlayerState = null;
      this._queueLength = 0;
      if (serverReached) {
        const incompatible = error?.code === 'incompatible';
        this._patchState({
          status: incompatible ? 'incompatible' : 'error',
          message: safeText(error?.message || 'YTmusic returned invalid companion state.', 240),
          installed: true, running: true, paired: !!this._token, pairingCode: '',
          playback: emptyPlayback(), capabilities: emptyCapabilities(), queue: unavailableQueue(error?.message)
        });
        return this.getState();
      }
      const status = running ? 'serverDisabled' : executablePath ? 'stopped' : 'notInstalled';
      const messages = {
        serverDisabled: 'YTmusic is running, but its local companion service is disabled.',
        stopped: 'Start YTmusic to use its live queue and playback controls.',
        notInstalled: 'YTmusic is missing from this LabSuite installation.'
      };
      this._patchState({
        status, message: messages[status], installed: !!executablePath || running, running,
        paired: !!this._token, apiVersion: '', pairingCode: '', playback: emptyPlayback(),
        capabilities: emptyCapabilities(), queue: unavailableQueue(messages[status])
      });
      return this.getState();
    }
  }

  async _authenticatedRequest(pathname, options = {}) {
    if (!this._token) throw new YTMDesktopError('requiresPairing', 'Connect LabMedia to YTmusic first.');
    const response = await this._request(`${BASE_URL}${pathname}`, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: this._token, Accept: 'application/json' }
    });
    if (response.status === 401) {
      await this._markReauthRequired();
      throw new YTMDesktopError('reauthRequired', 'YTmusic no longer accepts this connection. Connect again.');
    }
    return response;
  }

  async _connectAuthenticated() {
    const response = await this._authenticatedRequest('/api/v1/state', { timeoutMs: 5000 });
    if (response.status < 200 || response.status >= 300 || !response.body || typeof response.body !== 'object') {
      throw new YTMDesktopError('stateError', 'YTmusic returned invalid playback state.');
    }
    this._applyPlayerState(response.body);
    this._connectSocket();
    this._patchState({
      status: 'connected', message: 'Connected securely to YTmusic on this PC.', installed: true,
      running: true, paired: true, apiVersion: 'v1', pairingCode: ''
    });
    return this.getState();
  }

  _applyPlayerState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const transformed = transformPlayerState(raw);
    this._rawPlayerState = raw;
    this._queueLength = transformed.queueLength;
    this._state = {
      ...this._state,
      playback: transformed.playback,
      capabilities: transformed.capabilities,
      queue: transformed.queue
    };
    this._publish();
    return true;
  }

  _connectSocket() {
    if (!this._token || this._shuttingDown) return;
    this._disconnectSocket();
    const socket = this._socketFactory(REALTIME_URL, {
      transports: ['websocket'],
      upgrade: false,
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      randomizationFactor: 0.25,
      timeout: 5000,
      auth: { token: this._token }
    });
    this._socket = socket;
    socket.on('connect', () => {
      if (socket !== this._socket) return;
      this._patchState({ status: 'connected', message: 'Connected securely to YTmusic on this PC.', running: true, paired: true });
    });
    socket.on('state-update', state => {
      if (socket === this._socket) this._applyPlayerState(state);
    });
    socket.on('disconnect', () => {
      if (socket !== this._socket || this._shuttingDown) return;
      this._rejectPendingCommands(new YTMDesktopError('disconnected', 'YTmusic disconnected before the command was sent.'));
      this._patchState({ status: 'error', message: 'YTmusic connection was interrupted; reconnecting…', running: false });
    });
    socket.on('connect_error', error => {
      if (socket !== this._socket || this._shuttingDown) return;
      const code = safeText(error?.data?.code || error?.message, 80).toUpperCase();
      if (code.includes('UNAUTHENTICATED') || code.includes('UNAUTHORIZED')) {
        this._markReauthRequired().catch(() => {});
      } else {
        this._patchState({ status: 'error', message: 'YTmusic is temporarily unavailable; reconnecting…', running: false });
      }
    });
  }

  _disconnectSocket() {
    const socket = this._socket;
    this._socket = null;
    if (!socket) return;
    try { socket.removeAllListeners(); } catch (_) {}
    try { socket.disconnect(); } catch (_) {}
    try { socket.close(); } catch (_) {}
  }

  _rejectPendingCommands(error) {
    this._pendingCommands.splice(0).forEach(entry => {
      entry.waiters.forEach(({ reject }) => reject(error));
    });
  }

  async _markReauthRequired() {
    this._disconnectSocket();
    this._token = '';
    this._rejectPendingCommands(new YTMDesktopError('reauthRequired', 'YTmusic authorization was revoked.'));
    await this._deleteCredential().catch(() => {});
    this._patchState({
      status: 'reauthRequired', message: 'YTmusic revoked this connection. Connect again.',
      paired: false, pairingCode: '', playback: emptyPlayback(), capabilities: emptyCapabilities(),
      queue: unavailableQueue('Connect YTmusic again to restore its live queue.')
    });
  }

  _apiError(response, fallback) {
    const code = safeText(response?.body?.code || response?.body?.error, 80);
    const message = safeText(response?.body?.message, 240) || fallback;
    if (code === 'AUTHORIZATION_DISABLED') {
      return new YTMDesktopError('authorizationDisabled', 'YTmusic did not open its approval window. Try Connect again.');
    }
    if (code === 'AUTHORIZATION_DENIED') return new YTMDesktopError('authorizationDenied', 'YTmusic connection was denied.');
    if (code === 'AUTHORIZATION_TIME_OUT') return new YTMDesktopError('authorizationTimeout', 'YTmusic approval timed out.');
    if (response?.status === 401) return new YTMDesktopError('reauthRequired', 'YTmusic rejected this connection.');
    return new YTMDesktopError(code || 'apiError', message);
  }

  async pair() {
    if (this._pairPromise) return this._pairPromise;
    this._pairPromise = (async () => {
      await this.launch({ pairing: true, connect: false });
      if (!['requiresPairing', 'reauthRequired', 'connected'].includes(this._state.status)) {
        throw new YTMDesktopError('notReady', this._state.message || 'YTmusic is not ready to connect.');
      }
      this._disconnectSocket();
      this._patchState({ status: 'pairing', message: 'Requesting one-time approval from YTmusic…', pairingCode: '' });
      const requestBody = JSON.stringify({ appId: APP_ID, appName: APP_NAME, appVersion: this._appVersion });
      const codeResponse = await this._request(`${BASE_URL}/api/v1/auth/requestcode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: requestBody, timeoutMs: 10000
      });
      if (codeResponse.status < 200 || codeResponse.status >= 300 || !/^\d{4}$/.test(String(codeResponse.body?.code || ''))) {
        throw this._apiError(codeResponse, 'YTmusic could not create an approval code.');
      }
      const code = String(codeResponse.body.code);
      this._patchState({
        status: 'pairing', pairingCode: code,
        message: `Approve code ${code} in the YTmusic authorization window.`
      });
      const tokenResponse = await this._request(`${BASE_URL}/api/v1/auth/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ appId: APP_ID, code }), timeoutMs: 35000
      });
      if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
        throw this._apiError(tokenResponse, 'YTmusic connection failed.');
      }
      const token = validateToken(tokenResponse.body?.token);
      await this._setCredential(token);
      this._token = token;
      await this._connectAuthenticated();
      return this.getState();
    })().catch(error => {
      if (this._state.status === 'pairing') {
        this._patchState({
          status: error?.code === 'authorizationDisabled' ? 'requiresPairing' : 'error',
          message: safeText(error?.message || 'YTmusic connection failed.', 240), pairingCode: '', paired: false
        });
      }
      throw error;
    }).finally(() => { this._pairPromise = null; });
    return this._pairPromise;
  }

  async reconnect() {
    if (this._token) {
      const state = await this.refreshStatus({ connect: true });
      if (state.status === 'connected' || state.status === 'incompatible') return state;
      return this.launch({ pairing: state.status === 'serverDisabled', connect: true });
    }
    return this.pair();
  }

  async forget() {
    this._disconnectSocket();
    this._token = '';
    this._rawPlayerState = null;
    this._queueLength = 0;
    this._rejectPendingCommands(new YTMDesktopError('forgotten', 'YTmusic connection was forgotten.'));
    await this._deleteCredential().catch(() => {});
    this._patchState({
      status: 'requiresPairing', paired: false, pairingCode: '', playback: emptyPlayback(), capabilities: emptyCapabilities(),
      queue: unavailableQueue('Connect YTmusic to restore its live queue.'),
      message: 'LabMedia forgot its token. Remove LabSuite from YTmusic’s Authorized companions list to revoke it there.'
    });
    return this.getState();
  }

  async _waitForReady({ connect = true, timeoutMs = 20000, returnOnServerDisabled = true } = {}) {
    const maxAttempts = Math.max(1, Math.ceil(timeoutMs / 500));
    for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
      await this._sleep(attempts === 0 ? 300 : 500);
      const state = await this.refreshStatus({ connect });
      if (['connected', 'requiresPairing', 'reauthRequired', 'incompatible'].includes(state.status)) return state;
      if (returnOnServerDisabled && state.status === 'serverDisabled' && attempts >= 4) return state;
    }
    throw new YTMDesktopError('startupTimeout', 'YTmusic did not become ready. Close it and try again.');
  }

  async launch({ pairing = false, connect = true } = {}) {
    const executablePath = this._findExecutable();
    if (!executablePath || !this._validateExecutable(executablePath)) {
      throw new YTMDesktopError('notInstalled', 'YTmusic is not available in a trusted LabSuite location.');
    }
    const args = pairing ? ['labsuite-music://pair'] : [];
    const child = this._spawn(executablePath, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child?.unref?.();
    this._patchState({ status: 'starting', installed: true, message: pairing ? 'Starting YTmusic for approval…' : 'Starting YTmusic…' });
    return this._waitForReady({ connect, returnOnServerDisabled: !pairing });
  }

  async openRecommendations() {
    return this.launch();
  }

  async install() {
    if (this._platform !== 'win32') throw new YTMDesktopError('unsupported', 'YTmusic is supported only on Windows.');
    const executablePath = this._findExecutable();
    if (!executablePath || !this._validateExecutable(executablePath)) {
      throw new YTMDesktopError(
        'notInstalled',
        'The hardened YTmusic build is missing. Reinstall or update LabSuite.'
      );
    }
    this._patchState({ installing: false, installProgress: '', installed: true, message: 'YTmusic is ready to launch.' });
    return this.getState();
  }

  _commandBody(action, payload = {}) {
    const simple = new Set(['playPause', 'play', 'pause', 'next', 'previous', 'mute', 'unmute', 'shuffle', 'toggleLike', 'toggleDislike']);
    if (simple.has(action)) return { command: action };
    if (action === 'setVolume') {
      const value = Number(payload.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new YTMDesktopError('invalidCommand', 'Volume must be between 0 and 100.');
      return { command: action, data: Math.round(value) };
    }
    if (action === 'seekTo') {
      const value = Number(payload.value);
      const duration = Number(this._state.playback.durationSeconds || 0);
      if (!Number.isFinite(value) || value < 0 || duration <= 0 || value > duration + 1) throw new YTMDesktopError('invalidCommand', 'Seek position is outside the current track.');
      return { command: action, data: Math.max(0, Math.min(duration, value)) };
    }
    if (action === 'repeatMode') {
      const modes = { none: 0, all: 1, one: 2 };
      if (!Object.prototype.hasOwnProperty.call(modes, payload.value)) throw new YTMDesktopError('invalidCommand', 'Invalid repeat mode.');
      return { command: action, data: modes[payload.value] };
    }
    if (action === 'playQueueIndex') {
      const value = Number(payload.queueIndex);
      const exposedItem = this._state.queue.items.find(item => item.queueIndex === value && item.available);
      if (!Number.isInteger(value) || value < 0 || value >= this._queueLength || !exposedItem) {
        throw new YTMDesktopError('invalidCommand', 'Queue item is no longer available.');
      }
      return { command: action, data: value };
    }
    if (action === 'changeVideo') {
      const videoId = validateVideoId(payload.videoId, true);
      const playlistId = validatePlaylistId(payload.playlistId, true);
      if (!videoId && !playlistId) throw new YTMDesktopError('invalidCommand', 'A validated video or playlist ID is required.');
      return { command: action, data: { ...(videoId ? { videoId } : {}), ...(playlistId ? { playlistId } : {}) } };
    }
    throw new YTMDesktopError('invalidCommand', 'Unsupported YTmusic command.');
  }

  sendCommand(action, payload = {}) {
    if (!this.isConnected()) return Promise.reject(new YTMDesktopError('notConnected', 'YTmusic is not connected.'));
    const body = this._commandBody(String(action || ''), payload);
    const coalesceKey = ['setVolume', 'seekTo'].includes(body.command) ? body.command : '';
    return new Promise((resolve, reject) => {
      const existing = coalesceKey ? this._pendingCommands.find(entry => entry.coalesceKey === coalesceKey) : null;
      if (existing) {
        existing.body = body;
        existing.waiters.push({ resolve, reject });
      } else {
        this._pendingCommands.push({ body, coalesceKey, waiters: [{ resolve, reject }] });
      }
      this._drainCommands().catch(() => {});
    });
  }

  async _drainCommands() {
    if (this._processingCommands) return;
    this._processingCommands = true;
    try {
      while (this._pendingCommands.length && this.isConnected()) {
        const waitMs = Math.max(0, MIN_COMMAND_INTERVAL_MS - (this._now() - this._lastCommandAt));
        if (waitMs) await this._sleep(waitMs);
        const entry = this._pendingCommands.shift();
        try {
          const response = await this._authenticatedRequest('/api/v1/command', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry.body), timeoutMs: 5000
          });
          this._lastCommandAt = this._now();
          if (response.status < 200 || response.status >= 300) throw this._apiError(response, 'YTmusic command failed.');
          entry.waiters.forEach(({ resolve }) => resolve(true));
        } catch (error) {
          entry.waiters.forEach(({ reject }) => reject(error));
        }
      }
    } finally {
      this._processingCommands = false;
      if (this._pendingCommands.length && this.isConnected()) this._drainCommands().catch(() => {});
    }
  }

  async playLibraryItem({ playlistId = '', videoId = '' } = {}) {
    if (!this.isConnected()) {
      const executablePath = this._findExecutable();
      if (!executablePath || !this._validateExecutable(executablePath)) return false;
      try {
        await this.launch({
          pairing: !this._token || this._state.status === 'serverDisabled' || this._state.status === 'requiresAuth',
          connect: true
        });
      } catch (error) {
        this._patchState({
          status: 'error',
          message: safeText(error?.message || 'YTmusic could not start this Library item.', 240),
          queue: unavailableQueue(error?.message)
        });
        return true;
      }
    }

    if (!this.isConnected()) return true;
    try {
      await this.sendCommand('changeVideo', { playlistId, videoId });
    } catch (error) {
      if (this._state.status !== 'reauthRequired') {
        this._patchState({
          status: 'error',
          message: safeText(error?.message || 'YTmusic could not play this Library item.', 240),
          queue: unavailableQueue(error?.message)
        });
      }
    }
    return true;
  }

  shutdown() {
    this._shuttingDown = true;
    this._disconnectSocket();
    this._token = '';
    this._rawPlayerState = null;
    this._queueLength = 0;
    this._rejectPendingCommands(new YTMDesktopError('shutdown', 'LabSuite is closing.'));
    this._state = initialState();
  }
}

module.exports = {
  YTMDesktopProvider,
  YTMDesktopError,
  BASE_URL,
  REALTIME_URL,
  CONNECTION_STATES,
  MAX_QUEUE_ITEMS,
  __private: {
    safeText,
    safeHttpsUrl,
    parseDuration,
    transformPlayerState,
    validateToken,
    validateVideoId,
    validatePlaylistId,
    isYTMDesktopSession,
    defaultRequest,
    defaultFindExecutable,
    isTrustedExecutable
  }
};
