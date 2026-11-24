/**
 * FK "web push" protocol used by the T800 (firmware ALDS37, data lib FKDataHS105).
 *
 * Observed on the wire (2026-11-24 capture): the device opens a TCP connection and sends
 * an HTTP/1.0 POST with custom headers (request_code, trans_id, dev_id, blk_no, blk_len)
 * and a binary body: 4-byte little-endian length + UTF-8 JSON (+ trailing NUL).
 *
 * The device keeps a log in its own memory until the server replies `response_code: OK`,
 * so we only acknowledge after the punch is safely stored.
 */

export type FkRequest = {
  requestCode: string;
  transId: string;
  devId: string;
  headers: Record<string, string>;
  body: Buffer;
};

export type FkParseResult =
  | { complete: false }
  | { complete: true; request: FkRequest; consumed: number }
  | { complete: true; error: string; consumed: number };

const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_BYTES = 8_192;

export function looksLikeFkRequest(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('latin1') === 'POST ';
}

/** Extracts one complete HTTP request from the front of `buffer`, if present. */
export function parseFkRequest(buffer: Buffer): FkParseResult {
  const headerEnd = buffer.indexOf(HEADER_END);
  if (headerEnd === -1) {
    return buffer.length > MAX_HEADER_BYTES ? { complete: true, error: 'Header too large', consumed: buffer.length } : { complete: false };
  }
  const lines = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n');
  if (!lines[0]?.startsWith('POST ')) return { complete: true, error: 'Not a POST request', consumed: headerEnd + 4 };
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    // Devices repeat Content-Type; first value wins.
    if (!(name in headers)) headers[name] = line.slice(colon + 1).trim();
  }
  const length = Number(headers['content-length'] || '0');
  if (!Number.isInteger(length) || length < 0) return { complete: true, error: 'Invalid Content-Length', consumed: headerEnd + 4 };
  const bodyStart = headerEnd + 4;
  if (buffer.length < bodyStart + length) return { complete: false };
  return {
    complete: true,
    consumed: bodyStart + length,
    request: {
      requestCode: headers['request_code'] || '',
      transId: headers['trans_id'] || '',
      devId: headers['dev_id'] || '',
      headers,
      body: Buffer.from(buffer.subarray(bodyStart, bodyStart + length)),
    },
  };
}

/** Body = uint32 LE length + JSON text (possibly followed by NUL/newline padding). */
export function decodeFkJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length < 4) return null;
  const declared = body.readUInt32LE(0);
  const end = Math.min(body.length, 4 + declared);
  const text = body.subarray(4, end).toString('utf8').replace(/\0+$/g, '').trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export type FkPunch = {
  devId: string;
  userId: string;
  timestamp: Date;
  ioTime: string;
  ioMode: number | null;
  verifyMode: number | null;
};

/** Parses "YYYYMMDDHHmmss" device-local time using a fixed UTC offset such as "+05:30". */
export function parseFkTime(value: string, utcOffset: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!match || !/^[+-]\d{2}:\d{2}$/.test(utcOffset)) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${utcOffset}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function parseFkPunch(request: FkRequest, utcOffset: string): FkPunch | null {
  if (request.requestCode !== 'realtime_glog') return null;
  const json = decodeFkJsonBody(request.body);
  if (!json) return null;
  const userId = typeof json.user_id === 'string' || typeof json.user_id === 'number' ? String(json.user_id).trim() : '';
  const ioTime = typeof json.io_time === 'string' ? json.io_time : '';
  const timestamp = parseFkTime(ioTime, utcOffset);
  if (!userId || !timestamp || !request.devId) return null;
  return {
    devId: request.devId,
    userId,
    timestamp,
    ioTime,
    ioMode: typeof json.io_mode === 'number' ? json.io_mode : null,
    verifyMode: typeof json.verify_mode === 'number' ? json.verify_mode : null,
  };
}

/**
 * HTTP response the device expects. `OK` tells it the log was accepted (it then drops it
 * from its upload queue); anything else makes it retry later.
 */
export function buildFkResponse(transId: string, responseCode: 'OK' | 'ERROR' | 'ERROR_NO_CMD'): Buffer {
  return Buffer.from([
    'HTTP/1.0 200 OK',
    `response_code: ${responseCode}`,
    `trans_id: ${transId}`,
    'cmd_code: ',
    'Content-Type: application/octet-stream',
    'Content-Length: 0',
    'Connection: close',
    '',
    '',
  ].join('\r\n'), 'latin1');
}
