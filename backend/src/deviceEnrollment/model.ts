import { createHash } from 'node:crypto';

const hashId = (...parts: string[]) => createHash('sha256').update(parts.join('\u001f')).digest('hex');
export const deviceUserDocId = (deviceId: string, deviceUserId: string) => hashId(deviceId, deviceUserId);
export const studentDeviceLinkId = (deviceId: string, deviceUserId: string) => hashId(deviceId, deviceUserId);
export const autoStudentDocId = (deviceId: string, deviceUserId: string) => `AUTO-${hashId(deviceId, deviceUserId).slice(0, 20).toUpperCase()}`;

export function enrollmentMetadata(input: Record<string, unknown>) {
  const flag = (key: string) => typeof input[key] === 'boolean' ? input[key] : null;
  return {
    fingerprintEnrolled: flag('fingerprintEnrolled'), faceEnrolled: flag('faceEnrolled'),
    palmEnrolled: flag('palmEnrolled'), cardEnrolled: flag('cardEnrolled'), passwordEnrolled: flag('passwordEnrolled'),
  };
}

export function resolveDeviceUserStudentMatch(input: {
  deviceId: string; tenantId: string; deviceUserId: string;
  links: Array<{ deviceId: string; deviceUserId: string; studentId: string; tenantId?: string }>;
  students: Array<{ studentId: string; deviceUserId?: string; deviceId?: string; tenantId?: string }>;
  knownDeviceUsers: Array<{ deviceId: string; deviceUserId: string }>;
}): { studentId: string | null; match: 'exact' | 'unique' | 'ambiguous' | 'none' } {
  const exactLinks = input.links.filter((x) => x.deviceId === input.deviceId && x.deviceUserId === input.deviceUserId && (!x.tenantId || x.tenantId === input.tenantId));
  if (exactLinks.length === 1) return { studentId: exactLinks[0].studentId, match: 'exact' };
  if (exactLinks.length > 1) return { studentId: null, match: 'ambiguous' };
  const scoped = input.students.filter((x) => x.tenantId === input.tenantId && x.deviceUserId === input.deviceUserId);
  const exact = scoped.filter((x) => x.deviceId === input.deviceId);
  if (exact.length === 1) return { studentId: exact[0].studentId, match: 'exact' };
  if (exact.length > 1) return { studentId: null, match: 'ambiguous' };
  const legacy = scoped.filter((x) => !x.deviceId);
  const knownScopes = new Set(input.knownDeviceUsers.filter((x) => x.deviceUserId === input.deviceUserId).map((x) => x.deviceId));
  if (legacy.length === 1 && scoped.length < 3 && input.knownDeviceUsers.length < 3 && (knownScopes.size === 0 || (knownScopes.size === 1 && knownScopes.has(input.deviceId)))) return { studentId: legacy[0].studentId, match: 'unique' };
  return { studentId: null, match: scoped.length || knownScopes.size > 1 ? 'ambiguous' : 'none' };
}
