import { useMemo, useState } from 'react';
import { Check, Download, Eye, Fingerprint, GraduationCap, Pencil, Plus, Search, Trash2, UserCheck, UserX, Users, X, Briefcase } from 'lucide-react';
import { saveStudent } from '../services/students.js';
import { deleteStudentRecord } from '../services/adminApi.js';
import { deleteTeacher, nextTeacherId, saveTeacher } from '../services/teachers.js';
import { Avatar, Kpi, MiniDays, Segmented, StatusPill } from './ui.jsx';
import PersonModal from './PersonModal.jsx';
import { downloadCsv, getCutoff, isActive, lastDays, personDay, personId, prettyDay, timeText, todayKey } from './attendanceLogic.js';
import { State } from './State.jsx';

const nextStudentId = (students) => {
  const nums = students.map((s) => /^STU(\d+)$/i.exec(String(s.studentId || s.id))).filter(Boolean).map((m) => Number(m[1]));
  return `STU${(nums.length ? Math.max(...nums) : 1000) + 1}`;
};

/** One roster page for students and teachers: summary tiles, tabs, search, today's status and a 7-day strip. */
export default function PeoplePage({ kind, students, teachers, attendance, punchIndex, marksMap }) {
  const isStudent = kind === 'student';
  const source = isStudent ? students : teachers;
  const noun = isStudent ? 'student' : 'teacher';
  const cutoff = getCutoff(); const today = todayKey(); const week = useMemo(() => lastDays(7), [today]);
  const [search, setSearch] = useState(''); const [group, setGroup] = useState('all'); const [statusFilter, setStatusFilter] = useState('');
  const [modal, setModal] = useState(null); const [detail, setDetail] = useState(null); const [notice, setNotice] = useState(''); const [error, setError] = useState('');

  const rows = useMemo(() => source.data.map((p) => ({ p, today: personDay(kind, p, today, punchIndex.index, marksMap, cutoff), week: week.map((day) => ({ day, status: personDay(kind, p, day, punchIndex.index, marksMap, cutoff).status })) })), [source.data, punchIndex, marksMap, cutoff, today, kind]);
  const groups = useMemo(() => (isStudent ? [...new Set(source.data.map((s) => s.class).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })) : [...new Set(source.data.map((t) => t.subject).filter(Boolean))].sort()), [source.data, isStudent]);
  const filtered = rows.filter(({ p, today: t }) => {
    const hay = `${p.name} ${personId(kind, p)} ${p.deviceUserId || ''} ${p.subject || ''} ${p.phone || ''}`.toLowerCase();
    return hay.includes(search.toLowerCase()) && (group === 'all' || (isStudent ? p.class === group : p.subject === group)) && (!statusFilter || (statusFilter === 'inactive' ? !isActive(p) : t.status === statusFilter));
  }).sort((a, b) => String(a.p.name || '').localeCompare(String(b.p.name || '')));

  const active = source.data.filter(isActive);
  const present = rows.filter(({ p, today: t }) => isActive(p) && (t.status === 'present' || t.status === 'late')).length;
  const absent = rows.filter(({ p, today: t }) => isActive(p) && (t.status === 'absent')).length;
  const noDevice = source.data.filter((p) => !p.deviceUserId).length;
  const allDeviceIds = [...students.data, ...teachers.data].filter((p) => p.deviceUserId).map((p) => ({ id: String(p.deviceUserId), self: String(p.studentId || p.teacherId || p.id) }));

  async function save(form) {
    const dev = String(form.deviceUserId || '').trim(); const me = String(form[isStudent ? 'studentId' : 'teacherId'] || '');
    if (dev && allDeviceIds.some((d) => d.id === dev && d.self !== me)) throw new Error(`Device user ID ${dev} is already assigned to someone else.`);
    if (isStudent) await saveStudent({ ...form, deviceUserId: dev }); else await saveTeacher({ ...form, deviceUserId: dev }, modal?.id);
    setModal(null); setNotice(`${isStudent ? 'Student' : 'Teacher'} saved.`); setTimeout(() => setNotice(''), 3500);
  }
  async function remove(p) {
    if (!window.confirm(`Delete ${p.name}? Their past attendance records stay in the log.`)) return;
    setError('');
    try { if (isStudent) await deleteStudentRecord(p.studentId || p.id); else await deleteTeacher(p.id); setNotice(`${p.name} deleted.`); setTimeout(() => setNotice(''), 3500); } catch (e) { setError(e.message); }
  }
  function exportCsv() {
    downloadCsv(`${noun}s-${today}.csv`, [[`${isStudent ? 'Student' : 'Teacher'} ID`, 'Name', isStudent ? 'Class' : 'Subject', isStudent ? 'Section' : 'Phone', 'Device user ID', 'Status', 'Today'],
      ...filtered.map(({ p, today: t }) => [personId(kind, p), p.name, isStudent ? p.class : p.subject, isStudent ? p.section : p.phone, p.deviceUserId, p.status, t.status])]);
  }

  return (
    <>
      <div className="page-heading"><div><span className="eyebrow">{isStudent ? 'ROSTER & RECORDS' : 'STAFF & RECORDS'}</span><h1>{isStudent ? 'Students' : 'Teachers'}</h1>
        <p>{isStudent ? 'Enroll students, link their device ID and watch daily attendance.' : 'Enroll teachers, link their device ID and watch daily attendance.'}</p></div>
        <div className="head-actions"><button className="button secondary" onClick={exportCsv} disabled={!filtered.length}><Download size={16} /> Export CSV</button>
          <button className="button" onClick={() => setModal({ new: true })}><Plus size={17} /> {isStudent ? 'Enroll student' : 'Enroll teacher'}</button></div></div>
      {notice && <div className="success-banner"><Check size={16} />{notice}<button onClick={() => setNotice('')}><X size={15} /></button></div>}
      {error && <div className="form-error">{error}</div>}

      <div className="stat-grid four">
        <Kpi label={isStudent ? 'Total students' : 'Total teachers'} value={source.data.length} note={`${active.length} active`} icon={isStudent ? GraduationCap : Briefcase} />
        <Kpi label="Present today" value={present} note={active.length ? `${Math.round((present / active.length) * 100)}% of active` : 'No active records'} icon={UserCheck} tone="green" />
        <Kpi label="Absent today" value={absent} note="Active, no punch or mark" icon={UserX} tone="orange" />
        <Kpi label="No device ID" value={noDevice} note="Can't be matched to the T800" icon={Fingerprint} tone="purple" />
      </div>

      <section className="panel data-panel">
        <div className="table-toolbar tall">
          <div className="toolbar-title"><strong>{isStudent ? 'All students' : 'All teachers'}</strong><span className="count-pill">{filtered.length}</span></div>
          <div className="filter-tools">
            <label className="search-box"><Search size={16} /><input placeholder={`Search ${noun}s…`} value={search} onChange={(e) => setSearch(e.target.value)} /></label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">Any status</option><option value="present">Present today</option><option value="late">Late today</option><option value="absent">Absent today</option><option value="leave">On leave</option><option value="inactive">Inactive</option></select>
          </div>
        </div>
        {groups.length > 0 && <div className="tabs-row"><Segmented value={group} onChange={setGroup} options={[{ value: 'all', label: 'All', count: source.data.length }, ...groups.map((g) => ({ value: g, label: isStudent ? `Class ${g}` : g, count: source.data.filter((p) => (isStudent ? p.class : p.subject) === g).length }))]} /></div>}
        <State loading={source.loading} error={source.error} empty={!filtered.length} onRetry={source.reload}
          emptyText={source.data.length ? 'No one matches these filters.' : `No ${noun}s yet — enroll the first one.`}>
          <div className="table-scroll"><table>
            <thead><tr><th>{isStudent ? 'Student' : 'Teacher'}</th><th>{isStudent ? 'Class' : 'Subject'}</th><th>{isStudent ? 'Guardian / device' : 'Contact'}</th><th>Today</th><th>Last 7 days</th><th>Status</th><th className="right">Actions</th></tr></thead>
            <tbody>{filtered.map(({ p, today: t, week: w }) => (
              <tr key={p.id}>
                <td><span className="student-cell"><Avatar person={p} /><span className="stack"><span className="person-name">{p.name}</span><span className="mono small">{personId(kind, p)}</span></span></span></td>
                <td>{isStudent ? <span className="chip">{p.class || '—'}{p.section ? ` · ${p.section}` : ''}</span> : (p.subject ? <span className="chip">{p.subject}</span> : '—')}</td>
                <td><span className="stack"><span className="mono small">{p.deviceUserId ? `Device ID ${p.deviceUserId}` : 'No device ID'}</span>{!isStudent && <span className="small muted-t">{p.phone || p.email || '—'}</span>}</span></td>
                <td><span className="stack"><StatusPill status={t.status} small />{t.first && <span className="small muted-t">in {timeText(t.first)}</span>}</span></td>
                <td><MiniDays days={w} /></td>
                <td><span className={`badge ${isActive(p) ? 'good' : 'muted'}`}><i />{isActive(p) ? 'active' : 'inactive'}</span></td>
                <td className="right"><span className="row-icons">
                  <button title="View" onClick={() => setDetail(p)}><Eye size={15} /></button>
                  <button title="Edit" onClick={() => setModal(p)}><Pencil size={15} /></button>
                  <button title="Delete" className="danger" onClick={() => remove(p)}><Trash2 size={15} /></button></span></td>
              </tr>))}</tbody></table></div>
        </State>
      </section>

      {modal && <PersonModal kind={kind} initial={modal.new ? null : modal} suggestedId={isStudent ? nextStudentId(students.data) : nextTeacherId(teachers.data)} onClose={() => setModal(null)} onSave={save} />}
      {detail && <Detail kind={kind} person={detail} punchIndex={punchIndex} marksMap={marksMap} cutoff={cutoff} onClose={() => setDetail(null)} />}
    </>
  );
}

function Detail({ kind, person, punchIndex, marksMap, cutoff, onClose }) {
  const days = lastDays(30).reverse().map((day) => ({ day, ...personDay(kind, person, day, punchIndex.index, marksMap, cutoff) }));
  const count = (s) => days.filter((d) => d.status === s).length;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal detail-modal">
        <div className="modal-head"><div className="detail-person"><Avatar person={person} large /><div><span className="eyebrow">{kind === 'student' ? 'STUDENT PROFILE' : 'TEACHER PROFILE'}</span><h2>{person.name}</h2><span className="muted-copy mono">{personId(kind, person)}</span></div></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
        <div className="detail-fields">
          <div><span>{kind === 'student' ? 'Class & section' : 'Subject'}</span><strong>{kind === 'student' ? `${person.class || '—'} · ${person.section || '—'}` : (person.subject || '—')}</strong></div>
          <div><span>Device user ID</span><strong>{person.deviceUserId || '—'}</strong></div>
          <div><span>{kind === 'student' ? 'Status' : 'Contact'}</span><strong>{kind === 'student' ? (person.status || 'active') : (person.phone || person.email || '—')}</strong></div>
        </div>
        <div className="detail-counts"><span><b>{count('present')}</b>Present</span><span><b>{count('late')}</b>Late</span><span><b>{count('absent')}</b>Absent</span><span><b>{count('leave')}</b>Leave</span></div>
        <h3 className="history-title">Last 30 days</h3>
        <div className="history-list">{days.map((d) => (
          <div className="history-row" key={d.day}><span className="stack"><strong>{prettyDay(d.day)}</strong><small>{d.first ? `${timeText(d.first)}${d.last ? ` → ${timeText(d.last)}` : ''} · ${d.count} punch${d.count === 1 ? '' : 'es'}` : d.mark ? `Marked manually${d.mark.note ? ` — ${d.mark.note}` : ''}` : 'No punches'}</small></span><StatusPill status={d.status} small /></div>))}</div>
      </section>
    </div>
  );
}
