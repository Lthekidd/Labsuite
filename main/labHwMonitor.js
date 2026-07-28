const { app, ipcMain, BrowserWindow } = require('electron');
const os = require('os');
const { execFile } = require('child_process');

let activeSubscribers = new Set();
let samplingTimer = null;
let cachedSnapshot = null;
let lastCpuTimes = null;

function runPowerShell(command, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (_) {
        resolve(null);
      }
    });
  });
}

/**
 * Calculate per-core & overall CPU utilization percentage
 */
function getCpuUsage() {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return { overall: 0, cores: [] };

  const currentTimes = cpus.map(cpu => cpu.times);
  const cores = [];
  let totalIdleDiff = 0;
  let totalTickDiff = 0;

  for (let i = 0; i < cpus.length; i++) {
    const prev = lastCpuTimes ? lastCpuTimes[i] : null;
    const curr = currentTimes[i];

    if (!prev) {
      cores.push({ coreIndex: i, speed: cpus[i].speed, load: 0 });
      continue;
    }

    const idleDiff = curr.idle - prev.idle;
    const totalDiff = (curr.user + curr.nice + curr.sys + curr.idle + curr.irq) -
                      (prev.user + prev.nice + prev.sys + prev.idle + prev.irq);

    totalIdleDiff += idleDiff;
    totalTickDiff += totalDiff;

    const load = totalDiff > 0 ? Math.min(100, Math.max(0, Math.round(((totalDiff - idleDiff) / totalDiff) * 100))) : 0;
    cores.push({ coreIndex: i, speed: cpus[i].speed, load });
  }

  lastCpuTimes = currentTimes;
  const overall = totalTickDiff > 0 ? Math.min(100, Math.max(0, Math.round(((totalTickDiff - totalIdleDiff) / totalTickDiff) * 100))) : 0;

  return { overall, cores };
}

/**
 * Fetch advanced hardware metrics (WMI + OS)
 */
async function collectMetricsSnapshot() {
  const cpuUsage = getCpuUsage();
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'Processor';
  const cpuCoresCount = cpus.length;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memoryUsage = {
    total: totalMem,
    used: usedMem,
    free: freeMem,
    percent: Math.round((usedMem / totalMem) * 100)
  };

  // Asynchronously query WMI metrics for GPU, Storage, Power, and Battery
  const [procWmi, videoWmi, diskWmi, batteryWmi] = await Promise.all([
    runPowerShell(`Get-CimInstance Win32_Processor | Select-Object Name, MaxClockSpeed, CurrentClockSpeed, LoadPercentage | ConvertTo-Json`),
    runPowerShell(`Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterRAM, VideoProcessor | ConvertTo-Json`),
    runPowerShell(`Get-CimInstance Win32_DiskDrive | Select-Object Model, Size, MediaType, InterfaceType, Status | ConvertTo-Json`),
    runPowerShell(`Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json`)
  ]);

  const procInfo = Array.isArray(procWmi) ? procWmi[0] : procWmi;
  const videoInfo = Array.isArray(videoWmi) ? videoWmi[0] : videoWmi;
  const diskInfo = Array.isArray(diskWmi) ? diskWmi : (diskWmi ? [diskWmi] : []);
  const batteryInfo = Array.isArray(batteryWmi) ? batteryWmi[0] : batteryWmi;

  // Measure Ping Latency to Gateway / Cloud
  let pingMs = null;
  try {
    const pingRes = await runPowerShell(`Test-Connection -ComputerName 1.1.1.1 -Count 1 | Select-Object ResponseTime | ConvertTo-Json`);
    if (pingRes?.ResponseTime !== undefined) {
      pingMs = Number(pingRes.ResponseTime);
    }
  } catch (_) {}

  // Query Thermal Sensors (ACPI, LHM/OHM, Disk S.M.A.R.T.)
  let cpuTempC = null;
  let tempSource = 'hardware';

  try {
    const thermalWmi = await runPowerShell(`$t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue; if ($t) { [math]::Round(($t[0].CurrentTemperature - 2732) / 10, 1) } else { '' }`);
    if (thermalWmi && !isNaN(Number(thermalWmi)) && Number(thermalWmi) > 0 && Number(thermalWmi) < 115) {
      cpuTempC = Number(thermalWmi);
      tempSource = 'hardware';
    }
  } catch (_) {}

  if (cpuTempC === null) {
    // Thermal Estimator model based on real-time CPU load & base thermal curve
    const baseTemp = 36;
    const loadFactor = (cpuUsage.overall / 100) * 42;
    cpuTempC = Math.round((baseTemp + loadFactor) * 10) / 10;
    tempSource = 'estimated';
  }

  const cpuTempF = Math.round((cpuTempC * 1.8 + 32) * 10) / 10;

  // Format GPU
  const gpu = {
    name: videoInfo?.Name || 'Graphics Adapter',
    driver: videoInfo?.DriverVersion || 'N/A',
    vramBytes: Number(videoInfo?.AdapterRAM) || 0,
    processor: videoInfo?.VideoProcessor || 'GPU'
  };

  // Format Storage Disks
  const storage = diskInfo.map(d => ({
    model: d.Model || 'Fixed Disk',
    sizeBytes: Number(d.Size) || 0,
    mediaType: d.MediaType || 'Fixed Drive',
    interface: d.InterfaceType || 'SATA/NVMe',
    status: d.Status || 'OK'
  }));

  // Format Battery & Power
  const battery = batteryInfo ? {
    percent: Number(batteryInfo.EstimatedChargeRemaining) || 100,
    status: Number(batteryInfo.BatteryStatus) === 2 ? 'Charging' : 'Discharging'
  } : null;

  // Format Uptime
  const uptimeSeconds = os.uptime();
  const days = Math.floor(uptimeSeconds / (3600 * 24));
  const hours = Math.floor((uptimeSeconds % (3600 * 24)) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = Math.floor(uptimeSeconds % 60);
  const uptimeFormatted = `${days > 0 ? `${days}d ` : ''}${hours}h ${minutes}m ${seconds}s`;

  cachedSnapshot = {
    timestamp: new Date().toISOString(),
    cpu: {
      model: procInfo?.Name?.trim() || cpuModel,
      coresCount: cpuCoresCount,
      maxClockMhz: procInfo?.MaxClockSpeed || cpus[0]?.speed || 0,
      currentClockMhz: procInfo?.CurrentClockSpeed || cpus[0]?.speed || 0,
      loadPercent: cpuUsage.overall,
      tempC: cpuTempC,
      tempF: cpuTempF,
      tempSource: tempSource,
      cores: cpuUsage.cores
    },
    memory: memoryUsage,
    gpu,
    storage,
    battery,
    network: {
      pingMs,
      interfacesCount: Object.keys(os.networkInterfaces()).length
    },
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptimeSeconds,
      uptimeFormatted
    }
  };

  return cachedSnapshot;
}

/**
 * Start or update sampling loop when active subscribers exist
 */
function startSamplingLoop() {
  if (samplingTimer) return;

  // Take immediate snapshot
  collectMetricsSnapshot().then(snapshot => {
    broadcastSnapshot(snapshot);
  });

  // Sample every 1.5 seconds while open
  samplingTimer = setInterval(async () => {
    if (activeSubscribers.size === 0) {
      stopSamplingLoop();
      return;
    }
    const snapshot = await collectMetricsSnapshot();
    broadcastSnapshot(snapshot);
  }, 1500);

  console.log('LabHWMonitor: Sampling loop STARTED.');
}

/**
 * Stop & destroy sampling loop when no subscribers exist (Zero-Idle Overhead!)
 */
function stopSamplingLoop() {
  if (samplingTimer) {
    clearInterval(samplingTimer);
    samplingTimer = null;
    console.log('LabHWMonitor: Sampling loop STOPPED (Zero Idle Overhead).');
  }
}

function broadcastSnapshot(snapshot) {
  for (const subscriberId of activeSubscribers) {
    const win = BrowserWindow.fromId(subscriberId);
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send('hwmonitor:snapshot', snapshot);
    } else {
      activeSubscribers.delete(subscriberId);
    }
  }
  if (activeSubscribers.size === 0) {
    stopSamplingLoop();
  }
}

function initIpc() {
  ipcMain.handle('hwmonitor:subscribe', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      activeSubscribers.add(win.id);
      startSamplingLoop();
    }
    return { success: true, isSampling: true };
  });

  ipcMain.handle('hwmonitor:unsubscribe', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      activeSubscribers.delete(win.id);
    }
    if (activeSubscribers.size === 0) {
      stopSamplingLoop();
    }
    return { success: true, isSampling: false };
  });

  ipcMain.handle('hwmonitor:getSnapshot', async () => {
    if (!cachedSnapshot) {
      await collectMetricsSnapshot();
    }
    return cachedSnapshot;
  });
}

function init() {
  initIpc();
  console.log('LabHWMonitor initialized.');
}

module.exports = {
  init,
  collectMetricsSnapshot,
  getSnapshot: () => cachedSnapshot,
  isSampling: () => !!samplingTimer
};
