import type { ProtocolDetection } from './protocolDetector.ts';
import type { ParsedEvent } from './protocolParser.ts';
import type { DeviceUserParseResult } from './deviceUserParser.ts';
import { parseDeviceUser } from './deviceUserParser.ts';

export interface DeviceProtocolAdapter {
  identifyDevice(frame: Buffer): { supported: false };
  identify(initialBytes: Buffer): ProtocolDetection;
  parseFrame(frame: Buffer): ParsedEvent;
  parseHeartbeat(frame: Buffer): null;
  parseAttendance(frame: Buffer): null;
  parseDeviceUser(frame: Buffer): DeviceUserParseResult;
  buildCommand(commandType: string, payload?: unknown): { supported: false };
  parseCommandResponse(frame: Buffer): { supported: false };
  createResponse(frame: Buffer): null;
}

/** Passive adapter used until real T800 traffic establishes a protocol. */
export const unknownProtocolAdapter: DeviceProtocolAdapter = {
  identifyDevice: () => ({ supported: false }),
  identify: () => ({ protocol: 'unknown', confidence: 0 }),
  parseFrame: () => ({ type: 'unknown', parsed: false }),
  parseHeartbeat: () => null,
  parseAttendance: () => null,
  parseDeviceUser,
  buildCommand: () => ({ supported: false }),
  parseCommandResponse: () => ({ supported: false }),
  createResponse: () => null,
};
