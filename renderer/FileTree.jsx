import React, { useState, useEffect, useCallback, useRef } from 'react';
const ipcRenderer = window.electron.ipcRenderer;

// ─── Utility ───────────────────────────────────────────────────────────────

/**
 * Given a node path and a set of explicitly watched paths, determine its state:
 * - 'watched'   → this exact path is being backed up
 * - 'inherited' → an ancestor is being backed up (this is implicitly covered)
 * - 'none'      → not backed up at all
 */
function getWatchState(nodePath, watchedPaths, excludedPaths = new Set()) {
  const norm = nodePath.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');

  if (excludedPaths.has(norm)) return 'excluded';

  // Check if any ancestor is explicitly excluded
  for (const ex of excludedPaths) {
    if (norm.startsWith(ex + '/')) return 'excluded';
  }

  for (const w of watchedPaths) {
    const wNorm = w.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
    if (wNorm === norm) return 'watched';
    if (norm.startsWith(wNorm + '/')) return 'inherited';
  }
  return 'none';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

// ─── Single tree row ────────────────────────────────────────────────────────

function TreeNode({ node, depth, watchedPaths, excludedPaths, onAdd, onRemove, onExclude, onInclude }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState(null); // null = not loaded yet
  const [loading, setLoading] = useState(false);

  const watchState = getWatchState(node.path, watchedPaths, excludedPaths);
  // Determine if the node could have children
  const couldHaveChildren = node.isDrive || (node.isDir && node.hasChildren !== false);

  const handleExpand = useCallback(async (e) => {
    e.stopPropagation();
    if (!couldHaveChildren) return;

    if (!expanded) {
      setLoading(true);
      let result = null;
    try {
      result = await ipcRenderer.invoke('filesystem:listDir', { dirPath: node.path });
    } catch(e) {
      console.error(e);
      return;
    }
      setChildren(result.items || []);
      setLoading(false);
    }
    setExpanded(prev => !prev);
  }, [expanded, node.path, couldHaveChildren]);

  const handleToggle = useCallback((e) => {
    e.stopPropagation();
    if (watchState === 'inherited') {
      // Exclude this subfolder or file
      onExclude(node.path);
    } else if (watchState === 'excluded') {
      // Re-include this subfolder or file
      onInclude(node.path);
    } else if (watchState === 'watched') {
      onRemove(node.path);
    } else {
      onAdd(node.path, node);
    }
  }, [watchState, node.path, onAdd, onRemove, onExclude, onInclude]);

  const driveUsedPct = node.isDrive && node.size > 0
    ? Math.round((node.used / node.size) * 100)
    : null;

  return (
    <div>
      {/* ── Row ── */}
      <div
        className={`tree-node depth-${depth} ${watchState}`}
        style={{ paddingLeft: `${depth * 22 + 10}px` }}
      >
        {/* Expand chevron */}
        <button
          className="tree-chevron"
          onClick={handleExpand}
          disabled={!couldHaveChildren}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {!couldHaveChildren ? '' : loading ? (
            <span className="tree-spinner" />
          ) : expanded ? '▾' : '▸'}
        </button>

        {/* Icon */}
        <span className="tree-icon" onClick={handleExpand}>
          {node.icon ? node.icon : node.isDrive ? '💾' : !node.isDir ? '📄' : watchState === 'watched' ? '📂' : '📁'}
        </span>

        {/* Name + optional drive bar */}
        <span className="tree-name-col" onClick={handleExpand}>
          <span className={`tree-name ${watchState === 'watched' ? 'watched-text' : ''}`}>
            {node.name}
          </span>
          {node.isDrive && node.size > 0 && (
            <span className="drive-bar-wrap">
              <span className="drive-bar-track">
                <span
                  className="drive-bar-fill"
                  style={{ width: `${driveUsedPct}%` }}
                />
              </span>
              <span className="drive-bar-label">
                {formatBytes(node.used)} / {formatBytes(node.size)}
              </span>
            </span>
          )}
        </span>

        {/* State badge */}
        {watchState === 'inherited' && (
          <span className="tree-badge inherited" title="Covered by a parent folder">
            ✓ Included
          </span>
        )}
        {watchState === 'watched' && (
          <span className="tree-badge watched" title="This folder is being backed up">
            ✓ Backing up
          </span>
        )}
        {watchState === 'excluded' && (
          <span className="tree-badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171' }} title="Excluded from backups">
            ✗ Excluded
          </span>
        )}

        {/* Toggle */}
        {/* Files can be selected directly; a standalone file backup watches only
            that file instead of implicitly adding every sibling. */}
        {(() => {
          const normNode = node.path.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
          const isExplicitlyExcluded = excludedPaths.has(normNode);
          const isImplicitlyExcluded = watchState === 'excluded' && !isExplicitlyExcluded;
          
          return (
            <label
              className={`toggle-switch tree-toggle ${isImplicitlyExcluded ? 'toggle-disabled' : ''}`}
              title={
                isImplicitlyExcluded
                  ? 'Re-enable the parent excluded folder to back up this directory'
                  : watchState === 'watched'
                  ? `Click to stop backing up this ${node.isDir ? 'folder' : 'file'}`
                  : watchState === 'inherited'
                  ? 'Click to exclude this from backups'
                  : watchState === 'excluded'
                  ? 'Click to re-include this in backups'
                  : `Click to back up only this ${node.isDir ? 'folder' : 'file'}`
              }
            >
              <input
                type="checkbox"
                checked={watchState === 'watched' || watchState === 'inherited'}
                disabled={isImplicitlyExcluded}
                onChange={handleToggle}
              />
              <span className="slider" />
            </label>
          );
        })()}
      </div>

      {/* ── Children ── */}
      {expanded && (
        <div className="tree-children">
          {children && children.length === 0 && (
            <div className="tree-empty" style={{ paddingLeft: `${(depth + 1) * 22 + 36}px` }}>
              No subfolders
            </div>
          )}
          {children && children.map(child => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              watchedPaths={watchedPaths}
              excludedPaths={excludedPaths}
              onAdd={onAdd}
              onRemove={onRemove}
              onExclude={onExclude}
              onInclude={onInclude}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Root component ─────────────────────────────────────────────────────────

export default function FileTree({ watchedPaths, excludedPaths, onAdd, onRemove, onExclude, onInclude }) {
  const [drives, setDrives] = useState([]);
  const [loadingDrives, setLoadingDrives] = useState(true);

  useEffect(() => {
    setLoadingDrives(true);
    ipcRenderer.invoke('filesystem:listDrives').then(result => {
      setDrives(result || []);
      setLoadingDrives(false);
    }).catch(() => setLoadingDrives(false));
  }, []);

  if (loadingDrives) {
    return (
      <div className="file-tree file-tree-loading">
        <span className="tree-spinner" /> Scanning drives...
      </div>
    );
  }

  return (
    <div className="file-tree">
      {drives.map(drive => (
        <TreeNode
          key={drive.path}
          node={drive}
          depth={0}
          watchedPaths={watchedPaths}
          excludedPaths={excludedPaths}
          onAdd={onAdd}
          onRemove={onRemove}
          onExclude={onExclude}
          onInclude={onInclude}
        />
      ))}
    </div>
  );
}
