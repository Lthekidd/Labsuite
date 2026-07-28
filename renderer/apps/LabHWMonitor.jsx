import React, { useState, useEffect } from 'react';
import { ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise';
import { BatteryCharging } from '@phosphor-icons/react/BatteryCharging';
import { Cpu } from '@phosphor-icons/react/Cpu';
import { DesktopTower } from '@phosphor-icons/react/DesktopTower';
import { HardDrive } from '@phosphor-icons/react/HardDrive';
import { Lightning } from '@phosphor-icons/react/Lightning';
import { Thermometer } from '@phosphor-icons/react/Thermometer';
import { WifiHigh } from '@phosphor-icons/react/WifiHigh';
import AppIcon from '../AppIcon';

const ipcRenderer = window.electron?.ipcRenderer;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, idx)).toFixed(1)} ${units[idx]}`;
}

export default function LabHWMonitor() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tempUnit, setTempUnit] = useState('C'); // 'C' or 'F'

  // Subscribe to live metrics when mounted; Unsubscribe on unmount (Zero Idle Overhead!)
  useEffect(() => {
    let mounted = true;

    async function startSubscription() {
      try {
        setLoading(true);
        // Initial snapshot fetch
        const initial = await ipcRenderer?.invoke('hwmonitor:getSnapshot');
        if (mounted && initial) {
          setMetrics(initial);
          setLoading(false);
        }
        // Subscribe to live hardware stream
        await ipcRenderer?.invoke('hwmonitor:subscribe');
      } catch (err) {
        console.error('LabHWMonitor: failed to subscribe:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    startSubscription();

    const handleSnapshot = (_, data) => {
      if (mounted && data) {
        setMetrics(data);
        setLoading(false);
      }
    };

    ipcRenderer?.on('hwmonitor:snapshot', handleSnapshot);

    return () => {
      mounted = false;
      ipcRenderer?.removeListener('hwmonitor:snapshot', handleSnapshot);
      // Unsubscribe on unmount to completely stop hardware sampling loop
      ipcRenderer?.invoke('hwmonitor:unsubscribe');
    };
  }, []);

  const handleManualRefresh = async () => {
    setLoading(true);
    const updated = await ipcRenderer?.invoke('hwmonitor:getSnapshot');
    if (updated) setMetrics(updated);
    setLoading(false);
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto', color: '#e2e8f0' }}>
      {/* 1. Header & Live Sampling Status */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#10b981' }}>
            <AppIcon appId="hwmonitor" size={24} weight="bold" />
          </div>
          <div>
            <h1 style={{ fontSize: '20px', fontWeight: 700, margin: 0, color: '#f8fafc' }}>LabHWMonitor</h1>
            <p style={{ fontSize: '13px', color: '#94a3b8', margin: 0 }}>Advanced System Hardware Diagnostics & Thermal Monitor</p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', padding: '6px 12px', borderRadius: '20px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#34d399' }} /> Live Sampling (0% Idle Impact when closed)
          </div>
          <button
            onClick={handleManualRefresh}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: '#1e293b', color: '#e2e8f0', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}
          >
            <ArrowClockwise size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading && !metrics ? (
        <div style={{ padding: '60px', textAlign: 'center', color: '#64748b' }}>
          Gathering hardware diagnostics & WMI sensors...
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '20px' }}>
          {/* Card 1: Processor & Per-Core Load */}
          <div style={{ background: '#1e293b', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Cpu size={20} color="#10b981" />
                <span style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>CPU & Per-Core Clocks</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#10b981', background: 'rgba(16, 185, 129, 0.15)', padding: '2px 8px', borderRadius: '4px' }}>
                  {metrics?.cpu?.loadPercent || 0}% Load
                </span>
                <button
                  onClick={() => setTempUnit(tempUnit === 'C' ? 'F' : 'C')}
                  style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#f87171', borderRadius: '4px', padding: '2px 6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                  title="Toggle °C / °F"
                >
                  °{tempUnit}
                </button>
              </div>
            </div>

            {/* Thermal Temperature Readout */}
            <div style={{ background: '#0f172a', padding: '10px 12px', borderRadius: '8px', marginBottom: '14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Thermometer size={20} color="#f87171" weight="bold" />
                <div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 500 }}>CPU Temperature</div>
                  <div style={{ fontSize: '16px', fontWeight: 800, color: '#f8fafc' }}>
                    {tempUnit === 'C' ? `${metrics?.cpu?.tempC || 38} °C` : `${metrics?.cpu?.tempF || 100} °F`}
                  </div>
                </div>
              </div>
              <span style={{ fontSize: '10px', fontWeight: 600, color: metrics?.cpu?.tempSource === 'hardware' ? '#34d399' : '#fbbf24', background: metrics?.cpu?.tempSource === 'hardware' ? 'rgba(52, 211, 153, 0.15)' : 'rgba(251, 191, 36, 0.15)', padding: '2px 8px', borderRadius: '12px' }}>
                {metrics?.cpu?.tempSource === 'hardware' ? '🟢 Live Hardware Sensor' : '⚡ Load Sensor Estimate'}
              </span>
            </div>

            <div style={{ fontSize: '13px', color: '#cbd5e1', fontWeight: 600, marginBottom: '4px' }}>{metrics?.cpu?.model}</div>
            <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '16px' }}>
              {metrics?.cpu?.coresCount || 0} Cores / Threads • Base: {metrics?.cpu?.maxClockMhz || 0} MHz
            </div>

            {/* Overall Load Progress Bar */}
            <div style={{ background: '#0f172a', borderRadius: '6px', height: '10px', overflow: 'hidden', marginBottom: '16px' }}>
              <div style={{ width: `${metrics?.cpu?.loadPercent || 0}%`, height: '100%', background: 'linear-gradient(90deg, #10b981, #f59e0b)', transition: 'width 0.3s ease' }} />
            </div>

            {/* Per Core utilization Breakdown */}
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', marginBottom: '8px' }}>Per-Core Utilization:</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '8px', maxHeight: '160px', overflowY: 'auto' }}>
              {metrics?.cpu?.cores?.map((core, idx) => (
                <div key={idx} style={{ background: '#0f172a', padding: '6px 8px', borderRadius: '6px', fontSize: '11px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#cbd5e1', marginBottom: '3px' }}>
                    <span>Core {core.coreIndex}</span>
                    <span style={{ color: '#10b981', fontWeight: 600 }}>{core.load}%</span>
                  </div>
                  <div style={{ background: '#1e293b', borderRadius: '3px', height: '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${core.load}%`, height: '100%', background: '#10b981' }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Card 2: Memory & RAM */}
          <div style={{ background: '#1e293b', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Lightning size={20} color="#3b82f6" />
                <span style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>System Memory (RAM)</span>
              </div>
              <span style={{ fontSize: '12px', fontWeight: 700, color: '#3b82f6', background: 'rgba(59, 130, 246, 0.15)', padding: '2px 8px', borderRadius: '4px' }}>
                {metrics?.memory?.percent || 0}% Used
              </span>
            </div>

            <div style={{ fontSize: '24px', fontWeight: 800, color: '#f8fafc', marginBottom: '4px' }}>
              {formatBytes(metrics?.memory?.used)} <span style={{ fontSize: '13px', color: '#64748b', fontWeight: 500 }}>/ {formatBytes(metrics?.memory?.total)}</span>
            </div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '16px' }}>
              Available Free Memory: {formatBytes(metrics?.memory?.free)}
            </div>

            <div style={{ background: '#0f172a', borderRadius: '6px', height: '10px', overflow: 'hidden' }}>
              <div style={{ width: `${metrics?.memory?.percent || 0}%`, height: '100%', background: '#3b82f6', transition: 'width 0.3s ease' }} />
            </div>
          </div>

          {/* Card 3: GPU & Graphics */}
          <div style={{ background: '#1e293b', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <DesktopTower size={20} color="#ec4899" />
              <span style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>GPU & Graphics Hardware</span>
            </div>

            <div style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc', marginBottom: '4px' }}>{metrics?.gpu?.name}</div>
            <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '12px' }}>Processor: {metrics?.gpu?.processor}</div>

            <div style={{ background: '#0f172a', padding: '12px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
              <div>
                <span style={{ color: '#64748b', display: 'block', fontSize: '11px' }}>VRAM Memory</span>
                <span style={{ color: '#f1f5f9', fontWeight: 600 }}>{formatBytes(metrics?.gpu?.vramBytes)}</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ color: '#64748b', display: 'block', fontSize: '11px' }}>Driver Version</span>
                <span style={{ color: '#f1f5f9', fontWeight: 600 }}>{metrics?.gpu?.driver}</span>
              </div>
            </div>
          </div>

          {/* Card 4: Storage & Disk Health */}
          <div style={{ background: '#1e293b', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <HardDrive size={20} color="#f59e0b" />
              <span style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>Storage & S.M.A.R.T. Health</span>
            </div>

            {metrics?.storage?.map((drive, i) => (
              <div key={i} style={{ background: '#0f172a', padding: '10px 12px', borderRadius: '8px', marginBottom: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
                <div>
                  <div style={{ fontWeight: 600, color: '#f1f5f9' }}>{drive.model}</div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>{drive.interface} • {formatBytes(drive.sizeBytes)}</div>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#10b981', background: 'rgba(16, 185, 129, 0.15)', padding: '2px 8px', borderRadius: '4px' }}>
                  {drive.status}
                </span>
              </div>
            ))}
          </div>

          {/* Card 5: Network Latency */}
          <div style={{ background: '#1e293b', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <WifiHigh size={20} color="#06b6d4" />
              <span style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>Network Latency</span>
            </div>

            <div style={{ fontSize: '24px', fontWeight: 800, color: '#06b6d4', marginBottom: '4px' }}>
              {metrics?.network?.pingMs !== null ? `${metrics.network.pingMs} ms` : 'Testing...'}
            </div>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>
              Active Network Adapters: {metrics?.network?.interfacesCount || 0}
            </div>
          </div>

          {/* Card 6: System Uptime */}
          <div style={{ background: '#1e293b', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <BatteryCharging size={20} color="#a855f7" />
              <span style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>System Uptime & OS</span>
            </div>

            <div style={{ fontSize: '18px', fontWeight: 700, color: '#a855f7', marginBottom: '4px' }}>
              {metrics?.system?.uptimeFormatted || 'N/A'}
            </div>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>
              Hostname: {metrics?.system?.hostname} ({metrics?.system?.arch})
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
