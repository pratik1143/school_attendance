import { FieldValue } from 'firebase-admin/firestore';
import { env } from '../config/env.ts';
import { getDb } from './admin.ts';

export type RawLog = {
  connectionId: string;
  remoteIp: string;
  byteLength: number;
  rawHex: string;
  rawBase64: string;
  printableAscii: string;
  direction: 'DEVICE_TO_SERVER' | 'SERVER_TO_DEVICE';
  sequence: number;
  sensitiveRedacted?: boolean;
};
export async function saveRawLog(log: RawLog): Promise<string> {
  const result = await getDb().collection('raw_device_logs').add({
    source: 'tcp_listener',
    deviceId: env.deviceId,
    cloudId: env.cloudId,
    connectionId: log.connectionId,
    remoteIp: log.remoteIp,
    receivedAt: FieldValue.serverTimestamp(),
    byteLength: log.byteLength,
    rawHex: log.rawHex,
    rawBase64: log.rawBase64,
    printableAscii: log.printableAscii,
    direction: log.direction,
    sequence: log.sequence,
    sensitiveRedacted: log.sensitiveRedacted || false,
    parserStatus: 'unknown',
  });
  return result.id;
}
