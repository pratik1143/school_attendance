import { useState } from 'react';
import { X } from 'lucide-react';

const FIELDS = {
  student: [
    { key: 'studentId', label: 'Student ID', placeholder: 'e.g. STU1005', required: true, lockOnEdit: true, mono: true },
    { key: 'name', label: 'Full name', placeholder: 'Student name', required: true },
    { key: 'class', label: 'Class', placeholder: 'e.g. 8', required: true },
    { key: 'section', label: 'Section', placeholder: 'e.g. A', required: true },
    { key: 'deviceUserId', label: 'Device user ID', placeholder: 'Number on the T800 (optional)', digits: true },
  ],
  teacher: [
    { key: 'teacherId', label: 'Teacher ID', placeholder: 'e.g. TCH001', required: true, lockOnEdit: true, mono: true },
    { key: 'name', label: 'Full name', placeholder: 'Teacher name', required: true },
    { key: 'subject', label: 'Subject', placeholder: 'e.g. Mathematics' },
    { key: 'phone', label: 'Phone', placeholder: '+91 …' },
    { key: 'email', label: 'Email', placeholder: 'name@school.edu', type: 'email' },
    { key: 'deviceUserId', label: 'Device user ID', placeholder: 'Number on the T800 (optional)', digits: true },
  ],
};

export default function PersonModal({ kind, initial, suggestedId, onClose, onSave }) {
  const editing = Boolean(initial);
  const idKey = kind === 'student' ? 'studentId' : 'teacherId';
  const [form, setForm] = useState(() => ({ status: 'active', ...(initial || {}), [idKey]: initial ? (initial[idKey] || initial.id) : suggestedId }));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function submit(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try { await onSave(form); } catch (err) { setError(err.message || 'Could not save.'); } finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal">
        <div className="modal-head">
          <div><span className="eyebrow">{kind === 'student' ? 'STUDENT RECORD' : 'TEACHER RECORD'}</span><h2>{editing ? `Edit ${kind}` : `Enroll a ${kind}`}</h2>
            <p>{kind === 'student' ? 'Attendance from the device is matched through the device user ID.' : 'Teacher attendance is matched through the device user ID, or marked manually.'}</p></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        </div>
        <form onSubmit={submit} className="student-form">
          {error && <div className="form-error">{error}</div>}
          <div className="form-grid">
            {FIELDS[kind].map((f) => (
              <label key={f.key}>{f.label}
                <input className={f.mono ? 'mono' : ''} type={f.type || 'text'} value={form[f.key] || ''} placeholder={f.placeholder} required={f.required}
                  disabled={editing && f.lockOnEdit} inputMode={f.digits ? 'numeric' : undefined} pattern={f.digits ? '[0-9]*' : undefined}
                  onChange={(e) => set(f.key, f.digits ? e.target.value.replace(/\D/g, '') : e.target.value)} />
              </label>
            ))}
            <label>Status<select value={form.status || 'active'} onChange={(e) => set('status', e.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
          </div>
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
            <button className="button" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : `Enroll ${kind}`}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
