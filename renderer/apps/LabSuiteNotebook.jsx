import React, { useState, useEffect } from 'react';

const ipcRenderer = window.electron?.ipcRenderer;

export default function LabSuiteNotebook({ externalFilePath }) {
  const [notes, setNotes] = useState([]);
  const [activeNotePath, setActiveNotePath] = useState(null);
  const [noteContent, setNoteContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  const [versions, setVersions] = useState([]);
  const [showVersions, setShowVersions] = useState(false);

  useEffect(() => {
    loadNotesList();
    if (externalFilePath) {
      openNote(externalFilePath);
    }
  }, [externalFilePath]);

  const loadNotesList = async () => {
    try {
      setIsLoading(true);
      const files = await ipcRenderer.invoke('notepad:listLocal');
      // Sort files by modification time (newest first)
      files.sort((a, b) => b.mtime - a.mtime);
      setNotes(files);
    } catch (e) {
      console.error('Failed to list local notes:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const openNote = async (filePath) => {
    try {
      setIsLoading(true);
      const rawText = await ipcRenderer.invoke('notepad:readFile', { filePath });
      setNoteContent(rawText);
      setActiveNotePath(filePath);
      setShowVersions(false);
    } catch (e) {
      alert('Failed to open file: ' + e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const saveNote = async () => {
    if (!activeNotePath) return;
    try {
      setIsSaving(true);
      await ipcRenderer.invoke('notepad:save', { filePath: activeNotePath, content: noteContent });
      // Update local list mtime
      loadNotesList();
    } catch (e) {
      alert('Failed to save file: ' + e.message);
    } finally {
      setIsSaving(false);
    }
  };

  const fetchVersions = async () => {
    if (!activeNotePath) return;
    try {
      const verList = await ipcRenderer.invoke('notepad:getVersions', { filePath: activeNotePath });
      setVersions(verList);
    } catch (e) {
      console.error('Failed to get versions:', e);
    }
  };

  const toggleVersions = () => {
    if (!showVersions) {
      fetchVersions();
    }
    setShowVersions(!showVersions);
  };

  const restoreOldVersion = async (versionId) => {
    if (!window.confirm('Are you sure you want to restore this version? Your current unsaved changes will be lost.')) return;
    
    try {
      setIsLoading(true);
      const rawText = await ipcRenderer.invoke('notepad:restoreVersion', { filePath: activeNotePath, versionId });
      setNoteContent(rawText);
      setShowVersions(false);
    } catch (e) {
      alert('Failed to restore version: ' + e.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      
      {/* Sidebar for Local Backed-up Files */}
      <div style={{ width: '280px', background: 'rgba(0,0,0,0.2)', borderRight: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-panel)' }}>
          <h3 style={{ margin: 0, fontSize: '15px', color: 'var(--text-primary)' }}>Secure Notepad</h3>
          <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>Local Backed-Up Files</p>
        </div>
        
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
          {isLoading && notes.length === 0 ? (
            <div className="tree-spinner" style={{ margin: '20px auto' }}></div>
          ) : notes.length === 0 ? (
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '20px' }}>
              No .txt files found in your synced folders.
            </p>
          ) : (
            notes.map(file => (
              <div 
                key={file.path}
                onClick={() => openNote(file.path)}
                style={{
                  padding: '10px 12px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  marginBottom: '6px',
                  background: activeNotePath === file.path ? 'var(--accent-primary-alpha)' : 'transparent',
                  border: activeNotePath === file.path ? '1px solid var(--accent-primary)' : '1px solid transparent',
                  transition: 'background 0.2s'
                }}
              >
                <div style={{ fontWeight: 500, fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  📄 {file.name}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {file.rootName}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main Editor Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-main)' }}>
        {activeNotePath ? (
          <>
            <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '16px' }}>{activeNotePath.split('\\').pop().split('/').pop()}</h3>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>{activeNotePath}</div>
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button className="btn btn-secondary" onClick={toggleVersions}>
                  {showVersions ? 'Hide History' : '🕒 History'}
                </button>
                <button className="btn btn-primary" onClick={saveNote} disabled={isSaving}>
                  {isSaving ? 'Saving...' : '💾 Save & Encrypt'}
                </button>
              </div>
            </div>

            <div style={{ flex: 1, display: 'flex', position: 'relative' }}>
              <textarea
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  padding: '24px',
                  color: '#e2e8f0',
                  fontSize: '15px',
                  fontFamily: 'Consolas, monospace',
                  resize: 'none',
                  outline: 'none',
                  lineHeight: '1.6'
                }}
              />

              {/* Version History Slide-out */}
              {showVersions && (
                <div style={{ 
                  width: '300px', 
                  borderLeft: '1px solid var(--border-color)', 
                  background: 'var(--bg-panel)', 
                  display: 'flex', 
                  flexDirection: 'column',
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  bottom: 0,
                  boxShadow: '-4px 0 15px rgba(0,0,0,0.5)'
                }}>
                  <div style={{ padding: '16px', borderBottom: '1px solid var(--border-color)' }}>
                    <h4 style={{ margin: 0, color: 'var(--accent-primary)' }}>Cloud Version History</h4>
                    <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>Last 10 encrypted saves</p>
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
                    {versions.length === 0 ? (
                      <p style={{ fontSize: '13px', color: 'var(--text-muted)', textAlign: 'center' }}>No older versions found.</p>
                    ) : (
                      versions.map(v => (
                        <div key={v.id} style={{ 
                          padding: '12px', 
                          background: 'rgba(255,255,255,0.03)', 
                          borderRadius: '6px', 
                          marginBottom: '8px',
                          border: '1px solid rgba(255,255,255,0.05)'
                        }}>
                          <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                            {new Date(v.timestamp).toLocaleString()}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
                            Size: {(v.size / 1024).toFixed(2)} KB
                          </div>
                          <button 
                            className="btn btn-secondary" 
                            style={{ width: '100%', fontSize: '12px', padding: '6px' }}
                            onClick={() => restoreOldVersion(v.id)}
                          >
                            Restore this version
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: '64px', opacity: 0.2 }}>📝</span>
            <h3 style={{ color: 'var(--text-muted)', marginTop: '20px' }}>Select a text file to edit</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', maxWidth: '300px', textAlign: 'center' }}>
              Files edited here will be automatically versioned and securely synced to your cloud storage.
            </p>
          </div>
        )}
      </div>

    </div>
  );
}
