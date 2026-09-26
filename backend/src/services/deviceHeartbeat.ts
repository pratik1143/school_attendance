import { setDeviceConnection } from '../firestore/deviceRepository.ts';
import { writeSyncLog } from '../firestore/syncLogRepository.ts';
import { logger } from '../utils/logger.ts';

export async function markConnected(input: { connectionId: string; remoteIp: string; deviceId: string }): Promise<void> {
  try {
    await setDeviceConnection({ status: 'online', connectionId: input.connectionId, remoteIp: input.remoteIp });
    await writeSyncLog({ deviceId: input.deviceId, connectionId: input.connectionId, eventType: 'TCP_CONNECTED', status: 'success', message: 'TCP connection opened.' });
  } catch (error) { logger.error('Could not persist device connection state.', { connectionId: input.connectionId, error: String(error) }); }
}
export async function markPacketSeen(input: { connectionId: string; remoteIp: string; deviceId: string }): Promise<void> {
  try {
    await setDeviceConnection({ status: 'online', connectionId: input.connectionId, remoteIp: input.remoteIp, lastSeen: true });
  } catch (error) { logger.error('Could not persist device lastSeen.', { connectionId: input.connectionId, error: String(error) }); }
}
export async function markDisconnected(input: { connectionId: string; deviceId: string }): Promise<void> {
  try {
    await setDeviceConnection({ status: 'offline' });
    await writeSyncLog({ deviceId: input.deviceId, connectionId: input.connectionId, eventType: 'TCP_DISCONNECTED', status: 'success', message: 'TCP connection closed.' });
  } catch (error) { logger.error('Could not persist device disconnect state.', { connectionId: input.connectionId, error: String(error) }); }
}
