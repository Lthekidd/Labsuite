import React, { useEffect, useMemo, useState } from 'react';

const ipcRenderer = window.electron.ipcRenderer;

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusText(chat) {
  if (chat.running) return 'Running';
  if (chat.last_backup_status === 'success') return 'Protected';
  if (chat.last_backup_status === 'local-only') return 'Local only';
  if (chat.last_backup_status === 'failed') return 'Needs attention';
  return chat.selected ? 'Ready' : 'Not selected';
}

function messageText(message) {
  if (message._archive_text) return message._archive_text;
  if (typeof message.text === 'string') return message.text;
  if (!Array.isArray(message.text)) return '';
  return message.text.map(part => typeof part === 'string' ? part : part?.text || '').join('');
}

export default function TelegramChatArchive({ onStatus }) {
  const [chats, setChats] = useState([]);
  const [chatFilter, setChatFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('all');
  const [selectedChatId, setSelectedChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [messageQuery, setMessageQuery] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [progress, setProgress] = useState({});

  const loadChats = async () => {
    const items = await ipcRenderer.invoke('telegramArchive:getChats');
    const next = items || [];
    setChats(next);
    setSelectedChatId(current => {
      if (current && next.some(chat => chat.id === current)) return current;
      return next.find(chat => chat.selected)?.id || next.find(chat => chat.type === 'Saved Messages')?.id || next[0]?.id || null;
    });
  };

  const loadMessages = async (id = selectedChatId, query = messageQuery) => {
    if (!id) {
      setMessages([]);
      setMessageTotal(0);
      return;
    }
    setIsLoadingMessages(true);
    try {
      const result = await ipcRenderer.invoke('telegramArchive:getMessages', { id, query, limit: 250, offset: 0 });
      setMessages(result?.messages || []);
      setMessageTotal(result?.total || 0);
    } finally {
      setIsLoadingMessages(false);
    }
  };

  useEffect(() => {
    loadChats();
    const handleProgress = (event, update) => {
      setProgress(previous => ({ ...previous, [update.chatId]: update }));
      if (update.stage === 'completed') loadChats();
    };
    const handleComplete = (event, result) => {
      setIsBackingUp(false);
      setProgress({});
      loadChats();
      loadMessages();
      if (result.success) onStatus?.('Selected Telegram chats were archived.', 'success');
      else onStatus?.(`${result.error || 'One or more Telegram chat archives need attention.'} Use Copy failure log for the exact failed stage.`, 'error');
    };
    ipcRenderer.on('telegramArchive:progress', handleProgress);
    ipcRenderer.on('telegramArchive:complete', handleComplete);
    return () => {
      ipcRenderer.removeListener('telegramArchive:progress', handleProgress);
      ipcRenderer.removeListener('telegramArchive:complete', handleComplete);
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => loadMessages(selectedChatId, messageQuery), 180);
    return () => clearTimeout(timer);
  }, [selectedChatId, messageQuery]);

  const accounts = useMemo(() => {
    const values = new Map();
    chats.forEach(chat => values.set(chat.account_id, chat.account_name));
    return Array.from(values, ([id, name]) => ({ id, name }));
  }, [chats]);

  const visibleChats = useMemo(() => {
    const query = chatFilter.trim().toLowerCase();
    return chats.filter(chat => {
      if (accountFilter !== 'all' && chat.account_id !== accountFilter) return false;
      return !query || `${chat.name}\n${chat.type}\n${chat.preview}`.toLowerCase().includes(query);
    });
  }, [chats, chatFilter, accountFilter]);

  const selectedChat = chats.find(chat => chat.id === selectedChatId) || null;
  const selectedCount = chats.filter(chat => chat.selected).length;

  const scan = async () => {
    setIsScanning(true);
    try {
      const result = await ipcRenderer.invoke('telegramArchive:scan');
      await loadChats();
      onStatus?.(`Detected ${result.chats} chats across ${result.accounts} Telegram account(s).`, 'success');
    } catch (error) {
      onStatus?.(`Telegram scan failed: ${error.message}. Use Copy failure log for safe diagnostics.`, 'error');
    } finally {
      setIsScanning(false);
    }
  };

  const update = async (chat, updates) => {
    await ipcRenderer.invoke('telegramArchive:updateChat', { id: chat.id, updates });
    await loadChats();
  };

  const toggleSelected = async (chat) => {
    const selected = !chat.selected;
    await update(chat, { selected });
    if (selected) setSelectedChatId(chat.id);
  };

  const backupSelected = async () => {
    setIsBackingUp(true);
    try {
      await ipcRenderer.invoke('telegramArchive:backupSelected');
    } catch (error) {
      setIsBackingUp(false);
      onStatus?.(error.message, 'error');
    }
  };

  const backupOne = async (chat) => {
    if (!chat.selected) await update(chat, { selected: true });
    setIsBackingUp(true);
    try {
      await ipcRenderer.invoke('telegramArchive:backupChat', chat.id);
    } catch (error) {
      setIsBackingUp(false);
      onStatus?.(error.message, 'error');
    }
  };

  return (
    <div className="tg-archive">
      <div className="tg-archive-toolbar">
        <div>
          <div className="tg-archive-title">Readable chat archives</div>
          <div className="tg-archive-subtitle">Choose only the chats you want. Selected chats stay at the top and export sequentially.</div>
        </div>
        <div className="tg-archive-actions">
          <button className="btn btn-secondary" onClick={() => ipcRenderer.invoke('telegramArchive:openFolder', null)}>Open archive folder</button>
          <button className="btn btn-secondary" onClick={scan} disabled={isScanning || isBackingUp}>
            {isScanning ? <><span className="spinner-small" />Scanning Telegram…</> : 'Scan accounts & chats'}
          </button>
          <button className="btn btn-primary tg-primary" onClick={backupSelected} disabled={selectedCount === 0 || isBackingUp}>
            {isBackingUp ? 'Backing up…' : `Back up selected (${selectedCount})`}
          </button>
        </div>
      </div>

      <div className="tg-account-pills">
        <button className={accountFilter === 'all' ? 'active' : ''} onClick={() => setAccountFilter('all')}>All accounts</button>
        {accounts.map(account => (
          <button key={account.id} className={accountFilter === account.id ? 'active' : ''} onClick={() => setAccountFilter(account.id)}>
            {account.name}
          </button>
        ))}
      </div>

      <div className="tg-archive-shell">
        <aside className="tg-chat-sidebar">
          <div className="tg-search-wrap">
            <span>⌕</span>
            <input value={chatFilter} onChange={event => setChatFilter(event.target.value)} placeholder="Search detected chats" />
          </div>

          <div className="tg-chat-list">
            {visibleChats.length === 0 ? (
              <div className="tg-empty-list">
                <div className="tg-empty-icon">✈</div>
                <strong>No chats detected yet</strong>
                <span>Open Telegram Desktop, then scan accounts and chats.</span>
              </div>
            ) : visibleChats.map(chat => {
              const chatProgress = progress[chat.id];
              return (
                <div key={chat.id} className={`tg-chat-row ${selectedChatId === chat.id ? 'current' : ''} ${chat.selected ? 'chosen' : ''}`} onClick={() => setSelectedChatId(chat.id)}>
                  <div className="tg-avatar">{chat.type === 'Saved Messages' ? '🔖' : chat.name.slice(0, 1).toUpperCase()}</div>
                  <div className="tg-chat-copy">
                    <div className="tg-chat-line">
                      <span className="tg-chat-name">{chat.name}</span>
                      <span className="tg-chat-time">{chat.preview_time}</span>
                    </div>
                    <div className="tg-chat-line secondary">
                      <span className="tg-chat-preview">{chatProgress?.message || chat.preview || chat.type}</span>
                      {chat.unread && <span className="tg-unread">{chat.unread}</span>}
                    </div>
                    <div className={`tg-chat-status ${chat.last_backup_status || ''}`}>{statusText(chat)}</div>
                    {chatProgress && <div className="tg-row-progress"><span style={{ width: `${chatProgress.percent || 2}%` }} /></div>}
                  </div>
                  <label className="tg-select-toggle" title={chat.selected ? 'Remove from regular backup' : 'Add to regular backup'} onClick={event => event.stopPropagation()}>
                    <input type="checkbox" checked={!!chat.selected} onChange={() => toggleSelected(chat)} />
                    <span />
                  </label>
                </div>
              );
            })}
          </div>
        </aside>

        <section className="tg-message-panel">
          {!selectedChat ? (
            <div className="tg-viewer-empty">
              <div>✈</div>
              <strong>Select a chat</strong>
              <span>Backed-up messages will appear here in a readable, searchable view.</span>
            </div>
          ) : (
            <>
              <header className="tg-message-header">
                <div className="tg-avatar large">{selectedChat.type === 'Saved Messages' ? '🔖' : selectedChat.name.slice(0, 1).toUpperCase()}</div>
                <div className="tg-header-copy">
                  <strong>{selectedChat.name}</strong>
                  <span>{selectedChat.account_name} · {selectedChat.message_count || 0} messages · {selectedChat.media_count || 0} media</span>
                </div>
                <label className="tg-media-option" title="Include downloaded Telegram media in future exports">
                  <input type="checkbox" checked={selectedChat.include_media !== false} onChange={event => update(selectedChat, { include_media: event.target.checked })} />
                  Include media
                </label>
                <select value={selectedChat.schedule || 'weekly'} onChange={event => update(selectedChat, { schedule: event.target.value })}>
                  <option value="hourly">Hourly</option>
                  <option value="6hours">Every 6 hours</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="manual">Manual</option>
                </select>
                <button className="btn btn-secondary compact" onClick={() => backupOne(selectedChat)} disabled={isBackingUp}>Back up now</button>
              </header>

              <div className="tg-message-search">
                <span>⌕</span>
                <input value={messageQuery} onChange={event => setMessageQuery(event.target.value)} placeholder="Search sender, message text, or file name" />
                <small>{messageTotal} result{messageTotal === 1 ? '' : 's'}</small>
              </div>

              <div className="tg-message-list">
                {isLoadingMessages ? (
                  <div className="tg-viewer-empty small"><span className="spinner-small" />Loading archive…</div>
                ) : messages.length === 0 ? (
                  <div className="tg-viewer-empty small">
                    <div>☁</div>
                    <strong>{selectedChat.last_backup_at ? 'No matching messages' : 'This chat has not been archived yet'}</strong>
                    <span>{selectedChat.last_backup_at ? 'Try a different search.' : 'Choose Back up now. The first run exports history; later runs start at the last checkpoint.'}</span>
                  </div>
                ) : messages.map((message, index) => {
                  const sender = message.from || 'Unknown sender';
                  const outgoing = sender === selectedChat.account_name || sender === 'Me' || selectedChat.type === 'Saved Messages';
                  const text = messageText(message);
                  return (
                    <article key={message._archive_id || message.id || index} className={`tg-bubble-row ${outgoing ? 'outgoing' : ''}`}>
                      <div className="tg-bubble">
                        <div className="tg-bubble-sender">{sender}</div>
                        {text && <div className="tg-bubble-text">{text}</div>}
                        {(message.file || message.photo) && <div className="tg-bubble-media">Attachment: {message.file || message.photo}</div>}
                        <time>{formatDate(message.date || (message.date_unixtime ? Number(message.date_unixtime) * 1000 : ''))}</time>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </div>

      <div className="tg-archive-note">
        <span>Incremental archive</span>
        The first run exports the selected chat’s history. Later runs use the last message checkpoint with a one-day safety overlap, deduplicate by message ID and content, and upload only new archive/media files through the configured encrypted rclone remote.
      </div>
    </div>
  );
}
