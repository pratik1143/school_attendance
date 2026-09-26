import { env } from '../config/env.ts';
import { saveRawLog, type RawLog } from '../firestore/rawLogRepository.ts';
import { writeSyncLog } from '../firestore/syncLogRepository.ts';
import { detectProtocol } from './protocolDetector.ts';
import { parseProtocol } from './protocolParser.ts';
import { printableAscii, redactPrintableSecrets, toBase64, toHex } from '../utils/hex.ts';
import { logger } from '../utils/logger.ts';

export async function captureChunk(input: RawLog & { deviceId: string; receivedAt: Date }): Promise<string> {
  const marker = /(authorization|password|passwd|token|secret)\s*[:=]\s*[^\s,;]+/i;
  const sensitiveRedacted = marker.test(input.printableAscii);
  const safe = {
    connectionId: input.connectionId,
    remoteIp: input.remoteIp,
    byteLength: input.byteLength,
    rawHex: sensitiveRedacted ? '[REDACTED: sensitive text marker]' : input.rawHex,
    rawBase64: sensitiveRedacted ? '[REDACTED: sensitive text marker]' : input.rawBase64,
    printableAscii: redactPrintableSecrets(input.printableAscii),
    direction: input.direction,
    sequence: input.sequence,
    sensitiveRedacted,
  };
  // Persist evidence before detection or parsing so future parser failures cannot
  // discard the original stream chunk.
  const id = await saveRawLog(safe);
  const detection = detectProtocol(Buffer.from(input.rawBase64, 'base64'));
  const parsed = parseProtocol(Buffer.from(input.rawBase64, 'base64'));
  logger.info('TCP raw chunk persisted', { source: 'tcp_listener', rawLogId: id, connectionId: input.connectionId, remoteIp: input.remoteIp, byteLength: input.byteLength, protocol: detection.protocol, parsed: parsed.parsed });
  if (env.logRawPackets || env.diagnosticMode) {
    logger.info('Raw TCP diagnostic', {
      connectionId: input.connectionId,
      remoteIp: input.remoteIp,
      direction: input.direction,
      timestamp: input.receivedAt.toISOString(),
      bytes: input.byteLength,
      sequence: input.sequence,
      hex: sensitiveRedacted ? '[REDACTED: sensitive text marker]' : input.rawHex.match(/.{1,2}/g)?.join(' ') || '',
      ascii: redactPrintableSecrets(input.printableAscii),
    });
  }
  await writeSyncLog({ deviceId: input.deviceId, connectionId: input.connectionId, rawLogId: id, eventType: 'RAW_PACKET_RECEIVED', status: 'success', message: `Captured ${input.byteLength} raw TCP bytes in sequence ${input.sequence}; parser status unknown.` });
  await writeSyncLog({ deviceId: input.deviceId, connectionId: input.connectionId, rawLogId: id, eventType: 'PARSER_UNKNOWN', status: 'warning', message: 'No protocol has been verified; attendance ingestion was not called.' });
  return id;
}
export function rawFields(buffer: Buffer, direction: RawLog['direction'], sequence: number): Pick<RawLog, 'byteLength' | 'rawHex' | 'rawBase64' | 'printableAscii' | 'direction' | 'sequence'> {
  return { byteLength: buffer.length, rawHex: toHex(buffer), rawBase64: toBase64(buffer), printableAscii: printableAscii(buffer), direction, sequence };
}
