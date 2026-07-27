const ipcRenderer = window.electron?.ipcRenderer;

const entries = new Map();
const channelKeys = new Map();

function stableSerialize(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${stableSerialize(value[key])}`
  )).join(',')}}`;
}

function getKey(channel, args) {
  return `${channel}:${stableSerialize(args)}`;
}

function rememberChannelKey(channel, key) {
  if (!channelKeys.has(channel)) channelKeys.set(channel, new Set());
  channelKeys.get(channel).add(key);
}

function notify(entry) {
  for (const listener of entry.listeners) {
    try {
      listener(entry.value);
    } catch (error) {
      console.warn('Resource listener failed:', error);
    }
  }
}

function startRequest(channel, args, entry, ttl) {
  if (!ipcRenderer) return Promise.resolve(null);
  if (entry.promise) return entry.promise;

  entry.requestCount += 1;
  const invokeArgs = Array.isArray(args) ? args : [args];
  const request = ipcRenderer.invoke(channel, ...invokeArgs)
    .then(value => {
      entry.value = value;
      entry.hasValue = true;
      entry.expiresAt = ttl === Infinity ? Infinity : Date.now() + Math.max(0, ttl);
      notify(entry);
      return value;
    })
    .catch(error => {
      console.warn(`IPC Error on ${channel}:`, error.message);
      if (entry.hasValue) return entry.value;
      return null;
    })
    .finally(() => {
      if (entry.promise === request) entry.promise = null;
    });

  entry.promise = request;
  return request;
}

/**
 * Session-scoped IPC resource cache. Concurrent callers share one request,
 * including React Strict Mode's development remount pass.
 */
export function invokeResource(channel, args = [], options = {}) {
  const {
    ttl = Infinity,
    force = false,
    staleWhileRevalidate = false
  } = options;
  const key = getKey(channel, args);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      channel,
      args,
      value: null,
      hasValue: false,
      expiresAt: 0,
      promise: null,
      requestCount: 0,
      listeners: new Set()
    };
    entries.set(key, entry);
    rememberChannelKey(channel, key);
  }

  const fresh = entry.hasValue && Date.now() < entry.expiresAt;
  if (!force && fresh) return Promise.resolve(entry.value);

  if (!force && staleWhileRevalidate && entry.hasValue) {
    startRequest(channel, args, entry, ttl);
    return Promise.resolve(entry.value);
  }

  return startRequest(channel, args, entry, ttl);
}

export function peekResource(channel, args = []) {
  const entry = entries.get(getKey(channel, args));
  return entry?.hasValue ? entry.value : undefined;
}

export function subscribeResource(channel, args = [], listener) {
  const key = getKey(channel, args);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      channel,
      args,
      value: null,
      hasValue: false,
      expiresAt: 0,
      promise: null,
      requestCount: 0,
      listeners: new Set()
    };
    entries.set(key, entry);
    rememberChannelKey(channel, key);
  }
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

export function invalidateResource(channel, args) {
  if (args !== undefined) {
    const entry = entries.get(getKey(channel, args));
    if (entry) entry.expiresAt = 0;
    return;
  }
  for (const key of channelKeys.get(channel) || []) {
    const entry = entries.get(key);
    if (entry) entry.expiresAt = 0;
  }
}

export function clearResource(channel, args) {
  if (args !== undefined) {
    const key = getKey(channel, args);
    entries.delete(key);
    channelKeys.get(channel)?.delete(key);
    return;
  }
  for (const key of channelKeys.get(channel) || []) entries.delete(key);
  channelKeys.delete(channel);
}

export function getResourceDebugSnapshot() {
  return [...entries.entries()].map(([key, entry]) => ({
    key,
    channel: entry.channel,
    hasValue: entry.hasValue,
    inFlight: !!entry.promise,
    requestCount: entry.requestCount,
    listenerCount: entry.listeners.size,
    expiresAt: entry.expiresAt
  }));
}

Object.defineProperty(window, '__labsuiteResourceCache', {
  configurable: true,
  enumerable: false,
  value: Object.freeze({
    snapshot: getResourceDebugSnapshot
  })
});
