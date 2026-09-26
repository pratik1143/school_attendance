import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import { getDb } from '../firestore/admin.ts';
import { autoStudentDocId, deviceUserDocId, enrollmentMetadata, resolveDeviceUserStudentMatch, studentDeviceLinkId } from './model.ts';
import type { DeviceUserPacket } from '../tcp/deviceUserParser.ts';

export class EnrollmentServiceError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) { super(message); this.statusCode = statusCode; this.code = code; }
}

const safeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v.trim());
export type ParsedDeviceUser = DeviceUserPacket;

function asDate(value: unknown) { return value instanceof Timestamp ? value.toDate().toISOString() : value instanceof Date ? value.toISOString() : null; }
function safeUser(id: string, data: DocumentData) {
  return {
    id, deviceUserId: data.deviceUserId, deviceId: data.deviceId, deviceName: data.deviceName || data.deviceId,
    name: data.name || null, status: data.status || 'new', enrollmentStatus: data.enrollmentStatus || 'unknown',
    faceEnrolled: typeof data.faceEnrolled === 'boolean' ? data.faceEnrolled : null,
    fingerprintEnrolled: typeof data.fingerprintEnrolled === 'boolean' ? data.fingerprintEnrolled : null,
    palmEnrolled: typeof data.palmEnrolled === 'boolean' ? data.palmEnrolled : null,
    cardEnrolled: typeof data.cardEnrolled === 'boolean' ? data.cardEnrolled : null,
    passwordEnrolled: typeof data.passwordEnrolled === 'boolean' ? data.passwordEnrolled : null,
    source: data.source || 'unknown', firstSeenOnDevice: asDate(data.firstSeenOnDevice), lastSeenOnDevice: asDate(data.lastSeenOnDevice),
    studentId: data.studentId || null, rawLogId: data.rawLogId || null,
  };
}
async function audit(db: Firestore, input: { adminUserId: string; deviceId: string; deviceUserId: string; studentId?: string | null; action: string; source: string; details?: string }) {
  await db.collection('enrollment_audit_logs').add({ ...input, details: (input.details || '').slice(0, 300), timestamp: FieldValue.serverTimestamp() });
}
async function syncLog(db: Firestore, input: { tenantId: string; deviceId: string; deviceUserId: string; eventType: string; status: 'success' | 'warning' | 'error'; studentId?: string | null; message: string; rawLogId?: string | null }) {
  await db.collection('device_user_sync_logs').add({ syncId: randomUUID(), ...input, timestamp: FieldValue.serverTimestamp() });
}

export async function listDeviceEnrollment() {
  const db = getDb();
  const [users, devices, students] = await Promise.all([
    db.collection('device_users').orderBy('updatedAt', 'desc').limit(500).get(),
    db.collection('devices').orderBy('deviceName').limit(200).get(),
    db.collection('students').orderBy('name').limit(1000).get(),
  ]);
  const deviceMap = new Map(devices.docs.map((d) => [d.id, d.data()]));
  return {
    automaticSyncAvailable: false,
    limitation: 'Device user enrollment data is not available through the currently observed T800 network protocol.',
    deviceUsers: users.docs.map((d) => safeUser(d.id, { ...d.data(), deviceName: deviceMap.get(String(d.get('deviceId')))?.deviceName || d.get('deviceId') })),
    devices: devices.docs.map((d) => ({ id: d.id, deviceId: d.get('deviceId') || d.id, deviceName: d.get('deviceName') || d.id, tenantId: d.get('tenantId') || null })),
    students: students.docs.map((d) => ({ id: d.id, studentId: d.get('studentId') || d.id, name: d.get('name') || '', class: d.get('class') || '', section: d.get('section') || '', status: d.get('status') || '' })),
  };
}

/** Manual declaration is the supported fallback until verified device user packets exist. */
export async function registerManualDeviceUser(input: { deviceId?: unknown; deviceUserId?: unknown; name?: unknown; adminUserId: string }) {
  const db = getDb();
  if (!safeId(input.deviceId) || !String(input.deviceId).trim()) throw new EnrollmentServiceError(400, 'INVALID_DEVICE_ID', 'Choose a valid device.');
  if (!safeId(input.deviceUserId) || !String(input.deviceUserId).trim()) throw new EnrollmentServiceError(400, 'INVALID_DEVICE_USER_ID', 'Device user ID is required.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120) throw new EnrollmentServiceError(400, 'INVALID_NAME', 'Name must be between 1 and 120 characters.');
  const deviceId = input.deviceId.trim(); const deviceUserId = input.deviceUserId.trim(); const name = input.name.trim();
  const deviceRef = db.collection('devices').doc(deviceId); const userRef = db.collection('device_users').doc(deviceUserDocId(deviceId, deviceUserId));
  const result = await db.runTransaction(async (tx) => {
    const [device, existing] = await Promise.all([tx.get(deviceRef), tx.get(userRef)]);
    if (!device.exists) throw new EnrollmentServiceError(404, 'DEVICE_NOT_FOUND', 'Device not found.');
    const tenantId = device.get('tenantId');
    if (typeof tenantId !== 'string' || !tenantId) throw new EnrollmentServiceError(409, 'DEVICE_TENANT_REQUIRED', 'Assign a tenant to this device before enrollment.');
    const [exactStudentLinks, exactStudents, tenantStudents, sameUserOnDevices] = await Promise.all([
      tx.get(db.collection('student_device_links').where('deviceId', '==', deviceId).where('deviceUserId', '==', deviceUserId).limit(2)),
      tx.get(db.collection('students').where('tenantId', '==', tenantId).where('deviceId', '==', deviceId).where('deviceUserId', '==', deviceUserId).limit(2)),
      tx.get(db.collection('students').where('deviceUserId', '==', deviceUserId).limit(3)),
      tx.get(db.collection('device_users').where('deviceUserId', '==', deviceUserId).limit(3)),
    ]);
    const deviceName = device.get('deviceName') || deviceId;
    const now = FieldValue.serverTimestamp();
    const studentDocs = new Map([...exactStudents.docs, ...tenantStudents.docs].map((d) => [d.id, d]));
    const match = resolveDeviceUserStudentMatch({
      deviceId, tenantId, deviceUserId,
      links: exactStudentLinks.docs.map((d) => ({ deviceId: String(d.get('deviceId')), deviceUserId: String(d.get('deviceUserId')), studentId: String(d.get('studentId')), tenantId: String(d.get('tenantId') || '') })),
      students: [...studentDocs.values()].map((d) => ({ studentId: String(d.get('studentId') || d.id), deviceUserId: d.get('deviceUserId'), deviceId: d.get('deviceId'), tenantId: d.get('tenantId') })),
      knownDeviceUsers: sameUserOnDevices.docs.map((d) => ({ deviceId: String(d.get('deviceId')), deviceUserId: String(d.get('deviceUserId')) })),
    });
    let studentId: string | null = match.studentId;
    const matchType = match.match === 'ambiguous' ? 'none' : match.match;
    const autoId = autoStudentDocId(deviceId, deviceUserId); const autoRef = db.collection('students').doc(autoId);
    let autoExists = false;
    if (!studentId) {
      autoExists = (await tx.get(autoRef)).exists;
      studentId = autoId;
    }
    const createdAutoStudent = matchType === 'none' && !autoExists;
    const previous = existing.data();
    const nextStatus = studentId && matchType !== 'none' ? 'linked' : 'pending_profile';
    tx.set(userRef, {
      deviceUserId, deviceId, tenantId, clientId: device.get('clientId') || null, deviceName, name,
      status: nextStatus === 'linked' ? 'linked' : (previous?.status === 'ignored' ? 'ignored' : 'pending_profile'),
      enrollmentStatus: 'unknown', ...enrollmentMetadata({}),
      source: 'manual', studentId, firstSeenOnDevice: previous?.firstSeenOnDevice || null, lastSeenOnDevice: null,
      createdAt: previous?.createdAt || now, updatedAt: now,
    }, { merge: true });
    if (matchType !== 'none' && studentId) {
      const linkRef = db.collection('student_device_links').doc(studentDeviceLinkId(deviceId, deviceUserId));
      tx.set(linkRef, { studentId, deviceId, deviceUserId, tenantId, status: 'active', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    } else if (!autoExists) {
      tx.create(autoRef, { studentId: autoId, name, deviceUserId, deviceId, status: 'pending_profile', registrationSource: 'device_enrollment', deviceEnrollmentStatus: 'pending_profile', needsStudentProfile: true, tenantId, createdAt: now, updatedAt: now });
    } else {
      tx.set(autoRef, { name, updatedAt: now }, { merge: true });
    }
    return { deviceUserId, deviceId, studentId, created: !existing.exists, createdAutoStudent, status: nextStatus };
  });
  await syncLog(db, { tenantId: String((await deviceRef.get()).get('tenantId')), deviceId, deviceUserId, eventType: result.created ? 'DEVICE_USER_CREATED' : 'DEVICE_USER_UPDATED', status: 'success', studentId: result.studentId, message: 'Device user entered manually; biometric enrollment metadata is unknown.' });
  if (result.createdAutoStudent) await syncLog(db, { tenantId: String((await deviceRef.get()).get('tenantId')), deviceId, deviceUserId, eventType: 'STUDENT_AUTO_CREATED', status: 'success', studentId: result.studentId, message: 'Created a pending-profile student shell without inventing school fields.' });
  await audit(db, { adminUserId: input.adminUserId, deviceId, deviceUserId, studentId: result.studentId, action: result.created ? 'DEVICE_USER_CREATED' : 'DEVICE_USER_UPDATED', source: 'manual', details: 'Manual fallback; no device enrollment packet was observed.' });
  return result;
}

export async function linkDeviceUser(input: { deviceId: string; deviceUserId: string; studentId: string; adminUserId: string }) {
  const db = getDb(); const userRef = db.collection('device_users').doc(deviceUserDocId(input.deviceId, input.deviceUserId));
  const studentRef = db.collection('students').doc(input.studentId);
  const result = await db.runTransaction(async (tx) => {
    const [user, student] = await Promise.all([tx.get(userRef), tx.get(studentRef)]);
    if (!user.exists) throw new EnrollmentServiceError(404, 'DEVICE_USER_NOT_FOUND', 'Device user not found.');
    if (!student.exists || student.get('tenantId') !== user.get('tenantId')) throw new EnrollmentServiceError(404, 'STUDENT_NOT_FOUND', 'Student not found in this device tenant.');
    const studentId = String(student.get('studentId') || student.id); const linkRef = db.collection('student_device_links').doc(studentDeviceLinkId(input.deviceId, input.deviceUserId)); const previousLink = await tx.get(linkRef);
    if (previousLink.exists && previousLink.get('studentId') !== studentId) throw new EnrollmentServiceError(409, 'DEVICE_USER_ALREADY_LINKED', 'This device user is already linked to another student.');
    const oldStudentId = String(user.get('studentId') || '');
    if (oldStudentId.startsWith('AUTO-') && oldStudentId !== studentId) {
      const autoRef = db.collection('students').doc(oldStudentId); const auto = await tx.get(autoRef);
      if (auto.exists) tx.set(autoRef, { status: 'superseded', needsStudentProfile: false, supersededBy: studentId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    const studentPatch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (!student.get('deviceUserId')) studentPatch.deviceUserId = input.deviceUserId;
    if (!student.get('deviceId')) studentPatch.deviceId = input.deviceId;
    studentPatch.deviceEnrollmentStatus = 'linked';
    tx.set(linkRef, { studentId, deviceId: input.deviceId, deviceUserId: input.deviceUserId, tenantId: user.get('tenantId'), status: 'active', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.update(studentRef, studentPatch);
    tx.update(userRef, { studentId, status: 'linked', enrollmentStatus: 'linked', updatedAt: FieldValue.serverTimestamp() });
    return { studentId, deviceId: input.deviceId, deviceUserId: input.deviceUserId };
  });
  await syncLog(db, { tenantId: String((await userRef.get()).get('tenantId')), deviceId: input.deviceId, deviceUserId: input.deviceUserId, eventType: 'STUDENT_LINKED', status: 'success', studentId: result.studentId, message: 'Device user linked to an existing student.' });
  await audit(db, { adminUserId: input.adminUserId, ...result, action: 'STUDENT_LINKED', source: 'admin' });
  return result;
}

export async function completeDeviceUserProfile(input: { deviceId: string; deviceUserId: string; studentId: string; name: string; className: string; section: string; status?: string; adminUserId: string }) {
  const db = getDb();
  const name = input.name.trim(); const className = input.className.trim(); const section = input.section.trim(); const studentId = input.studentId.trim();
  if (!safeId(studentId) || !name || name.length > 120 || !className || className.length > 40 || !section || section.length > 40) throw new EnrollmentServiceError(400, 'INVALID_STUDENT_PROFILE', 'Student ID, name, class, and section are required.');
  if (input.status && !['active', 'inactive'].includes(input.status)) throw new EnrollmentServiceError(400, 'INVALID_STUDENT_STATUS', 'Student status must be active or inactive.');
  const userRef = db.collection('device_users').doc(deviceUserDocId(input.deviceId, input.deviceUserId)); const newStudentRef = db.collection('students').doc(studentId);
  const result = await db.runTransaction(async (tx) => {
    const user = await tx.get(userRef); if (!user.exists) throw new EnrollmentServiceError(404, 'DEVICE_USER_NOT_FOUND', 'Device user not found.');
    const tenantId = user.get('tenantId'); const oldId = String(user.get('studentId') || ''); const oldRef = oldId.startsWith('AUTO-') ? db.collection('students').doc(oldId) : null;
    const linkRef = db.collection('student_device_links').doc(studentDeviceLinkId(input.deviceId, input.deviceUserId));
    const [target, old, existingLink] = await Promise.all([tx.get(newStudentRef), oldRef ? tx.get(oldRef) : Promise.resolve(null), tx.get(linkRef)]);
    if (target.exists && target.id !== oldId) throw new EnrollmentServiceError(409, 'STUDENT_ID_EXISTS', 'That student ID is already in use.');
    if (existingLink.exists && existingLink.get('studentId') !== studentId) throw new EnrollmentServiceError(409, 'DEVICE_USER_ALREADY_LINKED', 'This device user is already linked to another student.');
    const now = FieldValue.serverTimestamp();
    tx.set(newStudentRef, { ...(old?.exists ? old.data() : {}), studentId, name, class: className, section, deviceUserId: input.deviceUserId, deviceId: input.deviceId, status: input.status || 'active', registrationSource: 'device_enrollment', deviceEnrollmentStatus: 'linked', needsStudentProfile: false, tenantId, updatedAt: now, ...(!old?.exists ? { createdAt: now } : {}) }, { merge: true });
    if (oldRef && oldRef.id !== newStudentRef.id && old?.exists) tx.set(oldRef, { status: 'superseded', needsStudentProfile: false, supersededBy: studentId, updatedAt: now }, { merge: true });
    tx.set(linkRef, { studentId, deviceId: input.deviceId, deviceUserId: input.deviceUserId, tenantId, status: 'active', createdAt: now, updatedAt: now }, { merge: true });
    tx.update(userRef, { studentId, name, status: 'linked', enrollmentStatus: 'linked', updatedAt: now });
    return { studentId, deviceId: input.deviceId, deviceUserId: input.deviceUserId };
  });
  await syncLog(db, { tenantId: String((await userRef.get()).get('tenantId')), deviceId: input.deviceId, deviceUserId: input.deviceUserId, eventType: 'STUDENT_PROFILE_COMPLETED', status: 'success', studentId: result.studentId, message: 'Pending student profile completed by admin.' });
  await audit(db, { adminUserId: input.adminUserId, ...result, action: 'STUDENT_CREATED', source: 'admin' });
  return result;
}

export async function setDeviceUserStatus(input: { deviceId: string; deviceUserId: string; status: 'new' | 'pending_profile' | 'ignored' | 'disabled'; adminUserId: string }) {
  const db = getDb(); const ref = db.collection('device_users').doc(deviceUserDocId(input.deviceId, input.deviceUserId)); const snap = await ref.get();
  if (!snap.exists) throw new EnrollmentServiceError(404, 'DEVICE_USER_NOT_FOUND', 'Device user not found.');
  await ref.update({ status: input.status, updatedAt: FieldValue.serverTimestamp() });
  const eventType = input.status === 'ignored' ? 'DEVICE_USER_IGNORED' : input.status === 'disabled' ? 'DEVICE_USER_DISABLED' : 'DEVICE_USER_UPDATED';
  await syncLog(db, { tenantId: String(snap.get('tenantId')), deviceId: input.deviceId, deviceUserId: input.deviceUserId, eventType, status: 'success', studentId: snap.get('studentId') || null, message: `Admin set device user status to ${input.status}.` });
  await audit(db, { adminUserId: input.adminUserId, deviceId: input.deviceId, deviceUserId: input.deviceUserId, studentId: snap.get('studentId') || null, action: eventType, source: 'admin' });
  return { deviceId: input.deviceId, deviceUserId: input.deviceUserId, status: input.status };
}

export type EnrollmentDb = Firestore;
