import React, { useState, useEffect } from 'react';
import { Copy } from '@phosphor-icons/react/Copy';
import { DownloadSimple } from '@phosphor-icons/react/DownloadSimple';
import { X } from '@phosphor-icons/react/X';

const ipcRenderer = window.electron?.ipcRenderer;

export default function LabShotPin() {
  const [dataUrl, setDataUrl] = useState(null);

  useEffect(() => {
    async function loadData() {
      const res = await ipcRenderer?.invoke('labshot:getCapturedScreen');
      if (res?.dataUrl) {
        setDataUrl(res.dataUrl);
      }
    }
    loadData();
  }, []);

  const handleCopy = async () => {
    if (dataUrl) {
      await ipcRenderer?.invoke('labshot:copyToClipboard', { dataUrl });
    }
  };

  const handleSave = async () => {
    if (dataUrl) {
      await ipcRenderer?.invoke('labshot:saveToFile', { dataUrl });
    }
  };

  const handleClose = () => {
    window.close();
  };

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#0f172a',
        border: '1px solid rgba(6, 182, 212, 0.5)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.8)',
        borderRadius: '6px',
        overflow: 'hidden',
        WebkitAppRegion: 'drag', // Allows dragging window by top bar
        userSelect: 'none'
      }}
    >
      {/* Pin Window Top Bar */}
      <div
        style={{
          height: '28px',
          background: '#1e293b',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px',
          borderBottom: '1px solid rgba(255,255,255,0.1)'
        }}
      >
        <span style={{ fontSize: '11px', fontWeight: 600, color: '#38bdf8' }}>📌 LabShot Pin</span>
        <div style={{ display: 'flex', gap: '4px', WebkitAppRegion: 'no-drag' }}>
          <button
            onClick={handleCopy}
            style={{ border: 'none', background: 'transparent', color: '#94a3b8', cursor: 'pointer', padding: '2px' }}
            title="Copy snippet"
          >
            <Copy size={14} />
          </button>
          <button
            onClick={handleSave}
            style={{ border: 'none', background: 'transparent', color: '#94a3b8', cursor: 'pointer', padding: '2px' }}
            title="Save snippet"
          >
            <DownloadSimple size={14} />
          </button>
          <button
            onClick={handleClose}
            style={{ border: 'none', background: 'transparent', color: '#ef4444', cursor: 'pointer', padding: '2px' }}
            title="Close snippet"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Snippet Image view */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {dataUrl ? (
          <img
            src={dataUrl}
            alt="Pinned Snippet"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        ) : (
          <span style={{ fontSize: '12px', color: '#64748b' }}>Loading snippet...</span>
        )}
      </div>
    </div>
  );
}
