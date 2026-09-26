import { randomBytes, randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { env } from '../config/env.ts';
import { getDb } from '../firestore/admin.ts';
import { decryptWebhookSecret, deliverWebhook, encryptWebhookSecret, generateWebhookSecret, parseWebhookUrl, resolveWebhookUrl, type WebhookUrlOptions } from '../../../shared/webhooks.ts';

export const WEBHOOK_EVENTS = ['attendance.created'] as const;
export type WebhookEventType = typeof WEBHOOK_EVENTS[number];
export class WebhookServiceError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) { super(message); this.statusCode = statusCode; this.code = code; }
}
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
function requiredKey() { if (!/^[a-fA-F0-9]{64}$/.test(env.webhookSecretEncryptionKey)) throw new WebhookServiceError(503, 'WEBHOOK_SECRET_STORE_UNAVAILABLE', 'Webhook secret management is not configured.'); return env.webhookSecretEncryptionKey; }
function urlOptions(): WebhookUrlOptions {
  const development = process.env.NODE_ENV !== 'production';
  return { production: !development, allowHttp: development && env.webhookAllowHttp, allowLocalhost: development && env.webhookAllowLocalhost };
}
async function validateUrl(raw: string) {
  parseWebhookUrl(raw, urlOptions());
  await resolveWebhookUrl(raw, urlOptions());
}
async function getClient(clientId: string) {
  if (!idPattern.test(clientId)) throw new WebhookServiceError(400, 'INVALID_CLIENT_ID', 'clientId is invalid.');
  const snap = await getDb().collection('api_clients').doc(clientId).get();
  if (!snap.exists) throw new WebhookServiceError(404, 'CLIENT_NOT_FOUND', 'Client not found.');
  const tenantId = snap.get('tenantId');
  if (typeof tenantId !== 'string' || !tenantId) throw new WebhookServiceError(409, 'CLIENT_TENANT_REQUIRED', 'Client must have a tenant ID before webhooks can be enabled.');
  return { ref: snap.ref, data: snap.data()!, tenantId };
}
function safeEndpoint(id: string, d: FirebaseFirestore.DocumentData) {
  const time = (v: unknown) => v instanceof Timestamp ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : null;
  return { webhookId: id, clientId: d.clientId, url: d.url, description: d.description || '', events: Array.isArray(d.events) ? d.events : [], status: d.status, secretStatus: d.secretHash ? 'configured' : 'missing', createdAt: time(d.createdAt), updatedAt: time(d.updatedAt), lastDeliveryAt: time(d.lastDeliveryAt), lastDeliveryStatus: d.lastDeliveryStatus || null, failureCount: Number(d.failureCount) || 0 };
}
async function audit(clientId: string, event: string, webhookId: string) {
  await getDb().collection('client_audit_logs').add({ clientId, event, webhookId, timestamp: FieldValue.serverTimestamp() });
}
export async function createWebhook(clientId: string, input: { url?: unknown; description?: unknown; events?: unknown; status?: unknown }) {
  const { data: clientData, tenantId } = await getClient(clientId);
  if (clientData.status !== 'active') throw new WebhookServiceError(409, 'CLIENT_INACTIVE', 'Enable the API client before creating an active webhook.');
  if (typeof input.url !== 'string' || input.url.length > 2048) throw new WebhookServiceError(400, 'INVALID_WEBHOOK_URL', 'A valid webhook URL is required.');
  try { await validateUrl(input.url); } catch (e) { const err = e as Error & { code?: string }; throw new WebhookServiceError(400, err.code || 'INVALID_WEBHOOK_URL', err.message); }
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description.length > 250) throw new WebhookServiceError(400, 'INVALID_DESCRIPTION', 'Description must be 250 characters or fewer.');
  const events = input.events === undefined ? ['attendance.created'] : input.events;
  if (!Array.isArray(events) || events.length === 0 || events.some((event) => event !== 'attendance.created')) throw new WebhookServiceError(400, 'INVALID_EVENTS', 'Phase 5 supports only attendance.created.');
  const status = input.status === undefined ? 'active' : input.status;
  if (status !== 'active' && status !== 'disabled') throw new WebhookServiceError(400, 'INVALID_STATUS', 'status must be active or disabled.');
  const secret = generateWebhookSecret(); const encrypted = encryptWebhookSecret(secret, requiredKey()); const webhookId = `wh_${randomBytes(12).toString('hex')}`;
  const record = { webhookId, clientId, tenantId, url: input.url, description, events: ['attendance.created'], status, ...encrypted, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), lastDeliveryAt: null, lastDeliveryStatus: null, failureCount: 0 };
  await getDb().collection('webhook_endpoints').doc(webhookId).create(record); await audit(clientId, 'WEBHOOK_CREATED', webhookId);
  return { webhook: safeEndpoint(webhookId, { ...record, createdAt: new Date(), updatedAt: new Date() }), secret };
}
export async function listWebhooks(clientId: string) {
  await getClient(clientId);
  const snap = await getDb().collection('webhook_endpoints').where('clientId', '==', clientId).limit(200).get();
  const endpoints = snap.docs.filter((d) => d.get('status') !== 'deleted');
  const items = await Promise.all(endpoints.map(async (doc) => {
    const deliveries = await getDb().collection('webhook_deliveries').where('webhookId', '==', doc.id).limit(1000).get();
    const total = deliveries.size; const delivered = deliveries.docs.filter((d) => d.get('status') === 'delivered').length;
    return { ...safeEndpoint(doc.id, doc.data()), deliveryCount: total, successCount: delivered, successRate: total ? Math.round(delivered / total * 100) : null };
  }));
  return items;
}
export async function getWebhook(clientId: string, webhookId: string) {
  await getClient(clientId); const snap = await getDb().collection('webhook_endpoints').doc(webhookId).get();
  if (!snap.exists || snap.get('clientId') !== clientId || snap.get('status') === 'deleted') throw new WebhookServiceError(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
  return safeEndpoint(snap.id, snap.data()!);
}
export async function updateWebhook(clientId: string, webhookId: string, input: { url?: unknown; description?: unknown; events?: unknown; status?: unknown }) {
  const ref = getDb().collection('webhook_endpoints').doc(webhookId); const snap = await ref.get();
  if (!snap.exists || snap.get('clientId') !== clientId || snap.get('status') === 'deleted') throw new WebhookServiceError(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if ('url' in input) { if (typeof input.url !== 'string' || input.url.length > 2048) throw new WebhookServiceError(400, 'INVALID_WEBHOOK_URL', 'A valid webhook URL is required.'); try { await validateUrl(input.url); } catch (e) { const err = e as Error & { code?: string }; throw new WebhookServiceError(400, err.code || 'INVALID_WEBHOOK_URL', err.message); } patch.url = input.url; }
  if ('description' in input) { if (typeof input.description !== 'string' || input.description.trim().length > 250) throw new WebhookServiceError(400, 'INVALID_DESCRIPTION', 'Description must be 250 characters or fewer.'); patch.description = input.description.trim(); }
  if ('events' in input) { if (!Array.isArray(input.events) || input.events.length === 0 || input.events.some((event) => event !== 'attendance.created')) throw new WebhookServiceError(400, 'INVALID_EVENTS', 'Phase 5 supports only attendance.created.'); patch.events = ['attendance.created']; }
  if ('status' in input) { if (!['active', 'disabled'].includes(String(input.status))) throw new WebhookServiceError(400, 'INVALID_STATUS', 'status must be active or disabled.'); patch.status = input.status; }
  await ref.update(patch); await audit(clientId, patch.status === 'disabled' ? 'WEBHOOK_DISABLED' : 'WEBHOOK_UPDATED', webhookId);
  return getWebhook(clientId, webhookId);
}
export async function deleteWebhook(clientId: string, webhookId: string) {
  const ref = getDb().collection('webhook_endpoints').doc(webhookId); const snap = await ref.get();
  if (!snap.exists || snap.get('clientId') !== clientId || snap.get('status') === 'deleted') throw new WebhookServiceError(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
  await ref.update({ status: 'deleted', deletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }); await audit(clientId, 'WEBHOOK_DELETED', webhookId); return { webhookId, status: 'deleted' };
}
export async function rotateWebhookSecret(clientId: string, webhookId: string) {
  const ref = getDb().collection('webhook_endpoints').doc(webhookId); const snap = await ref.get();
  if (!snap.exists || snap.get('clientId') !== clientId || snap.get('status') === 'deleted') throw new WebhookServiceError(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
  const secret = generateWebhookSecret(); const encrypted = encryptWebhookSecret(secret, requiredKey()); await ref.update({ ...encrypted, updatedAt: FieldValue.serverTimestamp() }); await audit(clientId, 'WEBHOOK_SECRET_ROTATED', webhookId);
  return { webhookId, secret };
}
export async function testWebhook(clientId: string, webhookId: string) {
  const endpoint = await getWebhookDocument(clientId, webhookId); const secret = decryptWebhookSecret({ secretEncrypted: String(endpoint.data.secretEncrypted || ''), secretIv: String(endpoint.data.secretIv || ''), secretTag: String(endpoint.data.secretTag || '') }, requiredKey());
  const payload = { id: `evt_test_${randomUUID()}`, event: 'webhook.test' as const, created_at: new Date().toISOString(), data: { message: 'Webhook connection test' } };
  const result = await deliverWebhook({ webhookId, url: endpoint.data.url, secret, payload, timeoutMs: env.webhookTimeoutMs, maxPayloadBytes: env.webhookMaxPayloadBytes, maxResponseBytes: env.webhookMaxResponseBytes, urlOptions: urlOptions() });
  return { testEventId: payload.id, ...result };
}
async function getWebhookDocument(clientId: string, webhookId: string) {
  await getClient(clientId); const snap = await getDb().collection('webhook_endpoints').doc(webhookId).get();
  if (!snap.exists || snap.get('clientId') !== clientId || snap.get('status') === 'deleted') throw new WebhookServiceError(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
  return { ref: snap.ref, data: snap.data()! };
}
export async function webhookDeliveries(clientId: string, webhookId: string, page: number, limit: number) {
  await getWebhook(clientId, webhookId);
  const snap = await getDb().collection('webhook_deliveries').where('webhookId', '==', webhookId).orderBy('createdAt', 'desc').limit(1000).get();
  const start = (page - 1) * limit;
  const rows = snap.docs.slice(start, start + limit).map((doc) => { const d = doc.data(); const iso = (v: unknown) => v instanceof Timestamp ? v.toDate().toISOString() : null; return { deliveryId: doc.id, webhookId, clientId: d.clientId, eventId: d.eventId, eventType: d.eventType, attempt: d.attempt, status: d.status, responseStatus: d.responseStatus ?? null, responseTimeMs: d.responseTimeMs ?? null, errorCode: d.errorCode ?? null, errorMessage: d.errorMessage ?? null, createdAt: iso(d.createdAt), sentAt: iso(d.sentAt) }; });
  return { rows, pagination: { page, limit, total: snap.size, hasMore: start + limit < snap.size } };
}

export function makeWebhookTestId(): string { return `evt_test_${randomUUID()}`; }
