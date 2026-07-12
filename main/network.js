const { execFile } = require('child_process');
const db = require('./database');

const CHECK_TTL_MS = 30000;
const systemPolicyCache = {
  refreshing: false,
  updatedAt: 0,
  wifiConnected: null,
  battery: null,
  metered: null
};

function isWithinWindow(start, end) {
  const now = new Date();
  const currentMins = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = String(start || '00:00').split(':').map(Number);
  const [endH, endM] = String(end || '23:59').split(':').map(Number);
  const startMins = startH * 60 + (startM || 0);
  const endMins = endH * 60 + (endM || 0);

  if (startMins <= endMins) {
    return currentMins >= startMins && currentMins <= endMins;
  }
  return currentMins >= startMins || currentMins <= endMins;
}

function getIdleSeconds() {
  try {
    const { powerMonitor } = require('electron');
    return powerMonitor.getSystemIdleTime();
  } catch (_) {
    return 0;
  }
}

function getAutomaticRuleBlock(settings) {
  const activeHoursEnabled = settings.sync_active_hours_enabled === '1';
  if (activeHoursEnabled) {
    const start = settings.sync_active_hours_start || '09:00';
    const end = settings.sync_active_hours_end || '17:00';
    if (!isWithinWindow(start, end)) {
      return `Paused: Outside active backup hours (${start} - ${end})`;
    }
  }

  if (settings.sync_only_when_idle === '1') {
    const idleSecs = getIdleSeconds();
    const thresholdMins = Number(settings.sync_idle_threshold_minutes) || 5;
    if (idleSecs < thresholdMins * 60) {
      return `Paused: Waiting for idle time (${Math.floor(idleSecs / 60)}m/${thresholdMins}m)`;
    }
  }

  return '';
}

function runCommand(command, args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true, timeout }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function refreshSystemPolicyCache() {
  if (process.platform !== 'win32' || systemPolicyCache.refreshing) return;
  systemPolicyCache.refreshing = true;

  Promise.allSettled([
    runCommand('netsh', ['wlan', 'show', 'interfaces']),
    runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$b = Get-CimInstance Win32_Battery; if ($b) { "PowerOnLine=$($b.PowerOnLine);Percent=$($b.RemainingCapacityPercent)" } else { "AC" }'
    ]),
    runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType=WindowsRuntime] | Out-Null; $profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile(); if ($profile) { $profile.GetConnectionCost().NetworkCostType } else { 1 }'
    ])
  ]).then(([wifiResult, batteryResult, meteredResult]) => {
    if (wifiResult.status === 'fulfilled') {
      const out = wifiResult.value;
      systemPolicyCache.wifiConnected = out.includes('State') && !out.includes('disconnected');
    }

    if (batteryResult.status === 'fulfilled') {
      const bInfo = batteryResult.value;
      if (!bInfo || bInfo === 'AC') {
        systemPolicyCache.battery = { powerOnLine: true, percent: 100, present: false };
      } else {
        const parts = bInfo.split(';');
        systemPolicyCache.battery = {
          powerOnLine: parts[0]?.split('=')[1] === 'True',
          percent: parseInt(parts[1]?.split('=')[1], 10) || 100,
          present: true
        };
      }
    }

    if (meteredResult.status === 'fulfilled') {
      systemPolicyCache.metered = meteredResult.value === '2' || meteredResult.value === '3';
    }

    systemPolicyCache.updatedAt = Date.now();
  }).catch(error => {
    console.error('Network check: Async policy refresh failed', error.message);
  }).finally(() => {
    systemPolicyCache.refreshing = false;
  });
}

function ensureFreshSystemPolicyCache() {
  if (process.platform !== 'win32') return true;
  const fresh = Date.now() - systemPolicyCache.updatedAt <= CHECK_TTL_MS;
  if (!fresh) refreshSystemPolicyCache();
  return fresh;
}

/**
 * Checks if backup is allowed under schedule/network/power rules.
 * Manual runs bypass automatic-only rules like schedule windows and idle gating.
 * Returns { allowed: boolean, reason: string }
 */
function isSyncAllowed(options = {}) {
  const settings = db.getDb().settings || {};
  const manual = options.manual === true;

  // 1. Time-based scheduling
  const type = settings.sync_schedule_type || 'ALWAYS';
  let start = '00:00';
  let end = '23:59';
  
  if (manual || type === 'ALWAYS') {
    // No time restriction
  } else {
    if (type === 'NIGHT') {
      start = '23:00';
      end = '06:00';
    } else if (type === 'CUSTOM') {
      start = settings.schedule_start || '00:00';
      end = settings.schedule_end || '23:59';
    }

    if (!isWithinWindow(start, end)) {
      const displayHours = type === 'NIGHT' ? '11 PM - 6 AM' : `${start} - ${end}`;
      return { allowed: false, reason: `Paused: Outside active hours (${displayHours})` };
    }
  }

  if (!manual) {
    const automaticRuleBlock = getAutomaticRuleBlock(settings);
    if (automaticRuleBlock) {
      return { allowed: false, reason: automaticRuleBlock };
    }
  }

  const systemPolicyFresh = ensureFreshSystemPolicyCache();

  // 2. WiFi-only constraint
  if (settings.wifi_only === '1' && process.platform === 'win32') {
    if (!systemPolicyFresh || systemPolicyCache.wifiConnected === null) {
      return { allowed: false, reason: 'Paused: Checking Wi-Fi status' };
    }
    if (!systemPolicyCache.wifiConnected) {
      return { allowed: false, reason: 'Paused: Waiting for Wi-Fi' };
    }
  }

  // 3. Battery constraints
  const batteryMode = settings.battery_mode || 'OFF'; // OFF, ON_BATTERY, LOW_BATTERY
  if (batteryMode !== 'OFF' && process.platform === 'win32') {
    const battery = systemPolicyCache.battery;
    if (!systemPolicyFresh || battery === null) {
      return { allowed: false, reason: 'Paused: Checking battery status' };
    }
    if (battery.present && !battery.powerOnLine) {
      if (batteryMode === 'ON_BATTERY') {
        return { allowed: false, reason: 'Paused: Running on battery power' };
      } else if (batteryMode === 'LOW_BATTERY' && battery.percent < 20) {
        return { allowed: false, reason: `Paused: Low battery (${battery.percent}%)` };
      }
    }
  }

  // 4. Metered connection constraint
  if (settings.pause_on_metered === '1' && process.platform === 'win32') {
    if (!systemPolicyFresh || systemPolicyCache.metered === null) {
      return { allowed: false, reason: 'Paused: Checking metered connection status' };
    }
    if (systemPolicyCache.metered) {
      return { allowed: false, reason: 'Paused: Metered network connection' };
    }
  }

  return { allowed: true, reason: '' };
}

module.exports = {
  isSyncAllowed,
  __private: {
    isWithinWindow,
    getAutomaticRuleBlock,
    refreshSystemPolicyCache
  }
};
