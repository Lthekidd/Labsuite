const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./database');
const rcloneModule = require('./rclone');
const telegramArchive = require('./telegramArchive');
const os = require('os');

// Keep track of active backup runs
const activeBackups = new Map();

function getTelegramTempDestination(installId, systemTempDir = os.tmpdir()) {
  return path.join(systemTempDir, 'LabSuite_Temp', `telegram_${installId}`);
}

/**
 * Detect accounts inside a given tdata folder.
 */
function detectAccounts(tdataPath) {
  if (!fs.existsSync(tdataPath)) return 0;
  let count = 0;
  if (fs.existsSync(path.join(tdataPath, 'key_datas'))) {
    count++;
  }
  try {
    const files = fs.readdirSync(tdataPath);
    for (const f of files) {
      if (f.startsWith('settings_') && fs.statSync(path.join(tdataPath, f)).isDirectory()) {
        count++;
      }
    }
  } catch (_) {}
  // Fallback to at least 1 if the path is valid but key_datas isn't there yet
  return count || 1;
}

/**
 * Scan standard Windows paths for Telegram Desktop installations.
 */
async function discoverTelegramInstalls() {
  const discovered = [];
  const username = os.userInfo().username;
  
  const pathsToScan = [
    // Standard installation AppData path
    path.join(process.env.APPDATA || `C:\\Users\\${username}\\AppData\\Roaming`, 'Telegram Desktop', 'tdata'),
    // Windows Store version path
    path.join(
      process.env.LOCALAPPDATA || `C:\\Users\\${username}\\AppData\\Local`,
      'Packages',
      'Telegram.TelegramDesktop_n86zxr96g8312',
      'LocalCache',
      'Roaming',
      'Telegram Desktop',
      'tdata'
    )
  ];

  for (const tdataPath of pathsToScan) {
    if (fs.existsSync(tdataPath)) {
      const accounts = detectAccounts(tdataPath);
      discovered.push({
        tdata_path: tdataPath,
        account_count: accounts,
        label: tdataPath.includes('Packages') ? 'Telegram Desktop (Store)' : 'Telegram Desktop'
      });
    }
  }

  return discovered;
}

/**
 * Spawns a PowerShell script to safely snapshot the tdata folder (using VSS if admin, falling back to robocopy).
 */
function createFolderSnapshot(tdataPath, tempDest) {
  return new Promise((resolve, reject) => {
    // Ensure temp directory is clean
    if (fs.existsSync(tempDest)) {
      try {
        fs.rmSync(tempDest, { recursive: true, force: true });
      } catch (_) {}
    }
    fs.mkdirSync(tempDest, { recursive: true });

    const drive = path.parse(tdataPath).root; // e.g. "C:\"
    const relPath = tdataPath.substring(drive.length);
    const driveLetter = drive.replace('\\', '');

    // Powershell script trying to do VSS. If it fails (non-admin), it uses direct robocopy.
    const psScript = `
$ErrorActionPreference = 'Stop'
$tdataPath = "${tdataPath}"
$tempDest = "${tempDest}"
$drive = "${driveLetter}"
$relPath = "${relPath}"

function RunDirectRobocopy {
    Write-Output "Running direct copy fallback..."
    # Robocopy exit codes < 8 are success/info. We suppress errors to handle them in JS.
    & robocopy $tdataPath $tempDest /E /R:1 /W:1 /NP /NFL /NDL /NJH /NJS
    $exitCode = $LASTEXITCODE
    if ($exitCode -ge 8) {
        Write-Output "Robocopy failed with exit code $exitCode"
    } else {
        Write-Output "Robocopy finished successfully (exit code $exitCode)"
    }
}

# Try VSS only on Windows and if running as administrator
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdmin) {
    Write-Output "Running as Administrator. Attempting VSS snapshot..."
    try {
        $shadow = (Get-WmiObject -List Win32_ShadowCopy).Create($drive + "\\", "ClientAccessible")
        if ($shadow.ReturnValue -eq 0) {
            $shadowId = $shadow.ShadowID
            $sc = Get-WmiObject Win32_ShadowCopy | Where-Object { $_.ID -eq $shadowId }
            $deviceObject = $sc.DeviceObject
            
            # Mount the shadow copy path
            $shadowSource = Join-Path $deviceObject $relPath
            Write-Output "VSS Shadow copy created. Copying from: $shadowSource"
            
            & robocopy $shadowSource $tempDest /E /R:1 /W:1 /NP /NFL /NDL /NJH /NJS
            $exitCode = $LASTEXITCODE
            
            # Clean up the shadow copy
            $sc.Delete()
            Write-Output "VSS Shadow copy cleaned up."
        } else {
            Write-Output "VSS creation failed with code: $($shadow.ReturnValue)"
            RunDirectRobocopy
        }
    } catch {
        Write-Output "VSS failed: $_"
        RunDirectRobocopy
    }
} else {
    Write-Output "Not running as Admin. VSS skipped."
    RunDirectRobocopy
}
`;

    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      windowsHide: true
    });

    let output = '';
    ps.stdout.on('data', (data) => {
      output += data.toString();
    });
    ps.stderr.on('data', (data) => {
      output += data.toString();
    });

    ps.on('close', (code) => {
      console.log(`Telegram snapshot output:\n${output}`);
      // Robocopy might return non-zero codes on success, but if target directory is empty we reject
      if (fs.existsSync(tempDest) && fs.readdirSync(tempDest).length > 0) {
        resolve();
      } else {
        reject(new Error(`Snapshot failed. Temp folder is empty or not created. Details: ${output}`));
      }
    });
  });
}

/**
 * Runs a backup for a specific Telegram installation.
 */
async function runTelegramBackup(installId, onProgress) {
  if (activeBackups.has(installId)) {
    throw new Error('Backup for this Telegram installation is already running.');
  }

  const installs = db.getTelegramInstalls();
  const install = installs.find(i => i.id === installId);
  if (!install) {
    throw new Error(`Telegram installation not found in database: ${installId}`);
  }

  // Update status to running
  db.updateTelegramInstall(installId, {
    last_backup_status: 'running',
    last_error: null
  });
  if (onProgress) {
    onProgress({ stage: 'preparing', percent: 0, message: 'Creating snapshot...' });
  }

  // Staging must be local to the PC running this backup. Database folder paths can
  // refer to removable or other-PC drives (for example E:) that are unavailable here.
  const tempDest = getTelegramTempDestination(installId);
  const startTime = Date.now();
  let failureStage = 'snapshot-copy';
  telegramArchive.recordDiagnosticEvent({
    outcome: 'started',
    operation: 'session-backup',
    stage: 'snapshot-copy',
    installId,
    message: 'Encrypted Telegram session backup started.'
  });

  try {
    // 1. Create a shadow copy snapshot of the files
    console.log(`Creating snapshot of ${install.tdata_path} to ${tempDest}`);
    await createFolderSnapshot(install.tdata_path, tempDest);
    telegramArchive.recordDiagnosticEvent({
      outcome: 'success',
      operation: 'session-backup',
      stage: 'snapshot-copy',
      installId,
      message: 'Telegram session files were copied into local staging.'
    });

    // 2. Perform rclone copy to Google Drive crypt
    failureStage = 'encrypted-cloud-copy';
    if (onProgress) {
      onProgress({ stage: 'uploading', percent: 10, message: 'Uploading to Google Drive...' });
    }

    const remotePath = install.remote_path;
    const { rcloneBin, configPath } = rcloneModule.getPaths();
    const destRemote = `${rcloneModule.getRemote()}:${remotePath}`;

    console.log(`Uploading snapshot from ${tempDest} to ${destRemote}`);
    
    // We run `rclone copy` to keep it incremental without deleting deleted files in target,
    // or `rclone sync` if we want exact session mirroring. Let's use `sync` so it mirrors
    // the current Telegram state (which matches the user's manual export logic and avoids bloating).
    // Note: rclone sync keeps it fully incremental (starts from previous upload and only changes).
    const args = [
      'sync',
      tempDest,
      destRemote,
      '--config', configPath,
      '--stats=1s',
      '--use-json-log'
    ];

    const rcloneProc = spawn(rcloneBin, args, { windowsHide: true });
    activeBackups.set(installId, rcloneProc);

    let stderrBuffer = '';
    const rcloneErrors = [];
    
    await new Promise((resolvePromise, rejectPromise) => {
      rcloneProc.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop(); // keep last incomplete line
        if (stderrBuffer.length > 64 * 1024) stderrBuffer = stderrBuffer.slice(-64 * 1024);

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed);
            if (entry.level === 'error' || entry.level === 'critical' || entry.level === 'warning') {
              rcloneErrors.push(entry.msg || trimmed);
              if (rcloneErrors.length > 12) rcloneErrors.shift();
            }
            if (entry.stats && onProgress) {
              const s = entry.stats;
              const percent = s.totalBytes > 0 ? Math.round((s.bytes / s.totalBytes) * 100) : 0;
              onProgress({
                stage: 'uploading',
                percent: Math.min(99, 10 + Math.round(percent * 0.85)),
                message: `Uploading: ${percent}% (${(s.bytes / 1024 / 1024).toFixed(1)} MB / ${(s.totalBytes / 1024 / 1024).toFixed(1)} MB)`
              });
            }
          } catch (_) {
            rcloneErrors.push(trimmed);
            if (rcloneErrors.length > 12) rcloneErrors.shift();
          }
        }
      });

      let settled = false;
      rcloneProc.on('error', error => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      });
      rcloneProc.on('close', (code) => {
        activeBackups.delete(installId);
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolvePromise();
        } else {
          if (stderrBuffer.trim()) {
            try {
              const entry = JSON.parse(stderrBuffer.trim());
              rcloneErrors.push(entry.msg || stderrBuffer.trim());
            } catch (_) {
              rcloneErrors.push(stderrBuffer.trim());
            }
          }
          const detail = rcloneErrors.slice(-8).join(' | ');
          const error = new Error(detail ? `Encrypted session upload failed: ${detail}` : `Encrypted session upload exited with code ${code}.`);
          error.exitCode = code;
          rejectPromise(error);
        }
      });
    });
    telegramArchive.recordDiagnosticEvent({
      outcome: 'success',
      operation: 'session-backup',
      stage: 'encrypted-cloud-copy',
      installId,
      message: 'Encrypted Telegram session copy completed.'
    });

    // Determine backup size
    let backupSizeBytes = 0;
    try {
      const getFolderSize = (dir) => {
        let size = 0;
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const fp = path.join(dir, f);
          const stat = fs.statSync(fp);
          if (stat.isDirectory()) {
            size += getFolderSize(fp);
          } else {
            size += stat.size;
          }
        }
        return size;
      };
      backupSizeBytes = getFolderSize(tempDest);
    } catch (_) {}

    // Cleanup temp folder
    try {
      fs.rmSync(tempDest, { recursive: true, force: true });
    } catch (_) {}

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const backupAt = new Date().toISOString();

    // Add to history and update installation state
    const history = install.backup_history || [];
    history.push({
      at: backupAt,
      size: backupSizeBytes,
      duration: durationSec,
      status: 'success'
    });

    db.updateTelegramInstall(installId, {
      last_backup_at: backupAt,
      last_backup_size_bytes: backupSizeBytes,
      last_backup_duration_sec: durationSec,
      last_backup_status: 'success',
      last_error: null,
      consecutive_failures: 0,
      backup_history: history.slice(-50) // keep last 50
    });

    if (onProgress) {
      onProgress({ stage: 'completed', percent: 100, message: 'Backup completed successfully!' });
    }
    telegramArchive.recordDiagnosticEvent({
      outcome: 'success',
      operation: 'session-backup',
      stage: 'completed',
      installId,
      message: 'Telegram session backup completed.'
    });

    return true;
  } catch (error) {
    console.error(`Telegram backup ${installId} failed:`, error);
    telegramArchive.recordDiagnosticEvent({
      outcome: 'failure',
      operation: 'session-backup',
      stage: failureStage,
      installId,
      message: error.message,
      exitCode: error.exitCode
    });
    
    // Cleanup temp folder
    try {
      if (fs.existsSync(tempDest)) {
        fs.rmSync(tempDest, { recursive: true, force: true });
      }
    } catch (_) {}

    const history = install.backup_history || [];
    history.push({
      at: new Date().toISOString(),
      size: 0,
      duration: Math.round((Date.now() - startTime) / 1000),
      status: 'failed',
      error: error.message
    });

    db.updateTelegramInstall(installId, {
      last_backup_status: 'failed',
      last_error: error.message,
      consecutive_failures: (install.consecutive_failures || 0) + 1,
      backup_history: history.slice(-50)
    });

    throw error;
  } finally {
    activeBackups.delete(installId);
  }
}

/**
 * Restores a specific remote backup.
 */
async function restoreTelegramBackup(device, remotePath, localDestination, onProgress) {
  if (onProgress) {
    onProgress({ stage: 'downloading', percent: 0, message: 'Downloading files from Google Drive...' });
  }

  const { rcloneBin, configPath } = rcloneModule.getPaths();
  const sourceRemote = `${rcloneModule.getRemote()}:${remotePath}`;

  fs.mkdirSync(localDestination, { recursive: true });

  const args = [
    'copy',
    sourceRemote,
    localDestination,
    '--config', configPath,
    '--stats=1s',
    '--use-json-log'
  ];

  console.log(`Restoring Telegram backup from ${sourceRemote} to ${localDestination}`);
  const rcloneProc = spawn(rcloneBin, args, { windowsHide: true });

  let stderrBuffer = '';

  await new Promise((resolve, reject) => {
    rcloneProc.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (entry.stats && onProgress) {
            const s = entry.stats;
            const percent = s.totalBytes > 0 ? Math.round((s.bytes / s.totalBytes) * 100) : 0;
            onProgress({
              stage: 'downloading',
              percent,
              message: `Downloading: ${percent}% (${(s.bytes / 1024 / 1024).toFixed(1)} MB / ${(s.totalBytes / 1024 / 1024).toFixed(1)} MB)`
            });
          }
        } catch (_) {}
      }
    });

    rcloneProc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`rclone copy restore exited with code ${code}`));
      }
    });
  });

  if (onProgress) {
    onProgress({ stage: 'completed', percent: 100, message: 'Restore completed successfully!' });
  }

  return true;
}

/**
 * List all remote backup paths across all devices (cross-PC catalog).
 */
async function listRemoteTelegramBackups() {
  const rootPath = 'TelegramBackup';
  
  try {
    const list = await rcloneModule.listRemoteDir(rootPath);
    // list is an array of directory objects: [{Path: 'DESKTOP-PC1', IsDir: true}, ...]
    const backups = [];
    for (const item of list) {
      if (item.IsDir) {
        const deviceName = item.Path;
        // List contents under this device to get metadata or estimate size
        const deviceDir = `${rootPath}/${deviceName}`;
        const contents = await rcloneModule.listRemoteDir(deviceDir);
        
        let totalSize = 0;
        let fileCount = 0;
        let lastMod = null;
        
        const countFiles = (items) => {
          for (const c of items) {
            if (c.IsDir === false) {
              totalSize += c.Size || 0;
              fileCount++;
              if (!lastMod || new Date(c.ModTime) > new Date(lastMod)) {
                lastMod = c.ModTime;
              }
            }
          }
        };
        
        countFiles(contents);
        
        backups.push({
          device: deviceName,
          remote_path: deviceDir,
          size_bytes: totalSize,
          file_count: fileCount,
          last_backup_at: lastMod
        });
      }
    }
    return backups;
  } catch (error) {
    console.error('Failed to list remote Telegram backups:', error);
    return [];
  }
}

/**
 * Check and run scheduled backups.
 * Reuses the schedule settings format of database.js.
 */
let scheduledInterval = null;
function startTelegramScheduler() {
  if (scheduledInterval) clearInterval(scheduledInterval);
  
  console.log('Telegram Backup Scheduler: Started.');
  scheduledInterval = setInterval(async () => {
    const installs = db.getTelegramInstalls();
    for (const install of installs) {
      if (!install.enabled || install.schedule === 'manual') continue;
      
      const lastRun = install.last_backup_at ? Date.parse(install.last_backup_at) : 0;
      const now = Date.now();
      let due = false;

      if (install.schedule === 'hourly') {
        due = (now - lastRun) >= 60 * 60 * 1000;
      } else if (install.schedule === '6hours') {
        due = (now - lastRun) >= 6 * 60 * 60 * 1000;
      } else if (install.schedule === 'daily') {
        const hasPassedDay = (now - lastRun) >= 24 * 60 * 60 * 1000;
        if (hasPassedDay) {
          // Check time of day
          const [prefHour, prefMin] = (install.schedule_time || '03:00').split(':').map(Number);
          const currentDate = new Date();
          if (currentDate.getHours() >= prefHour && currentDate.getMinutes() >= prefMin) {
            due = true;
          }
        }
      } else if (install.schedule === 'weekly') {
        due = (now - lastRun) >= 7 * 24 * 60 * 60 * 1000;
      }

      if (due && install.last_backup_status !== 'running') {
        console.log(`Telegram Backup Scheduler: Triggering backup for ${install.label} (${install.id})`);
        try {
          await runTelegramBackup(install.id);
        } catch (err) {
          console.error(`Scheduled backup failed for install ${install.id}:`, err);
        }
      }
    }
  }, 60000); // Check every minute
}

function stopTelegramScheduler() {
  if (scheduledInterval) {
    clearInterval(scheduledInterval);
    scheduledInterval = null;
    console.log('Telegram Backup Scheduler: Stopped.');
  }
}

function isBackupRunning(installId) {
  return activeBackups.has(installId);
}

module.exports = {
  discoverTelegramInstalls,
  runTelegramBackup,
  restoreTelegramBackup,
  listRemoteTelegramBackups,
  startTelegramScheduler,
  stopTelegramScheduler,
  detectAccounts,
  isBackupRunning,
  getTelegramTempDestination
};
