import React, { useState, useEffect } from 'react';

const ipcRenderer = window.electron.ipcRenderer;

export default function TelegramBackup() {
  const [installs, setInstalls] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [remoteBackups, setRemoteBackups] = useState([]);
  const [activeTab, setActiveTab] = useState('installs');
  const [isScanning, setIsScanning] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [historyInstall, setHistoryInstall] = useState(null);
  const [historyList, setHistoryList] = useState([]);
  const [newInstallLabel, setNewInstallLabel] = useState('');
  const [newInstallPath, setNewInstallPath] = useState('');
  const [progressMap, setProgressMap] = useState({});
  const [statusMessage, setStatusMessage] = useState(null);

  // Load installs on mount
  useEffect(() => {
    loadInstalls();
    loadRemoteBackups();

    // Listen to progress updates
    const handleProgress = (event, { id, remotePath, progress }) => {
      const key = id || remotePath;
      setProgressMap(prev => ({
        ...prev,
        [key]: progress
      }));
      if (progress.stage === 'completed') {
        loadInstalls();
        loadRemoteBackups();
        showStatus('Backup completed successfully!', 'success');
      }
    };

    const handleComplete = (event, { id, remotePath, success, error }) => {
      const key = id || remotePath;
      setProgressMap(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      loadInstalls();
      loadRemoteBackups();
      if (success) {
        showStatus('Operation completed successfully!', 'success');
      } else {
        showStatus(error || 'Operation failed.', 'error');
      }
    };

    ipcRenderer.on('telegram:progress', handleProgress);
    ipcRenderer.on('telegram:backup-complete', handleComplete);

    return () => {
      ipcRenderer.removeListener('telegram:progress', handleProgress);
      ipcRenderer.removeListener('telegram:backup-complete', handleComplete);
    };
  }, []);

  const loadInstalls = async () => {
    const list = await ipcRenderer.invoke('telegram:getInstalls');
    if (list) {
      setInstalls(list);
    }
  };

  const loadRemoteBackups = async () => {
    const backups = await ipcRenderer.invoke('telegram:listRemoteBackups');
    if (backups) {
      setRemoteBackups(backups);
    }
  };

  const showStatus = (msg, type = 'info') => {
    setStatusMessage({ msg, type });
    setTimeout(() => {
      setStatusMessage(null);
    }, 5000);
  };

  const handleScan = async () => {
    setIsScanning(true);
    try {
      const results = await ipcRenderer.invoke('telegram:discover');
      // Filter out already registered paths
      const existingPaths = new Set(installs.map(i => i.tdata_path.toLowerCase()));
      const newDiscovered = (results || []).filter(r => !existingPaths.has(r.tdata_path.toLowerCase()));
      setDiscovered(newDiscovered);
      if (newDiscovered.length === 0) {
        showStatus('Scan completed. No new Telegram installations found.', 'info');
      } else {
        showStatus(`Scan found ${newDiscovered.length} unregistered installation(s)!`, 'success');
      }
    } catch (err) {
      showStatus('Discovery scan failed: ' + err.message, 'error');
    } finally {
      setIsScanning(false);
    }
  };

  const handleAddDiscovered = async (item) => {
    try {
      await ipcRenderer.invoke('telegram:addInstall', {
        label: item.label,
        path: item.tdata_path
      });
      setDiscovered(prev => prev.filter(i => i.tdata_path !== item.tdata_path));
      loadInstalls();
      showStatus('Telegram installation registered!', 'success');
    } catch (err) {
      showStatus('Failed to add Telegram: ' + err.message, 'error');
    }
  };

  const handleAddCustom = async () => {
    if (!newInstallPath) {
      showStatus('Folder path is required.', 'error');
      return;
    }
    try {
      await ipcRenderer.invoke('telegram:addInstall', {
        label: newInstallLabel || 'Telegram Custom',
        path: newInstallPath
      });
      setShowAddModal(false);
      setNewInstallLabel('');
      setNewInstallPath('');
      loadInstalls();
      showStatus('Custom Telegram installation registered!', 'success');
    } catch (err) {
      showStatus('Failed to register: ' + err.message, 'error');
    }
  };

  const handleSelectPath = async () => {
    const selected = await ipcRenderer.invoke('folders:selectLocal');
    if (selected) {
      setNewInstallPath(selected);
      if (!newInstallLabel) {
        setNewInstallLabel('Telegram Portable');
      }
    }
  };

  const handleRemove = async (id) => {
    if (window.confirm('Are you sure you want to stop backing up this Telegram installation? Your remote backups will not be deleted.')) {
      try {
        await ipcRenderer.invoke('telegram:removeInstall', id);
        loadInstalls();
        showStatus('Installation removed from backup list.', 'info');
      } catch (err) {
        showStatus('Failed to remove: ' + err.message, 'error');
      }
    }
  };

  const handleUpdateSchedule = async (id, schedule) => {
    try {
      await ipcRenderer.invoke('telegram:updateInstall', { id, updates: { schedule } });
      loadInstalls();
      showStatus('Backup schedule updated.', 'success');
    } catch (err) {
      showStatus('Failed to update schedule: ' + err.message, 'error');
    }
  };

  const handleUpdateScheduleTime = async (id, schedule_time) => {
    try {
      await ipcRenderer.invoke('telegram:updateInstall', { id, updates: { schedule_time } });
      loadInstalls();
    } catch (err) {
      showStatus('Failed to update schedule time: ' + err.message, 'error');
    }
  };

  const handleToggleEnabled = async (id, enabled) => {
    try {
      await ipcRenderer.invoke('telegram:updateInstall', { id, updates: { enabled } });
      loadInstalls();
      showStatus(enabled ? 'Backup enabled.' : 'Backup paused.', 'info');
    } catch (err) {
      showStatus('Failed to toggle enabled state: ' + err.message, 'error');
    }
  };

  const handleBackupNow = async (id) => {
    try {
      await ipcRenderer.invoke('telegram:backupNow', id);
      // Immediately set the UI state to show preparing state
      setProgressMap(prev => ({
        ...prev,
        [id]: { stage: 'preparing', percent: 5, message: 'Snapshot starting...' }
      }));
      loadInstalls();
    } catch (err) {
      showStatus('Failed to start backup: ' + err.message, 'error');
    }
  };

  const handleViewHistory = async (install) => {
    setHistoryInstall(install);
    try {
      const history = await ipcRenderer.invoke('telegram:getHistory', install.id);
      setHistoryList((history || []).reverse());
      setShowHistoryModal(true);
    } catch (err) {
      showStatus('Failed to fetch history: ' + err.message, 'error');
    }
  };

  const handleRestore = async (device, remotePath) => {
    const dest = await ipcRenderer.invoke('folders:selectRestoreDest');
    if (!dest) return;

    setIsRestoring(true);
    setProgressMap(prev => ({
      ...prev,
      [remotePath]: { stage: 'downloading', percent: 5, message: 'Starting restore download...' }
    }));

    try {
      await ipcRenderer.invoke('telegram:restore', { device, remotePath, localDestination: dest });
    } catch (err) {
      showStatus('Restore failed: ' + err.message, 'error');
      setIsRestoring(false);
      setProgressMap(prev => {
        const next = { ...prev };
        delete next[remotePath];
        return next;
      });
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getStatusBadgeClass = (install) => {
    if (progressMap[install.id]) return 'badge-progress';
    if (!install.enabled) return 'badge-disabled';
    if (install.last_backup_status === 'success') return 'badge-success';
    if (install.last_backup_status === 'failed') return 'badge-failed';
    return 'badge-pending';
  };

  const getStatusLabel = (install) => {
    if (progressMap[install.id]) return 'Running';
    if (!install.enabled) return 'Paused';
    if (install.last_backup_status === 'success') return 'Protected';
    if (install.last_backup_status === 'failed') return 'Failed';
    return 'Pending';
  };

  return (
    <div style={{ padding: '30px', height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      
      {/* Page Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '26px', fontWeight: 800, margin: '0 0 4px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: '#0088cc' }}>✈️</span> Telegram Backup
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', margin: 0 }}>
            Safely back up your multi-account Telegram databases and media cache to Google Drive.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button 
            className="btn btn-secondary" 
            onClick={handleScan}
            disabled={isScanning}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            {isScanning ? <span className="spinner-small"></span> : '🔍'} Scan for Telegram
          </button>
          <button 
            className="btn btn-primary" 
            onClick={() => setShowAddModal(true)}
            style={{ background: '#0088cc', borderColor: '#0088cc' }}
          >
            ➕ Custom Path
          </button>
        </div>
      </div>

      {/* Global Status Banner */}
      {statusMessage && (
        <div className={`status-banner ${statusMessage.type}`} style={{
          padding: '12px 18px',
          borderRadius: '8px',
          marginBottom: '20px',
          fontSize: '13px',
          fontWeight: 600,
          background: statusMessage.type === 'success' ? 'rgba(16, 185, 129, 0.15)' : statusMessage.type === 'error' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)',
          border: `1px solid ${statusMessage.type === 'success' ? '#10b981' : statusMessage.type === 'error' ? '#ef4444' : '#3b82f6'}`,
          color: statusMessage.type === 'success' ? '#10b981' : statusMessage.type === 'error' ? '#ef4444' : '#3b82f6',
        }}>
          {statusMessage.msg}
        </div>
      )}

      {/* Tabs Menu */}
      <div className="tab-menu" style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', marginBottom: '24px', gap: '20px' }}>
        <button 
          onClick={() => setActiveTab('installs')} 
          style={{
            background: 'none',
            border: 'none',
            color: activeTab === 'installs' ? '#0088cc' : 'var(--text-secondary)',
            borderBottom: activeTab === 'installs' ? '2px solid #0088cc' : '2px solid transparent',
            padding: '10px 4px',
            fontSize: '14px',
            fontWeight: 700,
            cursor: 'pointer'
          }}
        >
          Active Backups ({installs.length})
        </button>
        <button 
          onClick={() => setActiveTab('cross-pc')} 
          style={{
            background: 'none',
            border: 'none',
            color: activeTab === 'cross-pc' ? '#0088cc' : 'var(--text-secondary)',
            borderBottom: activeTab === 'cross-pc' ? '2px solid #0088cc' : '2px solid transparent',
            padding: '10px 4px',
            fontSize: '14px',
            fontWeight: 700,
            cursor: 'pointer'
          }}
        >
          Cross-PC Restores ({remoteBackups.length})
        </button>
      </div>

      {/* Discovered Banner */}
      {discovered.length > 0 && activeTab === 'installs' && (
        <div style={{
          background: 'rgba(0, 136, 204, 0.08)',
          border: '1px solid rgba(0, 136, 204, 0.3)',
          borderRadius: '10px',
          padding: '16px 20px',
          marginBottom: '24px'
        }}>
          <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', fontWeight: 700, color: '#54a9eb' }}>
            Discovered Telegram Installations
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {discovered.map((item, idx) => (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', background: 'rgba(0,0,0,0.15)', padding: '10px 14px', borderRadius: '6px' }}>
                <div>
                  <strong>{item.label}</strong> ({item.account_count} accounts)
                  <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '2px', wordBreak: 'break-all' }}>
                    {item.tdata_path}
                  </div>
                </div>
                <button 
                  className="btn btn-primary"
                  onClick={() => handleAddDiscovered(item)}
                  style={{ padding: '6px 12px', fontSize: '12px', background: '#0088cc', borderColor: '#0088cc' }}
                >
                  Enable Backup
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab Contents: Installations */}
      {activeTab === 'installs' && (
        <div>
          {installs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: '12px', border: '1px dashed var(--border-color)' }}>
              <div style={{ fontSize: '48px', marginBottom: '16px' }}>✈️</div>
              <h3 style={{ margin: '0 0 8px 0', fontSize: '16px', fontWeight: 700 }}>No Telegram Backups Configured</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', maxWidth: '400px', margin: '0 auto 20px' }}>
                Scan for Telegram on your computer or add a custom path to start backing up your messages, images, and videos.
              </p>
              <button className="btn btn-primary" onClick={handleScan} style={{ background: '#0088cc', borderColor: '#0088cc' }}>
                Scan Computer
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '20px' }}>
              {installs.map(install => {
                const activeProgress = progressMap[install.id];
                return (
                  <div 
                    key={install.id} 
                    style={{
                      background: 'var(--bg-panel)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '12px',
                      padding: '20px',
                      display: 'flex',
                      flexDirection: 'column',
                      position: 'relative',
                      overflow: 'hidden'
                    }}
                  >
                    {/* Running Progress Bar Overlay */}
                    {activeProgress && (
                      <div style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        height: '4px',
                        background: '#0088cc',
                        width: `${activeProgress.percent}%`,
                        transition: 'width 0.3s ease-out'
                      }} />
                    )}

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                      <div>
                        <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 700 }}>{install.label}</h3>
                        <span className={`badge ${getStatusBadgeClass(install)}`} style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '4px', fontWeight: 600 }}>
                          {getStatusLabel(install)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <label className="switch" style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                          <input 
                            type="checkbox" 
                            checked={install.enabled} 
                            onChange={(e) => handleToggleEnabled(install.id, e.target.checked)}
                            style={{ marginRight: '6px' }}
                          />
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Active</span>
                        </label>
                        <button 
                          className="btn-icon" 
                          onClick={() => handleRemove(install.id)}
                          title="Delete backup path"
                          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px' }}
                        >
                          🗑️
                        </button>
                      </div>
                    </div>

                    <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                      <div style={{ wordBreak: 'break-all', fontFamily: 'monospace', background: 'rgba(0,0,0,0.12)', padding: '6px 10px', borderRadius: '4px', marginBottom: '6px' }}>
                        {install.tdata_path}
                      </div>
                      <div style={{ display: 'flex', gap: '15px' }}>
                        <span>👤 <strong>{install.account_count}</strong> account(s)</span>
                        {install.last_backup_at && (
                          <span>💾 <strong>{formatBytes(install.last_backup_size_bytes)}</strong></span>
                        )}
                      </div>
                    </div>

                    {/* Schedule options */}
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '10px 14px', borderRadius: '8px', marginBottom: '18px' }}>
                      <div style={{ fontSize: '12.5px', fontWeight: 600 }}>Schedule:</div>
                      <select 
                        value={install.schedule} 
                        onChange={(e) => handleUpdateSchedule(install.id, e.target.value)}
                        style={{ background: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: '4px', padding: '4px 8px', fontSize: '12.5px' }}
                      >
                        <option value="hourly">Hourly</option>
                        <option value="6hours">Every 6 Hours</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="manual">Manual Only</option>
                      </select>

                      {install.schedule === 'daily' && (
                        <input 
                          type="time" 
                          value={install.schedule_time || '03:00'}
                          onChange={(e) => handleUpdateScheduleTime(install.id, e.target.value)}
                          style={{ background: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: '4px', padding: '3px 6px', fontSize: '12.5px', width: '75px' }}
                        />
                      )}
                    </div>

                    {/* Details and Actions */}
                    <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                        {install.last_backup_at ? (
                          <>Last run: {new Date(install.last_backup_at).toLocaleString()}</>
                        ) : (
                          <>Never backed up</>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button 
                          className="btn btn-secondary" 
                          onClick={() => handleViewHistory(install)}
                          style={{ padding: '6px 12px', fontSize: '12.5px' }}
                        >
                          📜 History
                        </button>
                        <button 
                          className="btn btn-primary" 
                          disabled={!!activeProgress}
                          onClick={() => handleBackupNow(install.id)}
                          style={{ padding: '6px 14px', fontSize: '12.5px', background: '#0088cc', borderColor: '#0088cc' }}
                        >
                          {activeProgress ? 'Syncing...' : 'Backup Now'}
                        </button>
                      </div>
                    </div>

                    {/* Active progress status msg */}
                    {activeProgress && (
                      <div style={{ fontSize: '12px', color: '#54a9eb', marginTop: '10px', textAlign: 'right', fontWeight: 600 }}>
                        {activeProgress.message}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab Contents: Cross-PC Restores */}
      {activeTab === 'cross-pc' && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden' }}>
          {remoteBackups.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px' }}>
              <div style={{ fontSize: '48px', marginBottom: '16px' }}>☁️</div>
              <h3 style={{ margin: '0 0 8px 0', fontSize: '16px', fontWeight: 700 }}>No Cloud Backups Found</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', maxWidth: '400px', margin: '0 auto' }}>
                Google Drive doesn't contain any Telegram backups yet. Complete a backup run on any of your PCs to see them here.
              </p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.01)' }}>
                  <th style={{ padding: '14px 18px', fontWeight: 700 }}>Device / Source PC</th>
                  <th style={{ padding: '14px 18px', fontWeight: 700 }}>Last Backup</th>
                  <th style={{ padding: '14px 18px', fontWeight: 700 }}>Size</th>
                  <th style={{ padding: '14px 18px', fontWeight: 700 }}>Files Count</th>
                  <th style={{ padding: '14px 18px', fontWeight: 700, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {remoteBackups.map((bk, idx) => {
                  const progress = progressMap[bk.remote_path];
                  return (
                    <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <td style={{ padding: '14px 18px', fontWeight: 600 }}>
                        <span style={{ marginRight: '6px' }}>💻</span> {bk.device}
                      </td>
                      <td style={{ padding: '14px 18px', color: 'var(--text-secondary)' }}>
                        {bk.last_backup_at ? new Date(bk.last_backup_at).toLocaleString() : 'N/A'}
                      </td>
                      <td style={{ padding: '14px 18px', fontWeight: 700 }}>
                        {formatBytes(bk.size_bytes)}
                      </td>
                      <td style={{ padding: '14px 18px', color: 'var(--text-secondary)' }}>
                        {bk.file_count} files
                      </td>
                      <td style={{ padding: '14px 18px', textAlign: 'right' }}>
                        <button 
                          className="btn btn-primary"
                          disabled={!!progress || isRestoring}
                          onClick={() => handleRestore(bk.device, bk.remote_path)}
                          style={{ padding: '6px 14px', fontSize: '12px', background: '#0088cc', borderColor: '#0088cc' }}
                        >
                          {progress ? `Downloading ${progress.percent}%` : '⬇️ Restore Here'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Modal: Add Custom Path */}
      {showAddModal && (
        <div className="modal-backdrop" style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', zIndex: 1000
        }}>
          <div className="modal-content" style={{
            background: 'var(--bg-panel)', border: '1px solid var(--border-color)',
            borderRadius: '12px', width: '90%', maxWidth: '500px', overflow: 'hidden'
          }}>
            <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Register Custom Telegram Path</h3>
              <button onClick={() => setShowAddModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '16px' }}>×</button>
            </div>
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12.5px', marginBottom: '6px', fontWeight: 600 }}>Custom Label:</label>
                <input 
                  type="text" 
                  value={newInstallLabel}
                  onChange={(e) => setNewInstallLabel(e.target.value)}
                  placeholder="e.g. Telegram Work / Portable"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px', borderRadius: '6px', fontSize: '13px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12.5px', marginBottom: '6px', fontWeight: 600 }}>Path to 'tdata' Folder:</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input 
                    type="text" 
                    value={newInstallPath}
                    onChange={(e) => setNewInstallPath(e.target.value)}
                    placeholder="C:\Paths\Telegram\tdata"
                    style={{ flex: 1, background: 'var(--bg-main)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px', borderRadius: '6px', fontSize: '13px' }}
                  />
                  <button className="btn btn-secondary" onClick={handleSelectPath}>Browse</button>
                </div>
              </div>
            </div>
            <div className="modal-footer" style={{ padding: '14px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button className="btn btn-secondary" onClick={() => setShowAddModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAddCustom} style={{ background: '#0088cc', borderColor: '#0088cc' }}>Register</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: View Backup History */}
      {showHistoryModal && historyInstall && (
        <div className="modal-backdrop" style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', zIndex: 1000
        }}>
          <div className="modal-content" style={{
            background: 'var(--bg-panel)', border: '1px solid var(--border-color)',
            borderRadius: '12px', width: '90%', maxWidth: '600px', overflow: 'hidden'
          }}>
            <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Backup History</h3>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{historyInstall.label}</span>
              </div>
              <button onClick={() => setShowHistoryModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '16px' }}>×</button>
            </div>
            <div style={{ padding: '20px', maxHeight: '400px', overflowY: 'auto' }}>
              {historyList.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-secondary)' }}>No history available.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {historyList.map((run, idx) => (
                    <div 
                      key={idx} 
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: 'rgba(0,0,0,0.12)',
                        padding: '12px 16px',
                        borderRadius: '6px',
                        borderLeft: `3px solid ${run.status === 'success' ? '#10b981' : '#ef4444'}`
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 600 }}>
                          {new Date(run.at).toLocaleString()}
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                          Size: {formatBytes(run.size)} &bull; Duration: {run.duration}s
                        </div>
                      </div>
                      <div>
                        <span style={{
                          fontSize: '11px',
                          padding: '3px 8px',
                          borderRadius: '4px',
                          fontWeight: 700,
                          background: run.status === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                          color: run.status === 'success' ? '#10b981' : '#ef4444'
                        }}>
                          {run.status === 'success' ? 'SUCCESS' : 'FAILED'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="modal-footer" style={{ padding: '14px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowHistoryModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
