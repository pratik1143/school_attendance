export type ProtocolDetection = { protocol: 'unknown'; confidence: 0 };
export function detectProtocol(_buffer: Buffer): ProtocolDetection {
  // No framing or application protocol has been confirmed for this firmware.
  return { protocol: 'unknown', confidence: 0 };
}
