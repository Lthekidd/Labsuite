const QUEUE_STATUSES = new Set([
  'unavailable',
  'requiresAuth',
  'loading',
  'ready',
  'empty',
  'error'
]);

const MAX_QUEUE_ITEMS = 8;

function cleanText(value, maxLength = 300) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeQueueItem(raw = {}, index = 0) {
  return {
    id: cleanText(raw.id, 160) || `queue-${index}`,
    title: cleanText(raw.title, 300) || 'Unknown title',
    artist: cleanText(raw.artist, 300),
    artworkUrl: /^https:\/\//i.test(String(raw.artworkUrl || '')) ? String(raw.artworkUrl).slice(0, 2048) : '',
    durationMs: Number.isFinite(raw.durationMs) ? Math.max(0, Math.round(raw.durationMs)) : 0,
    attribution: cleanText(raw.attribution, 80)
  };
}

function normalizeQueueState(raw = {}) {
  const status = QUEUE_STATUSES.has(raw.status) ? raw.status : 'error';
  const items = Array.isArray(raw.items)
    ? raw.items.slice(0, MAX_QUEUE_ITEMS).map(normalizeQueueItem)
    : [];
  return {
    status: status === 'ready' && items.length === 0 ? 'empty' : status,
    provider: cleanText(raw.provider, 80),
    message: cleanText(raw.message, 500),
    attribution: cleanText(raw.attribution, 80),
    items
  };
}

function unavailableQueue(sourceApp = 'this player') {
  const source = cleanText(sourceApp, 80) || 'this player';
  const isSpotify = /spotify/i.test(source);
  return normalizeQueueState({
    status: 'unavailable',
    provider: isSpotify ? 'spotify' : '',
    message: isSpotify
      ? 'Spotify Up Next will appear when approved provider access is available.'
      : `Up Next is not shared by ${source}.`,
    attribution: isSpotify ? 'Spotify' : '',
    items: []
  });
}

// Provider authentication intentionally remains disabled for public builds until
// LabSuite has eligible Spotify API access. This capability boundary keeps queue
// availability honest and prevents tokens from entering the native helper.
function getQueueStateForSession(session = {}) {
  return unavailableQueue(session.sourceApp);
}

async function handleProviderAction(action, session = {}) {
  if (!['connectSpotify', 'refreshQueue'].includes(action)) {
    return normalizeQueueState({ status: 'error', message: 'Unsupported queue provider action.' });
  }
  return getQueueStateForSession(session);
}

module.exports = {
  QUEUE_STATUSES,
  MAX_QUEUE_ITEMS,
  normalizeQueueItem,
  normalizeQueueState,
  unavailableQueue,
  getQueueStateForSession,
  handleProviderAction
};
