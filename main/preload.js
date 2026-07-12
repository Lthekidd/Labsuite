/**
/**
 * LabSuite Preload Script
 *
 * Runs in a sandboxed context before the renderer loads.
 * Exposes ONLY the specific IPC channels LabSuite needs — nothing else.
 * This replaces nodeIntegration:true with a safe, explicit surface area.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Whitelist of channels the renderer is allowed to invoke (must match ipc.js handle registration exactly)
const INVOKE_CHANNELS = new Set([
  // Folders API
  'folders:list',
  'folders:add',
  'folders:addFile',
  'folders:reconnect',
  'folders:remove',
  'folders:toggle',
  'folders:exclude',
  'folders:include',
  'folders:setEncryption',
  'folders:selectLocal',
  'folders:selectRestoreDest',
  'folders:getSystemPaths',

  // Sync API
  'sync:triggerNow',
  'sync:pause',
  'sync:resume',
  'sync:resolveConflict',

  // Settings API
  'settings:get',
  'settings:set',
  'settings:exportDecryptTool',
  'aliases:sync',
  'aliases:save',

  // Authentication API
  'auth:startGDrive',
  'auth:checkConfig',
  'auth:setCryptPassword',
  'auth:disconnect',
  'auth:getGDriveInfo',
  'vault:metadata',
  'vault:destinations',
  'vault:connectDestination',
  'vault:transferDestination',
  'vault:syncReplica',

  // Logs & Activity API
  'logs:export',
  'diagnostics:export',
  'activity:get',
  'activity:clear',
  'backup:restorePoints',
  'backup:manifestSummary',
  'backup:planRestorePoint',
  'restore:pointInTime',

  // Restore API
  'restore:listRemote',
  'restore:listShortcuts',
  'restore:deleteRemote',
  'restore:start',
  'restore:packedFile',

  // Filesystem API
  'filesystem:listDrives',
  'filesystem:listDir',

  // Health & Verification API
  'health:get',
  'health:verify',
  'health:restoreDrill',

  // Search & Storage API
  'search:files',
  'analytics:storage',
  'analytics:summary',

  // Web Server API
  'serve:start',
  'serve:stop',

  // App API
  'app:getVersion',
  'app:getLogPath',
  'app:openExternal',

  // Advanced Features API (1, 3, 5, 7)
  'restore:browseSnapshot',
  'folders:updateExclusions',
  'settings:exportRecoverySheet',
  'vault:mount',
  'vault:unmount',
  'vault:getMountStatus',
  'vault:installWinFsp',
  
  // LabSuite v2 Modules API
  'crypt:encrypt',
  'crypt:decrypt',
  'fastSync:list',
  'fastSync:upload',
  'fastSync:download',
  'fastSync:delete',
  'sheets:writeLocalRecovery',
  'sheets:deleteLocalRecovery',
  'sheets:openRecoveryDir',
  'power:getShutdownSchedule',
  'power:scheduleShutdown',
  'power:cancelShutdown',
  'crypto:marketData',
  'crypto:search',
  'crypto:history',
  'crypto:historyRange',
  'lan:startDiscovery',
  'lan:stopDiscovery',
  'lan:getPeers',
  'lan:pingPeer',
  'lan:pingPeers',
  'lan:enableFileAccess',
  'lan:getFileAccessStatus',
  'lan:getSettings',
  'lan:setSettings',
  'lan:requestPair',
  'lan:respondPairRequest',
  'lan:getTrustedDevices',
  'lan:forgetTrustedDevice',
  'lan:listPeerDrives',
  'lan:listPeerDir',
  'lan:getTransferQueue',
  'lan:cancelTransferJob',
  'lan:retryTransferJob',
  'lan:clearFinishedTransfers',
  'lan:queueDownloadPeerItem',
  'lan:queueUploadFilesToPeer',
  'lan:queueUploadFolderToPeer',
  'lan:downloadPeerFile',
  'lan:downloadPeerFolder',
  'lan:movePeerPathToLocal',
  'lan:uploadFileToPeer',
  'lan:uploadFolderToPeer',
  'lan:moveLocalPathToPeer',
  'lan:moveLocalFolderToPeer',
  'lan:getDropSettings',
  'lan:setDropSettings',
  'lan:openDropInbox',
  'lan:queueDropPathsToPeer',
  'lan:queueDropTextToPeer',
  'vmProtect:discover',
  'vmProtect:getState',
  'vmProtect:startServer',
  'vmProtect:stopServer',
  'vmProtect:createHelper',
  'vmProtect:deployHelper',
  'vmProtect:approveEnrollment',
  'vmProtect:rejectEnrollment',
  'vmProtect:forgetGuest',
  'webdav:start',
  'webdav:stop',
  
  // Secure Notepad API
  'notepad:listLocal',
  'notepad:save',
  'notepad:getVersions',
  'notepad:restoreVersion',
  'notepad:readFile'
]);

const LISTEN_CHANNELS = new Set([
  'winfsp:install-progress',
  'status:change',
  'syncQueue:start',
  'syncQueue:item-start',
  'syncQueue:item-complete',
  'syncQueue:item-error',
  'syncQueue:complete',
  'sync:progress',
  'sync:folder-progress',
  'sync:overall-progress',
  'backup:file-activity',
  'backup:file-activity-batch',
  'sync:complete',
  'sync:error',
  'sync:conflict',
  'restore:progress',
  'restore:complete',
  'restore:error',
  'restore:error',
  'health:verify-log',
  'health:safety-update',
  'vault:transfer-progress',
  'analytics:storage-updated',
  'lan:peers',
  'lan:pair-request',
  'lan:transfer-progress',
  'lan:transfer-queue',
  'vmProtect:state',
  'notepad:open-file'
]);

const SEND_CHANNELS = new Set([
  'window:minimize',
  'window:maximize',
  'window:close'
]);

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    /**
     * Invoke a main-process handler and await the response.
     */
    invoke(channel, ...args) {
      if (!INVOKE_CHANNELS.has(channel)) {
        console.warn(`[preload] Blocked invoke on unknown channel: ${channel}`);
        return Promise.reject(new Error(`Channel not allowed: ${channel}`));
      }
      return ipcRenderer.invoke(channel, ...args);
    },

    /**
     * Register a listener for events pushed from the main process.
     */
    on(channel, listener) {
      if (!LISTEN_CHANNELS.has(channel)) {
        console.warn(`[preload] Blocked listener on unknown channel: ${channel}`);
        return;
      }
      ipcRenderer.on(channel, listener);
    },

    /**
     * Remove a specific listener.
     */
    removeListener(channel, listener) {
      if (!LISTEN_CHANNELS.has(channel)) return;
      ipcRenderer.removeListener(channel, listener);
    },

    /**
     * Remove all listeners for a channel.
     */
    removeAllListeners(channel) {
      if (!LISTEN_CHANNELS.has(channel)) return;
      ipcRenderer.removeAllListeners(channel);
    },

    /**
     * Fire-and-forget send.
     */
    send(channel, ...args) {
      if (!SEND_CHANNELS.has(channel)) {
        console.warn(`[preload] Blocked send on unknown channel: ${channel}`);
        return;
      }
      ipcRenderer.send(channel, ...args);
    }
  },
  getPathForFile(file) {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      return webUtils.getPathForFile(file);
    }
    return file.path || '';
  }
});
