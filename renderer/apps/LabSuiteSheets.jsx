import React, { useEffect, useMemo, useRef, useState } from 'react';

const ipcRenderer = window.electron?.ipcRenderer;
const FILE_EXTENSION = '.vssheet';
const DEFAULT_COLUMN_COUNT = 4;
const DEFAULT_ROW_COUNT = 12;
const DEFAULT_CELL_STYLE = {
  align: 'left',
  fontSize: 13,
  color: '#fafafa',
  background: '',
  bold: false,
  italic: false
};
const FONT_SIZES = [11, 12, 13, 14, 16, 18, 20, 24, 28];
const LOCAL_RECOVERY_DEBOUNCE_MS = 500;

async function safeInvoke(channel, ...args) {
  if (!ipcRenderer) throw new Error('LabSuite IPC is unavailable.');
  return ipcRenderer.invoke(channel, ...args);
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

function makeColumn(index, name) {
  return {
    id: makeId('col'),
    name: name || `Column ${index + 1}`,
    width: 180,
    style: { ...DEFAULT_CELL_STYLE }
  };
}

function makeRow(columns) {
  return {
    id: makeId('row'),
    height: 40,
    cells: Object.fromEntries(columns.map(column => [column.id, ''])),
    cellStyles: {}
  };
}

function normalizeCellStyle(style = {}) {
  const source = style && typeof style === 'object' ? style : {};
  return {
    ...DEFAULT_CELL_STYLE,
    ...source,
    align: ['left', 'center', 'right'].includes(source.align) ? source.align : DEFAULT_CELL_STYLE.align,
    fontSize: Math.max(9, Math.min(48, Number(source.fontSize) || DEFAULT_CELL_STYLE.fontSize)),
    color: /^#[0-9a-f]{6}$/i.test(String(source.color || '')) ? source.color : DEFAULT_CELL_STYLE.color,
    background: /^#[0-9a-f]{6}$/i.test(String(source.background || '')) ? source.background : '',
    bold: source.bold === true,
    italic: source.italic === true
  };
}

function getCellStyle(row, column) {
  return normalizeCellStyle({
    ...(column?.style || {}),
    ...(row?.cellStyles?.[column?.id] || {})
  });
}

function cleanTableName(value) {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function toFileName(value) {
  const name = cleanTableName(value) || 'Untitled Table';
  return name.toLowerCase().endsWith(FILE_EXTENSION) ? name : `${name}${FILE_EXTENSION}`;
}

function stripExtension(fileName) {
  return String(fileName || '').replace(/\.vssheet$/i, '');
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function tableToCsv(table) {
  if (!table) return '';
  const columns = Array.isArray(table.columns) ? table.columns : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const csvRows = [
    columns.map(column => csvEscape(column.name || '')),
    ...rows.map(row => columns.map(column => csvEscape(row.cells?.[column.id] ?? '')))
  ];
  return `\ufeff${csvRows.map(row => row.join(',')).join('\r\n')}\r\n`;
}

function normalizeTableData(raw, fileName) {
  const fallbackName = stripExtension(fileName) || 'Untitled Table';

  if (Array.isArray(raw)) {
    const maxColumns = raw.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0) || DEFAULT_COLUMN_COUNT;
    const columns = Array.from({ length: maxColumns }, (_, index) => makeColumn(index));
    const rows = raw.map(sourceRow => {
      const row = makeRow(columns);
      row.height = 40;
      columns.forEach((column, index) => {
        row.cells[column.id] = String((Array.isArray(sourceRow) ? sourceRow[index] : '') ?? '');
      });
      return row;
    });
    while (rows.length < DEFAULT_ROW_COUNT) {
      const newRow = makeRow(columns);
      newRow.height = 40;
      rows.push(newRow);
    }
    return {
      version: 2,
      tableName: fallbackName,
      columns,
      rows,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  if (raw && typeof raw === 'object') {
    const sourceColumns = Array.isArray(raw.columns) ? raw.columns : [];
    const columns = sourceColumns.length
      ? sourceColumns.map((column, index) => ({
        id: String(column.id || makeId('col')),
        name: String(column.name || `Column ${index + 1}`).slice(0, 80),
        width: Number(column.width) || 180,
        style: normalizeCellStyle(column.style)
      }))
      : Array.from({ length: DEFAULT_COLUMN_COUNT }, (_, index) => makeColumn(index));

    const rows = Array.isArray(raw.rows)
      ? raw.rows.map(sourceRow => {
        const cells = {};
        columns.forEach(column => {
          const sourceCells = sourceRow && typeof sourceRow === 'object' ? sourceRow.cells || {} : {};
          cells[column.id] = String(sourceCells[column.id] ?? '');
        });
        return {
          id: String(sourceRow.id || makeId('row')),
          height: Number(sourceRow.height) || 40,
          cells,
          cellStyles: Object.fromEntries(
            Object.entries(sourceRow.cellStyles || {})
              .filter(([columnId]) => columns.some(column => column.id === columnId))
              .map(([columnId, style]) => [columnId, normalizeCellStyle(style)])
          )
        };
      })
      : [];

    while (rows.length < DEFAULT_ROW_COUNT) {
      const newRow = makeRow(columns);
      newRow.height = 40;
      rows.push(newRow);
    }

    return {
      version: 2,
      tableName: String(raw.tableName || fallbackName).slice(0, 80),
      columns,
      rows,
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || new Date().toISOString()
    };
  }

  const columns = Array.from({ length: DEFAULT_COLUMN_COUNT }, (_, index) => makeColumn(index));
  return {
    version: 2,
    tableName: fallbackName,
    columns,
    rows: Array.from({ length: DEFAULT_ROW_COUNT }, () => {
      const newRow = makeRow(columns);
      newRow.height = 40;
      return newRow;
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createBlankTable(name) {
  const columns = Array.from({ length: DEFAULT_COLUMN_COUNT }, (_, index) => makeColumn(index));
  return {
    version: 2,
    tableName: cleanTableName(name) || 'Untitled Table',
    columns,
    rows: Array.from({ length: DEFAULT_ROW_COUNT }, () => {
      const newRow = makeRow(columns);
      newRow.height = 40;
      return newRow;
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function serializeTable(table) {
  return {
    version: 2,
    tableName: table.tableName,
    columns: table.columns.map(column => ({
      id: column.id,
      name: column.name,
      width: column.width || 180,
      style: normalizeCellStyle(column.style)
    })),
    rows: table.rows.map(row => ({
      id: row.id,
      height: row.height || 40,
      cells: Object.fromEntries(table.columns.map(column => [column.id, String(row.cells[column.id] ?? '')])),
      cellStyles: Object.fromEntries(
        table.columns
          .filter(column => row.cellStyles?.[column.id])
          .map(column => [column.id, normalizeCellStyle(row.cellStyles[column.id])])
      )
    })),
    createdAt: table.createdAt,
    updatedAt: new Date().toISOString()
  };
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString();
}

export default function LabSuiteSheets() {
  const [tables, setTables] = useState([]);
  const [activeFileName, setActiveFileName] = useState(null);
  const [activeTable, setActiveTable] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [localRecovery, setLocalRecovery] = useState({ status: 'idle', filePath: '', dir: '', error: '' });
  const [dirty, setDirty] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [filterText, setFilterText] = useState('');
  const [tablesSearch, setTablesSearch] = useState('');
  const [sortState, setSortState] = useState({ columnId: null, direction: 'asc' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [activeCell, setActiveCell] = useState(null); // { rowId, columnId }
  const [selectedTarget, setSelectedTarget] = useState(null); // { type, rowId, columnId }
  const [activeSearchMatch, setActiveSearchMatch] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [hoveredColResize, setHoveredColResize] = useState(null);
  const [hoveredRowResize, setHoveredRowResize] = useState(null);
  const [hoveredCard, setHoveredCard] = useState(null);
  const filterInputRef = useRef(null);

  useEffect(() => {
    loadTableList();
  }, []);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [contextMenu]);

  const searchQuery = filterText.trim().toLowerCase();

  const searchMatches = useMemo(() => {
    if (!activeTable || !searchQuery) return [];
    const matches = [];
    activeTable.rows.forEach((row, rowIndex) => {
      activeTable.columns.forEach((column, columnIndex) => {
        if (String(row.cells[column.id] || '').toLowerCase().includes(searchQuery)) {
          matches.push({
            rowId: row.id,
            columnId: column.id,
            rowIndex,
            columnIndex,
            key: `${row.id}:${column.id}`
          });
        }
      });
    });
    return matches;
  }, [activeTable, searchQuery]);

  const searchMatchKeys = useMemo(() => (
    new Set(searchMatches.map(match => match.key))
  ), [searchMatches]);

  const visibleRows = useMemo(() => {
    if (!activeTable) return [];
    if (!searchQuery) return activeTable.rows;
    const matchedRows = new Set(searchMatches.map(match => match.rowId));
    return activeTable.rows.filter(row => matchedRows.has(row.id));
  }, [activeTable, searchQuery, searchMatches]);

  useEffect(() => {
    if (!searchMatches.length) {
      setActiveSearchMatch(null);
      return;
    }
    setActiveSearchMatch(previous => {
      if (previous && searchMatches.some(match => match.key === previous.key)) return previous;
      return searchMatches[0];
    });
  }, [searchMatches]);

  const filteredTables = useMemo(() => {
    const query = tablesSearch.trim().toLowerCase();
    if (!query) return tables;
    return tables.filter(t => stripExtension(t.Name).toLowerCase().includes(query));
  }, [tables, tablesSearch]);

  const markDirty = () => {
    setDirty(true);
    setMessage('');
    setError('');
  };

  const loadTableList = async () => {
    try {
      setIsLoading(true);
      setError('');
      const files = await safeInvoke('fastSync:list', { appName: 'Sheets' });
      setTables((files || []).filter(file => String(file.Name || '').toLowerCase().endsWith(FILE_EXTENSION)));
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const closeActiveTable = () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setActiveFileName(null);
    setActiveTable(null);
    setDirty(false);
    setFilterText('');
    setSortState({ columnId: null, direction: 'asc' });
    setMessage('');
    setError('');
    setActiveCell(null);
    setSelectedTarget(null);
    setContextMenu(null);
    setLocalRecovery({ status: 'idle', filePath: '', dir: '', error: '' });
  };

  const openTable = async (fileName) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;

    try {
      setIsLoading(true);
      setError('');
      setMessage('');
      const encData = await safeInvoke('fastSync:download', { appName: 'Sheets', fileName });
      const rawJson = await safeInvoke('crypt:decrypt', { base64Data: encData });
      const parsed = JSON.parse(rawJson);
      setActiveTable(normalizeTableData(parsed, fileName));
      setActiveFileName(fileName);
      setDirty(false);
      setFilterText('');
      setSortState({ columnId: null, direction: 'asc' });
      setActiveCell(null);
      setSelectedTarget(null);
      setContextMenu(null);
      setLocalRecovery({ status: 'idle', filePath: '', dir: '', error: '' });
    } catch (err) {
      setError(`Failed to open table: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const createTable = () => {
    setNewName('');
    setShowNewModal(true);
  };

  const confirmCreateTable = () => {
    const tableName = cleanTableName(newName);
    if (!tableName) return;
    const table = createBlankTable(tableName);
    setActiveTable(table);
    setActiveFileName(toFileName(tableName));
    setDirty(true);
    setFilterText('');
    setSortState({ columnId: null, direction: 'asc' });
    setActiveCell(null);
    setSelectedTarget(null);
    setContextMenu(null);
    setLocalRecovery({ status: 'idle', filePath: '', dir: '', error: '' });
    setShowNewModal(false);
    setMessage('');
    setError('');
  };

  const saveTable = async () => {
    if (!activeTable || !activeFileName) return;

    try {
      setIsSaving(true);
      setError('');
      const payload = serializeTable(activeTable);
      const rawJson = JSON.stringify(payload);
      const encData = await safeInvoke('crypt:encrypt', { text: rawJson });
      await safeInvoke('fastSync:upload', { appName: 'Sheets', fileName: activeFileName, data: encData });
      setActiveTable(normalizeTableData(payload, activeFileName));
      setDirty(false);
      setMessage('Saved successfully.');
      await loadTableList();
    } catch (err) {
      setError(`Failed to save table: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const deleteActiveTable = async () => {
    if (!activeFileName || !window.confirm(`Delete "${stripExtension(activeFileName)}"?`)) return;

    try {
      setIsLoading(true);
      setError('');
      await safeInvoke('fastSync:delete', { appName: 'Sheets', fileName: activeFileName });
      await safeInvoke('sheets:deleteLocalRecovery', { fileName: activeFileName, tableName: activeTable?.tableName }).catch(() => {});
      setActiveFileName(null);
      setActiveTable(null);
      setDirty(false);
      setLocalRecovery({ status: 'idle', filePath: '', dir: '', error: '' });
      setMessage('Deleted successfully.');
      await loadTableList();
    } catch (err) {
      setError(`Failed to delete table: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const writeLocalRecovery = async (table = activeTable, fileName = activeFileName) => {
    if (!table || !fileName) return null;
    try {
      setLocalRecovery(previous => ({ ...previous, status: 'saving', error: '' }));
      const result = await safeInvoke('sheets:writeLocalRecovery', {
        fileName,
        tableName: table.tableName,
        csv: tableToCsv(table)
      });
      setLocalRecovery({
        status: 'saved',
        filePath: result?.filePath || '',
        dir: result?.dir || '',
        error: ''
      });
      return result;
    } catch (err) {
      setLocalRecovery(previous => ({
        ...previous,
        status: 'error',
        error: err.message || 'Local CSV recovery failed.'
      }));
      return null;
    }
  };

  const openLocalRecoveryFolder = async () => {
    try {
      const result = await safeInvoke('sheets:openRecoveryDir');
      if (!result?.success) throw new Error(result?.error || 'Could not open the recovery folder.');
      setLocalRecovery(previous => ({ ...previous, dir: result.dir || previous.dir }));
      setMessage('Opened local CSV recovery folder.');
      setError('');
    } catch (err) {
      setError(`Failed to open local CSV folder: ${err.message}`);
    }
  };

  const updateTableName = (value) => {
    setActiveTable(previous => previous ? { ...previous, tableName: value.slice(0, 80) } : previous);
    markDirty();
  };

  const updateColumnName = (columnId, value) => {
    setActiveTable(previous => {
      if (!previous) return previous;
      return {
        ...previous,
        columns: previous.columns.map(column => (
          column.id === columnId ? { ...column, name: value.slice(0, 80) } : column
        ))
      };
    });
    markDirty();
  };

  const updateCell = (rowId, columnId, value) => {
    setActiveTable(previous => {
      if (!previous) return previous;
      return {
        ...previous,
        rows: previous.rows.map(row => (
          row.id === rowId ? { ...row, cells: { ...row.cells, [columnId]: value } } : row
        ))
      };
    });
    markDirty();
  };

  const getSelectedStyle = () => {
    if (!activeTable) return DEFAULT_CELL_STYLE;
    const target = selectedTarget || (activeCell ? { type: 'cell', ...activeCell } : null);
    if (!target) return DEFAULT_CELL_STYLE;

    if (target.type === 'all') {
      const row = activeTable.rows[0];
      const column = activeTable.columns[0];
      return row && column ? getCellStyle(row, column) : DEFAULT_CELL_STYLE;
    }

    if (target.type === 'column') {
      const column = activeTable.columns.find(item => item.id === target.columnId);
      return normalizeCellStyle(column?.style);
    }

    const row = activeTable.rows.find(item => item.id === target.rowId);
    const column = activeTable.columns.find(item => item.id === target.columnId) || activeTable.columns[0];
    if (!row || !column) return DEFAULT_CELL_STYLE;
    return getCellStyle(row, column);
  };

  const applyFormat = (patch) => {
    const target = selectedTarget || (activeCell ? { type: 'cell', ...activeCell } : null);
    if (!target) {
      setMessage('Select a cell, row, or column first.');
      return;
    }

    setActiveTable(previous => {
      if (!previous) return previous;

      if (target.type === 'all') {
        return {
          ...previous,
          columns: previous.columns.map(column => ({
            ...column,
            style: normalizeCellStyle({ ...(column.style || {}), ...patch })
          })),
          rows: previous.rows.map(row => ({
            ...row,
            cellStyles: {
              ...(row.cellStyles || {}),
              ...Object.fromEntries(previous.columns.map(column => [
                column.id,
                normalizeCellStyle({
                  ...(column.style || {}),
                  ...(row.cellStyles?.[column.id] || {}),
                  ...patch
                })
              ]))
            }
          }))
        };
      }

      if (target.type === 'column') {
        return {
          ...previous,
          columns: previous.columns.map(column => (
            column.id === target.columnId
              ? { ...column, style: normalizeCellStyle({ ...(column.style || {}), ...patch }) }
              : column
          )),
          rows: previous.rows.map(row => ({
            ...row,
            cellStyles: {
              ...(row.cellStyles || {}),
              [target.columnId]: normalizeCellStyle({
                ...(previous.columns.find(column => column.id === target.columnId)?.style || {}),
                ...(row.cellStyles?.[target.columnId] || {}),
                ...patch
              })
            }
          }))
        };
      }

      if (target.type === 'row') {
        return {
          ...previous,
          rows: previous.rows.map(row => {
            if (row.id !== target.rowId) return row;
            return {
              ...row,
              cellStyles: {
                ...(row.cellStyles || {}),
                ...Object.fromEntries(previous.columns.map(column => [
                  column.id,
                  normalizeCellStyle({
                    ...(column.style || {}),
                    ...(row.cellStyles?.[column.id] || {}),
                    ...patch
                  })
                ]))
              }
            };
          })
        };
      }

      return {
        ...previous,
        rows: previous.rows.map(row => {
          if (row.id !== target.rowId) return row;
          const column = previous.columns.find(item => item.id === target.columnId);
          return {
            ...row,
            cellStyles: {
              ...(row.cellStyles || {}),
              [target.columnId]: normalizeCellStyle({
                ...(column?.style || {}),
                ...(row.cellStyles?.[target.columnId] || {}),
                ...patch
              })
            }
          };
        })
      };
    });
    markDirty();
  };

  const clearSelectedCells = () => {
    const target = selectedTarget || (activeCell ? { type: 'cell', ...activeCell } : null);
    if (!target || !window.confirm('Clear selected cell values?')) return;

    setActiveTable(previous => {
      if (!previous) return previous;
      if (target.type === 'all') {
        return {
          ...previous,
          rows: previous.rows.map(row => ({
            ...row,
            cells: Object.fromEntries(previous.columns.map(column => [column.id, '']))
          }))
        };
      }
      if (target.type === 'column') {
        return {
          ...previous,
          rows: previous.rows.map(row => ({
            ...row,
            cells: { ...row.cells, [target.columnId]: '' }
          }))
        };
      }
      if (target.type === 'row') {
        return {
          ...previous,
          rows: previous.rows.map(row => (
            row.id === target.rowId
              ? { ...row, cells: Object.fromEntries(previous.columns.map(column => [column.id, ''])) }
              : row
          ))
        };
      }
      return {
        ...previous,
        rows: previous.rows.map(row => (
          row.id === target.rowId
            ? { ...row, cells: { ...row.cells, [target.columnId]: '' } }
            : row
        ))
      };
    });
    setContextMenu(null);
    markDirty();
  };

  const deleteSelected = () => {
    const target = selectedTarget || (activeCell ? { type: 'cell', ...activeCell } : null);
    if (!target) {
      setMessage('Select cells, a row, or a column first.');
      return;
    }
    if (target.type === 'row') deleteRow(target.rowId);
    else if (target.type === 'column') deleteColumn(target.columnId);
    else clearSelectedCells();
  };

  const openContextMenu = (event, target) => {
    event.preventDefault();
    setSelectedTarget(target);
    if (target.type === 'cell') setActiveCell({ rowId: target.rowId, columnId: target.columnId });
    else setActiveCell(null);
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  };

  const getSelectionLabel = () => {
    const target = selectedTarget || (activeCell ? { type: 'cell', ...activeCell } : null);
    if (!activeTable || !target) return 'No selection';
    if (target.type === 'all') return 'All cells';
    if (target.type === 'column') {
      return activeTable.columns.find(column => column.id === target.columnId)?.name || 'Column';
    }
    const rowIndex = activeTable.rows.findIndex(row => row.id === target.rowId);
    if (target.type === 'row') return rowIndex >= 0 ? `Row ${rowIndex + 1}` : 'Row';
    const column = activeTable.columns.find(item => item.id === target.columnId);
    return `${column?.name || 'Cell'} / Row ${rowIndex >= 0 ? rowIndex + 1 : ''}`;
  };

  const addRow = () => {
    setActiveTable(previous => previous ? { ...previous, rows: [...previous.rows, makeRow(previous.columns)] } : previous);
    markDirty();
  };

  const deleteRow = (rowId) => {
    if (!activeTable || activeTable.rows.length <= 1) return;
    const rowIndex = activeTable?.rows.findIndex(row => row.id === rowId);
    if (!window.confirm(`Delete row ${rowIndex >= 0 ? rowIndex + 1 : ''}?`)) return;
    setActiveTable(previous => {
      if (!previous || previous.rows.length <= 1) return previous;
      return { ...previous, rows: previous.rows.filter(row => row.id !== rowId) };
    });
    setSelectedTarget(null);
    setContextMenu(null);
    markDirty();
  };

  const addColumn = () => {
    setActiveTable(previous => {
      if (!previous) return previous;
      const nextColumn = makeColumn(previous.columns.length);
      return {
        ...previous,
        columns: [...previous.columns, nextColumn],
        rows: previous.rows.map(row => ({
          ...row,
          cells: { ...row.cells, [nextColumn.id]: '' }
        }))
      };
    });
    markDirty();
  };

  const deleteColumn = (columnId) => {
    if (!activeTable || activeTable.columns.length <= 1) return;
    const columnName = activeTable?.columns.find(column => column.id === columnId)?.name || 'column';
    if (!window.confirm(`Delete "${columnName}"?`)) return;
    setActiveTable(previous => {
      if (!previous || previous.columns.length <= 1) return previous;
      return {
        ...previous,
        columns: previous.columns.filter(column => column.id !== columnId),
        rows: previous.rows.map(row => {
          const cells = { ...row.cells };
          delete cells[columnId];
          return { ...row, cells };
        })
      };
    });
    setSelectedTarget(null);
    setContextMenu(null);
    markDirty();
  };

  const sortByColumn = (columnId) => {
    const nextDirection = sortState.columnId === columnId && sortState.direction === 'asc' ? 'desc' : 'asc';
    setSortState({ columnId, direction: nextDirection });
    setActiveTable(previous => {
      if (!previous) return previous;
      const sortedRows = [...previous.rows].sort((a, b) => {
        const left = String(a.cells[columnId] || '').toLowerCase();
        const right = String(b.cells[columnId] || '').toLowerCase();
        return nextDirection === 'asc' ? left.localeCompare(right) : right.localeCompare(left);
      });
      return { ...previous, rows: sortedRows };
    });
    markDirty();
  };

  const handleColumnResizeMouseDown = (event, columnId) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = activeTable.columns.find(c => c.id === columnId)?.width || 180;

    const handleMouseMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = Math.max(80, startWidth + deltaX);
      setActiveTable(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          columns: prev.columns.map(c => c.id === columnId ? { ...c, width: newWidth } : c)
        };
      });
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      markDirty();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleRowResizeMouseDown = (event, rowId) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = activeTable.rows.find(r => r.id === rowId)?.height || 40;

    const handleMouseMove = (moveEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const newHeight = Math.max(28, startHeight + deltaY);
      setActiveTable(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          rows: prev.rows.map(r => r.id === rowId ? { ...r, height: newHeight } : r)
        };
      });
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      markDirty();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleCellPaste = (event, rowId, columnId) => {
    const text = event.clipboardData?.getData('text');
    if (!text || (!text.includes('\t') && !text.includes('\n'))) return;

    event.preventDefault();
    const pastedRows = text.replace(/\r/g, '').split('\n');
    if (pastedRows[pastedRows.length - 1] === '') pastedRows.pop();
    const matrix = pastedRows.map(row => row.split('\t'));

    setActiveTable(previous => {
      if (!previous) return previous;
      let columns = [...previous.columns];
      const startRowIndex = Math.max(0, previous.rows.findIndex(row => row.id === rowId));
      const startColumnIndex = Math.max(0, previous.columns.findIndex(column => column.id === columnId));
      const neededColumns = startColumnIndex + Math.max(...matrix.map(row => row.length));

      while (columns.length < neededColumns) {
        columns = [...columns, makeColumn(columns.length)];
      }

      const rows = previous.rows.map(row => {
        const cells = { ...row.cells };
        const cellStyles = { ...(row.cellStyles || {}) };
        columns.forEach(column => {
          if (!Object.prototype.hasOwnProperty.call(cells, column.id)) cells[column.id] = '';
          if (!Object.prototype.hasOwnProperty.call(cellStyles, column.id) && column.style) {
            cellStyles[column.id] = normalizeCellStyle(column.style);
          }
        });
        return { ...row, height: row.height || 40, cells, cellStyles };
      });

      while (rows.length < startRowIndex + matrix.length) {
        rows.push(makeRow(columns));
      }

      matrix.forEach((sourceRow, rowOffset) => {
        const targetRow = rows[startRowIndex + rowOffset];
        sourceRow.forEach((value, columnOffset) => {
          const targetColumn = columns[startColumnIndex + columnOffset];
          targetRow.cells[targetColumn.id] = value;
        });
      });

      return { ...previous, columns, rows };
    });
    markDirty();
  };

  const focusCell = (rowId, columnId) => {
    window.setTimeout(() => {
      const input = document.querySelector(`input[data-row-id="${rowId}"][data-column-id="${columnId}"]`);
      if (!input) return;
      input.focus();
      input.select();
    }, 0);
  };

  const jumpToSearchMatch = (direction = 1) => {
    if (!searchMatches.length) return;
    const currentIndex = activeSearchMatch
      ? searchMatches.findIndex(match => match.key === activeSearchMatch.key)
      : -1;
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + direction + searchMatches.length) % searchMatches.length;
    const match = searchMatches[nextIndex];
    setActiveSearchMatch(match);
    setSelectedTarget({ type: 'cell', rowId: match.rowId, columnId: match.columnId });
    setActiveCell({ rowId: match.rowId, columnId: match.columnId });
    focusCell(match.rowId, match.columnId);
  };

  const moveCellFocus = (rowId, columnId, rowDelta, columnDelta, options = {}) => {
    if (!activeTable) return;
    const rowList = visibleRows.length ? visibleRows : activeTable.rows;
    if (!rowList.length || !activeTable.columns.length) return;

    const rowIndex = Math.max(0, rowList.findIndex(row => row.id === rowId));
    const columnIndex = Math.max(0, activeTable.columns.findIndex(column => column.id === columnId));
    let nextRowIndex = rowIndex + rowDelta;
    let nextColumnIndex = columnIndex + columnDelta;

    if (options.wrapColumns) {
      if (nextColumnIndex >= activeTable.columns.length) {
        nextColumnIndex = 0;
        nextRowIndex += 1;
      } else if (nextColumnIndex < 0) {
        nextColumnIndex = activeTable.columns.length - 1;
        nextRowIndex -= 1;
      }
    }

    const movedBeforeFirstRow = nextRowIndex < 0;
    const movedAfterLastRow = nextRowIndex >= rowList.length;
    nextRowIndex = Math.max(0, Math.min(rowList.length - 1, nextRowIndex));
    nextColumnIndex = Math.max(0, Math.min(activeTable.columns.length - 1, nextColumnIndex));
    if (movedBeforeFirstRow) nextColumnIndex = 0;
    if (movedAfterLastRow) nextColumnIndex = activeTable.columns.length - 1;

    const nextRow = rowList[nextRowIndex];
    const nextColumn = activeTable.columns[nextColumnIndex];
    setSelectedTarget({ type: 'cell', rowId: nextRow.id, columnId: nextColumn.id });
    setActiveCell({ rowId: nextRow.id, columnId: nextColumn.id });
    focusCell(nextRow.id, nextColumn.id);
  };

  const handleCellKeyDown = (event, rowId, columnId) => {
    if (event.nativeEvent?.isComposing) return;

    if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      moveCellFocus(rowId, columnId, event.shiftKey ? -1 : 1, 0);
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      moveCellFocus(rowId, columnId, 0, event.shiftKey ? -1 : 1, { wrapColumns: true });
    }
  };

  const isEditableElement = (element) => {
    if (!element) return false;
    const tagName = element.tagName?.toLowerCase();
    return tagName === 'input' || tagName === 'textarea' || element.isContentEditable;
  };

  useEffect(() => {
    if (!activeTable) return undefined;

    const handleShortcut = (event) => {
      if (event.defaultPrevented) return;

      const key = event.key.toLowerCase();
      const usesShortcutModifier = event.ctrlKey || event.metaKey;
      const eventTarget = event.target;
      const isCellInput = eventTarget?.dataset?.sheetCell === 'true';
      const isEditable = isEditableElement(eventTarget);
      const shouldUseGridShortcut = !isEditable || isCellInput;

      if (usesShortcutModifier && key === 's') {
        event.preventDefault();
        if (!isSaving) saveTable();
        return;
      }

      if (usesShortcutModifier && key === 'f') {
        event.preventDefault();
        filterInputRef.current?.focus();
        filterInputRef.current?.select();
        return;
      }

      if (usesShortcutModifier && key === 'a' && shouldUseGridShortcut) {
        event.preventDefault();
        if (isCellInput) eventTarget.blur?.();
        setSelectedTarget({ type: 'all' });
        setActiveCell(null);
        setContextMenu(null);
        return;
      }

      if (usesShortcutModifier && key === 'b' && shouldUseGridShortcut) {
        event.preventDefault();
        applyFormat({ bold: !getSelectedStyle().bold });
        return;
      }

      if (usesShortcutModifier && key === 'i' && shouldUseGridShortcut) {
        event.preventDefault();
        applyFormat({ italic: !getSelectedStyle().italic });
        return;
      }

      if (!usesShortcutModifier && (event.key === 'Delete' || event.key === 'Backspace')) {
        const selectedKind = selectedTarget?.type || (activeCell ? 'cell' : null);
        const shouldLetTextFieldEdit = isEditable && (!isCellInput || selectedKind === 'cell');
        if (selectedKind && !shouldLetTextFieldEdit) {
          event.preventDefault();
          clearSelectedCells();
        }
        return;
      }

      if (event.key === 'Escape') {
        setContextMenu(null);
        setSelectedTarget(null);
        setActiveCell(null);
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [activeTable, activeCell, selectedTarget, isSaving, visibleRows]);

  useEffect(() => {
    if (!activeTable || !activeFileName) return undefined;
    const timer = window.setTimeout(() => {
      writeLocalRecovery(activeTable, activeFileName);
    }, LOCAL_RECOVERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [activeTable, activeFileName]);

  const selectedStyle = getSelectedStyle();
  const activeSearchMatchIndex = activeSearchMatch
    ? searchMatches.findIndex(match => match.key === activeSearchMatch.key)
    : -1;

  if (activeTable) {
    return (
      <div style={{ height: '100%', padding: '24px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '16px', overflow: 'hidden' }}>
        
        {/* Editor Toolbar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', minWidth: 0 }}>
            <button className="btn btn-secondary" onClick={closeActiveTable} style={{ display: 'flex', alignItems: 'center', gap: '6px', height: '38px', padding: '0 14px' }}>
              <span>←</span> Back
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <input
                  className="input-control"
                  value={activeTable.tableName}
                  onChange={event => updateTableName(event.target.value)}
                  style={{
                    height: '38px',
                    width: 'min(360px, 35vw)',
                    padding: '8px 12px 8px 32px',
                    fontWeight: 700,
                    fontSize: '15px',
                    color: 'var(--accent-secondary)',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    background: 'rgba(0, 0, 0, 0.2)'
                  }}
                />
                <span style={{ position: 'absolute', left: '10px', fontSize: '14px', opacity: 0.65 }}>📝</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span className="badge badge-success" style={{ fontSize: '9.5px', padding: '2px 6px', width: 'fit-content' }}>
                  {activeTable.rows.length} rows × {activeTable.columns.length} columns
                </span>
                {localRecovery.status !== 'idle' && (
                  <span
                    className={localRecovery.status === 'error' ? 'badge badge-danger' : 'badge badge-success'}
                    title={localRecovery.error || localRecovery.filePath || 'Local CSV recovery copy'}
                    style={{ fontSize: '9.5px', padding: '2px 6px', width: 'fit-content' }}
                  >
                    {localRecovery.status === 'saving' ? 'CSV saving' : localRecovery.status === 'error' ? 'CSV error' : 'CSV local'}
                  </span>
                )}
                {dirty && (
                  <span style={{ color: 'var(--accent-warning)', fontSize: '10.5px', fontWeight: 600, marginLeft: '4px' }}>
                    ● Unsaved Changes
                  </span>
                )}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button className="btn btn-secondary" onClick={addRow} disabled={isSaving} style={{ height: '38px', padding: '0 14px', fontSize: '13px' }}>
              ➕ Row
            </button>
            <button className="btn btn-secondary" onClick={addColumn} disabled={isSaving} style={{ height: '38px', padding: '0 14px', fontSize: '13px' }}>
              ➕ Column
            </button>
            <button className="btn btn-secondary" onClick={openLocalRecoveryFolder} disabled={isSaving} style={{ height: '38px', padding: '0 14px', fontSize: '13px' }} title={localRecovery.filePath || 'Open local CSV recovery folder'}>
              CSV Folder
            </button>
            <button className="btn btn-danger" onClick={deleteActiveTable} disabled={isSaving || isLoading} style={{ height: '38px', padding: '0 14px', fontSize: '13px' }}>
              🗑️ Delete
            </button>
            <button className="btn btn-primary" onClick={saveTable} disabled={isSaving} style={{ height: '38px', padding: '0 16px', fontSize: '13px' }} title="Save (Ctrl+S)">
              {isSaving ? 'Saving...' : '💾 Save'}
            </button>
          </div>
        </div>

        <section style={{ border: '1px solid var(--border-color)', borderRadius: '10px', padding: '8px 12px', background: 'rgba(255,255,255,0.025)', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: '12px', fontWeight: 700, minWidth: '118px' }}>
            {getSelectionLabel()}
          </span>

          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', borderLeft: '1px solid var(--border-color)', paddingLeft: '10px' }}>
            {[
              ['left', 'Left'],
              ['center', 'Center'],
              ['right', 'Right']
            ].map(([align, label]) => (
              <button
                key={align}
                className={selectedStyle.align === align ? 'btn btn-primary' : 'btn btn-secondary'}
                style={{ height: '30px', minWidth: '62px', padding: '0 9px', fontSize: '12px' }}
                onClick={() => applyFormat({ align })}
              >
                {label}
              </button>
            ))}
          </div>

          <select
            className="input-control"
            value={selectedStyle.fontSize}
            onChange={event => applyFormat({ fontSize: Number(event.target.value) })}
            style={{ height: '30px', width: '82px', padding: '4px 8px', fontSize: '12px' }}
            title="Font size"
          >
            {FONT_SIZES.map(size => (
              <option key={size} value={size}>{size}px</option>
            ))}
          </select>

          <button
            className={selectedStyle.bold ? 'btn btn-primary' : 'btn btn-secondary'}
            style={{ height: '30px', width: '34px', padding: 0, fontSize: '13px', fontWeight: 900 }}
            onClick={() => applyFormat({ bold: !selectedStyle.bold })}
            title="Bold (Ctrl+B)"
          >
            B
          </button>
          <button
            className={selectedStyle.italic ? 'btn btn-primary' : 'btn btn-secondary'}
            style={{ height: '30px', width: '34px', padding: 0, fontSize: '13px', fontStyle: 'italic', fontWeight: 800 }}
            onClick={() => applyFormat({ italic: !selectedStyle.italic })}
            title="Italic (Ctrl+I)"
          >
            I
          </button>

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, textTransform: 'none', letterSpacing: 0 }}>
            Text
            <input
              type="color"
              value={selectedStyle.color}
              onChange={event => applyFormat({ color: event.target.value })}
              style={{ width: '34px', height: '30px', padding: 0, border: '1px solid var(--border-color)', background: 'transparent', borderRadius: '6px' }}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, textTransform: 'none', letterSpacing: 0 }}>
            Fill
            <input
              type="color"
              value={selectedStyle.background || '#091413'}
              onChange={event => applyFormat({ background: event.target.value })}
              style={{ width: '34px', height: '30px', padding: 0, border: '1px solid var(--border-color)', background: 'transparent', borderRadius: '6px' }}
            />
          </label>

          <button className="btn btn-secondary" style={{ height: '30px', padding: '0 10px', fontSize: '12px' }} onClick={() => applyFormat({ background: '' })}>
            No Fill
          </button>
          <button className="btn btn-secondary" style={{ height: '30px', padding: '0 10px', fontSize: '12px' }} onClick={clearSelectedCells}>
            Clear
          </button>
          <button className="btn btn-danger" style={{ height: '30px', padding: '0 10px', fontSize: '12px' }} onClick={deleteSelected}>
            Delete Selected
          </button>
        </section>

        {/* Search Bar & Feedback Row */}
        <section style={{ border: '1px solid var(--border-color)', borderRadius: '10px', padding: '8px 16px', background: 'var(--bg-panel)', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              className="input-control"
              ref={filterInputRef}
              value={filterText}
              onChange={event => setFilterText(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  jumpToSearchMatch(event.shiftKey ? -1 : 1);
                }
              }}
              placeholder="Search cells..."
              title="Search cells (Ctrl+F, Enter for next match)"
              style={{ height: '32px', width: '240px', padding: '6px 10px 6px 28px', fontSize: '12.5px', borderRadius: '6px' }}
            />
            <span style={{ position: 'absolute', left: '8px', fontSize: '12px', opacity: 0.5 }}>🔍</span>
          </div>
          <span style={{ color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 500 }}>
            {searchQuery
              ? `${searchMatches.length} match${searchMatches.length === 1 ? '' : 'es'} in ${visibleRows.length} of ${activeTable.rows.length} rows`
              : `${visibleRows.length} of ${activeTable.rows.length} rows visible`}
          </span>
          {searchQuery && searchMatches.length > 0 && (
            <span className="badge badge-success" style={{ fontSize: '11px' }}>
              {Math.max(1, activeSearchMatchIndex + 1)} of {searchMatches.length}
            </span>
          )}
          {searchQuery && (
            <>
              <button className="btn btn-secondary" onClick={() => jumpToSearchMatch(-1)} disabled={!searchMatches.length} style={{ height: '30px', padding: '0 10px', fontSize: '12px' }}>
                Prev
              </button>
              <button className="btn btn-secondary" onClick={() => jumpToSearchMatch(1)} disabled={!searchMatches.length} style={{ height: '30px', padding: '0 10px', fontSize: '12px' }}>
                Next
              </button>
            </>
          )}
          {sortState.columnId && (
            <span className="badge badge-warning" style={{ fontSize: '11px' }}>
              Sorted {sortState.direction === 'asc' ? 'A-Z' : 'Z-A'}
            </span>
          )}
        </section>

        {(message || error) && (
          <div style={{
            padding: '10px 14px',
            borderRadius: '8px',
            border: `1px solid ${error ? 'rgba(239,68,68,0.25)' : 'rgba(34,197,94,0.22)'}`,
            color: error ? '#fca5a5' : '#86efac',
            background: error ? 'rgba(239,68,68,0.06)' : 'rgba(34,197,94,0.06)',
            fontSize: '13px',
            fontWeight: 500
          }}>
            {error || message}
          </div>
        )}

        {/* Table Workspace */}
        <div style={{ overflow: 'auto', flex: 1, border: '1px solid var(--border-color)', borderRadius: '10px', background: 'rgba(0,0,0,0.18)', position: 'relative' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: 'max-content', minWidth: '100%' }}>
            <thead>
              <tr>
                {/* Index Corner cell */}
                <th
                  onClick={() => {
                    setSelectedTarget({ type: 'all' });
                    setActiveCell(null);
                    setContextMenu(null);
                  }}
                  onContextMenu={event => openContextMenu(event, { type: 'all' })}
                  title="Select all cells (Ctrl+A)"
                  style={{
                    position: 'sticky',
                    top: 0,
                    left: 0,
                    zIndex: 3,
                    width: '58px',
                    minWidth: '58px',
                    background: selectedTarget?.type === 'all' ? 'rgba(64, 138, 113, 0.28)' : 'var(--bg-main)',
                    borderRight: '1px solid var(--border-color)',
                    borderBottom: '1px solid var(--border-color)',
                    height: '42px',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    fontSize: '10px',
                    fontWeight: 800
                  }}
                >
                  ALL
                </th>
                
                {/* Column Headers */}
                {activeTable.columns.map(column => (
                  <th
                    key={column.id}
                    onClick={() => setSelectedTarget({ type: 'column', columnId: column.id })}
                    onContextMenu={event => openContextMenu(event, { type: 'column', columnId: column.id })}
                    style={{
                      position: 'sticky',
                      top: 0,
                      zIndex: 2,
                      width: `${column.width || 180}px`,
                      minWidth: `${column.width || 180}px`,
                      background: selectedTarget?.type === 'all' || (selectedTarget?.type === 'column' && selectedTarget.columnId === column.id) ? 'rgba(64, 138, 113, 0.24)' : 'var(--bg-main)',
                      borderRight: '1px solid var(--border-color)',
                      borderBottom: '1px solid var(--border-color)',
                      padding: '0 8px',
                      height: '42px'
                    }}
                  >
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', height: '100%', position: 'relative' }}>
                      <input
                        value={column.name}
                        onChange={event => updateColumnName(column.id, event.target.value)}
                        onFocus={(e) => {
                          setSelectedTarget({ type: 'column', columnId: column.id });
                          e.target.style.background = 'rgba(255,255,255,0.05)';
                        }}
                        style={{
                          width: 'calc(100% - 62px)',
                          minWidth: 0,
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--accent-secondary)',
                          fontWeight: 700,
                          outline: 'none',
                          fontSize: '13px',
                          padding: '6px 4px',
                          borderRadius: '4px',
                          transition: 'background 0.2s'
                        }}
                        onBlur={(e) => { e.target.style.background = 'transparent'; }}
                      />
                      <button className="btn btn-secondary" style={{ padding: '3px 6px', fontSize: '9.5px', height: '24px', opacity: 0.8 }} onClick={(event) => { event.stopPropagation(); sortByColumn(column.id); }} title="Sort Column">
                        {sortState.columnId === column.id && sortState.direction === 'desc' ? '▼ Z-A' : '▲ A-Z'}
                      </button>

                      {/* Column Resize Handle */}
                      <div
                        onMouseDown={e => handleColumnResizeMouseDown(e, column.id)}
                        onMouseEnter={() => setHoveredColResize(column.id)}
                        onMouseLeave={() => setHoveredColResize(null)}
                        style={{
                          position: 'absolute',
                          right: 0,
                          top: 0,
                          bottom: 0,
                          width: '6px',
                          cursor: 'col-resize',
                          zIndex: 10,
                          background: hoveredColResize === column.id ? 'var(--accent-primary)' : 'transparent',
                          transition: 'background 0.2s'
                        }}
                      />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, visibleIndex) => (
                <tr key={row.id} style={{ height: `${row.height || 40}px` }}>
                  
                  {/* Row Index Label */}
                  <td style={{
                    position: 'sticky',
                    left: 0,
                    zIndex: 1,
                    width: '58px',
                    minWidth: '58px',
                    height: '100%',
                    background: selectedTarget?.type === 'all' || (selectedTarget?.type === 'row' && selectedTarget.rowId === row.id) ? 'rgba(64, 138, 113, 0.24)' : 'var(--bg-main)',
                    borderRight: '1px solid var(--border-color)',
                    borderBottom: '1px solid rgba(255,255,255,0.045)',
                    padding: 0,
                    textAlign: 'center',
                    position: 'relative'
                  }}
                    onContextMenu={event => openContextMenu(event, { type: 'row', rowId: row.id })}
                    onClick={() => setSelectedTarget({ type: 'row', rowId: row.id })}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%', position: 'relative' }}>
                      <button
                        className="btn btn-secondary"
                        style={{
                          width: 'calc(100% - 10px)',
                          height: 'calc(100% - 10px)',
                          padding: 0,
                          fontSize: '11.5px',
                          color: 'var(--text-muted)',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedTarget({ type: 'row', rowId: row.id });
                        }}
                        title="Select row"
                      >
                        {visibleIndex + 1}
                      </button>

                      {/* Row Resize Handle */}
                      <div
                        onMouseDown={e => handleRowResizeMouseDown(e, row.id)}
                        onMouseEnter={() => setHoveredRowResize(row.id)}
                        onMouseLeave={() => setHoveredRowResize(null)}
                        style={{
                          position: 'absolute',
                          left: 0,
                          right: 0,
                          bottom: 0,
                          height: '6px',
                          cursor: 'row-resize',
                          zIndex: 10,
                          background: hoveredRowResize === row.id ? 'var(--accent-primary)' : 'transparent',
                          transition: 'background 0.2s'
                        }}
                      />
                    </div>
                  </td>

                  {/* Data Cells */}
                  {activeTable.columns.map(column => {
                    const cellStyle = getCellStyle(row, column);
                    const isCellSelected = selectedTarget?.type === 'cell' && selectedTarget.rowId === row.id && selectedTarget.columnId === column.id;
                    const isAllSelected = selectedTarget?.type === 'all';
                    const isRowSelected = selectedTarget?.type === 'row' && selectedTarget.rowId === row.id;
                    const isColumnSelected = selectedTarget?.type === 'column' && selectedTarget.columnId === column.id;
                    const isCellActive = isCellSelected || (activeCell?.rowId === row.id && activeCell?.columnId === column.id);
                    const isSearchMatch = searchMatchKeys.has(`${row.id}:${column.id}`);
                    const isCurrentSearchMatch = activeSearchMatch?.rowId === row.id && activeSearchMatch?.columnId === column.id;
                    return (
                      <td
                        key={`${row.id}:${column.id}`}
                        onContextMenu={event => openContextMenu(event, { type: 'cell', rowId: row.id, columnId: column.id })}
                        style={{
                          width: `${column.width || 180}px`,
                          minWidth: `${column.width || 180}px`,
                          borderRight: '1px solid rgba(255,255,255,0.045)',
                          borderBottom: '1px solid rgba(255,255,255,0.045)',
                          background: isCurrentSearchMatch
                            ? 'rgba(250, 204, 21, 0.34)'
                            : (isCellActive
                              ? 'rgba(64, 138, 113, 0.14)'
                              : (isSearchMatch
                                ? 'rgba(250, 204, 21, 0.2)'
                                : (isAllSelected ? 'rgba(64, 138, 113, 0.09)' : (cellStyle.background || (isRowSelected || isColumnSelected ? 'rgba(64, 138, 113, 0.07)' : 'transparent'))))),
                          boxShadow: isCurrentSearchMatch
                            ? 'inset 0 0 0 2px #facc15'
                            : (isCellActive
                              ? 'inset 0 0 0 1px var(--accent-primary)'
                              : (isSearchMatch
                                ? 'inset 0 0 0 1px rgba(250, 204, 21, 0.45)'
                                : (isAllSelected ? 'inset 0 0 0 1px rgba(64, 138, 113, 0.22)' : 'none'))),
                          transition: 'background-color 0.15s, box-shadow 0.15s',
                          padding: 0
                        }}
                      >
                        <input
                          type="text"
                          data-sheet-cell="true"
                          data-row-id={row.id}
                          data-column-id={column.id}
                          value={row.cells[column.id] || ''}
                          onChange={event => updateCell(row.id, column.id, event.target.value)}
                          onPaste={event => handleCellPaste(event, row.id, column.id)}
                          onKeyDown={event => handleCellKeyDown(event, row.id, column.id)}
                          onFocus={() => {
                            setActiveCell({ rowId: row.id, columnId: column.id });
                            setSelectedTarget({ type: 'cell', rowId: row.id, columnId: column.id });
                          }}
                          onBlur={() => setActiveCell(null)}
                          style={{
                            width: '100%',
                            height: '100%',
                            border: 'none',
                            background: 'transparent',
                            color: cellStyle.color || 'var(--text-primary)',
                            padding: '8px 12px',
                            outline: 'none',
                            fontSize: `${cellStyle.fontSize || 13}px`,
                            fontFamily: 'inherit',
                            fontWeight: cellStyle.bold ? 800 : 400,
                            fontStyle: cellStyle.italic ? 'italic' : 'normal',
                            textAlign: cellStyle.align || 'left'
                          }}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          {visibleRows.length === 0 && (
            <div style={{ color: 'var(--text-muted)', padding: '48px', textAlign: 'center', fontSize: '14px', fontWeight: 500 }}>
              🔍 No matching records found.
            </div>
          )}
        </div>

        {contextMenu && (
          <div
            onClick={event => event.stopPropagation()}
            style={{
              position: 'fixed',
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`,
              zIndex: 500,
              minWidth: '190px',
              padding: '8px',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              background: 'var(--bg-main)',
              boxShadow: '0 20px 50px rgba(0,0,0,0.4)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}
          >
            <div style={{ padding: '4px 6px 8px', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 800, borderBottom: '1px solid var(--border-color)' }}>
              {getSelectionLabel()}
            </div>
            <button className="btn btn-secondary" style={{ justifyContent: 'flex-start', padding: '7px 9px', fontSize: '12px' }} onClick={clearSelectedCells}>
              Clear values
            </button>
            {contextMenu.target.type === 'row' && (
              <button className="btn btn-danger" style={{ justifyContent: 'flex-start', padding: '7px 9px', fontSize: '12px' }} onClick={() => deleteRow(contextMenu.target.rowId)}>
                Delete row
              </button>
            )}
            {contextMenu.target.type === 'column' && (
              <button className="btn btn-danger" style={{ justifyContent: 'flex-start', padding: '7px 9px', fontSize: '12px' }} onClick={() => deleteColumn(contextMenu.target.columnId)}>
                Delete column
              </button>
            )}
            <button className="btn btn-secondary" style={{ justifyContent: 'flex-start', padding: '7px 9px', fontSize: '12px' }} onClick={() => applyFormat({ ...DEFAULT_CELL_STYLE })}>
              Reset format
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ height: '100%', padding: '24px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '20px', overflow: 'hidden' }}>
      
      {/* List View Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '26px', fontWeight: 700, letterSpacing: '-0.5px' }}>Encrypted Tables</h1>
          <div style={{ marginTop: '4px', color: 'var(--text-secondary)', fontSize: '13.5px', fontWeight: 500 }}>
            📊 {tables.length} secured file{tables.length === 1 ? '' : 's'} synced on device
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              className="input-control"
              value={tablesSearch}
              onChange={event => setTablesSearch(event.target.value)}
              placeholder="Search tables..."
              style={{ height: '38px', width: '220px', padding: '8px 12px 8px 30px', fontSize: '13px', borderRadius: '8px' }}
            />
            <span style={{ position: 'absolute', left: '10px', fontSize: '13px', opacity: 0.55 }}>🔍</span>
          </div>
          <button className="btn btn-primary" onClick={createTable} style={{ height: '38px', padding: '0 16px' }}>
            New Table
          </button>
        </div>
      </div>

      {(message || error) && (
        <div style={{
          padding: '10px 14px',
          borderRadius: '8px',
          border: `1px solid ${error ? 'rgba(239,68,68,0.25)' : 'rgba(34,197,94,0.22)'}`,
          color: error ? '#fca5a5' : '#86efac',
          background: error ? 'rgba(239,68,68,0.06)' : 'rgba(34,197,94,0.06)',
          fontSize: '13px',
          fontWeight: 500
        }}>
          {error || message}
        </div>
      )}

      {/* Tables Grid */}
      <div style={{ overflow: 'auto', minHeight: 0, flex: 1 }}>
        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}>
            <div className="tree-spinner" style={{ width: '28px', height: '28px', borderWidth: '3px' }} />
          </div>
        ) : filteredTables.length === 0 ? (
          <div style={{
            textAlign: 'center',
            padding: '80px 40px',
            background: 'var(--bg-panel)',
            border: '1px dashed var(--border-color)',
            borderRadius: '12px',
            color: 'var(--text-muted)'
          }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>📊</div>
            <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>No Tables Found</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {tablesSearch ? 'No tables match your current filter search.' : 'Create an encrypted table to store structured secure data.'}
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '16px', padding: '4px' }}>
            {filteredTables.map(table => {
              const isHovered = hoveredCard === table.Name;
              return (
                <div
                  key={table.Name}
                  onMouseEnter={() => setHoveredCard(table.Name)}
                  onMouseLeave={() => setHoveredCard(null)}
                  onClick={() => openTable(table.Name)}
                  style={{
                    textAlign: 'left',
                    background: isHovered ? 'var(--bg-panel-hover)' : 'var(--bg-panel)',
                    padding: '20px',
                    borderRadius: '12px',
                    cursor: 'pointer',
                    border: isHovered ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)',
                    color: 'var(--text-primary)',
                    boxShadow: isHovered ? '0 8px 24px rgba(64, 138, 113, 0.15)' : 'none',
                    transform: isHovered ? 'translateY(-2px)' : 'translateY(0)',
                    transition: 'all 0.2s ease-in-out',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    height: '110px'
                  }}
                >
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <span style={{
                      fontSize: '20px',
                      background: 'rgba(255,255,255,0.04)',
                      padding: '6px',
                      borderRadius: '8px',
                      display: 'inline-flex'
                    }}>📊</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: '14.5px', color: 'var(--text-primary)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {stripExtension(table.Name)}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        Modified: {formatDate(table.ModTime)}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', fontSize: '11.5px', color: 'var(--accent-secondary)', fontWeight: 600 }}>
                    Secure Sheet
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* New Table Modal */}
      {showNewModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ padding: '24px', width: '360px', margin: 0, boxShadow: '0 24px 64px rgba(0,0,0,0.5)', background: 'var(--bg-main)' }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '19px', fontWeight: 700, color: 'var(--text-primary)' }}>New Encrypted Table</h3>
            
            <div className="form-group" style={{ marginBottom: '20px' }}>
              <label>Table File Name</label>
              <input
                autoFocus
                className="input-control"
                type="text"
                value={newName}
                onChange={event => setNewName(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && confirmCreateTable()}
                style={{ width: '100%', height: '38px', padding: '8px 12px', marginTop: '6px' }}
                placeholder="e.g. Project Budget"
              />
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowNewModal(false)} style={{ height: '36px', padding: '0 14px' }}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmCreateTable} style={{ height: '36px', padding: '0 16px' }}>Create Table</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
