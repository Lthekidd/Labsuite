import React, { useCallback, useEffect, useMemo, useState } from 'react';

const ipcRenderer = window.electron?.ipcRenderer;

const EMPTY_DISCOVERY = {
  supported: true,
  vmwareInstalled: false,
  vmrunPath: '',
  directDeployAvailable: false,
  adapters: [],
  vms: [],
  warnings: []
};

const EMPTY_STATE = {
  server: {},
  guests: [],
  enrollments: []
};

const cardStyle = {
  background: 'rgba(255, 255, 255, 0.025)',
  border: '1px solid var(--border-color)',
  borderRadius: '12px'
};

const inputStyle = {
  width: '100%',
  border: '1px solid var(--border-color)',
  borderRadius: '8px',
  background: 'rgba(0, 0, 0, 0.24)',
  color: 'var(--text-primary)',
  padding: '10px 12px',
  fontFamily: 'var(--font-sans)',
  fontSize: '13px',
  outline: 'none'
};

async function invoke(channel, payload) {
  if (!ipcRenderer) throw new Error('LabSuite VM Protect is unavailable in this window.');
  return payload === undefined
    ? ipcRenderer.invoke(channel)
    : ipcRenderer.invoke(channel, payload);
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === 'object') return Object.values(value).filter(Boolean);
  return [];
}

function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}

function getVmId(vm = {}) {
  return String(vm.vmId || vm.id || vm.vmxPath || vm.path || vm.name || vm.vmName || 'vm');
}

function getVmName(vm = {}) {
  return vm.name || vm.vmName || vm.displayName || getPathLeaf(vm.vmxPath || vm.path) || 'VMware virtual machine';
}

function getVmPath(vm = {}) {
  return vm.vmxPath || vm.path || vm.configPath || '';
}

function getPathLeaf(value) {
  const leaf = String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
  return leaf.replace(/\.vmx$/i, '');
}

function isVmRunning(vm = {}) {
  if (typeof vm.running === 'boolean') return vm.running;
  if (typeof vm.isRunning === 'boolean') return vm.isRunning;
  const state = String(vm.powerState || vm.state || vm.status || '').toLowerCase();
  return ['running', 'on', 'poweredon', 'powered_on', 'started'].includes(state.replace(/\s+/g, ''));
}

function isWindowsGuest(vm = {}) {
  const family = String(vm.osFamily || vm.platform || '').toLowerCase();
  const guestOS = String(vm.guestOS || vm.guestOs || '').toLowerCase();
  return family === 'windows' || /(^|[^a-z])win(?:dows|net|vista|xp|7|8|9|10|11|12)/i.test(guestOS);
}

function isServerRunning(server = {}) {
  if (typeof server.running === 'boolean') return server.running;
  if (typeof server.listening === 'boolean') return server.listening;
  if (typeof server.enabled === 'boolean') return server.enabled;
  const status = String(server.status || server.state || '').toLowerCase();
  return ['running', 'listening', 'online', 'started'].includes(status);
}

function sameMachine(vm = {}, record = {}) {
  const vmId = String(vm.vmId || vm.id || '');
  const recordId = String(record.vmId || record.sourceVmId || record.id || '');
  if (vmId && recordId && vmId === recordId) return true;

  const vmPath = normalizePath(getVmPath(vm));
  const recordPath = normalizePath(record.vmxPath || record.vmPath || record.sourceVmxPath);
  if (vmPath && recordPath && vmPath === recordPath) return true;

  if (!vmId && !recordId && !vmPath && !recordPath) {
    return getVmName(vm).toLowerCase() === String(record.vmName || record.name || '').toLowerCase();
  }
  return false;
}

function formatRelativeTime(value) {
  if (!value) return '';
  const timestamp = Number(value) || Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 10000) return 'just now';
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatExpiry(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${unit}`;
}

function Badge({ tone = 'neutral', children }) {
  const tones = {
    good: { color: '#86efac', background: 'rgba(34, 197, 94, 0.10)', border: 'rgba(34, 197, 94, 0.22)' },
    warning: { color: '#fbbf24', background: 'rgba(245, 158, 11, 0.10)', border: 'rgba(245, 158, 11, 0.22)' },
    neutral: { color: 'var(--text-secondary)', background: 'rgba(255, 255, 255, 0.04)', border: 'var(--border-color)' },
    quiet: { color: 'var(--text-muted)', background: 'rgba(255, 255, 255, 0.025)', border: 'var(--border-color)' }
  };
  const selected = tones[tone] || tones.neutral;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '5px 8px',
      borderRadius: '999px',
      color: selected.color,
      background: selected.background,
      border: `1px solid ${selected.border}`,
      fontSize: '11px',
      lineHeight: 1,
      fontWeight: 750,
      whiteSpace: 'nowrap'
    }}>
      {children}
    </span>
  );
}

function StatusDot({ good }) {
  return (
    <span aria-hidden="true" style={{
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      background: good ? '#4ade80' : '#71717a',
      boxShadow: good ? '0 0 10px rgba(74, 222, 128, 0.55)' : 'none',
      flex: '0 0 auto'
    }} />
  );
}

function SummaryCard({ label, title, detail, good, action }) {
  return (
    <div style={{ ...cardStyle, minHeight: '118px', padding: '16px 18px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '12px' }}>
      <div>
        <div style={{ color: 'var(--text-muted)', fontSize: '10.5px', fontWeight: 800, letterSpacing: '0.9px', textTransform: 'uppercase' }}>{label}</div>
        <div style={{ marginTop: '9px', display: 'flex', alignItems: 'center', gap: '9px', color: 'var(--text-primary)', fontSize: '15px', fontWeight: 750 }}>
          <StatusDot good={good} />
          {title}
        </div>
        {detail && <div style={{ marginTop: '6px', color: 'var(--text-muted)', fontSize: '12px', lineHeight: 1.45 }}>{detail}</div>}
      </div>
      {action}
    </div>
  );
}

export default function VMProtect() {
  const [discovery, setDiscovery] = useState(EMPTY_DISCOVERY);
  const [vmState, setVmState] = useState(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [helperResult, setHelperResult] = useState(null);
  const [credentialVm, setCredentialVm] = useState(null);
  const [credentials, setCredentials] = useState({ username: '', password: '' });

  const guests = useMemo(() => asArray(vmState.guests), [vmState.guests]);
  const enrollments = useMemo(() => asArray(vmState.enrollments), [vmState.enrollments]);
  const vms = useMemo(() => asArray(discovery.vms), [discovery.vms]);
  const unmatchedGuests = useMemo(
    () => guests.filter(guest => !vms.some(vm => sameMachine(vm, guest))),
    [guests, vms]
  );
  const unmatchedEnrollments = useMemo(
    () => enrollments.filter(enrollment => !vms.some(vm => sameMachine(vm, enrollment))),
    [enrollments, vms]
  );
  const serverRunning = isServerRunning(vmState.server);
  const receiverHealthy = serverRunning && vmState.server?.firewall?.ok !== false;
  const receiverRequired = serverRunning && (guests.length > 0 || enrollments.length > 0);

  const loadEverything = useCallback(async ({ quiet = false } = {}) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const [discoveryResult, stateResult] = await Promise.allSettled([
        invoke('vmProtect:discover'),
        invoke('vmProtect:getState')
      ]);
      const failures = [];
      const nextDiscovery = discoveryResult.status === 'fulfilled' ? discoveryResult.value : null;
      const nextState = stateResult.status === 'fulfilled' ? stateResult.value : null;
      if (discoveryResult.status === 'rejected') failures.push(discoveryResult.reason?.message || 'VMware discovery failed.');
      if (stateResult.status === 'rejected') failures.push(stateResult.reason?.message || 'The VM receiver state is unavailable.');
      if (nextDiscovery) {
        setDiscovery({
          ...EMPTY_DISCOVERY,
          ...nextDiscovery,
          vms: asArray(nextDiscovery.vms),
          adapters: asArray(nextDiscovery.adapters),
          warnings: asArray(nextDiscovery.warnings)
        });
      }
      if (nextState) {
        if (nextState.success === false) {
          failures.push(nextState.error || 'The VM receiver state is unavailable.');
        } else {
          setVmState({
            ...EMPTY_STATE,
            ...nextState,
            guests: asArray(nextState.guests),
            enrollments: asArray(nextState.enrollments)
          });
        }
      }
      if (failures.length) setError(failures.join(' '));
    } catch (err) {
      setError(err.message || 'Could not inspect VMware virtual machines.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadEverything();
  }, [loadEverything]);

  useEffect(() => {
    if (!ipcRenderer) return undefined;
    const handleState = (event, payload) => {
      const nextState = payload || (event?.server || event?.guests || event?.enrollments ? event : null);
      if (!nextState) return;
      setVmState(previous => ({
        ...previous,
        ...nextState,
        server: nextState.server ? { ...previous.server, ...nextState.server } : previous.server,
        guests: nextState.guests === undefined ? previous.guests : asArray(nextState.guests),
        enrollments: nextState.enrollments === undefined ? previous.enrollments : asArray(nextState.enrollments)
      }));
    };
    ipcRenderer.on('vmProtect:state', handleState);
    return () => ipcRenderer.removeListener('vmProtect:state', handleState);
  }, []);

  useEffect(() => {
    if (!credentialVm) return undefined;
    const handleKeyDown = event => {
      if (event.key === 'Escape' && !busyKey) closeCredentialModal();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [credentialVm, busyKey]);

  const clearNotices = () => {
    setError('');
    setMessage('');
    setHelperResult(null);
  };

  const reloadState = async () => {
    const nextState = await invoke('vmProtect:getState');
    if (nextState?.success === false) throw new Error(nextState.error || 'The VM receiver state is unavailable.');
    if (nextState) {
      setVmState({
        ...EMPTY_STATE,
        ...nextState,
        guests: asArray(nextState.guests),
        enrollments: asArray(nextState.enrollments)
      });
    }
  };

  const ensureReceiver = async () => {
    if (serverRunning) return;
    const result = await invoke('vmProtect:startServer');
    if (result?.success === false) throw new Error(result.error || 'Could not start the VM receiver.');
    if (result?.server || result?.guests || result?.enrollments) {
      setVmState(previous => ({ ...previous, ...result }));
    } else {
      await reloadState();
    }
  };

  const toggleReceiver = async () => {
    const key = 'receiver';
    setBusyKey(key);
    clearNotices();
    try {
      const channel = serverRunning ? 'vmProtect:stopServer' : 'vmProtect:startServer';
      const result = await invoke(channel);
      if (result?.success === false) throw new Error(result.error || `Could not ${serverRunning ? 'stop' : 'start'} the VM receiver.`);
      await reloadState();
      setMessage(serverRunning ? 'VM receiver stopped.' : 'VM receiver is ready for guest helpers.');
    } catch (err) {
      setError(err.message || 'Could not change the VM receiver state.');
    } finally {
      setBusyKey('');
    }
  };

  const createPortableHelper = async vm => {
    const key = `create:${getVmId(vm)}`;
    setBusyKey(key);
    clearNotices();
    try {
      await ensureReceiver();
      const result = await invoke('vmProtect:createHelper', {
        vmId: getVmId(vm),
        vmName: getVmName(vm),
        vmxPath: getVmPath(vm),
        vmwareUuid: vm.vmwareUuid || ''
      });
      if (!result || result.success === false) throw new Error(result?.error || 'Could not create the portable helper.');
      if (result.canceled) return;
      setHelperResult({
        vmName: getVmName(vm),
        path: result.path || '',
        expiresAt: result.expiresAt || '',
        method: result.method || 'portable'
      });
      setMessage(`Portable helper created for ${getVmName(vm)}.`);
      await reloadState();
    } catch (err) {
      setError(err.message || 'Could not create the portable helper.');
    } finally {
      setBusyKey('');
    }
  };

  const openCredentialModal = vm => {
    clearNotices();
    setCredentials({ username: '', password: '' });
    setCredentialVm(vm);
  };

  const closeCredentialModal = () => {
    if (busyKey) return;
    setCredentialVm(null);
    setCredentials({ username: '', password: '' });
  };

  const deployHelper = async event => {
    event.preventDefault();
    if (!credentialVm || !credentials.username.trim() || !credentials.password) return;
    const vm = credentialVm;
    const key = `deploy:${getVmId(vm)}`;
    setBusyKey(key);
    setError('');
    setMessage('');
    setHelperResult(null);
    try {
      await ensureReceiver();
      const result = await invoke('vmProtect:deployHelper', {
        vmId: getVmId(vm),
        vmName: getVmName(vm),
        vmxPath: getVmPath(vm),
        vmwareUuid: vm.vmwareUuid || '',
        username: credentials.username.trim(),
        password: credentials.password
      });
      if (!result || result.success === false) throw new Error(result?.error || 'LabSuite could not install the helper in this VM.');
      setCredentialVm(null);
      setCredentials({ username: '', password: '' });
      setMessage(result.message || `Helper installed in ${getVmName(vm)}. Finish the pairing prompt inside the VM.`);
      await reloadState();
    } catch (err) {
      setCredentials(previous => ({ ...previous, password: '' }));
      setError(err.message || 'LabSuite could not install the helper in this VM.');
    } finally {
      setBusyKey('');
    }
  };

  const forgetGuest = async guest => {
    const guestId = guest.guestId || guest.deviceId || guest.id;
    if (!guestId) return;
    const confirmed = window.confirm(`Forget ${guest.vmName || guest.name || 'this VM'}? Its existing backup history will be kept, but the helper will stop connecting.`);
    if (!confirmed) return;
    const key = `forget:${guestId}`;
    setBusyKey(key);
    clearNotices();
    try {
      const result = await invoke('vmProtect:forgetGuest', { guestId });
      if (result?.success === false) throw new Error(result.error || 'Could not forget this VM.');
      setVmState(previous => ({
        ...previous,
        guests: asArray(previous.guests).filter(item => (item.guestId || item.deviceId || item.id) !== guestId)
      }));
      setMessage(`${guest.vmName || guest.name || 'VM'} is no longer paired.`);
    } catch (err) {
      setError(err.message || 'Could not forget this VM.');
    } finally {
      setBusyKey('');
    }
  };

  const respondToEnrollment = async (enrollment, accepted) => {
    const enrollmentId = enrollment.enrollmentId || enrollment.id;
    if (!enrollmentId) return;
    const key = `${accepted ? 'approve' : 'reject'}:${enrollmentId}`;
    setBusyKey(key);
    clearNotices();
    try {
      const result = await invoke(
        accepted ? 'vmProtect:approveEnrollment' : 'vmProtect:rejectEnrollment',
        { enrollmentId }
      );
      if (!result || result.success === false) {
        throw new Error(result?.error || `Could not ${accepted ? 'approve' : 'reject'} this VM.`);
      }
      await reloadState();
      setMessage(accepted
        ? `${enrollment.name || enrollment.vmName || 'VM'} was approved. The helper will finish pairing automatically.`
        : String(enrollment.state || '').toLowerCase() === 'invited' ? 'The unused VM invitation was canceled.' : 'The VM pairing request was rejected.');
    } catch (err) {
      setError(err.message || 'Could not respond to the VM pairing request.');
    } finally {
      setBusyKey('');
    }
  };

  const serverDetail = useMemo(() => {
    if (!serverRunning) return 'Start it when you want VMs to pair or send protected files.';
    const server = vmState.server || {};
    const endpoint = server.url || server.address || server.host || '';
    const port = server.port ? `${endpoint ? ':' : 'Port '}${server.port}` : '';
    if (server.firewall?.attempted && server.firewall.ok === false) {
      return server.firewall.message || `Listening on ${endpoint}${port}, but Windows Firewall may block the VM.`;
    }
    return endpoint || port ? `Listening on ${endpoint}${port}` : 'Listening securely for paired VMs.';
  }, [serverRunning, vmState.server]);

  const pairedOnline = guests.filter(guest => guest.connected || guest.online || String(guest.status || '').toLowerCase() === 'online').length;
  const adapterCount = asArray(discovery.adapters).length;
  const warnings = asArray(discovery.warnings).map(item => typeof item === 'string' ? item : (item.message || item.error || String(item)));

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px', boxSizing: 'border-box' }}>
      <div style={{ width: '100%', maxWidth: '1120px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px', paddingBottom: '28px' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '18px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
              <div aria-hidden="true" style={{ width: '36px', height: '36px', borderRadius: '10px', display: 'grid', placeItems: 'center', background: 'rgba(64, 138, 113, 0.18)', border: '1px solid rgba(176, 228, 204, 0.16)', color: 'var(--accent-secondary)', fontSize: '18px' }}>▣</div>
              <h1 style={{ margin: 0, fontSize: '26px' }}>VM Protect</h1>
            </div>
            <p style={{ margin: '7px 0 0 47px', color: 'var(--text-secondary)', fontSize: '13px' }}>
              Protect individual files inside your VMware virtual machines.
            </p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={() => loadEverything({ quiet: true })} disabled={loading || refreshing || !!busyKey} aria-label="Refresh detected virtual machines">
            <span aria-hidden="true">↻</span>
            {refreshing ? 'Scanning…' : 'Refresh'}
          </button>
        </header>

        <section aria-label="VM Protect privacy" style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '13px',
          padding: '15px 17px',
          borderRadius: '11px',
          background: 'linear-gradient(100deg, rgba(64, 138, 113, 0.17), rgba(64, 138, 113, 0.06))',
          border: '1px solid rgba(176, 228, 204, 0.14)'
        }}>
          <div aria-hidden="true" style={{ color: '#86efac', fontSize: '18px', lineHeight: 1 }}>●</div>
          <div>
            <div style={{ color: 'var(--text-primary)', fontSize: '13px', fontWeight: 750 }}>No Google login inside your VM</div>
            <div style={{ marginTop: '4px', color: 'var(--text-secondary)', fontSize: '12.5px', lineHeight: 1.5 }}>
              Google Drive stays connected only to LabSuite on this PC. The guest helper never receives your Google password, Drive token, vault password, or encryption keys.
            </div>
          </div>
        </section>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '12px' }}>
          <SummaryCard
            label="Secure receiver"
            title={serverRunning ? receiverHealthy ? 'Ready' : 'Firewall check needed' : 'Stopped'}
            detail={serverDetail}
            good={receiverHealthy}
            action={(
              <button
                className="btn btn-secondary"
                type="button"
                onClick={toggleReceiver}
                disabled={!!busyKey || receiverRequired}
                title={receiverRequired ? 'The receiver stays on while a VM is paired or awaiting approval so changes are not missed.' : ''}
                style={{ alignSelf: 'flex-start', padding: '7px 11px', fontSize: '12px' }}
              >
                {busyKey === 'receiver' ? 'Working…' : receiverRequired ? 'Required by paired VMs' : serverRunning ? 'Stop receiver' : 'Start receiver'}
              </button>
            )}
          />
          <SummaryCard
            label="VMware"
            title={discovery.vmwareInstalled ? 'Detected' : 'Not detected'}
            detail={discovery.vmwareInstalled
              ? discovery.directDeployAvailable ? 'Direct helper install is available.' : 'Portable helper mode is available.'
              : 'Install VMware Workstation or use a portable helper in a reachable VM.'}
            good={!!discovery.vmwareInstalled}
          />
          <SummaryCard
            label="Protected guests"
            title={`${guests.length} paired`}
            detail={guests.length ? `${pairedOnline} online now · ${guests.length - pairedOnline} offline` : 'Pair a VM once, then protect files without signing in again.'}
            good={guests.length > 0}
          />
        </div>

        <div aria-live="polite" aria-atomic="true">
          {error && (
            <div role="alert" style={{ padding: '12px 14px', borderRadius: '9px', color: '#fca5a5', background: 'rgba(239, 68, 68, 0.09)', border: '1px solid rgba(239, 68, 68, 0.22)', fontSize: '12.5px', lineHeight: 1.5 }}>
              {error}
            </div>
          )}
          {!error && message && (
            <div style={{ padding: '12px 14px', borderRadius: '9px', color: '#86efac', background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.20)', fontSize: '12.5px', lineHeight: 1.5 }}>
              {message}
            </div>
          )}
        </div>

        {helperResult && (
          <section style={{ ...cardStyle, padding: '16px 18px', borderColor: 'rgba(176, 228, 204, 0.18)' }}>
            <div style={{ color: 'var(--text-primary)', fontSize: '13px', fontWeight: 750 }}>Portable helper for {helperResult.vmName}</div>
            <div style={{ marginTop: '6px', color: 'var(--text-secondary)', fontSize: '12.5px', lineHeight: 1.5 }}>
              Copy this helper into the VM and run it. LabSuite will guide you through the one-time pairing confirmation.
            </div>
            {helperResult.path && (
              <div title={helperResult.path} style={{ marginTop: '10px', padding: '9px 11px', borderRadius: '7px', background: 'rgba(0, 0, 0, 0.24)', color: 'var(--text-primary)', fontFamily: 'Consolas, monospace', fontSize: '11.5px', overflowWrap: 'anywhere', userSelect: 'text' }}>
                {helperResult.path}
              </div>
            )}
            {formatExpiry(helperResult.expiresAt) && (
              <div style={{ marginTop: '8px', color: 'var(--text-muted)', fontSize: '11.5px' }}>Pairing invitation expires {formatExpiry(helperResult.expiresAt)}.</div>
            )}
          </section>
        )}

        {warnings.length > 0 && (
          <section style={{ padding: '12px 15px', borderRadius: '9px', background: 'rgba(245, 158, 11, 0.065)', border: '1px solid rgba(245, 158, 11, 0.17)' }}>
            {warnings.map((warning, index) => (
              <div key={`${warning}:${index}`} style={{ color: '#fbbf24', fontSize: '12px', lineHeight: 1.5 }}>{warning}</div>
            ))}
          </section>
        )}

        <section style={{ ...cardStyle, overflow: 'hidden' }}>
          <div style={{ padding: '18px 19px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '18px', flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '17px' }}>Detected virtual machines</h2>
              <div style={{ marginTop: '5px', color: 'var(--text-muted)', fontSize: '12px' }}>
                {loading ? 'Looking for VMware virtual machines…' : `${vms.length} virtual machine${vms.length === 1 ? '' : 's'} found on this PC`}
              </div>
            </div>
            <div style={{ maxWidth: '500px', color: 'var(--text-secondary)', fontSize: '11.8px', lineHeight: 1.5 }}>
              A running Windows VM can receive the helper directly when VMware Tools is available. LabSuite asks for guest credentials once and never stores them. After pairing, credentials are not needed again.
            </div>
          </div>

          {loading ? (
            <div style={{ padding: '54px 24px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>Scanning VMware configuration…</div>
          ) : vms.length === 0 ? (
            <div style={{ padding: '50px 24px', textAlign: 'center' }}>
              <div aria-hidden="true" style={{ width: '50px', height: '50px', margin: '0 auto', display: 'grid', placeItems: 'center', borderRadius: '14px', background: 'rgba(255, 255, 255, 0.035)', border: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '23px' }}>▣</div>
              <div style={{ marginTop: '15px', color: 'var(--text-primary)', fontSize: '14px', fontWeight: 700 }}>
                {discovery.vmwareInstalled ? 'No VMware VMs found yet' : 'VMware was not found on this PC'}
              </div>
              <div style={{ margin: '7px auto 0', maxWidth: '520px', color: 'var(--text-muted)', fontSize: '12.5px', lineHeight: 1.55 }}>
                {discovery.vmwareInstalled
                  ? 'Start or open a registered VM, then refresh this page. You can still use a portable helper if the VM is stored elsewhere.'
                  : 'Install VMware Workstation to enable automatic discovery and direct deployment. Portable helpers can still pair over the network.'}
              </div>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => createPortableHelper({ id: 'manual', name: 'Windows VM', vmxPath: '' })}
                disabled={!!busyKey}
                style={{ marginTop: '16px', padding: '8px 13px', fontSize: '12px' }}
              >
                {busyKey === 'create:manual' ? 'Creating…' : 'Create portable helper'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: '12px', padding: '14px' }}>
              {vms.map(vm => {
                const id = getVmId(vm);
                const name = getVmName(vm);
                const path = getVmPath(vm);
                const running = isVmRunning(vm);
                const guest = guests.find(item => sameMachine(vm, item));
                const enrollment = enrollments.find(item => sameMachine(vm, item));
                const enrollmentState = String(enrollment?.state || 'pending').toLowerCase();
                const enrollmentFiles = asArray(enrollment?.selectedFiles);
                const paired = !!guest;
                const guestOnline = !!(guest && (guest.connected || guest.online || String(guest.status || '').toLowerCase() === 'online'));
                const selectedFileCount = guest
                  ? Number(guest.selectedFileCount) || asArray(guest.selectedFiles || guest.files).length
                  : 0;
                const backupStatus = guest?.backupStatus || 'waiting';
                const canDirectDeploy = running && isWindowsGuest(vm) && discovery.directDeployAvailable && vm.directDeployAvailable !== false;
                const actionKey = canDirectDeploy ? `deploy:${id}` : `create:${id}`;
                const lastSeen = guest && formatRelativeTime(guest.lastSeen || guest.lastSeenAt || guest.updatedAt);

                return (
                  <article key={id} style={{ ...cardStyle, padding: '16px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                      <div style={{ display: 'flex', gap: '12px', minWidth: 0 }}>
                        <div aria-hidden="true" style={{ width: '40px', height: '40px', flex: '0 0 auto', display: 'grid', placeItems: 'center', borderRadius: '10px', background: paired ? 'rgba(34, 197, 94, 0.10)' : 'rgba(255, 255, 255, 0.035)', border: paired ? '1px solid rgba(34, 197, 94, 0.18)' : '1px solid var(--border-color)', color: paired ? '#86efac' : 'var(--text-secondary)', fontSize: '18px' }}>▣</div>
                        <div style={{ minWidth: 0 }}>
                          <div title={name} style={{ color: 'var(--text-primary)', fontSize: '14px', fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                          {path && <div title={path} style={{ marginTop: '5px', color: 'var(--text-muted)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'text' }}>{path}</div>}
                        </div>
                      </div>
                      <Badge tone={running ? 'good' : 'quiet'}><StatusDot good={running} />{running ? 'Running' : 'Stopped'}</Badge>
                    </div>

                    <div style={{ marginTop: '15px', minHeight: '50px', padding: '10px 11px', borderRadius: '8px', background: 'rgba(0, 0, 0, 0.14)', border: '1px solid rgba(255, 255, 255, 0.04)' }}>
                      {paired ? (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                            <Badge tone={backupStatus === 'protected' ? 'good' : backupStatus === 'error' ? 'warning' : 'neutral'}>
                              {backupStatus === 'protected'
                                ? `${selectedFileCount} file${selectedFileCount === 1 ? '' : 's'} protected`
                                : backupStatus === 'error' ? 'Backup needs attention' : selectedFileCount > 0 ? `${selectedFileCount} selected` : 'Paired'}
                            </Badge>
                            <span style={{ color: guestOnline ? '#86efac' : 'var(--text-muted)', fontSize: '11px', fontWeight: 700 }}>{guestOnline ? 'Connected' : 'Offline'}</span>
                          </div>
                          <div style={{ marginTop: '7px', color: 'var(--text-muted)', fontSize: '11.5px' }}>
                            {backupStatus === 'error'
                              ? guest.backupError || 'The host backup engine will retry this file.'
                              : backupStatus === 'protected'
                                ? `Encrypted backup completed ${formatRelativeTime(guest.lastBackupAt)}`
                                : selectedFileCount === 0
                              ? 'Choose files in the VM helper to begin protection.'
                              : guest.lastUploadAt ? 'Verified file received; encrypted backup is queued.' : 'Waiting for the first verified file upload.'}
                          </div>
                          {enrollmentState !== 'invited' && (
                            <div title={enrollmentFiles.join('\n')} style={{ marginTop: '5px', color: 'var(--text-secondary)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              Requests {enrollmentFiles.length} file{enrollmentFiles.length === 1 ? '' : 's'}{enrollmentFiles[0] ? ` — ${enrollmentFiles[0]}` : ''}
                            </div>
                          )}
                        </>
                      ) : enrollment ? (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                            <Badge tone={enrollmentState === 'approved' ? 'good' : 'warning'}>
                              {enrollmentState === 'invited' ? 'Helper ready' : enrollmentState === 'approved' ? 'Approved' : 'Approval required'}
                            </Badge>
                            <span style={{ color: '#fbbf24', fontFamily: 'Consolas, monospace', fontSize: '16px', fontWeight: 800, letterSpacing: '2px' }}>
                              {enrollment.pairingCode || '------'}
                            </span>
                          </div>
                          <div style={{ marginTop: '7px', color: 'var(--text-muted)', fontSize: '11.5px' }}>
                            {enrollmentState === 'invited'
                              ? 'Run the helper inside this VM. The same code will appear there.'
                              : enrollmentState === 'approved' ? 'The helper is finishing secure enrollment.' : 'Approve only if this code matches the helper inside the VM.'}
                          </div>
                        </>
                      ) : (
                        <>
                          <div style={{ color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 650 }}>Not protected yet</div>
                          <div style={{ marginTop: '5px', color: 'var(--text-muted)', fontSize: '11.5px', lineHeight: 1.4 }}>
                            {canDirectDeploy
                              ? 'VMware Tools can deliver the helper to this running VM.'
                              : running ? 'Create a portable helper and run it inside this VM.' : 'Start the VM for direct install, or create a portable helper now.'}
                          </div>
                        </>
                      )}
                    </div>

                    <div style={{ marginTop: '13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                      <div style={{ color: 'var(--text-muted)', fontSize: '10.8px' }}>
                        {paired
                          ? `${formatBytes(guest.stagingBytes)} in protected version staging`
                          : adapterCount > 0 ? `${adapterCount} VMware network adapter${adapterCount === 1 ? '' : 's'} available` : 'Secure outbound pairing'}
                      </div>
                      {paired ? (
                        <button
                          className="btn btn-secondary"
                          type="button"
                          onClick={() => forgetGuest(guest)}
                          disabled={!!busyKey}
                          style={{ padding: '7px 11px', fontSize: '12px' }}
                          aria-label={`Forget pairing with ${name}`}
                        >
                          {busyKey === `forget:${guest.guestId || guest.deviceId || guest.id}` ? 'Forgetting…' : 'Forget'}
                        </button>
                      ) : enrollment ? (
                        <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <button
                            className="btn btn-secondary"
                            type="button"
                            onClick={() => respondToEnrollment(enrollment, false)}
                            disabled={!!busyKey}
                            style={{ padding: '7px 10px', fontSize: '11.5px' }}
                          >
                            {busyKey === `reject:${enrollment.enrollmentId || enrollment.id}` ? 'Canceling…' : enrollmentState === 'pending' ? 'Reject' : 'Cancel invitation'}
                          </button>
                          {enrollmentState === 'pending' && (
                            <button
                              className="btn btn-primary"
                              type="button"
                              onClick={() => respondToEnrollment(enrollment, true)}
                              disabled={!!busyKey}
                              style={{ padding: '8px 12px', fontSize: '12px' }}
                            >
                              {busyKey === `approve:${enrollment.enrollmentId || enrollment.id}` ? 'Approving…' : 'Approve VM'}
                            </button>
                          )}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {canDirectDeploy && (
                            <button
                              className="btn btn-secondary"
                              type="button"
                              onClick={() => createPortableHelper(vm)}
                              disabled={!!busyKey}
                              style={{ padding: '7px 10px', fontSize: '11.5px' }}
                              aria-label={`Create portable helper for ${name}`}
                            >
                              Portable instead
                            </button>
                          )}
                          <button
                            className="btn btn-primary"
                            type="button"
                            onClick={() => canDirectDeploy ? openCredentialModal(vm) : createPortableHelper(vm)}
                            disabled={!!busyKey}
                            style={{ padding: '8px 12px', fontSize: '12px' }}
                          >
                            {busyKey === actionKey ? 'Working…' : canDirectDeploy ? 'Install helper' : 'Create portable helper'}
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {(unmatchedGuests.length > 0 || unmatchedEnrollments.length > 0) && (
          <section style={{ ...cardStyle, overflow: 'hidden' }}>
            <div style={{ padding: '16px 19px', borderBottom: '1px solid var(--border-color)' }}>
              <h2 style={{ margin: 0, fontSize: '16px' }}>Other guest helpers</h2>
              <div style={{ marginTop: '5px', color: 'var(--text-muted)', fontSize: '12px' }}>
                Portable helpers and VMs whose configuration file has moved remain manageable here.
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px', padding: '14px' }}>
              {unmatchedEnrollments.map(enrollment => {
                const enrollmentId = enrollment.enrollmentId || enrollment.id;
                const enrollmentState = String(enrollment.state || 'pending').toLowerCase();
                return (
                  <article key={`pending:${enrollmentId}`} style={{ ...cardStyle, padding: '15px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                      <div>
                        <div style={{ color: 'var(--text-primary)', fontSize: '13.5px', fontWeight: 750 }}>{enrollment.name || enrollment.vmName || 'Windows VM'}</div>
                        <div style={{ marginTop: '4px', color: 'var(--text-muted)', fontSize: '11px' }}>{enrollment.machineName || 'Portable helper'}</div>
                      </div>
                      <Badge tone={enrollmentState === 'approved' ? 'good' : 'warning'}>
                        {enrollmentState === 'invited' ? 'Waiting for helper' : enrollmentState === 'approved' ? 'Approved' : 'Approval required'}
                      </Badge>
                    </div>
                    <div style={{ marginTop: '13px', padding: '10px', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.07)', border: '1px solid rgba(245, 158, 11, 0.16)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '11.5px' }}>Matching code</span>
                      <span style={{ color: '#fbbf24', fontFamily: 'Consolas, monospace', fontSize: '18px', fontWeight: 850, letterSpacing: '2px' }}>{enrollment.pairingCode || '------'}</span>
                    </div>
                    {enrollmentState !== 'invited' && (
                      <div title={asArray(enrollment.selectedFiles).join('\n')} style={{ marginTop: '8px', color: 'var(--text-muted)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        Requests {asArray(enrollment.selectedFiles).length} selected file{asArray(enrollment.selectedFiles).length === 1 ? '' : 's'}
                      </div>
                    )}
                    <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'flex-end', gap: '7px' }}>
                      <button className="btn btn-secondary" type="button" onClick={() => respondToEnrollment(enrollment, false)} disabled={!!busyKey} style={{ padding: '7px 10px', fontSize: '11.5px' }}>{enrollmentState === 'pending' ? 'Reject' : 'Cancel invitation'}</button>
                      {enrollmentState === 'pending' && (
                        <button className="btn btn-primary" type="button" onClick={() => respondToEnrollment(enrollment, true)} disabled={!!busyKey} style={{ padding: '8px 12px', fontSize: '12px' }}>Approve VM</button>
                      )}
                    </div>
                  </article>
                );
              })}
              {unmatchedGuests.map(guest => {
                const guestId = guest.guestId || guest.id;
                const online = guest.connected || guest.online || guest.status === 'online';
                const selectedCount = Number(guest.selectedFileCount) || asArray(guest.selectedFiles || guest.files).length;
                return (
                  <article key={`guest:${guestId}`} style={{ ...cardStyle, padding: '15px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                      <div>
                        <div style={{ color: 'var(--text-primary)', fontSize: '13.5px', fontWeight: 750 }}>{guest.vmName || guest.name || 'Windows VM'}</div>
                        <div style={{ marginTop: '4px', color: 'var(--text-muted)', fontSize: '11px' }}>{guest.machineName || 'Portable helper'}</div>
                      </div>
                      <Badge tone={online ? 'good' : 'quiet'}><StatusDot good={online} />{online ? 'Connected' : 'Offline'}</Badge>
                    </div>
                    <div style={{ marginTop: '12px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                      {selectedCount > 0 ? `${selectedCount} file${selectedCount === 1 ? '' : 's'} selected` : 'Paired — waiting for file selection'}
                    </div>
                    <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{guest.lastUploadAt ? `Last file ${formatRelativeTime(guest.lastUploadAt)}` : 'No file received yet'}</span>
                      <button className="btn btn-secondary" type="button" onClick={() => forgetGuest(guest)} disabled={!!busyKey} style={{ padding: '7px 10px', fontSize: '11.5px' }}>Forget</button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        <section style={{ ...cardStyle, padding: '17px 19px', display: 'grid', gridTemplateColumns: 'minmax(220px, 0.7fr) minmax(300px, 1.3fr)', gap: '22px' }}>
          <div>
            <div style={{ color: 'var(--text-primary)', fontSize: '13px', fontWeight: 750 }}>What happens after pairing?</div>
            <div style={{ marginTop: '6px', color: 'var(--text-muted)', fontSize: '11.8px', lineHeight: 1.55 }}>The VM remembers only its protected device credential. It does not remember the one-time Windows credentials used for installation.</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(110px, 1fr))', gap: '10px' }}>
            {[
              ['1', 'Select files', 'Choose exactly what to protect inside the VM.'],
              ['2', 'Changes stream', 'Each verified revision is safely journaled on the host.'],
              ['3', 'Host encrypts', 'LabSuite encrypts and sends them to your backup destinations.']
            ].map(([number, title, copy]) => (
              <div key={number} style={{ padding: '10px', borderLeft: '2px solid rgba(176, 228, 204, 0.18)' }}>
                <div style={{ color: 'var(--accent-secondary)', fontSize: '10px', fontWeight: 850 }}>{number}</div>
                <div style={{ marginTop: '4px', color: 'var(--text-primary)', fontSize: '11.8px', fontWeight: 700 }}>{title}</div>
                <div style={{ marginTop: '4px', color: 'var(--text-muted)', fontSize: '10.8px', lineHeight: 1.45 }}>{copy}</div>
              </div>
            ))}
          </div>
          <div style={{ gridColumn: '1 / -1', paddingTop: '11px', borderTop: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '11.5px', lineHeight: 1.5 }}>
            Restore currently recovers VM-protected versions onto the host through Backup Engine. Automatic write-back into the running guest is not enabled yet.
          </div>
        </section>
      </div>

      {credentialVm && (
        <div
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeCredentialModal();
          }}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0, 0, 0, 0.70)', backdropFilter: 'blur(4px)', display: 'grid', placeItems: 'center', padding: '24px' }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="vm-protect-credential-title"
            onSubmit={deployHelper}
            style={{ width: '100%', maxWidth: '470px', borderRadius: '13px', background: '#0d1b19', border: '1px solid rgba(255, 255, 255, 0.12)', boxShadow: '0 24px 70px rgba(0, 0, 0, 0.55)', overflow: 'hidden' }}
          >
            <div style={{ padding: '19px 20px 16px', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
                <div>
                  <h2 id="vm-protect-credential-title" style={{ margin: 0, fontSize: '17px' }}>Install helper in {getVmName(credentialVm)}</h2>
                  <div style={{ marginTop: '6px', color: 'var(--text-muted)', fontSize: '12px', lineHeight: 1.5 }}>VMware Tools must be running inside this Windows VM.</div>
                </div>
                <button className="btn btn-secondary" type="button" onClick={closeCredentialModal} disabled={!!busyKey} aria-label="Close install helper dialog" style={{ width: '30px', height: '30px', padding: 0 }}>×</button>
              </div>
            </div>

            <div style={{ padding: '18px 20px' }}>
              <div style={{ padding: '11px 12px', borderRadius: '8px', background: 'rgba(64, 138, 113, 0.11)', border: '1px solid rgba(176, 228, 204, 0.12)', color: 'var(--text-secondary)', fontSize: '11.8px', lineHeight: 1.5 }}>
                Enter the Windows account for this VM. LabSuite passes it directly to VMware Tools for this installation only. The username and password are never saved or sent to Google Drive.
                VMware's command-line tool temporarily carries the password as a process argument; choose the portable helper if you do not want that tradeoff.
              </div>

              <label htmlFor="vm-protect-username" style={{ display: 'block', marginTop: '16px', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 750, letterSpacing: '0.3px' }}>WINDOWS USERNAME</label>
              <input
                id="vm-protect-username"
                type="text"
                value={credentials.username}
                onChange={event => setCredentials(previous => ({ ...previous, username: event.target.value }))}
                placeholder="VM-NAME\\username or username"
                autoComplete="off"
                autoFocus
                disabled={!!busyKey}
                required
                style={{ ...inputStyle, marginTop: '7px' }}
              />

              <label htmlFor="vm-protect-password" style={{ display: 'block', marginTop: '14px', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 750, letterSpacing: '0.3px' }}>WINDOWS PASSWORD</label>
              <input
                id="vm-protect-password"
                type="password"
                value={credentials.password}
                onChange={event => setCredentials(previous => ({ ...previous, password: event.target.value }))}
                placeholder="Password for this VM"
                autoComplete="new-password"
                disabled={!!busyKey}
                required
                style={{ ...inputStyle, marginTop: '7px' }}
              />

              {error && <div role="alert" style={{ marginTop: '12px', color: '#fca5a5', fontSize: '11.8px', lineHeight: 1.45 }}>{error}</div>}
            </div>

            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: '9px' }}>
              <button className="btn btn-secondary" type="button" onClick={closeCredentialModal} disabled={!!busyKey}>Cancel</button>
              <button className="btn btn-primary" type="submit" disabled={!!busyKey || !credentials.username.trim() || !credentials.password}>
                {busyKey ? 'Installing…' : 'Install helper'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
