import { useEffect, useState } from 'react';
import { ArrowLeft, Fingerprint, ShieldCheck, Wifi } from 'lucide-react';

const formatDate = (value) => {
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};
function Badge({ value }) {
  const text = String(value || 'unknown');
  return <span className={`badge ${['online', 'active', 'completed', 'verified'].includes(text.toLowerCase()) ? 'good' : 'muted'}`}><i />{text.replaceAll('_', ' ')}</span>;
}
function Heading({ title, subtitle, action }) { return <div className="page-heading"><div><span className="eyebrow">CAMPUS HARDWARE</span><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>; }

const capabilityNames = {
  deviceInfo: 'Device information', deviceStatus: 'Device status', deviceSync: 'Device sync', userRead: 'Read users',
  userCreate: 'Create user', userUpdate: 'Update user', userDelete: 'Disable/delete user', attendanceRead: 'Read attendance',
  deviceRestart: 'Restart device', timeGet: 'Read device time', timeSet: 'Set device time', remoteEnrollment: 'Remote biometric enrollment',
};
const commandActions = [
  ['Refresh Device', 'device.info', 'deviceInfo'], ['Sync', 'device.sync', 'deviceSync'], ['Read Users', 'device.users.read', 'userRead'],
  ['Read Attendance', 'device.attendance.read', 'attendanceRead'], ['Settings', null, null], ['Restart', 'device.restart', 'deviceRestart'],
];

function DeviceDetail({ device, devices, deviceUsers, attendance, user, apiBase, onBack }) {
  const [tab, setTab] = useState('Overview'); const [commands, setCommands] = useState([]); const [logs, setLogs] = useState([]); const [error, setError] = useState(''); const [tenantAdmin, setTenantAdmin] = useState(false);
  const deviceId = device.deviceId || device.id;
  const verifiedCapabilities = Object.fromEntries(Object.keys(capabilityNames).map((key) => [key, false]));
  useEffect(() => {
    let live = true;
    user.getIdTokenResult().then(({ claims }) => live && setTenantAdmin((claims.admin === true || claims.role === 'admin' || claims.role === 'super_admin' || claims.roles?.includes?.('admin') || claims.roles?.includes?.('super_admin') || claims.operator === true || claims.role === 'operator' || claims.roles?.includes?.('operator')) && Boolean(claims.clientId && claims.tenantId))).catch(() => live && setTenantAdmin(false));
    return () => { live = false; };
  }, [user]);
  useEffect(() => {
    if (!tenantAdmin) return undefined;
    let live = true;
    async function loadSafeAdminData() {
      try {
        const token = await user.getIdToken(); const headers = { Authorization: `Bearer ${token}` };
        const [commandsResponse, logsResponse] = await Promise.all([
          fetch(`${apiBase}/api/v1/admin/devices/${encodeURIComponent(deviceId)}/commands`, { headers }),
          fetch(`${apiBase}/api/v1/admin/devices/${encodeURIComponent(deviceId)}/logs`, { headers }),
        ]);
        const [commandBody, logBody] = await Promise.all([commandsResponse.json().catch(() => ({})), logsResponse.json().catch(() => ({}))]);
        if (!commandsResponse.ok || !logsResponse.ok) throw new Error(commandBody.error?.message || logBody.error?.message || 'Device management data is unavailable.');
        if (live) { setCommands(commandBody.data || []); setLogs(logBody.data || []); }
      } catch (caught) { if (live) setError(caught.message); }
    }
    loadSafeAdminData();
    return () => { live = false; };
  }, [tenantAdmin, deviceId, user, apiBase]);
  const users = deviceUsers.data.filter((row) => row.deviceId === deviceId);
  const attendanceRows = attendance.data.filter((row) => row.deviceId === deviceId).slice(0, 50);
  return <>
    <Heading title={device.deviceName || deviceId} subtitle={`${device.model || 'T800'} · ${deviceId}`} action={<button className="button secondary" onClick={onBack}><ArrowLeft size={15} /> Devices</button>} />
    <nav className="device-detail-tabs">{['Overview', 'Connection', 'Firmware', 'Capabilities', 'Commands', 'Users', 'Attendance', 'Logs'].map((name) => <button key={name} className={tab === name ? 'selected' : ''} onClick={() => setTab(name)}>{name}</button>)}</nav>
    {error && <div className="form-error">{error}</div>}
    {tab === 'Overview' && <div className="device-detail-grid">{[['Device Name', device.deviceName], ['Device ID', deviceId], ['Model', device.model], ['Cloud ID', device.cloudId], ['Serial', device.serialNumber], ['Firmware', device.firmware], ['IP', device.remoteIp], ['Status', device.status], ['Last Seen', device.lastSeen ? formatDate(device.lastSeen) : null]].map(([label, value]) => <div className="device-detail-item" key={label}><span>{label}</span><strong>{value || 'Unknown'}</strong></div>)}</div>}
    {tab === 'Connection' && <div className="device-detail-grid">{[['Status', device.status], ['Connection ID', device.connectionId], ['Remote IP', device.remoteIp], ['Connected Since', device.connectedAt ? formatDate(device.connectedAt) : null], ['Last Packet', device.lastPacketAt ? formatDate(device.lastPacketAt) : null], ['Last Seen', device.lastSeen ? formatDate(device.lastSeen) : null]].map(([label, value]) => <div className="device-detail-item" key={label}><span>{label}</span><strong>{value || 'Unknown'}</strong></div>)}</div>}
    {tab === 'Firmware' && <section className="panel device-detail-empty"><h2>Firmware information</h2><p>Only values received from the device are shown.</p><strong>Firmware: {device.firmware || 'Unknown'} · Serial: {device.serialNumber || 'Unknown'}</strong></section>}
    {tab === 'Capabilities' && <section className="panel data-panel"><div className="table-scroll"><table><thead><tr><th>Capability</th><th>Status</th><th>Evidence</th></tr></thead><tbody>{Object.entries(verifiedCapabilities).map(([key, enabled]) => <tr key={key}><td>{capabilityNames[key]}</td><td><Badge value={enabled ? 'verified' : 'unsupported'} /></td><td>{enabled ? 'Verified command exchange' : 'Not supported by current verified device protocol.'}</td></tr>)}</tbody></table></div></section>}
    {tab === 'Commands' && <><section className="panel data-panel command-actions"><div className="panel-heading"><div><h2>Device commands</h2><p>Controls stay disabled until request and response formats are verified.</p></div></div><div className="device-action-grid">{commandActions.map(([label, , capability]) => <button key={label} disabled title="Not supported by current verified device protocol.">{label}</button>)}</div><p className="muted-copy">No bytes are sent. Admin API requests for unverified commands are recorded as <code>unsupported</code>.</p></section><section className="panel data-panel"><div className="table-toolbar"><strong>Command history</strong></div>{commands.length ? <div className="table-scroll"><table><thead><tr>{['Command', 'Status', 'Created', 'Expires', 'Protocol', 'Result'].map((x) => <th key={x}>{x}</th>)}</tr></thead><tbody>{commands.map((row) => <tr key={row.commandId}><td>{row.commandType}</td><td><Badge value={row.status} /></td><td>{row.createdAt ? formatDate(row.createdAt) : '—'}</td><td>{row.expiresAt ? formatDate(row.expiresAt) : '—'}</td><td>{row.protocol || 'unknown'}</td><td>{row.error || row.result || '—'}</td></tr>)}</tbody></table></div> : <p className="muted-copy device-detail-empty">No command requests recorded.</p>}</section></>}
    {tab === 'Users' && <section className="panel data-panel"><div className="table-toolbar"><strong>Known device users</strong></div>{users.length ? <div className="table-scroll"><table><thead><tr><th>Device user ID</th><th>Name</th><th>Status</th><th>Source</th></tr></thead><tbody>{users.map((row) => <tr key={row.id}><td>{row.deviceUserId}</td><td>{row.name || '—'}</td><td><Badge value={row.status} /></td><td>{row.source || '—'}</td></tr>)}</tbody></table></div> : <p className="muted-copy device-detail-empty">No device users recorded.</p>}</section>}
    {tab === 'Attendance' && <section className="panel data-panel"><div className="table-toolbar"><strong>Recent attendance</strong></div>{attendanceRows.length ? <div className="table-scroll"><table><thead><tr><th>Time</th><th>Device user ID</th><th>Student ID</th><th>Method</th><th>Status</th></tr></thead><tbody>{attendanceRows.map((row) => <tr key={row.id}><td>{formatDate(row.timestamp)}</td><td>{row.deviceUserId || '—'}</td><td>{row.studentId || 'Unmapped'}</td><td>{row.method || '—'}</td><td><Badge value={row.status} /></td></tr>)}</tbody></table></div> : <p className="muted-copy device-detail-empty">No attendance records for this device.</p>}</section>}
    {tab === 'Logs' && <section className="panel data-panel"><div className="table-toolbar"><strong>Safe device logs</strong><span className="muted-copy">Raw bytes are not included.</span></div>{logs.length ? <div className="table-scroll"><table><thead><tr>{['Timestamp', 'Direction', 'Command', 'Packet size', 'Status', 'Connection ID'].map((x) => <th key={x}>{x}</th>)}</tr></thead><tbody>{logs.map((row) => <tr key={row.logId}><td>{row.timestamp ? formatDate(row.timestamp) : '—'}</td><td>{row.direction || '—'}</td><td>Unknown packet</td><td>{row.packetSize} bytes</td><td>{row.parserStatus}</td><td>{row.connectionId || '—'}</td></tr>)}</tbody></table></div> : <p className="muted-copy device-detail-empty">{tenantAdmin ? 'No packet logs are available.' : 'A tenant-scoped administrator claim is required to inspect logs.'}</p>}</section>}
  </>;
}

export default function DeviceManagement({ devices, deviceUsers, attendance, user, apiBase }) {
  const [selectedId, setSelectedId] = useState(() => decodeURIComponent(window.location.pathname.match(/^\/devices\/([^/]+)/)?.[1] || ''));
  useEffect(() => { const onPop = () => setSelectedId(decodeURIComponent(window.location.pathname.match(/^\/devices\/([^/]+)/)?.[1] || '')); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  const selected = devices.data.find((row) => (row.deviceId || row.id) === selectedId);
  function openDevice(device) { const id = device.deviceId || device.id; window.history.pushState({}, '', `/devices/${encodeURIComponent(id)}`); setSelectedId(id); }
  function back() { window.history.pushState({}, '', '/'); setSelectedId(''); }
  if (selected) return <DeviceDetail device={selected} devices={devices} deviceUsers={deviceUsers} attendance={attendance} user={user} apiBase={apiBase} onBack={back} />;
  return <><Heading title="Devices" subtitle="Your school's registered attendance terminals." action={<span className="phase-tag"><i /> Phase 2 · Listener status</span>} /><div className="connectivity-banner"><div className="banner-icon"><Wifi size={19} /></div><div><strong>Connection status comes from the cloud TCP listener.</strong><span>Online/offline reflects the listener’s latest persisted connection state.</span></div></div><section className="panel data-panel"><div className="table-toolbar"><div className="toolbar-title"><strong>Registered devices</strong><span className="count-pill">{devices.data.length}</span></div></div>{devices.loading ? <div className="state">Loading devices…</div> : devices.error ? <div className="state error-state">{devices.error}</div> : devices.data.length ? <div className="table-scroll"><table><thead><tr>{['Device name', 'Device ID', 'Model', 'Cloud ID', 'Connection', 'Status', 'Last seen', 'Actions'].map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{devices.data.map((device) => <tr key={device.deviceId || device.id}><td>{device.deviceName || 'Unnamed device'}</td><td className="mono">{device.deviceId || device.id}</td><td>{device.model || '—'}</td><td className="mono">{device.cloudId || '—'}</td><td>{device.connectionType || '—'}</td><td><Badge value={device.status} /></td><td>{device.lastSeen ? formatDate(device.lastSeen) : '—'}</td><td><div className="row-actions device-actions"><button onClick={() => openDevice(device)}>View</button>{['Refresh', 'Sync', 'Read Users', 'Read Attendance', 'Settings'].map((label) => <button key={label} disabled title="Not supported by current verified device protocol.">{label}</button>)}</div></td></tr>)}</tbody></table></div> : <div className="state">No devices registered.</div>}<div className="table-footer"><span>{devices.data.length} device{devices.data.length === 1 ? '' : 's'} registered</span><span>Commands remain disabled until protocol verification.</span></div></section><div className="device-info-grid"><div className="info-card"><span className="info-icon blue"><Fingerprint size={18} /></span><div><strong>Protocol safety gate</strong><p>No command request is sent until its T800 request and response are verified.</p></div></div><div className="info-card"><span className="info-icon green"><ShieldCheck size={18} /></span><div><strong>Tenant-scoped management</strong><p>Command history and safe packet-log metadata require an administrator or device operator claim scoped to this tenant.</p></div></div></div></>;
}
