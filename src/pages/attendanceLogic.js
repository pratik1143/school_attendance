import { asDate } from '../services/common.js';

export const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayKey = () => dayKey(new Date());
export function shiftDay(key, delta) { const [y, m, d] = key.split('-').map(Number); return dayKey(new Date(y, m - 1, d + delta)); }
export function prettyDay(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
export const getCutoff = () => localStorage.getItem('sa.lateCutoff') || '09:15';
export const setCutoff = (v) => localStorage.setItem('sa.lateCutoff', v);

export const personId = (kind, p) => String(kind === 'student' ? (p.studentId || p.id) : (p.teacherId || p.id));
export const isActive = (p) => String(p.status || 'active').toLowerCase() === 'active';

/**
 * Index every device punch by person and day. A punch belongs to a student (by studentId or device user id)
 * or, failing that, to a teacher by device user id. Anything else is returned as `unmatched`.
 */
export function buildPunchIndex(attendance, students, teachers) {
  const sById = new Map(students.map((s) => [String(s.studentId || s.id), s]));
  const sByDev = new Map(students.filter((s) => s.deviceUserId).map((s) => [String(s.deviceUserId), s]));
  const tByDev = new Map(teachers.filter((t) => t.deviceUserId).map((t) => [String(t.deviceUserId), t]));
  const index = new Map(); const unmatched = [];
  for (const row of attendance) {
    const at = asDate(row.timestamp); if (!at) continue;
    const sid = row.studentId ? String(row.studentId) : ''; const dev = row.deviceUserId ? String(row.deviceUserId) : '';
    let kind = ''; let person = null;
    if (sid && sById.has(sid)) { kind = 'student'; person = sById.get(sid); }
    else if (dev && sByDev.has(dev)) { kind = 'student'; person = sByDev.get(dev); }
    else if (dev && tByDev.has(dev)) { kind = 'teacher'; person = tByDev.get(dev); }
    if (!person) { unmatched.push(row); continue; }
    const key = `${kind}:${personId(kind, person)}`; const day = dayKey(at);
    if (!index.has(key)) index.set(key, new Map());
    const days = index.get(key); if (!days.has(day)) days.set(day, []);
    days.get(day).push({ at, row });
  }
  for (const days of index.values()) for (const list of days.values()) list.sort((a, b) => a.at - b.at);
  return { index, unmatched };
}

export function marksIndex(marks) {
  const m = new Map(); for (const x of marks) m.set(`${x.kind}:${x.personId}:${x.date}`, x); return m;
}

/** Status of one person on one day: a manual mark wins, otherwise the device decides. */
export function dayStatus({ punches = [], mark, cutoff }) {
  const first = punches[0]?.at || null; const last = punches.length > 1 ? punches[punches.length - 1].at : null;
  let auto = 'absent';
  if (first) { const [h, m] = cutoff.split(':').map(Number); const limit = new Date(first); limit.setHours(h, m, 0, 0); auto = first > limit ? 'late' : 'present'; }
  return { first, last, count: punches.length, auto, mark: mark || null, status: mark ? mark.status : auto, source: mark ? 'manual' : first ? 'device' : '—' };
}

export function personDay(kind, person, day, punchIndex, marks, cutoff) {
  const key = personId(kind, person);
  return dayStatus({ punches: punchIndex.get(`${kind}:${key}`)?.get(day) || [], mark: marks.get(`${kind}:${key}:${day}`), cutoff });
}

export function lastDays(n, from = todayKey()) { return Array.from({ length: n }, (_, i) => shiftDay(from, i - (n - 1))); }

export const timeText = (d) => (d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

export function downloadCsv(name, rows) {
  const esc = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? `'${s}` : s; };
  const body = rows.map((r) => r.map((c) => `"${esc(c).replaceAll('"', '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
