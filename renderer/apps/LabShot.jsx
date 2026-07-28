import React, { useState, useEffect } from 'react';
import { Camera } from '@phosphor-icons/react/Camera';
import { Clock } from '@phosphor-icons/react/Clock';
import { Copy } from '@phosphor-icons/react/Copy';
import { DownloadSimple } from '@phosphor-icons/react/DownloadSimple';
import { FolderOpen } from '@phosphor-icons/react/FolderOpen';
import { LockSimple } from '@phosphor-icons/react/LockSimple';
import { PushPin } from '@phosphor-icons/react/PushPin';
import { Trash } from '@phosphor-icons/react/Trash';
import AppIcon from '../AppIcon';
import BrandMark from '../BrandMark';

const ipcRenderer = window.electron?.ipcRenderer;

export default function LabShot() {
  const [gallery, setGallery] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('gallery'); // gallery, settings

  const handleOpenFolder = async () => {
    await ipcRenderer?.invoke('labshot:openScreenshotsFolder');
  };

  const fetchGallery = async () => {
    try {
      setLoading(true);
      const items = await ipcRenderer?.invoke('labshot:getGallery');
      setGallery(items || []);
    } catch (err) {
      console.error('Failed to load LabShot gallery:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGallery();
  }, []);

  const handleStartCapture = async (delayMs = 0) => {
    try {
      await ipcRenderer?.invoke('labshot:startCapture', { delayMs });
    } catch (err) {
      console.error('Failed to start capture:', err);
    }
  };

  const handleCopyItem = async (item) => {
    if (item?.dataUrl) {
      await ipcRenderer?.invoke('labshot:copyToClipboard', { dataUrl: item.dataUrl });
    }
  };

  const handleSaveItem = async (item) => {
    if (item?.dataUrl) {
      await ipcRenderer?.invoke('labshot:saveToFile', { dataUrl: item.dataUrl });
    }
  };

  const handlePinItem = async (item) => {
    if (item?.dataUrl) {
      await ipcRenderer?.invoke('labshot:pinToScreen', {
        dataUrl: item.dataUrl,
        width: item.width || 400,
        height: item.height || 300
      });
    }
  };

  const handleDeleteItem = async (id) => {
    await ipcRenderer?.invoke('labshot:deleteScreenshot', { id });
    fetchGallery();
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto', color: '#e2e8f0' }}>
      {/* 1. Header & Branding */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(139, 92, 246, 0.14)', border: '1px solid rgba(167, 139, 250, 0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <AppIcon appId="labshot" size={30} />
          </div>
          <div>
            <h1 style={{ fontSize: '20px', fontWeight: 700, margin: 0, color: '#f8fafc' }}>LabShot</h1>
            <p style={{ fontSize: '13px', color: '#94a3b8', margin: 0 }}>Instant Flameshot-style Screen Capture, Live Annotation & Encrypted Vault Storage</p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => handleStartCapture(0)}
            style={{
              padding: '10px 18px',
              borderRadius: '8px',
              border: 'none',
              background: '#8b5cf6',
              color: '#0f172a',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(139, 92, 246, 0.3)'
            }}
          >
            <Camera size={18} weight="bold" /> Take Screenshot (Alt+Shift+S)
          </button>
          <button
            onClick={() => handleStartCapture(3000)}
            style={{
              padding: '10px 14px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.15)',
              background: '#1e293b',
              color: '#e2e8f0',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer'
            }}
          >
            <Clock size={16} /> 3s Delay
          </button>

          <button
            onClick={handleOpenFolder}
            style={{
              padding: '10px 14px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.15)',
              background: '#1e293b',
              color: '#e2e8f0',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer'
            }}
            title="Open local & vault screenshots folder on disk"
          >
            <FolderOpen size={16} /> Open Screenshots Folder
          </button>
        </div>
      </div>

      {/* 2. Navigation Tabs */}
      <div style={{ display: 'flex', gap: '16px', borderBottom: '1px solid rgba(255,255,255,0.1)', marginBottom: '20px' }}>
        <button
          onClick={() => setActiveTab('gallery')}
          style={{
            padding: '8px 16px',
            border: 'none',
            background: 'transparent',
            color: activeTab === 'gallery' ? '#a78bfa' : '#94a3b8',
            borderBottom: activeTab === 'gallery' ? '2px solid #8b5cf6' : '2px solid transparent',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          Screenshot History ({gallery.length})
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          style={{
            padding: '8px 16px',
            border: 'none',
            background: 'transparent',
            color: activeTab === 'settings' ? '#a78bfa' : '#94a3b8',
            borderBottom: activeTab === 'settings' ? '2px solid #8b5cf6' : '2px solid transparent',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          LabShot Settings
        </button>
      </div>

      {/* 3. Gallery Tab View */}
      {activeTab === 'gallery' && (
        <div>
          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>Loading screenshot history...</div>
          ) : gallery.length === 0 ? (
            <div style={{ padding: '60px', textAlign: 'center', background: '#0f172a', borderRadius: '12px', border: '1px dashed rgba(255,255,255,0.15)' }}>
              <AppIcon appId="labshot" size={64} />
              <h3 style={{ margin: '16px 0 8px 0', fontSize: '16px', color: '#f8fafc' }}>No Screenshots Captured Yet</h3>
              <p style={{ fontSize: '13px', color: '#94a3b8', maxWidth: '420px', margin: '0 auto 20px auto' }}>
                Press <strong style={{ color: '#a78bfa' }}>Alt+Shift+S</strong> anywhere on Windows, or click the LabShot tray icon to take your first screenshot!
              </p>
              <button
                onClick={() => handleStartCapture(0)}
                style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', background: '#8b5cf6', color: '#ffffff', fontWeight: 700, cursor: 'pointer' }}
              >
                Launch Screen Capture
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '20px' }}>
              {gallery.map(item => (
                <div
                  key={item.id}
                  style={{
                    background: '#1e293b',
                    borderRadius: '10px',
                    border: '1px solid rgba(255,255,255,0.1)',
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column'
                  }}
                >
                  {/* Thumbnail preview */}
                  <div style={{ height: '160px', background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    <img src={item.dataUrl} alt={item.title} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                  </div>

                  {/* Details */}
                  <div style={{ padding: '14px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: '#f1f5f9' }}>{item.title}</span>
                        {item.savedToVault && (
                          <span style={{ fontSize: '10px', background: 'rgba(139, 92, 246, 0.2)', color: '#c4b5fd', padding: '2px 6px', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '3px' }}>
                            <LockSimple size={10} /> Vault
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: '11px', color: '#64748b' }}>{new Date(item.timestamp).toLocaleString()}</span>
                    </div>

                    {/* Actions bar */}
                    <div style={{ display: 'flex', gap: '6px', marginTop: '14px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '10px' }}>
                      <button
                        onClick={() => handleCopyItem(item)}
                        style={{ flex: 1, padding: '6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)', background: '#0f172a', color: '#e2e8f0', fontSize: '12px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                      >
                        <Copy size={14} /> Copy
                      </button>
                      <button
                        onClick={() => handlePinItem(item)}
                        style={{ padding: '6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)', background: '#0f172a', color: '#e2e8f0', cursor: 'pointer' }}
                        title="Pin to Screen"
                      >
                        <PushPin size={14} />
                      </button>
                      <button
                        onClick={() => handleSaveItem(item)}
                        style={{ padding: '6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)', background: '#0f172a', color: '#e2e8f0', cursor: 'pointer' }}
                        title="Save to file"
                      >
                        <DownloadSimple size={14} />
                      </button>
                      <button
                        onClick={() => handleDeleteItem(item.id)}
                        style={{ padding: '6px', borderRadius: '6px', border: 'none', background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', cursor: 'pointer' }}
                        title="Delete screenshot"
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 4. Settings Tab View */}
      {activeTab === 'settings' && (
        <div style={{ background: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', maxWidth: '640px' }}>
          <h3 style={{ fontSize: '16px', margin: '0 0 16px 0', color: '#f8fafc' }}>LabShot Configuration</h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>Global Capture Hotkey</label>
              <div style={{ background: '#0f172a', padding: '10px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)', fontFamily: 'monospace', color: '#a78bfa', fontWeight: 600 }}>
                Alt + Shift + S
              </div>
            </div>

            <div>
              <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>System Tray Integration</label>
              <div style={{ fontSize: '13px', color: '#cbd5e1' }}>
                LabShot is active in the Windows notification area. Left-click the purple LabShot icon to capture at any time.
              </div>
            </div>

            <div>
              <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>Encrypted Vault Folder</label>
              <div style={{ fontSize: '13px', color: '#cbd5e1' }}>
                Screenshots saved to Vault are automatically backed up to your encrypted cloud storage target (`LabSuite/Screenshots`).
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
