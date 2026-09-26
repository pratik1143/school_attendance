import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';

export const WEBHOOK_EVENT = 'attendance.created' as const;
export type WebhookEvent = typeof WEBHOOK_EVENT;
export type WebhookPayload = { id: string; event: WebhookEvent | 'webhook.test'; created_at: string; data: Record<string, unknown> };
export type WebhookUrlOptions = { production?: boolean; allowHttp?: boolean; allowLocalhost?: boolean };
export type DeliveryResult = { ok: boolean; statusCode: number | null; responseTimeMs: number; errorCode: string | null; errorMessage: string | null };

export class WebhookError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) { super(message); this.code = code; this.retryable = retryable; this.name = 'WebhookError'; }
}
export function verifiedAttendanceEligible(data: Record<string, unknown>): boolean {
  return data.webhookEligible === true && data.verified === true && data.verificationStatus === 'verified' && typeof data.protocol === 'string' && data.protocol !== 'unknown' && String(data.source || '').toLowerCase() !== 'test' && String(data.status || '').toLowerCase() !== 'invalid' && data.duplicate !== true;
}
export function tenantClientOwnershipMatches(attendance: { tenantId?: unknown; clientId?: unknown }, client: { tenantId?: unknown; clientId: string }, resolvedClientId?: string): boolean {
  if (!attendance.tenantId || attendance.tenantId !== client.tenantId) return false;
  if (typeof attendance.clientId === 'string' && attendance.clientId) return attendance.clientId === client.clientId;
  return resolvedClientId === client.clientId;
}
export function deliveryLeaseDue(status: string, nextAttemptAt: number | null, lockUntil: number | null, now: number): boolean {
  return status === 'pending' ? nextAttemptAt !== null && nextAttemptAt <= now : status === 'processing' && lockUntil !== null && lockUntil <= now;
}

export function generateWebhookSecret(): string { return `whsec_${randomBytes(32).toString('base64url')}`; }
function encryptionKey(raw: string): Buffer {
  if (!/^[a-fA-F0-9]{64}$/.test(raw)) throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEY must be a 32-byte hexadecimal key.');
  return Buffer.from(raw, 'hex');
}
export function encryptWebhookSecret(secret: string, rawKey: string) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey(rawKey), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { secretEncrypted: ciphertext.toString('base64'), secretIv: iv.toString('base64'), secretTag: cipher.getAuthTag().toString('base64'), secretHash: createHash('sha256').update(secret).digest('hex') };
}
export function decryptWebhookSecret(record: { secretEncrypted: string; secretIv: string; secretTag: string }, rawKey: string): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(rawKey), Buffer.from(record.secretIv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.secretTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.secretEncrypted, 'base64')), decipher.final()]).toString('utf8');
}
export function signWebhook(secret: string, timestamp: string, rawBody: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest('hex')}`;
}
export function verifyWebhookSignature(secret: string, timestamp: string, rawBody: string | Buffer, header: string, now = Date.now(), toleranceSeconds = 300): boolean {
  if (!/^\d{10,13}$/.test(timestamp) || !Number.isInteger(toleranceSeconds) || toleranceSeconds < 0) return false;
  const timestampMs = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > toleranceSeconds * 1000) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody).slice(7), 'hex');
  if (!header.startsWith('sha256=')) return false;
  const actual = Buffer.from(header.slice(7), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isLoopbackName(hostname: string): boolean { return hostname === 'localhost' || hostname.endsWith('.localhost'); }
export function isPublicAddress(address: string, allowLoopback = false): boolean {
  const family = isIP(address); if (!family) return false;
  if (family === 4) {
    const o = address.split('.').map(Number); const [a, b] = o;
    if (a === 127 || a === 0 || a >= 224 || (a === 10) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || (a === 100 && b >= 64 && b <= 127)) return allowLoopback && a === 127;
    return true;
  }
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return allowLoopback && lower === '::1';
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice(7);
    if (isIP(mapped) === 4) return isPublicAddress(mapped, allowLoopback);
    const hex = mapped.split(':'); if (hex.length === 2) { const hi = Number.parseInt(hex[0], 16); const lo = Number.parseInt(hex[1], 16); return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, allowLoopback); }
  }
  if (family !== 6) return false;
  const firstHextet = Number.parseInt(lower.split(':')[0] || '0', 16);
  // Restrict IPv6 to global unicast (2000::/3), excluding special transition/documentation ranges.
  if (firstHextet < 0x2000 || firstHextet > 0x3fff || lower.startsWith('2001:db8:') || lower.startsWith('2001:0:') || lower.startsWith('2002:')) return false;
  return true;
}

export function parseWebhookUrl(raw: string, options: WebhookUrlOptions = {}): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebhookError('WEBHOOK_URL_INVALID', 'Webhook URL is invalid.', false); }
  const localDev = !options.production && options.allowLocalhost === true;
  const httpDev = !options.production && options.allowHttp === true;
  if (url.username || url.password || url.hash || url.href.length > 2048) throw new WebhookError('WEBHOOK_URL_INVALID', 'Webhook URL contains unsupported components.', false);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && httpDev)) throw new WebhookError('WEBHOOK_HTTPS_REQUIRED', 'Webhook URLs must use HTTPS.', false);
  if (isLoopbackName(url.hostname) && !localDev) throw new WebhookError('WEBHOOK_SSRF_BLOCKED', 'Localhost webhook URLs are disabled.', false);
  if (url.hostname === 'metadata.google.internal' || url.hostname === 'metadata.google' || url.hostname === 'metadata') throw new WebhookError('WEBHOOK_SSRF_BLOCKED', 'Internal metadata destinations are blocked.', false);
  if (isIP(url.hostname) && !isPublicAddress(url.hostname, localDev)) throw new WebhookError('WEBHOOK_SSRF_BLOCKED', 'Private or reserved IP destinations are blocked.', false);
  return url;
}

export async function resolveWebhookUrl(raw: string, options: WebhookUrlOptions = {}) {
  const url = parseWebhookUrl(raw, options); const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { throw new WebhookError('WEBHOOK_DNS_FAILED', 'Webhook hostname could not be resolved.', true); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address, !options.production && options.allowLocalhost === true))) throw new WebhookError('WEBHOOK_SSRF_BLOCKED', 'Webhook hostname resolves to a private or reserved address.', false);
  return { url, addresses };
}

export async function deliverWebhook(input: { webhookId: string; url: string; secret: string; payload: WebhookPayload; timeoutMs: number; maxPayloadBytes: number; maxResponseBytes?: number; urlOptions?: WebhookUrlOptions }): Promise<DeliveryResult> {
  const rawBody = Buffer.from(JSON.stringify(input.payload));
  if (rawBody.length > input.maxPayloadBytes) return { ok: false, statusCode: null, responseTimeMs: 0, errorCode: 'PAYLOAD_TOO_LARGE', errorMessage: 'Webhook payload exceeds the configured maximum.' };
  const started = Date.now();
  let resolved: Awaited<ReturnType<typeof resolveWebhookUrl>>;
  try { resolved = await resolveWebhookUrl(input.url, input.urlOptions); } catch (caught) {
    const e = caught instanceof WebhookError ? caught : new WebhookError('WEBHOOK_URL_INVALID', 'Webhook URL validation failed.', false);
    return { ok: false, statusCode: null, responseTimeMs: Date.now() - started, errorCode: e.code, errorMessage: e.message };
  }
  const timestamp = String(Math.floor(Date.now() / 1000)); const signature = signWebhook(input.secret, timestamp, rawBody);
  const addresses = resolved.addresses; const url = resolved.url;
  const options: RequestOptions = {
    protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, method: 'POST', path: `${url.pathname}${url.search}`,
    headers: { 'Content-Type': 'application/json', 'Content-Length': rawBody.length, 'X-Webhook-ID': input.webhookId, 'X-Webhook-Event': input.payload.event, 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature': signature, 'X-Webhook-Event-ID': input.payload.id, 'User-Agent': 'SchoolAttendance-Webhooks/1.0' },
    timeout: input.timeoutMs, maxHeaderSize: 16_384,
    lookup: ((hostname: string, lookupOptions: unknown, callback: (...args: unknown[]) => void) => {
      const opts = typeof lookupOptions === 'object' && lookupOptions !== null ? lookupOptions as { family?: number; all?: boolean } : {};
      const chosen = addresses.find((item) => !opts.family || item.family === opts.family) || addresses[0];
      if (!chosen) { callback(new Error('No safe DNS address.'), undefined, 0); return; }
      if (opts.all) callback(null, addresses.map((item) => ({ address: item.address, family: item.family })));
      else callback(null, chosen.address, chosen.family);
    }) as RequestOptions['lookup'],
  };
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DeliveryResult) => { if (settled) return; settled = true; resolve({ ...result, responseTimeMs: Date.now() - started }); };
    const req = request(options, (res) => {
      const responseLimit = input.maxResponseBytes ?? 8_192;
      let responseBytes = 0; let tooLarge = false;
      res.on('data', (chunk: Buffer) => { responseBytes += chunk.length; if (responseBytes > responseLimit) { tooLarge = true; res.destroy(); } });
      res.on('end', () => {
        const statusCode = res.statusCode || 0; const ok = statusCode >= 200 && statusCode < 300;
        finish({ ok, statusCode, responseTimeMs: 0, errorCode: ok ? null : tooLarge ? 'RESPONSE_TOO_LARGE' : `HTTP_${statusCode}`, errorMessage: ok ? null : tooLarge ? `Webhook response exceeded ${responseLimit} bytes.` : `Webhook endpoint returned HTTP ${statusCode}.` });
      });
      res.on('aborted', () => finish({ ok: false, statusCode: res.statusCode || null, responseTimeMs: 0, errorCode: tooLarge ? 'RESPONSE_TOO_LARGE' : 'WEBHOOK_RESPONSE_ERROR', errorMessage: tooLarge ? `Webhook response exceeded ${responseLimit} bytes.` : 'Webhook response ended unexpectedly.' }));
      res.on('error', () => finish({ ok: false, statusCode: res.statusCode || null, responseTimeMs: 0, errorCode: tooLarge ? 'RESPONSE_TOO_LARGE' : 'WEBHOOK_RESPONSE_ERROR', errorMessage: tooLarge ? `Webhook response exceeded ${responseLimit} bytes.` : 'Webhook response could not be read.' }));
    });
    req.setTimeout(input.timeoutMs, () => { req.destroy(new Error('Webhook request timed out.')); });
    req.on('error', (e) => { const timeout = /timed out/i.test(e.message); finish({ ok: false, statusCode: null, responseTimeMs: 0, errorCode: timeout ? 'WEBHOOK_TIMEOUT' : 'WEBHOOK_NETWORK_ERROR', errorMessage: timeout ? 'Webhook endpoint timed out.' : 'Webhook endpoint could not be reached.' }); });
    req.end(rawBody);
  });
}

export function webhookDeliveryId(webhookId: string, eventId: string): string { return createHash('sha256').update(`${webhookId}|${eventId}`).digest('hex'); }
export function eventDeliveryDisposition(statusCode: number | null, retryableNetworkError = false, responseComplete = true): 'delivered' | 'retry' | 'failed' {
  if (statusCode !== null && statusCode >= 200 && statusCode < 300) return responseComplete ? 'delivered' : retryableNetworkError ? 'retry' : 'failed';
  if (retryableNetworkError || statusCode === 408 || statusCode === 429 || (statusCode !== null && statusCode >= 500)) return 'retry';
  return 'failed';
}
export function retryDelayMs(attempt: number): number | null { return [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000][attempt - 1] ?? null; }
export function formatIsoIndia(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+05:30`;
}
export function buildWebhookPayload(id: string, createdAt: Date, data: Record<string, unknown>): WebhookPayload { return { id, event: WEBHOOK_EVENT, created_at: formatIsoIndia(createdAt), data: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null && value !== '')) }; }
