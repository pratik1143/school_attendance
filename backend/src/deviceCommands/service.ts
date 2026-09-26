import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore';
import { getDb } from '../firestore/admin.ts';
import { commandRequestStatus, commandExpiry, deviceOwnedByAdmin, isKnownCommandType, validRestartConfirmation, type DeviceCommandType } from './model.ts';

export class DeviceCommandError extends Error {
  readonly statusCode: number; readonly code: string;
  constructor(statusCode: number, code: string, message: string) { super(message); this.statusCode = statusCode; this.code = code; }
}
export type DeviceAdminScope = { uid: string; clientId: string | null; tenantId: string | null };
function commandRow(id: string, data: DocumentData) {
  const iso = (value: unknown) => value instanceof Timestamp ? value.toDate().toISOString() : value instanceof Date ? value.toISOString() : null;
  return { commandId: id, deviceId: data.deviceId, clientId: data.clientId || null, commandType: data.commandType, status: data.status, createdAt: iso(data.createdAt), createdBy: data.createdBy, sentAt: iso(data.sentAt), completedAt: iso(data.completedAt), responseCode: data.responseCode || null, result: data.result || null, error: data.error || null, connectionId: data.connectionId || null, protocol: data.protocol || 'unknown', expiresAt: iso(data.expiresAt) };
}
async function requireOwnedDevice(deviceId: string, scope: DeviceAdminScope) {
  if (!scope.clientId || !scope.tenantId) throw new DeviceCommandError(403, 'DEVICE_ADMIN_SCOPE_REQUIRED', 'A client-scoped administrator identity is required for device management.');
  const db = getDb(); const [device, client] = await Promise.all([
    db.collection('devices').doc(deviceId).get(), db.collection('api_clients').doc(scope.clientId).get(),
  ]);
  if (!device.exists) throw new DeviceCommandError(404, 'DEVICE_NOT_FOUND', 'Device not found.');
  if (!deviceOwnedByAdmin(scope, device.data() || {}, client.exists ? client.data() || {} : null)) {
    throw new DeviceCommandError(403, 'DEVICE_TENANT_DENIED', 'This administrator is not authorized for that device tenant.');
  }
  return { db, device };
}

export async function createDeviceCommand(input: { deviceId: string; commandType: unknown; scope: DeviceAdminScope; confirmation?: unknown }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.deviceId)) throw new DeviceCommandError(400, 'INVALID_DEVICE_ID', 'Device ID is invalid.');
  if (!isKnownCommandType(input.commandType)) throw new DeviceCommandError(400, 'INVALID_COMMAND_TYPE', 'Command type is not in the allowlist. Raw command bytes are not accepted.');
  const commandType: DeviceCommandType = input.commandType;
  const { db, device } = await requireOwnedDevice(input.deviceId, input.scope);
  const deviceName = String(device.get('deviceName') || input.deviceId);
  if (commandType === 'device.restart' && !validRestartConfirmation(deviceName, input.confirmation)) throw new DeviceCommandError(400, 'RESTART_CONFIRMATION_REQUIRED', `Type exactly: Restart ${deviceName}?`);
  // An allowlist alone is insufficient: command types remain disabled until both
  // a captured protocol exchange and the device's verified capability are enabled.
  const status = commandRequestStatus(commandType, (device.get('capabilities') || {}) as Record<string, unknown>, device.get('status') === 'online');
  const commandId = `cmd_${randomUUID()}`; const now = Date.now();
  const record = {
    commandId, deviceId: input.deviceId, clientId: input.scope.clientId, tenantId: input.scope.tenantId,
    commandType, payload: null, status, createdAt: FieldValue.serverTimestamp(), createdBy: input.scope.uid,
    sentAt: null, completedAt: null, responseCode: null, result: null,
    error: status === 'unsupported' ? 'Command not supported / protocol not verified.' : status === 'failed' ? 'Device is offline; command was not queued.' : null,
    connectionId: null, protocol: 'unknown', expiresAt: Timestamp.fromMillis(commandExpiry(now)),
    request: null, response: null, durationMs: null,
  };
  await db.collection('device_commands').doc(commandId).create(record);
  await db.collection('device_command_audit_logs').add({ commandId, deviceId: input.deviceId, clientId: input.scope.clientId, adminUserId: input.scope.uid, commandType, timestamp: FieldValue.serverTimestamp(), status, result: record.error || 'Command request recorded; no bytes sent.' , action: status === 'unsupported' ? 'COMMAND_UNSUPPORTED' : 'COMMAND_CREATED' });
  return { command: commandRow(commandId, { ...record, createdAt: new Date(now), expiresAt: new Date(now + 5 * 60_000) }), transmitted: false };
}

export async function listDeviceCommands(deviceId: string, scope: DeviceAdminScope, limit = 50) {
  const { db } = await requireOwnedDevice(deviceId, scope);
  const snapshot = await db.collection('device_commands').where('deviceId', '==', deviceId).where('clientId', '==', scope.clientId).orderBy('createdAt', 'desc').limit(Math.min(100, Math.max(1, limit))).get();
  return snapshot.docs.map((doc) => commandRow(doc.id, doc.data()));
}

export async function listSafeDeviceLogs(deviceId: string, scope: DeviceAdminScope, limit = 50) {
  const { db } = await requireOwnedDevice(deviceId, scope);
  const snapshot = await db.collection('raw_device_logs').where('deviceId', '==', deviceId).orderBy('receivedAt', 'desc').limit(Math.min(100, Math.max(1, limit))).get();
  return snapshot.docs.map((doc) => ({ logId: doc.id, timestamp: doc.get('receivedAt') instanceof Timestamp ? doc.get('receivedAt').toDate().toISOString() : null, direction: doc.get('direction') || null, packetSize: Number(doc.get('byteLength')) || 0, parserStatus: doc.get('parserStatus') || 'unknown', connectionId: doc.get('connectionId') || null }));
}
