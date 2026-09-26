export const DEVICE_COMMAND_TYPES = [
  'device.info', 'device.status', 'device.sync', 'device.users.read', 'device.user.read', 'device.user.create',
  'device.user.update', 'device.user.disable', 'device.user.delete', 'device.attendance.read', 'device.restart',
  'device.time.get', 'device.time.set',
] as const;
export type DeviceCommandType = typeof DEVICE_COMMAND_TYPES[number];
export type DeviceCommandStatus = 'queued' | 'sending' | 'sent' | 'acknowledged' | 'completed' | 'failed' | 'timeout' | 'cancelled' | 'unsupported';
export const COMMAND_CAPABILITY: Record<DeviceCommandType, string> = {
  'device.info': 'deviceInfo', 'device.status': 'deviceStatus', 'device.sync': 'deviceSync',
  'device.users.read': 'userRead', 'device.user.read': 'userRead', 'device.user.create': 'userCreate',
  'device.user.update': 'userUpdate', 'device.user.disable': 'userDelete', 'device.user.delete': 'userDelete',
  'device.attendance.read': 'attendanceRead', 'device.restart': 'deviceRestart',
  'device.time.get': 'timeGet', 'device.time.set': 'timeSet',
};
/** Must only be changed when request, response, and a real captured exchange are verified. */
export const VERIFIED_DEVICE_COMMANDS: readonly DeviceCommandType[] = [];
export const ALL_DEVICE_CAPABILITIES: Record<string, boolean> = Object.fromEntries([...new Set(Object.values(COMMAND_CAPABILITY)), 'remoteEnrollment'].map((key) => [key, false]));
export const DESTRUCTIVE_COMMANDS = new Set<DeviceCommandType>(['device.user.disable', 'device.user.delete', 'device.restart', 'device.time.set']);
export function isKnownCommandType(value: unknown): value is DeviceCommandType { return typeof value === 'string' && DEVICE_COMMAND_TYPES.includes(value as DeviceCommandType); }
export function commandIsSupported(type: DeviceCommandType, deviceCapabilities: Record<string, unknown> = {}) {
  return VERIFIED_DEVICE_COMMANDS.includes(type) && deviceCapabilities[COMMAND_CAPABILITY[type]] === true;
}
export function deviceOwnedByAdmin(scope: { clientId: string | null; tenantId: string | null }, device: { clientId?: unknown; tenantId?: unknown }, client: { status?: unknown; tenantId?: unknown } | null) {
  return Boolean(scope.clientId && scope.tenantId && client && client.status === 'active' && client.tenantId === scope.tenantId && device.tenantId === scope.tenantId && device.clientId === scope.clientId);
}
export function commandRequestStatus(type: DeviceCommandType, deviceCapabilities: Record<string, unknown>, online: boolean) {
  if (!commandIsSupported(type, deviceCapabilities)) return 'unsupported' as const;
  return online ? 'queued' as const : 'failed' as const;
}
export function validRestartConfirmation(deviceName: string, confirmation: unknown) { return confirmation === `Restart ${deviceName}?`; }
export function commandExpiry(now: number, ttlMs = 5 * 60_000) { return now + Math.max(1, ttlMs); }
export function commandCanBeClaimed(status: DeviceCommandStatus, expiresAt: number | null, now: number, deviceOnline: boolean, deviceLockUntil: number | null) {
  if (status !== 'queued' || expiresAt === null || expiresAt <= now || !deviceOnline) return false;
  return deviceLockUntil === null || deviceLockUntil <= now;
}
export function commandResultStatus(input: { supported: boolean; online: boolean; expired: boolean; responseValid: boolean }) {
  if (!input.supported) return 'unsupported' as const;
  if (!input.online) return 'failed' as const;
  if (input.expired) return 'timeout' as const;
  return input.responseValid ? 'completed' as const : 'failed' as const;
}
