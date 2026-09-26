export type DeviceUserPacket = {
  deviceId: string;
  deviceUserId: string;
  name: string | null;
  privilege: string | null;
  status: string | null;
  fingerprintEnrolled: boolean | null;
  faceEnrolled: boolean | null;
  palmEnrolled: boolean | null;
  cardEnrolled: boolean | null;
  source: string;
  rawLogId: string | null;
};
export type DeviceUserParseResult = { type: 'device_user'; parsed: true; user: DeviceUserPacket } | { type: 'unknown'; parsed: false; reason: 'no_verified_enrollment_format' };

/** Passive until captured T800 enrollment frames establish a repeatable wire format. */
export function parseDeviceUser(_frame: Buffer): DeviceUserParseResult {
  return { type: 'unknown', parsed: false, reason: 'no_verified_enrollment_format' };
}
