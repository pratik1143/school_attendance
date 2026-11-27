import { useMemo, useState } from 'react';
import { CalendarOff, ChevronLeft, ChevronRight, Clock3, Download, Fingerprint, Search, Trash2, UserCheck, UserX } from 'lucide-react';
import { deleteAttendanceRecords } from '../services/adminApi.js';
import { setMark } from '../services/marks.js';
import { Avatar, Kpi, Segmented, StatusPill } from './ui.jsx';
import { State } from './State.jsx';
import { dayKey, downloadCsv, getCutoff, isActive, personDay, personId, prettyDay, setCutoff, shiftDay, timeText, todayKey } from './attendanceLogic.js';
import { asDate, formatDate } from '../services/common.js';

/** Daily register for students and teachers (device punches + manual marks) and the raw punch log. */
export default function AttendancePage({ students, teachers, attendance, devices, punchIndex, marksMap }) {
  const [kind, setKind] = useState('student'); const [tab, setTab] = useState('register');
  const [day, setDay] = useState(todayKey()); const [cutoff, setCut] = useState(getCutoff());
  const [search, setSearch] = useState(''); const [group, setGroup] = useState(''); const [statusFilter, setStatusFilter] = useState('');
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const isStudent = kind === 'student'; const source = isStudent ? students : teachers;

  const rows = useMemo(() => source.data.filter(isActive).map((p) => ({ p, d: personDay(kind, p, day, punchIndex.index, marksMap, cutoff) })), [source.data, kind, day, punchIndex, marksMap, cutoff]);
  const groups = [...new Set(source.data.map((p) => (isStudent ? p.class : p.subject)).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  const filtered = rows.filter(({ p, d }) => `${p.name} ${personId(kind, p)} ${p.deviceUserId || ''}`.toLowerCase().includes(search.toLowerCase())
    && (!group || (isStudent ? p.class : p.subject) === group) && (!statusFilter || d.status === statusFilter))
    .sort((a, b) => String(a.p.name || '').localeCompare(String(b.p.name || '')));
  const count = (s) => rows.filter(({ d }) => d.status === s).length;
  const attended = count('present') + count('late');
  const rate = rows.length ? Math.round((attended / rows.length) * 100) : 0;

  async function mark(p, status) {
    setError(''); setBusy(personId(kind, p));
    try { await setMark({ kind, personId: personId(kind, p), date: day, status }); } catch (e) { setError(e.message || 'Could not save the mark.'); } finally { setBusy(''); }
  }
  function exportRegister() {
    downloadCsv(`${kind}-attendance-${day}.csv`, [[isStudent ? 'Student ID' : 'Teacher ID', 'Name', isStudent ? 'Class' : 'Subject', 'First in', 'Last out', 'Punches', 'Status', 'Source'],
      ...filtered.map(({ p, d }) => [personId(kind, p), p.name, isStudent ? `${p.class || ''} ${p.section || ''}`.trim() : p.subject, timeText(d.first), timeText(d.last), d.count, d.status, d.source])]);
  }

  return (
    <>
      <div className="page-heading"><div><span className="eyebrow">DAILY RECORDS</span><h1>Attendance</h1><p>Device punches and manual marks for students and teachers, in one register.</p></div>
        <div className="head-actions"><div className="day-nav"><button onClick={() => setDay(shiftDay(day, -1))} aria-label="Previous day"><ChevronLeft size={16} /></button>
          <input type="date" value={day} max={todayKey()} onChange={(e) => e.target.value && setDay(e.target.value)} />
          <button onClick={() => setDay(shiftDay(day, 1))} disabled={day >= todayKey()} aria-label="Next day"><ChevronRight size={16} /></button></div>
          {tab === 'register' && <button className="button secondary" onClick={exportRegister} disabled={!filtered.length}><Download size={16} /> Export</button>}</div></div>

      <div className="switch-row">
        <Segmented value={kind} onChange={(v) => { setKind(v); setGroup(''); setStatusFilter(''); }} options={[{ value: 'student', label: 'Students', count: students.data.filter(isActive).length }, { value: 'teacher', label: 'Teachers', count: teachers.data.filter(isActive).length }]} />
        <Segmented value={tab} onChange={setTab} options={[{ value: 'register', label: 'Daily register' }, { value: 'log', label: 'Punch log' }]} />
        <span className="day-label">{prettyDay(day)}</span>
      </div>

      {tab === 'register' ? (
        <>
          <div className="stat-grid four">
            <Kpi label="Present" value={count('present')} note={`${rate}% attendance rate`} icon={UserCheck} tone="green" />
            <Kpi label="Late" value={count('late')} note={`after ${cutoff}`} icon={Clock3} tone="orange" />
            <Kpi label="Absent" value={count('absent')} note="No punch, no mark" icon={UserX} tone="purple" />
            <Kpi label="On leave" value={count('leave')} note="Marked manually" icon={CalendarOff} />
          </div>
          {error && <div className="form-error">{error}</div>}
          <section className="panel data-panel">
            <div className="table-toolbar tall">
              <div className="toolbar-title"><strong>{isStudent ? 'Student register' : 'Teacher register'}</strong><span className="count-pill">{filtered.length}</span></div>
              <div className="filter-tools wrap">
                <label className="search-box"><Search size={16} /><input placeholder="Search name or ID…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
                <select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">{isStudent ? 'All classes' : 'All subjects'}</option>{groups.map((g) => <option key={g}>{g}</option>)}</select>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">Any status</option><option value="present">Present</option><option value="late">Late</option><option value="absent">Absent</option><option value="leave">On leave</option></select>
                <label className="cutoff">Late after<input type="time" value={cutoff} onChange={(e) => { setCut(e.target.value); setCutoff(e.target.value); }} /></label>
              </div>
            </div>
            <State loading={source.loading || attendance.loading} error={source.error || attendance.error} empty={!filtered.length}
              emptyText={rows.length ? 'No one matches these filters.' : `No active ${isStudent ? 'students' : 'teachers'} yet.`}>
              <div className="table-scroll"><table>
                <thead><tr><th>{isStudent ? 'Student' : 'Teacher'}</th><th>{isStudent ? 'Class' : 'Subject'}</th><th>First in</th><th>Last out</th><th>Punches</th><th>Status</th><th>Source</th><th className="right">Mark</th></tr></thead>
                <tbody>{filtered.map(({ p, d }) => { const id = personId(kind, p); return (
                  <tr key={p.id}>
                    <td><span className="student-cell"><Avatar person={p} /><span className="stack"><span className="person-name">{p.name}</span><span className="mono small">{id}</span></span></span></td>
                    <td>{isStudent ? <span className="chip">{p.class || '—'}{p.section ? ` · ${p.section}` : ''}</span> : (p.subject ? <span className="chip">{p.subject}</span> : '—')}</td>
                    <td className="mono">{timeText(d.first)}</td><td className="mono">{timeText(d.last)}</td><td>{d.count || '—'}</td>
                    <td><StatusPill status={d.status} /></td>
                    <td><span className="method">{d.source === 'device' ? <><Fingerprint size={13} />Device</> : d.source === 'manual' ? 'Manual' : '—'}</span></td>
                    <td className="right"><select className="mark-select" value={d.mark ? d.mark.status : 'auto'} disabled={busy === id} onChange={(e) => mark(p, e.target.value)}>
                      <option value="auto">Auto (device)</option><option value="present">Present</option><option value="late">Late</option><option value="absent">Absent</option><option value="leave">On leave</option></select></td>
                  </tr>); })}</tbody></table></div>
            </State>
          </section>
          {punchIndex.unmatched.length > 0 && <p className="hint">{punchIndex.unmatched.length} device punch{punchIndex.unmatched.length === 1 ? '' : 'es'} could not be matched to anyone — check the Punch log and set the person’s device user ID.</p>}
        </>
      ) : <PunchLog attendance={attendance} students={students.data} teachers={teachers.data} devices={devices.data} />}
    </>
  );
}

function PunchLog({ attendance, students, teachers, devices }) {
  const [search, setSearch] = useState(''); const [date, setDate] = useState(''); const [error, setError] = useState('');
  const sById = new Map(students.map((s) => [String(s.studentId || s.id), s]));
  const sByDev = new Map(students.filter((s) => s.deviceUserId).map((s) => [String(s.deviceUserId), s]));
  const tByDev = new Map(teachers.filter((t) => t.deviceUserId).map((t) => [String(t.deviceUserId), t]));
  const dMap = new Map(devices.map((d) => [d.deviceId || d.id, d]));
  const who = (r) => {
    const s = sById.get(String(r.studentId)) || sByDev.get(String(r.deviceUserId)); if (s) return { name: s.name, type: 'Student', id: s.studentId || s.id };
    const t = tByDev.get(String(r.deviceUserId)); if (t) return { name: t.name, type: 'Teacher', id: t.teacherId || t.id };
    return { name: 'Unmatched', type: '—', id: r.deviceUserId || r.studentId || '—' };
  };
  const filtered = attendance.data.filter((r) => { const d = asDate(r.timestamp); const w = who(r);
    return `${w.name} ${w.id} ${r.deviceUserId}`.toLowerCase().includes(search.toLowerCase()) && (!date || (d && dayKey(d) === date)); });
  async function remove(ids) {
    if (!ids.length || !window.confirm(`Delete ${ids.length} punch record${ids.length === 1 ? '' : 's'}? Device punches can then be tested again.`)) return;
    setError(''); try { await deleteAttendanceRecords(ids); } catch (e) { setError(e.message); }
  }
  return (
    <section className="panel data-panel">
      <div className="table-toolbar tall"><div className="toolbar-title"><strong>Punch log</strong><span className="count-pill">{filtered.length}</span></div>
        <div className="filter-tools wrap"><label className="search-box"><Search size={16} /><input placeholder="Search name or ID…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Filter by date" />
          <button className="button secondary" disabled={!filtered.length} onClick={() => remove(filtered.map((r) => r.id))}><Trash2 size={15} /> Delete shown</button></div></div>
      {error && <div className="form-error" style={{ margin: '0 20px 12px' }}>{error}</div>}
      <State loading={attendance.loading} error={attendance.error} empty={!filtered.length} onRetry={attendance.reload} emptyText="No punches recorded yet.">
        <div className="table-scroll"><table>
          <thead><tr><th>Date</th><th>Time</th><th>Person</th><th>Type</th><th>ID</th><th>Method</th><th>Device</th><th></th></tr></thead>
          <tbody>{filtered.slice(0, 300).map((r) => { const w = who(r); return (
            <tr key={r.id}><td className="date-cell">{formatDate(r.timestamp)}</td><td className="mono">{timeText(asDate(r.timestamp))}</td>
              <td className="person-name">{w.name}</td><td><span className="chip">{w.type}</span></td><td className="mono small">{w.id}</td>
              <td><span className="method"><Fingerprint size={13} />{r.method || '—'}</span></td><td>{dMap.get(r.deviceId)?.deviceName || r.deviceId || '—'}</td>
              <td className="right"><button className="row-delete" title="Delete punch" onClick={() => remove([r.id])}><Trash2 size={14} /></button></td></tr>); })}</tbody></table></div>
      </State>
    </section>
  );
}
