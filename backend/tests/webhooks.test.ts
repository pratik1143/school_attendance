import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { buildWebhookPayload, decryptWebhookSecret, deliverWebhook, deliveryLeaseDue, encryptWebhookSecret, eventDeliveryDisposition, generateWebhookSecret, isPublicAddress, parseWebhookUrl, resolveWebhookUrl, retryDelayMs, signWebhook, tenantClientOwnershipMatches, verifyWebhookSignature, webhookDeliveryId, verifiedAttendanceEligible } from '../../shared/webhooks.ts';

const key = '3b'.repeat(32);
const payload = buildWebhookPayload('evt_attendance_001', new Date('2026-09-27T03:12:15Z'), { attendance_id: '001', student_id: 'STU1001', rawLogId: undefined, firebaseDoc: undefined });

async function localReceiver(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const server: Server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local receiver did not bind.');
  return { server, base: `http://127.0.0.1:${address.port}` };
}
const localOptions = { production: false, allowHttp: true, allowLocalhost: true };
const sendLocal = (base: string, path = '/', timeoutMs = 500) => deliverWebhook({ webhookId: 'wh_test', url: `${base}${path}`, secret: 'whsec_unit_test_secret', payload, timeoutMs, maxPayloadBytes: 65_536, urlOptions: localOptions });

test('webhook secret creation is random and AES-GCM ciphertext round trips without storing plaintext', () => {
  const first = generateWebhookSecret(); const second = generateWebhookSecret();
  assert.match(first, /^whsec_[A-Za-z0-9_-]{43}$/); assert.notEqual(first, second);
  const encrypted = encryptWebhookSecret(first, key);
  assert.equal(decryptWebhookSecret(encrypted, key), first);
  assert.equal(JSON.stringify(encrypted).includes(first), false);
  assert.throws(() => decryptWebhookSecret(encrypted, '4b'.repeat(32)));
});

test('webhook payload excludes absent fields and uses Asia/Kolkata ISO time', () => {
  assert.equal(payload.created_at, '2026-09-27T08:42:15+05:30');
  assert.equal('rawLogId' in payload.data, false);
  assert.equal('firebaseDoc' in payload.data, false);
});

test('attendance eligibility requires verified, non-test, non-duplicate records', () => {
  const record = { webhookEligible: true, verified: true, verificationStatus: 'verified', protocol: 'T800_VERIFIED', source: 't800', status: 'present' };
  assert.equal(verifiedAttendanceEligible(record), true);
  assert.equal(verifiedAttendanceEligible({ ...record, protocol: 'unknown' }), false);
  assert.equal(verifiedAttendanceEligible({ ...record, source: 'test' }), false);
  assert.equal(verifiedAttendanceEligible({ ...record, duplicate: true }), false);
  assert.equal(verifiedAttendanceEligible({ ...record, webhookEligible: false }), false);
});

test('client ownership check requires matching tenant and exact client ownership', () => {
  const client = { clientId: 'client-a', tenantId: 'school-a' };
  assert.equal(tenantClientOwnershipMatches({ tenantId: 'school-a', clientId: 'client-a' }, client), true);
  assert.equal(tenantClientOwnershipMatches({ tenantId: 'school-a', clientId: 'client-b' }, client), false);
  assert.equal(tenantClientOwnershipMatches({ tenantId: 'school-b' }, client, 'client-a'), false);
  assert.equal(tenantClientOwnershipMatches({ tenantId: 'school-a' }, client, 'client-b'), false);
  assert.equal(tenantClientOwnershipMatches({ tenantId: 'school-a' }, client, 'client-a'), true);
});

test('HMAC signature verifies over the exact raw body and rejects invalid/expired signatures', () => {
  const raw = Buffer.from('{"id":"evt_1","event":"attendance.created"}'); const timestamp = '1790478400';
  const signature = signWebhook('secret', timestamp, raw);
  assert.equal(verifyWebhookSignature('secret', timestamp, raw, signature, 1_790_478_400_000), true);
  assert.equal(verifyWebhookSignature('secret', timestamp, Buffer.from(raw.toString() + ' '), signature, 1_790_478_400_000), false);
  assert.equal(verifyWebhookSignature('other', timestamp, raw, signature, 1_790_478_400_000), false);
  assert.equal(verifyWebhookSignature('secret', timestamp, raw, 'sha256=xyz', 1_790_478_400_000), false);
  assert.equal(verifyWebhookSignature('secret', timestamp, raw, signature, 1_790_480_000_000), false);
});

test('SSRF validation blocks local, private, link-local and metadata destinations', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '::1', '::7f00:1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.throws(() => parseWebhookUrl('http://example.com', { production: true }), /HTTPS/);
  assert.throws(() => parseWebhookUrl('https://localhost/hook', { production: true }), /Localhost/);
  assert.throws(() => parseWebhookUrl('https://169.254.169.254/latest/meta-data', { production: true }), /Private/);
  assert.throws(() => parseWebhookUrl('https://user:pass@example.com', { production: true }), /unsupported/);
  const local = await resolveWebhookUrl('http://127.0.0.1:8787/hook', localOptions);
  assert.equal(local.addresses.every(({ address }) => address === '127.0.0.1'), true);
});

test('delivery identity is deterministic per webhook and event', () => {
  assert.equal(webhookDeliveryId('wh_a', 'evt_1'), webhookDeliveryId('wh_a', 'evt_1'));
  assert.notEqual(webhookDeliveryId('wh_a', 'evt_1'), webhookDeliveryId('wh_b', 'evt_1'));
  assert.notEqual(webhookDeliveryId('wh_a', 'evt_1'), webhookDeliveryId('wh_a', 'evt_2'));
});

test('worker lease state prevents a second concurrent claim until the lock expires', () => {
  assert.equal(deliveryLeaseDue('pending', 10, null, 10), true);
  assert.equal(deliveryLeaseDue('pending', 11, null, 10), false);
  assert.equal(deliveryLeaseDue('processing', null, 9, 10), true);
  assert.equal(deliveryLeaseDue('processing', null, 11, 10), false);
  assert.equal(deliveryLeaseDue('delivered', null, null, 10), false);
});

test('response classification and bounded retry schedule follow configured attempts', () => {
  assert.equal(eventDeliveryDisposition(204), 'delivered');
  assert.equal(eventDeliveryDisposition(400), 'failed');
  assert.equal(eventDeliveryDisposition(401), 'failed');
  assert.equal(eventDeliveryDisposition(404), 'failed');
  for (const status of [408, 429, 500, 503]) assert.equal(eventDeliveryDisposition(status), 'retry');
  assert.equal(eventDeliveryDisposition(null, true), 'retry');
  assert.equal(eventDeliveryDisposition(200, false, false), 'failed');
  assert.deepEqual([1, 2, 3, 4, 5].map(retryDelayMs), [60_000, 300_000, 900_000, 3_600_000, null]);
});

test('delivery sends signed raw JSON for 2xx and preserves response status without response body', async (t) => {
  let receivedBody = Buffer.alloc(0); let receivedHeaders: import('node:http').IncomingHttpHeaders = {};
  const { server, base } = await localReceiver((req, res) => { const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => { receivedBody = Buffer.concat(chunks); receivedHeaders = req.headers; res.writeHead(204); res.end('ignored response body'); }); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const result = await sendLocal(base);
  assert.equal(result.ok, true); assert.equal(result.statusCode, 204);
  assert.equal(receivedHeaders['x-webhook-id'], 'wh_test');
  assert.equal(receivedHeaders['x-webhook-event'], 'attendance.created');
  assert.equal(receivedHeaders['x-webhook-event-id'], 'evt_attendance_001');
  assert.equal(verifyWebhookSignature('whsec_unit_test_secret', String(receivedHeaders['x-webhook-timestamp']), receivedBody, String(receivedHeaders['x-webhook-signature'])), true);
});

test('delivery classifies permanent and retryable HTTP errors without following redirects', async (t) => {
  const { server, base } = await localReceiver((req, res) => { const status = Number(new URL(req.url || '/', 'http://local').searchParams.get('status') || 200); res.writeHead(status, { Location: 'http://127.0.0.1:1/secret' }); res.end('diagnostic response body is discarded'); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  for (const status of [400, 401, 404]) { const result = await sendLocal(base, `/?status=${status}`); assert.equal(result.ok, false); assert.equal(result.statusCode, status); assert.equal(result.errorCode, `HTTP_${status}`); }
  for (const status of [408, 429, 500]) { const result = await sendLocal(base, `/?status=${status}`); assert.equal(eventDeliveryDisposition(result.statusCode), 'retry'); }
  const redirect = await sendLocal(base, '/?status=302'); assert.equal(redirect.statusCode, 302);
});

test('delivery enforces request timeouts and payload limits', async (t) => {
  const { server, base } = await localReceiver((_req, res) => { setTimeout(() => { if (!res.destroyed) res.end('late'); }, 150); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const timeout = await sendLocal(base, '/', 25); assert.equal(timeout.errorCode, 'WEBHOOK_TIMEOUT');
  const tooLarge = await deliverWebhook({ webhookId: 'wh_test', url: `${base}/`, secret: 's', payload, timeoutMs: 100, maxPayloadBytes: 4, urlOptions: localOptions });
  assert.equal(tooLarge.errorCode, 'PAYLOAD_TOO_LARGE');
});
