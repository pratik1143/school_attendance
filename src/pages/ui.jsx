import { Check, Clock3, CalendarOff, UserX, Minus } from 'lucide-react';

const STATUS = {
  present: { label: 'Present', icon: Check }, late: { label: 'Late', icon: Clock3 },
  absent: { label: 'Absent', icon: UserX }, leave: { label: 'On leave', icon: CalendarOff }, none: { label: '—', icon: Minus },
};

export function StatusPill({ status, small }) {
  const s = STATUS[status] || STATUS.none; const Icon = s.icon;
  return <span className={`sp sp-${status || 'none'} ${small ? 'sp-small' : ''}`}><Icon size={small ? 11 : 13} />{s.label}</span>;
}

export function Segmented({ value, onChange, options }) {
  return <div className="seg" role="tablist">{options.map((o) => <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}{o.count != null && <em>{o.count}</em>}</button>)}</div>;
}

/** Seven little squares: one per day, coloured by that day's status. */
export function MiniDays({ days }) {
  return <span className="mini-days" aria-label="Last 7 days">{days.map(({ day, status }) => <i key={day} className={`md md-${status}`} title={`${day}: ${STATUS[status]?.label || '—'}`} />)}</span>;
}

export function Avatar({ person, large }) {
  const initials = String(person?.name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return <span className={`person-avatar ${large ? 'large' : ''}`}>{initials || '?'}</span>;
}

export function Kpi({ label, value, note, icon: Icon, tone = 'blue' }) {
  return <article className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${tone}`}><Icon size={17} /></span></div><div className="stat-value">{value}</div><div className="stat-bottom"><span>{note}</span></div></article>;
}
