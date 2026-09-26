import { env } from '../config/env.ts';
import { saveAttendanceIfNew, type NormalizedAttendanceEvent } from '../firestore/attendanceRepository.ts';
import { writeSyncLog } from '../firestore/syncLogRepository.ts';
import { logger } from '../utils/logger.ts';

export async function ingestVerifiedAttendance(event: NormalizedAttendanceEvent, connectionId: string): Promise<void> {
  if (!event.deviceId || !event.deviceUserId || !Number.isFinite(event.timestamp.getTime()) || !Number.isFinite(event.receivedAt.getTime()) || !event.method || !event.status || !event.source || !event.protocol || event.protocol === 'unknown' || !event.rawLogId) {
    throw new Error('Verified attendance event is missing a required field.');
  }
  await writeSyncLog({ deviceId: env.deviceId, connectionId, rawLogId: event.rawLogId, eventType: 'PROTOCOL_DETECTED', status: 'success', message: `Verified adapter accepted protocol ${event.protocol}.` });
  await writeSyncLog({ deviceId: env.deviceId, connectionId, rawLogId: event.rawLogId, eventType: 'ATTENDANCE_PARSED', status: 'success', message: 'A verified attendance event was normalized.' });
  const result = await saveAttendanceIfNew(event);
  const eventType = result.outcome === 'created' ? 'ATTENDANCE_CREATED' : 'ATTENDANCE_DUPLICATE';
  logger.info(eventType, { deviceId: env.deviceId, connectionId, attendanceId: result.attendanceId, rawLogId: event.rawLogId, mappingStatus: result.mappingStatus });
  await writeSyncLog({ deviceId: env.deviceId, connectionId, rawLogId: event.rawLogId, attendanceId: result.attendanceId, eventType, status: 'success', message: result.outcome === 'created' ? 'Verified attendance event stored.' : 'Duplicate verified attendance event ignored.' });
  if (result.outcome === 'created' && result.mappingStatus === 'unmapped') {
    await writeSyncLog({ deviceId: env.deviceId, connectionId, rawLogId: event.rawLogId, attendanceId: result.attendanceId, eventType: 'ATTENDANCE_UNMAPPED', status: 'warning', message: 'No unique student mapping was found for this device user ID; attendance was retained with studentId null.' });
  }
}
