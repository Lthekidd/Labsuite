const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const { URL, URLSearchParams } = require('url');

const keychain = require('./keychain');
const rclone = require('./rclone');

const CREDENTIAL_SERVICE = 'LabSuite.LabMedia.YouTube';
const CREDENTIAL_ACCOUNT = 'oauth-v1';
const CACHE_TTL_MS = 10 * 60 * 1000;
const OAUTH_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SCOPES = Object.freeze([
  'openid',
  'email',
  'https://www.googleapis.com/auth/youtube.readonly'
]);
const CANONICAL_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const CONNECTION_STATES = Object.freeze([
  'requiresSetup', 'requiresAuth', 'connecting', 'connected', 'reauthRequired', 'error'
]);
const LIBRARY_STATES = Object.freeze([
  'idle', 'loading', 'ready', 'empty', 'offline', 'quotaExceeded', 'error'
]);
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

class YouTubeLibraryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'YouTubeLibraryError';
    this.code = code;
    Object.assign(this, details);
  }
}

function emptyLibrary() {
  return {
    status: 'idle',
    message: 'Open Library to load playlists.',
    attribution: 'YouTube',
    playlists: [],
    selectedPlaylist: null,
    items: [],
    hasMore: false
  };
}

function initialState() {
  return {
    connection: {
      status: 'requiresSetup',
      email: '',
      channelTitle: '',
      message: 'Add a personal Google Desktop OAuth client in Suite Settings, then reconnect Drive.'
    },
    library: emptyLibrary()
  };
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
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch (_) {
    return '';
  }
}

const CURATED_RADIO_PLAYLIST = Object.freeze({
  id: 'RADIO_STATIONS',
  title: '24/7 Lo-Fi & Ambient Radio',
  thumbnailUrl: 'https://i.ytimg.com/vi/jfKfPfyJRdk/hqdefault.jpg',
  itemCount: 5,
  isLiked: false,
  attribution: 'Radio'
});

const CURATED_RADIO_ITEMS = Object.freeze([
  { id: 'radio-1', videoId: 'jfKfPfyJRdk', title: 'Lofi Hip Hop Radio – Beats to Relax/Study to', artist: 'Lofi Girl', thumbnailUrl: 'https://i.ytimg.com/vi/jfKfPfyJRdk/hqdefault.jpg', durationMs: 0, available: true, attribution: 'Radio' },
  { id: 'radio-2', videoId: '4xDzrJKXOOY', title: 'Synthwave Radio – Chill Synth Beats', artist: 'Lofi Girl', thumbnailUrl: 'https://i.ytimg.com/vi/4xDzrJKXOOY/hqdefault.jpg', durationMs: 0, available: true, attribution: 'Radio' },
  { id: 'radio-3', videoId: '5wRWniH7WDA', title: 'Chillhop Radio – Jazzy & Lofi Beats', artist: 'Chillhop Music', thumbnailUrl: 'https://i.ytimg.com/vi/5wRWniH7WDA/hqdefault.jpg', durationMs: 0, available: true, attribution: 'Radio' },
  { id: 'radio-4', videoId: 'DWcJFNfaw9c', title: 'Peaceful Piano Radio – Relax & Study', artist: 'Relaxing Music', thumbnailUrl: 'https://i.ytimg.com/vi/DWcJFNfaw9c/hqdefault.jpg', durationMs: 0, available: true, attribution: 'Radio' },
  { id: 'radio-5', videoId: 'Dx5qFact3Mg', title: 'Smooth Jazz Cafe Radio – Soft Background Jazz', artist: 'Cafe Music BGM', thumbnailUrl: 'https://i.ytimg.com/vi/Dx5qFact3Mg/hqdefault.jpg', durationMs: 0, available: true, attribution: 'Radio' }
]);

function validatePlaylistId(value) {
  const id = String(value || '').trim();
  if (id === 'RADIO_STATIONS') return id;
  if (!PLAYLIST_ID_PATTERN.test(id)) throw new YouTubeLibraryError('invalidId', 'Invalid YouTube playlist ID.');
  return id;
}

function validateVideoId(value) {
  const id = String(value || '').trim();
  if (!VIDEO_ID_PATTERN.test(id)) throw new YouTubeLibraryError('invalidId', 'Invalid YouTube video ID.');
  return id;
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function parseIsoDuration(value) {
  const match = String(value || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return 0;
  return Math.round((Number(match[1] || 0) * 86400
    + Number(match[2] || 0) * 3600
    + Number(match[3] || 0) * 60
    + Number(match[4] || 0)) * 1000);
}

function bestThumbnail(thumbnails) {
  const options = ['maxres', 'standard', 'high', 'medium', 'default'];
  for (const key of options) {
    const url = safeHttpsUrl(thumbnails?.[key]?.url);
    if (url) return url;
  }
  return '';
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function hasRequiredScopes(scopeValue) {
  const granted = new Set(String(scopeValue || '').split(/\s+/).filter(Boolean));
  const hasEmailIdentity = granted.has('email') || granted.has(CANONICAL_EMAIL_SCOPE);
  return granted.has('openid') && hasEmailIdentity && granted.has(YOUTUBE_READONLY_SCOPE);
}

function missingRequiredScopes(scopeValue) {
  const granted = new Set(String(scopeValue || '').split(/\s+/).filter(Boolean));
  const missing = [];
  if (!granted.has('openid')) missing.push('openid');
  if (!granted.has('email') && !granted.has(CANONICAL_EMAIL_SCOPE)) missing.push('email');
  if (!granted.has(YOUTUBE_READONLY_SCOPE)) missing.push('youtube.readonly');
  return missing;
}

function findBrowserExecutable(appChoice = 'auto') {
  const edgeCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null
  ].filter(Boolean);

  const chromeCandidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null
  ].filter(Boolean);

  const findFirst = candidates => candidates.find(candidate => fs.existsSync(candidate));

  if (appChoice === 'edge') return findFirst(edgeCandidates) || null;
  if (appChoice === 'chrome') return findFirst(chromeCandidates) || null;

  return findFirst(edgeCandidates) || findFirst(chromeCandidates) || null;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultRequest(urlValue, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlValue);
    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          request.destroy(new YouTubeLibraryError('responseTooLarge', 'YouTube returned an oversized response.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : {}; } catch (_) { body = null; }
        resolve({
          status: Number(response.statusCode || 0),
          headers: response.headers || {},
          body,
          text
        });
      });
    });

    request.on('error', error => reject(new YouTubeLibraryError('offline', 'YouTube could not be reached.', { cause: error })));
    request.setTimeout(options.timeoutMs || 15000, () => {
      request.destroy(new YouTubeLibraryError('offline', 'The YouTube request timed out.'));
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}

function parseStoredCredential(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const refreshToken = String(value?.refreshToken || '');
    const email = String(value?.email || '').trim().toLowerCase();
    if (value?.version !== 1 || !refreshToken || !/^\S+@\S+\.\S+$/.test(email)) return null;
    return { version: 1, refreshToken, email };
  } catch (_) {
    return null;
  }
}

function googleErrorReason(response) {
  const errors = response?.body?.error?.errors;
  return Array.isArray(errors) ? safeText(errors[0]?.reason, 80) : '';
}

function classifyApiError(response) {
  const status = Number(response?.status || 0);
  const reason = googleErrorReason(response);
  if (status === 403 && ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) {
    return new YouTubeLibraryError('quotaExceeded', 'YouTube API quota is currently exhausted. Try again later.');
  }
  if (status === 403 && ['accessNotConfigured', 'forbidden'].includes(reason)) {
    return new YouTubeLibraryError('apiNotEnabled', 'Enable YouTube Data API v3 for the connected Google Cloud project.');
  }
  if (status === 429) return new YouTubeLibraryError('quotaExceeded', 'YouTube is rate limiting requests. Try again later.');
  if (status >= 500) return new YouTubeLibraryError('offline', 'YouTube is temporarily unavailable.');
  return new YouTubeLibraryError('apiError', `YouTube returned an error (${status || 'unknown'}).`);
}

class YouTubeLibraryProvider {
  constructor(dependencies = {}) {
    this._request = dependencies.request || defaultRequest;
    this._sleep = dependencies.sleep || delay;
    this._now = dependencies.now || (() => Date.now());
    this._randomBytes = dependencies.randomBytes || crypto.randomBytes;
    this._createHash = dependencies.createHash || crypto.createHash;
    this._createServer = dependencies.createServer || http.createServer;
    this._getOAuthContext = dependencies.getOAuthContext || (() => rclone.getGoogleOAuthApplicationContext());
    this._getCredential = dependencies.getCredential || (() => keychain.getCredential(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT));
    this._setCredential = dependencies.setCredential || (secret => keychain.setCredential(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT, secret));
    this._deleteCredential = dependencies.deleteCredential || (() => keychain.deleteCredential(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT));
    this._openExternal = dependencies.openExternal || (url => require('electron').shell.openExternal(url));
    this._spawn = dependencies.spawn || spawn;
    this._onChange = dependencies.onChange || (() => {});
    this._state = initialState();
    this._credential = null;
    this._accessToken = '';
    this._accessTokenExpiresAt = 0;
    this._refreshPromise = null;
    this._connectPromise = null;
    this._actionPromise = Promise.resolve();
    this._activeOAuth = null;
    this._playlistNextPageToken = '';
    this._itemNextPageToken = '';
    this._cacheUpdatedAt = 0;
    this._playlistItemCache = new Map();
  }

  setOnChange(handler) {
    this._onChange = typeof handler === 'function' ? handler : (() => {});
  }

  _publish() {
    try { this._onChange(this.getState()); } catch (_) {}
  }

  getState() {
    return clone(this._state);
  }

  async initialize() {
    let context = { clientId: '', clientSecret: '', email: '' };
    try { context = await this._getOAuthContext(); } catch (_) {}
    if (!context?.clientId || !context?.clientSecret) {
      this._state.connection = {
        status: 'requiresSetup', email: '', channelTitle: '',
        message: 'Add a personal Google Desktop OAuth client in Suite Settings, then reconnect Drive.'
      };
      this._publish();
      return this.getState();
    }

    this._credential = parseStoredCredential(await this._getCredential());
    if (this._credential) {
      this._state.connection = {
        status: 'connected', email: this._credential.email, channelTitle: '',
        message: `Connected as ${this._credential.email}`
      };
    } else {
      this._state.connection = {
        status: 'requiresAuth', email: '', channelTitle: '',
        message: 'Connect the same Google account used by Drive.'
      };
    }
    this._publish();
    return this.getState();
  }

  async _tokenRequest(params) {
    const response = await this._request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      timeoutMs: 15000
    });
    if (response.status >= 200 && response.status < 300 && response.body) return response.body;
    const oauthCode = safeText(response?.body?.error, 80);
    if (oauthCode === 'invalid_grant') throw new YouTubeLibraryError('invalidGrant', 'YouTube access must be reconnected.');
    throw new YouTubeLibraryError('oauthError', 'Google authorization could not be completed.');
  }

  async _refreshAccessToken() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = (async () => {
      if (!this._credential?.refreshToken) throw new YouTubeLibraryError('invalidGrant', 'YouTube access must be reconnected.');
      const context = await this._getOAuthContext();
      if (!context?.clientId || !context?.clientSecret) throw new YouTubeLibraryError('requiresSetup', 'Google OAuth client configuration is missing.');
      try {
        const token = await this._tokenRequest({
          client_id: context.clientId,
          client_secret: context.clientSecret,
          refresh_token: this._credential.refreshToken,
          grant_type: 'refresh_token'
        });
        this._accessToken = String(token.access_token || '');
        if (!this._accessToken) throw new YouTubeLibraryError('oauthError', 'Google did not return an access token.');
        this._accessTokenExpiresAt = this._now() + Math.max(60, Number(token.expires_in || 3600)) * 1000;
        return this._accessToken;
      } catch (error) {
        if (error?.code === 'invalidGrant') await this._markReauthRequired();
        throw error;
      }
    })().finally(() => { this._refreshPromise = null; });
    return this._refreshPromise;
  }

  async _getAccessToken(force = false) {
    if (!force && this._accessToken && this._accessTokenExpiresAt > this._now() + 60000) return this._accessToken;
    return this._refreshAccessToken();
  }

  async _markReauthRequired() {
    this._accessToken = '';
    this._accessTokenExpiresAt = 0;
    this._credential = null;
    await this._deleteCredential();
    this._clearLibrary();
    this._state.connection = {
      status: 'reauthRequired', email: '', channelTitle: '',
      message: 'Google revoked or expired this grant. Reconnect YouTube.'
    };
    this._publish();
  }

  async _apiGet(resource, params = {}) {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    let retried401 = false;
    let retriedRateLimit = false;
    let forceRefresh = false;
    while (true) {
      const token = await this._getAccessToken(forceRefresh);
      forceRefresh = false;
      const response = await this._request(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeoutMs: 15000
      });
      if (response.status >= 200 && response.status < 300 && response.body) return response.body;
      if (response.status === 401 && !retried401) {
        retried401 = true;
        this._accessToken = '';
        forceRefresh = true;
        continue;
      }
      const retryAfter = parseRetryAfter(response.headers?.['retry-after'], this._now());
      if ((response.status === 429 || response.status >= 500) && retryAfter > 0 && !retriedRateLimit) {
        retriedRateLimit = true;
        await this._sleep(Math.min(retryAfter, 120000));
        continue;
      }
      throw classifyApiError(response);
    }
  }

  async _startAuthorization(context) {
    if (this._activeOAuth) throw new YouTubeLibraryError('oauthBusy', 'A Google authorization is already in progress.');
    const verifier = base64Url(this._randomBytes(64));
    const challenge = base64Url(this._createHash('sha256').update(verifier).digest());
    const state = base64Url(this._randomBytes(32));

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        const server = this._activeOAuth?.server;
        this._activeOAuth = null;
        try { server?.close(); } catch (_) {}
        if (error) reject(error); else resolve(value);
      };

      const server = this._createServer(async (request, response) => {
        try {
          const callback = new URL(request.url || '/', 'http://127.0.0.1');
          if (request.method !== 'GET' || callback.pathname !== '/oauth2/callback') {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
          }
          if (callback.searchParams.get('state') !== state) {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('LabMedia rejected this callback. You can close this tab.');
            finish(new YouTubeLibraryError('stateMismatch', 'Google authorization state validation failed.'));
            return;
          }
          const oauthError = callback.searchParams.get('error');
          const code = callback.searchParams.get('code');
          if (oauthError || !code) {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('YouTube access was not granted. You can close this tab.');
            finish(new YouTubeLibraryError('accessDenied', 'YouTube authorization was cancelled or denied.'));
            return;
          }
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
          });
          response.end('<!doctype html><meta charset="utf-8"><title>Google approval received</title><style>body{font:16px system-ui;background:#111318;color:#eef2f7;padding:48px;max-width:760px}h1{font-size:24px}</style><h1>Google approval received</h1><p>Return to LabSuite while it verifies the account and loads YouTube Library.</p><p>This page confirms only the browser approval, not that setup finished.</p>');
          finish(null, { code, verifier, redirectUri: `http://127.0.0.1:${server.address().port}/oauth2/callback` });
        } catch (_) {
          finish(new YouTubeLibraryError('oauthCallback', 'Google authorization callback was malformed.'));
        }
      });

      server.on('error', () => finish(new YouTubeLibraryError('oauthServer', 'LabMedia could not start the local authorization callback.')));
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address();
        const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authUrl.search = new URLSearchParams({
          client_id: context.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES.join(' '),
          access_type: 'offline',
          prompt: 'consent',
          include_granted_scopes: 'false',
          login_hint: context.email,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256'
        }).toString();
        try {
          await this._openExternal(authUrl.toString());
        } catch (_) {
          finish(new YouTubeLibraryError('browserOpen', 'LabMedia could not open the system browser.'));
        }
      });
      this._activeOAuth = { server, finish };
      timeout = setTimeout(() => finish(new YouTubeLibraryError('oauthTimeout', 'Google authorization timed out.')), OAUTH_TIMEOUT_MS);
      timeout.unref?.();
    });
  }

  async connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = (async () => {
      this._state.connection = { status: 'connecting', email: '', channelTitle: '', message: 'Waiting for Google authorization…' };
      this._publish();
      try {
        const context = await this._getOAuthContext();
        if (!context?.clientId || !context?.clientSecret || !context?.email) {
          throw new YouTubeLibraryError('requiresSetup', 'Add a personal Google Desktop OAuth client in Suite Settings, then reconnect Drive.');
        }
        const grant = await this._startAuthorization(context);
        const token = await this._tokenRequest({
          client_id: context.clientId,
          client_secret: context.clientSecret,
          code: grant.code,
          code_verifier: grant.verifier,
          redirect_uri: grant.redirectUri,
          grant_type: 'authorization_code'
        });
        const accessToken = String(token.access_token || '');
        const refreshToken = String(token.refresh_token || '');
        if (!accessToken || !refreshToken) throw new YouTubeLibraryError('oauthError', 'Google did not return a durable YouTube grant. Try Reconnect.');
        // Google may canonicalize the requested `email` scope to
        // `https://www.googleapis.com/auth/userinfo.email` in the token
        // response. Treat those spellings as equivalent while still requiring
        // the exact read-only YouTube permission and OpenID identity scope.
        if (!hasRequiredScopes(token.scope)) {
          const missingScopes = missingRequiredScopes(token.scope);
          await this._revokeToken(refreshToken);
          const message = missingScopes.includes('youtube.readonly')
            ? 'Google did not grant YouTube read-only access. Add the YouTube read-only scope under Google Auth Platform → Data Access, then reconnect.'
            : 'Google did not grant the identity scopes needed to verify this is the same Gmail account as Drive.';
          throw new YouTubeLibraryError('missingScope', message);
        }
        const profileResponse = await this._request('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, timeoutMs: 15000
        });
        const email = String(profileResponse?.body?.email || '').trim().toLowerCase();
        if (profileResponse.status < 200 || profileResponse.status >= 300 || !email || email !== String(context.email).toLowerCase()) {
          await this._revokeToken(refreshToken);
          throw new YouTubeLibraryError('accountMismatch', `Authorize the same Google account used by Drive (${context.email}).`);
        }
        this._credential = { version: 1, refreshToken, email };
        await this._setCredential(JSON.stringify(this._credential));
        this._accessToken = accessToken;
        this._accessTokenExpiresAt = this._now() + Math.max(60, Number(token.expires_in || 3600)) * 1000;
        this._clearLibrary();
        this._state.connection = { status: 'connected', email, channelTitle: '', message: `Connected as ${email}` };
        this._publish();
        await this.refreshLibrary({ force: true });
        return this.getState();
      } catch (error) {
        if (error?.code === 'requiresSetup') {
          this._state.connection = { status: 'requiresSetup', email: '', channelTitle: '', message: error.message };
        } else if (this._state.connection.status !== 'reauthRequired') {
          this._state.connection = { status: 'error', email: '', channelTitle: '', message: safeText(error?.message || 'YouTube connection failed.', 240) };
        }
        this._publish();
        throw error;
      }
    })().finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  }

  async _revokeToken(token) {
    if (!token) return false;
    try {
      const response = await this._request('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ token }).toString(),
        timeoutMs: 10000
      });
      return response.status >= 200 && response.status < 300;
    } catch (_) {
      return false;
    }
  }

  _clearLibrary() {
    this._state.library = emptyLibrary();
    this._playlistNextPageToken = '';
    this._itemNextPageToken = '';
    this._cacheUpdatedAt = 0;
    this._playlistItemCache.clear();
  }

  async disconnect() {
    if (this._activeOAuth?.finish) this._activeOAuth.finish(new YouTubeLibraryError('cancelled', 'YouTube authorization was cancelled.'));
    const token = this._credential?.refreshToken || this._accessToken;
    await this._revokeToken(token);
    await this._deleteCredential();
    this._credential = null;
    this._accessToken = '';
    this._accessTokenExpiresAt = 0;
    this._clearLibrary();
    this._state.connection = {
      status: 'requiresAuth', email: '', channelTitle: '',
      message: 'Disconnected. Nothing was deleted from YouTube.'
    };
    this._publish();
    return this.getState();
  }

  _playlistFromApi(item, liked = false) {
    const id = safeText(item?.id, 128);
    if (!PLAYLIST_ID_PATTERN.test(id)) return null;
    return {
      id,
      title: liked ? 'Liked Music' : safeText(item?.snippet?.title || 'Untitled playlist', 180),
      thumbnailUrl: bestThumbnail(item?.snippet?.thumbnails),
      itemCount: Math.max(0, Number(item?.contentDetails?.itemCount || 0)),
      isLiked: !!liked,
      attribution: 'YouTube'
    };
  }

  async _fetchPlaylistPage(pageToken = '') {
    const result = await this._apiGet('playlists', {
      part: 'snippet,contentDetails', mine: 'true', maxResults: 50, pageToken
    });
    return {
      playlists: (Array.isArray(result.items) ? result.items : []).map(item => this._playlistFromApi(item)).filter(Boolean),
      nextPageToken: safeText(result.nextPageToken, 256)
    };
  }

  async refreshLibrary({ force = false } = {}) {
    if (this._state.connection.status !== 'connected') return this.getState();
    if (!force && this._cacheUpdatedAt && this._now() - this._cacheUpdatedAt < CACHE_TTL_MS && this._state.library.playlists.length) {
      return this.getState();
    }
    const previous = clone(this._state.library);
    this._state.library = { ...previous, status: 'loading', message: 'Loading YouTube playlists…' };
    this._publish();
    try {
      const channels = await this._apiGet('channels', { part: 'snippet,contentDetails', mine: 'true', maxResults: 1 });
      const channel = Array.isArray(channels.items) ? channels.items[0] : null;
      if (channel?.snippet?.title) {
        this._state.connection.channelTitle = safeText(channel.snippet.title, 160);
      }
      const likedId = safeText(channel?.contentDetails?.relatedPlaylists?.likes, 128);
      const [ownedPage, likedResponse] = await Promise.all([
        this._fetchPlaylistPage(''),
        PLAYLIST_ID_PATTERN.test(likedId)
          ? this._apiGet('playlists', { part: 'snippet,contentDetails', id: likedId, maxResults: 1 })
          : Promise.resolve({ items: [] })
      ]);
      let liked = null;
      if (PLAYLIST_ID_PATTERN.test(likedId)) {
        const likedApi = Array.isArray(likedResponse.items) ? likedResponse.items[0] : null;
        liked = this._playlistFromApi(likedApi || { id: likedId }, true);
      }
      const playlists = [CURATED_RADIO_PLAYLIST, liked, ...ownedPage.playlists]
        .filter(Boolean)
        .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
      this._playlistNextPageToken = ownedPage.nextPageToken;
      this._itemNextPageToken = '';
      this._cacheUpdatedAt = this._now();
      this._state.library = {
        status: playlists.length ? 'ready' : 'empty',
        message: playlists.length ? '' : 'No owned playlists or Liked Videos were found.',
        attribution: 'YouTube', playlists, selectedPlaylist: null, items: [],
        hasMore: !!this._playlistNextPageToken
      };
      this._publish();
      return this.getState();
    } catch (error) {
      this._applyLoadError(error, previous);
      throw error;
    }
  }

  _applyLoadError(error, previous) {
    const hasRecent = (previous?.playlists?.length || previous?.items?.length) > 0;
    if (error?.code === 'offline' && hasRecent) {
      this._state.library = { ...previous, status: 'offline', message: 'Offline—showing recent data from this LabSuite run.' };
    } else if (error?.code === 'quotaExceeded') {
      this._state.library = { ...previous, status: 'quotaExceeded', message: error.message };
    } else if (error?.code === 'invalidGrant') {
      this._state.library = emptyLibrary();
    } else {
      this._state.library = { ...previous, status: error?.code === 'offline' ? 'offline' : 'error', message: safeText(error?.message || 'YouTube Library could not be loaded.', 240) };
    }
    this._publish();
  }

  async loadMore() {
    if (this._state.library.selectedPlaylist) return this._loadPlaylistItems(this._state.library.selectedPlaylist.id, true);
    if (!this._playlistNextPageToken) return this.getState();
    const previous = clone(this._state.library);
    this._state.library = { ...previous, status: 'loading', message: 'Loading more playlists…' };
    this._publish();
    try {
      const page = await this._fetchPlaylistPage(this._playlistNextPageToken);
      this._playlistNextPageToken = page.nextPageToken;
      const playlists = [...previous.playlists, ...page.playlists]
        .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
      this._state.library = { ...previous, status: playlists.length ? 'ready' : 'empty', message: '', playlists, hasMore: !!this._playlistNextPageToken };
      this._publish();
      return this.getState();
    } catch (error) {
      this._applyLoadError(error, previous);
      throw error;
    }
  }

  async _fetchItemsPage(playlistId, pageToken = '') {
    const result = await this._apiGet('playlistItems', {
      part: 'snippet,contentDetails,status', playlistId, maxResults: 50, pageToken
    });
    const rawItems = Array.isArray(result.items) ? result.items : [];
    const videoIds = rawItems.map(item => safeText(item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId, 32))
      .filter(id => VIDEO_ID_PATTERN.test(id));
    const videos = videoIds.length
      ? await this._apiGet('videos', { part: 'snippet,contentDetails,status', id: [...new Set(videoIds)].join(','), maxResults: 50 })
      : { items: [] };
    const videoMap = new Map((Array.isArray(videos.items) ? videos.items : []).map(item => [String(item.id || ''), item]));
    const items = rawItems.map((entry, index) => {
      const videoId = safeText(entry?.contentDetails?.videoId || entry?.snippet?.resourceId?.videoId, 32);
      const video = videoMap.get(videoId);
      const entryPrivacy = safeText(entry?.status?.privacyStatus, 32);
      const videoPrivacy = safeText(video?.status?.privacyStatus, 32);
      const available = VIDEO_ID_PATTERN.test(videoId) && !!video && entryPrivacy !== 'private'
        && videoPrivacy !== 'private' && video?.status?.uploadStatus !== 'deleted';
      const rawTitle = entry?.snippet?.title || video?.snippet?.title;
      const unavailableTitle = /deleted/i.test(String(rawTitle || '')) ? 'Deleted video' : 'Private or unavailable video';
      return {
        id: safeText(entry?.id || `${playlistId}-${index}`, 160),
        videoId: VIDEO_ID_PATTERN.test(videoId) ? videoId : '',
        title: available ? safeText(rawTitle || 'Untitled video', 220) : unavailableTitle,
        artist: available ? safeText(entry?.snippet?.videoOwnerChannelTitle || video?.snippet?.channelTitle || '', 180) : '',
        thumbnailUrl: available ? bestThumbnail(entry?.snippet?.thumbnails || video?.snippet?.thumbnails) : '',
        durationMs: available ? parseIsoDuration(video?.contentDetails?.duration) : 0,
        available,
        unavailableReason: available ? '' : 'This playlist entry is private, deleted, or unavailable.',
        attribution: 'YouTube'
      };
    });
    return { items, nextPageToken: safeText(result.nextPageToken, 256) };
  }

  async selectPlaylist(playlistId, { force = false } = {}) {
    const id = validatePlaylistId(playlistId);
    if (id === 'RADIO_STATIONS') {
      this._state.library = {
        ...this._state.library, status: 'ready', message: '',
        selectedPlaylist: CURATED_RADIO_PLAYLIST, items: clone(CURATED_RADIO_ITEMS), hasMore: false
      };
      this._publish();
      return this.getState();
    }
    const playlist = this._state.library.playlists.find(item => item.id === id);
    if (!playlist) throw new YouTubeLibraryError('unknownPlaylist', 'That playlist is not in the loaded YouTube Library.');
    const cached = this._playlistItemCache.get(id);
    if (!force && cached && this._now() - cached.updatedAt < CACHE_TTL_MS) {
      this._itemNextPageToken = cached.nextPageToken;
      this._state.library = {
        ...this._state.library, status: cached.items.length ? 'ready' : 'empty', message: cached.items.length ? '' : 'This playlist is empty.',
        selectedPlaylist: playlist, items: clone(cached.items), hasMore: !!cached.nextPageToken
      };
      this._publish();
      return this.getState();
    }
    return this._loadPlaylistItems(id, false);
  }

  async _loadPlaylistItems(playlistId, append) {
    const id = validatePlaylistId(playlistId);
    const playlist = this._state.library.playlists.find(item => item.id === id);
    if (!playlist) throw new YouTubeLibraryError('unknownPlaylist', 'That playlist is not in the loaded YouTube Library.');
    if (append && !this._itemNextPageToken) return this.getState();
    const previous = clone(this._state.library);
    this._state.library = { ...previous, status: 'loading', message: append ? 'Loading more tracks…' : 'Loading playlist…', selectedPlaylist: playlist };
    this._publish();
    try {
      const page = await this._fetchItemsPage(id, append ? this._itemNextPageToken : '');
      this._itemNextPageToken = page.nextPageToken;
      const items = append ? [...previous.items, ...page.items] : page.items;
      this._playlistItemCache.set(id, { updatedAt: this._now(), items: clone(items), nextPageToken: this._itemNextPageToken });
      this._state.library = {
        ...previous, status: items.length ? 'ready' : 'empty', message: items.length ? '' : 'This playlist is empty.',
        selectedPlaylist: playlist, items, hasMore: !!this._itemNextPageToken
      };
      this._publish();
      return this.getState();
    } catch (error) {
      this._applyLoadError(error, previous);
      throw error;
    }
  }

  backToPlaylists() {
    const playlists = this._state.library.playlists;
    this._itemNextPageToken = '';
    this._state.library = {
      ...this._state.library, status: playlists.length ? 'ready' : 'empty', message: '',
      selectedPlaylist: null, items: [], hasMore: !!this._playlistNextPageToken
    };
    this._publish();
    return this.getState();
  }

  async refresh() {
    const selectedId = this._state.library.selectedPlaylist?.id;
    return selectedId ? this.selectPlaylist(selectedId, { force: true }) : this.refreshLibrary({ force: true });
  }

  _launchApp(url, preferredApp = 'auto', startMinimized = true) {
    const exePath = findBrowserExecutable(preferredApp);
    if (!exePath) {
      throw new YouTubeLibraryError('browserNotFound', 'Neither Microsoft Edge nor Google Chrome could be found to launch YouTube Music app windows.');
    }
    if (process.platform === 'win32' && startMinimized) {
      const child = this._spawn('cmd.exe', ['/c', 'start', '/min', '""', exePath, `--app=${url}`, '--start-minimized'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false
      });
      if (child && typeof child.unref === 'function') child.unref();
      return true;
    }

    const args = [`--app=${url}`];
    if (startMinimized) args.push('--start-minimized');
    const child = this._spawn(exePath, args, {
      detached: true,
      stdio: 'ignore',
      shell: false
    });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  }

  async openPlaylist(playlistId, preferredApp = 'auto', startMinimized = true) {
    const id = validatePlaylistId(playlistId);
    const isRadio = id === 'RADIO_STATIONS';
    if (!isRadio && !this._state.library.playlists.some(item => item.id === id)) throw new YouTubeLibraryError('unknownPlaylist', 'Unknown YouTube playlist.');
    const url = isRadio ? 'https://music.youtube.com/watch?v=jfKfPfyJRdk' : `https://music.youtube.com/playlist?list=${encodeURIComponent(id)}`;
    try {
      this._launchApp(url, preferredApp, startMinimized);
    } catch (_) {
      await this._openExternal(url);
    }
    return this.getState();
  }

  async openTrack(playlistId, videoId, preferredApp = 'auto', startMinimized = true) {
    const playlist = validatePlaylistId(playlistId);
    const video = validateVideoId(videoId);
    const isRadio = playlist === 'RADIO_STATIONS';
    const item = isRadio
      ? CURATED_RADIO_ITEMS.find(entry => entry.videoId === video)
      : this._state.library.items.find(entry => entry.videoId === video && entry.available);
    if ((!isRadio && this._state.library.selectedPlaylist?.id !== playlist) || !item) throw new YouTubeLibraryError('unknownTrack', 'Unknown or unavailable YouTube track.');
    const url = isRadio ? `https://music.youtube.com/watch?v=${encodeURIComponent(video)}` : `https://music.youtube.com/watch?v=${encodeURIComponent(video)}&list=${encodeURIComponent(playlist)}`;
    try {
      this._launchApp(url, preferredApp, startMinimized);
    } catch (_) {
      await this._openExternal(url);
    }
    return this.getState();
  }

  async handleAction(action, payload = {}) {
    const execute = async () => {
      switch (String(action || '')) {
        case 'openLibrary': return this.refreshLibrary();
        case 'connect':
        case 'reconnect': return this.connect();
        case 'disconnect': return this.disconnect();
        case 'refresh': return this.refresh();
        case 'loadMore': return this.loadMore();
        case 'selectPlaylist': return this.selectPlaylist(payload.playlistId);
        case 'backToPlaylists': return this.backToPlaylists();
        case 'openPlaylist': return this.openPlaylist(payload.playlistId, payload.preferredApp, payload.startMinimized);
        case 'openTrack': return this.openTrack(payload.playlistId, payload.videoId, payload.preferredApp, payload.startMinimized);
        default: throw new YouTubeLibraryError('invalidAction', 'Unsupported YouTube Library action.');
      }
    };
    const result = this._actionPromise.then(execute, execute);
    this._actionPromise = result.catch(() => {});
    return result;
  }

  shutdown() {
    if (this._activeOAuth?.finish) this._activeOAuth.finish(new YouTubeLibraryError('shutdown', 'LabSuite closed during authorization.'));
    this._accessToken = '';
    this._accessTokenExpiresAt = 0;
    this._playlistNextPageToken = '';
    this._itemNextPageToken = '';
    this._playlistItemCache.clear();
  }
}

module.exports = {
  YouTubeLibraryProvider,
  YouTubeLibraryError,
  CONNECTION_STATES,
  LIBRARY_STATES,
  CACHE_TTL_MS,
  SCOPES,
  __private: {
    parseIsoDuration,
    parseRetryAfter,
    parseStoredCredential,
    validatePlaylistId,
    validateVideoId,
    safeHttpsUrl,
    hasRequiredScopes,
    missingRequiredScopes,
    classifyApiError
  }
};
