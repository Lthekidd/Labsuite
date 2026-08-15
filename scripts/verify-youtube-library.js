const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  YouTubeLibraryProvider,
  SCOPES,
  __private
} = require('../main/youtubeLibrary');

const ROOT = path.join(__dirname, '..');

function response(status, body = {}, headers = {}) {
  return { status, body, headers, text: JSON.stringify(body) };
}

const GOOGLE_CANONICAL_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/youtube.readonly'
].join(' ');

function completeBrowserCallback(authUrl, openedUrls) {
  openedUrls.push(authUrl);
  const authorization = new URL(authUrl);
  assert.strictEqual(authorization.hostname, 'accounts.google.com');
  assert.strictEqual(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorization.searchParams.get('code_challenge'));
  assert.ok(authorization.searchParams.get('state'));
  assert.strictEqual(authorization.searchParams.get('login_hint'), 'same@example.com');
  assert.deepStrictEqual(new Set(authorization.searchParams.get('scope').split(' ')), new Set(SCOPES));
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.searchParams.set('code', 'test-authorization-code');
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  setImmediate(() => {
    http.get(callback, result => result.resume()).on('error', () => {});
  });
  return Promise.resolve();
}

async function testConnectedLibraryFlow() {
  let storedSecret = '';
  let deleted = false;
  let offline = false;
  let apiCalls = 0;
  const openedUrls = [];
  const requestBodies = [];

  const request = async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    if (options.body) requestBodies.push(options.body);
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      return response(200, {
        access_token: 'memory-only-access-token',
        refresh_token: 'secure-refresh-token',
        expires_in: 3600,
        scope: GOOGLE_CANONICAL_SCOPES
      });
    }
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') return response(200, {});
    if (url.hostname === 'openidconnect.googleapis.com') {
      return response(200, { email: 'same@example.com', email_verified: true });
    }
    if (offline) throw Object.assign(new Error('network unavailable'), { code: 'offline' });
    apiCalls += 1;
    assert.strictEqual(options.headers.Authorization, 'Bearer memory-only-access-token');
    if (url.pathname.endsWith('/channels')) {
      return response(200, { items: [{
        snippet: { title: 'My Channel' },
        contentDetails: { relatedPlaylists: { likes: 'LL_valid_likes' } }
      }] });
    }
    if (url.pathname.endsWith('/playlists') && url.searchParams.get('id')) {
      return response(200, { items: [{
        id: 'LL_valid_likes', snippet: { title: 'Ignored API title', thumbnails: { default: { url: 'https://i.ytimg.com/liked.jpg' } } },
        contentDetails: { itemCount: 22 }
      }] });
    }
    if (url.pathname.endsWith('/playlists') && url.searchParams.get('pageToken') === 'owned-next') {
      return response(200, { items: [{
        id: 'PL_second', snippet: { title: 'Second playlist', thumbnails: {} }, contentDetails: { itemCount: 1 }
      }] });
    }
    if (url.pathname.endsWith('/playlists')) {
      return response(200, {
        nextPageToken: 'owned-next',
        items: [{
          id: 'PL_owned', snippet: { title: 'Owned playlist', thumbnails: { high: { url: 'https://i.ytimg.com/owned.jpg' } } },
          contentDetails: { itemCount: 2 }
        }]
      });
    }
    if (url.pathname.endsWith('/playlistItems')) {
      assert.strictEqual(url.searchParams.get('maxResults'), '50');
      return response(200, { items: [
        {
          id: 'playlist-entry-1', contentDetails: { videoId: 'abcdefghijk' }, status: { privacyStatus: 'public' },
          snippet: { title: 'Available track', videoOwnerChannelTitle: 'Artist', thumbnails: { medium: { url: 'https://i.ytimg.com/track.jpg' } } }
        },
        {
          id: 'playlist-entry-2', contentDetails: { videoId: 'zzzzzzzzzzz' }, status: { privacyStatus: 'private' },
          snippet: { title: 'Private video' }
        }
      ] });
    }
    if (url.pathname.endsWith('/videos')) {
      return response(200, { items: [{
        id: 'abcdefghijk', snippet: { title: 'Available track', channelTitle: 'Artist' },
        contentDetails: { duration: 'PT3M42S' }, status: { privacyStatus: 'public', uploadStatus: 'processed' }
      }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const provider = new YouTubeLibraryProvider({
    request,
    getOAuthContext: async () => ({ clientId: 'desktop-client', clientSecret: 'protected-secret', email: 'same@example.com' }),
    getCredential: async () => null,
    setCredential: async secret => { storedSecret = secret; },
    deleteCredential: async () => { deleted = true; },
    openExternal: url => completeBrowserCallback(url, openedUrls)
  });

  await provider.initialize();
  assert.strictEqual(provider.getState().connection.status, 'requiresAuth');
  await provider.connect();

  let state = provider.getState();
  assert.strictEqual(state.connection.status, 'connected');
  assert.strictEqual(state.connection.email, 'same@example.com');
  assert.strictEqual(state.connection.channelTitle, 'My Channel');
  assert.strictEqual(state.library.status, 'ready');
  assert.deepStrictEqual(state.library.playlists.map(item => item.title), ['24/7 Lo-Fi & Ambient Radio', 'Liked Music', 'Owned playlist']);
  assert.strictEqual(state.library.hasMore, true);
  assert.ok(storedSecret.includes('secure-refresh-token'));
  assert.ok(!storedSecret.includes('memory-only-access-token'));
  assert.ok(!JSON.stringify(state).includes('secure-refresh-token'));
  assert.ok(!JSON.stringify(state).includes('owned-next'));

  const cachedApiCalls = apiCalls;
  await provider.handleAction('openLibrary');
  assert.strictEqual(apiCalls, cachedApiCalls, 'Opening a warm Library must use the ten-minute memory cache');

  await provider.loadMore();
  state = provider.getState();
  assert.deepStrictEqual(state.library.playlists.map(item => item.title), ['24/7 Lo-Fi & Ambient Radio', 'Liked Music', 'Owned playlist', 'Second playlist']);
  assert.strictEqual(state.library.hasMore, false);

  await provider.selectPlaylist('PL_owned');
  state = provider.getState();
  assert.strictEqual(state.library.items.length, 2);
  assert.strictEqual(state.library.items[0].durationMs, 222000);
  assert.strictEqual(state.library.items[0].available, true);
  assert.strictEqual(state.library.items[1].available, false);
  assert.strictEqual(state.library.items[1].title, 'Private or unavailable video');

  const spawnedArgs = [];
  provider._spawn = (exe, args) => { spawnedArgs.push([exe, ...args]); return { unref: () => {} }; };
  provider._openExternal = async url => { openedUrls.push(url); };
  await provider.openTrack('PL_owned', 'abcdefghijk');
  assert.ok(spawnedArgs.length > 0, 'Must attempt browser app window launching');
  assert.ok(spawnedArgs.at(-1).some(arg => arg.includes('--app=https://music.youtube.com/watch?v=abcdefghijk&list=PL_owned')),
    'App window argument must target allowlisted music.youtube.com URL');
  assert.ok(spawnedArgs.at(-1).includes('--start-minimized'),
    'App window must include --start-minimized flag when startMinimized is active');
  const browserLaunchCount = spawnedArgs.length;
  provider._openPlayback = async () => true;
  await provider.openTrack('PL_owned', 'abcdefghijk');
  assert.strictEqual(spawnedArgs.length, browserLaunchCount,
    'A YTmusic-handled item must not also open the browser fallback');
  await assert.rejects(() => provider.openTrack('PL_owned', 'zzzzzzzzzzz'), /unavailable/i);

  offline = true;
  await assert.rejects(() => provider.refresh(), /unavailable/i);
  state = provider.getState();
  assert.strictEqual(state.library.status, 'offline');
  assert.strictEqual(state.library.items.length, 2, 'Offline state must retain this-run data');
  offline = false;

  await provider.disconnect();
  state = provider.getState();
  assert.strictEqual(state.connection.status, 'requiresAuth');
  assert.strictEqual(state.library.playlists.length, 0);
  assert.strictEqual(deleted, true);
  assert.ok(requestBodies.some(body => body.includes('token=secure-refresh-token')));
  provider.shutdown();
}

async function testMismatchedAccountIsRejected() {
  let stored = false;
  let revoked = false;
  const provider = new YouTubeLibraryProvider({
    request: async (urlValue) => {
      const url = new URL(urlValue);
      if (url.pathname === '/token') return response(200, {
        access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: SCOPES.join(' ')
      });
      if (url.pathname === '/v1/userinfo') return response(200, { email: 'different@example.com' });
      if (url.pathname === '/revoke') { revoked = true; return response(200, {}); }
      throw new Error(`Unexpected request ${url}`);
    },
    getOAuthContext: async () => ({ clientId: 'client', clientSecret: 'secret', email: 'same@example.com' }),
    getCredential: async () => null,
    setCredential: async () => { stored = true; },
    deleteCredential: async () => {},
    openExternal: url => completeBrowserCallback(url, [])
  });
  await provider.initialize();
  await assert.rejects(() => provider.connect(), /same Google account/i);
  assert.strictEqual(stored, false);
  assert.strictEqual(revoked, true);
  assert.strictEqual(provider.getState().connection.status, 'error');
  provider.shutdown();
}

async function testInvalidGrantRequiresReconnect() {
  let deleted = false;
  const provider = new YouTubeLibraryProvider({
    request: async urlValue => {
      const url = new URL(urlValue);
      if (url.pathname === '/token') return response(400, { error: 'invalid_grant' });
      throw new Error(`Unexpected request ${url}`);
    },
    getOAuthContext: async () => ({ clientId: 'client', clientSecret: 'secret', email: 'same@example.com' }),
    getCredential: async () => JSON.stringify({ version: 1, refreshToken: 'revoked-refresh', email: 'same@example.com' }),
    deleteCredential: async () => { deleted = true; },
    openExternal: async () => {}
  });
  await provider.initialize();
  await assert.rejects(() => provider.refreshLibrary({ force: true }), /reconnected/i);
  assert.strictEqual(provider.getState().connection.status, 'reauthRequired');
  assert.strictEqual(deleted, true);
  provider.shutdown();
}

async function test401RetryAndRetryAfter() {
  let refreshes = 0;
  let channelCalls = 0;
  const waits = [];
  const provider = new YouTubeLibraryProvider({
    request: async (urlValue, options = {}) => {
      const url = new URL(urlValue);
      if (url.pathname === '/token') {
        refreshes += 1;
        return response(200, { access_token: `access-${refreshes}`, expires_in: 3600 });
      }
      if (url.pathname.endsWith('/channels')) {
        channelCalls += 1;
        if (channelCalls === 1) return response(401, {});
        if (channelCalls === 2) return response(429, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, { 'retry-after': '2' });
        assert.strictEqual(options.headers.Authorization, 'Bearer access-2');
        return response(200, { items: [{ snippet: { title: 'Retry Channel' }, contentDetails: { relatedPlaylists: {} } }] });
      }
      if (url.pathname.endsWith('/playlists')) return response(200, { items: [] });
      throw new Error(`Unexpected request ${url}`);
    },
    sleep: async ms => { waits.push(ms); },
    getOAuthContext: async () => ({ clientId: 'client', clientSecret: 'secret', email: 'same@example.com' }),
    getCredential: async () => JSON.stringify({ version: 1, refreshToken: 'refresh', email: 'same@example.com' }),
    deleteCredential: async () => {},
    openExternal: async () => {}
  });
  await provider.initialize();
  await provider.refreshLibrary({ force: true });
  assert.strictEqual(refreshes, 2, 'A 401 must trigger exactly one fresh access token');
  assert.strictEqual(channelCalls, 3);
  assert.deepStrictEqual(waits, [2000], 'Retry-After must be honored before retrying');
  assert.strictEqual(provider.getState().library.status, 'ready');
  provider.shutdown();
}

function testStaticSecurityContract() {
  const providerSource = fs.readFileSync(path.join(ROOT, 'main', 'youtubeLibrary.js'), 'utf8');
  const rcloneSource = fs.readFileSync(path.join(ROOT, 'main', 'rclone.js'), 'utf8');
  const supervisorSource = fs.readFileSync(path.join(ROOT, 'main', 'mediaWidget.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(ROOT, 'main', 'preload.js'), 'utf8');
  const ipcSource = fs.readFileSync(path.join(ROOT, 'main', 'ipc.js'), 'utf8');
  const nativeSource = fs.readFileSync(path.join(ROOT, 'native', 'LabMediaWidget', 'MainWindow.xaml.cs'), 'utf8');
  assert.ok(providerSource.includes("CREDENTIAL_SERVICE = 'LabSuite.LabMedia.YouTube'"));
  assert.ok(providerSource.includes("code_challenge_method: 'S256'"));
  assert.ok(providerSource.includes('login_hint: context.email'));
  assert.ok(providerSource.includes("scope: SCOPES.join(' ')"));
  assert.ok(providerSource.includes('email !== String(context.email).toLowerCase()'));
  assert.ok(providerSource.includes('NoCache') || providerSource.includes('no-store'));
  assert.ok(supervisorSource.includes("type: 'library:update'"));
  assert.ok(supervisorSource.includes("data.event === 'libraryAction'"));
  assert.ok(supervisorSource.includes('refreshYouTubeSetupState'),
    'YouTube setup state must refresh after Drive OAuth client migration');
  assert.ok(nativeSource.includes('SanitizeLibraryState'));
  assert.ok(!nativeSource.includes('pageToken'), 'Native helper must never receive Google page cursors');
  for (const action of ['youtubeConnect', 'youtubeReconnect', 'youtubeDisconnect', 'youtubeRefresh', 'openYouTubeOAuthSettings']) {
    assert.ok(preloadSource.includes(`labmedia:${action}`), `${action} must be allowlisted by preload`);
    assert.ok(ipcSource.includes(`labmedia:${action}`), `${action} must be handled in the main process`);
  }
  assert.ok(!providerSource.includes('console.log') && !providerSource.includes('console.error'),
    'YouTube provider must not log OAuth or API material');
  assert.ok(rcloneSource.includes('Re-pin the personal client identity')
    && rcloneSource.includes("throw new Error('Google Drive reconnected, but the personal OAuth client could not be saved.')"),
  'Drive reconnect must verify that personal OAuth credentials persisted after rclone updates its token');
  assert.ok(rcloneSource.includes('No personal Google OAuth client is saved. Enter the Desktop client ID and secret first.'),
    'Drive reauthorization must not silently fall back to the shared rclone OAuth client');
  assert.ok(providerSource.includes('This page confirms only the browser approval, not that setup finished.'),
    'OAuth callback page must not claim connection before token and account verification');
  assert.ok(!providerSource.includes('<h1>YouTube connected to LabMedia</h1>'),
    'OAuth callback page must not show a premature success message');
  assert.strictEqual(__private.parseRetryAfter('2'), 2000);
  assert.strictEqual(__private.parseIsoDuration('PT1H2M3S'), 3723000);
  assert.strictEqual(__private.hasRequiredScopes(GOOGLE_CANONICAL_SCOPES), true,
    'Google canonical userinfo.email scope must satisfy the requested email identity scope');
  assert.strictEqual(__private.hasRequiredScopes(SCOPES.join(' ')), true,
    'Literal requested scopes must remain valid');
  assert.strictEqual(__private.hasRequiredScopes('openid https://www.googleapis.com/auth/userinfo.email'), false,
    'YouTube read-only scope must remain mandatory');
  assert.deepStrictEqual(
    __private.missingRequiredScopes('openid https://www.googleapis.com/auth/userinfo.email'),
    ['youtube.readonly'],
    'Missing YouTube permission must produce a precise setup diagnosis'
  );
  assert.strictEqual(__private.classifyApiError(response(403, {
    error: { errors: [{ reason: 'quotaExceeded' }] }
  })).code, 'quotaExceeded');
  assert.throws(() => __private.validatePlaylistId('https://evil.example'), /Invalid/);
  assert.throws(() => __private.validateVideoId('short'), /Invalid/);
}

async function main() {
  await testConnectedLibraryFlow();
  await testMismatchedAccountIsRejected();
  await testInvalidGrantRequiresReconnect();
  await test401RetryAndRetryAfter();
  testStaticSecurityContract();
  console.log('All LabMedia YouTube Library tests passed cleanly!');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
