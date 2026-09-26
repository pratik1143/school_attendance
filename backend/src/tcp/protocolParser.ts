export type ParsedEvent = { type: 'unknown'; parsed: false };
export function parseProtocol(_buffer: Buffer): ParsedEvent {
  // Unknown bytes must never be converted into attendance events.
  return { type: 'unknown', parsed: false };
}
