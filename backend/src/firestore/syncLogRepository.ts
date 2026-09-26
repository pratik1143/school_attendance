import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from './admin.ts';

export type SyncEvent = {
  deviceId: string;
  connectionId?: string;
  rawLogId?: string;
  attendanceId?: string;
  eventType: string;
  status: 'success' | 'warning' | 'error';
  message: string;
};
export async function writeSyncLog(event: SyncEvent): Promise<void> {
  await getDb().collection('sync_logs').add({ ...event, timestamp: FieldValue.serverTimestamp() });
}
