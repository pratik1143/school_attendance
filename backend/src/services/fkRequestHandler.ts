import { env } from '../config/env.ts';
import { buildFkResponse, parseFkPunch, type FkRequest } from '../tcp/fkWebProtocol.ts';
import { ingestVerifiedAttendance } from './attendanceIngestion.ts';
import { logger } from '../utils/logger.ts';

export type FkHandlerDeps = { ingest: typeof ingestVerifiedAttendance };

/** Maps the device's Cloud ID to our device document ID. */
export function deviceIdFor(devId: string): string {
  return devId === env.cloudId ? env.deviceId : `FK_${devId}`;
}

/**
 * Handles one FK request and returns the bytes to reply with. A punch is acknowledged
 * with OK only after it has been stored, so the device keeps (and later re-sends) any
 * log we could not save — this is what makes offline/outage periods safe.
 */
export async function handleFkRequest(
  request: FkRequest,
  context: { connectionId: string; rawLogId: string | null; receivedAt: Date },
  deps: FkHandlerDeps = { ingest: ingestVerifiedAttendance },
): Promise<Buffer> {
  if (request.requestCode === 'realtime_glog') {
    const punch = parseFkPunch(request, env.deviceUtcOffset);
    if (!punch) {
      logger.warn('FK attendance log could not be parsed; not acknowledged.', { connectionId: context.connectionId, transId: request.transId });
      return buildFkResponse(request.transId, 'ERROR');
    }
    logger.info('FK attendance punch received', {
      connectionId: context.connectionId, devId: punch.devId, deviceUserId: punch.userId,
      timestamp: punch.timestamp.toISOString(), ioTime: punch.ioTime, ioMode: punch.ioMode, verifyMode: punch.verifyMode,
    });
    if (!context.rawLogId) {
      logger.warn('Raw log was not stored; leaving punch on the device for retry.', { connectionId: context.connectionId, transId: request.transId });
      return buildFkResponse(request.transId, 'ERROR');
    }
    try {
      await deps.ingest({
        deviceId: deviceIdFor(punch.devId),
        deviceUserId: punch.userId,
        timestamp: punch.timestamp,
        // Raw verify/io codes are kept in the raw log; their meaning is not mapped yet.
        method: 'biometric',
        status: 'present',
        source: 'device',
        protocol: 'fk_realtime_glog',
        verified: true,
        rawLogId: context.rawLogId,
        receivedAt: context.receivedAt,
        transactionId: `${punch.devId}|${punch.userId}|${punch.ioTime}`,
      }, context.connectionId);
      return buildFkResponse(request.transId, 'OK');
    } catch (error) {
      logger.error('Attendance could not be stored; leaving punch on the device for retry.', { connectionId: context.connectionId, error: error instanceof Error ? error.message : String(error) });
      return buildFkResponse(request.transId, 'ERROR');
    }
  }
  // Command polling and any other request: nothing queued for the device.
  logger.info('FK request received', { connectionId: context.connectionId, requestCode: request.requestCode, transId: request.transId });
  return buildFkResponse(request.transId, request.requestCode === 'receive_cmd' ? 'ERROR_NO_CMD' : 'OK');
}
