import React, { useState, useEffect, useMemo } from 'react';

// Common utility to format bytes into readable strings
const formatBytes = (bytes) => {
  if (bytes === 0 || isNaN(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export default function DiskAnalyzer() {
  const [drives, setDrives] = useState([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(null);
  const [scanResult, setScanResult] = useState(null);
  const [expandedNodes, setExpandedNodes] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Fetch local drives on mount
  useEffect(() => {
    loadDrives();
  }, []);

  const loadDrives = async () => {
    try {
      const driveList = await window.electron.ipcRenderer.invoke('disk-analyzer:getDrives');
      setDrives(driveList || []);
      if (driveList && driveList.length > 0 && !selectedPath) {
        setSelectedPath(driveList[0].path);
      }
    } catch (e) {
      console.warn('Failed to load drives:', e.message);
      // Fallback
      setDrives([{ path: 'C:\\', name: 'Local Disk (C:)', size: 0, free: 0, used: 0 }]);
      setSelectedPath('C:\\');
    }
  };

  // Register progress listener
  useEffect(() => {
    const handleProgress = (event, progress) => {
      setScanProgress(progress);
    };

    window.electron.ipcRenderer.on('disk-analyzer:progress', handleProgress);
    return () => {
      window.electron.ipcRenderer.removeListener('disk-analyzer:progress', handleProgress);
    };
  }, []);

  const handleStartScan = async () => {
    if (!selectedPath.trim()) return;
    setScanning(true);
    setScanResult(null);
    setScanProgress({
      scannedFiles: 0,
      scannedFolders: 0,
      totalSize: 0,
      currentPath: selectedPath,
      done: false
    });
    setErrorMsg('');

    try {
      const response = await window.electron.ipcRenderer.invoke('disk-analyzer:startScan', {
        rootPath: selectedPath.trim()
      });

      if (response.success) {
        setScanResult(response);
        // Automatically expand the root node
        if (response.tree) {
          setExpandedNodes({ [response.tree.path]: true });
        }
      } else {
        setErrorMsg(response.error || 'Scan failed.');
      }
    } catch (e) {
      setErrorMsg(e.message || 'An unexpected error occurred during the scan.');
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  };

  const handleCancelScan = async () => {
    try {
      await window.electron.ipcRenderer.invoke('disk-analyzer:cancelScan');
    } catch (e) {
      console.error('Cancel scan failed:', e);
    }
  };

  const handleOpenPath = async (filePath) => {
    try {
      await window.electron.ipcRenderer.invoke('app:openExternal', filePath);
    } catch (e) {
      console.warn('Failed to open path:', e);
    }
  };

  const toggleNode = (nodePath) => {
    setExpandedNodes(prev => ({
      ...prev,
      [nodePath]: !prev[nodePath]
    }));
  };

  // Flat tree rendering helper for visual table rows
  const renderTreeRows = (node, depth = 0) => {
    if (!node) return null;

    const isExpanded = expandedNodes[node.path];
    const hasChildren = node.children && node.children.length > 0;
    
    // Check search query filter
    const matchesSearch = !searchQuery || node.name.toLowerCase().includes(searchQuery.toLowerCase());
    
    // Calculate percentage bar
    // Root node size is 100%, sub-nodes are relative to root size
    const rootSize = scanResult?.tree?.size || 1;
    const sizePercent = Math.min(100, Math.max(0, (node.size / rootSize) * 100));

    const rows = [];

    if (matchesSearch || searchQuery === '') {
      rows.push(
        <tr key={node.path} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', background: node.isDir ? 'transparent' : 'rgba(255,255,255,0.005)' }}>
          <td style={{ padding: '8px 12px 8px ' + (12 + depth * 20) + 'px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            {node.isDir ? (
              <button 
                onClick={() => toggleNode(node.path)}
                style={{ 
                  background: 'transparent', 
                  border: 'none', 
                  color: 'var(--text-secondary)', 
                  cursor: 'pointer', 
                  padding: '2px', 
                  display: 'flex', 
                  alignItems: 'center',
                  transform: isExpanded ? 'rotate(90deg)' : 'none',
                  transition: 'transform 0.15s ease'
                }}
              >
                ▶
              </button>
            ) : (
              <span style={{ width: '16px', display: 'inline-block' }}></span>
            )}
            <span style={{ fontSize: '15px' }}>{node.isDir ? '📁' : '📄'}</span>
            <span 
              onClick={() => node.isDir && toggleNode(node.path)}
              style={{ 
                cursor: node.isDir ? 'pointer' : 'default', 
                fontWeight: node.isDir ? 600 : 400,
                color: node.isDir ? 'var(--text-primary)' : 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '400px'
              }}
              title={node.name}
            >
              {node.name}
            </span>
          </td>
          <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontWeight: 600, fontFamily: 'monospace' }}>
            {formatBytes(node.size)}
          </td>
          <td style={{ padding: '8px 12px', width: '220px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ flex: 1, height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '99px', overflow: 'hidden' }}>
                <div style={{ width: `${sizePercent}%`, height: '100%', background: 'linear-gradient(90deg, var(--accent-primary), #60a5fa)', borderRadius: 'inherit' }} />
              </div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', width: '38px', textAlign: 'right' }}>
                {sizePercent.toFixed(1)}%
              </span>
            </div>
          </td>
          <td style={{ padding: '8px 12px', textAlign: 'right' }}>
            <button 
              className="btn btn-secondary" 
              style={{ padding: '2px 8px', fontSize: '11px' }}
              onClick={() => handleOpenPath(node.path)}
            >
              Reveal
            </button>
          </td>
        </tr>
      );
    }

    if (isExpanded && hasChildren) {
      node.children.forEach(child => {
        rows.push(...renderTreeRows(child, depth + 1));
      });
    }

    return rows;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px', boxSizing: 'border-box', overflowY: 'auto' }}>
      
      {/* Header section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '24px' }}>Space Analyzer</h1>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>
            Visualize and clean up local folders taking up space on this PC.
          </p>
        </div>
      </div>

      {/* Control panel & Drive Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '20px', marginBottom: '20px' }}>
        
        {/* Drive select panel */}
        <div className="card" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <h3 style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Select Target Drive or Folder
          </h3>
          
          <div style={{ display: 'flex', gap: '10px' }}>
            <input 
              type="text" 
              value={selectedPath} 
              onChange={e => setSelectedPath(e.target.value)} 
              placeholder="e.g. C:\ or C:\Users\YourName\Desktop" 
              disabled={scanning}
              style={{ 
                flex: 1, 
                background: 'rgba(0,0,0,0.2)', 
                border: '1px solid var(--border-color)', 
                borderRadius: '8px', 
                color: '#fff', 
                padding: '10px 14px', 
                fontSize: '13.5px',
                outline: 'none'
              }}
            />
            
            {scanning ? (
              <button className="btn btn-danger" onClick={handleCancelScan} style={{ padding: '10px 20px' }}>
                Cancel Scan
              </button>
            ) : (
              <button className="btn btn-primary" onClick={handleStartScan} disabled={!selectedPath} style={{ padding: '10px 20px' }}>
                Start Scan
              </button>
            )}
          </div>

          {/* Quick Drive Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px', marginTop: '4px' }}>
            {drives.map(drive => {
              const driveUsedPercent = drive.size > 0 ? (drive.used / drive.size) * 100 : 0;
              const isSelected = selectedPath === drive.path;
              return (
                <div 
                  key={drive.path}
                  onClick={() => !scanning && setSelectedPath(drive.path)}
                  style={{
                    padding: '10px 12px',
                    border: isSelected ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                    borderRadius: '8px',
                    background: isSelected ? 'rgba(52, 211, 153, 0.03)' : 'rgba(255,255,255,0.01)',
                    cursor: scanning ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: '13px', color: isSelected ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                    {drive.name || drive.path}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{formatBytes(drive.free)} free</span>
                    <span>of {formatBytes(drive.size)}</span>
                  </div>
                  <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '99px', marginTop: '6px', overflow: 'hidden' }}>
                    <div style={{ width: `${driveUsedPercent}%`, height: '100%', background: isSelected ? 'var(--accent-primary)' : 'var(--text-muted)', borderRadius: 'inherit' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Scan Status Card */}
        <div className="card" style={{ padding: '18px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          {scanning && scanProgress ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div className="loading-spinner" style={{ width: '14px', height: '14px' }}></div>
                <strong style={{ fontSize: '13px', color: 'var(--accent-primary)' }}>Scanning local storage...</strong>
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={scanProgress.currentPath}>
                Path: {scanProgress.currentPath}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '6px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '6px' }}>
                <div>
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Folders</div>
                  <div style={{ fontSize: '13px', fontWeight: 600, fontFamily: 'monospace' }}>{scanProgress.scannedFolders}</div>
                </div>
                <div>
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Files</div>
                  <div style={{ fontSize: '13px', fontWeight: 600, fontFamily: 'monospace' }}>{scanProgress.scannedFiles}</div>
                </div>
              </div>
              <div style={{ marginTop: '4px' }}>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Space Evaluated</div>
                <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                  {formatBytes(scanProgress.totalSize)}
                </div>
              </div>
            </div>
          ) : scanResult ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--accent-secondary)' }}>
                <span>✓</span>
                <strong style={{ fontSize: '13px' }}>Scan Completed Successfully</strong>
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                Target: {selectedPath}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '6px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '6px' }}>
                <div>
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Folders</div>
                  <div style={{ fontSize: '13.5px', fontWeight: 600, fontFamily: 'monospace' }}>{scanResult.stats.scannedFolders}</div>
                </div>
                <div>
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Files</div>
                  <div style={{ fontSize: '13.5px', fontWeight: 600, fontFamily: 'monospace' }}>{scanResult.stats.scannedFiles}</div>
                </div>
              </div>
              <div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase', marginTop: '4px' }}>Total Size</div>
                <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--accent-primary)', fontFamily: 'monospace' }}>
                  {formatBytes(scanResult.stats.totalSize)}
                </div>
              </div>
            </div>
          ) : errorMsg ? (
            <div style={{ color: 'var(--accent-error)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <strong>Scan Error</strong>
              <div style={{ fontSize: '12px', lineHeight: 1.35 }}>{errorMsg}</div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12.5px', padding: '10px 0' }}>
              Ready to analyze storage.<br />Click **Start Scan** to begin.
            </div>
          )}
        </div>
      </div>

      {/* Main Results View */}
      {scanResult && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '20px', flex: 1, minHeight: 0 }}>
          
          {/* Left panel: Hierarchical tree list */}
          <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-color)' }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Directory Size Structure</h3>
              <input 
                type="text" 
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="🔍 Search folder/file names..."
                style={{ 
                  background: 'rgba(255,255,255,0.03)', 
                  border: '1px solid var(--border-color)', 
                  borderRadius: '6px', 
                  color: '#fff', 
                  padding: '6px 12px', 
                  fontSize: '12px',
                  width: '200px',
                  outline: 'none'
                }}
              />
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.015)', borderBottom: '1px solid var(--border-color)', position: 'sticky', top: 0, zIndex: 1 }}>
                    <th style={{ padding: '10px 12px' }}>Name</th>
                    <th style={{ padding: '10px 12px', width: '100px' }}>Size</th>
                    <th style={{ padding: '10px 12px', width: '220px' }}>Usage</th>
                    <th style={{ padding: '10px 12px', width: '80px', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {renderTreeRows(scanResult.tree)}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right panel: File type breakdown */}
          <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)' }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>File Type Breakdown</h3>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              
              {/* Mini visual distribution bar */}
              <div style={{ width: '100%', height: '14px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', overflow: 'hidden', display: 'flex' }}>
                {scanResult.extensions.slice(0, 5).map((item, index) => {
                  const colors = ['#34d399', '#60a5fa', '#f59e0b', '#ec4899', '#8b5cf6'];
                  const pct = scanResult.stats.totalSize > 0 ? (item.size / scanResult.stats.totalSize) * 100 : 0;
                  if (pct < 1) return null;
                  return (
                    <div 
                      key={item.ext} 
                      style={{ width: `${pct}%`, height: '100%', background: colors[index % colors.length] }} 
                      title={`${item.ext}: ${pct.toFixed(1)}%`}
                    />
                  );
                })}
              </div>

              {/* Extension List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {scanResult.extensions.slice(0, 15).map((item, index) => {
                  const colors = ['#34d399', '#60a5fa', '#f59e0b', '#ec4899', '#8b5cf6'];
                  const color = colors[index % colors.length] || '#a3a3a3';
                  const pct = scanResult.stats.totalSize > 0 ? (item.size / scanResult.stats.totalSize) * 100 : 0;
                  
                  return (
                    <div key={item.ext} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: color }} />
                          <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>{item.ext}</span>
                        </div>
                        <div style={{ color: 'var(--text-secondary)' }}>
                          <span style={{ fontFamily: 'monospace' }}>{formatBytes(item.size)}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '10.5px', marginLeft: '6px', fontFamily: 'monospace' }}>
                            ({pct.toFixed(1)}%)
                          </span>
                        </div>
                      </div>
                      <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.03)', borderRadius: '99px', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 'inherit' }} />
                      </div>
                    </div>
                  );
                })}
                
                {scanResult.extensions.length === 0 && (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '20px 0' }}>
                    No file extensions detected.
                  </div>
                )}
              </div>

            </div>
          </div>

        </div>
      )}

    </div>
  );
}
