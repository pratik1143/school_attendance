export const SCHOOL_ROLES = ['super_admin', 'school_admin', 'principal', 'teacher', 'operator'] as const;
export type SchoolRole = typeof SCHOOL_ROLES[number];
export type SchoolIdentity = { uid: string; role: SchoolRole; schoolId: string | null; teacherId: string | null };
export const ROLE_PERMISSIONS: Record<SchoolRole, readonly string[]> = {
  super_admin: ['*'],
  school_admin: ['school:manage', 'school:create', 'students:read', 'students:manage', 'teachers:read', 'teachers:manage', 'classes:manage', 'devices:read', 'devices:manage', 'attendance:read', 'attendance:adjust', 'reports:read', 'dashboard:read', 'users:manage'],
  principal: ['students:read', 'attendance:read', 'reports:read', 'teachers:read', 'dashboard:read', 'devices:read'],
  teacher: ['students:assigned', 'attendance:assigned', 'reports:assigned', 'classes:assigned'],
  operator: ['students:read', 'device_users:manage', 'attendance:read', 'devices:read', 'devices:operate', 'dashboard:read'],
};
export function roleCan(role: SchoolRole, permission: string): boolean {
  if (ROLE_PERMISSIONS[role].includes('*') || ROLE_PERMISSIONS[role].includes(permission)) return true;
  if (role === 'teacher' && ['dashboard:read', 'attendance:read', 'reports:read', 'students:read', 'teachers:read'].includes(permission)) return true;
  if (role === 'principal' && permission === 'dashboard:read') return true;
  return false;
}
export function resolveSchoolScope(identity: SchoolIdentity, requested: unknown): string {
  if (identity.role === 'super_admin') {
    if (!safeSchoolId(requested)) throw new Error('A valid schoolId is required for super-admin operations.');
    return requested;
  }
  if (!safeSchoolId(identity.schoolId)) throw new Error('School scope is missing from the authenticated identity.');
  return identity.schoolId;
}
export function normalizeRole(claims: Record<string, unknown>): SchoolRole | null {
  const role = typeof claims.role === 'string' ? claims.role : Array.isArray(claims.roles) ? claims.roles.find((r) => SCHOOL_ROLES.includes(r as SchoolRole)) : null;
  if (typeof role === 'string' && SCHOOL_ROLES.includes(role as SchoolRole)) return role as SchoolRole;
  if (claims.admin === true) return 'school_admin';
  return null;
}
export const safeSchoolId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export const validIsoDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export function localDateKey(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function zonedMidnightUtc(date: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number); const target = Date.UTC(year, month - 1, day);
  let result = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(result));
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    result += target - represented;
  }
  return new Date(result);
}
export function workingDaysBetween(start: string, end: string, workingDays: number[], holidays: Set<string>, timezone: string, today = localDateKey(new Date(), timezone)): string[] {
  if (!validIsoDate(start) || !validIsoDate(end) || start > end) return [];
  const days: string[] = []; const cursor = new Date(`${start}T00:00:00Z`); const last = new Date(`${end}T00:00:00Z`); const todayDate = new Date(`${today}T00:00:00Z`);
  for (; cursor <= last && cursor <= todayDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) if (workingDays.includes(cursor.getUTCDay()) && !holidays.has(cursor.toISOString().slice(0, 10))) days.push(cursor.toISOString().slice(0, 10));
  return days;
}
export function lateThresholdStatus(time: Date, date: string, startTime: string, lateAfterMinutes: number, timezone: string): 'present' | 'late' {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(time);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value])); const clockMinutes = Number(p.hour) * 60 + Number(p.minute);
  const [h, m] = startTime.split(':').map(Number);
  return clockMinutes > h * 60 + m + lateAfterMinutes ? 'late' : 'present';
}
export function attendanceSummary(totalStudents: number, statuses: string[]) {
  const counts = { present: 0, absent: 0, late: 0, excused: 0, unknown: 0 };
  for (const status of statuses) if (status in counts) counts[status as keyof typeof counts]++;
  const marked = statuses.length;
  return { totalStudents, ...counts, notMarked: Math.max(0, totalStudents - marked), attendancePercentage: totalStudents ? Number((counts.present / totalStudents * 100).toFixed(1)) : 0 };
}
export function validateStudentInput(input: Record<string, unknown>) {
  const studentId = typeof input.studentId === 'string' ? input.studentId.trim() : ''; const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(studentId) || !name || name.length > 120) return { valid: false, error: 'Student ID and name are required; name must be 120 characters or fewer.' };
  for (const key of ['email', 'phone', 'rollNumber', 'admissionNumber', 'classId', 'sectionId', 'sessionId', 'dateOfBirth', 'class', 'section', 'address', 'gender', 'photoUrl']) if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') return { valid: false, error: `Invalid ${key}.` };
  if (input.dateOfBirth && !validIsoDate(input.dateOfBirth)) return { valid: false, error: 'dateOfBirth must be YYYY-MM-DD.' };
  if (input.status && !['active', 'inactive', 'transferred', 'graduated', 'pending_profile'].includes(String(input.status))) return { valid: false, error: 'Unsupported student status.' };
  return { valid: true, error: '' };
}
export function validateCsvRows(rows: Record<string, string>[]) {
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const id = String(row.studentId || '').trim(); const name = String(row.name || '').trim(); const duplicate = Boolean(id && seen.has(id)); if (id) seen.add(id);
    return { row: index + 1, data: row, status: duplicate ? 'duplicate' : !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !name ? 'invalid' : 'valid', error: duplicate ? 'Duplicate studentId in file.' : !id || !name ? 'studentId and name are required.' : '' };
  });
}
export function csvCell(value: unknown) { let str = String(value ?? ''); if (/^[=+@]/.test(str) || /^-\D/.test(str)) str = `'${str}`; return `"${str.replaceAll('"', '""')}"`; }
