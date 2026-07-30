import React, { useEffect, useMemo, useState } from 'react';
import { ArrowsClockwise } from '@phosphor-icons/react/ArrowsClockwise';
import { CheckCircle } from '@phosphor-icons/react/CheckCircle';
import { Desktop } from '@phosphor-icons/react/Desktop';
import { Lightning } from '@phosphor-icons/react/Lightning';
import { PencilSimple } from '@phosphor-icons/react/PencilSimple';
import { Plus } from '@phosphor-icons/react/Plus';
import { Power } from '@phosphor-icons/react/Power';
import { Trash } from '@phosphor-icons/react/Trash';
import { WifiHigh } from '@phosphor-icons/react/WifiHigh';
import { X } from '@phosphor-icons/react/X';

const ipcRenderer = window.electron?.ipcRenderer;
const EMPTY_FORM = {
  id: '',
  name: '',
  mac: '',
  hostIp: '',
  broadcastIp: 'auto',
  port: '9',
  hostname: '',
  vendor: ''
};

const fieldStyle = {
  width: '100%',
  height: '38px',
  padding: '0 12px',
  color: 'var(--text-primary)',
  background: 'rgba(0, 0, 0, 0.24)',
  border: '1px solid var(--border-color)',
  borderRadius: '8px',
  fontSize: '13.5px'
};

const labelStyle = {
  display: 'block',
  fontSize: '11px',
  color: 'var(--text-secondary)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  marginBottom: '6px'
};

function getWakePresentation(wake) {
  const status = wake?.status || '';
  if (status === 'online') return { label: 'Online', color: '#22c55e', icon: <CheckCircle size={14} weight="fill" /> };
  if (status === 'timeout') return { label: 'Verification timed out', color: '#f59e0b', icon: <Lightning size={14} weight="fill" /> };
  if (status === 'sent-unverified' || status === 'sent') return { label: 'Packets sent', color: '#22c55e', icon: <Lightning size={14} weight="fill" /> };
  if (status === 'failed') return { label: 'Wake failed', color: '#ef4444', icon: <Lightning size={14} weight="fill" /> };
  if (['sending', 'checking', 'retrying', 'testing'].includes(status)) {
    return {
      label: status === 'testing' ? 'Testing...' : (wake?.message || 'Waking...'),
      color: '#ea580c',
      icon: <ArrowsClockwise size={14} weight="bold" className="animate-spin" />
    };
  }
  return { label: 'Wake and verify', color: '#ea580c', icon: <Lightning size={14} weight="fill" /> };
}

export default function WakeOnLan({ active = true }) {
  const [devices, setDevices] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [discoveredDevices, setDiscoveredDevices] = useState([]);
  const [discoveredSubnets, setDiscoveredSubnets] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [wakingStates, setWakingStates] = useState({});

  const editing = !!form.id;
  const savedMacs = useMemo(
    () => new Set(devices.map(device => String(device.mac || '').toUpperCase())),
    [devices]
  );

  const loadDevices = async () => {
    try {
      const data = await ipcRenderer?.invoke('wol:getDevices');
      setDevices(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Failed to load devices.');
    }
  };

  useEffect(() => {
    if (active) loadDevices();
  }, [active]);

  useEffect(() => {
    const handleProgress = (_event, progress) => {
      if (!progress?.deviceId) return;
      setWakingStates(previous => ({
        ...previous,
        [progress.deviceId]: {
          ...(previous[progress.deviceId] || {}),
          ...progress
        }
      }));
    };
    ipcRenderer?.on('wol:wake-progress', handleProgress);
    return () => ipcRenderer?.removeListener('wol:wake-progress', handleProgress);
  }, []);

  const updateForm = (key, value) => setForm(previous => ({ ...previous, [key]: value }));

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setError('');
  };

  const validateForm = () => {
    if (!form.name.trim()) return 'Please provide a device name.';
    const cleanMac = form.mac.replace(/[^a-fA-F0-9]/g, '');
    if (cleanMac.length !== 12) return 'MAC address must contain exactly 12 hexadecimal characters.';
    if (form.hostIp.trim() && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(form.hostIp.trim())) {
      return 'Host IP must be a valid IPv4 address.';
    }
    if (
      form.broadcastIp.trim().toLowerCase() !== 'auto' &&
      !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(form.broadcastIp.trim())
    ) {
      return 'Broadcast target must be a valid IPv4 address or "auto".';
    }
    const numericPort = Number(form.port);
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      return 'Port must be an integer from 1 to 65535.';
    }
    return '';
  };

  const handleSaveDevice = async event => {
    event.preventDefault();
    setError('');
    setMessage('');
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        mac: form.mac.trim(),
        hostIp: form.hostIp.trim(),
        broadcastIp: form.broadcastIp.trim() || 'auto',
        port: Number(form.port)
      };
      const response = await ipcRenderer?.invoke(editing ? 'wol:updateDevice' : 'wol:addDevice', payload);
      if (response?.success) {
        setMessage(editing ? `Updated "${payload.name}".` : `Registered "${payload.name}".`);
        setForm(EMPTY_FORM);
        await loadDevices();
      }
    } catch (err) {
      setError(err.message || `Failed to ${editing ? 'update' : 'add'} device.`);
    } finally {
      setSaving(false);
    }
  };

  const handleEditDevice = device => {
    setError('');
    setMessage('');
    setForm({
      id: device.id,
      name: device.name || '',
      mac: device.mac || '',
      hostIp: device.hostIp || '',
      broadcastIp: device.broadcastIp || device.ip || 'auto',
      port: String(device.port || 9),
      hostname: device.hostname || '',
      vendor: device.vendor || ''
    });
  };

  const handleDeleteDevice = async device => {
    if (!window.confirm(`Remove "${device.name}" from Wake-on-LAN?`)) return;
    setError('');
    setMessage('');
    try {
      await ipcRenderer?.invoke('wol:removeDevice', { id: device.id });
      if (form.id === device.id) setForm(EMPTY_FORM);
      setMessage(`Removed "${device.name}".`);
      await loadDevices();
    } catch (err) {
      setError(err.message || 'Failed to remove device.');
    }
  };

  const handleWakeDevice = async device => {
    setError('');
    setMessage('');
    setWakingStates(previous => ({
      ...previous,
      [device.id]: { status: 'sending', message: 'Sending packet bursts...' }
    }));
    try {
      const response = await ipcRenderer?.invoke('wol:wakeDevice', { id: device.id });
      if (!response?.success) {
        throw new Error(response?.error || 'Wake-on-LAN failed.');
      }
      const status = response.online === true
        ? 'online'
        : (response.online === false ? 'timeout' : 'sent-unverified');
      setWakingStates(previous => ({
        ...previous,
        [device.id]: { status, message: response.message || '' }
      }));
      setMessage(response.message || `Wake request sent to "${device.name}".`);
      await loadDevices();
    } catch (err) {
      setWakingStates(previous => ({
        ...previous,
        [device.id]: { status: 'failed', message: err.message || 'Wake failed.' }
      }));
      setError(err.message || 'Failed to wake device.');
    }
  };

  const handleTestDevice = async device => {
    setError('');
    setMessage('');
    setWakingStates(previous => ({
      ...previous,
      [device.id]: { status: 'testing', message: 'Testing configured packet routes...' }
    }));
    try {
      const response = await ipcRenderer?.invoke('wol:testDevice', { id: device.id });
      if (!response?.success) throw new Error(response?.error || 'Configuration test failed.');
      setWakingStates(previous => ({
        ...previous,
        [device.id]: {
          status: response.online === true ? 'online' : 'sent-unverified',
          message: response.message
        }
      }));
      setMessage(response.message);
    } catch (err) {
      setWakingStates(previous => ({
        ...previous,
        [device.id]: { status: 'failed', message: err.message || 'Configuration test failed.' }
      }));
      setError(err.message || 'Configuration test failed.');
    }
  };

  const handleScanNetwork = async () => {
    setScanning(true);
    setError('');
    setMessage('');
    setDiscoveredDevices([]);
    setDiscoveredSubnets([]);
    try {
      const response = await ipcRenderer?.invoke('wol:discoverDevices');
      if (!response?.success) throw new Error(response?.error || 'Subnet scan failed.');
      setDiscoveredDevices(response.devices || []);
      setDiscoveredSubnets(response.subnets || []);
      const truncatedCount = (response.subnets || []).filter(subnet => subnet.truncated).length;
      setMessage(
        `Discovered ${(response.devices || []).length} device(s) across ${(response.subnets || []).length} local subnet(s).` +
        (truncatedCount > 0 ? ` ${truncatedCount} large subnet scan(s) were capped for safety.` : '')
      );
    } catch (err) {
      setError(err.message || 'Subnet scan failed.');
    } finally {
      setScanning(false);
    }
  };

  const handleQuickAdd = async discovered => {
    const suggestedName = discovered.hostname || (
      discovered.vendor && discovered.vendor !== 'Unknown vendor'
        ? `${discovered.vendor} PC`
        : 'Network PC'
    );
    const enteredName = window.prompt(`Name the device at ${discovered.ip}:`, suggestedName);
    if (enteredName === null) return;
    const name = enteredName.trim();
    if (!name) {
      setError('Please provide a device name.');
      return;
    }

    setSaving(true);
    try {
      const response = await ipcRenderer?.invoke('wol:addDevice', {
        name,
        mac: discovered.mac,
        hostIp: discovered.ip,
        broadcastIp: discovered.broadcastIp || 'auto',
        port: 9,
        hostname: discovered.hostname || '',
        vendor: discovered.vendor || ''
      });
      if (response?.success) {
        setMessage(`Registered "${name}" with verified-host tracking enabled.`);
        await loadDevices();
        setDiscoveredDevices(previous => previous.filter(device => device.mac !== discovered.mac));
      }
    } catch (err) {
      setError(err.message || 'Failed to add discovered device.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: '40px', height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '28px' }}>
        <div style={{
          width: '58px',
          height: '58px',
          borderRadius: '16px',
          display: 'grid',
          placeItems: 'center',
          color: '#ea580c',
          background: 'rgba(234, 88, 12, 0.12)',
          border: '1px solid rgba(234, 88, 12, 0.25)'
        }}>
          <Power size={32} weight="duotone" />
        </div>
        <div>
          <h1 style={{ fontSize: '32px', marginBottom: '8px', background: 'linear-gradient(90deg, #ffd3b6, #ea580c)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Wake-on-LAN
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '15px', margin: 0 }}>
            Send packet bursts through every local adapter, retry automatically, and verify when a PC comes online.
          </p>
        </div>
      </div>

      {message && (
        <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'rgba(64, 138, 113, 0.12)', border: '1px solid rgba(64, 138, 113, 0.3)', color: '#86efac', marginBottom: '18px', fontSize: '13.5px' }}>
          {message}
        </div>
      )}
      {error && (
        <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', marginBottom: '18px', fontSize: '13.5px' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '28px', flexWrap: 'wrap', marginBottom: '36px' }}>
        <section style={{ flex: '2 1 560px', minWidth: 0 }}>
          <h2 style={{ fontSize: '20px', color: 'var(--text-primary)', fontWeight: 800, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Desktop size={20} weight="duotone" /> Configured Devices ({devices.length})
          </h2>

          {devices.length === 0 ? (
            <div style={{ border: '1px dashed var(--border-color)', borderRadius: '12px', padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', background: 'rgba(0, 0, 0, 0.1)' }}>
              No devices registered yet. Add one manually or scan your local subnets below.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '14px' }}>
              {devices.map(device => {
                const wake = wakingStates[device.id] || (
                  device.lastWakeStatus
                    ? { status: device.lastWakeStatus, message: '' }
                    : null
                );
                const presentation = getWakePresentation(wake);
                const busy = ['sending', 'checking', 'retrying', 'testing'].includes(wake?.status);
                return (
                  <article key={device.id} style={{ border: '1px solid var(--border-color)', borderRadius: '12px', background: 'var(--bg-panel)', padding: '17px', minHeight: '210px', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                      <div style={{ minWidth: 0 }}>
                        <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {device.name}
                        </h3>
                        <div style={{ color: 'var(--text-muted)', fontSize: '11.5px', marginTop: '3px' }}>
                          {[device.vendor, device.hostname].filter(Boolean).join(' • ')}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '2px' }}>
                        <button className="btn btn-secondary" style={{ padding: '5px', minWidth: 0 }} onClick={() => handleEditDevice(device)} title="Edit device">
                          <PencilSimple size={15} />
                        </button>
                        <button className="btn btn-secondary" style={{ padding: '5px', minWidth: 0 }} onClick={() => handleDeleteDevice(device)} title="Remove device">
                          <Trash size={15} />
                        </button>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gap: '6px', marginTop: '14px', fontSize: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                        <span style={{ color: 'var(--text-muted)' }}>MAC</span>
                        <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{device.mac}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Host IP</span>
                        <span style={{ color: device.hostIp ? 'var(--text-secondary)' : '#f59e0b', fontFamily: 'monospace' }}>{device.hostIp || 'Not set'}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Broadcast</span>
                        <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{device.broadcastIp || 'auto'}:{device.port}</span>
                      </div>
                    </div>

                    {wake?.message && (
                      <div style={{ marginTop: '10px', color: presentation.color, fontSize: '11.5px', lineHeight: 1.35 }}>
                        {wake.message}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '14px' }}>
                      <button className="btn btn-secondary" style={{ flex: '0 0 auto' }} disabled={busy} onClick={() => handleTestDevice(device)} title="Send a packet burst and perform one immediate online check">
                        Test
                      </button>
                      <button
                        className="btn btn-primary"
                        style={{ flex: 1, background: presentation.color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                        disabled={busy}
                        onClick={() => handleWakeDevice(device)}
                        title={device.hostIp ? 'Wake, retry, and verify this device' : 'Wake this device without online verification'}
                      >
                        {presentation.icon}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{presentation.label}</span>
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section style={{ flex: '1 1 320px', maxWidth: '430px', minWidth: '290px' }}>
          <h2 style={{ fontSize: '20px', color: 'var(--text-primary)', fontWeight: 800, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {editing ? <PencilSimple size={20} /> : <Plus size={20} />}
            {editing ? 'Edit Device' : 'Register Device'}
          </h2>
          <form onSubmit={handleSaveDevice} style={{ border: '1px solid var(--border-color)', borderRadius: '12px', background: 'var(--bg-panel)', padding: '22px', display: 'grid', gap: '14px' }}>
            <div>
              <label style={labelStyle}>Device Name</label>
              <input style={fieldStyle} value={form.name} onChange={event => updateForm('name', event.target.value)} placeholder="Gaming PC" disabled={saving} />
            </div>
            <div>
              <label style={labelStyle}>MAC Address</label>
              <input style={{ ...fieldStyle, fontFamily: 'monospace' }} value={form.mac} onChange={event => updateForm('mac', event.target.value)} placeholder="AA:BB:CC:DD:EE:FF" disabled={saving} />
            </div>
            <div>
              <label style={labelStyle}>Host IP <span style={{ color: 'var(--text-muted)', textTransform: 'none' }}>(for verification)</span></label>
              <input style={{ ...fieldStyle, fontFamily: 'monospace' }} value={form.hostIp} onChange={event => updateForm('hostIp', event.target.value)} placeholder="192.168.1.50" disabled={saving} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(90px, 1fr)', gap: '10px' }}>
              <div>
                <label style={labelStyle}>Broadcast Target</label>
                <input style={{ ...fieldStyle, fontFamily: 'monospace' }} value={form.broadcastIp} onChange={event => updateForm('broadcastIp', event.target.value)} placeholder="auto" disabled={saving} />
              </div>
              <div>
                <label style={labelStyle}>UDP Port</label>
                <input type="number" min="1" max="65535" style={fieldStyle} value={form.port} onChange={event => updateForm('port', event.target.value)} disabled={saving} />
              </div>
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '11.5px', lineHeight: 1.45 }}>
              “auto” sends three packets through every active IPv4 adapter using its calculated directed-broadcast address.
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              {editing && (
                <button type="button" className="btn btn-secondary" onClick={resetForm} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <X size={14} /> Cancel
                </button>
              )}
              <button type="submit" className="btn btn-primary" disabled={saving} style={{ flex: 1 }}>
                {saving ? 'Saving...' : (editing ? 'Save Changes' : 'Add Device')}
              </button>
            </div>
          </form>
        </section>
      </div>

      <section style={{ border: '1px solid rgba(64, 138, 113, 0.28)', borderRadius: '12px', background: 'linear-gradient(110deg, rgba(40, 90, 72, 0.15), rgba(9, 20, 19, 0.05))', padding: '22px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ fontSize: '18px', color: 'var(--text-primary)', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
              <WifiHigh size={20} weight="duotone" /> Subnet-aware Discovery
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '12.5px', margin: '5px 0 0' }}>
              Uses each adapter’s real netmask, then enriches neighbors with hostname and known adapter vendor.
            </p>
          </div>
          <button className="btn btn-primary" onClick={handleScanNetwork} disabled={scanning} style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
            <ArrowsClockwise size={15} weight="bold" className={scanning ? 'animate-spin' : ''} />
            {scanning ? 'Scanning...' : 'Scan Local Subnets'}
          </button>
        </div>

        {discoveredSubnets.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px', marginTop: '14px' }}>
            {discoveredSubnets.map(subnet => (
              <span key={`${subnet.name}:${subnet.subnet}`} style={{ padding: '5px 9px', borderRadius: '999px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.22)', color: '#93c5fd', fontSize: '11px' }}>
                {subnet.name}: {subnet.subnet} • {subnet.scannedHosts}/{subnet.availableHosts} hosts
              </span>
            ))}
          </div>
        )}

        {discoveredDevices.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '10px', marginTop: '16px' }}>
            {discoveredDevices.map(device => {
              const alreadySaved = savedMacs.has(String(device.mac || '').toUpperCase());
              return (
                <div key={device.mac} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'rgba(0, 0, 0, 0.2)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '11px 13px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '13.5px', fontWeight: 800, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {device.hostname || device.ip}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '3px' }}>
                      {device.ip} • {device.mac}
                    </div>
                    <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {device.vendor} • {device.subnet || device.interfaceName}
                    </div>
                  </div>
                  <button className="btn btn-secondary" disabled={alreadySaved || saving} onClick={() => handleQuickAdd(device)} style={{ whiteSpace: 'nowrap' }}>
                    {alreadySaved ? 'Added' : 'Add PC'}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          !scanning && (
            <div style={{ border: '1px dashed rgba(255,255,255,0.06)', borderRadius: '8px', padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12.5px', marginTop: '16px' }}>
              No discovery results yet.
            </div>
          )
        )}
      </section>
    </div>
  );
}
