import { createHash } from 'node:crypto';
import { FieldValue, type DocumentData } from 'firebase-admin/firestore';
import { getDb } from './admin.ts';
import { env } from '../config/env.ts';
import { localDateKey } from '../schoolManagement/model.ts';

export type NormalizedAttendanceEvent = {
  deviceId: string;
  deviceUserId: string;
  timestamp: Date;
  method: string;
  status: string;
  source: string;
  protocol: string;
  verified: true;
  rawLogId: string;
  receivedAt: Date;
  transactionId?: string;
};
export type MappingStatus = 'mapped' | 'unmapped';
export type StudentMapping = { studentId: string | null; mappingStatus: MappingStatus };

export function resolveStudentMapping(candidates: Array<{ documentId: string; studentId?: unknown; deviceId?: unknown }>, deviceId?: string): StudentMapping {
  const scoped = deviceId ? candidates.filter((candidate) => candidate.deviceId === deviceId) : candidates;
  const safe = scoped.length ? scoped : deviceId ? candidates.filter((candidate) => !candidate.deviceId) : candidates;
  if (safe.length !== 1) return { studentId: null, mappingStatus: 'unmapped' };
  const studentId = typeof safe[0].studentId === 'string' && safe[0].studentId.trim()
    ? safe[0].studentId
    : safe[0].documentId;
  return { studentId, mappingStatus: 'mapped' };
}

export function attendanceEventId(event: NormalizedAttendanceEvent): string {
  const identity = event.transactionId
    ? [event.deviceId, 'transaction', event.transactionId]
    : [event.deviceId, event.deviceUserId, event.timestamp.toISOString(), event.method, event.status, event.source];
  return createHash('sha256').update(identity.join('|')).digest('hex');
}

export async function saveAttendanceIfNew(event: NormalizedAttendanceEvent): Promise<{
  outcome: 'created' | 'duplicate';
  attendanceId: string;
  studentId: string | null;
  mappingStatus: MappingStatus;
}> {
  if (event.verified !== true || event.protocol === 'unknown' || event.source.toLowerCase() === 'test') throw new Error('Only verified, non-test attendance events can be persisted.');
  const db = getDb();
  const id = attendanceEventId(event);
  const ref = db.collection('attendance').doc(id);
  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) {
      const existingData = existing.data() as DocumentData;
      return {
        outcome: 'duplicate',
        attendanceId: id,
        studentId: typeof existingData.studentId === 'string' ? existingData.studentId : null,
        mappingStatus: existingData.mappingStatus === 'mapped' ? 'mapped' : 'unmapped',
      };
    }

    const device = await transaction.get(db.collection('devices').doc(event.deviceId));
    const tenantId = env.tenantId || (typeof device.get('tenantId') === 'string' ? device.get('tenantId') as string : '');
    const schoolId = typeof device.get('schoolId') === 'string' ? device.get('schoolId') as string : '';
    const [exactLinks, exactStudents, matches, knownDeviceUsers, activeSessions, schoolDoc] = await Promise.all([
      transaction.get(db.collection('student_device_links').where('deviceId', '==', event.deviceId).where('deviceUserId', '==', event.deviceUserId).where('status', '==', 'active').limit(2)),
      tenantId ? transaction.get(db.collection('students').where('tenantId', '==', tenantId).where('deviceId', '==', event.deviceId).where('deviceUserId', '==', event.deviceUserId).limit(2)) : Promise.resolve(null),
      transaction.get(db.collection('students').where('deviceUserId', '==', event.deviceUserId).limit(3)),
      transaction.get(db.collection('device_users').where('deviceUserId', '==', event.deviceUserId).limit(3)),
      schoolId ? transaction.get(db.collection('academic_sessions').where('schoolId', '==', schoolId).where('status', '==', 'active').limit(2)) : Promise.resolve(null),
      schoolId ? transaction.get(db.collection('schools').doc(schoolId)) : Promise.resolve(null),
    ]);
    const linkedStudents = exactLinks.docs.filter((link) => tenantId && link.get('tenantId') === tenantId).map((link) => ({ documentId: String(link.get('studentId') || ''), studentId: link.get('studentId'), deviceId: event.deviceId })).filter((link) => link.documentId);
    const studentDocs = new Map([...(exactStudents?.docs || []), ...matches.docs].map((student) => [student.id, student]));
    const tenantMatches = [...studentDocs.values()].filter((student) => (tenantId ? student.get('tenantId') === tenantId : !student.get('tenantId')) &&(!student.get('deviceId') || student.get('deviceId') === event.deviceId));
    const scopedCandidates = linkedStudents.length ? linkedStudents : tenantMatches.map((student) => ({ documentId: student.id, studentId: student.get('studentId'), deviceId: student.get('deviceId') }));
    let mapping = resolveStudentMapping(scopedCandidates, event.deviceId);
    if (!linkedStudents.length && mapping.mappingStatus === 'mapped' && !tenantMatches.some((student) => student.get('deviceId') === event.deviceId)) {
      const deviceScopes = new Set(knownDeviceUsers.docs.filter((known) => known.get('tenantId') === tenantId).map((known) => String(known.get('deviceId') || '')));
      // Without a tenant (single-school setup) only untenanted students are candidates.
      if (matches.size >= 3 || knownDeviceUsers.size >= 3 || deviceScopes.size > 1 || (deviceScopes.size === 1 && !deviceScopes.has(event.deviceId))) mapping = { studentId: null, mappingStatus: 'unmapped' };
    }
    const schoolTimezone = String(schoolDoc?.get('timezone') || 'Asia/Kolkata'); const schoolDate = localDateKey(event.timestamp, schoolTimezone);
    const activeSession = activeSessions?.docs.find((session) => String(session.get('startDate') || '') <= schoolDate && String(session.get('endDate') || '') >= schoolDate);
    const mappedStudent = [...studentDocs.values()].find((student) => String(student.get('studentId') || student.id) === String(mapping.studentId || ''));
    transaction.create(ref, {
      eventId: id,
      attendanceId: id,
      deviceId: event.deviceId,
      deviceUserId: event.deviceUserId,
      studentId: mapping.studentId,
      timestamp: event.timestamp,
      date: schoolDate,
      time: new Intl.DateTimeFormat('en-GB', { timeZone: schoolTimezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(event.timestamp),
      method: event.method,
      status: event.status,
      source: event.source,
      protocol: event.protocol,
      verificationStatus: 'verified',
      verified: true,
      webhookEligible: true,
      rawLogId: event.rawLogId,
      ...(tenantId ? { tenantId } : {}),
      ...(schoolId ? { schoolId } : {}),
      ...(activeSession ? { sessionId: activeSession.get('sessionId') || activeSession.id.replace(`${schoolId}__`, '') } : {}),
      ...(mappedStudent?.get('classId') ? { classId: mappedStudent.get('classId') } : {}),
      ...(mappedStudent?.get('sectionId') ? { sectionId: mappedStudent.get('sectionId') } : {}),
      ...(mappedStudent?.get('class') ? { class: mappedStudent.get('class') } : {}),
      ...(mappedStudent?.get('section') ? { section: mappedStudent.get('section') } : {}),
      ...(env.clientId || device.get('clientId') ? { clientId: env.clientId || device.get('clientId') } : {}),
      receivedAt: event.receivedAt,
      mappingStatus: mapping.mappingStatus,
      ...(event.transactionId ? { transactionId: event.transactionId } : {}),
      createdAt: FieldValue.serverTimestamp(),
    });
    return { outcome: 'created', attendanceId: id, ...mapping };
  });
}
