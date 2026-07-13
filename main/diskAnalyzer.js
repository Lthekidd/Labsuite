const fs = require('fs');
const path = require('path');
const { SKIP_TREE_WINDOWS } = require('./filesystem');

let activeScanCancelled = false;
let isScanRunning = false;

function cancelDiskScan() {
  if (isScanRunning) {
    activeScanCancelled = true;
    console.log('LabSuite: Disk space scan cancellation requested.');
  }
}

/**
 * Recursively scans a path for size calculations.
 * Yields periodically to the event loop so as not to block Electron.
 */
async function startDiskScan(rootPath, onProgress) {
  if (isScanRunning) {
    throw new Error('A disk space scan is already running.');
  }

  isScanRunning = false;
  activeScanCancelled = false;
  isScanRunning = true;

  try {
    const resolvedRoot = path.resolve(rootPath);
    const rootNode = {
      name: path.basename(resolvedRoot) || resolvedRoot,
      path: resolvedRoot,
      size: 0,
      isDir: true,
      children: []
    };

    const extBreakdown = {};
    const folderNodes = new Map([[resolvedRoot, rootNode]]);
    const traversalStack = [resolvedRoot];
    const visitedFolders = []; // Bottom-up calculation order

    let scannedFiles = 0;
    let scannedFolders = 0;
    let totalSize = 0;
    let lastProgressTime = Date.now();
    let yieldCounter = 0;

    // Phase 1: Traversal & File size aggregation
    while (traversalStack.length > 0) {
      if (activeScanCancelled) {
        throw new Error('Scan cancelled by user.');
      }

      const currentPath = traversalStack.pop();
      visitedFolders.push(currentPath);
      scannedFolders++;

      // Yield to event loop periodically to prevent UI thread lock
      yieldCounter++;
      if (yieldCounter % 150 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }

      // Periodically update progress
      if (Date.now() - lastProgressTime > 150) {
        onProgress({
          scannedFiles,
          scannedFolders,
          totalSize,
          currentPath,
          done: false
        });
        lastProgressTime = Date.now();
      }

      let entries = [];
      try {
        entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
      } catch (err) {
        // Skip folders that can't be read (permissions, locked system folders)
        continue;
      }

      const currentFolderNode = folderNodes.get(currentPath);
      if (!currentFolderNode) continue;

      for (const entry of entries) {
        if (activeScanCancelled) {
          throw new Error('Scan cancelled by user.');
        }

        const entryPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          // Check Windows system path exclusions
          if (process.platform === 'win32' && SKIP_TREE_WINDOWS.has(entry.name)) {
            continue;
          }

          const childFolderNode = {
            name: entry.name,
            path: entryPath,
            size: 0,
            isDir: true,
            children: []
          };

          folderNodes.set(entryPath, childFolderNode);
          currentFolderNode.children.push(childFolderNode);
          traversalStack.push(entryPath);
        } else {
          // It's a file, get size
          let fileSize = 0;
          try {
            const stat = await fs.promises.stat(entryPath);
            fileSize = stat.size;
          } catch (_) {
            // Use 0 size if file is locked/inaccessible
          }

          scannedFiles++;
          totalSize += fileSize;
          currentFolderNode.size += fileSize;

          // Track extension
          const ext = path.extname(entry.name).toLowerCase() || 'no extension';
          extBreakdown[ext] = (extBreakdown[ext] || 0) + fileSize;

          // Add file node as leaf
          currentFolderNode.children.push({
            name: entry.name,
            path: entryPath,
            size: fileSize,
            isDir: false
          });
        }
      }
    }

    // Phase 2: Bubble up subfolder sizes bottom-up
    // Since folders were pushed during traversal, reverse order is bottom-up
    for (let i = visitedFolders.length - 1; i >= 0; i--) {
      if (activeScanCancelled) {
        throw new Error('Scan cancelled by user.');
      }

      const currentPath = visitedFolders[i];
      const currentNode = folderNodes.get(currentPath);
      if (!currentNode || currentPath === resolvedRoot) continue;

      // Find parent path
      const parentPath = path.dirname(currentPath);
      const parentNode = folderNodes.get(parentPath);
      if (parentNode) {
        parentNode.size += currentNode.size;
      }
    }

    // Sort all folder/file children recursively by size descending
    for (const node of folderNodes.values()) {
      node.children.sort((a, b) => b.size - a.size);
    }

    // Format extension breakdown as sorted list
    const extensions = Object.entries(extBreakdown)
      .map(([ext, size]) => ({ ext, size }))
      .sort((a, b) => b.size - a.size);

    isScanRunning = false;
    return {
      tree: rootNode,
      extensions,
      stats: {
        scannedFiles,
        scannedFolders,
        totalSize
      }
    };

  } catch (error) {
    isScanRunning = false;
    throw error;
  } finally {
    isScanRunning = false;
  }
}

module.exports = {
  startDiskScan,
  cancelDiskScan
};
