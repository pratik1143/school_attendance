import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore';
import { getAdminAuth, getDb } from '../firestore/admin.ts';
import { studentDeviceLinkId } from '../deviceEnrollment/model.ts';
import { attendanceSummary, csvCell, lateThresholdStatus, localDateKey, normalizeRole, roleCan, resolveSchoolScope, safeSchoolId, SCHOOL_ROLES, validIsoDate, validateCsvRows, validateStudentInput, workingDaysBetween, zonedMidnightUtc } from './model.ts';
import type { SchoolIdentity, SchoolRole } from './model.ts';

export class SchoolServiceError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) { super(message); this.statusCode = statusCode; this.code = code; }
}
const iso = (v: unknown) => v instanceof Timestamp ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v ?? null;
const safeData = (doc: FirebaseFirestore.QueryDocumentSnapshot<DocumentData> | FirebaseFirestore.DocumentSnapshot<DocumentData>): Record<string, any> => ({ ...doc.data(), id: doc.get('id') || doc.get('sessionId') || doc.get('classId') || doc.get('sectionId') || doc.get('teacherId') || doc.get('assignmentId') || doc.get('holidayId') || doc.get('schoolId') || doc.id, createdAt: iso(doc.get('createdAt')), updatedAt: iso(doc.get('updatedAt')) });
const idSafe = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.trim());
const text = (v: unknown, max = 120) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const tzOkay = (v: unknown) => { try { new Intl.DateTimeFormat('en', { timeZone: String(v) }); return true; } catch { return false; } };

export async function schoolIdentity(token: string): Promise<SchoolIdentity> {
  try {
    const claims = await getAdminAuth().verifyIdToken(token); const role = normalizeRole(claims);
    if (!role || typeof claims.uid !== 'string') throw new Error('role');
    const schoolId = typeof claims.schoolId === 'string' ? claims.schoolId : role === 'school_admin' && typeof claims.tenantId === 'string' ? claims.tenantId : null;
    if (role !== 'super_admin' && !safeSchoolId(schoolId)) throw new Error('school');
    return { uid: claims.uid, role, schoolId, teacherId: typeof claims.teacherId === 'string' ? claims.teacherId : null };
  } catch { throw new SchoolServiceError(403, 'SCHOOL_ROLE_REQUIRED', 'A valid school role and school scope are required.'); }
}
function requirePermission(identity: SchoolIdentity, permission: string) { if (!roleCan(identity.role, permission)) throw new SchoolServiceError(403, 'PERMISSION_DENIED', 'Your role cannot perform this school operation.'); }
function scopeSchool(identity: SchoolIdentity, requested?: unknown) {
  try { return resolveSchoolScope(identity, requested); } catch { if (identity.role === 'super_admin') throw new SchoolServiceError(400, 'SCHOOL_ID_REQUIRED', 'Provide a valid schoolId.'); throw new SchoolServiceError(403, 'SCHOOL_SCOPE_REQUIRED', 'A school scope is missing from the authenticated identity.'); }
}
async function audit(schoolId: string, identity: SchoolIdentity, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown> = {}) {
  await getDb().collection('audit_logs').add({ schoolId, userId: identity.uid, role: identity.role, action, resourceType, resourceId, timestamp: FieldValue.serverTimestamp(), metadata });
}
function docKey(schoolId: string, id: string) { return `${schoolId}__${id}`; }
function bodyObj(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SchoolServiceError(400, 'INVALID_BODY', 'A JSON object is required.'); return v as Record<string, unknown>; }

async function createSchool(identity: SchoolIdentity, body: Record<string, unknown>) {
  requirePermission(identity, 'school:create'); const schoolId = safeSchoolId(body.schoolId) ? body.schoolId : randomUUID().replaceAll('-', ''); const name = text(body.name);
  if (!name) throw new SchoolServiceError(400, 'INVALID_SCHOOL', 'School name is required.');
  const timezone = body.timezone ? String(body.timezone) : 'Asia/Kolkata'; if (!tzOkay(timezone)) throw new SchoolServiceError(400, 'INVALID_TIMEZONE', 'Timezone is invalid.');
  const now = FieldValue.serverTimestamp(); const ref = getDb().collection('schools').doc(schoolId);
  await getDb().runTransaction(async (tx) => { const existing = await tx.get(ref); if (existing.exists) throw new SchoolServiceError(409, 'SCHOOL_EXISTS', 'School ID already exists.'); tx.create(ref, { schoolId, name, code: text(body.code, 32), address: text(body.address, 500), phone: text(body.phone, 40), email: text(body.email, 254), timezone, status: 'active', createdAt: now, updatedAt: now }); });
  await audit(schoolId, identity, 'SCHOOL_CREATED', 'school', schoolId); return { schoolId, name, timezone };
}
async function updateSchool(schoolId: string, identity: SchoolIdentity, body: Record<string, unknown>) {
  requirePermission(identity, 'school:manage'); const ref = getDb().collection('schools').doc(schoolId); const snap = await ref.get(); if (!snap.exists) throw new SchoolServiceError(404, 'SCHOOL_NOT_FOUND', 'School not found.');
  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  for (const field of ['name', 'code', 'address', 'phone', 'email']) if (body[field] !== undefined) { const value = text(body[field], field === 'address' ? 500 : field === 'email' ? 254 : 120); if (field === 'name' && !value) throw new SchoolServiceError(400, 'INVALID_SCHOOL', 'School name cannot be empty.'); if (field === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new SchoolServiceError(400, 'INVALID_EMAIL', 'School email is invalid.'); patch[field] = value; }
  if (body.timezone !== undefined) { const timezone = text(body.timezone, 64); if (!tzOkay(timezone)) throw new SchoolServiceError(400, 'INVALID_TIMEZONE', 'Timezone is invalid.'); patch.timezone = timezone; }
  await ref.update(patch); await audit(schoolId, identity, 'SCHOOL_UPDATED', 'school', schoolId); return { schoolId, ...patch, ...snap.data(), ...patch };
}

async function listCollection(collectionName: string, schoolId: string, limit = 200) {
  const snap = await getDb().collection(collectionName).where('schoolId', '==', schoolId).orderBy('name').limit(limit).get();
  return snap.docs.map((d) => safeData(d));
}
async function saveNamed(collectionName: string, schoolId: string, identity: SchoolIdentity, body: Record<string, unknown>, requiredPermission: string) {
  requirePermission(identity, requiredPermission); const name = text(body.name); if (!name) throw new SchoolServiceError(400, 'NAME_REQUIRED', 'Name is required.');
  const id = safeSchoolId(body.id) ? body.id : randomUUID().replaceAll('-', ''); const ref = getDb().collection(collectionName).doc(docKey(schoolId, id));
  const status = text(body.status, 24) || 'active'; if (!['active', 'inactive'].includes(status)) throw new SchoolServiceError(400, 'INVALID_STATUS', 'Status must be active or inactive.');
  const record: Record<string, unknown> = { id, schoolId, name, status, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
  if (collectionName === 'classes') { record.classId = id; record.sessionId = body.sessionId; record.displayOrder = Number.isInteger(body.displayOrder) ? body.displayOrder : 0; }
  if (collectionName === 'sections') { record.sectionId = id; record.sessionId = body.sessionId; record.classId = body.classId; }
  if (collectionName === 'teachers') { record.teacherId = id; record.email = text(body.email, 254); record.phone = text(body.phone, 40); record.employeeId = text(body.employeeId, 64); }
  if (collectionName === 'classes') { if (!idSafe(body.sessionId)) throw new SchoolServiceError(400, 'SESSION_REQUIRED', 'Choose an academic session.'); record.displayOrder = Number.isInteger(body.displayOrder) ? body.displayOrder : 0; }
  if (collectionName === 'sections') { if (!idSafe(body.sessionId) || !idSafe(body.classId)) throw new SchoolServiceError(400, 'CLASS_REQUIRED', 'Choose a valid class and academic session.'); }
  if (collectionName === 'teachers') { if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email))) throw new SchoolServiceError(400, 'INVALID_EMAIL', 'Email address is invalid.'); }
  const schoolRef = getDb().collection('schools').doc(schoolId); const sessionRef = idSafe(body.sessionId) ? getDb().collection('academic_sessions').doc(docKey(schoolId, String(body.sessionId))) : null;
  await getDb().runTransaction(async (tx) => {
    const classRef = collectionName === 'sections' ? getDb().collection('classes').doc(docKey(schoolId, String(body.classId))) : null;
    const refs = [schoolRef, ...(sessionRef ? [sessionRef] : []), ...(classRef ? [classRef] : [])]; const docs = await Promise.all(refs.map((r) => tx.get(r)));
    if (!docs[0].exists) throw new SchoolServiceError(404, 'SCHOOL_NOT_FOUND', 'School not found.');
    if (sessionRef && (!docs[1].exists || docs[1].get('schoolId') !== schoolId)) throw new SchoolServiceError(400, 'INVALID_SESSION', 'Academic session was not found in this school.');
    if (classRef && (!docs[2].exists || docs[2].get('schoolId') !== schoolId || docs[2].get('sessionId') !== body.sessionId)) throw new SchoolServiceError(400, 'INVALID_CLASS', 'Class must belong to this school and session.');
    let duplicateQuery: FirebaseFirestore.Query = getDb().collection(collectionName).where('schoolId', '==', schoolId).where('name', '==', name);
    if (collectionName === 'classes') duplicateQuery = duplicateQuery.where('sessionId', '==', body.sessionId);
    if (collectionName === 'sections') duplicateQuery = duplicateQuery.where('sessionId', '==', body.sessionId).where('classId', '==', body.classId);
    const duplicates = await tx.get(duplicateQuery.limit(3));
    if (duplicates.docs.some((d) => d.id !== ref.id && d.get('status') !== 'inactive')) throw new SchoolServiceError(409, 'DUPLICATE_NAME', 'An active record with this name already exists.');
    tx.set(ref, record, { merge: true });
  });
  await audit(schoolId, identity, `${collectionName.toUpperCase()}_SAVED`, collectionName.slice(0, -1), id, { name }); return record;
}
async function saveSession(schoolId: string, identity: SchoolIdentity, body: Record<string, unknown>) {
  requirePermission(identity, 'classes:manage'); const name = text(body.name, 30); const startDate = body.startDate; const endDate = body.endDate;
  if (!name || !validIsoDate(startDate) || !validIsoDate(endDate) || startDate > endDate) throw new SchoolServiceError(400, 'INVALID_SESSION', 'Provide a session name and a valid start/end date range.');
  const id = safeSchoolId(body.sessionId) ? body.sessionId : randomUUID().replaceAll('-', ''); const ref = getDb().collection('academic_sessions').doc(docKey(schoolId, id)); const status = body.status === 'active' ? 'active' : 'inactive'; const now = FieldValue.serverTimestamp();
  await getDb().runTransaction(async (tx) => { const matches = await tx.get(getDb().collection('academic_sessions').where('schoolId', '==', schoolId).where('status', '==', 'active')); if (status === 'active') for (const d of matches.docs) if (d.id !== ref.id) tx.update(d.ref, { status: 'inactive', updatedAt: now }); tx.set(ref, { sessionId: id, schoolId, name, startDate, endDate, status, createdAt: now, updatedAt: now }, { merge: true }); });
  await audit(schoolId, identity, 'ACADEMIC_SESSION_SAVED', 'academic_session', id, { name, status }); return { sessionId: id, schoolId, name, startDate, endDate, status };
}
async function saveStudent(schoolId: string, identity: SchoolIdentity, body: Record<string, unknown>, existingId?: string) {
  requirePermission(identity, 'students:manage'); const validation = validateStudentInput(body); if (!validation.valid) throw new SchoolServiceError(400, 'INVALID_STUDENT', validation.error); const studentId = text(body.studentId, 64); const name = text(body.name); if (!idSafe(studentId) || !name) throw new SchoolServiceError(400, 'INVALID_STUDENT', 'Student ID and name are required.');
  for (const f of ['classId', 'sectionId', 'sessionId']) if (body[f] && !idSafe(body[f])) throw new SchoolServiceError(400, 'INVALID_STUDENT', `${f} is invalid.`);
  const status = String(body.status || 'active'); if (!['active', 'inactive', 'transferred', 'graduated', 'pending_profile'].includes(status)) throw new SchoolServiceError(400, 'INVALID_STUDENT_STATUS', 'Student status is invalid.');
  const db = getDb(); const studentDocId = docKey(schoolId, studentId); const ref = db.collection('students').doc(studentDocId);
  const fields = ['admissionNumber', 'classId', 'sectionId', 'sessionId', 'class', 'section', 'gender', 'dateOfBirth', 'rollNumber', 'phone', 'email', 'address', 'photoUrl']; const optional = Object.fromEntries(fields.filter((f) => body[f] !== undefined && body[f] !== '').map((f) => [f, text(body[f], f === 'address' ? 500 : 160)]));
  if (optional.dateOfBirth && !validIsoDate(optional.dateOfBirth)) throw new SchoolServiceError(400, 'INVALID_DOB', 'Date of birth must be YYYY-MM-DD.');
  const now = FieldValue.serverTimestamp();
  await db.runTransaction(async (tx) => {
    const [existing, duplicateId] = await Promise.all([tx.get(ref), tx.get(db.collection('students').where('schoolId', '==', schoolId).where('studentId', '==', studentId).limit(2))]);
    if (existingId && existingId !== studentDocId) throw new SchoolServiceError(400, 'STUDENT_ID_IMMUTABLE', 'Student ID cannot be changed during an update.');
    if (duplicateId.docs.some((d) => d.id !== ref.id)) throw new SchoolServiceError(409, 'STUDENT_ID_EXISTS', 'Student ID is already used in this school.');
    if (!existingId && existing.exists) throw new SchoolServiceError(409, 'STUDENT_ID_EXISTS', 'Student ID is already used in this school.');
    if (!idSafe(body.sessionId)) throw new SchoolServiceError(400, 'INVALID_SESSION', 'Choose an academic session.');
    { const session = await tx.get(db.collection('academic_sessions').doc(docKey(schoolId, String(body.sessionId)))); if (!session.exists || session.get('schoolId') !== schoolId) throw new SchoolServiceError(400, 'INVALID_SESSION', 'Session does not belong to this school.'); }
    let className = text(body.class, 40); let sectionName = text(body.section, 40);
    if (body.classId) { const cls = await tx.get(db.collection('classes').doc(docKey(schoolId, String(body.classId)))); if (!cls.exists || cls.get('schoolId') !== schoolId) throw new SchoolServiceError(400, 'INVALID_CLASS', 'Class does not belong to this school.'); className = String(cls.get('name') || className); }
    if (body.sectionId) { const sec = await tx.get(db.collection('sections').doc(docKey(schoolId, String(body.sectionId)))); if (!sec.exists || sec.get('schoolId') !== schoolId || sec.get('classId') !== body.classId) throw new SchoolServiceError(400, 'INVALID_SECTION', 'Section does not belong to the selected class.'); sectionName = String(sec.get('name') || sectionName); }
    let device: FirebaseFirestore.DocumentSnapshot | null = null;
    if (body.deviceId) { device = await tx.get(db.collection('devices').doc(String(body.deviceId))); if (!device.exists || device.get('schoolId') !== schoolId) throw new SchoolServiceError(400, 'INVALID_DEVICE', 'Device must be assigned to this school before linking.'); }
    const tenantId = device?.get('tenantId') || existing.get('tenantId') || schoolId;
    if (optional.admissionNumber) { const admissions = await tx.get(db.collection('students').where('schoolId', '==', schoolId).where('admissionNumber', '==', optional.admissionNumber).limit(3)); if (admissions.docs.some((d) => d.id !== ref.id)) throw new SchoolServiceError(409, 'ADMISSION_NUMBER_EXISTS', 'Admission number is already used in this school.'); }
    let linkRef: FirebaseFirestore.DocumentReference | null = null;
    if (device && typeof body.deviceUserId === 'string' && body.deviceUserId.trim()) { linkRef = db.collection('student_device_links').doc(studentDeviceLinkId(String(body.deviceId), body.deviceUserId.trim())); const linked = await tx.get(linkRef); if (linked.exists && linked.get('studentId') !== studentId) throw new SchoolServiceError(409, 'DEVICE_USER_LINKED', 'This device user is already linked to another student.'); }
    tx.set(ref, { ...optional, studentId, schoolId, tenantId, name, status, ...(className ? { class: className } : {}), ...(sectionName ? { section: sectionName } : {}), ...(body.classId ? { classId: body.classId } : {}), ...(body.sectionId ? { sectionId: body.sectionId } : {}), ...(body.sessionId ? { sessionId: body.sessionId } : {}), ...(typeof body.deviceUserId === 'string' ? { deviceUserId: body.deviceUserId.trim() } : {}), ...(typeof body.deviceId === 'string' ? { deviceId: body.deviceId.trim() } : {}), createdAt: existing.exists ? existing.get('createdAt') : now, updatedAt: now }, { merge: true });
    if (linkRef && typeof body.deviceUserId === 'string') tx.set(linkRef, { schoolId, tenantId, studentId, deviceId: body.deviceId, deviceUserId: body.deviceUserId.trim(), status: 'active', createdAt: existing.exists ? existing.get('createdAt') : now, updatedAt: now }, { merge: true });
  });
  await audit(schoolId, identity, existingId ? 'STUDENT_UPDATED' : 'STUDENT_CREATED', 'student', studentId, { name, status }); return { id: ref.id, studentId, schoolId, name, status, ...optional };
}
async function saveAssignment(schoolId: string, identity: SchoolIdentity, body: Record<string, unknown>) {
  requirePermission(identity, 'teachers:manage'); const keys = ['sessionId', 'classId', 'sectionId', 'teacherId']; if (keys.some((k) => !idSafe(body[k]))) throw new SchoolServiceError(400, 'INVALID_ASSIGNMENT', 'Choose a valid session, class, section and teacher.');
  const id = `${body.sessionId}__${body.sectionId}__${body.teacherId}`; const ref = getDb().collection('class_teacher_assignments').doc(docKey(schoolId, id)); const now = FieldValue.serverTimestamp();
  await getDb().runTransaction(async (tx) => { const [session, cls, sec, teacher] = await Promise.all([tx.get(getDb().collection('academic_sessions').doc(docKey(schoolId, String(body.sessionId)))), tx.get(getDb().collection('classes').doc(docKey(schoolId, String(body.classId)))), tx.get(getDb().collection('sections').doc(docKey(schoolId, String(body.sectionId)))), tx.get(getDb().collection('teachers').doc(docKey(schoolId, String(body.teacherId))))]); if ([session, cls, sec, teacher].some((d) => !d.exists || d.get('schoolId') !== schoolId) || cls.get('sessionId') !== body.sessionId || sec.get('sessionId') !== body.sessionId || sec.get('classId') !== body.classId) throw new SchoolServiceError(400, 'INVALID_ASSIGNMENT', 'All assignment records must exist in the same school and session.'); tx.set(ref, { assignmentId: id, schoolId, ...Object.fromEntries(keys.map((k) => [k, body[k]])), status: 'active', createdAt: now, updatedAt: now }, { merge: true }); });
  await audit(schoolId, identity, 'TEACHER_ASSIGNED', 'class_teacher_assignment', id); return { assignmentId: id, schoolId, ...Object.fromEntries(keys.map((k) => [k, body[k]])), status: 'active' };
}
async function savePolicy(schoolId: string, identity: SchoolIdentity, body: Record<string, unknown>) {
  requirePermission(identity, 'school:manage'); const sessionId = text(body.sessionId, 128); const start = text(body.defaultStartTime, 5); const late = Number(body.lateAfterMinutes ?? 0); const half = Number(body.halfDayAfterMinutes ?? 0); const working = body.workingDays;
  if (!idSafe(sessionId) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !Number.isInteger(late) || late < 0 || late > 360 || !Number.isInteger(half) || half < 0 || half > 600 || !Array.isArray(working) || working.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new SchoolServiceError(400, 'INVALID_POLICY', 'Set a valid session, start time, minute thresholds and working days.');
  const [school, session] = await Promise.all([getDb().collection('schools').doc(schoolId).get(), getDb().collection('academic_sessions').doc(docKey(schoolId, sessionId)).get()]); if (!school.exists) throw new SchoolServiceError(404, 'SCHOOL_NOT_FOUND', 'School not found.'); if (!session.exists || session.get('schoolId') !== schoolId) throw new SchoolServiceError(400, 'INVALID_SESSION', 'Policy session does not belong to this school.'); const timezone = text(body.timezone, 64) || String(school.get('timezone') || 'Asia/Kolkata'); if (!tzOkay(timezone)) throw new SchoolServiceError(400, 'INVALID_TIMEZONE', 'Timezone is invalid.');
  const record = { schoolId, sessionId, defaultStartTime: start, lateAfterMinutes: late, halfDayAfterMinutes: half, workingDays: [...new Set(working as number[])], timezone, status: body.status === 'inactive' ? 'inactive' : 'active', updatedAt: FieldValue.serverTimestamp(), updatedBy: identity.uid };
  await getDb().collection('attendance_policies').doc(docKey(schoolId, sessionId)).set(record, { merge: true }); await audit(schoolId, identity, 'POLICY_CHANGED', 'attendance_policy', sessionId); return record;
}
async function saveHoliday(schoolId: string, identity: SchoolIdentity, body: Record<string, unknown>) {
  requirePermission(identity, 'school:manage'); const date = body.date; const name = text(body.name); const sessionId = text(body.sessionId, 128); const type = String(body.type || 'holiday');
  if (!validIsoDate(date) || !name || !idSafe(sessionId) || !['holiday', 'school_event', 'exam', 'other'].includes(type)) throw new SchoolServiceError(400, 'INVALID_HOLIDAY', 'Date, name, session and valid type are required.');
  const session = await getDb().collection('academic_sessions').doc(docKey(schoolId, sessionId)).get(); if (!session.exists || session.get('schoolId') !== schoolId || date < String(session.get('startDate')) || date > String(session.get('endDate'))) throw new SchoolServiceError(400, 'INVALID_HOLIDAY_SESSION', 'Holiday date must fall inside its academic session.');
  const holidayId = `${sessionId}_${date}_${randomUUID().slice(0, 8)}`; const record = { holidayId, schoolId, sessionId, date, name, type, createdAt: FieldValue.serverTimestamp(), createdBy: identity.uid }; await getDb().collection('school_holidays').doc(docKey(schoolId, holidayId)).create(record); await audit(schoolId, identity, 'HOLIDAY_CREATED', 'holiday', holidayId); return record;
}
async function manageUsers(schoolId: string, identity: SchoolIdentity, method: string, body?: unknown) {
  requirePermission(identity, 'users:manage'); const db = getDb();
  if (method === 'GET') { const q = await db.collection('school_users').where('schoolId', '==', schoolId).orderBy('name').limit(200).get(); return q.docs.map(safeData); }
  const data = bodyObj(body); const uid = text(data.uid, 128); const role = data.role as SchoolRole;
  if (!uid || !SCHOOL_ROLES.includes(role) || !['school_admin', 'principal', 'teacher', 'operator'].includes(role)) throw new SchoolServiceError(400, 'INVALID_USER_ROLE', 'Choose a valid user and school role.');
  if (identity.role !== 'super_admin' && ['school_admin', 'super_admin'].includes(role)) throw new SchoolServiceError(403, 'ROLE_GRANT_FORBIDDEN', 'Only a super admin can grant a school-admin role.');
  if (role === 'teacher' && !text(data.teacherId, 128)) throw new SchoolServiceError(400, 'TEACHER_REQUIRED', 'A teacher profile ID is required for teacher access.');
  if (role === 'teacher') { const teacher = await db.collection('teachers').doc(docKey(schoolId, text(data.teacherId, 128))).get(); if (!teacher.exists || teacher.get('schoolId') !== schoolId) throw new SchoolServiceError(400, 'TEACHER_NOT_FOUND', 'Teacher profile must exist in this school.'); }
  let target; try { target = await getAdminAuth().getUser(uid); } catch { throw new SchoolServiceError(404, 'USER_NOT_FOUND', 'Firebase Authentication user not found.'); }
  const schoolRef = db.collection('schools').doc(schoolId); const userRef = db.collection('school_users').doc(uid); const existing = await userRef.get(); if (existing.exists && existing.get('schoolId') !== schoolId && identity.role !== 'super_admin') throw new SchoolServiceError(409, 'USER_OTHER_SCHOOL', 'User is already assigned to another school.');
  const record = { uid, schoolId, role, name: text(data.name, 120) || target.displayName || '', email: target.email || '', phone: text(data.phone, 40), status: data.status === 'inactive' ? 'inactive' : 'active', ...(role === 'teacher' ? { teacherId: text(data.teacherId, 128) } : {}), createdAt: existing.get('createdAt') || FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
  if (!(await schoolRef.get()).exists) throw new SchoolServiceError(404, 'SCHOOL_NOT_FOUND', 'School not found.');
  const priorClaims = { ...(target.customClaims || {}) }; const claims = record.status === 'inactive' ? { ...priorClaims, role: null, schoolId: null, teacherId: null } : { ...priorClaims, role, schoolId, ...(role === 'teacher' ? { teacherId: text(data.teacherId, 128) } : { teacherId: null }) }; await getAdminAuth().setCustomUserClaims(uid, claims); await userRef.set(record, { merge: true }); await audit(schoolId, identity, record.status === 'inactive' ? 'SCHOOL_USER_DEACTIVATED' : 'SCHOOL_USER_ROLE_CHANGED', 'school_user', uid, { role }); return record;
}
async function saveAdjustment(schoolId: string, identity: SchoolIdentity, body: Record<string, unknown>) {
  requirePermission(identity, 'attendance:adjust'); const { attendanceDate, studentId, newStatus } = body; const reason = text(body.reason, 500);
  if (!validIsoDate(attendanceDate) || !idSafe(studentId) || !['present', 'absent', 'late', 'excused'].includes(String(newStatus)) || !reason) throw new SchoolServiceError(400, 'INVALID_ADJUSTMENT', 'Attendance date, student, new status and reason are required.');
  const db = getDb(); const studentQuery = await db.collection('students').where('schoolId', '==', schoolId).where('studentId', '==', studentId).limit(1).get();
  if (!studentQuery.size || studentQuery.docs[0].get('status') === 'inactive') throw new SchoolServiceError(404, 'STUDENT_NOT_FOUND', 'An active student in this school is required.');
  if (identity.role === 'teacher') {
    const assignment = await db.collection('class_teacher_assignments').where('schoolId', '==', schoolId).where('teacherId', '==', identity.teacherId || identity.uid).where('sectionId', '==', studentQuery.docs[0].get('sectionId')).where('status', '==', 'active').limit(1).get();
    if (!assignment.size) throw new SchoolServiceError(403, 'STUDENT_SCOPE_DENIED', 'Teachers may adjust attendance only for their assigned sections.');
  }
  const adjustmentId = randomUUID(); const record = { adjustmentId, schoolId, attendanceDate, studentId, newStatus, reason, changedBy: identity.uid, changedAt: FieldValue.serverTimestamp() };
  await db.collection('attendance_adjustments').doc(adjustmentId).create(record); await audit(schoolId, identity, 'ATTENDANCE_ADJUSTED', 'attendance_adjustment', adjustmentId, { attendanceDate, studentId, newStatus }); return record;
}
async function listOrAssignDevices(schoolId: string, identity: SchoolIdentity, method: string, deviceId?: string, input?: unknown) {
  requirePermission(identity, method === 'GET' ? 'devices:read' : 'devices:manage'); const db = getDb();
  if (method === 'GET') {
    const currentClaims = (await getAdminAuth().getUser(identity.uid)).customClaims || {};
    const [assigned, tenantDevices] = await Promise.all([
      db.collection('devices').where('schoolId', '==', schoolId).limit(500).get(),
      identity.role === 'super_admin' ? db.collection('devices').limit(500).get() : typeof currentClaims.tenantId === 'string' ? db.collection('devices').where('tenantId', '==', currentClaims.tenantId).limit(500).get() : Promise.resolve(null),
    ]);
    const docs = new Map([...assigned.docs, ...(tenantDevices?.docs || [])].map((d) => [d.id, d])); return [...docs.values()].map(safeData);
  }
  if (!deviceId || !idSafe(deviceId)) throw new SchoolServiceError(400, 'INVALID_DEVICE_ID', 'Device ID is invalid.');
  const body = bodyObj(input); const ref = db.collection('devices').doc(deviceId); const snap = await ref.get(); if (!snap.exists) throw new SchoolServiceError(404, 'DEVICE_NOT_FOUND', 'Device not found.');
  if (identity.role !== 'super_admin' && snap.get('tenantId') && snap.get('tenantId') !== (await getAdminAuth().getUser(identity.uid)).customClaims?.tenantId) throw new SchoolServiceError(403, 'DEVICE_TENANT_DENIED', 'Device belongs to a different client tenant.');
  const currentSchool = snap.get('schoolId'); if (currentSchool && currentSchool !== schoolId && identity.role !== 'super_admin') throw new SchoolServiceError(403, 'DEVICE_SCHOOL_DENIED', 'Only a super admin can move a device between schools.');
  await ref.set({ schoolId, updatedAt: FieldValue.serverTimestamp() }, { merge: true }); await audit(schoolId, identity, 'DEVICE_LINKED', 'device', deviceId, { previousSchoolId: currentSchool || null }); return { deviceId, schoolId };
}

async function schoolStats(schoolId: string, identity: SchoolIdentity, date?: string) {
  requirePermission(identity, 'dashboard:read'); requirePermission(identity, 'attendance:read');
  const school = await getDb().collection('schools').doc(schoolId).get(); if (!school.exists) throw new SchoolServiceError(404, 'SCHOOL_NOT_FOUND', 'School profile has not been configured.');
  const timezone = String(school.get('timezone') || 'Asia/Kolkata'); const today = date || localDateKey(new Date(), timezone); if (!validIsoDate(today)) throw new SchoolServiceError(400, 'INVALID_DATE', 'Date must use YYYY-MM-DD.');
  const [studentsSnap, sessionsSnap, devicesSnap, eventsSnap, holidaysSnap, assignmentSnap] = await Promise.all([
    getDb().collection('students').where('schoolId', '==', schoolId).where('status', '==', 'active').limit(10000).get(),
    getDb().collection('academic_sessions').where('schoolId', '==', schoolId).where('status', '==', 'active').limit(2).get(),
    getDb().collection('devices').where('schoolId', '==', schoolId).where('status', '==', 'online').count().get(),
    getDb().collection('attendance').where('schoolId', '==', schoolId).where('timestamp', '>=', zonedMidnightUtc(today, timezone)).where('timestamp', '<', zonedMidnightUtc(new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0,10), timezone)).limit(20000).get(),
    getDb().collection('school_holidays').where('schoolId', '==', schoolId).where('date', '==', today).limit(10).get(),
    identity.role === 'teacher' ? getDb().collection('class_teacher_assignments').where('schoolId', '==', schoolId).where('teacherId', '==', identity.teacherId || identity.uid).where('status', '==', 'active').limit(100).get() : Promise.resolve(null),
  ]);
  const activeSession = sessionsSnap.docs[0]; const policySnap = activeSession ? await getDb().collection('attendance_policies').where('schoolId', '==', schoolId).where('sessionId', '==', activeSession.get('sessionId') || activeSession.id.replace(`${schoolId}__`, '')).where('status', '==', 'active').limit(1).get() : null;
  const assignments = assignmentSnap?.docs || []; const allowedSections = new Set(assignments.map((d) => String(d.get('sectionId'))));
  const activeStudents = studentsSnap.docs.filter((d) => {
    const sessionMatches = !activeSession || d.get('sessionId') === (activeSession.get('sessionId') || activeSession.id.replace(`${schoolId}__`, ''));
    const teacherMatches = identity.role !== 'teacher' || allowedSections.has(String(d.get('sectionId')));
    return sessionMatches && teacherMatches;
  });
  const policy = policySnap?.docs[0]?.data() || {}; const eligibleEvents = eventsSnap.docs.filter((d) => identity.role !== 'teacher' || allowedSections.has(String(d.get('sectionId'))));
  const first = new Map<string, Date>(); for (const doc of eligibleEvents) { const d = doc.data(); if (!d.studentId || d.status === 'duplicate' || d.status === 'unknown' || d.webhookEligible === false || (d.verified !== true && d.verificationStatus !== 'verified')) continue; const time = d.timestamp instanceof Timestamp ? d.timestamp.toDate() : d.timestamp instanceof Date ? d.timestamp : null; if (!time) continue; const id = String(d.studentId); if (!first.has(id) || time < first.get(id)!) first.set(id, time); }
  const adjustments = await getDb().collection('attendance_adjustments').where('schoolId', '==', schoolId).where('attendanceDate', '==', today).limit(20000).get(); const adjusted = new Map(adjustments.docs.map((d) => [String(d.get('studentId')), String(d.get('newStatus'))]));
  const classes = await getDb().collection('classes').where('schoolId', '==', schoolId).where('status', '==', 'active').limit(200).get(); const sections = await getDb().collection('sections').where('schoolId', '==', schoolId).where('status', '==', 'active').limit(500).get();
  const classNames = new Map(classes.docs.map((d) => [String(d.get('id') || d.id.split('__').at(-1)), String(d.get('name'))])); const sectionNames = new Map(sections.docs.map((d) => [String(d.get('id') || d.id.split('__').at(-1)), String(d.get('name'))]));
  const dayOfWeek = new Date(`${today}T00:00:00Z`).getUTCDay(); const workingToday = !holidaysSnap.size && Array.isArray(policy.workingDays) && policy.workingDays.includes(dayOfWeek);
  const statuses = workingToday ? activeStudents.map((d) => { const id = String(d.get('studentId') || d.id); if (adjusted.has(id)) return adjusted.get(id)!; const firstTime = first.get(id); return firstTime ? (policy.defaultStartTime ? lateThresholdStatus(firstTime, today, String(policy.defaultStartTime), Number(policy.lateAfterMinutes || 0), timezone) : 'present') : 'absent'; }) : [];
  const summary = attendanceSummary(activeStudents.length, statuses); const groups = new Map<string, { sectionId: string; classId: string; statuses: string[] }>();
  activeStudents.forEach((d, i) => { const classId = String(d.get('classId') || d.get('class') || 'unassigned'); const sectionId = String(d.get('sectionId') || d.get('section') || 'unassigned'); const key = `${classId}__${sectionId}`; if (!groups.has(key)) groups.set(key, { classId, sectionId, statuses: [] }); if (workingToday) groups.get(key)!.statuses.push(statuses[i]); });
  const classWise = [...groups.values()].map((g) => ({ classId: g.classId, className: classNames.get(g.classId) || g.classId, sectionId: g.sectionId, sectionName: sectionNames.get(g.sectionId) || g.sectionId, ...attendanceSummary(g.statuses.length, g.statuses) }));
  return { school: { schoolId, name: school.get('name'), timezone }, date: today, holiday: holidaysSnap.size > 0, workingDay: workingToday, session: activeSession ? safeData(activeSession) : null, ...summary, activeDevices: devicesSnap.data().count, classWise, recentEvents: eligibleEvents.filter((d) => d.get('verified') === true || d.get('verificationStatus') === 'verified').slice(-10).reverse().map((d) => ({ id: d.id, studentId: d.get('studentId'), deviceId: d.get('deviceId'), timestamp: iso(d.get('timestamp')), method: d.get('method'), status: d.get('status') })) };
}
async function report(schoolId: string, identity: SchoolIdentity, query: URLSearchParams) {
  requirePermission(identity, 'reports:read'); const school = await getDb().collection('schools').doc(schoolId).get(); if (!school.exists) throw new SchoolServiceError(404, 'SCHOOL_NOT_FOUND', 'School not found.'); const timezone = String(school.get('timezone') || 'Asia/Kolkata');
  const from = query.get('from') || localDateKey(new Date(), timezone); const to = query.get('to') || from; if (!validIsoDate(from) || !validIsoDate(to) || from > to) throw new SchoolServiceError(400, 'INVALID_DATE_RANGE', 'Use a valid from/to range in YYYY-MM-DD.');
  const sessionId = query.get('sessionId'); const selectedSession = sessionId ? await getDb().collection('academic_sessions').doc(docKey(schoolId, sessionId)).get() : null;
  if (sessionId && (!selectedSession?.exists || selectedSession.get('schoolId') !== schoolId)) throw new SchoolServiceError(400, 'INVALID_SESSION', 'Academic session is not part of this school.');
  const activeSessionQuery = !selectedSession ? await getDb().collection('academic_sessions').where('schoolId', '==', schoolId).where('status', '==', 'active').limit(1).get() : null;
  const reportSession = selectedSession?.exists ? selectedSession : activeSessionQuery?.docs[0] || null;
  if (!reportSession) throw new SchoolServiceError(409, 'ACTIVE_SESSION_REQUIRED', 'Create or select an academic session before generating attendance reports.');
  const sessionBounds = reportSession.data(); const boundedFrom = from < String(sessionBounds?.startDate || from) ? String(sessionBounds?.startDate) : from; const boundedTo = to > String(sessionBounds?.endDate || to) ? String(sessionBounds?.endDate) : to;
  if (boundedFrom > boundedTo) throw new SchoolServiceError(400, 'SESSION_DATE_RANGE_EMPTY', 'The selected date range does not overlap that academic session.');
  const start = zonedMidnightUtc(boundedFrom, timezone); const endDate = new Date(Date.parse(`${boundedTo}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); const end = zonedMidnightUtc(endDate, timezone);
  const reportSessionId = String(reportSession.get('sessionId') || reportSession.id.replace(`${schoolId}__`, ''));
  const [studentsSnap, eventsSnap, holidaySnap, adjustmentsSnap] = await Promise.all([
    getDb().collection('students').where('schoolId', '==', schoolId).where('sessionId', '==', reportSessionId).where('status', '==', 'active').limit(10000).get(),
    getDb().collection('attendance').where('schoolId', '==', schoolId).where('sessionId', '==', reportSessionId).where('timestamp', '>=', start).where('timestamp', '<', end).orderBy('timestamp', 'asc').limit(20000).get(),
    getDb().collection('school_holidays').where('schoolId', '==', schoolId).where('sessionId', '==', reportSessionId).where('date', '>=', boundedFrom).where('date', '<=', boundedTo).limit(1000).get(),
    getDb().collection('attendance_adjustments').where('schoolId', '==', schoolId).where('attendanceDate', '>=', boundedFrom).where('attendanceDate', '<=', boundedTo).limit(20000).get(),
  ]);
  const policySnap = await getDb().collection('attendance_policies').where('schoolId', '==', schoolId).where('sessionId', '==', reportSessionId).where('status', '==', 'active').limit(1).get();
  let students = studentsSnap.docs; if (identity.role === 'teacher') { const assignments = await getDb().collection('class_teacher_assignments').where('schoolId', '==', schoolId).where('teacherId', '==', identity.teacherId || identity.uid).where('status', '==', 'active').limit(100).get(); const allowed = new Set(assignments.docs.map((d) => String(d.get('sectionId')))); students = students.filter((d) => allowed.has(String(d.get('sectionId')))); }
  const holidayDates = new Set(holidaySnap.docs.filter((d) => ['holiday', 'school_event'].includes(String(d.get('type')))).map((d) => String(d.get('date')))); const policy = policySnap.docs[0]?.data() || {}; const workDays = Array.isArray(policy.workingDays) ? policy.workingDays as number[] : []; const applicable = workingDaysBetween(boundedFrom, boundedTo, workDays, holidayDates, timezone);
  const deviceFilter = query.get('deviceId') || ''; const methodFilter = query.get('method')?.toLowerCase() || '';
  const filteredEvents = eventsSnap.docs.filter((e) => (!deviceFilter || e.get('deviceId') === deviceFilter) && (!methodFilter || String(e.get('method') || '').toLowerCase() === methodFilter));
  const studentsById = new Map(students.map((d) => [String(d.get('studentId') || d.id), d])); const dayEvents = new Map<string, Map<string, Date>>();
  for (const e of filteredEvents) { const sid = String(e.get('studentId') || ''); const time = e.get('timestamp') instanceof Timestamp ? (e.get('timestamp') as Timestamp).toDate() : null; if (!studentsById.has(sid) || !time || e.get('status') === 'duplicate' || e.get('status') === 'unknown' || (e.get('verified') !== true && e.get('verificationStatus') !== 'verified')) continue; const date = localDateKey(time, timezone); if (!dayEvents.has(date)) dayEvents.set(date, new Map()); const byStudent = dayEvents.get(date)!; if (!byStudent.has(sid)) byStudent.set(sid, time); }
  const adjustmentMap = new Map(adjustmentsSnap.docs.map((d) => [`${d.get('attendanceDate')}__${d.get('studentId')}`, String(d.get('newStatus'))])); const studentRows = [...studentsById].map(([studentId, student]) => { const days = applicable.map((date) => { const manual = adjustmentMap.get(`${date}__${studentId}`); if (manual) return manual; const first = dayEvents.get(date)?.get(studentId); return first ? policy.defaultStartTime ? lateThresholdStatus(first, date, String(policy.defaultStartTime), Number(policy.lateAfterMinutes || 0), timezone) : 'present' : 'absent'; }); const counts = attendanceSummary(applicable.length, days); return { studentId, name: student.get('name'), class: student.get('class') || '', section: student.get('section') || '', ...counts }; });
  const summary = attendanceSummary(studentRows.length * applicable.length, studentRows.flatMap((s) => applicable.map((date) => { const manual = adjustmentMap.get(`${date}__${s.studentId}`); if (manual) return manual; const first = dayEvents.get(date)?.get(s.studentId); return first ? policy.defaultStartTime ? lateThresholdStatus(first, date, String(policy.defaultStartTime), Number(policy.lateAfterMinutes || 0), timezone) : 'present' : 'absent'; })));
  const classIdFilter = query.get('classId'); const sectionFilter = query.get('sectionId'); const studentFilter = query.get('studentId');
  const statusFilter = query.get('status') || '';
  const filtered = studentRows.filter((s) => (!studentFilter || s.studentId === studentFilter) && (!classIdFilter || (studentsById.get(s.studentId)?.get('classId') || studentsById.get(s.studentId)?.get('class')) === classIdFilter) && (!sectionFilter || (studentsById.get(s.studentId)?.get('sectionId') || studentsById.get(s.studentId)?.get('section')) === sectionFilter) && (!statusFilter || Number(s[statusFilter as keyof typeof s] || 0) > 0));
  if (query.get('format') === 'csv') {
    if (!['super_admin', 'school_admin', 'principal'].includes(identity.role)) throw new SchoolServiceError(403, 'CSV_EXPORT_FORBIDDEN', 'CSV exports require school admin, principal or super admin access.');
    const lines = [['Student ID', 'Name', 'Class', 'Section', 'Applicable days', 'Present', 'Absent', 'Late', 'Excused', 'Attendance %'], ...filtered.map((s) => [s.studentId, s.name, s.class, s.section, s.totalStudents, s.present, s.absent, s.late, s.excused, s.attendancePercentage])].map((r) => r.map(csvCell).join(','));
    return { csv: lines.join('\r\n'), filename: `attendance-${from}-${to}.csv` };
  }
  const daily = applicable.map((date) => { const statuses = students.flatMap((d) => { const sid = String(d.get('studentId') || d.id); const manual = adjustmentMap.get(`${date}__${sid}`); const first = dayEvents.get(date)?.get(sid); return [manual || (first ? policy.defaultStartTime ? lateThresholdStatus(first, date, String(policy.defaultStartTime), Number(policy.lateAfterMinutes || 0), timezone) : 'present' : 'absent')]; }); return { date, ...attendanceSummary(students.length, statuses) }; });
  return { schoolId, session: safeData(reportSession), from: boundedFrom, to: boundedTo, applicableDays: applicable.length, summary, daily, students: filtered.slice(0, 1000), filteredCount: filtered.length, truncated: filtered.length > 1000, rawEventCount: filteredEvents.length, holidays: [...holidayDates] };
}

export async function handleSchoolManagementRequest(input: { token: string; method: string; path: string; url: URL; body?: unknown }) {
  const identity = await schoolIdentity(input.token); const parts = input.path.split('/').filter(Boolean); const resource = parts[3]; const id = parts[4];
  if (resource === 'schools' && input.method === 'POST') return createSchool(identity, bodyObj(input.body));
  const schoolId = scopeSchool(identity, input.url.searchParams.get('schoolId') || bodyObjSafe(input.body)?.schoolId);
  if (resource === 'schools' && input.method === 'PATCH') return updateSchool(schoolId, identity, bodyObj(input.body));
  if (resource === 'bootstrap' && input.method === 'GET') {
    requirePermission(identity, 'students:read');
    const [school, sessions, allClasses, allSections, teachers, policy, holidays, devices] = await Promise.all([getDb().collection('schools').doc(schoolId).get(), listCollection('academic_sessions', schoolId, 100), listCollection('classes', schoolId, 200), listCollection('sections', schoolId, 500), identity.role === 'teacher' ? Promise.resolve([]) : listCollection('teachers', schoolId, 500), getDb().collection('attendance_policies').where('schoolId', '==', schoolId).where('status', '==', 'active').limit(1).get(), getDb().collection('school_holidays').where('schoolId', '==', schoolId).orderBy('date', 'desc').limit(200).get(), getDb().collection('devices').where('schoolId', '==', schoolId).limit(200).get()]);
    if (!school.exists) throw new SchoolServiceError(404, 'SCHOOL_NOT_FOUND', 'Create or assign a school profile before using school management.');
    let classes = allClasses; let sections = allSections;
    if (identity.role === 'teacher') { const a = await getDb().collection('class_teacher_assignments').where('schoolId', '==', schoolId).where('teacherId', '==', identity.teacherId || identity.uid).where('status', '==', 'active').limit(100).get(); const sectionIds = new Set(a.docs.map((d) => String(d.get('sectionId')))); const classIds = new Set(a.docs.map((d) => String(d.get('classId')))); classes = allClasses.filter((r) => classIds.has(String(r.id))); sections = allSections.filter((r) => sectionIds.has(String(r.id))); }
    return { identity: { uid: identity.uid, role: identity.role, schoolId }, school: { ...safeData(school), timezone: school.get('timezone') || 'Asia/Kolkata' }, sessions, classes, sections, teachers, devices: devices.docs.map(safeData), policy: policy.docs[0] ? safeData(policy.docs[0]) : null, holidays: holidays.docs.map(safeData) };
  }
  if (resource === 'dashboard' && input.method === 'GET') return schoolStats(schoolId, identity, input.url.searchParams.get('date') || undefined);
  if (resource === 'reports' && input.method === 'GET') { const data = await report(schoolId, identity, input.url.searchParams); if ('csv' in data) return data; return data; }
  if (resource === 'sessions' && input.method === 'GET') { requirePermission(identity, 'students:read'); return listCollection('academic_sessions', schoolId, 100); }
  if (resource === 'sessions' && input.method === 'POST') return saveSession(schoolId, identity, bodyObj(input.body));
  if (resource === 'classes' && input.method === 'GET') { requirePermission(identity, 'students:read'); let rows = await listCollection('classes', schoolId, 500); if (identity.role === 'teacher') { const a = await getDb().collection('class_teacher_assignments').where('schoolId', '==', schoolId).where('teacherId', '==', identity.teacherId || identity.uid).where('status', '==', 'active').limit(100).get(); const ids = new Set(a.docs.map((d) => String(d.get('classId')))); rows = rows.filter((r) => ids.has(String(r.id))); } return rows; }
  if (resource === 'classes' && input.method === 'POST') return saveNamed('classes', schoolId, identity, bodyObj(input.body), 'classes:manage');
  if (resource === 'sections' && input.method === 'GET') { requirePermission(identity, 'students:read'); let rows = await listCollection('sections', schoolId, 500); if (identity.role === 'teacher') { const a = await getDb().collection('class_teacher_assignments').where('schoolId', '==', schoolId).where('teacherId', '==', identity.teacherId || identity.uid).where('status', '==', 'active').limit(100).get(); const ids = new Set(a.docs.map((d) => String(d.get('sectionId')))); rows = rows.filter((r) => ids.has(String(r.id))); } return rows; }
  if (resource === 'sections' && input.method === 'POST') return saveNamed('sections', schoolId, identity, bodyObj(input.body), 'classes:manage');
  if (resource === 'teachers' && input.method === 'GET') { requirePermission(identity, 'teachers:read'); return listCollection('teachers', schoolId, 500); }
  if (resource === 'teachers' && input.method === 'POST') return saveNamed('teachers', schoolId, identity, bodyObj(input.body), 'teachers:manage');
  if (resource === 'assignments' && input.method === 'GET') { requirePermission(identity, 'teachers:read'); const q = await getDb().collection('class_teacher_assignments').where('schoolId', '==', schoolId).limit(500).get(); return q.docs.map(safeData); }
  if (resource === 'assignments' && input.method === 'POST') return saveAssignment(schoolId, identity, bodyObj(input.body));
  if (resource === 'users' && ['GET', 'POST'].includes(input.method)) return manageUsers(schoolId, identity, input.method, input.body);
  if (resource === 'devices' && input.method === 'GET') return listOrAssignDevices(schoolId, identity, 'GET');
  if (resource === 'devices' && input.method === 'PATCH' && id) return listOrAssignDevices(schoolId, identity, 'PATCH', id, input.body);
  if (resource === 'students' && input.method === 'GET') { requirePermission(identity, identity.role === 'teacher' ? 'students:assigned' : 'students:read'); let q = getDb().collection('students').where('schoolId', '==', schoolId).orderBy('name'); const term = input.url.searchParams.get('search')?.trim(); if (term) q = getDb().collection('students').where('schoolId', '==', schoolId).orderBy('name'); const snap = await q.limit(500).get(); let rows = snap.docs.map(safeData); if (identity.role === 'teacher') { const a = await getDb().collection('class_teacher_assignments').where('schoolId', '==', schoolId).where('teacherId', '==', identity.teacherId || identity.uid).where('status', '==', 'active').limit(100).get(); const ids = new Set(a.docs.map((d) => String(d.get('sectionId')))); rows = rows.filter((r) => ids.has(String(r.sectionId))); } if (term) { const needle = term.toLowerCase(); rows = rows.filter((r) => [r.name, r.studentId, r.admissionNumber, r.deviceUserId, r.rollNumber].some((x) => String(x || '').toLowerCase().includes(needle))); } return { students: rows.slice(0, 100), totalLoaded: rows.length, truncated: rows.length > 100 }; }
  if (resource === 'students' && input.method === 'POST') return saveStudent(schoolId, identity, bodyObj(input.body));
  if (resource === 'students' && input.method === 'PATCH' && id) return saveStudent(schoolId, identity, { ...bodyObj(input.body), studentId: id }, docKey(schoolId, id));
  if (resource === 'settings' && input.method === 'GET') { requirePermission(identity, 'school:manage'); const snap = await getDb().collection('attendance_policies').where('schoolId', '==', schoolId).where('status', '==', 'active').limit(1).get(); return { school: safeData(await getDb().collection('schools').doc(schoolId).get()), policy: snap.docs[0] ? safeData(snap.docs[0]) : null }; }
  if (resource === 'settings' && input.method === 'PATCH') return savePolicy(schoolId, identity, bodyObj(input.body));
  if (resource === 'holidays' && input.method === 'POST') return saveHoliday(schoolId, identity, bodyObj(input.body));
  if (resource === 'adjustments' && input.method === 'POST') return saveAdjustment(schoolId, identity, bodyObj(input.body));
  throw new SchoolServiceError(404, 'NOT_FOUND', 'School management endpoint not found.');
}
function bodyObjSafe(v: unknown): Record<string, unknown> | null { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; }
