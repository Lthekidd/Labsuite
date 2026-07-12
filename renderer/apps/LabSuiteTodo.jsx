import React, { useState, useEffect } from 'react';

const ipcRenderer = window.electron?.ipcRenderer;

export default function LabSuiteTodo() {
  const [boards, setBoards] = useState([]);
  const [activeBoard, setActiveBoard] = useState(null);
  const [columns, setColumns] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showBoardModal, setShowBoardModal] = useState(false);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [activeCol, setActiveCol] = useState(null);
  
  useEffect(() => {
    loadBoardsList();
  }, []);

  const loadBoardsList = async () => {
    try {
      setIsLoading(true);
      const files = await ipcRenderer.invoke('fastSync:list', { appName: 'Todo' });
      setBoards(files.filter(f => f.Name.endsWith('.vstodo')));
    } catch (e) {
      console.error('Failed to list boards:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const createBoard = () => {
    setShowBoardModal(true);
    setNewName('');
  };

  const handleCreateBoardConfirm = () => {
    if (!newName) return;
    setActiveBoard(`${newName}.vstodo`);
    setColumns({
      'To Do': [],
      'In Progress': [],
      'Done': []
    });
    setShowBoardModal(false);
  };

  const openBoard = async (fileName) => {
    try {
      setIsLoading(true);
      const encData = await ipcRenderer.invoke('fastSync:download', { appName: 'Todo', fileName });
      const rawJson = await ipcRenderer.invoke('crypt:decrypt', { base64Data: encData });
      setColumns(JSON.parse(rawJson));
      setActiveBoard(fileName);
    } catch (e) {
      alert('Failed to open board: ' + e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const saveBoard = async () => {
    if (!activeBoard) return;
    try {
      setIsSaving(true);
      const rawJson = JSON.stringify(columns);
      const encData = await ipcRenderer.invoke('crypt:encrypt', { text: rawJson });
      await ipcRenderer.invoke('fastSync:upload', { appName: 'Todo', fileName: activeBoard, data: encData });
      loadBoardsList();
    } catch (e) {
      alert('Failed to save board: ' + e.message);
    } finally {
      setIsSaving(false);
    }
  };

  const addTask = (colName) => {
    setActiveCol(colName);
    setNewName('');
    setShowTaskModal(true);
  };

  const handleAddTaskConfirm = () => {
    if (!newName || !activeCol) return;
    setColumns(prev => ({
      ...prev,
      [activeCol]: [...prev[activeCol], { id: Date.now().toString(), text: newName }]
    }));
    setShowTaskModal(false);
  };

  const moveTask = (taskId, sourceCol, targetCol) => {
    if (sourceCol === targetCol) return;
    setColumns(prev => {
      const taskIndex = prev[sourceCol].findIndex(t => t.id === taskId);
      if (taskIndex === -1) return prev;
      
      const task = prev[sourceCol][taskIndex];
      const newSource = [...prev[sourceCol]];
      newSource.splice(taskIndex, 1);
      
      const newTarget = [...prev[targetCol], task];
      
      return {
        ...prev,
        [sourceCol]: newSource,
        [targetCol]: newTarget
      };
    });
  };

  const handleDragStart = (e, taskId, sourceCol) => {
    e.dataTransfer.setData('taskId', taskId);
    e.dataTransfer.setData('sourceCol', sourceCol);
  };

  const handleDrop = (e, targetCol) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('taskId');
    const sourceCol = e.dataTransfer.getData('sourceCol');
    if (taskId && sourceCol) {
      moveTask(taskId, sourceCol, targetCol);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  if (activeBoard) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button className="btn btn-secondary" onClick={() => setActiveBoard(null)}>← Back</button>
            <h3 style={{ margin: 0, color: 'var(--accent-secondary)' }}>{activeBoard.replace('.vstodo', '')}</h3>
          </div>
          <button className="btn btn-primary" onClick={saveBoard} disabled={isSaving}>
            {isSaving ? 'Encrypting...' : 'Save Board ☁️'}
          </button>
        </div>
        
        <div style={{ flex: 1, display: 'flex', gap: '20px', overflowX: 'auto', paddingBottom: '10px' }}>
          {Object.entries(columns).map(([colName, tasks]) => (
            <div 
              key={colName}
              style={{
                flex: '0 0 300px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px',
                display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.05)'
              }}
              onDrop={(e) => handleDrop(e, colName)}
              onDragOver={handleDragOver}
            >
              <div style={{ padding: '16px', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0 }}>{colName}</h4>
                <button 
                  style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: '18px' }}
                  onClick={() => addTask(colName)}
                >
                  +
                </button>
              </div>
              <div style={{ flex: 1, padding: '16px', overflowY: 'auto' }}>
                {tasks.map(task => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, task.id, colName)}
                    style={{
                      background: 'rgba(255,255,255,0.05)', padding: '12px', borderRadius: '6px',
                      marginBottom: '10px', cursor: 'grab', fontSize: '14px',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                    }}
                  >
                    {task.text}
                  </div>
                ))}
                {tasks.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '12px' }}>
                    Drop tasks here
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Select a board or create a new one.</p>
        <button className="btn btn-primary" onClick={createBoard}>+ New Board</button>
      </div>

      {isLoading ? (
        <div className="tree-spinner" style={{ margin: '20px auto' }}></div>
      ) : boards.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
          <span style={{ fontSize: '48px', display: 'block', marginBottom: '16px' }}>📋</span>
          <p style={{ color: 'var(--text-muted)' }}>No boards found in your encrypted cloud vault.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px' }}>
          {boards.map(board => (
            <div 
              key={board.Name}
              onClick={() => openBoard(board.Name)}
              style={{
                background: 'rgba(255,255,255,0.05)', padding: '20px', borderRadius: '8px',
                cursor: 'pointer', border: '1px solid rgba(255,255,255,0.05)',
                transition: 'background 0.2s'
              }}
            >
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>📋</div>
              <h4 style={{ margin: '0 0 4px 0', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {board.Name.replace('.vstodo', '')}
              </h4>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {new Date(board.ModTime).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {showBoardModal && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'var(--bg-panel)', padding: '24px', borderRadius: '12px', width: '300px', border: '1px solid var(--border-color)', backdropFilter: 'blur(10px)' }}>
            <h3 style={{ margin: '0 0 16px 0' }}>New Board Name</h3>
            <input 
              autoFocus
              type="text" 
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateBoardConfirm()}
              style={{ width: '100%', padding: '8px', marginBottom: '16px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: '6px' }}
              placeholder="e.g. Project Launch"
            />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowBoardModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreateBoardConfirm}>Create</button>
            </div>
          </div>
        </div>
      )}

      {showTaskModal && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'var(--bg-panel)', padding: '24px', borderRadius: '12px', width: '300px', border: '1px solid var(--border-color)', backdropFilter: 'blur(10px)' }}>
            <h3 style={{ margin: '0 0 16px 0' }}>New Task</h3>
            <input 
              autoFocus
              type="text" 
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddTaskConfirm()}
              style={{ width: '100%', padding: '8px', marginBottom: '16px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: '6px' }}
              placeholder="e.g. Fix login bug"
            />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowTaskModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAddTaskConfirm}>Add Task</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
