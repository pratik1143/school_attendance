import { FieldValue } from 'firebase-admin/firestore';
import { env } from '../config/env.ts';
import { getDb } from './admin.ts';

export async function setDeviceConnection(input: { status: 'online' | 'offline'; remoteIp?: string; connectionId?: string; lastSeen?: boolean }): Promise<void> {
  const patch: Record<string, unknown> = {
    deviceId: env.deviceId,
    ...(env.tenantId ? { tenantId: env.tenantId } : {}),
    ...(env.clientId ? { clientId: env.clientId } : {}),
    deviceName: env.deviceName,
    model: env.model,
    cloudId: env.cloudId,
    connectionType: env.connectionType,
    serverPort: env.tcpPort,
    status: input.status,
  };
  if (input.status === 'online') {
    patch.connectionId = input.connectionId;
    patch.remoteIp = input.remoteIp;
    patch.connectedAt = FieldValue.serverTimestamp();
  } else {
    patch.disconnectedAt = FieldValue.serverTimestamp();
  }
  if (input.lastSeen) patch.lastSeen = FieldValue.serverTimestamp();
  await getDb().collection('devices').doc(env.deviceId).set(patch, { merge: true });
}
